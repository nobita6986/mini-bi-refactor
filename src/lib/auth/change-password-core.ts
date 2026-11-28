/**
 * P3-W09A - Self-service password change for the currently authenticated account.
 *
 *   - The session is the only authority for "which user". The client NEVER names
 *     a target user. The route ignores any `email` / `user_id` field in the body.
 *   - "current password" is required so we don't silently change a password when
 *     a stolen device or shared kiosk is still signed in. The verification uses
 *     the existing Supabase `signInWithPassword` contract (which already maps
 *     HR Partner IDs to <id>@hrpartner.vn) and only proceeds if the returned
 *     auth subject equals the active session subject.
 *   - The actual update calls `client.auth.updateUser({ password })` against the
 *     cookie-bound client. The session's tokens are refreshed in-place by the
 *     Supabase ssr adapter; we never read or echo the new password.
 *   - All errors are mapped to the same codes the rest of the auth surface uses:
 *     UNAUTHENTICATED, AUTH_REQUEST_INVALID, AUTH_INVALID_CURRENT_PASSWORD,
 *     AUTH_PASSWORD_TOO_WEAK, AUTH_UNAVAILABLE, CSRF_REJECTED.
 *   - No DML, no logging, no env mutation, no dep changes.
 */
import type { ActorRepository, ActorResolution, DirectEntryActor } from "./direct-entry-v2";
import { isSameOriginAuthRequest } from "./same-origin-auth-request.ts";
import { z } from "zod";

const MAX_BODY_BYTES = 4096;
const MIN_PASSWORD_BYTES = 8;
const MAX_PASSWORD_BYTES = 1024;
// Mirrors the auth-session-core surface (no-store + nosniff + no-referrer) so
// every JSON response from this route is treated the same way by the browser.
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

type User = { id: string; email?: string | null };

export type PasswordChangeClient = {
  auth: {
    getUser(): Promise<{ data: { user: User | null }; error: unknown }>;
    signInWithPassword(input: { email: string; password: string }): Promise<{
      data: { user: User | null };
      error: unknown;
    }>;
    updateUser(input: { password: string }): Promise<{
      data: { user: User | null };
      error: unknown;
    }>;
  };
};

export type PasswordChangeDeps = {
  createClient(): Promise<PasswordChangeClient>;
  now(): string;
  /** Optional resolver; if present, used only to ensure the session is bound to a known actor. */
  resolveActor?(input: {
    session: { auth_subject: string; provider: "supabase"; authenticated_at: null };
    repository: ActorRepository | null | undefined;
    at: string;
  }): Promise<ActorResolution>;
  repository?: ActorRepository | null;
  /** Optional hook to mark partner password changed in DB after Auth password update. */
  markPartnerPasswordChanged?(input: {
    auth_subject: string;
    app_user_id: string;
  }): Promise<{ ok: boolean }>;
};

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function failure(code: string, status: number): Response {
  return json({ ok: false, code }, status);
}

const hrPartnerIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function resolveIdentifierToEmail(identifier: string): string {
  const lowered = identifier.trim().toLowerCase();
  return hrPartnerIdPattern.test(lowered) ? `${lowered}@hrpartner.vn` : lowered;
}

function sameOriginFailure(request: Request): Response | null {
  return isSameOriginAuthRequest(request) ? null : failure("CSRF_REJECTED", 403);
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return null;
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return null;
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

const passwordSchema = z.string()
  .min(MIN_PASSWORD_BYTES)
  .max(MAX_PASSWORD_BYTES);

/**
 * Validates the bounded body shape { currentPassword, newPassword, confirmPassword }.
 *
 * Accepts ONLY those three keys; any additional property (email, user_id,
 * scope, capability, etc.) is rejected so the client cannot direct the
 * change at a different account.
 */
function projectChangePasswordInput(value: unknown):
  { currentPassword: string; newPassword: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expected = ["currentPassword", "newPassword", "confirmPassword"] as const;
  if (keys.length !== 3 ||
      !expected.every((k) => Object.hasOwn(record, k))) return null;
  for (const k of expected) {
    if (typeof record[k] !== "string") return null;
  }
  const currentPassword = record.currentPassword as string;
  const newPassword = record.newPassword as string;
  const confirmPassword = record.confirmPassword as string;

  if (currentPassword.length === 0) return null;
  if (new TextEncoder().encode(currentPassword).byteLength > MAX_PASSWORD_BYTES) return null;
  if (new TextEncoder().encode(newPassword).byteLength > MAX_PASSWORD_BYTES) return null;
  if (newPassword !== confirmPassword) return null;
  if (!passwordSchema.safeParse(newPassword).success) return null;
  if (newPassword === currentPassword) return null;
  return { currentPassword, newPassword };
}

function isCredentialRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return true;
  const status = (error as { status: unknown }).status;
  return typeof status !== "number" || status === 400 || status === 401;
}

/**
 * Verifies the active session, re-validates the supplied current password
 * against the same auth_subject, then issues `updateUser({ password })`.
 *
 * All operations are confined to the cookie-bound Supabase client so the
 * session cookies stay consistent. No password is logged, echoed, or
 * persisted outside the immediate Supabase round-trip.
 */
export async function createChangePasswordResponse(
  request: Request,
  dependencies: PasswordChangeDeps,
): Promise<Response> {
  const csrf = sameOriginFailure(request);
  if (csrf) return csrf;

  const input = projectChangePasswordInput(await readBoundedJson(request));
  if (!input) return failure("AUTH_REQUEST_INVALID", 400);

  try {
    const client = await dependencies.createClient();

    // 1) The session MUST be live and bound to the current cookie jar.
    const session = await client.auth.getUser();
    if (session.error || !session.data.user?.id) {
      return failure("AUTH_UNAUTHENTICATED", 401);
    }
    const sessionUser = session.data.user;
    if (typeof sessionUser.email !== "string" || sessionUser.email.length === 0) {
      // Cannot verify current password without an email/HRP id to feed Supabase.
      return failure("AUTH_UNAVAILABLE", 503);
    }

    // 2) Optional downstream check: ensure the session maps to a usable actor.
    let resolvedActor: DirectEntryActor | null = null;
    if (dependencies.resolveActor) {
      const resolution = await dependencies.resolveActor({
        session: {
          auth_subject: sessionUser.id,
          provider: "supabase",
          authenticated_at: null,
        },
        repository: dependencies.repository ?? null,
        at: dependencies.now(),
      });
      if (!resolution.ok) {
        if (resolution.reason === "UNAUTHENTICATED") {
          return failure("AUTH_UNAUTHENTICATED", 401);
        }
        if (resolution.reason === "ACTOR_PENDING_ACTIVATION") {
          return failure("ACCOUNT_PENDING_ACTIVATION", 403);
        }
        return failure("ACCOUNT_NOT_AVAILABLE", 403);
      }
      resolvedActor = resolution.actor;
    }

    // 3) Re-authenticate with the supplied current password against the SAME
    //    email/HRP id the session is bound to. We never accept a different
    //    email/user_id from the body; the session determines the identifier.
    const identifier = sessionUser.email;
    const reauth = await client.auth.signInWithPassword({
      email: resolveIdentifierToEmail(identifier),
      password: input.currentPassword,
    });
    if (reauth.error) {
      return isCredentialRejection(reauth.error)
        ? failure("AUTH_INVALID_CURRENT_PASSWORD", 401)
        : failure("AUTH_UNAVAILABLE", 503);
    }
    if (!reauth.data.user?.id || reauth.data.user.id !== sessionUser.id) {
      return failure("AUTH_INVALID_CURRENT_PASSWORD", 401);
    }

    // 4) Issue the password update. The Supabase client refreshes the
    //    session tokens in-place via the cookie adapter; the route does
    //    not need to inspect or echo them.
    const updated = await client.auth.updateUser({ password: input.newPassword });
    if (updated.error) {
      const status = (updated.error as { status?: unknown }).status;
      if (status === 422 || status === 400) {
        return failure("AUTH_PASSWORD_TOO_WEAK", 422);
      }
      return isCredentialRejection(updated.error)
        ? failure("AUTH_INVALID_CURRENT_PASSWORD", 401)
        : failure("AUTH_UNAVAILABLE", 503);
    }

    // 5) Partner accounts must transition ACTIVE_MUST_CHANGE_PASSWORD -> ACTIVE in DB.
    if (resolvedActor?.partner_account) {
      if (!dependencies.markPartnerPasswordChanged) {
        return failure("AUTH_UNAVAILABLE", 503);
      }
      const marked = await dependencies.markPartnerPasswordChanged({
        auth_subject: resolvedActor.auth_subject,
        app_user_id: resolvedActor.app_user_id,
      });
      if (!marked.ok) {
        return failure("AUTH_UNAVAILABLE", 503);
      }
    }

    return json({ ok: true }, 200);
  } catch {
    return failure("AUTH_UNAVAILABLE", 503);
  }
}
