/**
 * PRE-W2-HF Project <-> Team authority - DB regression (PGlite over the 99-migration ledger).
 *
 * Covers the mapping table + RPCs (bounded read, grant, revoke), the canonical Full
 * Admin authority boundary, the pair-version OCC and idempotency contract, half-open
 * interval integrity (invalid + overlapping), mapping-aware Team Leader Project
 * Operations (read + assign/unassign), the D4 no-backfill start state, the D3
 * fail-closed revoke, and the ACL/self-check posture.
 *
 * NOTE: this file pins project-team authority at #94 and verifies the newer
 * append-only reporting migration follows it.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const TEAM_AUTHORITY_MIGRATION = "20261015100000_pre_w2_hf_project_team_authority.sql";
const BATCH_MIGRATION = "20261015130000_pre_w2_hf_project_team_batch_mapping.sql";
const PREVIOUS_MIGRATION = "20261014190000_pre_w2_hf_g_worker_directory_export.sql";
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

const PAST = "2020-01-01";
const FULL_ADMIN = ["entry_admin", "recruiter_master_manage", "team_master_manage"];

const PROJECT_MAPPED = "pt-authority-mapped";
const PROJECT_UNMAPPED = "pt-authority-unmapped";
const PROJECT_INACTIVE = "pt-authority-inactive";

const TEAM_A = uuid(11);
const TEAM_B = uuid(12);

const ADMIN_AUTH = uuid(101), ADMIN_APP = uuid(201);
const LONE_AUTH = uuid(102), LONE_APP = uuid(202);        // entry_admin only
const ACCOUNTING_AUTH = uuid(103), ACCOUNTING_APP = uuid(203); // catalog_master_manage only
const DISABLED_AUTH = uuid(104), DISABLED_APP = uuid(204);   // Full Admin, disabled account
const LEADER_A_AUTH = uuid(105), LEADER_A_APP = uuid(205);
const LEADER_B_AUTH = uuid(106), LEADER_B_APP = uuid(206);
const LEADER_RECRUITER_A = uuid(301), LEADER_RECRUITER_B = uuid(302);
const MANAGER_A_RECRUITER = uuid(311);
const MANAGER_B_RECRUITER = uuid(312);
const MANAGER_A_AUTH = uuid(121), MANAGER_A_APP = uuid(221);
const MANAGER_B_AUTH = uuid(122), MANAGER_B_APP = uuid(222);

function uuid(n) {
  return "44000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

let keySeq = 0;
function idemKey(prefix = "pt") {
  keySeq += 1;
  return `${prefix}-key-${String(900000 + keySeq)}`;
}

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${name} failed to install: ${error.message}`, { cause: error });
    }
  }
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf("20261015180000_pre_w2_hf_direct_entry_batch_workflow.sql"), 102, "direct-entry batch workflow is the append-only #103 migration");
  assert.equal(names.indexOf("20261015170000_pre_w2_uploader_submission_queues.sql"), 101, "uploader submission queues is the append-only #102 migration");
  assert.equal(names.indexOf("20261015160000_pre_w2_initial_status_any_start_date.sql"), 100, "initial-status hotfix is the append-only #101 migration");
  assert.equal(names.indexOf("20261015140000_pre_w2_hf_account_real_name_display.sql"), 98, "account real-name display is the append-only #99 migration");
  assert.equal(names.indexOf("20261015150000_pre_w2_worker_data_capabilities_default.sql"), 99, "worker-data capabilities is the append-only #100 migration");
  assert.equal(names.indexOf("20261015140000_pre_w2_change_request_review_queue.sql"), 97, "review queue remains the append-only #98 migration");
  assert.equal(names.indexOf(BATCH_MIGRATION), 96, "batch mapping is the append-only #97 migration");
  assert.equal(names.indexOf("20261015120000_pre_w2_worker_export_text_and_cccd_issue_date.sql"), 95, "migration chronology remains append-only");
  assert.equal(names.indexOf("20261015110000_pre_w2_hf_reporting_direct_entry_only.sql"), 94, "migration chronology remains append-only");
  assert.equal(names.indexOf(TEAM_AUTHORITY_MIGRATION), 93, "the authority migration remains #94");
  assert.equal(names.indexOf(PREVIOUS_MIGRATION), 92, "Project<->Team authority #94 follows PRE-W2-HF-G #93");
  return db;
}

async function rpc(db, name, args) {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
  const res = await db.query(`select public.${name}(${placeholders}) as data`, args);
  return res.rows[0].data;
}

const listScopes = (db, actor, ...rest) =>
  rpc(db, "direct_entry_list_project_team_scopes_admin", [actor.auth, actor.app, ...rest]);
const grantScope = (db, actor, args) =>
  rpc(db, "direct_entry_grant_project_team_scope", [actor.auth, actor.app, ...args]);
const revokeScope = (db, actor, args) =>
  rpc(db, "direct_entry_revoke_project_team_scope", [actor.auth, actor.app, ...args]);
const grantScopesBatch = (db, actor, { team, projects, reason = "batch grant", key }) =>
  rpc(db, "direct_entry_grant_project_team_scopes_batch",
    [actor.auth, actor.app, team, projects, reason, key]);
const revokeScopeVersionless = (db, actor, { mapping, effectiveTo = null, reason = "batch test revoke", key }) =>
  rpc(db, "direct_entry_revoke_project_team_scope",
    [actor.auth, actor.app, mapping, effectiveTo, reason, key]);
const projectList = (db, actor, includeInactive = true) =>
  rpc(db, "direct_entry_list_projects_admin", [actor.auth, actor.app, includeInactive]);
const projectGet = (db, actor, project) =>
  rpc(db, "direct_entry_get_project_admin", [actor.auth, actor.app, project]);
const assignmentList = (db, actor, project = null, history = true) =>
  rpc(db, "direct_entry_list_project_manager_assignments", [actor.auth, actor.app, project, history]);
const assignManager = (db, actor, { project, recruiter, version, key, validFrom = null }) =>
  rpc(db, "direct_entry_assign_project_manager",
    [actor.auth, actor.app, project, recruiter, validFrom, version, "approved assignment", key]);
const unassignManager = (db, actor, { assignment, version, projectVersion, key }) =>
  rpc(db, "direct_entry_unassign_project_manager",
    [actor.auth, actor.app, assignment, version, projectVersion, "approved revocation", key]);

async function count(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

async function expectDenied(fn, code = "42501") {
  await assert.rejects(fn, (error) => error.code === code);
}

async function addAppUser(db, auth, app, { enabled = true, capabilities = [], scope = null, teamScope = null } = {}) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)"
      + " values ($1,$2,$3,'PT Actor')", [app, auth, enabled]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id,capability,valid_from,is_current)"
        + " values ($1,$2,$3,true)", [app, capability, PAST]);
  }
  if (scope !== null) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id,scope_kind,valid_from,is_current)"
        + " values ($1,$2,$3,true)", [app, scope, PAST]);
  }
  if (teamScope !== null) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id,scope_kind,team_id,valid_from,is_current)"
        + " values ($1,'team',$2,$3,true)", [app, teamScope, PAST]);
  }
}

async function addRecruiter(db, recruiter, name, { team = null, active = true } = {}) {
  await db.query(
    "insert into public.recruiters (recruiter_id,display_name,personnel_code,personnel_position,active)"
      + " values ($1,$2,$3,'STAFF',$4)", [recruiter, name, `code-${name}`, active]);
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id,provider_type,valid_from,is_current)"
      + " values ($1,'hrp',$2,true)", [recruiter, PAST]);
  if (team !== null) {
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id,team_id,valid_from,is_current)"
        + " values ($1,$2,$3,true)", [recruiter, team, PAST]);
  }
}

async function linkAccount(db, app, recruiter) {
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links"
      + " (app_user_id,recruiter_id,verified,valid_from,is_current) values ($1,$2,true,$3,true)",
    [app, recruiter, PAST]);
}

async function designateLeader(db, app, recruiter, team) {
  await db.exec("begin");
  await db.query("select set_config('direct_entry.team_leader_marker','on',true)");
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
      + " (team_id,leader_app_user_id,leader_recruiter_id,valid_from,is_current) values ($1,$2,$3,$4,true)",
    [team, app, recruiter, PAST]);
  await db.exec("commit");
}

async function seed(db) {
  await db.query(
    "insert into public.teams (team_id,code,display_name,active) values"
      + " ($1,'PT_A','PT Team A',true),($2,'PT_B','PT Team B',true)",
    [TEAM_A, TEAM_B]);
  await db.query(
    "insert into public.direct_entry_projects (project_id,display_name,active,version) values"
      + " ($1,'Mapped Project',true,1),($2,'Unmapped Project',true,1),($3,'Inactive Project',false,1)",
    [PROJECT_MAPPED, PROJECT_UNMAPPED, PROJECT_INACTIVE]);

  await addAppUser(db, ADMIN_AUTH, ADMIN_APP, { capabilities: FULL_ADMIN, scope: "all" });
  await addAppUser(db, LONE_AUTH, LONE_APP, { capabilities: ["entry_admin"], scope: "all" });
  await addAppUser(db, ACCOUNTING_AUTH, ACCOUNTING_APP, { capabilities: ["catalog_master_manage"], scope: "all" });
  await addAppUser(db, DISABLED_AUTH, DISABLED_APP, { capabilities: FULL_ADMIN, scope: "all", enabled: false });

  // Team A leader (canonical identity: capability + own-team scope + recruiter identity
  // + provider + membership + verified link + leader assignment).
  await addAppUser(db, LEADER_A_AUTH, LEADER_A_APP, {
    capabilities: ["team_manager_assign"], teamScope: TEAM_A,
  });
  await addRecruiter(db, LEADER_RECRUITER_A, "Leader A", { team: TEAM_A });
  await linkAccount(db, LEADER_A_APP, LEADER_RECRUITER_A);
  await designateLeader(db, LEADER_A_APP, LEADER_RECRUITER_A, TEAM_A);

  await addAppUser(db, LEADER_B_AUTH, LEADER_B_APP, {
    capabilities: ["team_manager_assign"], teamScope: TEAM_B,
  });
  await addRecruiter(db, LEADER_RECRUITER_B, "Leader B", { team: TEAM_B });
  await linkAccount(db, LEADER_B_APP, LEADER_RECRUITER_B);
  await designateLeader(db, LEADER_B_APP, LEADER_RECRUITER_B, TEAM_B);

  // Eligible own-team project manager for Team A, plus an other-team manager.
  await addAppUser(db, MANAGER_A_AUTH, MANAGER_A_APP, { capabilities: ["entry_create"], scope: "own" });
  await addRecruiter(db, MANAGER_A_RECRUITER, "Manager A", { team: TEAM_A });
  await linkAccount(db, MANAGER_A_APP, MANAGER_A_RECRUITER);
  await addAppUser(db, MANAGER_B_AUTH, MANAGER_B_APP, { capabilities: ["entry_create"], scope: "own" });
  await addRecruiter(db, MANAGER_B_RECRUITER, "Manager B", { team: TEAM_B });
  await linkAccount(db, MANAGER_B_APP, MANAGER_B_RECRUITER);
}

const admin = { auth: ADMIN_AUTH, app: ADMIN_APP };
const leaderA = { auth: LEADER_A_AUTH, app: LEADER_A_APP };
const leaderB = { auth: LEADER_B_AUTH, app: LEADER_B_APP };

async function projectVersion(db, project) {
  return count(db, "select version from public.direct_entry_projects where project_id = $1", [project]);
}

async function mutationState(db, project) {
  const { rows } = await db.query(`
    select
      (select count(*)::int from public.direct_entry_project_manager_assignments where project_id=$1) as assignments,
      (select version from public.direct_entry_projects where project_id=$1) as project_version,
      (select count(*)::int from public.direct_entry_project_revisions where project_id=$1) as revisions
  `, [project]);
  return rows[0];
}

// ---------------------------------------------------------------------------
// 1. Ledger + source + posture guards.
// ---------------------------------------------------------------------------
test("PRE-W2-HF Project<->Team: ledger position, source boundary and ACL posture", async () => {
  const db = await buildDb();
  try {
    const source = (await readFile(path.join(MIGRATION_DIR, TEAM_AUTHORITY_MIGRATION), "utf8"))
      .replaceAll("\r\n", "\n");
    const batchSource = (await readFile(path.join(MIGRATION_DIR, BATCH_MIGRATION), "utf8"))
      .replaceAll("\r\n", "\n");

    // The generic authority selector must NOT be rewritten to pretend it checks a project.
    assert.doesNotMatch(source,
      /create(?:\s+or\s+replace)?\s+function\s+public\.direct_entry_assert_project_operation_authority\s*\(/i);
    assert.doesNotMatch(source,
      /create(?:\s+or\s+replace)?\s+function\s+public\.direct_entry_assert_project_admin\s*\(/i);
    // Every Team Leader Project Operations path must consume the mapping predicate.
    assert.match(source, /direct_entry_project_team_scope_effective\(p_project_id, v_team_id\)/);
    assert.match(source, /direct_entry_project_team_scope_effective\(a\.project_id, v_team_id\)/);
    assert.match(source, /direct_entry_lock_project_team_scope\(p_project_id, v_team_id\)/);
    assert.match(source, /direct_entry_lock_project_team_scope\(v_project_id, v_team_id\)/);
    // Canonical Full Admin guard, no new capability vocabulary.
    assert.match(source, /direct_entry_assert_actor_app_user_admin\(p_auth_subject, p_app_user_id\)/);
    assert.doesNotMatch(source, /capability\s+(?:in|not in)?\s*\([^)]*project_team/);
    assert.match(batchSource, /direct_entry_assert_actor_app_user_admin\(p_auth_subject, p_app_user_id\)/);
    assert.match(batchSource, /direct_entry_authorization_date\(\)/);
    assert.match(batchSource, /pg_advisory_xact_lock/);
    assert.match(batchSource, /for update/i);
    assert.match(batchSource, /direct_entry_idempotency_begin/);
    assert.match(batchSource, /direct_entry_idempotency_finish/);
    assert.doesNotMatch(batchSource, /p_expected_pair_version|p_effective_from/);

    // The revoke path must keep its row lock and own the cancellation marker.
    const revokeStart = source.indexOf(
      "create or replace function public.direct_entry_revoke_project_team_scope(");
    const revokeEnd = source.indexOf("\n$$;", revokeStart);
    assert.ok(revokeStart !== -1 && revokeEnd > revokeStart, "revoke function body found");
    const revokeSource = source.slice(revokeStart, revokeEnd);
    assert.ok(revokeSource.includes("where s.mapping_id = p_mapping_id\n   for update;"),
      "the revoke RPC must re-read the mapping row FOR UPDATE after the project lock");
    assert.match(revokeSource, /project_team_scope_marker/,
      "the revoke RPC must own the cancellation marker");
    assert.match(revokeSource,
      /p_effective_to\s*>\s*public\.direct_entry_authorization_date\(\)/,
      "the revoke RPC must reject future-effective revocation dates");

    // Table: forced RLS, revoked from every role.
    const rls = (await db.query(
      "select relrowsecurity, relforcerowsecurity from pg_class"
        + " where oid = 'public.direct_entry_project_team_scopes'::regclass")).rows[0];
    assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
    for (const role of ["anon", "authenticated", "service_role"]) {
      const { rows } = await db.query(
        "select has_table_privilege($1,'public.direct_entry_project_team_scopes','SELECT') as s,"
          + " has_table_privilege($1,'public.direct_entry_project_team_scopes','INSERT,UPDATE,DELETE') as d",
        [role]);
      assert.equal(rows[0].s, false, `${role} must not select the mapping table`);
      assert.equal(rows[0].d, false, `${role} must not mutate the mapping table`);
    }

    // RPC boundary: service_role only, SECURITY DEFINER, pinned search_path.
    for (const signature of [
      "public.direct_entry_list_project_team_scopes_admin(uuid,uuid,text,uuid,boolean,integer,integer)",
      "public.direct_entry_list_project_team_scopes_admin(uuid,uuid,text,uuid,boolean,integer,integer,text)",
      "public.direct_entry_grant_project_team_scopes_batch(uuid,uuid,uuid,text[],text,text)",
      "public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,date,text,text)",
    ]) {
      const { rows } = await db.query(`
        select p.prosecdef,
               coalesce(array_to_string(p.proconfig, ','), '') as config,
               has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
               has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
          from pg_proc p where p.oid = to_regprocedure($1)`, [signature]);
      assert.equal(rows.length, 1, `${signature} exists`);
      assert.equal(rows[0].prosecdef, true);
      assert.equal(rows[0].config, "search_path=pg_catalog, public");
      assert.equal(rows[0].anon_exec, false);
      assert.equal(rows[0].auth_exec, false);
      assert.equal(rows[0].svc_exec, true);
    }
    for (const signature of [
      "public.direct_entry_grant_project_team_scope(uuid,uuid,text,uuid,integer,date,text,text)",
      "public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,integer,date,text,text)",
    ]) {
      const { rows } = await db.query(`
        select has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
               has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
          from pg_proc p where p.oid = to_regprocedure($1)`, [signature]);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], { anon_exec: false, auth_exec: false, svc_exec: false },
        `${signature} is a retired overload; current server callers use the batch grant and six-argument revoke RPCs`);
    }

    // Internal helpers stay revoked from every role.
    for (const signature of [
      "public.direct_entry_project_team_scope_effective(text,uuid)",
      "public.direct_entry_lock_project_team_scope(text,uuid)",
      "public.direct_entry_project_team_scopes_no_overlap()",
      "public.direct_entry_project_team_scopes_touch()",
      "public.direct_entry_project_team_scopes_history_guard()",
    ]) {
      const { rows } = await db.query(`
        select has_function_privilege('anon', p.oid,'EXECUTE') as a,
               has_function_privilege('authenticated', p.oid,'EXECUTE') as b,
               has_function_privilege('service_role', p.oid,'EXECUTE') as c
          from pg_proc p where p.oid = to_regprocedure($1)`, [signature]);
      assert.deepEqual(rows[0], { a: false, b: false, c: false }, `${signature} stays revoked`);
    }

    // D4: the mapping starts empty; nothing is backfilled.
    assert.equal(await count(db, "select count(*)::int from public.direct_entry_project_team_scopes"), 0);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Full Admin authority boundary.
// ---------------------------------------------------------------------------
test("PRE-W2-HF Project<->Team: only the canonical Full Admin may read/grant/revoke", async () => {
  const db = await buildDb();
  try {
    await seed(db);

    const empty = await listScopes(db, admin, null, null, true, 1, 25);
    assert.deepEqual(empty.mappings, []);
    assert.equal(empty.total, 0);

    const granted = await grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 0, null, "grant mapped project", idemKey("grant")]);
    assert.equal(granted.project_id, PROJECT_MAPPED);
    assert.equal(granted.team_id, TEAM_A);
    assert.equal(granted.valid_to, null);
    assert.equal(granted.version, 1);

    for (const actor of [
      { auth: LONE_AUTH, app: LONE_APP },
      { auth: ACCOUNTING_AUTH, app: ACCOUNTING_APP },
      { auth: DISABLED_AUTH, app: DISABLED_APP },
      { auth: uuid(999), app: ADMIN_APP },
      { auth: LEADER_A_AUTH, app: LEADER_A_APP },
    ]) {
      await expectDenied(async () => listScopes(db, actor, null, null, true, 1, 25));
      await expectDenied(async () => grantScope(db, actor,
        [PROJECT_UNMAPPED, TEAM_A, 0, null, "denied grant", idemKey("denied-grant")]));
      await expectDenied(async () => revokeScope(db, actor,
        [granted.mapping_id, 1, null, "denied revoke", idemKey("denied-revoke")]));
    }

    const list = await listScopes(db, admin, PROJECT_MAPPED, TEAM_A, true, 1, 25);
    assert.equal(list.total, 1);
    assert.deepEqual(Object.keys(list.mappings[0]).sort(), [
      "created_at", "effective", "mapping_id", "project_display_name", "project_id",
      "revoked_at", "state", "team_code", "team_display_name", "team_id", "valid_from",
      "valid_to", "version",
    ]);
    assert.equal(list.mappings[0].effective, true);
    assert.equal(list.mappings[0].state, "CURRENT");

    await expectDenied(async () => listScopes(db, admin, null, null, true, 0, 25), "22023");
    await expectDenied(async () => listScopes(db, admin, null, null, true, 1, 101), "22023");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Searchable mapping read (HF): fuzzy search over code and display name.
// ---------------------------------------------------------------------------
const TEAM_SEARCH = uuid(21);
const PROJECT_COMPAL = "pt-hf-compal";
const PROJECT_OTHER = "pt-hf-other";

test("PRE-W2-HF Project<->Team: search filters by project/team code or name before paging", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await db.query(
      "insert into public.teams (team_id,code,display_name,active) values ($1,'PT_XZ','Nhóm XenZin',true)",
      [TEAM_SEARCH]);
    await db.query(
      "insert into public.direct_entry_projects (project_id,display_name,active,version) values"
        + " ($1,'Compal Electronics',true,1),($2,'Other Plant',true,1)",
      [PROJECT_COMPAL, PROJECT_OTHER]);
    await grantScope(db, admin,
      [PROJECT_COMPAL, TEAM_SEARCH, 0, null, "grant compal", idemKey("search-1")]);
    await grantScope(db, admin,
      [PROJECT_OTHER, TEAM_SEARCH, 0, null, "grant other", idemKey("search-2")]);

    const search = (project, team, history, page, size, term) =>
      rpc(db, "direct_entry_list_project_team_scopes_admin",
        [admin.auth, admin.app, project, team, history, page, size, term]);

    // Exactly one mapping matches the (case-insensitive) project display-name substring.
    const byName = await search(null, null, true, 1, 25, "compal");
    assert.equal(byName.total, 1);
    assert.deepEqual(byName.mappings.map((row) => row.project_id), [PROJECT_COMPAL]);
    assert.equal(byName.mappings[0].team_code, "PT_XZ");

    // Case-insensitive and matching the project code substring too.
    assert.equal((await search(null, null, true, 1, 25, "COMPAL")).total, 1);
    assert.equal((await search(null, null, true, 1, 25, "pt-hf-comp")).total, 1);

    // Matching the team code and the team display name returns both mappings.
    assert.equal((await search(null, null, true, 1, 25, "xz")).total, 2);
    assert.equal((await search(null, null, true, 1, 25, "xenzin")).total, 2);

    // A whitespace-only term is "no filter" and returns the unfiltered set.
    assert.equal((await search(null, null, true, 1, 25, "   ")).total, 2);

    // Filtering happens before pagination: page_size 1 keeps total at the filtered count.
    const paged = await search(null, null, true, 1, 1, "xenzin");
    assert.equal(paged.total, 2);
    assert.equal(paged.has_more, true);
    assert.equal(paged.mappings.length, 1);

    // A term that matches nothing yields an empty, consistent envelope.
    const none = await search(null, null, true, 1, 25, "zzz-no-match");
    assert.equal(none.total, 0);
    assert.deepEqual(none.mappings, []);

    // The exact project_id filter still composes with search.
    const exact = await search(PROJECT_COMPAL, null, true, 1, 25, "compal");
    assert.equal(exact.total, 1);
    const exactMiss = await search(PROJECT_OTHER, null, true, 1, 25, "compal");
    assert.equal(exactMiss.total, 0);

    // Oversized search is rejected before any read.
    await expectDenied(async () => search(null, null, true, 1, 25, "x".repeat(257)), "22023");
  } finally {
    await db.close();
  }
});

test("PRE-W2-HF Project<->Team: batch mapping is atomic, idempotent, and owns pair versions", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const today = (await db.query(
      "select public.direct_entry_authorization_date()::text as today")).rows[0].today;
    const key = idemKey("batch");
    const first = await grantScopesBatch(db, admin, {
      team: TEAM_A, projects: [PROJECT_MAPPED, PROJECT_UNMAPPED], key,
    });
    assert.deepEqual(Object.keys(first).sort(), ["created", "effective_from", "skipped", "team_id"]);
    assert.equal(first.team_id, TEAM_A);
    assert.equal(first.effective_from, today);
    assert.deepEqual(first.created.map(({ project_id }) => project_id).sort(),
      [PROJECT_MAPPED, PROJECT_UNMAPPED].sort());
    assert.ok(first.created.every((row) => row.version === 1 && row.created === true));
    assert.deepEqual(first.skipped, []);
    assert.deepEqual(await grantScopesBatch(db, admin, {
      team: TEAM_A, projects: [PROJECT_UNMAPPED, PROJECT_MAPPED], key,
    }), first, "input ordering is normalized for exact idempotent replay");

    const skipped = await grantScopesBatch(db, admin, {
      team: TEAM_A, projects: [PROJECT_MAPPED, PROJECT_UNMAPPED], key: idemKey("batch-skip"),
    });
    assert.deepEqual(skipped.created, []);
    assert.equal(skipped.skipped.length, 2);
    assert.ok(skipped.skipped.every((row) => row.status === "ALREADY_EFFECTIVE" && row.version === 1));
    const atomicProjects = ["pt-authority-batch-atomic-a", "pt-authority-batch-atomic-b"];
    await db.query(
      "insert into public.direct_entry_projects(project_id,display_name,active,version)"
        + " values ($1,'Atomic A',true,1),($2,'Atomic B',true,1)",
      atomicProjects);

    const baseline = await db.query(`
      select
        (select count(*)::int from public.direct_entry_project_team_scopes) as mappings,
        (select count(*)::int from public.direct_entry_audit_events
          where action='project_team_scope_grant') as audits
    `);
    const before = baseline.rows[0];
    const invalidBatches = [
      { team: TEAM_A, projects: [PROJECT_UNMAPPED, "missing-batch-project"], code: "P0002" },
      { team: TEAM_A, projects: [PROJECT_UNMAPPED, PROJECT_INACTIVE], code: "22023" },
      { team: TEAM_B, projects: [PROJECT_UNMAPPED], code: "22023", inactiveTeam: true },
      { team: uuid(98765), projects: [PROJECT_UNMAPPED], code: "P0002" },
    ];
    for (const invalid of invalidBatches) {
      if (invalid.inactiveTeam) {
        await db.query("update public.teams set active=false where team_id=$1", [TEAM_B]);
      }
      const badKey = idemKey("batch-invalid");
      await expectDenied(async () => grantScopesBatch(db, admin, {
        team: invalid.team, projects: invalid.projects, key: badKey,
      }), invalid.code);
      const after = (await db.query(`
        select
          (select count(*)::int from public.direct_entry_project_team_scopes) as mappings,
          (select count(*)::int from public.direct_entry_audit_events
            where action='project_team_scope_grant') as audits,
          (select count(*)::int from public.direct_entry_rpc_idempotency
            where app_user_id=$1 and action='project_team_scope_batch_grant'
              and idempotency_key=$2) as idempotency
      `, [ADMIN_APP, badKey])).rows[0];
      assert.deepEqual(after, { ...before, idempotency: 0 },
        "one invalid item rolls back all mappings, audit, reason and idempotency writes");
    }

    const injectedKey = idemKey("batch-midwrite-failure");
    await db.exec(`
      create function public.test_fail_second_batch_mapping()
      returns trigger language plpgsql set search_path=pg_catalog, public as $$
      begin
        if new.project_id = '${atomicProjects[1]}' then
          raise exception 'injected mid-batch failure' using errcode='23514';
        end if;
        return new;
      end
      $$;
      create trigger z_test_fail_second_batch_mapping
        before insert on public.direct_entry_project_team_scopes
        for each row execute function public.test_fail_second_batch_mapping();
    `);
    await expectDenied(() => grantScopesBatch(db, admin, {
      team: TEAM_A, projects: atomicProjects, reason: "injected batch write failure", key: injectedKey,
    }), "23514");
    const rolledBack = (await db.query(`
      select
        (select count(*)::int from public.direct_entry_project_team_scopes
          where project_id = any($1::text[]) and team_id=$2) as mappings,
        (select count(*)::int from public.direct_entry_audit_events
          where action='project_team_scope_grant') as audits,
        (select count(*)::int from public.direct_entry_rpc_idempotency
          where app_user_id=$3 and action='project_team_scope_batch_grant'
            and idempotency_key=$4) as idempotency,
        (select count(*)::int from public.direct_entry_restricted_reasons
          where reason_text='injected batch write failure') as reasons
    `, [atomicProjects, TEAM_A, ADMIN_APP, injectedKey])).rows[0];
    assert.deepEqual(rolledBack, {
      mappings: 0, audits: before.audits, idempotency: 0, reasons: 0,
    },
      "a write-time failure after the first insert rolls back all batch side effects");

    const lone = { auth: LONE_AUTH, app: LONE_APP };
    const accounting = { auth: ACCOUNTING_AUTH, app: ACCOUNTING_APP };
    const leader = { auth: LEADER_A_AUTH, app: LEADER_A_APP };
    for (const actor of [lone, accounting, leader, { auth: uuid(999), app: ADMIN_APP }]) {
      await expectDenied(() => grantScopesBatch(db, actor, {
        team: TEAM_A, projects: [PROJECT_UNMAPPED], key: idemKey("batch-denied"),
      }));
    }
    await expectDenied(() => grantScopesBatch(db,
      { auth: uuid(999), app: ADMIN_APP }, {
        team: TEAM_A, projects: [PROJECT_UNMAPPED], key: idemKey("batch-anonymous"),
      }));

    const mapping = first.created.find((row) => row.project_id === PROJECT_MAPPED);
    assert.ok(mapping);
    const revokeKey = idemKey("batch-revoke");
    const revoked = await revokeScopeVersionless(db, admin, {
      mapping: mapping.mapping_id, key: revokeKey,
    });
    assert.equal(revoked.version, mapping.version + 1);
    assert.equal(revoked.revoked, true);
    assert.deepEqual(await revokeScopeVersionless(db, admin, {
      mapping: mapping.mapping_id, key: revokeKey,
    }), revoked, "versionless revoke replays exact saved outcome");
    await expectDenied(() => revokeScopeVersionless(db, admin, {
      mapping: mapping.mapping_id, key: idemKey("batch-revoke-again"),
    }), "22023");

    const audit = (await db.query(`
      select count(*)::int as n from public.direct_entry_audit_events
       where action='project_team_scope_grant' and resource_ref = any($1::text[])
    `, [first.created.map((row) => row.mapping_id)])).rows[0].n;
    assert.equal(audit, 2, "one immutable audit event is recorded for each created mapping");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Grant contract: target validation, OCC, idempotency, overlaps.
// ---------------------------------------------------------------------------
test("PRE-W2-HF Project<->Team: grant target validation, OCC, idempotency and interval integrity", async () => {
  const db = await buildDb();
  try {
    await seed(db);

    await expectDenied(async () => grantScope(db, admin,
      ["no-such-project", TEAM_A, 0, null, "missing project", idemKey("missing")]), "P0002");
    await expectDenied(async () => grantScope(db, admin,
      [PROJECT_INACTIVE, TEAM_A, 0, null, "inactive project", idemKey("inactive")]), "22023");
    await expectDenied(async () => grantScope(db, admin,
      [PROJECT_MAPPED, "00000000-0000-4000-8000-0000000000ff", 0, null, "missing team", idemKey("missing-team")]), "P0002");
    await expectDenied(async () => grantScope(db, admin,
      [PROJECT_MAPPED, uuid(9999), 0, null, "bad team", idemKey("bad-team")]), "P0002");

    const key = idemKey("grant-a");
    const first = await grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 0, null, "grant mapped project", key]);
    assert.equal(first.version, 1);
    const replay = await grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 0, null, "grant mapped project", key]);
    assert.deepEqual(replay, first, "same key/payload replays the recorded grant");

    await expectDenied(async () => grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 0, null, "different payload", key]), "22023");

    // OCC: the pair version is now 1; a stale expected version fails closed.
    await expectDenied(async () => grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 0, null, "stale grant", idemKey("stale")]), "PT409");
    await expectDenied(async () => grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 5, null, "future grant", idemKey("future")]), "PT409");

    // Overlapping interval for the same pair fails; no residue.
    const before = await count(db, "select count(*)::int from public.direct_entry_project_team_scopes");
    await expectDenied(async () => grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 1, null, "overlap grant", idemKey("overlap")]), "23P01");
    assert.equal(await count(db, "select count(*)::int from public.direct_entry_project_team_scopes"), before);

    // Interval integrity at the DB level: an inverted interval cannot be constructed at
    // all, and a zero-length interval may only be written by the audited revoke RPC.
    const reasonId = (await db.query(
      "select reason_id from public.direct_entry_restricted_reasons limit 1")).rows[0].reason_id;
    await assert.rejects(db.query(
      "insert into public.direct_entry_project_team_scopes"
        + " (project_id,team_id,valid_from,valid_to,version,granted_by_user_id,reason_id)"
        + " values ($1,$2,'2026-01-10','2026-01-05',9,$3,$4)",
      [PROJECT_MAPPED, TEAM_B, ADMIN_APP, reasonId]), (error) => Boolean(error));
    await assert.rejects(db.query(
      "insert into public.direct_entry_project_team_scopes"
        + " (project_id,team_id,valid_from,valid_to,version,granted_by_user_id,reason_id)"
        + " values ($1,$2,'2026-01-10','2026-01-10',9,$3,$4)",
      [PROJECT_MAPPED, TEAM_B, ADMIN_APP, reasonId]), (error) => error.code === "23514");

    // History guard: a mapping row can never be deleted.
    await assert.rejects(db.query(
      "delete from public.direct_entry_project_team_scopes where mapping_id = $1", [first.mapping_id]),
    (error) => error.code === "55000");

    const audit = (await db.query(
      "select capability, scope_kind, resource_ref from public.direct_entry_audit_events"
        + " where action = 'project_team_scope_grant' order by created_at desc limit 1")).rows[0];
    assert.deepEqual(audit, {
      capability: "entry_admin", scope_kind: "all", resource_ref: first.mapping_id,
    });
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Mapping-aware Team Leader Project Operations.
// ---------------------------------------------------------------------------
test("PRE-W2-HF Project<->Team: leader reads and assignments require an active mapped project", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const grant = await grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 0, null, "grant mapped project", idemKey("gate-grant")]);

    // Before any mapping a leader sees no project at all (D4 fail-closed).
    const leaderBList = await projectList(db, leaderB, true);
    assert.deepEqual(leaderBList.projects, [], "an unmapped leader sees no project");

    const leaderList = await projectList(db, leaderA, true);
    assert.deepEqual(leaderList.projects.map((project) => project.project_id), [PROJECT_MAPPED]);
    for (const project of leaderList.projects) {
      assert.equal(project.can_assign_managers, true);
      assert.equal(project.can_manage_project_master, false, "leader never manages project master");
    }
    const mapped = await projectGet(db, leaderA, PROJECT_MAPPED);
    assert.equal(mapped.can_assign_managers, true);
    assert.equal(mapped.can_manage_project_master, false);
    await expectDenied(async () => projectGet(db, leaderA, PROJECT_UNMAPPED), "P0002");
    await expectDenied(async () => projectGet(db, leaderA, PROJECT_INACTIVE), "P0002");
    await expectDenied(async () => projectGet(db, leaderB, PROJECT_MAPPED), "P0002");

    const adminProject = await projectGet(db, admin, PROJECT_UNMAPPED);
    assert.equal(adminProject.can_manage_project_master, true);
    assert.equal(adminProject.can_assign_managers, true);

    // Assign: the target PM must belong to the leader's own team on a mapped project.
    const assigned = await assignManager(db, leaderA, {
      project: PROJECT_MAPPED, recruiter: MANAGER_A_RECRUITER,
      version: await projectVersion(db, PROJECT_MAPPED), key: idemKey("assign-ok"),
    });
    assert.equal(assigned.already_assigned, false);
    const audit = (await db.query(
      "select capability, scope_kind, scope_team_id from public.direct_entry_audit_events"
        + " where action='project_manager_assignment_assign' and resource_ref=$1",
      [assigned.assignment_id])).rows[0];
    assert.deepEqual(audit, { capability: "team_manager_assign", scope_kind: "team", scope_team_id: TEAM_A });

    await expectDenied(async () => assignManager(db, leaderA, {
      project: PROJECT_MAPPED, recruiter: MANAGER_B_RECRUITER,
      version: await projectVersion(db, PROJECT_MAPPED), key: idemKey("cross-team"),
    }), "42501");
    await expectDenied(async () => assignManager(db, leaderA, {
      project: PROJECT_UNMAPPED, recruiter: MANAGER_A_RECRUITER,
      version: await projectVersion(db, PROJECT_UNMAPPED), key: idemKey("unmapped"),
    }), "42501");
    await expectDenied(async () => assignManager(db, leaderB, {
      project: PROJECT_MAPPED, recruiter: MANAGER_A_RECRUITER,
      version: await projectVersion(db, PROJECT_MAPPED), key: idemKey("foreign-team"),
    }), "42501");
    await expectDenied(async () => assignManager(db, leaderA, {
      project: PROJECT_INACTIVE, recruiter: MANAGER_A_RECRUITER,
      version: await projectVersion(db, PROJECT_INACTIVE), key: idemKey("inactive-assign"),
    }), "22023");

    // Reads are filtered the same way.
    const leaderAssignments = await assignmentList(db, leaderA, PROJECT_MAPPED);
    assert.deepEqual(leaderAssignments.assignments.map((row) => row.manager_recruiter_id),
      [MANAGER_A_RECRUITER]);
    assert.equal(leaderAssignments.assignments[0].effective, true,
      "project-manager effective output comes from the current-state marker");
    await expectDenied(async () => assignmentList(db, leaderA, PROJECT_UNMAPPED), "P0002");
    await expectDenied(async () => assignmentList(db, leaderB, PROJECT_MAPPED), "P0002");
    const wide = await assignmentList(db, leaderA, null);
    assert.equal(wide.assignments.some((row) => row.project_id !== PROJECT_MAPPED), false);
    assert.equal(grant.version, 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Revoke closes access, keeps history, and regrant restores it.
// ---------------------------------------------------------------------------
test("PRE-W2-HF Project<->Team: revoke fails closed, keeps PM history, and regrant restores access", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const grant = await grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 0, null, "grant mapped project", idemKey("revoke-grant")]);
    const assigned = await assignManager(db, leaderA, {
      project: PROJECT_MAPPED, recruiter: MANAGER_A_RECRUITER,
      version: await projectVersion(db, PROJECT_MAPPED), key: idemKey("revoke-assign"),
    });
    const beforeHistory = (await db.query(
      "select version, valid_to, revoked_at from public.direct_entry_project_manager_assignments"
        + " where assignment_id = $1", [assigned.assignment_id])).rows[0];
    const beforeRevision = await mutationState(db, PROJECT_MAPPED);

    // OCC: a stale expected version fails closed, and a successful revoke cannot be
    // reopened. The same request replays the recorded result; a different key fails
    // because the mapping is already revoked.
    await expectDenied(async () => revokeScope(db, admin,
      [grant.mapping_id, 99, null, "stale revoke", idemKey("stale-revoke")]), "PT409");
    const revokePrimaryKey = idemKey("revoke-ok");
    const revoked = await revokeScope(db, admin,
      [grant.mapping_id, 1, null, "revoke mapped project", revokePrimaryKey]);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.version, 2);
    assert.equal(revoked.valid_to, (await db.query(
      "select public.direct_entry_authorization_date()::text as today")).rows[0].today);
    assert.deepEqual(await revokeScope(db, admin,
      [grant.mapping_id, 1, null, "revoke mapped project", revokePrimaryKey]), revoked,
      "the exact same request replays the recorded revoke");
    await expectDenied(async () => revokeScope(db, admin,
      [grant.mapping_id, 2, null, "revoke again", idemKey("revoke-fresh-key")]), "22023");

    // Leader loses every operation immediately.
    assert.deepEqual((await projectList(db, leaderA, true)).projects, []);
    await expectDenied(async () => projectGet(db, leaderA, PROJECT_MAPPED), "P0002");
    await expectDenied(async () => assignmentList(db, leaderA, PROJECT_MAPPED), "P0002");
    await expectDenied(async () => assignManager(db, leaderA, {
      project: PROJECT_MAPPED, recruiter: MANAGER_A_RECRUITER,
      version: await projectVersion(db, PROJECT_MAPPED), key: idemKey("after-revoke-assign"),
    }), "42501");
    await expectDenied(async () => unassignManager(db, leaderA, {
      assignment: assigned.assignment_id, version: beforeHistory.version,
      projectVersion: await projectVersion(db, PROJECT_MAPPED), key: idemKey("after-revoke-unassign"),
    }), "42501");

    // PM assignment history is untouched by the mapping revoke.
    const afterHistory = (await db.query(
      "select version, valid_to, revoked_at from public.direct_entry_project_manager_assignments"
        + " where assignment_id = $1", [assigned.assignment_id])).rows[0];
    assert.deepEqual(afterHistory, beforeHistory, "revoke never rewrites PM assignment history");
    const afterRevision = await mutationState(db, PROJECT_MAPPED);
    assert.deepEqual(afterRevision, beforeRevision, "revoke writes no project revision");

    // Admin keeps its own Project Operations path.
    const adminUnassign = await unassignManager(db, admin, {
      assignment: assigned.assignment_id, version: beforeHistory.version,
      projectVersion: await projectVersion(db, PROJECT_MAPPED), key: idemKey("admin-unassign"),
    });
    assert.equal(adminUnassign.already_unassigned, false);

    // Regrant after revoke restores leader access under the next pair version.
    const regrant = await grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 2, null, "regrant mapped project", idemKey("regrant")]);
    assert.equal(regrant.version, 3);
    assert.deepEqual((await projectList(db, leaderA, true)).projects.map((project) => project.project_id),
      [PROJECT_MAPPED]);

    // History is preserved for both intervals.
    const history = await listScopes(db, admin, PROJECT_MAPPED, TEAM_A, true, 1, 25);
    assert.equal(history.total, 2);
    assert.equal(history.mappings.filter((row) => row.state === "CURRENT").length, 1);
    assert.equal(history.mappings.filter((row) => row.state === "HISTORY").length, 1);
    const revokedProjection = history.mappings.find((row) => row.mapping_id === grant.mapping_id);
    assert.equal(revokedProjection.effective, false,
      "effective output follows the cleared current-state marker");
    assert.equal(revokedProjection.state, "HISTORY");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Denied leader writes leave no residue.
// ---------------------------------------------------------------------------
test("PRE-W2-HF Project<->Team: a denied leader write on an unmapped project leaves no residue", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const before = await mutationState(db, PROJECT_UNMAPPED);
    await expectDenied(async () => assignManager(db, leaderA, {
      project: PROJECT_UNMAPPED, recruiter: MANAGER_A_RECRUITER,
      version: await projectVersion(db, PROJECT_UNMAPPED), key: idemKey("residue"),
    }), "42501");
    assert.deepEqual(await mutationState(db, PROJECT_UNMAPPED), before);
    assert.equal(await count(db,
      "select count(*)::int from public.direct_entry_audit_events"
        + " where action='project_manager_assignment_assign'"), 0);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Revoke date semantics: same-day cancellation, current end date, and no future scheduling.
// ---------------------------------------------------------------------------
test("PRE-W2-HF Project<->Team: revoke is immediate and rejects future effective dates without residue", async () => {
  const db = await buildDb();
  try {
    await seed(db);

    // Same-day grant -> revoke removes access on the authorization date. Only the
    // audited revoke RPC may close the interval at its own start date.
    const grant = await grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 0, null, "same day grant", idemKey("same-day-grant")]);
    const today = (await db.query(
      "select public.direct_entry_authorization_date()::text as today")).rows[0].today;
    const revoked = await revokeScope(db, admin,
      [grant.mapping_id, 1, null, "same day revoke", idemKey("same-day-revoke")]);
    assert.equal(revoked.valid_to, today);
    const row = (await db.query(
      "select valid_from::text as f, valid_to::text as t from"
        + " public.direct_entry_project_team_scopes where mapping_id = $1",
      [grant.mapping_id])).rows[0];
    assert.equal(row.f, today);
    assert.equal(row.t, today, "revoke closes the interval exactly at the start date");
    assert.deepEqual((await projectList(db, leaderA, true)).projects, []);

    // An explicit end date at the authorization date still removes access immediately.
    const nextGrant = await grantScope(db, admin,
      [PROJECT_MAPPED, TEAM_A, 2, today, "second grant", idemKey("second-grant")]);
    const before = (await db.query(
      "select valid_from::text as valid_from, valid_to::text as valid_to, version,"
        + " revoked_by_user_id, revoke_reason_id from public.direct_entry_project_team_scopes"
        + " where mapping_id = $1", [nextGrant.mapping_id])).rows[0];
    const auditBefore = await count(db,
      "select count(*)::int from public.direct_entry_audit_events"
        + " where action='project_team_scope_revoke'");
    const futureKey = idemKey("future-revoke");
    await expectDenied(async () => revokeScope(db, admin,
      [nextGrant.mapping_id, nextGrant.version, "2099-01-01", "future revoke", futureKey]), "22023");
    const after = (await db.query(
      "select valid_from::text as valid_from, valid_to::text as valid_to, version,"
        + " revoked_by_user_id, revoke_reason_id from public.direct_entry_project_team_scopes"
        + " where mapping_id = $1", [nextGrant.mapping_id])).rows[0];
    assert.deepEqual(after, before, "future revoke leaves the mapping unchanged");
    assert.equal(await count(db,
      "select count(*)::int from public.direct_entry_audit_events"
        + " where action='project_team_scope_revoke'"), auditBefore,
    "future revoke writes no audit event");
    assert.equal(await count(db,
      "select count(*)::int from public.direct_entry_rpc_idempotency"
        + " where app_user_id=$1 and action='project_team_scope_revoke' and idempotency_key=$2",
      [ADMIN_APP, futureKey]), 0, "future revoke leaves no idempotency residue");

    const revokedToday = await revokeScope(db, admin,
      [nextGrant.mapping_id, nextGrant.version, today, "revoke today", idemKey("revoke-today")]);
    assert.equal(revokedToday.valid_to, today);
    assert.deepEqual((await projectList(db, leaderA, true)).projects
      .map((project) => project.project_id), []);
  } finally {
    await db.close();
  }
});
