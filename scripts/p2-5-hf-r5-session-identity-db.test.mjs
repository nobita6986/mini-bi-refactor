/**
 * P2.5-HF-R5 - session identity header DB regression (PGlite).
 *
 * Proves the #62 contract:
 *  - the canonical display_name column is NOT NULL and canonical (trimmed 1..256);
 *  - existing accounts are backfilled from the login label of the mapped auth user;
 *  - an account without a mapped auth user or without a usable login label makes
 *    the migration fail closed (no invented name, no UUID fallback);
 *  - the actor context RPC returns display_name and never an email.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const HF_R5 = "20261008220000_p2_5_hf_session_identity_header.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const AUTH = "00000000-0000-4000-8000-0000000000a1";
const APP = "00000000-0000-4000-8000-0000000000b1";

async function ledgerNames() {
  return (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
}

async function applyUpTo(db, names) {
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

async function freshDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  return db;
}

test("HF-R5: #62 stays immediately before R6 and a fresh ledger applies clean", async () => {
  const names = await ledgerNames();
  assert.equal(names.indexOf(HF_R5), 61, "#62 must stay immediately before #63");
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  const db = await freshDb();
  try {
    await applyUpTo(db, names);
    const { rows } = await db.query(
      "select is_nullable from information_schema.columns" +
      " where table_schema='public' and table_name='direct_entry_app_users'" +
      " and column_name='display_name'",
    );
    assert.equal(rows[0].is_nullable, "NO");
  } finally {
    await db.close();
  }
});

test("HF-R5: the existing accounts are backfilled from the mapped login label", async () => {
  const names = await ledgerNames();
  const pre = names.slice(0, names.indexOf(HF_R5));
  const db = await freshDb();
  try {
    await applyUpTo(db, pre);
    const auth = "00000000-0000-4000-8000-0000000000c1";
    const app = "00000000-0000-4000-8000-0000000000c2";
    await db.query("insert into auth.users (id, email) values ($1,$2)", [auth, "nguyenvana@hrpartner.vn"]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled) values ($1,$2,true)",
      [app, auth],
    );
    await db.exec(await readFile(path.join(MIGRATION_DIR, HF_R5), "utf8"));
    const { rows } = await db.query(
      "select display_name from public.direct_entry_app_users where app_user_id=$1", [app]);
    assert.equal(rows[0].display_name, "nguyenvana");
    assert.equal(rows[0].display_name, rows[0].display_name.trim());
  } finally {
    await db.close();
  }
});

test("HF-R5: an unmapped account is impossible and an unusable login label fails the migration closed", async () => {
  const names = await ledgerNames();
  const pre = names.slice(0, names.indexOf(HF_R5));

  // The FK to auth.users already makes an unmapped app user impossible.
  {
    const db = await freshDb();
    try {
      await applyUpTo(db, pre);
      await assert.rejects(
        db.query(
          "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled) values ($1,$2,true)",
          ["00000000-0000-4000-8000-0000000000d2", "00000000-0000-4000-8000-0000000000d9"],
        ),
        (e) => e.code === "23503",
        "an unmapped auth subject must be rejected",
      );
    } finally {
      await db.close();
    }
  }

  // An auth user without a usable login label must abort #62 instead of inventing a name.
  for (const email of [null, "no-at-sign", "   @x.vn"]) {
    const db = await freshDb();
    try {
      await applyUpTo(db, pre);
      const auth = "00000000-0000-4000-8000-0000000000e1";
      await db.query("insert into auth.users (id, email) values ($1,$2)", [auth, email]);
      await db.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled) values ($1,$2,true)",
        ["00000000-0000-4000-8000-0000000000e2", auth],
      );
      await assert.rejects(
        db.exec(await readFile(path.join(MIGRATION_DIR, HF_R5), "utf8")),
        /HF-R5 refused/,
        "email=" + String(email),
      );
    } finally {
      await db.close();
    }
  }
});

test("HF-R5: display_name is canonical, not nullable and not a UUID fallback", async () => {
  const db = await freshDb();
  try {
    await applyUpTo(db, await ledgerNames());
    await db.query("insert into auth.users (id, email) values ($1,$2)", [AUTH, "a@b.vn"]);
    await assert.rejects(
      db.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled) values ($1,$2,true)",
        [APP, AUTH],
      ),
      (e) => e.code === "23502",
      "missing display_name must violate NOT NULL",
    );
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)" +
      " values ($1,$2,true,$3)",
      [APP, AUTH, "Nguyễn Văn A"],
    );
    for (const bad of ["  padded  ", "", "   "]) {
      await assert.rejects(
        db.query(
          "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)" +
          " values ($1,$2,true,$3)",
          ["00000000-0000-4000-8000-0000000000f1", AUTH, bad],
        ),
        (e) => e.code === "23514",
        "non canonical value rejected: " + JSON.stringify(bad),
      );
    }
    await assert.rejects(
      db.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)" +
        " values ($1,$2,true,repeat('x',257))",
        ["00000000-0000-4000-8000-0000000000f2", AUTH],
      ),
      (e) => e.code === "23514",
      "over-long value rejected",
    );
  } finally {
    await db.close();
  }
});

test("HF-R5: the actor context RPC returns display_name and never an email", async () => {
  const db = await freshDb();
  try {
    await applyUpTo(db, await ledgerNames());
    await db.query("insert into auth.users (id, email) values ($1,$2)", [AUTH, "nguyenvana@hrpartner.vn"]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)" +
      " values ($1,$2,true,$3)",
      [APP, AUTH, "Nguyễn Văn A"],
    );
    const { rows } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as ctx", [AUTH]);
    const ctx = rows[0].ctx;
    assert.equal(ctx.display_name, "Nguyễn Văn A");
    assert.deepEqual(Object.keys(ctx).sort(), [
      "all_scope_grants", "allowed_worker_tabs", "app_user_id", "assigned_roles", "auth_subject", "capabilities",
      "display_name", "effective_grants", "enabled", "recruiter_links", "team_scope_grants", "teams",
    ]);
    assert.equal(JSON.stringify(ctx).includes("@"), false, "no email may be projected");
    assert.equal(JSON.stringify(ctx).toLowerCase().includes("nguyenvana@"), false);
  } finally {
    await db.close();
  }
});
