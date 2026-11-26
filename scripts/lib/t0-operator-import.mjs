/**
 * P2.5-HF-R5B-R2 - T0 operator worker importer (manifest .xlsx/.csv -> canonical RPC).
 *
 * Tai su dung: canonical CMT/CCCD (src/lib/contracts/national-id.ts), contract
 * worker-profile/1.1, idempotency/episode guards #57-#61, config/TLS loader, audit/reason/
 * idempotency tables. Khong migration, khong import engine thu hai, khong direct DML tren
 * canonical worker data (chi audit/reason cua chinh batch, dung trong cung transaction).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { isCanonicalLaborTypeKey } from "../../src/lib/contracts/direct-entry-v1.ts";
import { isCanonicalNationalId } from "../../src/lib/contracts/national-id.ts";

export const IMPORT_CONFIRM_PREFIX = "T0_WORKER_IMPORT_APPLY:";
export const IMPORT_CONTRACT_VERSION = "worker-profile/1.1";
export const IMPORT_MAX_ROWS_PER_CHUNK = 100;
export const IMPORT_MAX_ROWS = 500;
export const IMPORT_ACTION = "t0_worker_import";
export const IMPORT_REQUIRED_MIGRATIONS = Object.freeze([
  "20261008170000_p2_5_initial_employment_status_on.sql",
  "20261008180000_p2_5_hf_worker_create_and_rehire.sql",
  "20261008190000_p2_5_hf_r1_episode_status_and_lookup_boundary.sql",
  "20261008200000_p2_5_hf_r2_cccd_canonicalization_guard.sql",
  "20261008210000_p2_5_hf_r3_worker_full_correction.sql",
]);
export const IMPORT_TARGET_STATES = Object.freeze(["DRAFT", "SUBMITTED"]);
export const IMPORT_REQUIRED_COLUMNS = Object.freeze([
  "source_row_id", "uploader_login", "project_id", "first_work_date", "display_name",
  "national_id", "provider_type", "recruiter_code", "labor_type", "target_state",
]);
export const IMPORT_OPTIONAL_COLUMNS = Object.freeze([
  "gender", "date_of_birth_text", "national_id_issued_at_text", "national_id_issued_place",
  "address", "phone", "account_number", "bank_name", "account_holder_name", "general_note",
]);
export const IMPORT_COLUMNS = Object.freeze([
  ...IMPORT_REQUIRED_COLUMNS, ...IMPORT_OPTIONAL_COLUMNS,
]);
/** Cac truong luon la text: khong bao gio parse thanh so (giu so 0 dau). */
export const IMPORT_TEXT_COLUMNS = Object.freeze([
  "source_row_id", "national_id", "phone", "account_number", "bank_name", "account_holder_name",
]);
export const IMPORT_WORKER_DETAIL_KEYS = Object.freeze([
  "gender", "date_of_birth", "national_id", "national_id_issued_at",
  "national_id_issued_place", "address", "phone",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const EMPLOYEE_CODE = /^hrp-[0-9]{4}-[0-9]{6}$/;
// P3.1-W02C-R1: labor type la catalog dong. Preflight chi kiem tra HINH DANG canonical key
// (predicate dung chung voi server); ton tai/active do DB active-catalog guard quyet dinh
// khi apply, nen mot loai moi trong catalog khong bi chan o day.
const PROVIDER_TYPES = Object.freeze(["hrp", "vendor"]);
const PAYMENT_STATES = Object.freeze(["omitted", "unknown", "intentionally_blank", "provided"]);
const SAFE_DB_MESSAGES = Object.freeze([
  "BANK_NOT_ACTIVE", "BATCH_INVALID", "EMPLOYEE_CODE_DUPLICATE", "EMPLOYEE_CODE_YEAR",
  "EMPLOYEE_CODE_SEQUENCE_EXHAUSTED", "EMPLOYEE_CODE_LEGACY_QUARANTINE", "GENERAL_NOTE_TOO_LONG",
  "NATIONAL_ID_DUPLICATE", "NATIONAL_ID_INVALID", "OFF_REQUIRES_DATE_AND_REASON",
  "PAYMENT_DETAILS_INVALID", "PROFILE_DATE_INVALID", "PROJECT_NOT_ACTIVE", "RECRUITER_NOT_ACTIVE",
  "RECRUITER_MEMBERSHIP_INVALID",
]);

export class ImportValidationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ImportValidationError";
    this.code = code;
    this.details = details;
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : value === undefined || value === null
    ? "" : String(value).trim();
}

function issue(code, sourceRowId = null, severity = "error") {
  return { code, source_row_id: sourceRowId, severity };
}

/** UUID on dinh tu cac thanh phan: khong dung lai mot key cho nhieu RPC. */
export function deterministicUuid(...parts) {
  const digest = createHash("sha256").update(parts.map((part) => String(part)).join("|"))
    .digest("hex");
  const hex = digest.slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  return [hex.slice(0, 8).join(""), hex.slice(8, 12).join(""), hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""), hex.slice(20, 32).join("")].join("-");
}

export function fingerprintOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function confirmationToken(fingerprint) {
  return IMPORT_CONFIRM_PREFIX + String(fingerprint).toUpperCase();
}

function optionalTextValue(value) {
  const trimmed = text(value);
  return trimmed === "" ? { state: "omitted" } : { state: "provided", value: trimmed };
}

export function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

export function parseCsv(textContent) {
  const lines = textContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
    .filter((line) => line.trim() !== "");
  if (lines.length < 2) throw new ImportValidationError("MANIFEST_EMPTY");
  const header = parseCsvLine(lines[0]).map((cell) => text(cell).toLowerCase());
  const records = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const record = {};
    for (const [index, column] of header.entries()) {
      record[column] = text(cells[index]);
    }
    records.push(record);
  }
  return { header, records };
}

async function parseWorkbook(buffer) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (workbook.worksheets.length !== 1) throw new ImportValidationError("MANIFEST_INVALID");
  const worksheet = workbook.worksheets[0];
  const header = [];
  const records = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        header[columnNumber - 1] = text(cell.text).toLowerCase();
      });
      return;
    }
    const record = {};
    for (const [index, column] of header.entries()) {
      const cell = row.getCell(index + 1);
      // Truong text: dung cell.text de khong mat so 0 dau.
      const raw = cell === undefined || cell.value === null ? "" : cell.text;
      record[column] = text(raw);
    }
    if (Object.values(record).some((value) => value !== "")) records.push(record);
  });
  return { header, records };
}

/** Doc manifest .csv hoac .xlsx; fingerprint = SHA-256 cua chinh file nguon. */
export async function readImportSource(inputPath) {
  const buffer = await readFile(inputPath);
  const extension = path.extname(inputPath).toLowerCase();
  let parsed;
  if (extension === ".csv") {
    parsed = parseCsv(buffer.toString("utf8"));
  } else if (extension === ".xlsx") {
    parsed = await parseWorkbook(buffer);
  } else {
    throw new ImportValidationError("MANIFEST_FORMAT_UNSUPPORTED");
  }
  return { header: parsed.header, records: parsed.records, fingerprint: fingerprintOf(buffer) };
}

export function validateReason(reason) {
  const problems = [];
  const value = text(reason);
  if (value.length < 8 || value.length > 400) problems.push("REASON_LENGTH_INVALID");
  if (/[\u0000-\u001f\u007f]/.test(value)) problems.push("REASON_CONTROL_CHARACTER");
  if (/\S+@\S+\.\S+/.test(value)) problems.push("REASON_CONTAINS_EMAIL");
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) {
    problems.push("REASON_CONTAINS_UUID");
  }
  if (/(?:^|\D)(?:[0-9]{9}|[0-9]{12})(?:\D|$)/.test(value)) {
    problems.push("REASON_CONTAINS_NATIONAL_ID_LIKE");
  }
  return { ok: problems.length === 0, problems, reason: value };
}

export function validateOperatorOptions(options) {
  const problems = [];
  if (options.mode !== "check" && options.mode !== "apply") problems.push("MODE_INVALID");
  if (text(options.input) === "") problems.push("INPUT_REQUIRED");
  if (!UUID.test(text(options.batchId))) problems.push("BATCH_ID_INVALID");
  if (text(options.operator) === "" || text(options.operator).length > 320) {
    problems.push("OPERATOR_REQUIRED");
  }
  const reason = validateReason(options.reason);
  if (!reason.ok) problems.push(...reason.problems);
  if (options.mode === "check" && options.confirm !== null && options.confirm !== undefined) {
    problems.push("CONFIRM_NOT_ALLOWED_FOR_CHECK");
  }
  return {
    ok: problems.length === 0,
    problems,
    operator: reason.ok ? text(options.operator) : text(options.operator),
    reason: reason.reason,
  };
}

/** Validate header + tung dong manifest (offline, truoc khi mo connection). */
export function validateManifest(records) {
  const errors = [];
  const rows = [];
  if (records.length === 0) errors.push(issue("MANIFEST_EMPTY"));
  if (records.length > IMPORT_MAX_ROWS) errors.push(issue("MANIFEST_TOO_LARGE"));
  const seenSource = new Set();
  const seenNationalId = new Set();
  for (const [index, raw] of records.entries()) {
    const rowNumber = index + 1;
    const sourceRowId = text(raw.source_row_id) || String(rowNumber);
    for (const column of Object.keys(raw)) {
      if (!IMPORT_COLUMNS.includes(column)) {
        errors.push(issue("ROW_COLUMN_UNSUPPORTED", sourceRowId));
        break;
      }
    }
    for (const column of IMPORT_REQUIRED_COLUMNS) {
      if (text(raw[column]) === "") errors.push(issue("ROW_REQUIRED_VALUE_MISSING", sourceRowId));
    }
    if (seenSource.has(sourceRowId)) errors.push(issue("ROW_SOURCE_ID_DUPLICATE", sourceRowId));
    seenSource.add(sourceRowId);
    const targetState = text(raw.target_state).toUpperCase();
    if (!IMPORT_TARGET_STATES.includes(targetState)) {
      errors.push(issue("ROW_TARGET_STATE_INVALID", sourceRowId));
    }
    const laborType = text(raw.labor_type).toUpperCase();
    if (!isCanonicalLaborTypeKey(laborType)) errors.push(issue("ROW_LABOR_TYPE_INVALID", sourceRowId));
    const providerType = text(raw.provider_type).toLowerCase();
    if (!PROVIDER_TYPES.includes(providerType)) {
      errors.push(issue("ROW_PROVIDER_INVALID", sourceRowId));
    }
    const firstWorkDate = text(raw.first_work_date);
    if (!ISO_DATE.test(firstWorkDate)) {
      errors.push(issue("ROW_FIRST_WORK_DATE_INVALID", sourceRowId));
    }
    const displayName = text(raw.display_name);
    if (displayName === "" || displayName.length > 256) {
      errors.push(issue("ROW_DISPLAY_NAME_INVALID", sourceRowId));
    }
    // CCCD la text canonical: ky tu dinh dang bi tu choi, khong tu chuan hoa.
    const nationalId = text(raw.national_id);
    if (!isCanonicalNationalId(nationalId)) {
      errors.push(issue("ROW_NATIONAL_ID_INVALID", sourceRowId));
    } else if (seenNationalId.has(nationalId)) {
      errors.push(issue("ROW_NATIONAL_ID_DUPLICATE", sourceRowId));
    }
    if (nationalId !== "") seenNationalId.add(nationalId);
    const gender = text(raw.gender).toUpperCase();
    if (gender !== "" && !["MALE", "FEMALE", "OTHER"].includes(gender)) {
      errors.push(issue("ROW_GENDER_INVALID", sourceRowId));
    }
    // worker_details: CHI cac key canonical; display_name nam o top-level contract row.
    const workerDetails = {
      date_of_birth: optionalTextValue(raw.date_of_birth_text),
      national_id: { state: "provided", value: nationalId },
      address: optionalTextValue(raw.address),
      phone: optionalTextValue(raw.phone),
    };
    if (gender !== "") workerDetails.gender = { state: "provided", value: gender };
    if (text(raw.national_id_issued_at_text) !== "") {
      workerDetails.national_id_issued_at = optionalTextValue(raw.national_id_issued_at_text);
    }
    if (text(raw.national_id_issued_place) !== "") {
      workerDetails.national_id_issued_place = optionalTextValue(raw.national_id_issued_place);
    }
    let payment = null;
    const hasPayment = ["account_number", "bank_name", "account_holder_name"]
      .some((column) => text(raw[column]) !== "");
    if (hasPayment) {
      const accountNumber = text(raw.account_number);
      const bankName = text(raw.bank_name);
      const holder = text(raw.account_holder_name);
      if (accountNumber === "" || bankName === "" || holder === "") {
        errors.push(issue("ROW_PAYMENT_INVALID", sourceRowId));
      } else {
        payment = { state: "provided", account_number: accountNumber, bank_id: bankName,
          account_holder_name: holder };
      }
    }
    rows.push({
      sourceRowId,
      uploaderLogin: text(raw.uploader_login),
      projectRef: text(raw.project_id),
      recruiterRef: text(raw.recruiter_code),
      provider_type: providerType,
      first_work_date: firstWorkDate,
      labor_type: laborType,
      display_name: displayName,
      national_id: nationalId,
      target_state: targetState,
      worker_details: workerDetails,
      payment,
      general_note: text(raw.general_note) === "" ? null : text(raw.general_note),
    });
  }
  return { rows, errors };
}

/** Contract row worker-profile/1.1: display_name top-level, worker_details canonical. */
export function toContractRow(row) {
  const contract = {
    project_id: row.project_id,
    first_work_date: row.first_work_date,
    provider_type: row.provider_type,
    recruiter_id: row.recruiter_id,
    labor_type: row.labor_type,
    display_name: row.display_name,
    worker_details: row.worker_details,
  };
  if (row.payment !== null) contract.payment = row.payment;
  if (row.general_note !== null) contract.general_note = { state: "provided", value: row.general_note };
  return contract;
}

/** Group deterministic theo uploader + target_state, chunk theo gioi han RPC. */
export function buildImportPlan(rows, batchId) {
  const groups = new Map();
  const ordered = [...rows].sort((left, right) =>
    left.uploaderLogin.localeCompare(right.uploaderLogin) ||
    left.target_state.localeCompare(right.target_state) ||
    left.sourceRowId.localeCompare(right.sourceRowId));
  for (const row of ordered) {
    const groupKey = row.uploaderLogin + "|" + row.target_state + "|" + row.uploader.app_user_id;
    const group = groups.get(groupKey) ?? {
      uploaderLogin: row.uploaderLogin, uploader: row.uploader, targetState: row.target_state,
      chunks: [],
    };
    const current = group.chunks[group.chunks.length - 1];
    if (current === undefined || current.rows.length >= IMPORT_MAX_ROWS_PER_CHUNK) {
      group.chunks.push({ rows: [] });
    }
    group.chunks[group.chunks.length - 1].rows.push(row);
    groups.set(groupKey, group);
  }
  const plan = [];
  for (const group of groups.values()) {
    for (const [chunkIndex, chunk] of group.chunks.entries()) {
      plan.push({
        uploaderLogin: group.uploaderLogin,
        uploader: group.uploader,
        targetState: group.targetState,
        chunkIndex,
        rows: chunk.rows,
        payload: chunk.rows.map(toContractRow),
        idempotencyKey: deterministicUuid("t0-import-create", batchId, group.uploader.app_user_id,
          group.targetState, String(chunkIndex)),
      });
    }
  }
  return plan;
}

export function sanitizedIssues(items) {
  return items.map((item) => ({
    code: item.code, source_row_id: item.source_row_id ?? null,
    severity: item.severity ?? "error",
  }));
}

export function classifyDatabaseError(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  const message = typeof error?.message === "string" ? error.message : "";
  if (code === "42P01") return { code: "MIGRATION_LEDGER_UNAVAILABLE", sqlstate: code };
  if (code === "42501") return { code: "AUTHORITY_DENIED", sqlstate: code };
  if (code === "40001") return { code: "VERSION_CONFLICT", sqlstate: code };
  if (code === "23505") {
    if (message.includes("worker_active_episode_exists")) {
      return { code: "ACTIVE_EPISODE_EXISTS", sqlstate: code };
    }
    if (message.includes("worker_episode_reopen_forbidden")) {
      return { code: "EPISODE_REOPEN_FORBIDDEN", sqlstate: code };
    }
    return { code: "ROW_CONFLICT", sqlstate: code };
  }
  if (code === "22023" && message.includes("idempotency key reused with different input")) {
    return { code: "IDEMPOTENCY_CONFLICT", sqlstate: code };
  }
  if (message !== "" && SAFE_DB_MESSAGES.includes(message)) {
    return { code: message, sqlstate: code };
  }
  if (code === "22023" || code === "23514" || code === "22008") {
    return { code: "ROW_INVALID", sqlstate: code };
  }
  return { code: "IMPORT_FAILED", sqlstate: code };
}

export async function checkMigrationLedger(client) {
  const applied = await client.query("select version from public.schema_migrations");
  const appliedVersions = new Set(applied.rows.map((row) => String(row.version)));
  const pending = IMPORT_REQUIRED_MIGRATIONS.filter((version) => !appliedVersions.has(version));
  return { applied: appliedVersions.size, required: IMPORT_REQUIRED_MIGRATIONS.length,
    required_pending: pending.length, pending_names: pending };
}

const ACCOUNT_SQL = "select u.app_user_id::text as app_user_id, u.auth_subject::text as auth_subject" +
  " from public.direct_entry_app_users u join auth.users a on a.id = u.auth_subject" +
  " where u.enabled and (lower(coalesce(a.email, '')) = lower($1)" +
  " or u.app_user_id::text = $1 or u.auth_subject::text = $1)";

const GRANTS_SQL = "with effective as (" +
  "  select g.capability, g.scope_kind, g.scope_id" +
  "    from pg_catalog.jsonb_to_recordset(" +
  "      public.direct_entry_authz__internal_resolve_effective_grants($1::uuid)" +
  "    ) as g(capability text, scope_kind text, scope_id text)" +
  ")" +
  " select" +
  " coalesce((select array_agg(distinct e.capability) from effective e" +
  "   where e.capability is not null), '{}') as capabilities," +
  " coalesce((select array_agg(distinct lower(e.scope_kind)) from effective e" +
  "   where e.scope_kind is not null), '{}') as scopes," +
  " exists (select 1 from effective e" +
  "   where e.capability = 'entry_admin'" +
  "     and upper(coalesce(e.scope_kind, '')) = 'ALL'" +
  "     and nullif(btrim(coalesce(e.scope_id, '')), '') is null) as has_entry_admin_all";

function publicAccount(record) {
  return {
    app_user_id: record.app_user_id,
    auth_subject: record.auth_subject,
    capabilities: record.capabilities,
    scopes: record.scopes,
  };
}

async function resolveAccount(client, login) {
  const result = await client.query(ACCOUNT_SQL, [login]);
  if (result.rows.length !== 1) return null;
  const grants = await client.query(GRANTS_SQL, [result.rows[0].app_user_id]);
  const row = grants.rows[0] ?? {};
  return {
    app_user_id: result.rows[0].app_user_id,
    auth_subject: result.rows[0].auth_subject,
    capabilities: row.capabilities ?? [],
    scopes: row.scopes ?? [],
    hasEntryAdminAll: row.has_entry_admin_all === true,
  };
}

/** Technical operator: mapping hop le + entry_admin + hieu luc all scope. */
export async function resolveOperator(client, operatorLogin) {
  const account = await resolveAccount(client, operatorLogin);
  if (account === null) return { ok: false, code: "OPERATOR_NOT_FOUND" };
  if (!account.hasEntryAdminAll) {
    return { ok: false, code: "OPERATOR_NOT_AUTHORIZED" };
  }
  return { ok: true, operator: publicAccount(account) };
}

export async function resolveUploaders(client, rows) {
  const uploaders = new Map();
  const errors = [];
  for (const login of [...new Set(rows.map((row) => row.uploaderLogin))]) {
    const account = await resolveAccount(client, login);
    if (account === null) {
      for (const row of rows.filter((item) => item.uploaderLogin === login)) {
        errors.push(issue("UPLOADER_NOT_FOUND", row.sourceRowId));
      }
      continue;
    }
    uploaders.set(login, publicAccount(account));
  }
  return { uploaders, errors };
}

const PROJECT_SQL = "select project_id from public.direct_entry_projects" +
  " where active and (project_id = $1 or display_name = $1)";
const RECRUITER_SQL = "select recruiter_id::text as recruiter_id from public.recruiters" +
  " where active and (display_name = $1 or recruiter_id::text = $1)";

/** Resolve project/recruiter bang projection hien co; identity trong manifest khong duoc tin. */
export async function resolveRows(client, rows, uploaders) {
  const errors = [];
  const resolved = [];
  for (const row of rows) {
    const uploader = uploaders.get(row.uploaderLogin);
    if (uploader === undefined) continue;
    const project = await client.query(PROJECT_SQL, [row.projectRef]);
    if (project.rows.length !== 1) {
      errors.push(issue("PROJECT_NOT_RESOLVED", row.sourceRowId));
      continue;
    }
    const recruiter = await client.query(RECRUITER_SQL, [row.recruiterRef]);
    if (recruiter.rows.length !== 1) {
      errors.push(issue("RECRUITER_NOT_RESOLVED", row.sourceRowId));
      continue;
    }
    resolved.push({ ...row, project_id: project.rows[0].project_id,
      recruiter_id: recruiter.rows[0].recruiter_id, uploader });
  }
  return { rows: resolved, errors };
}

/** Authority preflight bang canonical helper (#58) cho tung row, theo actor cua uploader. */
export async function preflightAuthority(client, rows) {
  const errors = [];
  for (const row of rows) {
    const access = await client.query(
      "select public.direct_entry_actor_can_access_project($1::uuid,$2::text) as ok",
      [row.uploader.app_user_id, row.project_id]);
    if (access.rows[0]?.ok !== true) {
      // Guard 1 cua wrapper canonical: project access.
      errors.push(issue("UPLOADER_PROJECT_ACCESS_DENIED", row.sourceRowId));
      continue;
    }
    try {
      // Guard 2: create authority (manager assignment hoac legacy bundle).
      await client.query(
        "select public.direct_entry_create_authority($1::uuid,$2::uuid,$3::text,$4::date) as kind",
        [row.uploader.auth_subject, row.uploader.app_user_id, row.project_id, row.first_work_date]);
    } catch {
      errors.push(issue("UPLOADER_CREATE_AUTHORITY_DENIED", row.sourceRowId));
    }
  }
  return { errors };
}

/** Advisory lock theo batch + dung mot restricted reason va mot operator batch audit. */
export async function openBatchAudit(client, context) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))",
    ["t0-import:" + context.batchId]);
  const existing = await client.query(
    "select a.reason_id::text as reason_id, r.reason_text" +
    " from public.direct_entry_audit_events a" +
    " left join public.direct_entry_restricted_reasons r on r.reason_id = a.reason_id" +
    " where a.action = $1 and a.resource_ref = $2", [IMPORT_ACTION, context.batchId]);
  if (existing.rows.length > 0) {
    const reasonText = String(existing.rows[0].reason_text ?? "");
    if (!reasonText.includes("fp " + context.fingerprint)) {
      // Cung batch id nhung nguon khac: dung truoc khi mutation bat ky.
      throw new ImportValidationError("BATCH_ID_REUSED_WITH_DIFFERENT_SOURCE");
    }
    return { auditCount: existing.rows.length, reasonId: existing.rows[0].reason_id,
      replayed: true };
  }
  const reasonText = context.reason + " [batch " + context.batchId + " fp " + context.fingerprint + "]";
  const reason = await client.query(
    "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
    " values ($1::uuid,$2) returning reason_id::text as reason_id",
    [context.operator.app_user_id, reasonText]);
  const reasonId = reason.rows[0].reason_id;
  await client.query(
    "insert into public.direct_entry_audit_events (auth_subject, app_user_id, action, capability," +
    " resource_ref, scope_kind, outcome, reason_id, changed_fields)" +
    " values ($1::uuid,$2::uuid,$3,$4,$5,'all','APPLIED',$6::uuid,$7::text[])",
    [context.operator.auth_subject, context.operator.app_user_id, IMPORT_ACTION,
      "entry_admin", context.batchId, reasonId, "{batch_id,fingerprint}"]);
  return { auditCount: 1, reasonId, replayed: false };
}

export async function executeImportPlan(client, plan, context) {
  const submissions = [];
  const entryIds = [];
  const employeeCodes = [];
  for (const chunk of plan) {
    const created = await client.query(
      "select public.direct_entry_create_full_profile_batch_v2(" +
      "$1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text) as data",
      [chunk.uploader.auth_subject, chunk.uploader.app_user_id, IMPORT_CONTRACT_VERSION,
        JSON.stringify(chunk.payload), chunk.idempotencyKey]);
    // Projection canonical cua create: khong join them de lay version/submission.
    const data = created.rows[0]?.data ?? null;
    const ids = Array.isArray(data?.entry_ids) ? data.entry_ids : null;
    const codes = Array.isArray(data?.employee_codes) ? data.employee_codes : null;
    const submissionId = typeof data?.submission_id === "string" ? data.submission_id : null;
    const version = typeof data?.version === "number" ? data.version : null;
    const replayed = typeof data?.replayed === "boolean" ? data.replayed : false;
    if (ids === null || codes === null || submissionId === null || !UUID.test(submissionId) ||
        version === null || !Number.isInteger(version) || version < 1 ||
        ids.length !== chunk.rows.length || codes.length !== ids.length ||
        !ids.every((value) => typeof value === "string" && UUID.test(value)) ||
        !codes.every((value) => typeof value === "string" && EMPLOYEE_CODE.test(value))) {
      throw new ImportValidationError("RPC_RESULT_INVALID");
    }
    for (const [index, entryId] of ids.entries()) {
      entryIds.push(entryId);
      employeeCodes.push(codes[index]);
    }
    // Mot create chunk = dung MOT submission record.
    submissions.push({ chunk, submissionId, version, targetState: chunk.targetState,
      replayed, entryIds: ids });
  }
  let transitions = 0;
  for (const item of submissions) {
    if (item.targetState !== "SUBMITTED") continue;
    const submitted = await client.query(
      "select public.direct_entry_transition_submission(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) as data",
      [item.chunk.uploader.auth_subject, item.chunk.uploader.app_user_id, item.submissionId,
        item.version, "SUBMITTED",
        deterministicUuid("t0-import-transition", context.batchId, item.submissionId, "SUBMITTED")]);
    const submittedVersion = submitted.rows[0]?.data?.version;
    if (typeof submittedVersion !== "number" || !Number.isInteger(submittedVersion) ||
        submittedVersion !== item.version + 1) {
      throw new ImportValidationError("RPC_RESULT_INVALID");
    }
    transitions += 1;
  }
  return { entryIds, employeeCodes, submissions, transitionCount: transitions,
    chunkCount: plan.length, plan };
}

const POSTCHECK_SQL = "select e.entry_id::text as entry_id, e.employee_code, e.project_id," +
  " e.deleted_at, e.first_work_date::text as first_work_date," +
  " e.recruiter_id::text as recruiter_id, e.labor_type, e.provider_type," +
  " e.created_by_user_id::text as created_by_user_id, (e.team_id is not null) as has_team," +
  " (select st.status from public.direct_entry_employment_status_events st" +
  "   where st.entry_id = e.entry_id order by st.version desc limit 1) as latest_status," +
  " (select count(*)::int from public.direct_entry_employment_status_events st" +
  "   where st.entry_id = e.entry_id) as status_events," +
  " (select count(*)::int from public.direct_entry_audit_events a" +
  "   where a.resource_ref = e.entry_id::text) as audits" +
  " from public.direct_entries e where e.entry_id = $1::uuid";

/** Postcheck truoc commit: metadata/status/audit + operator audit dung mot lan. */
export async function postcheckImport(client, execution, rows, context) {
  const problems = [];
  let statusOn = 0;
  let metadata = 0;
  let audit = 0;
  const owner = new Map();
  for (const item of execution.submissions) {
    for (const entryId of item.entryIds) owner.set(entryId, item);
  }
  for (const [index, entryId] of execution.entryIds.entries()) {
    const row = rows[index];
    const item = owner.get(entryId);
    const found = await client.query(POSTCHECK_SQL, [entryId]);
    const entry = found.rows[0];
    if (entry === undefined || entry.deleted_at !== null) {
      problems.push(issue("POSTCHECK_ROW_MISSING", row.sourceRowId));
      continue;
    }
    if (entry.employee_code !== execution.employeeCodes[index]) {
      problems.push(issue("POSTCHECK_EMPLOYEE_CODE_MISMATCH", row.sourceRowId));
    }
    if (entry.created_by_user_id !== item.chunk.uploader.app_user_id) {
      problems.push(issue("POSTCHECK_CREATED_BY_NOT_UPLOADER", row.sourceRowId));
    }
    if (entry.latest_status !== "ON") {
      problems.push(issue("POSTCHECK_STATUS_NOT_ON", row.sourceRowId));
    } else if (Number(entry.status_events) !== 1) {
      problems.push(issue("POSTCHECK_STATUS_EVENTS_UNEXPECTED", row.sourceRowId));
    } else {
      statusOn += 1;
    }
    const metadataOk = entry.project_id === row.project_id &&
      entry.recruiter_id === row.recruiter_id && entry.first_work_date === row.first_work_date &&
      entry.labor_type === row.labor_type && entry.has_team === true &&
      typeof entry.provider_type === "string" && entry.provider_type !== "";
    if (!metadataOk) problems.push(issue("POSTCHECK_METADATA_MISSING", row.sourceRowId));
    else metadata += 1;
    if (Number(entry.audits) < 1) problems.push(issue("POSTCHECK_AUDIT_MISSING", row.sourceRowId));
    else audit += 1;
  }
  const batchAudit = await client.query(
    "select a.reason_id::text as reason_id, r.actor_user_id::text as actor_user_id" +
    " from public.direct_entry_audit_events a" +
    " left join public.direct_entry_restricted_reasons r on r.reason_id = a.reason_id" +
    " where a.action = $1 and a.resource_ref = $2", [IMPORT_ACTION, context.batchId]);
  let operatorAudit = 0;
  if (batchAudit.rows.length !== 1) {
    problems.push(issue("POSTCHECK_OPERATOR_AUDIT_COUNT"));
  } else if (batchAudit.rows[0].actor_user_id !== context.operator.app_user_id ||
      batchAudit.rows[0].reason_id === null) {
    problems.push(issue("POSTCHECK_OPERATOR_AUDIT_REFERENCE"));
  } else {
    operatorAudit = 1;
  }
  return { ok: problems.length === 0, problems, status_on: statusOn, metadata, audit,
    operator_audit: operatorAudit };
}
