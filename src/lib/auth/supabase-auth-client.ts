import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getServerEnv } from "@/lib/env";
import { createSupabaseCookieAdapter } from "./supabase-cookie-adapter";

export async function createSupabaseAuthClient() {
  const env = getServerEnv();
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: createSupabaseCookieAdapter(
      {
        getAll: () => cookieStore.getAll(),
        set: (name, value, options) => cookieStore.set(name, value, options),
      },
      { supabaseUrl: env.supabaseUrl },
    ),
  });
}
