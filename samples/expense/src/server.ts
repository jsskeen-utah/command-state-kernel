import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RunOutcome } from "../../../reference/typescript/src/index.ts";
import { resolveRequestContext } from "./auth.ts";
import type { Demo } from "./demo.ts";
import { LOADING_REASON, UNAVAILABLE_REASON } from "./policy.ts";

const STATUS_FOR_CODE: Record<string, number> = {
  INVALID_URI: 400,
  NOT_FOUND: 404,
  DENIED: 403,
  CANNOT_EXECUTE: 409,
  VALIDATION_FAILED: 422,
  EXECUTION_ERROR: 502,
  CANCELLED: 409,
};

/**
 * REST adapter over the kernel. Each request is authenticated, its caller's roles must be loaded,
 * and then the request is dispatched. While roles are loading or unavailable, the adapter refuses
 * with 503 and a code the client can act on. The server holds no session state.
 */
export function createExpenseServer(demo: Demo): Server {
  return createServer(async (req, res) => {
    try {
      await route(req, res, demo);
    } catch (error) {
      send(res, 500, { code: "SERVER_ERROR", reason: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse, demo: Demo): Promise<void> {
  const { kernel, directory, roles } = demo;
  const url = new URL(req.url ?? "/", "http://localhost");

  const caller = directory.byToken(bearer(req));
  if (caller) {
    const state = roles.ensure(caller.id);
    if (state.status === "loading") {
      return send(res, 503, { code: "PERMISSIONS_LOADING", reason: LOADING_REASON }, { "retry-after": "1" });
    }
    if (state.status === "failed") {
      return send(res, 503, { code: "PERMISSIONS_UNAVAILABLE", reason: UNAVAILABLE_REASON }, { "retry-after": "5" });
    }
  }

  const auth = resolveRequestContext(
    { authorization: header(req, "authorization"), "x-act-as": header(req, "x-act-as") },
    directory,
    roles
  );
  if (!auth.ok) return send(res, auth.status, { code: "UNAUTHENTICATED", reason: auth.reason });
  const ctx = auth.ctx;

  if (req.method === "GET" && url.pathname === "/api/me") {
    const state = roles.ensure(ctx.actor.id);
    const actorRoles = state.status === "loaded" ? state.roles : [];
    return send(res, 200, { actor: ctx.actor, delegationChain: ctx.delegationChain, roles: actorRoles });
  }

  if (req.method === "GET" && url.pathname === "/api/commands") {
    return send(res, 200, kernel.listCommands("command:/**", ctx, { includeUnavailable: true }));
  }

  if (req.method === "GET" && url.pathname === "/api/read") {
    const result = kernel.readState(url.searchParams.get("uri") ?? "", ctx);
    if (!result.ok) return send(res, STATUS_FOR_CODE[result.code] ?? 400, result);
    return send(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/check") {
    const params = JSON.parse(url.searchParams.get("params") ?? "{}") as unknown;
    return send(res, 200, kernel.check(url.searchParams.get("uri") ?? "", params, ctx));
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const since = Number(url.searchParams.get("since") ?? "0");
    const result = demo.history.events(since, ctx);
    return send(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/commands") {
    const body = (await readJson(req)) as { uri?: string; params?: unknown };
    const run = kernel.execute(body.uri ?? "", body.params, ctx);
    return sendOutcome(res, await run.settled);
  }

  if (req.method === "POST" && (url.pathname === "/api/undo" || url.pathname === "/api/redo")) {
    const result = url.pathname === "/api/undo" ? await demo.history.undo(ctx) : await demo.history.redo(ctx);
    if (!result.ok) return send(res, 409, { code: result.code, reason: result.reason });
    return sendOutcome(res, await result.run.settled);
  }

  return send(res, 404, { code: "NOT_FOUND", reason: `No route ${req.method} ${url.pathname}` });
}

function sendOutcome(res: ServerResponse, outcome: RunOutcome): void {
  if (outcome.status === "Completed") return send(res, 200, outcome);
  return send(res, STATUS_FOR_CODE[outcome.code ?? ""] ?? 500, outcome);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearer(req: IncomingMessage): string {
  return header(req, "authorization")?.replace(/^Bearer /, "") ?? "";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? {} : JSON.parse(text);
}
