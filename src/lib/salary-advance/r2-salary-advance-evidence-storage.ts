import "server-only";

import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  finalObjectKey,
  type DocumentEnvironment,
} from "../direct-entry/document-r2-contract.ts";
import {
  createR2S3Client,
  loadR2Config,
  type R2Dependencies,
  type SignedDocumentUrl,
} from "../direct-entry/r2-document-storage.ts";
import {
  SALARY_ADVANCE_EVIDENCE_MAX_BYTES,
  SALARY_ADVANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS,
  type SalaryAdvanceEvidenceMimeType,
} from "./salary-advance-contract.ts";

const SALARY_ADVANCE_EVIDENCE_STORAGE_KEY_REGEX = new RegExp(
  "^salary-advance/requests/" +
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/evidence/" +
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  "i",
);

const WORKER_PORTRAIT_STORAGE_KEY_REGEX = new RegExp(
  "^p1\\.6/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/" +
    "WORKER_PORTRAIT/[1-9]\\d*/" +
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  "i",
);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_IEND_TRAILER = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] as const;
const EMBEDDED_MARKUP_NEEDLES = [
  "<script",
  "<html",
  "<?php",
  "<svg",
  "<!doctype",
] as const;

export function buildSalaryAdvanceEvidenceStorageKey(
  requestId: string,
  uploadId: string,
): string {
  const key = `salary-advance/requests/${requestId.trim().toLowerCase()}/evidence/${uploadId.trim().toLowerCase()}`;
  if (!isOpaqueSalaryAdvanceEvidenceStorageKey(key)) {
    throw new Error("salary advance evidence storage key invalid");
  }
  return key;
}

export function isOpaqueSalaryAdvanceEvidenceStorageKey(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    SALARY_ADVANCE_EVIDENCE_STORAGE_KEY_REGEX.test(value)
  );
}

export function isOpaqueWorkerPortraitStorageKey(
  value: unknown,
): value is string {
  return (
    typeof value === "string" && WORKER_PORTRAIT_STORAGE_KEY_REGEX.test(value)
  );
}

export function salaryAdvanceStagingObjectKey(
  environment: DocumentEnvironment,
  storageKey: string,
): string {
  if (!isOpaqueSalaryAdvanceEvidenceStorageKey(storageKey)) {
    throw new Error("salary advance evidence storage key invalid");
  }
  return `${environment}/staging/${storageKey}`;
}

export function salaryAdvanceFinalObjectKey(
  environment: DocumentEnvironment,
  storageKey: string,
): string {
  if (!isOpaqueSalaryAdvanceEvidenceStorageKey(storageKey)) {
    throw new Error("salary advance evidence storage key invalid");
  }
  return `${environment}/final/${storageKey}`;
}

function containsEmbeddedMarkup(bytes: Uint8Array): boolean {
  const lowered = Buffer.from(bytes).toString("latin1").toLowerCase();
  return EMBEDDED_MARKUP_NEEDLES.some((needle) => lowered.includes(needle));
}

export type SalaryAdvanceEvidenceInspectionResult =
  | { ok: true; checksum_sha256: string }
  | {
      ok: false;
      code:
        | "SALARY_ADVANCE_EVIDENCE_MIME_INVALID"
        | "SALARY_ADVANCE_EVIDENCE_SIZE_INVALID"
        | "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID"
        | "SALARY_ADVANCE_EVIDENCE_CHECKSUM_INVALID";
    };

/**
 * Inspects salary advance evidence or portrait bytes:
 *  - Only JPEG (`image/jpeg`) and PNG (`image/png`) allowed.
 *  - Exact byte length match (`1..10_485_760`).
 *  - Magic header + structural trailer (`FFD9` for JPEG, `IEND`+CRC for PNG).
 *  - Rejects polyglot files containing HTML/SVG/script/PHP markup.
 *  - Exact lowercase SHA-256 hex match against expected `checksum_sha256`.
 */
export function inspectSalaryAdvanceEvidenceContent(input: {
  mime_type: string;
  expected_size_bytes: number;
  expected_checksum_sha256: string;
  bytes: Uint8Array;
}): SalaryAdvanceEvidenceInspectionResult {
  if (input.mime_type !== "image/jpeg" && input.mime_type !== "image/png") {
    return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_MIME_INVALID" };
  }

  if (
    !Number.isSafeInteger(input.expected_size_bytes) ||
    input.expected_size_bytes < 1 ||
    input.expected_size_bytes > SALARY_ADVANCE_EVIDENCE_MAX_BYTES ||
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > SALARY_ADVANCE_EVIDENCE_MAX_BYTES ||
    input.bytes.byteLength !== input.expected_size_bytes
  ) {
    return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_SIZE_INVALID" };
  }

  const { bytes } = input;
  if (containsEmbeddedMarkup(bytes)) {
    return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID" };
  }

  if (input.mime_type === "image/png") {
    if (
      bytes.byteLength < PNG_MAGIC.length + PNG_IEND_TRAILER.length ||
      !PNG_MAGIC.every((b, idx) => bytes[idx] === b)
    ) {
      return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID" };
    }
    const trailerOffset = bytes.byteLength - PNG_IEND_TRAILER.length;
    if (!PNG_IEND_TRAILER.every((b, idx) => bytes[trailerOffset + idx] === b)) {
      return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID" };
    }
  } else {
    if (
      bytes.byteLength < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff
    ) {
      return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID" };
    }
    let last = bytes.byteLength - 1;
    while (last > 0 && bytes[last] === 0x00) {
      last -= 1;
    }
    if (last < 3 || bytes[last - 1] !== 0xff || bytes[last] !== 0xd9) {
      return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID" };
    }
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== input.expected_checksum_sha256.trim().toLowerCase()) {
    return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_CHECKSUM_INVALID" };
  }

  return { ok: true, checksum_sha256: actualSha256 };
}

export type BoundedObjectReadResult =
  | { kind: "missing" }
  | { kind: "too-large" }
  | { kind: "found"; bytes: Uint8Array };

/**
 * Private R2 storage adapter for Salary Advance evidence and worker portrait streaming.
 * Note: Intentionally omits any `deleteFinal` method so committed evidence objects
 * in `${environment}/final/...` can never be deleted by race/cleanup paths.
 */
export type SalaryAdvanceEvidenceStorage = {
  available(): boolean;
  createUploadUrl(input: {
    storage_key: string;
    mime_type: SalaryAdvanceEvidenceMimeType;
    size_bytes: number;
  }): Promise<SignedDocumentUrl>;
  readStagedBounded(storageKey: string): Promise<BoundedObjectReadResult>;
  promoteStagedToFinal(input: {
    storage_key: string;
    mime_type: SalaryAdvanceEvidenceMimeType;
  }): Promise<void>;
  deleteStaged(storageKey: string): Promise<void>;
  readFinalBounded(storageKey: string): Promise<BoundedObjectReadResult>;
  readWorkerPortraitFinalBounded(
    storageKey: string,
  ): Promise<BoundedObjectReadResult>;
};

export const unavailableSalaryAdvanceEvidenceStorage: SalaryAdvanceEvidenceStorage =
  {
    available: () => false,
    async createUploadUrl() {
      throw new Error("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    },
    async readStagedBounded() {
      throw new Error("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    },
    async promoteStagedToFinal() {
      throw new Error("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    },
    async deleteStaged() {
      throw new Error("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    },
    async readFinalBounded() {
      throw new Error("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    },
    async readWorkerPortraitFinalBounded() {
      throw new Error("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    },
  };

type Send = { send(command: unknown): Promise<unknown> };

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function readSdkBodyBounded(
  body: {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
    transformToByteArray?: () => Promise<Uint8Array>;
  },
  maxBytes: number,
): Promise<{ kind: "too-large" } | { kind: "found"; bytes: Uint8Array }> {
  if (typeof body.transformToWebStream === "function") {
    const stream = body.transformToWebStream();
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return { kind: "too-large" };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: "found", bytes: combined };
  }

  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > maxBytes) {
      return { kind: "too-large" };
    }
    return { kind: "found", bytes };
  }

  throw new Error("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
}

async function readKeyBounded(
  client: Send,
  bucket: string,
  objectKey: string,
): Promise<BoundedObjectReadResult> {
  try {
    const result = (await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey,
      }),
    )) as {
      ContentLength?: number;
      Body?: {
        transformToWebStream?: () => ReadableStream<Uint8Array>;
        transformToByteArray?: () => Promise<Uint8Array>;
        destroy?: () => void;
      };
    };

    if (!result.Body || typeof result.ContentLength !== "number") {
      throw new Error("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    }
    if (result.ContentLength > SALARY_ADVANCE_EVIDENCE_MAX_BYTES) {
      if (typeof result.Body.destroy === "function") {
        result.Body.destroy();
      }
      return { kind: "too-large" };
    }

    const bounded = await readSdkBodyBounded(
      result.Body,
      SALARY_ADVANCE_EVIDENCE_MAX_BYTES,
    );
    if (bounded.kind === "too-large") {
      return bounded;
    }
    if (bounded.bytes.byteLength !== result.ContentLength) {
      throw new Error("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    }
    return bounded;
  } catch (error) {
    if (isNotFoundError(error)) {
      return { kind: "missing" };
    }
    throw error;
  }
}

export function createR2SalaryAdvanceEvidenceStorage(
  env: Record<string, string | undefined> = process.env,
  dependencies: R2Dependencies = {},
): SalaryAdvanceEvidenceStorage {
  const config = loadR2Config(env);
  if (!config) {
    return unavailableSalaryAdvanceEvidenceStorage;
  }

  const now = dependencies.now ?? Date.now;
  let client: Send | undefined = dependencies.client;
  const presign =
    dependencies.presign ??
    ((signer, command, options) =>
      getSignedUrl(signer as S3Client, command as never, options));

  const getClient = (): Send => {
    client ??= createR2S3Client(config) as unknown as Send;
    return client;
  };

  const expiryIso = (ttlSeconds: number) =>
    new Date(now() + ttlSeconds * 1000).toISOString();

  return {
    available: () => true,

    async createUploadUrl(input) {
      if (
        !Number.isSafeInteger(input.size_bytes) ||
        input.size_bytes < 1 ||
        input.size_bytes > SALARY_ADVANCE_EVIDENCE_MAX_BYTES
      ) {
        throw new Error("SALARY_ADVANCE_EVIDENCE_SIZE_INVALID");
      }
      const url = await presign(
        getClient(),
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: salaryAdvanceStagingObjectKey(
            config.environment,
            input.storage_key,
          ),
          ContentType: input.mime_type,
          ContentLength: input.size_bytes,
        }),
        {
          expiresIn: SALARY_ADVANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS,
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
      return {
        url,
        expires_at: expiryIso(SALARY_ADVANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS),
        headers: { "Content-Type": input.mime_type },
      };
    },

    async readStagedBounded(storageKey) {
      return readKeyBounded(
        getClient(),
        config.bucket,
        salaryAdvanceStagingObjectKey(config.environment, storageKey),
      );
    },

    async promoteStagedToFinal(input) {
      const stagedKey = salaryAdvanceStagingObjectKey(
        config.environment,
        input.storage_key,
      );
      const finalKey = salaryAdvanceFinalObjectKey(
        config.environment,
        input.storage_key,
      );
      await getClient().send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          Key: finalKey,
          CopySource: `${config.bucket}/${stagedKey}`,
          ContentType: input.mime_type,
          MetadataDirective: "REPLACE",
        }),
      );
    },

    async deleteStaged(storageKey) {
      try {
        await getClient().send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: salaryAdvanceStagingObjectKey(config.environment, storageKey),
          }),
        );
      } catch (error) {
        if (isNotFoundError(error)) return;
        throw error;
      }
    },

    async readFinalBounded(storageKey) {
      return readKeyBounded(
        getClient(),
        config.bucket,
        salaryAdvanceFinalObjectKey(config.environment, storageKey),
      );
    },

    async readWorkerPortraitFinalBounded(storageKey) {
      if (!isOpaqueWorkerPortraitStorageKey(storageKey)) {
        throw new Error("worker portrait storage key invalid");
      }
      return readKeyBounded(
        getClient(),
        config.bucket,
        finalObjectKey(config.environment, storageKey),
      );
    },
  };
}
