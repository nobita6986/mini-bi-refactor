import "server-only";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { DirectEntryDocumentType } from "../contracts/direct-entry-v1.ts";
import {
  DOCUMENT_BUCKETS,
  DOCUMENT_DOWNLOAD_URL_TTL_SECONDS,
  DOCUMENT_MAX_UPLOAD_BYTES,
  DOCUMENT_UPLOAD_URL_TTL_SECONDS,
  attachmentDisposition,
  finalObjectKey,
  genericDownloadName,
  stagingObjectKey,
  type DocumentEnvironment,
  type DocumentMimeType,
} from "./document-r2-contract.ts";

export type ObjectStorageProvider = "cloudflare_r2" | "vpsttt";

export type R2Config = {
  provider: ObjectStorageProvider;
  accountId: string | null;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  environment: DocumentEnvironment;
};

export type StagedObjectHead =
  | { kind: "missing" }
  | { kind: "found"; size_bytes: number; content_type: string | null };

export type SignedDocumentUrl = {
  url: string;
  expires_at: string;
  headers: Record<string, string>;
};

// All methods throw on provider failure; callers map that to DOCUMENT_STORAGE_UNAVAILABLE.
export type DocumentObjectStorage = {
  available(): boolean;
  writeEnrollmentPortraitStage(input: {
    stage_id: string;
    mime_type: DocumentMimeType;
    bytes: Uint8Array;
  }): Promise<void>;
  readEnrollmentPortraitStage(stageId: string): Promise<Uint8Array | null>;
  copyEnrollmentPortraitStage(input: {
    stage_id: string;
    storage_key: string;
    mime_type: DocumentMimeType;
  }): Promise<void>;
  deleteEnrollmentPortraitStage(stageId: string): Promise<void>;
  createUploadUrl(input: {
    storage_key: string;
    mime_type: DocumentMimeType;
    size_bytes: number;
  }): Promise<SignedDocumentUrl>;
  headStaged(storageKey: string): Promise<StagedObjectHead>;
  readStaged(storageKey: string): Promise<Uint8Array | null>;
  writeStaged(input: {
    storage_key: string;
    mime_type: DocumentMimeType;
    bytes: Uint8Array;
  }): Promise<void>;
  readFinal(storageKey: string): Promise<Uint8Array | null>;
  promote(input: {
    storage_key: string;
    mime_type: DocumentMimeType;
    sanitized_bytes?: Uint8Array;
  }): Promise<void>;
  deleteStaged(storageKey: string): Promise<void>;
  deleteFinal(storageKey: string): Promise<void>;
  createDownloadUrl(input: {
    storage_key: string;
    mime_type: DocumentMimeType;
    document_type: DirectEntryDocumentType;
    version: number;
  }): Promise<SignedDocumentUrl>;
};

type Send = { send(command: unknown): Promise<unknown> };
type Presign = (
  client: Send,
  command: unknown,
  options: { expiresIn: number; signableHeaders?: Set<string> },
) => Promise<string>;

export type R2Dependencies = {
  client?: Send;
  presign?: Presign;
  now?: () => number;
};

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const ACCESS_KEY_ID = /^[A-Za-z0-9]{16,128}$/;
const SECRET_ACCESS_KEY = /^[A-Za-z0-9/+=_-]{16,256}$/;
const VPSTTT_REGION = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const VPSTTT_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4_HOST = /^\d+\.\d+\.\d+\.\d+$/;
const VPSTTT_ACCESS_KEY_ID = /^[A-Za-z0-9._-]{8,128}$/;
const VPSTTT_SECRET_ACCESS_KEY = /^[\x21-\x7e]{16,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function enrollmentPortraitStageKey(environment: DocumentEnvironment, stageId: string): string {
  if (!UUID.test(stageId)) throw new Error("portrait stage id invalid");
  return `${environment}/enrollment-staging/${stageId}`;
}

export function resolveDocumentEnvironment(
  env: Record<string, string | undefined>,
): DocumentEnvironment | null {
  const configured = env.DOCUMENT_STORAGE_ENVIRONMENT;
  if (configured !== undefined) {
    const value = configured.trim();
    if (value === "preview" || value === "production") return value;
    return null;
  }
  return env.VERCEL_ENV === "production" ? "production" : "preview";
}

export function resolveDocumentStorageProvider(
  env: Record<string, string | undefined>,
): ObjectStorageProvider | null {
  const configured = env.DOCUMENT_STORAGE_PROVIDER;
  if (configured !== undefined) {
    const value = configured.trim();
    if (value === "cloudflare_r2" || value === "vpsttt") return value;
    return null;
  }
  return "cloudflare_r2";
}

export function parseHttpsEndpoint(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.includes("<") || value.includes(">")) return null;
  if (value.includes("?") || value.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  return trimmedPath ? `${url.origin}${trimmedPath}` : url.origin;
}

export function parseForcePathStyle(
  raw: string | undefined,
  defaultValue: boolean,
): boolean | null {
  if (raw === undefined) return defaultValue;
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function loadCloudflareR2Config(
  env: Record<string, string | undefined>,
  environment: DocumentEnvironment,
): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET_NAME?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  if (
    !accountId ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey ||
    !ACCOUNT_ID.test(accountId) ||
    !ACCESS_KEY_ID.test(accessKeyId) ||
    !SECRET_ACCESS_KEY.test(secretAccessKey) ||
    bucket !== DOCUMENT_BUCKETS[environment]
  ) {
    return null;
  }
  return {
    provider: "cloudflare_r2",
    accountId,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    forcePathStyle: false,
    bucket,
    accessKeyId,
    secretAccessKey,
    environment,
  };
}

function loadVpstttConfig(
  env: Record<string, string | undefined>,
  environment: DocumentEnvironment,
): R2Config | null {
  const endpoint = parseHttpsEndpoint(env.VPSTTT_STORAGE_ENDPOINT);
  const region = env.VPSTTT_STORAGE_REGION?.trim();
  const bucket = env.VPSTTT_STORAGE_BUCKET?.trim();
  const rawAccessKeyId = env.VPSTTT_STORAGE_ACCESS_KEY_ID;
  const rawSecretAccessKey = env.VPSTTT_STORAGE_SECRET_ACCESS_KEY;
  const accessKeyId = rawAccessKeyId?.trim();
  const secretAccessKey = rawSecretAccessKey?.trim();
  const forcePathStyle = parseForcePathStyle(env.VPSTTT_STORAGE_FORCE_PATH_STYLE, true);

  if (
    !endpoint ||
    !region ||
    !VPSTTT_REGION.test(region) ||
    !bucket ||
    !VPSTTT_BUCKET.test(bucket) ||
    bucket.includes("..") ||
    IPV4_HOST.test(bucket) ||
    !rawAccessKeyId ||
    !accessKeyId ||
    rawAccessKeyId.includes("<") ||
    rawAccessKeyId.includes(">") ||
    !VPSTTT_ACCESS_KEY_ID.test(accessKeyId) ||
    !rawSecretAccessKey ||
    !secretAccessKey ||
    rawSecretAccessKey.includes("<") ||
    rawSecretAccessKey.includes(">") ||
    !VPSTTT_SECRET_ACCESS_KEY.test(secretAccessKey) ||
    forcePathStyle === null
  ) {
    return null;
  }

  return {
    provider: "vpsttt",
    accountId: null,
    endpoint,
    region,
    forcePathStyle,
    bucket,
    accessKeyId,
    secretAccessKey,
    environment,
  };
}

export function loadR2Config(env: Record<string, string | undefined>): R2Config | null {
  const environment = resolveDocumentEnvironment(env);
  const provider = resolveDocumentStorageProvider(env);
  if (!environment || !provider) return null;
  return provider === "vpsttt"
    ? loadVpstttConfig(env, environment)
    : loadCloudflareR2Config(env, environment);
}

export function buildR2S3ClientConfig(config: R2Config): S3ClientConfig {
  return {
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
}

export function createR2S3Client(config: R2Config): S3Client {
  return new S3Client(buildR2S3ClientConfig(config));
}

export const unavailableDocumentObjectStorage: DocumentObjectStorage = {
  available: () => false,
  async writeEnrollmentPortraitStage() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async readEnrollmentPortraitStage() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async copyEnrollmentPortraitStage() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async deleteEnrollmentPortraitStage() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async createUploadUrl() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async headStaged() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async readStaged() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async writeStaged() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async readFinal() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async promote() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async deleteStaged() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async deleteFinal() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async createDownloadUrl() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
};

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === "NotFound" || value.name === "NoSuchKey" ||
    value.$metadata?.httpStatusCode === 404;
}

export function createR2DocumentStorage(
  env: Record<string, string | undefined> = process.env,
  dependencies: R2Dependencies = {},
): DocumentObjectStorage {
  const config = loadR2Config(env);
  if (!config) return unavailableDocumentObjectStorage;
  const now = dependencies.now ?? Date.now;
  let client: Send | undefined = dependencies.client;
  const presign: Presign = dependencies.presign ??
    ((signer, command, options) =>
      getSignedUrl(signer as S3Client, command as never, options));
  const getClient = (): Send => {
    client ??= createR2S3Client(config) as unknown as Send;
    return client;
  };
  const expiry = (seconds: number) => new Date(now() + seconds * 1000).toISOString();

  return {
    available: () => true,
    async writeEnrollmentPortraitStage(input) {
      await getClient().send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: enrollmentPortraitStageKey(config.environment, input.stage_id),
        Body: Buffer.from(input.bytes),
        ContentType: input.mime_type,
        ContentLength: input.bytes.byteLength,
      }));
    },
    async readEnrollmentPortraitStage(stageId) {
      try {
        const result = await getClient().send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: enrollmentPortraitStageKey(config.environment, stageId),
        })) as {
          ContentLength?: number;
          Body?: { transformToByteArray(): Promise<Uint8Array> };
        };
        if (!result.Body || typeof result.ContentLength !== "number" ||
            result.ContentLength > DOCUMENT_MAX_UPLOAD_BYTES) {
          throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
        }
        const bytes = await result.Body.transformToByteArray();
        if (bytes.byteLength !== result.ContentLength || bytes.byteLength > DOCUMENT_MAX_UPLOAD_BYTES) {
          throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
        }
        return bytes;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async copyEnrollmentPortraitStage(input) {
      await getClient().send(new CopyObjectCommand({
        Bucket: config.bucket,
        Key: stagingObjectKey(config.environment, input.storage_key),
        CopySource: `${config.bucket}/${enrollmentPortraitStageKey(config.environment, input.stage_id)}`,
        ContentType: input.mime_type,
        MetadataDirective: "REPLACE",
      }));
    },
    async deleteEnrollmentPortraitStage(stageId) {
      await getClient().send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: enrollmentPortraitStageKey(config.environment, stageId),
      }));
    },
    async createUploadUrl(input) {
      const url = await presign(
        getClient(),
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: stagingObjectKey(config.environment, input.storage_key),
          ContentType: input.mime_type,
          ContentLength: input.size_bytes,
        }),
        {
          expiresIn: DOCUMENT_UPLOAD_URL_TTL_SECONDS,
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
      return {
        url,
        expires_at: expiry(DOCUMENT_UPLOAD_URL_TTL_SECONDS),
        headers: { "Content-Type": input.mime_type },
      };
    },
    async headStaged(storageKey) {
      try {
        const head = await getClient().send(new HeadObjectCommand({
          Bucket: config.bucket,
          Key: stagingObjectKey(config.environment, storageKey),
        })) as { ContentLength?: number; ContentType?: string };
        if (typeof head.ContentLength !== "number" || !Number.isSafeInteger(head.ContentLength)) {
          throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
        }
        return {
          kind: "found",
          size_bytes: head.ContentLength,
          content_type: typeof head.ContentType === "string" ? head.ContentType : null,
        };
      } catch (error) {
        if (isNotFound(error)) return { kind: "missing" };
        throw error;
      }
    },
    async readStaged(storageKey) {
      try {
        const result = await getClient().send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: stagingObjectKey(config.environment, storageKey),
        })) as {
          ContentLength?: number;
          Body?: { transformToByteArray(): Promise<Uint8Array> };
        };
        if (!result.Body || typeof result.ContentLength !== "number" ||
            result.ContentLength > DOCUMENT_MAX_UPLOAD_BYTES) {
          throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
        }
        const bytes = await result.Body.transformToByteArray();
        if (bytes.byteLength > DOCUMENT_MAX_UPLOAD_BYTES) {
          throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
        }
        return bytes;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async writeStaged(input) {
      await getClient().send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: stagingObjectKey(config.environment, input.storage_key),
        Body: Buffer.from(input.bytes),
        ContentType: input.mime_type,
        ContentLength: input.bytes.byteLength,
      }));
    },
    async readFinal(storageKey) {
      try {
        const result = await getClient().send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: finalObjectKey(config.environment, storageKey),
        })) as {
          ContentLength?: number;
          Body?: { transformToByteArray(): Promise<Uint8Array> };
        };
        if (!result.Body || typeof result.ContentLength !== "number" ||
            result.ContentLength < 1 || result.ContentLength > DOCUMENT_MAX_UPLOAD_BYTES) {
          throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
        }
        const bytes = await result.Body.transformToByteArray();
        if (bytes.byteLength !== result.ContentLength ||
            bytes.byteLength > DOCUMENT_MAX_UPLOAD_BYTES) {
          throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
        }
        return bytes;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async promote(input) {
      if (input.sanitized_bytes) {
        await getClient().send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: finalObjectKey(config.environment, input.storage_key),
          Body: Buffer.from(input.sanitized_bytes),
          ContentLength: input.sanitized_bytes.byteLength,
          ContentType: input.mime_type,
          ContentDisposition: "attachment",
        }));
        return;
      }
      const source = stagingObjectKey(config.environment, input.storage_key);
      await getClient().send(new CopyObjectCommand({
        Bucket: config.bucket,
        Key: finalObjectKey(config.environment, input.storage_key),
        CopySource: `${config.bucket}/${source}`,
        ContentType: input.mime_type,
        ContentDisposition: "attachment",
        MetadataDirective: "REPLACE",
      }));
    },
    async deleteStaged(storageKey) {
      await getClient().send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: stagingObjectKey(config.environment, storageKey),
      }));
    },
    async deleteFinal(storageKey) {
      await getClient().send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: finalObjectKey(config.environment, storageKey),
      }));
    },
    async createDownloadUrl(input) {
      const fileName = genericDownloadName(input.document_type, input.version, input.mime_type);
      const url = await presign(
        getClient(),
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: finalObjectKey(config.environment, input.storage_key),
          ResponseContentType: input.mime_type,
          ResponseContentDisposition: attachmentDisposition(fileName),
        }),
        { expiresIn: DOCUMENT_DOWNLOAD_URL_TTL_SECONDS },
      );
      return { url, expires_at: expiry(DOCUMENT_DOWNLOAD_URL_TTL_SECONDS), headers: {} };
    },
  };
}
