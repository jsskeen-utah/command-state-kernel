import { CommandStateKernel } from "../../../reference/typescript/src/index.ts";
import type { Availability, CommandDescriptor, ExecutionContext, MountDescriptor, ReadPolicy } from "../../../reference/typescript/src/index.ts";
import type { Action, Policy } from "./policy.ts";

export type ReportStatus = "draft" | "submitted" | "approved" | "rejected" | "paid";

export interface Report {
  readonly id: string;
  readonly title: string;
  readonly amount: number;
  readonly payee: string;
  readonly payeeEmail: string;
  readonly bankAccount: string;
  readonly ownerId: string;
  readonly status: ReportStatus;
}

export interface ExpenseState {
  readonly reports: Readonly<Record<string, Report>>;
  /** Deleted reports, kept so that undoing a deletion restores them without putting their details in an inverse. */
  readonly removed: Readonly<Record<string, Report>>;
}

/** Largest amount a manager may approve. Above this, approval is refused by validation. */
export const APPROVAL_LIMIT = 5000;

/** Largest amount the bank will pay in one transfer. */
export const PAYMENT_LIMIT = 9000;

export interface Bank {
  pay(reportId: string): Promise<string>;
}

/** A stand-in bank for the sample. Reports listed in `declineIds` are declined, to show failed effects. */
export function fakeBank(declineIds: readonly string[] = []): Bank {
  return {
    async pay(reportId) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (declineIds.includes(reportId)) throw new Error("Bank declined the payment");
      return `PAY-${reportId}`;
    },
  };
}

export const SEED_STATE: ExpenseState = {
  removed: {},
  reports: {
    "r-1": report("r-1", "Hotel stay", 1200, "Harbour Hotel", "accounts@harbour.example", "GB00-1111", "user:alice", "draft"),
    "r-2": report("r-2", "Client dinner", 340, "Bistro Nine", "billing@bistro.example", "GB00-2222", "user:alice", "submitted"),
    "r-3": report("r-3", "Conference flights", 9500, "Air Co", "ap@air.example", "GB00-3333", "user:alice", "submitted"),
    "r-4": report("r-4", "Training", 800, "Learn Ltd", "pay@learn.example", "GB00-4444", "user:alice", "approved"),
  },
};

function report(
  id: string,
  title: string,
  amount: number,
  payee: string,
  payeeEmail: string,
  bankAccount: string,
  ownerId: string,
  status: ReportStatus
): Report {
  return { id, title, amount, payee, payeeEmail, bankAccount, ownerId, status };
}

type Params = Record<string, unknown>;

/**
 * Input schemas. A field may carry an `x-classification` annotation. The kernel does not interpret it.
 * The application applies its policy to classified fields before a record leaves the process.
 */
export const SCHEMAS: Record<string, Record<string, unknown>> = {
  "command:/report/create": {
    type: "object",
    properties: {
      bankAccount: { type: "string", "x-classification": "secret" },
      payeeEmail: { type: "string", "x-classification": "pii" },
    },
  },
};

export function fieldClassifications(commandUri: string): Record<string, string> {
  const properties = (SCHEMAS[commandUri]?.properties ?? {}) as Record<string, { "x-classification"?: string }>;
  return Object.fromEntries(
    Object.entries(properties).flatMap(([field, schema]) =>
      schema["x-classification"] ? [[field, schema["x-classification"]]] : []
    )
  );
}

const ready: Availability = { available: true };
const ok = { valid: true };
const invalid = (field: string, message: string) => ({ valid: false, issues: [{ field, message }] });
const isId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value);

/** A state rule returns a refusal reason for a report, or null when the report is in the right state. */
type StateRule = (report: Report) => string | null;

/**
 * Availability for a command that acts on one report.
 * With params, the named report must satisfy the state rule. Without params (for example, when a client
 * lists tools), the command is available if at least one report satisfies it.
 */
function targeted(rule: (report: Report) => string | null, noneReason: string) {
  return (state: ExpenseState, ctx: ExecutionContext, params?: unknown): Availability => {
    if (params === undefined) {
      return Object.values(state.reports).some((r) => rule(r) === null)
        ? ready
        : { available: false, reason: noneReason };
    }
    const r = findReport(state, (params as Params).id);
    if (!r) return { available: false, reason: "No such report" };
    const why = rule(r);
    return why === null ? ready : { available: false, reason: why };
  };
}

function findReport(state: ExpenseState, id: unknown): Report | undefined {
  return isId(id) ? state.reports[id] : undefined;
}

function put(state: ExpenseState, next: Report): ExpenseState {
  return { ...state, reports: { ...state.reports, [next.id]: next } };
}

function setStatus(state: ExpenseState, id: string, status: ReportStatus): ExpenseState {
  return put(state, { ...state.reports[id], status });
}

function stateUri(id: string): string {
  return `state:/reports/${id}`;
}

export function createExpenseKernel(options: { seed?: ExpenseState; bank?: Bank; policy: Policy }) {
  const bank = options.bank ?? fakeBank();
  const policy = options.policy;
  const kernel = new CommandStateKernel<ExpenseState>(options.seed ?? SEED_STATE, {
    readPolicy: policy.readDecision as ReadPolicy,
  });

  /** Asks the policy about the actor alone, without a target. A refusal here is the command's reason. */
  const allowed = (ctx: ExecutionContext, action: Action): Availability => {
    const decision = policy.can(ctx.actor, action);
    return decision.allow ? ready : { available: false, reason: decision.reason };
  };

  /**
   * Availability for a command on one report. The policy is asked first, with no target, so a role
   * refusal is reported as such. Then it is asked about each report, so an owner-only rule holds per
   * report, and the state rule runs last.
   */
  const gate = (action: Action, stateRule: StateRule, noneReason: string) => (
    state: ExpenseState,
    ctx: ExecutionContext,
    params?: unknown
  ): Availability => {
    const general = allowed(ctx, action);
    if (!general.available) return general;
    return targeted(
      (r) => {
        const decision = policy.can(ctx.actor, action, { ownerId: r.ownerId });
        return decision.allow ? stateRule(r) : decision.reason ?? "Not allowed";
      },
      noneReason
    )(state, ctx, params);
  };

  const commands: CommandDescriptor<ExpenseState>[] = [
    {
      uri: "command:/report/create",
      label: "Create expense report",
      description: "Creates a draft expense report owned by the caller.",
      inputSchema: SCHEMAS["command:/report/create"],
      isAvailable: (_state, ctx) => allowed(ctx, "report.create"),
      validate: (state, params) => {
        const p = params as Params;
        if (!isId(p.id)) return invalid("id", "id must be kebab-case");
        if (state.reports[p.id as string]) return invalid("id", "a report with this id already exists");
        if (typeof p.amount !== "number" || p.amount <= 0) return invalid("amount", "amount must be positive");
        return ok;
      },
      handle: async (params) => params,
      reduce: (state, params, _result, ctx) => {
        const p = params as Params;
        const id = p.id as string;
        const created = report(
          id,
          p.title as string,
          p.amount as number,
          p.payee as string,
          p.payeeEmail as string,
          p.bankAccount as string,
          ctx.actor.id,
          "draft"
        );
        return {
          nextState: put(state, created),
          summary: `Created report ${id}`,
          affectedStateUris: [stateUri(id)],
          inverse: { uri: "command:/report/delete", params: { id } },
        };
      },
    },
    {
      uri: "command:/report/delete",
      label: "Delete draft report",
      description: "Deletes a draft report owned by the caller.",
      inputSchema: {},
      isAvailable: gate("report.delete", (r) => (r.status === "draft" ? null : "Only drafts can be deleted"), "No draft report of yours to delete"),
      validate: () => ok,
      handle: async (params) => params,
      reduce: (state, params) => {
        const id = (params as Params).id as string;
        const old = state.reports[id];
        return {
          nextState: {
            removed: { ...state.removed, [id]: old },
            reports: Object.fromEntries(Object.entries(state.reports).filter(([key]) => key !== id)),
          },
          summary: `Deleted report ${id}`,
          affectedStateUris: [stateUri(id)],
          inverse: { uri: "command:/report/restore", params: { id } },
        };
      },
    },
    {
      uri: "command:/report/restore",
      label: "Restore deleted report",
      description: "Restores a report the caller deleted. Used to undo a deletion.",
      inputSchema: {},
      isAvailable: (state, ctx, params) => {
        if (params === undefined) {
          return Object.values(state.removed).some((r) => policy.can(ctx.actor, "report.delete", { ownerId: r.ownerId }).allow)
            ? ready
            : { available: false, reason: "No deleted report of yours to restore" };
        }
        const r = isId((params as Params).id) ? state.removed[(params as Params).id as string] : undefined;
        if (!r) return { available: false, reason: "No such deleted report" };
        const decision = policy.can(ctx.actor, "report.delete", { ownerId: r.ownerId });
        return decision.allow ? ready : { available: false, reason: decision.reason };
      },
      validate: () => ok,
      handle: async (params) => params,
      reduce: (state, params) => {
        const id = (params as Params).id as string;
        const restored = state.removed[id];
        const { [id]: _gone, ...stillRemoved } = state.removed;
        return {
          nextState: { removed: stillRemoved, reports: { ...state.reports, [id]: restored } },
          summary: `Restored report ${id}`,
          affectedStateUris: [stateUri(id)],
          inverse: { uri: "command:/report/delete", params: { id } },
        };
      },
    },
    {
      uri: "command:/report/edit",
      label: "Edit draft report",
      description: "Changes the title or amount of a draft report owned by the caller.",
      inputSchema: {},
      isAvailable: gate("report.edit", (r) => (r.status === "draft" ? null : "Only drafts can be edited"), "No draft report of yours to edit"),
      validate: (_state, params) => {
        const p = params as Params;
        if (p.amount !== undefined && (typeof p.amount !== "number" || p.amount <= 0)) {
          return invalid("amount", "amount must be positive");
        }
        return ok;
      },
      handle: async (params) => params,
      reduce: (state, params) => {
        const p = params as Params;
        const id = p.id as string;
        const old = state.reports[id];
        const next = {
          ...old,
          title: (p.title as string | undefined) ?? old.title,
          amount: (p.amount as number | undefined) ?? old.amount,
        };
        return {
          nextState: put(state, next),
          summary: `Edited report ${id}`,
          affectedStateUris: [stateUri(id)],
          inverse: { uri: "command:/report/edit", params: { id, title: old.title, amount: old.amount } },
        };
      },
    },
    transition(gate, "submit", "Submit report", "Sends a draft report for approval.", "draft", "submitted", "unsubmit", "report.submit", "No draft report of yours to submit"),
    transition(gate, "unsubmit", "Withdraw submission", "Returns a submitted report to draft.", "submitted", "draft", "submit", "report.unsubmit", "No submitted report of yours to withdraw"),
    {
      uri: "command:/report/approve",
      label: "Approve report",
      description: `Approves a submitted report up to the approval limit of ${APPROVAL_LIMIT}. Approvers cannot approve their own reports.`,
      inputSchema: {},
      isAvailable: gate(
        "report.approve",
        (r) => (r.status === "submitted" ? null : "Only submitted reports can be approved"),
        "No submitted report awaiting approval by you"
      ),
      validate: (state, params) => {
        const r = findReport(state, (params as Params).id);
        if (r && r.amount > APPROVAL_LIMIT) {
          return invalid("amount", `amount exceeds the approval limit of ${APPROVAL_LIMIT}`);
        }
        return ok;
      },
      handle: async (params) => params,
      reduce: (state, params) => {
        const id = (params as Params).id as string;
        return {
          nextState: setStatus(state, id, "approved"),
          summary: `Approved report ${id}`,
          affectedStateUris: [stateUri(id)],
          inverse: { uri: "command:/report/unapprove", params: { id } },
        };
      },
    },
    transition(gate, "unapprove", "Revoke approval", "Returns an approved report to submitted.", "approved", "submitted", "approve", "report.unapprove", "No approved report to revoke"),
    {
      uri: "command:/report/reject",
      label: "Reject report",
      description: "Rejects a submitted report with a reason. Rejection cannot be undone.",
      inputSchema: {},
      isAvailable: gate(
        "report.reject",
        (r) => (r.status === "submitted" ? null : "Only submitted reports can be rejected"),
        "No submitted report to reject"
      ),
      validate: (_state, params) =>
        typeof (params as Params).reason === "string" && ((params as Params).reason as string).trim().length > 0
          ? ok
          : invalid("reason", "a reason is required"),
      handle: async (params) => params,
      reduce: (state, params) => {
        const id = (params as Params).id as string;
        return {
          nextState: setStatus(state, id, "rejected"),
          summary: `Rejected report ${id}`,
          affectedStateUris: [stateUri(id)],
        };
      },
    },
    {
      uri: "command:/report/pay",
      label: "Pay report",
      description: `Pays an approved report through the bank, up to ${PAYMENT_LIMIT}. Payments cannot be undone.`,
      inputSchema: {},
      isAvailable: gate(
        "report.pay",
        (r) => (r.status === "approved" ? null : "Only approved reports can be paid"),
        "No approved report to pay"
      ),
      validate: (state, params) => {
        const r = findReport(state, (params as Params).id);
        return r && r.amount > PAYMENT_LIMIT
          ? invalid("amount", `amount exceeds the single-payment limit of ${PAYMENT_LIMIT}`)
          : ok;
      },
      handle: async (params) => bank.pay((params as Params).id as string),
      reduce: (state, params, result) => {
        const id = (params as Params).id as string;
        return {
          nextState: setStatus(state, id, "paid"),
          summary: `Paid report ${id} (${String(result)})`,
          affectedStateUris: [stateUri(id)],
        };
      },
    },
  ];

  for (const command of commands) kernel.registerCommand(command);

  const mounts: MountDescriptor<ExpenseState>[] = [
    {
      uri: "state:/reports",
      description: "All reports, as summaries (without payee contact details or bank account)",
      classification: "internal",
      select: (state) =>
        Object.values(state.reports).map((r) => ({
          id: r.id,
          title: r.title,
          amount: r.amount,
          ownerId: r.ownerId,
          status: r.status,
        })),
    },
    {
      uri: "state:/reports/:id",
      description: "An expense report (without payee contact details or bank account)",
      classification: "internal",
      select: (state, p) => {
        const r = state.reports[p.id];
        return r ? { id: r.id, title: r.title, amount: r.amount, payee: r.payee, ownerId: r.ownerId, status: r.status } : null;
      },
    },
    {
      uri: "state:/reports/:id/payee-email",
      description: "The payee's contact email",
      classification: "pii",
      select: (state, p) => state.reports[p.id]?.payeeEmail ?? null,
    },
    {
      uri: "state:/reports/:id/bank-account",
      description: "The payee's bank account",
      classification: "secret",
      select: (state, p) => state.reports[p.id]?.bankAccount ?? null,
    },
  ];
  for (const mount of mounts) kernel.registerMount(mount);

  return kernel;
}

/** A status move between two states, allowed by the policy for this action, and by the state. */
function transition(
  gate: (
    action: Action,
    stateRule: StateRule,
    noneReason: string
  ) => (state: ExpenseState, ctx: ExecutionContext, params?: unknown) => Availability,
  name: string,
  label: string,
  description: string,
  from: ReportStatus,
  to: ReportStatus,
  inverseName: string,
  action: Action,
  noneReason: string
): CommandDescriptor<ExpenseState> {
  return {
    uri: `command:/report/${name}`,
    label,
    description,
    inputSchema: {},
    isAvailable: gate(action, (r) => (r.status === from ? null : `Report is ${r.status}, not ${from}`), noneReason),
    validate: () => ok,
    handle: async (params) => params,
    reduce: (state, params) => {
      const id = (params as Params).id as string;
      return {
        nextState: setStatus(state, id, to),
        summary: `${label}: ${id}`,
        affectedStateUris: [stateUri(id)],
        inverse: { uri: `command:/report/${inverseName}`, params: { id } },
      };
    },
  };
}
