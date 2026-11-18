import { fileURLToPath } from "node:url";
import { ExpenseClient } from "./mcp.ts";

/**
 * CLI adapter for the expense sample. Like the MCP adapter, it holds no kernel. It calls the REST
 * adapter as one actor, so the same availability, validation, and read rules apply to scripts and
 * acceptance tests as to people and agents. Output is JSON so that it can be read by other tools.
 *
 * Usage:
 *   node src/cli.ts commands
 *   node src/cli.ts check <command-uri>
 *   node src/cli.ts run <command-uri> [json-params]
 *   node src/cli.ts read <state-uri>
 *   node src/cli.ts events [since]
 *   node src/cli.ts undo | redo
 *
 * Environment: EXPENSE_URL, EXPENSE_TOKEN, and optionally EXPENSE_ACT_AS.
 *
 * Exit codes: 0 success, 1 the kernel refused or failed, 2 bad usage.
 */

const USAGE = `usage:
  cli.ts commands
  cli.ts check <command-uri>
  cli.ts run <command-uri> [json-params]
  cli.ts read <state-uri>
  cli.ts events [since]
  cli.ts undo | redo`;

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(code);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseParams(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    fail("json-params is not valid JSON");
  }
}

function clientFromEnv(): ExpenseClient {
  const url = process.env.EXPENSE_URL ?? "http://localhost:3000";
  const token = process.env.EXPENSE_TOKEN;
  if (!token) fail("EXPENSE_TOKEN is not set");
  return new ExpenseClient(url, token, process.env.EXPENSE_ACT_AS);
}

export async function main(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (!verb) fail("missing command");

  const client = clientFromEnv();

  switch (verb) {
    case "commands": {
      const res = await client.commands();
      print(res.body);
      return res.status < 400 ? 0 : 1;
    }
    case "check": {
      const [uri, rawParams] = rest;
      if (!uri) fail("check needs a command uri");
      const params = parseParams(rawParams);
      const res = await client.check(uri, params);
      print(res.body);
      const body = res.body as { available?: boolean; valid?: boolean } | null;
      return res.status < 400 && body?.available && body?.valid ? 0 : 1;
    }
    case "run": {
      const [uri, rawParams] = rest;
      if (!uri) fail("run needs a command uri");
      const params = parseParams(rawParams);
      const res = await client.execute(uri, params);
      print(res.body);
      return res.status < 400 ? 0 : 1;
    }
    case "read": {
      const [uri] = rest;
      if (!uri) fail("read needs a state uri");
      const res = await client.read(uri);
      print(res.body);
      return res.status < 400 ? 0 : 1;
    }
    case "events": {
      const since = Number(rest[0] ?? 0);
      if (!Number.isInteger(since) || since < 0) fail("since must be a whole number");
      const res = await client.events(since);
      print(res.body);
      return res.status < 400 ? 0 : 1;
    }
    case "undo":
    case "redo": {
      const res = await client.history(verb);
      print(res.body);
      return res.status < 400 ? 0 : 1;
    }
    default:
      fail(`unknown command: ${verb}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
