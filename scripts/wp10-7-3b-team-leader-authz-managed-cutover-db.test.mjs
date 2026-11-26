/**
 * WP10-7 Slice 3B — Team Leader `authz_managed = true` Cutover
 * Real Isolated PostgreSQL 18 Upgrade (0..251 -> #252), Skew Matrix, Lifecycle,
 * Runtime-vs-Mirror Parity, Concurrency Barriers, and Incident Recovery Drill.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against an
 * isolated native PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Verifies ALL mandatory WP10-7 Slice 3B requirements:
 *   1. Migration #252 hygiene (LF, 0 `@`, 0 `SAVEPOINT`, 0 `'40001'`, 0 `ALTER DEFAULT PRIVILEGES`),
 *      atomic rollback zero drift, `+0` net `service_role` RPCs, and pre-3B -> post-3B upgrade:
 *      - Pre-3B `authz_managed = true` TLs (with `scope('team')` + `team_manager_assign` + 4 `wr_bridge` rows)
 *        replace/revoke cleanly post-3B (0 `23514`/`55000`), closing old `scope`/`cap`/`wr_bridge` rows
 *        while PRESERVING capabilities still granted by an active Permission Group.
 *   2. Skewed legacy grants matrix (6/6 on same `authz_managed = true` candidate):
 *      - `scope('team', TEAM_B)`, `scope('team', TEAM_A)`, `cap('team_manager_assign')`,
 *        `cap('entry_team')`, future `scope('team', TEAM_A)`, future `cap('team_manager_assign')`.
 *      - `list_team_leader_candidates` (`visible = true`) -> `designate` (0 `42501`/`23P01`/`23505`,
 *        0 new `cap`/`scope`/`wr_bridge` rows) -> `replace` -> same-day `revoke` (`v_restore`,
 *        including mixed `v_previous` unmanaged + `v_old` managed).
 *      - Rejections: wrong Org (`23514`), wrong team/membership (`42501`), actor missing privilege (`42501`),
 *        OCC `PT409`, and idempotency replay returning the exact original payload.
 *   3. Disable/Enable, `sync_legacy_grants`, Runtime vs Legacy Mirror parity across domains & #42:
 *      - (a) Disable -> Enable (no conflict): locked state (`enabled=false`, `caps=[]`, `wr_rev=42501`);
 *            re-enabled runtime (all 6 TL/WR caps, Work Reports `list_assignment_options`/
 *            `list_pending_reviews`/`create_assignment`/`decide_review`/`analytics_overview`/
 *            `list_my_obligations`/`has_active_obligations`, Attendance `monthly_matrix`/`admin_report`,
 *            Leave routing/create/approve & Attendance Explanation submit/approve) vs legacy mirror
 *            (`wr_bridge = 0`, mirror lacks `report_review` & `scope('team')` yet runtime has `report_review = true`).
 *      - (b) Disable -> Replace with `CAND_2` while locked -> Enable `CAND_1`: `CAND_1` never regains TL/WR/Leave;
 *            `CAND_2` receives full runtime authority.
 *      - (c) Edit Permission Group (runs `sync_legacy_grants`) while 3B TL active -> Revoke ->
 *            candidate reappears in candidate list and re-designate succeeds (`0` `42501`).
 *      - (d) #42 guards: `move_team_membership` and `unassign_team_membership` block active & suspended 3B TL
 *            (`PT409`) and succeed after revoke.
 *   4. Preservation of `authz_managed = false` lifecycle/guards + Real PG18 Barrier Concurrency:
 *      - `authz_managed = false` on `TEAM_B`: designate/replace/revoke/disable/enable still write & close
 *        `scope_grants`, `cap_grants`, and 4 `work_report_team_leader_capability_grants` rows + keep overlap guards.
 *      - PG18 lock barriers (`wait_event_type = 'Lock'`, `pg_locks.granted = false`, 0 `40P01` deadlocks):
 *        2 concurrent `designate` calls, `designate` vs `move_team_membership`, `designate` vs `disable_app_user`.
 *   5. Post-3B Incident & Full Recovery Drill:
 *      - (a) Restoring ONLY the 3 pre-3B function definitions (no data backfill): `revoke` on post-3B TL
 *            fails with SQLSTATE `23514` (`leader authority interval state conflict`).
 *      - (b) Running the exact runbook SQL backfill + restoring the 3 pre-3B functions & ACLs: `revoke` on
 *            post-3B TL assignments (active, synced-partial, suspended after enable, and same-day replace)
 *            succeeds cleanly (`change = 'revoke'`) with 0 `23514`/`55000`/`23P01`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

import {
  projectAttendanceExplanationApprovalInbox,
  projectSubmitAttendanceExplanationResult,
} from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import { computeCreatePersonFingerprint } from "../src/lib/organization/person-contract.ts";
import {
  migrationChecksum,
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  runMigrationApply,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP10_7_2B_MIGRATION_NAME =
  "20261126210000_wp10_7_2b_drop_leave_profile_unit_kind.sql";
const WP10_7_3B_MIGRATION_NAME =
  "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql";
const EXPECTED_TL_GUARD_MSG = "recruiter holds active or restorable team leader assignment";

const ROLE_PREAMBLE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);";

const OWNER = {
  auth: "95100000-0000-4000-8000-00000000a001",
  app: "95100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-7-3B",
};
const LUANPT = {
  auth: "95100000-0000-4000-8000-00000000a002",
  app: "95100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "95100000-0000-4000-8000-00000000a003",
  app: "95100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "95100000-0000-4000-8000-00000000a004",
  app: "95100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

const TARGET_3B_FUNCTIONS = [
  "direct_entry_list_team_leader_candidates",
  "direct_entry_apply_team_leader_mutation",
  "work_report_sync_team_leader_capabilities",
];

// Exact Step 1 backfill SQL from WP10-7 Slice 3B Runbook Section 4.3
const RUNBOOK_EMERGENCY_BACKFILL_DO_SQL = `
DO $wp10_7_3b_emergency_backfill$
DECLARE
  v_today date := public.direct_entry_authorization_date();
  v_prev_marker text := pg_catalog.current_setting('direct_entry.team_leader_marker', true);
  v_a record;
  v_cap text;
  v_grant_id uuid;
  v_existing_grant_id uuid;
  v_grant_from date;
  v_lock_key text;
  v_missing_cnt integer;
BEGIN
  PERFORM pg_catalog.set_config('direct_entry.team_leader_marker', 'on', true);

  PERFORM s.grant_id
    FROM public.direct_entry_scope_grants s
   WHERE s.app_user_id IN (
     SELECT DISTINCT a.leader_app_user_id
       FROM public.direct_entry_team_leader_assignments a
      WHERE a.is_current OR a.suspended_by_account_disable OR a.valid_to = v_today
   )
   ORDER BY s.grant_id ASC
   FOR UPDATE;

  FOR v_lock_key IN
    SELECT DISTINCT 'scope:' || a.leader_app_user_id::text || ':team:' || a.team_id::text AS k
      FROM public.direct_entry_team_leader_assignments a
     WHERE a.is_current OR a.suspended_by_account_disable OR a.valid_to = v_today
     ORDER BY k ASC
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 0));
  END LOOP;

  PERFORM a.assignment_id
    FROM public.direct_entry_team_leader_assignments a
   WHERE a.is_current OR a.suspended_by_account_disable OR a.valid_to = v_today
   ORDER BY a.assignment_id ASC
   FOR UPDATE;

  PERFORM g.grant_id
    FROM public.direct_entry_capability_grants g
   WHERE g.app_user_id IN (
     SELECT DISTINCT a.leader_app_user_id
       FROM public.direct_entry_team_leader_assignments a
      WHERE a.is_current OR a.suspended_by_account_disable OR a.valid_to = v_today
   )
   ORDER BY g.grant_id ASC
   FOR UPDATE;

  FOR v_lock_key IN
    SELECT DISTINCT 'capability:' || a.leader_app_user_id::text || ':' || cap AS k
      FROM public.direct_entry_team_leader_assignments a
      CROSS JOIN unnest(ARRAY[
        'team_manager_assign', 'report_view', 'report_analytics_view', 'report_assign', 'report_review'
      ]) AS cap
     WHERE a.is_current OR a.suspended_by_account_disable OR a.valid_to = v_today
     ORDER BY k ASC
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 0));
  END LOOP;

  FOR v_a IN
    SELECT a.*
      FROM public.direct_entry_team_leader_assignments a
     WHERE a.is_current = true OR a.suspended_by_account_disable = true
     ORDER BY a.valid_from ASC, a.assignment_id ASC
  LOOP
    SELECT s.grant_id
      INTO v_existing_grant_id
      FROM public.direct_entry_scope_grants s
     WHERE s.app_user_id = v_a.leader_app_user_id
       AND s.scope_kind = 'team'
       AND s.team_id = v_a.team_id
       AND s.valid_from <= v_a.valid_from
       AND s.valid_to IS NOT DISTINCT FROM v_a.valid_to
       AND (s.valid_to IS NULL OR s.valid_to > s.valid_from)
     ORDER BY s.valid_from DESC, s.grant_id DESC
     LIMIT 1;

    IF v_existing_grant_id IS NOT NULL THEN
      UPDATE public.direct_entry_scope_grants s
         SET is_current = false,
             suspended_by_account_disable = false,
             valid_to = CASE
               WHEN s.valid_from < v_a.valid_from THEN v_a.valid_from
               ELSE s.valid_from
             END
       WHERE s.app_user_id = v_a.leader_app_user_id
         AND s.scope_kind = 'team'
         AND s.grant_id <> v_existing_grant_id
         AND (
           s.is_current
           OR s.suspended_by_account_disable
           OR (
             (s.valid_to IS NULL OR s.valid_to > s.valid_from)
             AND pg_catalog.daterange(s.valid_from, s.valid_to, '[)')
                 && pg_catalog.daterange(v_a.valid_from, v_a.valid_to, '[)')
           )
         );

      UPDATE public.direct_entry_scope_grants s
         SET is_current = v_a.is_current,
             suspended_by_account_disable = v_a.suspended_by_account_disable
       WHERE s.grant_id = v_existing_grant_id
         AND (
           s.is_current IS DISTINCT FROM v_a.is_current
           OR s.suspended_by_account_disable IS DISTINCT FROM v_a.suspended_by_account_disable
         );
    ELSE
      UPDATE public.direct_entry_scope_grants s
         SET is_current = false,
             suspended_by_account_disable = false,
             valid_to = CASE
               WHEN s.valid_from < v_a.valid_from THEN v_a.valid_from
               ELSE s.valid_from
             END
       WHERE s.app_user_id = v_a.leader_app_user_id
         AND s.scope_kind = 'team'
         AND (
           s.is_current
           OR s.suspended_by_account_disable
           OR (
             (s.valid_to IS NULL OR s.valid_to > s.valid_from)
             AND pg_catalog.daterange(s.valid_from, s.valid_to, '[)')
                 && pg_catalog.daterange(v_a.valid_from, v_a.valid_to, '[)')
           )
         );

      INSERT INTO public.direct_entry_scope_grants (
        app_user_id, scope_kind, team_id, valid_from, valid_to, is_current, suspended_by_account_disable
      ) VALUES (
        v_a.leader_app_user_id, 'team', v_a.team_id, v_a.valid_from, v_a.valid_to,
        v_a.is_current, v_a.suspended_by_account_disable
      );
    END IF;

    SELECT g.grant_id
      INTO v_existing_grant_id
      FROM public.direct_entry_capability_grants g
     WHERE g.app_user_id = v_a.leader_app_user_id
       AND g.capability = 'team_manager_assign'
       AND g.valid_from = v_a.valid_from
       AND g.valid_to IS NOT DISTINCT FROM v_a.valid_to
       AND (g.valid_to IS NULL OR g.valid_to > g.valid_from)
     ORDER BY g.grant_id DESC
     LIMIT 1;

    IF v_existing_grant_id IS NOT NULL THEN
      UPDATE public.direct_entry_capability_grants g
         SET is_current = false,
             suspended_by_account_disable = false,
             valid_to = CASE
               WHEN g.valid_from < v_a.valid_from THEN v_a.valid_from
               ELSE g.valid_from
             END
       WHERE g.app_user_id = v_a.leader_app_user_id
         AND g.capability = 'team_manager_assign'
         AND g.grant_id <> v_existing_grant_id
         AND (
           g.is_current
           OR g.suspended_by_account_disable
           OR (
             (g.valid_to IS NULL OR g.valid_to > g.valid_from)
             AND pg_catalog.daterange(g.valid_from, g.valid_to, '[)')
                 && pg_catalog.daterange(v_a.valid_from, v_a.valid_to, '[)')
           )
         );

      UPDATE public.direct_entry_capability_grants g
         SET is_current = v_a.is_current,
             suspended_by_account_disable = v_a.suspended_by_account_disable
       WHERE g.grant_id = v_existing_grant_id
         AND (
           g.is_current IS DISTINCT FROM v_a.is_current
           OR g.suspended_by_account_disable IS DISTINCT FROM v_a.suspended_by_account_disable
         );
    ELSE
      UPDATE public.direct_entry_capability_grants g
         SET is_current = false,
             suspended_by_account_disable = false,
             valid_to = CASE
               WHEN g.valid_from < v_a.valid_from THEN v_a.valid_from
               ELSE g.valid_from
             END
       WHERE g.app_user_id = v_a.leader_app_user_id
         AND g.capability = 'team_manager_assign'
         AND (
           g.is_current
           OR g.suspended_by_account_disable
           OR (
             (g.valid_to IS NULL OR g.valid_to > g.valid_from)
             AND pg_catalog.daterange(g.valid_from, g.valid_to, '[)')
                 && pg_catalog.daterange(v_a.valid_from, v_a.valid_to, '[)')
           )
         );

      INSERT INTO public.direct_entry_capability_grants (
        app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable
      ) VALUES (
        v_a.leader_app_user_id, 'team_manager_assign', v_a.valid_from, v_a.valid_to,
        v_a.is_current, v_a.suspended_by_account_disable
      );
    END IF;

    FOREACH v_cap IN ARRAY ARRAY['report_view', 'report_analytics_view', 'report_assign', 'report_review'] LOOP
      IF NOT EXISTS (
        SELECT 1
          FROM public.work_report_team_leader_capability_grants x
          JOIN public.direct_entry_capability_grants g ON g.grant_id = x.capability_grant_id
         WHERE x.leader_assignment_id = v_a.assignment_id
           AND x.capability = v_cap
      ) THEN
        SELECT g.grant_id
          INTO v_existing_grant_id
          FROM public.direct_entry_capability_grants g
         WHERE g.app_user_id = v_a.leader_app_user_id
           AND g.capability = v_cap
           AND g.valid_to IS NULL
           AND (
             (v_a.is_current AND g.is_current = true)
             OR (v_a.suspended_by_account_disable AND NOT g.is_current AND g.suspended_by_account_disable = true)
           )
         ORDER BY g.valid_from DESC, g.grant_id DESC
         LIMIT 1;

        IF v_existing_grant_id IS NOT NULL THEN
          INSERT INTO public.work_report_team_leader_capability_grants (
            leader_assignment_id, capability, capability_grant_id
          ) VALUES (
            v_a.assignment_id, v_cap, v_existing_grant_id
          )
          ON CONFLICT (leader_assignment_id, capability) DO UPDATE
            SET capability_grant_id = EXCLUDED.capability_grant_id;
        ELSE
          UPDATE public.direct_entry_capability_grants g
             SET is_current = false,
                 suspended_by_account_disable = false,
                 valid_to = greatest(v_a.valid_from, g.valid_from)
           WHERE g.app_user_id = v_a.leader_app_user_id
             AND g.capability = v_cap
             AND NOT g.is_current
             AND g.valid_to IS NULL;

          SELECT greatest(v_a.valid_from, coalesce(max(g.valid_to), v_a.valid_from))
            INTO v_grant_from
            FROM public.direct_entry_capability_grants g
           WHERE g.app_user_id = v_a.leader_app_user_id
             AND g.capability = v_cap
             AND NOT g.is_current
             AND g.valid_to IS NOT NULL
             AND g.valid_to > g.valid_from
             AND pg_catalog.daterange(g.valid_from, g.valid_to, '[)')
                 && pg_catalog.daterange(v_a.valid_from, NULL, '[)');

          UPDATE public.direct_entry_capability_grants g
             SET is_current = false,
                 suspended_by_account_disable = false,
                 valid_to = g.valid_from
           WHERE g.app_user_id = v_a.leader_app_user_id
             AND g.capability = v_cap
             AND g.valid_from >= v_grant_from
             AND (g.valid_to IS NULL OR g.valid_to > g.valid_from);

          INSERT INTO public.direct_entry_capability_grants (
            app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable
          ) VALUES (
            v_a.leader_app_user_id, v_cap, v_grant_from, NULL,
            v_a.is_current, v_a.suspended_by_account_disable
          )
          RETURNING grant_id INTO v_grant_id;

          INSERT INTO public.work_report_team_leader_capability_grants (
            leader_assignment_id, capability, capability_grant_id
          ) VALUES (
            v_a.assignment_id, v_cap, v_grant_id
          )
          ON CONFLICT (leader_assignment_id, capability) DO UPDATE
            SET capability_grant_id = EXCLUDED.capability_grant_id;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  FOR v_a IN
    SELECT a.*
      FROM public.direct_entry_team_leader_assignments a
     WHERE NOT a.is_current
       AND NOT a.suspended_by_account_disable
       AND a.valid_to = v_today
       AND a.valid_to > a.valid_from
       AND EXISTS (
         SELECT 1
           FROM public.direct_entry_team_leader_assignments newer
          WHERE newer.team_id = a.team_id
            AND newer.is_current = true
            AND newer.valid_from = v_today
       )
     ORDER BY a.valid_from ASC, a.assignment_id ASC
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.direct_entry_scope_grants s
       WHERE s.app_user_id = v_a.leader_app_user_id
         AND s.scope_kind = 'team'
         AND s.team_id = v_a.team_id
         AND s.valid_from <= v_a.valid_from
         AND s.valid_to = v_a.valid_to
         AND s.valid_to > s.valid_from
    ) AND NOT EXISTS (
      SELECT 1 FROM public.direct_entry_scope_grants s
       WHERE s.app_user_id = v_a.leader_app_user_id
         AND s.scope_kind = 'team'
         AND s.team_id = v_a.team_id
         AND (s.valid_to IS NULL OR s.valid_to > s.valid_from)
         AND pg_catalog.daterange(s.valid_from, s.valid_to, '[)')
             && pg_catalog.daterange(v_a.valid_from, v_a.valid_to, '[)')
    ) THEN
      INSERT INTO public.direct_entry_scope_grants (
        app_user_id, scope_kind, team_id, valid_from, valid_to, is_current, suspended_by_account_disable
      ) VALUES (
        v_a.leader_app_user_id, 'team', v_a.team_id, v_a.valid_from, v_a.valid_to, false, false
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.direct_entry_capability_grants g
       WHERE g.app_user_id = v_a.leader_app_user_id
         AND g.capability = 'team_manager_assign'
         AND g.valid_from = v_a.valid_from
         AND g.valid_to = v_a.valid_to
         AND g.valid_to > g.valid_from
    ) AND NOT EXISTS (
      SELECT 1 FROM public.direct_entry_capability_grants g
       WHERE g.app_user_id = v_a.leader_app_user_id
         AND g.capability = 'team_manager_assign'
         AND (g.valid_to IS NULL OR g.valid_to > g.valid_from)
         AND pg_catalog.daterange(g.valid_from, g.valid_to, '[)')
             && pg_catalog.daterange(v_a.valid_from, v_a.valid_to, '[)')
    ) THEN
      INSERT INTO public.direct_entry_capability_grants (
        app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable
      ) VALUES (
        v_a.leader_app_user_id, 'team_manager_assign', v_a.valid_from, v_a.valid_to, false, false
      );
    END IF;
  END LOOP;

  PERFORM pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);

  SELECT count(*)::int
    INTO v_missing_cnt
    FROM public.direct_entry_team_leader_assignments a
   WHERE (a.is_current OR a.suspended_by_account_disable)
     AND (
       (SELECT count(*)::int FROM public.direct_entry_scope_grants s
         WHERE s.app_user_id = a.leader_app_user_id
           AND s.scope_kind = 'team'
           AND s.team_id = a.team_id
           AND s.valid_from <= a.valid_from
           AND s.valid_to IS NOT DISTINCT FROM a.valid_to
           AND (s.valid_to IS NULL OR s.valid_to > s.valid_from)
           AND s.is_current = a.is_current
           AND s.suspended_by_account_disable = a.suspended_by_account_disable) <> 1
       OR (SELECT count(*)::int FROM public.direct_entry_capability_grants g
            WHERE g.app_user_id = a.leader_app_user_id
              AND g.capability = 'team_manager_assign'
              AND g.valid_from = a.valid_from
              AND g.valid_to IS NOT DISTINCT FROM a.valid_to
              AND (g.valid_to IS NULL OR g.valid_to > g.valid_from)
              AND g.is_current = a.is_current
              AND g.suspended_by_account_disable = a.suspended_by_account_disable) <> 1
       OR (SELECT count(*)::int FROM public.work_report_team_leader_capability_grants x
            WHERE x.leader_assignment_id = a.assignment_id) <> 4
     );

  IF v_missing_cnt > 0 THEN
    RAISE EXCEPTION 'WP10_7_3B_ROLLBACK_BACKFILL_INCOMPLETE: % active/suspended TL assignment(s) still missing legacy grants or bridge rows', v_missing_cnt
      USING errcode = '55000';
  END IF;
END
$wp10_7_3b_emergency_backfill$;
`;

let seq = 1;
function nextUuid() {
  return `95110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `wp10_7_3b_${prefix}_${seq++}`;
}
function sha256(val) {
  return createHash("sha256").update(String(val), "utf8").digest("hex");
}

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  return result.error ? null : candidate;
}

function runBin(file, args, { ignoreOutput = false, input = undefined } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(input !== undefined ? { input } : {}),
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  assert.equal(result.status, 0, `${path.basename(file)} failed:\n${result.stderr || result.stdout}`);
  return result;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function connect(port, appName, database = "postgres") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: appName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function beginServiceTx(client) {
  await client.query(
    "begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role",
  );
}

function settleInTx(client, queryPromise) {
  return queryPromise.then(
    async (value) => {
      await client.query("commit");
      return { status: "fulfilled", value };
    },
    async (reason) => {
      await client.query("rollback").catch(() => {});
      return { status: "rejected", reason };
    },
  );
}

async function waitUntilBlocked(observer, appName, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `select a.pid,
              a.application_name,
              a.wait_event_type,
              a.wait_event,
              l.locktype,
              l.mode,
              coalesce(l.relation::regclass::text, l.locktype) as relation_name
         from pg_stat_activity a
         join pg_locks l
           on l.pid = a.pid
          and l.granted = false
        where a.application_name = $1
          and a.state = 'active'
          and a.wait_event_type = 'Lock'
        limit 1`,
      [appName],
    );
    if (rows.length === 1) {
      return rows[0];
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const { rows: snap } = await observer.query(
    `select pid, application_name, state, wait_event_type, wait_event, left(query, 120) as query_prefix
       from pg_stat_activity
      where application_name = $1`,
    [appName],
  );
  throw new Error(`Timed out waiting for ${appName} to block on Lock. Snapshot: ${JSON.stringify(snap)}`);
}

function assertNotDeadlock(res, label) {
  if (res?.status === "rejected") {
    assert.notEqual(res.reason?.code, "40P01", `${label} raised 40P01 deadlock: ${res.reason?.message}`);
  }
}

async function setBusinessDate(client, isoDate) {
  await client.query(`
    create or replace function public.direct_entry_authorization_date()
    returns date
    language sql
    stable
    security definer
    set search_path = pg_catalog, public
    as $function$
      select '${isoDate}'::date
    $function$;
    revoke all on function public.direct_entry_authorization_date() from public, anon, authenticated, service_role;
  `);
}

describe("WP10-7 Slice 3B (PG18): Team Leader authz_managed cutover, lifecycle, concurrency & recovery drill", () => {
  const clients = [];
  let tmpDir = "";
  let pgData = "";
  let pgLog = "";
  let pgCtl = null;
  let port = 0;
  let started = false;

  let setup = null;
  let observer = null;
  let w1 = null;
  let w2 = null;

  let inOuterTx = false;
  let spSeq = 1;

  let files = [];
  let wp1073bSql = "";
  let wp1073bIdx = -1;
  let staged3bMigrationsDir = "";

  let todayStr = "";
  let yesterdayVn = "";
  let tomorrowStr = "";
  let leaveDay1 = "";
  let yearMonth = "";
  let leaveYear = 2026;

  let TEAM_A = "";
  let TEAM_B = "";
  let TEAM_PRE_GRP = "";
  let deptByKey = {};
  let grpByCode = {};
  let grpTlPreserveId = "";
  let wrTpl = null;

  let CAND_1 = null;
  let CAND_2 = null;
  let TEAM_MEMBER = null;
  let PRE_TL_REPLACE = null;
  let PRE_TL_GRP_PRESERVE = null;
  let WRONG_ORG_CAND = null;
  let WRONG_TEAM_CAND = null;
  let LEGACY_TL_1 = null;
  let LEGACY_TL_2 = null;
  let PREV_UNMANAGED_A = null;

  let pre3bSnapshot = null;
  let pre3bRestoreStatements = "";

  async function beginOuterTx() {
    assert.equal(inOuterTx, false, "Already inside outer tx");
    await setup.query("begin");
    inOuterTx = true;
  }

  async function rollbackOuterTx() {
    assert.equal(inOuterTx, true, "Not inside outer tx");
    await setup.query("rollback");
    inOuterTx = false;
  }

  async function serviceRpc(fnName, args = [], casts = [], client = setup) {
    const placeholders = args.map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`)).join(", ");
    const sql = `select public.${fnName}(${placeholders}) as data`;
    if (client === setup && inOuterTx) {
      const sp = `sp_rpc_${spSeq++}`;
      await setup.query(`savepoint ${sp}`);
      try {
        await setup.query("set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role");
        const res = await setup.query(sql, args);
        await setup.query("reset role");
        await setup.query(`release savepoint ${sp}`);
        return res.rows[0]?.data;
      } catch (err) {
        await setup.query(`rollback to savepoint ${sp}`).catch(() => {});
        await setup.query("reset role").catch(() => {});
        throw err;
      }
    }
    await client.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role");
    try {
      const res = await client.query(sql, args);
      await client.query("commit");
      return res.rows[0]?.data;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    }
  }

  async function tryServiceRpc(fnName, args = [], casts = [], client = setup) {
    try {
      const data = await serviceRpc(fnName, args, casts, client);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, code: err?.code ?? "ERR", message: err?.message ?? String(err) };
    }
  }

  async function seedLegacyAdmin(user) {
    await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
    await setup.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
       values ($1::uuid, $2::uuid, $3, true, false, 1)`,
      [user.app, user.auth, user.name],
    );
    await setup.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'all', null, '2026-01-01', true)`,
      [user.app],
    );
    for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await setup.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, '2026-01-01', true)`,
        [user.app, cap],
      );
    }
  }

  async function seedCandidate(
    slug,
    displayName,
    teamId,
    deptId,
    { authzManaged = true, groupId = null, withLeaveProfile = false } = {},
  ) {
    const auth = nextUuid();
    const app = nextUuid();
    const rec = nextUuid();
    const code = `C3B_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10)}_${seq}`;
    await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [auth, `${slug}@hrpartner.local`]);
    await setup.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
       values ($1::uuid, $2::uuid, $3, true, $4, 1)`,
      [app, auth, displayName, authzManaged],
    );
    await setup.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, $3, 'TEAM_LEADER', true)`,
      [rec, displayName, code],
    );
    await setup.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2026-01-01', true)`,
      [rec],
    );
    await setup.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
      [app, rec],
    );
    if (teamId) {
      await setup.query(
        `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
         values ($1::uuid, $2::uuid, '2026-01-01', true)`,
        [rec, teamId],
      );
    }
    let personId = null;
    if (deptId) {
      const empCode = `PER-${code}`;
      const pRes = await serviceRpc("org_department_create_person_admin", [
        OWNER.auth,
        OWNER.app,
        empCode,
        displayName,
        "2026-01-01",
        deptId,
        app,
        1,
        rec,
        `Seed person ${slug}`,
        nextUuid(),
        computeCreatePersonFingerprint(OWNER.app, {
          employee_code: empCode,
          full_name: displayName,
          joined_on: "2026-01-01",
          initial_department_ref: deptId,
          account_ref: app,
          expected_account_version: 1,
          recruiter_id: rec,
          reason: `Seed person ${slug}`,
        }),
      ]);
      personId = pRes.person.person_id;
    }
    if (groupId && authzManaged) {
      const { rows: [u] } = await setup.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [app],
      );
      const idemp = nextUuid();
      await serviceRpc(
        "direct_entry_authz_assign_group_member_admin",
        [OWNER.auth, OWNER.app, app, groupId, u.version, `Assign group ${slug}`, idemp, sha256(`grp:${app}:${groupId}:${idemp}`)],
        ["uuid", "uuid", "uuid", "uuid", "integer", "text", "uuid", "text"],
      );
    }
    if (withLeaveProfile) {
      await serviceRpc(
        "leave_management_upsert_employee_profile_admin",
        [
          OWNER.auth,
          OWNER.app,
          app,
          "OFFICIAL",
          null,
          "2026-01-01",
          "2026-01-01",
          null,
          0,
          0,
          `Leave profile ${slug}`,
          nextKey(`lv_${slug}`),
          sha256(`lv:${app}:${seq}`),
        ],
        ["uuid", "uuid", "uuid", "text", "text", "date", "date", "date", "integer", "integer", "text", "text", "text"],
      );
    }
    return { auth, app, rec, personId, slug, name: displayName };
  }

  async function seedTeam(code, displayName) {
    const teamId = nextUuid();
    await setup.query(
      "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, $2, $3, true, 1)",
      [teamId, code, displayName],
    );
    return teamId;
  }

  async function getTeamVersion(teamId) {
    const { rows: [r] } = await setup.query("select version from public.teams where team_id = $1::uuid", [teamId]);
    return r.version;
  }

  async function getUserVersion(appUserId) {
    const { rows: [r] } = await setup.query(
      "select version, enabled, authz_managed from public.direct_entry_app_users where app_user_id = $1::uuid",
      [appUserId],
    );
    return r;
  }

  async function getRecruiterVersion(recruiterId) {
    const { rows: [r] } = await setup.query(
      "select version from public.recruiters where recruiter_id = $1::uuid",
      [recruiterId],
    );
    return r.version;
  }

  async function snapshotTlTables(appUserId, queryClient = setup) {
    const tla = await queryClient.query(
      `select assignment_id::text, team_id::text, is_current, suspended_by_account_disable as susp, valid_from::text, valid_to::text
         from public.direct_entry_team_leader_assignments
        where leader_app_user_id = $1::uuid
        order by valid_from, assignment_id`,
      [appUserId],
    );
    const caps = await queryClient.query(
      `select grant_id::text, capability, is_current, suspended_by_account_disable as susp, valid_from::text, valid_to::text
         from public.direct_entry_capability_grants
        where app_user_id = $1::uuid
        order by capability, valid_from, grant_id`,
      [appUserId],
    );
    const scopes = await queryClient.query(
      `select grant_id::text, scope_kind, team_id::text, is_current, suspended_by_account_disable as susp, valid_from::text, valid_to::text
         from public.direct_entry_scope_grants
        where app_user_id = $1::uuid
        order by scope_kind, team_id nulls first, valid_from, grant_id`,
      [appUserId],
    );
    const bridge = await queryClient.query(
      `select x.leader_assignment_id::text, x.capability, x.capability_grant_id::text,
              g.is_current as grant_current, g.suspended_by_account_disable as grant_susp, g.valid_to::text as grant_valid_to
         from public.work_report_team_leader_capability_grants x
         join public.direct_entry_team_leader_assignments a on a.assignment_id = x.leader_assignment_id
         join public.direct_entry_capability_grants g on g.grant_id = x.capability_grant_id
        where a.leader_app_user_id = $1::uuid
        order by x.capability, x.leader_assignment_id`,
      [appUserId],
    );
    return {
      tla: tla.rows,
      caps: caps.rows,
      scopes: scopes.rows,
      bridge: bridge.rows,
    };
  }

  async function captureTargetFunctionCatalog(queryClient = observer) {
    const { rows: fnRows } = await queryClient.query(
      `select p.proname,
              pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_args,
              pg_catalog.pg_get_userbyid(p.proowner) as owner,
              p.prosecdef,
              p.proconfig,
              pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
              pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec,
              pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid), 'UTF8')),
                'hex'
              ) as funcdef_sha256,
              pg_catalog.pg_get_functiondef(p.oid) as funcdef
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = any($1::text[])
        order by p.proname asc`,
      [TARGET_3B_FUNCTIONS],
    );
    const { rows: svcRows } = await queryClient.query(`
      select p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as sig
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
       order by sig asc
    `);
    return {
      functions: fnRows,
      serviceRoleSignatures: svcRows.map((r) => r.sig),
    };
  }

  before(async () => {
    const initdb = binary("initdb");
    pgCtl = binary("pg_ctl");
    assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb and pg_ctl binaries are required");

    tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-7-3b-pg18-"));
    pgData = path.join(tmpDir, "pgdata");
    pgLog = path.join(tmpDir, "postgres.log");
    port = await freePort();

    runBin(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"], {
      ignoreOutput: true,
    });
    runBin(
      pgCtl,
      [
        "-D",
        pgData,
        "-l",
        pgLog,
        "-w",
        "-o",
        `-F -h 127.0.0.1 -p ${port} ${process.platform === "win32" ? "" : '-k "" '}-c deadlock_timeout=100ms -c log_min_messages=warning`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    setup = await connect(port, "wp10-7-3b-setup");
    observer = await connect(port, "wp10-7-3b-observer");
    w1 = await connect(port, "wp10-7-3b-w1");
    w2 = await connect(port, "wp10-7-3b-w2");
    clients.push(setup, observer, w1, w2);

    await setup.query(ROLE_PREAMBLE);

    files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const wp1072bIdx = files.indexOf(WP10_7_2B_MIGRATION_NAME);
    wp1073bIdx = files.indexOf(WP10_7_3B_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.ok(wp1072bIdx > groupsIdx, "WP10-7 Slice 2B migration #251 must exist");
    assert.ok(wp1073bIdx > wp1072bIdx, "WP10-7 Slice 3B migration #252 must follow #251");

    wp1073bSql = await readFile(path.join(MIGRATION_DIR, WP10_7_3B_MIGRATION_NAME), "utf8");
    staged3bMigrationsDir = path.join(tmpDir, "staged-3b", "supabase", "migrations");
    await mkdir(staged3bMigrationsDir, { recursive: true });
    for (const fname of files.slice(0, wp1073bIdx + 1)) {
      await copyFile(path.join(MIGRATION_DIR, fname), path.join(staged3bMigrationsDir, fname));
    }

    for (let i = 0; i < groupsIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }
    await seedLegacyAdmin(OWNER);
    await seedLegacyAdmin(LUANPT);
    await seedLegacyAdmin(LIENVU);
    await seedLegacyAdmin(NGATTT);

    const plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(plan.action_diff.unexpected_diff_count, 0);
    const applied = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    for (let i = groupsIdx; i < wp1073bIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }

    await setup.query(`
      create table if not exists public.schema_migrations (
        version     text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      )
    `);
    for (let i = 0; i < wp1073bIdx; i += 1) {
      const fname = files[i];
      const sqlText = await readFile(path.join(MIGRATION_DIR, fname), "utf8");
      await setup.query(
        "insert into public.schema_migrations (version, checksum) values ($1, $2) on conflict (version) do nothing",
        [fname, migrationChecksum(sqlText)],
      );
    }

    const { rows: [dates] } = await observer.query(`
      with d as (
        select (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date as today_vn
      ),
      workdays as (
        select gs::date as wd
          from d, generate_series(d.today_vn - 20, d.today_vn - 1, interval '1 day') as gs
         where extract(dow from gs) <> 0
         order by gs desc
      )
      select today_vn::text,
             (select wd::text from workdays limit 1) as yesterday_vn,
             (today_vn + 1)::text as tomorrow_vn,
             (today_vn + 2)::text as leave_d1,
             to_char(today_vn, 'YYYY-MM') as ym,
             extract(year from today_vn)::int as leave_year
        from d
    `);
    await setBusinessDate(setup, dates.today_vn);
    todayStr = dates.today_vn;
    yesterdayVn = dates.yesterday_vn;
    tomorrowStr = dates.tomorrow_vn;
    leaveDay1 = dates.leave_d1;
    yearMonth = dates.ym;
    leaveYear = dates.leave_year;

    TEAM_A = await seedTeam("team_3b_a", "Đội 3B A");
    TEAM_B = await seedTeam("team_3b_b", "Đội 3B B");
    TEAM_PRE_GRP = await seedTeam("team_3b_pre_grp", "Đội 3B Pre Group");

    const { rows: depts } = await setup.query(
      "select department_id::text, system_key from public.organization_departments where is_active = true",
    );
    deptByKey = Object.fromEntries(depts.map((d) => [d.system_key, d.department_id]));
    const { rows: grps } = await setup.query(
      "select group_id::text, code from public.authz_user_groups where active = true",
    );
    grpByCode = Object.fromEntries(grps.map((g) => [g.code, g.group_id]));

    // Seed published Work Report template with requires_review = true so pending reviews work end-to-end
    const wrSchema = {
      version: "work-report-schema/1.0",
      sections: [{
        section_key: "kpi",
        label: "KPI",
        description: null,
        sort_order: 10,
        fields: [{
          field_key: "calls",
          section_key: "kpi",
          sort_order: 10,
          label: "Cuộc gọi",
          description: null,
          field_type: "integer",
          required: true,
          default_value: 0,
          validation: { min_value: 0, max_value: 1000, allow_zero: true },
          options: null,
          is_metric: true,
          metric_spec: {
            metric_key: "calls",
            unit: "cuộc",
            aggregations: ["SUM"],
            null_policy: "EXCLUDE_FROM_AVG",
            zero_policy: "INCLUDE_AS_ZERO",
            compatible_group: "wp107_3b_calls_v1",
          },
          is_dimension: false,
        }],
      }],
    };
    const wrMetrics = {
      version: "work-report-metrics/1.0",
      metrics: [{
        metric_key: "calls",
        field_key: "calls",
        field_type: "integer",
        unit: "cuộc",
        aggregations: ["SUM"],
        null_policy: "EXCLUDE_FROM_AVG",
        zero_policy: "INCLUDE_AS_ZERO",
        compatible_group: "wp107_3b_calls_v1",
      }],
    };
    wrTpl = await serviceRpc("work_report_create_template", [
      OWNER.auth, OWNER.app, "WP107_3B_TPL", "WP107_3B_TPL", "Mẫu 3B", "DAILY",
      JSON.stringify(wrSchema), JSON.stringify(wrMetrics), `tpl-${nextUuid()}`,
    ]);
    await setup.query(
      "update public.work_report_template_versions set requires_review = true where version_id = $1::uuid",
      [wrTpl.draft_version_id],
    );
    await serviceRpc("work_report_publish_template", [
      OWNER.auth, OWNER.app, wrTpl.template_id, wrTpl.draft_version_id, wrTpl.version, `pub-${nextUuid()}`,
    ]);

    // Seed custom team-scoped permission group that grants team_manager_assign + report_review (for Requirement 1 group-cap preservation)
    const grpTlCapRes = await serviceRpc(
      "direct_entry_authz_create_group_admin",
      [
        OWNER.auth,
        OWNER.app,
        "GRP_3B_TL_PRESERVE",
        "Nhóm 3B Có Quyền TL",
        "Nhóm quyền giữ team_manager_assign và report_review khi thu hồi TL",
        deptByKey.RECRUITMENT,
        TEAM_PRE_GRP,
        ["entry_own", "entry_team", "team_manager_assign", "report_review", "report_view"],
        JSON.stringify([]),
        "Seed GRP_3B_TL_PRESERVE",
        nextUuid(),
        sha256("grp:GRP_3B_TL_PRESERVE"),
      ],
      ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
    );
    grpTlPreserveId = grpTlCapRes.group?.group_id ?? grpTlCapRes.group_id;
    assert.ok(grpTlPreserveId, "GRP_3B_TL_PRESERVE group_id required");

    CAND_1 = await seedCandidate("cand1.managed", "Ứng viên 1 (Managed)", TEAM_A, deptByKey.RECRUITMENT, {
      authzManaged: true,
      groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    CAND_2 = await seedCandidate("cand2.managed", "Ứng viên 2 (Managed)", TEAM_A, deptByKey.RECRUITMENT, {
      authzManaged: true,
      groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    TEAM_MEMBER = await seedCandidate("member.teama", "Nhân viên Đội A", TEAM_A, deptByKey.RECRUITMENT, {
      authzManaged: true,
      groupId: grpByCode.RECRUITER_OPERATIONS,
      withLeaveProfile: true,
    });

    PRE_TL_REPLACE = await seedCandidate("pretl.replace", "TL Tiền-3B Thay Thế", TEAM_A, deptByKey.RECRUITMENT, {
      authzManaged: true,
      groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    // Seed without GRP_3B_TL_PRESERVE first so pre-3B designate succeeds, then assign GRP_3B_TL_PRESERVE in Test 1!
    PRE_TL_GRP_PRESERVE = await seedCandidate("pretl.grppres", "TL Tiền-3B Nhóm Quyền", TEAM_PRE_GRP, deptByKey.RECRUITMENT, {
      authzManaged: true,
      groupId: grpByCode.RECRUITER_OPERATIONS,
    });

    WRONG_ORG_CAND = await seedCandidate("wrongorg", "Ứng viên Sai Org", TEAM_A, deptByKey.RECRUITMENT, {
      authzManaged: true,
      groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    await setup.query(
      "update public.organization_persons set status = 'INACTIVE', deactivated_at = now() where person_id = $1::uuid",
      [WRONG_ORG_CAND.personId],
    );
    WRONG_TEAM_CAND = await seedCandidate("wrongteam", "Ứng viên Sai Tổ", TEAM_B, deptByKey.RECRUITMENT, {
      authzManaged: true,
      groupId: grpByCode.RECRUITER_OPERATIONS,
    });

    LEGACY_TL_1 = await seedCandidate("legacy1", "Ứng viên Legacy 1", TEAM_B, deptByKey.RECRUITMENT, {
      authzManaged: false,
      groupId: null,
    });
    LEGACY_TL_2 = await seedCandidate("legacy2", "Ứng viên Legacy 2", TEAM_B, deptByKey.RECRUITMENT, {
      authzManaged: false,
      groupId: null,
    });
    PREV_UNMANAGED_A = await seedCandidate("prev.unmanaged", "Ứng viên Unmanaged Đội A", TEAM_A, deptByKey.RECRUITMENT, {
      authzManaged: false,
      groupId: null,
    });
  });

  after(async () => {
    for (const c of clients) {
      await c?.query("rollback").catch(() => {});
      await c?.end().catch(() => {});
    }
    if (started && pgCtl) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("1. Migration #252 hygiene, atomic rollback zero drift, and pre-3B -> post-3B upgrade cleanup & group capability preservation", async () => {
    // 1a. Hygiene checks
    assert.equal(wp1073bSql.includes("\r\n"), false, "Migration #252 must use LF line endings");
    assert.equal(wp1073bSql.includes("@"), false, "Migration #252 must contain zero '@' characters");
    assert.equal(/\bsavepoint\b/i.test(wp1073bSql), false, "Migration #252 must contain zero SAVEPOINT");
    assert.equal(/'40001'/.test(wp1073bSql), false, "Migration #252 must contain zero '40001'");
    assert.equal(/alter\s+default\s+privileges/i.test(wp1073bSql), false, "Migration #252 must contain zero ALTER DEFAULT PRIVILEGES");

    // 1b. Seed TWO pre-3B authz_managed=true Team Leaders at <= #251
    const tvA0 = await getTeamVersion(TEAM_A);
    await serviceRpc(
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, TEAM_A, PRE_TL_REPLACE.app, todayStr, tvA0, "Pre-3B TL on TEAM_A", nextKey("pre_rep")],
      ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    const snapPreRep = await snapshotTlTables(PRE_TL_REPLACE.app);
    assert.equal(snapPreRep.tla.filter((r) => r.is_current).length, 1);
    assert.equal(snapPreRep.scopes.filter((s) => s.scope_kind === "team" && s.is_current).length, 1);
    assert.equal(snapPreRep.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current).length, 1);
    assert.equal(snapPreRep.bridge.filter((b) => b.grant_current).length, 4);

    const tvGrp0 = await getTeamVersion(TEAM_PRE_GRP);
    await serviceRpc(
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, TEAM_PRE_GRP, PRE_TL_GRP_PRESERVE.app, todayStr, tvGrp0, "Pre-3B TL with group caps", nextKey("pre_grp")],
      ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    const uvPreGrp = (await getUserVersion(PRE_TL_GRP_PRESERVE.app)).version;
    const idempGrp = nextUuid();
    await serviceRpc(
      "direct_entry_authz_assign_group_member_admin",
      [OWNER.auth, OWNER.app, PRE_TL_GRP_PRESERVE.app, grpTlPreserveId, uvPreGrp, "Assign GRP_3B_TL_PRESERVE to active pre-3B TL", idempGrp, sha256(`grp:${PRE_TL_GRP_PRESERVE.app}:${grpTlPreserveId}:${idempGrp}`)],
      ["uuid", "uuid", "uuid", "uuid", "integer", "text", "uuid", "text"],
    );
    const snapPreGrp = await snapshotTlTables(PRE_TL_GRP_PRESERVE.app);
    assert.equal(snapPreGrp.tla.filter((r) => r.is_current).length, 1);
    assert.equal(snapPreGrp.scopes.filter((s) => s.scope_kind === "team" && s.is_current).length, 1);
    assert.equal(snapPreGrp.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current).length, 1);
    assert.equal(snapPreGrp.bridge.length, 4, "Pre-3B TL with group caps still has 4 bridge rows");

    // Capture exact pre-3B function definitions + owner + ACLs (used for rollback check AND Section 5 drill)
    pre3bSnapshot = await captureTargetFunctionCatalog(observer);
    assert.equal(pre3bSnapshot.functions.length, 3);
    pre3bRestoreStatements = pre3bSnapshot.functions
      .map((fn) => {
        const aclGrant = fn.svc_exec
          ? `\nGRANT EXECUTE ON FUNCTION public.${fn.proname}(${fn.identity_args}) TO service_role;`
          : "";
        return (
          `${fn.funcdef};\n` +
          `ALTER FUNCTION public.${fn.proname}(${fn.identity_args}) OWNER TO ${fn.owner};\n` +
          `REVOKE ALL ON FUNCTION public.${fn.proname}(${fn.identity_args}) FROM public, anon, authenticated, service_role;${aclGrant}`
        );
      })
      .join("\n\n");

    // 1c. Atomic rollback zero drift
    const stripped252 = wp1073bSql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
    await setup.query("begin");
    await setup.query(stripped252);
    await setup.query("rollback");

    const afterRbSnapshot = await captureTargetFunctionCatalog(observer);
    assert.deepEqual(
      afterRbSnapshot.functions.map((f) => ({
        proname: f.proname,
        sha: f.funcdef_sha256,
        svc: f.svc_exec,
        pub: f.public_exec,
        anon: f.anon_exec,
        auth: f.auth_exec,
      })),
      pre3bSnapshot.functions.map((f) => ({
        proname: f.proname,
        sha: f.funcdef_sha256,
        svc: f.svc_exec,
        pub: f.public_exec,
        anon: f.anon_exec,
        auth: f.auth_exec,
      })),
      "Atomic rollback must leave 0 drift in target functions/ACLs",
    );
    assert.deepEqual(afterRbSnapshot.serviceRoleSignatures, pre3bSnapshot.serviceRoleSignatures);
    const { rows: migRowsBefore } = await observer.query(
      "select 1 from public.schema_migrations where version = $1",
      [WP10_7_3B_MIGRATION_NAME],
    );
    assert.equal(migRowsBefore.length, 0);

    // 1d. Upgrade #251 -> #252 via runMigrationApply
    const applyRes = await runMigrationApply({
      directory: staged3bMigrationsDir,
      loadConfig: async () => ({
        databaseUrl: `postgresql://postgres@127.0.0.1:${port}/postgres`,
        projectRef: "local",
      }),
      createClient: (databaseUrl) =>
        new Client({
          connectionString: databaseUrl,
          application_name: "wp10-7-3b-apply",
          connectionTimeoutMillis: 5000,
        }),
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(applyRes.appliedCount, 1);

    const post3bSnapshot = await captureTargetFunctionCatalog(observer);
    assert.deepEqual(
      post3bSnapshot.serviceRoleSignatures,
      pre3bSnapshot.serviceRoleSignatures,
      "Migration #252 must add +0 net service_role RPCs",
    );
    for (const fn of post3bSnapshot.functions) {
      assert.equal(fn.prosecdef, true);
      assert.ok(fn.proconfig.includes("search_path=pg_catalog, public"));
      assert.equal(fn.public_exec, false);
      assert.equal(fn.anon_exec, false);
      assert.equal(fn.auth_exec, false);
      assert.equal(
        fn.svc_exec,
        fn.proname === "direct_entry_list_team_leader_candidates",
        `Unexpected service_role privilege on ${fn.proname}`,
      );
    }

    // 1e. Post-3B replace of pre-3B TL (in rolled-back tx): closes old scope/cap/wr_bridge cleanly (0 23514/55000)
    await beginOuterTx();
    {
      const tvA1 = await getTeamVersion(TEAM_A);
      const repRes = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, todayStr, tvA1, "Post-3B replace pre-3B TL", nextKey("post_rep_pre")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(repRes.change, "replace");
      const snapOldAfterRep = await snapshotTlTables(PRE_TL_REPLACE.app);
      assert.equal(snapOldAfterRep.tla.filter((r) => r.is_current).length, 0);
      assert.equal(snapOldAfterRep.scopes.filter((s) => s.scope_kind === "team" && s.is_current).length, 0);
      assert.equal(snapOldAfterRep.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current).length, 0);
      assert.equal(snapOldAfterRep.bridge.filter((b) => b.grant_current || b.grant_valid_to === null).length, 0);

      const snapCand1 = await snapshotTlTables(CAND_1.app);
      assert.equal(snapCand1.tla.filter((r) => r.is_current).length, 1);
      assert.equal(snapCand1.scopes.filter((s) => s.scope_kind === "team").length, 0);
      assert.equal(snapCand1.caps.filter((c) => c.capability === "team_manager_assign").length, 0);
      assert.equal(snapCand1.bridge.length, 0);
    }
    await rollbackOuterTx();

    // 1f. Post-3B real revoke of both pre-3B TLs (leaves TEAM_A & TEAM_PRE_GRP clean for later tests)
    const tvA1Real = await getTeamVersion(TEAM_A);
    const revPreRep = await serviceRpc(
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, TEAM_A, todayStr, tvA1Real, "Post-3B revoke pre-3B TL", nextKey("post_rev_pre")],
      ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    assert.equal(revPreRep.change, "revoke");
    const snapPreRepAfter = await snapshotTlTables(PRE_TL_REPLACE.app);
    assert.equal(snapPreRepAfter.tla.filter((r) => r.is_current).length, 0);
    assert.equal(snapPreRepAfter.scopes.filter((s) => s.scope_kind === "team" && s.is_current).length, 0);
    assert.equal(snapPreRepAfter.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current).length, 0);
    assert.equal(snapPreRepAfter.bridge.filter((b) => b.grant_current || b.grant_valid_to === null).length, 0);

    // Revoke PRE_TL_GRP_PRESERVE: closes TLA & scope('team') & non-group report_* caps, PRESERVES group-granted team_manager_assign & report_review!
    const tvGrp1 = await getTeamVersion(TEAM_PRE_GRP);
    const revPreGrp = await serviceRpc(
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, TEAM_PRE_GRP, todayStr, tvGrp1, "Post-3B revoke pre-3B TL preserving group caps", nextKey("post_rev_grp")],
      ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    assert.equal(revPreGrp.change, "revoke");
    const snapPreGrpAfter = await snapshotTlTables(PRE_TL_GRP_PRESERVE.app);
    assert.equal(snapPreGrpAfter.tla.filter((r) => r.is_current).length, 0);
    assert.equal(snapPreGrpAfter.scopes.filter((s) => s.scope_kind === "team" && s.is_current).length, 0);
    assert.equal(
      snapPreGrpAfter.caps.some((c) => c.capability === "team_manager_assign" && c.is_current && c.valid_to === null),
      true,
      "Group-granted team_manager_assign must be preserved after pre-3B TL revoke",
    );
    assert.equal(
      snapPreGrpAfter.caps.some((c) => c.capability === "report_review" && c.is_current && c.valid_to === null),
      true,
      "Group-granted report_review must be preserved after pre-3B TL revoke",
    );
    assert.equal(
      snapPreGrpAfter.caps.some((c) => c.capability === "report_assign" && !c.is_current && c.valid_to === todayStr),
      true,
      "Non-group report_assign from wr_bridge must be closed after pre-3B TL revoke",
    );
    const ctxPreGrp = await serviceRpc("direct_entry_resolve_actor_context", [PRE_TL_GRP_PRESERVE.auth], ["uuid"]);
    assert.equal(ctxPreGrp.capabilities.includes("team_manager_assign"), true);
    assert.equal(ctxPreGrp.capabilities.includes("report_review"), true);
    assert.equal(
      ctxPreGrp.effective_grants.some((g) => g.source_type === "TEAM_LEADER"),
      false,
      "TEAM_LEADER effective grants must be cleared after revoke",
    );
    assert.deepEqual(
      ctxPreGrp.team_scope_grants.map((s) => s.team_id),
      [TEAM_PRE_GRP],
      "Team-scoped Permission Group GRP_3B_TL_PRESERVE keeps TEAM_PRE_GRP scope independently of revoked TL",
    );
  });

  it("2. Skewed legacy grants matrix (6/6 on authz_managed=true) + Org/Team/Actor/OCC/Idempotency + mixed v_restore", async () => {
    const skewCases = [
      {
        id: "2.1: stale scope('team', TEAM_B) is_current=true",
        inject: async () => {
          await setup.query("set local direct_entry.team_leader_marker = 'on'");
          await setup.query(
            `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
             values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)`,
            [CAND_1.app, TEAM_B],
          );
        },
      },
      {
        id: "2.2: stale scope('team', TEAM_A) is_current=true",
        inject: async () => {
          await setup.query("set local direct_entry.team_leader_marker = 'on'");
          await setup.query(
            `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
             values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)`,
            [CAND_1.app, TEAM_A],
          );
        },
      },
      {
        id: "2.3: stale cap('team_manager_assign') is_current=true",
        inject: async () => {
          await setup.query("set local direct_entry.team_leader_marker = 'on'");
          await setup.query(
            `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
             values ($1::uuid, 'team_manager_assign', '2026-01-01', true)`,
            [CAND_1.app],
          );
        },
      },
      {
        id: "2.4: stale cap('entry_team') is_current=true",
        inject: async () => {
          await setup.query("set local direct_entry.team_leader_marker = 'on'");
          await setup.query(
            `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
             values ($1::uuid, 'entry_team', '2026-01-01', true)`,
            [CAND_1.app],
          );
        },
      },
      {
        id: "2.5: future scope('team', TEAM_A) valid_from=tomorrow",
        inject: async () => {
          await setup.query("set local direct_entry.team_leader_marker = 'on'");
          await setup.query(
            `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
             values ($1::uuid, 'team', $2::uuid, $3::date, false)`,
            [CAND_1.app, TEAM_A, tomorrowStr],
          );
        },
      },
      {
        id: "2.6: future cap('team_manager_assign') valid_from=tomorrow",
        inject: async () => {
          await setup.query("set local direct_entry.team_leader_marker = 'on'");
          await setup.query(
            `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
             values ($1::uuid, 'team_manager_assign', $2::date, false)`,
            [CAND_1.app, tomorrowStr],
          );
        },
      },
    ];

    for (const sc of skewCases) {
      await beginOuterTx();
      try {
        await sc.inject();
        const beforeSnap1 = await snapshotTlTables(CAND_1.app);
        const beforeSnap2 = await snapshotTlTables(CAND_2.app);

        const listRes = await serviceRpc(
          "direct_entry_list_team_leader_candidates",
          [OWNER.auth, OWNER.app, TEAM_A, null, 1, 25],
          ["uuid", "uuid", "uuid", "text", "integer", "integer"],
        );
        assert.equal(
          listRes.candidates.some((c) => c.app_user_id === CAND_1.app),
          true,
          `${sc.id}: CAND_1 must be visible`,
        );

        const tv0 = await getTeamVersion(TEAM_A);
        const desRes = await serviceRpc(
          "direct_entry_designate_team_leader",
          [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, todayStr, tv0, `${sc.id} designate`, nextKey("sk_des")],
          ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
        );
        assert.equal(desRes.change, "designate");

        const midSnap1 = await snapshotTlTables(CAND_1.app);
        assert.equal(midSnap1.tla.filter((r) => r.is_current).length, 1);
        assert.equal(midSnap1.caps.length, beforeSnap1.caps.length, `${sc.id}: 0 new cap_grants`);
        assert.equal(midSnap1.scopes.length, beforeSnap1.scopes.length, `${sc.id}: 0 new scope_grants`);
        assert.equal(midSnap1.bridge.length, beforeSnap1.bridge.length, `${sc.id}: 0 new wr_bridge`);

        const tv1 = await getTeamVersion(TEAM_A);
        const repRes = await serviceRpc(
          "direct_entry_designate_team_leader",
          [OWNER.auth, OWNER.app, TEAM_A, CAND_2.app, todayStr, tv1, `${sc.id} replace`, nextKey("sk_rep")],
          ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
        );
        assert.equal(repRes.change, "replace");

        // Same-day revoke -> closes CAND_2 cleanly (CAND_1 had valid_from = valid_to = todayStr, so 0 active leaders remain)
        const tv2 = await getTeamVersion(TEAM_A);
        const revRes = await serviceRpc(
          "direct_entry_revoke_team_leader",
          [OWNER.auth, OWNER.app, TEAM_A, todayStr, tv2, `${sc.id} same-day revoke`, nextKey("sk_rev")],
          ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
        );
        assert.equal(revRes.change, "revoke");

        const endSnap1 = await snapshotTlTables(CAND_1.app);
        const endSnap2 = await snapshotTlTables(CAND_2.app);
        assert.equal(endSnap1.tla.filter((r) => r.is_current).length, 0);
        assert.equal(endSnap1.caps.length, beforeSnap1.caps.length);
        assert.equal(endSnap1.scopes.length, beforeSnap1.scopes.length);
        assert.equal(endSnap1.bridge.length, beforeSnap1.bridge.length);
        assert.equal(endSnap2.tla.filter((r) => r.is_current).length, 0);
        assert.equal(endSnap2.caps.length, beforeSnap2.caps.length);
        assert.equal(endSnap2.scopes.length, beforeSnap2.scopes.length);
        assert.equal(endSnap2.bridge.length, beforeSnap2.bridge.length);
      } finally {
        await rollbackOuterTx();
      }
    }

    // Pure-managed same-day v_restore: CAND_1 designated on yesterdayVn -> replaced today by CAND_2 -> revoked today -> restores CAND_1
    await beginOuterTx();
    try {
      await setBusinessDate(setup, yesterdayVn);
      const tv0 = await getTeamVersion(TEAM_A);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, yesterdayVn, tv0, "Pure v_restore designate CAND_1", nextKey("pv_des")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      await setBusinessDate(setup, todayStr);
      const tv1 = await getTeamVersion(TEAM_A);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_2.app, todayStr, tv1, "Pure v_restore replace CAND_2", nextKey("pv_rep")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const tv2 = await getTeamVersion(TEAM_A);
      const revPure = await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, todayStr, tv2, "Pure v_restore revoke CAND_2", nextKey("pv_rev")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(revPure.change, "revoke");
      const snapPure1 = await snapshotTlTables(CAND_1.app);
      const snapPure2 = await snapshotTlTables(CAND_2.app);
      assert.equal(snapPure1.tla.filter((r) => r.is_current && r.valid_to === null).length, 1, "Pure v_restore must restore CAND_1");
      assert.equal(snapPure1.scopes.filter((s) => s.scope_kind === "team").length, 0);
      assert.equal(snapPure1.bridge.length, 0);
      assert.equal(snapPure2.tla.filter((r) => r.is_current).length, 0);
    } finally {
      await rollbackOuterTx();
    }

    // Mixed v_restore: v_previous (authz_managed = false, valid_from = yesterdayVn) + v_old (authz_managed = true, valid_from = todayStr)
    await beginOuterTx();
    try {
      await setBusinessDate(setup, yesterdayVn);
      const tv0 = await getTeamVersion(TEAM_A);
      const desPrev = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, PREV_UNMANAGED_A.app, yesterdayVn, tv0, "Mixed v_restore designate unmanaged", nextKey("mix_des")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(desPrev.change, "designate");
      const snapPrev0 = await snapshotTlTables(PREV_UNMANAGED_A.app);
      assert.equal(snapPrev0.scopes.filter((s) => s.scope_kind === "team" && s.is_current).length, 1);
      assert.equal(snapPrev0.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current).length, 1);
      assert.equal(snapPrev0.bridge.filter((b) => b.grant_current).length, 4);

      await setBusinessDate(setup, todayStr);
      const tv1 = await getTeamVersion(TEAM_A);
      const repManaged = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, todayStr, tv1, "Mixed v_restore replace with managed", nextKey("mix_rep")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(repManaged.change, "replace");

      const tv2 = await getTeamVersion(TEAM_A);
      const revManaged = await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, todayStr, tv2, "Mixed v_restore revoke managed", nextKey("mix_rev")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(revManaged.change, "revoke");

      const snapPrevRestored = await snapshotTlTables(PREV_UNMANAGED_A.app);
      const snapCand1Closed = await snapshotTlTables(CAND_1.app);
      assert.equal(snapCand1Closed.tla.filter((r) => r.is_current).length, 0);
      assert.equal(snapPrevRestored.tla.filter((r) => r.is_current && r.valid_to === null).length, 1);
      assert.equal(snapPrevRestored.scopes.filter((s) => s.scope_kind === "team" && s.is_current && s.valid_to === null).length, 1);
      assert.equal(snapPrevRestored.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current && c.valid_to === null).length, 1);
      assert.equal(snapPrevRestored.bridge.filter((b) => b.grant_current && b.grant_valid_to === null).length, 4);
    } finally {
      await rollbackOuterTx();
    }

    // Rejections (Wrong Org 23514, Wrong Team 42501, Actor 42501, OCC PT409) & Idempotency Replay
    await beginOuterTx();
    try {
      const tv0 = await getTeamVersion(TEAM_A);

      const errOrg = await tryServiceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, WRONG_ORG_CAND.app, todayStr, tv0, "Wrong org", nextKey("err_org")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(errOrg.ok, false);
      assert.equal(errOrg.code, "23514", `Wrong org must fail 23514, got ${errOrg.code}: ${errOrg.message}`);

      const errTeam = await tryServiceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, WRONG_TEAM_CAND.app, todayStr, tv0, "Wrong team", nextKey("err_team")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(errTeam.ok, false);
      assert.equal(errTeam.code, "42501", `Wrong team membership must fail 42501, got ${errTeam.code}: ${errTeam.message}`);

      const errListActor = await tryServiceRpc(
        "direct_entry_list_team_leader_candidates",
        [CAND_2.auth, CAND_2.app, TEAM_A, null, 1, 25],
        ["uuid", "uuid", "uuid", "text", "integer", "integer"],
      );
      assert.equal(errListActor.ok, false);
      assert.equal(errListActor.code, "42501");

      const errDesActor = await tryServiceRpc(
        "direct_entry_designate_team_leader",
        [CAND_2.auth, CAND_2.app, TEAM_A, CAND_1.app, todayStr, tv0, "Unprivileged actor", nextKey("err_act")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(errDesActor.ok, false);
      assert.equal(errDesActor.code, "42501");

      const errOcc = await tryServiceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, todayStr, tv0 + 99, "Stale version OCC", nextKey("err_occ")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(errOcc.ok, false);
      assert.equal(errOcc.code, "PT409", `Stale version must fail PT409, got ${errOcc.code}: ${errOcc.message}`);

      // Idempotency replay returns exact original payload even after version bumped
      const idempKey = nextKey("idemp_des");
      const firstRes = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, todayStr, tv0, "Idempotent designate", idempKey],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const { rows: [revCountBefore] } = await setup.query(
        "select count(*)::int as cnt from public.direct_entry_team_leader_revisions where team_id = $1::uuid",
        [TEAM_A],
      );
      const replayRes = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, todayStr, tv0, "Idempotent designate", idempKey],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const { rows: [revCountAfter] } = await setup.query(
        "select count(*)::int as cnt from public.direct_entry_team_leader_revisions where team_id = $1::uuid",
        [TEAM_A],
      );
      assert.deepEqual(replayRes, firstRes, "Idempotency replay must return exact original payload");
      assert.equal(revCountAfter.cnt, revCountBefore.cnt, "Idempotency replay must create 0 new revisions");
    } finally {
      await rollbackOuterTx();
    }
  });

  it("3. Disable/Enable, sync_legacy_grants, Runtime vs Legacy Mirror parity across domains & #42 guards", async () => {
    const TL_CAPS = [
      "entry_team",
      "team_manager_assign",
      "report_view",
      "report_analytics_view",
      "report_assign",
      "report_review",
    ];

    // 3a. Disable -> Enable (no replacement): Runtime vs Legacy Mirror & full cross-domain checks
    await beginOuterTx();
    try {
      const tv0 = await getTeamVersion(TEAM_A);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, todayStr, tv0, "3a designate CAND_1", nextKey("3a_des")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );

      // Disable CAND_1
      const uv0 = (await getUserVersion(CAND_1.app)).version;
      await serviceRpc(
        "direct_entry_disable_app_user",
        [OWNER.auth, OWNER.app, CAND_1.app, uv0, "3a disable CAND_1", nextKey("3a_dis")],
        ["uuid", "uuid", "uuid", "integer", "text", "text"],
      );
      const ctxLocked = await serviceRpc("direct_entry_resolve_actor_context", [CAND_1.auth], ["uuid"]);
      assert.equal(ctxLocked.enabled, false);
      assert.deepEqual(ctxLocked.capabilities, []);
      const wrRevLocked = await tryServiceRpc(
        "work_report_list_pending_reviews",
        [CAND_1.auth, CAND_1.app, null, null, 20],
        ["uuid", "uuid", "uuid", "text", "integer"],
      );
      assert.equal(wrRevLocked.ok, false);
      assert.equal(wrRevLocked.code, "42501");

      // Re-enable CAND_1
      const uv1 = (await getUserVersion(CAND_1.app)).version;
      await serviceRpc(
        "direct_entry_enable_app_user",
        [OWNER.auth, OWNER.app, CAND_1.app, uv1, "3a enable CAND_1", nextKey("3a_ena")],
        ["uuid", "uuid", "uuid", "integer", "text", "text"],
      );

      // (i) Runtime actual capabilities & all domain RPCs
      const ctxReen = await serviceRpc("direct_entry_resolve_actor_context", [CAND_1.auth], ["uuid"]);
      assert.equal(ctxReen.enabled, true);
      for (const cap of TL_CAPS) {
        assert.equal(ctxReen.capabilities.includes(cap), true, `Runtime must include ${cap}`);
      }
      assert.equal(
        ctxReen.team_scope_grants.some((g) => g.team_id === TEAM_A),
        true,
        "Runtime team_scope_grants must include TEAM_A",
      );
      assert.equal(
        ctxReen.effective_report_review_scopes.some((s) => s.kind === "team" && s.team_id === TEAM_A),
        true,
        "Runtime effective_report_review_scopes must include TEAM_A",
      );

      const wrOpts = await serviceRpc("work_report_list_assignment_options", [CAND_1.auth, CAND_1.app, null], ["uuid", "uuid", "uuid"]);
      assert.ok(wrOpts.templates.some((t) => t.template_id === wrTpl.template_id));

      // Create assignment as CAND_1, TEAM_MEMBER submits, CAND_1 reviews & approves!
      await serviceRpc(
        "work_report_create_assignment",
        [CAND_1.auth, CAND_1.app, wrTpl.template_id, "TEAM", null, TEAM_A, null, "DAILY", true, 0, "23:59:59", false, todayStr, null, nextKey("3a_asgn")],
        ["uuid", "uuid", "uuid", "text", "uuid", "uuid", "uuid[]", "text", "boolean", "integer", "time", "boolean", "date", "date", "text"],
      );
      const { rows: [obRow] } = await setup.query(
        "select obligation_id from public.work_report_obligations where template_id = $1::uuid and assignee_app_user_id = $2::uuid",
        [wrTpl.template_id, TEAM_MEMBER.app],
      );
      assert.ok(obRow, "TEAM_MEMBER obligation must be created");
      const wrSub = await serviceRpc(
        "work_report_submit",
        [TEAM_MEMBER.auth, TEAM_MEMBER.app, obRow.obligation_id, JSON.stringify({ calls: 12 }), null, nextKey("3a_sub")],
        ["uuid", "uuid", "uuid", "jsonb", "integer", "text"],
      );
      const wrPending = await serviceRpc("work_report_list_pending_reviews", [CAND_1.auth, CAND_1.app, null, null, 20], ["uuid", "uuid", "uuid", "text", "integer"]);
      assert.equal(wrPending.items.some((i) => i.obligation_id === obRow.obligation_id), true);
      const wrDetail = await serviceRpc("work_report_get_review_submission", [CAND_1.auth, CAND_1.app, obRow.obligation_id], ["uuid", "uuid", "uuid"]);
      assert.equal(wrDetail.obligation.obligation_id, obRow.obligation_id);
      const wrDecided = await serviceRpc(
        "work_report_decide_review",
        [CAND_1.auth, CAND_1.app, obRow.obligation_id, "APPROVED", null, wrSub.version, nextKey("3a_dec")],
        ["uuid", "uuid", "uuid", "text", "text", "integer", "text"],
      );
      assert.equal(wrDecided.state, "APPROVED");

      const wrAnal = await serviceRpc(
        "work_report_analytics_overview",
        [CAND_1.auth, CAND_1.app, wrTpl.template_id, null, todayStr, todayStr, TEAM_A, null, "final"],
        ["uuid", "uuid", "uuid", "uuid", "date", "date", "uuid", "uuid", "text"],
      );
      assert.ok(wrAnal);
      const wrMyOb = await serviceRpc("work_report_list_my_obligations", [CAND_1.auth, CAND_1.app, null], ["uuid", "uuid", "text"]);
      assert.ok(wrMyOb);
      const wrHasOb = await serviceRpc("work_report_has_active_obligations", [CAND_1.auth, CAND_1.app], ["uuid", "uuid"]);
      assert.equal(typeof wrHasOb.has_active_obligations, "boolean");

      const attMatrix = await serviceRpc(
        "attendance_monthly_matrix_report",
        [CAND_1.auth, CAND_1.app, yearMonth, null, null, null, 1, 20],
        ["uuid", "uuid", "text", "uuid", "uuid", "text", "integer", "integer"],
      );
      assert.ok(attMatrix);
      const attAdmin = await serviceRpc(
        "attendance_admin_report",
        [CAND_1.auth, CAND_1.app, todayStr, todayStr, 1, 20, null, null],
        ["uuid", "uuid", "date", "date", "integer", "integer", "text", "uuid"],
      );
      assert.ok(attAdmin);

      // Leave routing + create + approve
      const lvSum = await serviceRpc("leave_management_get_my_summary", [TEAM_MEMBER.auth, TEAM_MEMBER.app, leaveYear], ["uuid", "uuid", "integer"]);
      const route = lvSum?.routing ?? lvSum?.approval_route;
      assert.equal(route?.route_kind, "TEAM_LEADER");
      assert.equal(route?.primary_approver_app_user_id, CAND_1.app);

      const lvReq = await serviceRpc("leave_management_create_request", [
        TEAM_MEMBER.auth,
        TEAM_MEMBER.app,
        JSON.stringify([{ leave_date: leaveDay1, session_code: "AM", leave_type: "UNPAID" }]),
        "3a leave test",
        nextKey("3a_lv"),
        sha256(`3a_lv:${seq}`),
      ]);
      assert.equal(lvReq.request.route_kind, "TEAM_LEADER");
      assert.equal(lvReq.request.primary_approver_app_user_id, CAND_1.app);
      const lvInbox = await serviceRpc("leave_management_list_approval_inbox", [CAND_1.auth, CAND_1.app, "PENDING", 50, 0]);
      assert.equal(lvInbox.items.some((i) => i.request_id === lvReq.request.request_id), true);
      const lvApproved = await serviceRpc("leave_management_decide_request", [
        CAND_1.auth,
        CAND_1.app,
        lvReq.request.request_id,
        "APPROVE",
        1,
        "3a CAND_1 approves leave",
        nextKey("3a_lv_app"),
        sha256(`3a_lv_app:${seq}`),
      ]);
      assert.equal(lvApproved.request.status, "APPROVED");

      // Attendance Explanation submit + approve
      const expRaw = await serviceRpc("attendance_submit_explanation", [
        TEAM_MEMBER.auth,
        TEAM_MEMBER.app,
        yesterdayVn,
        "SLOT_1",
        "3a explanation test",
        nextUuid(),
        sha256(`3a_exp:${seq}`),
      ]);
      const exp = projectSubmitAttendanceExplanationResult(expRaw);
      assert.equal(exp.explanation.route_kind, "TEAM_LEADER");
      assert.equal(exp.explanation.primary_approver?.app_user_id, CAND_1.app);
      const expInbox = projectAttendanceExplanationApprovalInbox(
        await serviceRpc("attendance_list_explanation_approval_inbox", [CAND_1.auth, CAND_1.app, "PENDING", 50, 0]),
      );
      assert.equal(expInbox.items.some((i) => i.explanation_id === exp.explanation.explanation_id), true);
      const expApproved = await serviceRpc("attendance_decide_explanation", [
        CAND_1.auth,
        CAND_1.app,
        exp.explanation.explanation_id,
        "APPROVE",
        1,
        "3a CAND_1 approves explanation",
        nextUuid(),
        sha256(`3a_exp_app:${seq}`),
      ]);
      assert.equal(expApproved.explanation.status, "APPROVED");

      // (ii) Legacy mirror tables comparison
      const snapReen = await snapshotTlTables(CAND_1.app);
      assert.equal(snapReen.bridge.length, 0, "Legacy wr_bridge remains 0 post-3B");
      assert.equal(snapReen.scopes.filter((s) => s.scope_kind === "team").length, 0, "Legacy scope('team') remains 0");
      assert.equal(
        snapReen.caps.some((c) => c.capability === "report_review" && c.is_current),
        false,
        "Legacy mirror lacks report_review (because TEAM_LEADER role omits it & wr_bridge=0) while runtime has report_review=true",
      );
    } finally {
      await rollbackOuterTx();
    }

    // 3b. Disable CAND_1 -> Replace with CAND_2 while locked -> Enable CAND_1
    await beginOuterTx();
    try {
      const tv0 = await getTeamVersion(TEAM_A);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, todayStr, tv0, "3b designate CAND_1", nextKey("3b_des")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const uv0 = (await getUserVersion(CAND_1.app)).version;
      await serviceRpc(
        "direct_entry_disable_app_user",
        [OWNER.auth, OWNER.app, CAND_1.app, uv0, "3b disable CAND_1", nextKey("3b_dis")],
        ["uuid", "uuid", "uuid", "integer", "text", "text"],
      );
      const tv1 = await getTeamVersion(TEAM_A);
      const repLocked = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_2.app, todayStr, tv1, "3b replace with CAND_2 while locked", nextKey("3b_rep")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(repLocked.change, "replace");

      const uv1 = (await getUserVersion(CAND_1.app)).version;
      await serviceRpc(
        "direct_entry_enable_app_user",
        [OWNER.auth, OWNER.app, CAND_1.app, uv1, "3b re-enable CAND_1", nextKey("3b_ena")],
        ["uuid", "uuid", "uuid", "integer", "text", "text"],
      );

      const ctx1 = await serviceRpc("direct_entry_resolve_actor_context", [CAND_1.auth], ["uuid"]);
      assert.equal(ctx1.enabled, true);
      assert.deepEqual(
        ctx1.capabilities.filter((c) => TL_CAPS.includes(c)),
        [],
        "Re-enabled CAND_1 must NOT resurrect any TL/WR capability",
      );
      assert.deepEqual(ctx1.team_scope_grants, []);
      const wr1 = await tryServiceRpc("work_report_list_pending_reviews", [CAND_1.auth, CAND_1.app, null, null, 20], ["uuid", "uuid", "uuid", "text", "integer"]);
      assert.equal(wr1.ok, false);
      assert.equal(wr1.code, "42501");
      const lvInbox1 = await tryServiceRpc("leave_management_list_approval_inbox", [CAND_1.auth, CAND_1.app, "PENDING", 50, 0]);
      assert.equal(lvInbox1.ok, false);
      assert.equal(lvInbox1.code, "42501");

      const ctx2 = await serviceRpc("direct_entry_resolve_actor_context", [CAND_2.auth], ["uuid"]);
      for (const cap of TL_CAPS) {
        assert.equal(ctx2.capabilities.includes(cap), true, `CAND_2 must hold ${cap}`);
      }
      const lvSum2 = await serviceRpc("leave_management_get_my_summary", [TEAM_MEMBER.auth, TEAM_MEMBER.app, leaveYear], ["uuid", "uuid", "integer"]);
      assert.equal((lvSum2?.routing ?? lvSum2?.approval_route)?.primary_approver_app_user_id, CAND_2.app);
    } finally {
      await rollbackOuterTx();
    }

    // 3c. Edit Permission Group (triggers sync_legacy_grants) while 3B TL active -> Revoke -> visible & re-designate succeeds (0 42501)
    await beginOuterTx();
    try {
      const grpEditRes = await serviceRpc(
        "direct_entry_authz_create_group_admin",
        [
          OWNER.auth,
          OWNER.app,
          "GRP_3B_SYNC_TEST",
          "Nhóm Test Sync 3B",
          "Test sync_legacy_grants while TL active",
          deptByKey.RECRUITMENT,
          null,
          ["entry_own"],
          JSON.stringify([]),
          "Create GRP_3B_SYNC_TEST",
          nextUuid(),
          sha256("grp:GRP_3B_SYNC_TEST"),
        ],
        ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
      );
      const grpEditId = grpEditRes.group?.group_id ?? grpEditRes.group_id;
      const uvMem = (await getUserVersion(CAND_1.app)).version;
      await serviceRpc(
        "direct_entry_authz_assign_group_member_admin",
        [OWNER.auth, OWNER.app, CAND_1.app, grpEditId, uvMem, "Assign CAND_1 to GRP_3B_SYNC_TEST", nextUuid(), sha256(`assign:${CAND_1.app}:${grpEditId}`)],
        ["uuid", "uuid", "uuid", "uuid", "integer", "text", "uuid", "text"],
      );

      const tv0 = await getTeamVersion(TEAM_A);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, todayStr, tv0, "3c designate before group edit", nextKey("3c_des")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );

      // Advance business date by 1 day inside rolled-back tx so sync_legacy_grants creates team_manager_assign with valid_from != v_old.valid_from!
      await setBusinessDate(setup, tomorrowStr);

      const { rows: [grpRow] } = await setup.query("select version from public.authz_user_groups where group_id = $1::uuid", [grpEditId]);
      const updKey = nextUuid();
      await serviceRpc(
        "direct_entry_authz_update_group_admin",
        [
          OWNER.auth,
          OWNER.app,
          grpEditId,
          grpRow.version,
          "Nhóm Test Sync 3B",
          "Updated while TL active",
          deptByKey.RECRUITMENT,
          null,
          true,
          ["entry_own", "audit_view"],
          JSON.stringify([]),
          "Edit group while TL active",
          updKey,
          sha256(updKey),
        ],
        ["uuid", "uuid", "uuid", "integer", "text", "text", "uuid", "uuid", "boolean", "text[]", "jsonb", "text", "uuid", "text"],
      );

      // Confirm sync_legacy_grants wrote team_manager_assign into legacy capability_grants on tomorrowStr
      const snapSynced = await snapshotTlTables(CAND_1.app);
      assert.equal(
        snapSynced.caps.some((c) => c.capability === "team_manager_assign" && c.is_current && c.valid_from === tomorrowStr),
        true,
      );

      // Revoke TL on tomorrowStr -> succeeds cleanly (0 42501/23514)
      const tv1 = await getTeamVersion(TEAM_A);
      const revRes = await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, tomorrowStr, tv1, "3c revoke after sync_legacy_grants", nextKey("3c_rev")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(revRes.change, "revoke");

      // Candidate reappears in list AND re-designate succeeds with 0 42501!
      const candsAfter = await serviceRpc(
        "direct_entry_list_team_leader_candidates",
        [OWNER.auth, OWNER.app, TEAM_A, null, 1, 25],
        ["uuid", "uuid", "uuid", "text", "integer", "integer"],
      );
      assert.equal(candsAfter.candidates.some((c) => c.app_user_id === CAND_1.app), true);

      const tv2 = await getTeamVersion(TEAM_A);
      const redesRes = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, tomorrowStr, tv2, "3c re-designate after group edit+revoke", nextKey("3c_redes")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(redesRes.change, "designate");
    } finally {
      await rollbackOuterTx();
    }

    // 3d. #42 guards: move & unassign block active & suspended 3B TL, succeed after revoke
    await beginOuterTx();
    try {
      const tv0 = await getTeamVersion(TEAM_A);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_1.app, todayStr, tv0, "3d designate for #42 guard", nextKey("3d_des")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const rv0 = await getRecruiterVersion(CAND_1.rec);
      const mvErrActive = await tryServiceRpc(
        "direct_entry_move_team_membership",
        [OWNER.auth, OWNER.app, CAND_1.rec, TEAM_B, todayStr, rv0, "Move active 3B TL", nextKey("3d_mv1")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(mvErrActive.ok, false);
      assert.equal(mvErrActive.code, "PT409");
      assert.equal(mvErrActive.message, EXPECTED_TL_GUARD_MSG);

      const unErrActive = await tryServiceRpc(
        "direct_entry_unassign_team_membership",
        [OWNER.auth, OWNER.app, CAND_1.rec, todayStr, rv0, "Unassign active 3B TL", nextKey("3d_un1")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(unErrActive.ok, false);
      assert.equal(unErrActive.code, "PT409");
      assert.equal(unErrActive.message, EXPECTED_TL_GUARD_MSG);

      // Suspend CAND_1 -> still blocked!
      const uv0 = (await getUserVersion(CAND_1.app)).version;
      await serviceRpc(
        "direct_entry_disable_app_user",
        [OWNER.auth, OWNER.app, CAND_1.app, uv0, "3d suspend CAND_1", nextKey("3d_dis")],
        ["uuid", "uuid", "uuid", "integer", "text", "text"],
      );
      const mvErrSusp = await tryServiceRpc(
        "direct_entry_move_team_membership",
        [OWNER.auth, OWNER.app, CAND_1.rec, TEAM_B, todayStr, rv0, "Move suspended 3B TL", nextKey("3d_mv2")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(mvErrSusp.ok, false);
      assert.equal(mvErrSusp.code, "PT409");
      assert.equal(mvErrSusp.message, EXPECTED_TL_GUARD_MSG);

      const unErrSusp = await tryServiceRpc(
        "direct_entry_unassign_team_membership",
        [OWNER.auth, OWNER.app, CAND_1.rec, todayStr, rv0, "Unassign suspended 3B TL", nextKey("3d_un2")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(unErrSusp.ok, false);
      assert.equal(unErrSusp.code, "PT409");
      assert.equal(unErrSusp.message, EXPECTED_TL_GUARD_MSG);

      // Re-enable -> Revoke -> Move succeeds!
      const uv1 = (await getUserVersion(CAND_1.app)).version;
      await serviceRpc(
        "direct_entry_enable_app_user",
        [OWNER.auth, OWNER.app, CAND_1.app, uv1, "3d enable CAND_1", nextKey("3d_ena")],
        ["uuid", "uuid", "uuid", "integer", "text", "text"],
      );
      const tv1 = await getTeamVersion(TEAM_A);
      await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, todayStr, tv1, "3d revoke CAND_1", nextKey("3d_rev")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const mvOk = await serviceRpc(
        "direct_entry_move_team_membership",
        [OWNER.auth, OWNER.app, CAND_1.rec, TEAM_B, todayStr, rv0, "Move revoked 3B TL", nextKey("3d_mv_ok")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(mvOk.change, "MOVE");

      // Separate unassign check on CAND_2 after designate -> revoke
      const tv2 = await getTeamVersion(TEAM_A);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, CAND_2.app, todayStr, tv2, "3d designate CAND_2", nextKey("3d_des2")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const tv3 = await getTeamVersion(TEAM_A);
      await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, todayStr, tv3, "3d revoke CAND_2", nextKey("3d_rev2")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const rv2 = await getRecruiterVersion(CAND_2.rec);
      const unOk = await serviceRpc(
        "direct_entry_unassign_team_membership",
        [OWNER.auth, OWNER.app, CAND_2.rec, todayStr, rv2, "Unassign revoked 3B TL", nextKey("3d_un_ok")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(unOk.team_id, TEAM_A);
    } finally {
      await rollbackOuterTx();
    }
  });

  it("4. Preservation of authz_managed=false lifecycle/guards & Real PG18 barrier concurrency (0 40P01 deadlocks)", async () => {
    // 4a. authz_managed = false on TEAM_B: full lifecycle & legacy overlap guards preserved
    await beginOuterTx();
    try {
      // Overlap guard preserved for authz_managed = false
      await setup.query("set local direct_entry.team_leader_marker = 'on'");
      await setup.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
         values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)`,
        [LEGACY_TL_2.app, TEAM_A],
      );
      const listLegSkew = await serviceRpc(
        "direct_entry_list_team_leader_candidates",
        [OWNER.auth, OWNER.app, TEAM_B, null, 1, 25],
        ["uuid", "uuid", "uuid", "text", "integer", "integer"],
      );
      assert.equal(listLegSkew.candidates.some((c) => c.app_user_id === LEGACY_TL_2.app), false, "Legacy candidate with stale scope must stay hidden");
      const tvB0 = await getTeamVersion(TEAM_B);
      const desLegSkew = await tryServiceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_B, LEGACY_TL_2.app, todayStr, tvB0, "Legacy overlap guard", nextKey("4a_skew")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(desLegSkew.ok, false);
      assert.equal(desLegSkew.code, "42501");
      // Clean up stale row for LEGACY_TL_2
      await setup.query("delete from public.direct_entry_scope_grants where app_user_id = $1::uuid", [LEGACY_TL_2.app]);

      // Clean designate LEGACY_TL_1 -> writes scope_grants + cap_grants + 4 wr_bridge
      const desLeg1 = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_B, LEGACY_TL_1.app, todayStr, tvB0, "4a legacy designate", nextKey("4a_des1")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(desLeg1.change, "designate");
      const snapLeg1 = await snapshotTlTables(LEGACY_TL_1.app);
      assert.equal(snapLeg1.scopes.filter((s) => s.scope_kind === "team" && s.is_current).length, 1);
      assert.equal(snapLeg1.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current).length, 1);
      assert.equal(snapLeg1.bridge.filter((b) => b.grant_current).length, 4);

      // Disable -> Enable LEGACY_TL_1 suspends and restores all legacy rows
      const uvl0 = (await getUserVersion(LEGACY_TL_1.app)).version;
      await serviceRpc(
        "direct_entry_disable_app_user",
        [OWNER.auth, OWNER.app, LEGACY_TL_1.app, uvl0, "4a legacy disable", nextKey("4a_dis1")],
        ["uuid", "uuid", "uuid", "integer", "text", "text"],
      );
      const snapLeg1Dis = await snapshotTlTables(LEGACY_TL_1.app);
      assert.equal(snapLeg1Dis.scopes.filter((s) => s.susp).length, 1);
      assert.equal(snapLeg1Dis.caps.filter((c) => c.susp).length, 5);
      assert.equal(snapLeg1Dis.bridge.filter((b) => b.grant_susp).length, 4);

      const uvl1 = (await getUserVersion(LEGACY_TL_1.app)).version;
      await serviceRpc(
        "direct_entry_enable_app_user",
        [OWNER.auth, OWNER.app, LEGACY_TL_1.app, uvl1, "4a legacy enable", nextKey("4a_ena1")],
        ["uuid", "uuid", "uuid", "integer", "text", "text"],
      );
      const snapLeg1Ena = await snapshotTlTables(LEGACY_TL_1.app);
      assert.equal(snapLeg1Ena.scopes.filter((s) => s.is_current).length, 1);
      assert.equal(snapLeg1Ena.caps.filter((c) => c.is_current).length, 5);
      assert.equal(snapLeg1Ena.bridge.filter((b) => b.grant_current).length, 4);

      // Replace LEGACY_TL_1 -> LEGACY_TL_2 -> Revoke LEGACY_TL_2
      const tvB1 = await getTeamVersion(TEAM_B);
      const repLeg = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_B, LEGACY_TL_2.app, todayStr, tvB1, "4a legacy replace", nextKey("4a_rep")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(repLeg.change, "replace");
      const snapLeg1AfterRep = await snapshotTlTables(LEGACY_TL_1.app);
      assert.equal(snapLeg1AfterRep.scopes.filter((s) => s.is_current).length, 0);
      assert.equal(snapLeg1AfterRep.caps.filter((c) => c.is_current).length, 0);
      assert.equal(snapLeg1AfterRep.bridge.filter((b) => b.grant_current).length, 0);

      const snapLeg2 = await snapshotTlTables(LEGACY_TL_2.app);
      assert.equal(snapLeg2.scopes.filter((s) => s.scope_kind === "team" && s.is_current).length, 1);
      assert.equal(snapLeg2.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current).length, 1);
      assert.equal(snapLeg2.bridge.filter((b) => b.grant_current).length, 4);

      const tvB2 = await getTeamVersion(TEAM_B);
      const revLeg2 = await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_B, todayStr, tvB2, "4a legacy revoke", nextKey("4a_rev")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(revLeg2.change, "revoke");
      const snapLeg2AfterRev = await snapshotTlTables(LEGACY_TL_2.app);
      assert.equal(snapLeg2AfterRev.tla.filter((r) => r.is_current).length, 0);
      assert.equal(snapLeg2AfterRev.scopes.filter((s) => s.is_current).length, 0);
      assert.equal(snapLeg2AfterRev.caps.filter((c) => c.is_current).length, 0);
      assert.equal(snapLeg2AfterRev.bridge.filter((b) => b.grant_current).length, 0);
    } finally {
      await rollbackOuterTx();
    }

    // 4b. Real PG18 Barrier Concurrency (committed transactions across w1 & w2)
    const DESIGNATE_SQL =
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::integer, $7, $8) as data";
    const MOVE_SQL =
      "select public.direct_entry_move_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::integer, $7, $8) as data";
    const DISABLE_SQL =
      "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4::integer, $5, $6) as data";

    const T_C1 = await seedTeam("team_3b_c1", "Đội Concurrency 1");
    const T_C2 = await seedTeam("team_3b_c2", "Đội Concurrency 2");
    const T_C3 = await seedTeam("team_3b_c3", "Đội Concurrency 3");

    const CA1 = await seedCandidate("conc.a1", "Conc A1", T_C1, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });
    const CA2 = await seedCandidate("conc.a2", "Conc A2", T_C1, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });

    // Barrier 1: 2 concurrent designate calls on T_C1 (genuine Lock wait -> w2 fails PT409, 0 40P01)
    await beginServiceTx(w1);
    await w1.query(DESIGNATE_SQL, [OWNER.auth, OWNER.app, T_C1, CA1.app, todayStr, 1, "Barrier des 1", nextKey("b_des1")]);
    await beginServiceTx(w2);
    const pDes2 = settleInTx(
      w2,
      w2.query(DESIGNATE_SQL, [OWNER.auth, OWNER.app, T_C1, CA2.app, todayStr, 1, "Barrier des 2", nextKey("b_des2")]),
    );
    const waitDes2 = await waitUntilBlocked(observer, "wp10-7-3b-w2");
    assert.equal(waitDes2.wait_event_type, "Lock");
    await w1.query("commit");
    const rDes2 = await pDes2;
    assertNotDeadlock(rDes2, "Concurrent designate #2");
    assert.equal(rDes2.status, "rejected");
    assert.equal(rDes2.reason?.code, "PT409");

    // Multi-trial Promise.all race of 2 concurrent designate calls
    for (let trial = 0; trial < 3; trial += 1) {
      const tRace = await seedTeam(`team_3b_race_${trial}`, `Đội Race ${trial}`);
      const rA = await seedCandidate(`race.a${trial}`, `Race A${trial}`, tRace, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });
      const rB = await seedCandidate(`race.b${trial}`, `Race B${trial}`, tRace, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });
      const [res1, res2] = await Promise.all([
        tryServiceRpc("direct_entry_designate_team_leader", [OWNER.auth, OWNER.app, tRace, rA.app, todayStr, 1, `Race 1 ${trial}`, nextKey(`r1_${trial}`)], ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"], w1),
        tryServiceRpc("direct_entry_designate_team_leader", [OWNER.auth, OWNER.app, tRace, rB.app, todayStr, 1, `Race 2 ${trial}`, nextKey(`r2_${trial}`)], ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"], w2),
      ]);
      assert.notEqual(res1.code, "40P01");
      assert.notEqual(res2.code, "40P01");
      assert.equal(Number(res1.ok) + Number(res2.ok), 1, `Trial ${trial}: exactly 1 designate must succeed`);
      const loser = res1.ok ? res2 : res1;
      assert.equal(loser.code, "PT409");
    }

    // Barrier 2: designate vs move_team_membership (both barrier orders, 0 40P01)
    const CB1 = await seedCandidate("conc.b1", "Conc B1", T_C2, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });
    const CB2 = await seedCandidate("conc.b2", "Conc B2", T_C2, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });

    // Order 2A: Move first -> Designate blocks on Lock -> Move commits -> Designate rejects cleanly
    await beginServiceTx(w1);
    await w1.query(MOVE_SQL, [OWNER.auth, OWNER.app, CB1.rec, T_C3, todayStr, 1, "Barrier move first", nextKey("b_mv1")]);
    await beginServiceTx(w2);
    const pDesAfterMove = settleInTx(
      w2,
      w2.query(DESIGNATE_SQL, [OWNER.auth, OWNER.app, T_C2, CB1.app, todayStr, 1, "Barrier des after move", nextKey("b_dmv1")]),
    );
    const waitDam = await waitUntilBlocked(observer, "wp10-7-3b-w2");
    assert.equal(waitDam.wait_event_type, "Lock");
    await w1.query("commit");
    const rDam = await pDesAfterMove;
    assertNotDeadlock(rDam, "Designate after move");
    assert.equal(rDam.status, "rejected");

    // Order 2B: Designate first -> Move blocks on Lock -> Designate commits -> Move rejects PT409
    await beginServiceTx(w1);
    await w1.query(DESIGNATE_SQL, [OWNER.auth, OWNER.app, T_C2, CB2.app, todayStr, 1, "Barrier des before move", nextKey("b_des_mv2")]);
    await beginServiceTx(w2);
    const pMoveAfterDes = settleInTx(
      w2,
      w2.query(MOVE_SQL, [OWNER.auth, OWNER.app, CB2.rec, T_C3, todayStr, 1, "Barrier move after des", nextKey("b_mv2")]),
    );
    const waitMad = await waitUntilBlocked(observer, "wp10-7-3b-w2");
    assert.equal(waitMad.wait_event_type, "Lock");
    await w1.query("commit");
    const rMad = await pMoveAfterDes;
    assertNotDeadlock(rMad, "Move after designate");
    assert.equal(rMad.status, "rejected");
    assert.equal(rMad.reason?.code, "PT409");
    assert.equal(rMad.reason?.message, EXPECTED_TL_GUARD_MSG);

    // Barrier 3: designate vs disable_app_user (both barrier orders, 0 40P01)
    const CC1 = await seedCandidate("conc.c1", "Conc C1", T_C3, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });
    const CC2 = await seedCandidate("conc.c2", "Conc C2", T_C3, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });
    const cc1Ver = (await getUserVersion(CC1.app)).version;
    const cc2Ver = (await getUserVersion(CC2.app)).version;

    // Order 3A: Disable first -> Designate blocks on Lock -> Disable commits -> Designate rejects 42501
    await beginServiceTx(w1);
    await w1.query(DISABLE_SQL, [OWNER.auth, OWNER.app, CC1.app, cc1Ver, "Barrier disable first", nextKey("b_dis1")]);
    await beginServiceTx(w2);
    const pDesAfterDis = settleInTx(
      w2,
      w2.query(DESIGNATE_SQL, [OWNER.auth, OWNER.app, T_C3, CC1.app, todayStr, 1, "Barrier des after disable", nextKey("b_ddis1")]),
    );
    const waitDad = await waitUntilBlocked(observer, "wp10-7-3b-w2");
    assert.equal(waitDad.wait_event_type, "Lock");
    await w1.query("commit");
    const rDad = await pDesAfterDis;
    assertNotDeadlock(rDad, "Designate after disable");
    assert.equal(rDad.status, "rejected");
    assert.equal(rDad.reason?.code, "42501");

    // Order 3B: Designate first -> Disable blocks on Lock -> Designate commits -> Disable suspends newly created TLA cleanly!
    await beginServiceTx(w1);
    await w1.query(DESIGNATE_SQL, [OWNER.auth, OWNER.app, T_C3, CC2.app, todayStr, 1, "Barrier des before disable", nextKey("b_ddis2")]);
    await beginServiceTx(w2);
    const pDisAfterDes = settleInTx(
      w2,
      w2.query(DISABLE_SQL, [OWNER.auth, OWNER.app, CC2.app, cc2Ver, "Barrier disable after des", nextKey("b_dis2")]),
    );
    const waitDisAd = await waitUntilBlocked(observer, "wp10-7-3b-w2");
    assert.equal(waitDisAd.wait_event_type, "Lock");
    await w1.query("commit");
    const rDisAd = await pDisAfterDes;
    assertNotDeadlock(rDisAd, "Disable after designate");
    assert.equal(rDisAd.status, "fulfilled", `Disable after designate must succeed: ${rDisAd.reason?.message}`);
    const snapCc2 = await snapshotTlTables(CC2.app, observer);
    assert.equal(snapCc2.tla[0].is_current, false);
    assert.equal(snapCc2.tla[0].susp, true);
    assert.equal(snapCc2.scopes.filter((s) => s.scope_kind === "team").length, 0);
    assert.equal(snapCc2.bridge.length, 0);
  });

  it("5. Post-3B Incident & Full Recovery Drill (23514 on function-only restore vs clean revoke after runbook backfill + function/ACL restore)", async () => {
    // Seed post-3B assignments across 3 recovery scenarios:
    //   1) REC_ACT: pure post-3B active TL (0 scope/cap/wr_bridge)
    //   2) REC_SYNCED: post-3B active TL where sync_legacy_grants wrote partial legacy caps (no report_review, 0 wr_bridge, 0 scope)
    //   3) REC_SUSP: post-3B TL suspended via disable_app_user (0 scope/cap/wr_bridge)
    //   4) REC_REPL_PREV -> REC_REPL_CURR: same-day replace post-3B (tests Section 1B v_restore backfill)
    const T_REC_ACT = await seedTeam("team_3b_rec_act", "Đội Recovery Active");
    const T_REC_SYNC = await seedTeam("team_3b_rec_sync", "Đội Recovery Synced");
    const T_REC_SUSP = await seedTeam("team_3b_rec_susp", "Đội Recovery Suspended");
    const T_REC_REPL = await seedTeam("team_3b_rec_repl", "Đội Recovery Replace");

    const REC_ACT = await seedCandidate("rec.act", "Recovery Active", T_REC_ACT, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });
    const REC_SYNCED = await seedCandidate("rec.sync", "Recovery Synced", T_REC_SYNC, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });
    const REC_SUSP = await seedCandidate("rec.susp", "Recovery Suspended", T_REC_SUSP, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });
    const REC_REPL_PREV = await seedCandidate("rec.rprev", "Recovery Replace Prev", T_REC_REPL, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });
    const REC_REPL_CURR = await seedCandidate("rec.rcurr", "Recovery Replace Curr", T_REC_REPL, deptByKey.RECRUITMENT, { authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS });

    await serviceRpc("direct_entry_designate_team_leader", [OWNER.auth, OWNER.app, T_REC_ACT, REC_ACT.app, todayStr, 1, "5 post-3B active", nextKey("5_act")], ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"]);
    await serviceRpc("direct_entry_designate_team_leader", [OWNER.auth, OWNER.app, T_REC_SYNC, REC_SYNCED.app, todayStr, 1, "5 post-3B synced", nextKey("5_sync")], ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"]);
    await setup.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [REC_SYNCED.app]);

    await serviceRpc("direct_entry_designate_team_leader", [OWNER.auth, OWNER.app, T_REC_SUSP, REC_SUSP.app, todayStr, 1, "5 post-3B susp", nextKey("5_susp")], ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"]);
    const uvSusp = (await getUserVersion(REC_SUSP.app)).version;
    await serviceRpc("direct_entry_disable_app_user", [OWNER.auth, OWNER.app, REC_SUSP.app, uvSusp, "5 disable REC_SUSP", nextKey("5_dis_susp")], ["uuid", "uuid", "uuid", "integer", "text", "text"]);

    await setBusinessDate(setup, yesterdayVn);
    await serviceRpc("direct_entry_designate_team_leader", [OWNER.auth, OWNER.app, T_REC_REPL, REC_REPL_PREV.app, yesterdayVn, 1, "5 post-3B repl prev", nextKey("5_rprev")], ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"]);
    await setBusinessDate(setup, todayStr);
    await serviceRpc("direct_entry_designate_team_leader", [OWNER.auth, OWNER.app, T_REC_REPL, REC_REPL_CURR.app, todayStr, 2, "5 post-3B repl curr", nextKey("5_rcurr")], ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"]);

    const snapActPre = await snapshotTlTables(REC_ACT.app);
    assert.equal(snapActPre.scopes.filter((s) => s.scope_kind === "team").length, 0);
    assert.equal(snapActPre.bridge.length, 0);

    // 5a. Restore ONLY the 3 pre-3B function definitions (NO data backfill) -> revoke MUST fail with 23514!
    await beginOuterTx();
    try {
      await setup.query(pre3bRestoreStatements);
      const revFail = await tryServiceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, T_REC_ACT, todayStr, 2, "5a function-only restore revoke", nextKey("5a_rev")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(revFail.ok, false, "Function-only restore without backfill MUST fail on post-3B revoke");
      assert.equal(revFail.code, "23514", `Expected SQLSTATE 23514, got ${revFail.code}: ${revFail.message}`);
      assert.match(revFail.message, /leader authority interval state conflict/);
    } finally {
      await rollbackOuterTx();
    }

    // 5b. Run EXACT runbook backfill SQL + restore 3 pre-3B function definitions & ACLs in single atomic BEGIN; ... COMMIT;
    await setup.query(`BEGIN;\n${RUNBOOK_EMERGENCY_BACKFILL_DO_SQL}\n${pre3bRestoreStatements}\nCOMMIT;`);

    // Verify catalog parity with pre-3B snapshot (funcdef_sha256, owner, prosecdef, ACL)
    const restoredCatalog = await captureTargetFunctionCatalog(observer);
    assert.deepEqual(
      restoredCatalog.functions.map((f) => ({
        proname: f.proname,
        owner: f.owner,
        prosecdef: f.prosecdef,
        pub: f.public_exec,
        anon: f.anon_exec,
        auth: f.auth_exec,
        svc: f.svc_exec,
        sha: f.funcdef_sha256,
      })),
      pre3bSnapshot.functions.map((f) => ({
        proname: f.proname,
        owner: f.owner,
        prosecdef: f.prosecdef,
        pub: f.public_exec,
        anon: f.anon_exec,
        auth: f.auth_exec,
        svc: f.svc_exec,
        sha: f.funcdef_sha256,
      })),
      "Restored 3 functions + owner + ACLs must match pre-3B snapshot 100%",
    );

    // Verify Query 3A check: 0 active/suspended TL assignments missing legacy pair or 4 wr_bridge rows
    const { rows: [audit3a] } = await observer.query(`
      WITH tl_grant_audit AS (
        SELECT
          a.assignment_id,
          (SELECT count(*)::int FROM public.direct_entry_scope_grants s
            WHERE s.app_user_id = a.leader_app_user_id
              AND s.scope_kind = 'team'
              AND s.team_id = a.team_id
              AND s.valid_from <= a.valid_from
              AND s.valid_to IS NOT DISTINCT FROM a.valid_to
              AND (s.valid_to IS NULL OR s.valid_to > s.valid_from)
              AND s.is_current = a.is_current
              AND s.suspended_by_account_disable = a.suspended_by_account_disable) AS matching_scope_cnt,
          (SELECT count(*)::int FROM public.direct_entry_capability_grants g
            WHERE g.app_user_id = a.leader_app_user_id
              AND g.capability = 'team_manager_assign'
              AND g.valid_from = a.valid_from
              AND g.valid_to IS NOT DISTINCT FROM a.valid_to
              AND (g.valid_to IS NULL OR g.valid_to > g.valid_from)
              AND g.is_current = a.is_current
              AND g.suspended_by_account_disable = a.suspended_by_account_disable) AS matching_cap_cnt,
          (SELECT count(*)::int FROM public.work_report_team_leader_capability_grants x
            WHERE x.leader_assignment_id = a.assignment_id) AS wr_bridge_rows
        FROM public.direct_entry_team_leader_assignments a
        WHERE a.is_current OR a.suspended_by_account_disable
      )
      SELECT count(*) FILTER (WHERE matching_scope_cnt <> 1 OR matching_cap_cnt <> 1)::int AS bad_pair_cnt,
             count(*) FILTER (WHERE wr_bridge_rows <> 4)::int AS bad_bridge_cnt
        FROM tl_grant_audit
    `);
    assert.equal(audit3a.bad_pair_cnt, 0);
    assert.equal(audit3a.bad_bridge_cnt, 0);

    // Revoke REC_ACT -> succeeds cleanly & closes all backfilled rows!
    const tvAct = await getTeamVersion(T_REC_ACT);
    const revAct = await serviceRpc(
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, T_REC_ACT, todayStr, tvAct, "5b revoke REC_ACT", nextKey("5b_act")],
      ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    assert.equal(revAct.change, "revoke");
    const snapActPost = await snapshotTlTables(REC_ACT.app);
    assert.equal(snapActPost.tla.filter((r) => r.is_current).length, 0);
    assert.equal(snapActPost.scopes.filter((s) => s.scope_kind === "team" && s.is_current).length, 0);
    assert.equal(snapActPost.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current).length, 0);
    assert.equal(snapActPost.bridge.filter((b) => b.grant_current || b.grant_valid_to === null).length, 0);

    // Revoke REC_SYNCED -> succeeds cleanly & closes all backfilled rows!
    const tvSync = await getTeamVersion(T_REC_SYNC);
    const revSync = await serviceRpc(
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, T_REC_SYNC, todayStr, tvSync, "5b revoke REC_SYNCED", nextKey("5b_sync")],
      ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    assert.equal(revSync.change, "revoke");
    const snapSyncPost = await snapshotTlTables(REC_SYNCED.app);
    assert.equal(snapSyncPost.tla.filter((r) => r.is_current).length, 0);
    assert.equal(snapSyncPost.scopes.filter((s) => s.scope_kind === "team" && s.is_current).length, 0);
    assert.equal(snapSyncPost.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current).length, 0);
    assert.equal(snapSyncPost.bridge.filter((b) => b.grant_current || b.grant_valid_to === null).length, 0);

    // Enable REC_SUSP -> Revoke REC_SUSP -> succeeds cleanly!
    const uvSuspPost = (await getUserVersion(REC_SUSP.app)).version;
    await serviceRpc(
      "direct_entry_enable_app_user",
      [OWNER.auth, OWNER.app, REC_SUSP.app, uvSuspPost, "5b enable REC_SUSP", nextKey("5b_ena_susp")],
      ["uuid", "uuid", "uuid", "integer", "text", "text"],
    );
    const tvSusp = await getTeamVersion(T_REC_SUSP);
    const revSusp = await serviceRpc(
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, T_REC_SUSP, todayStr, tvSusp, "5b revoke REC_SUSP", nextKey("5b_rev_susp")],
      ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    assert.equal(revSusp.change, "revoke");
    const snapSuspPost = await snapshotTlTables(REC_SUSP.app);
    assert.equal(snapSuspPost.tla.filter((r) => r.is_current || r.susp).length, 0);
    assert.equal(snapSuspPost.scopes.filter((s) => s.scope_kind === "team" && (s.is_current || s.susp)).length, 0);
    assert.equal(snapSuspPost.bridge.filter((b) => b.grant_current || b.grant_susp || b.grant_valid_to === null).length, 0);

    // Revoke REC_REPL_CURR -> same-day v_restore restores REC_REPL_PREV cleanly!
    const tvRepl = await getTeamVersion(T_REC_REPL);
    const revRepl = await serviceRpc(
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, T_REC_REPL, todayStr, tvRepl, "5b revoke REC_REPL_CURR", nextKey("5b_rev_repl")],
      ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    assert.equal(revRepl.change, "revoke");
    const snapReplCurr = await snapshotTlTables(REC_REPL_CURR.app);
    const snapReplPrev = await snapshotTlTables(REC_REPL_PREV.app);
    assert.equal(snapReplCurr.tla.filter((r) => r.is_current).length, 0);
    assert.equal(snapReplPrev.tla.filter((r) => r.is_current && r.valid_to === null).length, 1);
    assert.equal(snapReplPrev.scopes.filter((s) => s.scope_kind === "team" && s.is_current && s.valid_to === null).length, 1);
    assert.equal(snapReplPrev.caps.filter((c) => c.capability === "team_manager_assign" && c.is_current && c.valid_to === null).length, 1);
  });
});
