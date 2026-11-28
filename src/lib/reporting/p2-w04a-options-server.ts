import "server-only";

import type { DirectEntryActor } from "@/lib/auth/direct-entry-v2";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { buildSourceOptions } from "./p1-dashboard";
import type { ReportingOptionsCatalog } from "./p1-dashboard";
import { buildDimensionOptions } from "./p1-reporting";
import type { DimensionOptionRow } from "./p1-reporting";
import { P2_W04A_CUTOVER_FAILED_CODE } from "./p2-w04a-cutover";

/**
 * P3-W05A — Actor-scoped cutover dimension options.
 *
 * Options are generated at the DB boundary from the SAME authorized row set
 * as the scoped facts, so no out-of-scope dimension leaks into the filter
 * catalog or rankings. `actor` is a mandatory input.
 */

export type CutoverOptionsResult =
  | { ok: true; options: ReportingOptionsCatalog }
  | { ok: false; code: string; message: string };

function logSafeError(prefix: string, error: unknown) {
  const safeCode =
    error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "unknown";
  console.error("[" + prefix + "] query failed. code=" + safeCode);
}

/**
 * Read the actor-scoped options catalog from the DB boundary.
 */
export async function fetchCutoverReportingOptions(
  actor: DirectEntryActor,
): Promise<CutoverOptionsResult> {
  try {
    const sb = createServiceSupabaseClient();
    const res = await sb.rpc("direct_entry_reporting_scoped_options", {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
    });
    if (res.error) {
      logSafeError("p3-w05a-options", res.error);
      return { ok: false, code: P2_W04A_CUTOVER_FAILED_CODE, message: "Cutover options read path failed." };
    }

    const payload = (res.data ?? {}) as {
      dimensions?: DimensionOptionRow[];
      collaborators?: { key: string; display: string }[];
      sources?: { id: string; file_name: string }[];
    };
    const dimensions = buildDimensionOptions(payload.dimensions ?? []);
    if (
      dimensions.collaborators.length === 0 &&
      Array.isArray(payload.collaborators) &&
      payload.collaborators.length > 0
    ) {
      dimensions.collaborators = payload.collaborators
        .filter(
          (item): item is { key: string; display: string } =>
            Boolean(item) && typeof item.key === "string" && item.key.trim() !== "",
        )
        .map((item) => ({
          key: item.key,
          display:
            typeof item.display === "string" && item.display.trim() !== ""
              ? item.display
              : item.key,
        }))
        .sort((a, b) => a.display.localeCompare(b.display, "vi"));
    }
    return {
      ok: true,
      options: {
        dimensions,
        sources: buildSourceOptions(payload.sources ?? []),
      },
    };
  } catch (error) {
    logSafeError("p3-w05a-options", error);
    return { ok: false, code: P2_W04A_CUTOVER_FAILED_CODE, message: "Cutover options read path failed." };
  }
}
