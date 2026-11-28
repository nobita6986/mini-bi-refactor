import {
  validateClientBusinessPayload,
} from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import {
  isCanonicalLaborTypeKey,
  validateEmployeeCode,
  validateWorkerDetails,
  type WorkerDetails,
} from "../contracts/direct-entry-v1.ts";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntryRepository, DraftCatalog } from "./write-repository.ts";
import { projectPaymentProjection } from "./payment-contract.ts";

const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC_MICROS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROW_KEYS = new Set([
  "project_id", "first_work_date", "employee_code", "worker", "recruiter_id", "labor_type", "collaborator_id",
]);
const BATCH_WORKER_KEYS = new Set([
  "display_name", "date_of_birth", "national_id", "address", "phone",
]);

type WriteDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DirectEntryRepository;
};

type ProjectedBatchRow = Record<string, unknown> & {
  project_id: string;
  first_work_date: string;
  recruiter_id: string;
};

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function error(code: string, status: number): Response {
  return json({ ok: false, code }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkerDetails(value: unknown): value is WorkerDetails {
  if (!isRecord(value) || Object.keys(value).some((key) => !BATCH_WORKER_KEYS.has(key)) ||
      typeof value.display_name !== "string") return false;
  return ["date_of_birth", "national_id", "address", "phone"].every((key) => {
    const field = value[key];
    if (!isRecord(field)) return false;
    if (field.state === "omitted" || field.state === "unknown" ||
        field.state === "intentionally_blank") return Object.keys(field).length === 1;
    return field.state === "provided" && typeof field.value === "string" &&
      Object.keys(field).length === 2;
  });
}

export async function readBoundedJson(request: Request): Promise<unknown | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function projectRows(value: unknown): ProjectedBatchRow[] | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "rows") ||
      !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 100) return null;

  const codes: string[] = [];
  const rows: ProjectedBatchRow[] = [];
  for (const item of value.rows) {
    if (!isRecord(item) || Object.keys(item).some((key) => !ROW_KEYS.has(key))) return null;
    const {
      project_id,
      first_work_date,
      employee_code,
      worker,
      recruiter_id,
      labor_type,
    } = item;
    if (typeof project_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(project_id) ||
        typeof first_work_date !== "string" || !isRealCalendarDate(first_work_date) ||
        typeof employee_code !== "string" ||
        typeof recruiter_id !== "string" || !UUID.test(recruiter_id) ||
        !isCanonicalLaborTypeKey(labor_type) ||
        !isWorkerDetails(worker) ||
        validateWorkerDetails(worker).length > 0 ||
        validateEmployeeCode(employee_code, first_work_date, codes).length > 0) return null;
    let collaboratorId: string | null | undefined;
    if (Object.hasOwn(item, "collaborator_id")) {
      if (item.collaborator_id === null) {
        collaboratorId = null;
      } else if (typeof item.collaborator_id === "string" &&
                 CATALOG_ID.test(item.collaborator_id.trim())) {
        collaboratorId = item.collaborator_id.trim();
      } else {
        return null;
      }
    }
    codes.push(employee_code);
    const row: ProjectedBatchRow = {
      project_id,
      first_work_date,
      employee_code,
      worker_details: worker,
      recruiter_id,
      labor_type,
    };
    if (collaboratorId !== undefined) row.collaborator_id = collaboratorId;
    rows.push(row);
  }
  return rows;
}

function parseBatchResult(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || Object.keys(value).some((key) =>
    !["submission_id", "state", "version", "entry_ids"].includes(key)
  ) || !UUID.test(String(value.submission_id)) || value.state !== "DRAFT" ||
      typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1 ||
      !Array.isArray(value.entry_ids) ||
      value.entry_ids.length < 1 || value.entry_ids.length > 100 ||
      !value.entry_ids.every((id) => typeof id === "string" && UUID.test(id)) ||
      new Set(value.entry_ids).size !== value.entry_ids.length) return null;
  return {
    submission_id: value.submission_id,
    submission_version: value.version,
    entry_ids: value.entry_ids,
    status: value.state,
  };
}

export async function postDirectEntryBatch(
  request: Request,
  flag: string | undefined,
  dependencies: WriteDependencies,
): Promise<Response> {
  if (flag !== "true") return error("NOT_FOUND", 404);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return error("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return error("CONTENT_TYPE_INVALID", 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.length < 1 || idempotencyKey.length > 128 ||
      idempotencyKey.trim().length === 0) return error("IDEMPOTENCY_KEY_INVALID", 400);

  const body = await readBoundedJson(request);
  if (body === null) return error("BODY_INVALID", 400);
  let rows: ProjectedBatchRow[] | null;
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return error("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
    rows = projectRows(body);
  } catch {
    return error("BATCH_INVALID", 400);
  }
  if (!rows) return error("BATCH_INVALID", 400);

  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? error("UNAUTHENTICATED", 401)
        : error("ACTOR_NOT_AVAILABLE", 403);
    }
    const actor = session.actor.actor;
    const catalogs = new Map<string, DraftCatalog>();
    for (const row of rows) {
      const date = row.first_work_date;
      let catalog = catalogs.get(date);
      if (!catalog) {
        const result = await dependencies.repository.loadInputCatalog({
          auth_subject: actor.auth_subject,
          app_user_id: actor.app_user_id,
          effective_date: date,
        });
        if (!result.ok) {
          if (result.kind === "denied") return error("ACTOR_DENIED", 403);
          console.error("[direct-entry] batch master catalog unavailable");
          return error("BATCH_UNAVAILABLE", 500);
        }
        catalog = result.data;
        catalogs.set(date, catalog);
      }
      const recruiter = catalog.recruiters.find(({ recruiter_id }) => recruiter_id === row.recruiter_id);
      if (!catalog.projects.some(({ project_id }) => project_id === row.project_id) || !recruiter) {
        return error("BATCH_MASTER_INVALID", 400);
      }
      if (typeof row.collaborator_id === "string") {
        if (recruiter.provider_type !== "hrp" ||
            !(catalog.collaborators ?? []).some((item) => item.collaborator_id === row.collaborator_id && item.active)) {
          return error("BATCH_MASTER_INVALID", 400);
        }
      }
    }
    const result = await dependencies.repository.createBatch({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      rows,
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) {
      if (result.kind === "conflict") return error("IDEMPOTENCY_CONFLICT", 409);
      if (result.kind === "denied") return error("ACTOR_DENIED", 403);
      if (result.kind === "invalid") return error("BATCH_INVALID", 400);
      console.error("[direct-entry] batch RPC unavailable");
      return error("BATCH_UNAVAILABLE", 500);
    }
    const projection = parseBatchResult(result.data);
    if (!projection) {
      console.error("[direct-entry] batch RPC returned malformed projection");
      return error("BATCH_UNAVAILABLE", 500);
    }
    return json({ ok: true, ...projection }, 201);
  } catch {
    console.error("[direct-entry] batch request failed");
    return error("BATCH_UNAVAILABLE", 500);
  }
}

const ENTRY_UUID = UUID;
const ENTRY_KEYS = new Set([
  "entry_id", "submission_id", "created_at", "created_by", "project_id", "first_work_date", "employee_code",
  "worker_details", "recruiter_id", "team_id", "provider_type", "collaborator_id", "collaborator_display_name",
  "labor_type", "labor_type_display", "general_note", "version", "scope_kind", "payment", "employment_status",
  "documents", "worker_portrait",
]);
const WORKER_PROJECTION_KEYS = new Set([
  "display_name", "gender", "date_of_birth", "national_id", "national_id_issued_at",
  "national_id_issued_place", "address", "phone",
]);
const STATUS_KEYS = new Set(["status", "effective_date", "version"]);
const DOCUMENT_KEYS = new Set([
  "document_id", "document_type", "version", "size_bytes", "mime_type",
  "upload_status", "scan_status", "validation_status", "created_at", "updated_at",
]);
const PORTRAIT_STATUSES = [
  "MISSING", "QUEUED", "UPLOADING", "QUARANTINED", "SCANNING", "READY", "FAILED", "SUPERSEDED",
] as const;
const PORTRAIT_CURRENT_KEYS = [
  "document_id", "version", "checksum_sha256", "mime_type", "size_bytes",
] as const;

function isWorkerPortraitProjection(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["origin", "added_at", "status", "current"]) ||
      !(value.origin === null || value.origin === "ENROLLMENT" || value.origin === "LEGACY_ADDED") ||
      !(value.added_at === null || (typeof value.added_at === "string" &&
        Number.isFinite(Date.parse(value.added_at)))) ||
      !(PORTRAIT_STATUSES as readonly unknown[]).includes(value.status) ||
      !(value.current === null || isRecord(value.current))) return false;
  if ((value.origin === "LEGACY_ADDED") !== (value.added_at !== null)) return false;
  if (value.current === null) return true;
  const current = value.current as Record<string, unknown>;
  return hasExactKeys(current, [...PORTRAIT_CURRENT_KEYS]) &&
    typeof current.document_id === "string" && UUID.test(current.document_id) &&
    typeof current.version === "number" && Number.isSafeInteger(current.version) &&
    current.version > 0 &&
    typeof current.checksum_sha256 === "string" && /^[a-f0-9]{64}$/.test(current.checksum_sha256) &&
    (current.mime_type === "image/jpeg" || current.mime_type === "image/png") &&
    typeof current.size_bytes === "number" && Number.isSafeInteger(current.size_bytes) &&
    current.size_bytes > 0 && value.origin !== null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

/** RPC read_projection returns the canonical worker profile after server authorization. */
function isWorkerReadProjection(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !WORKER_PROJECTION_KEYS.has(key))) {
    return false;
  }
  if (typeof value.display_name === "string" && value.display_name === "") {
    return validateWorkerDetails({
      ...(value as WorkerDetails),
      display_name: "Placeholder",
    }).length === 0;
  }
  return validateWorkerDetails(value as WorkerDetails).length === 0;
}

function isGeneralNoteReadProjection(value: unknown): boolean {
  if (value === null || typeof value === "string") return true;
  return isRecord(value) && hasExactKeys(value, ["present"]) && value.present === true;
}

function isCreatorReadProjection(value: unknown): boolean {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    Object.keys(value).every((key) => key === "display_name" || key === "login_id") &&
    (value.display_name === null || (typeof value.display_name === "string" &&
      value.display_name.length > 0 && value.display_name.length <= 256)) &&
    (value.login_id === null || (typeof value.login_id === "string" &&
      value.login_id.length > 0 && value.login_id.length <= 256)) &&
    (value.display_name !== null || value.login_id !== null);
}

/** Current R4 RPC may return bank_name text in addition to the older catalog bank_id shape. */
function isPaymentReadProjection(value: unknown): boolean {
  return value === null || projectPaymentProjection(value) !== null;
}

export function projectEntry(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !ENTRY_KEYS.has(key)) ||
      !ENTRY_UUID.test(String(value.entry_id)) || !ENTRY_UUID.test(String(value.submission_id)) ||
      typeof value.created_at !== "string" || !ISO_UTC_MICROS.test(value.created_at) ||
      !isCreatorReadProjection(value.created_by) ||
      typeof value.project_id !== "string" || typeof value.first_work_date !== "string" ||
      !isRealCalendarDate(value.first_work_date) ||
      typeof value.employee_code !== "string" ||
      validateEmployeeCode(value.employee_code, value.first_work_date).length > 0 ||
      !isWorkerReadProjection(value.worker_details) ||
      typeof value.recruiter_id !== "string" || !ENTRY_UUID.test(value.recruiter_id) ||
      typeof value.team_id !== "string" || !ENTRY_UUID.test(value.team_id) ||
      (value.provider_type !== "hrp" && value.provider_type !== "vendor") ||
      (Object.hasOwn(value, "collaborator_id") && value.collaborator_id !== null &&
        (typeof value.collaborator_id !== "string" || !CATALOG_ID.test(value.collaborator_id))) ||
      (Object.hasOwn(value, "collaborator_display_name") && value.collaborator_display_name !== null &&
        (typeof value.collaborator_display_name !== "string" || value.collaborator_display_name.trim().length === 0)) ||
      !isCanonicalLaborTypeKey(value.labor_type) ||
      // P3.1-W02C-R2: nhan do server resolve tu catalog theo key (ke ca key da inactive).
      // Thieu/rong => unavailable, khong de UI tu map key sang nhan.
      typeof value.labor_type_display !== "string" || value.labor_type_display.length < 1 ||
      typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1 ||
      (value.scope_kind !== "own" && value.scope_kind !== "team" &&
        value.scope_kind !== "all" && value.scope_kind !== "project" &&
        value.scope_kind !== "recruited" && value.scope_kind !== "team_review") ||
      !isGeneralNoteReadProjection(value.general_note) ||
      !isPaymentReadProjection(value.payment) ||
      !isRecord(value.employment_status) ||
      !Array.isArray(value.documents) ||
      !(value.worker_portrait === null || isWorkerPortraitProjection(value.worker_portrait))) return null;
  const status = value.employment_status as Record<string, unknown>;
  if (Object.keys(status).some((key) => !STATUS_KEYS.has(key)) ||
      !["UNCONFIRMED", "ON", "OFF"].includes(String(status.status)) ||
      typeof status.effective_date !== "string" || !isRealCalendarDate(status.effective_date) ||
      typeof status.version !== "number" || !Number.isSafeInteger(status.version) ||
      status.version < 1) return null;
  if (value.documents.some((document) => !isRecord(document) ||
      Object.keys(document).some((key) => !DOCUMENT_KEYS.has(key)) ||
      typeof document.document_id !== "string" || !UUID.test(document.document_id) ||
      typeof document.document_type !== "string" ||
      !Number.isSafeInteger(document.version) ||
      typeof document.size_bytes !== "number" || !Number.isSafeInteger(document.size_bytes) ||
      typeof document.mime_type !== "string" ||
      typeof document.upload_status !== "string" ||
      typeof document.scan_status !== "string" ||
      typeof document.validation_status !== "string")) return null;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, child]));
}

type ReadDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DirectEntryRepository;
};

export async function getDirectEntryEntry(
  entryId: string,
  flag: string | undefined,
  dependencies: ReadDependencies,
): Promise<Response> {
  if (flag !== "true") return error("NOT_FOUND", 404);
  if (!ENTRY_UUID.test(entryId)) return error("ENTRY_ID_INVALID", 400);
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? error("UNAUTHENTICATED", 401)
        : error("ACTOR_NOT_AVAILABLE", 403);
    }
    const actor = session.actor.actor;
    const result = await dependencies.repository.readEntry({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
    });
    if (!result.ok) {
      if (result.kind === "not-found" || result.kind === "denied") return error("ENTRY_NOT_FOUND", 404);
      console.error("[direct-entry] read projection unavailable");
      return error("ENTRY_UNAVAILABLE", 500);
    }
    const projection = projectEntry(result.data);
    if (!projection) {
      console.error("[direct-entry] read RPC returned malformed projection");
      return error("ENTRY_UNAVAILABLE", 500);
    }
    return json({ ok: true, entry: projection }, 200);
  } catch {
    console.error("[direct-entry] read request failed");
    return error("ENTRY_UNAVAILABLE", 500);
  }
}
