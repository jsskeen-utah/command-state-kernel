import type { ExecutionContext, ReadDecision } from "../../../reference/typescript/src/index.ts";
import type { RoleSource } from "./roles.ts";

/**
 * The application's authorization rules, in one place. Who may do what is decided here, from the
 * actor and the target. Whether a command makes sense for the report's current status is decided
 * by the command itself, in the domain, because that is state and not authorization.
 *
 * Roles come from a RoleSource. While they are loading, or if their lookup failed, every decision
 * is a refusal (fail closed), with a reason that says which it is.
 */

export type Action =
  | "report.create"
  | "report.edit"
  | "report.delete"
  | "report.submit"
  | "report.unsubmit"
  | "report.approve"
  | "report.unapprove"
  | "report.reject"
  | "report.pay";

export interface Target {
  readonly ownerId: string;
}

export interface Decision {
  readonly allow: boolean;
  readonly reason?: string;
}

export interface Policy {
  can(actor: ExecutionContext["actor"], action: Action, target?: Target): Decision;
  readDecision(classification: string, ctx: ExecutionContext): ReadDecision;
}

export const LOADING_REASON = "Permissions are still loading. Try again shortly.";
export const UNAVAILABLE_REASON = "Permissions could not be checked. Try again later.";

type Rule = (actor: ExecutionContext["actor"], roles: readonly string[], target?: Target) => Decision;

const ALLOW: Decision = { allow: true };
const refuse = (reason: string): Decision => ({ allow: false, reason });

const ownerOnly: Rule = (actor, _roles, target) =>
  target !== undefined && target.ownerId !== actor.id ? refuse("Only the owner can do this") : ALLOW;

const managerOnly = (reason: string): Rule => (_actor, roles) =>
  roles.includes("manager") ? ALLOW : refuse(reason);

const financeOnly = (reason: string): Rule => (_actor, roles) =>
  roles.includes("finance") ? ALLOW : refuse(reason);

const RULES: Record<Action, Rule> = {
  "report.create": () => ALLOW,
  "report.edit": ownerOnly,
  "report.delete": ownerOnly,
  "report.submit": ownerOnly,
  "report.unsubmit": ownerOnly,
  "report.approve": (actor, roles, target) => {
    if (!roles.includes("manager")) return refuse("Only managers can approve");
    if (target !== undefined && target.ownerId === actor.id) return refuse("You cannot approve your own report");
    return ALLOW;
  },
  "report.unapprove": managerOnly("Only managers can revoke approval"),
  "report.reject": managerOnly("Only managers can reject"),
  "report.pay": financeOnly("Only finance can pay"),
};

/**
 * Builds the sample's policy from a source of roles. The rules above are the only place that
 * decides who may act. The read policy below is the only place that decides who may see sensitive
 * state, and it reads the same roles.
 */
export function createPolicy(roles: RoleSource): Policy {
  const current = (actor: ExecutionContext["actor"]) => roles.ensure(actor.id);

  return {
    can: (actor, action, target) => {
      const state = current(actor);
      if (state.status === "loading") return refuse(LOADING_REASON);
      if (state.status === "failed") return refuse(UNAVAILABLE_REASON);
      return RULES[action](actor, state.roles, target);
    },
    readDecision: (classification, ctx) => {
      const state = current(ctx.actor);
      if (state.status !== "loaded") return "deny";
      const finance = state.roles.includes("finance");
      if (classification === "public" || classification === "internal") return "allow";
      if (classification === "pii") return finance ? "allow" : "mask";
      if (classification === "secret") return finance ? "allow" : "deny";
      return "deny";
    },
  };
}
