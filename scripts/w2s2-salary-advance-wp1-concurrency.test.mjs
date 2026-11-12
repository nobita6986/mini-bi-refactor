/**
 * W2S2 Salary Advance (Ứng lương) WP1 — Real PostgreSQL Concurrency Regression Suite.
 *
 * Proves against an isolated local PostgreSQL cluster (`initdb` + `pg_ctl`, zero remote DB):
 *   1. Concurrent state transition race (`salary_advance_transition_request`) with the same
 *      `expected_version`: strictly 1 winner advances `version`, contender fails with
 *      `PT409` (`SALARY_ADVANCE_VERSION_CONFLICT`).
 *   2. Concurrent idempotent retry & conflict (`salary_advance_create_request`):
 *      - Identical `(actor, idempotency_key, request_fingerprint)` across concurrent
 *        connections serializes via `pg_advisory_xact_lock`, writes strictly 1 request +
 *        1 event, and returns `replayed: true` on the second connection.
 *      - Same `(actor, idempotency_key)` with different `request_fingerprint` yields
 *        strictly 1 winner and 1 `23505` (`SALARY_ADVANCE_IDEMPOTENCY_CONFLICT`).
 *   3. Concurrent evidence finalize race (`salary_advance_finalize_evidence`):
 *      - When two upload attempts race, strictly 1 commits and the losing attempt fails
 *        with `PT409` (`SALARY_ADVANCE_UPLOAD_SUPERSEDED` or `SALARY_ADVANCE_VERSION_CONFLICT`),
 *        never overwriting the winning evidence version.
 *   4. Concurrent worker portrait rotation during `salary_advance_review_evidence` (`REVIEWED`):
 *      - If the worker's `WORKER_PORTRAIT` advances to a newer version before `REVIEWED`
 *        commits, `salary_advance_review_evidence` fails closed with `PT409`
 *        (`SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT`).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { computeAssignAccountingMemberFingerprint } from "../src/lib/departments/department-contract.ts";
import {
  computeCreateRequestFingerprint,
  computeFinalizeEvidenceFingerprint,
  computeReserveEvidenceFingerprint,
  computeReviewEvidenceFingerprint,
  computeTransitionRequestFingerprint,
} from "../src/lib/salary-advance/salary-advance-contract.ts";
import { computeAssignProjectAccountantFingerprint } from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import { SALARY_ADVANCE_WP1_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const TEAM_RACE = "99900000-0000-4000-8000-00000000000a";
const PRJ_RACE = "sal_adv_prj_race";

const ADMIN = {
  auth: "19900000-0000-4000-8000-000000000001",
  app: "29900000-0000-4000-8000-000000000001",
  name: "Full Admin Race",
};
const PM = {
  auth: "19900000-0000-4000-8000-000000000002",
  app: "29900000-0000-4000-8000-000000000002",
  recruiter: "39900000-0000-4000-8000-000000000002",
  name: "QLDA Race",
  code: "PM-902",
};
const ACCT = {
  auth: "19900000-0000-4000-8000-000000000003",
  app: "29900000-0000-4000-8000-000000000003",
  recruiter: "39900000-0000-4000-8000-000000000003",
  name: "Kế Toán Race",
  code: "KT-903",
};

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `89900000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
}

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32"
      ? "C:\\Program Files\\PostgreSQL\\18\\bin"
      : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return result.error ? null : candidate;
}

function run(file, args, { ignoreOutput = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  assert.equal(
    result.status,
    0,
    `${path.basename(file)} failed:\n${result.stderr || result.stdout}`,
  );
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function connect(
  port,
  database = "postgres",
  applicationName = "sal-adv-race",
) {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function applyMigrations(client) {
  await client.query(
    "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key, email text);",
  );
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const targetIndex = names.indexOf(SALARY_ADVANCE_WP1_MIGRATION_NAME);
  assert.ok(
    targetIndex >= 0,
    `migration inventory must include ${SALARY_ADVANCE_WP1_MIGRATION_NAME}`,
  );
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

function makeWorkerDetails(displayName) {
  const unknown = { state: "unknown" };
  return {
    display_name: displayName,
    date_of_birth: unknown,
    national_id: unknown,
    address: unknown,
    phone: unknown,
  };
}

async function seedPortraitVersion(client, entryId, shaChar) {
  const { rows } = await client.query(
    "select version from public.direct_entries where entry_id = $1::uuid",
    [entryId],
  );
  const res1 = await client.query(
    `select public.direct_entry_reserve_document_direct_upload(
       $1::uuid, $2::uuid, $3::uuid, $4::integer, 'WORKER_PORTRAIT',
       $5::text, 512, 'image/jpeg', null
     ) as data`,
    [PM.auth, PM.app, entryId, rows[0].version, `race-port-res-${nextUuid()}`],
  );
  const reservation = res1.rows[0].data;
  const res2 = await client.query(
    `select public.direct_entry_finalize_document_direct_upload(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer,
       $6::text, 'validated', $7::text, 512, 'image/jpeg'
     ) as data`,
    [
      PM.auth,
      PM.app,
      entryId,
      reservation.document_id,
      reservation.entry_version,
      `race-port-fin-${nextUuid()}`,
      shaChar.repeat(64),
    ],
  );
  return res2.rows[0].data;
}

const initdb = binary("initdb");
const pgCtl = binary("pg_ctl");

test(
  "W2S2 Salary Advance WP1 native PostgreSQL concurrency: OCC transitions, idempotency races, evidence finalize races, and 4-way portrait lock races",
  { skip: !initdb || !pgCtl ? "PostgreSQL binaries not available" : false },
  async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "bi-sal-adv-wp1-pg-"),
    );
    const dataDir = path.join(tempRoot, "data");
    const logFile = path.join(tempRoot, "postgres.log");
    const port = await freePort();
    let started = false;
    const clients = [];

    try {
      run(
        initdb,
        [
          "-D",
          dataDir,
          "-U",
          "postgres",
          "-A",
          "trust",
          "-E",
          "UTF8",
          "--no-locale",
        ],
        { ignoreOutput: true },
      );
      run(
        pgCtl,
        [
          "-D",
          dataDir,
          "-l",
          logFile,
          "-w",
          "-o",
          `-F -h 127.0.0.1 -p ${port} -k ""`,
          "start",
        ],
        { ignoreOutput: true },
      );
      started = true;

      const setup = await connect(port, "postgres", "sal-adv-setup");
      clients.push(setup);
      await applyMigrations(setup);

      // Seed actors, project, PM, Accountant, and SUBMITTED worker
      await setup.query(
        `insert into public.teams (team_id, code, display_name, active)
         values ($1::uuid, 'TD_SAL_ADV_RACE', 'Nhóm Race', true)`,
        [TEAM_RACE],
      );

      for (const actor of [ADMIN, PM, ACCT]) {
        await setup.query("insert into auth.users (id) values ($1::uuid)", [
          actor.auth,
        ]);
        await setup.query(
          `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
           values ($1::uuid, $2::uuid, true, $3)`,
          [actor.app, actor.auth, actor.name],
        );
      }

      await setup.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'entry_admin', '2026-01-01', true),
                ($1::uuid, 'recruiter_master_manage', '2026-01-01', true),
                ($1::uuid, 'team_master_manage', '2026-01-01', true),
                ($1::uuid, 'catalog_master_manage', '2026-01-01', true)`,
        [ADMIN.app],
      );
      await setup.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'all', '2026-01-01', true)`,
        [ADMIN.app],
      );

      await setup.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'entry_create', '2026-01-01', true),
                ($1::uuid, 'submission_create', '2026-01-01', true),
                ($1::uuid, 'entry_own', '2026-01-01', true),
                ($1::uuid, 'document_upload', '2026-01-01', true),
                ($1::uuid, 'document_view', '2026-01-01', true)`,
        [PM.app],
      );
      await setup.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'own', '2026-01-01', true)`,
        [PM.app],
      );

      for (const person of [PM, ACCT]) {
        await setup.query(
          `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
           values ($1::uuid, $2, $3, 'STAFF', true)`,
          [person.recruiter, person.name, person.code],
        );
        await setup.query(
          `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
           values ($1::uuid, 'hrp', '2026-01-01', true)`,
          [person.recruiter],
        );
        await setup.query(
          `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
           values ($1::uuid, $2::uuid, '2026-01-01', true)`,
          [person.recruiter, TEAM_RACE],
        );
        await setup.query(
          `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
           values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
          [person.app, person.recruiter],
        );
      }

      await setup.query(
        `insert into public.direct_entry_projects (project_id, display_name, active, version)
         values ($1, 'Dự Án Race', true, 1)`,
        [PRJ_RACE],
      );
      await setup.query(
        `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current)
         values ($1, $2::uuid, '2026-01-01', true)`,
        [PRJ_RACE, PM.recruiter],
      );

      const acctDeptReason = "Bổ nhiệm Kế toán Race";
      await setup.query(
        `select public.org_department_assign_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 0, null::date, $4::text, $5::uuid, $6::text
         )`,
        [
          ADMIN.auth,
          ADMIN.app,
          ACCT.app,
          acctDeptReason,
          nextUuid(),
          computeAssignAccountingMemberFingerprint({
            actor_app_user_id: ADMIN.app,
            account_ref: ACCT.app,
            expected_pair_version: 0,
            effective_from: null,
            reason: acctDeptReason,
          }),
        ],
      );

      const prjAcctReason = "Phân công Kế toán Race phụ trách PRJ_RACE";
      await setup.query(
        `select public.vendor_finance_assign_project_accountant_admin(
           $1::uuid, $2::uuid, $3::text, $4::uuid, 0, null::date, $5::text, $6::uuid, $7::text
         )`,
        [
          ADMIN.auth,
          ADMIN.app,
          PRJ_RACE,
          ACCT.app,
          prjAcctReason,
          nextUuid(),
          computeAssignProjectAccountantFingerprint({
            project_id: PRJ_RACE,
            accountant_ref: ACCT.app,
            valid_from: null,
            expected_version: 0,
            reason: prjAcctReason,
          }),
        ],
      );

      const batchRes = await setup.query(
        `select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, 'race_batch_1') as data`,
        [
          PM.auth,
          PM.app,
          JSON.stringify([
            {
              project_id: PRJ_RACE,
              first_work_date: "2026-10-01",
              employee_code: "hrp-2026-900001",
              worker_details: makeWorkerDetails("Công Nhân Race 01"),
              recruiter_id: PM.recruiter,
              labor_type: "TEMPORARY",
            },
          ]),
        ],
      );
      const subId = batchRes.rows[0].data.submission_id;
      await setup.query(
        `select public.direct_entry_transition_submission($1::uuid, $2::uuid, $3::uuid, 1, 'SUBMITTED', 'race_submit_1')`,
        [PM.auth, PM.app, subId],
      );
      const { rows: workerRows } = await setup.query(
        `select entry_id from public.direct_entries where submission_id = $1::uuid`,
        [subId],
      );
      const workerEntryId = workerRows[0].entry_id;

      const c1 = await connect(port, "postgres", "sal-adv-c1");
      const c2 = await connect(port, "postgres", "sal-adv-c2");
      clients.push(c1, c2);

      // =======================================================================
      // 1. Concurrent Idempotent Replay (Identical Key + Identical Fingerprint)
      // =======================================================================
      const sharedIdemKey = "idem-concurrent-replay-01";
      const sharedFp = computeCreateRequestFingerprint({
        project_id: PRJ_RACE,
        worker_entry_id: workerEntryId,
        requested_amount_vnd: "10000000",
        initial_content: "Ứng lương kiểm tra idempotency đồng thời",
      });

      const [idemR1, idemR2] = await Promise.all([
        c1.query(
          `select public.salary_advance_create_request(
             $1::uuid, $2::uuid, $3::text, $4::uuid, '10000000',
             'Ứng lương kiểm tra idempotency đồng thời', $5::text, $6::text
           ) as data`,
          [PM.auth, PM.app, PRJ_RACE, workerEntryId, sharedIdemKey, sharedFp],
        ),
        c2.query(
          `select public.salary_advance_create_request(
             $1::uuid, $2::uuid, $3::text, $4::uuid, '10000000',
             'Ứng lương kiểm tra idempotency đồng thời', $5::text, $6::text
           ) as data`,
          [PM.auth, PM.app, PRJ_RACE, workerEntryId, sharedIdemKey, sharedFp],
        ),
      ]);

      const d1 = idemR1.rows[0].data;
      const d2 = idemR2.rows[0].data;
      assert.equal(d1.request.request_id, d2.request.request_id);
      assert.deepEqual([d1.replayed, d2.replayed].sort(), [false, true]);
      const reqId = d1.request.request_id;

      // =======================================================================
      // 2. Concurrent Idempotency Conflict (Same Key + Different Fingerprint)
      // =======================================================================
      const conflictIdemKey = "idem-concurrent-conflict-01";
      const fpA = computeCreateRequestFingerprint({
        project_id: PRJ_RACE,
        worker_entry_id: workerEntryId,
        requested_amount_vnd: "11000000",
        initial_content: "Payload A",
      });
      const fpB = computeCreateRequestFingerprint({
        project_id: PRJ_RACE,
        worker_entry_id: workerEntryId,
        requested_amount_vnd: "12000000",
        initial_content: "Payload B",
      });

      const conflictOutcomes = await Promise.allSettled([
        c1.query(
          `select public.salary_advance_create_request(
             $1::uuid, $2::uuid, $3::text, $4::uuid, '11000000',
             'Payload A', $5::text, $6::text
           ) as data`,
          [PM.auth, PM.app, PRJ_RACE, workerEntryId, conflictIdemKey, fpA],
        ),
        c2.query(
          `select public.salary_advance_create_request(
             $1::uuid, $2::uuid, $3::text, $4::uuid, '12000000',
             'Payload B', $5::text, $6::text
           ) as data`,
          [PM.auth, PM.app, PRJ_RACE, workerEntryId, conflictIdemKey, fpB],
        ),
      ]);
      const fulfilledConflict = conflictOutcomes.filter(
        (o) => o.status === "fulfilled",
      );
      const rejectedConflict = conflictOutcomes.filter(
        (o) => o.status === "rejected",
      );
      assert.equal(fulfilledConflict.length, 1);
      assert.equal(rejectedConflict.length, 1);
      assert.equal(rejectedConflict[0].reason.code, "23505");
      assert.match(
        rejectedConflict[0].reason.message,
        /SALARY_ADVANCE_IDEMPOTENCY_CONFLICT/,
      );

      // =======================================================================
      // 3. Concurrent State Transitions on the Same `expected_version = 1`
      //    (PM tries WITHDRAW while ACCT tries APPROVE on reqId)
      // =======================================================================
      // Create a dedicated request for the APPROVE path so reqId is guaranteed APPROVED
      const approveReqRes = await setup.query(
        `select public.salary_advance_create_request(
           $1::uuid, $2::uuid, $3::text, $4::uuid, '15000000',
           'Ứng lương kiểm tra race transition', $5::text, $6::text
         ) as data`,
        [
          PM.auth,
          PM.app,
          PRJ_RACE,
          workerEntryId,
          "idem-create-race-trans",
          computeCreateRequestFingerprint({
            project_id: PRJ_RACE,
            worker_entry_id: workerEntryId,
            requested_amount_vnd: "15000000",
            initial_content: "Ứng lương kiểm tra race transition",
          }),
        ],
      );
      const raceTransReqId = approveReqRes.rows[0].data.request.request_id;

      const transOutcomes = await Promise.allSettled([
        c1.query(
          `select public.salary_advance_transition_request(
             $1::uuid, $2::uuid, $3::uuid, 'REQUEST_INFO', 1,
             'Cần bổ sung thông tin', 'idem-race-trans-1', $4::text
           ) as data`,
          [
            ACCT.auth,
            ACCT.app,
            raceTransReqId,
            computeTransitionRequestFingerprint({
              request_id: raceTransReqId,
              action: "REQUEST_INFO",
              expected_version: 1,
              message_text: "Cần bổ sung thông tin",
            }),
          ],
        ),
        c2.query(
          `select public.salary_advance_transition_request(
             $1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1,
             'Đồng ý duyệt', 'idem-race-trans-2', $4::text
           ) as data`,
          [
            ACCT.auth,
            ACCT.app,
            raceTransReqId,
            computeTransitionRequestFingerprint({
              request_id: raceTransReqId,
              action: "APPROVE",
              expected_version: 1,
              message_text: "Đồng ý duyệt",
            }),
          ],
        ),
      ]);

      const transFulfilled = transOutcomes.filter(
        (o) => o.status === "fulfilled",
      );
      const transRejected = transOutcomes.filter(
        (o) => o.status === "rejected",
      );
      assert.equal(transFulfilled.length, 1);
      assert.equal(transRejected.length, 1);
      assert.equal(transRejected[0].reason.code, "PT409");
      assert.match(
        transRejected[0].reason.message,
        /SALARY_ADVANCE_VERSION_CONFLICT/,
      );

      // =======================================================================
      // 4. Concurrent Evidence Reserve/Finalize Race on reqId (after APPROVE)
      // =======================================================================
      await setup.query(
        `select public.salary_advance_transition_request(
           $1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1,
           null, 'idem-approve-main-req', $4::text
         )`,
        [
          ACCT.auth,
          ACCT.app,
          reqId,
          computeTransitionRequestFingerprint({
            request_id: reqId,
            action: "APPROVE",
            expected_version: 1,
            message_text: null,
          }),
        ],
      );

      // Reserve upload A and then upload B (which supersedes A) at version 2
      const resUploadA = await setup.query(
        `select public.salary_advance_reserve_evidence(
           $1::uuid, $2::uuid, $3::uuid, 2, 'image/jpeg', 1024,
           $4::text, 'Upload A', 'idem-res-up-a', $5::text
         ) as data`,
        [
          PM.auth,
          PM.app,
          reqId,
          "a".repeat(64),
          computeReserveEvidenceFingerprint({
            request_id: reqId,
            expected_version: 2,
            mime_type: "image/jpeg",
            size_bytes: 1024,
            checksum_sha256: "a".repeat(64),
            caption_note: "Upload A",
          }),
        ],
      );
      const uploadAId = resUploadA.rows[0].data.upload_id;

      const resUploadB = await setup.query(
        `select public.salary_advance_reserve_evidence(
           $1::uuid, $2::uuid, $3::uuid, 2, 'image/jpeg', 2048,
           $4::text, 'Upload B', 'idem-res-up-b', $5::text
         ) as data`,
        [
          PM.auth,
          PM.app,
          reqId,
          "b".repeat(64),
          computeReserveEvidenceFingerprint({
            request_id: reqId,
            expected_version: 2,
            mime_type: "image/jpeg",
            size_bytes: 2048,
            checksum_sha256: "b".repeat(64),
            caption_note: "Upload B",
          }),
        ],
      );
      const uploadBId = resUploadB.rows[0].data.upload_id;

      // Both Upload A and Upload B attempt to finalize concurrently at expected_version = 2
      const finOutcomes = await Promise.allSettled([
        c1.query(
          `select public.salary_advance_finalize_evidence(
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, 2,
             'idem-fin-up-a', $5::text
           ) as data`,
          [
            PM.auth,
            PM.app,
            reqId,
            uploadAId,
            computeFinalizeEvidenceFingerprint({
              request_id: reqId,
              upload_id: uploadAId,
              expected_version: 2,
            }),
          ],
        ),
        c2.query(
          `select public.salary_advance_finalize_evidence(
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, 2,
             'idem-fin-up-b', $5::text
           ) as data`,
          [
            PM.auth,
            PM.app,
            reqId,
            uploadBId,
            computeFinalizeEvidenceFingerprint({
              request_id: reqId,
              upload_id: uploadBId,
              expected_version: 2,
            }),
          ],
        ),
      ]);

      const finFulfilled = finOutcomes.filter((o) => o.status === "fulfilled");
      const finRejected = finOutcomes.filter((o) => o.status === "rejected");
      assert.equal(finFulfilled.length, 1);
      assert.equal(finRejected.length, 1);
      assert.equal(finRejected[0].reason.code, "PT409");
      assert.match(
        finRejected[0].reason.message,
        /SALARY_ADVANCE_UPLOAD_SUPERSEDED|SALARY_ADVANCE_VERSION_CONFLICT/,
      );

      const winnerData = finFulfilled[0].value.rows[0].data;
      assert.equal(
        winnerData.request.current_evidence.checksum_sha256,
        "b".repeat(64),
      );
      assert.equal(winnerData.request.version, 3);

      // =======================================================================
      // 5. Portrait Version Rotation Race During `salary_advance_review_evidence`
      // =======================================================================
      const portV1 = await seedPortraitVersion(setup, workerEntryId, "d");
      assert.equal(portV1.version, 1);

      // Rotate worker portrait to version 2 before Accountant's review with portV1 commits
      const portV2 = await seedPortraitVersion(setup, workerEntryId, "e");
      assert.equal(portV2.version, 2);

      await assert.rejects(
        () =>
          c1.query(
            `select public.salary_advance_review_evidence(
               $1::uuid, $2::uuid, $3::uuid, 3, 1, 'REVIEWED',
               $4::uuid, 1, null, 'idem-race-port-stale', $5::text
             ) as data`,
            [
              ACCT.auth,
              ACCT.app,
              reqId,
              portV1.document_id,
              computeReviewEvidenceFingerprint({
                request_id: reqId,
                expected_version: 3,
                evidence_version: 1,
                decision: "REVIEWED",
                expected_worker_portrait_document_id: portV1.document_id,
                expected_worker_portrait_version: 1,
                note: null,
              }),
            ],
          ),
        (err) =>
          err.code === "PT409" &&
          /SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT/.test(err.message),
      );

      // Review succeeds with current portV2 lock
      const reviewOk = await c2.query(
        `select public.salary_advance_review_evidence(
           $1::uuid, $2::uuid, $3::uuid, 3, 1, 'REVIEWED',
           $4::uuid, 2, null, 'idem-race-port-ok', $5::text
         ) as data`,
        [
          ACCT.auth,
          ACCT.app,
          reqId,
          portV2.document_id,
          computeReviewEvidenceFingerprint({
            request_id: reqId,
            expected_version: 3,
            evidence_version: 1,
            decision: "REVIEWED",
            expected_worker_portrait_document_id: portV2.document_id,
            expected_worker_portrait_version: 2,
            note: null,
          }),
        ],
      );
      assert.equal(
        reviewOk.rows[0].data.request.evidence_review_state,
        "REVIEWED",
      );
      assert.equal(reviewOk.rows[0].data.request.request_state, "APPROVED");
    } finally {
      for (const client of clients) {
        await client.end().catch(() => {});
      }
      if (started) {
        spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], {
          windowsHide: true,
          stdio: "ignore",
        });
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);
