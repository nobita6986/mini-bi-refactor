import {
  projectClientCapabilities,
  projectClientScopes,
  type ActorRepository,
  type ActorResolution,
  type DirectEntryActor,
  type SessionIdentity,
} from "./direct-entry-v2.ts";
import { isSameOriginAuthRequest } from "./same-origin-auth-request.ts";
import { z } from "zod";

const MAX_BODY_BYTES = 4096;
const MAX_PASSWORD_BYTES = 1024;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const emailSchema = z.email().max(254);

type User = { id: string };

export type AuthClient = {
  auth: {
    signInWithPassword(input: { email: string; password: string }): Promise<{
      data: { user: User | null };
      error: unknown;
    }>;
    getUser(): Promise<{ data: { user: User | null }; error: unknown }>;
    signOut(options: { scope: "local" }): Promise<{ error: unknown }>;
  };
};

export type AuthDependencies = {
  createClient(): Promise<AuthClient>;
  repository: ActorRepository;
  resolveActor(input: {
    session: SessionIdentity;
    repository: ActorRepository;
    at: string;
  }): Promise<ActorResolution>;
  now(): string;
};

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function failure(code: string, status: number): Response {
  return json({ ok: false, code }, status);
}

function actorProjection(actor: DirectEntryActor) {
  // P2.5-HF-R5: display_name is the only identity field added for the header.
  // Email, auth_subject, login metadata, and raw effective_grants are never projected.
  return {
    app_user_id: actor.app_user_id,
    display_name: actor.display_name,
    capabilities: projectClientCapabilities(actor),
    scopes: projectClientScopes(actor),
    self_recruiter_suggestion: actor.self_recruiter_suggestion,
  };
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

function projectCredentials(value: unknown): { email: string; password: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, "email") || !Object.hasOwn(record, "password") ||
      typeof record.email !== "string" || typeof record.password !== "string") return null;

  const identifier = record.email.trim().toLowerCase();
  const email = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(identifier)
    ? `${identifier}@hrpartner.vn`
    : identifier;
  if (!emailSchema.safeParse(email).success ||
      record.password.length === 0 ||
      new TextEncoder().encode(record.password).byteLength > MAX_PASSWORD_BYTES) return null;
  return { email, password: record.password };
}

function isCredentialRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return true;
  const status = error.status;
  return typeof status !== "number" || status === 400 || status === 401;
}

async function resolveActor(
  dependencies: AuthDependencies,
  userId: string,
): Promise<ActorResolution> {
  return dependencies.resolveActor({
    session: {
      auth_subject: userId,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: dependencies.repository,
    at: dependencies.now(),
  });
}

export async function createAuthLoginResponse(
  request: Request,
  dependencies: AuthDependencies,
): Promise<Response> {
  const csrf = sameOriginFailure(request);
  if (csrf) return csrf;

  const credentials = projectCredentials(await readBoundedJson(request));
  if (!credentials) return failure("AUTH_REQUEST_INVALID", 400);

  try {
    const client = await dependencies.createClient();
    const signedIn = await client.auth.signInWithPassword(credentials);
    if (signedIn.error) {
      return isCredentialRejection(signedIn.error)
        ? failure("AUTH_INVALID_CREDENTIALS", 401)
        : failure("AUTH_UNAVAILABLE", 503);
    }
    if (!signedIn.data.user?.id) {
      return failure("AUTH_INVALID_CREDENTIALS", 401);
    }

    const actor = await resolveActor(dependencies, signedIn.data.user.id);
    if (!actor.ok) {
      const signedOut = await client.auth.signOut({ scope: "local" });
      if (signedOut.error) return failure("AUTH_UNAVAILABLE", 503);
      return failure("ACCOUNT_NOT_AVAILABLE", 403);
    }
    return json({ ok: true, actor: actorProjection(actor.actor) }, 200);
  } catch {
    return failure("AUTH_UNAVAILABLE", 503);
  }
}

export async function createAuthLogoutResponse(
  request: Request,
  dependencies: Pick<AuthDependencies, "createClient">,
): Promise<Response> {
  const csrf = sameOriginFailure(request);
  if (csrf) return csrf;
  try {
    const client = await dependencies.createClient();
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) return failure("AUTH_UNAVAILABLE", 503);
    return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
  } catch {
    return failure("AUTH_UNAVAILABLE", 503);
  }
}

export async function createAuthSessionResponse(
  resolveSession: () => Promise<{
    actor: ActorResolution;
  }>,
): Promise<Response> {
  try {
    const result = await resolveSession();
    if (!result.actor.ok) {
      return result.actor.reason === "UNAUTHENTICATED"
        ? failure("AUTH_UNAUTHENTICATED", 401)
        : failure("ACCOUNT_NOT_AVAILABLE", 403);
    }
    return json({ ok: true, actor: actorProjection(result.actor.actor) }, 200);
  } catch {
    return failure("AUTH_UNAVAILABLE", 503);
  }
}
