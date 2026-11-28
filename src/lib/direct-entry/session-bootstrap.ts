import {
  projectClientCapabilities,
  projectClientScopes,
  type DirectEntryActor,
} from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core";

const NO_STORE = "private, no-store";

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": NO_STORE },
  });
}

export async function createDirectEntrySessionResponse(
  flag: string | undefined,
  resolveSession: () => Promise<DirectEntrySessionResult>,
): Promise<Response> {
  if (flag !== "true") {
    return json({ ok: false, code: "NOT_FOUND" }, 404);
  }

  try {
    const result = await resolveSession();
    if (!result.actor.ok) {
      if (result.actor.reason === "UNAUTHENTICATED") {
        return json({ ok: false, code: "UNAUTHENTICATED" }, 401);
      }
      return json({ ok: false, code: "ACTOR_NOT_AVAILABLE" }, 403);
    }
    if (result.actor.actor.partner_account !== undefined) {
      return json({ ok: false, code: "ACTOR_NOT_AVAILABLE" }, 403);
    }

    const actor: Pick<
      DirectEntryActor,
      | "app_user_id"
      | "capabilities"
      | "scopes"
      | "self_recruiter_suggestion"
      | "effective_report_review_scopes"
      | "allowed_worker_tabs"
    > = {
      app_user_id: result.actor.actor.app_user_id,
      capabilities: projectClientCapabilities(result.actor.actor),
      scopes: projectClientScopes(result.actor.actor),
      self_recruiter_suggestion: result.actor.actor.self_recruiter_suggestion,
      ...(result.actor.actor.effective_report_review_scopes !== undefined
        ? { effective_report_review_scopes: result.actor.actor.effective_report_review_scopes }
        : {}),
      ...(result.actor.actor.allowed_worker_tabs !== undefined
        ? { allowed_worker_tabs: result.actor.actor.allowed_worker_tabs }
        : {}),
    };
    const headers = new Headers({ "Cache-Control": NO_STORE });
    for (const [name, value] of Object.entries(result.response_headers)) {
      if (["expires", "pragma"].includes(name.toLowerCase())) headers.set(name, value);
    }
    return Response.json({ ok: true, actor }, { headers });
  } catch {
    console.error("[direct-entry] session bootstrap unavailable");
    return json({ ok: false, code: "SESSION_UNAVAILABLE" }, 503);
  }
}
