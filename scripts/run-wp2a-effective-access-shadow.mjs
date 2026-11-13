#!/usr/bin/env node
/**
 * WP2A — Read-Only Candidate Effective Access & Shadow Comparator CLI Runner
 *
 * Modes:
 *   --pglite                Run against local in-memory PGlite (applies all migrations + synthetic fixture,
 *                           verifies SQL vs RPC parity, and optionally runs EXPLAIN ANALYZE BUFFERS).
 *   --nwc [--config <path>] Run read-only standalone SQL shadow queries (01..04) against NWC DB
 *                           (without applying WP2A migration or any writes).
 *   --as-of <iso8601>       Optional business timestamp (default: server transaction_timestamp()).
 *   --explain               Collect EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) metrics inside READ ONLY tx.
 *   --out <jsonPath>        Write sanitized JSON summary (masked account IDs only, zero secrets/PII).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";
import { buildSslOptions, SUPABASE_CA_PATH } from "./lib/supabase-tls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const SQL_DIR = path.join(__dirname, "wp2a-shadow", "sql");
const EXPECTED_NWC_PROJECT_REF = "nwcvmigrhzdywaumkrjp";
const DEFAULT_NWC_CONFIG = "C:/importal/db-test-nwc/DB-staging-for-VPS-nwc.txt";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

function parseCliArgs(argv) {
  const args = {
    mode: null,
    configPath: process.env.WP2A_NWC_CONFIG_FILE || DEFAULT_NWC_CONFIG,
    asOf: null,
    explain: false,
    outPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--pglite") {
      args.mode = "pglite";
    } else if (token === "--nwc") {
      args.mode = "nwc";
    } else if (token === "--config" && argv[i + 1]) {
      args.configPath = path.resolve(argv[++i]);
    } else if (token === "--as-of" && argv[i + 1]) {
      args.asOf = argv[++i];
    } else if (token === "--explain") {
      args.explain = true;
    } else if (token === "--out" && argv[i + 1]) {
      args.outPath = path.resolve(argv[++i]);
    } else if (token === "--help" || token === "-h") {
      console.log(
        "Usage: node scripts/run-wp2a-effective-access-shadow.mjs (--pglite | --nwc) [--config <path>] [--as-of <iso>] [--explain] [--out <jsonPath>]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown CLI argument: ${token}`);
    }
  }
  if (!args.mode) {
    throw new Error("Specify exactly one target mode: --pglite or --nwc");
  }
  if (args.asOf) {
    const parsed = new Date(args.asOf);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid --as-of timestamp: ${args.asOf}`);
    }
  }
  return args;
}

function maskUuid(value) {
  if (!value || typeof value !== "string") return null;
  return `${value.slice(0, 8)}...`;
}

function extractProjectRefFromPostgresUri(parsedUri) {
  const username = decodeURIComponent(parsedUri.username || "");
  if (username.startsWith("postgres.") && username.length > "postgres.".length) {
    return username.slice("postgres.".length);
  }
  const hostParts = (parsedUri.hostname || "").split(".");
  if (
    hostParts.length === 4 &&
    hostParts[0] === "db" &&
    hostParts[2] === "supabase" &&
    hostParts[3] === "co"
  ) {
    return hostParts[1];
  }
  return null;
}

export function parseExternalNwcConfig(configFilePath, expectedProjectRef = EXPECTED_NWC_PROJECT_REF) {
  if (!fs.existsSync(configFilePath)) {
    throw new Error("External NWC config file not found. Set WP2A_NWC_CONFIG_FILE or pass --config <path>.");
  }
  const raw = fs.readFileSync(configFilePath, "utf8");
  const uriMatch = raw.match(/postgres(?:ql)?:\/\/[^\s"']+/i);
  if (!uriMatch) {
    throw new Error("Could not parse PostgreSQL connection URI from external config file.");
  }

  const connectionString = uriMatch[0].trim();
  const parsedUri = new URL(connectionString);
  const uriProjectRef = extractProjectRefFromPostgresUri(parsedUri);
  if (!uriProjectRef) {
    throw new Error(
      "Refusing to connect: PostgreSQL URI does not expose a verifiable Supabase project ref."
    );
  }

  const apiMatch = raw.match(/https:\/\/([a-z0-9-]+)\.supabase\.co/i);
  const apiProjectRef = apiMatch ? apiMatch[1].toLowerCase() : null;
  if (apiProjectRef && apiProjectRef !== uriProjectRef.toLowerCase()) {
    throw new Error(
      `Refusing to connect: API project ref (${apiProjectRef}) mismatches DB URI project ref (${uriProjectRef}).`
    );
  }
  if (uriProjectRef !== expectedProjectRef) {
    throw new Error(
      `Refusing to connect: target project ref "${uriProjectRef}" does not match locked NWC ref "${expectedProjectRef}".`
    );
  }
  if (
    process.env.SUPABASE_DB_SSL_MODE === "disable" ||
    process.env.SUPABASE_DB_TLS_INSECURE === "1"
  ) {
    throw new Error("Refusing to connect: insecure SSL/TLS overrides are forbidden.");
  }

  const ssl = buildSslOptions();
  if (!ssl || typeof ssl !== "object" || ssl.rejectUnauthorized === false || !ssl.ca) {
    throw new Error("Refusing to connect: verified TLS with Supabase Root CA is required.");
  }

  return {
    connectionString,
    ssl,
    projectRef: uriProjectRef,
    caCertPath: SUPABASE_CA_PATH,
  };
}

function stripSqlCommentsAndSemicolon(sqlText) {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim()
    .replace(/;\s*$/, "");
}

async function loadSqlTemplates() {
  const files = {
    currentSnapshot: "01_current_effective_snapshot.sql",
    candidateDiff: "02_candidate_and_diff.sql",
    driftDiagnostics: "03_drift_diagnostics.sql",
    uatPersonaMatrix: "04_uat_persona_matrix_check.sql",
  };
  const loaded = {};
  for (const [key, name] of Object.entries(files)) {
    const raw = await fsp.readFile(path.join(SQL_DIR, name), "utf8");
    loaded[key] = { name, sql: raw, statement: stripSqlCommentsAndSemicolon(raw) };
  }
  return loaded;
}

async function runInReadOnlyTx(executor, asOfIso, fn) {
  await executor.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;");
  try {
    await executor.query("SET LOCAL TIME ZONE 'Asia/Ho_Chi_Minh';");
    if (asOfIso) {
      await executor.query("SELECT set_config('wp2a.as_of_ts', $1, true);", [asOfIso]);
    }
    const result = await fn();
    await executor.query("ROLLBACK;");
    return result;
  } catch (err) {
    try {
      await executor.query("ROLLBACK;");
    } catch {
      // Ignore rollback errors after original failure
    }
    throw err;
  }
}

function extractExplainSummary(label, explainJson) {
  const root = Array.isArray(explainJson) ? explainJson[0] : explainJson;
  const plan = root?.Plan || {};
  let tempWrittenBlocks = 0;
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;
  let maxNodeTimeMs = 0;
  let maxNodeType = null;

  function walk(node) {
    if (!node || typeof node !== "object") return;
    tempWrittenBlocks += Number(node["Temp Written Blocks"] || 0);
    sharedHitBlocks += Number(node["Shared Hit Blocks"] || 0);
    sharedReadBlocks += Number(node["Shared Read Blocks"] || 0);
    const totalTime = Number(node["Actual Total Time"] || 0);
    if (totalTime >= maxNodeTimeMs) {
      maxNodeTimeMs = totalTime;
      maxNodeType = node["Node Type"] || null;
    }
    if (Array.isArray(node.Plans)) {
      for (const child of node.Plans) walk(child);
    }
  }
  walk(plan);

  return {
    query: label,
    planningTimeMs: Number(root?.["Planning Time"] ?? 0),
    executionTimeMs: Number(root?.["Execution Time"] ?? 0),
    actualRows: Number(plan["Actual Rows"] ?? 0),
    sharedHitBlocks,
    sharedReadBlocks,
    tempWrittenBlocks,
    slowestNodeType: maxNodeType,
    slowestNodeTotalTimeMs: maxNodeTimeMs,
  };
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const k = keyFn(row) ?? "UNKNOWN";
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function sanitizeDiffRows(rows) {
  return rows.map((r) => ({
    account_id_mask: r.account_id_mask || maskUuid(r.app_user_id),
    diff_status: r.diff_status,
    diff_classification: r.diff_classification,
    t0_decision_reason: r.t0_decision_reason,
    row_layer: r.row_layer,
    module_code: r.module_code,
    action_code: r.action_code,
    scope_kind: r.scope_kind,
    scope_ref: r.scope_ref,
    curr_grant_source: r.curr_grant_source,
    cand_grant_source: r.cand_grant_source,
    curr_valid_window: r.curr_valid_window,
    cand_valid_window: r.cand_valid_window,
    reconstructibility: r.reconstructibility,
  }));
}

function sanitizeDriftRows(rows) {
  return rows.map((r) => ({
    drift_category: r.drift_category,
    drift_code: r.drift_code,
    severity: r.severity,
    source_table: r.source_table,
    account_id_mask: r.account_id_mask || maskUuid(r.app_user_id),
    subject_ref: r.subject_ref,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    is_current_state: r.is_current_state,
    temporal_verifiability: r.temporal_verifiability,
    t0_decision_note: r.t0_decision_note,
  }));
}

function sanitizePersonaRows(rows) {
  return rows.map((r) => ({
    row_kind: r.row_kind,
    account_id_mask: r.account_id_mask || maskUuid(r.app_user_id),
    enabled: r.enabled,
    primary_persona: r.primary_persona,
    all_matched_personas: r.all_matched_personas,
    role_verification_status: r.role_verification_status,
    reconstructibility: r.reconstructibility,
    dept_memberships: r.dept_memberships,
    legacy_unit_kind: r.legacy_unit_kind,
  }));
}

async function seedPgliteShadowFixture(db) {
  const TEAM_1 = "11111111-1111-4111-8111-111111111101";
  const PROJ_1 = "WP2A_PROJ_01";
  const U_BOD_ORPHAN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
  const U_TL_DEPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
  const U_CAT_ALL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03";
  const U_PM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04";
  const U_DISABLED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05";

  await db.query(
    `insert into public.teams (team_id, code, display_name, active, version)
     values ($1::uuid, 'WP2A_T1', 'WP2A Team 1', true, 1)`,
    [TEAM_1]
  );
  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active, version)
     values ($1, 'WP2A Project 1', true, 1)`,
    [PROJ_1]
  );

  const users = [
    [U_BOD_ORPHAN, "bod-orphan@example.test", "BOD Orphan", true],
    [U_TL_DEPT, "tl-dept@example.test", "TL Dept", true],
    [U_CAT_ALL, "cat-all@example.test", "Cat All", true],
    [U_PM, "pm@example.test", "PM User", true],
    [U_DISABLED, "disabled@example.test", "Disabled User", false],
  ];
  for (const [id, email, displayName, enabled] of users) {
    await db.query(`insert into auth.users (id, email) values ($1::uuid, $2)`, [id, email]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name, created_at)
       values ($1::uuid, $1::uuid, $2, $3, '2026-01-01T00:00:00Z'::timestamptz)`,
      [id, enabled, displayName]
    );
  }

  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current)
     values ($1::uuid, 'all', '2026-10-01', null, true),
            ($2::uuid, 'all', '2026-10-01', null, true)`,
    [U_BOD_ORPHAN, U_CAT_ALL]
  );
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current)
     values ($1::uuid, 'catalog_master_manage', '2026-10-01', null, true),
            ($2::uuid, 'entry_own', '2026-10-01', null, true),
            ($3::uuid, 'entry_own', '2026-10-01', null, true)`,
    [U_CAT_ALL, U_DISABLED, U_PM]
  );
  await db.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
     values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01'::uuid, 'PM Recruiter', 'REC_PM', 'STAFF', true, 1),
            ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02'::uuid, 'TL Recruiter', 'REC_TL', 'STAFF', true, 1)`
  );
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01'::uuid, true, '2026-10-01', true),
            ($2::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02'::uuid, true, '2026-10-01', true)`,
    [U_PM, U_TL_DEPT]
  );
  await db.query(
    `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, valid_to, is_current, version)
     values ($1, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01'::uuid, '2026-10-01', null, true, 1)`,
    [PROJ_1]
  );
  await db.query(
    `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, is_current)
     values ($1::uuid, $2::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02'::uuid, '2026-10-01', null, true)`,
    [TEAM_1, U_TL_DEPT]
  );
  await db.query(
    `insert into public.leave_department_approvers (unit_kind, approver_app_user_id, valid_from, valid_to, is_current, reason)
     values ('MARKETING', $1::uuid, '2026-10-01', null, true, 'Seed dept approver')`,
    [U_TL_DEPT]
  );
  await db.query(
    `insert into public.leave_employee_profiles (app_user_id, unit_kind, employment_status, work_start_date, official_effective_date, is_shared_non_employee)
     values ($1::uuid, 'MANAGEMENT_BOD', 'OFFICIAL', '2026-01-01', '2026-01-01', false)`,
    [U_BOD_ORPHAN]
  );
}

async function runPgliteMode(args, sqlTemplates) {
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    await db.exec("alter table auth.users add column if not exists email text;");

    const migrationFiles = (await fsp.readdir(MIGRATION_DIR))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const file of migrationFiles) {
      await db.exec(await fsp.readFile(path.join(MIGRATION_DIR, file), "utf8"));
    }

    await seedPgliteShadowFixture(db);
    const asOfIso = args.asOf || "2026-11-12T10:00:00+07:00";

    const data = await runInReadOnlyTx(db, asOfIso, async () => {
      const snapRes = await db.query(sqlTemplates.currentSnapshot.statement);
      const diffRes = await db.query(sqlTemplates.candidateDiff.statement);
      const driftRes = await db.query(sqlTemplates.driftDiagnostics.statement);
      const personaRes = await db.query(sqlTemplates.uatPersonaMatrix.statement);

      const rpcSnap = await db.query(
        `select * from public.direct_entry_authz_resolve_current_snapshot($1::timestamptz, null)`,
        [asOfIso]
      );
      const rpcDiff = await db.query(
        `select * from public.direct_entry_authz_compare_shadow_access($1::timestamptz, null)`,
        [asOfIso]
      );
      const rpcCand = await db.query(
        `select * from public.direct_entry_authz_resolve_candidate_access($1::timestamptz, null)`,
        [asOfIso]
      );

      const normalizeSnap = (rows) =>
        rows
          .map((r) => ({
            app_user_id: r.app_user_id,
            row_layer: r.row_layer,
            module_code: r.module_code,
            action_code: r.action_code,
            scope_kind: r.scope_kind,
            scope_ref: r.scope_ref,
            grant_source: r.grant_source,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const normalizeDiff = (rows) =>
        rows
          .map((r) => ({
            app_user_id: r.app_user_id,
            diff_status: r.diff_status,
            diff_classification: r.diff_classification,
            row_layer: r.row_layer,
            module_code: r.module_code,
            action_code: r.action_code,
            scope_kind: r.scope_kind,
            scope_ref: r.scope_ref,
            curr_grant_source: r.curr_grant_source,
            cand_grant_source: r.cand_grant_source,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

      assert.deepEqual(normalizeSnap(rpcSnap.rows), normalizeSnap(snapRes.rows), "RPC vs SQL current snapshot parity mismatch");
      assert.deepEqual(normalizeDiff(rpcDiff.rows), normalizeDiff(diffRes.rows), "RPC vs SQL diff parity mismatch");

      return {
        snapshotCount: snapRes.rows.length,
        candidateCount: rpcCand.rows.length,
        diffRows: sanitizeDiffRows(diffRes.rows),
        driftRows: sanitizeDriftRows(driftRes.rows),
        personaRows: sanitizePersonaRows(personaRes.rows),
        rpcParityVerified: true,
      };
    });

    const explainPlans = [];
    if (args.explain) {
      await runInReadOnlyTx(db, asOfIso, async () => {
        for (const [label, tpl] of Object.entries(sqlTemplates)) {
          const ex = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${tpl.statement}`);
          explainPlans.push(extractExplainSummary(label, ex.rows[0]["QUERY PLAN"]));
        }
        const exRpc = await db.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM public.direct_entry_authz_compare_shadow_access($1::timestamptz, null)`,
          [asOfIso]
        );
        explainPlans.push(extractExplainSummary("rpcCompareShadowAccess", exRpc.rows[0]["QUERY PLAN"]));
      });
    }

    return {
      target: "pglite",
      asOfTs: asOfIso,
      rpcParityVerified: data.rpcParityVerified,
      snapshotRowCount: data.snapshotCount,
      candidateRowCount: data.candidateCount,
      diffRowCount: data.diffRows.length,
      diffByClassification: countBy(data.diffRows, (r) => r.diff_classification),
      unexpectedDiffCount: data.diffRows.filter((r) => r.diff_classification.startsWith("UNEXPECTED_")).length,
      driftRowCount: data.driftRows.length,
      driftByCode: countBy(data.driftRows, (r) => `${r.severity}:${r.drift_code}`),
      personaRowCount: data.personaRows.length,
      personaPrimaryCounts: countBy(
        data.personaRows.filter((r) => r.row_kind === "ACCOUNT_CANDIDATE"),
        (r) => r.primary_persona
      ),
      uatProvisioningGaps: data.personaRows.filter((r) => r.row_kind === "UAT_PROVISIONING_GAP"),
      diffRows: data.diffRows,
      driftRows: data.driftRows,
      explainPlans,
    };
  } finally {
    await db.close();
  }
}

async function runNwcMode(args, sqlTemplates) {
  const nwcCfg = parseExternalNwcConfig(args.configPath);
  const client = new Client({
    connectionString: nwcCfg.connectionString,
    ssl: nwcCfg.ssl,
  });

  await client.connect();
  try {
    const result = await runInReadOnlyTx(client, args.asOf, async () => {
      const meta = await client.query(
        `select coalesce(nullif(current_setting('wp2a.as_of_ts', true), '')::timestamptz, pg_catalog.transaction_timestamp())::text as effective_as_of_ts`
      );
      const snapRes = await client.query(sqlTemplates.currentSnapshot.statement);
      const diffRes = await client.query(sqlTemplates.candidateDiff.statement);
      const driftRes = await client.query(sqlTemplates.driftDiagnostics.statement);
      const personaRes = await client.query(sqlTemplates.uatPersonaMatrix.statement);

      return {
        effectiveAsOfTs: meta.rows[0]?.effective_as_of_ts || args.asOf || "server_now",
        snapshotCount: snapRes.rows.length,
        diffRows: sanitizeDiffRows(diffRes.rows),
        driftRows: sanitizeDriftRows(driftRes.rows),
        personaRows: sanitizePersonaRows(personaRes.rows),
      };
    });

    const explainPlans = [];
    if (args.explain) {
      await runInReadOnlyTx(client, args.asOf, async () => {
        for (const [label, tpl] of Object.entries(sqlTemplates)) {
          const ex = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${tpl.statement}`);
          explainPlans.push(extractExplainSummary(label, ex.rows[0]["QUERY PLAN"]));
        }
      });
    }

    return {
      target: `nwc:${nwcCfg.projectRef}`,
      tlsCaVerified: path.basename(nwcCfg.caCertPath),
      readOnlyTransactionVerified: true,
      asOfTs: result.effectiveAsOfTs,
      snapshotRowCount: result.snapshotCount,
      diffRowCount: result.diffRows.length,
      diffByClassification: countBy(result.diffRows, (r) => r.diff_classification),
      unexpectedDiffCount: result.diffRows.filter((r) => r.diff_classification.startsWith("UNEXPECTED_")).length,
      driftRowCount: result.driftRows.length,
      driftByCode: countBy(result.driftRows, (r) => `${r.severity}:${r.drift_code}`),
      personaRowCount: result.personaRows.length,
      personaPrimaryCounts: countBy(
        result.personaRows.filter((r) => r.row_kind === "ACCOUNT_CANDIDATE"),
        (r) => r.primary_persona
      ),
      uatProvisioningGaps: result.personaRows.filter((r) => r.row_kind === "UAT_PROVISIONING_GAP"),
      diffRows: result.diffRows,
      driftRows: result.driftRows,
      explainPlans,
    };
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const sqlTemplates = await loadSqlTemplates();
  const report =
    args.mode === "pglite"
      ? await runPgliteMode(args, sqlTemplates)
      : await runNwcMode(args, sqlTemplates);

  const rendered = JSON.stringify(report, null, 2);
  if (args.outPath) {
    await fsp.mkdir(path.dirname(args.outPath), { recursive: true });
    await fsp.writeFile(args.outPath, `${rendered}\n`, "utf8");
  }
  console.log(rendered);
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().catch((err) => {
    console.error(`[wp2a-shadow-runner] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
