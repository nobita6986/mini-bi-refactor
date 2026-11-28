import type { ActorResolution, PartnerKind } from "../auth/direct-entry-v2.ts";

export type PartnerPortalAccessDecision =
  | "NOT_FOUND"
  | "REDIRECT_LOGIN"
  | "ACCOUNT_PENDING_ACTIVATION"
  | "ACCOUNT_UNAVAILABLE"
  | "TEMPORARY_UNAVAILABLE"
  | "PARTNER_FORBIDDEN"
  | "PASSWORD_CHANGE_REQUIRED"
  | "ALLOW";

export function decidePartnerPortalPageAccess(input: {
  enabledFlag: string | undefined;
  actor: ActorResolution | null;
  requireVendor?: boolean;
  allowMustChangePassword?: boolean;
}): PartnerPortalAccessDecision {
  if (input.enabledFlag !== "true") {
    return "NOT_FOUND";
  }
  const resolution = input.actor;
  if (!resolution) {
    return "TEMPORARY_UNAVAILABLE";
  }
  if (!resolution.ok) {
    if (resolution.reason === "UNAUTHENTICATED") return "REDIRECT_LOGIN";
    if (resolution.reason === "ACTOR_PENDING_ACTIVATION") {
      return "ACCOUNT_PENDING_ACTIVATION";
    }
    if (
      resolution.reason === "ACTOR_DISABLED" ||
      resolution.reason === "ACTOR_MAPPING_MISSING"
    ) {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "TEMPORARY_UNAVAILABLE";
  }

  const partner = resolution.actor.partner_account;
  if (!partner) {
    return "PARTNER_FORBIDDEN";
  }
  if (
    !input.allowMustChangePassword &&
    (partner.must_change_password ||
      partner.account_state === "ACTIVE_MUST_CHANGE_PASSWORD")
  ) {
    return "PASSWORD_CHANGE_REQUIRED";
  }
  if (input.requireVendor && partner.partner_kind !== "VENDOR") {
    return "PARTNER_FORBIDDEN";
  }
  return "ALLOW";
}

export function canAccessVendorPortalTabs(
  partnerKind: PartnerKind | null | undefined,
): boolean {
  return partnerKind === "VENDOR";
}
