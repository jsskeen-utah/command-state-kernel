import type { CommandRun, CommandStateKernel, ExecutionContext, ReadDecision, TransitionRecord } from "../../../reference/typescript/src/index.ts";

/**
 * The sample's history, owned by the application, not the kernel. It subscribes to the kernel's
 * transition stream when the application boots, numbers what it receives, and keeps a stack of
 * undoable records per actor. Undo and redo are checked with the kernel's `check` before they run.
 */

export interface HistoryEvent extends TransitionRecord {
  /** The application's own number for this record, starting at 1. */
  readonly n: number;
  /** When the application received the record. */
  readonly receivedAt: number;
}

export type HistoryOutcome =
  | { readonly ok: true; readonly run: CommandRun }
  | { readonly ok: false; readonly code: "CANNOT_EXECUTE"; readonly reason: string };

export interface History {
  events(since: number, ctx: ExecutionContext): { status: "ok"; latest: number; events: HistoryEvent[] };
  undo(ctx: ExecutionContext): Promise<HistoryOutcome>;
  redo(ctx: ExecutionContext): Promise<HistoryOutcome>;
}

/**
 * The application's policy for what leaves the process. The history keeps records as supplied, so
 * undo and redo can re-run commands. Only the events it returns are masked.
 */
export interface HistoryOptions {
  readonly readDecision: (classification: string, ctx: ExecutionContext) => ReadDecision;
  readonly classifiedFields: (commandUri: string) => Record<string, string>;
}

const UNDO_TAG = "history:undo:";
const REDO_TAG = "history:redo:";
const REDACTED = "[REDACTED]";

export function createHistory<TState>(kernel: CommandStateKernel<TState>, options: HistoryOptions): History {
  let n = 0;
  let tokens = 0;
  const log: HistoryEvent[] = [];
  const undoStacks = new Map<string, HistoryEvent[]>();
  const redoStacks = new Map<string, HistoryEvent[]>();
  const queues = new Map<string, Promise<unknown>>();

  kernel.transitions$.subscribe((record) => {
    const event: HistoryEvent = { ...record, n: ++n, receivedAt: Date.now() };
    log.push(event);

    // The history's own undo and redo runs are handled by the operations below, not by this stack.
    const tag = record.correlationId ?? "";
    if (tag.startsWith(UNDO_TAG) || tag.startsWith(REDO_TAG)) return;

    if (record.inverse) push(undoStacks, record.actor.id, event);
    redoStacks.delete(record.actor.id);
  });

  /** One operation at a time per actor, so an undo cannot race another undo. */
  const serialized = <T>(actorId: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(actorId) ?? Promise.resolve();
    const next = previous.then(work, work);
    queues.set(actorId, next.catch(() => undefined));
    return next;
  };

  /**
   * Transition records are delivered after a run settles, so the operations wait one turn before
   * reading the stacks. Without that, a quick second undo could miss the record of the first.
   */
  const delivered = () => new Promise((resolve) => setTimeout(resolve, 0));

  const undo = (ctx: ExecutionContext): Promise<HistoryOutcome> =>
    serialized(ctx.actor.id, async () => {
      await delivered();
      const stack = undoStacks.get(ctx.actor.id) ?? [];
      const top = stack[stack.length - 1];
      if (!top?.inverse) return refused("Nothing to undo");

      const { uri, params } = top.inverse;
      const check = kernel.check(uri, params, ctx);
      if (!check.available || !check.valid) return refused(check.reason ?? "This action can no longer be undone");

      const token = `${UNDO_TAG}${++tokens}`;
      const run = kernel.execute(uri, params, { ...ctx, correlationId: token });
      stack.pop();
      const outcome = await run.settled;
      if (outcome.status === "Completed") {
        push(redoStacks, ctx.actor.id, top);
      } else {
        stack.push(top);
      }
      return { ok: true, run };
    });

  const redo = (ctx: ExecutionContext): Promise<HistoryOutcome> =>
    serialized(ctx.actor.id, async () => {
      await delivered();
      const stack = redoStacks.get(ctx.actor.id) ?? [];
      const top = stack[stack.length - 1];
      if (!top) return refused("Nothing to redo");
      if (JSON.stringify(top.params).includes(REDACTED)) {
        return refused("This action's parameters were redacted when recorded, so it cannot be redone");
      }

      const check = kernel.check(top.commandUri, top.params, ctx);
      if (!check.available || !check.valid) return refused(check.reason ?? "This action can no longer be redone");

      const token = `${REDO_TAG}${++tokens}`;
      const run = kernel.execute(top.commandUri, top.params, { ...ctx, correlationId: token });
      stack.pop();
      const outcome = await run.settled;
      if (outcome.status === "Completed") {
        await delivered();
        const fresh = log.find((event) => event.correlationId === token);
        if (fresh) push(undoStacks, ctx.actor.id, fresh);
      } else {
        stack.push(top);
      }
      return { ok: true, run };
    });

  return {
    events: (since, ctx) => {
      const visible = log
        .filter((event) => event.n > since)
        .map((event) => ({
          ...event,
          params: masked(event.params, options.classifiedFields(event.commandUri), ctx, options.readDecision),
          inverse: event.inverse && {
            uri: event.inverse.uri,
            params: masked(event.inverse.params, options.classifiedFields(event.inverse.uri), ctx, options.readDecision),
          },
          affectedStateUris: event.affectedStateUris.filter((uri) => kernel.readState(uri, ctx).ok),
        }));
      return { status: "ok", latest: n, events: visible };
    },
    undo,
    redo,
  };
}

function push(map: Map<string, HistoryEvent[]>, actorId: string, event: HistoryEvent): void {
  const stack = map.get(actorId) ?? [];
  stack.push(event);
  map.set(actorId, stack);
}

function masked(
  params: unknown,
  fields: Record<string, string>,
  ctx: ExecutionContext,
  decide: (classification: string, ctx: ExecutionContext) => ReadDecision
): unknown {
  if (params === null || typeof params !== "object") return params;
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  for (const [field, classification] of Object.entries(fields)) {
    if (field in out && decide(classification, ctx) !== "allow") out[field] = REDACTED;
  }
  return out;
}

function refused(reason: string): HistoryOutcome {
  return { ok: false, code: "CANNOT_EXECUTE", reason };
}
