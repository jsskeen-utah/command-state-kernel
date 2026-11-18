import { createExpenseKernel, fakeBank, SEED_STATE, fieldClassifications, type Bank, type ExpenseState } from "./domain.ts";
import { makeDirectory, makeUser, type Directory } from "./auth.ts";
import { createPolicy } from "./policy.ts";
import { createRoleCache, type RoleSource } from "./roles.ts";
import { createHistory, type History } from "./history.ts";
import type { CommandStateKernel } from "../../../reference/typescript/src/index.ts";

export const DEMO_USERS = [
  makeUser("user:alice", "Alice"),
  makeUser("user:mia", "Mia"),
  makeUser("user:fin", "Fin"),
  makeUser("user:root", "Root"),
];

/** Roles as the identity service knows them. The demo starts with these already loaded. */
export const DEMO_ROLES: Record<string, readonly string[]> = {
  "user:alice": ["employee"],
  "user:mia": ["employee", "manager"],
  "user:fin": ["employee", "finance"],
  "user:root": ["employee", "manager", "finance", "admin"],
};

/** Demo tokens. Anyone who can read this file can use them, which is fine for a sample and nothing else. */
export const DEMO_TOKENS: Record<string, string> = {
  "tok-alice": "user:alice",
  "tok-mia": "user:mia",
  "tok-fin": "user:fin",
  "tok-root": "user:root",
};

export interface Demo {
  readonly kernel: CommandStateKernel<ExpenseState>;
  readonly directory: Directory;
  readonly roles: RoleSource;
  readonly history: History;
}

/**
 * Builds the demo. By default the roles are already loaded, so requests can be made at once. Pass a
 * role source to simulate a remote identity service that is slow or failing.
 */
export function buildDemo(options: { bank?: Bank; roles?: RoleSource } = {}): Demo {
  const directory = makeDirectory(DEMO_USERS, DEMO_TOKENS);
  const roles = options.roles ?? createRoleCache(() => Promise.reject(new Error("no lookup")), { seed: DEMO_ROLES });
  const policy = createPolicy(roles);
  const kernel = createExpenseKernel({
    seed: SEED_STATE,
    bank: options.bank ?? fakeBank(["r-4"]),
    policy,
  });
  const history = createHistory(kernel, {
    readDecision: policy.readDecision,
    classifiedFields: fieldClassifications,
  });
  return { kernel, directory, roles, history };
}
