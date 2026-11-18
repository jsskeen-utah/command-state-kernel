import type { ExecutionContext } from "../../../reference/typescript/src/index.ts";
import type { RoleSource } from "./roles.ts";

/**
 * Adapter configuration for the sample. The adapter knows who people are: their tokens and their
 * display names. Their roles come from the role source. Who may do what is the application's
 * policy (policy.ts). This file decides who may act on whose behalf, a question about the request.
 */

export interface User {
  readonly id: string;
  readonly displayName: string;
}

export function makeUser(id: string, displayName: string): User {
  return { id, displayName };
}

export interface Directory {
  byToken(token: string): User | undefined;
  byId(id: string): User | undefined;
}

export function makeDirectory(users: readonly User[], tokens: Record<string, string>): Directory {
  const byId = new Map(users.map((user) => [user.id, user]));
  return {
    byToken: (token) => {
      const id = tokens[token];
      return id === undefined ? undefined : byId.get(id);
    },
    byId: (id) => byId.get(id),
  };
}

export type RequestAuth =
  | { ok: true; ctx: ExecutionContext }
  | { ok: false; status: 401 | 403 | 404; reason: string };

/**
 * Turns request headers into an execution context. The caller is authenticated by bearer token.
 * Only an administrator may act as another user, with X-Act-As. The chain records the admin, and
 * the context names the target as the actor, so the target's rules apply.
 */
export function resolveRequestContext(
  headers: { authorization?: string | undefined; "x-act-as"?: string | undefined },
  directory: Directory,
  roles: RoleSource
): RequestAuth {
  const token = headers.authorization?.replace(/^Bearer /, "") ?? "";
  const caller = directory.byToken(token);
  if (!caller) return { ok: false, status: 401, reason: "Missing or unknown bearer token" };

  const actAs = headers["x-act-as"];
  if (actAs === undefined) {
    return {
      ok: true,
      ctx: {
        actor: { id: caller.id, displayName: caller.displayName, kind: "human" },
        delegationChain: [],
      },
    };
  }

  const callerRoles = roles.ensure(caller.id);
  if (callerRoles.status !== "loaded" || !callerRoles.roles.includes("admin")) {
    return { ok: false, status: 403, reason: "Only administrators may act on behalf of another user" };
  }
  const target = directory.byId(actAs);
  if (!target) return { ok: false, status: 404, reason: `No user ${actAs}` };

  return {
    ok: true,
    ctx: {
      actor: { id: target.id, displayName: target.displayName, kind: "human" },
      delegationChain: [{ id: caller.id, displayName: caller.displayName, kind: "human" }],
    },
  };
}
