import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getServerEnv } from "@/lib/env";
import {
  resolveDirectEntrySession,
  type DirectEntrySessionResult,
} from "./direct-entry-session-core";
import { resolveActor, type ActorRepository } from "./direct-entry-v2";
import {
  scopeAuthCookieStore,
  type AuthCookieWriteMode,
} from "./supabase-cookie-adapter";

export async function getDirectEntryActor(
  repository: ActorRepository | null | undefined,
  options: { cookieWriteMode?: AuthCookieWriteMode } = {},
): Promise<DirectEntrySessionResult> {
  const env = getServerEnv();
  const cookieStore = await cookies();
  return resolveDirectEntrySession({
    createClient: (url, publishableKey, options) =>
      createServerClient(url, publishableKey, options),
    resolveActor,
    supabaseUrl: env.supabaseUrl,
    publishableKey: env.supabasePublishableKey,
    cookieStore: scopeAuthCookieStore(
      {
        getAll: () => cookieStore.getAll(),
        set: (name, value, options) => cookieStore.set(name, value, options),
      },
      options.cookieWriteMode,
      { supabaseUrl: env.supabaseUrl },
    ),
    repository,
    at: new Date().toISOString(),
  });
}
