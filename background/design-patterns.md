# General design patterns

These are the patterns the kernel relies on, or chose not to rely on, and what each one contributed.

## GoF Command

From *Design Patterns* (Gamma, Helm, Johnson, Vlissides, 1994). A request is encapsulated as an object, so it can be queued, logged, and undone.

**What we took:** a command is an object with identity and its own execution logic. Undo is a command in its own right.

**Departure:** the classic pattern's undo is an `unexecute` method on the object. Our inverse is serializable data, `{ uri, params }`, that a different process can read, check, and run. The undo is a new command run, not a method on the old object.

## Observer

Subjects notify observers when they change.

**What we took:** `onTransition` is an observer hook. Adapters subscribe to it.

**Departure:** listeners are isolated. A listener that throws cannot change the outcome of a run or stop the others. Ordering across listeners is not guaranteed. A pull-only consumer keeps its own counter, or compares state identity, so the mechanism does not depend on being able to receive pushes.

## Memento

Captures state so it can be restored later.

**What we took:** the idea that undo needs a way back.

**Departure:** we do not keep snapshots. Each undo frame stores the inverse of one run. Keeping a full copy of the state for every step would be expensive, and reducers that return new state share unchanged parts, so recording the change is enough.

## Event Sourcing

Stores the sequence of events as the source of truth, and derives state by replaying them.

**What we took:** the transition record, which names the actor for each committed transition.

**Departure:** state is the source of truth. The kernel emits transition records and keeps none of them. An application that keeps history does so as a subscriber. Replay would call handlers that perform I/O, which is not safe. Losing that history loses the record of changes, not the state, and state cannot be rebuilt from it. Event sourcing is built around the opposite guarantee, so we do not claim it.

## CQRS

Command and query models are kept apart, so each can be shaped for its job.

**What we took:** reads and commands are separate. Mounts are the query side, and commands are the write side.

**Departure:** the kernel keeps both in one state tree, with one consistency boundary. Full CQRS separates the stores too, which the kernel does not do.

## Mediator

Objects send requests to a central mediator, which routes each one to a handler. MediatR is a well-known .NET example.

**What we took:** commands are dispatched by identity to a registered handler.

**Departure:** a mediator routes requests and does not know much about them. The kernel knows the availability rule, the validation, the inverse, and the record policy for each command, and it enforces the lifecycle. The command is a richer unit than a request message.

## Ports and Adapters (Hexagonal architecture)

Alistair Cockburn's pattern: the application core defines ports, and adapters connect them to the outside world.

**What we took:** this is the Layer 1 and Layer 3 split. The kernel is the core, the UI, MCP, and WebMCP are adapters, and each adapter adds its own transport and consumer rules.

**Departure:** the kernel's port is more specific than a generic interface. It is URIs, a context, and a fixed lifecycle. Adapters must follow those rules and cannot reach into the core.

## Capability-based and attribute-based access control

Access control by unforgeable tokens (capabilities) or by attributes of the subject, resource, and environment.

**What we took:** the subject is an explicit part of every call, through the execution context.

**Departure:** the kernel does not decide access at all. Our first design put capability globs in the context and checked them in the kernel. We removed that. Authorization is the application's, expressed in command rules and in the read policy, because a kernel that understands access rules cannot stay neutral about the rules themselves.

## Where to look next

The background above covers the patterns the design is closest to. The design also touches on what distributed systems do about delivery and catch-up. Those concerns now sit with the application, which is why the kernel stays out of them.
