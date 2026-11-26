import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { runCatalogBootstrap } from "./p1.6-production-catalog-bootstrap.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const ACTOR = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const SOURCE_ID = "93000000-0000-4000-8000-000000000001";
const SYNC_ID = "94000000-0000-4000-8000-000000000001";
const BASE_DATE = "2026-01-01";
const REQUIRED_CAPABILITIES = [
  "entry_admin",
  "recruiter_master_manage",
  "team_master_manage",
];
const PLAN_KEYS = [
  "source_fingerprint", "project_count", "recruiter_count",
  "provider_period_count", "invalid_count", "ambiguous_count", "catalog_empty",
];

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  for (const name of migrations) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await db.query(
    "insert into auth.users(id) values ($1::uuid)",
    [ACTOR.auth_subject],
  );
  await db.query(
    "insert into public.direct_entry_app_users" +
    " (app_user_id, auth_subject, enabled, display_name)" +
    " values ($1::uuid, $2::uuid, true, 'Synthetic Account')",
    [ACTOR.app_user_id, ACTOR.auth_subject],
  );
  for (const capability of REQUIRED_CAPABILITIES) {
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, is_current)" +
      " values ($1::uuid, $2, '2020-01-01', true)",
      [ACTOR.app_user_id, capability],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id, scope_kind, valid_from, is_current)" +
    " values ($1::uuid, 'all', '2020-01-01', true)",
    [ACTOR.app_user_id],
  );
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, is_current)" +
    " values ($1::uuid, 'entry_create', '2020-01-01', true)",
    [ACTOR.app_user_id],
  );
  await db.query(
    "insert into public.data_sources(id, drive_file_id, file_name, sheet_name)" +
    " values ($1::uuid, 'synthetic-source', 'Synthetic source', 'Synthetic data')",
    [SOURCE_ID],
  );
  await db.query(
    "insert into public.sync_runs(run_id, source_id, trigger_type, status, rows_read," +
    " rows_valid, rows_rejected, finished_at) values ($1::uuid, $2::uuid, 'manual'," +
    " 'succeeded', 20, 20, 0, now())",
    [SYNC_ID, SOURCE_ID],
  );
  return db;
}

async function databaseBeforeCatalogMigration() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => name < "20261005050000_p1_6_i04c2b_catalog_bootstrap_boundary.sql");
  for (const name of migrations) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

async function fact(db, {
  date = BASE_DATE,
  project = "project-a",
  projectDisplay = "Synthetic Project A",
  recruiter = "recruiter-a",
  recruiterDisplay = "Synthetic Recruiter A",
  provider = "hrp",
  providerDisplay = provider === "hrp" ? "HRP" : provider === "vendor" ? "Vendor" : "Không hợp lệ",
  employment = "thời vụ",
  count = 1,
  sourceId = SOURCE_ID,
  syncId = SYNC_ID,
} = {}) {
  await db.query(
    "insert into public.daily_recruitment_breakdown(" +
    "source_id,business_date,project_key,project_display,recruiter_key,recruiter_display," +
    "provider_type_key,provider_type_display,employment_type_key,employment_type_display," +
    "recruited_count,sync_run_id,snapshot_at) values(" +
    "$1::uuid,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid,now())",
    [sourceId, date, project, projectDisplay, recruiter, recruiterDisplay,
      provider, providerDisplay, employment, employment === "thời vụ" ? "Thời vụ" : "Chính thức",
      count, syncId],
  );
}

async function seedValidReporting(db) {
  await fact(db);
  await fact(db, { date: "2026-02-01", provider: "vendor", providerDisplay: "Vendor" });
  await fact(db, {
    date: "2026-01-01", project: "project-b", projectDisplay: "Synthetic Project B",
    recruiter: "recruiter-b", recruiterDisplay: "Synthetic Recruiter B", provider: "vendor",
    providerDisplay: "Vendor",
  });
  await fact(db, { date: "2099-01-01", provider: "hrp", providerDisplay: "HRP" });
  await fact(db, {
    date: "2099-01-01", project: "project-b", projectDisplay: "Synthetic Project B",
    recruiter: "recruiter-c", recruiterDisplay: "Synthetic Recruiter C", provider: "hrp",
    providerDisplay: "HRP",
  });
}

async function plan(db, actor = ACTOR) {
  await db.query("set role service_role");
  try {
    const { rows } = await db.query(
      "select public.direct_entry_catalog_bootstrap_plan($1::uuid,$2::uuid) as data",
      [actor.auth_subject, actor.app_user_id],
    );
    return rows[0].data;
  } finally {
    await db.query("reset role");
  }
}

async function apply(db, fingerprint, {
  actor = ACTOR,
  key = "synthetic-bootstrap-key",
  reason = "Synthetic approved catalog bootstrap",
} = {}) {
  await db.query("set role service_role");
  try {
    const { rows } = await db.query(
      "select public.direct_entry_apply_catalog_bootstrap(" +
      "$1::uuid,$2::uuid,$3::text,$4::text,$5::text) as data",
      [actor.auth_subject, actor.app_user_id, fingerprint, key, reason],
    );
    return rows[0].data;
  } finally {
    await db.query("reset role");
  }
}

async function counts(db) {
  const { rows } = await db.query(
    "select" +
    " (select count(*)::int from public.direct_entry_projects) as projects," +
    " (select count(*)::int from public.recruiters) as recruiters," +
    " (select count(*)::int from public.teams) as teams," +
    " (select count(*)::int from public.recruiter_aliases) as aliases," +
    " (select count(*)::int from public.recruiter_provider_memberships) as providers," +
    " (select count(*)::int from public.recruiter_team_memberships) as team_memberships," +
    " (select count(*)::int from public.direct_entry_catalog_bootstrap_runs) as runs," +
    " (select count(*)::int from public.direct_entry_restricted_reasons) as reasons," +
    " (select count(*)::int from public.direct_entry_audit_events where action='catalog_bootstrap') as audits," +
    " (select count(*)::int from public.direct_entry_banks) as banks",
  );
  return rows[0];
}

async function reportingBaseline(db) {
  const { rows } = await db.query(
    "select count(*)::int as rows, coalesce(sum(b.recruited_count),0)::bigint as total" +
    " from public.daily_recruitment_breakdown b",
  );
  return rows[0];
}

test("the migration chain applies from scratch and exposes only the approved RPC boundary", async () => {
  const db = await database();
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql"));
  // W05A #48, W07C-R7 #49, W07E #50, W02 #51, W03 #52, W04 #53,
  // W06A #54, W05 #55, W05-R1 #56, initial-ON #57, P2.5-HF #58 through R7 #64, and P3-W07A-R3 #65.
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");

  const acl = await db.query(
    "select c.relrowsecurity, c.relforcerowsecurity," +
    " has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as service_dml," +
    " has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as anon_dml," +
    " has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as auth_dml" +
    " from pg_class c where c.oid='public.direct_entry_catalog_bootstrap_runs'::regclass",
  );
  assert.deepEqual(acl.rows[0], {
    relrowsecurity: true, relforcerowsecurity: true,
    service_dml: false, anon_dml: false, auth_dml: false,
  });

  for (const signature of [
    "public.direct_entry_catalog_bootstrap_plan(uuid,uuid)",
    "public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)",
  ]) {
    const { rows } = await db.query(
      "select p.prosecdef, array_to_string(p.proconfig, ',') as config," +
      " has_function_privilege('service_role',p.oid,'EXECUTE') as service_exec," +
      " has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated',p.oid,'EXECUTE') as auth_exec," +
      " exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a" +
      " where p.oid=$1::regprocedure and a.grantee=0) as public_exec" +
      " from pg_proc p where p.oid=$1::regprocedure",
      [signature],
    );
    assert.deepEqual(rows[0], {
      prosecdef: true,
      config: "search_path=pg_catalog, public",
      service_exec: true,
      anon_exec: false,
      auth_exec: false,
      public_exec: false,
    });
  }
  assert.equal((await db.query(
    "select has_function_privilege('service_role'," +
    "'public.direct_entry_catalog_bootstrap_projection()'::regprocedure,'EXECUTE') as allowed",
  )).rows[0].allowed, false);
  const executor = await db.query(
    "select r.rolcanlogin, r.rolbypassrls," +
    " pg_get_userbyid(p.proowner) as owner," +
    " pg_has_role('service_role',r.oid,'member') as service_member" +
    " from pg_roles r cross join pg_proc p" +
    " where r.rolname='direct_entry_catalog_bootstrap_executor'" +
    " and p.oid='public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)'::regprocedure",
  );
  assert.deepEqual(executor.rows[0], {
    rolcanlogin: false,
    rolbypassrls: false,
    owner: "direct_entry_catalog_bootstrap_executor",
    service_member: false,
  });
  const memberships = await db.query(
    "select exists(select 1 from pg_auth_members m join pg_roles member_role on member_role.oid=m.member" +
    " where member_role.rolname=current_user and m.roleid='direct_entry_catalog_bootstrap_executor'::regrole)" +
    " as installer," +
    " pg_has_role('service_role','direct_entry_catalog_bootstrap_executor','member') as service," +
    " pg_has_role('anon','direct_entry_catalog_bootstrap_executor','member') as anon," +
    " pg_has_role('authenticated','direct_entry_catalog_bootstrap_executor','member') as authenticated," +
    " has_schema_privilege('direct_entry_catalog_bootstrap_executor','public','CREATE') as executor_create",
  );
  assert.deepEqual(memberships.rows[0], {
    installer: false, service: false, anon: false, authenticated: false, executor_create: false,
  });

  await db.query("set role service_role");
  await assert.rejects(
    db.query("insert into public.direct_entry_catalog_bootstrap_runs(" +
      "app_user_id,source_fingerprint,project_count,recruiter_count,team_count," +
      "provider_membership_count,status,idempotency_key,reason_id)" +
      " values ($1::uuid,repeat('a',64),0,0,0,0,'APPLIED','direct-write',$2::uuid)",
      [ACTOR.app_user_id, "00000000-0000-4000-8000-000000000001"]),
    { code: "42501" },
  );
  await assert.rejects(
    db.query("insert into public.direct_entry_projects(project_id,display_name)" +
      " values ('service-role-write','Synthetic denied write')"),
    { code: "42501" },
  );
  await db.query("reset role");
  await seedValidReporting(db);
  const { rows: scopedSource } = await db.query(
    "insert into public.data_sources(drive_file_id,file_name,sheet_name,is_test)" +
    " values ('synthetic-test-source','Synthetic test','Synthetic test',true) returning id",
  );
  const { rows: scopedRun } = await db.query(
    "insert into public.sync_runs(run_id,source_id,trigger_type,status,rows_read,rows_valid," +
    " rows_rejected,finished_at) values (gen_random_uuid(),$1::uuid,'manual','succeeded',1,1,0,now())" +
    " returning run_id",
    [scopedSource[0].id],
  );
  await fact(db, {
    sourceId: scopedSource[0].id,
    syncId: scopedRun[0].run_id,
    project: "test-only-project",
    projectDisplay: "Synthetic excluded project",
    recruiter: "test-only-recruiter",
    recruiterDisplay: "Synthetic excluded recruiter",
  });
  const planned = await plan(db);
  assert.deepEqual(Object.keys(planned).sort(), [...PLAN_KEYS].sort());
  assert.deepEqual(
    [planned.project_count, planned.recruiter_count, planned.provider_period_count,
      planned.invalid_count, planned.ambiguous_count, planned.catalog_empty],
    [2, 3, 5, 0, 0, true],
  );
  const sanitized = JSON.stringify(planned);
  for (const privateValue of ["Synthetic Project", "Synthetic Recruiter", "project-a", "recruiter-a", ACTOR.app_user_id]) {
    assert.equal(sanitized.includes(privateValue), false);
  }
  assert.equal(sanitized.includes("test-only-project"), false);
  await db.close();
});

test("failed migration rolls back executor, object, and temporary membership changes", async () => {
  const db = await databaseBeforeCatalogMigration();
  const migration = await readFile(
    path.join(MIGRATION_DIR, "20261005050000_p1_6_i04c2b_catalog_bootstrap_boundary.sql"),
    "utf8",
  );
  await db.query("begin");
  await assert.rejects(
    db.exec(`${migration}\nDO $$ BEGIN RAISE EXCEPTION 'synthetic post-ownership failure'; END $$;`),
  );
  await db.query("rollback");

  const { rows } = await db.query(
    "select to_regrole('direct_entry_catalog_bootstrap_executor') is not null as role," +
    " to_regclass('public.direct_entry_catalog_bootstrap_runs') is not null as ledger," +
    " exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace" +
    " where n.nspname='public' and p.proname like 'direct_entry_catalog_bootstrap_%') as functions," +
    " exists(select 1 from pg_policy where polname like 'direct_entry_catalog_bootstrap_%') as policies",
  );
  assert.deepEqual(rows[0], { role: false, ledger: false, functions: false, policies: false });
  await db.close();
});

test("pre-existing installer membership is rejected instead of being allowlisted", async () => {
  const db = await databaseBeforeCatalogMigration();
  const migration = await readFile(
    path.join(MIGRATION_DIR, "20261005050000_p1_6_i04c2b_catalog_bootstrap_boundary.sql"),
    "utf8",
  );
  await db.query("begin");
  await db.exec(
    "create role direct_entry_catalog_bootstrap_executor nologin noinherit nobypassrls;" +
    " grant direct_entry_catalog_bootstrap_executor to current_user;",
  );
  await assert.rejects(db.exec(migration), { code: "42501" });
  await db.query("rollback");

  const { rows } = await db.query(
    "select to_regrole('direct_entry_catalog_bootstrap_executor') is not null as role," +
    " to_regclass('public.direct_entry_catalog_bootstrap_runs') is not null as ledger",
  );
  assert.deepEqual(rows[0], { role: false, ledger: false });
  await db.close();
});

test("plan and apply require all three enabled Owner capabilities", async () => {
  const db = await database();
  await seedValidReporting(db);
  await db.query(
    "delete from public.direct_entry_capability_grants" +
    " where app_user_id=$1::uuid and capability='team_master_manage'",
    [ACTOR.app_user_id],
  );
  await assert.rejects(plan(db), { code: "42501" });
  const { rows } = await db.query(
    "select public.direct_entry_catalog_bootstrap_projection()->>'source_fingerprint' as fingerprint",
  );
  await assert.rejects(apply(db, rows[0].fingerprint), { code: "42501" });
  assert.deepEqual(await counts(db), {
    projects: 0, recruiters: 0, teams: 0, aliases: 0, providers: 0,
    team_memberships: 0, runs: 0, reasons: 0, audits: 0, banks: 0,
  });
  await db.close();
});

test("same-day provider ambiguity is reported and cannot be applied", async () => {
  const db = await database();
  await seedValidReporting(db);
  await fact(db, { provider: "vendor", providerDisplay: "Vendor", employment: "chính thức" });
  const planned = await plan(db);
  assert.equal(planned.ambiguous_count, 1);
  await assert.rejects(apply(db, planned.source_fingerprint), { code: "23514" });
  assert.equal((await counts(db)).projects, 0);
  await db.close();
});

test("invalid provider, missing valid history, malformed key, and invalid display fail closed", async (t) => {
  const cases = [
    ["invalid provider", { provider: "__invalid__" }],
    ["missing valid provider", { recruiter: "recruiter-c", recruiterDisplay: "Synthetic C", provider: "__invalid__" }],
    ["malformed project key", { project: "bad/project", projectDisplay: "Synthetic Project C" }],
    ["placeholder recruiter key", { recruiter: "__unknown__", recruiterDisplay: "Synthetic C" }],
    ["blank display", { project: "project-c", projectDisplay: " " }],
    ["same-day display conflict", { projectDisplay: "Conflicting Synthetic Project", employment: "chính thức" }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const db = await database();
      await seedValidReporting(db);
      await fact(db, options);
      const planned = await plan(db);
      assert.ok(planned.invalid_count > 0);
      await assert.rejects(apply(db, planned.source_fingerprint), { code: "23514" });
      assert.equal((await counts(db)).projects, 0);
      await db.close();
    });
  }
});

test("source fingerprint drift rejects apply before any catalog, ledger, reason, or audit write", async () => {
  const db = await database();
  await seedValidReporting(db);
  const planned = await plan(db);
  await db.query(
    "update public.daily_recruitment_breakdown set recruited_count=recruited_count+1",
  );
  await assert.rejects(apply(db, planned.source_fingerprint), { code: "PT409" });
  assert.deepEqual(await counts(db), {
    projects: 0, recruiters: 0, teams: 0, aliases: 0, providers: 0,
    team_memberships: 0, runs: 0, reasons: 0, audits: 0, banks: 0,
  });
  await db.close();
});

test("apply creates the unassigned catalog once with non-overlapping history; replay is idempotent", async () => {
  const db = await database();
  await seedValidReporting(db);
  const baseline = await reportingBaseline(db);
  const planned = await plan(db);
  const applied = await apply(db, planned.source_fingerprint);
  assert.deepEqual(
    [applied.status, applied.project_count, applied.recruiter_count, applied.team_count,
      applied.provider_membership_count, applied.replayed],
    ["APPLIED", 2, 3, 1, 5, false],
  );
  assert.deepEqual(await counts(db), {
    projects: 2, recruiters: 3, teams: 1, aliases: 3, providers: 5,
    team_memberships: 3, runs: 1, reasons: 1, audits: 1, banks: 0,
  });
  const { rows: team } = await db.query(
    "select code,display_name from public.teams where active",
  );
  assert.deepEqual(team, [{ code: "unassigned", display_name: "Chưa phân nhóm" }]);
  const { rows: intervals } = await db.query(
    "select provider_type,to_char(valid_from,'YYYY-MM-DD') as valid_from," +
    " to_char(valid_to,'YYYY-MM-DD') as valid_to,is_current from public.recruiter_provider_memberships" +
    " where recruiter_id=(select recruiter_id from public.recruiter_aliases where reporting_key='recruiter-a')" +
    " order by valid_from",
  );
  assert.deepEqual(intervals, [
    { provider_type: "hrp", valid_from: "2026-01-01", valid_to: "2026-02-01", is_current: false },
    { provider_type: "vendor", valid_from: "2026-02-01", valid_to: "2099-01-01", is_current: true },
    { provider_type: "hrp", valid_from: "2099-01-01", valid_to: null, is_current: false },
  ]);
  const { rows: futureOnly } = await db.query(
    "select p.is_current as provider_current,t.is_current as team_current"
      + " from public.recruiter_provider_memberships p"
      + " join public.recruiters r using (recruiter_id)"
      + " join public.recruiter_team_memberships t using (recruiter_id)"
      + " where r.display_name='Synthetic Recruiter C'",
  );
  assert.deepEqual(futureOnly, [{ provider_current: false, team_current: false }],
    "future-only imported history does not become current during bootstrap");
  const { rows: overlaps } = await db.query(
    "select count(*)::int as count from public.recruiter_provider_memberships a" +
    " join public.recruiter_provider_memberships b on a.recruiter_id=b.recruiter_id" +
    " and a.membership_id < b.membership_id" +
    " and daterange(a.valid_from,a.valid_to,'[)') && daterange(b.valid_from,b.valid_to,'[)')",
  );
  assert.equal(overlaps[0].count, 0);
  const { rows: audit } = await db.query(
    "select action,capability,scope_kind,outcome,reason_id,resource_ref,changed_fields" +
    " from public.direct_entry_audit_events where action='catalog_bootstrap'",
  );
  assert.equal(audit.length, 1);
  assert.deepEqual(
    [audit[0].action, audit[0].capability, audit[0].scope_kind, audit[0].outcome],
    ["catalog_bootstrap", "entry_admin", "all", "APPLIED"],
  );
  assert.match(audit[0].resource_ref, /^catalog-bootstrap:[0-9a-f-]{36}$/);
  assert.deepEqual(audit[0].changed_fields, [
    "projects", "recruiters", "recruiter_aliases", "teams",
    "recruiter_team_memberships", "recruiter_provider_memberships",
  ]);

  const { rows: catalog } = await db.query(
    "select public.direct_entry_input_catalog($1::uuid,$2::uuid,'2026-02-15'::date) as data",
    [ACTOR.auth_subject, ACTOR.app_user_id],
  );
  assert.equal(catalog[0].data.projects.length, 2);
  assert.equal(catalog[0].data.recruiters.length, 2);
  // P3-W07A: HRP recruiters show label = `display_name · personnel_code · Team`;
  // Vendor recruiters with vendor_id=NULL show label = display_name.
  // The P1.6 baseline catalog has 2 vendors (vendor rows for recruiter-a and
  // recruiter-b). Both appear in the catalog with their display_name as the
  // label until W07A links them to vendor records.
  assert.deepEqual(
    catalog[0].data.recruiters.map((r) => ({
      provider_type: r.provider_type,
      label: r.label,
    })),
    [
      { provider_type: "vendor", label: "Synthetic Recruiter A" },
      { provider_type: "vendor", label: "Synthetic Recruiter B" },
    ],
  );
  assert.deepEqual(await reportingBaseline(db), baseline);

  const replay = await apply(db, planned.source_fingerprint);
  assert.equal(replay.status, "ALREADY_APPLIED");
  assert.equal(replay.replayed, true);
  assert.deepEqual(await counts(db), {
    projects: 2, recruiters: 3, teams: 1, aliases: 3, providers: 5,
    team_memberships: 3, runs: 1, reasons: 1, audits: 1, banks: 0,
  });
  await assert.rejects(apply(db, planned.source_fingerprint, { key: "different-key" }), {
    code: "23505",
  });
  await db.close();
});

test("audit failure rolls back every catalog, reason, ledger, and audit write", async () => {
  const db = await database();
  await seedValidReporting(db);
  await db.exec(`
    create function public.test_reject_catalog_audit()
    returns trigger language plpgsql as $$
    begin
      if new.action = 'catalog_bootstrap' then
        raise exception 'synthetic audit rejection' using errcode = '23514';
      end if;
      return new;
    end
    $$;
    create trigger test_reject_catalog_audit
      before insert on public.direct_entry_audit_events
      for each row execute function public.test_reject_catalog_audit();
  `);
  const planned = await plan(db);
  await assert.rejects(apply(db, planned.source_fingerprint), { code: "23514" });
  assert.deepEqual(await counts(db), {
    projects: 0, recruiters: 0, teams: 0, aliases: 0, providers: 0,
    team_memberships: 0, runs: 0, reasons: 0, audits: 0, banks: 0,
  });
  await db.close();
});

test("operator uses RPCs only, keeps identifiers and failure details out of logs", async () => {
  const source = await readFile(
    path.join(process.cwd(), "scripts/p1.6-production-catalog-bootstrap.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /\.from\s*\(/);
  assert.doesNotMatch(source, /\.(?:select|insert|update|delete|upsert)\s*\(/);
  assert.doesNotMatch(source, /\b(?:insert\s+into|update\s+public|delete\s+from|select\s+.+\s+from\s+public)\b/i);
  for (const table of [
    "direct_entry_projects", "recruiters", "teams", "recruiter_aliases",
    "recruiter_provider_memberships", "recruiter_team_memberships",
  ]) assert.equal(source.includes(table), false);

  const calls = [];
  const logs = [];
  const planned = {
    source_fingerprint: "a".repeat(64), project_count: 8, recruiter_count: 10,
    provider_period_count: 15, invalid_count: 0, ambiguous_count: 0, catalog_empty: true,
  };
  const client = { async rpc(name, args) {
    calls.push({ name, args });
    return { data: name.endsWith("_plan") ? planned : {
      status: "APPLIED", source_fingerprint: planned.source_fingerprint,
      project_count: 8, recruiter_count: 10, team_count: 1,
      provider_membership_count: 15, replayed: false,
    }, error: null };
  } };
  await runCatalogBootstrap({
    mode: "apply", client, authSubject: ACTOR.auth_subject, appUserId: ACTOR.app_user_id,
    confirmation: "APPLY_P1_6_I04C2B_PRODUCTION_CATALOG",
    idempotencyKey: "synthetic-operator-key", log: (line) => logs.push(line),
  });
  assert.deepEqual(calls.map(({ name }) => name), [
    "direct_entry_catalog_bootstrap_plan", "direct_entry_apply_catalog_bootstrap",
  ]);
  assert.equal(JSON.stringify(logs).includes(ACTOR.auth_subject), false);
  assert.equal(JSON.stringify(logs).includes(ACTOR.app_user_id), false);
  assert.equal(JSON.stringify(logs).includes("synthetic-operator-key"), false);

  const errorLogs = [];
  await assert.rejects(runCatalogBootstrap({
    mode: "check",
    client: { async rpc() { return { data: null, error: { code: "42501", message: ACTOR.auth_subject } }; } },
    authSubject: ACTOR.auth_subject, appUserId: ACTOR.app_user_id,
    log: (line) => errorLogs.push(line),
  }), /RPC_FAILED|catalog bootstrap RPC failed/);
  assert.deepEqual(errorLogs, []);

  await assert.rejects(runCatalogBootstrap({
    mode: "apply", client, authSubject: ACTOR.auth_subject, appUserId: ACTOR.app_user_id,
    confirmation: "wrong", idempotencyKey: "synthetic-operator-key", log() {},
  }), /confirmation token/);
});
