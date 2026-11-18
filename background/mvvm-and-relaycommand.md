# MVVM, ICommand, and RelayCommand

## What the pattern is

Model-View-ViewModel separates a view (what the user sees), a model (the domain), and a view model (a presentation of the domain shaped for one view). It was introduced for Windows Presentation Foundation, and the view model exposes its state and actions through bindings. A view binds to properties and to commands. It holds no logic of its own.

In WPF, an action is an `ICommand`:

- `bool CanExecute(object parameter)` says whether the action can run now.
- `void Execute(object parameter)` runs it.
- `event EventHandler CanExecuteChanged` tells the view to ask again.

`RelayCommand` (also called `DelegateCommand` in Prism) is the usual implementation. It wraps a delegate for `Execute` and a predicate for `CanExecute`, so a view model can declare commands inline without a class per command. The button is bound to the command, and the framework enables or disables it from `CanExecute`.

## What we took

- **Commands as objects with an availability question.** The button-enabling model comes from here. A command knows whether it applies, and the UI asks rather than deciding itself.
- **The UI does not hold the rules.** A view only binds. The equivalent in our design is an adapter that reads availability and forwards intent.
- **Change notification drives re-evaluation.** `CanExecuteChanged` is the ancestor of the state stream and of the availability signals in the Angular adapter.

## Where we departed, and why

**Availability and validation are separate.** `ICommand.CanExecute` takes a single parameter and returns a bool, so "is this action possible at all" and "are these arguments legal" share one answer. A user refused by a form field and a user who cannot approve anything see the same disabled button. The kernel splits the two. `isAvailable` answers the first question, and it can answer without parameters. `validate` answers the second. An agent can therefore be told which tools to offer, and then why a particular call was refused.

**`CanExecute` returns a reason.** A bool is enough for a button. It is not enough for an agent, for an accessibility layer, or for a tooltip that has to say why. Our `isAvailable` returns `{ available, reason }`, so every refusal is explained.

**Execution is an observable run.** `Execute` returns `void`. Failure and completion go to whatever surface the view model happens to watch. A kernel run returns a handle in the `Started` state. It can be observed, cancelled, and settled. That is what an async handler needs, and it is what lets an agent poll or wait for a result.

**The command is not the undo.** WPF commands have no built-in undo. The GoF Command pattern does, through an object that can execute itself in reverse. We keep the inverse as serializable data, `{ uri, params }`, because it has to survive into the transition records, be sent to another process, and be checked before it runs.

**Commands are addressable.** A `RelayCommand` is reachable only from the view model that holds it. In our design a command has a URI, so the MCP and WebMCP adapters can reach the same command the button uses.

**One kernel serves many consumers.** MVVM gives each view its own view model. Here there is one kernel, and the screen, the MCP server, and the browser agent are all projections of it. The view-model idea survives as the adapter, which shapes the kernel for one consumer.

## Where the comparison breaks down

- **MVVM's view model is usually a per-screen presentation object.** Our kernel owns the state, so it is closer to a model with commands than to a view model. The analogy works for the adapters, not for the kernel.
- **WPF commands run on the UI thread.** The kernel is written for async handlers from the start, which is why it needs a run handle.
- **Binding is implicit in MVVM.** Here consumers read and subscribe explicitly, through URIs and the state and transition streams. That is more code for a screen, but it is the same code for every consumer.
