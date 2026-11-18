import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createExpenseServer } from "../src/server.ts";
import { buildDemo } from "../src/demo.ts";
import { createRoleCache } from "../src/roles.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function start(roles?: ReturnType<typeof createRoleCache>) {
  const demo = buildDemo({ roles });
  const server = createExpenseServer(demo);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function get(base: string, path: string, token: string) {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test("while roles are loading, requests are refused with a retryable code, and then succeed", async () => {
  const lookup = deferred<readonly string[]>();
  const s = await start(createRoleCache(() => lookup.promise, { retryAfterMs: 60_000 }));
  try {
    const first = await get(s.base, "/api/me", "tok-alice");
    assert.equal(first.status, 503);
    assert.equal(first.body.code, "PERMISSIONS_LOADING");
    assert.equal(first.headers.get("retry-after"), "1");

    lookup.resolve(["employee"]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const later = await get(s.base, "/api/me", "tok-alice");
    assert.equal(later.status, 200);
    assert.deepEqual(later.body.roles, ["employee"]);
  } finally {
    await s.close();
  }
});

test("a failed role lookup fails closed, even for a manager, and the approval is not made", async () => {
  const roles = createRoleCache(() => Promise.reject(new Error("identity service unreachable")), {
    retryAfterMs: 60_000,
  });
  const demo = buildDemo({ roles });
  const server = createExpenseServer(demo);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const first = await get(base, "/api/me", "tok-mia");
    assert.equal(first.status, 503);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const res = await fetch(`${base}/api/commands`, {
      method: "POST",
      headers: { authorization: "Bearer tok-mia", "content-type": "application/json" },
      body: JSON.stringify({ uri: "command:/report/approve", params: { id: "r-2" } }),
    });
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.code, "PERMISSIONS_UNAVAILABLE");
    assert.equal(demo.kernel.getState().reports["r-2"].status, "submitted", "nothing was committed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
