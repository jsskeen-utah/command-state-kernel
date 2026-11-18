import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDemoKernel, type DemoHarness } from "./fixture.ts";
import type { ExecutionContext, KernelOptions, ReadDecision, TransitionRecord } from "../src/types.ts";

interface Step {
  readonly do: string;
  readonly [key: string]: any;
}

interface Scenario {
  readonly name: string;
  readonly setup?: { readonly options?: KernelOptions; readonly policy?: string };
  readonly steps: readonly Step[];
}

interface Suite {
  readonly policies: Record<string, Record<string, ReadDecision>>;
  readonly contexts: Record<string, ExecutionContext>;
  readonly scenarios: readonly Scenario[];
}

const suite = JSON.parse(
  readFileSync(new URL("../../../conformance/scenarios.json", import.meta.url), "utf8")
) as Suite;

for (const scenario of suite.scenarios) {
  test(scenario.name, async () => {
    const policy = suite.policies[scenario.setup?.policy ?? "standard"];
    const harness = createDemoKernel({}, policy);
    const vars = new Map<string, any>();
    for (const step of scenario.steps) {
      if (step.do === "await" || step.do === "flush") {
        await runStep(step, harness, suite.contexts, vars);
      } else {
        runStep(step, harness, suite.contexts, vars);
      }
    }
  });
}

async function runStep(
  step: Step,
  h: DemoHarness,
  contexts: Record<string, ExecutionContext>,
  vars: Map<string, any>
): Promise<void> {
  const ctx = (name: string): ExecutionContext => {
    const found = contexts[name];
    if (!found) throw new Error(`Unknown context: ${name}`);
    return found;
  };
  const get = (name: string): any => {
    if (!vars.has(name)) throw new Error(`Unknown variable: ${name}`);
    return vars.get(name);
  };
  const recordsFrom = (name: string): TransitionRecord[] => get(name).list as TransitionRecord[];

  switch (step.do) {
    case "execute":
      vars.set(step.as, h.kernel.execute(step.uri, step.params, ctx(step.ctx)));
      return;
    case "await": {
      const value = get(step.as);
      await value.settled;
      return;
    }
    case "flush":
      await new Promise((resolve) => setTimeout(resolve, 0));
      return;
    case "cancel":
      vars.set(step.as, get(step.of).cancel());
      return;
    case "read":
      vars.set(step.as, h.kernel.readState(step.uri, ctx(step.ctx)));
      return;
    case "check":
      vars.set(step.as, h.kernel.check(step.uri, step.params, ctx(step.ctx)));
      return;
    case "checkInverse": {
      const record = recordsFrom(step.from)[step.index ?? 0];
      if (!record?.inverse) throw new Error("record has no inverse");
      vars.set(step.as, h.kernel.check(record.inverse.uri, record.inverse.params, ctx(step.ctx)));
      return;
    }
    case "executeInverse": {
      const record = recordsFrom(step.from)[step.index ?? 0];
      if (!record?.inverse) throw new Error("record has no inverse");
      vars.set(step.as, h.kernel.execute(record.inverse.uri, record.inverse.params, ctx(step.ctx)));
      return;
    }
    case "subscribe": {
      const list: TransitionRecord[] = [];
      h.kernel.transitions$.subscribe((record) => list.push(record));
      vars.set(step.as, { list });
      return;
    }
    case "subscribeState": {
      const list: Array<{ count: number }> = [];
      h.kernel.state$.subscribe((state) => list.push(state as { count: number }));
      vars.set(step.as, { list });
      return;
    }
    case "getState":
      vars.set(step.as, h.kernel.getState());
      return;
    case "list":
      vars.set(
        step.as,
        step.kind === "commands"
          ? h.kernel.listCommands(step.glob, ctx(step.ctx), { includeUnavailable: step.includeUnavailable })
          : h.kernel.listMounts(step.glob, ctx(step.ctx))
      );
      return;
    case "expectRun": {
      const run = get(step.as);
      assert.equal(run.status, step.status, "run status");
      if ("code" in step) assert.equal(run.outcome?.code ?? null, step.code, "run code");
      if ("reason" in step) assert.equal(run.outcome?.reason ?? null, step.reason, "run reason");
      if ("issues" in step) assert.deepEqual(run.outcome?.issues, step.issues, "run issues");
      if ("result" in step) assert.deepEqual(run.outcome?.result, step.result, "run result");
      return;
    }
    case "expectCancel":
      assert.equal(get(step.as).requested, step.requested, "cancel requested");
      return;
    case "expectHandlerCalls":
      assert.equal(h.calls[step.uri] ?? 0, step.count, `handler calls for ${step.uri}`);
      return;
    case "expectRead": {
      const r = get(step.as);
      assert.equal(r.ok, step.ok, "read ok");
      if ("code" in step) assert.equal(r.code, step.code, "read code");
      if ("data" in step) assert.deepEqual(r.data, step.data, "read data");
      if ("redacted" in step) assert.equal(r.redacted, step.redacted, "read redacted");
      return;
    }
    case "expectCheck": {
      const c = get(step.as);
      assert.equal(c.available, step.available, "check available");
      assert.equal(c.valid, step.valid, "check valid");
      if ("reason" in step) assert.equal(c.reason ?? null, step.reason, "check reason");
      if ("issues" in step) assert.deepEqual(c.issues, step.issues, "check issues");
      return;
    }
    case "expectRecords": {
      const records = recordsFrom(step.as);
      if ("count" in step) assert.equal(records.length, step.count, "record count");
      if ("commandUris" in step) {
        assert.deepEqual(records.map((r) => r.commandUri), step.commandUris, "record command uris");
      }
      if ("actors" in step) assert.deepEqual(records.map((r) => r.actor.id), step.actors, "record actors");
      if ("firstParams" in step) assert.deepEqual(records[0]?.params, step.firstParams, "record params");
      if ("firstInverse" in step) {
        assert.deepEqual(records[0]?.inverse ?? null, step.firstInverse, "record inverse");
      }
      if ("firstAffected" in step) {
        assert.deepEqual(records[0]?.affectedStateUris, step.firstAffected, "record affected");
      }
      if ("firstDelegation" in step) {
        assert.deepEqual(records[0]?.delegationChain.map((a) => a.id), step.firstDelegation, "record delegation");
      }
      return;
    }
    case "expectState": {
      const state = get(step.as) as Record<string, unknown>;
      assert.deepEqual(state[step.path], step.value, `state ${step.path}`);
      return;
    }
    case "expectStates": {
      const states = get(step.as).list as Array<{ count: number }>;
      assert.deepEqual(states.map((s) => s.count), step.counts, "state counts");
      return;
    }
    case "expectList": {
      const uris = get(step.as).map((item: { uri: string }) => item.uri).sort();
      assert.deepEqual(uris, [...step.uris].sort(), "listed uris");
      return;
    }
    default:
      throw new Error(`Unknown step: ${step.do}`);
  }
}
