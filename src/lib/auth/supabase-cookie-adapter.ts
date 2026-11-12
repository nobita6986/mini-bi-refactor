import type { CookieMethodsServer, CookieOptions } from "@supabase/ssr";

export const MAX_HTTP_HEADER_SIZE_BYTES = 32768;

export type AuthCookieStore = {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: CookieOptions): void;
};

export type AuthCookieWriteMode = "read-write" | "read-only";

export type AuthCookieScopeOptions = {
  supabaseUrl?: string | null;
  storageKey?: string | null;
};

export type CookieHeaderMetricsSummary = {
  totalCookieCount: number;
  estimatedCookieHeaderBytes: number;
  activeSupabaseCookieCount: number;
  activeSupabaseBytes: number;
  staleSupabaseCookieCount: number;
  staleSupabaseBytes: number;
  staleSupabaseCookieNames: string[];
  duplicateCookieNames: string[];
  otherCookieCount: number;
  otherCookieBytes: number;
  entries: Array<{
    name: string;
    byteLength: number;
    category: "active_supabase" | "stale_supabase" | "other";
  }>;
};

const SUPABASE_MANAGED_COOKIE_PATTERN =
  /^sb-[a-z0-9_-]+-auth-token(?:\.\d+|-code-verifier(?:\.\d+|\/[^\s;,]*)?)?$/i;

const EXPIRE_STALE_COOKIE_OPTIONS: CookieOptions = {
  path: "/",
  maxAge: 0,
  sameSite: "lax",
};

export function resolveSupabaseStorageKey(
  supabaseUrl?: string | null,
): string | null {
  if (typeof supabaseUrl !== "string" || !supabaseUrl.trim()) {
    return null;
  }
  try {
    const hostname = new URL(supabaseUrl).hostname;
    const projectRef = hostname.split(".")[0]?.trim();
    if (!projectRef) return null;
    return `sb-${projectRef}-auth-token`;
  } catch {
    return null;
  }
}

export function isSupabaseManagedCookieName(name: string): boolean {
  return SUPABASE_MANAGED_COOKIE_PATTERN.test(name);
}

export function isActiveSupabaseCookieName(
  name: string,
  storageKey: string,
): boolean {
  const verifierBase = `${storageKey}-code-verifier`;
  return (
    name === storageKey ||
    name.startsWith(`${storageKey}.`) ||
    name === verifierBase ||
    name.startsWith(`${verifierBase}.`) ||
    name.startsWith(`${verifierBase}/`)
  );
}

function collectOrphanedChunkNamesForBaseKey(
  cookieNames: ReadonlySet<string>,
  baseKey: string,
): Set<string> {
  const orphaned = new Set<string>();
  const prefix = `${baseKey}.`;
  const chunkEntries: Array<{ name: string; index: number }> = [];

  for (const name of cookieNames) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const index = Number(suffix);
    if (Number.isSafeInteger(index) && index >= 0) {
      chunkEntries.push({ name, index });
    }
  }

  if (chunkEntries.length === 0) {
    return orphaned;
  }

  if (cookieNames.has(baseKey)) {
    for (const entry of chunkEntries) {
      orphaned.add(entry.name);
    }
    return orphaned;
  }

  const indexSet = new Set(chunkEntries.map((entry) => entry.index));
  let contiguousLimit = 0;
  while (indexSet.has(contiguousLimit)) {
    contiguousLimit += 1;
  }

  for (const entry of chunkEntries) {
    if (entry.index >= contiguousLimit) {
      orphaned.add(entry.name);
    }
  }

  return orphaned;
}

export function findStaleSupabaseCookieNames(
  cookies: ReadonlyArray<{ name: string; value: string }>,
  storageKey?: string | null,
): string[] {
  if (!storageKey) return [];

  const cookieNames = new Set(cookies.map((cookie) => cookie.name));
  const orphanedChunks = new Set<string>([
    ...collectOrphanedChunkNamesForBaseKey(cookieNames, storageKey),
    ...collectOrphanedChunkNamesForBaseKey(
      cookieNames,
      `${storageKey}-code-verifier`,
    ),
  ]);

  const staleNames: string[] = [];
  const seen = new Set<string>();

  for (const { name } of cookies) {
    if (seen.has(name)) continue;
    const isForeignSupabase =
      isSupabaseManagedCookieName(name) &&
      !isActiveSupabaseCookieName(name, storageKey);
    if (isForeignSupabase || orphanedChunks.has(name)) {
      seen.add(name);
      staleNames.push(name);
    }
  }

  return staleNames;
}

export function filterAndDedupeAuthCookies(
  cookies: ReadonlyArray<{ name: string; value: string }>,
  storageKey?: string | null,
): { name: string; value: string }[] {
  const staleSet = new Set(findStaleSupabaseCookieNames(cookies, storageKey));
  const seenNames = new Set<string>();
  const filtered: { name: string; value: string }[] = [];

  for (const cookie of cookies) {
    if (staleSet.has(cookie.name) || seenNames.has(cookie.name)) {
      continue;
    }
    seenNames.add(cookie.name);
    filtered.push({ name: cookie.name, value: cookie.value });
  }

  return filtered;
}

export function pruneStaleSupabaseCookies(
  cookieStore: AuthCookieStore,
  options?: AuthCookieScopeOptions,
): string[] {
  const storageKey =
    options?.storageKey ?? resolveSupabaseStorageKey(options?.supabaseUrl);
  if (!storageKey) return [];

  const staleNames = findStaleSupabaseCookieNames(
    cookieStore.getAll(),
    storageKey,
  );
  for (const name of staleNames) {
    cookieStore.set(name, "", { ...EXPIRE_STALE_COOKIE_OPTIONS });
  }
  return staleNames;
}

export function summarizeCookieHeaderMetrics(
  cookies: ReadonlyArray<{ name: string; value: string }>,
  options?: AuthCookieScopeOptions,
): CookieHeaderMetricsSummary {
  const storageKey =
    options?.storageKey ?? resolveSupabaseStorageKey(options?.supabaseUrl);
  const staleSet = new Set(findStaleSupabaseCookieNames(cookies, storageKey));
  const seenNames = new Set<string>();
  const duplicateSet = new Set<string>();

  let totalPairBytes = 0;
  let activeSupabaseCookieCount = 0;
  let activeSupabaseBytes = 0;
  let staleSupabaseCookieCount = 0;
  let staleSupabaseBytes = 0;
  let otherCookieCount = 0;
  let otherCookieBytes = 0;
  const entries: CookieHeaderMetricsSummary["entries"] = [];

  for (const cookie of cookies) {
    if (seenNames.has(cookie.name)) {
      duplicateSet.add(cookie.name);
    } else {
      seenNames.add(cookie.name);
    }

    const pairBytes =
      Buffer.byteLength(cookie.name, "utf8") +
      1 +
      Buffer.byteLength(cookie.value, "utf8");
    totalPairBytes += pairBytes;

    const isStaleSupabase =
      staleSet.has(cookie.name) ||
      (Boolean(storageKey) &&
        isSupabaseManagedCookieName(cookie.name) &&
        !isActiveSupabaseCookieName(cookie.name, storageKey!));
    const isActiveSupabase = storageKey
      ? !isStaleSupabase && isActiveSupabaseCookieName(cookie.name, storageKey)
      : isSupabaseManagedCookieName(cookie.name);

    if (isStaleSupabase) {
      staleSupabaseCookieCount += 1;
      staleSupabaseBytes += pairBytes;
      entries.push({
        name: cookie.name,
        byteLength: pairBytes,
        category: "stale_supabase",
      });
    } else if (isActiveSupabase) {
      activeSupabaseCookieCount += 1;
      activeSupabaseBytes += pairBytes;
      entries.push({
        name: cookie.name,
        byteLength: pairBytes,
        category: "active_supabase",
      });
    } else {
      otherCookieCount += 1;
      otherCookieBytes += pairBytes;
      entries.push({
        name: cookie.name,
        byteLength: pairBytes,
        category: "other",
      });
    }
  }

  const separatorBytes = cookies.length > 1 ? (cookies.length - 1) * 2 : 0;
  const headerPrefixBytes = cookies.length > 0 ? Buffer.byteLength("Cookie: ", "utf8") : 0;

  return {
    totalCookieCount: cookies.length,
    estimatedCookieHeaderBytes: headerPrefixBytes + totalPairBytes + separatorBytes,
    activeSupabaseCookieCount,
    activeSupabaseBytes,
    staleSupabaseCookieCount,
    staleSupabaseBytes,
    staleSupabaseCookieNames: [...staleSet],
    duplicateCookieNames: [...duplicateSet],
    otherCookieCount,
    otherCookieBytes,
    entries,
  };
}

export function scopeAuthCookieStore(
  cookieStore: AuthCookieStore,
  writeMode: AuthCookieWriteMode = "read-write",
  options?: AuthCookieScopeOptions,
): AuthCookieStore {
  const storageKey =
    options?.storageKey ?? resolveSupabaseStorageKey(options?.supabaseUrl);
  let pruned = false;

  const maybePruneStale = () => {
    if (pruned || writeMode === "read-only" || !storageKey) return;
    pruned = true;
    pruneStaleSupabaseCookies(cookieStore, { storageKey });
  };

  return {
    getAll: () => {
      maybePruneStale();
      return filterAndDedupeAuthCookies(cookieStore.getAll(), storageKey);
    },
    set: (name, value, cookieOptions) => {
      if (writeMode === "read-only") return;
      maybePruneStale();
      cookieStore.set(name, value, cookieOptions);
    },
  };
}

export function createSupabaseCookieAdapter(
  cookieStore: AuthCookieStore,
  options?: AuthCookieScopeOptions,
): CookieMethodsServer {
  const scopedStore = scopeAuthCookieStore(cookieStore, "read-write", options);
  return {
    getAll: () => scopedStore.getAll(),
    setAll: (cookies) => {
      for (const { name, value, options: cookieOptions } of cookies) {
        scopedStore.set(name, value, cookieOptions);
      }
    },
  };
}
