# Background: where the pattern comes from

The command-state kernel draws on several established patterns. None of them is the whole design, and the documents here record what we borrowed, what we changed on purpose, and where the comparison stops working.

| Document | Covers |
|---|---|
| [mvvm-and-relaycommand.md](./mvvm-and-relaycommand.md) | MVVM, `ICommand`, and `RelayCommand`: the closest ancestor for commands with availability |
| [redux-and-ngrx.md](./redux-and-ngrx.md) | Redux, NgRx, and NgRx Signals: centralized state, pure reducers, and effects |
| [ui-architectures.md](./ui-architectures.md) | MVC, MVP, Flux, and the Elm Architecture |
| [design-patterns.md](./design-patterns.md) | General patterns: GoF Command, Observer, Memento, Event Sourcing, CQRS, Mediator, and Ports and Adapters |

## The short version

The kernel takes three things. Commands are objects that can say whether they are available, as MVVM does. State is one centralized structure that changes only through pure reducers, as Redux does. The UI is a projection, as in Flux and the Elm Architecture.

Its departures are more deliberate. Availability and validation are separate questions. Each run is an observable handle. Undo uses data that can be serialized, not an object that can execute. Commands and state share one address space, so an agent can refer to either one the same way. Authorization is kept out of the kernel. The kernel keeps no log: it emits a record for each committed transition, and history is left to the application.
