export interface Actor {
  readonly id: string;
  readonly displayName?: string;
  readonly kind?: string;
}

export interface ExecutionContext {
  readonly actor: Actor;
  readonly delegationChain: readonly Actor[];
  readonly focusCommandPath?: string;
  readonly focusStatePath?: string;
  readonly correlationId?: string;
}

export type ReadDecision = "allow" | "mask" | "deny";
export type ReadPolicy = (classification: string, ctx: ExecutionContext) => ReadDecision;

export interface Issue {
  readonly field?: string;
  readonly message: string;
}

export interface Availability {
  readonly available: boolean;
  readonly reason?: string;
}

export interface Validation {
  readonly valid: boolean;
  readonly issues?: readonly Issue[];
}

export interface CheckResult {
  readonly available: boolean;
  readonly valid: boolean;
  readonly reason?: string;
  readonly issues?: readonly Issue[];
}

export interface CommandInvocation {
  readonly uri: string;
  readonly params: unknown;
}


export interface ReduceOutput<TState> {
  readonly nextState: TState;
  readonly summary: string;
  readonly affectedStateUris: readonly string[];
  readonly inverse?: CommandInvocation;
}

export interface CommandDescriptor<TState> {
  readonly uri: string;
  readonly label?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  isAvailable(state: Readonly<TState>, ctx: ExecutionContext, params?: unknown): Availability;
  validate(state: Readonly<TState>, params: unknown, ctx: ExecutionContext): Validation;
  handle(params: unknown, ctx: ExecutionContext, signal: AbortSignal): Promise<unknown>;
  reduce(
    state: Readonly<TState>,
    params: unknown,
    result: unknown,
    ctx: ExecutionContext
  ): ReduceOutput<TState>;
}

export interface MountDescriptor<TState> {
  readonly uri: string;
  readonly description: string;
  readonly classification: string;
  select(state: Readonly<TState>, params: Readonly<Record<string, string>>): unknown;
}

export type ErrorCode =
  | "INVALID_URI"
  | "NOT_FOUND"
  | "CANNOT_EXECUTE"
  | "VALIDATION_FAILED"
  | "EXECUTION_ERROR"
  | "CANCELLED"
  | "DENIED";

export type RunStatus = "Started" | "Completed" | "Failed" | "Cancelled";

export interface RunOutcome {
  readonly status: RunStatus;
  readonly commandUri: string;
  readonly code?: ErrorCode;
  readonly reason?: string;
  readonly issues?: readonly Issue[];
  readonly result?: unknown;
  readonly summary?: string;
}

export interface CommandRun {
  readonly id: number;
  readonly commandUri: string;
  readonly status: RunStatus;
  readonly outcome: RunOutcome | undefined;
  readonly settled: Promise<RunOutcome>;
  cancel(): { requested: boolean };
}

/** One committed transition. Carries no sequence number and no time: adapters add those if they want them. */
export interface TransitionRecord {
  readonly commandUri: string;
  readonly params: unknown;
  readonly summary: string;
  readonly affectedStateUris: readonly string[];
  readonly inverse?: CommandInvocation;
  readonly actor: Actor;
  readonly delegationChain: readonly Actor[];
  readonly correlationId?: string;
}

export type ReadResult =
  | { readonly ok: true; readonly uri: string; readonly data: unknown; readonly redacted: boolean }
  | { readonly ok: false; readonly code: "INVALID_URI" | "NOT_FOUND" | "DENIED"; readonly reason: string };

/** Runs a delivery task later. The default queues it as a microtask. Applications may supply their own. */
export type Scheduler = (task: () => void) => void;

export interface KernelOptions {
  readonly readPolicy?: ReadPolicy;
  readonly scheduler?: Scheduler;
}

export interface CommandSummary {
  readonly uri: string;
  readonly label?: string;
  readonly description: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface MountSummary {
  readonly uri: string;
  readonly description: string;
  readonly classification: string;
  readonly redacted: boolean;
}
