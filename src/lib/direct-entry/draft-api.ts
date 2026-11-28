import {
  validateClientBusinessPayload,
} from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import {
  isCanonicalLaborTypeKey,
  validateEmployeeCode,
  validateWorkerDetails,
  type LaborType,
  type WorkerDetails,
} from "../contracts/direct-entry-v1.ts";
import {
  DRAFT_LIST_PROJECTION_VERSION,
  type DirectEntryRepository,
  type DraftCatalog,
} from "./write-repository.ts";
import { readBoundedJson } from "./write-api.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PATCH_KEYS = new Set([
  "project_id", "first_work_date", "employee_code", "worker_details", "recruiter_id", "labor_type",
  "collaborator_id", "general_note", "payment",
]);
const WORKER_PATCH_KEYS = new Set([
  "display_name", "gender", "date_of_birth", "national_id", "national_id_issued_at",
  "national_id_issued_place", "address", "phone",
]);

type Dependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DirectEntryRepository;
};

type DraftPatch = Partial<{
  project_id: string;
  first_work_date: string;
  employee_code: string;
  worker_details: Partial<WorkerDetails>;
  recruiter_id: string;
  labor_type: LaborType;
  collaborator_id: string | null;
  general_note: string | null;
  payment: {
    state: "provided" | "unknown" | "intentionally_blank" | "omitted";
    account_number: string | null;
    bank_name: string | null;
    account_holder_name: string | null;
  };
}>;

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectOptionalText(value: unknown): WorkerDetails["date_of_birth"] | null {
  if (!isRecord(value)) return null;
  if ((value.state === "omitted" || value.state === "unknown" ||
       value.state === "intentionally_blank") && Object.keys(value).length === 1) {
    return { state: value.state };
  }
  if (value.state === "provided" && typeof value.value === "string" &&
      Object.keys(value).length === 2) {
    return { state: "provided", value: value.value };
  }
  return null;
}

function projectWorkerPatch(value: unknown): Partial<WorkerDetails> | null {
  if (!isRecord(value) || Object.keys(value).length === 0 ||
      Object.keys(value).some((key) => !WORKER_PATCH_KEYS.has(key))) return null;

  const patch: Partial<WorkerDetails> = {};
  if (Object.hasOwn(value, "display_name")) {
    if (typeof value.display_name !== "string") return null;
    patch.display_name = value.display_name;
  }
  if (Object.hasOwn(value, "gender")) {
    const gender = value.gender;
    if (!isRecord(gender)) return null;
    if ((gender.state === "omitted" || gender.state === "unknown" ||
         gender.state === "intentionally_blank") && Object.keys(gender).length === 1) {
      patch.gender = { state: gender.state };
    } else if (gender.state === "provided" && Object.keys(gender).length === 2) {
      if (gender.value === "MALE") patch.gender = { state: "provided", value: "MALE" };
      else if (gender.value === "FEMALE") patch.gender = { state: "provided", value: "FEMALE" };
      else if (gender.value === "OTHER") patch.gender = { state: "provided", value: "OTHER" };
      else return null;
    } else return null;
  }
  for (const key of ["date_of_birth", "national_id", "national_id_issued_at",
    "national_id_issued_place", "address", "phone"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const field = projectOptionalText(value[key]);
    if (!field) return null;
    switch (key) {
      case "date_of_birth": patch.date_of_birth = field; break;
      case "national_id": patch.national_id = field; break;
      case "national_id_issued_at": patch.national_id_issued_at = field; break;
      case "national_id_issued_place": patch.national_id_issued_place = field; break;
      case "address": patch.address = field; break;
      case "phone": patch.phone = field; break;
    }
  }
  const candidate: WorkerDetails = {
    display_name: patch.display_name ?? "Synthetic",
    gender: patch.gender,
    date_of_birth: patch.date_of_birth ?? { state: "omitted" },
    national_id: patch.national_id ?? { state: "omitted" },
    national_id_issued_at: patch.national_id_issued_at,
    national_id_issued_place: patch.national_id_issued_place,
    address: patch.address ?? { state: "omitted" },
    phone: patch.phone ?? { state: "omitted" },
  };
  return validateWorkerDetails(candidate).length === 0 ? patch : null;
}

function projectPaymentPatch(value: unknown): DraftPatch["payment"] | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !==
      "account_holder_name,account_number,bank_name,state" ||
      (value.state !== "provided" && value.state !== "unknown" &&
       value.state !== "intentionally_blank" && value.state !== "omitted")) return null;
  const texts = [value.account_number, value.bank_name, value.account_holder_name];
  if (texts.some((text) => text !== null &&
      (typeof text !== "string" || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)))) {
    return null;
  }
  if (value.account_number !== null && typeof value.account_number === "string" &&
      value.account_number.length > 64) return null;
  const hasValue = texts.some((text) => typeof text === "string" && text.trim() !== "");
  if (value.state === "provided" ? !hasValue : texts.some((text) => text !== null)) return null;
  return {
    state: value.state,
    account_number: value.account_number as string | null,
    bank_name: value.bank_name as string | null,
    account_holder_name: value.account_holder_name as string | null,
  };
}

function projectPatch(value: unknown): {
  expected_version: number;
  patch: DraftPatch;
} | null {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "expected_version") || !Object.hasOwn(value, "patch") ||
      typeof value.expected_version !== "number" ||
      !Number.isSafeInteger(value.expected_version) || value.expected_version < 1 ||
      !isRecord(value.patch) || Object.keys(value.patch).length === 0 ||
      Object.keys(value.patch).some((key) => !PATCH_KEYS.has(key))) return null;
  const patch = value.patch;
  const projectedPatch: DraftPatch = {};
  if (Object.hasOwn(patch, "project_id")) {
    if (typeof patch.project_id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(patch.project_id)) return null;
    projectedPatch.project_id = patch.project_id;
  }
  if (Object.hasOwn(patch, "first_work_date")) {
    if (typeof patch.first_work_date !== "string" || !isRealCalendarDate(patch.first_work_date)) {
      return null;
    }
    projectedPatch.first_work_date = patch.first_work_date;
  }
  if (Object.hasOwn(patch, "employee_code")) {
    if (typeof patch.employee_code !== "string" ||
        validateEmployeeCode(patch.employee_code).length > 0) {
      return null;
    }
    projectedPatch.employee_code = patch.employee_code;
  }
  if (Object.hasOwn(patch, "recruiter_id")) {
    if (typeof patch.recruiter_id !== "string" || !UUID.test(patch.recruiter_id)) return null;
    projectedPatch.recruiter_id = patch.recruiter_id;
  }
  if (Object.hasOwn(patch, "labor_type")) {
    if (!isCanonicalLaborTypeKey(patch.labor_type)) return null;
    projectedPatch.labor_type = patch.labor_type;
  }
  if (Object.hasOwn(patch, "collaborator_id")) {
    if (patch.collaborator_id === null) {
      projectedPatch.collaborator_id = null;
    } else if (typeof patch.collaborator_id === "string" &&
               CATALOG_ID.test(patch.collaborator_id.trim())) {
      projectedPatch.collaborator_id = patch.collaborator_id.trim();
    } else {
      return null;
    }
  }
  if (Object.hasOwn(patch, "worker_details")) {
    const workerDetails = projectWorkerPatch(patch.worker_details);
    if (!workerDetails) return null;
    projectedPatch.worker_details = workerDetails;
  }
  if (Object.hasOwn(patch, "general_note")) {
    if (patch.general_note !== null &&
        (typeof patch.general_note !== "string" || patch.general_note.trim() === "" ||
         patch.general_note.length > 4000)) return null;
    projectedPatch.general_note = patch.general_note as string | null;
  }
  if (Object.hasOwn(patch, "payment")) {
    const payment = projectPaymentPatch(patch.payment);
    if (!payment) return null;
    projectedPatch.payment = payment;
  }
  return { expected_version: value.expected_version, patch: projectedPatch };
}

function projectDelete(value: unknown): { expected_version: number } | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 ||
      typeof value.expected_version !== "number" ||
      !Number.isSafeInteger(value.expected_version) || value.expected_version < 1) return null;
  return { expected_version: value.expected_version };
}

export async function getInputCatalog(
  effectiveDate: string | null,
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (effectiveDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ||
      !isRealCalendarDate(effectiveDate)) return fail("EFFECTIVE_DATE_INVALID", 400);
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const result = await dependencies.repository.loadInputCatalog({
      auth_subject: session.actor.actor.auth_subject,
      app_user_id: session.actor.actor.app_user_id,
      effective_date: effectiveDate,
    });
    if (!result.ok) {
      if (result.kind === "denied") return fail("ACTOR_NOT_AVAILABLE", 403);
      console.error("[direct-entry] input catalog unavailable");
      return fail("CATALOG_UNAVAILABLE", 500);
    }
    const catalog: DraftCatalog = result.data;
    return respond({ ok: true, catalog }, 200);
  } catch {
    console.error("[direct-entry] input catalog request failed");
    return fail("CATALOG_UNAVAILABLE", 500);
  }
}

export async function getOwnDrafts(
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const result = await dependencies.repository.listOwnDrafts({
      auth_subject: session.actor.actor.auth_subject,
      app_user_id: session.actor.actor.app_user_id,
    });
    if (!result.ok) {
      if (result.kind === "denied") return fail("ACTOR_NOT_AVAILABLE", 403);
      if (result.kind === "too-large") return fail("DRAFT_LIMIT_EXCEEDED", 413);
      console.error("[direct-entry] own drafts unavailable");
      return fail("DRAFTS_UNAVAILABLE", 500);
    }
    return respond({
      ok: true,
      projection_version: DRAFT_LIST_PROJECTION_VERSION,
      drafts: result.data,
    }, 200);
  } catch {
    console.error("[direct-entry] own drafts request failed");
    return fail("DRAFTS_UNAVAILABLE", 500);
  }
}

export async function patchDraftEntry(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.trim() === "" || idempotencyKey.length > 128) {
    return fail("IDEMPOTENCY_KEY_INVALID", 400);
  }
  const body = await readBoundedJson(request);
  if (body === null) return fail("BODY_INVALID", 400);
  let parsed: ReturnType<typeof projectPatch>;
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
    parsed = projectPatch(body);
  } catch {
    return fail("DRAFT_PATCH_INVALID", 400);
  }
  if (!parsed) return fail("DRAFT_PATCH_INVALID", 400);

  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const trustedActor = {
      auth_subject: session.actor.actor.auth_subject,
      app_user_id: session.actor.actor.app_user_id,
    };
    if (parsed.patch.first_work_date !== undefined) {
      const catalogResult = await dependencies.repository.loadInputCatalog({
        ...trustedActor,
        effective_date: parsed.patch.first_work_date,
      });
      if (!catalogResult.ok) {
        if (catalogResult.kind === "denied") return fail("ACTOR_NOT_AVAILABLE", 403);
        console.error("[direct-entry] draft catalog validation unavailable");
        return fail("CATALOG_UNAVAILABLE", 500);
      }
      const catalog = catalogResult.data;
      if ((parsed.patch.project_id !== undefined &&
           !catalog.projects.some(({ project_id }) => project_id === parsed.patch.project_id)) ||
          (parsed.patch.recruiter_id !== undefined &&
           !catalog.recruiters.some(({ recruiter_id }) => recruiter_id === parsed.patch.recruiter_id)) ||
          (typeof parsed.patch.collaborator_id === "string" &&
           !(catalog.collaborators ?? []).some((item) => item.collaborator_id === parsed.patch.collaborator_id && item.active))) {
        return fail("DRAFT_MASTER_INVALID", 400);
      }
    }
    const result = await dependencies.repository.updateDraftRow({
      ...trustedActor,
      entry_id: entryId,
      expected_version: parsed.expected_version,
      patch: parsed.patch,
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) {
      if (result.kind === "conflict") return fail("DRAFT_CONFLICT", 409);
      if (result.kind === "denied") return fail("ACTOR_DENIED", 403);
      if (result.kind === "not-found") return fail("ENTRY_NOT_FOUND", 404);
      if (result.kind === "invalid") return fail("DRAFT_PATCH_INVALID", 400);
      console.error("[direct-entry] draft update unavailable");
      return fail("DRAFT_UPDATE_UNAVAILABLE", 500);
    }
    return respond({
      ok: true,
      entry_id: result.data.entry_id,
      entry_version: result.data.version,
      submission_version: result.data.submission_version,
    }, 200);
  } catch {
    console.error("[direct-entry] draft update request failed");
    return fail("DRAFT_UPDATE_UNAVAILABLE", 500);
  }
}

export async function deleteDraftEntry(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.trim() === "" || idempotencyKey.length > 128) {
    return fail("IDEMPOTENCY_KEY_INVALID", 400);
  }
  const body = await readBoundedJson(request);
  if (body === null) return fail("BODY_INVALID", 400);
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("DRAFT_DELETE_INVALID", 400);
  }
  const parsed = projectDelete(body);
  if (!parsed) return fail("DRAFT_DELETE_INVALID", 400);

  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const result = await dependencies.repository.deleteDraftRow({
      auth_subject: session.actor.actor.auth_subject,
      app_user_id: session.actor.actor.app_user_id,
      entry_id: entryId,
      expected_version: parsed.expected_version,
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) {
      if (result.kind === "conflict") return fail("DRAFT_CONFLICT", 409);
      if (result.kind === "final-row") return fail("DRAFT_FINAL_ROW", 409);
      if (result.kind === "denied") return fail("ACTOR_DENIED", 403);
      if (result.kind === "not-found") return fail("ENTRY_NOT_FOUND", 404);
      if (result.kind === "invalid") return fail("DRAFT_DELETE_INVALID", 400);
      console.error("[direct-entry] draft deletion unavailable");
      return fail("DRAFT_DELETE_UNAVAILABLE", 500);
    }
    return respond({
      ok: true,
      entry_id: result.data.entry_id,
      deleted: true,
      entry_version: result.data.version,
    }, 200);
  } catch {
    console.error("[direct-entry] draft deletion request failed");
    return fail("DRAFT_DELETE_UNAVAILABLE", 500);
  }
}
