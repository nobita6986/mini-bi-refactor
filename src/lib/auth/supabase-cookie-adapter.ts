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
  otherSupabaseCookieCount: number;
  otherSupabaseBytes: number;
  otherSupabaseCookieNames: string[];
  duplicateCookieNames: string[];
  otherCookieCount: number;
  otherCookieBytes: number;
  entries: Array<{
    name: string;
    byteLength: number;
    category: "active_supabase" | "stale_supabase" | "other_supabase" | "other";
  }>;
};

const SUPABASE_MANAGED_COOKIE_PATTERN =
  /^sb-[a-z0-9_-]+-auth-token(?:\.(?:0|[1-9]\d*)|(?:-flow-[a-z0-9_-]{8,64}|-flows)?-code-verifier(?:\.(?:0|[1-9]\d*)|\/[^\s;,]*)?)?$/i;
const CHUNK_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;
const FLOW_SLOT_BASE_SUFFIX_PATTERN = /^-flow-[a-z0-9_-]{8,64}-code-verifier$/i;

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

function isChunkForBaseKey(name: string, baseKey: string): boolean {
  const prefix = `${baseKey}.`;
  return (
    name.startsWith(prefix) && CHUNK_INDEX_PATTERN.test(name.slice(prefix.length))
  );
}

export function isActiveSupabaseCookieName(
  name: string,
  storageKey: string,
): boolean {
  const verifierBase = `${storageKey}-code-verifier`;
  const flowsVerifierBase = `${storageKey}-flows-code-verifier`;
  if (
    name === storageKey ||
    isChunkForBaseKey(name, storageKey) ||
    name === verifierBase ||
    isChunkForBaseKey(name, verifierBase) ||
    name.startsWith(`${verifierBase}/`) ||
    name === flowsVerifierBase ||
    isChunkForBaseKey(name, flowsVerifierBase)
  ) {
    return true;
  }

  if (!name.startsWith(`${storageKey}-flow-`)) {
    return false;
  }
  const rest = name.slice(storageKey.length);
  const dotIndex = rest.indexOf(".");
  if (dotIndex < 0) {
    return FLOW_SLOT_BASE_SUFFIX_PATTERN.test(rest);
  }
  const baseSuffix = rest.slice(0, dotIndex);
  const chunkSuffix = rest.slice(dotIndex + 1);
  return (
    FLOW_SLOT_BASE_SUFFIX_PATTERN.test(baseSuffix) &&
    CHUNK_INDEX_PATTERN.test(chunkSuffix)
  );
}

function resolveEffectiveCookieValues(
  cookies: ReadonlyArray<{ name: string; value: string }>,
): Map<string, string> {
  const effectiveValues = new Map<string, string>();
  for (const cookie of cookies) {
    const existing = effectiveValues.get(cookie.name);
    if (existing === undefined || (existing === "" && cookie.value.length > 0)) {
      effectiveValues.set(cookie.name, cookie.value);
    }
  }
  return effectiveValues;
}

function collectOrphanedChunkNamesForBaseKey(
  effectiveValues: ReadonlyMap<string, string>,
  baseKey: string,
): Set<string> {
  const orphaned = new Set<string>();
  const prefix = `${baseKey}.`;
  const nonEmptyChunks: Array<{ name: string; index: number }> = [];

  for (const [name, value] of effectiveValues) {
    if (value.length === 0 || !name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!CHUNK_INDEX_PATTERN.test(suffix)) continue;
    const index = Number(suffix);
    if (Number.isSafeInteger(index) && index >= 0) {
      nonEmptyChunks.push({ name, index });
    }
  }

  if (nonEmptyChunks.length === 0) {
    return orphaned;
  }

  const baseValue = effectiveValues.get(baseKey) ?? "";
  if (baseValue.length > 0) {
    for (const entry of nonEmptyChunks) {
      orphaned.add(entry.name);
    }
    return orphaned;
  }

  const indexSet = new Set(nonEmptyChunks.map((entry) => entry.index));
  let contiguousLimit = 0;
  while (indexSet.has(contiguousLimit)) {
    contiguousLimit += 1;
  }

  for (const entry of nonEmptyChunks) {
    if (entry.index >= contiguousLimit) {
      orphaned.add(entry.name);
    }
  }

  return orphaned;
}

function collectActiveVerifierBaseKeys(
  effectiveValues: ReadonlyMap<string, string>,
  storageKey: string,
): string[] {
  const baseKeys = new Set<string>([
    storageKey,
    `${storageKey}-code-verifier`,
    `${storageKey}-flows-code-verifier`,
  ]);
  const flowPrefix = `${storageKey}-flow-`;
  for (const name of effectiveValues.keys()) {
    if (!name.startsWith(flowPrefix)) continue;
    const rest = name.slice(storageKey.length);
    const dotIndex = rest.indexOf(".");
    const baseSuffix = dotIndex >= 0 ? rest.slice(0, dotIndex) : rest;
    if (FLOW_SLOT_BASE_SUFFIX_PATTERN.test(baseSuffix)) {
      baseKeys.add(`${storageKey}${baseSuffix}`);
    }
  }
  return [...baseKeys];
}

export function findStaleSupabaseCookieNames(
  cookies: ReadonlyArray<{ name: string; value: string }>,
  storageKey?: string | null,
): string[] {
  if (!storageKey) return [];

  const effectiveValues = resolveEffectiveCookieValues(cookies);
  const orphanedChunks = new Set<string>();
  for (const baseKey of collectActiveVerifierBaseKeys(effectiveValues, storageKey)) {
    for (const orphanName of collectOrphanedChunkNamesForBaseKey(
      effectiveValues,
      baseKey,
    )) {
      orphanedChunks.add(orphanName);
    }
  }

  const staleNames: string[] = [];
  const seen = new Set<string>();

  // Only prune orphaned chunks that deterministically belong to this deployment's
  // own storageKey; never expire cookies belonging to other Supabase projects /
  // parent-domain cookies that may be shared with Production.
  for (const { name } of cookies) {
    if (seen.has(name)) continue;
    if (orphanedChunks.has(name)) {
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
  const effectiveValues = resolveEffectiveCookieValues(cookies);
  const seenNames = new Set<string>();
  const filtered: { name: string; value: string }[] = [];

  for (const cookie of cookies) {
    if (staleSet.has(cookie.name) || seenNames.has(cookie.name)) {
      continue;
    }
    seenNames.add(cookie.name);
    filtered.push({
      name: cookie.name,
      value: effectiveValues.get(cookie.name) ?? cookie.value,
    });
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
  const otherSupabaseNameSet = new Set<string>();

  let totalPairBytes = 0;
  let activeSupabaseCookieCount = 0;
  let activeSupabaseBytes = 0;
  let staleSupabaseCookieCount = 0;
  let staleSupabaseBytes = 0;
  let otherSupabaseCookieCount = 0;
  let otherSupabaseBytes = 0;
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

    const isStaleSupabase = staleSet.has(cookie.name);
    const isOtherSupabase =
      Boolean(storageKey) &&
      !isStaleSupabase &&
      isSupabaseManagedCookieName(cookie.name) &&
      !isActiveSupabaseCookieName(cookie.name, storageKey!);
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
    } else if (isOtherSupabase) {
      otherSupabaseCookieCount += 1;
      otherSupabaseBytes += pairBytes;
      otherSupabaseNameSet.add(cookie.name);
      entries.push({
        name: cookie.name,
        byteLength: pairBytes,
        category: "other_supabase",
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
    otherSupabaseCookieCount,
    otherSupabaseBytes,
    otherSupabaseCookieNames: [...otherSupabaseNameSet],
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
