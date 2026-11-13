import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const NEW_MIGRATION = "20261011170000_p3_1_w03a_r2_r1_account_read_repair.sql";
const REAL_NAME_MIGRATION = "20261015140000_pre_w2_hf_account_real_name_display.sql";
const ADMIN_AUTH = "10000000-0000-4000-8000-000000000101";
const ADMIN_APP = "20000000-0000-4000-8000-000000000101";
const ACCOUNTING_AUTH = "10000000-0000-4000-8000-000000000102";
const ACCOUNTING_APP = "20000000-0000-4000-8000-000000000102";
const TARGET_AUTH = "10000000-0000-4000-8000-000000000103";
const TARGET_APP = "20000000-0000-4000-8000-000000000103";
const DISABLED_ADMIN_AUTH = "10000000-0000-4000-8000-000000000104";
const DISABLED_ADMIN_APP = "20000000-0000-4000-8000-000000000104";
const REASON = "Synthetic account read R2 reason";

async function migrations() {
  return (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
}
async function db() {
  const database = new PGlite();
  await database.exec(AUTH_PROLOGUE);
  for (const name of await migrations()) await database.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  return database;
}
async function rows(database, sql, values = []) {
  return (await database.query(sql, values)).rows;
}
async function rpc(database, name, values) {
  return (await rows(database, `select public.${name}($1::uuid,$2::uuid,$3::text,$4::text,$5::integer,$6::integer) as result`, values))[0].result;
}
async function seed(database) {
  await database.exec("alter table auth.users add column if not exists email text");
  await database.query("insert into auth.users(id,email) values ($1,'admin@hrpartner.vn'),($2,'accounting@hrpartner.vn'),($3,'target.td@hrpartner.vn'),($4,'disabled@hrpartner.vn')", [ADMIN_AUTH, ACCOUNTING_AUTH, TARGET_AUTH, DISABLED_ADMIN_AUTH]);
  await database.query(`
    insert into public.direct_entry_app_users(app_user_id,auth_subject,display_name,enabled)
    values ($1,$2,'Admin',true),($3,$4,'Accounting',true),($5,$6,'Target',true),($7,$8,'Disabled Admin',false)`,
    [ADMIN_APP, ADMIN_AUTH, ACCOUNTING_APP, ACCOUNTING_AUTH, TARGET_APP, TARGET_AUTH, DISABLED_ADMIN_APP, DISABLED_ADMIN_AUTH]);
  for (const capability of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
    await database.query("insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current) values ($1,$2,'2026-01-01',true)", [ADMIN_APP, capability]);
  }
  await database.query("insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from,is_current) values ($1,'all','2026-01-01',true)", [ADMIN_APP]);
  await database.query("insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current) values ($1,'catalog_master_manage','2026-01-01',true)", [ACCOUNTING_APP]);
  await database.query("insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from,is_current) values ($1,'all','2026-01-01',true)", [ACCOUNTING_APP]);
}
async function denied(operation, code = "42501") {
  await assert.rejects(operation, (error) => error.code === code);
}

test("R2 migration #83 is append-only and read RPC ACL/projection is exact", async () => {
  const names = await migrations();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(NEW_MIGRATION), 83, "migration chronology remains append-only");
  assert.equal(names.indexOf(REAL_NAME_MIGRATION), 98, "migration chronology remains append-only");
  const database = await db();
  await seed(database);
  const result = await rpc(database, "direct_entry_list_app_users_admin", [ADMIN_AUTH, ADMIN_APP, null, "all", 1, 25]);
  assert.deepEqual(Object.keys(result).sort(), ["accounts", "enabled", "page", "page_size", "search", "total"]);
  assert.deepEqual(Object.keys(result.accounts[0]).sort(), [
    "account_ref",
    "account_type",
    "active_person_link",
    "display_name",
    "enabled",
    "login_id",
    "version",
  ]);
  assert.equal(result.accounts[0].account_type, "NORMAL");
  assert.equal(result.accounts[0].active_person_link, null);
  assert.equal(result.accounts[0].display_name, "Accounting");
  assert.equal(result.accounts[0].login_id, "accounting");
  assert.equal(result.accounts[0].account_ref, ACCOUNTING_APP);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["auth_subject", "@hrpartner.vn", "capability", "scope", "reason", "audit", "account_label"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  const acl = await rows(database, `
    select to_regprocedure('public.direct_entry_list_app_users_admin(uuid,uuid,text,integer,integer)') is null as old_absent,
           has_function_privilege('service_role','public.direct_entry_list_app_users_admin(uuid,uuid,text,text,integer,integer)','execute') as list_exec,
           has_function_privilege('service_role','public.direct_entry_get_app_user_admin(uuid,uuid,uuid)','execute') as detail_exec,
           has_function_privilege('service_role','public.direct_entry_app_user_projection(public.direct_entry_app_users)','execute') as projection_exec,
           has_function_privilege('authenticated','public.direct_entry_list_app_users_admin(uuid,uuid,text,text,integer,integer)','execute') as auth_exec`);
  assert.deepEqual(acl[0], { old_absent: true, list_exec: true, detail_exec: true, projection_exec: false, auth_exec: false });
  await database.close();
});

test("R2 list filters, bounds, stable order and detail are Full-Admin-only", async () => {
  const database = await db();
  await seed(database);
  const all = await rpc(database, "direct_entry_list_app_users_admin", [ADMIN_AUTH, ADMIN_APP, null, "all", 1, 2]);
  assert.equal(all.search, null);
  assert.equal(all.page_size, 2);
  assert.equal(all.total, 4);
  assert.equal(all.accounts[0].display_name, "Accounting");
  assert.equal(all.accounts[1].display_name, "Admin");
  const searched = await rpc(database, "direct_entry_list_app_users_admin", [ADMIN_AUTH, ADMIN_APP, " tArGeT ", "all", 1, 25]);
  assert.equal(searched.search, "tArGeT");
  assert.deepEqual(searched.accounts.map((account) => account.display_name), ["Target"]);
  const disabled = await rpc(database, "direct_entry_list_app_users_admin", [ADMIN_AUTH, ADMIN_APP, null, "false", 1, 25]);
  assert.equal(disabled.total, 1);
  const detail = (await rows(database, "select public.direct_entry_get_app_user_admin($1::uuid,$2::uuid,$3::uuid) as result", [ADMIN_AUTH, ADMIN_APP, TARGET_APP]))[0].result;
  assert.deepEqual(Object.keys(detail).sort(), [
    "account_ref",
    "account_type",
    "active_person_link",
    "display_name",
    "enabled",
    "login_id",
    "version",
  ]);
  assert.equal(detail.account_type, "NORMAL");
  assert.equal(detail.active_person_link, null);
  await denied(rpc(database, "direct_entry_list_app_users_admin", [ACCOUNTING_AUTH, ACCOUNTING_APP, null, "all", 1, 25]));
  await denied(rpc(database, "direct_entry_list_app_users_admin", [DISABLED_ADMIN_AUTH, DISABLED_ADMIN_APP, null, "all", 1, 25]));
  await denied(rpc(database, "direct_entry_list_app_users_admin", ["10000000-0000-4000-8000-000000000199", ADMIN_APP, null, "all", 1, 25]));
  await assert.rejects(rpc(database, "direct_entry_list_app_users_admin", [ADMIN_AUTH, ADMIN_APP, " ", "all", 1, 25]), (error) => error.code === "22023");
  const badSearch = await rpc(database, "direct_entry_list_app_users_admin", [ADMIN_AUTH, ADMIN_APP, "bad", "all", 1, 25]);
  assert.equal(badSearch.search, "bad");
  assert.deepEqual(badSearch.accounts, []);
  await assert.rejects(rpc(database, "direct_entry_list_app_users_admin", [ADMIN_AUTH, ADMIN_APP, null, "bad", 1, 25]), (error) => error.code === "22023");
  await assert.rejects(rpc(database, "direct_entry_list_app_users_admin", [ADMIN_AUTH, ADMIN_APP, null, "all", 0, 25]), (error) => error.code === "22023");
  await assert.rejects(rows(database, "select public.direct_entry_get_app_user_admin($1::uuid,$2::uuid,$3::uuid)", [ADMIN_AUTH, ADMIN_APP, "20000000-0000-4000-8000-000000000199"]), (error) => error.code === "P0002");
  await database.close();
});

test("account read shows linked recruiter real name and only the Auth login local-part", async () => {
  const database = await db();
  await seed(database);
  const recruiterId = "30000000-0000-4000-8000-000000000103";
  await database.query("insert into public.recruiters(recruiter_id,display_name) values ($1,'Bạch Thu Lan')", [recruiterId]);
  await database.query(`
    insert into public.direct_entry_app_user_recruiter_links(app_user_id,recruiter_id,verified,valid_from,is_current)
    values ($1,$2,true,'2026-01-01',true)`, [TARGET_APP, recruiterId]);
  const list = await rpc(database, "direct_entry_list_app_users_admin", [ADMIN_AUTH, ADMIN_APP, "Bạch Thu Lan", "all", 1, 25]);
  assert.deepEqual(list.accounts.map(({ display_name, login_id }) => ({ display_name, login_id })), [
    { display_name: "Bạch Thu Lan", login_id: "target.td" },
  ]);
  const detail = (await rows(database, "select public.direct_entry_get_app_user_admin($1::uuid,$2::uuid,$3::uuid) as result", [ADMIN_AUTH, ADMIN_APP, TARGET_APP]))[0].result;
  assert.equal(detail.display_name, "Bạch Thu Lan");
  assert.equal(detail.login_id, "target.td");
  await database.query("update public.direct_entry_app_users set display_name='accounting' where app_user_id=$1", [ACCOUNTING_APP]);
  const missingName = (await rows(database, "select public.direct_entry_get_app_user_admin($1::uuid,$2::uuid,$3::uuid) as result", [ADMIN_AUTH, ADMIN_APP, ACCOUNTING_APP]))[0].result;
  assert.equal(missingName.display_name, null);
  assert.equal(missingName.login_id, "accounting");
  assert.equal(JSON.stringify(detail).includes("@hrpartner.vn"), false);
  await database.close();
});

test("R2 mutation reuses W03A lifecycle, returns replay-safe state and does not cascade", async () => {
  const database = await db();
  await seed(database);
  const enabled = (await rows(database, "select public.direct_entry_enable_app_user($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) as result", [ADMIN_AUTH, ADMIN_APP, DISABLED_ADMIN_APP, 1, REASON, "r2-enable"]))[0].result;
  assert.equal(enabled.change, "enable");
  const replay = (await rows(database, "select public.direct_entry_enable_app_user($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) as result", [ADMIN_AUTH, ADMIN_APP, DISABLED_ADMIN_APP, 1, REASON, "r2-enable"]))[0].result;
  assert.deepEqual(replay, enabled);
  await denied(rows(database, "select public.direct_entry_disable_app_user($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text)", [ADMIN_AUTH, ADMIN_APP, DISABLED_ADMIN_APP, 1, REASON, "r2-stale"]), "PT409");
  await database.close();
});
