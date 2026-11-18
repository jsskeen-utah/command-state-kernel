import { computed, signal, type Signal } from "@angular/core";
import type { Subscription } from "rxjs";
import type {
  CheckResult,
  CommandRun,
  CommandStateKernel,
  CommandSummary,
  ExecutionContext,
  MountSummary,
  ReadResult,
  RunOutcome,
  RunStatus,
} from "../typescript/src/index.ts";

/**
 * A run as seen by Angular templates. `status` and `outcome` are signals, so a button can show a
 * spinner while the run is Started and a message when it settles.
 */
export interface ExecutionView {
  readonly run: CommandRun;
  readonly status: Signal<RunStatus>;
  readonly outcome: Signal<RunOutcome | undefined>;
  cancel(): { requested: boolean };
}

/**
 * Layer 3 adapter: projects a command-state kernel onto Angular signals.
 *
 * The kernel's state stream drives a state signal. Every read, listing, and check is a computed
 * signal over it, so each recomputes when the state changes. Reads stay synchronous, as the spec
 * requires. The adapter keeps no history. Applications that want history subscribe to transitions.
 */
export class KernelSignals<TState> {
  private readonly state: Signal<Readonly<TState>>;
  private readonly stateWritable;
  private readonly subscription: Subscription;

  constructor(readonly kernel: CommandStateKernel<TState>) {
    this.stateWritable = signal<Readonly<TState>>(kernel.getState());
    this.state = this.stateWritable.asReadonly();
    this.subscription = kernel.state$.subscribe((next) => this.stateWritable.set(next));
  }

  /** Stops following the kernel's state. */
  dispose(): void {
    this.subscription.unsubscribe();
  }

  readState(uri: string, ctx: Signal<ExecutionContext>): Signal<ReadResult> {
    return computed(() => {
      this.state();
      return this.kernel.readState(uri, ctx());
    });
  }

  commands(
    glob: string,
    ctx: Signal<ExecutionContext>,
    includeUnavailable = false
  ): Signal<readonly CommandSummary[]> {
    return computed(() => {
      this.state();
      return this.kernel.listCommands(glob, ctx(), { includeUnavailable });
    });
  }

  mounts(glob: string, ctx: Signal<ExecutionContext>): Signal<readonly MountSummary[]> {
    return computed(() => {
      this.state();
      return this.kernel.listMounts(glob, ctx());
    });
  }

  /** Asks whether a candidate invocation could run now. Recomputes when the state changes. */
  check(uri: string, params: unknown, ctx: Signal<ExecutionContext>): Signal<CheckResult> {
    return computed(() => {
      this.state();
      return this.kernel.check(uri, params, ctx());
    });
  }

  execute(uri: string, params: unknown, ctx: ExecutionContext): ExecutionView {
    return this.track(this.kernel.execute(uri, params, ctx));
  }

  private track(run: CommandRun): ExecutionView {
    const status = signal<RunStatus>(run.status);
    const outcome = signal<RunOutcome | undefined>(run.outcome);
    run.settled.then((settled) => {
      status.set(settled.status);
      outcome.set(settled);
    });
    return {
      run,
      status: status.asReadonly(),
      outcome: outcome.asReadonly(),
      cancel: () => run.cancel(),
    };
  }
}
