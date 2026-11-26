import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyStagingObject, finalObjectKey, genericDownloadName, inspectDocumentContent, sha256Hex, stagingObjectKey,
} from "./document-r2-contract.ts";
import {
  buildR2S3ClientConfig,
  createR2DocumentStorage,
  loadR2Config,
  resolveDocumentStorageProvider,
} from "./r2-document-storage.ts";

const documentId = "b2000000-0000-4000-8000-000000000001";
const key = `p1.6/c2000000-0000-4000-8000-000000000001/CCCD_FRONT/1/${documentId}`;
const env = (extra = {}) => ({
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "hrp-bi-preview",
  R2_ACCESS_KEY_ID: "SYNTHETICACCESSKEY01",
  R2_SECRET_ACCESS_KEY: "synthetic-secret-value-0001",
  ...extra,
});
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82);
const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9);
const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");

function recorder() {
  const sent = [];
  return {
    sent,
    client: { async send(command) { sent.push(command); return {}; } },
    presign: async (_client, command, options) => {
      sent.push({ presign: command, options });
      return "https://signed.example.test/object?sig=synthetic";
    },
  };
}

test("missing, malformed or wrong-environment config fails closed before any network", async () => {
  const rec = recorder();
  for (const bad of [{}, env({ R2_ACCOUNT_ID: "short" }), env({ R2_BUCKET_NAME: "hrp-bi-product" }), env({ R2_BUCKET_NAME: undefined })]) {
    const storage = createR2DocumentStorage(bad, rec);
    assert.equal(storage.available(), false);
    await assert.rejects(storage.createUploadUrl({ storage_key: key, mime_type: "image/png", size_bytes: 1 }));
    await assert.rejects(storage.headStaged(key));
  }
  assert.deepEqual(rec.sent, []);
});

test("bucket is chosen server-side per environment", async () => {
  assert.equal(loadR2Config(env())?.bucket, "hrp-bi-preview");
  assert.equal(loadR2Config(env({ VERCEL_ENV: "production" })), null);
  assert.equal(loadR2Config(env({ VERCEL_ENV: "production", R2_BUCKET_NAME: "hrp-bi-product" }))?.bucket, "hrp-bi-product");
  const stagingOnVercelProduction = env({
    VERCEL_ENV: "production",
    DOCUMENT_STORAGE_ENVIRONMENT: "preview",
  });
  assert.equal(loadR2Config(stagingOnVercelProduction)?.environment, "preview");
  assert.equal(loadR2Config(stagingOnVercelProduction)?.bucket, "hrp-bi-preview");
  assert.equal(loadR2Config(env({
    VERCEL_ENV: "production",
    DOCUMENT_STORAGE_ENVIRONMENT: "staging",
  })), null, "unknown override fails closed");
  const rec = recorder();
  await createR2DocumentStorage(stagingOnVercelProduction, rec).createUploadUrl({
    storage_key: key, mime_type: "image/png", size_bytes: 512,
  });
  assert.equal(rec.sent[0].presign.input.Bucket, "hrp-bi-preview");
  assert.equal(rec.sent[0].presign.input.Key, `preview/staging/${key}`);
});

test("presigned PUT is bound to staging key, content type, length and expires within five minutes", async () => {
  const rec = recorder();
  const storage = createR2DocumentStorage(env(), { ...rec, now: () => 1_000_000 });
  const signed = await storage.createUploadUrl({ storage_key: key, mime_type: "image/png", size_bytes: 512 });
  const call = rec.sent[0];
  assert.equal(call.presign.input.Bucket, "hrp-bi-preview");
  assert.equal(call.presign.input.Key, `preview/staging/${key}`);
  assert.equal(call.presign.input.ContentType, "image/png");
  assert.equal(call.presign.input.ContentLength, 512);
  assert.ok(call.options.expiresIn <= 300);
  assert.deepEqual(signed.headers, { "Content-Type": "image/png" });
  assert.equal(Date.parse(signed.expires_at) - 1_000_000, 300_000);
  assert.doesNotMatch(JSON.stringify(signed), /synthetic-secret|SYNTHETICACCESSKEY|hrp-bi-preview|p1\.6\//);
});

test("presigned GET is attachment-only with a generic name and lives at most two minutes", async () => {
  const rec = recorder();
  const storage = createR2DocumentStorage(env(), rec);
  await storage.createDownloadUrl({ storage_key: key, mime_type: "application/pdf", document_type: "CCCD_FRONT", version: 2 });
  const call = rec.sent[0];
  assert.ok(call.options.expiresIn <= 120);
  assert.equal(call.presign.input.Key, `preview/final/${key}`);
  assert.equal(call.presign.input.ResponseContentDisposition, 'attachment; filename="cccd-front-v2.pdf"');
});

test("promote copies staging to a final opaque key as attachment and delete targets staging only", async () => {
  const rec = recorder();
  const storage = createR2DocumentStorage(env(), rec);
  await storage.promote({ storage_key: key, mime_type: "image/png" });
  await storage.deleteStaged(key);
  assert.equal(rec.sent[0].input.Key, `preview/final/${key}`);
  assert.equal(rec.sent[0].input.CopySource, `hrp-bi-preview/preview/staging/${key}`);
  assert.equal(rec.sent[0].input.ContentDisposition, "attachment");
  assert.equal(rec.sent[1].input.Key, `preview/staging/${key}`);
});

test("enrollment portraits use a private server-only staging key before entering the document pipeline", async () => {
  const rec = recorder();
  const storage = createR2DocumentStorage(env(), rec);
  const stageId = "d2000000-0000-4000-8000-000000000001";
  const bytes = Uint8Array.of(1, 2, 3);
  await storage.writeEnrollmentPortraitStage({
    stage_id: stageId, mime_type: "image/png", bytes,
  });
  await storage.copyEnrollmentPortraitStage({
    stage_id: stageId, storage_key: key.replace("CCCD_FRONT", "WORKER_PORTRAIT"),
    mime_type: "image/png",
  });
  await storage.deleteEnrollmentPortraitStage(stageId);
  assert.equal(rec.sent[0].input.Key, `preview/enrollment-staging/${stageId}`);
  assert.deepEqual(rec.sent[0].input.Body, Buffer.from(bytes));
  assert.equal(rec.sent[0].input.ContentType, "image/png");
  assert.equal(rec.sent[1].input.Key,
    `preview/staging/${key.replace("CCCD_FRONT", "WORKER_PORTRAIT")}`);
  assert.equal(rec.sent[1].input.CopySource,
    `hrp-bi-preview/preview/enrollment-staging/${stageId}`);
  assert.equal(rec.sent[1].input.ContentType, "image/png");
  assert.equal(rec.sent[2].input.Key, `preview/enrollment-staging/${stageId}`);
  await assert.rejects(storage.writeEnrollmentPortraitStage({
    stage_id: "not-a-uuid", mime_type: "image/png", bytes,
  }));
});

test("sanitized promotion writes server bytes directly to the private final key", async () => {
  const rec = recorder();
  const storage = createR2DocumentStorage(env(), rec);
  const sanitizedBytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  await storage.promote({
    storage_key: key.replace("CCCD_FRONT", "WORKER_PORTRAIT"),
    mime_type: "image/jpeg",
    sanitized_bytes: sanitizedBytes,
  });
  const command = rec.sent[0];
  assert.equal(command.input.Key, `preview/final/${key.replace("CCCD_FRONT", "WORKER_PORTRAIT")}`);
  assert.equal(command.input.ContentType, "image/jpeg");
  assert.equal(command.input.ContentLength, sanitizedBytes.byteLength);
  assert.deepEqual(command.input.Body, Buffer.from(sanitizedBytes));
  assert.equal("CopySource" in command.input, false);
});

test("final object reads are size-bounded and use the server-derived final key", async () => {
  const sent = [];
  const bytes = Uint8Array.of(1, 2, 3);
  const storage = createR2DocumentStorage(env(), {
    client: {
      async send(command) {
        sent.push(command);
        return {
          ContentLength: bytes.byteLength,
          Body: { async transformToByteArray() { return bytes; } },
        };
      },
    },
  });
  assert.deepEqual(await storage.readFinal(key), bytes);
  assert.equal(sent[0].input.Key, `preview/final/${key}`);
});

test("head maps not-found to missing and oversize reads are rejected", async () => {
  const missing = createR2DocumentStorage(env(), { client: { async send() { throw { name: "NotFound" }; } } });
  assert.deepEqual(await missing.headStaged(key), { kind: "missing" });
  const big = createR2DocumentStorage(env(), {
    client: { async send() { return { ContentLength: 10 * 1024 * 1024 + 1, Body: { transformToByteArray: async () => new Uint8Array() } }; } },
  });
  await assert.rejects(big.readStaged(key));
});

test("object keys require opaque ids and never carry names", () => {
  assert.throws(() => stagingObjectKey("preview", "cccd-nguyen-van-a.png"));
  assert.equal(finalObjectKey("production", key), `production/final/${key}`);
  assert.doesNotMatch(genericDownloadName("CCCD_BACK", 1, "image/jpeg"), /[A-Z0-9]{9,}/);
});

test("content inspection accepts real signatures and rejects fakes and polyglots", () => {
  assert.equal(inspectDocumentContent({ document_type: "CCCD_FRONT", mime_type: "image/png", bytes: png }).ok, true);
  assert.equal(inspectDocumentContent({ document_type: "CCCD_FRONT", mime_type: "image/jpeg", bytes: jpeg }).ok, true);
  assert.equal(inspectDocumentContent({ document_type: "EMPLOYMENT_CONTRACT", mime_type: "application/pdf", bytes: pdf }).ok, true);
  assert.equal(inspectDocumentContent({ document_type: "CCCD_FRONT", mime_type: "image/png", bytes: jpeg }).ok, false);
  const text = new TextEncoder().encode("<html><script>alert(1)</script>");
  assert.equal(inspectDocumentContent({ document_type: "CCCD_FRONT", mime_type: "image/png", bytes: text }).ok, false);
  const polyglot = Uint8Array.from([...jpeg.slice(0, 7), ...new TextEncoder().encode("<script>x</script>"), 0xff, 0xd9]);
  assert.equal(inspectDocumentContent({ document_type: "CCCD_FRONT", mime_type: "image/jpeg", bytes: polyglot }).ok, false);
  const truncatedPdf = new TextEncoder().encode("%PDF-1.4 no trailer");
  assert.equal(inspectDocumentContent({ document_type: "EMPLOYMENT_CONTRACT", mime_type: "application/pdf", bytes: truncatedPdf }).ok, false);
});

test("sha256 is computed from bytes and staging cleanup contract is fixed", () => {
  assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(classifyStagingObject({ ageHours: 1, invalid: true, finalized: false }), "delete-invalid");
  assert.equal(classifyStagingObject({ ageHours: 23, invalid: false, finalized: false }), "keep");
  assert.equal(classifyStagingObject({ ageHours: 24, invalid: false, finalized: false }), "eligible-for-cleanup");
});

test("resolveDocumentStorageProvider defaults to cloudflare_r2, accepts vpsttt, and fails closed on unknown values", () => {
  assert.equal(resolveDocumentStorageProvider({}), "cloudflare_r2");
  assert.equal(resolveDocumentStorageProvider({ DOCUMENT_STORAGE_PROVIDER: "cloudflare_r2" }), "cloudflare_r2");
  assert.equal(resolveDocumentStorageProvider({ DOCUMENT_STORAGE_PROVIDER: " vpsttt " }), "vpsttt");
  assert.equal(resolveDocumentStorageProvider({ DOCUMENT_STORAGE_PROVIDER: "s3" }), null);
  assert.equal(resolveDocumentStorageProvider({ DOCUMENT_STORAGE_PROVIDER: "" }), null);
});

test("loadR2Config validates VPSTTT config with decoupled bucket, rejects invalid fields, and never falls back to R2_*", () => {
  const vpstttEnv = (extra = {}) => ({
    ...env(),
    DOCUMENT_STORAGE_ENVIRONMENT: "production",
    DOCUMENT_STORAGE_PROVIDER: "vpsttt",
    VPSTTT_STORAGE_ENDPOINT: "https://s3.synthetic.test:9000",
    VPSTTT_STORAGE_REGION: "ap-southeast-1",
    VPSTTT_STORAGE_BUCKET: "vpsttt-clone-bucket",
    VPSTTT_STORAGE_ACCESS_KEY_ID: "VPSTTTSYNTHETICKEY01",
    VPSTTT_STORAGE_SECRET_ACCESS_KEY: "vpsttt-synthetic-secret-key-0123456789",
    ...extra,
  });

  const valid = loadR2Config(vpstttEnv());
  assert.ok(valid);
  assert.equal(valid.provider, "vpsttt");
  assert.equal(valid.accountId, null);
  assert.equal(valid.environment, "production");
  assert.equal(valid.bucket, "vpsttt-clone-bucket");
  assert.equal(valid.forcePathStyle, true);

  const pathStyleOff = loadR2Config(vpstttEnv({ VPSTTT_STORAGE_FORCE_PATH_STYLE: "false" }));
  assert.equal(pathStyleOff?.forcePathStyle, false);

  for (const bad of [
    { VPSTTT_STORAGE_ENDPOINT: undefined },
    { VPSTTT_STORAGE_ENDPOINT: "http://s3.synthetic.test:9000" },
    { VPSTTT_STORAGE_ENDPOINT: "https://s3.synthetic.test?foo=1" },
    { VPSTTT_STORAGE_ENDPOINT: "https://<host>.test" },
    { VPSTTT_STORAGE_REGION: undefined },
    { VPSTTT_STORAGE_BUCKET: "a..b" },
    { VPSTTT_STORAGE_BUCKET: "127.0.0.1" },
    { VPSTTT_STORAGE_BUCKET: "UPPER_CASE" },
    { VPSTTT_STORAGE_ACCESS_KEY_ID: "<access-key>" },
    { VPSTTT_STORAGE_SECRET_ACCESS_KEY: "<secret-key>" },
    { VPSTTT_STORAGE_FORCE_PATH_STYLE: "invalid" },
  ]) {
    assert.equal(loadR2Config(vpstttEnv(bad)), null, JSON.stringify(bad));
  }
});

test("buildR2S3ClientConfig targets Cloudflare R2 vs VPSTTT endpoints, regions, and path-style flags", () => {
  const r2Cfg = loadR2Config(env());
  assert.ok(r2Cfg);
  const r2ClientCfg = buildR2S3ClientConfig(r2Cfg);
  assert.equal(r2ClientCfg.region, "auto");
  assert.equal(r2ClientCfg.endpoint, "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(r2ClientCfg.forcePathStyle, false);
  assert.equal(r2ClientCfg.requestChecksumCalculation, "WHEN_REQUIRED");
  assert.equal(r2ClientCfg.responseChecksumValidation, "WHEN_REQUIRED");

  const vpstttCfg = loadR2Config({
    DOCUMENT_STORAGE_ENVIRONMENT: "production",
    DOCUMENT_STORAGE_PROVIDER: "vpsttt",
    VPSTTT_STORAGE_ENDPOINT: "https://127.0.0.1:9443/",
    VPSTTT_STORAGE_REGION: "us-east-1",
    VPSTTT_STORAGE_BUCKET: "vpsttt-clone-bucket",
    VPSTTT_STORAGE_ACCESS_KEY_ID: "VPSTTTSYNTHETICKEY01",
    VPSTTT_STORAGE_SECRET_ACCESS_KEY: "vpsttt-synthetic-secret-key-0123456789",
  });
  assert.ok(vpstttCfg);
  const vpstttClientCfg = buildR2S3ClientConfig(vpstttCfg);
  assert.equal(vpstttClientCfg.region, "us-east-1");
  assert.equal(vpstttClientCfg.endpoint, "https://127.0.0.1:9443");
  assert.equal(vpstttClientCfg.forcePathStyle, true);
  assert.deepEqual(vpstttClientCfg.credentials, {
    accessKeyId: "VPSTTTSYNTHETICKEY01",
    secretAccessKey: "vpsttt-synthetic-secret-key-0123456789",
  });
});
