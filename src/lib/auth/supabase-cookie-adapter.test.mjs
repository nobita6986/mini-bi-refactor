import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { combineChunks, createChunks } from "@supabase/ssr";
import edgeCookiesPkg from "next/dist/compiled/@edge-runtime/cookies/index.js";
import nextRequestCookiesPkg from "next/dist/server/web/spec-extension/adapters/request-cookies.js";

const { RequestCookies } = edgeCookiesPkg;
const { MutableRequestCookiesAdapter } = nextRequestCookiesPkg;

import {
  MAX_HTTP_HEADER_SIZE_BYTES,
  createSupabaseCookieAdapter,
  filterAndDedupeAuthCookies,
  findStaleSupabaseCookieNames,
  pruneStaleSupabaseCookies,
  resolveSupabaseStorageKey,
  scopeAuthCookieStore,
  summarizeCookieHeaderMetrics,
} from "./supabase-cookie-adapter.ts";

test("SSR getAll/setAll read and write every cookie with options intact", () => {
  const cookies = new Map([["sb-access-token", "old"]]);
  const writes = [];
  const adapter = createSupabaseCookieAdapter({
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    set: (name, value, options) => {
      writes.push({ name, value, options });
      cookies.set(name, value);
    },
  });
  assert.deepEqual(adapter.getAll(), [{ name: "sb-access-token", value: "old" }]);
  adapter.setAll([
    { name: "sb-access-token", value: "new", options: { httpOnly: true, sameSite: "lax", path: "/" } },
    { name: "sb-refresh-token", value: "refresh", options: { httpOnly: true, sameSite: "lax", path: "/" } },
  ], { "cache-control": "no-store" });
  assert.equal(adapter.getAll().length, 2);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].options.httpOnly, true);
});

test("RSC read-only cookie scope preserves reads and suppresses refresh writes", () => {
  const writes = [];
  const source = {
    getAll: () => [{ name: "sb-access-token", value: "old" }],
    set: (name, value, options) => writes.push({ name, value, options }),
  };
  const readOnly = scopeAuthCookieStore(source, "read-only");
  assert.deepEqual(readOnly.getAll(), [{ name: "sb-access-token", value: "old" }]);
  readOnly.set("sb-access-token", "refreshed", { path: "/" });
  assert.equal(writes.length, 0);

  const writable = scopeAuthCookieStore(source);
  writable.set("sb-access-token", "refreshed", { path: "/" });
  assert.equal(writes.length, 1);
});

test("resolveSupabaseStorageKey and stale cookie detection prune only active project orphaned chunks while preserving shared/foreign cookies", () => {
  const supabaseUrl = "https://nwcvprojectref.supabase.co";
  const storageKey = resolveSupabaseStorageKey(supabaseUrl);
  assert.equal(storageKey, "sb-nwcvprojectref-auth-token");

  const bloatedCookies = [
    { name: "sb-nwcvprojectref-auth-token.0", value: "chunk0".repeat(500) },
    { name: "sb-nwcvprojectref-auth-token.1", value: "chunk1".repeat(500) },
    // Orphaned high-index chunk (gap at .2) on active storageKey
    { name: "sb-nwcvprojectref-auth-token.3", value: "orphan3".repeat(400) },
    // Foreign Supabase project cookies (e.g. Production or parent domain cookie) must NEVER be expired by bi2
    { name: "sb-otherproject-auth-token.0", value: "foreign0".repeat(500) },
    { name: "sb-otherproject-auth-token.1", value: "foreign1".repeat(500) },
    { name: "sb-otherproject-auth-token-code-verifier", value: "verifier" },
    // Duplicate cookie name (e.g. parent domain + host-only)
    { name: "sb-nwcvprojectref-auth-token.0", value: "duplicate-chunk0" },
    // Non-Supabase cookie
    { name: "cf_clearance", value: " benign " },
  ];

  const staleNames = findStaleSupabaseCookieNames(bloatedCookies, storageKey);
  assert.deepEqual(staleNames, [
    "sb-nwcvprojectref-auth-token.3",
  ]);

  const filtered = filterAndDedupeAuthCookies(bloatedCookies, storageKey);
  assert.deepEqual(
    filtered.map((c) => c.name),
    [
      "sb-nwcvprojectref-auth-token.0",
      "sb-nwcvprojectref-auth-token.1",
      "sb-otherproject-auth-token.0",
      "sb-otherproject-auth-token.1",
      "sb-otherproject-auth-token-code-verifier",
      "cf_clearance",
    ],
  );
  assert.equal(filtered[0].value, "chunk0".repeat(500));

  const expiredWrites = [];
  const store = {
    getAll: () => bloatedCookies,
    set: (name, value, options) => expiredWrites.push({ name, value, options }),
  };
  const pruned = pruneStaleSupabaseCookies(store, { supabaseUrl });
  assert.deepEqual(pruned, staleNames);
  assert.equal(expiredWrites.length, 1);
  assert.equal(expiredWrites[0].name, "sb-nwcvprojectref-auth-token.3");
  assert.equal(expiredWrites[0].value, "");
  assert.equal(expiredWrites[0].options.maxAge, 0);
  assert.equal(expiredWrites[0].options.path, "/");
});

test("summarizeCookieHeaderMetrics reports names, counts, and byte sizes without leaking values", () => {
  const secretValue = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SUPER_SECRET_TOKEN_PAYLOAD";
  const metrics = summarizeCookieHeaderMetrics(
    [
      { name: "sb-active-auth-token.0", value: secretValue },
      { name: "sb-active-auth-token.2", value: secretValue },
      { name: "sb-prod-auth-token.0", value: secretValue },
    ],
    { supabaseUrl: "https://active.supabase.co" },
  );

  assert.equal(metrics.totalCookieCount, 3);
  assert.equal(metrics.activeSupabaseCookieCount, 1);
  assert.equal(metrics.staleSupabaseCookieCount, 1);
  assert.deepEqual(metrics.staleSupabaseCookieNames, ["sb-active-auth-token.2"]);
  assert.equal(metrics.otherSupabaseCookieCount, 1);
  assert.deepEqual(metrics.otherSupabaseCookieNames, ["sb-prod-auth-token.0"]);
  const serialized = JSON.stringify(metrics);
  assert.equal(
    serialized.includes("SUPER_SECRET_TOKEN_PAYLOAD"),
    false,
    "Metrics summary must never contain cookie values or tokens",
  );
});

async function readCombinedSession(getAll, storageKey) {
  const cookies = getAll();
  return combineChunks(storageKey, async (chunkName) => {
    const found = cookies.find((cookie) => cookie.name === chunkName);
    return found ? found.value : null;
  });
}

function spyMutableCookieWrites(mutableCookies) {
  const setCalls = [];
  const deleteCalls = [];
  const originalSet = mutableCookies.set.bind(mutableCookies);
  const originalDelete = mutableCookies.delete.bind(mutableCookies);

  const spiedStore = {
    getAll: () => mutableCookies.getAll(),
    set: (name, value, options) => {
      setCalls.push({ name, value, options });
      return originalSet(name, value, options);
    },
    delete: (...args) => {
      deleteCalls.push(args);
      return originalDelete(...args);
    },
  };

  return { spiedStore, setCalls, deleteCalls };
}

test("MutableRequestCookiesAdapter regression: deleting base cookie and writing chunks preserves session and avoids deleting new chunks in read-only and read-write modes", async () => {
  const supabaseUrl = "https://nwcvprojectref.supabase.co";
  const storageKey = resolveSupabaseStorageKey(supabaseUrl);
  assert.ok(storageKey);

  const largePayload = `base64-${"a1b2c3d4e5f6".repeat(320)}`;
  const expectedChunks = createChunks(storageKey, largePayload);
  assert.ok(expectedChunks.length >= 2, "Test payload must span multiple chunks");

  for (const deleteStrategy of ["delete", "set-empty-maxage0"]) {
    const reqCookies = new RequestCookies(
      new Headers({ cookie: `${storageKey}=base-session-v1` }),
    );
    const mutableCookies = MutableRequestCookiesAdapter.wrap(reqCookies);

    // 1. Initial read sees non-empty base cookie in both read-only and read-write
    const roInitial = scopeAuthCookieStore(mutableCookies, "read-only", { supabaseUrl });
    const rwInitial = createSupabaseCookieAdapter(mutableCookies, { supabaseUrl });
    assert.equal(await readCombinedSession(() => roInitial.getAll(), storageKey), "base-session-v1");
    assert.equal(await readCombinedSession(() => rwInitial.getAll(), storageKey), "base-session-v1");

    // 2. Delete base cookie and write chunked session
    if (deleteStrategy === "delete") {
      mutableCookies.delete(storageKey);
    } else {
      mutableCookies.set(storageKey, "", { path: "/", maxAge: 0, sameSite: "lax" });
    }
    for (const chunk of expectedChunks) {
      mutableCookies.set(chunk.name, chunk.value, { path: "/", sameSite: "lax" });
    }

    // MutableRequestCookiesAdapter retains base key with empty value alongside the chunks
    const rawAfterWrite = mutableCookies.getAll();
    const rawBase = rawAfterWrite.find((c) => c.name === storageKey);
    assert.equal(rawBase?.value, "");
    for (const chunk of expectedChunks) {
      assert.equal(
        rawAfterWrite.find((c) => c.name === chunk.name)?.value,
        chunk.value,
      );
    }

    // 3a. Read-only mode reads reconstructed session and performs 0 writes
    const { spiedStore: roSpyStore, setCalls: roSets, deleteCalls: roDeletes } =
      spyMutableCookieWrites(mutableCookies);
    const roScoped = scopeAuthCookieStore(roSpyStore, "read-only", { supabaseUrl });
    assert.equal(await readCombinedSession(() => roScoped.getAll(), storageKey), largePayload);
    assert.equal(roSets.length, 0);
    assert.equal(roDeletes.length, 0);

    // 3b. Read-write mode: first read + subsequent read preserve chunks with 0 delete/expire calls
    const { spiedStore: rwSpyStore, setCalls: rwSets, deleteCalls: rwDeletes } =
      spyMutableCookieWrites(mutableCookies);
    const rwAdapter1 = createSupabaseCookieAdapter(rwSpyStore, { supabaseUrl });
    assert.equal(await readCombinedSession(() => rwAdapter1.getAll(), storageKey), largePayload);
    const rwAdapter2 = createSupabaseCookieAdapter(rwSpyStore, { supabaseUrl });
    assert.equal(await readCombinedSession(() => rwAdapter2.getAll(), storageKey), largePayload);
    assert.equal(rwSets.length, 0);
    assert.equal(rwDeletes.length, 0);

    for (const chunk of expectedChunks) {
      assert.equal(mutableCookies.get(chunk.name)?.value, chunk.value);
    }
  }
});

test("Non-empty base cookie takes precedence over stale non-empty chunks in read-only and read-write modes without repeated writes", async () => {
  const supabaseUrl = "https://nwcvprojectref.supabase.co";
  const storageKey = resolveSupabaseStorageKey(supabaseUrl);
  assert.ok(storageKey);

  const reqCookies = new RequestCookies(
    new Headers({
      cookie: [
        `${storageKey}=single-cookie-session`,
        `${storageKey}.0=stale-chunk-0`,
        `${storageKey}.1=stale-chunk-1`,
      ].join("; "),
    }),
  );
  const mutableCookies = MutableRequestCookiesAdapter.wrap(reqCookies);

  // Read-only mode: returns base cookie, filters out .0/.1, 0 writes
  const { spiedStore: roSpyStore, setCalls: roSets } = spyMutableCookieWrites(mutableCookies);
  const roScoped = scopeAuthCookieStore(roSpyStore, "read-only", { supabaseUrl });
  const roCookies = roScoped.getAll();
  assert.deepEqual(
    roCookies.map((c) => c.name),
    [storageKey],
  );
  assert.equal(roCookies[0].value, "single-cookie-session");
  assert.equal(roSets.length, 0);

  // Read-write mode: first adapter expires .0/.1 cleanly; second adapter emits 0 redundant writes
  const { spiedStore: rwSpyStore, setCalls: rwSets } = spyMutableCookieWrites(mutableCookies);
  const rwAdapter1 = createSupabaseCookieAdapter(rwSpyStore, { supabaseUrl });
  const rwCookies1 = rwAdapter1.getAll();
  assert.deepEqual(
    rwCookies1.filter((c) => c.value.length > 0).map((c) => c.name),
    [storageKey],
  );
  assert.equal(rwCookies1.find((c) => c.name === storageKey)?.value, "single-cookie-session");
  assert.equal(rwSets.length, 2);
  assert.deepEqual(
    rwSets.map((call) => ({ name: call.name, value: call.value, maxAge: call.options.maxAge, path: call.options.path })),
    [
      { name: `${storageKey}.0`, value: "", maxAge: 0, path: "/" },
      { name: `${storageKey}.1`, value: "", maxAge: 0, path: "/" },
    ],
  );

  const rwAdapter2 = createSupabaseCookieAdapter(rwSpyStore, { supabaseUrl });
  const rwCookies2 = rwAdapter2.getAll();
  assert.equal(rwCookies2.find((c) => c.name === storageKey)?.value, "single-cookie-session");
  assert.equal(rwSets.length, 2, "Subsequent read must not issue redundant delete writes for empty chunks");
  assert.equal(mutableCookies.get(storageKey)?.value, "single-cookie-session");
});

test("Dockerfile, package.json, and smoke test configure finite 32 KB HTTP header limit", () => {
  assert.equal(MAX_HTTP_HEADER_SIZE_BYTES, 32768);
  const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
  const pkg = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
  assert.match(dockerfile, /--max-http-header-size=32768/);
  assert.match(pkg, /--max-http-header-size=32768/);
});

