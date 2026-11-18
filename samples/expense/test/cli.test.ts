import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createExpenseServer } from "../src/server.ts";
import { buildDemo } from "../src/demo.ts";

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const rest = createExpenseServer(buildDemo());
  await new Promise<void>((resolve) => rest.listen(0, resolve));
  const base = `http://localhost:${(rest.address() as AddressInfo).port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise<void>((resolve) => rest.close(() => resolve()));
  }
}

function runCli(env: Record<string, string>, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI_PATH, ...args], { env: { ...(process.env as Record<string, string>), ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
    });
  });
}

function cli(base: string, token: string, args: string[]) {
  return runCli({ EXPENSE_URL: base, EXPENSE_TOKEN: token }, args);
}

test("check reports validation issues separately from availability", async () => {
  await withServer(async (base) => {
    const bad = await cli(base, "tok-alice", ["check", "command:/report/create", '{"id":"BAD ID","amount":10}']);
    assert.equal(bad.code, 1);
    const body = JSON.parse(bad.stdout);
    assert.equal(body.available, true);
    assert.equal(body.valid, false);
    assert.equal(body.issues[0].field, "id");
  });
});

test("check exits 0 only when the command is available and valid", async () => {
  await withServer(async (base) => {
    const ok = await cli(base, "tok-alice", ["check", "command:/report/create", '{"id":"r-9","amount":10}']);
    assert.equal(ok.code, 0);
    assert.equal(JSON.parse(ok.stdout).valid, true);
  });
});

test("check distinguishes an unknown command from one that is refused", async () => {
  await withServer(async (base) => {
    const unknown = await cli(base, "tok-alice", ["check", "command:/nope"]);
    assert.equal(unknown.code, 1);
    assert.match(JSON.parse(unknown.stdout).reason, /No command/);
  });
});

test("run is refused with the kernel's reason, and the CLI exits 1", async () => {
  await withServer(async (base) => {
    const refused = await cli(base, "tok-mia", ["run", "command:/report/submit", '{"id":"r-1"}']);
    assert.equal(refused.code, 1);
    const body = JSON.parse(refused.stdout);
    assert.equal(body.code, "CANNOT_EXECUTE");
    assert.match(body.reason, /owner/);
  });
});

test("malformed json-params is a usage error with exit code 2", async () => {
  await withServer(async (base) => {
    const bad = await cli(base, "tok-alice", ["run", "command:/report/submit", "{not json"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /not valid JSON/);
  });
});

test("a missing token is a usage error", async () => {
  const result = await runCli({ EXPENSE_TOKEN: "" }, ["commands"]);
  assert.equal(result.code, 2);
});
