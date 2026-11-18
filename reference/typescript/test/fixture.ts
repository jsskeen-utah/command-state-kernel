import { CommandStateKernel } from "../src/kernel.ts";
import type { CommandDescriptor, KernelOptions, ReadDecision } from "../src/types.ts";

export interface DemoState {
  count: number;
  label: string;
  email: string;
  token: string;
  lockOwner: string | null;
  docs: Record<string, { title: string }>;
}

export interface DemoHarness {
  kernel: CommandStateKernel<DemoState>;
  calls: Record<string, number>;
}

function initialState(): DemoState {
  return {
    count: 0,
    label: "initial",
    email: "alice@example.com",
    token: "",
    lockOwner: null,
    docs: { d1: { title: "Spec" } },
  };
}

function positive(params: unknown) {
  const by = (params as { by?: unknown }).by;
  return typeof by === "number" && by > 0
    ? { valid: true }
    : { valid: false, issues: [{ field: "by", message: "must be positive" }] };
}

export function createDemoKernel(
  options: KernelOptions,
  policy: Record<string, ReadDecision>
): DemoHarness {
  const calls: Record<string, number> = {};
  const kernel = new CommandStateKernel<DemoState>(initialState(), {
    ...options,
    readPolicy: (classification) => policy[classification] ?? "deny",
  });

  const ready = { available: true };
  const track = (uri: string, handle: (params: unknown) => Promise<unknown>) =>
    (params: unknown) => {
      calls[uri] = (calls[uri] ?? 0) + 1;
      return handle(params);
    };

  const define = (
    uri: string,
    extra: Omit<CommandDescriptor<DemoState>, "uri" | "description" | "inputSchema" | "isAvailable" | "validate" | "handle"> & {
      handle: (params: unknown) => Promise<unknown>;
      isAvailable?: CommandDescriptor<DemoState>["isAvailable"];
      validate?: CommandDescriptor<DemoState>["validate"];
    }
  ) => {
    const { handle, ...rest } = extra;
    kernel.registerCommand({
      description: uri,
      inputSchema: {},
      isAvailable: () => ready,
      validate: () => ({ valid: true }),
      ...rest,
      uri,
      handle: (params, _ctx, _signal) => track(uri, handle)(params),
    });
  };

  const counter = (uri: string, sign: 1 | -1, inverseUri: string, delayMs = 0) =>
    define(uri, {
      isAvailable: (state, ctx, params) => {
        if (ctx.actor.id === "anon") return { available: false, reason: "Anonymous callers cannot change the counter" };
        if (sign > 0 || params === undefined) return ready;
        const by = (params as { by: number }).by;
        return state.count >= by ? ready : { available: false, reason: "Count is below the amount to remove" };
      },
      validate: (_state, params) => positive(params),
      handle: async (params) => {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return (params as { by: number }).by;
      },
      reduce: (state, params) => {
        const by = (params as { by: number }).by;
        return {
          nextState: { ...state, count: state.count + sign * by },
          summary: `${sign > 0 ? "Added" : "Removed"} ${by}`,
          affectedStateUris: ["state:/counter"],
          inverse: { uri: inverseUri, params: { by } },
        };
      },
    });

  counter("command:/counter/increment", 1, "command:/counter/decrement");
  counter("command:/counter/decrement", -1, "command:/counter/increment");
  counter("command:/counter/slow-increment", 1, "command:/counter/slow-decrement", 20);
  counter("command:/counter/slow-decrement", -1, "command:/counter/slow-increment", 20);

  define("command:/counter/fail", {
    handle: async () => {
      throw new Error("boom");
    },
    reduce: (state) => ({ nextState: state, summary: "", affectedStateUris: [] }),
  });

  define("command:/counter/hang", {
    handle: () => new Promise<unknown>(() => {}),
    reduce: (state) => ({ nextState: state, summary: "", affectedStateUris: [] }),
  });

  define("command:/counter/not-ready", {
    isAvailable: () => ({ available: false, reason: "Service offline" }),
    handle: async () => 0,
    reduce: (state) => ({ nextState: state, summary: "", affectedStateUris: [] }),
  });

  define("command:/counter/bad-reduce", {
    handle: async () => 1,
    reduce: () => {
      throw new Error("reducer broke");
    },
  });

  define("command:/label/set", {
    validate: (_state, params) =>
      typeof (params as { label?: unknown }).label === "string"
        ? { valid: true }
        : { valid: false, issues: [{ field: "label", message: "must be a string" }] },
    handle: async (params) => (params as { label: string }).label,
    reduce: (state, params) => {
      const label = (params as { label: string }).label;
      return {
        nextState: { ...state, label },
        summary: `Label set to ${label}`,
        affectedStateUris: ["state:/label"],
        inverse: { uri: "command:/label/set", params: { label: state.label } },
      };
    },
  });

  define("command:/auth/set-token", {
    handle: async (params) => (params as { token: string }).token,
    reduce: (state, params) => ({
      nextState: { ...state, token: (params as { token: string }).token },
      summary: "Token updated",
      affectedStateUris: ["state:/auth/token"],
    }),
  });

  define("command:/lock/engage", {
    isAvailable: (state) =>
      state.lockOwner === null ? ready : { available: false, reason: "Lock already held" },
    handle: async () => null,
    reduce: (state, _params, _result, ctx) => ({
      nextState: { ...state, lockOwner: ctx.actor.id },
      summary: `Lock engaged by ${ctx.actor.id}`,
      affectedStateUris: ["state:/lock/owner"],
      inverse: { uri: "command:/lock/release", params: {} },
    }),
  });

  define("command:/lock/release", {
    isAvailable: (state, ctx) =>
      state.lockOwner === ctx.actor.id
        ? ready
        : { available: false, reason: "Only the lock owner can release" },
    handle: async () => null,
    reduce: (state) => ({
      nextState: { ...state, lockOwner: null },
      summary: "Lock released",
      affectedStateUris: ["state:/lock/owner"],
      inverse: { uri: "command:/lock/engage", params: {} },
    }),
  });

  const mount = (
    uri: string,
    classification: string,
    description: string,
    select: (state: DemoState, params: Record<string, string>) => unknown
  ) => kernel.registerMount({ uri, classification, description, select });

  mount("state:/counter", "public", "Counter", (s) => s.count);
  mount("state:/label", "internal", "Label", (s) => s.label);
  mount("state:/user/email", "pii", "Email", (s) => s.email);
  mount("state:/auth/token", "secret", "Token", (s) => s.token);
  mount("state:/doc/:id", "internal", "Document", (s, p) => s.docs[p["id"]] ?? null);
  mount("state:/lock/owner", "internal", "Lock owner", (s) => s.lockOwner);

  return { kernel, calls };
}
