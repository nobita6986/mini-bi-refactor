import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import type { DocumentEnvironment } from "../direct-entry/document-r2-contract.ts";
import {
  createR2S3Client,
  loadR2Config,
  type R2Config,
} from "../direct-entry/r2-document-storage.ts";
import { isUuid } from "../http/direct-entry-api-guard.ts";
import {
  BULLETIN_ALLOWED_MIME_TYPES,
  BULLETIN_MAX_ATTACHMENT_BYTES,
  BULLETIN_MIME_EXTENSIONS,
  BulletinValidationError,
  type BulletinAttachmentKind,
  type BulletinAttachmentMimeType,
} from "./contract.ts";

export type BulletinInspectedAttachment = {
  kind: BulletinAttachmentKind;
  mime_type: BulletinAttachmentMimeType;
  ext: string;
  file_name: string;
  file_size_bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  page_count: number | null;
};

export type BulletinStoredObject = {
  bytes: Uint8Array;
  content_type: string | null;
  content_length: number;
};

export type BulletinStorage = {
  available(): boolean;
  environment(): DocumentEnvironment | null;
  buildObjectKey(
    bulletinId: string,
    attachmentId: string,
    mimeType: BulletinAttachmentMimeType,
  ): string;
  putAttachment(input: {
    storage_key: string;
    mime_type: BulletinAttachmentMimeType;
    bytes: Uint8Array;
  }): Promise<void>;
  getAttachment(storageKey: string): Promise<BulletinStoredObject | null>;
  deleteAttachment(storageKey: string): Promise<void>;
};

type S3Send = { send(command: unknown): Promise<unknown> };

export type BulletinStorageDependencies = {
  client?: S3Send;
  config?: R2Config | null;
};

const EMBEDDED_MARKUP_NEEDLES = [
  "<script",
  "<html",
  "<?php",
  "<svg",
  "<!doctype",
] as const;

const EXTENSION_TO_MIME: Readonly<Record<string, BulletinAttachmentMimeType>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

const SINGLE_LINE_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/g;

function detectMagicMimeType(bytes: Uint8Array): BulletinAttachmentMimeType | null {
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "image/webp";
  }

  if (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  ) {
    return "application/pdf";
  }

  return null;
}

function containsEmbeddedMarkup(bytes: Uint8Array, limit: number): boolean {
  const sample = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, limit)))
    .toString("latin1")
    .toLowerCase();
  return EMBEDDED_MARKUP_NEEDLES.some((needle) => sample.includes(needle));
}

export function sanitizeBulletinFileName(
  rawFileName: string | null | undefined,
  mimeType: BulletinAttachmentMimeType,
): string {
  const ext = BULLETIN_MIME_EXTENSIONS[mimeType];
  const base = rawFileName
    ? path.posix.basename(rawFileName.replaceAll("\\", "/"))
    : "";
  const cleaned = base
    .replace(SINGLE_LINE_CONTROL_CHAR_PATTERN, "")
    .replace(/["/;]/g, "_")
    .trim();

  if (cleaned.length === 0) {
    return `attachment.${ext}`;
  }
  if (cleaned.length <= 255) {
    return cleaned;
  }
  const suffix = `.${ext}`;
  return `${cleaned.slice(0, Math.max(1, 255 - suffix.length))}${suffix}`;
}

export function countPdfPagesFromBuffer(bytes: Uint8Array): number | null {
  const latin1 = Buffer.from(bytes).toString("latin1");

  const pageMatches = latin1.match(/\/Type\s*\/Page(?![sA-Za-z])/g);
  if (pageMatches && pageMatches.length > 0) {
    return pageMatches.length;
  }

  let maxCount = 0;
  for (const match of latin1.matchAll(/\/Count\s+(\d+)/g)) {
    const parsed = Number(match[1]);
    if (Number.isSafeInteger(parsed) && parsed > maxCount) {
      maxCount = parsed;
    }
  }
  return maxCount > 0 ? maxCount : null;
}

export async function inspectBulletinAttachment(input: {
  bytes: Uint8Array;
  fileName?: string | null;
  declaredMimeType?: string | null;
}): Promise<BulletinInspectedAttachment> {
  const buf = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);

  if (buf.byteLength === 0) {
    throw new BulletinValidationError(
      "BULLETIN_ATTACHMENT_INVALID",
      "Attachment file cannot be empty",
      400,
    );
  }
  if (buf.byteLength > BULLETIN_MAX_ATTACHMENT_BYTES) {
    throw new BulletinValidationError(
      "BULLETIN_ATTACHMENT_TOO_LARGE",
      "Attachment exceeds 15 MB limit",
      413,
    );
  }

  const detectedMime = detectMagicMimeType(buf);
  if (!detectedMime) {
    throw new BulletinValidationError(
      "BULLETIN_ATTACHMENT_INVALID",
      "Unsupported or unrecognized attachment format",
      400,
    );
  }

  const declared = input.declaredMimeType?.trim().toLowerCase() ?? "";
  if (declared !== "") {
    if (
      !(BULLETIN_ALLOWED_MIME_TYPES as readonly string[]).includes(declared) ||
      declared !== detectedMime
    ) {
      throw new BulletinValidationError(
        "BULLETIN_ATTACHMENT_INVALID",
        "Attachment MIME type mismatch",
        400,
      );
    }
  }

  if (input.fileName) {
    const ext = path.posix.extname(input.fileName.trim()).toLowerCase();
    if (ext !== "") {
      const mapped = EXTENSION_TO_MIME[ext];
      if (!mapped || mapped !== detectedMime) {
        throw new BulletinValidationError(
          "BULLETIN_ATTACHMENT_INVALID",
          "Attachment file extension mismatch",
          400,
        );
      }
    }
  }

  const markupScanLimit =
    detectedMime === "application/pdf" ? 1024 : buf.byteLength;
  if (containsEmbeddedMarkup(buf, markupScanLimit)) {
    throw new BulletinValidationError(
      "BULLETIN_ATTACHMENT_INVALID",
      "Embedded markup is not allowed in attachments",
      400,
    );
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const file_name = sanitizeBulletinFileName(input.fileName, detectedMime);
  const ext = BULLETIN_MIME_EXTENSIONS[detectedMime];

  if (detectedMime === "application/pdf") {
    return {
      kind: "PDF",
      mime_type: detectedMime,
      ext,
      file_name,
      file_size_bytes: buf.byteLength,
      sha256,
      width: null,
      height: null,
      page_count: countPdfPagesFromBuffer(buf),
    };
  }

  let width: number | null = null;
  let height: number | null = null;
  try {
    const metadata = await sharp(buf, {
      failOn: "error",
      limitInputPixels: 40_000_000,
    }).metadata();
    const expectedFormat =
      detectedMime === "image/jpeg"
        ? "jpeg"
        : detectedMime === "image/png"
          ? "png"
          : "webp";
    if (metadata.format && metadata.format !== expectedFormat) {
      throw new BulletinValidationError(
        "BULLETIN_ATTACHMENT_INVALID",
        "Image format mismatch",
        400,
      );
    }
    if (
      typeof metadata.width === "number" &&
      Number.isSafeInteger(metadata.width) &&
      metadata.width > 0
    ) {
      width = metadata.width;
    }
    if (
      typeof metadata.height === "number" &&
      Number.isSafeInteger(metadata.height) &&
      metadata.height > 0
    ) {
      height = metadata.height;
    }
  } catch (error) {
    if (error instanceof BulletinValidationError) throw error;
    width = null;
    height = null;
  }

  return {
    kind: "IMAGE",
    mime_type: detectedMime,
    ext,
    file_name,
    file_size_bytes: buf.byteLength,
    sha256,
    width,
    height,
    page_count: null,
  };
}

export function buildBulletinStorageKey(
  environment: DocumentEnvironment,
  bulletinId: string,
  attachmentId: string,
  mimeType: BulletinAttachmentMimeType,
): string {
  if (!isUuid(bulletinId) || !isUuid(attachmentId)) {
    throw new Error("Invalid bulletin or attachment UUID for storage key");
  }
  const ext = BULLETIN_MIME_EXTENSIONS[mimeType];
  return `${environment}/hr-bulletins/${bulletinId.toLowerCase()}/${attachmentId.toLowerCase()}.${ext}`;
}

function isS3NotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    value.name === "NotFound" ||
    value.name === "NoSuchKey" ||
    value.$metadata?.httpStatusCode === 404
  );
}

export const unavailableBulletinStorage: BulletinStorage = {
  available: () => false,
  environment: () => null,
  buildObjectKey() {
    throw new Error("BULLETIN_STORAGE_UNAVAILABLE");
  },
  async putAttachment() {
    throw new Error("BULLETIN_STORAGE_UNAVAILABLE");
  },
  async getAttachment() {
    throw new Error("BULLETIN_STORAGE_UNAVAILABLE");
  },
  async deleteAttachment() {
    throw new Error("BULLETIN_STORAGE_UNAVAILABLE");
  },
};

export function createBulletinStorage(
  env: Record<string, string | undefined> = process.env,
  dependencies: BulletinStorageDependencies = {},
): BulletinStorage {
  const config =
    dependencies.config !== undefined ? dependencies.config : loadR2Config(env);
  if (!config) {
    return unavailableBulletinStorage;
  }

  let client: S3Send | undefined = dependencies.client;
  const getClient = (): S3Send => {
    client ??= createR2S3Client(config) as unknown as S3Client as unknown as S3Send;
    return client;
  };

  return {
    available: () => true,
    environment: () => config.environment,
    buildObjectKey(bulletinId, attachmentId, mimeType) {
      return buildBulletinStorageKey(
        config.environment,
        bulletinId,
        attachmentId,
        mimeType,
      );
    },
    async putAttachment(input) {
      await getClient().send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.storage_key,
          Body: Buffer.from(input.bytes),
          ContentType: input.mime_type,
          ContentLength: input.bytes.byteLength,
        }),
      );
    },
    async getAttachment(storageKey) {
      try {
        const result = (await getClient().send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: storageKey,
          }),
        )) as {
          ContentLength?: number;
          ContentType?: string;
          Body?: { transformToByteArray(): Promise<Uint8Array> };
        };
        if (!result.Body) {
          throw new Error("BULLETIN_STORAGE_UNAVAILABLE");
        }
        if (
          typeof result.ContentLength === "number" &&
          (result.ContentLength < 1 ||
            result.ContentLength > BULLETIN_MAX_ATTACHMENT_BYTES)
        ) {
          throw new Error("BULLETIN_STORAGE_UNAVAILABLE");
        }
        const bytes = await result.Body.transformToByteArray();
        if (
          bytes.byteLength < 1 ||
          bytes.byteLength > BULLETIN_MAX_ATTACHMENT_BYTES ||
          (typeof result.ContentLength === "number" &&
            bytes.byteLength !== result.ContentLength)
        ) {
          throw new Error("BULLETIN_STORAGE_UNAVAILABLE");
        }
        return {
          bytes,
          content_type:
            typeof result.ContentType === "string" ? result.ContentType : null,
          content_length: bytes.byteLength,
        };
      } catch (error) {
        if (isS3NotFound(error)) return null;
        throw error;
      }
    },
    async deleteAttachment(storageKey) {
      await getClient().send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: storageKey,
        }),
      );
    },
  };
}
