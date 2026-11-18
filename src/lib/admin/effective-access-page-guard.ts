/**
 * Trusted server/nav authority guard for WP6 effective-access & global-role surfaces.
 *
 * Uses paired capability-scope grants (`hasPairedCapability`) whenever `effective_grants`
 * is present on the resolved actor, matching `/api/admin/access/**` (`role-access-api.ts`)
 * without mutating `direct-entry-page-access.ts` owned elsewhere.
 */
import {
  hasPairedCapability,
  type ActorResolution,
  type DirectEntryActor,
  type PairedEffectiveGrant,
} from "../auth/direct-entry-v2.ts";
import type { DirectEntryPageDecision } from "../auth/direct-entry-page-access.ts";
import {
  ADMIN_AUTHORITY_CAPABILITIES,
  adminSecurityNavPredicate,
  type NavActorProjection,
  type NavCapabilityPredicate,
} from "../navigation/registry-capability.ts";

/** Canonical Full Admin paired check (`entry_admin` ∧ `recruiter_master_manage` ∧ `team_master_manage` @ `ALL`). */
export function hasPairedFullAdminAuthority(
  actor: DirectEntryActor | null | undefined,
): boolean {
  if (!actor || actor.enabled !== true) return false;
  if (!Array.isArray(actor.effective_grants)) {
    return false;
  }
  return ADMIN_AUTHORITY_CAPABILITIES.every((capability) =>
    hasPairedCapability(actor, capability, { kind: "all" }),
  );
}

/** Nav-projection paired check matching `hasPairedFullAdminAuthority` without `app_user_id`. */
export function hasPairedGrantsAdminAuthority(
  grants: readonly PairedEffectiveGrant[] | null | undefined,
): boolean {
  if (!Array.isArray(grants)) return false;
  return ADMIN_AUTHORITY_CAPABILITIES.every((requiredCap) =>
    grants.some(
      (grant) =>
        grant.capability === requiredCap &&
        grant.scope_kind === "ALL" &&
        grant.scope_id === null,
    ),
  );
}

/**
 * Navigation visibility predicate for `/admin/access/effective`.
 * Fail-closed when `effective_grants` is present (never falls back to unpaired arrays).
 */
export const effectiveAccessAdminNavPredicate: NavCapabilityPredicate = (
  actor: NavActorProjection,
) => {
  if (Array.isArray(actor.effective_grants)) {
    return hasPairedGrantsAdminAuthority(actor.effective_grants);
  }
  return adminSecurityNavPredicate(actor);
};

/** Direct-URL server page guard for `/admin/access/effective`. */
export function decideEffectiveAccessPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  const { actor } = input;
  if (!actor) return "TEMPORARY_UNAVAILABLE";
  if (!actor.ok) {
    if (actor.reason === "UNAUTHENTICATED") return "REDIRECT_LOGIN";
    if (
      actor.reason === "ACTOR_MAPPING_MISSING" ||
      actor.reason === "ACTOR_DISABLED"
    ) {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "TEMPORARY_UNAVAILABLE";
  }
  return hasPairedFullAdminAuthority(actor.actor)
    ? "ALLOW"
    : "ACCESS_DENIED";
}
