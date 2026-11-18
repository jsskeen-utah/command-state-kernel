---
name: command-state-kernel
description: Use when working with an application built on the command-state kernel, to discover what an actor can do, check a command before running it, read state, and review the event log. Use it for scripting, acceptance checks, or driving the app as an agent.
---

# Working with a command-state kernel application

The application exposes commands (things that change state) and state mounts (things you can read). Its CLI is the safest way in. Use it instead of calling the REST API by hand.

## Setup

Run the CLI from the application's folder, with the server running:

```
EXPENSE_URL=http://localhost:3000 EXPENSE_TOKEN=tok-alice node src/cli.ts commands
```

Set `EXPENSE_URL` and `EXPENSE_TOKEN` in the environment for each CLI call. Examples use PowerShell-style syntax. Use your shell's equivalent. Start the server with `node src/main.ts`. To use another port, set `PORT` the same way.

## Example: create, then submit

```
node src/cli.ts check command:/report/create '{"id":"r-7","amount":120}'
node src/cli.ts run command:/report/create '{"id":"r-7","amount":120}'
node src/cli.ts check command:/report/submit '{"id":"r-7"}'
node src/cli.ts run command:/report/submit '{"id":"r-7"}'
```

Parameters are JSON. Report ids are lowercase kebab-case, such as `r-7`. Use `commands` to see what the actor may run and which parameters a command takes.

## The loop

1. **Discover.** Run `commands` to see what the actor may run now. Each entry has `available` and, when false, a `reason`.
2. **Check before you run.** Run `check <uri> '<json>'`. It reports `available` and `valid` separately, plus the issues for each field. It changes no state.
3. **Run.** Only run a command after `check` says it is available and valid. Exit code 0 means it completed.
4. **Confirm.** Run `read` or `events` to confirm the state changed as expected.

**Stop rule:** If `check` says `available: false`, do not run the command, not even to see what happens. Report the reason and stop. Running it again only repeats the refusal.

## Reading the answers

- **`available: false` with a reason.** The application refused the actor. Don't retry it with different parameters. Report the reason.
- **`code: PERMISSIONS_LOADING` (HTTP 503).** The application is still fetching the actor's permissions. Wait a moment and try again. Don't treat it as a refusal.
- **`code: PERMISSIONS_UNAVAILABLE` (HTTP 503).** The permission lookup failed, so nothing is allowed right now. Stop and report it. Don't retry in a loop.
- **`valid: false`.** The arguments are wrong. Fix the fields named in `issues`. If `available` is also false, don't act on `valid`. Fix the refusal first.
- **Exit code 1 from `check`.** The command is unavailable or invalid. Read which one from the JSON.
- **Exit code 1 from `run`.** The kernel refused or failed the command. The output is JSON with `status: "Failed"`, a `code`, and a `reason`. This is not a usage error.
- **Exit code 2.** You made a usage error, such as bad JSON or a missing token. Fix the call.
- **`No command at ...`.** The URI is wrong, or the command doesn't exist. Check `commands` for the right one.

## Rules that aren't negotiable

- Don't change state by any route other than a command. Reads are free. Writes go through `run`.
- Don't work around a refusal. If a command is refused, the refusal is the answer.
- Don't assume `undo` covers everything. It only reverts the actor's own most recent action, and only if that action recorded an inverse.
- Don't put real credentials into scripts. Use the `EXPENSE_TOKEN` environment variable.

## Why the CLI

The CLI uses the same availability, validation, and read rules as the UI and the MCP server, so a result from `check` is the same answer the application would give a person. Its JSON output is stable enough to script against, and its exit codes can gate a pipeline.
