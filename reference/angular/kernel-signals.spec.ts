import { describe, expect, it } from "vitest";
import { signal } from "@angular/core";
import { createDemoKernel } from "../typescript/test/fixture.ts";
import type { ExecutionContext, ReadDecision } from "../typescript/src/index.ts";
import { KernelSignals } from "./kernel-signals.ts";

const policy: Record<string, ReadDecision> = { public: "allow", internal: "allow", pii: "mask", secret: "deny" };

const alice: ExecutionContext = {
  actor: { id: "user:alice", kind: "human" },
  delegationChain: [],
};
const bob: ExecutionContext = {
  actor: { id: "user:bob", kind: "human" },
  delegationChain: [],
};
const guest: ExecutionContext = { actor: { id: "anon" }, delegationChain: [] };

function setup() {
  const { kernel } = createDemoKernel({}, policy);
  return new KernelSignals(kernel);
}

/** Deliveries are scheduled after a run settles, so wait for them before reading signals. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("KernelSignals reads", () => {
  it("recomputes a state read when a command commits", async () => {
    const store = setup();
    const ctx = signal(alice);
    const count = store.readState("state:/counter", ctx);

    expect(count()).toMatchObject({ ok: true, data: 0 });
    const view = store.execute("command:/counter/increment", { by: 2 }, alice);
    await view.run.settled;
    await flush();
    expect(count()).toMatchObject({ ok: true, data: 2 });
  });

  it("re-evaluates availability when the actor changes", () => {
    const store = setup();
    const ctx = signal(guest);
    const increment = store.commands("command:/counter/increment", ctx, true);

    expect(increment()[0]).toMatchObject({ available: false, reason: "Anonymous callers cannot change the counter" });
    ctx.set(alice);
    expect(increment()[0]).toMatchObject({ available: true });
  });
});

describe("KernelSignals discovery", () => {
  it("updates the available commands after a state change", async () => {
    const store = setup();
    const aliceCtx = signal(alice);
    const available = store.commands("command:/lock/**", aliceCtx);

    expect(available().map((c) => c.uri)).toEqual(["command:/lock/engage"]);
    const view = store.execute("command:/lock/engage", {}, alice);
    await view.run.settled;
    await flush();
    expect(available().map((c) => c.uri)).toEqual(["command:/lock/release"]);
  });

  it("keeps unavailable commands with their reason when asked", () => {
    const store = setup();
    const bobCtx = signal(bob);
    const all = store.commands("command:/lock/**", bobCtx, true);
    const release = all().find((c) => c.uri === "command:/lock/release");

    expect(release).toMatchObject({ available: false, reason: "Only the lock owner can release" });
  });

  it("re-checks a candidate invocation when the state changes", async () => {
    const store = setup();
    const aliceCtx = signal(alice);
    const decrement = store.check("command:/counter/decrement", { by: 2 }, aliceCtx);

    expect(decrement()).toMatchObject({ available: false, reason: "Count is below the amount to remove" });
    const view = store.execute("command:/counter/increment", { by: 2 }, alice);
    await view.run.settled;
    await flush();
    expect(decrement()).toMatchObject({ available: true, valid: true });
  });
});

describe("KernelSignals execution", () => {
  it("exposes a run's status as a signal that settles", async () => {
    const store = setup();
    const view = store.execute("command:/counter/slow-increment", { by: 1 }, alice);

    expect(view.status()).toBe("Started");
    await view.run.settled;
    expect(view.status()).toBe("Completed");
    expect(view.outcome()?.result).toBe(1);
  });

  it("surfaces a refusal immediately as a failed run with its code", () => {
    const store = setup();
    const view = store.execute("command:/counter/not-ready", {}, alice);

    expect(view.status()).toBe("Failed");
    expect(view.outcome()).toMatchObject({ code: "CANNOT_EXECUTE", reason: "Service offline" });
  });
});
