/**
 * P2.5-W06A-R2 - manager-candidate projection regression (DB, PGlite #1-#57).
 *
 * - candidate list is service-role-only and requires entry_admin + all scope;
 * - only ACTIVE recruiters with a VERIFIED effective account link are listed
 *   (the exact assign-RPC eligibility);
 * - search matches display_name / personnel_code;
 * - projection carries recruiter_id + display_name + personnel_code/position
 *   and never auth_subject / app_user_id.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const W06A_MIGRATION = "20261008140000_p2_5_w06a_manager_candidates.sql";
const W05_MIGRATION = "20261008150000_p2_5_w05_review_authority.sql";
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) { return "00000000-0000-4000-8000-" + String(n).padStart(12, "0"); }
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const NO_SCOPE_AUTH = uuid(32), NO_SCOPE_APP = uuid(42);
const REC_A = uuid(21), REC_B = uuid(22), REC_C = uuid(23);

async function migratedDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql") && n <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  for (const name of names) await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  return { db, names };
}
async function seed(db) {
  for (const [auth, app] of [[ADMIN_AUTH, ADMIN_APP], [NO_SCOPE_AUTH, NO_SCOPE_APP]]) {
    await db.query("insert into auth.users (id) values ($1)", [auth]);
    await db.query("insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')", [app, auth]);
  }
  await db.query("insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1,'entry_admin','2020-01-01',true)", [ADMIN_APP]);
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1,'all','2020-01-01',true)", [ADMIN_APP]);
  await db.query("insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1,'entry_admin','2020-01-01',true)", [NO_SCOPE_APP]);
  // recruiters: A verified+active, B active but NO verified link, C verified but INACTIVE
  for (const [rec, name, code, active] of [
    [REC_A, "Nguyễn Văn A", "vinh.ta", true],
    [REC_B, "Trần Thị B", "tran.ttb", true],
    [REC_C, "Lê Văn C", "le.vc", false],
  ]) {
    await db.query("insert into public.recruiters (recruiter_id, display_name, personnel_code, active) values ($1,$2,$3,$4)",
      [rec, name, code, active]);
  }
  // one verified link per app_user (interval overlap guard): ADMIN->REC_A, NO_SCOPE->REC_C.
  await db.query("insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)", [ADMIN_APP, REC_A]);
  await db.query("insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)", [NO_SCOPE_APP, REC_C]);
}
async function candidates(db, auth, app, search) {
  const res = await db.query(
    "select public.direct_entry_list_project_manager_candidates($1::uuid,$2::uuid,$3::text) as data",
    [auth, app, search]);
  return res.rows[0].data;
}

test("P2.5-W06A-R2: migration #54 stays after W04 #53 in the append-only ledger", async () => {
  const { db, names } = await migratedDb();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(W06A_MIGRATION), 53, "migration chronology remains append-only");
  assert.equal(names.indexOf(W05_MIGRATION), 54, "migration chronology remains append-only");
  await db.close();
});

test("candidate list requires entry_admin + all scope (deny no-scope)", async () => {
  const { db } = await migratedDb();
  await seed(db);
  await assert.rejects(
    () => candidates(db, NO_SCOPE_AUTH, NO_SCOPE_APP, null),
    (error) => error.code === "42501",
  );
  await db.close();
});

test("candidate list: only active + verified-link recruiters, searchable, no auth/user/PII", async () => {
  const { db } = await migratedDb();
  await seed(db);
  const all = await candidates(db, ADMIN_AUTH, ADMIN_APP, null);
  const ids = all.candidates.map((c) => c.recruiter_id).sort();
  assert.deepEqual(ids, [REC_A], "only verified+active; inactive REC_C and unlinked REC_B excluded");
  for (const c of all.candidates) {
    assert.ok(c.recruiter_id);
    assert.ok(c.display_name);
    assert.equal("auth_subject" in c, false);
    assert.equal("app_user_id" in c, false);
  }
  const byName = await candidates(db, ADMIN_AUTH, ADMIN_APP, "Nguyễn");
  assert.equal(byName.candidates.length, 1);
  assert.equal(byName.candidates[0].personnel_code, "vinh.ta");
  const byCode = await candidates(db, ADMIN_AUTH, ADMIN_APP, "vinh");
  assert.equal(byCode.candidates.length, 1);
  const none = await candidates(db, ADMIN_AUTH, ADMIN_APP, "zzz-no-match");
  assert.equal(none.candidates.length, 0);
  await db.close();
});
test("bounds: >100 eligible candidates return at most 100 in stable order", async () => {
  const { db } = await migratedDb();
  await db.query("insert into auth.users (id) values ($1)", [ADMIN_AUTH]);
  await db.query("insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')", [ADMIN_APP, ADMIN_AUTH]);
  await db.query("insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1,'entry_admin','2020-01-01',true)", [ADMIN_APP]);
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1,'all','2020-01-01',true)", [ADMIN_APP]);
  // 150 active recruiters, each with one verified link from a distinct app_user.
  for (let i = 0; i < 150; i += 1) {
    const rec = uuid(200 + i);
    const au = uuid(1000 + i);
    const auth = uuid(2000 + i);
    const name = "Candidate " + String(i).padStart(3, "0");
    await db.query("insert into public.recruiters (recruiter_id, display_name, personnel_code, active) values ($1,$2,$3,true)", [rec, name, "code-" + String(i).padStart(3, "0")]);
    await db.query("insert into auth.users (id) values ($1)", [auth]);
    await db.query("insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')", [au, auth]);
    await db.query("insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)", [au, rec]);
  }
  const all = await candidates(db, ADMIN_AUTH, ADMIN_APP, null);
  assert.equal(all.candidates.length, 100, "must cap at 100");
  assert.equal(all.candidates[0].display_name, "Candidate 000");
  assert.equal(all.candidates[99].display_name, "Candidate 099");
  // stable order by display_name then recruiter_id.
  for (let i = 1; i < all.candidates.length; i += 1) {
    assert.ok(all.candidates[i - 1].display_name < all.candidates[i].display_name);
  }
  await db.close();
});
