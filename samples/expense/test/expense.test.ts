import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createExpenseServer } from "../src/server.ts";
import { buildDemo } from "../src/demo.ts";

async function start() {
  const demo = buildDemo();
  const server = createExpenseServer(demo);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface CallOptions {
  body?: unknown;
  actAs?: string;
}

async function call(base: string, method: string, path: string, token: string | undefined, options: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.actAs) headers["x-act-as"] = options.actAs;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const run = (base: string, token: string, uri: string, params: unknown = {}, actAs?: string) =>
  call(base, "POST", "/api/commands", token, { body: { uri, params }, actAs });

const read = (base: string, token: string, uri: string) =>
  call(base, "GET", `/api/read?uri=${encodeURIComponent(uri)}`, token);

test("an employee submits, a manager approves, finance pays, and the log attributes each actor", async () => {
  const s = await start();
  try {
    assert.equal((await run(s.base, "tok-alice", "command:/report/submit", { id: "r-1" })).status, 200);
    assert.equal((await run(s.base, "tok-mia", "command:/report/approve", { id: "r-1" })).status, 200);
    const paid = await run(s.base, "tok-fin", "command:/report/pay", { id: "r-1" });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.result, "PAY-r-1");

    const events = await call(s.base, "GET", "/api/events?since=0", "tok-root");
    assert.deepEqual(
      events.body.events.map((e: { actor: { id: string } }) => e.actor.id),
      ["user:alice", "user:mia", "user:fin"]
    );
  } finally {
    await s.close();
  }
});

test("an employee cannot approve: a manager-only rule refuses the command, with its reason", async () => {
  const s = await start();
  try {
    const res = await run(s.base, "tok-alice", "command:/report/approve", { id: "r-2" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "CANNOT_EXECUTE");
    assert.equal(res.body.reason, "Only managers can approve");
  } finally {
    await s.close();
  }
});

test("approval over the limit is refused by validation, with the field named", async () => {
  const s = await start();
  try {
    const res = await run(s.base, "tok-mia", "command:/report/approve", { id: "r-3" });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "VALIDATION_FAILED");
    assert.deepEqual(res.body.issues, [{ field: "amount", message: "amount exceeds the approval limit of 5000" }]);
  } finally {
    await s.close();
  }
});

test("payee email is masked for an employee, and the bank account is secret", async () => {
  const s = await start();
  try {
    const email = await read(s.base, "tok-alice", "state:/reports/r-1/payee-email");
    assert.equal(email.status, 200);
    assert.deepEqual([email.body.data, email.body.redacted], ["[MASKED]", true]);

    const aliceAccount = await read(s.base, "tok-alice", "state:/reports/r-1/bank-account");
    assert.equal(aliceAccount.status, 403);

    const finAccount = await read(s.base, "tok-fin", "state:/reports/r-1/bank-account");
    assert.equal(finAccount.body.data, "GB00-1111");
  } finally {
    await s.close();
  }
});

test("undo is per user: a manager cannot undo an employee's submission", async () => {
  const s = await start();
  try {
    assert.equal((await run(s.base, "tok-alice", "command:/report/submit", { id: "r-1" })).status, 200);

    const mia = await call(s.base, "POST", "/api/undo", "tok-mia");
    assert.equal(mia.status, 409);
    assert.equal(mia.body.reason, "Nothing to undo");

    const alice = await call(s.base, "POST", "/api/undo", "tok-alice");
    assert.equal(alice.status, 200);
    assert.equal((await read(s.base, "tok-alice", "state:/reports/r-1")).body.data.status, "draft");
  } finally {
    await s.close();
  }
});

test("a declined payment fails the run with a bank error and leaves the report approved", async () => {
  const s = await start();
  try {
    const res = await run(s.base, "tok-fin", "command:/report/pay", { id: "r-4" });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, "EXECUTION_ERROR");
    assert.equal(res.body.reason, "Bank declined the payment");
    assert.equal((await read(s.base, "tok-fin", "state:/reports/r-4")).body.data.status, "approved");
  } finally {
    await s.close();
  }
});

test("an administrator can act as another user, and the delegation chain is recorded", async () => {
  const s = await start();
  try {
    const created = await run(
      s.base,
      "tok-root",
      "command:/report/create",
      { id: "r-5", title: "Taxi", amount: 45, payee: "City Cabs", payeeEmail: "x@cabs.example", bankAccount: "GB00-5555" },
      "user:alice"
    );
    assert.equal(created.status, 200);

    const events = await call(s.base, "GET", "/api/events?since=0", "tok-root");
    const last = events.body.events.at(-1);
    assert.equal(last.actor.id, "user:alice");
    assert.deepEqual(last.delegationChain.map((a: { id: string }) => a.id), ["user:root"]);
  } finally {
    await s.close();
  }
});

test("only an administrator may act on behalf of another user", async () => {
  const s = await start();
  try {
    const res = await call(s.base, "GET", "/api/me", "tok-alice", { actAs: "user:mia" });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("secret create parameters are masked in events for callers without clearance", async () => {
  const s = await start();
  try {
    await run(s.base, "tok-alice", "command:/report/create", {
      id: "r-6",
      title: "Train",
      amount: 80,
      payee: "Rail Co",
      payeeEmail: "b@rail.example",
      bankAccount: "GB00-6666",
    });
    const events = await call(s.base, "GET", "/api/events?since=0", "tok-alice");
    const created = events.body.events.find((e: { commandUri: string }) => e.commandUri === "command:/report/create");
    assert.equal(created.params.bankAccount, "[REDACTED]");
    assert.equal(created.params.payeeEmail, "[REDACTED]");
    assert.equal(created.params.id, "r-6");
  } finally {
    await s.close();
  }
});

test("check tells a row's actions apart by availability and reason, without running them", async () => {
  const s = await start();
  try {
    const check = (uri: string, params: unknown, token = "tok-alice") =>
      call(s.base, "GET", `/api/check?uri=${encodeURIComponent(uri)}&params=${encodeURIComponent(JSON.stringify(params))}`, token);

    const submittable = await check("command:/report/submit", { id: "r-1" });
    assert.deepEqual([submittable.body.available, submittable.body.valid], [true, true]);

    const notDraft = await check("command:/report/submit", { id: "r-2" });
    assert.equal(notDraft.body.available, false);
    assert.equal(notDraft.body.reason, "Report is submitted, not draft");

    const notGranted = await check("command:/report/approve", { id: "r-2" });
    assert.match(notGranted.body.reason, /Only managers can approve/);

    const overLimit = await check("command:/report/approve", { id: "r-3" }, "tok-mia");
    assert.equal(overLimit.body.valid, false);
    assert.equal(overLimit.body.issues[0].field, "amount");

    assert.equal((await read(s.base, "tok-alice", "state:/reports/r-1")).body.data.status, "draft");
  } finally {
    await s.close();
  }
});

test("the report list is one read, and carries no bank details", async () => {
  const s = await start();
  try {
    const res = await read(s.base, "tok-alice", "state:/reports");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 4);
    assert.ok(res.body.data.every((r: Record<string, unknown>) => !("bankAccount" in r)));
  } finally {
    await s.close();
  }
});

test("a deleted report's bank account is not in the event log, and undoing the deletion restores it", async () => {
  const s = await start();
  try {
    await run(s.base, "tok-alice", "command:/report/create", {
      id: "r-7",
      title: "Parking",
      amount: 12,
      payee: "City Parking",
      payeeEmail: "p@parking.example",
      bankAccount: "GB00-7777",
    });
    assert.equal((await run(s.base, "tok-alice", "command:/report/delete", { id: "r-7" })).status, 200);

    const events = await call(s.base, "GET", "/api/events?since=0", "tok-alice");
    assert.equal(JSON.stringify(events.body).includes("GB00-7777"), false, "the account is masked for this caller");

    assert.equal((await call(s.base, "POST", "/api/undo", "tok-alice")).status, 200);
    const account = await read(s.base, "tok-fin", "state:/reports/r-7/bank-account");
    assert.equal(account.body.data, "GB00-7777");
  } finally {
    await s.close();
  }
});

test("requests without a valid token are rejected", async () => {
  const s = await start();
  try {
    assert.equal((await call(s.base, "GET", "/api/me", undefined)).status, 401);
    assert.equal((await call(s.base, "GET", "/api/me", "tok-nobody")).status, 401);
  } finally {
    await s.close();
  }
});
