# Redux, NgRx, and NgRx Signals

## What the pattern is

Redux keeps an application's state in one store. State is read-only from the outside. A change is an action, a plain object describing what happened, and a reducer, a pure function from the previous state and the action to the next state. Asynchronous work sits in middleware, such as thunks or sagas, which dispatch further actions when the work finishes. Redux also gives you a log of actions and states that tools can replay.

NgRx is a Redux-style library for Angular. It adds selectors, which are memoized functions that read slices of the store, and effects, which listen for actions and dispatch new ones. NgRx Signals is a newer option that replaces the observable store with a signal-based store. Its features include state, computed values, and methods.

## What we took

- **One store of state, changed only by pure functions.** The reducer is the kernel's `reduce`. It is deterministic, does no I/O, and runs against the state current at commit time.
- **Effects are separate from state changes.** Redux puts side effects in middleware and NgRx puts them in effects. Here the equivalent is `handle`. It is asynchronous, can call out, and returns a result. It cannot write state, and only `reduce` changes state.
- **Selectors are the read side.** A selector is a pure view over state. Our mounts play that role, with one difference explained below.
- **Immutable state, shared where unchanged.** Reducers return new state rather than mutating it, so a transition can be detected by reference. Parts a reducer does not touch can be shared between versions. That depends on each reducer, and the kernel does not require it.
- **Signals in the adapter.** The Angular adapter uses NgRx Signals' idea directly, with a signal per read and a `computed` for each derived value.

## Where we departed, and why

**The command is the unit, not the action type.** A Redux action is an object with a type string. The meaning of that type is spread across reducers and effects that listen for it. A kernel command carries its own identity, description, input schema, availability rule, validation, handler, reducer, and inverse. Reading one command tells you everything about it. The cost is that commands are more substantial than action creators, and each one has more parts to get right.

**Availability is part of the command.** Redux has no notion of "this action is not possible right now". The UI usually works it out separately. In the kernel, `isAvailable` and `validate` are part of the command, so a client can ask whether a dispatch would succeed without performing it.

**Addresses, not selectors.** A selector is a function. An agent cannot call one across a process boundary without shipping code. A mount has a URI, so the same read works from the UI, from an MCP client, and from a browser agent. Selectors and URIs are two ways of reaching the same state, and we chose the one that can cross a wire.

**Undo is built in.** Redux has no undo. Libraries like redux-undo add it by keeping snapshots of past states. The kernel instead stores the inverse of each run as data, and the undo history is per actor. Snapshots would mean keeping whole states. Inverses keep only what changed, and they are checked against current state before they run.

**The transition stream is not replayable.** Redux devtools can replay actions because reducers are pure and the log is the whole truth. Our handlers are asynchronous and call external systems, so replaying records would call them again. The kernel keeps no log. It emits a record for each transition, and an application that wants history records them itself.

**Commit-time reduction is the same, but the handler is explicit.** Redux reducers always run on the current state, so the commit-time rule matches. The difference is that our handler's result is an explicit value that the reducer receives. Redux middleware can dispatch from anywhere. Here the effect and the state change are separate steps with a clear seam between them.

**Authorization is not in the store.** Redux has no notion of who is dispatching. Adding it usually means middleware that checks permissions, and that middleware sits between the UI and the store. Here the application decides in `isAvailable` and in the read policy, from the actor in the context.

## Where the comparison breaks down

- **Redux's middleware is open-ended.** Our handler is a single function per command. That is more rigid than middleware, and it is deliberate: every effect has a name and a place in the command.
- **Redux is a state library for a single UI.** The kernel is a state and command boundary for several consumers. Redux does not address the case where the caller is an agent with its own identity.
- **NgRx Signals and our adapter solve different problems.** NgRx Signals manages state inside an Angular app. The kernel adapter reads state that lives somewhere else, so its signals are derived from a kernel that may be in another process.
