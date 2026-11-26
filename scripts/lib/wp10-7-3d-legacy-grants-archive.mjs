import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const WP10_7_3D_MIGRATION_SUFFIX =
  "_wp10_7_3d_drop_direct_entry_legacy_grants.sql";
export const WP10_7_3D_MIGRATION_PATTERN =
  /^\d{14}_wp10_7_3d_drop_direct_entry_legacy_grants\.sql$/;
export const WP10_7_3D_ARCHIVE_FORMAT_VERSION =
  "wp10-7-3d-legacy-grants-archive/v1";

/** Canonical lock & drop order: bridge first to clear incoming FK into capability_grants. */
export const WP10_7_3D_TARGET_TABLES = Object.freeze([
  "work_report_team_leader_capability_grants",
  "direct_entry_capability_grants",
  "direct_entry_scope_grants",
]);

/** Alphabetical order used when computing __BUNDLE_ALL_3_TABLES__ canonical SHA-256. */
export const WP10_7_3D_CANONICAL_TABLE_ORDER = Object.freeze([
  "direct_entry_capability_grants",
  "direct_entry_scope_grants",
  "work_report_team_leader_capability_grants",
]);

export const WP10_7_3D_BUNDLE_TABLE_KEY = "__BUNDLE_ALL_3_TABLES__";

export const WP10_7_3D_LOCK_ORDER_SQL =
  "LOCK TABLE public.work_report_team_leader_capability_grants, public.direct_entry_capability_grants, public.direct_entry_scope_grants IN ACCESS EXCLUSIVE MODE;";

export const WP10_7_3D_PLANNED_DROP_FUNCTION_NAMES = Object.freeze([
  "direct_entry_authz__internal_sync_legacy_grants",
  "work_report_sync_team_leader_capabilities",
  "direct_entry_has_capability",
  "direct_entry_has_scope",
  "direct_entry__internal_capability_grant_effective",
  "direct_entry__internal_team_scope_grant_effective",
  "direct_entry_assert_actor",
  "direct_entry__internal_reconcile_cancelled_team_leaders",
  "direct_entry_transition_legacy_team_leaders",
  "direct_entry_seed_team_scope_grants",
]);

/** Dependency-safe restore order: LANGUAGE sql callees before callers. */
export const WP10_7_3D_RESTORE_FUNCTION_SIGNATURES = Object.freeze([
  "public.direct_entry_guard_effective_interval()",
  "public.direct_entry_set_current_on_insert()",
  "public.work_report_sync_team_leader_capabilities()",
  "public.direct_entry__internal_capability_grant_effective(uuid, date)",
  "public.direct_entry__internal_team_scope_grant_effective(uuid, date)",
  "public.direct_entry_has_capability(uuid, text)",
  "public.direct_entry_has_scope(uuid, text)",
  "public.direct_entry_assert_actor(uuid, uuid, text)",
  "public.direct_entry_authz__internal_sync_legacy_grants(uuid)",
  "public.direct_entry__internal_reconcile_cancelled_team_leaders(date)",
  "public.direct_entry_transition_legacy_team_leaders(date)",
  "public.direct_entry_seed_team_scope_grants()",
]);

export const WP10_7_3D_SHARED_TRIGGER_FUNCTIONS_TO_TRIM = Object.freeze([
  "direct_entry_guard_effective_interval",
  "direct_entry_set_current_on_insert",
]);

export const WP10_7_3D_PRESERVED_SHARED_TRIGGER_FUNCTIONS = Object.freeze([
  "public.direct_entry_clear_authority_on_disable()",
  "public.direct_entry_guard_effective_interval()",
  "public.direct_entry_set_current_on_insert()",
  "public.direct_entry_reject_system_vendor_business_team()",
  "public.direct_entry_team_leader_marker()",
]);

/**
 * Verified historical dynamic-EXECUTE helper allowlist.
 * Even allowlisted signatures are REJECTED if EXECUTE is granted to
 * PUBLIC, anon, authenticated, or service_role.
 */
export const WP10_7_3D_ALLOWLISTED_DYNAMIC_EXECUTE_SIGNATURES = Object.freeze([
  "public.direct_entry_hf_replace_proc_source(regprocedure, text, text, integer)",
]);

export const WP10_7_3D_EXCLUDED_SYSTEM_SCHEMAS = Object.freeze([
  "auth",
  "storage",
  "realtime",
  "extensions",
  "graphql",
  "graphql_public",
  "vault",
  "pgsodium",
  "pgsodium_masks",
  "supabase_functions",
  "supabase_migrations",
  "net",
  "pgtle",
  "cron",
  "pgbouncer",
]);

export const WP10_7_3D_TABLE_SPECS = Object.freeze({
  direct_entry_capability_grants: Object.freeze({
    tableName: "direct_entry_capability_grants",
    csvFile: "direct_entry_capability_grants.archive.csv",
    jsonFile: "direct_entry_capability_grants.archive.json",
    csvColumns: Object.freeze([
      "grant_id",
      "app_user_id",
      "capability",
      "valid_from",
      "valid_to",
      "created_at_utc",
      "is_current",
      "suspended_by_account_disable",
    ]),
    tableColumns: Object.freeze([
      "grant_id",
      "app_user_id",
      "capability",
      "valid_from",
      "valid_to",
      "created_at",
      "is_current",
      "suspended_by_account_disable",
    ]),
    nullableColumns: Object.freeze(["valid_to"]),
    primaryKeyColumns: Object.freeze(["grant_id"]),
    orderBySql: "grant_id ASC",
  }),
  direct_entry_scope_grants: Object.freeze({
    tableName: "direct_entry_scope_grants",
    csvFile: "direct_entry_scope_grants.archive.csv",
    jsonFile: "direct_entry_scope_grants.archive.json",
    csvColumns: Object.freeze([
      "grant_id",
      "app_user_id",
      "scope_kind",
      "team_id",
      "valid_from",
      "valid_to",
      "created_at_utc",
      "is_current",
      "suspended_by_account_disable",
    ]),
    tableColumns: Object.freeze([
      "grant_id",
      "app_user_id",
      "scope_kind",
      "team_id",
      "valid_from",
      "valid_to",
      "created_at",
      "is_current",
      "suspended_by_account_disable",
    ]),
    nullableColumns: Object.freeze(["team_id", "valid_to"]),
    primaryKeyColumns: Object.freeze(["grant_id"]),
    orderBySql: "grant_id ASC",
  }),
  work_report_team_leader_capability_grants: Object.freeze({
    tableName: "work_report_team_leader_capability_grants",
    csvFile: "work_report_team_leader_capability_grants.archive.csv",
    jsonFile: "work_report_team_leader_capability_grants.archive.json",
    csvColumns: Object.freeze([
      "leader_assignment_id",
      "capability",
      "capability_grant_id",
    ]),
    tableColumns: Object.freeze([
      "leader_assignment_id",
      "capability",
      "capability_grant_id",
    ]),
    nullableColumns: Object.freeze([]),
    primaryKeyColumns: Object.freeze(["leader_assignment_id", "capability"]),
    orderBySql: "leader_assignment_id ASC, capability ASC",
  }),
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const VALID_SCOPE_KINDS = new Set(["own", "team", "all"]);
const VALID_BRIDGE_CAPABILITIES = new Set([
  "report_view",
  "report_analytics_view",
  "report_assign",
  "report_review",
]);
const VALID_BOOLEANS = new Set(["true", "false"]);
const PG_TABLE_PRIVILEGE_MAP = Object.freeze({
  r: "SELECT",
  a: "INSERT",
  w: "UPDATE",
  d: "DELETE",
  D: "TRUNCATE",
  x: "REFERENCES",
  t: "TRIGGER",
  m: "MAINTAIN",
});

export function isWp1073dMigrationName(migrationName) {
  return (
    typeof migrationName === "string" &&
    WP10_7_3D_MIGRATION_PATTERN.test(migrationName)
  );
}

function sha256Utf8(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function quotePgIdent(ident) {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function escapeCsvCell(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** RFC-4180 single-line CSV parser (supports quoted fields and "" unescaping). */
function parseCsvLine(line, lineNumber) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else if (ch === '"' && field.length === 0) {
      inQuotes = true;
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    throw new Error(
      `WP10-7-3D archive CSV unterminated quoted field on line ${lineNumber}`,
    );
  }
  fields.push(field);
  return fields;
}

function assertValidUuid(value, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`WP10-7-3D archive invalid UUID for ${label}: ${String(value)}`);
  }
  return value.toLowerCase();
}

function assertValidIsoDate(value, label, allowEmpty = false) {
  if (allowEmpty && (value === "" || value === null || value === undefined)) {
    return "";
  }
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    throw new Error(`WP10-7-3D archive invalid date for ${label}: ${String(value)}`);
  }
  return value;
}

function assertValidUtcTimestamp(value, label) {
  if (typeof value !== "string" || !UTC_TS_RE.test(value)) {
    throw new Error(
      `WP10-7-3D archive invalid UTC timestamp for ${label}: ${String(value)}`,
    );
  }
  return value;
}

function assertValidBoolString(value, label) {
  const str = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  if (!VALID_BOOLEANS.has(str)) {
    throw new Error(`WP10-7-3D archive invalid boolean for ${label}: ${str}`);
  }
  return str;
}

function assertValidCapabilityText(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[|\r\n]/.test(value)) {
    throw new Error(
      `WP10-7-3D archive invalid capability for ${label}: ${String(value)}`,
    );
  }
  return value;
}

function normalizeAndCanonicalizeRows(tableName, rawRows) {
  const spec = WP10_7_3D_TABLE_SPECS[tableName];
  if (!spec) {
    throw new Error(`Unknown WP10-7-3D archive table: ${String(tableName)}`);
  }
  if (!Array.isArray(rawRows)) {
    throw new Error(`WP10-7-3D archive rows for ${tableName} must be an array`);
  }

  const seenKeys = new Set();
  const normalizedRows = [];

  for (let i = 0; i < rawRows.length; i += 1) {
    const raw = rawRows[i];
    const rowCtx = `${tableName}[${i}]`;
    if (tableName === "direct_entry_capability_grants") {
      const grant_id = assertValidUuid(raw.grant_id, `${rowCtx}.grant_id`);
      const app_user_id = assertValidUuid(raw.app_user_id, `${rowCtx}.app_user_id`);
      const capability = assertValidCapabilityText(raw.capability, `${rowCtx}.capability`);
      const valid_from = assertValidIsoDate(raw.valid_from, `${rowCtx}.valid_from`, false);
      const valid_to = assertValidIsoDate(raw.valid_to, `${rowCtx}.valid_to`, true);
      const created_at_utc = assertValidUtcTimestamp(
        raw.created_at_utc,
        `${rowCtx}.created_at_utc`,
      );
      const is_current = assertValidBoolString(raw.is_current, `${rowCtx}.is_current`);
      const suspended_by_account_disable = assertValidBoolString(
        raw.suspended_by_account_disable,
        `${rowCtx}.suspended_by_account_disable`,
      );
      if (seenKeys.has(grant_id)) {
        throw new Error(`WP10-7-3D archive duplicate primary key ${grant_id} in ${tableName}`);
      }
      seenKeys.add(grant_id);
      normalizedRows.push({
        grant_id,
        app_user_id,
        capability,
        valid_from,
        valid_to: valid_to === "" ? null : valid_to,
        created_at_utc,
        is_current: is_current === "true",
        suspended_by_account_disable: suspended_by_account_disable === "true",
      });
    } else if (tableName === "direct_entry_scope_grants") {
      const grant_id = assertValidUuid(raw.grant_id, `${rowCtx}.grant_id`);
      const app_user_id = assertValidUuid(raw.app_user_id, `${rowCtx}.app_user_id`);
      const scope_kind = String(raw.scope_kind ?? "");
      if (!VALID_SCOPE_KINDS.has(scope_kind)) {
        throw new Error(
          `WP10-7-3D archive invalid scope_kind in ${rowCtx}: ${scope_kind}`,
        );
      }
      const rawTeam = raw.team_id ?? "";
      const team_id =
        rawTeam === "" ? null : assertValidUuid(rawTeam, `${rowCtx}.team_id`);
      if ((scope_kind === "team") !== (team_id !== null)) {
        throw new Error(
          `WP10-7-3D archive scope_kind/team_id invariant violation in ${rowCtx}`,
        );
      }
      const valid_from = assertValidIsoDate(raw.valid_from, `${rowCtx}.valid_from`, false);
      const valid_to = assertValidIsoDate(raw.valid_to, `${rowCtx}.valid_to`, true);
      const created_at_utc = assertValidUtcTimestamp(
        raw.created_at_utc,
        `${rowCtx}.created_at_utc`,
      );
      const is_current = assertValidBoolString(raw.is_current, `${rowCtx}.is_current`);
      const suspended_by_account_disable = assertValidBoolString(
        raw.suspended_by_account_disable,
        `${rowCtx}.suspended_by_account_disable`,
      );
      if (seenKeys.has(grant_id)) {
        throw new Error(`WP10-7-3D archive duplicate primary key ${grant_id} in ${tableName}`);
      }
      seenKeys.add(grant_id);
      normalizedRows.push({
        grant_id,
        app_user_id,
        scope_kind,
        team_id,
        valid_from,
        valid_to: valid_to === "" ? null : valid_to,
        created_at_utc,
        is_current: is_current === "true",
        suspended_by_account_disable: suspended_by_account_disable === "true",
      });
    } else {
      const leader_assignment_id = assertValidUuid(
        raw.leader_assignment_id,
        `${rowCtx}.leader_assignment_id`,
      );
      const capability = assertValidCapabilityText(raw.capability, `${rowCtx}.capability`);
      if (!VALID_BRIDGE_CAPABILITIES.has(capability)) {
        throw new Error(
          `WP10-7-3D archive invalid bridge capability in ${rowCtx}: ${capability}`,
        );
      }
      const capability_grant_id = assertValidUuid(
        raw.capability_grant_id,
        `${rowCtx}.capability_grant_id`,
      );
      const pk = `${leader_assignment_id}|${capability}`;
      if (seenKeys.has(pk)) {
        throw new Error(`WP10-7-3D archive duplicate primary key ${pk} in ${tableName}`);
      }
      seenKeys.add(pk);
      normalizedRows.push({
        leader_assignment_id,
        capability,
        capability_grant_id,
      });
    }
  }

  if (tableName === "work_report_team_leader_capability_grants") {
    normalizedRows.sort(
      (a, b) =>
        compareAscii(a.leader_assignment_id, b.leader_assignment_id) ||
        compareAscii(a.capability, b.capability),
    );
  } else {
    normalizedRows.sort((a, b) => compareAscii(a.grant_id, b.grant_id));
  }

  const canonicalLines = normalizedRows.map((row) =>
    spec.csvColumns
      .map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return "";
        if (typeof val === "boolean") return val ? "true" : "false";
        return String(val);
      })
      .join("|"),
  );
  const canonicalSha256 = sha256Utf8(canonicalLines.join("\n"));

  return {
    tableName,
    rowCount: normalizedRows.length,
    canonicalSha256,
    rows: normalizedRows,
  };
}

/**
 * Parse and validate a WP10-7-3D archive CSV for one of the 3 target tables,
 * sort canonically, and compute `{ tableName, rowCount, canonicalSha256, rows }`.
 */
export function parseWp1073dTableArchiveCsv(tableName, csvText) {
  const spec = WP10_7_3D_TABLE_SPECS[tableName];
  if (!spec) {
    throw new Error(`Unknown WP10-7-3D archive table: ${String(tableName)}`);
  }
  if (typeof csvText !== "string") {
    throw new Error(`WP10-7-3D archive CSV for ${tableName} must be a UTF-8 string`);
  }
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const expectedHeader = spec.csvColumns.join(",");
  if (lines.length === 0) {
    throw new Error(
      `WP10-7-3D archive CSV for ${tableName} must start with exact header: ${expectedHeader}`,
    );
  }
  const parsedHeader = parseCsvLine(lines[0], 1);
  if (parsedHeader.join(",") !== expectedHeader) {
    throw new Error(
      `WP10-7-3D archive CSV for ${tableName} must start with exact header: ${expectedHeader} (got: ${parsedHeader.join(",")})`,
    );
  }

  const rawRows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i], i + 1);
    if (cells.length !== spec.csvColumns.length) {
      throw new Error(
        `WP10-7-3D archive CSV for ${tableName} invalid column count on line ${i + 1}: expected ${spec.csvColumns.length}, got ${cells.length}`,
      );
    }
    const obj = {};
    for (let c = 0; c < spec.csvColumns.length; c += 1) {
      obj[spec.csvColumns[c]] = cells[c];
    }
    rawRows.push(obj);
  }

  return normalizeAndCanonicalizeRows(tableName, rawRows);
}

/** Format normalized rows as deterministic RFC-4180 CSV (raw empty fields for NULL). */
export function formatWp1073dTableArchiveCsv(tableName, normalizedRows) {
  const spec = WP10_7_3D_TABLE_SPECS[tableName];
  if (!spec) {
    throw new Error(`Unknown WP10-7-3D archive table: ${String(tableName)}`);
  }
  const lines = [spec.csvColumns.join(",")];
  for (const row of normalizedRows) {
    const cells = spec.csvColumns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return "";
      if (typeof val === "boolean") return val ? "true" : "false";
      return escapeCsvCell(val);
    });
    lines.push(cells.join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Compute deterministic combined `__BUNDLE_ALL_3_TABLES__` fingerprint from per-table entries. */
export function computeWp1073dBundleFingerprint(tablesMap) {
  let totalRows = 0;
  const parts = [];
  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const entry = tablesMap?.[tableName];
    const rowCount = entry?.row_count ?? entry?.rowCount;
    const sha = entry?.canonical_sha256 ?? entry?.canonicalSha256;
    if (!Number.isInteger(rowCount) || rowCount < 0) {
      throw new Error(
        `Invalid WP10-7-3D row count for ${tableName}: ${String(rowCount)}`,
      );
    }
    if (typeof sha !== "string" || !SHA256_HEX_RE.test(sha)) {
      throw new Error(
        `Invalid WP10-7-3D canonical_sha256 for ${tableName}: ${String(sha)}`,
      );
    }
    totalRows += rowCount;
    parts.push(`${tableName}|${rowCount}|${sha.toLowerCase()}`);
  }
  return {
    table_name: WP10_7_3D_BUNDLE_TABLE_KEY,
    row_count: totalRows,
    canonical_sha256: sha256Utf8(parts.join("\n")),
  };
}

/**
 * Compute live PostgreSQL canonical UTF-8 SHA-256 fingerprints across all 3 target
 * tables + `__BUNDLE_ALL_3_TABLES__` (matches `3d_readonly_preflight.sql` Section 4).
 */
export async function computeWp1073dLiveFingerprintsInTx(client) {
  const { rows } = await client.query(`
    WITH cap_manifest AS (
      SELECT 'direct_entry_capability_grants'::text AS table_name,
             count(*)::bigint AS row_count,
             pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   coalesce(
                     pg_catalog.string_agg(
                       cg.grant_id::text
                       || '|' || cg.app_user_id::text
                       || '|' || cg.capability
                       || '|' || cg.valid_from::text
                       || '|' || coalesce(cg.valid_to::text, '')
                       || '|' || pg_catalog.to_char(cg.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                       || '|' || cg.is_current::text
                       || '|' || cg.suspended_by_account_disable::text,
                       E'\\n'
                       ORDER BY cg.grant_id ASC
                     ),
                     ''
                   ),
                   'UTF8'
                 )
               ),
               'hex'
             ) AS canonical_sha256
        FROM public.direct_entry_capability_grants cg
    ),
    scope_manifest AS (
      SELECT 'direct_entry_scope_grants'::text AS table_name,
             count(*)::bigint AS row_count,
             pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   coalesce(
                     pg_catalog.string_agg(
                       sg.grant_id::text
                       || '|' || sg.app_user_id::text
                       || '|' || sg.scope_kind
                       || '|' || coalesce(sg.team_id::text, '')
                       || '|' || sg.valid_from::text
                       || '|' || coalesce(sg.valid_to::text, '')
                       || '|' || pg_catalog.to_char(sg.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                       || '|' || sg.is_current::text
                       || '|' || sg.suspended_by_account_disable::text,
                       E'\\n'
                       ORDER BY sg.grant_id ASC
                     ),
                     ''
                   ),
                   'UTF8'
                 )
               ),
               'hex'
             ) AS canonical_sha256
        FROM public.direct_entry_scope_grants sg
    ),
    bridge_manifest AS (
      SELECT 'work_report_team_leader_capability_grants'::text AS table_name,
             count(*)::bigint AS row_count,
             pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   coalesce(
                     pg_catalog.string_agg(
                       x.leader_assignment_id::text
                       || '|' || x.capability
                       || '|' || x.capability_grant_id::text,
                       E'\\n'
                       ORDER BY x.leader_assignment_id ASC, x.capability ASC
                     ),
                     ''
                   ),
                   'UTF8'
                 )
               ),
               'hex'
             ) AS canonical_sha256
        FROM public.work_report_team_leader_capability_grants x
    ),
    all_manifests AS (
      SELECT * FROM cap_manifest
      UNION ALL
      SELECT * FROM scope_manifest
      UNION ALL
      SELECT * FROM bridge_manifest
    )
    SELECT table_name, row_count, canonical_sha256 FROM all_manifests
    UNION ALL
    SELECT '${WP10_7_3D_BUNDLE_TABLE_KEY}'::text AS table_name,
           (SELECT sum(row_count)::bigint FROM all_manifests) AS row_count,
           pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 (
                   SELECT pg_catalog.string_agg(
                     m2.table_name || '|' || m2.row_count::text || '|' || m2.canonical_sha256,
                     E'\\n'
                     ORDER BY m2.table_name ASC
                   )
                   FROM all_manifests m2
                 ),
                 'UTF8'
               )
             ),
             'hex'
           ) AS canonical_sha256
  `);

  const tables = {};
  let bundle = null;
  for (const row of rows) {
    const parsed = {
      row_count: Number(row.row_count),
      canonical_sha256: String(row.canonical_sha256 ?? "").toLowerCase(),
    };
    if (row.table_name === WP10_7_3D_BUNDLE_TABLE_KEY) {
      bundle = {
        table_name: WP10_7_3D_BUNDLE_TABLE_KEY,
        ...parsed,
      };
    } else {
      tables[row.table_name] = parsed;
    }
  }
  return { tables, bundle };
}

/**
 * Capture full 8-dimension PostgreSQL catalog snapshot for the 3 target tables,
 * the external bridge trigger, and the functions trimmed/dropped in Slice 3D.
 */
export async function captureWp1073dCatalogSnapshot(client) {
  const tables = {};
  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const {
      rows: [cls],
    } = await client.query(
      `select c.relname,
              pg_catalog.pg_get_userbyid(c.relowner) as owner,
              c.relrowsecurity,
              c.relforcerowsecurity,
              coalesce(c.relacl::text[], array[]::text[]) as relacl
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1`,
      [tableName],
    );
    if (!cls) {
      throw new Error(
        `WP10-7-3D catalog snapshot failed: table public.${tableName} does not exist`,
      );
    }

    const { rows: cols } = await client.query(
      `select a.attnum::int as attnum,
              a.attname,
              pg_catalog.format_type(a.atttypid, a.atttypmod) as typ,
              a.attnotnull,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) as defval
         from pg_catalog.pg_attribute a
         left join pg_catalog.pg_attrdef d
           on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = ('public.' || $1)::pg_catalog.regclass
          and a.attnum > 0
          and not a.attisdropped
        order by a.attnum`,
      [tableName],
    );

    const { rows: cons } = await client.query(
      `select conname,
              contype::text as contype,
              pg_catalog.pg_get_constraintdef(oid) as condef
         from pg_catalog.pg_constraint
        where conrelid = ('public.' || $1)::pg_catalog.regclass
          and contype in ('c', 'f', 'p', 'u')
        order by contype, conname`,
      [tableName],
    );

    const { rows: idxs } = await client.query(
      `select i.indexrelid::pg_catalog.regclass::text as idx,
              i.indisprimary as is_primary,
              pg_catalog.pg_get_indexdef(i.indexrelid) as idxdef
         from pg_catalog.pg_index i
        where i.indrelid = ('public.' || $1)::pg_catalog.regclass
        order by 1`,
      [tableName],
    );

    const { rows: trgs } = await client.query(
      `select t.tgname,
              p.oid::pg_catalog.regprocedure::text as fn_sig,
              pg_catalog.pg_get_triggerdef(t.oid) as tgdef
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = ('public.' || $1)::pg_catalog.regclass
          and not t.tgisinternal
        order by t.tgname`,
      [tableName],
    );

    const { rows: pols } = await client.query(
      `select polname,
              polcmd::text as polcmd,
              polpermissive,
              pg_catalog.pg_get_expr(polqual, polrelid) as qual,
              pg_catalog.pg_get_expr(polwithcheck, polrelid) as withcheck,
              array(
                select case when r = 0 then 'public'::text else pg_catalog.pg_get_userbyid(r)::text end
                  from unnest(polroles) r
                 order by 1
              )::text[] as roles
         from pg_catalog.pg_policy
        where polrelid = ('public.' || $1)::pg_catalog.regclass
        order by polname`,
      [tableName],
    );

    tables[tableName] = {
      owner: cls.owner,
      relrowsecurity: Boolean(cls.relrowsecurity),
      relforcerowsecurity: Boolean(cls.relforcerowsecurity),
      relacl: [...cls.relacl].sort(compareAscii),
      cols: cols.map((c) => ({
        attnum: Number(c.attnum),
        attname: c.attname,
        typ: c.typ,
        attnotnull: Boolean(c.attnotnull),
        defval: c.defval ?? null,
      })),
      cons: cons.map((c) => ({
        conname: c.conname,
        contype: c.contype,
        condef: c.condef,
      })),
      idxs: idxs.map((ix) => ({
        idx: ix.idx,
        is_primary: Boolean(ix.is_primary),
        idxdef: ix.idxdef,
      })),
      trgs: trgs.map((t) => ({
        tgname: t.tgname,
        fn_sig: t.fn_sig,
        tgdef: t.tgdef,
      })),
      pols: pols.map((p) => ({
        polname: p.polname,
        polcmd: p.polcmd,
        polpermissive: Boolean(p.polpermissive),
        qual: p.qual ?? null,
        withcheck: p.withcheck ?? null,
        roles: (() => {
          if (!Array.isArray(p.roles)) {
            throw new Error(
              `WP10-7-3D catalog snapshot expected text[] array for policy roles on ${tableName}.${p.polname}`,
            );
          }
          return [...p.roles].sort(compareAscii);
        })(),
      })),
    };
  }

  const { rows: externalBridgeTriggers } = await client.query(`
    select c.relname as table_name,
           t.tgname,
           p.oid::pg_catalog.regprocedure::text as fn_sig,
           pg_catalog.pg_get_triggerdef(t.oid) as tgdef
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
     where not t.tgisinternal
       and n.nspname = 'public'
       and p.proname = 'work_report_sync_team_leader_capabilities'
     order by c.relname, t.tgname
  `);

  const functions = {};
  for (const sig of WP10_7_3D_RESTORE_FUNCTION_SIGNATURES) {
    const {
      rows: [fnRow],
    } = await client.query(
      `select p.oid::pg_catalog.regprocedure::text as canonical_sig,
              pg_catalog.pg_get_functiondef(p.oid) as def,
              pg_catalog.pg_get_userbyid(p.proowner) as owner,
              coalesce(p.proacl::text[], array[]::text[]) as proacl
         from pg_catalog.pg_proc p
        where p.oid = pg_catalog.to_regprocedure($1)`,
      [sig],
    );
    if (fnRow) {
      functions[sig] = {
        canonical_sig: fnRow.canonical_sig,
        def: fnRow.def,
        owner: fnRow.owner,
        proacl: [...fnRow.proacl].sort(compareAscii),
      };
    }
  }

  return {
    tables,
    external_bridge_triggers: externalBridgeTriggers.map((t) => ({
      table_name: t.table_name,
      tgname: t.tgname,
      fn_sig: t.fn_sig,
      tgdef: t.tgdef,
    })),
    functions,
  };
}

function parsePgAclEntry(entry) {
  const eqIdx = entry.indexOf("=");
  const slashIdx = entry.lastIndexOf("/");
  if (eqIdx === -1 || slashIdx === -1 || slashIdx <= eqIdx) {
    return null;
  }
  const grantee = entry.slice(0, eqIdx);
  const privCodes = entry.slice(eqIdx + 1, slashIdx);
  const grantor = entry.slice(slashIdx + 1);
  return { grantee, privCodes, grantor };
}

function buildTableAclStatements(tableName, owner, relacl) {
  const stmts = [
    `REVOKE ALL ON public.${tableName} FROM PUBLIC, anon, authenticated, service_role;`,
  ];
  for (const entry of relacl ?? []) {
    const parsed = parsePgAclEntry(entry);
    if (!parsed) continue;
    if (parsed.grantee === owner) continue;
    const targetRole =
      parsed.grantee === "" ? "PUBLIC" : quotePgIdent(parsed.grantee);
    const privs = [];
    for (const ch of parsed.privCodes) {
      if (ch === "*") continue;
      const mapped = PG_TABLE_PRIVILEGE_MAP[ch];
      if (mapped) privs.push(mapped);
    }
    if (privs.length > 0) {
      stmts.push(`GRANT ${privs.join(", ")} ON public.${tableName} TO ${targetRole};`);
    }
  }
  return stmts;
}

function buildFunctionAclStatements(sig, owner, proacl) {
  const stmts = [
    `ALTER FUNCTION ${sig} OWNER TO ${quotePgIdent(owner)};`,
    `REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`,
  ];
  for (const entry of proacl ?? []) {
    const parsed = parsePgAclEntry(entry);
    if (!parsed) continue;
    if (parsed.grantee === owner) continue;
    if (parsed.privCodes.includes("X")) {
      const targetRole =
        parsed.grantee === "" ? "PUBLIC" : quotePgIdent(parsed.grantee);
      stmts.push(`GRANT EXECUTE ON FUNCTION ${sig} TO ${targetRole};`);
    }
  }
  return stmts;
}

function mapPolicyCommand(polcmd) {
  switch (polcmd) {
    case "r":
      return "SELECT";
    case "a":
      return "INSERT";
    case "w":
      return "UPDATE";
    case "d":
      return "DELETE";
    case "*":
    default:
      return "ALL";
  }
}

function buildCreateTableDdl(tableName, tableSnap) {
  const lines = [];
  for (const col of tableSnap.cols) {
    let colDef = `  ${quotePgIdent(col.attname)} ${col.typ}`;
    if (col.defval !== null) {
      colDef += ` DEFAULT ${col.defval}`;
    }
    if (col.attnotnull) {
      colDef += " NOT NULL";
    }
    lines.push(colDef);
  }
  for (const con of tableSnap.cons) {
    if (con.contype === "p" || con.contype === "c" || con.contype === "u") {
      lines.push(`  CONSTRAINT ${quotePgIdent(con.conname)} ${con.condef}`);
    }
  }
  return [
    `CREATE TABLE public.${tableName} (\n${lines.join(",\n")}\n);`,
    `ALTER TABLE public.${tableName} OWNER TO ${quotePgIdent(tableSnap.owner)};`,
  ];
}

function buildPostDataSchemaStatements(catalogSnapshot) {
  const stmts = [];

  // (iii) Foreign keys (after data load) + non-PK indexes
  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const snap = catalogSnapshot.tables[tableName];
    for (const con of snap.cons) {
      if (con.contype === "f") {
        stmts.push(
          `ALTER TABLE public.${tableName} ADD CONSTRAINT ${quotePgIdent(con.conname)} ${con.condef};`,
        );
      }
    }
  }
  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const snap = catalogSnapshot.tables[tableName];
    for (const ix of snap.idxs) {
      if (!ix.is_primary) {
        stmts.push(`${ix.idxdef};`);
      }
    }
  }

  // (iv) Restore trimmed & dropped functions in strict dependency-safe order (Runbook Trap #3:
  //      LANGUAGE sql callees __internal_*_grant_effective BEFORE direct_entry_has_capability/scope!)
  for (const sig of WP10_7_3D_RESTORE_FUNCTION_SIGNATURES) {
    const fnSnap = catalogSnapshot.functions?.[sig];
    if (!fnSnap) continue;
    const defTrimmed = fnSnap.def.trim().replace(/;+$/, "");
    stmts.push(`${defTrimmed};`);
    stmts.push(...buildFunctionAclStatements(sig, fnSnap.owner, fnSnap.proacl));
  }

  // Attach all 7 direct triggers + external bridge trigger AFTER data load (Runbook Trap #1)
  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const snap = catalogSnapshot.tables[tableName];
    for (const trg of snap.trgs) {
      stmts.push(`${trg.tgdef};`);
    }
  }
  for (const extTrg of catalogSnapshot.external_bridge_triggers ?? []) {
    stmts.push(`${extTrg.tgdef};`);
  }

  // (v) RLS, FORCE RLS, ACLs, and RLS policies
  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const snap = catalogSnapshot.tables[tableName];
    if (snap.relrowsecurity) {
      stmts.push(`ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY;`);
    }
    if (snap.relforcerowsecurity) {
      stmts.push(`ALTER TABLE public.${tableName} FORCE ROW LEVEL SECURITY;`);
    }
    stmts.push(...buildTableAclStatements(tableName, snap.owner, snap.relacl));
    for (const pol of snap.pols) {
      const permissive = pol.polpermissive ? "PERMISSIVE" : "RESTRICTIVE";
      const cmd = mapPolicyCommand(pol.polcmd);
      const roles = pol.roles
        .map((r) => (r === "public" ? "PUBLIC" : quotePgIdent(r)))
        .join(", ");
      let sql = `CREATE POLICY ${quotePgIdent(pol.polname)} ON public.${tableName} AS ${permissive} FOR ${cmd} TO ${roles}`;
      if (pol.qual !== null) {
        sql += ` USING (${pol.qual})`;
      }
      if (pol.withcheck !== null) {
        sql += ` WITH CHECK (${pol.withcheck})`;
      }
      stmts.push(`${sql};`);
    }
  }

  return stmts;
}

/**
 * Build deterministic standalone `psql` restore SQL bundle that handles all 3 runbook traps:
 *   1. Data load BEFORE attaching triggers (`set_current_on_insert` & `marker_guard`)
 *   2. CSV `\copy ... WITH (FORMAT csv, HEADER true, NULL '', FORCE_NULL (...))`
 *   3. `LANGUAGE sql` callees recreated BEFORE callers
 */
export function buildWp1073dRestoreSql({ catalogSnapshot, csvPaths }) {
  const lines = [
    "-- =============================================================================",
    "-- WP10-7 Slice 3D — Deterministic Legacy Grants Restore Bundle",
    "-- Handles all 3 Runbook Traps:",
    "--   1. Loads archived CSVs BEFORE attaching set_current_on_insert / marker_guard triggers",
    "--   2. Uses explicit NULL '' + FORCE_NULL on nullable columns (valid_to, team_id)",
    "--   3. Restores LANGUAGE sql callees before direct_entry_has_capability / has_scope",
    "-- =============================================================================",
    "BEGIN;",
    "",
    "-- (i) Recreate tables with exact columns, types, defaults, NOT NULL, PK, CHECKs, and owner",
  ];

  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    lines.push(...buildCreateTableDdl(tableName, catalogSnapshot.tables[tableName]));
    lines.push("");
  }

  lines.push(
    "-- (ii) Load archived CSVs BEFORE attaching triggers (Trap #1 & Trap #2)",
  );
  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const spec = WP10_7_3D_TABLE_SPECS[tableName];
    const csvPath = String(csvPaths[tableName]).replaceAll("\\", "/");
    const forceNullClause =
      spec.nullableColumns.length > 0
        ? `, FORCE_NULL (${spec.nullableColumns.join(", ")})`
        : "";
    lines.push(
      `\\copy public.${tableName} (${spec.tableColumns.join(", ")}) FROM '${csvPath}' WITH (FORMAT csv, HEADER true, NULL ''${forceNullClause})`,
    );
  }
  lines.push("");
  lines.push(
    "-- (iii)-(v) Restore FKs, indexes, functions (Trap #3), triggers, RLS, ACLs, and policies",
  );
  lines.push(...buildPostDataSchemaStatements(catalogSnapshot));
  lines.push("");
  lines.push("COMMIT;");
  lines.push("");
  return lines.join("\n");
}

/**
 * Export all 3 target tables (deterministic CSV + JSON), full 8-dimension catalog
 * snapshot, deterministic `restore.sql`, and verified `manifest.json` inside a
 * `REPEATABLE READ READ ONLY` snapshot.
 */
export async function exportWp1073dLegacyGrantsArchive(
  client,
  outputDir,
  { inExistingTransaction = false } = {},
) {
  if (typeof outputDir !== "string" || outputDir.trim() === "") {
    throw new Error("WP10-7-3D archive outputDir must be a non-empty string");
  }
  const resolvedDir = path.resolve(outputDir);
  await mkdir(resolvedDir, { recursive: true });

  const rawRowsByTable = {};
  let pgFingerprints;
  let catalogSnapshot;

  if (!inExistingTransaction) {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
  }
  try {
    const capRes = await client.query(`
      SELECT grant_id::text AS grant_id,
             app_user_id::text AS app_user_id,
             capability,
             valid_from::text AS valid_from,
             valid_to::text AS valid_to,
             pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_utc,
             is_current,
             suspended_by_account_disable
        FROM public.direct_entry_capability_grants
       ORDER BY grant_id ASC
    `);
    rawRowsByTable.direct_entry_capability_grants = capRes.rows;

    const scopeRes = await client.query(`
      SELECT grant_id::text AS grant_id,
             app_user_id::text AS app_user_id,
             scope_kind,
             team_id::text AS team_id,
             valid_from::text AS valid_from,
             valid_to::text AS valid_to,
             pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_utc,
             is_current,
             suspended_by_account_disable
        FROM public.direct_entry_scope_grants
       ORDER BY grant_id ASC
    `);
    rawRowsByTable.direct_entry_scope_grants = scopeRes.rows;

    const bridgeRes = await client.query(`
      SELECT leader_assignment_id::text AS leader_assignment_id,
             capability,
             capability_grant_id::text AS capability_grant_id
        FROM public.work_report_team_leader_capability_grants
       ORDER BY leader_assignment_id ASC, capability ASC
    `);
    rawRowsByTable.work_report_team_leader_capability_grants = bridgeRes.rows;

    pgFingerprints = await computeWp1073dLiveFingerprintsInTx(client);
    catalogSnapshot = await captureWp1073dCatalogSnapshot(client);
  } finally {
    if (!inExistingTransaction) {
      await client.query("ROLLBACK").catch(() => {});
    }
  }

  const tablesManifest = {};
  const files = {};
  const csvPaths = {};

  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const spec = WP10_7_3D_TABLE_SPECS[tableName];
    const canonical = normalizeAndCanonicalizeRows(
      tableName,
      rawRowsByTable[tableName],
    );
    const pgTableFp = pgFingerprints.tables[tableName];
    if (
      !pgTableFp ||
      canonical.rowCount !== pgTableFp.row_count ||
      canonical.canonicalSha256 !== pgTableFp.canonical_sha256
    ) {
      throw new Error(
        `WP10-7-3D archive export self-check failed for ${tableName}: ` +
          `node=(${canonical.rowCount}, ${canonical.canonicalSha256}) vs ` +
          `pg=(${pgTableFp?.row_count}, ${pgTableFp?.canonical_sha256})`,
      );
    }

    const csvText = formatWp1073dTableArchiveCsv(tableName, canonical.rows);
    // Round-trip verify CSV parser against PostgreSQL SHA-256!
    const reparsedCsv = parseWp1073dTableArchiveCsv(tableName, csvText);
    if (
      reparsedCsv.rowCount !== pgTableFp.row_count ||
      reparsedCsv.canonicalSha256 !== pgTableFp.canonical_sha256
    ) {
      throw new Error(
        `WP10-7-3D archive CSV round-trip mismatch for ${tableName}`,
      );
    }

    const jsonText = `${JSON.stringify(
      {
        table_name: tableName,
        row_count: canonical.rowCount,
        canonical_sha256: canonical.canonicalSha256,
        rows: canonical.rows,
      },
      null,
      2,
    )}\n`;

    const csvPath = path.join(resolvedDir, spec.csvFile);
    const jsonPath = path.join(resolvedDir, spec.jsonFile);
    await writeFile(csvPath, csvText, "utf8");
    await writeFile(jsonPath, jsonText, "utf8");

    csvPaths[tableName] = csvPath;
    files[tableName] = { csvPath, jsonPath };
    tablesManifest[tableName] = {
      row_count: canonical.rowCount,
      canonical_sha256: canonical.canonicalSha256,
      csv_file: spec.csvFile,
      json_file: spec.jsonFile,
      csv_sha256: sha256Utf8(csvText),
      json_sha256: sha256Utf8(jsonText),
    };
  }

  const bundle = computeWp1073dBundleFingerprint(tablesManifest);
  if (
    bundle.row_count !== pgFingerprints.bundle.row_count ||
    bundle.canonical_sha256 !== pgFingerprints.bundle.canonical_sha256
  ) {
    throw new Error(
      `WP10-7-3D archive bundle self-check failed: ` +
        `node=(${bundle.row_count}, ${bundle.canonical_sha256}) vs ` +
        `pg=(${pgFingerprints.bundle.row_count}, ${pgFingerprints.bundle.canonical_sha256})`,
    );
  }

  const restoreSql = buildWp1073dRestoreSql({ catalogSnapshot, csvPaths });
  const restoreSqlFile = "restore.sql";
  const restoreSqlPath = path.join(resolvedDir, restoreSqlFile);
  await writeFile(restoreSqlPath, restoreSql, "utf8");

  const manifest = {
    format_version: WP10_7_3D_ARCHIVE_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    tables: tablesManifest,
    bundle,
    restore_sql_file: restoreSqlFile,
    restore_sql_sha256: sha256Utf8(restoreSql),
    catalog_snapshot: catalogSnapshot,
  };

  const manifestPath = path.join(resolvedDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    archiveDir: resolvedDir,
    manifestPath,
    restoreSqlPath,
    manifest,
    files,
  };
}

function resolveArchiveRelativePath(archiveDir, relFile, label) {
  if (typeof relFile !== "string" || relFile.trim() === "") {
    throw new Error(`WP10-7-3D archive manifest missing ${label}`);
  }
  const resolved = path.resolve(archiveDir, relFile);
  const relCheck = path.relative(archiveDir, resolved);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new Error(
      `WP10-7-3D archive manifest path traversal rejected for ${label}: ${relFile}`,
    );
  }
  return resolved;
}

/**
 * Normalize expected 3-table + bundle manifest fingerprints fail-closed.
 */
export function normalizeWp1073dArchiveExpectation(expected) {
  const source = expected?.manifest ?? expected ?? {};
  const rawTables = source.expectedTables ?? source.tables;
  if (!rawTables || typeof rawTables !== "object") {
    throw new Error("WP10-7-3D archive expectation missing tables map");
  }
  const tables = {};
  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const entry = rawTables[tableName];
    const rowCount = entry?.row_count ?? entry?.rowCount;
    const sha = entry?.canonical_sha256 ?? entry?.canonicalSha256;
    if (!Number.isInteger(rowCount) || rowCount < 0) {
      throw new Error(
        `Invalid WP10-7-3D expected row_count for ${tableName}: ${String(rowCount)}`,
      );
    }
    if (typeof sha !== "string" || !SHA256_HEX_RE.test(sha)) {
      throw new Error(
        `Invalid WP10-7-3D expected canonical_sha256 for ${tableName}: ${String(sha)}`,
      );
    }
    tables[tableName] = {
      row_count: rowCount,
      canonical_sha256: sha.toLowerCase(),
    };
  }
  const computedBundle = computeWp1073dBundleFingerprint(tables);
  const rawBundle = source.expectedBundle ?? source.bundle;
  if (rawBundle) {
    const bCount = rawBundle.row_count ?? rawBundle.rowCount;
    const bSha = String(
      rawBundle.canonical_sha256 ?? rawBundle.canonicalSha256 ?? "",
    ).toLowerCase();
    if (bCount !== computedBundle.row_count || bSha !== computedBundle.canonical_sha256) {
      throw new Error(
        `WP10-7-3D archive manifest bundle mismatch: ` +
          `declared=(${String(bCount)}, ${bSha}) vs computed=(${computedBundle.row_count}, ${computedBundle.canonical_sha256})`,
      );
    }
  }
  return { tables, bundle: computedBundle };
}

/**
 * Load a WP10-7-3D archive `manifest.json` from disk and verify ALL 3 CSV files,
 * optional JSON files, file SHA-256 digests, and the combined bundle fingerprint.
 */
export async function loadAndVerifyWp1073dArchiveManifest(manifestPath) {
  if (typeof manifestPath !== "string" || manifestPath.trim() === "") {
    throw new Error("WP10-7-3D archive manifest path must be a non-empty string");
  }
  const resolvedManifestPath = path.resolve(manifestPath);
  const archiveDir = path.dirname(resolvedManifestPath);
  const rawManifestText = await readFile(resolvedManifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(rawManifestText);
  } catch (error) {
    throw new Error(
      `WP10-7-3D archive manifest is not valid JSON (${resolvedManifestPath}): ${error.message}`,
    );
  }
  if (manifest?.format_version !== WP10_7_3D_ARCHIVE_FORMAT_VERSION) {
    throw new Error(
      `WP10-7-3D archive manifest unsupported format_version: ${String(manifest?.format_version)}`,
    );
  }

  const normalized = normalizeWp1073dArchiveExpectation(manifest);
  const parsedTables = {};

  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const entry = manifest.tables[tableName];
    const csvPath = resolveArchiveRelativePath(
      archiveDir,
      entry.csv_file,
      `tables.${tableName}.csv_file`,
    );
    const csvText = await readFile(csvPath, "utf8");
    if (entry.csv_sha256 !== undefined) {
      const actualCsvSha = sha256Utf8(csvText);
      if (actualCsvSha !== String(entry.csv_sha256).toLowerCase()) {
        throw new Error(
          `WP10-7-3D archive CSV file digest mismatch for ${tableName}: expected ${entry.csv_sha256}, actual ${actualCsvSha}`,
        );
      }
    }
    const parsedCsv = parseWp1073dTableArchiveCsv(tableName, csvText);
    const expected = normalized.tables[tableName];
    if (
      parsedCsv.rowCount !== expected.row_count ||
      parsedCsv.canonicalSha256 !== expected.canonical_sha256
    ) {
      throw new Error(
        `WP10-7-3D archive CSV content mismatch for ${tableName}: ` +
          `csv=(${parsedCsv.rowCount}, ${parsedCsv.canonicalSha256}) vs ` +
          `manifest=(${expected.row_count}, ${expected.canonical_sha256})`,
      );
    }

    if (entry.json_file) {
      const jsonPath = resolveArchiveRelativePath(
        archiveDir,
        entry.json_file,
        `tables.${tableName}.json_file`,
      );
      const jsonText = await readFile(jsonPath, "utf8");
      if (entry.json_sha256 !== undefined) {
        const actualJsonSha = sha256Utf8(jsonText);
        if (actualJsonSha !== String(entry.json_sha256).toLowerCase()) {
          throw new Error(
            `WP10-7-3D archive JSON file digest mismatch for ${tableName}: expected ${entry.json_sha256}, actual ${actualJsonSha}`,
          );
        }
      }
      const parsedJsonPayload = JSON.parse(jsonText);
      const parsedJson = normalizeAndCanonicalizeRows(
        tableName,
        parsedJsonPayload?.rows,
      );
      if (
        parsedJson.rowCount !== expected.row_count ||
        parsedJson.canonicalSha256 !== expected.canonical_sha256
      ) {
        throw new Error(
          `WP10-7-3D archive JSON content mismatch for ${tableName}: ` +
            `json=(${parsedJson.rowCount}, ${parsedJson.canonicalSha256}) vs ` +
            `manifest=(${expected.row_count}, ${expected.canonical_sha256})`,
        );
      }
    }

    parsedTables[tableName] = parsedCsv;
  }

  return {
    manifestPath: resolvedManifestPath,
    archiveDir,
    manifest,
    expectedTables: normalized.tables,
    expectedBundle: normalized.bundle,
    parsedTables,
  };
}

/**
 * Inside an active migration transaction, lock ALL 3 target tables in ACCESS EXCLUSIVE
 * mode and assert live `(row_count, canonical_sha256)` parity for every table and the
 * combined bundle against the verified archive manifest BEFORE any DDL runs.
 */
export async function verifyWp1073dArchiveInTransaction(client, expectedArchive) {
  const normalized = normalizeWp1073dArchiveExpectation(expectedArchive);
  await client.query(WP10_7_3D_LOCK_ORDER_SQL);
  const live = await computeWp1073dLiveFingerprintsInTx(client);

  const mismatches = [];
  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const exp = normalized.tables[tableName];
    const act = live.tables[tableName];
    if (
      !act ||
      act.row_count !== exp.row_count ||
      act.canonical_sha256 !== exp.canonical_sha256
    ) {
      mismatches.push(
        `${tableName}: expected=(row_count=${exp.row_count}, canonical_sha256=${exp.canonical_sha256}) ` +
          `live=(row_count=${String(act?.row_count)}, canonical_sha256=${act?.canonical_sha256 || "<empty>"})`,
      );
    }
  }
  if (
    !live.bundle ||
    live.bundle.row_count !== normalized.bundle.row_count ||
    live.bundle.canonical_sha256 !== normalized.bundle.canonical_sha256
  ) {
    mismatches.push(
      `${WP10_7_3D_BUNDLE_TABLE_KEY}: expected=(row_count=${normalized.bundle.row_count}, canonical_sha256=${normalized.bundle.canonical_sha256}) ` +
        `live=(row_count=${String(live.bundle?.row_count)}, canonical_sha256=${live.bundle?.canonical_sha256 || "<empty>"})`,
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `WP10-7-3D archive parity check failed in transaction: ${mismatches.join("; ")}`,
    );
  }

  return { verified: true, live };
}

/**
 * Hardened WP10-7 Slice 3D Dependency & Dynamic SQL Precheck:
 *   1. Static pg_proc refs across ALL non-system schemas (0 outside planned 3D drop/trim list)
 *   2. Hardened dynamic EXECUTE check (closes T0 Roadmap L437): flags ANY non-allowlisted
 *      active routine containing dynamic EXECUTE (catching concatenated table-name SQL like
 *      `'direct_entry_' || 'capability_grants'` or `format(...)`), and only allowlists
 *      verified historical helpers (`direct_entry_hf_replace_proc_source`) AFTER verifying
 *      EXECUTE privileges are revoked from PUBLIC, anon, authenticated, and service_role.
 *   3. String-literal-only refs to the 3 target tables outside planned drop/trim routines
 *   4. 0 views / materialized views referencing the 3 tables
 *   5. 0 incoming FKs from any 4th table & 0 unexpected external pg_depend objects
 *   6. 0 active or disabled `authz_managed = false` accounts
 */
export async function runWp1073dPrecheck(
  client,
  {
    throwOnFailure = false,
    allowlistedDynamicExecuteSignatures = WP10_7_3D_ALLOWLISTED_DYNAMIC_EXECUTE_SIGNATURES,
  } = {},
) {
  const excludedSchemas = [...WP10_7_3D_EXCLUDED_SYSTEM_SCHEMAS];
  const plannedDropNames = [...WP10_7_3D_PLANNED_DROP_FUNCTION_NAMES];
  const dynamicAllowlist = [...allowlistedDynamicExecuteSignatures];

  const { rows: procRows } = await client.query(
    `
    WITH app_procs AS (
      SELECT
        p.oid,
        n.nspname AS schema_name,
        p.proname AS proc_name,
        n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS signature,
        pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
        exists (
          select 1
            from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
           where a.grantee = 0
             and a.privilege_type = 'EXECUTE'
        ) AS public_acl_exec,
        pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
        pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
        pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec,
        pg_catalog.regexp_replace(
          coalesce(p.prosrc, ''),
          $rx$('([^']|'')*'|--[^\\r\\n]*|/\\*([^*]|\\*+[^*/])*\\*+/)$rx$,
          ' ',
          'g'
        ) AS norm_no_strings,
        pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(
            coalesce(p.prosrc, ''),
            $rx$(--[^\\r\\n]*|/\\*([^*]|\\*+[^*/])*\\*+/)$rx$,
            ' ',
            'g'
          ),
          '''''',
          '''',
          'g'
        ) AS no_comments_norm_quotes
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname <> 'pg_catalog'
        AND n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND n.nspname <> ALL($1::text[])
        AND p.prokind IN ('f', 'p')
    )
    SELECT
      ap.schema_name,
      ap.proc_name,
      ap.signature,
      ap.public_exec,
      ap.public_acl_exec,
      ap.anon_exec,
      ap.authenticated_exec,
      ap.service_role_exec,
      (ap.norm_no_strings ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants|direct_entry_authz__internal_sync_legacy_grants|work_report_sync_team_leader_capabilities|direct_entry_has_capability|direct_entry_has_scope|direct_entry__internal_capability_grant_effective|direct_entry__internal_team_scope_grant_effective|direct_entry_assert_actor|direct_entry__internal_reconcile_cancelled_team_leaders|direct_entry_transition_legacy_team_leaders|direct_entry_seed_team_scope_grants)\\M') AS has_static_ref,
      (ap.norm_no_strings ~* '\\mexecute\\M') AS has_dynamic_execute,
      (
        ap.no_comments_norm_quotes ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\\M'
        AND NOT (ap.norm_no_strings ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\\M')
      ) AS has_string_literal_table_ref,
      (ap.schema_name = 'public' AND ap.proc_name = ANY($2::text[])) AS is_planned_3d_drop_fn,
      (ap.schema_name = 'public' AND ap.proc_name IN ('direct_entry_guard_effective_interval', 'direct_entry_set_current_on_insert')) AS is_shared_trigger_fn_to_trim,
      (ap.signature = ANY($3::text[])) AS is_allowlisted_dynamic_execute
    FROM app_procs ap
    WHERE (ap.norm_no_strings ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants|direct_entry_authz__internal_sync_legacy_grants|work_report_sync_team_leader_capabilities|direct_entry_has_capability|direct_entry_has_scope|direct_entry__internal_capability_grant_effective|direct_entry__internal_team_scope_grant_effective|direct_entry_assert_actor|direct_entry__internal_reconcile_cancelled_team_leaders|direct_entry_transition_legacy_team_leaders|direct_entry_seed_team_scope_grants)\\M')
       OR (ap.norm_no_strings ~* '\\mexecute\\M')
       OR (ap.no_comments_norm_quotes ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\\M')
    ORDER BY ap.signature ASC
    `,
    [excludedSchemas, plannedDropNames, dynamicAllowlist],
  );

  const blockingStaticProcs = [];
  const blockingDynamicExecuteProcs = [];
  const allowlistedDynamicExecuteProcs = [];
  const stringLiteralOnlyProcs = [];

  for (const row of procRows) {
    const privilegesRevoked =
      !row.public_exec &&
      !row.public_acl_exec &&
      !row.anon_exec &&
      !row.authenticated_exec &&
      !row.service_role_exec;

    if (row.has_dynamic_execute) {
      if (row.is_allowlisted_dynamic_execute && privilegesRevoked) {
        allowlistedDynamicExecuteProcs.push({
          signature: row.signature,
          privileges_revoked: true,
        });
      } else {
        blockingDynamicExecuteProcs.push({
          signature: row.signature,
          reason: row.is_allowlisted_dynamic_execute
            ? "allowlisted dynamic EXECUTE helper has non-revoked EXECUTE privileges"
            : "non-allowlisted active routine contains dynamic EXECUTE",
          public_exec: Boolean(row.public_exec || row.public_acl_exec),
          anon_exec: Boolean(row.anon_exec),
          authenticated_exec: Boolean(row.authenticated_exec),
          service_role_exec: Boolean(row.service_role_exec),
        });
      }
    }

    if (
      row.has_static_ref &&
      !row.is_planned_3d_drop_fn &&
      !(
        row.schema_name === "public" &&
        row.proc_name === "direct_entry_guard_effective_interval"
      )
    ) {
      blockingStaticProcs.push({
        signature: row.signature,
        service_role_exec: Boolean(row.service_role_exec),
      });
    }

    if (
      row.has_string_literal_table_ref &&
      !row.is_planned_3d_drop_fn &&
      !row.is_shared_trigger_fn_to_trim
    ) {
      stringLiteralOnlyProcs.push({
        signature: row.signature,
        service_role_exec: Boolean(row.service_role_exec),
      });
    }
  }

  const { rows: blockingViews } = await client.query(`
    SELECT 'VIEW'::text AS object_kind, v.schemaname, v.viewname AS object_name
      FROM pg_catalog.pg_views v
     WHERE v.schemaname NOT IN ('pg_catalog', 'information_schema')
       AND v.definition ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\\M'
    UNION ALL
    SELECT 'MATVIEW'::text AS object_kind, mv.schemaname, mv.matviewname AS object_name
      FROM pg_catalog.pg_matviews mv
     WHERE mv.schemaname NOT IN ('pg_catalog', 'information_schema')
       AND mv.definition ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\\M'
    ORDER BY object_kind, schemaname, object_name
  `);

  const { rows: incomingExternalFks } = await client.query(`
    SELECT cn.nspname || '.' || c.relname AS source_table,
           con.conname AS constraint_name,
           fn.nspname || '.' || fc.relname AS referenced_table,
           pg_catalog.pg_get_constraintdef(con.oid) AS constraint_def
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
      JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
      JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
     WHERE con.contype = 'f'
       AND fn.nspname = 'public'
       AND fc.relname IN (
         'direct_entry_capability_grants',
         'direct_entry_scope_grants',
         'work_report_team_leader_capability_grants'
       )
       AND NOT (
         cn.nspname = 'public'
         AND c.relname IN (
           'direct_entry_capability_grants',
           'direct_entry_scope_grants',
           'work_report_team_leader_capability_grants'
         )
       )
     ORDER BY source_table, constraint_name
  `);

  const { rows: unexpectedPgDepend } = await client.query(`
    SELECT refc.relname AS target_table,
           d.deptype::text AS deptype,
           d.classid::pg_catalog.regclass::text AS dependent_class,
           pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) AS dependent_object
      FROM pg_catalog.pg_depend d
      JOIN pg_catalog.pg_class refc ON refc.oid = d.refobjid
      JOIN pg_catalog.pg_namespace refn ON refn.oid = refc.relnamespace
     WHERE refn.nspname = 'public'
       AND refc.relname IN (
         'direct_entry_capability_grants',
         'direct_entry_scope_grants',
         'work_report_team_leader_capability_grants'
       )
       AND d.deptype IN ('n', 'a', 'i')
       AND d.classid NOT IN (
         'pg_catalog.pg_type'::pg_catalog.regclass,
         'pg_catalog.pg_class'::pg_catalog.regclass,
         'pg_catalog.pg_trigger'::pg_catalog.regclass,
         'pg_catalog.pg_attrdef'::pg_catalog.regclass
       )
       AND NOT (
         d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
         AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_constraint con
             JOIN pg_catalog.pg_class cc ON cc.oid = con.conrelid
             JOIN pg_catalog.pg_namespace cn ON cn.oid = cc.relnamespace
            WHERE con.oid = d.objid
              AND cn.nspname = 'public'
              AND cc.relname IN (
                'direct_entry_capability_grants',
                'direct_entry_scope_grants',
                'work_report_team_leader_capability_grants'
              )
         )
       )
       AND NOT (
         d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass
         AND pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
             = 'policy direct_entry_catalog_bootstrap_capability_read on table direct_entry_capability_grants'
       )
     ORDER BY refc.relname, dependent_class, dependent_object
  `);

  const { rows: unmanagedRows } = await client.query(`
    SELECT app_user_id::text AS app_user_id,
           display_name,
           enabled
      FROM public.direct_entry_app_users
     WHERE NOT coalesce(authz_managed, false)
     ORDER BY enabled DESC, app_user_id ASC
  `);
  const activeUnmanaged = unmanagedRows.filter((r) => r.enabled).length;
  const disabledUnmanaged = unmanagedRows.length - activeUnmanaged;

  const reasons = [];
  if (blockingStaticProcs.length > 0) {
    reasons.push(
      `blocking_static_procs=${blockingStaticProcs.length} (${blockingStaticProcs.map((p) => p.signature).join(", ")})`,
    );
  }
  if (blockingDynamicExecuteProcs.length > 0) {
    reasons.push(
      `blocking_dynamic_execute_procs=${blockingDynamicExecuteProcs.length} (${blockingDynamicExecuteProcs.map((p) => `${p.signature} [${p.reason}]`).join(", ")})`,
    );
  }
  if (stringLiteralOnlyProcs.length > 0) {
    reasons.push(
      `unexpected_string_literal_procs=${stringLiteralOnlyProcs.length} (${stringLiteralOnlyProcs.map((p) => p.signature).join(", ")})`,
    );
  }
  if (blockingViews.length > 0) {
    reasons.push(
      `blocking_views=${blockingViews.length} (${blockingViews.map((v) => `${v.schemaname}.${v.object_name}`).join(", ")})`,
    );
  }
  if (incomingExternalFks.length > 0) {
    reasons.push(
      `incoming_external_fks=${incomingExternalFks.length} (${incomingExternalFks.map((f) => `${f.source_table}.${f.constraint_name}`).join(", ")})`,
    );
  }
  if (unexpectedPgDepend.length > 0) {
    reasons.push(
      `unexpected_pg_depend=${unexpectedPgDepend.length} (${unexpectedPgDepend.map((d) => d.dependent_object).join(", ")})`,
    );
  }
  if (unmanagedRows.length > 0) {
    reasons.push(
      `unmanaged_accounts=${unmanagedRows.length} (active=${activeUnmanaged}, disabled=${disabledUnmanaged})`,
    );
  }

  const ready = reasons.length === 0;
  const report = {
    ready,
    blockingStaticProcs,
    blockingDynamicExecuteProcs,
    allowlistedDynamicExecuteProcs,
    stringLiteralOnlyProcs,
    blockingViews,
    incomingExternalFks,
    unexpectedPgDepend,
    unmanagedAccounts: {
      total: unmanagedRows.length,
      active: activeUnmanaged,
      disabled: disabledUnmanaged,
      rows: unmanagedRows,
    },
    summary: {
      blocking_static_procs: blockingStaticProcs.length,
      blocking_dynamic_execute_procs: blockingDynamicExecuteProcs.length,
      allowlisted_dynamic_execute_procs: allowlistedDynamicExecuteProcs.length,
      unexpected_string_literal_procs: stringLiteralOnlyProcs.length,
      blocking_views_or_matviews: blockingViews.length,
      incoming_external_fks: incomingExternalFks.length,
      unexpected_pg_depend_objects: unexpectedPgDepend.length,
      unmanaged_accounts: unmanagedRows.length,
      active_unmanaged_accounts: activeUnmanaged,
      disabled_unmanaged_accounts: disabledUnmanaged,
      ready_for_slice_3d: ready,
    },
    reasons,
  };

  if (throwOnFailure && !ready) {
    throw new Error(`WP10-7-3D precheck failed: ${reasons.join("; ")}`);
  }

  return report;
}

async function insertArchivedRows(client, tableName, rows) {
  if (rows.length === 0) return;

  if (tableName === "direct_entry_capability_grants") {
    for (const r of rows) {
      await client.query(
        `INSERT INTO public.direct_entry_capability_grants
           (grant_id, app_user_id, capability, valid_from, valid_to, created_at, is_current, suspended_by_account_disable)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::date, $5::date, $6::timestamptz, $7::boolean, $8::boolean)`,
        [
          r.grant_id,
          r.app_user_id,
          r.capability,
          r.valid_from,
          r.valid_to,
          r.created_at_utc,
          r.is_current,
          r.suspended_by_account_disable,
        ],
      );
    }
  } else if (tableName === "direct_entry_scope_grants") {
    for (const r of rows) {
      await client.query(
        `INSERT INTO public.direct_entry_scope_grants
           (grant_id, app_user_id, scope_kind, team_id, valid_from, valid_to, created_at, is_current, suspended_by_account_disable)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::uuid, $5::date, $6::date, $7::timestamptz, $8::boolean, $9::boolean)`,
        [
          r.grant_id,
          r.app_user_id,
          r.scope_kind,
          r.team_id,
          r.valid_from,
          r.valid_to,
          r.created_at_utc,
          r.is_current,
          r.suspended_by_account_disable,
        ],
      );
    }
  } else if (tableName === "work_report_team_leader_capability_grants") {
    for (const r of rows) {
      await client.query(
        `INSERT INTO public.work_report_team_leader_capability_grants
           (leader_assignment_id, capability, capability_grant_id)
         VALUES ($1::uuid, $2::text, $3::uuid)`,
        [r.leader_assignment_id, r.capability, r.capability_grant_id],
      );
    }
  }
}

/**
 * Restore the 3 dropped tables, all archived rows, all 5 FKs, partial unique indexes,
 * trimmed/dropped functions (in LANGUAGE sql dependency order), all 7+1 triggers,
 * owner, table/role ACLs, and RLS + policies from a verified WP10-7-3D archive.
 */
export async function restoreWp1073dLegacyGrantsArchive(
  client,
  archiveSource,
  { inExistingTransaction = false, verifyParity = true } = {},
) {
  const loaded =
    typeof archiveSource === "string"
      ? await loadAndVerifyWp1073dArchiveManifest(archiveSource)
      : archiveSource;

  const catalogSnapshot = loaded?.manifest?.catalog_snapshot;
  if (!catalogSnapshot?.tables) {
    throw new Error(
      "WP10-7-3D restore requires a verified archive manifest containing catalog_snapshot",
    );
  }
  const parsedTables = loaded?.parsedTables;
  if (!parsedTables) {
    throw new Error(
      "WP10-7-3D restore requires parsedTables (load via loadAndVerifyWp1073dArchiveManifest)",
    );
  }

  if (!inExistingTransaction) {
    await client.query("BEGIN");
  }
  try {
    // (i) Recreate tables + PK/CHECK constraints + owners
    for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
      for (const stmt of buildCreateTableDdl(
        tableName,
        catalogSnapshot.tables[tableName],
      )) {
        await client.query(stmt);
      }
    }

    // (ii) Load all archived rows BEFORE attaching triggers (Trap #1 & Trap #2)
    for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
      await insertArchivedRows(client, tableName, parsedTables[tableName].rows);
    }

    // (iii)-(v) FKs, indexes, functions (Trap #3), triggers, RLS, ACLs, policies
    for (const stmt of buildPostDataSchemaStatements(catalogSnapshot)) {
      await client.query(stmt);
    }

    if (!inExistingTransaction) {
      await client.query("COMMIT");
    }
  } catch (error) {
    if (!inExistingTransaction) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  }

  const parity = verifyParity
    ? await verifyWp1073dRestoreParity(client, loaded, { throwOnMismatch: true })
    : null;

  return { restored: true, parity };
}

function stableJson(value) {
  return JSON.stringify(value);
}

/**
 * Verify exact 8-dimension parity between a restored DB and the pre-drop archive manifest:
 *   1. rowCounts (3 tables + bundle)
 *   2. canonicalSha256 (3 tables + bundle)
 *   3. structureAndIndexes (columns/types/defaults/NOT NULL, PK/CHECK/UNIQUE, indexes)
 *   4. foreignKeys (all 5 FKs)
 *   5. triggers (7 direct + 1 external bridge trigger)
 *   6. owner (3/3 tables)
 *   7. tableAcl (sorted relacl on 3/3 tables incl. bootstrap executor)
 *   8. rlsAndPolicies (RLS + FORCE RLS + policies on 3/3 tables)
 */
export async function verifyWp1073dRestoreParity(
  client,
  expectedArchive,
  { throwOnMismatch = true } = {},
) {
  const loaded =
    typeof expectedArchive === "string"
      ? await loadAndVerifyWp1073dArchiveManifest(expectedArchive)
      : expectedArchive;

  const normalized = normalizeWp1073dArchiveExpectation(loaded);
  const expectedSnap = loaded?.manifest?.catalog_snapshot;
  if (!expectedSnap?.tables) {
    throw new Error(
      "WP10-7-3D restore parity check requires manifest.catalog_snapshot",
    );
  }

  const liveFingerprints = await computeWp1073dLiveFingerprintsInTx(client);
  const liveCatalogSnapshot = await captureWp1073dCatalogSnapshot(client);

  const mismatches = [];
  const dimensions = {
    rowCounts: true,
    canonicalSha256: true,
    structureAndIndexes: true,
    foreignKeys: true,
    triggers: true,
    owner: true,
    tableAcl: true,
    rlsAndPolicies: true,
  };

  for (const tableName of WP10_7_3D_CANONICAL_TABLE_ORDER) {
    const expFp = normalized.tables[tableName];
    const actFp = liveFingerprints.tables[tableName];
    if (actFp?.row_count !== expFp.row_count) {
      dimensions.rowCounts = false;
      mismatches.push(
        `[rowCounts] ${tableName}: expected=${expFp.row_count}, live=${String(actFp?.row_count)}`,
      );
    }
    if (actFp?.canonical_sha256 !== expFp.canonical_sha256) {
      dimensions.canonicalSha256 = false;
      mismatches.push(
        `[canonicalSha256] ${tableName}: expected=${expFp.canonical_sha256}, live=${String(actFp?.canonical_sha256)}`,
      );
    }

    const expTbl = expectedSnap.tables[tableName];
    const actTbl = liveCatalogSnapshot.tables[tableName];

    const expNonFkCons = expTbl.cons.filter((c) => c.contype !== "f");
    const actNonFkCons = actTbl.cons.filter((c) => c.contype !== "f");
    if (
      stableJson(actTbl.cols) !== stableJson(expTbl.cols) ||
      stableJson(actNonFkCons) !== stableJson(expNonFkCons) ||
      stableJson(actTbl.idxs) !== stableJson(expTbl.idxs)
    ) {
      dimensions.structureAndIndexes = false;
      mismatches.push(`[structureAndIndexes] ${tableName} DDL/constraints/indexes drift`);
    }

    const expFks = expTbl.cons.filter((c) => c.contype === "f");
    const actFks = actTbl.cons.filter((c) => c.contype === "f");
    if (stableJson(actFks) !== stableJson(expFks)) {
      dimensions.foreignKeys = false;
      mismatches.push(`[foreignKeys] ${tableName} FK mismatch`);
    }

    if (stableJson(actTbl.trgs) !== stableJson(expTbl.trgs)) {
      dimensions.triggers = false;
      mismatches.push(`[triggers] ${tableName} direct triggers mismatch`);
    }

    if (actTbl.owner !== expTbl.owner) {
      dimensions.owner = false;
      mismatches.push(
        `[owner] ${tableName}: expected=${expTbl.owner}, live=${actTbl.owner}`,
      );
    }

    if (stableJson(actTbl.relacl) !== stableJson(expTbl.relacl)) {
      dimensions.tableAcl = false;
      mismatches.push(
        `[tableAcl] ${tableName}: expected=${stableJson(expTbl.relacl)}, live=${stableJson(actTbl.relacl)}`,
      );
    }

    if (
      actTbl.relrowsecurity !== expTbl.relrowsecurity ||
      actTbl.relforcerowsecurity !== expTbl.relforcerowsecurity ||
      stableJson(actTbl.pols) !== stableJson(expTbl.pols)
    ) {
      dimensions.rlsAndPolicies = false;
      mismatches.push(`[rlsAndPolicies] ${tableName} RLS/policy mismatch`);
    }
  }

  if (liveFingerprints.bundle?.row_count !== normalized.bundle.row_count) {
    dimensions.rowCounts = false;
    mismatches.push(
      `[rowCounts] ${WP10_7_3D_BUNDLE_TABLE_KEY}: expected=${normalized.bundle.row_count}, live=${String(liveFingerprints.bundle?.row_count)}`,
    );
  }
  if (
    liveFingerprints.bundle?.canonical_sha256 !==
    normalized.bundle.canonical_sha256
  ) {
    dimensions.canonicalSha256 = false;
    mismatches.push(
      `[canonicalSha256] ${WP10_7_3D_BUNDLE_TABLE_KEY}: expected=${normalized.bundle.canonical_sha256}, live=${String(liveFingerprints.bundle?.canonical_sha256)}`,
    );
  }

  if (
    stableJson(liveCatalogSnapshot.external_bridge_triggers) !==
    stableJson(expectedSnap.external_bridge_triggers)
  ) {
    dimensions.triggers = false;
    mismatches.push("[triggers] external bridge trigger mismatch");
  }

  const ok = mismatches.length === 0;
  if (throwOnMismatch && !ok) {
    throw new Error(
      `WP10-7-3D 8-dimension restore parity verification failed: ${mismatches.join("; ")}`,
    );
  }

  return {
    ok,
    dimensions,
    mismatches,
    liveFingerprints,
    liveCatalogSnapshot,
  };
}
