/**
 * Hotfix after R2.2 — Decouple first_work_date calendar year from employee_code year prefix.
 *
 * Covers mandatory Database (1..11) and TypeScript/API/UI (1..9) regression tests.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  canonicalizeEmployeeCode,
  validateEmployeeCode,
} from "../src/lib/contracts/direct-entry-v1.ts";
import {
  projectChangeRequestCreate,
  projectChangeRequestItem,
} from "../src/lib/direct-entry/change-request-contract.ts";
import {
  buildChangeRequestItem,
  buildEntryFieldProposal,
  workerEntryFormFromBaseline,
} from "../src/lib/direct-entry/change-request-proposal-builders.ts";
import {
  privilegedEditEntry,
  projectPrivilegedEditRequest,
} from "../src/lib/direct-entry/privileged-edit-api.ts";
import {
  classifyPrivilegedEditError,
  createPrivilegedEditRepository,
} from "../src/lib/direct-entry/privileged-edit-repository.ts";
import { projectWorkerDetail } from "../src/lib/direct-entry/worker-detail-projection.ts";
import { projectWorkerDirectoryPage } from "../src/lib/direct-entry/worker-directory-contract.ts";
import { projectWorkerExportEnvelope } from "../src/lib/direct-entry/worker-export-contract.ts";
import { buildWorkerExportXlsx } from "../src/lib/direct-entry/worker-export-xlsx.ts";
import {
  WORKER_CONFLICT_MESSAGE,
  privilegedEditErrorMessage,
} from "../src/lib/direct-entry/worker-operations-model.ts";
import { reserveDirectEntryDocument } from "../src/lib/direct-entry/document-api.ts";
import { finalizeDirectEntryDocument } from "../src/lib/direct-entry/document-finalize-api.ts";
import { getDirectEntryEntry } from "../src/lib/direct-entry/write-api.ts";
import { createDirectEntryWriteRepository } from "../src/lib/direct-entry/write-repository.ts";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const HOTFIX_MIGRATION =
  "20261021140000_hf_decouple_first_work_date_employee_code_year.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM_A = uuid(511);
const TEAM_B = uuid(512);
const PROJ_A = "hf_decouple_proj_a";
const PROJ_B = "hf_decouple_proj_b";
const REC_A = uuid(521);
const REC_B = uuid(522);
const REC_C = uuid(523);
const ADMIN_AUTH = uuid(531);
const ADMIN_APP = uuid(541);
const PM_A_AUTH = uuid(532);
const PM_A_APP = uuid(542);
const PM_B_AUTH = uuid(533);
const PM_B_APP = uuid(543);
const STAFF_A_AUTH = uuid(534);
const STAFF_A_APP = uuid(544);
const TL_A_AUTH = uuid(535);
const TL_A_APP = uuid(545);

async function buildDb({ upToBeforeHotfix = false } = {}) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(
    names.includes(HOTFIX_MIGRATION),
    "Hotfix migration #130 is present in supabase/migrations",
  );
  const targetNames = upToBeforeHotfix
    ? names.slice(0, names.indexOf(HOTFIX_MIGRATION))
    : names.filter((name) => name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql");
  for (const name of targetNames) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return { db, names };
}

function workerDetails(cccd = "079095000002", name = "Nguyen Van Nam 2025") {
  return {
    display_name: name,
    gender: { state: "provided", value: "MALE" },
    date_of_birth: { state: "provided", value: "1995-05-10" },
    national_id: { state: "provided", value: cccd },
    national_id_issued_at: { state: "provided", value: "2021-01-10" },
    national_id_issued_place: { state: "provided", value: "Bộ Công An" },
    address: { state: "provided", value: "TP.HCM" },
    phone: { state: "provided", value: "0901234567" },
  };
}

async function insertActor(db, auth, app, capabilities, scopeKind = null) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)" +
      " values ($1, $2, true, 'Synthetic Actor')",
    [app, auth],
  );
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
        " values ($1, $2, '2020-01-01', true)",
      [app, capability],
    );
  }
  if (scopeKind !== null) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)" +
        " values ($1, $2, '2020-01-01', true)",
      [app, scopeKind],
    );
  }
}

async function seedActorsAndCatalog(db) {
  for (const [team, code, name] of [
    [TEAM_A, "TEAM_HF_A", "Team HF A"],
    [TEAM_B, "TEAM_HF_B", "Team HF B"],
  ]) {
    await db.query(
      "insert into public.teams (team_id, code, display_name) values ($1, $2, $3)",
      [team, code, name],
    );
  }
  for (const [project, name] of [
    [PROJ_A, "Project HF A"],
    [PROJ_B, "Project HF B"],
  ]) {
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ($1, $2)",
      [project, name],
    );
  }
  for (const [recruiter, name, team] of [
    [REC_A, "Recruiter HF A", TEAM_A],
    [REC_B, "Recruiter HF B", TEAM_B],
    [REC_C, "Recruiter HF C", TEAM_A],
  ]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1, $2)",
      [recruiter, name],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
        " values ($1, 'hrp', '2020-01-01', true)",
      [recruiter],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
        " values ($1, $2, '2020-01-01', true)",
      [recruiter, team],
    );
  }

  // Admin
  await insertActor(
    db,
    ADMIN_AUTH,
    ADMIN_APP,
    [
      "entry_admin",
      "entry_privileged_edit",
      "entry_create",
      "submission_create",
      "change_review",
      "pii_view",
      "payment_view",
      "payment_edit",
      "document_view",
    ],
    "all",
  );

  // PM of PROJ_A
  await insertActor(db, PM_A_AUTH, PM_A_APP, ["change_request_create", "pii_view"]);
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
      " (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1, $2, true, '2020-01-01', true)",
    [PM_A_APP, REC_A],
  );
  await db.query(
    "insert into public.direct_entry_project_manager_assignments" +
      " (project_id, manager_recruiter_id, valid_from, is_current) values ($1, $2, '2020-01-01', true)",
    [PROJ_A, REC_A],
  );

  // PM of PROJ_B (out-of-scope for PROJ_A entries)
  await insertActor(db, PM_B_AUTH, PM_B_APP, ["change_request_create", "pii_view"]);
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
      " (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1, $2, true, '2020-01-01', true)",
    [PM_B_APP, REC_B],
  );
  await db.query(
    "insert into public.direct_entry_project_manager_assignments" +
      " (project_id, manager_recruiter_id, valid_from, is_current) values ($1, $2, '2020-01-01', true)",
    [PROJ_B, REC_B],
  );

  // Staff A (proposer on own/recruited entries, no direct edit)
  await insertActor(
    db,
    STAFF_A_AUTH,
    STAFF_A_APP,
    ["entry_create", "submission_create", "change_request_create", "pii_view"],
    "own",
  );
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
      " (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1, $2, true, '2020-01-01', true)",
    [STAFF_A_APP, REC_C],
  );

  // Reviewer (all scope)
  await insertActor(db, TL_A_AUTH, TL_A_APP, ["change_review", "pii_view"], "all");
}

let seedSeq = 0;
async function seedSubmittedWorker(
  db,
  {
    employeeCode,
    firstWorkDate,
    cccd,
    name = "Worker HF",
    projectId = PROJ_A,
    recruiterId = REC_A,
    teamId = TEAM_A,
    createdBy = STAFF_A_APP,
  },
) {
  seedSeq += 1;
  const candidateId = uuid(6000 + seedSeq);
  const submissionId = uuid(7000 + seedSeq);
  const entryId = uuid(8000 + seedSeq);
  await db.exec("begin");
  try {
    await db.query(
      "insert into public.direct_entry_candidates (candidate_id) values ($1)",
      [candidateId],
    );
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
        " values ($1, $2, 'DRAFT')",
      [submissionId, createdBy],
    );
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
        " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
        " provider_type, labor_type)" +
        " values ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, 'hrp', 'TEMPORARY')",
      [
        entryId,
        submissionId,
        candidateId,
        createdBy,
        projectId,
        firstWorkDate,
        employeeCode,
        JSON.stringify(workerDetails(cccd, name)),
        recruiterId,
        teamId,
      ],
    );
    await seedLegacyReviewSubmission(db, submissionId);
    await db.query(
      "update public.direct_entry_submissions set state = 'SUBMITTED', version = 3 where submission_id = $1",
      [submissionId],
    );
    const reasonId = (
      await db.query(
        "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
          " values ($1, 'Seed initial ON status') returning reason_id::text as id",
        [ADMIN_APP],
      )
    ).rows[0].id;
    await db.query(
      "insert into public.direct_entry_employment_status_events" +
        " (entry_id, status, effective_date, version, actor_user_id, reason_id)" +
        " values ($1, 'ON', $2::date, 1, $3, $4)",
      [entryId, firstWorkDate, ADMIN_APP, reasonId],
    );
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return { entryId, candidateId, submissionId, employeeCode };
}

test("DB 1..11: migration #130 drops only direct_entries_check, allows cross-year first_work_date edits, and preserves all constraints/OCC/scope/audit", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndCatalog(db);

    // DB #10: Verify constraint inventory on public.direct_entries after migration #130
    const constraints = (
      await db.query(`
        select c.conname, c.contype, pg_get_constraintdef(c.oid, true) as def
          from pg_constraint c
         where c.conrelid = 'public.direct_entries'::regclass
         order by c.conname
      `)
    ).rows;
    const names = constraints.map((row) => row.conname);
    assert.equal(
      names.includes("direct_entries_check"),
      false,
      "DB #10: direct_entries_check (employee_code year = first_work_date year) is removed",
    );
    for (const required of [
      "direct_entries_employee_code_check",
      "direct_entries_employee_code_key",
      "direct_entries_pkey",
      "direct_entries_version_check",
      "direct_entries_worker_details_check",
    ]) {
      assert.equal(
        names.includes(required),
        true,
        `DB #10: constraint ${required} remains intact`,
      );
    }
    const fkCount = constraints.filter((row) => row.contype === "f").length;
    assert.equal(fkCount, 9, "DB #10: all 9 foreign keys on public.direct_entries remain intact");

    // DB #1: Entry hrp-2025-000002 with first_work_date 2025-06-21 remains valid
    const worker2025 = await seedSubmittedWorker(db, {
      employeeCode: "hrp-2025-000002",
      firstWorkDate: "2025-06-21",
      cccd: "079095000002",
      name: "Nguyen Van 2025",
    });
    const peerWorker = await seedSubmittedWorker(db, {
      employeeCode: "hrp-2025-000003",
      firstWorkDate: "2025-07-01",
      cccd: "079095000003",
      name: "Tran Thi Peer",
    });

    const initialRow = (
      await db.query(
        "select employee_code, first_work_date::text as first_work_date, version" +
          " from public.direct_entries where entry_id = $1::uuid",
        [worker2025.entryId],
      )
    ).rows[0];
    assert.deepEqual(initialRow, {
      employee_code: "hrp-2025-000002",
      first_work_date: "2025-06-21",
      version: 1,
    });

    // DB #2, #7, #8: Direct edit only first_work_date -> 2026-09-30 with NULL reason succeeds,
    // keeps employee_code = 'hrp-2025-000002', increments version, and records revision + audit
    const editRes = await db.query(
      "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text, $6::text) as data",
      [
        PM_A_AUTH,
        PM_A_APP,
        worker2025.entryId,
        JSON.stringify({ first_work_date: "2026-09-30" }),
        null,
        "hf-direct-edit-2025-to-2026",
      ],
    );
    assert.deepEqual(editRes.rows[0].data, {
      entry_id: worker2025.entryId,
      version: 2,
    });

    const updatedRow = (
      await db.query(
        "select employee_code, first_work_date::text as first_work_date, version" +
          " from public.direct_entries where entry_id = $1::uuid",
        [worker2025.entryId],
      )
    ).rows[0];
    assert.deepEqual(
      updatedRow,
      {
        employee_code: "hrp-2025-000002",
        first_work_date: "2026-09-30",
        version: 2,
      },
      "DB #2: first_work_date is updated to 2026-09-30 while employee_code stays hrp-2025-000002",
    );

    const revisions = (
      await db.query(
        "select version, before_snapshot->>'first_work_date' as before_date," +
          " after_snapshot->>'first_work_date' as after_date," +
          " before_snapshot->>'employee_code' as before_code," +
          " after_snapshot->>'employee_code' as after_code," +
          " reason_id" +
          " from public.direct_entry_revisions where entry_id = $1::uuid order by version",
        [worker2025.entryId],
      )
    ).rows;
    assert.deepEqual(
      revisions,
      [
        {
          version: 2,
          before_date: "2025-06-21",
          after_date: "2026-09-30",
          before_code: "hrp-2025-000002",
          after_code: "hrp-2025-000002",
          reason_id: null,
        },
      ],
      "DB #7 & #8: revision records before/after first_work_date, keeps employee_code unchanged, and allows NULL reason",
    );

    const audits = (
      await db.query(
        "select action, outcome, changed_fields, reason_id" +
          " from public.direct_entry_audit_events where resource_ref = $1",
        [worker2025.entryId],
      )
    ).rows;
    assert.deepEqual(
      audits,
      [
        {
          action: "entry_privileged_edit",
          outcome: "APPLIED",
          changed_fields: ["first_work_date"],
          reason_id: null,
        },
      ],
      "DB #7 & #8: audit records changed_fields = ['first_work_date'] and reason_id = null",
    );

    // Also verify Change Request workflow (propose by PM A + approve by Reviewer) changing first_work_date across years
    const crRes = (
      await db.query(
        "select public.direct_entry_create_change_request($1::uuid, $2::uuid, $3::jsonb, $4::text, $5::text) as data",
        [
          PM_A_AUTH,
          PM_A_APP,
          JSON.stringify([
            {
              entry_id: peerWorker.entryId,
              target_kind: "ENTRY_FIELD",
              expected_version: 1,
              proposal: { first_work_date: "2026-10-05" },
            },
          ]),
          null,
          "hf-cr-propose-cross-year",
        ],
      )
    ).rows[0].data;
    assert.equal(crRes.state, "PENDING");
    await db.query(
      "select public.direct_entry_decide_change_request($1::uuid, $2::uuid, $3::uuid, 1, 'APPROVED', null, 'hf-cr-approve-cross-year')",
      [TL_A_AUTH, TL_A_APP, crRes.request_id],
    );
    const peerAfterCr = (
      await db.query(
        "select employee_code, first_work_date::text as first_work_date, version" +
          " from public.direct_entries where entry_id = $1::uuid",
        [peerWorker.entryId],
      )
    ).rows[0];
    assert.deepEqual(peerAfterCr, {
      employee_code: "hrp-2025-000003",
      first_work_date: "2026-10-05",
      version: 2,
    });

    // DB #3: Duplicate employee_code is still rejected with 23505
    await assert.rejects(
      () =>
        db.query(
          "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, 2, $4::jsonb, 'dup test', 'hf-dup-code')",
          [
            ADMIN_AUTH,
            ADMIN_APP,
            worker2025.entryId,
            JSON.stringify({ employee_code: "hrp-2025-000003" }),
          ],
        ),
      (error) => error.code === "23505",
      "DB #3: duplicate employee_code is rejected by direct_entries_employee_code_key",
    );

    // DB #4: Malformed employee_code is still rejected with 23514
    for (const badCode of ["HRP-2025-000002", "hrp-2025-12", "hrp-25-000002", "bad-code"]) {
      await assert.rejects(
        () =>
          db.query(
            "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, 2, $4::jsonb, 'bad format', $5::text)",
            [
              ADMIN_AUTH,
              ADMIN_APP,
              worker2025.entryId,
              JSON.stringify({ employee_code: badCode }),
              "hf-bad-format-" + badCode,
            ],
          ),
        (error) => error.code === "23514",
        `DB #4: non-canonical employee_code ${badCode} is rejected`,
      );
    }

    // DB #5: Stale OCC version is rejected with PT409
    await assert.rejects(
      () =>
        db.query(
          "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, null, 'hf-stale-occ')",
          [
            ADMIN_AUTH,
            ADMIN_APP,
            worker2025.entryId,
            JSON.stringify({ first_work_date: "2026-10-01" }),
          ],
        ),
      (error) => error.code === "PT409",
      "DB #5: stale OCC expected_version is rejected",
    );

    // DB #6: Out-of-scope actor (PM_B on PROJ_A entry) is rejected with 42501
    await assert.rejects(
      () =>
        db.query(
          "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, 2, $4::jsonb, null, 'hf-out-of-scope')",
          [
            PM_B_AUTH,
            PM_B_APP,
            worker2025.entryId,
            JSON.stringify({ first_work_date: "2026-10-01" }),
          ],
        ),
      (error) => error.code === "42501",
      "DB #6: out-of-scope PM is denied direct edit",
    );

    // DB #9: OFF status still requires leave_reason
    await assert.rejects(
      () =>
        db.query(
          "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, 2, $4::jsonb, null, 'hf-off-without-reason')",
          [
            ADMIN_AUTH,
            ADMIN_APP,
            worker2025.entryId,
            JSON.stringify({
              employment_status: { status: "OFF", effective_date: "2026-10-01" },
            }),
          ],
        ),
      (error) => error.code === "22023" || error.code === "23514",
      "DB #9: OFF without leave_reason is rejected",
    );

    // TS/DB #8: Verify Worker Detail RPC + API, Worker Directory RPC, and Worker Export RPC return new date + old employee_code
    const detailRpc = (
      await db.query(
        "select public.direct_entry_read_projection($1::uuid, $2::uuid, $3::uuid) as data",
        [ADMIN_AUTH, ADMIN_APP, worker2025.entryId],
      )
    ).rows[0].data;
    assert.equal(detailRpc.employee_code, "hrp-2025-000002");
    assert.equal(detailRpc.first_work_date, "2026-09-30");
    const detailApiResp = await getDirectEntryEntry(
      worker2025.entryId,
      "true",
      {
        resolveSession: async () => ({
          actor: {
            ok: true,
            actor: { auth_subject: ADMIN_AUTH, app_user_id: ADMIN_APP },
          },
          response_headers: {},
        }),
        repository: {
          async readEntry() {
            return { ok: true, data: detailRpc };
          },
        },
      },
    );
    assert.equal(detailApiResp.status, 200, "TS #8: getDirectEntry succeeds on cross-year worker");
    const detailJson = await detailApiResp.json();
    assert.equal(detailJson.entry.employee_code, "hrp-2025-000002");
    assert.equal(detailJson.entry.first_work_date, "2026-09-30");
    const projectedDetail = projectWorkerDetail(detailJson, worker2025.entryId);
    assert.ok(projectedDetail, "TS #8: projectWorkerDetail accepts cross-year worker");

    const dirRpc = (
      await db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'all'::text, null::text, null::uuid, null::text, null::text, 20, null::text) as data",
        [ADMIN_AUTH, ADMIN_APP],
      )
    ).rows[0].data;
    const projectedDir = projectWorkerDirectoryPage(dirRpc, {
      scope: "all",
      page_size: 20,
    });
    assert.ok(projectedDir, "TS #8: projectWorkerDirectoryPage accepts cross-year workers");
    const dirRow = projectedDir.items.find((w) => w.entry_id === worker2025.entryId);
    assert.ok(dirRow);
    assert.equal(dirRow.employee_code, "hrp-2025-000002");
    assert.equal(dirRow.first_work_date, "2026-09-30");

    const exportRpc = (
      await db.query(
        "select public.direct_entry_export_workers($1::uuid, $2::uuid, 'all', null, null, null, 'Export test') as data",
        [ADMIN_AUTH, ADMIN_APP],
      )
    ).rows[0].data;
    const projectedExport = projectWorkerExportEnvelope(exportRpc);
    assert.ok(projectedExport && projectedExport.status === "ok", "TS #8: projectWorkerExportEnvelope accepts cross-year workers");
    const exportedWorker = projectedExport.rows.find(
      (r) => r.employee_code === "hrp-2025-000002",
    );
    assert.ok(exportedWorker);
    assert.equal(exportedWorker.first_work_date, "2026-09-30");
    const workbookBytes = await buildWorkerExportXlsx(projectedExport.rows);
    assert.ok(workbookBytes.byteLength > 0, "TS #8: XLSX export builds cleanly");
  } finally {
    await db.close();
  }
});

test("DB #11: migration #130 fails closed and rolls back completely if precondition is violated", async () => {
  const { db } = await buildDb({ upToBeforeHotfix: true });
  try {
    const migrationSql = await readFile(
      path.join(MIGRATION_DIR, HOTFIX_MIGRATION),
      "utf8",
    );
    const sha256 = createHash("sha256").update(migrationSql, "utf8").digest("hex");
    assert.equal(sha256.length, 64);

    // Apply migration #130 once (succeeds)
    await db.exec(migrationSql);

    // Applying migration #130 a second time when direct_entries_check is already gone
    // must fail precondition inside the transaction and leave all remaining constraints intact
    await assert.rejects(
      () => db.exec(migrationSql),
      /Precondition failed: expected exactly one year-matching CHECK constraint named direct_entries_check/,
    );
    await db.exec("rollback");

    const remaining = (
      await db.query(`
        select c.conname
          from pg_constraint c
         where c.conrelid = 'public.direct_entries'::regclass
         order by c.conname
      `)
    ).rows.map((r) => r.conname);
    assert.equal(remaining.includes("direct_entries_employee_code_check"), true);
    assert.equal(remaining.includes("direct_entries_employee_code_key"), true);
  } finally {
    await db.close();
  }
});

test("TS/API/UI 1..9: cross-year proposal, single-field direct-edit patch, sanitized error mapping, and zero year-from-code reporting drift", async () => {
  // TS #1, #2, #3: Proposal & direct-edit builder with employee_code 2025 and first_work_date 2026
  const baseline = {
    project_id: "proj-1",
    first_work_date: "2025-06-21",
    employee_code: "hrp-2025-000002",
    recruiter_id: "22222222-2222-4222-8222-222222222222",
    labor_type: "TEMPORARY",
    worker_details: workerDetails("079095000002", "Nguyen Van 2025"),
  };
  const form = workerEntryFormFromBaseline(baseline);
  assert.equal(form.employee_code, "hrp-2025-000002", "TS #3: employee_code is never auto-mutated");
  form.first_work_date = "2026-09-30";

  const built = buildEntryFieldProposal({
    entryId: "c1000000-0000-4000-8000-000000000002",
    expectedVersion: 1,
    baseline,
    form,
  });
  assert.deepEqual(
    built,
    {
      ok: true,
      proposal: { first_work_date: "2026-09-30" },
    },
    "TS #1 & #2: changing only first_work_date across years emits only { first_work_date } and keeps employee_code untouched",
  );

  // Verify Change Request contract accepts cross-year proposal and rejects non-canonical employee_code
  const crItem = buildChangeRequestItem({
    entryId: "c1000000-0000-4000-8000-000000000002",
    expectedVersion: 1,
    targetKind: "ENTRY_FIELD",
    proposal: built.proposal,
  });
  assert.ok(crItem);
  assert.deepEqual(crItem.proposal, { first_work_date: "2026-09-30" });
  assert.equal(
    projectChangeRequestCreate({
      items: [crItem],
      reason: null,
      idempotency_key: "cr-cross-year-key",
    }).ok,
    true,
  );

  // TS #4: Invalid canonical employee_code format is still rejected everywhere
  for (const invalidCode of ["HRP-2025-000002", "hrp-2025-12", "hrp-2025-1234567", "bad"]) {
    assert.equal(validateEmployeeCode(invalidCode, "2026-09-30").length > 0, true, invalidCode);
    assert.deepEqual(
      buildEntryFieldProposal({
        entryId: "c1000000-0000-4000-8000-000000000002",
        expectedVersion: 1,
        baseline,
        form: { ...form, employee_code: invalidCode },
      }),
      { ok: false, code: "WORKER_INVALID" },
    );
    assert.equal(
      projectChangeRequestItem({
        entry_id: "c1000000-0000-4000-8000-000000000002",
        target_kind: "ENTRY_FIELD",
        expected_version: 1,
        proposal: { employee_code: invalidCode },
      }),
      null,
    );
    assert.equal(
      projectPrivilegedEditRequest({
        expected_entry_version: 1,
        patch: { employee_code: invalidCode },
        reason: null,
      }),
      null,
    );
  }
  assert.equal(canonicalizeEmployeeCode("hrp-2025-000002"), "hrp-2025-000002");

  // TS #2 & #6: Privileged edit API accepts date-only cross-year patch and rejects invalid calendar dates
  assert.deepEqual(
    projectPrivilegedEditRequest({
      expected_entry_version: 1,
      patch: { first_work_date: "2026-09-30" },
      reason: null,
    }),
    {
      expected_entry_version: 1,
      patch: { first_work_date: "2026-09-30" },
      reason: null,
    },
  );
  assert.equal(
    projectPrivilegedEditRequest({
      expected_entry_version: 1,
      patch: { first_work_date: "2026-02-30" },
      reason: null,
    }),
    null,
    "Invalid calendar date 2026-02-30 is rejected at the API boundary",
  );

  // TS #5 & #6: Duplicate code (23505) -> 409 PRIVILEGED_EDIT_CONFLICT; OCC conflicts -> 409 VERSION_CONFLICT
  const dupClassified = classifyPrivilegedEditError({
    code: "23505",
    message: 'duplicate key value violates unique constraint "direct_entries_employee_code_key"',
  });
  assert.deepEqual(dupClassified, {
    ok: false,
    kind: "conflict",
    code: "PRIVILEGED_EDIT_CONFLICT",
  });

  const repo = createPrivilegedEditRepository(async () => ({
    data: null,
    error: {
      code: "23505",
      message: 'duplicate key value violates unique constraint "direct_entries_employee_code_key"',
    },
  }));
  const dupResponse = await privilegedEditEntry(
    new Request(
      "https://example.test/api/direct-entry/entries/c1000000-0000-4000-8000-000000000002/privileged-edit",
      {
        method: "POST",
        headers: {
          origin: "https://example.test",
          host: "example.test",
          "content-type": "application/json",
          "idempotency-key": "00000000-0000-4000-8000-000000000999",
        },
        body: JSON.stringify({
          expected_entry_version: 1,
          patch: { employee_code: "hrp-2025-000003" },
          reason: null,
        }),
      },
    ),
    "c1000000-0000-4000-8000-000000000002",
    "true",
    {
      resolveSession: async () => ({
        actor: {
          ok: true,
          actor: {
            auth_subject: ADMIN_AUTH,
            app_user_id: ADMIN_APP,
          },
        },
        response_headers: {},
      }),
      repository: repo,
    },
  );
  assert.equal(dupResponse.status, 409);
  const dupJson = await dupResponse.json();
  assert.deepEqual(dupJson, { ok: false, code: "PRIVILEGED_EDIT_CONFLICT" });

  // TS #7: UI error mapping reads sanitized response code and never exposes raw PostgreSQL text
  assert.match(
    privilegedEditErrorMessage(409, "PRIVILEGED_EDIT_CONFLICT"),
    /Dữ liệu bị trùng/,
  );
  assert.equal(
    privilegedEditErrorMessage(409, "VERSION_CONFLICT"),
    WORKER_CONFLICT_MESSAGE,
  );
  assert.match(
    privilegedEditErrorMessage(400, "PRIVILEGED_EDIT_INVALID"),
    /Dữ liệu chỉnh sửa không hợp lệ/,
  );
  assert.doesNotMatch(
    privilegedEditErrorMessage(400, "PRIVILEGED_EDIT_INVALID"),
    /năm trong mã NLĐ/i,
    "PRIVILEGED_EDIT_INVALID must not falsely blame employee_code year mismatch",
  );
  assert.match(
    privilegedEditErrorMessage(403, "PRIVILEGED_EDIT_STATE_LOCKED"),
    /Trạng thái hồ sơ hiện tại không cho phép chỉnh sửa trực tiếp/,
  );
  assert.match(
    privilegedEditErrorMessage(403, "PRIVILEGED_EDIT_DENIED"),
    /Bạn không còn quyền sửa trực tiếp hồ sơ này/,
  );

  const workerOpsSource = await readFile(
    path.resolve("src/components/direct-entry/worker-operations.tsx"),
    "utf8",
  );
  assert.match(workerOpsSource, /privilegedEditErrorMessage\(response\.status,\s*errorCode\)/);
  assert.match(workerOpsSource, /onDone\("Đã lưu chỉnh sửa trực tiếp\."\)/);

  // TS #9: Verify no reporting or authorization module derives work year from employee_code
  const reportingDir = path.resolve("src/lib/reporting");
  const reportingFiles = (await readdir(reportingDir)).filter(
    (name) => name.endsWith(".ts") || name.endsWith(".mjs"),
  );
  for (const file of reportingFiles) {
    const text = await readFile(path.join(reportingDir, file), "utf8");
    assert.doesNotMatch(
      text,
      /employee_code\.slice\(4,\s*8\)|substring\(employee_code\s+from\s+5\s+for\s+4\)/i,
      `Reporting file ${file} must not derive work year from employee_code`,
    );
  }
});

test("HF Worker Profile Direct Edit: banking (payment) in direct_entry_privileged_edit and document upload/replace on SUBMITTED entries", async () => {
  const { db, names } = await buildDb();
  try {
    assert.ok(
      names.includes("20261030100000_hf_worker_profile_direct_edit_banking_and_documents.sql"),
      "Hotfix migration 20261030100000 is present in supabase/migrations",
    );
    await seedActorsAndCatalog(db);
    await db.query(
      "insert into public.direct_entry_banks (bank_id, display_name, active) values ('VCB', 'Vietcombank', true) on conflict (bank_id) do nothing",
    );

    const worker = await seedSubmittedWorker(db, {
      employeeCode: "hrp-2025-000088",
      firstWorkDate: "2026-03-10",
      cccd: "079095000088",
      name: "Nguyen Thi Ho So",
      projectId: PROJ_A,
      recruiterId: REC_A,
      teamId: TEAM_A,
    });

    // 1. Assigned PM (PM_A) updates personal + banking (payment: provided) via direct_entry_privileged_edit
    const editPaymentRes = (
      await db.query(
        "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, $6::text, $7::text) as data",
        [
          PM_A_AUTH,
          PM_A_APP,
          worker.entryId,
          1,
          JSON.stringify({
            worker_details: {
              ...workerDetails("079095000088", "Nguyen Thi Ho So Moi"),
              phone: { state: "provided", value: "0912345678" },
            },
            payment: {
              state: "provided",
              account_number: "19038889990001",
              bank_id: "VCB",
              account_holder_name: "NGUYEN THI HO SO MOI",
            },
          }),
          "Cap nhat thong tin ca nhan va ngan hang",
          "hf-direct-edit-payment-1",
        ],
      )
    ).rows[0].data;
    assert.equal(editPaymentRes.version, 2);

    const paymentRow1 = (
      await db.query(
        "select state, account_number, bank_id, account_holder_name, version from public.direct_entry_payments where entry_id = $1::uuid",
        [worker.entryId],
      )
    ).rows[0];
    assert.deepEqual(paymentRow1, {
      state: "provided",
      account_number: "19038889990001",
      bank_id: "VCB",
      account_holder_name: "NGUYEN THI HO SO MOI",
      version: 1,
    });

    // 2. Admin updates banking state to intentionally_blank ( increments payment.version )
    const editPaymentBlank = (
      await db.query(
        "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, $6::text, $7::text) as data",
        [
          ADMIN_AUTH,
          ADMIN_APP,
          worker.entryId,
          editPaymentRes.version,
          JSON.stringify({
            payment: {
              state: "intentionally_blank",
              account_number: null,
              bank_id: null,
              account_holder_name: null,
            },
          }),
          null,
          "hf-direct-edit-payment-2",
        ],
      )
    ).rows[0].data;
    assert.equal(editPaymentBlank.version, editPaymentRes.version + 1);

    const paymentRow2 = (
      await db.query(
        "select state, account_number, bank_id, account_holder_name, version from public.direct_entry_payments where entry_id = $1::uuid",
        [worker.entryId],
      )
    ).rows[0];
    assert.deepEqual(paymentRow2, {
      state: "intentionally_blank",
      account_number: null,
      bank_id: null,
      account_holder_name: null,
      version: 2,
    });

    // 3. Invalid payment payload is rejected with 22023 and Out-of-scope PM_B is rejected with 42501
    await assert.rejects(
      db.query(
        "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, null, 'hf-bad-payment')",
        [
          ADMIN_AUTH,
          ADMIN_APP,
          worker.entryId,
          editPaymentBlank.version,
          JSON.stringify({
            payment: {
              state: "provided",
              account_number: "not-digits",
              bank_id: "VCB",
              account_holder_name: "NGUYEN THI HO SO",
            },
          }),
        ],
      ),
      (err) => err.code === "22023",
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, null, 'hf-denied-pm-b')",
        [
          PM_B_AUTH,
          PM_B_APP,
          worker.entryId,
          editPaymentBlank.version,
          JSON.stringify({
            payment: {
              state: "unknown",
              account_number: null,
              bank_id: null,
              account_holder_name: null,
            },
          }),
        ],
      ),
      (err) => err.code === "42501",
    );

    // 3b. Security regression: actors who have direct-edit authority (ADMIN, PM_A, TL_A)
    //     but LACK capability 'document_upload' MUST be denied on reserve (both DB & API)
    //     on SUBMITTED entries with zero upload intent or entry mutation.
    const writeRepo = createDirectEntryWriteRepository(async (name, args) => {
      const keys = Object.keys(args);
      const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(", ");
      const values = keys.map((key) => args[key]);
      try {
        const res = await db.query(
          `select public.${name}(${placeholders}) as data`,
          values,
        );
        return { data: res.rows[0]?.data ?? null, error: null };
      } catch (err) {
        return {
          data: null,
          error: { code: err.code ?? "P0001", message: err.message ?? "db error" },
        };
      }
    });

    for (const [actorLabel, authSub, appId, apiCaps, expectedApiStatus] of [
      ["ADMIN", ADMIN_AUTH, ADMIN_APP, ["entry_admin", "entry_privileged_edit"], 403],
      ["PM_A", PM_A_AUTH, PM_A_APP, ["change_request_create"], 404],
      ["TL_A", TL_A_AUTH, TL_A_APP, ["team_manager_assign"], 403],
    ]) {
      for (const [docType, mimeType] of [
        ["WORKER_PORTRAIT", "image/jpeg"],
        ["CCCD_FRONT", "image/jpeg"],
        ["CCCD_BACK", "image/png"],
        ["EMPLOYMENT_CONTRACT", "application/pdf"],
      ]) {
        await assert.rejects(
          db.query(
            "select public.direct_entry_reserve_document_direct_upload($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text, $6::text, 1024, $7::text, 'Denied without document_upload')",
            [
              authSub,
              appId,
              worker.entryId,
              editPaymentBlank.version,
              docType,
              `hf-no-cap-res-${actorLabel}-${docType}`,
              mimeType,
            ],
          ),
          (err) => err.code === "42501",
          `${actorLabel} without document_upload must be rejected with 42501 on reserve (${docType})`,
        );
      }

      let signedUrlCalled = false;
      const apiRes = await reserveDirectEntryDocument(
        new Request(`https://example.test/api/direct-entry/entries/${worker.entryId}/documents`, {
          method: "POST",
          headers: {
            origin: "https://example.test",
            host: "example.test",
            "content-type": "application/json",
            "idempotency-key": `hf-api-no-cap-res-${actorLabel}`,
          },
          body: JSON.stringify({
            document_type: "WORKER_PORTRAIT",
            expected_entry_version: editPaymentBlank.version,
            size_bytes: 1024,
            mime_type: "image/jpeg",
          }),
        }),
        worker.entryId,
        "true",
        {
          resolveSession: async () => ({
            actor: {
              ok: true,
              actor: {
                auth_subject: authSub,
                app_user_id: appId,
                display_name: actorLabel,
                enabled: true,
                capabilities: apiCaps,
                scopes: [],
                self_recruiter_suggestion: null,
                session: { provider: "supabase", verification: "getUser", authenticated_at: null },
              },
            },
            response_headers: {},
          }),
          repository: writeRepo,
          storage: {
            available: () => true,
            async createUploadUrl() {
              signedUrlCalled = true;
              throw new Error("createUploadUrl must not be called when document_upload is missing");
            },
          },
        },
      );
      assert.equal(apiRes.status, expectedApiStatus);
      assert.equal(signedUrlCalled, false);
    }

    const residueAfterDeniedReserve = (
      await db.query(
        `select
           (select count(*)::int from public.direct_entry_document_versions where candidate_id = $1::uuid) as doc_versions,
           (select count(*)::int from public.direct_entry_rpc_idempotency where action = 'document_direct_reserve') as reserve_idem,
           (select version from public.direct_entries where entry_id = $2::uuid) as entry_version`,
        [worker.candidateId, worker.entryId],
      )
    ).rows[0];
    assert.deepEqual(residueAfterDeniedReserve, {
      doc_versions: 0,
      reserve_idem: 0,
      entry_version: editPaymentBlank.version,
    });

    // 3c. DRAFT upload permission remains intact: Assigned PM (PM_A) without document_upload
    //     can still upload to their OWN DRAFT entry in PROJ_A.
    const draftSubmissionId = uuid(598);
    const draftCandidateId = uuid(599);
    const draftEntryId = uuid(600);
    await db.exec("begin");
    try {
      await db.query(
        "insert into public.direct_entry_candidates (candidate_id) values ($1)",
        [draftCandidateId],
      );
      await db.query(
        "insert into public.direct_entry_submissions (submission_id, state, created_by_user_id) values ($1, 'DRAFT', $2)",
        [draftSubmissionId, PM_A_APP],
      );
      await db.query(
        `insert into public.direct_entries (
           entry_id, submission_id, candidate_id, project_id, first_work_date, employee_code,
           worker_details, general_note, recruiter_id, team_id, provider_type, labor_type,
           created_by_user_id, version
         ) values (
           $1, $2, $3, $4, '2026-03-15', 'hrp-2026-000099',
           $5::jsonb, '{"state":"omitted"}'::jsonb, $6, $7, 'hrp', 'TEMPORARY',
           $8, 1
         )`,
        [
          draftEntryId,
          draftSubmissionId,
          draftCandidateId,
          PROJ_A,
          JSON.stringify(workerDetails("079095000099", "Nguyen Van Draft PM")),
          REC_A,
          TEAM_A,
          PM_A_APP,
        ],
      );
      await db.exec("commit");
    } catch (err) {
      await db.exec("rollback");
      throw err;
    }
    const pmDraftReserve = (
      await db.query(
        "select public.direct_entry_reserve_document_direct_upload($1::uuid, $2::uuid, $3::uuid, 1, 'WORKER_PORTRAIT', 'hf-draft-pm-res', 1024, 'image/jpeg', null) as data",
        [PM_A_AUTH, PM_A_APP, draftEntryId],
      )
    ).rows[0].data;
    assert.equal(pmDraftReserve.upload_status, "QUEUED");

    // 4. Grant document_upload capability to direct-edit actors (ADMIN, PM_A, TL_A) and PM_B
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
        " values ($1, 'document_upload', '2020-01-01', true), ($2, 'document_upload', '2020-01-01', true), ($3, 'document_upload', '2020-01-01', true), ($4, 'document_upload', '2020-01-01', true)",
      [ADMIN_APP, PM_A_APP, TL_A_APP, PM_B_APP],
    );

    // 4a. Assigned PM (PM_A) with BOTH direct-edit authority and document_upload can upload
    //     new and replacement documents (WORKER_PORTRAIT, CCCD_FRONT, CCCD_BACK, EMPLOYMENT_CONTRACT)
    //     on SUBMITTED entry, while any direct-edit actor lacking document_upload is denied on finalize.
    let currentEntryVersion = editPaymentBlank.version;
    for (const [docType, mimeType] of [
      ["WORKER_PORTRAIT", "image/jpeg"],
      ["CCCD_FRONT", "image/jpeg"],
      ["CCCD_BACK", "image/png"],
      ["EMPLOYMENT_CONTRACT", "application/pdf"],
    ]) {
      // Initial upload (version 1)
      const res1 = (
        await db.query(
          "select public.direct_entry_reserve_document_direct_upload($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text, $6::text, 1024, $7::text, 'Direct edit upload v1') as data",
          [
            PM_A_AUTH,
            PM_A_APP,
            worker.entryId,
            currentEntryVersion,
            docType,
            `hf-doc-${docType}-v1-res`,
            mimeType,
          ],
        )
      ).rows[0].data;
      assert.equal(res1.version, 1);
      assert.equal(res1.upload_status, "QUEUED");

      if (docType === "WORKER_PORTRAIT") {
        // Temporarily revoke document_upload from ADMIN, PM_A, TL_A and prove finalize & context('finalize')
        // are denied at both DB and API layers without mutating the QUEUED document or entry version.
        await db.query(
          "update public.direct_entry_capability_grants set is_current = false, valid_to = '2025-01-01'" +
            " where capability = 'document_upload' and app_user_id in ($1::uuid, $2::uuid, $3::uuid)",
          [ADMIN_APP, PM_A_APP, TL_A_APP],
        );

        for (const [actorLabel, authSub, appId, apiCaps, expectedApiStatus] of [
          ["ADMIN", ADMIN_AUTH, ADMIN_APP, ["entry_admin", "entry_privileged_edit"], 403],
          ["PM_A", PM_A_AUTH, PM_A_APP, ["change_request_create"], 404],
          ["TL_A", TL_A_AUTH, TL_A_APP, ["team_manager_assign"], 403],
        ]) {
          await assert.rejects(
            db.query(
              "select public.direct_entry_document_direct_context($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'finalize')",
              [authSub, appId, worker.entryId, res1.document_id],
            ),
            (err) => err.code === "42501",
            `${actorLabel} without document_upload must be rejected with 42501 on document_direct_context('finalize')`,
          );
          await assert.rejects(
            db.query(
              "select public.direct_entry_finalize_document_direct_upload($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6::text, 'validated', $7::text, 1024, $8::text)",
              [
                authSub,
                appId,
                worker.entryId,
                res1.document_id,
                res1.entry_version,
                `hf-no-cap-fin-${actorLabel}`,
                "a".repeat(64),
                mimeType,
              ],
            ),
            (err) => err.code === "42501",
            `${actorLabel} without document_upload must be rejected with 42501 on finalize`,
          );

          let storageTouched = false;
          const finApiRes = await finalizeDirectEntryDocument(
            new Request(
              `https://example.test/api/direct-entry/entries/${worker.entryId}/documents/${res1.document_id}/finalize`,
              {
                method: "POST",
                headers: {
                  origin: "https://example.test",
                  host: "example.test",
                  "content-type": "application/json",
                  "idempotency-key": `hf-api-no-cap-fin-${actorLabel}`,
                },
                body: JSON.stringify({ expected_entry_version: res1.entry_version }),
              },
            ),
            worker.entryId,
            res1.document_id,
            "true",
            {
              resolveSession: async () => ({
                actor: {
                  ok: true,
                  actor: {
                    auth_subject: authSub,
                    app_user_id: appId,
                    display_name: actorLabel,
                    enabled: true,
                    capabilities: apiCaps,
                    scopes: [],
                    self_recruiter_suggestion: null,
                    session: { provider: "supabase", verification: "getUser", authenticated_at: null },
                  },
                },
                response_headers: {},
              }),
              repository: writeRepo,
              storage: {
                available: () => true,
                async headStaged() {
                  storageTouched = true;
                  throw new Error("headStaged must not be called when finalize access is denied");
                },
              },
            },
          );
          assert.equal(finApiRes.status, expectedApiStatus);
          assert.equal(storageTouched, false);
        }

        const residueAfterDeniedFinalize = (
          await db.query(
            `select
               (select count(*)::int from public.direct_entry_document_objects where document_id = $1::uuid) as doc_objects,
               (select upload_status from public.direct_entry_document_events where document_id = $1::uuid order by version desc limit 1) as latest_status,
               (select count(*)::int from public.direct_entry_rpc_idempotency where action = 'document_direct_finalize') as finalize_idem,
               (select version from public.direct_entries where entry_id = $2::uuid) as entry_version`,
            [res1.document_id, worker.entryId],
          )
        ).rows[0];
        assert.deepEqual(residueAfterDeniedFinalize, {
          doc_objects: 0,
          latest_status: "QUEUED",
          finalize_idem: 0,
          entry_version: res1.entry_version,
        });

        // Re-enable document_upload for ADMIN, PM_A, TL_A
        await db.query(
          "update public.direct_entry_capability_grants set is_current = true, valid_to = null" +
            " where capability = 'document_upload' and app_user_id in ($1::uuid, $2::uuid, $3::uuid)",
          [ADMIN_APP, PM_A_APP, TL_A_APP],
        );
      }

      const ctx1 = (
        await db.query(
          "select public.direct_entry_document_direct_context($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'finalize') as data",
          [PM_A_AUTH, PM_A_APP, worker.entryId, res1.document_id],
        )
      ).rows[0].data;
      assert.equal(ctx1.document_id, res1.document_id);

      const fin1 = (
        await db.query(
          "select public.direct_entry_finalize_document_direct_upload($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6::text, 'validated', $7::text, 1024, $8::text) as data",
          [
            PM_A_AUTH,
            PM_A_APP,
            worker.entryId,
            res1.document_id,
            res1.entry_version,
            `hf-doc-${docType}-v1-fin`,
            "a".repeat(64),
            mimeType,
          ],
        )
      ).rows[0].data;
      assert.equal(fin1.upload_status, "READY");
      assert.equal(fin1.version, 1);
      currentEntryVersion = fin1.entry_version;

      // Replacement upload (version 2)
      const res2 = (
        await db.query(
          "select public.direct_entry_reserve_document_direct_upload($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text, $6::text, 2048, $7::text, 'Direct edit replace v2') as data",
          [
            PM_A_AUTH,
            PM_A_APP,
            worker.entryId,
            currentEntryVersion,
            docType,
            `hf-doc-${docType}-v2-res`,
            mimeType,
          ],
        )
      ).rows[0].data;
      assert.equal(res2.version, 2);

      const fin2 = (
        await db.query(
          "select public.direct_entry_finalize_document_direct_upload($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6::text, 'validated', $7::text, 2048, $8::text) as data",
          [
            PM_A_AUTH,
            PM_A_APP,
            worker.entryId,
            res2.document_id,
            res2.entry_version,
            `hf-doc-${docType}-v2-fin`,
            "b".repeat(64),
            mimeType,
          ],
        )
      ).rows[0].data;
      assert.equal(fin2.upload_status, "READY");
      assert.equal(fin2.version, 2);
      currentEntryVersion = fin2.entry_version;
    }

    // 5. Out-of-scope PM_B (even with document_upload) is denied document upload on SUBMITTED entry
    await assert.rejects(
      db.query(
        "select public.direct_entry_reserve_document_direct_upload($1::uuid, $2::uuid, $3::uuid, $4::integer, 'WORKER_PORTRAIT', 'hf-denied-doc-pm-b', 1024, 'image/jpeg', null)",
        [PM_B_AUTH, PM_B_APP, worker.entryId, currentEntryVersion],
      ),
      (err) => err.code === "42501",
    );

    // 6. HF Edit Values (20261030120000):
    //    - gender state 'intentionally_blank' is accepted
    //    - VietQR bank ('TCB') auto-registers in direct_entry_banks and populates bank_name ('Techcombank')
    //    - Custom reference bank (bank_id: null, bank_name: 'Ngân hàng Nông thôn Xã A') is stored and projected
    //    - Bank account without bank_id/bank_name is accepted and satisfies salary advance bank account check
    assert.ok(
      names.includes("20261030120000_hf_worker_profile_edit_values_and_banks.sql"),
      "Hotfix migration 20261030120000 is present in supabase/migrations",
    );

    const editVietQrBank = (
      await db.query(
        "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, $6::text, $7::text) as data",
        [
          PM_A_AUTH,
          PM_A_APP,
          worker.entryId,
          currentEntryVersion,
          JSON.stringify({
            worker_details: {
              ...workerDetails("079095000088", "Nguyen Thi Ho So Moi"),
              gender: { state: "intentionally_blank" },
            },
            payment: {
              state: "provided",
              account_number: "19038889990002",
              bank_id: "TCB",
              account_holder_name: "NGUYEN THI HO SO MOI",
            },
          }),
          "Chon ngan hang TCB tu VietQR va xoa gioi tinh",
          "hf-direct-edit-vietqr-tcb",
        ],
      )
    ).rows[0].data;
    currentEntryVersion = editVietQrBank.version;

    const paymentRowTcb = (
      await db.query(
        "select state, account_number, bank_id, bank_name, account_holder_name from public.direct_entry_payments where entry_id = $1::uuid",
        [worker.entryId],
      )
    ).rows[0];
    assert.deepEqual(paymentRowTcb, {
      state: "provided",
      account_number: "19038889990002",
      bank_id: "TCB",
      bank_name: "Techcombank",
      account_holder_name: "NGUYEN THI HO SO MOI",
    });

    const editCustomBank = (
      await db.query(
        "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, $6::text, $7::text) as data",
        [
          PM_A_AUTH,
          PM_A_APP,
          worker.entryId,
          currentEntryVersion,
          JSON.stringify({
            payment: {
              state: "provided",
              account_number: "19038889990003",
              bank_id: null,
              bank_name: "Ngân hàng Nông thôn Xã A",
              account_holder_name: "NGUYEN THI HO SO MOI",
            },
          }),
          "Luu ten ngan hang ngoai danh muc",
          "hf-direct-edit-custom-bank-name",
        ],
      )
    ).rows[0].data;
    currentEntryVersion = editCustomBank.version;

    const paymentRowCustom = (
      await db.query(
        "select state, account_number, bank_id, bank_name, account_holder_name from public.direct_entry_payments where entry_id = $1::uuid",
        [worker.entryId],
      )
    ).rows[0];
    assert.deepEqual(paymentRowCustom, {
      state: "provided",
      account_number: "19038889990003",
      bank_id: null,
      bank_name: "Ngân hàng Nông thôn Xã A",
      account_holder_name: "NGUYEN THI HO SO MOI",
    });

    const entryReadCustom = (
      await db.query(
        "select public.direct_entry_read_projection($1::uuid, $2::uuid, $3::uuid) as data",
        [ADMIN_AUTH, ADMIN_APP, worker.entryId],
      )
    ).rows[0].data;
    assert.equal(entryReadCustom.payment.bank_id, null);
    assert.equal(entryReadCustom.payment.bank_name, "Ngân hàng Nông thôn Xã A");
    assert.equal(entryReadCustom.worker_details.gender.state, "intentionally_blank");

    // 7. Regression guard: direct_entry_valid_worker_details preserves the worker-profile/1.2
    //    exception allowing empty display_name ("") ONLY when a valid 12-digit national_id is provided,
    //    while also accepting gender = intentionally_blank.
    const validatorCheck = (
      await db.query(`
        select
          public.direct_entry_valid_worker_details(jsonb_build_object(
            'display_name', '',
            'gender', jsonb_build_object('state', 'intentionally_blank'),
            'date_of_birth', jsonb_build_object('state', 'omitted'),
            'national_id', jsonb_build_object('state', 'provided', 'value', '079095000123'),
            'address', jsonb_build_object('state', 'omitted'),
            'phone', jsonb_build_object('state', 'omitted')
          )) as valid_empty_name_with_12_digit_cccd,
          public.direct_entry_valid_worker_details(jsonb_build_object(
            'display_name', '',
            'date_of_birth', jsonb_build_object('state', 'omitted'),
            'national_id', jsonb_build_object('state', 'omitted'),
            'address', jsonb_build_object('state', 'omitted'),
            'phone', jsonb_build_object('state', 'omitted')
          )) as invalid_empty_name_without_cccd,
          public.direct_entry_valid_worker_details(jsonb_build_object(
            'display_name', '',
            'date_of_birth', jsonb_build_object('state', 'omitted'),
            'national_id', jsonb_build_object('state', 'provided', 'value', '000000000000'),
            'address', jsonb_build_object('state', 'omitted'),
            'phone', jsonb_build_object('state', 'omitted')
          )) as invalid_empty_name_with_zero_cccd
      `)
    ).rows[0];
    assert.deepEqual(validatorCheck, {
      valid_empty_name_with_12_digit_cccd: true,
      invalid_empty_name_without_cccd: false,
      invalid_empty_name_with_zero_cccd: false,
    });
  } finally {
    await db.close();
  }
});

test("direct edit keeps saved recruiter/team/provider when that recruiter is no longer current", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndCatalog(db);
    const worker = await seedSubmittedWorker(db, {
      employeeCode: "hrp-2026-009901",
      firstWorkDate: "2026-03-10",
      cccd: "079095009901",
      recruiterId: REC_C,
      teamId: TEAM_A,
    });

    await db.query("update public.recruiters set active = false where recruiter_id = $1", [REC_C]);
    await db.query(
      "update public.recruiter_provider_memberships set is_current = false where recruiter_id = $1",
      [REC_C],
    );
    await db.query(
      "update public.recruiter_team_memberships set is_current = false where recruiter_id = $1",
      [REC_C],
    );

    const effectiveDate = (
      await db.query("select public.direct_entry_authorization_date()::text as date")
    ).rows[0].date;
    const statusEdit = (
      await db.query(
        "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, null, 'inactive-recruiter-status') as data",
        [
          PM_A_AUTH,
          PM_A_APP,
          worker.entryId,
          JSON.stringify({
            employment_status: {
              status: "OFF",
              effective_date: effectiveDate,
              leave_reason: "Đã nghỉ việc",
            },
          }),
        ],
      )
    ).rows[0].data;
    assert.deepEqual(statusEdit, { entry_id: worker.entryId, version: 2 });

    const preserved = (
      await db.query(
        "select recruiter_id::text as recruiter_id, team_id::text as team_id, provider_type, first_work_date::text as first_work_date, version from public.direct_entries where entry_id = $1::uuid",
        [worker.entryId],
      )
    ).rows[0];
    assert.deepEqual(preserved, {
      recruiter_id: REC_C,
      team_id: TEAM_A,
      provider_type: "hrp",
      first_work_date: "2026-03-10",
      version: 2,
    });

    const statusAudit = (
      await db.query(
        "select action, outcome, changed_fields from public.direct_entry_audit_events where resource_ref = $1",
        [worker.entryId],
      )
    ).rows;
    assert.deepEqual(statusAudit, [
      {
        action: "entry_privileged_edit",
        outcome: "APPLIED",
        changed_fields: ["employment_status"],
      },
    ]);
    const statusEvent = (
      await db.query(
        "select status, effective_date::text as effective_date, leave_reason_text from public.direct_entry_employment_status_events where entry_id = $1::uuid order by version desc limit 1",
        [worker.entryId],
      )
    ).rows[0];
    assert.deepEqual(statusEvent, {
      status: "OFF",
      effective_date: effectiveDate,
      leave_reason_text: "Đã nghỉ việc",
    });

    const sameRecruiterEdit = (
      await db.query(
        "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, 2, $4::jsonb, null, 'inactive-recruiter-same-links') as data",
        [
          PM_A_AUTH,
          PM_A_APP,
          worker.entryId,
          JSON.stringify({
            recruiter_id: REC_C,
            first_work_date: "2026-03-10",
            worker_details: workerDetails("079095009901", "Worker HF Updated"),
          }),
        ],
      )
    ).rows[0].data;
    assert.deepEqual(sameRecruiterEdit, { entry_id: worker.entryId, version: 3 });

    await db.query("update public.recruiters set active = false where recruiter_id = $1", [REC_B]);
    await db.query(
      "update public.recruiter_provider_memberships set is_current = false where recruiter_id = $1",
      [REC_B],
    );
    await db.query(
      "update public.recruiter_team_memberships set is_current = false where recruiter_id = $1",
      [REC_B],
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_privileged_edit($1::uuid, $2::uuid, $3::uuid, 3, $4::jsonb, null, 'inactive-recruiter-changed-link')",
        [
          PM_A_AUTH,
          PM_A_APP,
          worker.entryId,
          JSON.stringify({ recruiter_id: REC_B }),
        ],
      ),
      (error) => error.code === "42501",
    );

    const afterDeniedChange = (
      await db.query(
        "select recruiter_id::text as recruiter_id, team_id::text as team_id, provider_type, version from public.direct_entries where entry_id = $1::uuid",
        [worker.entryId],
      )
    ).rows[0];
    assert.deepEqual(afterDeniedChange, {
      recruiter_id: REC_C,
      team_id: TEAM_A,
      provider_type: "hrp",
      version: 3,
    });
  } finally {
    await db.close();
  }
});
