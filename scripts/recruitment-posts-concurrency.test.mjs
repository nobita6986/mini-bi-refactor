/**
 * Phase 2 — Recruitment Posts Foundation (`recruitment_project_briefs`)
 * Real PostgreSQL Concurrency Regression Suite (`initdb` + `pg_ctl`, zero remote DB).
 *
 * Covers `T-CONC-01` .. `T-CONC-08`:
 *   - T-CONC-01: Parallel `recruitment_post_create` with different `idempotency_key`s on the same
 *     `(project_id, industrial_park_id)` -> BOTH succeed and create 2 independent `PUBLISHED` posts.
 *   - T-CONC-02: Parallel `recruitment_post_create` with identical `(actor, action, idempotency_key, payload)`
 *     -> 1 creates (`replayed: false`), 1 replays (`replayed: true`), strictly 1 brief and 1 revision.
 *   - T-CONC-03: Parallel mutations sharing `idempotency_key` with different payload/action/actor
 *     -> 1 wins, contenders fail with `PT409 RECRUITMENT_POST_IDEMPOTENCY_CONFLICT`.
 *   - T-CONC-04: Parallel `update` vs `update` and `update` vs `withdraw` with `expected_version = 1`
 *     -> 1 wins (`version = 2`), 1 fails with `PT409 RECRUITMENT_POST_STALE`.
 *   - T-CONC-05: `recruitment_post:write` advisory lock serializes `revision_seq` allocation so
 *     commit order matches `revision_seq` order without snapshot visibility inversions.
 *   - T-CONC-06: Concurrent PM unassignment holding `FOR UPDATE` on `direct_entry_projects` racing
 *     with `recruitment_post_create` -> `create` waits on project lock and fails closed with `42501`.
 *   - T-CONC-07: Concurrent `recruitment_post_list` pagination under snapshot `S` (including
 *     `province_id` and `labor_type_key` filters) racing with `update`, `withdraw`, `create`, and
 *     `industrial_park_update_admin` province move.
 *   - T-CONC-08: Mixed parallel workload across multiple clients -> `0` deadlocks (`40P01`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import {
  RECRUITMENT_POSTS_MIGRATION_NAME,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const ADMIN = {
  auth: "19900000-0000-4000-8000-000000000281",
  app: "29900000-0000-4000-8000-000000000281",
  email: "nobita6986@gmail.com",
  name: "Full Admin Recruitment Race",
};

const PM_A = {
  auth: "19900000-0000-4000-8000-000000000282",
  app: "29900000-0000-4000-8000-000000000282",
  recruiter: "39900000-0000-4000-8000-000000000282",
  email: "pma-race@hrp.local",
  name: "PM A Race",
};

const PM_RACE_UNASSIGN = {
  auth: "19900000-0000-4000-8000-000000000283",
  app: "29900000-0000-4000-8000-000000000283",
  recruiter: "39900000-0000-4000-8000-000000000283",
  email: "pm-unassign-race@hrp.local",
  name: "PM Unassign Race",
};

const VIEWER = {
  auth: "19900000-0000-4000-8000-000000000284",
  app: "29900000-0000-4000-8000-000000000284",
  email: "viewer-race@hrp.local",
  name: "Viewer Race",
};

const KEY = (n) => `98000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function makeBriefContent(overrides = {}) {
  return {
    general: {
      customer_name: "Công ty TNHH Điện tử Việt Hàn",
      investment_origin: "Hàn Quốc",
      manufacturing_industry: "Sản xuất linh kiện điện tử",
      job_description: "Lắp ráp và kiểm tra ngoại quan linh kiện điện tử",
      environment_types: ["CLEAN_ROOM", "NORMAL_ROOM"],
      work_postures: ["SITTING", "STANDING"],
      shift_pattern: "TWO_SHIFTS",
      shift_details: null,
      manager_name: "Trần Quản Lý",
      manager_phone: "0912345678",
      labor_type_keys: ["CHINH_THUC"],
      supply_schedule_text: "Tuyển liên tục các ngày trong tuần",
      expected_headcount: 100,
      ...(overrides.general ?? {}),
    },
    candidate: {
      age_min: 18,
      age_max: 40,
      gender_requirement: "ANY",
      education_requirement: "SECONDARY",
      experience_required: false,
      experience_details: null,
      accept_former_customer_workers: true,
      entry_assessment_text: "Test tay khéo và phỏng vấn trực tiếp",
      other_requirements_text: "Không dị ứng phòng sạch",
      ...(overrides.candidate ?? {}),
    },
    compensation: {
      base_salary_vnd: "6000000",
      base_salary_conditions: "Đủ 26 ngày công tiêu chuẩn",
      attendance_bonus_vnd: "500000",
      attendance_bonus_conditions: "Không đi muộn về sớm",
      living_allowance_vnd: "400000",
      living_allowance_conditions: null,
      seniority_allowance_vnd: "300000",
      seniority_allowance_conditions: "Từ tháng thứ 2",
      eyesight_allowance_vnd: null,
      eyesight_allowance_conditions: null,
      other_allowance_text: null,
      average_income_min_vnd: "9500000",
      average_income_max_vnd: "13000000",
      salary_payment_schedule: "Ngày 10 hàng tháng qua ngân hàng",
      salary_advance_available: true,
      salary_advance_amount_vnd: "2000000",
      salary_advance_schedule: "Ngày 25 hàng tháng",
      weekly_salary_available: false,
      weekly_salary_payment_schedule: null,
      day_shift_8h_vnd: "240000",
      day_shift_11h_vnd: "350000",
      night_shift_8h_vnd: "290000",
      night_shift_11h_vnd: "420000",
      sunday_day_11h_vnd: "520000",
      sunday_night_11h_vnd: "600000",
      holiday_day_11h_vnd: "780000",
      holiday_night_11h_vnd: "880000",
      ppe_provided: true,
      ppe_details: "Phát miễn phí 2 bộ quần áo và giày phòng sạch",
      other_benefits: "Hỗ trợ 2 bữa ăn ca tại nhà máy",
      ...(overrides.compensation ?? {}),
    },
    documents: {
      require_original_cccd_and_copy: true,
      require_certified_resume: false,
      require_health_certificate_within_6_months: false,
      require_photo_3x4: true,
      require_degree_or_certificate: false,
      require_social_insurance_book: false,
      require_other_documents: false,
      other_documents_text: null,
      ...(overrides.documents ?? {}),
    },
  };
}

function makeCreatePayload(projectId, parkId, overrides = {}) {
  return {
    project_id: projectId,
    industrial_park_id: parkId,
    ...makeBriefContent(overrides),
  };
}

function makeUpdatePayload(overrides = {}) {
  return makeBriefContent(overrides);
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

function run(file, args, { ignoreOutput = false, logFile } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  if (result.status !== 0) {
    const details = [
      result.stderr ? `stderr:\n${result.stderr.trim()}` : null,
      result.stdout ? `stdout:\n${result.stdout.trim()}` : null,
      logFile && existsSync(logFile)
        ? `postgres.log:\n${readFileSync(logFile, "utf8").trim()}`
        : null,
      result.error ? `spawnError: ${result.error.message}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    assert.equal(
      result.status,
      0,
      `${path.basename(file)} failed (exit=${result.status}, signal=${result.signal ?? "none"}):\n${details || "(no output captured)"}`,
    );
  }
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
  applicationName = "rp-race",
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
    .filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")
    .sort();
  assert.ok(
    names.includes(RECRUITMENT_POSTS_MIGRATION_NAME),
    `migration inventory must include ${RECRUITMENT_POSTS_MIGRATION_NAME}`,
  );
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    if (name === RECRUITMENT_POSTS_MIGRATION_NAME) {
      await client.query(
        "create role rp_nobypass_migrator nologin nobypassrls;" +
          " grant postgres to rp_nobypass_migrator with admin false, inherit true, set false;",
      );
      await client.query("begin");
      let nobypassErr = null;
      try {
        await client.query(
          "set local session authorization rp_nobypass_migrator",
        );
        await client.query(migrationSqlForTransaction(sql));
      } catch (err) {
        nobypassErr = err;
      } finally {
        await client.query("rollback; reset session authorization;");
      }
      assert.ok(
        nobypassErr,
        "Migration must fail closed on real PostgreSQL when executed by a NOBYPASSRLS role that cannot SET to the direct_entries owner",
      );
      assert.equal(nobypassErr.code, "55000");
      assert.match(nobypassErr.message, /must bypass FORCE RLS/);

      const { rows: rolledBackRows } = await client.query(
        "select to_regclass('public.recruitment_project_briefs') as rel",
      );
      assert.equal(
        rolledBackRows[0].rel,
        null,
        "Failed NOBYPASSRLS migration must roll back atomically on real PostgreSQL",
      );
    }
    await client.query(sql);
  }
}

test("Real PostgreSQL concurrency (T-CONC-01..08): multi-post same pair create, idempotent replay/conflict, OCC stale, advisory lock revision_seq serialization, PM unassign race, snapshot pagination under concurrent mutations, and zero deadlocks", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL binaries (initdb/pg_ctl) not available on PATH");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bi-rec-posts-pg-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  let started = false;

  try {
    run(initdb, [
      "--username=postgres",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-locale",
      "--encoding=UTF8",
      "--pgdata",
      dataDir,
    ]);
    run(
      pgCtl,
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-o",
        `-F -h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : ` -k ${tempDir}`}`,
        "-w",
        "start",
      ],
      { ignoreOutput: process.platform === "win32", logFile },
    );
    started = true;

    let vpBaThien1Id;
    let vpBaThien2Id;
    let ptPhuHaId;
    let ptCamKheId;
    let vinhPhucId;
    let phuThoId;

    const setup = await connect(port, "postgres", "rp-setup");
    try {
      await applyMigrations(setup);

      for (const actor of [ADMIN, PM_A, PM_RACE_UNASSIGN, VIEWER]) {
        await setup.query(
          "insert into auth.users (id, email) values ($1::uuid, $2)",
          [actor.auth, actor.email],
        );
        await setup.query(
          `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
           values ($1::uuid, $2::uuid, true, $3)`,
          [actor.app, actor.auth, actor.name],
        );
        if (actor.recruiter) {
          await setup.query(
            `insert into public.recruiters (recruiter_id, display_name, active)
             values ($1::uuid, $2, true)`,
            [actor.recruiter, actor.name],
          );
          await setup.query(
            `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
             values ($1::uuid, $2::uuid, true, '2020-01-01', true)`,
            [actor.app, actor.recruiter],
          );
        }
      }

      for (const cap of [
        "entry_admin",
        "recruiter_master_manage",
        "team_master_manage",
      ]) {
        await setup.query(
          `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
           values ($1::uuid, $2, '2020-01-01', true)`,
          [ADMIN.app, cap],
        );
      }
      await setup.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'all', '2020-01-01', true)`,
        [ADMIN.app],
      );

      await setup.query(`
        insert into public.direct_entry_projects (project_id, display_name, active)
        values
          ('PROJ_RACE_A', 'Dự án Race A', true),
          ('PROJ_RACE_UNASSIGN', 'Dự án Race Unassign', true)
        on conflict (project_id) do nothing;

        insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
        values
          ('CHINH_THUC', 'Chính thức', 'chinh_thuc', 10, true),
          ('THOI_VU', 'Thời vụ', 'thoi_vu', 20, true)
        on conflict (labor_type_key) do update
          set active = excluded.active,
              display_name = excluded.display_name;
      `);

      await setup.query(
        `insert into public.direct_entry_project_manager_assignments
           (project_id, manager_recruiter_id, valid_from, is_current)
         values
           ('PROJ_RACE_A', $1::uuid, '2026-01-01', true),
           ('PROJ_RACE_UNASSIGN', $2::uuid, '2026-01-01', true)`,
        [PM_A.recruiter, PM_RACE_UNASSIGN.recruiter],
      );

      const { rows: parkRows } = await setup.query(`
        select ip.industrial_park_id, ip.industrial_park_code, ip.province_id
          from public.industrial_parks ip
      `);
      const byCode = Object.fromEntries(
        parkRows.map((r) => [r.industrial_park_code, r]),
      );
      vpBaThien1Id = byCode.VP_BA_THIEN_1.industrial_park_id;
      vpBaThien2Id = byCode.VP_BA_THIEN_2.industrial_park_id;
      ptPhuHaId = byCode.PT_PHU_HA.industrial_park_id;
      ptCamKheId = byCode.PT_CAM_KHE.industrial_park_id;
      vinhPhucId = byCode.VP_BA_THIEN_1.province_id;
      phuThoId = byCode.PT_PHU_HA.province_id;
    } finally {
      await setup.end();
    }

    const c1 = await connect(port, "postgres", "rp-race-1");
    const c2 = await connect(port, "postgres", "rp-race-2");
    const c3 = await connect(port, "postgres", "rp-race-3");
    const c4 = await connect(port, "postgres", "rp-race-4");
    try {
      // =========================================================================
      // T-CONC-01: Two parallel `recruitment_post_create` calls on the same
      // `(project_id, industrial_park_id)` with different `idempotency_key`s
      // BOTH succeed and create two independent `PUBLISHED` posts.
      // =========================================================================
      const samePairPayload = makeCreatePayload("PROJ_RACE_A", vpBaThien1Id);
      const [conc1A, conc1B] = await Promise.all([
        c1.query(
          "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as res",
          [PM_A.auth, PM_A.app, samePairPayload, KEY(1)],
        ),
        c2.query(
          "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as res",
          [PM_A.auth, PM_A.app, samePairPayload, KEY(2)],
        ),
      ]);
      const post1A = conc1A.rows[0].res.post;
      const post1B = conc1B.rows[0].res.post;
      assert.equal(post1A.status, "PUBLISHED");
      assert.equal(post1B.status, "PUBLISHED");
      assert.notEqual(
        post1A.brief_id,
        post1B.brief_id,
        "Independent idempotency keys on the same project+park must create 2 distinct brief_ids",
      );

      // =========================================================================
      // T-CONC-02: Two parallel `recruitment_post_create` calls with identical
      // `(actor, action, idempotency_key, payload)` -> 1 creates, 1 replays, 1 row.
      // =========================================================================
      const idemReplayKey = KEY(3);
      const replayPayload = makeCreatePayload("PROJ_RACE_A", vpBaThien2Id, {
        general: { customer_name: "Công ty Replay Đồng Thời" },
      });
      const [repA, repB] = await Promise.all([
        c1.query(
          "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as res",
          [PM_A.auth, PM_A.app, replayPayload, idemReplayKey],
        ),
        c2.query(
          "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as res",
          [PM_A.auth, PM_A.app, replayPayload, idemReplayKey],
        ),
      ]);
      const resRepA = repA.rows[0].res;
      const resRepB = repB.rows[0].res;
      assert.equal(resRepA.post.brief_id, resRepB.post.brief_id);
      assert.deepEqual(
        [resRepA.replayed, resRepB.replayed].sort(),
        [false, true],
      );
      const { rows: revCountRep } = await c1.query(
        "select count(*)::int as c from public.recruitment_project_brief_revisions where brief_id = $1::uuid",
        [resRepA.post.brief_id],
      );
      assert.equal(revCountRep[0].c, 1);

      // =========================================================================
      // T-CONC-03: Two parallel `recruitment_post_create` calls sharing the same
      // `idempotency_key` with DIFFERENT payloads -> 1 succeeds, 1 fails with PT409
      // `RECRUITMENT_POST_IDEMPOTENCY_CONFLICT`.
      // =========================================================================
      const idemConflictKey = KEY(4);
      const [confA, confB] = await Promise.allSettled([
        c1.query(
          "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as res",
          [
            PM_A.auth,
            PM_A.app,
            makeCreatePayload("PROJ_RACE_A", vpBaThien1Id, {
              general: { expected_headcount: 111 },
            }),
            idemConflictKey,
          ],
        ),
        c2.query(
          "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as res",
          [
            PM_A.auth,
            PM_A.app,
            makeCreatePayload("PROJ_RACE_A", vpBaThien1Id, {
              general: { expected_headcount: 222 },
            }),
            idemConflictKey,
          ],
        ),
      ]);
      const confFulfilled = [confA, confB].filter(
        (r) => r.status === "fulfilled",
      );
      const confRejected = [confA, confB].filter(
        (r) => r.status === "rejected",
      );
      assert.equal(confFulfilled.length, 1);
      assert.equal(confRejected.length, 1);
      assert.equal(confRejected[0].reason.code, "PT409");
      assert.equal(
        confRejected[0].reason.message,
        "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT",
      );

      // =========================================================================
      // T-CONC-04: Two parallel `update` calls with `expected_version = 1` on `post1A`,
      // and parallel `update` + `withdraw` with `expected_version = 1` on `post1B`
      // -> strictly 1 wins (`version = 2`), 1 fails with `PT409 RECRUITMENT_POST_STALE`.
      // =========================================================================
      const [occUpdA, occUpdB] = await Promise.allSettled([
        c1.query(
          "select public.recruitment_post_update($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5) as res",
          [
            PM_A.auth,
            PM_A.app,
            post1A.brief_id,
            makeUpdatePayload({ general: { customer_name: "OCC Winner A" } }),
            KEY(10),
          ],
        ),
        c2.query(
          "select public.recruitment_post_update($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5) as res",
          [
            PM_A.auth,
            PM_A.app,
            post1A.brief_id,
            makeUpdatePayload({ general: { customer_name: "OCC Winner B" } }),
            KEY(11),
          ],
        ),
      ]);
      const occUpdFulfilled = [occUpdA, occUpdB].filter(
        (r) => r.status === "fulfilled",
      );
      const occUpdRejected = [occUpdA, occUpdB].filter(
        (r) => r.status === "rejected",
      );
      assert.equal(occUpdFulfilled.length, 1);
      assert.equal(occUpdRejected.length, 1);
      assert.equal(occUpdRejected[0].reason.code, "PT409");
      assert.equal(occUpdRejected[0].reason.message, "RECRUITMENT_POST_STALE");
      assert.equal(occUpdFulfilled[0].value.rows[0].res.post.version, 2);

      const [occMixUpd, occMixWd] = await Promise.allSettled([
        c1.query(
          "select public.recruitment_post_update($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5) as res",
          [
            PM_A.auth,
            PM_A.app,
            post1B.brief_id,
            makeUpdatePayload({ general: { customer_name: "Mix Update" } }),
            KEY(12),
          ],
        ),
        c2.query(
          "select public.recruitment_post_withdraw($1::uuid, $2::uuid, $3::uuid, 1, $4) as res",
          [PM_A.auth, PM_A.app, post1B.brief_id, KEY(13)],
        ),
      ]);
      const occMixFulfilled = [occMixUpd, occMixWd].filter(
        (r) => r.status === "fulfilled",
      );
      const occMixRejected = [occMixUpd, occMixWd].filter(
        (r) => r.status === "rejected",
      );
      assert.equal(occMixFulfilled.length, 1);
      assert.equal(occMixRejected.length, 1);
      assert.equal(occMixRejected[0].reason.code, "PT409");
      assert.equal(occMixRejected[0].reason.message, "RECRUITMENT_POST_STALE");

      // =========================================================================
      // T-CONC-05: `recruitment_post:write` advisory lock serializes `revision_seq`
      // allocation and commit order across transactions on different posts.
      // Hold `BEGIN` on `c1` with a mutation on `post1A`, start `c2` mutation on
      // `resRepA.post.brief_id` (which blocks on `recruitment_post:write`), verify `c3`
      // snapshot read before `c1` commit does not see either, then commit `c1` and verify
      // `c1`'s `revision_seq` < `c2`'s `revision_seq`.
      // =========================================================================
      await c1.query("begin");
      const tx1Res = await c1.query(
        "select public.recruitment_post_update($1::uuid, $2::uuid, $3::uuid, 2, $4::jsonb, $5) as res",
        [
          PM_A.auth,
          PM_A.app,
          post1A.brief_id,
          makeUpdatePayload({ general: { customer_name: "Tx1 Serialized" } }),
          KEY(20),
        ],
      );
      const tx2Promise = c2.query(
        "select public.recruitment_post_update($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5) as res",
        [
          PM_A.auth,
          PM_A.app,
          resRepA.post.brief_id,
          makeUpdatePayload({ general: { customer_name: "Tx2 Serialized" } }),
          KEY(21),
        ],
      );

      // Give c2 a moment to block on the `recruitment_post:write` advisory lock
      await new Promise((r) => setTimeout(r, 80));

      await c1.query("commit");
      const tx2Res = await tx2Promise;
      assert.equal(tx1Res.rows[0].res.post.version, 3);
      assert.equal(tx2Res.rows[0].res.post.version, 2);

      const { rows: seqRows } = await c3.query(
        `select brief_id, version, revision_seq
           from public.recruitment_project_brief_revisions
          where (brief_id = $1::uuid and version = 3)
             or (brief_id = $2::uuid and version = 2)`,
        [post1A.brief_id, resRepA.post.brief_id],
      );
      const tx1Seq = BigInt(
        seqRows.find((r) => r.brief_id === post1A.brief_id).revision_seq,
      );
      const tx2Seq = BigInt(
        seqRows.find((r) => r.brief_id === resRepA.post.brief_id).revision_seq,
      );
      assert.ok(
        tx1Seq < tx2Seq,
        `Tx1 revision_seq (${tx1Seq}) must be strictly less than Tx2 revision_seq (${tx2Seq})`,
      );

      // =========================================================================
      // T-CONC-06: Concurrent PM unassignment (holding `FOR UPDATE` on
      // `direct_entry_projects` and revoking `direct_entry_project_manager_assignments`)
      // racing with `recruitment_post_create` by `PM_RACE_UNASSIGN`.
      // `create` waits on the project row lock and then fails closed with `42501`.
      // =========================================================================
      await c1.query("begin");
      await c1.query(
        "select 1 from public.direct_entry_projects where project_id = 'PROJ_RACE_UNASSIGN' for update",
      );
      await c1.query(
        `update public.direct_entry_project_manager_assignments
            set is_current = false,
                valid_to = '2026-11-10'::date,
                revoked_at = '2026-11-10T00:00:00Z'::timestamptz
          where project_id = 'PROJ_RACE_UNASSIGN'
            and manager_recruiter_id = $1::uuid`,
        [PM_RACE_UNASSIGN.recruiter],
      );

      const blockedCreatePromise = c2
        .query(
          "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as res",
          [
            PM_RACE_UNASSIGN.auth,
            PM_RACE_UNASSIGN.app,
            makeCreatePayload("PROJ_RACE_UNASSIGN", vpBaThien1Id),
            KEY(30),
          ],
        )
        .then(
          () => ({ status: "fulfilled" }),
          (reason) => ({ status: "rejected", reason }),
        );

      await new Promise((r) => setTimeout(r, 80));
      await c1.query("commit");

      const blockedCreateOutcome = await blockedCreatePromise;
      assert.equal(blockedCreateOutcome.status, "rejected");
      assert.equal(blockedCreateOutcome.reason.code, "42501");
      assert.equal(
        blockedCreateOutcome.reason.message,
        "RECRUITMENT_POST_ACCESS_DENIED",
      );

      // =========================================================================
      // T-CONC-07: Concurrent `recruitment_post_list` pagination under snapshot `S`
      // (with `labor_type_key` and `province_id` filters) running alongside `update`,
      // `withdraw`, `create`, and `industrial_park_update_admin` (moving province).
      // =========================================================================
      // Seed 12 posts in ptPhuHaId with THOI_VU so page 1 has 10 and page 2 has 2
      const ptCreatedIds = [];
      for (let i = 1; i <= 12; i += 1) {
        const { rows } = await c1.query(
          "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as res",
          [
            PM_A.auth,
            PM_A.app,
            makeCreatePayload("PROJ_RACE_A", ptPhuHaId, {
              general: {
                customer_name: `Phú Hà Race #${i}`,
                labor_type_keys: ["THOI_VU"],
              },
            }),
            KEY(100 + i),
          ],
        );
        ptCreatedIds.push(rows[0].res.post.brief_id);
      }

      const page1Res = await c3.query(
        "select public.recruitment_post_list($1::uuid, $2::uuid, null::text, $3::uuid, null::uuid, 'THOI_VU'::text, null::date, null::date, null::text, null::text, 10) as res",
        [VIEWER.auth, VIEWER.app, phuThoId],
      );
      const page1 = page1Res.rows[0].res;
      assert.equal(page1.items.length, 10);
      assert.equal(page1.has_more, true);

      // Concurrently while reader holds snapshot_token + next_cursor:
      // - c1 updates a page-1 post to CHINH_THUC
      // - c2 creates a new THOI_VU post in ptPhuHaId
      // - c3 withdraws one of the 2 posts on page 2 (`ptCreatedIds[0]`, the oldest of the 12)
      // - c4 (Admin) attempts to move ptPhuHaId to vinhPhucId -> blocked by PT409
      // - c4 (Admin) moves ptCamKheId (which has 0 PUBLISHED posts) to vinhPhucId -> succeeds
      const withdrawnPage2Id = ptCreatedIds[0];
      const remainingPage2Id = ptCreatedIds[1];
      const [mutUpd, mutCreate, mutWithdraw, moveBlocked, moveEmptySuccess] =
        await Promise.allSettled([
          c1.query(
            "select public.recruitment_post_update($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5) as res",
            [
              PM_A.auth,
              PM_A.app,
              page1.items[0].brief_id,
              makeUpdatePayload({
                general: {
                  customer_name: "Đổi sang CHINH_THUC sau snapshot",
                  labor_type_keys: ["CHINH_THUC"],
                },
              }),
              KEY(201),
            ],
          ),
          c2.query(
            "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as res",
            [
              PM_A.auth,
              PM_A.app,
              makeCreatePayload("PROJ_RACE_A", ptPhuHaId, {
                general: {
                  customer_name: "Tạo mới sau snapshot",
                  labor_type_keys: ["THOI_VU"],
                },
              }),
              KEY(202),
            ],
          ),
          c3.query(
            "select public.recruitment_post_withdraw($1::uuid, $2::uuid, $3::uuid, 1, $4) as res",
            [PM_A.auth, PM_A.app, withdrawnPage2Id, KEY(205)],
          ),
          c4.query(
            "select public.industrial_park_update_admin($1::uuid, $2::uuid, $3::uuid, 1, $4::uuid, null, 'Move park with published posts', $5) as res",
            [ADMIN.auth, ADMIN.app, ptPhuHaId, vinhPhucId, KEY(203)],
          ),
          c4.query(
            "select public.industrial_park_update_admin($1::uuid, $2::uuid, $3::uuid, 1, $4::uuid, null, 'Move empty park', $5) as res",
            [ADMIN.auth, ADMIN.app, ptCamKheId, vinhPhucId, KEY(204)],
          ),
        ]);

      assert.equal(mutUpd.status, "fulfilled");
      assert.equal(mutCreate.status, "fulfilled");
      assert.equal(mutWithdraw.status, "fulfilled");
      assert.equal(moveBlocked.status, "rejected");
      assert.equal(moveBlocked.reason.code, "PT409");
      assert.equal(
        moveBlocked.reason.message,
        "INDUSTRIAL_PARK_HAS_PUBLISHED_POSTS",
      );
      assert.equal(moveEmptySuccess.status, "fulfilled");

      const page2Res = await c3.query(
        "select public.recruitment_post_list($1::uuid, $2::uuid, null::text, $3::uuid, null::uuid, 'THOI_VU'::text, null::date, null::date, $4::text, $5::text, 10) as res",
        [
          VIEWER.auth,
          VIEWER.app,
          phuThoId,
          page1.next_cursor,
          page1.snapshot_token,
        ],
      );
      const page2 = page2Res.rows[0].res;
      assert.deepEqual(
        page2.items.map((item) => item.brief_id),
        [remainingPage2Id],
        "Page 2 must exclude the concurrently withdrawn post and the post created after S, while keeping remainingPage2Id",
      );
      assert.equal(page2.has_more, false);
      const combinedIds = [...page1.items, ...page2.items].map(
        (item) => item.brief_id,
      );
      assert.equal(new Set(combinedIds).size, 11);
      assert.ok(
        !combinedIds.includes(withdrawnPage2Id),
        "Withdrawn post must never appear in page 2",
      );
      assert.ok(
        !combinedIds.includes(mutCreate.value.rows[0].res.post.brief_id),
        "Post created after snapshot S must not leak into page 2",
      );

      // =========================================================================
      // T-CONC-08: Mixed parallel workload (`create`, `update`, `withdraw`,
      // `industrial_park_update_admin`, `recruitment_post_list`) -> 0 deadlocks (`40P01`).
      // =========================================================================
      const workloadOutcomes = await Promise.allSettled([
        c1.query(
          "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as res",
          [
            PM_A.auth,
            PM_A.app,
            makeCreatePayload("PROJ_RACE_A", vpBaThien1Id, {
              general: { customer_name: "Workload Create 1" },
            }),
            KEY(301),
          ],
        ),
        c2.query(
          "select public.recruitment_post_update($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5) as res",
          [
            PM_A.auth,
            PM_A.app,
            ptCreatedIds[2],
            makeUpdatePayload({
              general: { customer_name: "Workload Update" },
            }),
            KEY(302),
          ],
        ),
        c3.query(
          "select public.recruitment_post_withdraw($1::uuid, $2::uuid, $3::uuid, 1, $4) as res",
          [PM_A.auth, PM_A.app, ptCreatedIds[3], KEY(303)],
        ),
        c4.query(
          "select public.industrial_park_update_admin($1::uuid, $2::uuid, $3::uuid, 1, $4::uuid, null, 'Concurrent province move attempt', $5) as res",
          [ADMIN.auth, ADMIN.app, vpBaThien1Id, phuThoId, KEY(304)],
        ),
      ]);

      for (const outcome of workloadOutcomes) {
        if (outcome.status === "rejected") {
          assert.notEqual(
            outcome.reason?.code,
            "40P01",
            `Must never deadlock (40P01), got: ${outcome.reason?.message}`,
          );
        }
      }
    } finally {
      await Promise.all([c1.end(), c2.end(), c3.end(), c4.end()]);
    }
  } finally {
    if (started) {
      run(pgCtl, ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
        ignoreOutput: process.platform === "win32",
        logFile,
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
