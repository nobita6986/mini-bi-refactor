/**
 * P2.5-W03 - API boundary worker directory (GET).
 *
 * Pipeline:
 *   1. DIRECT_ENTRY_API_ENABLED gate (route)
 *   2. parse/validate query (scope bat buoc, page_size/cursor/filter bound)
 *   3. Supabase SSR session (getDirectEntryActor)
 *   4. actor mapping server-side
 *   5. repository goi direct_entry_list_workers
 *   6. strict result projection (worker-directory-contract)
 *   7. sanitized response (private, no-store)
 *
 * GET khong mutation nen khong co CSRF/origin check. Reuse the actor RPC's
 * worker-tab projection for early denials. The directory RPC still checks scope.
 */
import type { WorkerOperationsTabId } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { projectWorkerDirectoryQuery } from "./worker-directory-contract.ts";
import type { WorkerDirectoryRepository } from "./worker-directory-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkerDirectoryDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: WorkerDirectoryRepository;
};

type TrustedActor = { auth_subject: string; app_user_id: string };

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

async function resolveTrustedActor(
  dependencies: WorkerDirectoryDependencies,
): Promise<{ ok: true; actor: TrustedActor; allowedTabs: readonly WorkerOperationsTabId[] | undefined } | { ok: false; response: Response }> {
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response: session.actor.reason === "UNAUTHENTICATED"
          ? fail("UNAUTHENTICATED", 401)
          : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    if (!actor || typeof actor.auth_subject !== "string" || !UUID.test(actor.auth_subject) ||
        typeof actor.app_user_id !== "string" || !UUID.test(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    return {
      ok: true,
      actor: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id },
      allowedTabs: actor.allowed_worker_tabs,
    };
  } catch {
    console.error("[direct-entry] worker directory session unavailable");
    return { ok: false, response: fail("WORKER_DIRECTORY_UNAVAILABLE", 500) };
  }
}

export async function listWorkers(
  request: Request,
  flag: string | undefined,
  dependencies: WorkerDirectoryDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  let parsed: ReturnType<typeof projectWorkerDirectoryQuery>;
  try {
    parsed = projectWorkerDirectoryQuery(new URL(request.url).searchParams);
  } catch {
    return fail("WORKER_QUERY_INVALID", 400);
  }
  if (!parsed.ok) return fail(parsed.code, 400);

  const session = await resolveTrustedActor(dependencies);
  if (!session.ok) return session.response;
  if (session.allowedTabs !== undefined && !session.allowedTabs.includes(parsed.value.scope)) {
    return fail("WORKER_DIRECTORY_DENIED", 403);
  }

  let result: Awaited<ReturnType<WorkerDirectoryRepository["listWorkers"]>>;
  try {
    result = await dependencies.repository.listWorkers({
      ...session.actor,
      ...parsed.value,
    });
  } catch {
    console.error("[direct-entry] worker directory list failed");
    return fail("WORKER_DIRECTORY_UNAVAILABLE", 500);
  }
  if (!result.ok) {
    if (result.kind === "invalid") return fail("WORKER_QUERY_INVALID", 400);
    if (result.kind === "denied") return fail("WORKER_DIRECTORY_DENIED", 403);
    if (result.kind === "not-found") return fail("WORKER_DIRECTORY_DENIED", 403);
    console.error("[direct-entry] worker directory unavailable");
    return fail("WORKER_DIRECTORY_UNAVAILABLE", 500);
  }
  return respond({
    ok: true,
    scope: result.data.scope,
    items: result.data.items,
    page_size: result.data.page_size,
    has_more: result.data.has_more,
    next_cursor: result.data.next_cursor,
    authorization_date: result.data.authorization_date,
    summary: result.data.summary,
  }, 200);
}
