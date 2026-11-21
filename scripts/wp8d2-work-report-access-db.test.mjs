/**
 * WP8D-2 — Work Reports Subsystem Authorization Migration to WP5 Paired Access
 * PGlite Database, Anti-Drift Probe Oracle, and End-to-End SQL -> Actor -> TS Suite.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import { PGlite } from "@electric-sql/pglite";
import {
  migrationChecksum,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";
import { resolveActor } from "../src/lib/auth/direct-entry-v2.ts";
import {
  decideWorkReportAnalyticsPageAccess,
  decideWorkReportAssignmentsPageAccess,
  decideWorkReportTemplatesPageAccess,
  decideWorkReportsPageAccess,
} from "../src/lib/auth/direct-entry-page-access.ts";
import {
  decideNavEntryVisibility,
  workReportAnalyticsPredicate,
  workReportAssignmentPredicate,
  workReportDelegationPredicate,
  workReportReviewPredicate,
  workReportTemplateManagePredicate,
  workReportViewPredicate,
  workReportsNavPredicate,
} from "../src/lib/navigation/registry-capability.ts";
import { createAssignmentRepository } from "../src/lib/work-reports/assignment-repository.ts";
import {
  decideWorkReportReview,
  getWorkReportReviewSubmission,
  listPendingWorkReportReviews,
} from "../src/lib/work-reports/review-api.ts";
import { createReviewRepository } from "../src/lib/work-reports/review-repository.ts";
import { createSubmissionRepository } from "../src/lib/work-reports/submission-repository.ts";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const WP8D2_MIGRATION_NAME = "20261120170000_wp8d2_work_report_access.sql";
const WP8C1_MIGRATION_NAME = "20261120150000_wp8c1_contextual_tl_pm_guards.sql";

const PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const TEAM_A = "58d20000-0000-4000-8000-00000000000a";
const TEAM_B = "58d20000-0000-4000-8000-00000000000b";
const TEAM_INACTIVE = "58d20000-0000-4000-8000-00000000000c";

const OWNER = { auth: "18d20000-0000-4000-8000-000000000001", app: "28d20000-0000-4000-8000-000000000001", email: "nobita6986@gmail.com", name: "Owner WP8D2" };
const LUANPT = { auth: "18d20000-0000-4000-8000-000000000002", app: "28d20000-0000-4000-8000-000000000002", email: "luanpt@hrpartner.vn", name: "Luan PT" };
const LIENVU = { auth: "18d20000-0000-4000-8000-000000000003", app: "28d20000-0000-4000-8000-000000000003", email: "lienvu@hrpartner.vn", name: "Lien Vu" };
const NGATTT = { auth: "18d20000-0000-4000-8000-000000000004", app: "28d20000-0000-4000-8000-000000000004", email: "ngattt@hrpartner.vn", name: "Nga TTT" };

const TL_A = { auth: "18d20000-0000-4000-8000-000000000005", app: "28d20000-0000-4000-8000-000000000005", recruiter: "38d20000-0000-4000-8000-000000000005", email: "tla.wp8d2@hrpartner.vn", name: "Leader A Mirror Cleared" };
const HR_TL_A = { auth: "18d20000-0000-4000-8000-000000000006", app: "28d20000-0000-4000-8000-000000000006", recruiter: "38d20000-0000-4000-8000-000000000006", email: "hrtla.wp8d2@hrpartner.vn", name: "Dual HR Operator + TL A" };
const STAFF_A1 = { auth: "18d20000-0000-4000-8000-000000000007", app: "28d20000-0000-4000-8000-000000000007", recruiter: "38d20000-0000-4000-8000-000000000007", email: "staffa1.wp8d2@hrpartner.vn", name: "Staff A1" };
const STAFF_A2 = { auth: "18d20000-0000-4000-8000-000000000008", app: "28d20000-0000-4000-8000-000000000008", recruiter: "38d20000-0000-4000-8000-000000000008", email: "staffa2.wp8d2@hrpartner.vn", name: "Staff A2 Delegate" };
const STAFF_B1 = { auth: "18d20000-0000-4000-8000-000000000009", app: "28d20000-0000-4000-8000-000000000009", recruiter: "38d20000-0000-4000-8000-000000000009", email: "staffb1.wp8d2@hrpartner.vn", name: "Staff B1" };
const VIEW_ANALYTICS_ONLY = { auth: "18d20000-0000-4000-8000-000000000010", app: "28d20000-0000-4000-8000-000000000010", email: "vaonly.wp8d2@hrpartner.vn", name: "View + Analytics Only" };
const VIEW_ONLY = { auth: "18d20000-0000-4000-8000-000000000011", app: "28d20000-0000-4000-8000-000000000011", email: "viewonly.wp8d2@hrpartner.vn", name: "View Only" };
const ANALYTICS_ONLY = { auth: "18d20000-0000-4000-8000-000000000012", app: "28d20000-0000-4000-8000-000000000012", email: "anonly.wp8d2@hrpartner.vn", name: "Analytics Only" };
const CROSS_AV = { auth: "18d20000-0000-4000-8000-000000000013", app: "28d20000-0000-4000-8000-000000000013", email: "crossav.wp8d2@hrpartner.vn", name: "Analytics ALL + View Team A" };
const OWN_VIEWER = { auth: "18d20000-0000-4000-8000-000000000014", app: "28d20000-0000-4000-8000-000000000014", email: "ownview.wp8d2@hrpartner.vn", name: "Own Scope Report View" };
const TEAM_FORM_MGR = { auth: "18d20000-0000-4000-8000-000000000015", app: "28d20000-0000-4000-8000-000000000015", email: "teamform.wp8d2@hrpartner.vn", name: "Team Scope Form Manage" };
const DELEG_GRANTOR = { auth: "18d20000-0000-4000-8000-000000000016", app: "28d20000-0000-4000-8000-000000000016", email: "grantor.wp8d2@hrpartner.vn", name: "Direct Delegation Grantor" };
const DISJOINT_DELEG = { auth: "18d20000-0000-4000-8000-000000000017", app: "28d20000-0000-4000-8000-000000000017", email: "disjoint.wp8d2@hrpartner.vn", name: "Disjoint Team Delegator" };
const ADMIN_AND_TL = { auth: "18d20000-0000-4000-8000-000000000018", app: "28d20000-0000-4000-8000-000000000018", recruiter: "38d20000-0000-4000-8000-000000000018", email: "admintl.wp8d2@hrpartner.vn", name: "Admin Plus TL B" };
const SHARED_ACCT = { auth: "18d20000-0000-4000-8000-000000000019", app: "28d20000-0000-4000-8000-000000000019", email: "shared.wp8d2@hrpartner.vn", name: "Shared Account" };
const DISABLED_ADMIN = { auth: "18d20000-0000-4000-8000-000000000020", app: "28d20000-0000-4000-8000-000000000020", email: "disadm.wp8d2@hrpartner.vn", name: "Disabled Admin" };
const INACTIVE_TL = { auth: "18d20000-0000-4000-8000-000000000021", app: "28d20000-0000-4000-8000-000000000021", recruiter: "38d20000-0000-4000-8000-000000000021", email: "inacttl.wp8d2@hrpartner.vn", name: "Inactive Team TL" };
const NO_TEAM_USER = { auth: "18d20000-0000-4000-8000-000000000022", app: "28d20000-0000-4000-8000-000000000022", email: "noteam.wp8d2@hrpartner.vn", name: "No Team Employee" };

const ADMIN_SEED_CAPS = [
  "entry_admin", "entry_team", "entry_own", "entry_create", "submission_create",
  "entry_privileged_edit", "entry_restore", "recruiter_master_manage", "team_master_manage",
  "audit_view", "worker_edit_history_view", "document_upload", "document_view",
  "employment_status.review", "employment_status.apply", "change_request_create",
  "change_review", "employment_status.request", "duplicate_cccd_withdraw",
];
const RECRUITER_SEED_CAPS = [
  "entry_create", "entry_own", "submission_create", "document_upload",
  "document_view", "change_request_create", "employment_status.request",
];

let keySeq = 1;
const nextKey = (prefix) => `wp8d2_${prefix}_${keySeq++}`;
const nextUuid = () => `98d20000-0000-4000-8000-${(keySeq++).toString(16).padStart(12, "0")}`;

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createDb({ stopBefore = null, upToInclusive = null } = {}) {
  const db = new PGlite();
  await db.exec(PROLOGUE);
  const migrations = await loadMigrations();
  let slice = migrations;
  if (stopBefore) {
    const idx = migrations.findIndex((m) => m.name === stopBefore);
    assert.ok(idx >= 0, `migration ${stopBefore} must exist`);
    slice = migrations.slice(0, idx);
  } else if (upToInclusive) {
    const idx = migrations.findIndex((m) => m.name === upToInclusive);
    assert.ok(idx >= 0, `migration ${upToInclusive} must exist`);
    slice = migrations.slice(0, idx + 1);
  }
  for (const m of slice) {
    await db.exec(m.sql);
  }
  return { db, migrations };
}

async function seedBaseUser(db, user, { enabled = true, accountType = "NORMAL", caps = [], scopes = [], teamId = null } = {}) {
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, account_type)
     values ($1::uuid, $2::uuid, $3, $4, $5)`,
    [user.app, user.auth, user.name, enabled, accountType],
  );
  if (user.recruiter) {
    const code = user.email.split("@")[0].replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 16);
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, $3, 'STAFF', true)`,
      [user.recruiter, user.name, code],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2026-01-01', true)`,
      [user.recruiter],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
      [user.app, user.recruiter],
    );
    if (teamId) {
      await db.query(
        `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
         values ($1::uuid, $2::uuid, '2026-01-01', true)`,
        [user.recruiter, teamId],
      );
    }
  }
  for (const cap of caps) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [user.app, cap],
    );
  }
  for (const sc of scopes) {
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, $2, $3::uuid, '2026-01-01', true)`,
      [user.app, sc.kind, sc.teamId ?? null],
    );
  }
}

async function clearLegacyMirrors(db, appUserIds) {
  await db.query(
    `delete from public.work_report_team_leader_capability_grants x
      where exists (
        select 1 from public.direct_entry_capability_grants g
         where g.grant_id = x.capability_grant_id
           and g.app_user_id = any($1::uuid[])
      )`,
    [appUserIds],
  );
  await db.query("select pg_catalog.set_config('direct_entry.team_leader_marker', 'on', false)");
  await db.query("delete from public.direct_entry_capability_grants where app_user_id = any($1::uuid[])", [appUserIds]);
  await db.query("delete from public.direct_entry_scope_grants where app_user_id = any($1::uuid[])", [appUserIds]);
  await db.query("select pg_catalog.set_config('direct_entry.team_leader_marker', '', false)");
}

async function resolveViaRealRpc(db, authSubject) {
  const { rows } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
    [authSubject],
  );
  const rawContext = rows[0]?.ctx ?? null;
  const resolution = await resolveActor({
    session: {
      auth_subject: authSubject,
      provider: "supabase",
      authenticated_at: "2026-11-20T00:00:00.000Z",
    },
    repository: {
      loadByAuthSubject: async () => rawContext,
    },
    at: "2026-11-20T00:00:00.000Z",
  });
  return { rawContext, resolution };
}

async function createPublishedTemplate(db, actor, code, { requiresReview = true } = {}) {
  const schema = RECRUITMENT_DAILY_TEMPLATE_SCHEMA;
  const metrics = buildWorkReportMetricContract(schema);
  const { rows: [{ res: created }] } = await db.query(
    `select public.work_report_create_template(
       $1::uuid, $2::uuid, $3, $3, 'WP8D2 Template', 'DAILY', $4::jsonb, $5::jsonb, $6
     ) as res`,
    [actor.auth, actor.app, code, JSON.stringify(schema), JSON.stringify(metrics), nextKey("tpl")],
  );
  if (requiresReview) {
    await db.query(
      "update public.work_report_template_versions set requires_review = true where version_id = $1::uuid",
      [created.draft_version_id],
    );
  }
  await db.query(
    "select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)",
    [actor.auth, actor.app, created.template_id, created.draft_version_id, created.version, nextKey("pub")],
  );
  return created;
}

test("WP8D-2 [1/5]: Migration #231 hygiene, atomic rollback zero drift, exact 231 migrations (C2 #230 -> D2 #231), exact 337 service_role RPCs, STABLE probe chain & role catalog invariants", async () => {
  const { db, migrations } = await createDb({ stopBefore: WP8D2_MIGRATION_NAME });
  try {
    assert.ok(migrations.length >= 231, "Merged migration chain must contain at least 231 migrations through WP8D-2");
    assert.equal(
      migrations.findIndex((m) => m.name === "20261120160000_wp8c2_entry_worker_access.sql"),
      229,
      "WP8C-2 migration must sit at #230 immediately before WP8D-2",
    );
    assert.equal(
      migrations.findIndex((m) => m.name === WP8D2_MIGRATION_NAME),
      230,
      "WP8D-2 migration must sit at #231 immediately after WP8C-2",
    );
    const wp8d2 = migrations.find((m) => m.name === WP8D2_MIGRATION_NAME);
    assert.ok(wp8d2, "WP8D-2 migration must exist");
    assert.equal(wp8d2.sql.includes("@"), false, "Migration must not contain @ character");
    assert.equal(/savepoint/i.test(wp8d2.sql), false, "Migration must not contain literal SAVEPOINT");
    assert.equal(wp8d2.sql.includes("'40001'"), false, "Migration must use PT409 (never PostgREST-retried 40001) for OCC conflicts");
    const checksum = migrationChecksum(wp8d2.sql);
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(migrationChecksum(wp8d2.sql.replace(/\n/g, "\r\n")), checksum);

    const { rows: [{ cnt: beforeSrCount }] } = await db.query(
      `select count(*)::int as cnt
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    );
    assert.equal(beforeSrCount, 337, "Pre-WP8D-2 baseline (#230 after WP8C-2) must have exact 337 service_role RPCs");

    await db.exec(`
      create table if not exists public.schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      );
    `);

    const failingSql = `${migrationSqlForTransaction(wp8d2.sql)}\nselect 1 / 0;\n`;
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(failingSql);
          await db.query("insert into public.schema_migrations (version, checksum) values ($1, $2)", [wp8d2.name, checksum]);
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      (err) => err.code === "22012",
    );

    const { rows: [{ n: rollbackNewFn }] } = await db.query(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in (
          'work_report__internal_is_full_admin',
          'work_report__internal_direct_team_ids',
          'work_report__internal_has_read_capability',
          'work_report__internal_has_read_scope',
          'work_report__internal_read_team_ids',
          'work_report__internal_assert_read_actor'
        )`,
    );
    assert.equal(rollbackNewFn, 0, "Rolled-back migration leaves zero new helpers");
    const { rows: [{ n: rollbackLedger }] } = await db.query(
      "select count(*)::int as n from public.schema_migrations where version = $1",
      [wp8d2.name],
    );
    assert.equal(rollbackLedger, 0, "Rolled-back migration leaves zero ledger row");

    // Clean apply
    await db.exec(wp8d2.sql);

    const { rows: [{ cnt: afterSrCount }] } = await db.query(
      `select count(*)::int as cnt
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    );
    assert.equal(afterSrCount, 337, "WP8D-2 adds +0 new service_role RPCs (exact 337)");

    // Verify ZERO public work_report* RPCs reference legacy direct_entry_has_scope / direct_entry_scope_grants / direct_entry_capability_grants
    // except explicit pre-cutover (not authz_managed) delegate fallback in work_report_create_delegation
    const { rows: legacyPublicRefs } = await db.query(`
      select p.proname, pg_get_functiondef(p.oid) as def
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname like 'work_report%'
         and has_function_privilege('service_role', p.oid, 'EXECUTE')
         and (
           pg_get_functiondef(p.oid) like '%direct_entry_has_scope%'
           or pg_get_functiondef(p.oid) like '%direct_entry_has_capability%'
           or pg_get_functiondef(p.oid) like '%direct_entry_capability_grants%'
           or (
             pg_get_functiondef(p.oid) like '%direct_entry_scope_grants%'
             and p.proname <> 'work_report_create_delegation'
           )
         )
    `);
    assert.deepEqual(legacyPublicRefs, [], "Zero public work_report RPCs may read legacy capability/scope helpers directly");

    // Verify all 16 touched/new internal helpers are STABLE and revoked from service_role/client/PUBLIC
    const internalSigs = [
      "public.direct_entry_authz__internal_resolve_effective_grants(uuid)",
      "public.work_report__internal_is_full_admin(uuid)",
      "public.work_report__internal_has_direct_capability(uuid,text)",
      "public.work_report__internal_has_direct_scope(uuid,text,text,uuid)",
      "public.work_report__internal_direct_team_ids(uuid,text)",
      "public.work_report_assert_actor(uuid,uuid,text)",
      "public.work_report_assert_scope(uuid,text,uuid,boolean)",
      "public.work_report__internal_has_read_capability(uuid,text)",
      "public.work_report__internal_has_read_scope(uuid,text,text,uuid)",
      "public.work_report__internal_read_team_ids(uuid,text)",
      "public.work_report__internal_assert_read_actor(uuid,uuid,text)",
      "public.work_report__internal_is_delegation_effective(uuid,timestamptz)",
      "public.work_report__internal_resolve_capability_authority(uuid,text,uuid,uuid,timestamptz)",
      "public.work_report__internal_has_any_capability_authority(uuid,text,timestamptz)",
      "public.work_report__internal_actor_can_assign_member(uuid,uuid,uuid)",
      "public.work_report__internal_resolve_analytics_scope(uuid,uuid,boolean,uuid,uuid,uuid)",
    ];
    for (const sig of internalSigs) {
      const { rows: [r] } = await db.query(
        `select p.provolatile, p.prosecdef,
                has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as sr_exec
           from pg_proc p where p.oid = $1::regprocedure`,
        [sig],
      );
      assert.equal(r.provolatile, "s", `${sig} must be STABLE`);
      assert.equal(r.prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.equal(r.pub_exec, false, `${sig} PUBLIC denied`);
      assert.equal(r.anon_exec, false, `${sig} anon denied`);
      assert.equal(r.auth_exec, false, `${sig} authenticated denied`);
      assert.equal(r.sr_exec, false, `${sig} service_role denied`);
    }
  } finally {
    await db.close();
  }
});

test("WP8D-2 [2/5]: Mirror-cleared managed personas keep full SQL -> Actor -> TS parity & block cross-scope HR_OPERATOR+TL escalation", async () => {
  const { db } = await createDb();
  try {
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'WR8D_A', 'Team Alpha', true),
              ($2::uuid, 'WR8D_B', 'Team Beta', true),
              ($3::uuid, 'WR8D_C', 'Team Inactive', true)`,
      [TEAM_A, TEAM_B, TEAM_INACTIVE],
    );

    await seedBaseUser(db, OWNER, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LUANPT, { caps: [], scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LIENVU, { caps: ADMIN_SEED_CAPS.filter((c) => c !== "duplicate_cccd_withdraw"), scopes: [{ kind: "all" }] });
    await seedBaseUser(db, NGATTT, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, TL_A, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, HR_TL_A, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_A1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_A2, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_B1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_B });
    await seedBaseUser(db, VIEW_ANALYTICS_ONLY, {});
    await seedBaseUser(db, VIEW_ONLY, {});
    await seedBaseUser(db, ANALYTICS_ONLY, {});
    await seedBaseUser(db, CROSS_AV, {});
    await seedBaseUser(db, OWN_VIEWER, {});
    await seedBaseUser(db, TEAM_FORM_MGR, {});
    await seedBaseUser(db, SHARED_ACCT, { accountType: "SHARED" });
    await seedBaseUser(db, DISABLED_ADMIN, { enabled: false });
    await seedBaseUser(db, INACTIVE_TL, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_INACTIVE });

    const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
    const cutover = await runWp5Cutover(db, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(cutover.status, "APPLIED");

    // Designate TL_A on TEAM_A, INACTIVE_TL on TEAM_INACTIVE
    await db.query(
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, public.direct_entry_authorization_date(), 1, 'Designate TL A', $5)",
      [OWNER.auth, OWNER.app, TEAM_A, TL_A.app, nextKey("des_tla")],
    );
    await db.query(
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, public.direct_entry_authorization_date(), 1, 'Designate Inactive TL', $5)",
      [OWNER.auth, OWNER.app, TEAM_INACTIVE, INACTIVE_TL.app, nextKey("des_inact")],
    );
    // Deactivate TEAM_INACTIVE directly after designation
    await db.query("update public.teams set active = false where team_id = $1::uuid", [TEAM_INACTIVE]);

    // Assign HR_OPERATOR to HR_TL_A and also give HR_TL_A contextual TEAM_LEADER on TEAM_A (by replacing TL_A? No, test TL_A first, or assign HR_OPERATOR to TL_A later!)
    // Actually give HR_TL_A HR_OPERATOR global role + DIRECT_GRANT report_review/assign/view/analytics_view @ CONTEXT_TEAM(TEAM_A) to simulate dual-role HR_OPERATOR + TL simultaneously with TL_A!
    await db.query(
      `select public.direct_entry_authz_assign_global_role_admin(
         $1::uuid, $2::uuid, $3::uuid, 'HR_OPERATOR', 1, 'Dual role HR_OPERATOR', $4::uuid, $5
       )`,
      [OWNER.auth, OWNER.app, HR_TL_A.app, nextUuid(), "a".repeat(64)],
    );
    for (const cap of ["report_view", "report_analytics_view", "report_assign", "report_review", "team_manager_assign"]) {
      await db.query(
        `insert into public.authz_direct_capability_grants
           (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
         values ($1::uuid, $2, 'CONTEXT_TEAM', $3, 'EXCEPTION_GRANT', 'Dual-role team grants', $4::uuid)`,
        [HR_TL_A.app, cap, TEAM_A, OWNER.app],
      );
    }

    // Seed direct grants for narrow managed personas
    await db.query(
      `insert into public.authz_direct_capability_grants
         (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
       values
         ($1::uuid, 'report_view', 'ALL', null, 'EXCEPTION_GRANT', 'VA view', $7::uuid),
         ($1::uuid, 'report_analytics_view', 'ALL', null, 'EXCEPTION_GRANT', 'VA analytics', $7::uuid),
         ($2::uuid, 'report_view', 'ALL', null, 'EXCEPTION_GRANT', 'View only', $7::uuid),
         ($3::uuid, 'report_analytics_view', 'ALL', null, 'EXCEPTION_GRANT', 'Analytics only', $7::uuid),
         ($4::uuid, 'report_analytics_view', 'ALL', null, 'EXCEPTION_GRANT', 'Cross analytics ALL', $7::uuid),
         ($4::uuid, 'report_view', 'CONTEXT_TEAM', $8, 'EXCEPTION_GRANT', 'Cross view TEAM_A', $7::uuid),
         ($5::uuid, 'report_view', 'OWN', null, 'EXCEPTION_GRANT', 'Invalid OWN view', $7::uuid),
         ($6::uuid, 'report_form_manage', 'CONTEXT_TEAM', $8, 'EXCEPTION_GRANT', 'Invalid team form manage', $7::uuid)`,
      [VIEW_ANALYTICS_ONLY.app, VIEW_ONLY.app, ANALYTICS_ONLY.app, CROSS_AV.app, OWN_VIEWER.app, TEAM_FORM_MGR.app, OWNER.app, TEAM_A],
    );
    await db.query(
      `insert into public.authz_account_role_assignments
         (app_user_id, role_code, source_kind, reason, assigned_by_app_user_id)
       values ($1::uuid, 'ADMIN', 'ADMIN_ASSIGNMENT', 'Disabled admin role', $2::uuid)`,
      [DISABLED_ADMIN.app, OWNER.app],
    );

    // CLEAR ALL LEGACY MIRRORS FOR EVERY MANAGED ACCOUNT!
    const managedAll = [
      OWNER.app, LUANPT.app, LIENVU.app, NGATTT.app, TL_A.app, HR_TL_A.app,
      STAFF_A1.app, STAFF_A2.app, STAFF_B1.app, VIEW_ANALYTICS_ONLY.app, VIEW_ONLY.app,
      ANALYTICS_ONLY.app, CROSS_AV.app, OWN_VIEWER.app, TEAM_FORM_MGR.app,
      SHARED_ACCT.app, DISABLED_ADMIN.app, INACTIVE_TL.app,
    ];
    await clearLegacyMirrors(db, managedAll);

    // 1. Mirror-cleared OWNER (ADMIN 21-cap bundle, 0 explicit report_form_manage/assign/review/delegate)
    const { rawContext: ownerCtx, resolution: ownerRes } = await resolveViaRealRpc(db, OWNER.auth);
    assert.equal(ownerRes.ok, true);
    assert.equal(ownerCtx.capabilities.length, 0, "Legacy capabilities mirror is cleared");
    assert.equal(ownerCtx.effective_grants.length, 21, "ADMIN bundle stays exact 21 grants");
    for (const forbidden of ["report_form_manage", "report_assign", "report_review", "report_delegate"]) {
      assert.equal(
        ownerCtx.effective_grants.some((g) => g.capability === forbidden),
        false,
        `ADMIN effective_grants must NEVER auto-emit ${forbidden}`,
      );
    }
    assert.deepEqual(Object.keys(ownerCtx).sort(), [
      "all_scope_grants", "allowed_worker_tabs", "app_user_id", "assigned_roles", "auth_subject",
      "capabilities", "display_name", "effective_grants", "enabled", "recruiter_links",
      "team_scope_grants", "teams",
    ], "ADMIN without explicit report_review keeps exact 12-key payload");

    assert.equal(workReportTemplateManagePredicate(ownerRes.actor), true);
    assert.equal(workReportAssignmentPredicate(ownerRes.actor), true);
    assert.equal(workReportViewPredicate(ownerRes.actor), true);
    assert.equal(workReportAnalyticsPredicate(ownerRes.actor), true);
    assert.equal(workReportReviewPredicate(ownerRes.actor), true);
    assert.equal(workReportDelegationPredicate(ownerRes.actor), true);
    assert.equal(decideWorkReportTemplatesPageAccess({ actor: ownerRes }), "ALLOW");
    assert.equal(decideWorkReportAssignmentsPageAccess({ actor: ownerRes }), "ALLOW");
    assert.equal(decideWorkReportAnalyticsPageAccess({ actor: ownerRes }), "ALLOW");

    // OWNER creates template, assigns TEAM_A & TEAM_B, staff submits
    const tpl1 = await createPublishedTemplate(db, OWNER, "WP8D2_DAILY_1", { requiresReview: true });
    const { rows: [{ d: today }] } = await db.query("select public.direct_entry_authorization_date()::text as d");
    await db.query(
      `select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null, 'DAILY', true, 0, '23:59:59'::time, false, $5::date, null, $6)`,
      [OWNER.auth, OWNER.app, tpl1.template_id, TEAM_A, today, nextKey("asg_a")],
    );
    await db.query(
      `select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null, 'DAILY', true, 0, '23:59:59'::time, false, $5::date, null, $6)`,
      [OWNER.auth, OWNER.app, tpl1.template_id, TEAM_B, today, nextKey("asg_b")],
    );
    const { rows: obs } = await db.query(
      "select obligation_id, assignee_app_user_id from public.work_report_obligations where template_id = $1::uuid",
      [tpl1.template_id],
    );
    const obA1 = obs.find((o) => o.assignee_app_user_id === STAFF_A1.app).obligation_id;
    const obB1 = obs.find((o) => o.assignee_app_user_id === STAFF_B1.app).obligation_id;
    const { rows: [{ res: subA1 }] } = await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5) as res",
      [STAFF_A1.auth, STAFF_A1.app, obA1, JSON.stringify({ calls_made: 10, interested_candidates: 3, workers_started: 1, notes: null }), nextKey("sub_a1")],
    );
    await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)",
      [STAFF_B1.auth, STAFF_B1.app, obB1, JSON.stringify({ calls_made: 20, interested_candidates: 6, workers_started: 2, notes: null }), nextKey("sub_b1")],
    );

    // 2. Mirror-cleared TEAM_LEADER (TL_A): canonical report_review @ CONTEXT_TEAM(TEAM_A) with 0 legacy mirrors!
    const { rawContext: tlCtx, resolution: tlRes } = await resolveViaRealRpc(db, TL_A.auth);
    assert.equal(tlRes.ok, true);
    assert.equal(tlCtx.capabilities.length, 0, "TL_A legacy capabilities mirror is empty");
    assert.ok(
      tlCtx.effective_grants.some(
        (g) => g.capability === "report_review" && g.scope_kind === "CONTEXT_TEAM" && g.scope_id === TEAM_A && g.source_type === "CONTEXTUAL_ASSIGNMENT",
      ),
      "Managed TL_A derives canonical report_review @ CONTEXT_TEAM from CONTEXTUAL_ASSIGNMENT with zero legacy mirror",
    );
    assert.deepEqual(
      tlCtx.effective_report_review_scopes.map((s) => ({ kind: s.kind, team_id: s.team_id })),
      [{ kind: "team", team_id: TEAM_A }],
    );
    assert.equal(workReportTemplateManagePredicate(tlRes.actor), false);
    assert.equal(workReportDelegationPredicate(tlRes.actor), false);
    assert.equal(workReportAssignmentPredicate(tlRes.actor), true);
    assert.equal(workReportViewPredicate(tlRes.actor), true);
    assert.equal(workReportAnalyticsPredicate(tlRes.actor), true);
    assert.equal(workReportReviewPredicate(tlRes.actor), true);

    // TL_A SQL: allowed TEAM_A, denied TEAM_B, denied templates, denied delegations
    const { rows: [{ res: tlPending }] } = await db.query(
      "select public.work_report_list_pending_reviews($1::uuid, $2::uuid, null, null, 50) as res",
      [TL_A.auth, TL_A.app],
    );
    assert.deepEqual(tlPending.items.map((i) => i.obligation_id), [obA1]);
    const { rows: [{ res: tlReadable }] } = await db.query(
      "select public.work_report_list_readable_submissions($1::uuid, $2::uuid) as res",
      [TL_A.auth, TL_A.app],
    );
    assert.equal(tlReadable.effective_scope.kind, "team");
    assert.deepEqual(tlReadable.items.map((i) => i.obligation_id), [obA1]);
    await assert.rejects(
      db.query("select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid)", [TL_A.auth, TL_A.app, obB1]),
      (e) => e.code === "42501",
      "TL_A cannot read TEAM_B submission",
    );
    await assert.rejects(
      db.query("select public.work_report_get_review_submission($1::uuid, $2::uuid, $3::uuid)", [TL_A.auth, TL_A.app, obB1]),
      (e) => e.code === "42501",
      "TL_A cannot review TEAM_B submission",
    );
    await assert.rejects(
      db.query("select public.work_report_list_templates($1::uuid, $2::uuid)", [TL_A.auth, TL_A.app]),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      db.query("select public.work_report_list_delegations($1::uuid, $2::uuid)", [TL_A.auth, TL_A.app]),
      (e) => e.code === "42501",
    );

    // 3. Dual-role HR_OPERATOR (@ ALL) + TEAM_A report grants (@ CONTEXT_TEAM): ZERO cross-scope escalation to ALL!
    const { rawContext: hrTlCtx, resolution: hrTlRes } = await resolveViaRealRpc(db, HR_TL_A.auth);
    assert.equal(hrTlRes.ok, true);
    assert.deepEqual(
      hrTlCtx.effective_report_review_scopes.map((s) => ({ kind: s.kind, team_id: s.team_id })),
      [{ kind: "team", team_id: TEAM_A }],
      "Dual-role HR_OPERATOR(@ALL)+TL(@TEAM_A) must NEVER escalate effective_report_review_scopes to 'all'",
    );
    const { rows: [{ res: hrTlReadable }] } = await db.query(
      "select public.work_report_list_readable_submissions($1::uuid, $2::uuid) as res",
      [HR_TL_A.auth, HR_TL_A.app],
    );
    assert.equal(hrTlReadable.effective_scope.kind, "team", "HR_OPERATOR+TL readable scope stays 'team', never 'all'");
    assert.deepEqual(hrTlReadable.items.map((i) => i.obligation_id), [obA1]);
    const { rows: [{ res: hrTlOverview }] } = await db.query(
      "select public.work_report_analytics_overview($1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'provisional_included') as res",
      [HR_TL_A.auth, HR_TL_A.app, tpl1.template_id],
    );
    assert.equal(hrTlOverview.effective_scope.kind, "team", "HR_OPERATOR+TL analytics stays 'team', never 'all'");
    await assert.rejects(
      db.query("select public.work_report_analytics_overview($1::uuid, $2::uuid, $3::uuid, null, null, null, $4::uuid, null, 'provisional_included')", [HR_TL_A.auth, HR_TL_A.app, tpl1.template_id, TEAM_B]),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      db.query("select public.work_report_list_assignment_options($1::uuid, $2::uuid, $3::uuid)", [HR_TL_A.auth, HR_TL_A.app, TEAM_B]),
      (e) => e.code === "42501",
    );
    const { rows: [{ res: hrTlGroups }] } = await db.query(
      "select public.work_report_list_groups($1::uuid, $2::uuid) as res",
      [HR_TL_A.auth, HR_TL_A.app],
    );
    assert.equal(hrTlGroups.scope_kind, "team");

    // 4. VIEW_ANALYTICS_ONLY (report_view + report_analytics_view @ ALL, NOT Full Admin):
    //    NEVER gains assign/review/delegate/template!
    const { resolution: vaRes } = await resolveViaRealRpc(db, VIEW_ANALYTICS_ONLY.auth);
    assert.equal(workReportViewPredicate(vaRes.actor), true);
    assert.equal(workReportAnalyticsPredicate(vaRes.actor), true);
    assert.equal(workReportTemplateManagePredicate(vaRes.actor), false);
    assert.equal(workReportAssignmentPredicate(vaRes.actor), false);
    assert.equal(workReportReviewPredicate(vaRes.actor), false);
    assert.equal(workReportDelegationPredicate(vaRes.actor), false);
    assert.equal(decideWorkReportAnalyticsPageAccess({ actor: vaRes }), "ALLOW");
    const { rows: [{ res: vaReadable }] } = await db.query(
      "select public.work_report_list_readable_submissions($1::uuid, $2::uuid) as res",
      [VIEW_ANALYTICS_ONLY.auth, VIEW_ANALYTICS_ONLY.app],
    );
    assert.equal(vaReadable.effective_scope.kind, "all");
    assert.equal(vaReadable.items.length, 2);
    for (const [label, sql, params] of [
      ["templates", "select public.work_report_list_templates($1::uuid, $2::uuid)", [VIEW_ANALYTICS_ONLY.auth, VIEW_ANALYTICS_ONLY.app]],
      ["assignments", "select public.work_report_list_assignments($1::uuid, $2::uuid)", [VIEW_ANALYTICS_ONLY.auth, VIEW_ANALYTICS_ONLY.app]],
      ["pending_reviews", "select public.work_report_list_pending_reviews($1::uuid, $2::uuid)", [VIEW_ANALYTICS_ONLY.auth, VIEW_ANALYTICS_ONLY.app]],
      ["decide_review", "select public.work_report_decide_review($1::uuid, $2::uuid, $3::uuid, 'APPROVED', null, $4, $5)", [VIEW_ANALYTICS_ONLY.auth, VIEW_ANALYTICS_ONLY.app, obA1, subA1.version, nextKey("va_rev")]],
      ["delegations", "select public.work_report_list_delegations($1::uuid, $2::uuid)", [VIEW_ANALYTICS_ONLY.auth, VIEW_ANALYTICS_ONLY.app]],
    ]) {
      await assert.rejects(db.query(sql, params), (e) => e.code === "42501", `VIEW_ANALYTICS_ONLY denied on ${label}`);
    }

    // 5. VIEW_ONLY vs ANALYTICS_ONLY vs CROSS_AV (analytics @ ALL + view @ TEAM_A)
    const { resolution: voRes } = await resolveViaRealRpc(db, VIEW_ONLY.auth);
    assert.equal(workReportViewPredicate(voRes.actor), true);
    assert.equal(workReportAnalyticsPredicate(voRes.actor), false);
    assert.equal(decideWorkReportAnalyticsPageAccess({ actor: voRes }), "ALLOW");
    const { rows: [{ res: voSubs }] } = await db.query(
      "select public.work_report_list_readable_submissions($1::uuid, $2::uuid) as res",
      [VIEW_ONLY.auth, VIEW_ONLY.app],
    );
    assert.equal(voSubs.items.length, 2);
    await assert.rejects(
      db.query("select public.work_report_analytics_overview($1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'provisional_included')", [VIEW_ONLY.auth, VIEW_ONLY.app, tpl1.template_id]),
      (e) => e.code === "42501",
    );

    const { resolution: aoRes } = await resolveViaRealRpc(db, ANALYTICS_ONLY.auth);
    assert.equal(workReportAnalyticsPredicate(aoRes.actor), true);
    assert.equal(workReportViewPredicate(aoRes.actor), false);
    assert.equal(decideWorkReportAnalyticsPageAccess({ actor: aoRes }), "ALLOW");
    const { rows: [{ res: aoOver }] } = await db.query(
      "select public.work_report_analytics_overview($1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'provisional_included') as res",
      [ANALYTICS_ONLY.auth, ANALYTICS_ONLY.app, tpl1.template_id],
    );
    assert.equal(aoOver.effective_scope.kind, "all");
    await assert.rejects(
      db.query("select public.work_report_analytics_contributions($1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'provisional_included')", [ANALYTICS_ONLY.auth, ANALYTICS_ONLY.app, tpl1.template_id]),
      (e) => e.code === "42501",
    );

    // CROSS_AV: analytics_overview -> 'all'; analytics_contributions (requires report_view!) -> intersects to 'team' (TEAM_A only)!
    const { rows: [{ res: cavOver }] } = await db.query(
      "select public.work_report_analytics_overview($1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'provisional_included') as res",
      [CROSS_AV.auth, CROSS_AV.app, tpl1.template_id],
    );
    assert.equal(cavOver.effective_scope.kind, "all");
    const { rows: [{ res: cavContrib }] } = await db.query(
      "select public.work_report_analytics_contributions($1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'provisional_included') as res",
      [CROSS_AV.auth, CROSS_AV.app, tpl1.template_id],
    );
    assert.equal(cavContrib.effective_scope.kind, "team", "Contributions must intersect analytics @ ALL with report_view @ TEAM_A");
    await assert.rejects(
      db.query("select public.work_report_analytics_contributions($1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'provisional_included', null, null, $4::uuid)", [CROSS_AV.auth, CROSS_AV.app, tpl1.template_id, TEAM_B]),
      (e) => e.code === "42501",
      "CROSS_AV cannot drill down TEAM_B contributions",
    );

    // 6. Fail-closed negative personas: OWN_VIEWER, TEAM_FORM_MGR, INACTIVE_TL, SHARED_ACCT, DISABLED_ADMIN
    const { resolution: ownRes } = await resolveViaRealRpc(db, OWN_VIEWER.auth);
    assert.equal(workReportViewPredicate(ownRes.actor), false);
    assert.equal(decideWorkReportAnalyticsPageAccess({ actor: ownRes }), "ACCESS_DENIED");
    await assert.rejects(
      db.query("select public.work_report_list_readable_submissions($1::uuid, $2::uuid)", [OWN_VIEWER.auth, OWN_VIEWER.app]),
      (e) => e.code === "42501" && e.message.includes("WORK_REPORT_SCOPE_DENIED"),
    );

    const { resolution: tfmRes } = await resolveViaRealRpc(db, TEAM_FORM_MGR.auth);
    assert.equal(workReportTemplateManagePredicate(tfmRes.actor), false);
    assert.equal(decideWorkReportTemplatesPageAccess({ actor: tfmRes }), "ACCESS_DENIED");
    await assert.rejects(
      db.query("select public.work_report_list_templates($1::uuid, $2::uuid)", [TEAM_FORM_MGR.auth, TEAM_FORM_MGR.app]),
      (e) => e.code === "42501" && e.message.includes("WORK_REPORT_ALL_SCOPE_REQUIRED"),
    );

    const { resolution: inactTlRes } = await resolveViaRealRpc(db, INACTIVE_TL.auth);
    assert.equal(workReportReviewPredicate(inactTlRes.actor), false, "Inactive team TL loses report_review immediately");
    assert.equal(workReportAssignmentPredicate(inactTlRes.actor), false);
    await assert.rejects(
      db.query("select public.work_report_list_pending_reviews($1::uuid, $2::uuid)", [INACTIVE_TL.auth, INACTIVE_TL.app]),
      (e) => e.code === "42501",
    );

    const { resolution: sharedRes } = await resolveViaRealRpc(db, SHARED_ACCT.auth);
    assert.equal(workReportsNavPredicate(sharedRes.actor), false);
    assert.equal(decideWorkReportsPageAccess({ actor: sharedRes }), "ACCESS_DENIED");
    assert.equal(decideWorkReportsPageAccess({ actor: tlRes }), "ALLOW");
    await assert.rejects(
      db.query("select public.work_report_list_templates($1::uuid, $2::uuid)", [SHARED_ACCT.auth, SHARED_ACCT.app]),
      (e) => e.code === "42501",
    );

    const { resolution: disRes } = await resolveViaRealRpc(db, DISABLED_ADMIN.auth);
    assert.equal(disRes.ok, false);
    assert.equal(decideWorkReportsPageAccess({ actor: disRes }), "ACCOUNT_UNAVAILABLE");
    assert.equal(decideWorkReportTemplatesPageAccess({ actor: disRes }), "ACCOUNT_UNAVAILABLE");
    await assert.rejects(
      db.query("select public.work_report_list_templates($1::uuid, $2::uuid)", [DISABLED_ADMIN.auth, DISABLED_ADMIN.app]),
      (e) => e.code === "42501" && e.message.includes("WORK_REPORT_ACTOR_DENIED"),
    );
  } finally {
    await db.close();
  }
});

test("WP8D-2 [3/5]: Delegation (R3, immediate-only, no self-review, no chaining, disjoint grantor, SHARED blocked), independent role isolation & idempotency before OCC", async () => {
  const { db } = await createDb();
  try {
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'WR8D3_A', 'Team 3A', true),
              ($2::uuid, 'WR8D3_B', 'Team 3B', true)`,
      [TEAM_A, TEAM_B],
    );

    await seedBaseUser(db, OWNER, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LUANPT, { caps: [], scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LIENVU, { caps: ADMIN_SEED_CAPS.filter((c) => c !== "duplicate_cccd_withdraw"), scopes: [{ kind: "all" }] });
    await seedBaseUser(db, NGATTT, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, DELEG_GRANTOR, {});
    await seedBaseUser(db, DISJOINT_DELEG, {});
    await seedBaseUser(db, STAFF_A1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_A2, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_B1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_B });
    await seedBaseUser(db, ADMIN_AND_TL, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_B });
    await seedBaseUser(db, SHARED_ACCT, { accountType: "SHARED" });

    const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
    await runWp5Cutover(db, { mode: "apply", confirmApply: true, expectedFingerprint: plan.manifest_fingerprint });

    // Direct grants for DELEG_GRANTOR & DISJOINT_DELEG; ADMIN + TL on ADMIN_AND_TL
    await db.query(
      `insert into public.authz_direct_capability_grants
         (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
       values
         ($1::uuid, 'report_delegate', 'ALL', null, 'EXCEPTION_GRANT', 'Grantor delegate', $3::uuid),
         ($1::uuid, 'report_review', 'ALL', null, 'EXCEPTION_GRANT', 'Grantor review', $3::uuid),
         ($1::uuid, 'report_assign', 'ALL', null, 'EXCEPTION_GRANT', 'Grantor assign', $3::uuid),
         ($2::uuid, 'report_delegate', 'CONTEXT_TEAM', $4, 'EXCEPTION_GRANT', 'Disjoint delegate A', $3::uuid),
         ($2::uuid, 'report_review', 'CONTEXT_TEAM', $5, 'EXCEPTION_GRANT', 'Disjoint review B', $3::uuid)`,
      [DELEG_GRANTOR.app, DISJOINT_DELEG.app, OWNER.app, TEAM_A, TEAM_B],
    );
    await db.query(
      "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'ADMIN', 1, 'Assign ADMIN to ADMIN_AND_TL', $4::uuid, $5)",
      [OWNER.auth, OWNER.app, ADMIN_AND_TL.app, nextUuid(), "b".repeat(64)],
    );
    await db.query(
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, public.direct_entry_authorization_date(), 1, 'Designate ADMIN_AND_TL on TEAM_B', $5)",
      [OWNER.auth, OWNER.app, TEAM_B, ADMIN_AND_TL.app, nextKey("des_admtl")],
    );

    // Clear ALL legacy mirrors on all managed users
    await clearLegacyMirrors(db, [
      OWNER.app, DELEG_GRANTOR.app, DISJOINT_DELEG.app, STAFF_A1.app, STAFF_A2.app,
      STAFF_B1.app, ADMIN_AND_TL.app, SHARED_ACCT.app,
    ]);

    const t1 = await createPublishedTemplate(db, OWNER, "WP8D3_T1", { requiresReview: true });
    const t2 = await createPublishedTemplate(db, OWNER, "WP8D3_T2", { requiresReview: true });
    const { rows: [{ d: today }] } = await db.query("select public.direct_entry_authorization_date()::text as d");

    for (const tpl of [t1, t2]) {
      await db.query(
        "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null, 'DAILY', true, 0, '23:59:59'::time, false, $5::date, null, $6)",
        [OWNER.auth, OWNER.app, tpl.template_id, TEAM_A, today, nextKey("asg")],
      );
    }
    await db.query(
      "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null, 'DAILY', true, 0, '23:59:59'::time, false, $5::date, null, $6)",
      [OWNER.auth, OWNER.app, t1.template_id, TEAM_B, today, nextKey("asgb")],
    );

    const { rows: obs } = await db.query("select obligation_id, template_id, assignee_app_user_id from public.work_report_obligations");
    const findOb = (tplId, uid) => obs.find((o) => o.template_id === tplId && o.assignee_app_user_id === uid).obligation_id;
    const obA1T1 = findOb(t1.template_id, STAFF_A1.app);
    const obA2T1 = findOb(t1.template_id, STAFF_A2.app);
    const obA1T2 = findOb(t2.template_id, STAFF_A1.app);
    const obB1T1 = findOb(t1.template_id, STAFF_B1.app);

    const payload = JSON.stringify({ calls_made: 5, interested_candidates: 2, workers_started: 1, notes: null });
    const { rows: [{ res: subA1T1 }] } = await db.query("select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5) as res", [STAFF_A1.auth, STAFF_A1.app, obA1T1, payload, nextKey("s1")]);
    const { rows: [{ res: subA2T1 }] } = await db.query("select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5) as res", [STAFF_A2.auth, STAFF_A2.app, obA2T1, payload, nextKey("s2")]);
    await db.query("select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)", [STAFF_A1.auth, STAFF_A1.app, obA1T2, payload, nextKey("s3")]);
    await db.query("select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)", [STAFF_B1.auth, STAFF_B1.app, obB1T1, payload, nextKey("s4")]);

    // Disjoint team delegator: report_delegate @ TEAM_A + report_review @ TEAM_B -> options.capabilities=[] & creation denied
    const { rows: [{ res: disjList }] } = await db.query(
      "select public.work_report_list_delegations($1::uuid, $2::uuid) as res",
      [DISJOINT_DELEG.auth, DISJOINT_DELEG.app],
    );
    assert.deepEqual(disjList.options.capabilities, [], "Disjoint delegate@TEAM_A + review@TEAM_B must offer 0 delegatable capabilities");
    await assert.rejects(
      db.query("select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid, null, null, $6)", [DISJOINT_DELEG.auth, DISJOINT_DELEG.app, STAFF_A2.app, t1.template_id, TEAM_A, nextKey("disj_a")]),
      (e) => e.code === "42501",
    );

    // Immediate-only rule (reject scheduled dates) + SHARED account blocked from delegation options & creation
    const { rows: [{ res: grantorOpts }] } = await db.query(
      "select public.work_report_list_delegations($1::uuid, $2::uuid) as res",
      [DELEG_GRANTOR.auth, DELEG_GRANTOR.app],
    );
    assert.equal(grantorOpts.options.delegates.some((d) => d.app_user_id === SHARED_ACCT.app), false, "SHARED account excluded from delegate options");
    await assert.rejects(
      db.query("select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'all', null, null, null, $5)", [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, SHARED_ACCT.app, t1.template_id, nextKey("shared_del")]),
      (e) => e.code === "42501" && e.message.includes("WORK_REPORT_DELEGATE_NOT_AVAILABLE"),
    );
    await assert.rejects(
      db.query("select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid, now(), now() + interval '1 day', $6)", [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, STAFF_A2.app, t1.template_id, TEAM_A, nextKey("sched_del")]),
      (e) => e.code === "22023",
    );

    // Valid immediate open-ended delegations (review + assign) on T1 for TEAM_A -> STAFF_A2
    const { rows: [{ res: delRev }] } = await db.query(
      "select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid, null, null, $6) as res",
      [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, STAFF_A2.app, t1.template_id, TEAM_A, nextKey("del_rev")],
    );
    assert.equal(delRev.effective_to, null);
    await db.query(
      "select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_assign', $3::uuid, $4::uuid, 'team', $5::uuid, null, null, $6)",
      [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, STAFF_A2.app, t1.template_id, TEAM_A, nextKey("del_asg")],
    );

    // R3 check on STAFF_A2: 0 blanket report_review/assign in effective_grants, projected review scope present!
    const { rawContext: a2Ctx, resolution: a2Res } = await resolveViaRealRpc(db, STAFF_A2.auth);
    assert.equal(a2Ctx.effective_grants.some((g) => g.capability === "report_review" || g.capability === "report_assign"), false);
    assert.deepEqual(a2Ctx.effective_report_review_scopes.map((s) => ({ kind: s.kind, team_id: s.team_id })), [{ kind: "team", team_id: TEAM_A }]);
    assert.equal(workReportReviewPredicate(a2Res.actor), true);
    assert.equal(workReportDelegationPredicate(a2Res.actor), false);

    // No self-review, no wrong template, no wrong team, no chaining
    await assert.rejects(
      db.query("select public.work_report_decide_review($1::uuid, $2::uuid, $3::uuid, 'APPROVED', null, $4, $5)", [STAFF_A2.auth, STAFF_A2.app, obA2T1, subA2T1.version, nextKey("self_rev")]),
      (e) => e.code === "42501" && e.message.includes("WORK_REPORT_SELF_REVIEW_FORBIDDEN"),
    );
    await assert.rejects(
      db.query("select public.work_report_get_review_submission($1::uuid, $2::uuid, $3::uuid)", [STAFF_A2.auth, STAFF_A2.app, obA1T2]),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      db.query("select public.work_report_get_review_submission($1::uuid, $2::uuid, $3::uuid)", [STAFF_A2.auth, STAFF_A2.app, obB1T1]),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      db.query("select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid, null, null, $6)", [STAFF_A2.auth, STAFF_A2.app, STAFF_A1.app, t1.template_id, TEAM_A, nextKey("chain")]),
      (e) => e.code === "42501",
    );

    // Delegated review decision + idempotency replay AFTER version bump (idempotency before OCC!)
    const revKey = nextKey("del_decide");
    const { rows: [{ res: decided1 }] } = await db.query(
      "select public.work_report_decide_review($1::uuid, $2::uuid, $3::uuid, 'APPROVED', null, $4, $5) as res",
      [STAFF_A2.auth, STAFF_A2.app, obA1T1, subA1T1.version, revKey],
    );
    assert.equal(decided1.state, "APPROVED");
    const { rows: [{ res: decidedReplay }] } = await db.query(
      "select public.work_report_decide_review($1::uuid, $2::uuid, $3::uuid, 'APPROVED', null, $4, $5) as res",
      [STAFF_A2.auth, STAFF_A2.app, obA1T1, subA1T1.version, revKey],
    );
    assert.deepEqual(decidedReplay, decided1, "decide_review replays idempotency before OCC");

    // Group update & set_group_active: idempotency BEFORE OCC!
    const { rows: [{ res: grpCreated }] } = await db.query(
      "select public.work_report_create_group($1::uuid, $2::uuid, 'Nhóm A', 'Mô tả', $3::uuid[], $4) as res",
      [STAFF_A2.auth, STAFF_A2.app, [STAFF_A1.app], nextKey("grp_create")],
    );
    const grpUpdKey = nextKey("grp_upd");
    const { rows: [{ res: grpUpd1 }] } = await db.query(
      "select public.work_report_update_group($1::uuid, $2::uuid, $3::uuid, 1, 'Nhóm A v2', null, $4::uuid[], $5) as res",
      [STAFF_A2.auth, STAFF_A2.app, grpCreated.group_id, [STAFF_A1.app, STAFF_A2.app], grpUpdKey],
    );
    assert.equal(grpUpd1.version, 2);
    const { rows: [{ res: grpUpdReplay }] } = await db.query(
      "select public.work_report_update_group($1::uuid, $2::uuid, $3::uuid, 1, 'Nhóm A v2', null, $4::uuid[], $5) as res",
      [STAFF_A2.auth, STAFF_A2.app, grpCreated.group_id, [STAFF_A1.app, STAFF_A2.app], grpUpdKey],
    );
    assert.deepEqual(grpUpdReplay, grpUpd1, "update_group replays idempotency BEFORE OCC check");

    const grpActKey = nextKey("grp_act");
    const { rows: [{ res: grpAct1 }] } = await db.query(
      "select public.work_report_set_group_active($1::uuid, $2::uuid, $3::uuid, 2, false, $4) as res",
      [STAFF_A2.auth, STAFF_A2.app, grpCreated.group_id, grpActKey],
    );
    assert.equal(grpAct1.version, 3);
    const { rows: [{ res: grpActReplay }] } = await db.query(
      "select public.work_report_set_group_active($1::uuid, $2::uuid, $3::uuid, 2, false, $4) as res",
      [STAFF_A2.auth, STAFF_A2.app, grpCreated.group_id, grpActKey],
    );
    assert.deepEqual(grpActReplay, grpAct1, "set_group_active replays idempotency BEFORE OCC check");

    // Genuine stale OCC MUST raise PT409 (never 40001) on set_group_active, revoke_delegation, set_assignment_state & change_obligation_status
    await assert.rejects(
      db.query(
        "select public.work_report_set_group_active($1::uuid, $2::uuid, $3::uuid, 2, true, $4)",
        [STAFF_A2.auth, STAFF_A2.app, grpCreated.group_id, nextKey("grp_act_stale")],
      ),
      (e) => e.code === "PT409",
      "Stale set_group_active must raise PT409",
    );
    await assert.rejects(
      db.query(
        "select public.work_report_revoke_delegation($1::uuid, $2::uuid, $3::uuid, 99, $4)",
        [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, delRev.delegation_id, nextKey("rev_del_stale")],
      ),
      (e) => e.code === "PT409",
      "Stale revoke_delegation must raise PT409",
    );
    const { rows: [{ res: t1Asg }] } = await db.query(
      "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'USER', $4::uuid, null, null, 'DAILY', true, 0, '23:59:59'::time, false, $5::date, null, $6) as res",
      [STAFF_A2.auth, STAFF_A2.app, t1.template_id, STAFF_A1.app, today, nextKey("del_asg_state")],
    );
    const asgStateKey = nextKey("asg_pause");
    const { rows: [{ res: asgPaused1 }] } = await db.query(
      "select public.work_report_set_assignment_state($1::uuid, $2::uuid, $3::uuid, 1, 'PAUSED', $4) as res",
      [STAFF_A2.auth, STAFF_A2.app, t1Asg.assignment_id, asgStateKey],
    );
    assert.equal(asgPaused1.version, 2);
    const { rows: [{ res: asgPausedReplay }] } = await db.query(
      "select public.work_report_set_assignment_state($1::uuid, $2::uuid, $3::uuid, 1, 'PAUSED', $4) as res",
      [STAFF_A2.auth, STAFF_A2.app, t1Asg.assignment_id, asgStateKey],
    );
    assert.deepEqual(asgPausedReplay, asgPaused1, "set_assignment_state replays idempotency BEFORE OCC");
    await assert.rejects(
      db.query(
        "select public.work_report_set_assignment_state($1::uuid, $2::uuid, $3::uuid, 1, 'ACTIVE', $4)",
        [STAFF_A2.auth, STAFF_A2.app, t1Asg.assignment_id, nextKey("asg_stale")],
      ),
      (e) => e.code === "PT409",
      "Stale set_assignment_state must raise PT409",
    );
    const { rows: [{ version: obA2T1Ver }] } = await db.query(
      "select version from public.work_report_obligations where obligation_id = $1::uuid",
      [obA2T1],
    );
    const obExKey = nextKey("ob_exempt");
    const { rows: [{ res: obEx1 }] } = await db.query(
      "select public.work_report_change_obligation_status($1::uuid, $2::uuid, $3::uuid, $4, 'EXEMPT', 'Miễn báo cáo kiểm thử', null, $5) as res",
      [STAFF_A2.auth, STAFF_A2.app, obA2T1, obA2T1Ver, obExKey],
    );
    assert.equal(obEx1.status, "EXEMPTED");
    const { rows: [{ res: obExReplay }] } = await db.query(
      "select public.work_report_change_obligation_status($1::uuid, $2::uuid, $3::uuid, $4, 'EXEMPT', 'Miễn báo cáo kiểm thử', null, $5) as res",
      [STAFF_A2.auth, STAFF_A2.app, obA2T1, obA2T1Ver, obExKey],
    );
    assert.deepEqual(obExReplay, obEx1, "change_obligation_status replays idempotency BEFORE OCC");
    await assert.rejects(
      db.query(
        "select public.work_report_change_obligation_status($1::uuid, $2::uuid, $3::uuid, $4, 'EXEMPT', 'Stale', null, $5)",
        [STAFF_A2.auth, STAFF_A2.app, obA2T1, obA2T1Ver, nextKey("ob_stale")],
      ),
      (e) => e.code === "PT409",
      "Stale change_obligation_status must raise PT409",
    );

    // Disable grantor -> immediately kills delegation (review scope vanishes, pending reviews denied)
    await db.query(
      "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, 1, 'Disable grantor', $4)",
      [OWNER.auth, OWNER.app, DELEG_GRANTOR.app, nextKey("dis_gr")],
    );
    const { rawContext: a2AfterDis } = await resolveViaRealRpc(db, STAFF_A2.auth);
    assert.equal(a2AfterDis.effective_report_review_scopes, undefined, "Grantor disable immediately removes delegated review scopes");
    await assert.rejects(
      db.query("select public.work_report_list_pending_reviews($1::uuid, $2::uuid)", [STAFF_A2.auth, STAFF_A2.app]),
      (e) => e.code === "42501",
    );

    // Independent grant isolation on ADMIN_AND_TL: revoke ADMIN -> retains TEAM_LEADER on TEAM_B (loses TEAM_A & templates)!
    const { rows: [{ assignment_id: admAsgId }] } = await db.query(
      "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and ended_at is null",
      [ADMIN_AND_TL.app],
    );
    const { rows: [{ version: admTlVer }] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [ADMIN_AND_TL.app],
    );
    await db.query(
      "select public.direct_entry_authz_revoke_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'Revoke ADMIN keep TL', $6::uuid, $7)",
      [OWNER.auth, OWNER.app, ADMIN_AND_TL.app, admAsgId, admTlVer, nextUuid(), "c".repeat(64)],
    );
    await clearLegacyMirrors(db, [ADMIN_AND_TL.app]);
    // Still reviews TEAM_B via contextual TL, denied templates and TEAM_A!
    const { rows: [{ res: bPending }] } = await db.query(
      "select public.work_report_list_pending_reviews($1::uuid, $2::uuid) as res",
      [ADMIN_AND_TL.auth, ADMIN_AND_TL.app],
    );
    assert.deepEqual(bPending.items.map((i) => i.obligation_id), [obB1T1]);
    await assert.rejects(
      db.query("select public.work_report_list_templates($1::uuid, $2::uuid)", [ADMIN_AND_TL.auth, ADMIN_AND_TL.app]),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      db.query("select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid)", [ADMIN_AND_TL.auth, ADMIN_AND_TL.app, obA1T1]),
      (e) => e.code === "42501",
    );
  } finally {
    await db.close();
  }
});

test("WP8D-2 [4/5]: Probe #18 20-case anti-drift oracle (against BOTH #230 and baseline #229 materializers) + strict READ ONLY 0-write guarantee", async () => {
  const { db: db230 } = await createDb();
  const { db: db229 } = await createDb({ upToInclusive: WP8C1_MIGRATION_NAME });

  async function runOracle(db, { managedMirrorCleared }) {
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'ORC_A', 'Oracle Team A', true),
              ($2::uuid, 'ORC_B', 'Oracle Team B', true)`,
      [TEAM_A, TEAM_B],
    );
    await seedBaseUser(db, OWNER, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LUANPT, { caps: [], scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LIENVU, { caps: ADMIN_SEED_CAPS.filter((c) => c !== "duplicate_cccd_withdraw"), scopes: [{ kind: "all" }] });
    await seedBaseUser(db, NGATTT, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, TL_A, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_A1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_A2, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_B1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_B });
    await seedBaseUser(db, NO_TEAM_USER, {});

    if (managedMirrorCleared) {
      const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
      await runWp5Cutover(db, { mode: "apply", confirmApply: true, expectedFingerprint: plan.manifest_fingerprint });
    }

    await db.query(
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, public.direct_entry_authorization_date(), 1, 'Oracle TL', $5)",
      [OWNER.auth, OWNER.app, TEAM_A, TL_A.app, nextKey("orc_tl")],
    );

    if (managedMirrorCleared) {
      await clearLegacyMirrors(db, [OWNER.app, TL_A.app, STAFF_A1.app, STAFF_A2.app, STAFF_B1.app, NO_TEAM_USER.app]);
    }

    const tUser = await createPublishedTemplate(db, OWNER, "ORC_USER", { requiresReview: false });
    const tUserSet = await createPublishedTemplate(db, OWNER, "ORC_USET", { requiresReview: false });
    const tTeam = await createPublishedTemplate(db, OWNER, "ORC_TEAM", { requiresReview: false });
    const tGroup = await createPublishedTemplate(db, OWNER, "ORC_GRP", { requiresReview: false });
    const tOnce = await createPublishedTemplate(db, OWNER, "ORC_ONCE", { requiresReview: false });

    const { rows: [{ d: today }] } = await db.query("select (now() at time zone 'Asia/Ho_Chi_Minh')::date as d");
    const todayIso = typeof today === "string" ? today.slice(0, 10) : today.toISOString().slice(0, 10);

    // Helper: compare READ ONLY probe vs actual materialization (inside rollback so cases stay independent)
    const checkCase = async (label, targetUser, { expectedBool, setupSql = null, setupParams = [] } = {}) => {
      if (setupSql) {
        await db.query(setupSql, setupParams);
      }
      const { rows: [{ cnt: beforeObCnt }] } = await db.query("select count(*)::int as cnt from public.work_report_obligations");

      // 1. Strict READ ONLY probe
      await db.exec("begin transaction read only;");
      let probeVal;
      try {
        const { rows: [{ res }] } = await db.query(
          "select public.work_report_has_active_obligations($1::uuid, $2::uuid) as res",
          [targetUser.auth, targetUser.app],
        );
        probeVal = res.has_active_obligations;
        await db.exec("commit;");
      } catch (err) {
        await db.exec("rollback;");
        throw err;
      }

      const { rows: [{ cnt: afterProbeCnt }] } = await db.query("select count(*)::int as cnt from public.work_report_obligations");
      assert.equal(afterProbeCnt, beforeObCnt, `${label}: probe must write 0 rows`);
      assert.equal(probeVal, expectedBool, `${label}: probe expected ${expectedBool}`);

      // 2. Compare against real business list_my_obligations materializer (rollback after check to isolate)
      await db.exec("begin;");
      let matHasActive;
      try {
        const { rows: [{ res: listRes }] } = await db.query(
          "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as res",
          [targetUser.auth, targetUser.app],
        );
        matHasActive = Array.isArray(listRes.items) && listRes.items.length > 0;
      } finally {
        await db.exec("rollback;");
      }
      assert.equal(probeVal, matHasActive, `${label}: probe (${probeVal}) MUST equal materializer (${matHasActive})`);
      return probeVal;
    };

    const results = {};
    // Case 1: Empty user (0 assignments)
    results.c01_empty = await checkCase("C01 empty", STAFF_A1, { expectedBool: false });

    // Case 2: USER assignment (future effective_from -> false)
    await db.query(
      `insert into public.work_report_assignments
         (template_id, template_version_id, target_kind, target_user_id, frequency, is_mandatory, due_day_offset, due_time_local, exclude_sundays, effective_from, assigned_by_user_id, state, is_current)
       values ($1::uuid, $2::uuid, 'USER', $3::uuid, 'DAILY', true, 0, '23:59:59', false, ($4::date + 2), $5::uuid, 'ACTIVE', true)`,
      [tUser.template_id, tUser.draft_version_id, STAFF_A1.app, todayIso, OWNER.app],
    );
    results.c02_user_future = await checkCase("C02 USER future", STAFF_A1, { expectedBool: false });

    // Case 3: USER assignment effective today (unmaterialized yet -> true)
    await db.query("update public.work_report_assignments set effective_from = $1::date where template_id = $2::uuid", [todayIso, tUser.template_id]);
    results.c03_user_active = await checkCase("C03 USER active unmaterialized", STAFF_A1, { expectedBool: true });

    // Case 4: USER assignment paused -> false
    await db.query("update public.work_report_assignments set state = 'PAUSED' where template_id = $1::uuid", [tUser.template_id]);
    results.c04_user_paused = await checkCase("C04 USER paused", STAFF_A1, { expectedBool: false });

    // Case 5: USER_SET assignment active -> true for STAFF_A2, false for STAFF_B1
    const { rows: [{ assignment_id: usetAsg }] } = await db.query(
      `insert into public.work_report_assignments
         (template_id, template_version_id, target_kind, frequency, is_mandatory, due_day_offset, due_time_local, exclude_sundays, effective_from, assigned_by_user_id, state, is_current)
       values ($1::uuid, $2::uuid, 'USER_SET', 'DAILY', true, 0, '23:59:59', false, $3::date, $4::uuid, 'ACTIVE', true)
       returning assignment_id`,
      [tUserSet.template_id, tUserSet.draft_version_id, todayIso, OWNER.app],
    );
    await db.query("insert into public.work_report_assignment_targets (assignment_id, target_user_id) values ($1::uuid, $2::uuid)", [usetAsg, STAFF_A2.app]);
    results.c05_userset_hit = await checkCase("C05 USER_SET member", STAFF_A2, { expectedBool: true });
    results.c06_userset_miss = await checkCase("C06 USER_SET non-member", STAFF_B1, { expectedBool: false });
    await db.query("update public.work_report_assignments set state = 'REVOKED', is_current = false where assignment_id = $1::uuid", [usetAsg]);

    // Case 7: TEAM assignment active -> true for STAFF_B1, false for NO_TEAM_USER
    const { rows: [{ assignment_id: teamAsg }] } = await db.query(
      `insert into public.work_report_assignments
         (template_id, template_version_id, target_kind, target_team_id, frequency, is_mandatory, due_day_offset, due_time_local, exclude_sundays, effective_from, assigned_by_user_id, state, is_current)
       values ($1::uuid, $2::uuid, 'TEAM', $3::uuid, 'DAILY', true, 0, '23:59:59', false, $4::date, $5::uuid, 'ACTIVE', true)
       returning assignment_id`,
      [tTeam.template_id, tTeam.draft_version_id, TEAM_B, todayIso, OWNER.app],
    );
    results.c07_team_hit = await checkCase("C07 TEAM member", STAFF_B1, { expectedBool: true });
    results.c08_team_miss = await checkCase("C08 TEAM non-member", NO_TEAM_USER, { expectedBool: false });
    await db.query("update public.work_report_assignments set state = 'REVOKED', is_current = false where assignment_id = $1::uuid", [teamAsg]);

    // Case 9-12: GROUP assignment assigned by TL_A (mirror-cleared on #230!):
    // - All members in TEAM_A -> true
    // - Add out-of-scope STAFF_B1 into group -> all-or-nothing fails -> false for STAFF_A1!
    // - Remove STAFF_B1, deactivate group -> false
    // - Reactivate group, check eligible vs ineligible
    const { rows: [{ res: grp }] } = await db.query(
      "select public.work_report_create_group($1::uuid, $2::uuid, 'TL A Group', null, $3::uuid[], $4) as res",
      [TL_A.auth, TL_A.app, [STAFF_A1.app, STAFF_A2.app], nextKey("orc_grp")],
    );
    const { rows: [{ assignment_id: grpAsg }] } = await db.query(
      `insert into public.work_report_assignments
         (template_id, template_version_id, target_kind, target_group_id, frequency, is_mandatory, due_day_offset, due_time_local, exclude_sundays, effective_from, assigned_by_user_id, state, is_current)
       values ($1::uuid, $2::uuid, 'GROUP', $3::uuid, 'DAILY', true, 0, '23:59:59', false, $4::date, $5::uuid, 'ACTIVE', true)
       returning assignment_id`,
      [tGroup.template_id, tGroup.draft_version_id, grp.group_id, todayIso, TL_A.app],
    );
    results.c09_group_tl_ok = await checkCase("C09 GROUP assigned by TL_A", STAFF_A1, { expectedBool: true });
    // Inject out-of-scope member -> all-or-nothing fails for TL_A assignor!
    await db.query("insert into public.work_report_group_members (group_id, member_user_id, added_by_user_id) values ($1::uuid, $2::uuid, $3::uuid)", [grp.group_id, STAFF_B1.app, OWNER.app]);
    results.c10_group_all_or_nothing = await checkCase("C10 GROUP all-or-nothing out-of-scope", STAFF_A1, { expectedBool: false });
    await db.query("delete from public.work_report_group_members where group_id = $1::uuid and member_user_id = $2::uuid", [grp.group_id, STAFF_B1.app]);
    // Group inactive -> false
    await db.query("update public.work_report_groups set active = false where group_id = $1::uuid", [grp.group_id]);
    results.c11_group_inactive = await checkCase("C11 GROUP inactive", STAFF_A1, { expectedBool: false });
    await db.query("update public.work_report_groups set active = true where group_id = $1::uuid", [grp.group_id]);
    // Template archived -> false
    await db.query("update public.work_report_templates set status = 'ARCHIVED' where template_id = $1::uuid", [tGroup.template_id]);
    results.c12_template_inactive = await checkCase("C12 template archived", STAFF_A1, { expectedBool: false });
    await db.query("update public.work_report_assignments set state = 'REVOKED', is_current = false where assignment_id = $1::uuid", [grpAsg]);

    // Case 13-17: ONCE collision, CANCELLED unsubmitted reactivation, CANCELLED submitted non-reactivation, EXEMPTED, existing ACTIVE submitted
    const { rows: [{ assignment_id: onceAsg }] } = await db.query(
      `insert into public.work_report_assignments
         (template_id, template_version_id, target_kind, target_user_id, frequency, is_mandatory, due_day_offset, due_time_local, exclude_sundays, effective_from, assigned_by_user_id, state, is_current)
       values ($1::uuid, $2::uuid, 'USER', $3::uuid, 'ONCE', true, 0, '23:59:59', false, $4::date, $5::uuid, 'ACTIVE', true)
       returning assignment_id`,
      [tOnce.template_id, tOnce.draft_version_id, STAFF_A1.app, todayIso, OWNER.app],
    );
    results.c13_once_fresh = await checkCase("C13 ONCE fresh", STAFF_A1, { expectedBool: true });

    // Materialize ONCE obligation for real via business RPC
    const { rows: [{ res: realMat }] } = await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as res",
      [STAFF_A1.auth, STAFF_A1.app],
    );
    assert.equal(realMat.items.length, 1, "Business list_my_obligations materializes ONCE obligation");
    const onceObId = realMat.items[0].obligation_id;
    results.c14_existing_active = await checkCase("C14 existing ACTIVE", STAFF_A1, { expectedBool: true });

    // Exempt ONCE obligation -> probe = false (never reactivates EXEMPTED)
    await db.query("update public.work_report_obligations set obligation_status = 'EXEMPTED' where obligation_id = $1::uuid", [onceObId]);
    results.c15_exempted = await checkCase("C15 EXEMPTED non-reactivated", STAFF_A1, { expectedBool: false });

    // Cancel ONCE obligation -> ONCE already has row for assignment_id -> probe = false (ONCE collision!)
    await db.query("update public.work_report_obligations set obligation_status = 'CANCELLED' where obligation_id = $1::uuid", [onceObId]);
    results.c16_once_collision = await checkCase("C16 ONCE collision on cancelled", STAFF_A1, { expectedBool: false });

    // Switch to DAILY active assignment on same template & today -> materialize DAILY obligation -> cancel unsubmitted -> reactivates (true)!
    await db.query("update public.work_report_assignments set state = 'REVOKED', is_current = false where assignment_id = $1::uuid", [onceAsg]);
    await db.query("delete from public.work_report_obligations where obligation_id = $1::uuid", [onceObId]);
    await db.query(
      `insert into public.work_report_assignments
         (template_id, template_version_id, target_kind, target_user_id, frequency, is_mandatory, due_day_offset, due_time_local, exclude_sundays, effective_from, assigned_by_user_id, state, is_current)
       values ($1::uuid, $2::uuid, 'USER', $3::uuid, 'DAILY', true, 0, '23:59:59', false, $4::date, $5::uuid, 'ACTIVE', true)`,
      [tOnce.template_id, tOnce.draft_version_id, STAFF_A1.app, todayIso, OWNER.app],
    );
    const { rows: [{ res: dailyMat }] } = await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as res",
      [STAFF_A1.auth, STAFF_A1.app],
    );
    assert.equal(dailyMat.items.length, 1, "Business list_my_obligations materializes DAILY obligation");
    const dailyObId = dailyMat.items[0].obligation_id;
    await db.query("update public.work_report_obligations set obligation_status = 'CANCELLED' where obligation_id = $1::uuid", [dailyObId]);
    results.c17_cancelled_unsubmitted = await checkCase("C17 CANCELLED unsubmitted reactivates", STAFF_A1, { expectedBool: true });

    // Mark that cancelled DAILY obligation as submitted (first_submitted_at IS NOT NULL) -> NEVER reactivates -> false!
    await db.query(
      `insert into public.work_report_submissions
         (obligation_id, template_id, template_version_id, assignee_app_user_id, state, first_submitted_at, latest_submitted_at, submitted_by_user_id)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'COMPLETED', now(), now(), $4::uuid)`,
      [dailyObId, tOnce.template_id, tOnce.draft_version_id, STAFF_A1.app],
    );
    results.c18_cancelled_submitted = await checkCase("C18 CANCELLED submitted never reactivates", STAFF_A1, { expectedBool: false });

    // Case 19-20: Vietnam +07:00 window lookback boundary (effective_to = today - 8 days -> outside 7-day lookback -> false; today - 6 days -> inside -> true)
    await db.query("delete from public.work_report_submissions where obligation_id = $1::uuid", [dailyObId]);
    await db.query("delete from public.work_report_obligations where obligation_id = $1::uuid", [dailyObId]);
    await db.query("update public.work_report_assignments set effective_from = ($1::date - 10), effective_to = ($1::date - 8) where template_id = $2::uuid and state = 'ACTIVE'", [todayIso, tOnce.template_id]);
    results.c19_lookback_outside = await checkCase("C19 outside 7d window", STAFF_A1, { expectedBool: false });
    await db.query("update public.work_report_assignments set effective_to = ($1::date - 6) where template_id = $2::uuid and state = 'ACTIVE'", [todayIso, tOnce.template_id]);
    results.c20_lookback_inside = await checkCase("C20 inside 7d VN boundary", STAFF_A1, { expectedBool: true });

    // Negative actor check: mismatched auth_subject denied 42501
    await assert.rejects(
      db.query("select public.work_report_has_active_obligations($1::uuid, $2::uuid)", [STAFF_B1.auth, STAFF_A1.app]),
      (e) => e.code === "42501",
    );

    return results;
  }

  try {
    const res230 = await runOracle(db230, { managedMirrorCleared: true });
    const res229 = await runOracle(db229, { managedMirrorCleared: false });
    assert.deepEqual(res230, res229, "All 20 probe cases on mirror-cleared #230 must match baseline #229 oracle identically");
  } finally {
    await db230.close();
    await db229.close();
  }
});

test("WP8D-2 [5/5]: Pre-cutover (authz_managed=false) R1 compatibility parity preserved (legacy tombstone, tl_wr_compat_bridge, team report_delegate bridge)", async () => {
  const { db } = await createDb();
  try {
    await db.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'PRE_A', 'Pre Team A', true)",
      [TEAM_A],
    );
    await seedBaseUser(db, OWNER, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, TL_A, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_A1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, VIEW_ONLY, { caps: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: [{ kind: "all" }] });
    // Explicit legacy tombstone for report_view on pre-cutover Full Admin
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current)
       values ($1::uuid, 'report_view', '2026-01-01', '2026-02-01', false)`,
      [VIEW_ONLY.app],
    );
    // Designate pre-cutover TL_A + grant report_delegate on team
    await db.query(
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, public.direct_entry_authorization_date(), 1, 'Pre TL', $5)",
      [OWNER.auth, OWNER.app, TEAM_A, TL_A.app, nextKey("pre_tl")],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, 'report_delegate', '2026-01-01', true)",
      [TL_A.app],
    );

    // Verify legacy tombstone still denies pre-cutover Full Admin
    await assert.rejects(
      db.query("select public.work_report_list_readable_submissions($1::uuid, $2::uuid)", [VIEW_ONLY.auth, VIEW_ONLY.app]),
      (e) => e.code === "42501" && e.message.includes("WORK_REPORT_CAPABILITY_DENIED"),
    );

    // Verify pre-cutover TL_A has report_review via tl_wr_compat_bridge AND report_delegate via legacy_bridge_candidates CONTEXT_TEAM!
    const { rawContext: preTlCtx, resolution: preTlRes } = await resolveViaRealRpc(db, TL_A.auth);
    assert.equal(preTlRes.ok, true);
    assert.ok(
      preTlCtx.effective_grants.some((g) => g.capability === "report_review" && g.scope_kind === "CONTEXT_TEAM" && g.scope_id === TEAM_A),
      "Pre-cutover TL retains report_review @ CONTEXT_TEAM",
    );
    assert.ok(
      preTlCtx.effective_grants.some((g) => g.capability === "report_delegate" && g.scope_kind === "CONTEXT_TEAM" && g.scope_id === TEAM_A && g.source_type === "LEGACY_BRIDGE"),
      "Pre-cutover team delegator emits report_delegate @ CONTEXT_TEAM in LEGACY_BRIDGE",
    );
    assert.equal(workReportDelegationPredicate(preTlRes.actor), true);

    const tpl = await createPublishedTemplate(db, OWNER, "PRE_TPL", { requiresReview: true });
    const { rows: [{ res: preDel }] } = await db.query(
      "select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid, null, null, $6) as res",
      [TL_A.auth, TL_A.app, STAFF_A1.app, tpl.template_id, TEAM_A, nextKey("pre_del")],
    );
    assert.equal(preDel.status, "ACTIVE");
    const { rawContext: preStaffCtx, resolution: preStaffRes } = await resolveViaRealRpc(db, STAFF_A1.auth);
    assert.deepEqual(preStaffCtx.effective_report_review_scopes.map((s) => ({ kind: s.kind, team_id: s.team_id })), [{ kind: "team", team_id: TEAM_A }]);
    assert.equal(workReportReviewPredicate(preStaffRes.actor), true);
  } finally {
    await db.close();
  }
});

test("WP8D-2 [6/6] R1 E2E: Pure report_assign delegate opens AppShell + WorkReportsShell + /work-reports/assignments via READ ONLY probe, assigns only delegated scope, and immediately loses access on revoke/disable/grantor-loss while keeping independent direct roles", async () => {
  const { db } = await createDb();
  const prevWorkReportsEnabled = process.env.WORK_REPORTS_API_ENABLED;
  const prevDirectEntryApiEnabled = process.env.DIRECT_ENTRY_API_ENABLED;
  process.env.WORK_REPORTS_API_ENABLED = "true";
  process.env.DIRECT_ENTRY_API_ENABLED = "false";

  try {
    // 1. Seed teams, accounts, cutover, designate TL_B (independent direct role), clear all legacy mirrors
    await db.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'R1_A', 'Team A', true), ($2::uuid, 'R1_B', 'Team B', true)",
      [TEAM_A, TEAM_B],
    );
    await seedBaseUser(db, OWNER, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LUANPT, { caps: [], scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LIENVU, { caps: ADMIN_SEED_CAPS.filter((c) => c !== "duplicate_cccd_withdraw"), scopes: [{ kind: "all" }] });
    await seedBaseUser(db, NGATTT, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, DELEG_GRANTOR, { caps: [], scopes: [] });
    await seedBaseUser(db, STAFF_A1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_A2, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_B1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_B });
    await seedBaseUser(db, ADMIN_AND_TL, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_B });

    const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
    const cutover = await runWp5Cutover(db, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(cutover.status, "APPLIED");

    // Grant direct WP5 report_delegate + report_assign @ ALL to DELEG_GRANTOR
    for (const cap of ["report_delegate", "report_assign"]) {
      await db.query(
        `insert into public.authz_direct_capability_grants
           (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
         values ($1::uuid, $2, 'ALL', null, 'EXCEPTION_GRANT', 'R1 grantor', $3::uuid)`,
        [DELEG_GRANTOR.app, cap, OWNER.app],
      );
    }
    // Designate ADMIN_AND_TL as Team Leader on TEAM_B (independent direct report_assign @ CONTEXT_TEAM(TEAM_B))
    await db.query(
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, public.direct_entry_authorization_date(), 1, 'R1 Direct TL B', $5)",
      [OWNER.auth, OWNER.app, TEAM_B, ADMIN_AND_TL.app, nextKey("r1_tlb")],
    );

    // Clear ALL legacy mirrors for every managed account
    await clearLegacyMirrors(db, [
      OWNER.app, LUANPT.app, LIENVU.app, NGATTT.app, DELEG_GRANTOR.app, STAFF_A1.app, STAFF_A2.app, STAFF_B1.app, ADMIN_AND_TL.app,
    ]);

    const t1 = await createPublishedTemplate(db, OWNER, "R1_T1", { requiresReview: false });
    const t2 = await createPublishedTemplate(db, OWNER, "R1_T2", { requiresReview: false });
    const { rows: [{ d: today }] } = await db.query("select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as d");

    // 2. Wire REAL production resolve-nav-actor.ts + work-reports-shell.tsx against REAL PGlite (READ ONLY tx for nav probes!)
    const repoRoot = path.resolve(".");
    let activeRequestCache = null;
    const runInRequest = (fn) => {
      const prev = activeRequestCache;
      activeRequestCache = new Map();
      return Promise.resolve().then(fn).finally(() => { activeRequestCache = prev; });
    };
    const requestScopedCache = (fn) => (...args) => {
      if (!activeRequestCache) return fn(...args);
      let map = activeRequestCache.get(fn);
      if (!map) {
        map = new Map();
        activeRequestCache.set(fn, map);
      }
      const key = args.length === 0 ? "__noargs__" : JSON.stringify(args);
      if (map.has(key)) return map.get(key);
      const val = fn(...args);
      map.set(key, val);
      return val;
    };
    const loadTs = (relPath, overrides = {}) => {
      const fullPath = path.join(repoRoot, relPath);
      const { outputText } = ts.transpileModule(readFileSync(fullPath, "utf8"), {
        fileName: fullPath,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
        },
      });
      const mod = { exports: {} };
      const req = Module.createRequire(fullPath);
      const customReq = (spec) => {
        if (Object.prototype.hasOwnProperty.call(overrides, spec)) return overrides[spec];
        return req(spec);
      };
      new Function("exports", "require", "module", "__filename", "__dirname", outputText)(
        mod.exports, customReq, mod, fullPath, path.dirname(fullPath),
      );
      return mod.exports;
    };

    let currentAuthSubject = STAFF_A2.auth;
    let listOptionsReadOnlyCalls = 0;
    let obligationsReadOnlyCalls = 0;
    let injectProbeFault = null;

    const readOnlyRpcAdapter = async (fnName, args) => {
      if (fnName === "work_report_list_assignment_options") {
        listOptionsReadOnlyCalls += 1;
        if (injectProbeFault) return injectProbeFault();
        await db.exec("begin transaction read only;");
        try {
          const { rows } = await db.query(
            "select public.work_report_list_assignment_options($1::uuid, $2::uuid, $3::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id, args.p_team_id ?? null],
          );
          await db.exec("commit;");
          return { data: rows[0]?.res, error: null };
        } catch (err) {
          await db.exec("rollback;").catch(() => {});
          return { data: null, error: { code: err.code, message: err.message } };
        }
      }
      if (fnName === "work_report_has_active_obligations") {
        obligationsReadOnlyCalls += 1;
        await db.exec("begin transaction read only;");
        try {
          const { rows } = await db.query(
            "select public.work_report_has_active_obligations($1::uuid, $2::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id],
          );
          await db.exec("commit;");
          return { data: rows[0]?.res, error: null };
        } catch (err) {
          await db.exec("rollback;").catch(() => {});
          return { data: null, error: { code: err.code, message: err.message } };
        }
      }
      throw new Error(`Unexpected RPC in nav probe: ${fnName}`);
    };

    const registryCapabilityMod = loadTs("src/lib/navigation/registry-capability.ts", { "server-only": {} });
    const workReportsShellMod = loadTs("src/components/work-reports/work-reports-shell.tsx", {
      "server-only": {},
      "@/components/ui/page-shell": { PageHeader: () => null, PageShell: () => null },
      "@/lib/navigation/registry-capability": registryCapabilityMod,
      "./work-reports-nav": { WorkReportsModuleNav: () => null },
    });
    const navMod = loadTs("src/lib/navigation/resolve-nav-actor.ts", {
      "server-only": {},
      react: { cache: requestScopedCache },
      "@/lib/navigation/registry-capability": registryCapabilityMod,
      "@/lib/auth/direct-entry-page-access": {
        EMPTY_CHANGE_REQUEST_HISTORICAL_PROBE: { hasHistoricalRequests: false },
        probeHistoricalChangeRequestAccess: async () => ({ hasHistoricalRequests: false }),
      },
      "@/lib/auth/direct-entry-session": {
        getDirectEntryActor: async () => (await resolveViaRealRpc(db, currentAuthSubject)).resolution,
      },
      "@/lib/auth/direct-entry-session-retry": {
        resolveSessionWithBoundedRetry: async (loader) => ({ actor: await loader() }),
      },
      "@/lib/direct-entry/actor-context-repository": { createDirectEntryActorRepository: () => ({}) },
      "@/lib/direct-entry/change-request-read-repository": {
        createChangeRequestReadRepository: () => ({ listChangeRequests: async () => ({ ok: true, data: { items: [] } }) }),
      },
      "@/lib/leave/leave-repository": {
        createLeaveRepository: () => ({ getActorAccess: async () => ({ ok: true, data: { can_access: false, can_manage_config: false, can_view_monthly_report: false } }) }),
      },
      "@/lib/salary-advance/salary-advance-repository": {
        createSalaryAdvanceRepository: () => ({ getActorAccess: async () => ({ ok: true, data: { can_access: false } }) }),
      },
      "@/lib/vendor-finance/vendor-finance-repository": {
        createVendorFinanceRepository: () => ({ getActorAccess: async () => ({ ok: true, data: { can_view: false, can_record: false, can_reconcile: false, can_manage_project_assignments: false } }) }),
      },
      "@/lib/work-reports/assignment-repository": {
        createAssignmentRepository: () => createAssignmentRepository(readOnlyRpcAdapter),
      },
      "@/lib/work-reports/submission-repository": {
        createSubmissionRepository: () => createSubmissionRepository(readOnlyRpcAdapter),
      },
    });

    const evaluateUiFlow = async (user) => {
      currentAuthSubject = user.auth;
      const beforeObs = (await db.query("select count(*)::int as n from public.work_report_obligations")).rows[0].n;
      const beforeListCalls = listOptionsReadOnlyCalls;
      const out = await runInRequest(async () => {
        const appShellActor = await navMod.resolveNavActorForAppShell({ directEntryEnabled: true, adminNavigationEnabled: true });
        const actorRes = await navMod.resolveActorForRequest();
        const assignProbe = actorRes.ok ? await navMod.resolveWorkReportAssignmentAccessForRequest() : null;
        const shellActor = await navMod.resolveWorkReportShellActorForRequest();
        const pageDecision = decideWorkReportAssignmentsPageAccess({
          actor: actorRes,
          hasWorkReportAssignmentAccess: assignProbe?.hasAssignmentAccess,
          assignmentAccessStatus: assignProbe?.status,
        });
        const rootPageDecision = decideWorkReportsPageAccess({
          actor: actorRes,
          hasWorkReportAssignmentAccess: assignProbe?.hasAssignmentAccess,
        });
        const shellLinks = workReportsShellMod.buildWorkReportsNavLinks(shellActor);
        const appShellShowsAssignments =
          decideNavEntryVisibility({
            capabilityKey: "work_report_assignments",
            actor: appShellActor,
            viewport: "desktop",
            entryVisibleInViewport: true,
          }) &&
          decideNavEntryVisibility({
            capabilityKey: "work_report_assignments",
            actor: appShellActor,
            viewport: "mobile",
            entryVisibleInViewport: true,
          });
        const appShellShowsWorkReports =
          decideNavEntryVisibility({
            capabilityKey: "work_reports",
            actor: appShellActor,
            viewport: "desktop",
            entryVisibleInViewport: true,
          }) &&
          decideNavEntryVisibility({
            capabilityKey: "work_reports",
            actor: appShellActor,
            viewport: "mobile",
            entryVisibleInViewport: true,
          });
        const moduleShowsAssignments = shellLinks.some((g) =>
          g.subLinks?.some((s) => s.href === "/work-reports/assignments"),
        );
        const moduleShowsGroups = shellLinks.some((g) =>
          g.subLinks?.some((s) => s.href === "/work-reports/assignments?tab=groups"),
        );
        return {
          appShellActor,
          actorRes,
          assignProbe,
          shellActor,
          pageDecision,
          rootPageDecision,
          appShellShowsAssignments,
          appShellShowsWorkReports,
          moduleShowsAssignments,
          moduleShowsGroups,
        };
      });
      const afterObs = (await db.query("select count(*)::int as n from public.work_report_obligations")).rows[0].n;
      assert.equal(afterObs, beforeObs, "Menu/page probe MUST NEVER write or materialize obligations");
      assert.ok(listOptionsReadOnlyCalls - beforeListCalls <= 1, "At most 1 read-only listOptions call per request");
      return out;
    };

    // 3. Before delegation: unauthorized STAFF_A2 & STAFF_B1 CANNOT see menu or open /work-reports/assignments
    const unauthA2 = await evaluateUiFlow(STAFF_A2);
    assert.equal(unauthA2.appShellShowsAssignments, false);
    assert.equal(unauthA2.moduleShowsAssignments, false);
    assert.equal(unauthA2.pageDecision, "ACCESS_DENIED");
    const unauthB1 = await evaluateUiFlow(STAFF_B1);
    assert.equal(unauthB1.appShellShowsAssignments, false);
    assert.equal(unauthB1.moduleShowsAssignments, false);
    assert.equal(unauthB1.pageDecision, "ACCESS_DENIED");

    // 4. Delegate ONLY report_assign on (T1, TEAM_A) to STAFF_A2 (pure delegate — 0 direct report_* grants!)
    const { rows: [{ res: del1 }] } = await db.query(
      "select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_assign', $3::uuid, $4::uuid, 'team', $5::uuid, null, null, $6) as res",
      [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, STAFF_A2.app, t1.template_id, TEAM_A, nextKey("r1_del_a2")],
    );
    const { rawContext: a2Raw } = await resolveViaRealRpc(db, STAFF_A2.auth);
    assert.equal(a2Raw.effective_grants.some((g) => g.capability === "report_assign"), false, "R3: 0 blanket report_assign in effective_grants");
    assert.equal(Object.keys(a2Raw).length, 12, "Actor RPC preserves exact 12-key contract");

    const obsCallsBeforeDelegate = obligationsReadOnlyCalls;
    assert.ok(obsCallsBeforeDelegate >= 2, "Unauthorized users fell through to read-only obligations probe");
    const pureDelFlow = await evaluateUiFlow(STAFF_A2);
    assert.equal(obligationsReadOnlyCalls, obsCallsBeforeDelegate, "Pure report_assign delegate short-circuits obligations probe");
    assert.equal(pureDelFlow.appShellShowsWorkReports, true, "Pure delegate sees Báo cáo của tôi in AppShell");
    assert.equal(pureDelFlow.appShellShowsAssignments, true, "Pure delegate sees Quản lý/Giao báo cáo in AppShell");
    assert.equal(pureDelFlow.moduleShowsAssignments, true, "Pure delegate sees Đợt giao in WorkReportsShell");
    assert.equal(pureDelFlow.moduleShowsGroups, true, "Pure delegate sees Nhóm nhận báo cáo in WorkReportsShell");
    assert.equal(pureDelFlow.pageDecision, "ALLOW", "Pure delegate opens /work-reports/assignments directly");
    assert.equal(pureDelFlow.rootPageDecision, "ALLOW");

    // 5. Pure delegate assigns exact delegated (T1, TEAM_A) -> SUCCEEDS; wrong template T2 or wrong team TEAM_B -> 42501!
    const { rows: [{ res: okAsg }] } = await db.query(
      "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'USER', $4::uuid, null, null, 'DAILY', true, 0, '23:59:59'::time, false, $5::date, null, $6) as res",
      [STAFF_A2.auth, STAFF_A2.app, t1.template_id, STAFF_A1.app, today, nextKey("r1_asg_ok")],
    );
    assert.ok(okAsg.assignment_id, "Pure delegate succeeds assigning delegated T1/TEAM_A");
    await assert.rejects(
      db.query(
        "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'USER', $4::uuid, null, null, 'DAILY', true, 0, '23:59:59'::time, false, $5::date, null, $6)",
        [STAFF_A2.auth, STAFF_A2.app, t2.template_id, STAFF_A1.app, today, nextKey("r1_asg_wrong_tpl")],
      ),
      (e) => e.code === "42501",
      "Wrong template T2 stays denied by SQL",
    );
    await assert.rejects(
      db.query(
        "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null, 'DAILY', true, 0, '23:59:59'::time, false, $5::date, null, $6)",
        [STAFF_A2.auth, STAFF_A2.app, t1.template_id, TEAM_B, today, nextKey("r1_asg_wrong_team")],
      ),
      (e) => e.code === "42501",
      "Wrong team TEAM_B stays denied by SQL",
    );

    // 6. Probe error / malformed payload fails closed without crashing AppShell and yields TEMPORARY_UNAVAILABLE on page
    injectProbeFault = () => ({ data: { templates: "corrupted" }, error: null });
    const faultFlow = await evaluateUiFlow(STAFF_A2);
    assert.ok(faultFlow.appShellActor !== null, "Malformed probe never crashes AppShell");
    assert.equal(faultFlow.appShellShowsAssignments, false, "Malformed probe fails closed in AppShell");
    assert.equal(faultFlow.moduleShowsAssignments, false, "Malformed probe fails closed in WorkReportsShell");
    assert.equal(faultFlow.pageDecision, "TEMPORARY_UNAVAILABLE", "Malformed probe preserves page TEMPORARY_UNAVAILABLE");
    injectProbeFault = null;

    // 7. Revoke delegation -> immediately loses AppShell, WorkReportsShell & /work-reports/assignments
    await db.query(
      "select public.work_report_revoke_delegation($1::uuid, $2::uuid, $3::uuid, $4, $5)",
      [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, del1.delegation_id, del1.version, nextKey("r1_rev_del1")],
    );
    const afterRevokeFlow = await evaluateUiFlow(STAFF_A2);
    assert.equal(afterRevokeFlow.appShellShowsAssignments, false);
    assert.equal(afterRevokeFlow.moduleShowsAssignments, false);
    assert.equal(afterRevokeFlow.pageDecision, "ACCESS_DENIED");

    // 8. Re-delegate, then disable STAFF_A2 -> ACCOUNT_UNAVAILABLE & AppShell null; re-enable -> regains access; disable grantor -> loses access!
    await db.query(
      "select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_assign', $3::uuid, $4::uuid, 'team', $5::uuid, null, null, $6)",
      [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, STAFF_A2.app, t1.template_id, TEAM_A, nextKey("r1_del_a2_2")],
    );
    const { rows: [{ version: a2Ver1 }] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [STAFF_A2.app],
    );
    await db.query(
      "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Disable delegate', $5)",
      [OWNER.auth, OWNER.app, STAFF_A2.app, a2Ver1, nextKey("r1_dis_a2")],
    );
    const disabledFlow = await evaluateUiFlow(STAFF_A2);
    assert.equal(disabledFlow.appShellActor, null);
    assert.equal(disabledFlow.pageDecision, "ACCOUNT_UNAVAILABLE");

    const { rows: [{ version: a2Ver2 }] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [STAFF_A2.app],
    );
    await db.query(
      "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Re-enable delegate', $5)",
      [OWNER.auth, OWNER.app, STAFF_A2.app, a2Ver2, nextKey("r1_en_a2")],
    );
    await clearLegacyMirrors(db, [STAFF_A2.app]);
    assert.equal((await evaluateUiFlow(STAFF_A2)).pageDecision, "ALLOW");

    // Grantor loses authority (disabled) -> delegate immediately loses AppShell/Shell/Page access
    const { rows: [{ version: grVer }] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [DELEG_GRANTOR.app],
    );
    await db.query(
      "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Disable grantor', $5)",
      [OWNER.auth, OWNER.app, DELEG_GRANTOR.app, grVer, nextKey("r1_dis_gr")],
    );
    const grantorLostFlow = await evaluateUiFlow(STAFF_A2);
    assert.equal(grantorLostFlow.appShellShowsAssignments, false);
    assert.equal(grantorLostFlow.moduleShowsAssignments, false);
    assert.equal(grantorLostFlow.pageDecision, "ACCESS_DENIED");

    // 9. Independent direct role preserved: ADMIN_AND_TL (direct TL on TEAM_B) receives ALL delegation from OWNER,
    //    then delegation is revoked -> still keeps direct TEAM_B access (0 listOptions probe calls needed!) while losing TEAM_A!
    const { rows: [{ res: delTl }] } = await db.query(
      "select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_assign', $3::uuid, $4::uuid, 'all', null, null, null, $5) as res",
      [OWNER.auth, OWNER.app, ADMIN_AND_TL.app, t1.template_id, nextKey("r1_del_tlb")],
    );
    await db.query(
      "select public.work_report_revoke_delegation($1::uuid, $2::uuid, $3::uuid, $4, $5)",
      [OWNER.auth, OWNER.app, delTl.delegation_id, delTl.version, nextKey("r1_rev_tlb")],
    );
    const callsBeforeDirectTl = listOptionsReadOnlyCalls;
    const directTlFlow = await evaluateUiFlow(ADMIN_AND_TL);
    assert.equal(directTlFlow.appShellShowsAssignments, true);
    assert.equal(directTlFlow.moduleShowsAssignments, true);
    assert.equal(directTlFlow.pageDecision, "ALLOW");
    assert.equal(listOptionsReadOnlyCalls, callsBeforeDirectTl, "Direct TL short-circuits listOptions probe");
    // Direct TL still assigns TEAM_B cleanly, denied TEAM_A after delegation revoke
    const { rows: [{ res: tlTeamBAsg }] } = await db.query(
      "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null, 'DAILY', true, 0, '23:59:59'::time, false, $5::date, null, $6) as res",
      [ADMIN_AND_TL.auth, ADMIN_AND_TL.app, t1.template_id, TEAM_B, today, nextKey("r1_tlb_ok")],
    );
    assert.ok(tlTeamBAsg.assignment_id);
    await assert.rejects(
      db.query(
        "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null, 'DAILY', true, 0, '23:59:59'::time, false, $5::date, null, $6)",
        [ADMIN_AND_TL.auth, ADMIN_AND_TL.app, t1.template_id, TEAM_A, today, nextKey("r1_tlb_deny_a")],
      ),
      (e) => e.code === "42501",
    );
  } finally {
    if (prevWorkReportsEnabled === undefined) delete process.env.WORK_REPORTS_API_ENABLED;
    else process.env.WORK_REPORTS_API_ENABLED = prevWorkReportsEnabled;
    if (prevDirectEntryApiEnabled === undefined) delete process.env.DIRECT_ENTRY_API_ENABLED;
    else process.env.DIRECT_ENTRY_API_ENABLED = prevDirectEntryApiEnabled;
    await db.close();
  }
});

test("WP8D-2 [7/7] R2/P1 F-WD-DRIFT-01 E2E: Real SQL -> createReviewRepository -> review-api handlers (non-empty queue, pagination, filters, scope isolation, detail -> reject/resubmit/approve/OCC/self-review, revoke/disable, draft privacy)", async () => {
  const { db } = await createDb();
  try {
    // 1. Seed teams, managed accounts, WP5 cutover, designate TL_A, clear ALL legacy mirrors
    await db.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'R2_A', 'R2 Team Alpha', true), ($2::uuid, 'R2_B', 'R2 Team Beta', true)",
      [TEAM_A, TEAM_B],
    );
    await seedBaseUser(db, OWNER, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LUANPT, { caps: [], scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LIENVU, { caps: ADMIN_SEED_CAPS.filter((c) => c !== "duplicate_cccd_withdraw"), scopes: [{ kind: "all" }] });
    await seedBaseUser(db, NGATTT, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, TL_A, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_A1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_A2, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_B1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_B });
    await seedBaseUser(db, ADMIN_AND_TL, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_B });

    const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
    const cutover = await runWp5Cutover(db, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(cutover.status, "APPLIED");

    await db.query(
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, public.direct_entry_authorization_date(), 1, 'R2 TL A', $5)",
      [OWNER.auth, OWNER.app, TEAM_A, TL_A.app, nextKey("r2_tla")],
    );
    await clearLegacyMirrors(db, [
      OWNER.app, LUANPT.app, LIENVU.app, NGATTT.app, TL_A.app, STAFF_A1.app, STAFF_A2.app, STAFF_B1.app, ADMIN_AND_TL.app,
    ]);

    // 2. Seed 3 published templates (requires_review = true): T1 (multi-team + null-team snapshot), T2 (late + draft), T3 (empty)
    const t1 = await createPublishedTemplate(db, OWNER, "R2_REV_T1", { requiresReview: true });
    const t2 = await createPublishedTemplate(db, OWNER, "R2_REV_T2", { requiresReview: true });
    const t3Empty = await createPublishedTemplate(db, OWNER, "R2_REV_T3_EMPTY", { requiresReview: true });

    const { rows: [{ d: today, y: yesterday }] } = await db.query(
      "select public.direct_entry_authorization_date()::text as d, (public.direct_entry_authorization_date() - 1)::text as y",
    );

    // T1 on-time assignments (due_offset_days=1 guarantees on-time regardless of UTC/ICT clock): TEAM_A, TEAM_B
    await db.query(
      "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null, 'DAILY', true, 1, '23:59:59'::time, false, $5::date, null, $6)",
      [OWNER.auth, OWNER.app, t1.template_id, TEAM_A, today, nextKey("r2_asg_t1_a")],
    );
    await db.query(
      "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null, 'DAILY', true, 1, '23:59:59'::time, false, $5::date, null, $6)",
      [OWNER.auth, OWNER.app, t1.template_id, TEAM_B, today, nextKey("r2_asg_t1_b")],
    );
    // T2 overdue assignment (yesterday 00:01, p_exclude_sundays=false; reopened via RPC below) so SQL genuinely computes is_late=true & post-deadline amendment
    await db.query(
      "select public.work_report_create_assignment($1::uuid, $2::uuid, $3::uuid, 'USER', $4::uuid, null, null, 'DAILY', true, 0, '00:01:00'::time, false, $5::date, $5::date, $6)",
      [OWNER.auth, OWNER.app, t2.template_id, STAFF_A1.app, yesterday, nextKey("r2_asg_t2_late")],
    );
    await db.query(
      "select public.work_report_ensure_obligations_for_window($1::uuid, $2::uuid, $3::date)",
      [OWNER.auth, OWNER.app, today],
    );
    await db.query(
      "select public.work_report_ensure_obligations_for_window($1::uuid, $2::uuid, $3::date)",
      [OWNER.auth, OWNER.app, yesterday],
    );

    const { rows: obs } = await db.query(
      "select obligation_id, template_id, assignee_app_user_id, period_key, period_start_date::text as period_start_date, period_end_date::text as period_end_date from public.work_report_obligations",
    );
    const findOb = (tplId, userId) => {
      const hit = obs.find((o) => o.template_id === tplId && o.assignee_app_user_id === userId);
      assert.ok(hit, `expected obligation for tpl=${tplId}, user=${userId}`);
      return hit;
    };
    const obA1T1 = findOb(t1.template_id, STAFF_A1.app);
    const obTlAT1 = findOb(t1.template_id, TL_A.app);
    const obA2T1Draft = findOb(t1.template_id, STAFF_A2.app);
    const obB1T1 = findOb(t1.template_id, STAFF_B1.app);
    const obNoTeamT1 = findOb(t1.template_id, ADMIN_AND_TL.app);
    const obA1T2Late = findOb(t2.template_id, STAFF_A1.app);

    const submitPayload = (calls, notes = null) =>
      JSON.stringify({ calls_made: calls, interested_candidates: 2, workers_started: 1, notes });

    // Submit 5 reports into PENDING_REVIEW and leave 1 as unsubmitted DRAFT with private draft_payload_json
    await db.query(
      "select public.work_report_save_draft($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)",
      [STAFF_A2.auth, STAFF_A2.app, obA2T1Draft.obligation_id, submitPayload(777, "SECRET_DRAFT_ONLY"), nextKey("r2_draft")],
    );
    const subA1T1 = (await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5) as res",
      [STAFF_A1.auth, STAFF_A1.app, obA1T1.obligation_id, submitPayload(10, "T1_A1"), nextKey("r2_sub_a1_t1")],
    )).rows[0].res;
    const subTlAT1 = (await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5) as res",
      [TL_A.auth, TL_A.app, obTlAT1.obligation_id, submitPayload(20, "T1_TLA"), nextKey("r2_sub_tla_t1")],
    )).rows[0].res;
    await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)",
      [STAFF_B1.auth, STAFF_B1.app, obB1T1.obligation_id, submitPayload(30, "T1_B1"), nextKey("r2_sub_b1_t1")],
    );
    await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)",
      [ADMIN_AND_TL.auth, ADMIN_AND_TL.app, obNoTeamT1.obligation_id, submitPayload(40, "T1_NT"), nextKey("r2_sub_nt_t1")],
    );
    // Simulate historical obligation with null snapshot_team_id to verify nullable team DTO fields
    await db.query(
      "update public.work_report_obligations set snapshot_team_id = null, snapshot_team_code = null, snapshot_team_display_name = null where obligation_id = $1::uuid",
      [obNoTeamT1.obligation_id],
    );
    // Reopen overdue T2 obligation so SQL genuinely allows late submission and sets is_late=true
    await db.query(
      "select public.work_report_change_obligation_status($1::uuid, $2::uuid, $3::uuid, 1, 'REOPEN', 'Mở lại nộp bổ sung', statement_timestamp() + interval '1 day', $4)",
      [OWNER.auth, OWNER.app, obA1T2Late.obligation_id, nextKey("r2_reopen_t2")],
    );
    const subA1T2Late = (await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5) as res",
      [STAFF_A1.auth, STAFF_A1.app, obA1T2Late.obligation_id, submitPayload(11, "T2_LATE_V1"), nextKey("r2_sub_a1_t2")],
    )).rows[0].res;
    assert.equal(subA1T1.state, "PENDING_REVIEW");
    assert.equal(subTlAT1.state, "PENDING_REVIEW");
    assert.equal(subA1T2Late.state, "PENDING_REVIEW");

    // 3. Build REAL SQL -> service_role (READ ONLY for reads) -> createReviewRepository -> review-api deps
    let readOnlyReviewCalls = 0;
    const realReviewRpc = async (name, args) => {
      if (name === "work_report_list_pending_reviews") {
        readOnlyReviewCalls++;
        await db.exec("begin transaction read only; set local role service_role");
        try {
          const { rows } = await db.query(
            "select public.work_report_list_pending_reviews($1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer) as res",
            [args.p_auth_subject, args.p_app_user_id, args.p_template_id ?? null, args.p_cursor ?? null, args.p_page_size ?? 50],
          );
          await db.exec("commit");
          return { data: rows[0]?.res ?? null, error: null };
        } catch (err) {
          await db.exec("rollback");
          return { data: null, error: { code: err.code, message: err.message } };
        }
      }
      if (name === "work_report_get_review_submission") {
        readOnlyReviewCalls++;
        await db.exec("begin transaction read only; set local role service_role");
        try {
          const { rows } = await db.query(
            "select public.work_report_get_review_submission($1::uuid, $2::uuid, $3::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id, args.p_obligation_id],
          );
          await db.exec("commit");
          return { data: rows[0]?.res ?? null, error: null };
        } catch (err) {
          await db.exec("rollback");
          return { data: null, error: { code: err.code, message: err.message } };
        }
      }
      if (name === "work_report_decide_review") {
        await db.exec("begin; set local role service_role");
        try {
          const { rows } = await db.query(
            "select public.work_report_decide_review($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::integer, $7::text) as res",
            [
              args.p_auth_subject,
              args.p_app_user_id,
              args.p_obligation_id,
              args.p_decision,
              args.p_reason ?? null,
              args.p_expected_version,
              args.p_idempotency_key,
            ],
          );
          await db.exec("commit");
          return { data: rows[0]?.res ?? null, error: null };
        } catch (err) {
          await db.exec("rollback");
          return { data: null, error: { code: err.code, message: err.message } };
        }
      }
      throw new Error(`Unexpected review RPC: ${name}`);
    };

    const realReviewRepo = createReviewRepository(realReviewRpc);
    const depsFor = (user, repo = realReviewRepo) => ({
      resolveSession: async () => ({ actor: (await resolveViaRealRpc(db, user.auth)).resolution }),
      repository: repo,
    });
    const postDecision = (user, obligationId, body, headerKey = body.idempotency_key) =>
      decideWorkReportReview(
        new Request(`http://localhost/api/work-reports/reviews/${obligationId}/decision`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost",
            Host: "localhost",
            ...(headerKey ? { "Idempotency-Key": headerKey } : {}),
          },
          body: JSON.stringify(body),
        }),
        obligationId,
        "true",
        depsFor(user),
      );

    // 4. Positive control: non-empty queue (>= 2 items) via REAL SQL -> REAL repository -> REAL API handler returns 200
    const beforeObsCount = (await db.query("select count(*)::int as n from public.work_report_obligations")).rows[0].n;
    const ownerListRes = await listPendingWorkReportReviews(
      new Request("http://localhost/api/work-reports/reviews?page_size=50"),
      "true",
      depsFor(OWNER),
    );
    assert.equal(ownerListRes.status, 200, "Non-empty pending queue MUST return 200 (not 503 F-WD-DRIFT-01)");
    const ownerListBody = await ownerListRes.json();
    assert.equal(ownerListBody.ok, true);
    assert.equal(ownerListBody.items.length, 5, "OWNER sees all 5 PENDING_REVIEW items and excludes DRAFT");
    assert.equal(ownerListBody.has_more, false);
    assert.equal(ownerListBody.next_cursor, null);
    assert.equal(
      ownerListBody.items.some((i) => i.obligation_id === obA2T1Draft.obligation_id),
      false,
      "Unsubmitted DRAFT never appears in pending review queue",
    );
    assert.ok(!JSON.stringify(ownerListBody).includes("SECRET_DRAFT_ONLY"), "Private draft payload never leaks");
    assert.ok(!JSON.stringify(ownerListBody).includes("T1_A1"), "Submitted payload_json never leaks in pending list");

    // Verify full runtime DTO AND SQL-before-Web legacy aliases on every item
    for (const item of ownerListBody.items) {
      assert.equal("payload_json" in item, false);
      assert.equal("draft_payload_json" in item, false);
      assert.equal(typeof item.assignee_display_name, "string");
      assert.equal(item.assignee_label, item.assignee_display_name, "Legacy assignee_label matches assignee_display_name");
      assert.equal(item.team_id, item.snapshot_team_id, "Legacy team_id matches snapshot_team_id");
      assert.equal(item.version, item.submission_version, "Legacy version matches submission_version");
      assert.equal(item.state, "PENDING_REVIEW", "Legacy state alias preserved for ReviewInbox UI");
      assert.equal(Number.isInteger(item.template_version) && item.template_version >= 1, true);
      assert.match(item.period_start_date, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(item.period_end_date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(typeof item.is_late, "boolean");
      assert.equal(typeof item.has_post_deadline_amendment, "boolean");
    }

    const lateItem = ownerListBody.items.find((i) => i.obligation_id === obA1T2Late.obligation_id);
    assert.ok(lateItem);
    assert.equal(lateItem.period_start_date, yesterday);
    assert.equal(lateItem.period_end_date, yesterday);
    assert.equal(lateItem.is_late, true, "Real DB is_late=true propagated faithfully");
    assert.equal(lateItem.has_post_deadline_amendment, false);
    assert.equal(lateItem.submission_version, subA1T2Late.version);

    const noTeamItem = ownerListBody.items.find((i) => i.obligation_id === obNoTeamT1.obligation_id);
    assert.ok(noTeamItem);
    assert.equal(noTeamItem.snapshot_team_id, null);
    assert.equal(noTeamItem.team_id, null);
    assert.equal(noTeamItem.team_display_name, null);
    assert.equal(noTeamItem.team_label, "Chưa phân nhóm");

    // 5. Empty queue returns 200 with empty items
    const emptyRes = await listPendingWorkReportReviews(
      new Request(`http://localhost/api/work-reports/reviews?template_id=${t3Empty.template_id}`),
      "true",
      depsFor(OWNER),
    );
    assert.equal(emptyRes.status, 200);
    const emptyBody = await emptyRes.json();
    assert.deepEqual(emptyBody.items, []);
    assert.equal(emptyBody.has_more, false);
    assert.equal(emptyBody.next_cursor, null);

    // 6. 2+ page cursor pagination (page_size=2) and template_id filter
    const p1Res = await listPendingWorkReportReviews(
      new Request("http://localhost/api/work-reports/reviews?page_size=2"),
      "true",
      depsFor(OWNER),
    );
    assert.equal(p1Res.status, 200);
    const p1 = await p1Res.json();
    assert.equal(p1.items.length, 2);
    assert.equal(p1.has_more, true);
    assert.ok(typeof p1.next_cursor === "string" && p1.next_cursor.includes("|"));

    const p2Res = await listPendingWorkReportReviews(
      new Request(`http://localhost/api/work-reports/reviews?page_size=2&cursor=${encodeURIComponent(p1.next_cursor)}`),
      "true",
      depsFor(OWNER),
    );
    assert.equal(p2Res.status, 200);
    const p2 = await p2Res.json();
    assert.equal(p2.items.length, 2);
    assert.equal(p2.has_more, true);
    assert.ok(typeof p2.next_cursor === "string");

    const p3Res = await listPendingWorkReportReviews(
      new Request(`http://localhost/api/work-reports/reviews?page_size=2&cursor=${encodeURIComponent(p2.next_cursor)}`),
      "true",
      depsFor(OWNER),
    );
    assert.equal(p3Res.status, 200);
    const p3 = await p3Res.json();
    assert.equal(p3.items.length, 1);
    assert.equal(p3.has_more, false);
    assert.equal(p3.next_cursor, null);
    assert.deepEqual(
      [...p1.items, ...p2.items, ...p3.items].map((i) => i.obligation_id),
      ownerListBody.items.map((i) => i.obligation_id),
      "Keyset pagination traverses all 5 pending items with exact order and zero duplicates",
    );

    const t2FilterRes = await listPendingWorkReportReviews(
      new Request(`http://localhost/api/work-reports/reviews?template_id=${t2.template_id}`),
      "true",
      depsFor(OWNER),
    );
    assert.equal(t2FilterRes.status, 200);
    const t2FilterBody = await t2FilterRes.json();
    assert.deepEqual(t2FilterBody.items.map((i) => i.obligation_id), [obA1T2Late.obligation_id]);

    // 7. Scope isolation: mirror-cleared TL_A, delegated STAFF_A2 (T1, TEAM_A), unauthorized STAFF_B1
    const tlListRes = await listPendingWorkReportReviews(
      new Request("http://localhost/api/work-reports/reviews"),
      "true",
      depsFor(TL_A),
    );
    assert.equal(tlListRes.status, 200);
    const tlListBody = await tlListRes.json();
    assert.deepEqual(
      tlListBody.items.map((i) => i.obligation_id).sort(),
      [obA1T1.obligation_id, obTlAT1.obligation_id, obA1T2Late.obligation_id].sort(),
      "TL_A sees ONLY TEAM_A pending items (never TEAM_B or null-team)",
    );
    const tlCrossTeamDetail = await getWorkReportReviewSubmission(
      new Request(`http://localhost/api/work-reports/reviews/${obB1T1.obligation_id}`),
      obB1T1.obligation_id,
      "true",
      depsFor(TL_A),
    );
    assert.equal(tlCrossTeamDetail.status, 403, "TL_A denied detail outside TEAM_A");

    const { rows: [{ res: delRev }] } = await db.query(
      "select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid, null, null, $6) as res",
      [OWNER.auth, OWNER.app, STAFF_A2.app, t1.template_id, TEAM_A, nextKey("r2_del_rev")],
    );
    const delListRes = await listPendingWorkReportReviews(
      new Request("http://localhost/api/work-reports/reviews"),
      "true",
      depsFor(STAFF_A2),
    );
    assert.equal(delListRes.status, 200);
    const delListBody = await delListRes.json();
    assert.deepEqual(
      delListBody.items.map((i) => i.obligation_id).sort(),
      [obA1T1.obligation_id, obTlAT1.obligation_id].sort(),
      "Delegate STAFF_A2 sees ONLY delegated (T1, TEAM_A) items (never T2, TEAM_B, or null-team)",
    );
    assert.equal(
      (await getWorkReportReviewSubmission(
        new Request(`http://localhost/api/work-reports/reviews/${obA1T2Late.obligation_id}`),
        obA1T2Late.obligation_id,
        "true",
        depsFor(STAFF_A2),
      )).status,
      403,
      "Delegate denied wrong template T2",
    );
    assert.equal(
      (await getWorkReportReviewSubmission(
        new Request(`http://localhost/api/work-reports/reviews/${obB1T1.obligation_id}`),
        obB1T1.obligation_id,
        "true",
        depsFor(STAFF_A2),
      )).status,
      403,
      "Delegate denied wrong team TEAM_B",
    );
    assert.equal(
      (await listPendingWorkReportReviews(
        new Request("http://localhost/api/work-reports/reviews"),
        "true",
        depsFor(STAFF_B1),
      )).status,
      403,
      "Unauthorized STAFF_B1 denied pending list",
    );

    // 8. Real detail -> REJECT -> resubmit (with private draft + post-deadline amendment) -> detail -> APPROVE -> replay -> stale OCC -> self-review
    const lateDetailRes = await getWorkReportReviewSubmission(
      new Request(`http://localhost/api/work-reports/reviews/${obA1T2Late.obligation_id}`),
      obA1T2Late.obligation_id,
      "true",
      depsFor(TL_A),
    );
    assert.equal(lateDetailRes.status, 200, "Real SQL detail passes createReviewRepository().getSubmission -> 200");
    const lateDetail = (await lateDetailRes.json()).detail;
    assert.equal(lateDetail.obligation.obligation_id, obA1T2Late.obligation_id);
    assert.equal(lateDetail.submission.version, lateItem.submission_version);
    assert.equal("draft_payload_json" in lateDetail.submission, false, "Detail never exposes draft_payload_json");
    assert.equal(lateDetail.revisions.length, 1);
    assert.equal(lateDetail.revisions[0].payload_json.calls_made, 11);
    assert.equal(lateDetail.current_revision.revision_no, 1);
    assert.equal(lateDetail.current_revision.payload_json.calls_made, 11);
    assert.equal(typeof lateDetail.assignee_display_name, "string");
    assert.equal(lateDetail.team_display_name, "R2 Team Alpha");
    assert.deepEqual(lateDetail.review_events, []);

    const rejectRes = await postDecision(TL_A, obA1T2Late.obligation_id, {
      decision: "REJECT",
      reason: "Cần bổ sung số liệu xác minh",
      expected_version: lateItem.submission_version,
      idempotency_key: nextKey("r2_rej_t2"),
    });
    assert.equal(rejectRes.status, 200);
    const rejectBody = await rejectRes.json();
    assert.equal(rejectBody.state, "REJECTED");
    assert.equal(rejectBody.version, lateItem.submission_version + 1);

    // Unsubmitted DRAFT obligation returns clean 404 WORK_REPORT_NOT_FOUND (never 503 or draft leak)
    const draftDetailRes = await getWorkReportReviewSubmission(
      new Request(`http://localhost/api/work-reports/reviews/${obA2T1Draft.obligation_id}`),
      obA2T1Draft.obligation_id,
      "true",
      depsFor(OWNER),
    );
    assert.equal(draftDetailRes.status, 404, "Unsubmitted DRAFT detail returns clean 404 (not 503 or draft leak)");
    assert.equal((await draftDetailRes.json()).code, "WORK_REPORT_NOT_FOUND");

    // Assignee saves an unsubmitted draft and BEFORE resubmit, reviewer detail MUST NOT leak UNSUBMITTED_DRAFT_888
    await db.query(
      "select public.work_report_save_draft($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $6)",
      [STAFF_A1.auth, STAFF_A1.app, obA1T2Late.obligation_id, submitPayload(888, "UNSUBMITTED_DRAFT_888"), rejectBody.version, nextKey("r2_resub_draft")],
    );
    const midDraftDetailRes = await getWorkReportReviewSubmission(
      new Request(`http://localhost/api/work-reports/reviews/${obA1T2Late.obligation_id}`),
      obA1T2Late.obligation_id,
      "true",
      depsFor(TL_A),
    );
    assert.equal(midDraftDetailRes.status, 200);
    const midDraftDetail = (await midDraftDetailRes.json()).detail;
    assert.equal("draft_payload_json" in midDraftDetail.submission, false, "Submission omits draft_payload_json while draft is live in DB");
    assert.equal(midDraftDetail.current_revision.payload_json.calls_made, 11);
    assert.ok(!JSON.stringify(midDraftDetail).includes("UNSUBMITTED_DRAFT_888"), "Live unsubmitted draft_payload_json in DB never leaks to reviewer");

    const { rows: [{ version: afterDraftVer }] } = await db.query(
      "select version from public.work_report_submissions where obligation_id = $1::uuid",
      [obA1T2Late.obligation_id],
    );
    const resubmittedLate = (await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $6) as res",
      [STAFF_A1.auth, STAFF_A1.app, obA1T2Late.obligation_id, submitPayload(15, "T2_LATE_V2"), afterDraftVer, nextKey("r2_resub_t2")],
    )).rows[0].res;
    assert.equal(resubmittedLate.state, "PENDING_REVIEW");

    const amendedListRes = await listPendingWorkReportReviews(
      new Request(`http://localhost/api/work-reports/reviews?template_id=${t2.template_id}`),
      "true",
      depsFor(TL_A),
    );
    assert.equal(amendedListRes.status, 200);
    const amendedItem = (await amendedListRes.json()).items[0];
    assert.equal(amendedItem.is_late, true);
    assert.equal(amendedItem.has_post_deadline_amendment, true, "Real DB has_post_deadline_amendment=true propagated faithfully");
    assert.equal(amendedItem.submission_version, resubmittedLate.version);

    const amendedDetailRes = await getWorkReportReviewSubmission(
      new Request(`http://localhost/api/work-reports/reviews/${obA1T2Late.obligation_id}`),
      obA1T2Late.obligation_id,
      "true",
      depsFor(TL_A),
    );
    assert.equal(amendedDetailRes.status, 200);
    const amendedDetail = (await amendedDetailRes.json()).detail;
    assert.equal(amendedDetail.revisions.length, 2);
    assert.deepEqual(amendedDetail.revisions.map((r) => r.revision_no), [2, 1]);
    assert.equal(amendedDetail.current_revision.payload_json.calls_made, 15);
    assert.equal("draft_payload_json" in amendedDetail.submission, false);
    assert.equal(amendedDetail.review_events.length, 1);
    const ev0 = amendedDetail.review_events[0];
    assert.equal(ev0.decision, "REJECTED");
    assert.equal(ev0.reason, "Cần bổ sung số liệu xác minh");
    assert.equal(ev0.reviewer_user_id, TL_A.app);
    assert.equal(ev0.acting_scope_kind, "team");
    assert.equal(ev0.acting_team_id, TEAM_A);
    assert.equal(ev0.delegation_id, null);
    assert.equal(ev0.revision_no, 1);
    assert.equal(typeof ev0.reviewed_at, "string");
    assert.equal(ev0.created_at, ev0.reviewed_at);
    assert.equal(typeof ev0.reviewer_display_name, "string");
    assert.ok(Array.isArray(amendedDetail.template.schema_json.sections), "Matches ReviewInbox UI isReviewDetail shape");

    // Delegate STAFF_A2 opens detail & approves STAFF_A1/T1 using real submission_version, replays idempotently, and stale OCC returns 409
    const delT1Item = delListBody.items.find((i) => i.obligation_id === obA1T1.obligation_id);
    assert.ok(delT1Item);
    const delDetailRes = await getWorkReportReviewSubmission(
      new Request(`http://localhost/api/work-reports/reviews/${obA1T1.obligation_id}`),
      obA1T1.obligation_id,
      "true",
      depsFor(STAFF_A2),
    );
    assert.equal(delDetailRes.status, 200);
    const approveIdemKey = nextKey("r2_del_approve");
    const approveRes = await postDecision(STAFF_A2, obA1T1.obligation_id, {
      decision: "APPROVE",
      reason: null,
      expected_version: delT1Item.submission_version,
      idempotency_key: approveIdemKey,
    });
    assert.equal(approveRes.status, 200);
    const approveBody = await approveRes.json();
    assert.equal(approveBody.state, "APPROVED");
    assert.equal(approveBody.version, delT1Item.submission_version + 1);
    assert.equal(approveBody.delegation_id, delRev.delegation_id);

    // Idempotent replay with same key & payload returns identical 200 result
    const replayRes = await postDecision(STAFF_A2, obA1T1.obligation_id, {
      decision: "APPROVE",
      reason: null,
      expected_version: delT1Item.submission_version,
      idempotency_key: approveIdemKey,
    });
    assert.equal(replayRes.status, 200);
    assert.deepEqual((await replayRes.json()).data, approveBody.data);

    // Stale OCC with old submission_version & new idempotency key returns 409 WORK_REPORT_VERSION_CONFLICT
    const staleRes = await postDecision(STAFF_A2, obA1T1.obligation_id, {
      decision: "APPROVE",
      reason: null,
      expected_version: delT1Item.submission_version,
      idempotency_key: nextKey("r2_stale_occ"),
    });
    assert.equal(staleRes.status, 409);
    assert.equal((await staleRes.json()).code, "WORK_REPORT_VERSION_CONFLICT");

    // Self-review denied with 403 WORK_REPORT_SELF_REVIEW_FORBIDDEN
    const tlSelfItem = tlListBody.items.find((i) => i.obligation_id === obTlAT1.obligation_id);
    assert.ok(tlSelfItem);
    const selfRevRes = await postDecision(TL_A, obTlAT1.obligation_id, {
      decision: "APPROVE",
      reason: null,
      expected_version: tlSelfItem.submission_version,
      idempotency_key: nextKey("r2_self_rev"),
    });
    assert.equal(selfRevRes.status, 403);
    assert.equal((await selfRevRes.json()).code, "WORK_REPORT_SELF_REVIEW_FORBIDDEN");

    // 9. Revoked delegate & disabled reviewer lose access immediately
    await db.query(
      "select public.work_report_revoke_delegation($1::uuid, $2::uuid, $3::uuid, $4, $5)",
      [OWNER.auth, OWNER.app, delRev.delegation_id, delRev.version, nextKey("r2_rev_del")],
    );
    assert.equal(
      (await listPendingWorkReportReviews(
        new Request("http://localhost/api/work-reports/reviews"),
        "true",
        depsFor(STAFF_A2),
      )).status,
      403,
      "Revoked delegate immediately loses pending review list",
    );
    assert.equal(
      (await getWorkReportReviewSubmission(
        new Request(`http://localhost/api/work-reports/reviews/${obTlAT1.obligation_id}`),
        obTlAT1.obligation_id,
        "true",
        depsFor(STAFF_A2),
      )).status,
      403,
      "Revoked delegate immediately loses review detail",
    );

    const { rows: [{ version: tlVer }] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [TL_A.app],
    );
    await db.query(
      "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Disable TL A R2', $5)",
      [OWNER.auth, OWNER.app, TL_A.app, tlVer, nextKey("r2_dis_tla")],
    );
    const disTlList = await listPendingWorkReportReviews(
      new Request("http://localhost/api/work-reports/reviews"),
      "true",
      depsFor(TL_A),
    );
    assert.equal(disTlList.status, 403);
    assert.equal((await disTlList.json()).code, "ACTOR_NOT_AVAILABLE");

    // 10. Negative control: parser remains strict (missing required field or leaked payload -> 503 WORK_REPORT_UNAVAILABLE)
    const strippedRepo = createReviewRepository(async (name, args) => {
      const res = await realReviewRpc(name, args);
      if (name === "work_report_list_pending_reviews" && res.data?.items?.length > 0) {
        const broken = { ...res.data.items[0] };
        delete broken.submission_version;
        return { data: { ...res.data, items: [broken] }, error: null };
      }
      return res;
    });
    const strippedRes = await listPendingWorkReportReviews(
      new Request("http://localhost/api/work-reports/reviews"),
      "true",
      depsFor(OWNER, strippedRepo),
    );
    assert.equal(strippedRes.status, 503);
    assert.equal((await strippedRes.json()).code, "WORK_REPORT_UNAVAILABLE");

    const leakyDraftRepo = createReviewRepository(async (name, args) => {
      const res = await realReviewRpc(name, args);
      if (name === "work_report_list_pending_reviews" && res.data?.items?.length > 0) {
        return { data: { ...res.data, items: [{ ...res.data.items[0], draft_payload_json: { secret: true } }] }, error: null };
      }
      return res;
    });
    const leakyDraftRes = await listPendingWorkReportReviews(
      new Request("http://localhost/api/work-reports/reviews"),
      "true",
      depsFor(OWNER, leakyDraftRepo),
    );
    assert.equal(leakyDraftRes.status, 503);
    assert.equal((await leakyDraftRes.json()).code, "WORK_REPORT_UNAVAILABLE");

    const afterObsCount = (await db.query("select count(*)::int as n from public.work_report_obligations")).rows[0].n;
    assert.equal(afterObsCount, beforeObsCount, "Review reads never materialize or write obligations");
    assert.ok(readOnlyReviewCalls >= 10, "All review read probes executed inside BEGIN TRANSACTION READ ONLY");
  } finally {
    await db.close();
  }
});

test("WP8D-2 [8/8] D2-SERVICE-READ-01: Managed SERVICE accounts (DB_SEEDED_DIRECT_GRANT fixture) read strictly paired Work Reports via REAL SQL + N8N resolver/dispatcher (READ ONLY, 0 writes) while denied on ALL writes, personal ops, Full Admin override, wrong scope/cap & SHARED", async () => {
  const { db } = await createDb();
  const SVC_READ_VA = { auth: "18d20000-0000-4000-8000-000000000101", app: "28d20000-0000-4000-8000-000000000101", email: "svc.va@hrpartner.vn", name: "Service View+Analytics" };
  const SVC_READ_ALL5 = { auth: "18d20000-0000-4000-8000-000000000102", app: "28d20000-0000-4000-8000-000000000102", email: "svc.all5@hrpartner.vn", name: "Service All 5 Read" };
  const SVC_ANALYTICS_ONLY = { auth: "18d20000-0000-4000-8000-000000000103", app: "28d20000-0000-4000-8000-000000000103", email: "svc.anonly@hrpartner.vn", name: "Service Analytics Only" };
  const SVC_TEAM_A = { auth: "18d20000-0000-4000-8000-000000000104", app: "28d20000-0000-4000-8000-000000000104", email: "svc.teama@hrpartner.vn", name: "Service Team A Scoped" };
  const SVC_ADMIN_TRIPLE = { auth: "18d20000-0000-4000-8000-000000000105", app: "28d20000-0000-4000-8000-000000000105", email: "svc.admintriple@hrpartner.vn", name: "Service Admin Triple No Override" };
  const SVC_OVERGRANTED = { auth: "18d20000-0000-4000-8000-000000000106", app: "28d20000-0000-4000-8000-000000000106", email: "svc.overgranted@hrpartner.vn", name: "Service Overgranted Deny Write" };
  const SHARED_DIRECT = { auth: "18d20000-0000-4000-8000-000000000107", app: "28d20000-0000-4000-8000-000000000107", email: "shared.direct@hrpartner.vn", name: "Shared Direct Grants Denied" };

  try {
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'SVC_TA', 'Service Team Alpha', true),
              ($2::uuid, 'SVC_TB', 'Service Team Beta', true),
              ($3::uuid, 'SVC_TI', 'Service Team Inactive', false)`,
      [TEAM_A, TEAM_B, TEAM_INACTIVE],
    );

    await seedBaseUser(db, OWNER, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LUANPT, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, LIENVU, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, NGATTT, { caps: ADMIN_SEED_CAPS, scopes: [{ kind: "all" }] });
    await seedBaseUser(db, STAFF_A1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_A });
    await seedBaseUser(db, STAFF_B1, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }], teamId: TEAM_B });
    await seedBaseUser(db, NO_TEAM_USER, { caps: RECRUITER_SEED_CAPS, scopes: [{ kind: "own" }] });

    for (const svc of [SVC_READ_VA, SVC_READ_ALL5, SVC_ANALYTICS_ONLY, SVC_TEAM_A, SVC_ADMIN_TRIPLE, SVC_OVERGRANTED]) {
      await seedBaseUser(db, svc, { accountType: "SERVICE" });
    }
    await seedBaseUser(db, SHARED_DIRECT, { accountType: "SHARED" });

    // Apply WP5 cutover so OWNER is managed ADMIN and all accounts are authz_managed = true
    const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
    const cutover = await runWp5Cutover(db, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(cutover.status, "APPLIED");
    await db.query(
      "update public.direct_entry_app_users set authz_managed = true where app_user_id = any($1::uuid[])",
      [[
        SVC_READ_VA.app,
        SVC_READ_ALL5.app,
        SVC_ANALYTICS_ONLY.app,
        SVC_TEAM_A.app,
        SVC_ADMIN_TRIPLE.app,
        SVC_OVERGRANTED.app,
        SHARED_DIRECT.app,
      ]],
    );

    const seedGrant = async (user, capability, scopeKind, scopeId = null) => {
      await db.query(
        `insert into public.authz_direct_capability_grants
           (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
         values ($1::uuid, $2, $3, $4, 'EXCEPTION_GRANT', 'DB_SEEDED_DIRECT_GRANT fixture', $5::uuid)`,
        [user.app, capability, scopeKind, scopeId, OWNER.app],
      );
    };

    // 1. Seed DB_SEEDED_DIRECT_GRANT fixtures (explicit paired direct grants, zero legacy mirrors)
    await seedGrant(SVC_READ_VA, "report_view", "ALL");
    await seedGrant(SVC_READ_VA, "report_analytics_view", "ALL");

    for (const cap of ["report_view", "report_analytics_view", "report_form_manage", "report_assign"]) {
      await seedGrant(SVC_READ_ALL5, cap, "ALL");
      await seedGrant(SHARED_DIRECT, cap, "ALL");
    }

    await seedGrant(SVC_ANALYTICS_ONLY, "report_analytics_view", "ALL");

    await seedGrant(SVC_TEAM_A, "report_view", "CONTEXT_TEAM", TEAM_A);
    await seedGrant(SVC_TEAM_A, "report_analytics_view", "CONTEXT_TEAM", TEAM_A);
    await seedGrant(SVC_TEAM_A, "report_assign", "CONTEXT_TEAM", TEAM_A);
    await seedGrant(SVC_TEAM_A, "report_form_manage", "CONTEXT_TEAM", TEAM_A);

    for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await seedGrant(SVC_ADMIN_TRIPLE, cap, "ALL");
    }

    for (const cap of [
      "report_form_manage",
      "report_assign",
      "report_view",
      "report_analytics_view",
      "report_review",
      "report_delegate",
    ]) {
      await seedGrant(SVC_OVERGRANTED, cap, "ALL");
    }

    await clearLegacyMirrors(db, [
      OWNER.app,
      SVC_READ_VA.app,
      SVC_READ_ALL5.app,
      SVC_ANALYTICS_ONLY.app,
      SVC_TEAM_A.app,
      SVC_ADMIN_TRIPLE.app,
      SVC_OVERGRANTED.app,
      SHARED_DIRECT.app,
    ]);

    // 2. Seed real Work Reports domain data via OWNER (NORMAL)
    const today = (await db.query("select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as d")).rows[0].d;
    const t1 = await createPublishedTemplate(db, OWNER, "SVC_RPT_T1", { requiresReview: true });
    const t2 = await createPublishedTemplate(db, OWNER, "SVC_RPT_T2", { requiresReview: false });
    const { rows: [t1VerRow] } = await db.query(
      "select current_published_version_id as version_id from public.work_report_templates where template_id = $1::uuid",
      [t1.template_id],
    );

    const groupA = (await db.query(
      "select public.work_report_create_group($1::uuid, $2::uuid, 'SVC Group A', 'Team A only', $3::uuid[], $4) as res",
      [OWNER.auth, OWNER.app, [STAFF_A1.app], nextKey("svc_grp_a")],
    )).rows[0].res;

    const asgTeamA = (await db.query(
      `select public.work_report_create_assignment(
         $1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null,
         'DAILY', true, 1, '18:00:00'::time, false, $5::date, null, $6
       ) as res`,
      [OWNER.auth, OWNER.app, t1.template_id, TEAM_A, today, nextKey("svc_asg_ta")],
    )).rows[0].res;

    const asgTeamB = (await db.query(
      `select public.work_report_create_assignment(
         $1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null,
         'DAILY', true, 1, '18:00:00'::time, false, $5::date, null, $6
       ) as res`,
      [OWNER.auth, OWNER.app, t1.template_id, TEAM_B, today, nextKey("svc_asg_tb")],
    )).rows[0].res;

    const asgGroupA = (await db.query(
      `select public.work_report_create_group_assignment(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         'DAILY', true, 1, '18:00:00'::time, false, $5::date, null, $6
       ) as res`,
      [OWNER.auth, OWNER.app, t2.template_id, groupA.group_id, today, nextKey("svc_asg_ga")],
    )).rows[0].res;

    // Mixed USER_SET with STAFF_A1 (TEAM_A) + NO_TEAM_USER (NULL current team) — tests SQL 3-valued logic fail-closed!
    const asgUserSetMix = (await db.query(
      `select public.work_report_create_assignment(
         $1::uuid, $2::uuid, $3::uuid, 'USER_SET', null, null, $4::uuid[],
         'DAILY', true, 1, '18:00:00'::time, false, $5::date, null, $6
       ) as res`,
      [OWNER.auth, OWNER.app, t2.template_id, [STAFF_A1.app, NO_TEAM_USER.app], today, nextKey("svc_asg_mix")],
    )).rows[0].res;

    // Also create a delegation by OWNER so revoke_delegation negative test has a real target delegation_id
    const ownerDeleg = (await db.query(
      `select public.work_report_create_delegation(
         $1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid, null, null, $6
       ) as res`,
      [OWNER.auth, OWNER.app, STAFF_A1.app, t1.template_id, TEAM_A, nextKey("svc_del_target")],
    )).rows[0].res;

    const obA1List = (await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as res",
      [STAFF_A1.auth, STAFF_A1.app],
    )).rows[0].res.items;
    const obB1List = (await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as res",
      [STAFF_B1.auth, STAFF_B1.app],
    )).rows[0].res.items;

    const obA1T1 = obA1List.find((o) => o.template_id === t1.template_id);
    const obA1T2 = obA1List.find((o) => o.template_id === t2.template_id);
    const obB1T1 = obB1List.find((o) => o.template_id === t1.template_id);
    assert.ok(obA1T1 && obA1T2 && obB1T1);

    const payloadJson = (calls, notes) => JSON.stringify({
      calls_made: calls,
      interested_candidates: 4,
      workers_started: 1,
      notes,
    });

    await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)",
      [STAFF_A1.auth, STAFF_A1.app, obA1T1.obligation_id, payloadJson(25, "TEAM_A_T1_NOTE"), nextKey("svc_sub_a1_t1")],
    );
    await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)",
      [STAFF_A1.auth, STAFF_A1.app, obA1T2.obligation_id, payloadJson(14, "TEAM_A_T2_NOTE"), nextKey("svc_sub_a1_t2")],
    );
    await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)",
      [STAFF_B1.auth, STAFF_B1.app, obB1T1.obligation_id, payloadJson(99, "TEAM_B_T1_NOTE"), nextKey("svc_sub_b1_t1")],
    );

    // Seed synthetic obligations pointing assignee_app_user_id at SVC_ANALYTICS_ONLY & SVC_TEAM_A (on TEAM_B),
    // plus a NO_TEAM_USER obligation with NULL snapshot_team_id to verify ALL vs CONTEXT_TEAM handling.
    const synthObNoCap = nextUuid();
    const synthObOtherTeam = nextUuid();
    const synthObNullTeam = nextUuid();
    await db.query(
      `insert into public.work_report_obligations
         (obligation_id, template_id, template_version_id, assignment_id, assignee_app_user_id,
          snapshot_team_id, snapshot_team_code, snapshot_team_display_name,
          period_type, period_key, period_start_date, period_end_date, due_at, is_mandatory, obligation_status)
       values
         ($1::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
          $10::uuid, 'SVC_TB', 'Service Team Beta',
          'DAILY', '2026-11-18', '2026-11-18', '2026-11-18', now() + interval '1 day', true, 'ACTIVE'),
         ($2::uuid, $4::uuid, $5::uuid, $6::uuid, $8::uuid,
          $10::uuid, 'SVC_TB', 'Service Team Beta',
          'DAILY', '2026-11-18', '2026-11-18', '2026-11-18', now() + interval '1 day', true, 'ACTIVE'),
         ($3::uuid, $4::uuid, $5::uuid, $6::uuid, $9::uuid,
          null, null, null,
          'DAILY', '2026-11-18', '2026-11-18', '2026-11-18', now() + interval '1 day', true, 'ACTIVE')`,
      [synthObNoCap, synthObOtherTeam, synthObNullTeam, t1.template_id, t1VerRow.version_id, asgTeamB.assignment_id, SVC_ANALYTICS_ONLY.app, SVC_TEAM_A.app, NO_TEAM_USER.app, TEAM_B],
    );

    // Snapshot row counts across all core tables before SERVICE read + deny-write battery
    const snapshotCounts = async () => {
      const { rows: [c] } = await db.query(
        `select
           (select count(*)::int from public.work_report_obligations) as obligations,
           (select count(*)::int from public.work_report_submissions) as submissions,
           (select count(*)::int from public.work_report_templates) as templates,
           (select count(*)::int from public.work_report_assignments) as assignments,
           (select count(*)::int from public.work_report_groups) as groups,
           (select count(*)::int from public.work_report_delegations) as delegations,
           (select count(*)::int from public.work_report_audit_events) as audits`,
      );
      return c;
    };
    const beforeCounts = await snapshotCounts();

    // 3. Build STRICT BEGIN TRANSACTION READ ONLY + SET LOCAL ROLE service_role invoker for ALL read RPCs
    let readOnlyRpcCalls = 0;
    const readOnlyRpc = async (name, args) => {
      readOnlyRpcCalls++;
      await db.exec("begin transaction read only; set local role service_role");
      try {
        let res;
        if (name === "direct_entry_resolve_actor_context") {
          res = (await db.query(
            "select public.direct_entry_resolve_actor_context($1::uuid) as res",
            [args.p_auth_subject],
          )).rows[0]?.res;
        } else if (name === "work_report_list_readable_submissions") {
          res = (await db.query(
            `select public.work_report_list_readable_submissions(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date,
               $7::uuid, $8::uuid, $9::text, $10::text, $11::integer
             ) as res`,
            [
              args.p_auth_subject, args.p_app_user_id,
              args.p_template_id ?? null, args.p_version_id ?? null,
              args.p_from ?? null, args.p_to ?? null,
              args.p_team_id ?? null, args.p_assignee_id ?? null,
              args.p_state ?? null, args.p_cursor ?? null, args.p_limit ?? 50,
            ],
          )).rows[0]?.res;
        } else if (name === "work_report_get_submission") {
          res = (await db.query(
            "select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id, args.p_obligation_id],
          )).rows[0]?.res;
        } else if (name === "work_report_list_templates") {
          res = (await db.query(
            "select public.work_report_list_templates($1::uuid, $2::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id],
          )).rows[0]?.res;
        } else if (name === "work_report_get_template") {
          res = (await db.query(
            "select public.work_report_get_template($1::uuid, $2::uuid, $3::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id, args.p_template_id],
          )).rows[0]?.res;
        } else if (name === "work_report_list_assignments") {
          res = (await db.query(
            "select public.work_report_list_assignments($1::uuid, $2::uuid, $3::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id, args.p_team_id ?? null],
          )).rows[0]?.res;
        } else if (name === "work_report_get_assignment_detail") {
          res = (await db.query(
            "select public.work_report_get_assignment_detail($1::uuid, $2::uuid, $3::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id, args.p_assignment_id],
          )).rows[0]?.res;
        } else if (name === "work_report_analytics_overview") {
          res = (await db.query(
            `select public.work_report_analytics_overview(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, $7::uuid, $8::uuid, $9::text
             ) as res`,
            [
              args.p_auth_subject, args.p_app_user_id,
              args.p_template_id ?? null, args.p_version_id ?? null,
              args.p_from ?? null, args.p_to ?? null,
              args.p_team_id ?? null, args.p_assignee_id ?? null, args.p_finality ?? "final",
            ],
          )).rows[0]?.res;
        } else if (name === "work_report_analytics_breakdown") {
          res = (await db.query(
            `select public.work_report_analytics_breakdown(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date,
               $7::uuid, $8::uuid, $9::text, $10::text, $11::integer, $12::integer
             ) as res`,
            [
              args.p_auth_subject, args.p_app_user_id,
              args.p_template_id ?? null, args.p_version_id ?? null,
              args.p_from ?? null, args.p_to ?? null,
              args.p_team_id ?? null, args.p_assignee_id ?? null,
              args.p_finality ?? "final", args.p_group_by ?? "team",
              args.p_page ?? 1, args.p_page_size ?? 50,
            ],
          )).rows[0]?.res;
        } else if (name === "work_report_analytics_contributions") {
          res = (await db.query(
            `select public.work_report_analytics_contributions(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date,
               $7::uuid, $8::uuid, $9::text, $10::text, $11::text,
               $12::uuid, $13::uuid, $14::text, $15::text, $16::integer
             ) as res`,
            [
              args.p_auth_subject, args.p_app_user_id,
              args.p_template_id ?? null, args.p_version_id ?? null,
              args.p_from ?? null, args.p_to ?? null,
              args.p_team_id ?? null, args.p_assignee_id ?? null,
              args.p_finality ?? "final", args.p_metric_key ?? null, args.p_compatible_group ?? null,
              args.p_target_team_id ?? null, args.p_target_assignee_id ?? null,
              args.p_target_period_key ?? null, args.p_cursor ?? null, args.p_limit ?? 20,
            ],
          )).rows[0]?.res;
        } else if (name === "work_report_analytics_filter_options") {
          res = (await db.query(
            "select public.work_report_analytics_filter_options($1::uuid, $2::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id],
          )).rows[0]?.res;
        } else if (name === "work_report_reconcile_metric_projection") {
          res = (await db.query(
            "select public.work_report_reconcile_metric_projection($1::uuid, $2::uuid, $3::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id, args.p_template_id ?? null],
          )).rows[0]?.res;
        } else if (name === "work_report_has_active_obligations") {
          res = (await db.query(
            "select public.work_report_has_active_obligations($1::uuid, $2::uuid) as res",
            [args.p_auth_subject, args.p_app_user_id],
          )).rows[0]?.res;
        } else {
          throw new Error(`Unexpected readOnlyRpc call: ${name}`);
        }
        await db.exec("commit");
        return { data: res ?? null, error: null };
      } catch (err) {
        await db.exec("rollback");
        return { data: null, error: { code: err.code, message: err.message } };
      }
    };

    // 4. Direct readOnlyRpc verification of SVC_READ_VA (report_view + report_analytics_view @ ALL)
    const vaSubmissions = await readOnlyRpc("work_report_list_readable_submissions", {
      p_auth_subject: SVC_READ_VA.auth,
      p_app_user_id: SVC_READ_VA.app,
    });
    assert.equal(vaSubmissions.error, null);
    assert.equal(vaSubmissions.data.items.length, 3, "Reads all 3 submitted reports across TEAM_A and TEAM_B");

    const vaDetail = await readOnlyRpc("work_report_get_submission", {
      p_auth_subject: SVC_READ_VA.auth,
      p_app_user_id: SVC_READ_VA.app,
      p_obligation_id: obA1T1.obligation_id,
    });
    assert.equal(vaDetail.error, null);
    assert.ok(vaDetail.data);

    const vaAnalytics = await readOnlyRpc("work_report_analytics_overview", {
      p_auth_subject: SVC_READ_VA.auth,
      p_app_user_id: SVC_READ_VA.app,
      p_template_id: t1.template_id,
      p_from: today,
      p_to: today,
      p_finality: "provisional_included",
    });
    assert.equal(vaAnalytics.error, null);
    assert.ok(vaAnalytics.data);

    // SVC_READ_VA does NOT have report_form_manage or report_assign -> MUST fail closed with 42501 on templates & assignments!
    const vaTemplatesDenied = await readOnlyRpc("work_report_list_templates", {
      p_auth_subject: SVC_READ_VA.auth,
      p_app_user_id: SVC_READ_VA.app,
    });
    assert.equal(vaTemplatesDenied.error?.code, "42501");

    const vaAssignmentsDenied = await readOnlyRpc("work_report_list_assignments", {
      p_auth_subject: SVC_READ_VA.auth,
      p_app_user_id: SVC_READ_VA.app,
    });
    assert.equal(vaAssignmentsDenied.error?.code, "42501");

    // 5. Full 5-dataset direct read via SVC_READ_ALL5
    const all5Templates = await readOnlyRpc("work_report_list_templates", {
      p_auth_subject: SVC_READ_ALL5.auth,
      p_app_user_id: SVC_READ_ALL5.app,
    });
    assert.equal(all5Templates.error, null);
    assert.ok(all5Templates.data.templates.length >= 2);

    const all5TplDetail = await readOnlyRpc("work_report_get_template", {
      p_auth_subject: SVC_READ_ALL5.auth,
      p_app_user_id: SVC_READ_ALL5.app,
      p_template_id: t1.template_id,
    });
    assert.equal(all5TplDetail.error, null);
    assert.equal(all5TplDetail.data.template_id, t1.template_id);

    const all5Assignments = await readOnlyRpc("work_report_list_assignments", {
      p_auth_subject: SVC_READ_ALL5.auth,
      p_app_user_id: SVC_READ_ALL5.app,
    });
    assert.equal(all5Assignments.error, null);
    assert.equal(all5Assignments.data.assignments.length, 4);

    const all5AssignmentDetail = await readOnlyRpc("work_report_get_assignment_detail", {
      p_auth_subject: SVC_READ_ALL5.auth,
      p_app_user_id: SVC_READ_ALL5.app,
      p_assignment_id: asgTeamA.assignment_id,
    });
    assert.equal(all5AssignmentDetail.error, null);
    assert.equal(all5AssignmentDetail.data.assignment.assignment_id, asgTeamA.assignment_id);

    // 6. Strict per-capability isolation: SVC_ANALYTICS_ONLY can read analytics ONLY
    const anOnlyOverview = await readOnlyRpc("work_report_analytics_overview", {
      p_auth_subject: SVC_ANALYTICS_ONLY.auth,
      p_app_user_id: SVC_ANALYTICS_ONLY.app,
      p_template_id: t1.template_id,
      p_from: today,
      p_to: today,
      p_finality: "provisional_included",
    });
    assert.equal(anOnlyOverview.error, null);
    assert.equal((await readOnlyRpc("work_report_analytics_filter_options", {
      p_auth_subject: SVC_ANALYTICS_ONLY.auth,
      p_app_user_id: SVC_ANALYTICS_ONLY.app,
    })).error, null);
    assert.equal((await readOnlyRpc("work_report_reconcile_metric_projection", {
      p_auth_subject: SVC_ANALYTICS_ONLY.auth,
      p_app_user_id: SVC_ANALYTICS_ONLY.app,
      p_template_id: t1.template_id,
    })).error, null);

    for (const [fnName, args] of [
      ["work_report_list_readable_submissions", { p_auth_subject: SVC_ANALYTICS_ONLY.auth, p_app_user_id: SVC_ANALYTICS_ONLY.app }],
      ["work_report_get_submission", { p_auth_subject: SVC_ANALYTICS_ONLY.auth, p_app_user_id: SVC_ANALYTICS_ONLY.app, p_obligation_id: obA1T1.obligation_id }],
      // Personal assignee bypass attempt on synthetic obligation assigned to SVC_ANALYTICS_ONLY
      ["work_report_get_submission", { p_auth_subject: SVC_ANALYTICS_ONLY.auth, p_app_user_id: SVC_ANALYTICS_ONLY.app, p_obligation_id: synthObNoCap }],
      ["work_report_analytics_contributions", { p_auth_subject: SVC_ANALYTICS_ONLY.auth, p_app_user_id: SVC_ANALYTICS_ONLY.app, p_template_id: t1.template_id, p_metric_key: "calls_made" }],
      ["work_report_list_templates", { p_auth_subject: SVC_ANALYTICS_ONLY.auth, p_app_user_id: SVC_ANALYTICS_ONLY.app }],
      ["work_report_get_template", { p_auth_subject: SVC_ANALYTICS_ONLY.auth, p_app_user_id: SVC_ANALYTICS_ONLY.app, p_template_id: t1.template_id }],
      ["work_report_list_assignments", { p_auth_subject: SVC_ANALYTICS_ONLY.auth, p_app_user_id: SVC_ANALYTICS_ONLY.app }],
      ["work_report_get_assignment_detail", { p_auth_subject: SVC_ANALYTICS_ONLY.auth, p_app_user_id: SVC_ANALYTICS_ONLY.app, p_assignment_id: asgTeamA.assignment_id }],
    ]) {
      const denied = await readOnlyRpc(fnName, args);
      assert.equal(denied.error?.code, "42501", `SVC_ANALYTICS_ONLY must be denied ${fnName}`);
    }

    // 7. Strict CONTEXT_TEAM isolation (SVC_TEAM_A): reads TEAM_A only; denied TEAM_B, mixed USER_SET with NULL team, and template ALL-only readers
    const teamASubs = await readOnlyRpc("work_report_list_readable_submissions", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
    });
    assert.equal(teamASubs.error, null);
    assert.equal(teamASubs.data.effective_scope.kind, "team");
    assert.equal(teamASubs.data.items.length, 2, "SVC_TEAM_A sees only TEAM_A submissions");
    assert.ok(teamASubs.data.items.every((i) => i.team_id === TEAM_A));

    assert.equal((await readOnlyRpc("work_report_get_submission", {
      p_auth_subject: SVC_READ_VA.auth,
      p_app_user_id: SVC_READ_VA.app,
      p_obligation_id: synthObNullTeam,
    })).error, null, "SVC_READ_VA @ ALL can read NULL snapshot_team_id obligation");
    assert.equal((await readOnlyRpc("work_report_analytics_contributions", {
      p_auth_subject: SVC_READ_VA.auth,
      p_app_user_id: SVC_READ_VA.app,
      p_template_id: t1.template_id,
      p_from: today,
      p_to: today,
      p_finality: "provisional_included",
      p_metric_key: "calls_made",
    })).error, null, "SVC_READ_VA with report_analytics_view + report_view @ ALL reads analytics_contributions");

    assert.equal((await readOnlyRpc("work_report_get_submission", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_obligation_id: obA1T1.obligation_id,
    })).error, null);
    assert.equal((await readOnlyRpc("work_report_get_submission", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_obligation_id: synthObNullTeam,
    })).error?.code, "42501", "SVC_TEAM_A denied NULL snapshot_team_id obligation");
    assert.equal((await readOnlyRpc("work_report_analytics_contributions", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_template_id: t1.template_id,
      p_from: today,
      p_to: today,
      p_team_id: TEAM_A,
      p_finality: "provisional_included",
      p_metric_key: "calls_made",
    })).error, null, "SVC_TEAM_A reads TEAM_A analytics_contributions");
    assert.equal((await readOnlyRpc("work_report_analytics_contributions", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_template_id: t1.template_id,
      p_from: today,
      p_to: today,
      p_team_id: TEAM_B,
      p_finality: "provisional_included",
      p_metric_key: "calls_made",
    })).error?.code, "42501", "SVC_TEAM_A denied TEAM_B analytics_contributions");
    assert.equal((await readOnlyRpc("work_report_get_submission", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_obligation_id: obB1T1.obligation_id,
    })).error?.code, "42501", "SVC_TEAM_A denied TEAM_B submission");
    assert.equal((await readOnlyRpc("work_report_get_submission", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_obligation_id: synthObOtherTeam,
    })).error?.code, "42501", "SVC_TEAM_A denied synthetic personal-assignee bypass on TEAM_B");
    assert.equal((await readOnlyRpc("work_report_list_readable_submissions", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_team_id: TEAM_B,
    })).error?.code, "42501", "SVC_TEAM_A denied TEAM_B filter on submissions");
    assert.equal((await readOnlyRpc("work_report_analytics_overview", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_team_id: TEAM_B,
    })).error?.code, "42501", "SVC_TEAM_A denied TEAM_B filter on analytics");

    const teamAAsgs = await readOnlyRpc("work_report_list_assignments", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
    });
    assert.equal(teamAAsgs.error, null);
    const teamAAsgIds = teamAAsgs.data.items.map((a) => a.assignment_id).sort();
    assert.deepEqual(
      teamAAsgIds,
      [asgTeamA.assignment_id, asgGroupA.assignment_id].sort(),
      "SVC_TEAM_A sees only TEAM_A & Group-A assignments — excludes TEAM_B AND mixed USER_SET with teamless user",
    );
    assert.equal((await readOnlyRpc("work_report_get_assignment_detail", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_assignment_id: asgTeamA.assignment_id,
    })).error, null);
    assert.equal((await readOnlyRpc("work_report_get_assignment_detail", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_assignment_id: asgTeamB.assignment_id,
    })).error?.code, "42501", "SVC_TEAM_A denied TEAM_B assignment detail");
    assert.equal((await readOnlyRpc("work_report_get_assignment_detail", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_assignment_id: asgUserSetMix.assignment_id,
    })).error?.code, "42501", "SVC_TEAM_A denied mixed USER_SET with teamless user");

    // report_form_manage @ CONTEXT_TEAM must still fail with WORK_REPORT_ALL_SCOPE_REQUIRED
    const teamATplDenied = await readOnlyRpc("work_report_list_templates", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
    });
    assert.equal(teamATplDenied.error?.code, "42501");
    assert.match(teamATplDenied.error?.message ?? "", /WORK_REPORT_ALL_SCOPE_REQUIRED/);
    const teamAGetTplDenied = await readOnlyRpc("work_report_get_template", {
      p_auth_subject: SVC_TEAM_A.auth,
      p_app_user_id: SVC_TEAM_A.app,
      p_template_id: t1.template_id,
    });
    assert.equal(teamAGetTplDenied.error?.code, "42501");
    assert.match(teamAGetTplDenied.error?.message ?? "", /WORK_REPORT_ALL_SCOPE_REQUIRED/);

    // 8. ZERO Full Admin override for SERVICE (SVC_ADMIN_TRIPLE has entry_admin + recruiter_master_manage + team_master_manage @ ALL, no report_*)
    for (const [fnName, args] of [
      ["work_report_list_readable_submissions", { p_auth_subject: SVC_ADMIN_TRIPLE.auth, p_app_user_id: SVC_ADMIN_TRIPLE.app }],
      ["work_report_get_submission", { p_auth_subject: SVC_ADMIN_TRIPLE.auth, p_app_user_id: SVC_ADMIN_TRIPLE.app, p_obligation_id: obA1T1.obligation_id }],
      ["work_report_analytics_overview", { p_auth_subject: SVC_ADMIN_TRIPLE.auth, p_app_user_id: SVC_ADMIN_TRIPLE.app }],
      ["work_report_list_templates", { p_auth_subject: SVC_ADMIN_TRIPLE.auth, p_app_user_id: SVC_ADMIN_TRIPLE.app }],
      ["work_report_get_template", { p_auth_subject: SVC_ADMIN_TRIPLE.auth, p_app_user_id: SVC_ADMIN_TRIPLE.app, p_template_id: t1.template_id }],
      ["work_report_list_assignments", { p_auth_subject: SVC_ADMIN_TRIPLE.auth, p_app_user_id: SVC_ADMIN_TRIPLE.app }],
      ["work_report_get_assignment_detail", { p_auth_subject: SVC_ADMIN_TRIPLE.auth, p_app_user_id: SVC_ADMIN_TRIPLE.app, p_assignment_id: asgTeamA.assignment_id }],
    ]) {
      const denied = await readOnlyRpc(fnName, args);
      assert.equal(denied.error?.code, "42501", `SVC_ADMIN_TRIPLE must NEVER receive Full Admin override on ${fnName}`);
    }

    // 9. SHARED account with ALL 4 direct read grants @ ALL & wrong auth_subject mapping MUST fail closed (42501 WORK_REPORT_ACTOR_DENIED)
    for (const [fnName, args] of [
      ["work_report_list_readable_submissions", { p_auth_subject: SHARED_DIRECT.auth, p_app_user_id: SHARED_DIRECT.app }],
      ["work_report_get_submission", { p_auth_subject: SHARED_DIRECT.auth, p_app_user_id: SHARED_DIRECT.app, p_obligation_id: obA1T1.obligation_id }],
      ["work_report_analytics_overview", { p_auth_subject: SHARED_DIRECT.auth, p_app_user_id: SHARED_DIRECT.app }],
      ["work_report_list_templates", { p_auth_subject: SHARED_DIRECT.auth, p_app_user_id: SHARED_DIRECT.app }],
      ["work_report_list_assignments", { p_auth_subject: SHARED_DIRECT.auth, p_app_user_id: SHARED_DIRECT.app }],
      // Wrong auth_subject mapping
      ["work_report_list_readable_submissions", { p_auth_subject: OWNER.auth, p_app_user_id: SVC_READ_ALL5.app }],
      ["work_report_analytics_overview", { p_auth_subject: OWNER.auth, p_app_user_id: SVC_READ_ALL5.app }],
    ]) {
      const denied = await readOnlyRpc(fnName, args);
      assert.equal(denied.error?.code, "42501", `SHARED / mismatched auth_subject must be denied on ${fnName}`);
      assert.match(denied.error?.message ?? "", /WORK_REPORT_ACTOR_DENIED/);
    }

    // 10. EXHAUSTIVE DENY-WRITE & DENY-PERSONAL MATRIX:
    //     SVC_OVERGRANTED holds ALL 6 report_* @ ALL direct grants, yet MUST be DENIED (42501) on ALL 19 mutating/personal RPCs
    //     AND all 5 interactive human-only UI queue/picker RPCs!
    const svcContext = (await readOnlyRpc("direct_entry_resolve_actor_context", {
      p_auth_subject: SVC_OVERGRANTED.auth,
    })).data;
    assert.equal("effective_report_review_scopes" in svcContext, false, "SERVICE never receives effective_report_review_scopes");

    const svcProbe = await readOnlyRpc("work_report_has_active_obligations", {
      p_auth_subject: SVC_OVERGRANTED.auth,
      p_app_user_id: SVC_OVERGRANTED.app,
    });
    assert.equal(svcProbe.error, null);
    assert.deepEqual(svcProbe.data, { has_active_obligations: false });

    const assertServiceRoleDenied42501 = async (label, sql, params) => {
      await db.exec("begin; set local role service_role");
      let caught = null;
      try {
        await db.query(sql, params);
        await db.exec("commit");
      } catch (err) {
        caught = err;
        await db.exec("rollback");
      }
      assert.ok(caught, `SVC_OVERGRANTED MUST be denied on ${label}`);
      assert.equal(caught.code, "42501", `SVC_OVERGRANTED on ${label} must raise 42501 (got ${caught.code}: ${caught.message})`);
    };

    const schemaJson = JSON.stringify(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
    const metricsJson = JSON.stringify(buildWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA));

    // All 5 template writers
    await assertServiceRoleDenied42501(
      "work_report_create_template",
      "select public.work_report_create_template($1::uuid, $2::uuid, 'SVC_TPL', 'SVC', 'desc', 'DAILY', $3::jsonb, $4::jsonb, $5)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, schemaJson, metricsJson, nextKey("deny_ctpl")],
    );
    await assertServiceRoleDenied42501(
      "work_report_update_template_draft",
      "select public.work_report_update_template_draft($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'SVC', 'desc', 'DAILY', $5::jsonb, $6::jsonb, $7)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, t1.template_id, t1VerRow.version_id, schemaJson, metricsJson, nextKey("deny_utpl")],
    );
    await assertServiceRoleDenied42501(
      "work_report_publish_template",
      "select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, t1.template_id, t1VerRow.version_id, nextKey("deny_ptpl")],
    );
    await assertServiceRoleDenied42501(
      "work_report_archive_template",
      "select public.work_report_archive_template($1::uuid, $2::uuid, $3::uuid, 1, $4)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, t1.template_id, nextKey("deny_atpl")],
    );
    await assertServiceRoleDenied42501(
      "work_report_clone_template_draft",
      "select public.work_report_clone_template_draft($1::uuid, $2::uuid, $3::uuid, 1, $4)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, t1.template_id, nextKey("deny_cltpl")],
    );

    // All 3 group writers
    await assertServiceRoleDenied42501(
      "work_report_create_group",
      "select public.work_report_create_group($1::uuid, $2::uuid, 'SVC Bad Group', null, $3::uuid[], $4)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, [STAFF_A1.app], nextKey("deny_cgrp")],
    );
    await assertServiceRoleDenied42501(
      "work_report_update_group",
      "select public.work_report_update_group($1::uuid, $2::uuid, $3::uuid, 1, 'SVC Renamed', null, $4::uuid[], $5)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, groupA.group_id, [STAFF_A1.app], nextKey("deny_ugrp")],
    );
    await assertServiceRoleDenied42501(
      "work_report_set_group_active",
      "select public.work_report_set_group_active($1::uuid, $2::uuid, $3::uuid, 1, false, $4)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, groupA.group_id, nextKey("deny_agrp")],
    );

    // All 5 assignment & obligation writers
    await assertServiceRoleDenied42501(
      "work_report_create_assignment",
      `select public.work_report_create_assignment(
         $1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null,
         'DAILY', true, 1, '18:00:00'::time, false, $5::date, null, $6
       )`,
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, t1.template_id, TEAM_A, today, nextKey("deny_casg")],
    );
    await assertServiceRoleDenied42501(
      "work_report_create_group_assignment",
      `select public.work_report_create_group_assignment(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         'DAILY', true, 1, '18:00:00'::time, false, $5::date, null, $6
       )`,
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, t1.template_id, groupA.group_id, today, nextKey("deny_cgasg")],
    );
    await assertServiceRoleDenied42501(
      "work_report_set_assignment_state",
      "select public.work_report_set_assignment_state($1::uuid, $2::uuid, $3::uuid, 1, 'PAUSED', $4)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, asgTeamA.assignment_id, nextKey("deny_sasg")],
    );
    await assertServiceRoleDenied42501(
      "work_report_change_obligation_status",
      "select public.work_report_change_obligation_status($1::uuid, $2::uuid, $3::uuid, 1, 'EXEMPT', 'denied', null, $4)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, obA1T1.obligation_id, nextKey("deny_cobs")],
    );
    await assertServiceRoleDenied42501(
      "work_report_ensure_obligations_for_window",
      "select public.work_report_ensure_obligations_for_window($1::uuid, $2::uuid, $3::date)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, today],
    );

    // All 3 review & delegation writers
    await assertServiceRoleDenied42501(
      "work_report_decide_review",
      "select public.work_report_decide_review($1::uuid, $2::uuid, $3::uuid, 'APPROVE', null, 1, $4)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, obA1T1.obligation_id, nextKey("deny_rev")],
    );
    await assertServiceRoleDenied42501(
      "work_report_create_delegation",
      "select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'all', null, null, null, $5)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, STAFF_A1.app, t1.template_id, nextKey("deny_cdel")],
    );
    await assertServiceRoleDenied42501(
      "work_report_revoke_delegation",
      "select public.work_report_revoke_delegation($1::uuid, $2::uuid, $3::uuid, 1, $4)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, ownerDeleg.delegation_id, nextKey("deny_rdel")],
    );

    // All 3 personal obligation/submission mutators (including list_my_obligations materializer!)
    await assertServiceRoleDenied42501(
      "work_report_list_my_obligations",
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE')",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app],
    );
    await assertServiceRoleDenied42501(
      "work_report_save_draft",
      "select public.work_report_save_draft($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, obA1T1.obligation_id, payloadJson(1, "NO"), nextKey("deny_draft")],
    );
    await assertServiceRoleDenied42501(
      "work_report_submit",
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, obA1T1.obligation_id, payloadJson(1, "NO"), nextKey("deny_sub")],
    );

    // All 5 interactive human-only UI queue/picker RPCs
    await assertServiceRoleDenied42501(
      "work_report_list_groups",
      "select public.work_report_list_groups($1::uuid, $2::uuid)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app],
    );
    await assertServiceRoleDenied42501(
      "work_report_list_assignment_options",
      "select public.work_report_list_assignment_options($1::uuid, $2::uuid, null)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app],
    );
    await assertServiceRoleDenied42501(
      "work_report_list_delegations",
      "select public.work_report_list_delegations($1::uuid, $2::uuid)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app],
    );
    await assertServiceRoleDenied42501(
      "work_report_list_pending_reviews",
      "select public.work_report_list_pending_reviews($1::uuid, $2::uuid, null, null, 50)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app],
    );
    await assertServiceRoleDenied42501(
      "work_report_get_review_submission",
      "select public.work_report_get_review_submission($1::uuid, $2::uuid, $3::uuid)",
      [SVC_OVERGRANTED.auth, SVC_OVERGRANTED.app, obA1T1.obligation_id],
    );

    // Verify ZERO writes occurred across all 7 tables during entire SERVICE read + deny-write battery!
    const afterCounts = await snapshotCounts();
    assert.deepEqual(afterCounts, beforeCounts, "SERVICE reads & denied writes must produce ZERO DB side-effects");
    assert.ok(readOnlyRpcCalls >= 25, "All SERVICE reads executed strictly inside BEGIN TRANSACTION READ ONLY");

    // 11. Immediate revocation & disable enforcement for SERVICE
    await db.query(
      `update public.authz_direct_capability_grants
          set ended_at = greatest(started_at, clock_timestamp()),
              ended_by_app_user_id = $2::uuid,
              ended_reason = 'Revoke report_view in fixture'
        where app_user_id = $1::uuid
          and capability = 'report_view'`,
      [SVC_READ_VA.app, OWNER.app],
    );
    const afterRevokeSub = await readOnlyRpc("work_report_list_readable_submissions", {
      p_auth_subject: SVC_READ_VA.auth,
      p_app_user_id: SVC_READ_VA.app,
    });
    assert.equal(afterRevokeSub.error?.code, "42501", "Revoking report_view immediately denies SERVICE reader");

    await db.query(
      "update public.direct_entry_app_users set enabled = false where app_user_id = $1::uuid",
      [SVC_READ_ALL5.app],
    );
    for (const [fnName, args] of [
      ["work_report_list_readable_submissions", { p_auth_subject: SVC_READ_ALL5.auth, p_app_user_id: SVC_READ_ALL5.app }],
      ["work_report_analytics_overview", { p_auth_subject: SVC_READ_ALL5.auth, p_app_user_id: SVC_READ_ALL5.app }],
      ["work_report_list_templates", { p_auth_subject: SVC_READ_ALL5.auth, p_app_user_id: SVC_READ_ALL5.app }],
      ["work_report_list_assignments", { p_auth_subject: SVC_READ_ALL5.auth, p_app_user_id: SVC_READ_ALL5.app }],
    ]) {
      const denied = await readOnlyRpc(fnName, args);
      assert.equal(denied.error?.code, "42501", `Disabled SERVICE actor denied on ${fnName}`);
      assert.match(denied.error?.message ?? "", /WORK_REPORT_ACTOR_DENIED/);
    }
  } finally {
    await db.close();
  }
});
