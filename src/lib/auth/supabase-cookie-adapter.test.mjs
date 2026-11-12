import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("resolveSupabaseStorageKey and stale cookie detection prune foreign project cookies and orphaned chunks", () => {
  const supabaseUrl = "https://nwcvprojectref.supabase.co";
  const storageKey = resolveSupabaseStorageKey(supabaseUrl);
  assert.equal(storageKey, "sb-nwcvprojectref-auth-token");

  const bloatedCookies = [
    { name: "sb-nwcvprojectref-auth-token.0", value: "chunk0".repeat(500) },
    { name: "sb-nwcvprojectref-auth-token.1", value: "chunk1".repeat(500) },
    // Orphaned high-index chunk (gap at .2)
    { name: "sb-nwcvprojectref-auth-token.3", value: "orphan3".repeat(400) },
    // Foreign Supabase project cookies from another environment
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
    "sb-otherproject-auth-token.0",
    "sb-otherproject-auth-token.1",
    "sb-otherproject-auth-token-code-verifier",
  ]);

  const filtered = filterAndDedupeAuthCookies(bloatedCookies, storageKey);
  assert.deepEqual(
    filtered.map((c) => c.name),
    [
      "sb-nwcvprojectref-auth-token.0",
      "sb-nwcvprojectref-auth-token.1",
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
  assert.equal(expiredWrites.length, 4);
  for (const write of expiredWrites) {
    assert.equal(write.value, "");
    assert.equal(write.options.maxAge, 0);
    assert.equal(write.options.path, "/");
  }
});

test("summarizeCookieHeaderMetrics reports only names, counts, and byte sizes without leaking values", () => {
  const secretValue = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SUPER_SECRET_TOKEN_PAYLOAD";
  const metrics = summarizeCookieHeaderMetrics(
    [
      { name: "sb-active-auth-token.0", value: secretValue },
      { name: "sb-legacy-auth-token.0", value: secretValue },
    ],
    { supabaseUrl: "https://active.supabase.co" },
  );

  assert.equal(metrics.totalCookieCount, 2);
  assert.equal(metrics.activeSupabaseCookieCount, 1);
  assert.equal(metrics.staleSupabaseCookieCount, 1);
  assert.deepEqual(metrics.staleSupabaseCookieNames, ["sb-legacy-auth-token.0"]);
  const serialized = JSON.stringify(metrics);
  assert.equal(
    serialized.includes("SUPER_SECRET_TOKEN_PAYLOAD"),
    false,
    "Metrics summary must never contain cookie values or tokens",
  );
});

test("Dockerfile, package.json, and smoke test configure finite 32 KB HTTP header limit", () => {
  assert.equal(MAX_HTTP_HEADER_SIZE_BYTES, 32768);
  const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
  const pkg = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
  assert.match(dockerfile, /--max-http-header-size=32768/);
  assert.match(pkg, /--max-http-header-size=32768/);
});

