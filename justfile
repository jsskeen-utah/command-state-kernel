# Justfile for the command-state kernel. Run `just` to list recipes.
# Each ecosystem is driven through its own tool: npm --prefix for Node projects, dotnet for .NET.

default:
    @just --list

# Install npm dependencies for every Node project
install:
    npm --prefix reference/typescript install
    npm --prefix reference/angular install
    npm --prefix samples/expense install

# Run every test suite
test: test-typescript test-dotnet test-angular test-expense

# Kernel and shared conformance suite (TypeScript reference)
test-typescript:
    npm --prefix reference/typescript test

# Kernel and shared conformance suite (.NET port)
test-dotnet:
    dotnet test reference/dotnet/CommandStateKernel.slnx

# Angular signals adapter
test-angular:
    npm --prefix reference/angular test

# Expense sample: REST API, MCP server, CLI, and screen
test-expense:
    npm --prefix samples/expense test

# Typecheck the Node projects
typecheck:
    npm --prefix reference/typescript run typecheck
    npm --prefix reference/angular run typecheck
    npm --prefix samples/expense run typecheck

# Start the expense REST server on http://localhost:3000
run-expense:
    npm --prefix samples/expense start
