/**
 * P3-W05A - Reporting audience projection for W06C.
 *
 * A minimal typed server-side projection:
 *   { kind: 'all',  label: 'Toan cong ty' }
 *   { kind: 'team', label: teamDisplayName }
 *   { kind: 'own',  label: recruiterDisplayName | safe fallback }
 *
 * The DB is the authority for the resolved audience (including the display
 * label). This module:
 *   - exposes the locked priority rule all > team > own as a pure, testable
 *     function (the actor resolver always synthesizes an own scope);
 *   - normalizes the sanitized audience jsonb returned by the scoped RPC.
 *
 * No internal UUID, auth subject, capability/grant record, email or PII is
 * present in the projection.
 */

import {
  hasPairedAllReportingAccess,
  type DirectEntryActor,
} from "../auth/direct-entry-v2.ts";

export type ReportingAudienceKind = "all" | "team" | "own";

export interface ReportingAudience {
  kind: ReportingAudienceKind;
  label: string;
}

export const REPORTING_AUDIENCE_ALL_LABEL = "Toàn công ty";
export const REPORTING_AUDIENCE_OWN_FALLBACK_LABEL = "Cá nhân";

/**
 * Resolve the audience KIND strictly from the actor's paired `effective_grants`
 * (WP5B-2 Group A). Priority: all > team > own (fails closed when grants are missing/unpaired).
 */
export function resolveReportingAudienceKind(
  actor: DirectEntryActor,
): ReportingAudienceKind {
  if (hasPairedAllReportingAccess(actor)) return "all";
  if (
    actor.enabled === true &&
    Array.isArray(actor.effective_grants) &&
    actor.effective_grants.some(
      (grant) =>
        grant.scope_kind === "CONTEXT_TEAM" &&
        typeof grant.scope_id === "string" &&
        grant.scope_id.length > 0 &&
        (grant.capability === "entry_team" || grant.capability === "report_analytics_view"),
    )
  ) {
    return "team";
  }
  return "own";
}

/**
 * Normalize the sanitized audience jsonb returned by the scoped RPCs into
 * the typed projection. Returns null when the payload is malformed (the
 * caller must fail closed, not default to a zero dashboard).
 */
export function reportingAudienceFromDb(value: unknown): ReportingAudience | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = record["audience"];
  if (kind !== "all" && kind !== "team" && kind !== "own") return null;
  const rawLabel = record["label"];
  const label =
    typeof rawLabel === "string" && rawLabel.trim() !== ""
      ? rawLabel
      : kind === "all"
        ? REPORTING_AUDIENCE_ALL_LABEL
        : REPORTING_AUDIENCE_OWN_FALLBACK_LABEL;
  return { kind, label };
}

/**
 * Count the effective team scope reported by the scoped RPC. The DB resolves the
 * team audience from EVERY effective team scope grant but returns only the first
 * team's display label, so callers need the count to keep that label inclusive.
 * Only a count is derived here - no team UUID leaves this module.
 */
export function audienceTeamScopeCount(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const teamIds = (value as Record<string, unknown>)["team_ids"];
  if (!Array.isArray(teamIds)) return 0;
  return teamIds.length;
}

/**
 * Keep the team scope label inclusive when more than one team is in scope. A
 * single team keeps the DB label verbatim; a multi-team scope is labelled so no
 * surface can claim the whole scope is one named team.
 */
export function resolveAudienceScopeLabel(
  audience: ReportingAudience,
  teamCount: number,
): string {
  if (audience.kind !== "team") return audience.label;
  if (!Number.isFinite(teamCount) || teamCount <= 1) return audience.label;
  const others = Math.trunc(teamCount) - 1;
  return audience.label + " và " + others + " nhóm khác";
}
/**
 * Compose the final sanitized audience projection from a scoped RPC payload.
 * Returns null when the payload carries no usable audience, so the read path
 * fails closed instead of labelling facts with a scope the DB never confirmed.
 * The returned label is always the inclusive scope label (never a UUID).
 */
export function resolveReportingAudienceProjection(
  value: unknown,
): ReportingAudience | null {
  const audience = reportingAudienceFromDb(value);
  if (audience === null) return null;
  return {
    kind: audience.kind,
    label: resolveAudienceScopeLabel(audience, audienceTeamScopeCount(value)),
  };
}
