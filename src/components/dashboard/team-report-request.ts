import type { ReportingData } from "@/lib/reporting/p1-reporting";

/**
 * P3-W06D-R2 - request helpers shared by the team report and its detail list.
 *
 * The selected team's aggregate and its entry-level detail both ride on the
 * one server-authorized endpoint `GET /api/reporting/team-report`. Filters come
 * from the DB-applied `data.applied` (never from unvalidated URL state), and
 * `source` is never sent (team scope ignores it).
 */

export const TEAM_REPORT_FILTER_KEYS = ["from", "to", "project", "recruiter", "provider", "collaborator", "employment", "status"] as const;

export function teamReportUrl(data: ReportingData, bucketKey: string, cursor: string | null): string {
  const params = new URLSearchParams({ bucket_key: bucketKey, limit: "25" });
  for (const key of TEAM_REPORT_FILTER_KEYS) {
    const value = data.applied[key];
    if (value) params.set(key, value);
  }
  if (cursor) params.set("cursor", cursor);
  return "/api/reporting/team-report?" + params.toString();
}

/** Signature of the DB-applied filters: a change resets the team selection. */
export function teamReportDataSignature(data: ReportingData): string {
  return JSON.stringify({
    from: data.applied.from ?? null,
    to: data.applied.to ?? null,
    project: data.applied.project ?? null,
    recruiter: data.applied.recruiter ?? null,
    provider: data.applied.provider ?? null,
    collaborator: data.applied.collaborator ?? null,
    employment: data.applied.employment ?? null,
    status: data.applied.status ?? null,
    source: data.applied.source ?? null,
  });
}
