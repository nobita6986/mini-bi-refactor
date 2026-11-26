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
  attachmentDisposition,
  type DocumentEnvironment,
} from "../direct-entry/document-r2-contract.ts";
import {
  createR2S3Client,
  loadR2Config,
  type R2Dependencies,
  type SignedDocumentUrl,
} from "../direct-entry/r2-document-storage.ts";
import {
  VENDOR_FINANCE_EVIDENCE_DOWNLOAD_URL_TTL_SECONDS,
  VENDOR_FINANCE_EVIDENCE_MAX_BYTES,
  VENDOR_FINANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS,
  type VendorFinanceEvidenceMimeType,
} from "./vendor-finance-contract.ts";

const VFIN_EVIDENCE_STORAGE_KEY_REGEX = new RegExp(
  "^vfin-01/(?:entry|reconciliation)/" +
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/" +
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  "i",
);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_IEND_TRAILER = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] as const;
const EMBEDDED_MARKUP_NEEDLES = ["<script", "<html", "<?php", "<svg", "<!doctype"] as const;

export function isOpaqueVfinEvidenceStorageKey(value: unknown): value is string {
  return typeof value === "string" && VFIN_EVIDENCE_STORAGE_KEY_REGEX.test(value);
}

export function vfinStagingObjectKey(
  environment: DocumentEnvironment,
  storageKey: string,
): string {
  if (!isOpaqueVfinEvidenceStorageKey(storageKey)) {
    throw new Error("vfin evidence storage key invalid");
  }
  return `${environment}/staging/${storageKey}`;
}

export function vfinFinalObjectKey(
  environment: DocumentEnvironment,
  storageKey: string,
): string {
  if (!isOpaqueVfinEvidenceStorageKey(storageKey)) {
    throw new Error("vfin evidence storage key invalid");
  }
  return `${environment}/final/${storageKey}`;
}

export function vfinGenericDownloadName(mimeType: VendorFinanceEvidenceMimeType): string {
  return mimeType === "image/png" ? "vfin-evidence.png" : "vfin-evidence.jpg";
}

function containsEmbeddedMarkup(bytes: Uint8Array): boolean {
  const lowered = Buffer.from(bytes).toString("latin1").toLowerCase();
  return EMBEDDED_MARKUP_NEEDLES.some((needle) => lowered.includes(needle));
}

export type VfinEvidenceInspectionResult =
  | { ok: true; checksum_sha256: string }
  | {
      ok: false;
      code:
        | "VENDOR_FINANCE_EVIDENCE_MIME_INVALID"
        | "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID"
        | "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID"
        | "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID";
    };

/**
 * Inspects staged R2 evidence bytes:
 *  - Only JPEG (`image/jpeg`) and PNG (`image/png`) allowed.
 *  - Exact byte length match (`1..10_485_760`).
 *  - Magic header + structural trailer (`FFD9` for JPEG, `IEND`+CRC for PNG).
 *  - Rejects polyglot files containing HTML/SVG/script/PHP markup.
 *  - Exact lowercase SHA-256 hex match against reserved `checksum_sha256`.
 */
export function inspectVfinEvidenceContent(input: {
  mime_type: string;
  expected_size_bytes: number;
  expected_checksum_sha256: string;
  bytes: Uint8Array;
}): VfinEvidenceInspectionResult {
  if (input.mime_type !== "image/jpeg" && input.mime_type !== "image/png") {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_MIME_INVALID" };
  }

  if (
    !Number.isSafeInteger(input.expected_size_bytes) ||
    input.expected_size_bytes < 1 ||
    input.expected_size_bytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES ||
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > VENDOR_FINANCE_EVIDENCE_MAX_BYTES ||
    input.bytes.byteLength !== input.expected_size_bytes
  ) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID" };
  }

  const { bytes } = input;
  if (containsEmbeddedMarkup(bytes)) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID" };
  }

  if (input.mime_type === "image/png") {
    if (
      bytes.byteLength < PNG_MAGIC.length + PNG_IEND_TRAILER.length ||
      !PNG_MAGIC.every((b, idx) => bytes[idx] === b)
    ) {
      return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID" };
    }
    const trailerOffset = bytes.byteLength - PNG_IEND_TRAILER.length;
    if (!PNG_IEND_TRAILER.every((b, idx) => bytes[trailerOffset + idx] === b)) {
      return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID" };
    }
  } else {
    if (
      bytes.byteLength < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff
    ) {
      return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID" };
    }
    let last = bytes.byteLength - 1;
    while (last > 0 && bytes[last] === 0x00) {
      last -= 1;
    }
    if (last < 3 || bytes[last - 1] !== 0xff || bytes[last] !== 0xd9) {
      return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID" };
    }
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== input.expected_checksum_sha256.trim().toLowerCase()) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID" };
  }

  return { ok: true, checksum_sha256: actualSha256 };
}

export type StagedEvidenceReadResult =
  | { kind: "missing" }
  | { kind: "too-large" }
  | { kind: "found"; bytes: Uint8Array };

export type VendorFinanceEvidenceStorage = {
  available(): boolean;
  createUploadUrl(input: {
    storage_key: string;
    mime_type: VendorFinanceEvidenceMimeType;
    size_bytes: number;
  }): Promise<SignedDocumentUrl>;
  readStagedBounded(storageKey: string): Promise<StagedEvidenceReadResult>;
  promoteStagedToFinal(input: {
    storage_key: string;
    mime_type: VendorFinanceEvidenceMimeType;
  }): Promise<void>;
  deleteStaged(storageKey: string): Promise<void>;
  deleteFinal(storageKey: string): Promise<void>;
  createDownloadUrl(input: {
    storage_key: string;
    mime_type: VendorFinanceEvidenceMimeType;
  }): Promise<{ url: string; expires_at: string }>;
};

export const unavailableVendorFinanceEvidenceStorage: VendorFinanceEvidenceStorage = {
  available: () => false,
  async createUploadUrl() {
    throw new Error("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  },
  async readStagedBounded() {
    throw new Error("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  },
  async promoteStagedToFinal() {
    throw new Error("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  },
  async deleteStaged() {
    throw new Error("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  },
  async deleteFinal() {
    throw new Error("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  },
  async createDownloadUrl() {
    throw new Error("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  },
};

type Send = { send(command: unknown): Promise<unknown> };

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
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

  throw new Error("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
}

export function createR2VendorFinanceEvidenceStorage(
  env: Record<string, string | undefined> = process.env,
  dependencies: R2Dependencies = {},
): VendorFinanceEvidenceStorage {
  const config = loadR2Config(env);
  if (!config) {
    return unavailableVendorFinanceEvidenceStorage;
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

  const deleteStagedInternal = async (storageKey: string): Promise<void> => {
    try {
      await getClient().send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: vfinStagingObjectKey(config.environment, storageKey),
        }),
      );
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
  };

  const deleteFinalInternal = async (storageKey: string): Promise<void> => {
    try {
      await getClient().send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: vfinFinalObjectKey(config.environment, storageKey),
        }),
      );
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
  };

  return {
    available: () => true,

    async createUploadUrl(input) {
      if (
        !Number.isSafeInteger(input.size_bytes) ||
        input.size_bytes < 1 ||
        input.size_bytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES
      ) {
        throw new Error("VENDOR_FINANCE_EVIDENCE_SIZE_INVALID");
      }
      const url = await presign(
        getClient(),
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: vfinStagingObjectKey(config.environment, input.storage_key),
          ContentType: input.mime_type,
          ContentLength: input.size_bytes,
        }),
        {
          expiresIn: VENDOR_FINANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS,
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
      return {
        url,
        expires_at: expiryIso(VENDOR_FINANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS),
        headers: { "Content-Type": input.mime_type },
      };
    },

    async readStagedBounded(storageKey) {
      try {
        const result = (await getClient().send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: vfinStagingObjectKey(config.environment, storageKey),
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
          throw new Error("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
        }
        if (result.ContentLength > VENDOR_FINANCE_EVIDENCE_MAX_BYTES) {
          if (typeof result.Body.destroy === "function") {
            result.Body.destroy();
          }
          return { kind: "too-large" };
        }

        const bounded = await readSdkBodyBounded(
          result.Body,
          VENDOR_FINANCE_EVIDENCE_MAX_BYTES,
        );
        if (bounded.kind === "too-large") {
          return bounded;
        }
        if (bounded.bytes.byteLength !== result.ContentLength) {
          throw new Error("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
        }
        return bounded;
      } catch (error) {
        if (isNotFoundError(error)) {
          return { kind: "missing" };
        }
        throw error;
      }
    },

    async promoteStagedToFinal(input) {
      const stagedKey = vfinStagingObjectKey(config.environment, input.storage_key);
      const finalKey = vfinFinalObjectKey(config.environment, input.storage_key);
      // Copy staged -> final ONLY; staged object MUST stay intact until DB commits `READY`
      // so transient DB errors on finalize remain safely retryable.
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
      await deleteStagedInternal(storageKey);
    },

    async deleteFinal(storageKey) {
      await deleteFinalInternal(storageKey);
    },

    async createDownloadUrl(input) {
      const url = await presign(
        getClient(),
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: vfinFinalObjectKey(config.environment, input.storage_key),
          ResponseContentDisposition: attachmentDisposition(
            vfinGenericDownloadName(input.mime_type),
          ),
          ResponseContentType: input.mime_type,
        }),
        { expiresIn: VENDOR_FINANCE_EVIDENCE_DOWNLOAD_URL_TTL_SECONDS },
      );
      return {
        url,
        expires_at: expiryIso(VENDOR_FINANCE_EVIDENCE_DOWNLOAD_URL_TTL_SECONDS),
      };
    },
  };
}
