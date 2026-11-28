import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { hasAnyValidPairedGrant } from "../auth/direct-entry-v2.ts";
import { createHash } from "node:crypto";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import {
  FULL_PROFILE_MAX_BODY_BYTES,
  parseFullProfilePayload,
  type FullProfilePayload,
} from "./full-profile-contract.ts";
import type { createFullProfileRepository } from "./full-profile-repository.ts";
import type { DirectEntryRepository } from "./write-repository.ts";
import type { DocumentObjectStorage } from "./r2-document-storage.ts";
import { inspectDocumentContent, sha256Hex } from "./document-r2-contract.ts";
import type { createWorkerPortraitStageRepository } from "./worker-portrait-stage-repository.ts";
import { finalizeDirectEntryDocument, type CccdFinalizeTriggerInput } from "./document-finalize-api.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CLIENT_CODES = new Set([
  "BANK_NOT_ACTIVE", "BATCH_INVALID", "BATCH_SIZE_INVALID",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN", "COLLABORATOR_INVALID", "COLLABORATOR_NOT_ACTIVE",
  "CONTRACT_VERSION_UNSUPPORTED",
  "EMPLOYEE_CODE_DUPLICATE", "EMPLOYEE_CODE_FORMAT",
  "EMPLOYEE_CODE_LEGACY_QUARANTINE", "EMPLOYEE_CODE_YEAR",
  "EMPLOYEE_CODE_SEQUENCE_EXHAUSTED",
  "GENERAL_NOTE_INVALID", "GENERAL_NOTE_TOO_LONG", "GENDER_VOCABULARY_INVALID",
  "NATIONAL_ID_DUPLICATE", "NATIONAL_ID_INVALID", "NATIONAL_ID_ISSUED_PLACE_INVALID",
  "OFF_REQUIRES_DATE_AND_REASON", "PASTE_VALUE_FORMAT",
  "PAYMENT_DETAILS_INVALID", "PROFILE_DATE_INVALID",
  "PROJECT_NOT_ACTIVE", "RECRUITER_MEMBERSHIP_INVALID", "RECRUITER_NOT_ACTIVE",
  "WORKER_ACTIVE_EPISODE_EXISTS", "WORKER_EPISODE_REOPEN_FORBIDDEN",
]);

type Repository = ReturnType<typeof createFullProfileRepository>;
type Dependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: Pick<Repository, "createFullProfileBatch"> &
    Partial<Pick<Repository, "createFullProfileBatchWithPortraitStages">>;
  portraitStages?: ReturnType<typeof createWorkerPortraitStageRepository>;
  documentRepository?: DirectEntryRepository;
  documentStorage?: DocumentObjectStorage;
  onCccdImageFinalized?: (input: CccdFinalizeTriggerInput) => void;
};

async function reconcileRejectedPortraitStage(
  stageId: string,
  idempotencyKey: string,
  actor: { auth_subject: string; app_user_id: string },
  dependencies: Dependencies,
): Promise<void> {
  const stages = dependencies.portraitStages;
  const storage = dependencies.documentStorage;
  if (!stages || !storage) return;
  const recovered = await stages.recover({ ...actor, stage_id: stageId });
  if (!recovered.ok) {
    console.error("[direct-entry] rejected portrait stage recovery failed");
    return;
  }
  if (recovered.data.status === "CLAIMED") {
    const released = await stages.release({
      ...actor, stage_id: stageId, idempotency_key: idempotencyKey,
    });
    if (!released.ok || released.data !== true) {
      console.error("[direct-entry] rejected worker document stage release failed");
    }
    return;
  }
  if (recovered.data.status === "STAGED") {
    const cancelled = await stages.cancel({ ...actor, stage_id: stageId });
    if (!cancelled.ok) {
      console.error("[direct-entry] rejected portrait stage cancellation failed");
      return;
    }
  }
  try {
    await storage.deleteEnrollmentPortraitStage(stageId);
  } catch {
    console.error("[direct-entry] rejected portrait stage object cleanup failed");
  }
}

type ReadBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: "invalid" | "too-large" };

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

function deriveStageBatchIdempotencyKey(
  requestKey: string,
  stages: readonly { index: number; stage_id: string; document_type: string }[],
): string {
  const canonicalStages = [...stages]
    .sort((left, right) => left.index - right.index ||
      left.document_type.localeCompare(right.document_type) || left.stage_id.localeCompare(right.stage_id))
    .map((stage) => `${stage.index}:${stage.document_type}:${stage.stage_id.toLowerCase()}`)
    .join("\n");
  const digest = createHash("sha256")
    .update(requestKey.toLowerCase() + "\n" + canonicalStages, "utf8")
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readBoundedJson(request: Request): Promise<ReadBodyResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, kind: "invalid" };
    if (length > FULL_PROFILE_MAX_BODY_BYTES) return { ok: false, kind: "too-large" };
  }
  if (!request.body) return { ok: false, kind: "invalid" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FULL_PROFILE_MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, kind: "too-large" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, kind: "invalid" };
  } finally {
    reader.releaseLock();
  }
}

function projectResult(value: unknown, expectedCount: number, expectedYears?: readonly string[]): {
  submission_id: string;
  state: "DRAFT";
  version: number;
  entry_ids: string[];
  employee_codes?: string[];
  replayed: boolean;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedKeys = expectedYears
    ? ["employee_codes", "entry_ids", "replayed", "state", "submission_id", "version"]
    : ["entry_ids", "replayed", "state", "submission_id", "version"];
  if (Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",") ||
      typeof record.submission_id !== "string" || !UUID.test(record.submission_id) ||
      record.state !== "DRAFT" || typeof record.version !== "number" ||
      !Number.isSafeInteger(record.version) || record.version < 1 ||
      typeof record.replayed !== "boolean" || !Array.isArray(record.entry_ids) ||
      record.entry_ids.length !== expectedCount ||
      !record.entry_ids.every((id) => typeof id === "string" && UUID.test(id)) ||
      new Set(record.entry_ids).size !== record.entry_ids.length) return null;
  let employeeCodes: string[] | undefined;
  if (expectedYears) {
    if (!Array.isArray(record.employee_codes) || record.employee_codes.length !== expectedCount ||
        !record.employee_codes.every((code, index) =>
          typeof code === "string" &&
          /^hrp-\d{4}-\d{6}$/.test(code) &&
          code.slice(4, 8) === expectedYears[index]) ||
        new Set(record.employee_codes).size !== record.employee_codes.length) return null;
    employeeCodes = record.employee_codes as string[];
  }
  return {
    submission_id: record.submission_id,
    state: "DRAFT",
    version: record.version,
    entry_ids: record.entry_ids as string[],
    ...(employeeCodes ? { employee_codes: employeeCodes } : {}),
    replayed: record.replayed,
  };
}

export async function postFullProfileBatch(
  request: Request,
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

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
  if (idempotencyKey === null || !UUID.test(idempotencyKey)) {
    return fail("IDEMPOTENCY_KEY_INVALID", 400);
  }

  const body = await readBoundedJson(request);
  if (!body.ok) {
    return body.kind === "too-large"
      ? fail("BODY_TOO_LARGE", 413)
      : fail("BODY_INVALID", 400);
  }
  const parsed = parseFullProfilePayload(body.value);
  if (!parsed.ok) {
    const first = parsed.issues[0];
    return fail(SAFE_CLIENT_CODES.has(first.code) ? first.code : "BATCH_INVALID", 400);
  }

  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const actor = {
      auth_subject: session.actor.actor.auth_subject,
      app_user_id: session.actor.actor.app_user_id,
    };
    const stageRows = parsed.payload.rows.flatMap((row, index) => {
      const stages: { index: number; stage_id: string; document_type: string }[] = [];
      if (row.portrait_stage_id) {
        stages.push({ index, stage_id: row.portrait_stage_id, document_type: "WORKER_PORTRAIT" });
      }
      for (const [documentType, stageId] of Object.entries(row.document_stage_ids ?? {})) {
        stages.push({ index, stage_id: stageId, document_type: documentType });
      }
      return stages;
    });
    if (new Set(stageRows.map(({ stage_id }) => stage_id)).size !== stageRows.length) {
      return fail("BATCH_INVALID", 400);
    }
    const stageBatchIdempotencyKey = stageRows.length === 0
      ? idempotencyKey
      : deriveStageBatchIdempotencyKey(idempotencyKey, stageRows);
    if (stageRows.length > 0 &&
        !hasAnyValidPairedGrant(session.actor.actor, "document_upload", ["OWN", "ALL"])) {
      return fail("DOCUMENT_DENIED", 403);
    }
    if (stageRows.length > 0 && (
      !dependencies.portraitStages || !dependencies.documentRepository ||
      !dependencies.documentStorage || !dependencies.repository.createFullProfileBatchWithPortraitStages
    )) return fail("PORTRAIT_STAGE_UNAVAILABLE", 503);

    const claimed = [];
    for (const stage of stageRows) {
      const result = await dependencies.portraitStages!.claim({
        ...actor, stage_id: stage.stage_id, idempotency_key: stageBatchIdempotencyKey,
      });
      if (!result.ok) {
        for (const previous of claimed) {
          const released = await dependencies.portraitStages!.release({
            ...actor, stage_id: previous.stage_id, idempotency_key: stageBatchIdempotencyKey,
          });
          if (!released.ok || released.data !== true) {
            console.error("[direct-entry] partially claimed worker document stage release failed");
          }
        }
        if (result.kind === "denied") return fail("ENTRY_NOT_FOUND", 404);
        if (result.kind === "conflict") return fail("DOCUMENT_VERSION_CONFLICT", 409);
        return fail(result.kind === "invalid" ? "DOCUMENT_REQUEST_INVALID" : "PORTRAIT_STAGE_UNAVAILABLE",
          result.kind === "invalid" ? 400 : 503);
      }
      if (result.data.document_type !== stage.document_type) {
        const released = await dependencies.portraitStages!.release({
          ...actor, stage_id: stage.stage_id, idempotency_key: stageBatchIdempotencyKey,
        });
        if (!released.ok || released.data !== true) {
          console.error("[direct-entry] mismatched worker document stage release failed");
        }
        return fail("DOCUMENT_REQUEST_INVALID", 400);
      }
      claimed.push({ ...stage, data: result.data });
    }

    const stripStage = <T extends {
      portrait_stage_id?: string;
      document_stage_ids?: Partial<Record<"CCCD_FRONT" | "CCCD_BACK" | "EMPLOYMENT_CONTRACT", string>>;
    }>(row: T): Omit<T, "portrait_stage_id" | "document_stage_ids"> => {
      const clean = { ...row };
      delete clean.portrait_stage_id;
      delete clean.document_stage_ids;
      return clean;
    };
    const payload: FullProfilePayload = stageRows.length === 0
      ? parsed.payload
      : parsed.payload.contract_version === "worker-profile/1.0"
        ? {
          contract_version: parsed.payload.contract_version,
          rows: parsed.payload.rows.map(stripStage),
        }
        : {
          contract_version: parsed.payload.contract_version,
          rows: parsed.payload.rows.map(stripStage),
        };
    const batchInput = {
      auth_subject: session.actor.actor.auth_subject,
      app_user_id: session.actor.actor.app_user_id,
      payload,
      idempotency_key: stageBatchIdempotencyKey,
    };
    const result = stageRows.length > 0
      ? await dependencies.repository.createFullProfileBatchWithPortraitStages!({
        ...batchInput,
        portrait_stage_ids: stageRows.map(({ stage_id }) => stage_id),
      })
      : await dependencies.repository.createFullProfileBatch(batchInput);
    if (!result.ok) {
      if (result.kind !== "unavailable" && claimed.length > 0) {
        for (const stage of claimed) {
          try {
            await reconcileRejectedPortraitStage(
              stage.stage_id, stageBatchIdempotencyKey, actor, dependencies,
            );
          } catch {
            console.error("[direct-entry] rejected stage reconciliation threw");
          }
        }
      }
      if (result.kind === "conflict") return fail("IDEMPOTENCY_CONFLICT", 409);
      if (result.kind === "denied") return fail("ACTOR_DENIED", 403);
      if (result.kind === "invalid") {
        const code = result.code && SAFE_CLIENT_CODES.has(result.code)
          ? result.code
          : "BATCH_INVALID";
        return fail(code, 400);
      }
      console.error("[direct-entry] full-profile batch unavailable");
      return fail("BATCH_UNAVAILABLE", 500);
    }
    const expectedYears =
      parsed.payload.contract_version === "worker-profile/1.1" ||
      parsed.payload.contract_version === "worker-profile/1.2"
        ? parsed.payload.rows.map((row) => row.first_work_date.slice(0, 4))
        : undefined;
    const projection = projectResult(result.data, parsed.payload.rows.length, expectedYears);
    if (!projection) {
      console.error("[direct-entry] full-profile batch returned malformed projection");
      return fail("BATCH_UNAVAILABLE", 500);
    }
    try {
      for (const stage of claimed) {
        const claimedStage = stage.data;
        const entryId = projection.entry_ids[stage.index];
        if (claimedStage.document_type !== stage.document_type) {
          console.error("[direct-entry] worker document stage type mismatch");
          return fail("IDEMPOTENCY_CONFLICT", 409);
        }
        if (claimedStage.status === "ATTACHED") {
          if (claimedStage.entry_id !== entryId || !claimedStage.document_id) {
            return fail("IDEMPOTENCY_CONFLICT", 409);
          }
          await dependencies.documentStorage!.deleteEnrollmentPortraitStage(stage.stage_id);
          continue;
        }

        const stagedBytes = await dependencies.documentStorage!.readEnrollmentPortraitStage(stage.stage_id);
        if (!stagedBytes || stagedBytes.byteLength !== claimedStage.size_bytes ||
            sha256Hex(stagedBytes) !== claimedStage.checksum_sha256 ||
            !inspectDocumentContent({
              document_type: claimedStage.document_type,
              mime_type: claimedStage.mime_type,
              bytes: stagedBytes,
            }).ok) {
          console.error("[direct-entry] portrait stage integrity check failed");
          return fail("PORTRAIT_PROMOTION_PENDING", 503);
        }

        const entry = await dependencies.documentRepository!.readEntry({
          ...actor, entry_id: entryId,
        });
        if (!entry.ok || typeof entry.data !== "object" || entry.data === null ||
            !("version" in entry.data) || typeof entry.data.version !== "number") {
          console.error("[direct-entry] portrait enrollment entry lookup unavailable");
          return fail("PORTRAIT_PROMOTION_PENDING", 503);
        }
        const reservation = await dependencies.documentRepository!.reserveDocumentUpload({
          ...actor,
          entry_id: entryId,
          expected_entry_version: entry.data.version,
          document_type: claimedStage.document_type,
          idempotency_key: stage.stage_id,
          size_bytes: claimedStage.size_bytes,
          mime_type: claimedStage.mime_type,
          reason: null,
        });
        if (!reservation.ok) return fail("PORTRAIT_PROMOTION_PENDING", 503);
        if (reservation.data.upload_status === "QUEUED") {
          await dependencies.documentStorage!.copyEnrollmentPortraitStage({
            stage_id: stage.stage_id,
            storage_key: reservation.data.storage_key,
            mime_type: claimedStage.mime_type,
          });
          const finalizeRequest = new Request("https://direct-entry.internal/api/direct-entry", {
            method: "POST",
            headers: {
              origin: "https://direct-entry.internal",
              host: "direct-entry.internal",
              "content-type": "application/json",
              "idempotency-key": stage.stage_id,
            },
            body: JSON.stringify({ expected_entry_version: reservation.data.entry_version }),
          });
          const finalized = await finalizeDirectEntryDocument(
            finalizeRequest, entryId, reservation.data.document_id, "true", {
              resolveSession: dependencies.resolveSession,
              repository: dependencies.documentRepository!,
              storage: dependencies.documentStorage!,
              onCccdImageFinalized: dependencies.onCccdImageFinalized,
            },
          );
          if (!finalized.ok) {
            console.error("[direct-entry] portrait enrollment finalization pending");
            return fail("PORTRAIT_PROMOTION_PENDING", 503);
          }
        } else if (reservation.data.upload_status !== "READY" ||
            reservation.data.validation_status !== "VALIDATED") {
          return fail("PORTRAIT_PROMOTION_PENDING", 503);
        }
        const completed = await dependencies.portraitStages!.complete({
          ...actor,
          stage_id: stage.stage_id,
          idempotency_key: stageBatchIdempotencyKey,
          entry_id: entryId,
          document_id: reservation.data.document_id,
        });
        if (!completed.ok) {
          console.error("[direct-entry] portrait stage completion pending");
          return fail("PORTRAIT_PROMOTION_PENDING", 503);
        }
        await dependencies.documentStorage!.deleteEnrollmentPortraitStage(stage.stage_id);
      }
    } catch {
      console.error("[direct-entry] post-commit stage promotion failed");
      return fail("PORTRAIT_PROMOTION_PENDING", 503);
    }
    const { replayed, ...safeResult } = projection;
    return respond({ ok: true, ...safeResult }, replayed ? 200 : 201);
  } catch {
    console.error("[direct-entry] full-profile batch request failed");
    return fail("BATCH_UNAVAILABLE", 500);
  }
}
