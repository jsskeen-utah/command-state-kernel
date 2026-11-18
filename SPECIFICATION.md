# Command-State Kernel: Layer 1 Specification

Document status: Draft, version 0.x. Normative, with non-normative sections 12 and 13 and Appendix A.

Scope: a language-agnostic, framework-agnostic, transport-agnostic contract for a kernel that owns application state, exposes commands and state reads by URI, and emits a record of each committed change.

Normative keywords MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119.

### Exit criteria for 1.0

Any section of this specification may change before 1.0. Breaking changes are described in release notes and in commit messages. The following are required before 1.0 is released:

- At least one implementation outside the TypeScript and .NET references passes the conformance suite, which would show the spec does not depend on either language.
- The conformance suite covers the behaviour the spec requires in §10, including cancellation and delivery ordering under load.
- The read-policy and classification contracts (§5.3, §7.3) have been exercised by more than one application.

## 1. Layers

| Layer | Content | Rules |
|---|---|---|
| **1. Specification** (this document) | URI addressing, commands, state, execution context, read policy, transitions, inverses | No knowledge of UI, transport, authentication, authorization rules, history, or any framework. |
| **2. Language SDK** | Idiomatic implementation of Layer 1 with the standard library and the language's ReactiveX implementation only | Conforms to Layer 1 and to the conformance suite. Labeled as a reference for its language. |
| **3. Adapters and applications** | UI, MCP, WebMCP, CLI, telemetry, history, undo, framework bindings, acceptance tests | Authenticate callers and mint `ExecutionContext`. Configure authorization: the read policy, what is exposed to each consumer, and who may observe transitions. Keep whatever history and undo they need, and project URIs onto transport conventions. |

Layer 1 defines what a kernel does. It has no built-in authorization rules. It calls hooks the application supplies (`isAvailable` in §4.2, the read policy in §5.3). It does not define what a consumer is, how consumers authenticate, what they are allowed to do, what history they keep, or how they receive changes.

## 2. Addressing

### 2.1 Schemes

Two schemes address kernel nodes:

- `command:` addresses an executable command.
- `state:` addresses a readable state mount.

URIs MUST NOT contain an authority (`//`).

### 2.2 Segments

Each path segment MUST match `^[a-z][a-z0-9-]*$`. Segments are kebab-case. Adapters MAY project segments onto their own naming rules (for example, replacing `-` with `_` for a tool name), but MUST NOT change the canonical URI.

Command and mount registration MUST reject any URI that does not match this rule.

### 2.3 Absolute and relative references

- `scheme:/a/b` is absolute and resolves from the root of its tree.
- `scheme:a/b` and `scheme:./a/b` are relative. They resolve against the focus path in the `ExecutionContext` for that scheme (`focusCommandPath` or `focusStatePath`, default `/`).
- `..` removes one segment. `.` is ignored. A reference that climbs above the root is invalid.

### 2.4 Canonicalization invariant

The kernel MUST resolve every reference to its canonical absolute form before it evaluates availability, runs a command, reads state, or emits a transition record. Relative references MUST NOT appear in any emitted value.

### 2.5 Glob matching

Globs are matched against canonical URIs.

- `*` matches exactly one segment.
- `**` matches zero or more segments.
- A glob MUST use the same scheme as the URI it is matched against.

Globs select nodes for discovery. Globs are not authorization. Who may use a node is decided by the application (§4.2, §5.3).

### 2.6 Template matching

Mounts MAY be declared with parameter templates (`state:/documents/:id/metadata`). A template is used only to match a concrete URI to a mount and extract its parameters. Templates are not used for discovery. Discovery uses globs.

## 3. Execution context

Every call to the kernel (read, list, check, dispatch) MUST carry an immutable `ExecutionContext`.

| Field | Required | Meaning |
|---|---|---|
| `actor` | yes | The effective principal: `{ id, displayName?, kind? }`. `id` is required and unique. `kind` is an opaque string the kernel does not interpret. |
| `delegationChain` | yes (may be empty) | Ordered list of actors, `[immediateDelegate, ..., originalInitiator]`. Empty means direct execution. |
| `focusCommandPath` | no | Base for relative `command:` references. Default `/`. |
| `focusStatePath` | no | Base for relative `state:` references. Default `/`. |
| `correlationId` | no | Carried into transition records, so related runs can be grouped. |

Invariants:

- The kernel does not authenticate callers, and it does not decide what an actor may do. Adapters attest the context before calling the kernel.
- The kernel passes the context to command rules and to the read policy, and carries it into transition records. It does not interpret roles, permissions, or capabilities. Commands and the read policy read the actor and derive those from it.

## 4. Commands

### 4.1 Descriptor

A command is registered with:

| Member | Required | Kind | Meaning |
|---|---|---|---|
| `uri` | yes | canonical `command:/...` | Identity. Unique within the kernel. |
| `label` | no | string | Human-readable hint. Adapters MAY use it. |
| `description` | yes | string | Purpose, for discovery and tool descriptions. |
| `inputSchema` | yes | JSON Schema | Parameter shape. |
| `isAvailable(state, ctx, params?)` | yes | **synchronous**, pure | Readiness for this actor, as the application defines it (§4.2). |
| `validate(state, params, ctx)` | yes | **synchronous**, pure | Input validity (§4.3). |
| `handle(params, ctx, signal)` | yes | **asynchronous** | Performs the work and returns a result (§4.4). |
| `reduce(state, params, result, ctx)` | yes | **synchronous**, pure | Produces the next state and, optionally, the inverse (§4.5). |

A command MUST NOT mutate state from `handle`. Only `reduce` may change state.

### 4.2 Availability (scope 1)

`isAvailable(state, ctx, params?)` returns:

```
{ available: boolean, reason?: string }
```

- It answers "does this command make sense now, for this actor?" The answer can depend on state, on the actor, and on the delegation chain. A command that must be restricted to some actors checks them here.
- A rule such as "only managers may approve" is the application's. The command implements it from the actor in the context and returns `available: false` with a reason. The kernel never inspects the rule.
- `params` is optional. Without it, the answer is about readiness only. A command that acts on a target answers the parameterless question from its local rules and cached data, never from a live lookup. If the answer depends on remote data that is not yet cached, it returns `available: false` with a reason that signals loading, not refusal (§12). When the cache fills and the answer becomes true, the adapter emits on its availability observable (§9). A targeted check with parameters then decides whether a specific target works.
- `reason` SHOULD be provided when `available` is false.
- `isAvailable` MUST be synchronous and MUST NOT perform I/O.

### 4.3 Validation (scope 2)

`validate(state, params, ctx)` returns:

```
{ valid: boolean, issues?: { field?: string, message: string }[] }
```

- It answers "given that the command is available, are these arguments legal?"
- It MUST be synchronous and MUST NOT perform I/O.

### 4.4 Handling (asynchronous)

`handle(params, ctx, signal)` is the command's effect. It is asynchronous by default. It MAY call external systems. It returns a result, which the reducer will consume. The `signal` is raised when cancellation is requested.

- A handler that ignores `signal` MUST still have its run settled as `Cancelled` when cancellation is requested (§4.8).
- Work the handler has already performed is not reverted by cancellation.

### 4.5 Reduction (pure) and inverses

`reduce(state, params, result, ctx)` returns:

```
{ nextState, summary, affectedStateUris, inverse? }
```

- It MUST be deterministic and MUST NOT perform I/O.
- `reduce` runs at commit time against the state current at that moment. If `reduce` throws, the run fails with `EXECUTION_ERROR`.
- `inverse`, when present, is a serializable `CommandInvocation`: `{ uri, params }`. It describes how to undo this run. It is computed from the state before the run. A run whose reduction has no inverse is not undoable (§8).
- The kernel does not detect conflicts between runs. Two runs that start from the same state each reduce against whatever state is current when they commit. A command that must not be applied to a state other than the one it was checked against is responsible for checking that itself (Appendix A.7).

### 4.6 Execution lifecycle

```
execute(params, ctx)
  │
  ├─ isAvailable false ────────► Failed  CANNOT_EXECUTE       (no handler)
  ├─ validate invalid ─────────► Failed  VALIDATION_FAILED    (no handler)
  │
  └─ Started  (execute returns a handle at once)
       │
       ├─ handle resolves ─► reduce at commit ─► Completed    (state + transition record)
       ├─ handle throws ───► Failed  EXECUTION_ERROR           (no state change)
       ├─ reduce throws ───► Failed  EXECUTION_ERROR           (no state change)
       └─ cancel requested ► Cancelled                         (no state change, no record)
```

Rules:

- `execute` MUST return its handle before `handle` completes. The run is observable and cancellable while it is `Started`.
- The first terminal state wins. Later results are discarded.
- A run that reaches `Completed` commits exactly one state transition and emits exactly one transition record (§7).
- A run that reaches `Failed` or `Cancelled` commits nothing and emits nothing.
- Rejected executions (`CANNOT_EXECUTE`, `VALIDATION_FAILED`) never start and emit nothing.
- Adapters and extensions MUST NOT change the outcome of an execution the kernel has accepted, and the kernel does not depend on them to report it.

### 4.7 Error codes

| Code | Meaning |
|---|---|
| `INVALID_URI` | The reference is malformed or cannot be canonicalized. |
| `NOT_FOUND` | No command or mount exists at the canonical URI. |
| `CANNOT_EXECUTE` | `isAvailable` returned false. The reason says why. |
| `VALIDATION_FAILED` | `validate` returned invalid. |
| `EXECUTION_ERROR` | `handle` or `reduce` threw. |
| `CANCELLED` | The caller asked for the result of a cancelled run. Cancelling a run does not return this code by itself. The run's status is `Cancelled` (§4.6). |
| `DENIED` | A state read was refused by the read policy (§5.3). |

Kernel operations MUST NOT throw for expected failures. They return a structured result with one of these codes.

### 4.8 Cancellation

- `cancel()` on a `Started` run moves it to `Cancelled` immediately and raises `signal`.
- A second cancel on the same run returns `{ cancelled: false }`.
- Cancelling a run that is already terminal returns `{ cancelled: false }`.

### 4.9 Checking without running

`check(uri, params, ctx)` reports whether a command could run with these parameters for this context, without running it. It evaluates availability (§4.2) and validation (§4.3), and returns:

```
{ available: boolean, valid: boolean, reason?: string, issues?: Issue[] }
```

`check` MUST NOT perform I/O and MUST NOT change state. An application uses it to show what a user may do, to decide whether to offer an undo (§8), or to test a candidate invocation.

## 5. State and read policy

### 5.1 State

- The kernel holds one immutable state value.
- `getState()` returns the current value. It is synchronous and never waits.
- A state change stream emits the new value after each committed transition. A new subscriber receives the current value first, then each change. The stream is a current-value observable (§9). It is not a history.
- Only the reducer of a committed run changes state.
- Each committed transition produces a new state value. A run that leaves the state unchanged produces the same value, so identity can detect change.
- The state carries no history, no sequence, and no version.

### 5.2 Mounts

A mount binds a canonical `state:/...` URI (or a template, §2.6) to a pure selector and a classification.

```
{ uri, description, classification: string, select(state, params) }
```

- `select` MUST be synchronous and pure.
- A read returns `{ ok, uri, data, redacted }`.
- A refused read returns `{ ok: false, code, reason }`, with `code` one of `INVALID_URI`, `NOT_FOUND`, or `DENIED`.
- The kernel resolves the mount first. A missing mount is `NOT_FOUND`. A mount the read policy denies is `DENIED`. The kernel reports these truthfully, so a mount's existence can be seen by any caller that reaches the kernel directly.
- An adapter exposed to callers outside the trust boundary MUST map `NOT_FOUND` to `DENIED` before returning a result, if existence must stay hidden. The kernel does not do this for it.

### 5.3 Classification and the read policy

- `classification` is an opaque label. The kernel does not define the meaning of any label.
- The application supplies a `ReadPolicy`: `(classification, ctx) → allow | mask | deny`. It is supplied at kernel construction or per call. This is the application's rule for who may see what. The kernel only calls it.
- `deny` means the mount is omitted from listings and reads return `DENIED`.
- `mask` means the mount is listed and read, but its data is replaced with a masked placeholder. The read result sets `redacted: true`.
- The kernel MUST apply the policy to every read and every listing.
- If no policy is supplied, every mount is denied. This is the zero-trust default.
- Classification labels, role names, and policy values MUST NOT be hard-coded in the kernel.
- When a read policy or command rule depends on remote data that is missing, stale, or failed to load, the answer MUST be treated as unavailable or denied, never as permission.

## 6. Discovery

- `listCommands(glob, ctx)` returns commands whose URIs match the glob. Each entry carries `available` and, when unavailable, `reason`. Unavailable commands are included only when the caller asks for them. Adapters decide what to expose.
- `listMounts(glob, ctx)` returns mounts whose URIs match the glob and whose read decision is not `deny`. The mount's `redacted` flag is set when the decision is `mask`.
- Discovery is not authorization. A listing reports what the kernel knows. Exposing a listing to a consumer is the adapter's decision.

## 7. Transitions

### 7.1 Records

For each committed transition, the kernel emits one record:

| Field | Meaning |
|---|---|
| `commandUri` | Canonical command URI |
| `params` | As the caller supplied them (§7.3) |
| `summary` | From `reduce` |
| `affectedStateUris` | Canonical state URIs, from `reduce` |
| `inverse` | Optional `CommandInvocation` from `reduce` (§8). Its `uri` is canonical, as `commandUri` is. |
| `actor`, `delegationChain`, `correlationId` | From the `ExecutionContext` |

A record carries no sequence number and no timestamp. Records are delivered in commit order. An application that wants numbers, times, or anything else adds them when it receives a record (Appendix A).

### 7.2 Delivery

- Each subscriber receives every committed transition exactly once, in commit order, from the time it subscribes.
- Delivery is asynchronous with respect to the commit. A subscriber MUST NOT be able to delay a commit, a run's settlement, or another subscriber. The scheduler is chosen by the application or the bootstrap, not by the kernel.
- Failed, cancelled, and rejected runs produce no record.
- A subscriber that throws does not affect the run or other subscribers. The error is reported through the ReactiveX library's unhandled-error channel (RxJS: `config.onUnhandledError`).
- The kernel does not replay past transitions. A subscriber that needs earlier transitions must have subscribed from the start, or must read them from its own store.

### 7.3 Parameters and classification

- A record carries the parameters as the caller supplied them. The kernel does not redact, omit, or transform them.
- A command MAY classify its parameters in its input schema, using an `x-classification` annotation on each field (for example, `bankAccount: secret`). The kernel does not interpret these labels. They are descriptive, in the same way that mount classifications are (§5.3).
- Applications that expose records to consumers apply their own policy to classified fields before the records leave the process. Records delivered to in-process subscribers contain raw values. A subscriber that persists or transmits a record is responsible for applying policy first.
- Records are unsafe to log or persist as delivered. Adapters that expose records apply redaction or filtering to classified fields before output. A debug adapter redacts. A user-facing adapter filters by what that user may see.
- The `inverse` is carried as the command supplied it, for the same reason: it is the data undo runs on. A command whose inverse would carry sensitive values SHOULD carry a reference instead (Appendix A.9).

## 8. Undo as a command capability

### 8.1 What the kernel provides

- A command that declares an `inverse` in `reduce` is undoable for that run. The inverse is a serializable `CommandInvocation`, and it is included in the transition record (§7.1).
- Whether an inverse is possible now is an ordinary availability question. An application asks it by checking the inverse invocation: `check(inverse.uri, inverse.params, ctx)` (§4.9).
- Running an inverse is an ordinary command run. It follows the full lifecycle, emits its own transition record, and can itself declare an inverse.

### 8.2 What the kernel does not provide

The kernel keeps no undo stack and no redo stack. It does not coalesce edits, scope undo to an actor, lock history operations, or decide what undo means for an application. None of these appear in Layer 1.

### 8.3 Properties commands should satisfy

For a command that declares an inverse:

- Running the inverse immediately after the run, with no intervening committed transitions, returns the state to a value equal to the one before the run.
- The inverse describes the state before the run, not the state at some later commit.

These are properties of the command. Conformance checks them (§10). The kernel does not enforce them at runtime. When other transitions commit between a run and its inverse, the guarantee does not hold. Detecting that overlap is the application's job (Appendix A.2, A.7).

## 9. Reactivity

- The kernel exposes two streams: the state change stream (§5.1) and the transition stream (§7). Both are ReactiveX observables. Each implementation expresses them with its language's ReactiveX library (for example RxJS, Rx.NET, or RxJava). Subscribers MUST be notified through these observables, not through ad hoc callbacks. ReactiveX is treated as a native-level dependency of each language SDK, on the same footing as its standard library.
- Where a language or framework has a native reactive primitive, such as signals in Angular, adapters SHOULD bind UI and other consumers to that primitive, converting from the kernel's observables at the adapter boundary, rather than exposing a ReactiveX subject such as `BehaviorSubject` directly.
- Availability is not pushed by the kernel. An adapter that needs to tell its clients when availability may have changed SHOULD expose an "availability may have changed" observable, built with ReactiveX. It emits after a committed transition or after a remote-data update, and it is a hint: clients re-check the commands they show with `check` or `listCommands`.
- Changes to remote data that a command's rules depend on are not kernel transitions. They are handled as described in §12.

## 10. Conformance

An implementation conforms to Layer 1 when it passes the shared conformance suite. The suite is language-neutral and lives at `conformance/scenarios.json`. Each runner supplies the fixtures and executes the same steps. The suite MUST cover, at minimum:

- URI canonicalization, including relative references and `..`
- the kernel passing the caller's context to command rules unchanged, so that a rule refusing one actor reports its own reason
- availability and validation as separate refusals, and `check` reporting both
- async execution, cancellation, and settlement
- commit-time reduction and the single-transition rule
- `getState()` returning the current value, and the state stream emitting the current value first and each change after
- transition records: one per committed transition, in commit order, with no record for failed, cancelled, or rejected runs
- delivery: a subscriber that never returns does not delay a commit
- parameter classification: records carry parameters as supplied, and classification is carried in the input schema
- read policy: deny, mask, and the result shape
- inverses: an inverse is carried in the record, `check` on the inverse reports whether it is possible, and running it restores the prior state
- glob matching (§2.5) and template matching (§2.6), including that globs are never used to match templates
- discovery (§6): `listCommands` and `listMounts` honour the glob, unavailable commands appear only when requested, and `deny` mounts are omitted
- error codes (§4.7): each refusal and failure returns the code the spec names for it
- existence handling (§5.2): a missing mount returns `NOT_FOUND` and a denied mount returns `DENIED`, in the order the spec describes
- delivery ordering under concurrent load: commit order and exactly-once delivery hold when many runs settle at once

## 11. Non-goals

- Authentication, token validation, or the rules that decide what an actor may do. These belong to the application and its adapters.
- Transport protocols (MCP, WebMCP, HTTP, stdio).
- History of any kind: retention of transitions, sequence numbers, cursors, undo and redo stacks.
- Conflict detection and resolution between runs. These belong to the application.
- Persistence of state or of the transition stream.
- UI rendering, binding, or framework-specific reactivity such as signals. The ReactiveX streams in §9 are part of the kernel's contract; how an adapter binds them to a UI is not.
- Command discovery by assembly scanning or any language-specific registration mechanism.

## 12. Recommended: authorization that depends on remote data (non-normative)

This section is guidance, not part of Layer 1. Layer 1 does not implement it, and a conforming kernel does not need it.

Kernel calls are synchronous (§4.2), so a rule cannot wait on a remote service inside `isAvailable`. An application that needs remote data for its rules SHOULD handle it as follows.

- **Keep a local copy.** The application holds the remote data (for example, an actor's roles) in a cache that its rules read synchronously.
- **Report "loading" when the data is missing.** When the cache has no answer for the actor, the rule returns a refusal whose reason says the answer is loading. The adapter starts the lookup in the background.
- **Distinguish loading from refusal.** A loading answer means "retry later". A refusal means "do not retry". Adapters SHOULD present these differently, and SHOULD carry the difference as a structured signal as well as the human reason. Code must not depend on the wording of a reason.
- **Fail closed.** A lookup that fails, or a cached answer older than a maximum age, SHOULD be treated as unavailable. The rule in §5.3 applies.
- **Notify on completion.** When a lookup completes, the adapter SHOULD emit on its "availability may have changed" observable (§9). A change in remote policy is not a kernel transition, so the transition stream does not carry it.
- **Re-check high-risk effects.** Availability can be stale. A command whose effect is hard to reverse SHOULD re-check the authoritative decision inside `handle`, before the effect, and refuse if the answer has changed.

## 13. Extensions (non-normative)

Adapters and applications may add behaviour around the kernel that Layer 1 does not define, such as the loading state in §12, history, undo strategies, and conflict handling. Such behaviour is bound by the rule in §4.6.

## Appendix A (non-normative): building history, undo, and concurrency in an application

These patterns are examples. Each application chooses what it needs.

**A.1 Undo per user.** Subscribe to the transition stream. Keep a stack per actor of records that carry an `inverse`. An "Undo" command for that actor looks at the top of the actor's stack, asks `check` on the record's inverse, and runs it if the check passes. If it does not pass, the command reports the reason and leaves the record on the stack.

**A.2 Numbering.** Subscribe from startup, and assign a number to each record as it arrives. A consumer that restarts loads its own snapshot and continues from the last number it stored. Numbers are the consumer's; the kernel assigns none, so a consumer that needs to detect a missed record must store its own counter and compare it on restart.

**A.3 Timestamps.** Add the time of receipt, or the time the application records, when a record arrives. Kernel records carry no time.

**A.4 Coalescing.** Merge consecutive records from the same actor with the same key within a time window. Keep the first record's inverse and the last record's forward command.

**A.5 Redo.** When an undo succeeds, move its record to a redo stack. Clear that actor's redo stack when the actor commits a new run.

**A.6 Persistence.** Persist the transition records and the snapshot together. Undo across restarts needs the inverses, which the records carry.

**A.7 Guarding against stale work.** Because the kernel reduces against the current state, an application that needs to refuse work based on an earlier state passes the value it expects as a parameter, and checks it in `validate` or `reduce`. For example, a command that changes a report's amount includes the amount it saw, and refuses if the report no longer has that amount. The refusal is the command's own, and it reports through the usual lifecycle.

**A.8 Serialization.** If two undo requests from one actor may overlap, the application serializes them, for example with a queue.

**A.9 Sensitive values and inverses.** The inverse is the data undo needs, and the kernel does not redact it. So a command whose inverse would need a secret (for example, the bank account of a deleted report) SHOULD keep the secret in its own state, and make the inverse a reference to it (for example, `restore` with the report's id). The inverse then carries no secret, and undo still works. Commands with no such secret can carry the inverse directly.

**A.10 Redo and redaction.** An application that keeps records for redo holds the parameters as supplied, so it can re-run a command. Redaction belongs to whatever exposes the records: the application applies its policy to classified fields, using the same read policy it uses for state, before a record leaves the process.

**A.11 CLI and acceptance tests.** A CLI adapter can expose `list`, `check`, and `run` for every command, using the same availability and validation rules as the UI and MCP adapters. An acceptance test is then a sequence of commands, with state reads and transition records checked after each step. `check` lets a test confirm that a forbidden action is refused and see the reason, without changing state. These tests verify the kernel's behaviour, not rendering, so an application should pair them with UI-level verification.
