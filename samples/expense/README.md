# Expense approval sample

A small REST application built on the command-state kernel. It shows one kernel serving several callers, each with its own rules.

Run it from this folder with Node 24 or later:

```
node src/main.ts        # starts on http://localhost:3000 (set PORT to change it)
node --test test/expense.test.ts
```

## What it demonstrates

| Kernel feature | In this app |
|---|---|
| Availability | Submit is available only to the owner of a draft. Approval is unavailable for your own reports. |
| Validation | Managers cannot approve above 5000. Payments above 9000 are refused. |
| Async handler | Payment goes through a bank stand-in that can decline. |
| Per-actor undo | `POST /api/undo` reverts the caller's most recent action only. |
| Read policy | Payee email is masked without `clearance:pii`. The bank account is denied without `clearance:secret`. |
| Delegation | An admin sends `X-Act-As`. The event log records the admin in the chain. |
| Redaction | Create parameters are stored as `[REDACTED]` in the event log. |
| Rules by role | The application's commands and read policy read the actor's roles. An employee cannot approve, because the manager rule refuses them, with its reason. |

Who may do what is in one place: `src/policy.ts`. Commands ask it through their availability check, and the read policy is built from it too. Roles come from a cache in `src/roles.ts`, which stands in for a remote identity service. While a user's roles are loading, the adapter answers 503 with `PERMISSIONS_LOADING` and the client should retry. If the lookup fails, it answers 503 with `PERMISSIONS_UNAVAILABLE` and nothing is allowed. The token-to-user mapping and the impersonation check are adapter code in `src/auth.ts`. The kernel knows none of them.

## MCP server for agents

`src/mcp.ts` is a stdio MCP server. It is a second adapter over the same REST API, so it has no kernel of its own. It runs as one actor, given by a token. Start the REST server first, then point an MCP client at this command:

```
EXPENSE_URL=http://localhost:3000 EXPENSE_TOKEN=tok-alice node src/mcp.ts
```

Optional: `EXPENSE_ACT_AS=user:alice` makes an admin token act as that user.

What the agent sees:

- **Tools for the commands available now**, named by projecting the command URI (`command:/report/submit` becomes `report_submit`). Commands that the actor's rules refuse are not listed.
- **Read and history tools**: `read_state`, `events_since`, `undo`, and `redo`.
- **Change notifications.** After each tool call, the server re-checks availability and sends `tools/list_changed` if the set changed.

Projection refuses to start if two commands would share a tool name.

## CLI for scripts and acceptance tests

`src/cli.ts` is a third adapter over the same REST API. It holds no kernel either. It prints JSON, so scripts and tests can read it, and it sets the exit code so shell pipelines can gate on it:

```
EXPENSE_URL=http://localhost:3000 EXPENSE_TOKEN=tok-mia node src/cli.ts commands
EXPENSE_URL=http://localhost:3000 EXPENSE_TOKEN=tok-mia node src/cli.ts check command:/report/create '{"id":"r-9","amount":10}'
EXPENSE_URL=http://localhost:3000 EXPENSE_TOKEN=tok-mia node src/cli.ts run command:/report/create '{"id":"r-9","amount":10}'
```

| Verb | Purpose | Exit 0 when |
|---|---|---|
| `commands` | List commands for the actor, with availability and reasons | The request succeeds |
| `check <uri> [json]` | Availability and validation, with no state change | The command is available and valid |
| `run <uri> [json]` | Run the command | The kernel completes it |
| `read <uri>` | Read state, subject to policy | The read succeeds |
| `events [since]` | Events since a sequence number | The request succeeds |
| `undo` / `redo` | Revert or reapply the actor's own last action | The request succeeds |

Exit code 2 is a usage error. `check` distinguishes an unknown command (`No command at ...`) from one the actor cannot run, and it reports validation issues separately from availability. `test/cli.test.ts` covers these cases.

## Endpoints

All requests need `Authorization: Bearer <token>`. Demo tokens are in `src/demo.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/me` | Who you are, your delegation chain, and your roles |
| GET | `/api/commands` | Commands you may run, with availability and reasons |
| GET | `/api/check?uri=...&params=...` | Availability and validation for one command, with no state change |
| GET | `/api/read?uri=state:/reports/r-1` | Read state (sensitivity applies) |
| POST | `/api/commands` | Body `{ "uri": "command:/report/submit", "params": { "id": "r-1" } }` |
| POST | `/api/undo`, `/api/redo` | Undo or redo your own most recent action |
| GET | `/api/events?since=N` | Events since a sequence number, filtered by what you may see |

Status codes follow the failure code: 403 for `DENIED` (a read refused by policy), 409 for `CANNOT_EXECUTE` (a rule refused the command, with its reason), 422 for `VALIDATION_FAILED`, 502 for `EXECUTION_ERROR`.

## Limits of the sample

- **State is in memory.** Restarting the server resets everything, and that is not something to build on.
- **One kernel is shared by all requests.** This is deliberate, and it is why undo is per actor.
- **Demo tokens are public.** They are fine here and nowhere else.
- **No UI yet.** The Angular screen is planned on top of the same kernel.
- **MCP tools are a projection, not the source of truth.** The server exposes only commands the actor can run now. Each run is still checked by the kernel.
