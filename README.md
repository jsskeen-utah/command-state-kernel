# Command-state kernel

An architectural specification for an application's commands and state, in a form that can be exposed to a UI, to command-line agents over MCP, to browser agents over WebMCP, or any other client or consumer, from one source of truth.

## Running the tests

Run the tests from this folder with [`just`](https://github.com/casey/just). Run `just` on its own to list the recipes.

```
just install          # npm install for each Node project (once)
just test             # every suite
just test-typescript  # kernel and conformance suite
just test-dotnet      # .NET port and conformance suite
just test-angular     # Angular adapter
just test-expense     # expense REST API, MCP server, CLI, and screen
```

The .NET tests need the .NET 10 SDK. The Node projects use npm and Node 24 or later.

## Status

Prototype. The specification is a draft, and the implementations exist to test it, not for production use.

## License

- **Specification and documentation** (`SPECIFICATION.md`, `README.md`, `background/`) are licensed under [CC BY 4.0](LICENSE-DOCS).
- **Reference code, samples, conformance suite, and build files** (`reference/`, `samples/`, `conformance/`, `justfile`) are licensed under [Apache 2.0](LICENSE).
