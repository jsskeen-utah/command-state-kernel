/**
 * A cache of each actor's roles, filled from a remote identity service. The application's rules read
 * it synchronously. A miss starts a background lookup and reports "loading". A failed lookup is
 * reported as "failed", and the policy fails closed on both. See SPECIFICATION §12.
 */

export type RoleState =
  | { readonly status: "loaded"; readonly roles: readonly string[] }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly reason: string };

export interface RoleSource {
  /** Returns the actor's roles if known. Otherwise starts a lookup and reports "loading" or "failed". */
  ensure(actorId: string): RoleState;
}

export interface RoleCacheOptions {
  /** Roles already known, for example from the directory at startup. */
  readonly seed?: Readonly<Record<string, readonly string[]>>;
  /** How long a failed lookup is reported as failed before another lookup is started. */
  readonly retryAfterMs?: number;
}

export function createRoleCache(
  fetchRoles: (actorId: string) => Promise<readonly string[]>,
  options: RoleCacheOptions = {}
): RoleSource {
  const loaded = new Map<string, readonly string[]>(Object.entries(options.seed ?? {}));
  const inFlight = new Set<string>();
  const failed = new Map<string, { reason: string; at: number }>();
  const retryAfterMs = options.retryAfterMs ?? 30_000;

  return {
    ensure(actorId) {
      const known = loaded.get(actorId);
      if (known) return { status: "loaded", roles: known };

      const recent = failed.get(actorId);
      if (recent && Date.now() - recent.at < retryAfterMs) return { status: "failed", reason: recent.reason };

      if (!inFlight.has(actorId)) {
        inFlight.add(actorId);
        fetchRoles(actorId)
          .then(
            (roles) => {
              loaded.set(actorId, roles);
              failed.delete(actorId);
            },
            (error) => {
              failed.set(actorId, { reason: error instanceof Error ? error.message : String(error), at: Date.now() });
            }
          )
          .finally(() => inFlight.delete(actorId));
      }
      return { status: "loading" };
    },
  };
}
