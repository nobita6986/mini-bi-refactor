import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";

import {
  BULLETIN_MAX_ATTACHMENT_BYTES,
  BulletinValidationError,
} from "./contract.ts";
import {
  buildBulletinStorageKey,
  countPdfPagesFromBuffer,
  createBulletinStorage,
  inspectBulletinAttachment,
  unavailableBulletinStorage,
} from "./storage.ts";

const BULLETIN_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function makeR2Env(extra = {}) {
  return {
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_BUCKET_NAME: "hrp-bi-preview",
    R2_ACCESS_KEY_ID: "SYNTHETICACCESSKEY01",
    R2_SECRET_ACCESS_KEY: "synthetic-secret-value-0001",
    ...extra,
  };
}

function makeVpstttEnv(extra = {}) {
  return {
    DOCUMENT_STORAGE_PROVIDER: "vpsttt",
    DOCUMENT_STORAGE_ENVIRONMENT: "production",
    VPSTTT_STORAGE_ENDPOINT: "https://storage.vpsttt.example",
    VPSTTT_STORAGE_REGION: "ap-southeast-1",
    VPSTTT_STORAGE_BUCKET: "vpsttt-bulletins-bucket",
    VPSTTT_STORAGE_ACCESS_KEY_ID: "VPSTTTSYNTHETICKEY01",
    VPSTTT_STORAGE_SECRET_ACCESS_KEY: "vpsttt-synthetic-secret-key-0123456789",
    VPSTTT_STORAGE_FORCE_PATH_STYLE: "true",
    ...extra,
  };
}

function createFakeS3Client() {
  const objects = new Map();
  const commands = [];
  return {
    objects,
    commands,
    client: {
      async send(command) {
        commands.push(command);
        if (command instanceof PutObjectCommand) {
          const copy = Buffer.from(command.input.Body);
          objects.set(`${command.input.Bucket}/${command.input.Key}`, {
            bytes: copy,
            contentType: command.input.ContentType,
            contentLength: command.input.ContentLength,
          });
          return {};
        }
        if (command instanceof GetObjectCommand) {
          const item = objects.get(`${command.input.Bucket}/${command.input.Key}`);
          if (!item) {
            const err = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            throw err;
          }
          return {
            ContentType: item.contentType,
            ContentLength: item.contentLength,
            Body: {
              async transformToByteArray() {
                return Uint8Array.from(item.bytes);
              },
            },
          };
        }
        if (command instanceof DeleteObjectCommand) {
          objects.delete(`${command.input.Bucket}/${command.input.Key}`);
          return {};
        }
        throw new Error(`Unexpected S3 command: ${command?.constructor?.name}`);
      },
    },
  };
}

test("inspectBulletinAttachment detects sharp PNG/JPEG/WEBP, preserves exact raw sha256 & dimensions without re-encoding", async () => {
  const pngBuf = await sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 10, g: 120, b: 220 } },
  })
    .png()
    .toBuffer();
  const jpegBuf = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 220, g: 50, b: 30 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  const webpBuf = await sharp({
    create: { width: 96, height: 72, channels: 4, background: { r: 40, g: 180, b: 90, alpha: 1 } },
  })
    .webp()
    .toBuffer();

  const pngRes = await inspectBulletinAttachment({
    bytes: pngBuf,
    fileName: "banner.png",
    declaredMimeType: "image/png",
  });
  assert.deepEqual(pngRes, {
    kind: "IMAGE",
    mime_type: "image/png",
    ext: "png",
    file_name: "banner.png",
    file_size_bytes: pngBuf.byteLength,
    sha256: sha256Hex(pngBuf),
    width: 120,
    height: 80,
    page_count: null,
  });

  const jpegRes = await inspectBulletinAttachment({
    bytes: jpegBuf,
    fileName: "photo.jpeg",
    declaredMimeType: "image/jpeg",
  });
  assert.equal(jpegRes.kind, "IMAGE");
  assert.equal(jpegRes.mime_type, "image/jpeg");
  assert.equal(jpegRes.ext, "jpg");
  assert.equal(jpegRes.width, 64);
  assert.equal(jpegRes.height, 48);
  assert.equal(jpegRes.sha256, sha256Hex(jpegBuf));

  const webpRes = await inspectBulletinAttachment({
    bytes: webpBuf,
    fileName: "poster.webp",
    declaredMimeType: "image/webp",
  });
  assert.equal(webpRes.kind, "IMAGE");
  assert.equal(webpRes.mime_type, "image/webp");
  assert.equal(webpRes.ext, "webp");
  assert.equal(webpRes.width, 96);
  assert.equal(webpRes.height, 72);
  assert.equal(webpRes.sha256, sha256Hex(webpBuf));
});

test("inspectBulletinAttachment detects PDF magic bytes and counts pages safely", async () => {
  const twoPagePdf = Buffer.from(
    "%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 /Kids [2 0 R 3 0 R] >> endobj\n" +
      "2 0 obj << /Type /Page /Parent 1 0 R >> endobj\n" +
      "3 0 obj << /Type /Page /Parent 1 0 R >> endobj\n%%EOF\n",
    "latin1",
  );
  const res = await inspectBulletinAttachment({
    bytes: twoPagePdf,
    fileName: "../dir/Quyet dinh nghi le.pdf",
    declaredMimeType: "application/pdf",
  });
  assert.deepEqual(res, {
    kind: "PDF",
    mime_type: "application/pdf",
    ext: "pdf",
    file_name: "Quyet dinh nghi le.pdf",
    file_size_bytes: twoPagePdf.byteLength,
    sha256: sha256Hex(twoPagePdf),
    width: null,
    height: null,
    page_count: 2,
  });

  const countOnlyPdf = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Pages /Count 5 >> endobj\n%%EOF", "latin1");
  assert.equal(countPdfPagesFromBuffer(countOnlyPdf), 5);

  const unknownPagePdf = Buffer.from("%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF", "latin1");
  assert.equal(countPdfPagesFromBuffer(unknownPagePdf), null);
});

test("inspectBulletinAttachment rejects HTML, SVG, embedded script, MIME/ext mismatch, 0 bytes, and > 15MB", async () => {
  const pngBuf = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();

  // 0 bytes
  await assert.rejects(
    inspectBulletinAttachment({ bytes: Buffer.alloc(0), fileName: "empty.png" }),
    (err) => err instanceof BulletinValidationError && err.code === "BULLETIN_ATTACHMENT_INVALID" && err.status === 400,
  );

  // > 15,728,640 bytes -> 413 BULLETIN_ATTACHMENT_TOO_LARGE
  const overMax = Buffer.alloc(BULLETIN_MAX_ATTACHMENT_BYTES + 1, 0x20);
  overMax.write("%PDF-1.4\n", 0, "latin1");
  await assert.rejects(
    inspectBulletinAttachment({ bytes: overMax, fileName: "big.pdf", declaredMimeType: "application/pdf" }),
    (err) => err instanceof BulletinValidationError && err.code === "BULLETIN_ATTACHMENT_TOO_LARGE" && err.status === 413,
  );

  // Exact 15,728,640 bytes -> allowed
  const exactMax = Buffer.alloc(BULLETIN_MAX_ATTACHMENT_BYTES, 0x20);
  exactMax.write("%PDF-1.4\n<< /Type /Page >>\n", 0, "latin1");
  const exactRes = await inspectBulletinAttachment({
    bytes: exactMax,
    fileName: "exact.pdf",
    declaredMimeType: "application/pdf",
  });
  assert.equal(exactRes.file_size_bytes, BULLETIN_MAX_ATTACHMENT_BYTES);
  assert.equal(exactRes.sha256, sha256Hex(exactMax));

  // HTML, SVG, plain text
  for (const [label, payload, mime] of [
    ["html", Buffer.from("<!doctype html><html><script>alert(1)</script></html>"), "text/html"],
    ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "image/svg+xml"],
    ["text", Buffer.from("plain text file"), "text/plain"],
  ]) {
    await assert.rejects(
      inspectBulletinAttachment({ bytes: payload, fileName: `${label}.png`, declaredMimeType: mime }),
      (err) => err instanceof BulletinValidationError && err.code === "BULLETIN_ATTACHMENT_INVALID" && err.status === 400,
    );
  }

  // MIME mismatch and extension mismatch on real PNG bytes
  await assert.rejects(
    inspectBulletinAttachment({ bytes: pngBuf, fileName: "image.png", declaredMimeType: "image/jpeg" }),
    (err) => err instanceof BulletinValidationError && err.code === "BULLETIN_ATTACHMENT_INVALID",
  );
  await assert.rejects(
    inspectBulletinAttachment({ bytes: pngBuf, fileName: "image.jpg", declaredMimeType: "image/png" }),
    (err) => err instanceof BulletinValidationError && err.code === "BULLETIN_ATTACHMENT_INVALID",
  );

  // Embedded <script inside image bytes
  const taintedPng = Buffer.concat([pngBuf, Buffer.from("<script>alert(1)</script>", "latin1")]);
  await assert.rejects(
    inspectBulletinAttachment({ bytes: taintedPng, fileName: "tainted.png", declaredMimeType: "image/png" }),
    (err) => err instanceof BulletinValidationError && err.code === "BULLETIN_ATTACHMENT_INVALID",
  );
});

test("createBulletinStorage supports cloudflare_r2 and vpsttt configs with zero re-encoding and 503 unavailability", async () => {
  const pngBuf = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 200, b: 0 } },
  })
    .png()
    .toBuffer();
  const rawSha = sha256Hex(pngBuf);

  for (const [label, env, expectedPrefix, expectedBucket] of [
    ["cloudflare_r2", makeR2Env(), "preview", "hrp-bi-preview"],
    ["vpsttt", makeVpstttEnv(), "production", "vpsttt-bulletins-bucket"],
  ]) {
    const fake = createFakeS3Client();
    const storage = createBulletinStorage(env, { client: fake.client });
    assert.equal(storage.available(), true, `${label} should be available`);
    assert.equal(storage.environment(), expectedPrefix);

    const key = storage.buildObjectKey(BULLETIN_ID, ATTACHMENT_ID, "image/png");
    assert.equal(
      key,
      buildBulletinStorageKey(expectedPrefix, BULLETIN_ID, ATTACHMENT_ID, "image/png"),
    );
    assert.equal(key, `${expectedPrefix}/hr-bulletins/${BULLETIN_ID}/${ATTACHMENT_ID}.png`);

    await storage.putAttachment({ storage_key: key, mime_type: "image/png", bytes: pngBuf });
    const putCmd = fake.commands[0];
    assert.ok(putCmd instanceof PutObjectCommand);
    assert.equal(putCmd.input.Bucket, expectedBucket);
    assert.equal(putCmd.input.Key, key);
    assert.equal(putCmd.input.ContentType, "image/png");
    assert.equal(putCmd.input.ContentLength, pngBuf.byteLength);
    assert.equal(Buffer.compare(Buffer.from(putCmd.input.Body), pngBuf), 0);

    const fetched = await storage.getAttachment(key);
    assert.ok(fetched);
    assert.equal(fetched.content_type, "image/png");
    assert.equal(fetched.content_length, pngBuf.byteLength);
    assert.equal(sha256Hex(Buffer.from(fetched.bytes)), rawSha);
    assert.equal(Buffer.compare(Buffer.from(fetched.bytes), pngBuf), 0);

    await storage.deleteAttachment(key);
    assert.equal(await storage.getAttachment(key), null);
  }

  // Unconfigured / unavailable storage
  const unconfigured = createBulletinStorage({});
  assert.equal(unconfigured, unavailableBulletinStorage);
  assert.equal(unconfigured.available(), false);
  assert.equal(unconfigured.environment(), null);
  assert.throws(() => unconfigured.buildObjectKey(BULLETIN_ID, ATTACHMENT_ID, "image/png"), /BULLETIN_STORAGE_UNAVAILABLE/);
  await assert.rejects(unconfigured.getAttachment("preview/hr-bulletins/a/b.png"), /BULLETIN_STORAGE_UNAVAILABLE/);
  await assert.rejects(
    unconfigured.putAttachment({ storage_key: "k", mime_type: "image/png", bytes: pngBuf }),
    /BULLETIN_STORAGE_UNAVAILABLE/,
  );
});
