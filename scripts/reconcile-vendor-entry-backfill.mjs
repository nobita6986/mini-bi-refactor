#!/usr/bin/env node
/**
 * Read-only Dry-Run & Reconciliation Report for Vendor Direct-Entry `vendor_id` Backfill.
 *
 * Uses the exact same source-time classification rules as migration
 * `20261128120000_vendor_referrer_entry_vendor_snapshot.sql`:
 *   - Works both BEFORE migration #259 (no `direct_entries.vendor_id` column yet)
 *     and AFTER migration #259 (to confirm 0 pending `UNIQUE_MATCH` rows remain).
 *   - Runs strictly inside `BEGIN TRANSACTION READ ONLY ... ROLLBACK` when invoked
 *     with `manageTransaction = true` (CLI default).
 *   - Never prints connection URIs, passwords, config secrets, or Worker PII.
 *
 * Usage:
 *   node scripts/reconcile-vendor-entry-backfill.mjs [--db-url <uri>] [--employee-code <code>] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";

import { buildSslOptions } from "./lib/supabase-tls.mjs";

const { Client } = pg;

export const DEFAULT_EMPLOYEE_CODE = "hrp-2026-003553";
export const DEFAULT_REQ_CONFIG_FILE = "C:/importal/db-test-req/DB-staging-for-VPS-req.txt";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toIsoDateOrNull(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s || null;
}

function toIsoTimestampOrNull(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? s : parsed.toISOString();
}

export function parseCliArgs(argv) {
  let dbUrl = null;
  let employeeCode = DEFAULT_EMPLOYEE_CODE;
  let employeeCodeSeen = false;
  let json = false;
  let help = false;

  const takeValue = (args, index, flag, inline) => {
    if (inline !== null) {
      if (inline.trim() === "") {
        throw new Error(`Missing value for ${flag}`);
      }
      return { value: inline.trim(), nextIndex: index };
    }
    const next = args[index + 1];
    if (next === undefined || next.trim() === "" || next.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return { value: next.trim(), nextIndex: index + 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--json") {
      if (json) throw new Error("Duplicate flag --json");
      json = true;
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inline = eqIdx === -1 ? null : arg.slice(eqIdx + 1);

    if (flag === "--db-url") {
      if (dbUrl !== null) throw new Error("Duplicate flag --db-url");
      const parsed = takeValue(argv, i, flag, inline);
      dbUrl = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (flag === "--employee-code") {
      if (employeeCodeSeen) throw new Error("Duplicate flag --employee-code");
      const parsed = takeValue(argv, i, flag, inline);
      employeeCode = parsed.value;
      employeeCodeSeen = true;
      i = parsed.nextIndex;
      continue;
    }

    throw new Error(`Unknown CLI argument: ${arg}`);
  }

  return { dbUrl, employeeCode, json, help };
}

/**
 * Extracts a PostgreSQL URI from a local secret config file without ever
 * echoing the parsed credentials in thrown errors.
 */
export function parseDbUrlFromConfigText(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("DB config file is empty");
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const kvMatch = trimmed.match(/^(SUPABASE_DB_URL|DATABASE_URL|postgresql)\s*[:=]\s*(.+)$/i);
    if (!kvMatch) continue;
    const key = kvMatch[1].toLowerCase();
    let val = kvMatch[2].trim().replace(/^["']|["']$/g, "");
    if (key === "postgresql" && val.startsWith("//")) {
      val = `postgresql:${val}`;
    }
    if (/^postgres(?:ql)?:\/\//i.test(val)) {
      return val;
    }
  }

  const uriMatch = raw.match(/postgres(?:ql)?:\/\/[^\s"'`<>]+/i);
  if (uriMatch) {
    return uriMatch[0].trim();
  }

  throw new Error("Could not find PostgreSQL connection URI in config file");
}

export function resolveDbConnectionConfig(options = {}) {
  const cliDbUrl = normalizeText(options.dbUrl);
  const envDbUrl = normalizeText(options.envDbUrl ?? process.env.SUPABASE_DB_URL);
  const configFile = normalizeText(
    options.configFile ?? process.env.VENDOR_REFERRER_BACKFILL_DB_CONFIG_FILE ?? DEFAULT_REQ_CONFIG_FILE,
  );

  let connectionString = "";
  let source = "";

  if (cliDbUrl) {
    connectionString = cliDbUrl;
    source = "cli:--db-url";
  } else if (envDbUrl) {
    connectionString = envDbUrl;
    source = "env:SUPABASE_DB_URL";
  } else {
    if (!fs.existsSync(configFile)) {
      throw new Error(
        `No --db-url or SUPABASE_DB_URL provided, and fallback config file does not exist: ${configFile}`,
      );
    }
    const raw = fs.readFileSync(configFile, "utf8");
    connectionString = parseDbUrlFromConfigText(raw);
    source = `file:${path.basename(configFile)}`;
  }

  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`Invalid PostgreSQL connection URI from ${source}`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`Unsupported database URI protocol from ${source}`);
  }

  const host = (parsed.hostname || "").toLowerCase();
  const ssl = LOOPBACK_HOSTS.has(host) ? false : buildSslOptions();

  return {
    connectionString,
    ssl,
    source,
  };
}

export function buildVendorEntryClassificationSql(hasVendorIdColumn) {
  const existingVendorExpr = hasVendorIdColumn ? "e.vendor_id" : "null::text";
  return `
    with vendor_entries as (
      select
        e.entry_id,
        e.employee_code,
        e.first_work_date::text as first_work_date,
        e.recruiter_id,
        r.display_name as recruiter_name,
        e.project_id,
        e.created_at as entry_created_at,
        (e.deleted_at is not null) as is_deleted,
        (e.voided_at is not null) as is_voided,
        s.state as submission_state,
        (e.deleted_at is null and e.voided_at is null and s.state = 'SUBMITTED') as is_active_submitted_turn,
        ${existingVendorExpr} as existing_vendor_id
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
      left join public.recruiters r
        on r.recruiter_id = e.recruiter_id
      where e.provider_type = 'vendor'
    ),
    revision_evidence as (
      select
        ve.entry_id,
        exists (
          select 1
            from public.direct_entry_revisions rev
           where rev.entry_id = ve.entry_id
        ) as has_revisions,
        exists (
          select 1
            from public.direct_entry_revisions rev
           where rev.entry_id = ve.entry_id
             and (
               rev.after_snapshot->>'recruiter_id' is distinct from ve.recruiter_id::text
               or rev.after_snapshot->>'provider_type' is distinct from 'vendor'
               or (
                 rev.before_snapshot is not null
                 and (
                   rev.before_snapshot->>'recruiter_id' is distinct from ve.recruiter_id::text
                   or rev.before_snapshot->>'provider_type' is distinct from 'vendor'
                 )
               )
             )
        ) as has_disagreeing_rev,
        latest_rev.created_at as latest_rev_created_at,
        latest_rev.after_snapshot->>'recruiter_id' as latest_rev_recruiter_id,
        latest_rev.after_snapshot->>'provider_type' as latest_rev_provider_type,
        src_rev.created_at as src_rev_created_at
      from vendor_entries ve
      left join lateral (
        select rev.created_at, rev.after_snapshot
          from public.direct_entry_revisions rev
         where rev.entry_id = ve.entry_id
         order by rev.version desc, rev.created_at desc, rev.revision_id desc
         limit 1
      ) latest_rev on true
      left join lateral (
        select rev.created_at
          from public.direct_entry_revisions rev
         where rev.entry_id = ve.entry_id
           and rev.after_snapshot->>'recruiter_id' = ve.recruiter_id::text
           and rev.after_snapshot->>'provider_type' = 'vendor'
           and (
             rev.before_snapshot is null
             or rev.before_snapshot->>'recruiter_id' is distinct from rev.after_snapshot->>'recruiter_id'
             or rev.before_snapshot->>'provider_type' is distinct from rev.after_snapshot->>'provider_type'
           )
         order by rev.version desc, rev.created_at desc, rev.revision_id desc
         limit 1
      ) src_rev on true
    ),
    source_points as (
      select
        ve.*,
        re.has_revisions,
        (
          re.has_revisions
          and (
            re.latest_rev_recruiter_id is distinct from ve.recruiter_id::text
            or re.latest_rev_provider_type is distinct from 'vendor'
            or (re.src_rev_created_at is null and re.has_disagreeing_rev)
          )
        ) as has_revision_conflict,
        case
          when not re.has_revisions then ve.entry_created_at
          when re.src_rev_created_at is not null
           and re.latest_rev_recruiter_id is not distinct from ve.recruiter_id::text
           and re.latest_rev_provider_type is not distinct from 'vendor'
            then re.src_rev_created_at
          when re.src_rev_created_at is null
           and not re.has_disagreeing_rev
           and re.latest_rev_recruiter_id is not distinct from ve.recruiter_id::text
           and re.latest_rev_provider_type is not distinct from 'vendor'
            then ve.entry_created_at
          else coalesce(re.src_rev_created_at, re.latest_rev_created_at, ve.entry_created_at)
        end as source_recorded_at
      from vendor_entries ve
      join revision_evidence re
        on re.entry_id = ve.entry_id
    ),
    source_dates as (
      select
        sp.*,
        (sp.source_recorded_at at time zone 'Asia/Ho_Chi_Minh')::date as source_vn_date
      from source_points sp
    ),
    membership_evidence as (
      select
        sd.*,
        coalesce(vm.distinct_vendor_count, 0)::integer as distinct_vendor_count,
        coalesce(vm.matched_vendor_ids, '{}'::text[]) as matched_vendor_ids,
        case when coalesce(vm.distinct_vendor_count, 0) = 1 then vm.single_vendor_id else null end as matched_vendor_id,
        case when coalesce(vm.distinct_vendor_count, 0) = 1 then vm.single_rpm_created_at else null end as rpm_created_at,
        coalesce(hm.has_hrp_conflict, false) as has_hrp_conflict,
        coalesce(cm.any_time_vendor_rpm_count, 0)::integer as any_time_vendor_rpm_count,
        coalesce(cm.any_time_vendor_ids, '{}'::text[]) as any_time_vendor_ids
      from source_dates sd
      left join lateral (
        select
          count(distinct rpm.vendor_id)::integer as distinct_vendor_count,
          array_agg(distinct rpm.vendor_id order by rpm.vendor_id) as matched_vendor_ids,
          min(rpm.vendor_id) as single_vendor_id,
          max(rpm.created_at) as single_rpm_created_at
        from public.recruiter_provider_memberships rpm
        join public.vendors v
          on v.vendor_id = rpm.vendor_id
       where rpm.recruiter_id = sd.recruiter_id
         and rpm.provider_type = 'vendor'
         and rpm.vendor_id is not null
         and rpm.vendor_id <> '__system_vendor__'
         and rpm.valid_from <= sd.source_vn_date
         and (rpm.valid_to is null or sd.source_vn_date < rpm.valid_to)
         and (rpm.valid_to is null or rpm.valid_to > rpm.valid_from)
         and rpm.created_at <= sd.source_recorded_at
      ) vm on true
      left join lateral (
        select true as has_hrp_conflict
          from public.recruiter_provider_memberships rpm_hrp
         where rpm_hrp.recruiter_id = sd.recruiter_id
           and rpm_hrp.provider_type = 'hrp'
           and rpm_hrp.valid_from <= sd.source_vn_date
           and (rpm_hrp.valid_to is null or sd.source_vn_date < rpm_hrp.valid_to)
           and (rpm_hrp.valid_to is null or rpm_hrp.valid_to > rpm_hrp.valid_from)
           and rpm_hrp.created_at <= sd.source_recorded_at
         limit 1
      ) hm on true
      left join lateral (
        select
          count(distinct rpm_all.vendor_id)::integer as any_time_vendor_rpm_count,
          array_agg(distinct rpm_all.vendor_id order by rpm_all.vendor_id) as any_time_vendor_ids
        from public.recruiter_provider_memberships rpm_all
        where rpm_all.recruiter_id = sd.recruiter_id
          and rpm_all.provider_type = 'vendor'
          and rpm_all.vendor_id is not null
          and rpm_all.vendor_id <> '__system_vendor__'
      ) cm on true
    ),
    classified as (
      select
        me.entry_id::text as entry_id,
        me.employee_code,
        me.first_work_date,
        me.recruiter_id::text as recruiter_id,
        me.recruiter_name,
        me.project_id,
        me.is_deleted,
        me.is_voided,
        me.submission_state,
        me.is_active_submitted_turn,
        me.existing_vendor_id,
        me.has_revisions,
        me.has_revision_conflict,
        me.has_hrp_conflict,
        me.distinct_vendor_count,
        me.matched_vendor_ids,
        me.any_time_vendor_rpm_count,
        me.any_time_vendor_ids,
        me.source_recorded_at,
        me.source_vn_date::text as source_vn_date,
        case
          when me.existing_vendor_id is not null then 'ALREADY_SNAPSHOTTED'
          when me.has_revision_conflict or me.has_hrp_conflict or me.distinct_vendor_count > 1 then 'CONFLICTING_EVIDENCE'
          when me.distinct_vendor_count = 1 then 'UNIQUE_MATCH'
          else 'MISSING_EVIDENCE'
        end as classification,
        case
          when me.existing_vendor_id is not null then null
          when not me.has_revision_conflict and not me.has_hrp_conflict and me.distinct_vendor_count = 1 then me.matched_vendor_id
          else null
        end as matched_vendor_id,
        case
          when me.existing_vendor_id is not null then null
          when not me.has_revision_conflict and not me.has_hrp_conflict and me.distinct_vendor_count = 1 then me.rpm_created_at
          else null
        end as rpm_created_at
      from membership_evidence me
    )
    select *
      from classified
     order by first_work_date asc, employee_code asc, entry_id asc
  `;
}

function buildReasonCodes(row) {
  if (row.classification === "CONFLICTING_EVIDENCE") {
    const reasons = [];
    if (row.has_revision_conflict) reasons.push("REVISION_MISMATCH_OR_MISSING_SOURCE_REVISION");
    if (row.has_hrp_conflict) reasons.push("CONFLICTING_HRP_MEMBERSHIP_AT_SOURCE_TIME");
    if (Number(row.distinct_vendor_count) > 1) reasons.push("MULTIPLE_VENDOR_MEMBERSHIPS_AT_SOURCE_TIME");
    return reasons;
  }
  if (row.classification === "MISSING_EVIDENCE") {
    return Number(row.any_time_vendor_rpm_count) > 0
      ? ["NO_QUALIFYING_MEMBERSHIP_AT_SOURCE_TIME"]
      : ["NO_VENDOR_MEMBERSHIP_RECORD"];
  }
  return [];
}

function toReconciliationItem(row, reasonCodes) {
  const base = {
    entry_id: row.entry_id,
    employee_code: row.employee_code,
    first_work_date: toIsoDateOrNull(row.first_work_date),
    recruiter_id: row.recruiter_id,
    recruiter_name: row.recruiter_name ?? null,
    project_id: row.project_id,
    submission_state: row.submission_state,
    is_deleted: Boolean(row.is_deleted),
    is_voided: Boolean(row.is_voided),
    is_active_submitted_turn: Boolean(row.is_active_submitted_turn),
    source_recorded_at: toIsoTimestampOrNull(row.source_recorded_at),
    source_vn_date: toIsoDateOrNull(row.source_vn_date),
    classification: row.classification,
    reason_codes: reasonCodes,
  };
  if (row.classification === "CONFLICTING_EVIDENCE") {
    base.matched_vendor_ids = Array.isArray(row.matched_vendor_ids) ? row.matched_vendor_ids : [];
  } else {
    base.any_time_vendor_ids = Array.isArray(row.any_time_vendor_ids) ? row.any_time_vendor_ids : [];
  }
  return base;
}

export async function runVendorEntryBackfillDryRun(client, options = {}) {
  const manageTransaction = options.manageTransaction !== false;
  const requestedEmployeeCode = normalizeText(options.employeeCode) || DEFAULT_EMPLOYEE_CODE;

  if (manageTransaction) {
    await client.query("BEGIN TRANSACTION READ ONLY;");
  }

  try {
    const schemaRes = await client.query(`
      select exists (
        select 1
          from information_schema.columns c
         where c.table_schema = 'public'
           and c.table_name = 'direct_entries'
           and c.column_name = 'vendor_id'
      ) as has_vendor_id_column
    `);
    const hasVendorIdColumn = Boolean(schemaRes.rows[0]?.has_vendor_id_column);

    const { rows } = await client.query(buildVendorEntryClassificationSql(hasVendorIdColumn));

    const groups = {
      already_snapshotted: { entries: 0, active_submitted_turns: 0 },
      unique_match: { entries: 0, active_submitted_turns: 0 },
      missing_evidence: { entries: 0, active_submitted_turns: 0 },
      conflicting_evidence: { entries: 0, active_submitted_turns: 0 },
    };

    const missingEvidenceItems = [];
    const conflictingEvidenceItems = [];
    let matchedEmployeeRow = null;
    const targetCodeLower = requestedEmployeeCode.toLowerCase();

    for (const row of rows) {
      const isTurn = Boolean(row.is_active_submitted_turn);
      const turnInc = isTurn ? 1 : 0;

      if (row.classification === "ALREADY_SNAPSHOTTED") {
        groups.already_snapshotted.entries += 1;
        groups.already_snapshotted.active_submitted_turns += turnInc;
      } else if (row.classification === "UNIQUE_MATCH") {
        groups.unique_match.entries += 1;
        groups.unique_match.active_submitted_turns += turnInc;
      } else if (row.classification === "MISSING_EVIDENCE") {
        groups.missing_evidence.entries += 1;
        groups.missing_evidence.active_submitted_turns += turnInc;
        missingEvidenceItems.push(toReconciliationItem(row, buildReasonCodes(row)));
      } else if (row.classification === "CONFLICTING_EVIDENCE") {
        groups.conflicting_evidence.entries += 1;
        groups.conflicting_evidence.active_submitted_turns += turnInc;
        conflictingEvidenceItems.push(toReconciliationItem(row, buildReasonCodes(row)));
      }

      if (!matchedEmployeeRow && String(row.employee_code || "").toLowerCase() === targetCodeLower) {
        matchedEmployeeRow = row;
      }
    }

    let employeeLookup;
    if (matchedEmployeeRow) {
      const rpmCreatedAt = toIsoTimestampOrNull(matchedEmployeeRow.rpm_created_at);
      employeeLookup = {
        found: true,
        entry_id: matchedEmployeeRow.entry_id,
        employee_code: matchedEmployeeRow.employee_code,
        provider_type: "vendor",
        first_work_date: toIsoDateOrNull(matchedEmployeeRow.first_work_date),
        recruiter_id: matchedEmployeeRow.recruiter_id,
        recruiter_name: matchedEmployeeRow.recruiter_name ?? null,
        project_id: matchedEmployeeRow.project_id,
        submission_state: matchedEmployeeRow.submission_state,
        is_active_submitted_turn: Boolean(matchedEmployeeRow.is_active_submitted_turn),
        source_recorded_at: toIsoTimestampOrNull(matchedEmployeeRow.source_recorded_at),
        source_vn_date: toIsoDateOrNull(matchedEmployeeRow.source_vn_date),
        classification: matchedEmployeeRow.classification,
        matched_vendor_id: matchedEmployeeRow.matched_vendor_id ?? null,
        rpm_created_at: rpmCreatedAt,
        vendor_created_at: rpmCreatedAt,
        existing_vendor_id: matchedEmployeeRow.existing_vendor_id ?? null,
        reason_codes: buildReasonCodes(matchedEmployeeRow),
      };
    } else {
      const fallbackRes = await client.query(
        `
          select
            e.entry_id::text as entry_id,
            e.employee_code,
            e.provider_type,
            e.first_work_date::text as first_work_date,
            e.recruiter_id::text as recruiter_id,
            r.display_name as recruiter_name,
            ${hasVendorIdColumn ? "e.vendor_id" : "null::text"} as existing_vendor_id
          from public.direct_entries e
          left join public.recruiters r
            on r.recruiter_id = e.recruiter_id
         where lower(e.employee_code) = lower($1)
         limit 1
        `,
        [requestedEmployeeCode],
      );
      const nonVendor = fallbackRes.rows[0] ?? null;
      employeeLookup = {
        found: Boolean(nonVendor),
        entry_id: nonVendor?.entry_id ?? null,
        employee_code: nonVendor?.employee_code ?? requestedEmployeeCode,
        provider_type: nonVendor?.provider_type ?? null,
        first_work_date: toIsoDateOrNull(nonVendor?.first_work_date),
        recruiter_id: nonVendor?.recruiter_id ?? null,
        recruiter_name: nonVendor?.recruiter_name ?? null,
        source_recorded_at: null,
        source_vn_date: null,
        classification: nonVendor ? `NON_VENDOR_${String(nonVendor.provider_type).toUpperCase()}` : null,
        matched_vendor_id: null,
        rpm_created_at: null,
        vendor_created_at: null,
        existing_vendor_id: nonVendor?.existing_vendor_id ?? null,
        reason_codes: [],
      };
    }

    const totalEntries = rows.length;
    const totalTurns = rows.reduce((acc, row) => acc + (row.is_active_submitted_turn ? 1 : 0), 0);

    const beforeWithVendorEntries = groups.already_snapshotted.entries;
    const beforeWithVendorTurns = groups.already_snapshotted.active_submitted_turns;
    const beforeWithoutVendorEntries = totalEntries - beforeWithVendorEntries;
    const beforeWithoutVendorTurns = totalTurns - beforeWithVendorTurns;

    const afterWithVendorEntries = groups.already_snapshotted.entries + groups.unique_match.entries;
    const afterWithVendorTurns =
      groups.already_snapshotted.active_submitted_turns + groups.unique_match.active_submitted_turns;
    const afterWithoutVendorEntries =
      groups.missing_evidence.entries + groups.conflicting_evidence.entries;
    const afterWithoutVendorTurns =
      groups.missing_evidence.active_submitted_turns + groups.conflicting_evidence.active_submitted_turns;

    const groupedEntriesSum =
      groups.already_snapshotted.entries +
      groups.unique_match.entries +
      groups.missing_evidence.entries +
      groups.conflicting_evidence.entries;
    const groupedTurnsSum =
      groups.already_snapshotted.active_submitted_turns +
      groups.unique_match.active_submitted_turns +
      groups.missing_evidence.active_submitted_turns +
      groups.conflicting_evidence.active_submitted_turns;

    if (manageTransaction) {
      await client.query("ROLLBACK;");
    }

    return {
      schema: {
        has_vendor_id_column: hasVendorIdColumn,
        mode: hasVendorIdColumn ? "post_259" : "pre_259",
      },
      summary: {
        total_vendor_entries: totalEntries,
        total_active_submitted_turns: totalTurns,
        before_backfill: {
          with_vendor_id: {
            entries: beforeWithVendorEntries,
            active_submitted_turns: beforeWithVendorTurns,
          },
          without_vendor_id: {
            entries: beforeWithoutVendorEntries,
            active_submitted_turns: beforeWithoutVendorTurns,
          },
          total: {
            entries: totalEntries,
            active_submitted_turns: totalTurns,
          },
        },
        projected_after_backfill: {
          with_vendor_id: {
            entries: afterWithVendorEntries,
            active_submitted_turns: afterWithVendorTurns,
          },
          without_vendor_id: {
            entries: afterWithoutVendorEntries,
            active_submitted_turns: afterWithoutVendorTurns,
          },
          total: {
            entries: afterWithVendorEntries + afterWithoutVendorEntries,
            active_submitted_turns: afterWithVendorTurns + afterWithoutVendorTurns,
          },
        },
        conservation: {
          entries_conserved:
            groupedEntriesSum === totalEntries &&
            afterWithVendorEntries + afterWithoutVendorEntries === totalEntries,
          active_submitted_turns_conserved:
            groupedTurnsSum === totalTurns &&
            afterWithVendorTurns + afterWithoutVendorTurns === totalTurns,
        },
      },
      groups,
      reconciliation_items: {
        missing_evidence: missingEvidenceItems,
        conflicting_evidence: conflictingEvidenceItems,
      },
      employee_lookup: employeeLookup,
    };
  } catch (err) {
    if (manageTransaction) {
      try {
        await client.query("ROLLBACK;");
      } catch {
        // ignore rollback error after primary failure
      }
    }
    throw err;
  }
}

function formatTextReport(report, connectionSource) {
  const lines = [];
  lines.push("Vendor Direct-Entry Backfill Dry-Run & Reconciliation");
  lines.push(`- Target source: ${connectionSource}`);
  lines.push(`- Schema mode: ${report.schema.mode} (has_vendor_id_column=${report.schema.has_vendor_id_column})`);
  lines.push("");
  lines.push("Summary & Conservation (all vendor direct_entries / active SUBMITTED turns):");
  lines.push(
    `  Before backfill:          with_vendor_id=${report.summary.before_backfill.with_vendor_id.entries} (${report.summary.before_backfill.with_vendor_id.active_submitted_turns} turns), ` +
      `without_vendor_id=${report.summary.before_backfill.without_vendor_id.entries} (${report.summary.before_backfill.without_vendor_id.active_submitted_turns} turns), ` +
      `total=${report.summary.before_backfill.total.entries} (${report.summary.before_backfill.total.active_submitted_turns} turns)`,
  );
  lines.push(
    `  Projected after backfill: with_vendor_id=${report.summary.projected_after_backfill.with_vendor_id.entries} (${report.summary.projected_after_backfill.with_vendor_id.active_submitted_turns} turns), ` +
      `without_vendor_id=${report.summary.projected_after_backfill.without_vendor_id.entries} (${report.summary.projected_after_backfill.without_vendor_id.active_submitted_turns} turns), ` +
      `total=${report.summary.projected_after_backfill.total.entries} (${report.summary.projected_after_backfill.total.active_submitted_turns} turns)`,
  );
  lines.push(
    `  Conservation: entries=${report.summary.conservation.entries_conserved}, active_submitted_turns=${report.summary.conservation.active_submitted_turns_conserved}`,
  );
  lines.push("");
  lines.push("Classification Breakdown:");
  for (const [key, counts] of Object.entries(report.groups)) {
    lines.push(`  - ${key}: ${counts.entries} entries (${counts.active_submitted_turns} active SUBMITTED turns)`);
  }
  lines.push("");
  lines.push(`Employee Lookup (${report.employee_lookup.employee_code}):`);
  if (!report.employee_lookup.found) {
    lines.push("  - Not found in public.direct_entries");
  } else {
    lines.push(
      `  - entry_id=${report.employee_lookup.entry_id}, first_work_date=${report.employee_lookup.first_work_date}, ` +
        `recruiter=${report.employee_lookup.recruiter_id} (${report.employee_lookup.recruiter_name ?? "unknown"}), ` +
        `source_recorded_at=${report.employee_lookup.source_recorded_at}, source_vn_date=${report.employee_lookup.source_vn_date}, ` +
        `classification=${report.employee_lookup.classification}, matched_vendor_id=${report.employee_lookup.matched_vendor_id ?? "null"}, ` +
        `rpm_created_at=${report.employee_lookup.rpm_created_at ?? "null"}, existing_vendor_id=${report.employee_lookup.existing_vendor_id ?? "null"}`,
    );
  }
  lines.push("");
  lines.push(
    `Reconciliation Items: missing_evidence=${report.reconciliation_items.missing_evidence.length}, conflicting_evidence=${report.reconciliation_items.conflicting_evidence.length}`,
  );
  for (const item of [
    ...report.reconciliation_items.conflicting_evidence,
    ...report.reconciliation_items.missing_evidence,
  ]) {
    lines.push(
      `  - [${item.classification}] ${item.employee_code} (${item.entry_id}) first_work_date=${item.first_work_date} ` +
        `recruiter=${item.recruiter_id} (${item.recruiter_name ?? "unknown"}) source_vn_date=${item.source_vn_date} ` +
        `reasons=${item.reason_codes.join(",")}`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/reconcile-vendor-entry-backfill.mjs [--db-url <uri>] [--employee-code <code|hrp-2026-003553>] [--json]",
    );
    return;
  }

  const conn = resolveDbConnectionConfig({ dbUrl: args.dbUrl });
  const client = new Client({
    connectionString: conn.connectionString,
    ssl: conn.ssl,
  });

  await client.connect();
  try {
    const report = await runVendorEntryBackfillDryRun(client, {
      employeeCode: args.employeeCode,
      manageTransaction: true,
    });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatTextReport(report, conn.source));
    }
  } finally {
    await client.end().catch(() => {});
  }
}

const isCliEntry =
  typeof process.argv[1] === "string" &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isCliEntry) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("RECONCILE DRY-RUN FAILED:", message);
    process.exitCode = 1;
  });
}
