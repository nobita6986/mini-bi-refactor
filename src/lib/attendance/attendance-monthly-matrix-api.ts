import "server-only";

import { createHash } from "node:crypto";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  adminAuthorityNavPredicate,
  attendanceFullAdminOrBodNavPredicate,
  attendanceReportNavPredicate,
  hasActiveDepartmentHeadRole,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";
import {
  ATTENDANCE_MONTHLY_MATRIX_EXPORT_FALLBACK_PAGE_SIZE,
  ATTENDANCE_MONTHLY_MATRIX_EXPORT_PAGE_SIZE,
  ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT,
  attendanceMonthlyMatrixHttpStatusForError,
  parseAssignBranchBody,
  parseAssignSlotPolicyBody,
  parseAttendanceBranchesAdminQuery,
  parseAttendanceExplanationApprovalInboxQuery,
  parseAttendanceMonthlyMatrixExportQuery,
  parseAttendanceMonthlyMatrixQuery,
  parseCreateSlotPolicyBody,
  parseDecideAttendanceExplanationBody,
  parseMyAttendanceExplanationsQuery,
  parseSubmitAttendanceExplanationBody,
  parseUnassignBranchBody,
  parseUnassignSlotPolicyBody,
  parseUpsertBranchBody,
  parseUpsertSlotPolicyProfileBody,
  type AttendanceExplanationDecision,
  type AttendanceMonthlyMatrixEmployeeRowProjection,
  type AttendanceMonthlyMatrixErrorCode,
  type AttendanceMonthlyMatrixReportProjection,
  type AttendanceSlotCode,
} from "./attendance-monthly-matrix-contract.ts";
import {
  logAttendanceMatrixDiagnostic,
  type AttendanceMonthlyMatrixRepository,
} from "./attendance-monthly-matrix-repository.ts";
import {
  attendanceMonthlyMatrixExportFilename,
  buildAttendanceMonthlyMatrixXlsx,
} from "./attendance-monthly-matrix-xlsx.ts";

const MAX_BRANCH_JSON_BODY_BYTES = 16_384;

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
] as const;

export type AttendanceMonthlyMatrixApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: AttendanceMonthlyMatrixRepository;
};

function matrixError(code: AttendanceMonthlyMatrixErrorCode): Response {
  return failJson(code, attendanceMonthlyMatrixHttpStatusForError(code));
}

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  for (const headerName of DISALLOWED_AUTHORITY_HEADERS) {
    if (request.headers.get(headerName) !== null) {
      return true;
    }
  }
  return false;
}

async function resolveVerifiedActor(
  resolveSession: () => Promise<DirectEntrySessionResult>,
): Promise<
  | {
      ok: true;
      auth_subject: string;
      app_user_id: string;
      nav_actor: NavActorProjection;
    }
  | { ok: false; response: Response }
> {
  let session: DirectEntrySessionResult;
  try {
    session = await resolveSession();
  } catch {
    console.error("[attendance-monthly-matrix] session resolution failed");
    return { ok: false, response: matrixError("ATTENDANCE_REPORT_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? matrixError("UNAUTHENTICATED")
          : matrixError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (!actor || !isUuid(actor.auth_subject) || !isUuid(actor.app_user_id)) {
    return { ok: false, response: matrixError("ACTOR_NOT_AVAILABLE") };
  }

  return {
    ok: true,
    auth_subject: actor.auth_subject.toLowerCase(),
    app_user_id: actor.app_user_id.toLowerCase(),
    nav_actor: {
      capabilities: actor.capabilities,
      scopes: actor.scopes.map((scope) => ({ kind: scope.kind })),
      ...(actor.effective_grants !== undefined
        ? { effective_grants: actor.effective_grants }
        : {}),
      hasAttendanceDepartmentHeadAccess: hasActiveDepartmentHeadRole(actor),
    },
  };
}

async function readBoundedJsonBody(
  request: Request,
  limitBytes: number,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; kind: "invalid" | "too-large" }
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, kind: "invalid" };
    }
    const parsedLength = Number(trimmed);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, kind: "invalid" };
    }
    if (parsedLength > limitBytes) {
      return { ok: false, kind: "too-large" };
    }
  }

  if (!request.body) {
    return { ok: false, kind: "invalid" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel();
        return { ok: false, kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { ok: false, kind: "invalid" };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    return { ok: true, value: JSON.parse(rawText) as unknown };
  } catch {
    return { ok: false, kind: "invalid" };
  }
}

export function computeBranchUpsertRequestFingerprint(input: {
  app_user_id: string;
  branch_id: string | null;
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  expected_version: number;
}): string {
  const canonicalPayload = JSON.stringify({
    v: 1,
    op: "branch_upsert",
    app_user_id: input.app_user_id.toLowerCase(),
    branch_id: input.branch_id ? input.branch_id.toLowerCase() : null,
    branch_code: input.branch_code,
    display_name: input.display_name,
    address: input.address,
    latitude:
      input.latitude === null
        ? null
        : Object.is(input.latitude, -0)
          ? 0
          : input.latitude,
    longitude:
      input.longitude === null
        ? null
        : Object.is(input.longitude, -0)
          ? 0
          : input.longitude,
    active: input.active,
    expected_version: input.expected_version,
  });
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export function computeBranchAssignRequestFingerprint(input: {
  app_user_id: string;
  target_app_user_id: string;
  branch_id: string;
  valid_from: string | null;
  expected_version: number;
}): string {
  const canonicalPayload = JSON.stringify({
    v: 1,
    op: "branch_assign",
    app_user_id: input.app_user_id.toLowerCase(),
    target_app_user_id: input.target_app_user_id.toLowerCase(),
    branch_id: input.branch_id.toLowerCase(),
    valid_from: input.valid_from,
    expected_version: input.expected_version,
  });
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export function computeBranchUnassignRequestFingerprint(input: {
  app_user_id: string;
  assignment_id: string;
  valid_to: string | null;
  expected_version: number;
}): string {
  const canonicalPayload = JSON.stringify({
    v: 1,
    op: "branch_unassign",
    app_user_id: input.app_user_id.toLowerCase(),
    assignment_id: input.assignment_id.toLowerCase(),
    valid_to: input.valid_to,
    expected_version: input.expected_version,
  });
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export function computeSlotPolicyCreateRequestFingerprint(input: {
  app_user_id: string;
  profile_id?: string | null;
  profile_code?: string | null;
  display_name?: string | null;
  description?: string | null;
  active?: boolean;
  expected_profile_version?: number;
  effective_from_date: string;
  slots?: readonly {
    slot_code?: string;
    slot_index?: number;
    slot_label?: string;
    target_time: string;
    grace_before_minutes: number;
    grace_after_minutes: number;
  }[];
  slot_1_time?: string;
  slot_1_grace_before_minutes?: number;
  slot_1_grace_after_minutes?: number;
  slot_2_time?: string;
  slot_2_grace_before_minutes?: number;
  slot_2_grace_after_minutes?: number;
  slot_3_time?: string;
  slot_3_grace_before_minutes?: number;
  slot_3_grace_after_minutes?: number;
  slot_4_time?: string;
  slot_4_grace_before_minutes?: number;
  slot_4_grace_after_minutes?: number;
  expected_version: number;
}): string {
  const rawSlots =
    Array.isArray(input.slots) && input.slots.length > 0
      ? input.slots
      : [
          {
            slot_label: "Time 1",
            target_time: input.slot_1_time ?? "",
            grace_before_minutes: input.slot_1_grace_before_minutes ?? 0,
            grace_after_minutes: input.slot_1_grace_after_minutes ?? 0,
          },
          {
            slot_label: "Time 2",
            target_time: input.slot_2_time ?? "",
            grace_before_minutes: input.slot_2_grace_before_minutes ?? 0,
            grace_after_minutes: input.slot_2_grace_after_minutes ?? 0,
          },
          {
            slot_label: "Time 3",
            target_time: input.slot_3_time ?? "",
            grace_before_minutes: input.slot_3_grace_before_minutes ?? 0,
            grace_after_minutes: input.slot_3_grace_after_minutes ?? 0,
          },
          {
            slot_label: "Time 4",
            target_time: input.slot_4_time ?? "",
            grace_before_minutes: input.slot_4_grace_before_minutes ?? 0,
            grace_after_minutes: input.slot_4_grace_after_minutes ?? 0,
          },
        ];

  const normalizedSlots = rawSlots.map((slot, index) => {
    const slotIndex = index + 1;
    const rawLabel = typeof slot.slot_label === "string" ? slot.slot_label.trim() : "";
    return {
      slot_index: slotIndex,
      slot_code: `SLOT_${slotIndex}`,
      slot_label: rawLabel.length > 0 ? rawLabel : `Time ${slotIndex}`,
      target_time: slot.target_time,
      grace_before_minutes: slot.grace_before_minutes,
      grace_after_minutes: slot.grace_after_minutes,
    };
  });

  const hasProfileMetadata =
    typeof input.profile_id === "string" ||
    typeof input.profile_code === "string" ||
    typeof input.display_name === "string" ||
    typeof input.description === "string" ||
    typeof input.active === "boolean" ||
    typeof input.expected_profile_version === "number";

  const canonicalPayload = hasProfileMetadata
    ? JSON.stringify({
        v: 3,
        op: "slot_policy_create",
        app_user_id: input.app_user_id.toLowerCase(),
        profile_id: input.profile_id ? input.profile_id.toLowerCase() : null,
        profile_code: input.profile_code ?? null,
        display_name: input.display_name ?? null,
        description: input.description ?? null,
        active: input.active ?? true,
        expected_profile_version: input.expected_profile_version ?? 0,
        effective_from_date: input.effective_from_date,
        slots: normalizedSlots,
        expected_version: input.expected_version,
      })
    : JSON.stringify({
        v: 2,
        op: "slot_policy_create",
        app_user_id: input.app_user_id.toLowerCase(),
        effective_from_date: input.effective_from_date,
        slots: normalizedSlots,
        expected_version: input.expected_version,
      });
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export function computeSlotPolicyProfileUpsertRequestFingerprint(input: {
  app_user_id: string;
  profile_id: string | null;
  profile_code: string | null;
  display_name: string | null;
  description: string | null;
  active: boolean;
  expected_profile_version?: number | null;
  effective_from_date: string | null;
  slots: readonly {
    slot_code?: string;
    slot_index?: number;
    slot_label?: string;
    target_time: string;
    grace_before_minutes: number;
    grace_after_minutes: number;
  }[] | null;
  expected_version: number | null;
}): string {
  const normalizedSlots = Array.isArray(input.slots)
    ? input.slots.map((slot, index) => {
        const slotIndex = index + 1;
        const rawLabel = typeof slot.slot_label === "string" ? slot.slot_label.trim() : "";
        return {
          slot_index: slotIndex,
          slot_code: `SLOT_${slotIndex}`,
          slot_label: rawLabel.length > 0 ? rawLabel : `Time ${slotIndex}`,
          target_time: slot.target_time,
          grace_before_minutes: slot.grace_before_minutes,
          grace_after_minutes: slot.grace_after_minutes,
        };
      })
    : null;

  const canonicalPayload = JSON.stringify({
    v: 1,
    op: "slot_policy_profile_upsert",
    app_user_id: input.app_user_id.toLowerCase(),
    profile_id: input.profile_id ? input.profile_id.toLowerCase() : null,
    profile_code: input.profile_code,
    display_name: input.display_name,
    description: input.description,
    active: input.active,
    expected_profile_version: input.expected_profile_version,
    effective_from_date: input.effective_from_date,
    slots: normalizedSlots,
    expected_version: input.expected_version,
  });
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export function computeSlotPolicyAssignRequestFingerprint(input: {
  app_user_id: string;
  target_app_user_id: string;
  profile_id: string;
  valid_from: string | null;
  expected_version: number;
}): string {
  const canonicalPayload = JSON.stringify({
    v: 1,
    op: "slot_policy_assign",
    app_user_id: input.app_user_id.toLowerCase(),
    target_app_user_id: input.target_app_user_id.toLowerCase(),
    profile_id: input.profile_id.toLowerCase(),
    valid_from: input.valid_from,
    expected_version: input.expected_version,
  });
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export function computeSlotPolicyUnassignRequestFingerprint(input: {
  app_user_id: string;
  assignment_id: string;
  valid_to: string | null;
  expected_version: number;
}): string {
  const canonicalPayload = JSON.stringify({
    v: 1,
    op: "slot_policy_unassign",
    app_user_id: input.app_user_id.toLowerCase(),
    assignment_id: input.assignment_id.toLowerCase(),
    valid_to: input.valid_to,
    expected_version: input.expected_version,
  });
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export function computeExplanationSubmitRequestFingerprint(input: {
  app_user_id: string;
  business_date: string;
  slot_code: AttendanceSlotCode;
  reason: string;
}): string {
  const canonicalPayload = JSON.stringify({
    v: 1,
    op: "attendance_explanation_submit",
    app_user_id: input.app_user_id.toLowerCase(),
    business_date: input.business_date,
    slot_code: input.slot_code,
    reason: input.reason.trim(),
  });
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export function computeExplanationDecideRequestFingerprint(input: {
  app_user_id: string;
  explanation_id: string;
  decision: AttendanceExplanationDecision;
  expected_row_version: number;
  decision_note: string | null;
}): string {
  const canonicalPayload = JSON.stringify({
    v: 1,
    op: "attendance_explanation_decide",
    app_user_id: input.app_user_id.toLowerCase(),
    explanation_id: input.explanation_id.toLowerCase(),
    decision: input.decision,
    expected_row_version: input.expected_row_version,
    decision_note: input.decision_note ? input.decision_note.trim() : null,
  });
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export async function getAttendanceMonthlyMatrixReport(
  request: Request,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_REPORT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return matrixError("ATTENDANCE_REPORT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!attendanceReportNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_REPORT_ACCESS_DENIED");
  }

  const parsedQuery = parseAttendanceMonthlyMatrixQuery(parsedUrl);
  if (!parsedQuery.ok) {
    return matrixError(parsedQuery.code);
  }

  const result = await dependencies.repository.getMonthlyMatrixReport({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    year_month: parsedQuery.value.year_month,
    branch_id: parsedQuery.value.branch_id,
    employee_id: parsedQuery.value.employee_id,
    search: parsedQuery.value.search,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
    phase: "report_fetch",
  });

  if (!result.ok) {
    return matrixError(result.code);
  }

  return noStoreJson(
    {
      ok: true,
      report: result.report,
    },
    200,
  );
}

export async function exportAttendanceMonthlyMatrixXlsx(
  request: Request,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_REPORT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return matrixError("ATTENDANCE_REPORT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!attendanceReportNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_REPORT_ACCESS_DENIED");
  }

  const parsedQuery = parseAttendanceMonthlyMatrixExportQuery(parsedUrl);
  if (!parsedQuery.ok) {
    return matrixError(parsedQuery.code);
  }

  const collectExportPages = async (
    pageSize: number,
    phasePrefix: "export" | "export_fallback",
  ): Promise<
    | {
        ok: true;
        firstReport: AttendanceMonthlyMatrixReportProjection;
        collectedItems: AttendanceMonthlyMatrixEmployeeRowProjection[];
      }
    | { ok: false; code: AttendanceMonthlyMatrixErrorCode }
  > => {
    const firstPageResult = await dependencies.repository.getMonthlyMatrixReport({
      auth_subject: actorResult.auth_subject,
      app_user_id: actorResult.app_user_id,
      year_month: parsedQuery.value.year_month,
      branch_id: parsedQuery.value.branch_id,
      employee_id: parsedQuery.value.employee_id,
      search: parsedQuery.value.search,
      page: 1,
      page_size: pageSize,
      phase: `${phasePrefix}_page_1`,
    });

    if (!firstPageResult.ok) {
      return { ok: false, code: firstPageResult.code };
    }

    const firstReport = firstPageResult.report;
    const expectedTotalRows = firstReport.pagination.total_rows;
    const expectedTotalPages = firstReport.pagination.total_pages;
    const expectedSnapshotToken = firstReport.pagination.snapshot_token;

    if (expectedTotalRows > ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT) {
      return { ok: false, code: "ATTENDANCE_MATRIX_EXPORT_ROW_LIMIT_EXCEEDED" };
    }

    const collectedItems: AttendanceMonthlyMatrixEmployeeRowProjection[] = [];
    const seenEmployeeIds = new Set<string>();

    for (const item of firstReport.items) {
      if (seenEmployeeIds.has(item.app_user_id)) {
        return { ok: false, code: "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE" };
      }
      seenEmployeeIds.add(item.app_user_id);
      collectedItems.push(item);
    }

    if (expectedTotalRows === 0) {
      if (collectedItems.length !== 0 || expectedTotalPages !== 0) {
        return { ok: false, code: "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE" };
      }
    } else {
      if (firstReport.items.length === 0 || expectedTotalPages < 1) {
        return { ok: false, code: "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE" };
      }

      for (let page = 2; page <= expectedTotalPages; page += 1) {
        const nextPageResult = await dependencies.repository.getMonthlyMatrixReport({
          auth_subject: actorResult.auth_subject,
          app_user_id: actorResult.app_user_id,
          year_month: firstReport.filters.year_month,
          branch_id: parsedQuery.value.branch_id,
          employee_id: parsedQuery.value.employee_id,
          search: parsedQuery.value.search,
          page,
          page_size: pageSize,
          phase: `${phasePrefix}_page_n`,
        });

        if (!nextPageResult.ok) {
          return { ok: false, code: nextPageResult.code };
        }

        const nextReport = nextPageResult.report;
        if (
          nextReport.pagination.total_rows !== expectedTotalRows ||
          nextReport.pagination.total_pages !== expectedTotalPages ||
          nextReport.pagination.snapshot_token !== expectedSnapshotToken ||
          nextReport.items.length === 0
        ) {
          return { ok: false, code: "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE" };
        }

        for (const item of nextReport.items) {
          if (seenEmployeeIds.has(item.app_user_id)) {
            return { ok: false, code: "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE" };
          }
          seenEmployeeIds.add(item.app_user_id);
          collectedItems.push(item);
        }
      }

      if (collectedItems.length !== expectedTotalRows) {
        return { ok: false, code: "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE" };
      }
    }

    return { ok: true, firstReport, collectedItems };
  };

  let collectionResult = await collectExportPages(
    ATTENDANCE_MONTHLY_MATRIX_EXPORT_PAGE_SIZE,
    "export",
  );

  if (
    !collectionResult.ok &&
    collectionResult.code === "ATTENDANCE_REPORT_UNAVAILABLE" &&
    ATTENDANCE_MONTHLY_MATRIX_EXPORT_FALLBACK_PAGE_SIZE <
      ATTENDANCE_MONTHLY_MATRIX_EXPORT_PAGE_SIZE
  ) {
    logAttendanceMatrixDiagnostic({
      phase: "export_page_size_fallback",
      fallback_phase: "export_page_size_fallback",
      code: collectionResult.code,
      sqlstate: null,
    });
    collectionResult = await collectExportPages(
      ATTENDANCE_MONTHLY_MATRIX_EXPORT_FALLBACK_PAGE_SIZE,
      "export_fallback",
    );
  }

  if (!collectionResult.ok) {
    return matrixError(collectionResult.code);
  }

  const { firstReport, collectedItems } = collectionResult;

  try {
    const bytes = await buildAttendanceMonthlyMatrixXlsx({
      year_month: firstReport.filters.year_month,
      from_date: firstReport.filters.from_date,
      to_date: firstReport.filters.to_date,
      calendar_days: firstReport.calendar_days,
      items: collectedItems,
      slot_policy: firstReport.slot_policy,
    });
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const filename = attendanceMonthlyMatrixExportFilename(firstReport.filters.year_month);

    return new Response(body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    logAttendanceMatrixDiagnostic({
      phase: "workbook_build",
      fallback_phase: "workbook_build",
      code: "ATTENDANCE_REPORT_UNAVAILABLE",
      sqlstate: null,
    });
    return matrixError("ATTENDANCE_REPORT_UNAVAILABLE");
  }
}

export async function getAttendanceBranchesAdmin(
  request: Request,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_REPORT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return matrixError("ATTENDANCE_REPORT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!attendanceFullAdminOrBodNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_REPORT_ACCESS_DENIED");
  }

  const parsedQuery = parseAttendanceBranchesAdminQuery(parsedUrl);
  if (!parsedQuery.ok) {
    return matrixError(parsedQuery.code);
  }

  const result = await dependencies.repository.listBranchesAdmin({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    include_inactive: parsedQuery.value.include_inactive,
  });

  if (!result.ok) {
    return matrixError(result.code);
  }

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function postOrPutAttendanceBranchAdmin(
  request: Request,
  branchId: string | null,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return matrixError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_BRANCH_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return matrixError("ATTENDANCE_BRANCH_INVALID");
    }
  } catch {
    return matrixError("ATTENDANCE_BRANCH_INVALID");
  }

  let normalizedBranchId: string | null = null;
  if (branchId !== null) {
    if (!isUuid(branchId)) {
      return matrixError("ATTENDANCE_BRANCH_INVALID");
    }
    normalizedBranchId = branchId.toLowerCase();
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return matrixError("CONTENT_TYPE_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!adminAuthorityNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_BRANCH_WRITE_DENIED");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_BRANCH_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? matrixError("BODY_TOO_LARGE")
      : matrixError("ATTENDANCE_BRANCH_INVALID");
  }

  const parsedBody = parseUpsertBranchBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return matrixError(parsedBody.code);
  }

  if (normalizedBranchId === null && parsedBody.value.expected_version !== 0) {
    return matrixError("ATTENDANCE_BRANCH_VERSION_CONFLICT");
  }
  if (normalizedBranchId !== null && parsedBody.value.expected_version < 1) {
    return matrixError("ATTENDANCE_BRANCH_INVALID");
  }

  const requestFingerprint = computeBranchUpsertRequestFingerprint({
    app_user_id: actorResult.app_user_id,
    branch_id: normalizedBranchId,
    branch_code: parsedBody.value.branch_code,
    display_name: parsedBody.value.display_name,
    address: parsedBody.value.address,
    latitude: parsedBody.value.latitude,
    longitude: parsedBody.value.longitude,
    active: parsedBody.value.active,
    expected_version: parsedBody.value.expected_version,
  });

  const saved = await dependencies.repository.upsertBranchAdmin({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    branch_id: normalizedBranchId,
    branch_code: parsedBody.value.branch_code,
    display_name: parsedBody.value.display_name,
    address: parsedBody.value.address,
    latitude: parsedBody.value.latitude,
    longitude: parsedBody.value.longitude,
    active: parsedBody.value.active,
    expected_version: parsedBody.value.expected_version,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: requestFingerprint,
  });

  if (!saved.ok) {
    return matrixError(saved.code);
  }

  const statusCode = saved.result.replayed ? 200 : normalizedBranchId === null ? 201 : 200;
  return noStoreJson(
    {
      ok: true,
      replayed: saved.result.replayed,
      branch: saved.result.branch,
    },
    statusCode,
  );
}

export async function postAttendanceBranchAssignmentAdmin(
  request: Request,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return matrixError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_BRANCH_ASSIGNMENT_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return matrixError("ATTENDANCE_BRANCH_ASSIGNMENT_INVALID");
    }
  } catch {
    return matrixError("ATTENDANCE_BRANCH_ASSIGNMENT_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return matrixError("CONTENT_TYPE_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!adminAuthorityNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_BRANCH_WRITE_DENIED");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_BRANCH_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? matrixError("BODY_TOO_LARGE")
      : matrixError("ATTENDANCE_BRANCH_ASSIGNMENT_INVALID");
  }

  const parsedBody = parseAssignBranchBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return matrixError(parsedBody.code);
  }

  const requestFingerprint = computeBranchAssignRequestFingerprint({
    app_user_id: actorResult.app_user_id,
    target_app_user_id: parsedBody.value.target_app_user_id,
    branch_id: parsedBody.value.branch_id,
    valid_from: parsedBody.value.valid_from,
    expected_version: parsedBody.value.expected_version,
  });

  const saved = await dependencies.repository.assignEmployeeBranchAdmin({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    target_app_user_id: parsedBody.value.target_app_user_id,
    branch_id: parsedBody.value.branch_id,
    valid_from: parsedBody.value.valid_from,
    expected_version: parsedBody.value.expected_version,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: requestFingerprint,
  });

  if (!saved.ok) {
    return matrixError(saved.code);
  }

  return noStoreJson(
    {
      ok: true,
      replayed: saved.result.replayed,
      assignment: saved.result.assignment,
    },
    saved.result.replayed ? 200 : 201,
  );
}

export async function postAttendanceBranchUnassignAdmin(
  request: Request,
  assignmentId: string,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return matrixError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_BRANCH_ASSIGNMENT_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0 || !isUuid(assignmentId)) {
      return matrixError("ATTENDANCE_BRANCH_ASSIGNMENT_INVALID");
    }
  } catch {
    return matrixError("ATTENDANCE_BRANCH_ASSIGNMENT_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return matrixError("CONTENT_TYPE_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!adminAuthorityNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_BRANCH_WRITE_DENIED");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_BRANCH_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? matrixError("BODY_TOO_LARGE")
      : matrixError("ATTENDANCE_BRANCH_ASSIGNMENT_INVALID");
  }

  const parsedBody = parseUnassignBranchBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return matrixError(parsedBody.code);
  }

  const normalizedAssignmentId = assignmentId.toLowerCase();
  const requestFingerprint = computeBranchUnassignRequestFingerprint({
    app_user_id: actorResult.app_user_id,
    assignment_id: normalizedAssignmentId,
    valid_to: parsedBody.value.valid_to,
    expected_version: parsedBody.value.expected_version,
  });

  const saved = await dependencies.repository.unassignEmployeeBranchAdmin({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    assignment_id: normalizedAssignmentId,
    valid_to: parsedBody.value.valid_to,
    expected_version: parsedBody.value.expected_version,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: requestFingerprint,
  });

  if (!saved.ok) {
    return matrixError(saved.code);
  }

  return noStoreJson(
    {
      ok: true,
      replayed: saved.result.replayed,
      assignment: saved.result.assignment,
    },
    200,
  );
}

export async function getAttendanceSlotPoliciesAdmin(
  request: Request,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_REPORT_QUERY_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return matrixError("ATTENDANCE_REPORT_QUERY_INVALID");
    }
  } catch {
    return matrixError("ATTENDANCE_REPORT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!attendanceFullAdminOrBodNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_REPORT_ACCESS_DENIED");
  }

  if (!dependencies.repository.getSlotPoliciesAdmin) {
    return matrixError("ATTENDANCE_REPORT_UNAVAILABLE");
  }

  const result = await dependencies.repository.getSlotPoliciesAdmin({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
  });

  if (!result.ok) {
    return matrixError(result.code);
  }

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function postAttendanceSlotPolicyAdmin(
  request: Request,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return matrixError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_SLOT_POLICY_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return matrixError("ATTENDANCE_SLOT_POLICY_INVALID");
    }
  } catch {
    return matrixError("ATTENDANCE_SLOT_POLICY_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return matrixError("CONTENT_TYPE_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!adminAuthorityNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_SLOT_POLICY_WRITE_DENIED");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_BRANCH_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? matrixError("BODY_TOO_LARGE")
      : matrixError("ATTENDANCE_SLOT_POLICY_INVALID");
  }

  const parsedBody = parseCreateSlotPolicyBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return matrixError(parsedBody.code);
  }

  if (!dependencies.repository.createSlotPolicyAdmin) {
    return matrixError("ATTENDANCE_REPORT_UNAVAILABLE");
  }

  const requestFingerprint = computeSlotPolicyCreateRequestFingerprint({
    app_user_id: actorResult.app_user_id,
    profile_id: parsedBody.value.profile_id,
    profile_code: parsedBody.value.profile_code,
    display_name: parsedBody.value.display_name,
    description: parsedBody.value.description,
    active: parsedBody.value.active,
    expected_profile_version: parsedBody.value.expected_profile_version,
    effective_from_date: parsedBody.value.effective_from_date,
    slots: parsedBody.value.slots,
    expected_version: parsedBody.value.expected_version,
  });

  const saved = await dependencies.repository.createSlotPolicyAdmin({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    profile_id: parsedBody.value.profile_id,
    profile_code: parsedBody.value.profile_code,
    display_name: parsedBody.value.display_name,
    description: parsedBody.value.description,
    active: parsedBody.value.active,
    expected_profile_version: parsedBody.value.expected_profile_version,
    effective_from_date: parsedBody.value.effective_from_date,
    slots: parsedBody.value.slots,
    expected_version: parsedBody.value.expected_version,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: requestFingerprint,
  });

  if (!saved.ok) {
    return matrixError(saved.code);
  }

  return noStoreJson(
    {
      ok: true,
      replayed: saved.result.replayed,
      ...(saved.result.profile ? { profile: saved.result.profile } : {}),
      policy: saved.result.policy,
    },
    saved.result.replayed ? 200 : 201,
  );
}

export async function postOrPutAttendanceSlotPolicyProfileAdmin(
  request: Request,
  profileId: string | null,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return matrixError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_SLOT_POLICY_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return matrixError("ATTENDANCE_SLOT_POLICY_INVALID");
    }
  } catch {
    return matrixError("ATTENDANCE_SLOT_POLICY_INVALID");
  }

  let normalizedProfileId: string | null = null;
  if (profileId !== null) {
    if (!isUuid(profileId)) {
      return matrixError("ATTENDANCE_SLOT_POLICY_INVALID");
    }
    normalizedProfileId = profileId.toLowerCase();
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return matrixError("CONTENT_TYPE_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!adminAuthorityNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_SLOT_POLICY_WRITE_DENIED");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_BRANCH_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? matrixError("BODY_TOO_LARGE")
      : matrixError("ATTENDANCE_SLOT_POLICY_INVALID");
  }

  const parsedBody = parseUpsertSlotPolicyProfileBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
    normalizedProfileId,
  );
  if (!parsedBody.ok) {
    return matrixError(parsedBody.code);
  }

  if (!dependencies.repository.upsertSlotPolicyProfileAdmin) {
    return matrixError("ATTENDANCE_REPORT_UNAVAILABLE");
  }

  const requestFingerprint = computeSlotPolicyProfileUpsertRequestFingerprint({
    app_user_id: actorResult.app_user_id,
    profile_id: parsedBody.value.profile_id,
    profile_code: parsedBody.value.profile_code,
    display_name: parsedBody.value.display_name,
    description: parsedBody.value.description,
    active: parsedBody.value.active,
    expected_profile_version: parsedBody.value.expected_profile_version,
    effective_from_date: parsedBody.value.effective_from_date,
    slots: parsedBody.value.slots,
    expected_version: parsedBody.value.expected_version,
  });

  const saved = await dependencies.repository.upsertSlotPolicyProfileAdmin({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    profile_id: parsedBody.value.profile_id,
    profile_code: parsedBody.value.profile_code,
    display_name: parsedBody.value.display_name,
    description: parsedBody.value.description,
    active: parsedBody.value.active,
    expected_profile_version: parsedBody.value.expected_profile_version,
    effective_from_date: parsedBody.value.effective_from_date,
    slots: parsedBody.value.slots,
    expected_version: parsedBody.value.expected_version,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: requestFingerprint,
  });

  if (!saved.ok) {
    return matrixError(saved.code);
  }

  const isCreate = parsedBody.value.profile_id === null || parsedBody.value.expected_version === 0;
  const statusCode = saved.result.replayed ? 200 : isCreate ? 201 : 200;
  return noStoreJson(
    {
      ok: true,
      replayed: saved.result.replayed,
      profile: saved.result.profile,
      policy: saved.result.policy,
    },
    statusCode,
  );
}

export async function postAttendanceSlotPolicyAssignmentAdmin(
  request: Request,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return matrixError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return matrixError("ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID");
    }
  } catch {
    return matrixError("ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return matrixError("CONTENT_TYPE_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!adminAuthorityNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_SLOT_POLICY_WRITE_DENIED");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_BRANCH_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? matrixError("BODY_TOO_LARGE")
      : matrixError("ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID");
  }

  const parsedBody = parseAssignSlotPolicyBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return matrixError(parsedBody.code);
  }

  if (!dependencies.repository.assignEmployeeSlotPolicyAdmin) {
    return matrixError("ATTENDANCE_REPORT_UNAVAILABLE");
  }

  const requestFingerprint = computeSlotPolicyAssignRequestFingerprint({
    app_user_id: actorResult.app_user_id,
    target_app_user_id: parsedBody.value.target_app_user_id,
    profile_id: parsedBody.value.profile_id,
    valid_from: parsedBody.value.valid_from,
    expected_version: parsedBody.value.expected_version,
  });

  const saved = await dependencies.repository.assignEmployeeSlotPolicyAdmin({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    target_app_user_id: parsedBody.value.target_app_user_id,
    profile_id: parsedBody.value.profile_id,
    valid_from: parsedBody.value.valid_from,
    expected_version: parsedBody.value.expected_version,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: requestFingerprint,
  });

  if (!saved.ok) {
    return matrixError(saved.code);
  }

  return noStoreJson(
    {
      ok: true,
      replayed: saved.result.replayed,
      assignment: saved.result.assignment,
    },
    saved.result.replayed ? 200 : 201,
  );
}

export async function postAttendanceSlotPolicyUnassignAdmin(
  request: Request,
  assignmentId: string,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return matrixError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0 || !isUuid(assignmentId)) {
      return matrixError("ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID");
    }
  } catch {
    return matrixError("ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return matrixError("CONTENT_TYPE_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!adminAuthorityNavPredicate(actorResult.nav_actor)) {
    return matrixError("ATTENDANCE_SLOT_POLICY_WRITE_DENIED");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_BRANCH_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? matrixError("BODY_TOO_LARGE")
      : matrixError("ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID");
  }

  const parsedBody = parseUnassignSlotPolicyBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return matrixError(parsedBody.code);
  }

  if (!dependencies.repository.unassignEmployeeSlotPolicyAdmin) {
    return matrixError("ATTENDANCE_REPORT_UNAVAILABLE");
  }

  const normalizedAssignmentId = assignmentId.toLowerCase();
  const requestFingerprint = computeSlotPolicyUnassignRequestFingerprint({
    app_user_id: actorResult.app_user_id,
    assignment_id: normalizedAssignmentId,
    valid_to: parsedBody.value.valid_to,
    expected_version: parsedBody.value.expected_version,
  });

  const saved = await dependencies.repository.unassignEmployeeSlotPolicyAdmin({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    assignment_id: normalizedAssignmentId,
    valid_to: parsedBody.value.valid_to,
    expected_version: parsedBody.value.expected_version,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: requestFingerprint,
  });

  if (!saved.ok) {
    return matrixError(saved.code);
  }

  return noStoreJson(
    {
      ok: true,
      replayed: saved.result.replayed,
      assignment: saved.result.assignment,
    },
    200,
  );
}

export async function getMyAttendanceExplanations(
  request: Request,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_EXPLANATION_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return matrixError("ATTENDANCE_EXPLANATION_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  const parsedQuery = parseMyAttendanceExplanationsQuery(parsedUrl);
  if (!parsedQuery.ok) {
    return matrixError(parsedQuery.code);
  }

  if (!dependencies.repository.getMyExplanationsOverview) {
    return matrixError("ATTENDANCE_REPORT_UNAVAILABLE");
  }

  const result = await dependencies.repository.getMyExplanationsOverview({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    business_date: parsedQuery.value.business_date,
  });

  if (!result.ok) {
    return matrixError(result.code);
  }

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function postSubmitAttendanceExplanation(
  request: Request,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return matrixError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_EXPLANATION_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return matrixError("ATTENDANCE_EXPLANATION_INVALID");
    }
  } catch {
    return matrixError("ATTENDANCE_EXPLANATION_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return matrixError("CONTENT_TYPE_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_BRANCH_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? matrixError("BODY_TOO_LARGE")
      : matrixError("ATTENDANCE_EXPLANATION_INVALID");
  }

  const parsedBody = parseSubmitAttendanceExplanationBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return matrixError(parsedBody.code);
  }

  if (!dependencies.repository.submitExplanation) {
    return matrixError("ATTENDANCE_REPORT_UNAVAILABLE");
  }

  const requestFingerprint = computeExplanationSubmitRequestFingerprint({
    app_user_id: actorResult.app_user_id,
    business_date: parsedBody.value.business_date,
    slot_code: parsedBody.value.slot_code,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.submitExplanation({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    business_date: parsedBody.value.business_date,
    slot_code: parsedBody.value.slot_code,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: requestFingerprint,
  });

  if (!saved.ok) {
    return matrixError(saved.code);
  }

  return noStoreJson(
    {
      ok: true,
      replayed: saved.result.replayed,
      explanation: saved.result.explanation,
    },
    saved.result.replayed ? 200 : 201,
  );
}

export async function getAttendanceExplanationApprovalInbox(
  request: Request,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_EXPLANATION_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return matrixError("ATTENDANCE_EXPLANATION_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  const parsedQuery = parseAttendanceExplanationApprovalInboxQuery(parsedUrl);
  if (!parsedQuery.ok) {
    return matrixError(parsedQuery.code);
  }

  if (!dependencies.repository.listExplanationApprovalInbox) {
    return matrixError("ATTENDANCE_REPORT_UNAVAILABLE");
  }

  const result = await dependencies.repository.listExplanationApprovalInbox({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    status_filter: parsedQuery.value.status_filter ?? "PENDING",
  });

  if (!result.ok) {
    return matrixError(result.code);
  }

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function postDecideAttendanceExplanation(
  request: Request,
  explanationId: string,
  dependencies: AttendanceMonthlyMatrixApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return matrixError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return matrixError("ATTENDANCE_EXPLANATION_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0 || !isUuid(explanationId)) {
      return matrixError("ATTENDANCE_EXPLANATION_INVALID");
    }
  } catch {
    return matrixError("ATTENDANCE_EXPLANATION_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return matrixError("CONTENT_TYPE_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_BRANCH_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? matrixError("BODY_TOO_LARGE")
      : matrixError("ATTENDANCE_EXPLANATION_INVALID");
  }

  const parsedBody = parseDecideAttendanceExplanationBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return matrixError(parsedBody.code);
  }

  if (!dependencies.repository.decideExplanation) {
    return matrixError("ATTENDANCE_REPORT_UNAVAILABLE");
  }

  const normalizedExplanationId = explanationId.toLowerCase();
  const requestFingerprint = computeExplanationDecideRequestFingerprint({
    app_user_id: actorResult.app_user_id,
    explanation_id: normalizedExplanationId,
    decision: parsedBody.value.decision,
    expected_row_version: parsedBody.value.expected_row_version,
    decision_note: parsedBody.value.decision_note,
  });

  const saved = await dependencies.repository.decideExplanation({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    explanation_id: normalizedExplanationId,
    decision: parsedBody.value.decision,
    expected_row_version: parsedBody.value.expected_row_version,
    decision_note: parsedBody.value.decision_note,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: requestFingerprint,
  });

  if (!saved.ok) {
    return matrixError(saved.code);
  }

  return noStoreJson(
    {
      ok: true,
      replayed: saved.result.replayed,
      explanation: saved.result.explanation,
    },
    200,
  );
}
