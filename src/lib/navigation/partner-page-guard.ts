import type { ActorResolution } from "../auth/direct-entry-v2.ts";

export type InternalBiPartnerBlock = "REDIRECT_CHANGE_PASSWORD" | "ACCESS_DENIED";

/**
 * Shared server-page guard for internal BI routes:
 * - Returns null for BI employees (no `partner_account`) or non-OK resolutions.
 * - Forces partners with `must_change_password` to `/partner/change-password`.
 * - Denies active partners with `<AccessDenied />`.
 */
export function resolveInternalBiPartnerBlock(
  actor: ActorResolution | null | undefined,
): InternalBiPartnerBlock | null {
  if (!actor?.ok || !actor.actor.partner_account) {
    return null;
  }
  const partner = actor.actor.partner_account;
  if (
    partner.must_change_password ||
    partner.account_state === "ACTIVE_MUST_CHANGE_PASSWORD"
  ) {
    return "REDIRECT_CHANGE_PASSWORD";
  }
  return "ACCESS_DENIED";
}
