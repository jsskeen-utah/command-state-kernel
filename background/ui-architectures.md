# UI architectures: MVC, MVP, Flux, and the Elm Architecture

These are the main ways of separating UI code from application logic. They mostly differ in where the rules for changing state live, and in how the view learns that state changed.

## MVC

The model holds data and rules, the view renders, and the controller turns input into calls on the model. In classic desktop and server-side MVC, the view observes the model directly.

**What we took:** the separation of domain from presentation. The kernel knows nothing about any view.

**Departure:** the controller is no longer a per-screen object. A command plays that role, and any consumer can reach it.

**Where it breaks down:** MVC leaves open who may call the controller. The kernel makes that explicit through the actor in the context and the availability rule.

## MVP

The presenter holds the logic that moves between model and view, and the view is passive. The presenter calls the view with explicit methods, so it is easy to test.

**What we took:** passive views and testable presentation logic. The adapters are close to presenters, and the browser screen is passive.

**Departure:** the presenter's logic does not sit between the view and the model. The kernel is the model, and adapters only translate.

**Where it breaks down:** a presenter knows one view. Here several consumers share one kernel, and none of them is special.

## Flux

Flux, from Facebook, enforces one-way flow. Views dispatch actions to a central dispatcher, stores update in response, and views re-render from the stores. Redux is a simplified Flux with a single store.

**What we took:** one-way flow, and actions as the only way to change state.

**Departure:** Flux stores can each hold state and react to any action. The kernel has one state tree, and only the reducer of a committed run can change it. Consumers never subscribe to a store and decide for themselves what changed. They read the current state or the transition stream.

**Where it breaks down:** Flux does not describe the view layer's identity or access, or how a view outside the process reads a store.

## The Elm Architecture

Elm structures a program as a model, a message type, an update function, and a view. The update function returns the new model together with a command, a description of an effect for the runtime to perform. Effects are data, so update stays pure and effects are run outside it.

**What we took:** the split between pure state change and effect. Our `reduce` is pure, and `handle` is the effect. The idea that a whole program is one state machine comes from here too.

**Departure:** Elm's effects are data that the runtime interprets. Our effects are asynchronous functions with a cancellation signal. We chose this because the handler needs to return a value to the reducer, and because cancellation has to reach the call in progress. Elm's model would make that awkward.

**Where it breaks down:** Elm has one program and one view. The kernel has many consumers, each of which may be a different language or runtime, so it cannot assume a common runtime that interprets effects.
