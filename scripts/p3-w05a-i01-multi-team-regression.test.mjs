/**
 * P3-W05A-I01-R1 - multi-team actor-scoped reporting regression (real DB).
 *
 * Proves the DB-authoritative audience for an actor holding SEVERAL effective
 * team scope grants: the audience is `team`, it carries exactly the effective
 * team ids, the facts are the union of those teams without double counting, and
 * no external-source metadata/options leak into a team response.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

import {
  audienceTeamScopeCount,
  resolveAudienceScopeLabel,
  resolveReportingAudienceProjection,
} from "../src/lib/reporting/p3-w05a-audience.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM_A = uuid(11), TEAM_B = uuid(12), TEAM_C = uuid(13);
const REC_A1 = uuid(21), REC_B1 = uuid(22), REC_C1 = uuid(23);
const AUTH_MULTI = uuid(31), APP_MULTI = uuid(41);
const AUTH_DISABLED = uuid(32), APP_DISABLED = uuid(42);
const AUTH_FORGED = uuid(33);
const AUTH_INACTIVE_SCOPE = uuid(34), APP_INACTIVE_SCOPE = uuid(44);
const AUTH_OWN_NO_LINK = uuid(35), APP_OWN_NO_LINK = uuid(45);
const DS1 = uuid(61), RUN1 = uuid(62);

const E1 = uuid(101), E2 = uuid(102), E3 = uuid(103), E4 = uuid(104);
const S1 = uuid(201), S2 = uuid(202), S3 = uuid(203), S4 = uuid(204);
const C1 = uuid(301), C2 = uuid(302), C3 = uuid(303), C4 = uuid(304);

const OMITTED = { state: "omitted" };
function workerDetails(name) {
  return { display_name: name, date_of_birth: OMITTED, national_id: OMITTED, address: OMITTED, phone: OMITTED };
}

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  for (const name of names) await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  return db;
}

async function insertEntry(db, { entry, sub, cand, createdBy, project, date, code, recruiter, team, provider, labor }) {
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [cand]);
    await db.query("insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1,$2,'DRAFT')", [sub, createdBy]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id, project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type) " +
      "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [entry, sub, cand, createdBy, project, date, code, JSON.stringify(workerDetails("Worker " + code)), recruiter, team, provider, labor],
    );
    await seedLegacyReviewSubmission(db, sub);
    await db.query("update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1", [sub]);
    await db.exec("commit");
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

async function seedFixture(db) {
  for (const [auth, app] of [
    [AUTH_MULTI, APP_MULTI],
    [AUTH_DISABLED, APP_DISABLED],
    [AUTH_INACTIVE_SCOPE, APP_INACTIVE_SCOPE],
    [AUTH_OWN_NO_LINK, APP_OWN_NO_LINK],
  ]) {
    await db.query("insert into auth.users (id) values ($1)", [auth]);
    await db.query("insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')", [app, auth]);
  }

  for (const [team, code, name] of [[TEAM_A, "TEAM_A", "Team Alpha"], [TEAM_B, "TEAM_B", "Team Beta"], [TEAM_C, "TEAM_C", "Team Gamma"]]) {
    await db.query("insert into public.teams (team_id, code, display_name) values ($1,$2,$3)", [team, code, name]);
  }
  for (const [rec, team, name, key] of [
    [REC_A1, TEAM_A, "Recruiter A1", "rec a1"],
    [REC_B1, TEAM_B, "Recruiter B1", "rec b1"],
    [REC_C1, TEAM_C, "Recruiter C1", "rec c1"],
  ]) {
    await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,$2)", [rec, name]);
    await db.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1,'hrp','2020-01-01',true)", [rec]);
    await db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1,$2,'2020-01-01',true)", [rec, team]);
    await db.query("insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from) values ($1,$2,'2020-01-01')", [rec, key]);
  }
  for (const [project, name] of [["proj_a", "Project A"], ["proj_b", "Project B"], ["proj_c", "Project C"]]) {
    await db.query("insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)", [project, name]);
  }

  // Multi-team actor: verified link plus a synthetic own grant, then TWO
  // effective team grants and out-of-scope ineffective team grants.
  await db.query("insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)", [APP_MULTI, REC_A1]);
  await db.query("insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1,'entry_own','2020-01-01',true), ($1,'entry_team','2020-01-01',true)", [APP_MULTI]);
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1,'own',null,'2020-01-01',true)", [APP_MULTI]);
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1,'team',$2,'2020-01-01',true)", [APP_MULTI, TEAM_A]);
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1,'team',$2,'2020-01-01',true)", [APP_MULTI, TEAM_B]);
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to) values ($1,'team',$2,'2020-01-01','2021-01-01')", [APP_MULTI, TEAM_C]);
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,'team',$2,(select public.direct_entry_authorization_date() + 1))", [APP_MULTI, TEAM_C]);

  // Actor whose only team grant is already expired.
  await db.query("insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1,'entry_team','2020-01-01',true)", [APP_INACTIVE_SCOPE]);
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to) values ($1,'team',$2,'2020-01-01','2021-01-01')", [APP_INACTIVE_SCOPE, TEAM_A]);
  // Actor with an explicit own scope but no verified recruiter link.
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1,'own',null,'2020-01-01',true)", [APP_OWN_NO_LINK]);
  // Disabled actor.
  await db.query("update public.direct_entry_app_users set enabled=false where app_user_id=$1", [APP_DISABLED]);

  await insertEntry(db, { entry: E1, sub: S1, cand: C1, createdBy: APP_MULTI, project: "proj_a", date: "2026-10-10", code: "hrp-2026-000101", recruiter: REC_A1, team: TEAM_A, provider: "hrp", labor: "TEMPORARY" });
  await insertEntry(db, { entry: E2, sub: S2, cand: C2, createdBy: APP_MULTI, project: "proj_a", date: "2026-10-10", code: "hrp-2026-000102", recruiter: REC_A1, team: TEAM_A, provider: "hrp", labor: "TEMPORARY" });
  await insertEntry(db, { entry: E3, sub: S3, cand: C3, createdBy: APP_MULTI, project: "proj_b", date: "2026-10-11", code: "hrp-2026-000103", recruiter: REC_B1, team: TEAM_B, provider: "hrp", labor: "PERMANENT" });
  await insertEntry(db, { entry: E4, sub: S4, cand: C4, createdBy: APP_MULTI, project: "proj_c", date: "2026-10-12", code: "hrp-2026-000104", recruiter: REC_C1, team: TEAM_C, provider: "hrp", labor: "TEMPORARY" });

  // A retired aggregate row stays in the fixture to prove the live report ignores it.
  await db.query("insert into public.data_sources (id, drive_file_id, file_name, sheet_name, active, is_test) values ($1,'legacy','legacy.xlsx','Sheet1',true,false)", [DS1]);
  await db.query("insert into public.sync_runs (run_id, source_id, trigger_type, status, started_at, finished_at) values ($1,$2,'manual','succeeded','2026-10-05T00:00:00Z','2026-10-05T00:00:00Z')", [RUN1, DS1]);
  await db.query(
    "insert into public.daily_recruitment_breakdown " +
    "(source_id, business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count, sync_run_id, snapshot_at) " +
    // This historical row is not part of the Direct Entry reporting dataset.
    "values ($1,'1999-12-31','legacy_proj','Legacy Project','legacy_rec','Legacy Recruiter','hrp','HRP','thời vụ','Thời vụ',7,$2,'2026-10-05T00:00:00Z')",
    [DS1, RUN1],
  );
}

async function audienceOf(db, app, auth) {
  const r = await db.query("select public.direct_entry_reporting_resolve_audience($1::uuid,$2::uuid) as data", [auth, app]);
  return r.rows[0].data;
}
async function factsOf(db, app, auth, filters = {}) {
  const r = await db.query("select public.direct_entry_reporting_scoped_facts($1::uuid,$2::uuid,$3::jsonb) as data", [auth, app, JSON.stringify(filters)]);
  return r.rows[0].data;
}
async function optionsOf(db, app, auth) {
  const r = await db.query("select public.direct_entry_reporting_scoped_options($1::uuid,$2::uuid) as data", [auth, app]);
  return r.rows[0].data;
}

async function withFixture(fn) {
  const db = await buildDb();
  try {
    await seedFixture(db);
    await fn(db);
  } finally {
    await db.close();
  }
}

test("W05A multi-team: the DB resolves audience team with exactly the effective team ids", async () => {
  await withFixture(async (db) => {
    const aud = await audienceOf(db, APP_MULTI, AUTH_MULTI);
    assert.equal(aud.audience, "team", "two effective team grants must outrank the synthetic own scope");
    assert.deepEqual([...aud.team_ids].sort(), [TEAM_A, TEAM_B].sort(), "audience must carry every effective team id");
    assert.equal(aud.team_ids.length, 2, "out-of-scope team grants must not be counted");
    assert.equal(aud.recruiter_id, null);
    assert.ok(!aud.team_ids.includes(TEAM_C), "TEAM_C scope is expired/future and must be excluded");
  });
});

test("W05A multi-team: facts are the union of both effective teams only", async () => {
  await withFixture(async (db) => {
    const res = await factsOf(db, APP_MULTI, AUTH_MULTI);
    const ids = res.facts.map((f) => f.entry_id).sort();
    assert.deepEqual(ids, [E1, E2, E3].sort(), "team facts must be the union of TEAM_A and TEAM_B");
    assert.ok(!ids.includes(E4), "a TEAM_C entry is outside the effective team scope");
    for (const f of res.facts) {
      assert.ok(["recruiter a1", "recruiter b1"].includes(f.recruiter_key), "no out-of-scope recruiter may appear");
      assert.ok(["project a", "project b"].includes(f.project_key), "no out-of-scope project may appear");
    }
  });
});

test("W05A multi-team: no double counting across several scopes or memberships", async () => {
  await withFixture(async (db) => {
    const res = await factsOf(db, APP_MULTI, AUTH_MULTI);
    assert.equal(res.facts.length, 3, "three distinct eligible entries, not four");
    assert.equal(res.facts.reduce((a, f) => a + f.recruited_count, 0), 3, "aggregate equals the distinct allowed facts");
    const g1 = res.facts.find((f) => f.entry_id === E1);
    const g2 = res.facts.find((f) => f.entry_id === E2);
    assert.equal(g1.recruited_count, 1);
    assert.equal(g2.recruited_count, 1);
    assert.equal(
      [g1.business_date, g1.project_key, g1.recruiter_key, g1.employment_type_key].join("|"),
      [g2.business_date, g2.project_key, g2.recruiter_key, g2.employment_type_key].join("|"),
      "E1 and E2 share the ReportingFact grain but must stay two rows",
    );
  });
});

test("W05A multi-team: non-current historical and scheduled grants never widen the scope", async () => {
  await withFixture(async (db) => {
    const aud = await audienceOf(db, APP_MULTI, AUTH_MULTI);
    assert.equal(audienceTeamScopeCount(aud), 2, "only the two effective grants count");
    const res = await factsOf(db, APP_MULTI, AUTH_MULTI);
    assert.equal(res.facts.some((f) => f.entry_id === E4), false, "the expired/future team contributes nothing");
    assert.equal(res.facts.some((f) => f.team_id === TEAM_C || f.recruiter_key === "recruiter c1"), false);
  });
});

test("W05A R1: current scope marker, not valid_from, controls team authorization", async () => {
  await withFixture(async (db) => {
    const futureStart = (await db.query(
      "select (public.direct_entry_authorization_date() + 1)::text as date",
    )).rows[0].date;
    await db.query(
      `update public.direct_entry_scope_grants set valid_from = $1
        where app_user_id = $2 and scope_kind = 'team' and team_id = $3`,
      [futureStart, APP_MULTI, TEAM_A],
    );
    assert.equal((await db.query(
      `select is_current from public.direct_entry_scope_grants
        where app_user_id = $1 and scope_kind = 'team' and team_id = $2`,
      [APP_MULTI, TEAM_A],
    )).rows[0].is_current, true, "the active grant marker survives a date change");
    const audience = await audienceOf(db, APP_MULTI, AUTH_MULTI);
    assert.equal(audience.audience, "team");
    assert.deepEqual([...audience.team_ids].sort(), [TEAM_A, TEAM_B].sort());
  });
});

test("W05A multi-team: external-source metadata and options stay empty for a team audience", async () => {
  await withFixture(async (db) => {
    const res = await factsOf(db, APP_MULTI, AUTH_MULTI);
    assert.deepEqual(res.sources, [], "a team audience must not receive the source registry");
    assert.deepEqual(res.latest_runs, [], "a team audience must not receive sync status");
    assert.deepEqual(res.presence, [], "a team audience must not receive source presence");
    const opts = await optionsOf(db, APP_MULTI, AUTH_MULTI);
    assert.deepEqual(opts.sources, [], "team filter options must not expose legacy sources");
    const projects = opts.dimensions.filter((d) => d.dimension === "project").map((d) => d.key).sort();
    const recruiters = opts.dimensions.filter((d) => d.dimension === "recruiter").map((d) => d.key).sort();
    assert.deepEqual(projects, ["project a", "project b"]);
    assert.deepEqual(recruiters, ["recruiter a1", "recruiter b1"]);
    assert.equal(projects.includes("project c"), false);
    assert.equal(recruiters.includes("recruiter c1"), false);
    assert.equal(opts.dimensions.some((d) => d.key === "legacy_proj" || d.key === "legacy_rec"), false);
  });
});

test("W05A multi-team: the server label stays inclusive and leaks no team UUID", async () => {
  await withFixture(async (db) => {
    const aud = await audienceOf(db, APP_MULTI, AUTH_MULTI);
    // End to end: the raw DB payload is what the server projects into the label.
    const projection = resolveReportingAudienceProjection(aud);
    assert.ok(projection, "a valid DB audience must project");
    assert.equal(projection.kind, "team");
    assert.equal(projection.label, "Team Alpha và 1 nhóm khác", "a multi-team scope must not read as one named team");
    for (const id of [TEAM_A, TEAM_B, TEAM_C, REC_A1, REC_B1, REC_C1, APP_MULTI]) {
      assert.equal(projection.label.includes(id), false, "no internal UUID may reach the label");
    }
    assert.equal(UUID_PATTERN.test(projection.label), false, "the label must not contain any UUID-shaped token");
    // A single-team scope keeps the DB label verbatim.
    assert.equal(resolveAudienceScopeLabel({ kind: "team", label: aud.label }, 1), "Team Alpha");
    assert.equal(audienceTeamScopeCount(aud), 2);
  });
});

test("W05A: a missing or malformed audience projection fails closed", () => {
  assert.equal(resolveReportingAudienceProjection(null), null);
  assert.equal(resolveReportingAudienceProjection(undefined), null);
  assert.equal(resolveReportingAudienceProjection({}), null);
  assert.equal(resolveReportingAudienceProjection({ audience: "", label: "x" }), null);
  assert.equal(resolveReportingAudienceProjection({ audience: "admin", label: "x" }), null);
  // Valid payloads still project, with the same inclusive-label rule.
  assert.deepEqual(
    resolveReportingAudienceProjection({ audience: "all", label: "Toàn công ty", team_ids: [] }),
    { kind: "all", label: "Toàn công ty" },
  );
  assert.deepEqual(
    resolveReportingAudienceProjection({ audience: "team", label: "Team Alpha", team_ids: ["a"] }),
    { kind: "team", label: "Team Alpha" },
  );
  assert.deepEqual(
    resolveReportingAudienceProjection({ audience: "own", label: "Nguyễn Văn A", team_ids: [] }),
    { kind: "own", label: "Nguyễn Văn A" },
  );
});

test("W05A fixture: a disabled actor and a forged actor/app pair are rejected", async () => {
  await withFixture(async (db) => {
    await assert.rejects(
      () => audienceOf(db, APP_DISABLED, AUTH_DISABLED),
      /reporting actor unavailable/,
      "a disabled app user must fail closed",
    );
    await assert.rejects(
      () => audienceOf(db, APP_MULTI, AUTH_FORGED),
      /reporting actor unavailable/,
      "a forged auth subject/app user pair must fail closed",
    );
    await assert.rejects(() => audienceOf(db, APP_MULTI, AUTH_DISABLED), /reporting actor unavailable/);
  });
});

test("W05A fixture: only ineffective scope grants never widen the audience", async () => {
  await withFixture(async (db) => {
    const aud = await audienceOf(db, APP_INACTIVE_SCOPE, AUTH_INACTIVE_SCOPE);
    assert.equal(aud.audience, "own", "an expired team grant must not resolve to team");
    assert.deepEqual(aud.team_ids, [], "no effective team may be reported");
    const res = await factsOf(db, APP_INACTIVE_SCOPE, AUTH_INACTIVE_SCOPE);
    assert.deepEqual(res.facts, [], "no verified recruiter link means no visible facts");
    assert.deepEqual(res.sources, []);
  });
});

test("W05A fixture: an own scope without a verified recruiter link yields own plus zero facts", async () => {
  await withFixture(async (db) => {
    const aud = await audienceOf(db, APP_OWN_NO_LINK, AUTH_OWN_NO_LINK);
    assert.equal(aud.audience, "own");
    assert.equal(aud.recruiter_id, null, "no verified link means no recruiter identity");
    const res = await factsOf(db, APP_OWN_NO_LINK, AUTH_OWN_NO_LINK);
    assert.equal(res.audience.audience, "own");
    assert.deepEqual(res.facts, [], "an own scope without a link is a valid empty dashboard");
    assert.deepEqual(res.sources, []);
    assert.deepEqual(res.latest_runs, []);
    assert.deepEqual(res.presence, []);
  });
});
