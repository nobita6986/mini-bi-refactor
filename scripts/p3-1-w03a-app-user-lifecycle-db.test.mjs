import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const NEW_MIGRATION = "20261011150000_p3_1_w03a_app_user_lifecycle.sql";
const ADMIN_AUTH = "10000000-0000-4000-8000-000000000001";
const ADMIN_APP = "20000000-0000-4000-8000-000000000001";
const ACCOUNTING_AUTH = "10000000-0000-4000-8000-000000000002";
const ACCOUNTING_APP = "20000000-0000-4000-8000-000000000002";
const LEADER_AUTH = "10000000-0000-4000-8000-000000000003";
const LEADER_APP = "20000000-0000-4000-8000-000000000003";
const STAFF_AUTH = "10000000-0000-4000-8000-000000000004";
const STAFF_APP = "20000000-0000-4000-8000-000000000004";
const TARGET_AUTH = "10000000-0000-4000-8000-000000000005";
const TARGET_APP = "20000000-0000-4000-8000-000000000005";
const DISABLED_ADMIN_AUTH = "10000000-0000-4000-8000-000000000006";
const DISABLED_ADMIN_APP = "20000000-0000-4000-8000-000000000006";
const TEAM_ID = "30000000-0000-4000-8000-000000000001";
const RECRUITER_ID = "40000000-0000-4000-8000-000000000001";
const REASON = "Synthetic W03A lifecycle reason";

async function migrationNames() {
  return (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
}

async function readMigration(name) {
  return readFile(path.join(MIGRATION_DIR, name), "utf8");
}

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  for (const name of (await migrationNames()).filter((n) => n <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")) await db.exec(await readMigration(name));
  return db;
}

async function query(db, sql, values = []) {
  return (await db.query(sql, values)).rows;
}

async function rpc(db, name, values) {
  return (await query(db, `select public.${name}($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) as result`, values))[0].result;
}

async function seed(db) {
  await db.query(
    "insert into auth.users (id) values ($1),($2),($3),($4),($5),($6)",
    [ADMIN_AUTH, ACCOUNTING_AUTH, LEADER_AUTH, STAFF_AUTH, TARGET_AUTH, DISABLED_ADMIN_AUTH],
  );
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
     values ($1,$2,'Synthetic Admin',true),($3,$4,'Synthetic Accounting',true),
            ($5,$6,'Synthetic Leader',true),($7,$8,'Synthetic Staff',true),
            ($9,$10,'Synthetic Target',false),($11,$12,'Synthetic Disabled Admin',false)`,
    [ADMIN_APP, ADMIN_AUTH, ACCOUNTING_APP, ACCOUNTING_AUTH, LEADER_APP, LEADER_AUTH,
      STAFF_APP, STAFF_AUTH, TARGET_APP, TARGET_AUTH, DISABLED_ADMIN_APP, DISABLED_ADMIN_AUTH],
  );
  await db.query("insert into public.teams (team_id, code, display_name) values ($1,'w03a_team','W03A Team')", [TEAM_ID]);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'W03A Recruiter')", [RECRUITER_ID]);
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links
       (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1,$2,true,'2026-01-01',true)`, [TARGET_APP, RECRUITER_ID]);

  const fullAdmin = ["entry_admin", "recruiter_master_manage", "team_master_manage"];
  for (const appUserId of [ADMIN_APP, DISABLED_ADMIN_APP]) {
    for (const [index, capability] of fullAdmin.entries()) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1,$2,$3::date,true)`, [appUserId, capability, `2026-01-0${index + 1}`],
      );
    }
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1,'all','2026-01-01',true)`, [appUserId]);
  }
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
     values ($1,'entry_create','2026-01-01',true)`, [TARGET_APP]);
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1,'own','2026-01-01',true)`, [TARGET_APP]);
  await db.query(
    `insert into public.direct_entry_team_leader_assignments
       (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
     values ($1,$2,$3,'2026-01-01',true)`, [TEAM_ID, TARGET_APP, RECRUITER_ID]);
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
     values ($1,'catalog_master_manage','2026-01-01',true),
            ($2,'team_manager_assign','2026-01-01',true),
            ($3,'entry_create','2026-01-01',true)`, [ACCOUNTING_APP, LEADER_APP, STAFF_APP]);
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1,'all',null,'2026-01-01',true),($2,'team',$3,'2026-01-01',true),($4,'own',null,'2026-01-01',true)`,
    [ACCOUNTING_APP, LEADER_APP, TEAM_ID, STAFF_APP]);
}

async function appUser(db, appUserId) {
  return (await query(db, "select enabled, version from public.direct_entry_app_users where app_user_id = $1", [appUserId]))[0];
}

async function childRows(db) {
  return {
    capabilities: await query(db, `
      select grant_id::text, app_user_id::text, capability, valid_from::text, valid_to::text, created_at::text
        from public.direct_entry_capability_grants where app_user_id = $1
       order by grant_id`, [TARGET_APP]),
    scopes: await query(db, `
      select grant_id::text, app_user_id::text, scope_kind, team_id::text, valid_from::text, valid_to::text, created_at::text
        from public.direct_entry_scope_grants where app_user_id = $1
       order by grant_id`, [TARGET_APP]),
    links: await query(db, `
      select link_id::text, app_user_id::text, recruiter_id::text, verified, valid_from::text, valid_to::text, created_at::text
        from public.direct_entry_app_user_recruiter_links where app_user_id = $1
       order by link_id`, [TARGET_APP]),
    leaders: await query(db, `
      select assignment_id::text, team_id::text, leader_app_user_id::text, leader_recruiter_id::text,
             valid_from::text, valid_to::text, created_at::text
        from public.direct_entry_team_leader_assignments where leader_app_user_id = $1
       order by assignment_id`, [TARGET_APP]),
  };
}

async function assertNoRevisionResidue(db) {
  assert.equal((await query(db, "select enabled, version from public.direct_entry_app_users where app_user_id = $1", [DISABLED_ADMIN_APP]))[0].enabled, false);
  assert.equal((await query(db, "select count(*)::int as count from public.direct_entry_app_user_revisions where app_user_id = $1", [DISABLED_ADMIN_APP]))[0].count, 0);
  assert.equal((await query(db, "select count(*)::int as count from public.direct_entry_audit_events where app_user_id = $1 and action in ('enable','disable')", [DISABLED_ADMIN_APP]))[0].count, 0);
  assert.equal((await query(db, "select count(*)::int as count from public.direct_entry_rpc_idempotency where app_user_id = $1 and action in ('app_user_enable','app_user_disable')", [DISABLED_ADMIN_APP]))[0].count, 0);
}

async function assertSqlState(operation, code) {
  await assert.rejects(operation, (error) => error.code === code);
}

test("W03A migration is #82 append-only and exposes the locked schema", async () => {
  const names = await migrationNames();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(NEW_MIGRATION), 81);
  const db = await database();
  const columns = await query(db, `
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'direct_entry_app_users'
       and column_name in ('version','updated_at') order by column_name`);
  assert.deepEqual(columns.map((row) => row.column_name), ["updated_at", "version"]);
  const revision = await query(db, `
    select conname from pg_constraint
     where conrelid = 'public.direct_entry_app_user_revisions'::regclass
       and conname = 'direct_entry_app_user_revisions_app_user_id_version_key'`);
  assert.equal(revision.length, 1);
  const auditLink = await query(db, `
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'direct_entry_audit_events'
       and column_name = 'app_user_revision_id'`);
  assert.equal(auditLink.length, 1);
  const actionConstraints = await query(db, `
    select pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
     where c.conrelid = 'public.direct_entry_app_user_revisions'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%action%'`);
  assert.equal(actionConstraints.length, 1);
  assert.deepEqual(
    [...actionConstraints[0].definition.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort(),
    ['account_created', 'capability_grant', 'capability_revoke', 'disable', 'display_name_update', 'enable', 'link_create', 'link_revoke', 'scope_grant', 'scope_revoke'],
  );
  const revisionSecurity = await query(db, `
    select c.relrowsecurity, c.relforcerowsecurity,
           has_table_privilege('public','public.direct_entry_app_user_revisions','select') as public_select,
           has_table_privilege('service_role','public.direct_entry_app_user_revisions','select') as service_select
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'direct_entry_app_user_revisions'`);
  assert.equal(revisionSecurity[0].relrowsecurity, true);
  assert.equal(revisionSecurity[0].relforcerowsecurity, true);
  assert.equal(revisionSecurity[0].public_select, false);
  assert.equal(revisionSecurity[0].service_select, false);
  const acl = await query(db, `
    select has_function_privilege('service_role','public.direct_entry_enable_app_user(uuid,uuid,uuid,integer,text,text)','execute') as enable_exec,
           has_function_privilege('service_role','public.direct_entry_disable_app_user(uuid,uuid,uuid,integer,text,text)','execute') as disable_exec,
           has_function_privilege('authenticated','public.direct_entry_enable_app_user(uuid,uuid,uuid,integer,text,text)','execute') as authenticated_exec,
           has_function_privilege('service_role','public.direct_entry_assert_actor_app_user_admin(uuid,uuid)','execute') as helper_exec`);
  assert.equal(acl[0].enable_exec, true);
  assert.equal(acl[0].disable_exec, true);
  assert.equal(acl[0].authenticated_exec, false);
  assert.equal(acl[0].helper_exec, false);
  await db.close();
});

test("W03A Full Admin can enable, replay, and disable without touching child rows", async () => {
  const db = await database();
  await seed(db);
  const childrenBefore = await childRows(db);

  const enabled = await rpc(db, "direct_entry_enable_app_user", [
    ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, REASON, "w03a-enable-1",
  ]);
  assert.equal(enabled.change, "enable");
  assert.equal(enabled.version, 2);
  assert.equal((await appUser(db, TARGET_APP)).enabled, true);
  assert.deepEqual(await childRows(db), childrenBefore);

  const revision = await query(db, `
    select action, version, before_snapshot, after_snapshot, reason_id
      from public.direct_entry_app_user_revisions where revision_id = $1`, [enabled.revision_id]);
  assert.equal(revision[0].action, "enable");
  assert.equal(revision[0].version, 2);
  assert.deepEqual(Object.keys(revision[0].before_snapshot).sort(), [
    "actor_app_user_id", "changed", "interval", "target_app_user_id",
  ]);
  assert.equal(revision[0].before_snapshot.changed.enabled, false);
  assert.equal(revision[0].after_snapshot.changed.enabled, true);
  const audit = await query(db, `
    select action, capability, outcome, app_user_id, revision_id, app_user_revision_id, changed_fields
      from public.direct_entry_audit_events where app_user_revision_id = $1`, [enabled.revision_id]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "enable");
  assert.equal(audit[0].capability, "entry_admin");
  assert.equal(audit[0].outcome, "APPLIED");
  assert.equal(audit[0].app_user_id, ADMIN_APP);
  assert.equal(audit[0].revision_id, null);
  assert.deepEqual(audit[0].changed_fields, ["enabled"]);

  const replay = await rpc(db, "direct_entry_enable_app_user", [
    ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, REASON, "w03a-enable-1",
  ]);
  assert.deepEqual(replay, enabled);
  assert.equal((await appUser(db, TARGET_APP)).version, 2);
  assert.equal((await query(db, "select count(*)::int as count from public.direct_entry_app_user_revisions where app_user_id = $1", [TARGET_APP]))[0].count, 1);

  await assertSqlState(
    rpc(db, "direct_entry_enable_app_user", [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, "different reason", "w03a-enable-1"]),
    "22023",
  );
  await assertSqlState(
    rpc(db, "direct_entry_disable_app_user", [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, REASON, "w03a-disable-stale"]),
    "PT409",
  );
  assert.equal((await appUser(db, TARGET_APP)).version, 2);

  const disabled = await rpc(db, "direct_entry_disable_app_user", [
    ADMIN_AUTH, ADMIN_APP, TARGET_APP, 2, REASON, "w03a-disable-1",
  ]);
  assert.equal(disabled.change, "disable");
  assert.equal(disabled.version, 3);
  assert.equal((await appUser(db, TARGET_APP)).enabled, false);
  assert.equal((await query(db, "select count(*)::int as count from public.direct_entry_app_user_revisions where app_user_id = $1", [TARGET_APP]))[0].count, 2);
  assert.deepEqual(await childRows(db), childrenBefore);

  const resolved = (await query(db, "select public.direct_entry_resolve_actor_context($1::uuid) as data", [TARGET_AUTH]))[0].data;
  assert.equal(resolved.enabled, false);
  await db.close();
});

test("W03A denies non-Full-Admin and forged actors without residue", async () => {
  const db = await database();
  await seed(db);
  await assertSqlState(
    rpc(db, "direct_entry_enable_app_user", [DISABLED_ADMIN_AUTH, DISABLED_ADMIN_APP, TARGET_APP, 1, REASON, "disabled-admin-enable"]),
    "42501",
  );
  await assertSqlState(
    rpc(db, "direct_entry_disable_app_user", [DISABLED_ADMIN_AUTH, DISABLED_ADMIN_APP, TARGET_APP, 1, REASON, "disabled-admin-disable"]),
    "42501",
  );
  await assertNoRevisionResidue(db);

  const denied = [
    [ACCOUNTING_AUTH, ACCOUNTING_APP],
    [LEADER_AUTH, LEADER_APP],
    [STAFF_AUTH, STAFF_APP],
    [TARGET_AUTH, TARGET_APP],
    [ADMIN_AUTH, STAFF_APP],
    ["10000000-0000-4000-8000-000000000099", ADMIN_APP],
  ];
  for (const [authSubject, actorAppUserId] of denied) {
    await assertSqlState(
      rpc(db, "direct_entry_enable_app_user", [authSubject, actorAppUserId, TARGET_APP, 1, REASON, `deny-${actorAppUserId}`]),
      "42501",
    );
  }
  assert.equal((await appUser(db, TARGET_APP)).version, 1);
  assert.equal((await query(db, "select count(*)::int as count from public.direct_entry_app_user_revisions"))[0].count, 0);
  assert.equal((await query(db, "select count(*)::int as count from public.direct_entry_audit_events where action in ('enable','disable')"))[0].count, 0);
  await db.close();
});

test("W03A revisions and linked audit events are immutable", async () => {
  const db = await database();
  await seed(db);
  const result = await rpc(db, "direct_entry_enable_app_user", [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, REASON, "immutable-1"]);
  await assertSqlState(
    db.query("update public.direct_entry_app_user_revisions set action = 'disable' where revision_id = $1", [result.revision_id]),
    "55000",
  );
  await assertSqlState(
    db.query("delete from public.direct_entry_app_user_revisions where revision_id = $1", [result.revision_id]),
    "55000",
  );
  await assertSqlState(
    db.query("update public.direct_entry_audit_events set action = 'disable' where app_user_revision_id = $1", [result.revision_id]),
    "55000",
  );
  await db.close();
});
