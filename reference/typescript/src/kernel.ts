import { BehaviorSubject, Observable, Subject } from "rxjs";
import { matchesGlob, matchTemplate, parseRef } from "./uri.ts";
import type {
  CheckResult,
  CommandDescriptor,
  CommandInvocation,
  CommandRun,
  CommandSummary,
  ErrorCode,
  ExecutionContext,
  Issue,
  KernelOptions,
  MountDescriptor,
  MountSummary,
  ReadDecision,
  ReadPolicy,
  ReadResult,
  ReduceOutput,
  RunOutcome,
  RunStatus,
  Scheduler,
  TransitionRecord,
} from "./types.ts";

const MASKED = "[MASKED]";

let nextRunId = 1;

class Run implements CommandRun {
  readonly id: number;
  readonly commandUri: string;
  status: RunStatus = "Started";
  outcome: RunOutcome | undefined = undefined;
  readonly settled: Promise<RunOutcome>;
  readonly controller = new AbortController();
  private settle!: (outcome: RunOutcome) => void;

  constructor(commandUri: string) {
    this.id = nextRunId++;
    this.commandUri = commandUri;
    this.settled = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  finish(outcome: RunOutcome): boolean {
    if (this.outcome) return false;
    this.outcome = outcome;
    this.status = outcome.status;
    this.settle(outcome);
    return true;
  }

  cancel(): { requested: boolean } {
    if (this.status !== "Started") return { requested: false };
    this.finish({ status: "Cancelled", commandUri: this.commandUri, code: "CANCELLED" });
    this.controller.abort();
    return { requested: true };
  }
}

export class CommandStateKernel<TState> {
  private readonly stateSubject: BehaviorSubject<TState>;
  private readonly transitionSubject = new Subject<TransitionRecord>();

  private readonly commands = new Map<string, CommandDescriptor<TState>>();
  private readonly mounts: { segments: string[]; mount: MountDescriptor<TState> }[] = [];

  private readonly readPolicy: ReadPolicy;

  /** The state stream. Emits the current state to each new subscriber, then each committed change. */
  readonly state$: Observable<Readonly<TState>>;

  /** The transition stream. Emits one record per committed transition, in commit order, from subscription on. */
  readonly transitions$: Observable<TransitionRecord>;

  constructor(initialState: TState, options: KernelOptions = {}) {
    const scheduler = options.scheduler ?? ((task: () => void) => queueMicrotask(task));
    this.stateSubject = new BehaviorSubject(initialState);
    this.readPolicy = options.readPolicy ?? (() => "deny");
    this.state$ = scheduledFrom(this.stateSubject, scheduler);
    this.transitions$ = scheduledFrom(this.transitionSubject, scheduler);
  }

  registerCommand(descriptor: CommandDescriptor<TState>): this {
    const ref = parseRef(descriptor.uri, "command");
    if (!ref.ok) throw new Error(ref.reason);
    if (ref.uri !== descriptor.uri) {
      throw new Error(`Command URI must be canonical: ${descriptor.uri}`);
    }
    if (this.commands.has(ref.uri)) throw new Error(`Command already registered: ${ref.uri}`);
    this.commands.set(ref.uri, descriptor);
    return this;
  }

  registerMount(mount: MountDescriptor<TState>): this {
    const ref = parseRef(mount.uri, "state", "/", { templates: true });
    if (!ref.ok) throw new Error(ref.reason);
    if (ref.uri !== mount.uri) throw new Error(`Mount URI must be canonical: ${mount.uri}`);
    if (this.mounts.some((entry) => entry.mount.uri === ref.uri)) {
      throw new Error(`State mount already registered: ${ref.uri}`);
    }
    this.mounts.push({ segments: ref.segments, mount });
    return this;
  }

  /** The current state. Synchronous, and never waits. */
  getState(): Readonly<TState> {
    return this.stateSubject.value;
  }

  execute(uri: string, params: unknown, ctx: ExecutionContext): CommandRun {
    return this.begin(uri, params, ctx);
  }

  /**
   * Asks, without running anything, whether a command could run with these parameters for this
   * caller. Covers both scopes: availability (state and caller) and validity (the parameters).
   */
  check(uri: string, params: unknown, ctx: ExecutionContext): CheckResult {
    const ref = parseRef(uri, "command", ctx.focusCommandPath ?? "/");
    if (!ref.ok) return { available: false, valid: false, reason: ref.reason };

    const cmd = this.commands.get(ref.uri);
    if (!cmd) return { available: false, valid: false, reason: `No command at ${ref.uri}` };

    const availability = cmd.isAvailable(this.stateSubject.value, ctx, params);
    if (!availability.available) {
      return { available: false, valid: false, reason: availability.reason ?? "Command is not available" };
    }

    const validation = cmd.validate(this.stateSubject.value, params, ctx);
    if (!validation.valid) {
      const issues = validation.issues ?? [];
      return {
        available: true,
        valid: false,
        reason: issues.map((issue) => issue.message).join("; ") || "Validation failed",
        issues,
      };
    }
    return { available: true, valid: true };
  }

  readState(uri: string, ctx: ExecutionContext): ReadResult {
    const ref = parseRef(uri, "state", ctx.focusStatePath ?? "/");
    if (!ref.ok) return { ok: false, code: "INVALID_URI", reason: ref.reason };

    const found = this.findMount(ref.segments);
    if (!found) return { ok: false, code: "NOT_FOUND", reason: `No state mount at ${ref.uri}` };

    const decision = this.decide(found.mount, ctx);
    if (decision === "deny") {
      return { ok: false, code: "DENIED", reason: "Denied by read policy" };
    }
    if (decision === "mask") {
      return { ok: true, uri: ref.uri, data: MASKED, redacted: true };
    }
    return {
      ok: true,
      uri: ref.uri,
      data: found.mount.select(this.stateSubject.value, found.params),
      redacted: false,
    };
  }

  listCommands(
    glob: string,
    ctx: ExecutionContext,
    options: { includeUnavailable?: boolean } = {}
  ): CommandSummary[] {
    const result: CommandSummary[] = [];
    for (const cmd of this.commands.values()) {
      if (!matchesGlob(cmd.uri, glob)) continue;
      const availability = cmd.isAvailable(this.stateSubject.value, ctx);
      if (!availability.available && !options.includeUnavailable) continue;
      result.push({
        uri: cmd.uri,
        label: cmd.label,
        description: cmd.description,
        available: availability.available,
        reason: availability.reason,
      });
    }
    return result;
  }

  listMounts(glob: string, ctx: ExecutionContext): MountSummary[] {
    const result: MountSummary[] = [];
    for (const { mount } of this.mounts) {
      if (!matchesGlob(mount.uri, glob)) continue;
      const decision = this.decide(mount, ctx);
      if (decision === "deny") continue;
      result.push({
        uri: mount.uri,
        description: mount.description,
        classification: mount.classification,
        redacted: decision === "mask",
      });
    }
    return result;
  }

  // --- Lifecycle -----------------------------------------------------------

  private begin(raw: string, params: unknown, ctx: ExecutionContext): CommandRun {
    const ref = parseRef(raw, "command", ctx.focusCommandPath ?? "/");
    if (!ref.ok) return rejected(raw, "INVALID_URI", ref.reason);

    const cmd = this.commands.get(ref.uri);
    if (!cmd) return rejected(ref.uri, "NOT_FOUND", `No command at ${ref.uri}`);

    const availability = cmd.isAvailable(this.stateSubject.value, ctx, params);
    if (!availability.available) {
      return rejected(ref.uri, "CANNOT_EXECUTE", availability.reason ?? "Command is not available");
    }

    const validation = cmd.validate(this.stateSubject.value, params, ctx);
    if (!validation.valid) {
      const issues = validation.issues ?? [];
      return rejected(
        ref.uri,
        "VALIDATION_FAILED",
        issues.map((issue) => issue.message).join("; ") || "Validation failed",
        issues
      );
    }

    const run = new Run(ref.uri);
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(cmd.handle(params, ctx, run.controller.signal));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (result) => this.commit(run, cmd, params, result, ctx),
      (error) => {
        run.finish({ status: "Failed", commandUri: run.commandUri, code: "EXECUTION_ERROR", reason: messageOf(error) });
      }
    );
    return run;
  }

  private commit(
    run: Run,
    cmd: CommandDescriptor<TState>,
    params: unknown,
    result: unknown,
    ctx: ExecutionContext
  ): void {
    if (run.outcome) return;

    let output: ReduceOutput<TState>;
    let affected: string[];
    try {
      output = cmd.reduce(this.stateSubject.value, params, result, ctx);
      affected = output.affectedStateUris.map((uri) => {
        const ref = parseRef(uri, "state", ctx.focusStatePath ?? "/");
        if (!ref.ok) throw new Error(ref.reason);
        return ref.uri;
      });
    } catch (error) {
      run.finish({ status: "Failed", commandUri: run.commandUri, code: "EXECUTION_ERROR", reason: messageOf(error) });
      return;
    }

    this.stateSubject.next(output.nextState);
    const record: TransitionRecord = {
      commandUri: run.commandUri,
      params,
      summary: output.summary,
      affectedStateUris: affected,
      inverse: output.inverse ? { uri: canonicalCommand(output.inverse.uri, ctx), params: output.inverse.params } : undefined,
      actor: ctx.actor,
      delegationChain: [...ctx.delegationChain],
      correlationId: ctx.correlationId,
    };

    run.finish({ status: "Completed", commandUri: run.commandUri, result, summary: output.summary });
    this.transitionSubject.next(record);
  }

  // --- Helpers -------------------------------------------------------------

  private decide(mount: MountDescriptor<TState>, ctx: ExecutionContext): ReadDecision {
    return this.readPolicy(mount.classification, ctx);
  }

  private findMount(
    segments: readonly string[]
  ): { mount: MountDescriptor<TState>; params: Record<string, string> } | undefined {
    for (const entry of this.mounts) {
      const params = matchTemplate(entry.segments, segments);
      if (params) return { mount: entry.mount, params };
    }
    return undefined;
  }
}

/**
 * Gives each subscriber its own delivery task, so a slow subscriber cannot delay the commit or the others.
 * A subscriber that throws is reported by ReactiveX, and nothing else changes.
 */
function scheduledFrom<T>(source: Observable<T>, schedule: Scheduler): Observable<T> {
  return new Observable<T>((subscriber) =>
    source.subscribe((value) => schedule(() => subscriber.next(value)))
  );
}

/** Inverses are written as canonical URIs when the command is registered. Relative ones resolve against the run's focus. */
function canonicalCommand(uri: string, ctx: ExecutionContext): string {
  const ref = parseRef(uri, "command", ctx.focusCommandPath ?? "/");
  return ref.ok ? ref.uri : uri;
}

function rejected(commandUri: string, code: ErrorCode, reason: string, issues?: readonly Issue[]): CommandRun {
  const run = new Run(commandUri);
  run.finish({ status: "Failed", commandUri, code, reason, issues });
  return run;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { CommandInvocation };
