import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createHash,
  createHmac,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import https from "node:https";
import test from "node:test";

import { S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";

import { postAttendanceCheckIn } from "../attendance/attendance-api.ts";
import { ATTENDANCE_MAX_SYNC_WINDOW_MS } from "../attendance/attendance-contract.ts";
import { createR2AttendanceStorage } from "../attendance/r2-attendance-storage.ts";
import { createR2SalaryAdvanceEvidenceStorage } from "../salary-advance/r2-salary-advance-evidence-storage.ts";
import { createR2VendorFinanceEvidenceStorage } from "../vendor-finance/r2-evidence-storage.ts";
import { reserveDirectEntryDocument } from "./document-api.ts";
import {
  downloadDirectEntryDocument,
  finalizeDirectEntryDocument,
  previewWorkerPortraitDocument,
} from "./document-finalize-api.ts";
import { DOCUMENT_BUCKETS, sha256Hex } from "./document-r2-contract.ts";
import {
  buildR2S3ClientConfig,
  createR2DocumentStorage,
  loadR2Config,
} from "./r2-document-storage.ts";
import { runWorkerPortraitStageReaper } from "./worker-portrait-stage-reaper.ts";

const APP_ORIGIN = "https://bi2.hrpartner.vn";
const FOREIGN_ORIGIN = "https://evil.example";
const VPSTTT_BUCKET = "vpsttt-clone-bucket";
const VPSTTT_REGION = "ap-southeast-1";
const VPSTTT_ACCESS_KEY = "VPSTTTSYNTHETICKEY01";
const VPSTTT_SECRET_KEY = "vpsttt-synthetic-secret-key-0123456789";
const ATTENDANCE_SECRET = "att-vpsttt-test-signing-secret-2026-unique-99887766";

const ACTOR = {
  auth_subject: "91000000-0000-4000-8000-0000000000a1",
  app_user_id: "92000000-0000-4000-8000-0000000000a1",
  capabilities: ["document_upload", "document_view"],
};

// Pure-Node X.509 v3 self-signed certificate (no openssl CLI dependency; identical on Windows & Linux).
function generateSelfSignedCert() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const derLen = (n) =>
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 0xff]);
  const wrap = (tag, buf) => Buffer.concat([Buffer.from([tag]), derLen(buf.length), buf]);
  const seq = (...items) => wrap(0x30, Buffer.concat(items));
  const set = (...items) => wrap(0x31, Buffer.concat(items));
  const int = (buf) => wrap(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
  const oid = (bytes) => wrap(0x06, Buffer.from(bytes));
  const utf8 = (str) => wrap(0x0c, Buffer.from(str, "utf8"));
  const utc = (d) =>
    wrap(
      0x17,
      Buffer.from(
        `${String(d.getUTCFullYear()).slice(-2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
          `${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCHours()).padStart(2, "0")}` +
          `${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`,
        "ascii",
      ),
    );
  const sigAlg = seq(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), Buffer.from([0x05, 0x00]));
  const name = seq(set(seq(oid([0x55, 0x04, 0x03]), utf8("127.0.0.1"))));
  const now = Date.now();
  const spki = publicKey.export({ type: "spki", format: "der" });
  const sanExt = seq(
    oid([0x55, 0x1d, 0x11]),
    wrap(
      0x04,
      seq(
        wrap(0x82, Buffer.from("localhost", "ascii")),
        wrap(0x87, Buffer.from([127, 0, 0, 1])),
      ),
    ),
  );
  const basicConstraintsExt = seq(
    oid([0x55, 0x1d, 0x13]),
    Buffer.from([0x01, 0x01, 0xff]),
    wrap(0x04, seq(Buffer.from([0x01, 0x01, 0xff]))),
  );
  const tbs = seq(
    wrap(0xa0, int(Buffer.from([2]))),
    int(randomBytes(8)),
    sigAlg,
    name,
    seq(utc(new Date(now - 3_600_000)), utc(new Date(now + 86_400_000))),
    name,
    spki,
    wrap(0xa3, seq(basicConstraintsExt, sanExt)),
  );
  const signature = createSign("SHA256").update(tbs).sign(privateKey);
  const certDer = seq(tbs, sigAlg, wrap(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = certDer.toString("base64").match(/.{1,64}/g).join("\n");
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

const rfc3986 = (str) =>
  encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function parseRawQueryPairs(rawQuery) {
  if (!rawQuery) return [];
  return rawQuery.split("&").filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? "" : part.slice(eq + 1);
    return [decodeURIComponent(k), decodeURIComponent(v)];
  });
}

function parseAmzDateMs(amzDate) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function sigV4SigningKey(secretKey, dateStamp, region) {
  const kDate = createHmac("sha256", `AWS4${secretKey}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

function verifySigV4({ method, pathname, rawQuery, headers, body, accessKeyId, secretAccessKey, region, nowMs }) {
  const queryPairs = parseRawQueryPairs(rawQuery);
  const queryMap = new Map(queryPairs);
  const authHeader = headers.authorization;

  let amzDate;
  let credential;
  let signedHeaderNames;
  let signatureHex;
  let payloadHash;
  let canonicalQueryPairs;

  if (queryMap.has("X-Amz-Signature")) {
    if (queryMap.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") return { ok: false, reason: "bad-algo" };
    amzDate = queryMap.get("X-Amz-Date") ?? "";
    credential = queryMap.get("X-Amz-Credential") ?? "";
    signedHeaderNames = (queryMap.get("X-Amz-SignedHeaders") ?? "").split(";").filter(Boolean);
    signatureHex = queryMap.get("X-Amz-Signature") ?? "";
    const expiresSec = Number(queryMap.get("X-Amz-Expires"));
    const issuedMs = parseAmzDateMs(amzDate);
    if (!issuedMs || !Number.isFinite(expiresSec) || expiresSec <= 0) return { ok: false, reason: "bad-expiry" };
    if (issuedMs + expiresSec * 1000 <= nowMs) return { ok: false, reason: "expired" };
    payloadHash = "UNSIGNED-PAYLOAD";
    canonicalQueryPairs = queryPairs.filter(([k]) => k !== "X-Amz-Signature");
  } else if (typeof authHeader === "string" && authHeader.startsWith("AWS4-HMAC-SHA256 ")) {
    const parts = Object.fromEntries(
      authHeader
        .slice("AWS4-HMAC-SHA256 ".length)
        .split(",")
        .map((kv) => {
          const i = kv.trim().indexOf("=");
          return [kv.trim().slice(0, i), kv.trim().slice(i + 1)];
        }),
    );
    credential = parts.Credential ?? "";
    signedHeaderNames = (parts.SignedHeaders ?? "").split(";").filter(Boolean);
    signatureHex = parts.Signature ?? "";
    amzDate = headers["x-amz-date"] ?? "";
    const xAmzSha = headers["x-amz-content-sha256"];
    const computedBodyHash = createHash("sha256").update(body).digest("hex");
    if (xAmzSha && xAmzSha !== "UNSIGNED-PAYLOAD" && xAmzSha !== computedBodyHash) {
      return { ok: false, reason: "payload-hash-mismatch" };
    }
    payloadHash = xAmzSha ?? computedBodyHash;
    canonicalQueryPairs = queryPairs;
  } else {
    return { ok: false, reason: "anonymous" };
  }

  const credParts = credential.split("/");
  if (
    credParts.length !== 5 ||
    credParts[0] !== accessKeyId ||
    credParts[1] !== amzDate.slice(0, 8) ||
    credParts[2] !== region ||
    credParts[3] !== "s3" ||
    credParts[4] !== "aws4_request"
  ) {
    return { ok: false, reason: "bad-credential" };
  }

  for (const h of signedHeaderNames) {
    if (headers[h] === undefined) return { ok: false, reason: `missing-signed-header:${h}` };
  }

  const encodedQuery = canonicalQueryPairs
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${String(headers[h]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeadersStr = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    pathname,
    encodedQuery,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join("\n");

  const scope = `${credParts[1]}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const expectedHex = createHmac("sha256", sigV4SigningKey(secretAccessKey, credParts[1], region))
    .update(stringToSign)
    .digest("hex");

  const actualBuf = Buffer.from(signatureHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return { ok: false, reason: "signature-mismatch" };
  }
  return { ok: true };
}

function xmlError(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

async function createMockVpstttServer() {
  const { certPem, keyPem } = generateSelfSignedCert();
  const objects = new Map();
  const requests = [];
  let nowOffsetMs = 0;

  const server = https.createServer({ key: keyPem, cert: certPem }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const reqUrl = req.url ?? "/";
    const qIdx = reqUrl.indexOf("?");
    const rawPathname = qIdx === -1 ? reqUrl : reqUrl.slice(0, qIdx);
    const rawQuery = qIdx === -1 ? "" : reqUrl.slice(qIdx + 1);
    const queryMap = new Map(parseRawQueryPairs(rawQuery));
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    const host = typeof req.headers.host === "string" ? req.headers.host : "";
    const ifNoneMatch = typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"] : null;

    requests.push({
      method: req.method,
      host,
      path: rawPathname,
      query: rawQuery,
      origin,
      ifNoneMatch,
      headers: { ...req.headers },
    });

    const corsAllowed = origin === APP_ORIGIN;
    if (origin !== null && !corsAllowed) {
      res.writeHead(403, { "Content-Type": "application/xml" });
      res.end(xmlError("AccessDenied", "CORS origin denied"));
      return;
    }

    const corsHeaders = corsAllowed
      ? { "Access-Control-Allow-Origin": APP_ORIGIN, Vary: "Origin" }
      : {};

    if (req.method === "OPTIONS") {
      if (!corsAllowed) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(204, {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "GET, PUT, HEAD, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, content-length, if-none-match, x-amz-meta-sha256",
        "Access-Control-Max-Age": "300",
      });
      res.end();
      return;
    }

    // Enforce path-style routing: /<bucket>/<key> and never virtual-hosted <bucket>.<host>
    if (host.startsWith(`${VPSTTT_BUCKET}.`)) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/xml" });
      res.end(xmlError("InvalidRequest", "Virtual-hosted style is disallowed"));
      return;
    }

    const decodedPath = decodeURIComponent(rawPathname);
    const prefix = `/${VPSTTT_BUCKET}/`;
    if (!decodedPath.startsWith(prefix) || decodedPath.length <= prefix.length) {
      res.writeHead(404, { ...corsHeaders, "Content-Type": "application/xml" });
      res.end(xmlError("NoSuchBucket", "Bucket or key missing"));
      return;
    }
    const key = decodedPath.slice(prefix.length);

    const auth = verifySigV4({
      method: req.method,
      pathname: rawPathname,
      rawQuery,
      headers: req.headers,
      body,
      accessKeyId: VPSTTT_ACCESS_KEY,
      secretAccessKey: VPSTTT_SECRET_KEY,
      region: VPSTTT_REGION,
      nowMs: Date.now() + nowOffsetMs,
    });
    if (!auth.ok) {
      res.writeHead(403, { ...corsHeaders, "Content-Type": "application/xml" });
      res.end(xmlError("AccessDenied", auth.reason));
      return;
    }

    if (req.method === "PUT") {
      const copySourceHeader = req.headers["x-amz-copy-source"];
      if (typeof copySourceHeader === "string") {
        const cleaned = decodeURIComponent(copySourceHeader.replace(/^\/+/, ""));
        const slash = cleaned.indexOf("/");
        const srcBucket = slash === -1 ? "" : cleaned.slice(0, slash);
        const srcKey = slash === -1 ? "" : cleaned.slice(slash + 1);
        const srcObj = srcBucket === VPSTTT_BUCKET ? objects.get(srcKey) : undefined;
        if (!srcObj) {
          res.writeHead(404, { ...corsHeaders, "Content-Type": "application/xml" });
          res.end(xmlError("NoSuchKey", "Copy source missing"));
          return;
        }
        const replaceMeta = String(req.headers["x-amz-metadata-directive"] ?? "").toUpperCase() === "REPLACE";
        const nextMeta = {};
        for (const [hk, hv] of Object.entries(req.headers)) {
          if (hk.startsWith("x-amz-meta-") && typeof hv === "string") nextMeta[hk.slice(11)] = hv;
        }
        objects.set(key, {
          bytes: new Uint8Array(srcObj.bytes),
          contentType:
            (replaceMeta ? req.headers["content-type"] : undefined) ??
            req.headers["content-type"] ??
            srcObj.contentType,
          contentDisposition:
            (replaceMeta ? req.headers["content-disposition"] : srcObj.contentDisposition) ?? null,
          metadata: replaceMeta ? nextMeta : { ...srcObj.metadata, ...nextMeta },
          etag: srcObj.etag,
        });
        res.writeHead(200, { ...corsHeaders, "Content-Type": "application/xml" });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>${new Date().toISOString()}</LastModified><ETag>"${srcObj.etag}"</ETag></CopyObjectResult>`,
        );
        return;
      }

      if (ifNoneMatch === "*" && objects.has(key)) {
        res.writeHead(412, { ...corsHeaders, "Content-Type": "application/xml" });
        res.end(xmlError("PreconditionFailed", "At least one pre-condition you specified did not hold"));
        return;
      }

      const metadata = {};
      for (const [hk, hv] of Object.entries(req.headers)) {
        if (hk.startsWith("x-amz-meta-") && typeof hv === "string") metadata[hk.slice(11)] = hv;
      }
      const etag = createHash("md5").update(body).digest("hex");
      objects.set(key, {
        bytes: new Uint8Array(body),
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream",
        contentDisposition: typeof req.headers["content-disposition"] === "string" ? req.headers["content-disposition"] : null,
        metadata,
        etag,
      });
      res.writeHead(200, { ...corsHeaders, ETag: `"${etag}"` });
      res.end();
      return;
    }

    if (req.method === "HEAD") {
      const obj = objects.get(key);
      if (!obj) {
        res.writeHead(404, corsHeaders);
        res.end();
        return;
      }
      const metaHeaders = Object.fromEntries(
        Object.entries(obj.metadata).map(([k, v]) => [`x-amz-meta-${k}`, v]),
      );
      res.writeHead(200, {
        ...corsHeaders,
        "Content-Length": String(obj.bytes.byteLength),
        "Content-Type": obj.contentType,
        ...(obj.contentDisposition ? { "Content-Disposition": obj.contentDisposition } : {}),
        ETag: `"${obj.etag}"`,
        ...metaHeaders,
      });
      res.end();
      return;
    }

    if (req.method === "GET") {
      const obj = objects.get(key);
      if (!obj) {
        res.writeHead(404, { ...corsHeaders, "Content-Type": "application/xml" });
        res.end(xmlError("NoSuchKey", "The specified key does not exist."));
        return;
      }
      const metaHeaders = Object.fromEntries(
        Object.entries(obj.metadata).map(([k, v]) => [`x-amz-meta-${k}`, v]),
      );
      const responseContentType = queryMap.get("response-content-type") ?? obj.contentType;
      const responseContentDisposition = queryMap.get("response-content-disposition") ?? obj.contentDisposition;
      res.writeHead(200, {
        ...corsHeaders,
        "Content-Length": String(obj.bytes.byteLength),
        "Content-Type": responseContentType,
        ...(responseContentDisposition ? { "Content-Disposition": responseContentDisposition } : {}),
        ETag: `"${obj.etag}"`,
        ...metaHeaders,
      });
      res.end(Buffer.from(obj.bytes));
      return;
    }

    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    res.writeHead(405, corsHeaders);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const endpoint = `https://127.0.0.1:${address.port}`;

  return {
    endpoint,
    certPem,
    objects,
    requests,
    setNowOffsetMs(ms) {
      nowOffsetMs = ms;
    },
    seedObject(key, bytes, { contentType = "application/octet-stream", contentDisposition = null, metadata = {} } = {}) {
      objects.set(key, {
        bytes: new Uint8Array(bytes),
        contentType,
        contentDisposition,
        metadata: { ...metadata },
        etag: createHash("md5").update(bytes).digest("hex"),
      });
    },
    async close() {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

function createIsolatedCaRequestHandler(certPem, outboundSpy) {
  const agent = new https.Agent({ ca: certPem });
  return {
    metadata: { handlerProtocol: "http/1.1" },
    async handle(httpRequest) {
      const qPairs = [];
      if (httpRequest.query) {
        for (const [k, v] of Object.entries(httpRequest.query)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) {
            for (const item of v) qPairs.push(`${rfc3986(k)}=${rfc3986(String(item))}`);
          } else if (v === null) {
            qPairs.push(rfc3986(k));
          } else {
            qPairs.push(`${rfc3986(k)}=${rfc3986(String(v))}`);
          }
        }
      }
      const qs = qPairs.join("&");
      const pathWithQuery = qs ? `${httpRequest.path}?${qs}` : httpRequest.path;
      outboundSpy.push({
        method: httpRequest.method,
        hostname: httpRequest.hostname,
        port: httpRequest.port ?? null,
        path: pathWithQuery,
      });

      const bodyBuf =
        httpRequest.body === undefined || httpRequest.body === null
          ? null
          : typeof httpRequest.body === "string"
            ? Buffer.from(httpRequest.body, "utf8")
            : Buffer.isBuffer(httpRequest.body)
              ? httpRequest.body
              : Buffer.from(httpRequest.body);

      return await new Promise((resolve, reject) => {
        const req = https.request(
          {
            protocol: httpRequest.protocol,
            hostname: httpRequest.hostname,
            port: httpRequest.port,
            method: httpRequest.method,
            path: pathWithQuery,
            headers: httpRequest.headers,
            agent,
          },
          (res) => {
            const normalizedHeaders = {};
            for (const [hk, hv] of Object.entries(res.headers)) {
              if (typeof hv === "string") normalizedHeaders[hk] = hv;
              else if (Array.isArray(hv)) normalizedHeaders[hk] = hv.join(", ");
            }
            resolve({
              response: {
                statusCode: res.statusCode ?? -1,
                reason: res.statusMessage,
                headers: normalizedHeaders,
                body: res,
              },
            });
          },
        );
        req.on("error", reject);
        if (bodyBuf) req.write(bodyBuf);
        req.end();
      });
    },
  };
}

function browserHttpsRequest(urlString, { method = "GET", headers = {}, body, certPem }) {
  const target = new URL(urlString);
  const agent = certPem ? new https.Agent({ ca: certPem }) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: new Uint8Array(Buffer.concat(chunks)),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(Buffer.from(body));
    req.end();
  });
}

function makeVpstttEnv(endpoint, extra = {}) {
  return {
    DOCUMENT_STORAGE_ENVIRONMENT: "production",
    DOCUMENT_STORAGE_PROVIDER: "vpsttt",
    VPSTTT_STORAGE_ENDPOINT: endpoint,
    VPSTTT_STORAGE_REGION: VPSTTT_REGION,
    VPSTTT_STORAGE_BUCKET: VPSTTT_BUCKET,
    VPSTTT_STORAGE_ACCESS_KEY_ID: VPSTTT_ACCESS_KEY,
    VPSTTT_STORAGE_SECRET_ACCESS_KEY: VPSTTT_SECRET_KEY,
    VPSTTT_STORAGE_FORCE_PATH_STYLE: "true",
    ATTENDANCE_ENABLED: "true",
    ATTENDANCE_TIME_TOKEN_SECRET: ATTENDANCE_SECRET,
    // Deliberately include valid R2_* vars to prove VPSTTT never touches Cloudflare when selected.
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_BUCKET_NAME: DOCUMENT_BUCKETS.production,
    R2_ACCESS_KEY_ID: "R2SYNTHETICACCESSKEY01",
    R2_SECRET_ACCESS_KEY: "r2-synthetic-secret-value-0001",
    ...extra,
  };
}

function createTestS3Client(env, certPem, outboundSpy) {
  const config = loadR2Config(env);
  assert.ok(config, "expected valid storage config");
  return new S3Client({
    ...buildR2S3ClientConfig(config),
    requestHandler: createIsolatedCaRequestHandler(certPem, outboundSpy),
  });
}

const PNG_BYTES = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");

async function buildExifJpeg() {
  return new Uint8Array(
    await sharp({ create: { width: 10, height: 8, channels: 3, background: "#224466" } })
      .jpeg({ quality: 90 })
      .withMetadata({ exif: { IFD0: { Artist: "private-exif-marker" } } })
      .toBuffer(),
  );
}

function createDirectEntryRepo() {
  const docs = new Map();
  let versionCounter = 1;
  return {
    docs,
    repository: {
      async reserveDocumentUpload(input) {
        for (const doc of docs.values()) {
          if (doc.entry_id === input.entry_id && doc.idempotency_key === input.idempotency_key) {
            return {
              ok: true,
              data: {
                document_id: doc.document_id,
                version: doc.version,
                entry_version: doc.entry_version,
                reused: true,
                storage_key: doc.storage_key,
                upload_status: doc.upload_status,
                scan_status: doc.scan_status,
                validation_status: doc.validation_status,
              },
            };
          }
        }
        const document_id = randomUUID();
        const version = versionCounter++;
        const storage_key = `p1.6/${input.entry_id}/${input.document_type}/${version}/${document_id}`;
        const row = {
          document_id,
          entry_id: input.entry_id,
          idempotency_key: input.idempotency_key,
          document_type: input.document_type,
          version,
          entry_version: input.expected_entry_version + 1,
          size_bytes: input.size_bytes,
          mime_type: input.mime_type,
          storage_key,
          checksum_sha256: null,
          upload_status: "QUEUED",
          scan_status: "PENDING",
          validation_status: "PENDING",
        };
        docs.set(document_id, row);
        return {
          ok: true,
          data: {
            document_id,
            version,
            entry_version: row.entry_version,
            reused: false,
            storage_key,
            upload_status: row.upload_status,
            scan_status: row.scan_status,
            validation_status: row.validation_status,
          },
        };
      },
      async getDocumentContext(input) {
        const doc = docs.get(input.document_id);
        if (!doc || doc.entry_id !== input.entry_id) return { ok: false, kind: "not-found" };
        return {
          ok: true,
          data: {
            document_id: doc.document_id,
            document_type: doc.document_type,
            version: doc.version,
            entry_version: doc.entry_version,
            size_bytes: doc.size_bytes,
            mime_type: doc.mime_type,
            storage_key: doc.storage_key,
            checksum_sha256: doc.checksum_sha256,
            upload_status: doc.upload_status,
            scan_status: doc.scan_status,
            validation_status: doc.validation_status,
          },
        };
      },
      async finalizeDocument(input) {
        const doc = docs.get(input.document_id);
        if (!doc || doc.entry_id !== input.entry_id) return { ok: false, kind: "not-found" };
        if (input.expected_entry_version !== doc.entry_version) return { ok: false, kind: "conflict" };
        doc.entry_version += 1;
        if (input.outcome === "validated") {
          doc.upload_status = "READY";
          doc.scan_status = "NOT_REQUIRED";
          doc.validation_status = "VALIDATED";
          doc.checksum_sha256 = input.checksum_sha256;
          doc.size_bytes = input.size_bytes;
        } else {
          doc.upload_status = "FAILED";
          doc.scan_status = "NOT_REQUIRED";
          doc.validation_status = "REJECTED";
        }
        return {
          ok: true,
          data: {
            document_id: doc.document_id,
            version: doc.version,
            entry_version: doc.entry_version,
            upload_status: doc.upload_status,
            scan_status: doc.scan_status,
            validation_status: doc.validation_status,
            reused: false,
          },
        };
      },
    },
  };
}

function createAttendanceRepo() {
  const byKey = new Map();
  const rows = [];
  return {
    byKey,
    rows,
    repository: {
      async lookupCheckInIdempotency(input) {
        const hit = byKey.get(`${input.app_user_id}:${input.idempotency_key}`);
        if (!hit) return { ok: true, found: false };
        if (hit.request_fingerprint !== input.request_fingerprint) {
          return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
        }
        return {
          ok: true,
          found: true,
          photo_storage_key: hit.photo_storage_key,
          checkin: { ...hit.projection, replayed: true },
        };
      },
      async recordCheckIn(input) {
        const composite = `${input.app_user_id}:${input.idempotency_key}`;
        const hit = byKey.get(composite);
        if (hit) {
          if (hit.request_fingerprint !== input.request_fingerprint) {
            return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
          }
          return { ok: true, checkin: { ...hit.projection, replayed: true } };
        }
        const capturedAtMs =
          input.time_source === "SERVER_ANCHORED"
            ? Date.parse(input.time_anchor_issued_at) + input.elapsed_since_anchor_ms
            : Date.parse(input.device_claimed_at);
        if (
          input.time_source === "SERVER_ANCHORED" &&
          Date.parse(input.received_at) - capturedAtMs > ATTENDANCE_MAX_SYNC_WINDOW_MS
        ) {
          return { ok: false, code: "ATTENDANCE_SYNC_WINDOW_EXPIRED" };
        }
        const projection = {
          checkin_id: randomUUID(),
          business_date: "2026-10-23",
          sequence_in_day: rows.length + 1,
          daily_count: rows.length + 1,
          captured_at: new Date(capturedAtMs).toISOString(),
          received_at: input.received_at,
          time_source: input.time_source,
          replayed: false,
        };
        const record = { ...input, projection };
        rows.push(record);
        byKey.set(composite, record);
        return { ok: true, checkin: projection };
      },
    },
  };
}

test("VPSTTT HTTPS S3 server enforces TLS, SigV4, strict CORS, path-style, and reads pre-seeded production/* clone keys", async () => {
  const srv = await createMockVpstttServer();
  const outboundSpy = [];
  try {
    const env = makeVpstttEnv(srv.endpoint);
    const client = createTestS3Client(env, srv.certPem, outboundSpy);
    const docStorage = createR2DocumentStorage(env, { client });
    const attStorage = createR2AttendanceStorage(env, { client });
    const vfinStorage = createR2VendorFinanceEvidenceStorage(env, { client });
    const saStorage = createR2SalaryAdvanceEvidenceStorage(env, { client });

    assert.equal(docStorage.available(), true);
    assert.equal(attStorage.available(), true);
    assert.equal(vfinStorage.available(), true);
    assert.equal(saStorage.available(), true);

    const jpegBytes = await buildExifJpeg();
    const userId = ACTOR.app_user_id;
    const idemId = "c1000000-0000-4000-8000-000000000011";
    const objId = "d1000000-0000-4000-8000-000000000011";
    const attKey = `production/attendance-checkins/${userId}/${idemId}/${objId}.jpg`;
    srv.seedObject(attKey, jpegBytes, { contentType: "image/jpeg" });

    const entryId = "a2000000-0000-4000-8000-000000000001";
    const docIds = {
      CCCD_FRONT: "b2000000-0000-4000-8000-000000000001",
      CCCD_BACK: "b2000000-0000-4000-8000-000000000002",
      WORKER_PORTRAIT: "b2000000-0000-4000-8000-000000000003",
      EMPLOYMENT_CONTRACT: "b2000000-0000-4000-8000-000000000004",
    };
    const deFrontKey = `p1.6/${entryId}/CCCD_FRONT/1/${docIds.CCCD_FRONT}`;
    const deBackKey = `p1.6/${entryId}/CCCD_BACK/1/${docIds.CCCD_BACK}`;
    const dePortraitKey = `p1.6/${entryId}/WORKER_PORTRAIT/1/${docIds.WORKER_PORTRAIT}`;
    const deContractKey = `p1.6/${entryId}/EMPLOYMENT_CONTRACT/1/${docIds.EMPLOYMENT_CONTRACT}`;
    srv.seedObject(`production/final/${deFrontKey}`, PNG_BYTES, { contentType: "image/png" });
    srv.seedObject(`production/final/${deBackKey}`, jpegBytes, { contentType: "image/jpeg" });
    srv.seedObject(`production/final/${dePortraitKey}`, jpegBytes, { contentType: "image/jpeg" });
    srv.seedObject(`production/final/${deContractKey}`, PDF_BYTES, { contentType: "application/pdf" });

    const vfinKey = `vfin-01/entry/${entryId}/${docIds.CCCD_FRONT}`;
    srv.seedObject(`production/final/${vfinKey}`, PNG_BYTES, { contentType: "image/png" });

    const saReqId = "e2000000-0000-4000-8000-000000000001";
    const saUpId = "e2000000-0000-4000-8000-000000000002";
    const saKey = `salary-advance/requests/${saReqId}/evidence/${saUpId}`;
    srv.seedObject(`production/final/${saKey}`, PNG_BYTES, { contentType: "image/png" });

    // TLS without custom CA must fail verification (proves TLS is actually enforced).
    await assert.rejects(browserHttpsRequest(`${srv.endpoint}/${VPSTTT_BUCKET}/production/final/${deFrontKey}`, {}));

    // Read pre-seeded cloned keys across all 4 adapters.
    assert.deepEqual(await attStorage.readCheckInPhoto(attKey), jpegBytes);
    assert.deepEqual(await docStorage.readFinal(deFrontKey), PNG_BYTES);
    assert.deepEqual(await docStorage.readFinal(deBackKey), jpegBytes);
    assert.deepEqual(await docStorage.readFinal(dePortraitKey), jpegBytes);
    assert.deepEqual(await docStorage.readFinal(deContractKey), PDF_BYTES);

    const signedContract = await docStorage.createDownloadUrl({
      storage_key: deContractKey,
      mime_type: "application/pdf",
      document_type: "EMPLOYMENT_CONTRACT",
      version: 1,
    });
    const dlContract = await browserHttpsRequest(signedContract.url, {
      headers: { origin: APP_ORIGIN },
      certPem: srv.certPem,
    });
    assert.equal(dlContract.status, 200);
    assert.equal(dlContract.headers["access-control-allow-origin"], APP_ORIGIN);
    assert.equal(dlContract.headers["content-disposition"], 'attachment; filename="employment-contract-v1.pdf"');
    assert.deepEqual(dlContract.body, PDF_BYTES);

    const signedVfin = await vfinStorage.createDownloadUrl({
      storage_key: vfinKey,
      mime_type: "image/png",
    });
    const dlVfin = await browserHttpsRequest(signedVfin.url, {
      headers: { origin: APP_ORIGIN },
      certPem: srv.certPem,
    });
    assert.equal(dlVfin.status, 200);
    assert.deepEqual(dlVfin.body, PNG_BYTES);

    assert.deepEqual(await saStorage.readFinalBounded(saKey), { kind: "found", bytes: PNG_BYTES });
    assert.deepEqual(await saStorage.readWorkerPortraitFinalBounded(dePortraitKey), {
      kind: "found",
      bytes: jpegBytes,
    });

    // Anonymous and foreign-origin checks.
    const anonGet = await browserHttpsRequest(`${srv.endpoint}/${VPSTTT_BUCKET}/production/final/${deFrontKey}`, {
      certPem: srv.certPem,
    });
    assert.equal(anonGet.status, 403);
    const anonHead = await browserHttpsRequest(`${srv.endpoint}/${VPSTTT_BUCKET}/production/final/${deFrontKey}`, {
      method: "HEAD",
      certPem: srv.certPem,
    });
    assert.equal(anonHead.status, 403);

    const evilPreflight = await browserHttpsRequest(signedContract.url, {
      method: "OPTIONS",
      headers: { origin: FOREIGN_ORIGIN },
      certPem: srv.certPem,
    });
    assert.equal(evilPreflight.status, 403);
    assert.equal(evilPreflight.headers["access-control-allow-origin"], undefined);

    assert.ok(srv.requests.length > 0);
    for (const req of srv.requests) {
      assert.ok(req.path.startsWith(`/${VPSTTT_BUCKET}/`), `expected path-style on ${req.path}`);
      assert.equal(req.host.startsWith(`${VPSTTT_BUCKET}.`), false);
    }
    assert.equal(
      outboundSpy.some((r) => r.hostname.includes("r2.cloudflarestorage.com")),
      false,
    );
  } finally {
    await srv.close();
  }
});

test("full upload -> staging -> finalize -> reopen lifecycle across Direct Entry, Reaper, VFIN, and Salary Advance on VPSTTT", async () => {
  const srv = await createMockVpstttServer();
  const outboundSpy = [];
  try {
    const env = makeVpstttEnv(srv.endpoint);
    const client = createTestS3Client(env, srv.certPem, outboundSpy);
    const docStorage = createR2DocumentStorage(env, { client });
    const vfinStorage = createR2VendorFinanceEvidenceStorage(env, { client });
    const saStorage = createR2SalaryAdvanceEvidenceStorage(env, { client });
    const repo = createDirectEntryRepo();
    const resolveSession = async () => ({ actor: { ok: true, actor: ACTOR }, response_headers: {} });
    const entryId = "a2000000-0000-4000-8000-000000000002";
    const jpegWithExif = await buildExifJpeg();

    // 1) Direct Entry lifecycle for all 4 document types.
    const cases = [
      { type: "CCCD_FRONT", mime: "image/png", bytes: PNG_BYTES, expectedVersion: 1 },
      { type: "CCCD_BACK", mime: "image/jpeg", bytes: jpegWithExif, expectedVersion: 2 },
      { type: "EMPLOYMENT_CONTRACT", mime: "application/pdf", bytes: PDF_BYTES, expectedVersion: 4 },
      { type: "WORKER_PORTRAIT", mime: "image/jpeg", bytes: jpegWithExif, expectedVersion: 6 },
    ];
    let entryVersion = 1;
    const finalizedIds = {};

    for (const c of cases) {
      const reserveRes = await reserveDirectEntryDocument(
        new Request(`${APP_ORIGIN}/api/direct-entry/entries/${entryId}/documents`, {
          method: "POST",
          headers: {
            origin: APP_ORIGIN,
            host: "bi2.hrpartner.vn",
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({
            document_type: c.type,
            expected_entry_version: entryVersion,
            size_bytes: c.bytes.byteLength,
            mime_type: c.mime,
          }),
        }),
        entryId,
        "true",
        { resolveSession, repository: repo.repository, storage: docStorage },
      );
      assert.equal(reserveRes.status, 201);
      const reserved = await reserveRes.json();
      entryVersion = reserved.entry_version;
      const ttlPut = (Date.parse(reserved.upload.expires_at) - Date.now()) / 1000;
      assert.ok(ttlPut > 0 && ttlPut <= 300);

      // Strict CORS preflight: allow app origin, reject foreign origin.
      const okPre = await browserHttpsRequest(reserved.upload.url, {
        method: "OPTIONS",
        headers: { origin: APP_ORIGIN, "access-control-request-method": "PUT" },
        certPem: srv.certPem,
      });
      assert.equal(okPre.status, 204);
      assert.equal(okPre.headers["access-control-allow-origin"], APP_ORIGIN);
      assert.notEqual(okPre.headers["access-control-allow-origin"], "*");

      const badPre = await browserHttpsRequest(reserved.upload.url, {
        method: "OPTIONS",
        headers: { origin: FOREIGN_ORIGIN, "access-control-request-method": "PUT" },
        certPem: srv.certPem,
      });
      assert.equal(badPre.status, 403);
      assert.equal(badPre.headers["access-control-allow-origin"], undefined);

      // Tampering signed headers (content-type / content-length) fails SigV4 with 403.
      const badContentTypePut = await browserHttpsRequest(reserved.upload.url, {
        method: "PUT",
        headers: {
          origin: APP_ORIGIN,
          "content-type": c.mime === "image/png" ? "image/jpeg" : "image/png",
          "content-length": String(c.bytes.byteLength),
        },
        body: c.bytes,
        certPem: srv.certPem,
      });
      assert.equal(badContentTypePut.status, 403);

      const badLengthPut = await browserHttpsRequest(reserved.upload.url, {
        method: "PUT",
        headers: {
          origin: APP_ORIGIN,
          "content-type": c.mime,
          "content-length": String(c.bytes.byteLength + 1),
        },
        body: Buffer.concat([Buffer.from(c.bytes), Buffer.from([0])]),
        certPem: srv.certPem,
      });
      assert.equal(badLengthPut.status, 403);

      // Real browser HTTPS PUT to presigned URL.
      const putRes = await browserHttpsRequest(reserved.upload.url, {
        method: "PUT",
        headers: {
          origin: APP_ORIGIN,
          ...reserved.upload.headers,
          "content-length": String(c.bytes.byteLength),
        },
        body: c.bytes,
        certPem: srv.certPem,
      });
      assert.equal(putRes.status, 200);
      assert.equal(putRes.headers["access-control-allow-origin"], APP_ORIGIN);

      // Finalize (head -> read -> inspect -> sanitize portrait -> promote -> deleteStaged).
      const finRes = await finalizeDirectEntryDocument(
        new Request(`${APP_ORIGIN}/api/direct-entry/entries/${entryId}/documents/${reserved.document_id}/finalize`, {
          method: "POST",
          headers: {
            origin: APP_ORIGIN,
            host: "bi2.hrpartner.vn",
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({ expected_entry_version: entryVersion }),
        }),
        entryId,
        reserved.document_id,
        "true",
        { resolveSession, repository: repo.repository, storage: docStorage },
      );
      assert.equal(finRes.status, 200);
      const finalized = await finRes.json();
      assert.equal(finalized.upload_status, "READY");
      assert.equal(finalized.validation_status, "VALIDATED");
      entryVersion = finalized.entry_version;
      finalizedIds[c.type] = reserved.document_id;

      // Staging key must be deleted after finalize.
      const docMeta = repo.docs.get(reserved.document_id);
      assert.equal(srv.objects.has(`production/staging/${docMeta.storage_key}`), false);
      assert.equal(srv.objects.has(`production/final/${docMeta.storage_key}`), true);

      if (c.type === "WORKER_PORTRAIT") {
        // Portrait is sanitized (EXIF stripped) and blocked on generic download, allowed on preview.
        const dlDenied = await downloadDirectEntryDocument(
          new Request(`${APP_ORIGIN}/x`),
          entryId,
          reserved.document_id,
          "true",
          { resolveSession, repository: repo.repository, storage: docStorage },
        );
        assert.equal(dlDenied.status, 404);

        const prevRes = await previewWorkerPortraitDocument(
          new Request(`${APP_ORIGIN}/x`),
          entryId,
          reserved.document_id,
          "true",
          { resolveSession, repository: repo.repository, storage: docStorage },
        );
        assert.equal(prevRes.status, 200);
        const streamed = new Uint8Array(await prevRes.arrayBuffer());
        assert.equal(Buffer.from(streamed).toString("latin1").includes("private-exif-marker"), false);
      } else {
        // Download 302 -> browser HTTPS GET with attachment disposition.
        const dlRes = await downloadDirectEntryDocument(
          new Request(`${APP_ORIGIN}/x`),
          entryId,
          reserved.document_id,
          "true",
          { resolveSession, repository: repo.repository, storage: docStorage },
        );
        assert.equal(dlRes.status, 302);
        const location = dlRes.headers.get("location");
        assert.ok(location);
        const parsedLoc = new URL(location);
        assert.ok(Number(parsedLoc.searchParams.get("X-Amz-Expires")) <= 120);

        const got = await browserHttpsRequest(location, {
          headers: { origin: APP_ORIGIN },
          certPem: srv.certPem,
        });
        assert.equal(got.status, 200);
        assert.match(String(got.headers["content-disposition"]), /^attachment; filename="/);
        assert.deepEqual(got.body, c.bytes);
      }
    }

    // Unauthorized actor fails 403 BEFORE touching VPSTTT; expired presigned URL fails 403.
    const reqCountBeforeUnauth = srv.requests.length;
    const unauthDownload = await downloadDirectEntryDocument(
      new Request(`${APP_ORIGIN}/x`),
      entryId,
      finalizedIds.CCCD_FRONT,
      "true",
      {
        resolveSession: async () => ({
          actor: { ok: true, actor: { ...ACTOR, capabilities: [] } },
          response_headers: {},
        }),
        repository: repo.repository,
        storage: docStorage,
      },
    );
    assert.equal(unauthDownload.status, 403);
    assert.equal(srv.requests.length, reqCountBeforeUnauth);

    const freshDownload = await downloadDirectEntryDocument(
      new Request(`${APP_ORIGIN}/x`),
      entryId,
      finalizedIds.CCCD_FRONT,
      "true",
      { resolveSession, repository: repo.repository, storage: docStorage },
    );
    const expiredUrl = freshDownload.headers.get("location");
    srv.setNowOffsetMs(301_000);
    const expiredGet = await browserHttpsRequest(expiredUrl, {
      headers: { origin: APP_ORIGIN },
      certPem: srv.certPem,
    });
    assert.equal(expiredGet.status, 403);
    const expiredPut = await docStorage.createUploadUrl({
      storage_key: `p1.6/${entryId}/CCCD_FRONT/9/${randomUUID()}`,
      mime_type: "image/png",
      size_bytes: PNG_BYTES.byteLength,
    });
    const expiredPutRes = await browserHttpsRequest(expiredPut.url, {
      method: "PUT",
      headers: { origin: APP_ORIGIN, "content-type": "image/png", "content-length": String(PNG_BYTES.byteLength) },
      body: PNG_BYTES,
      certPem: srv.certPem,
    });
    assert.equal(expiredPutRes.status, 403);
    srv.setNowOffsetMs(0);

    // 2) Enrollment portrait stage + reaper cleanup on VPSTTT.
    const stageId = randomUUID();
    const stagedDocKey = `p1.6/${entryId}/CCCD_FRONT/8/${randomUUID()}`;
    const finalDocKey = `p1.6/${entryId}/CCCD_FRONT/9/${randomUUID()}`;
    await docStorage.writeEnrollmentPortraitStage({ stage_id: stageId, mime_type: "image/png", bytes: PNG_BYTES });
    assert.deepEqual(await docStorage.readEnrollmentPortraitStage(stageId), PNG_BYTES);
    await docStorage.writeStaged({ storage_key: stagedDocKey, mime_type: "image/png", bytes: PNG_BYTES });
    await docStorage.writeStaged({ storage_key: finalDocKey, mime_type: "image/png", bytes: PNG_BYTES });
    await docStorage.promote({ storage_key: finalDocKey, mime_type: "image/png" });

    const reaperResult = await runWorkerPortraitStageReaper({
      storage: docStorage,
      repository: {
        async claimExpiredCleanup() { return { ok: true, data: [stageId] }; },
        async completeCleanup() { return { ok: true, data: true }; },
        async claimSubmissionObjectCleanup() {
          return {
            ok: true,
            data: [
              { cleanup_id: randomUUID(), object_kind: "DOCUMENT_STAGED", stage_id: null, storage_key: stagedDocKey },
              { cleanup_id: randomUUID(), object_kind: "DOCUMENT_FINAL", stage_id: null, storage_key: finalDocKey },
            ],
          };
        },
        async completeSubmissionObjectCleanup() { return { ok: true, data: true }; },
      },
    });
    assert.deepEqual(reaperResult, { claimed: 3, deleted: 3, failed: 0 });
    assert.equal(srv.objects.has(`production/enrollment-staging/${stageId}`), false);
    assert.equal(srv.objects.has(`production/staging/${stagedDocKey}`), false);
    assert.equal(srv.objects.has(`production/final/${finalDocKey}`), false);

    // 3) Vendor Finance lifecycle on VPSTTT.
    const vfinKey = `vfin-01/entry/${entryId}/${randomUUID()}`;
    const vfinUpload = await vfinStorage.createUploadUrl({
      storage_key: vfinKey,
      mime_type: "image/png",
      size_bytes: PNG_BYTES.byteLength,
    });
    const vfinPut = await browserHttpsRequest(vfinUpload.url, {
      method: "PUT",
      headers: { origin: APP_ORIGIN, ...vfinUpload.headers, "content-length": String(PNG_BYTES.byteLength) },
      body: PNG_BYTES,
      certPem: srv.certPem,
    });
    assert.equal(vfinPut.status, 200);
    assert.deepEqual(await vfinStorage.readStagedBounded(vfinKey), { kind: "found", bytes: PNG_BYTES });
    await vfinStorage.promoteStagedToFinal({ storage_key: vfinKey, mime_type: "image/png" });
    await vfinStorage.deleteStaged(vfinKey);
    const vfinDl = await vfinStorage.createDownloadUrl({ storage_key: vfinKey, mime_type: "image/png" });
    const vfinGet = await browserHttpsRequest(vfinDl.url, { headers: { origin: APP_ORIGIN }, certPem: srv.certPem });
    assert.equal(vfinGet.status, 200);
    assert.deepEqual(vfinGet.body, PNG_BYTES);

    // 4) Salary Advance lifecycle on VPSTTT.
    const saKey = `salary-advance/requests/${entryId}/evidence/${randomUUID()}`;
    const saUpload = await saStorage.createUploadUrl({
      storage_key: saKey,
      mime_type: "image/png",
      size_bytes: PNG_BYTES.byteLength,
    });
    const saPut = await browserHttpsRequest(saUpload.url, {
      method: "PUT",
      headers: { origin: APP_ORIGIN, ...saUpload.headers, "content-length": String(PNG_BYTES.byteLength) },
      body: PNG_BYTES,
      certPem: srv.certPem,
    });
    assert.equal(saPut.status, 200);
    assert.deepEqual(await saStorage.readStagedBounded(saKey), { kind: "found", bytes: PNG_BYTES });
    await saStorage.promoteStagedToFinal({ storage_key: saKey, mime_type: "image/png" });
    await saStorage.deleteStaged(saKey);
    assert.deepEqual(await saStorage.readFinalBounded(saKey), { kind: "found", bytes: PNG_BYTES });
  } finally {
    await srv.close();
  }
});

test("PR #49 attendance regression (9-key iOS -> 11-key replay) and If-None-Match: * collision handling on VPSTTT", async () => {
  const srv = await createMockVpstttServer();
  const outboundSpy = [];
  try {
    const env = makeVpstttEnv(srv.endpoint);
    const client = createTestS3Client(env, srv.certPem, outboundSpy);
    const attStorage = createR2AttendanceStorage(env, { client });
    const repo = createAttendanceRepo();
    const resolveSession = async () => ({ actor: { ok: true, actor: ACTOR }, response_headers: {} });

    const jpegA = await buildExifJpeg();
    const jpegB = new Uint8Array(
      await sharp({ create: { width: 12, height: 8, channels: 3, background: "#993322" } }).jpeg().toBuffer(),
    );
    const shaA = sha256Hex(jpegA);
    const idemKey = "f1000000-0000-4000-8000-000000000049";
    const nowMs = Date.parse("2026-10-23T01:25:00.000Z");

    const buildReq = (metaObj) => {
      const form = new FormData();
      form.append("metadata", JSON.stringify(metaObj));
      form.append("photo", new Blob([jpegA], { type: "image/jpeg" }), "checkin.jpg");
      return new Request(`${APP_ORIGIN}/api/attendance/check-in`, {
        method: "POST",
        headers: {
          origin: APP_ORIGIN,
          host: "bi2.hrpartner.vn",
          "idempotency-key": idemKey,
        },
        body: form,
      });
    };

    const baseMeta = {
      latitude: 21.0285,
      longitude: 105.8542,
      accuracy_meters: 12.5,
      address_hint: "Ha Noi",
      client_captured_at: "2026-10-21T07:45:00.000+07:00",
      note: "iOS offline",
      idempotency_key: idemKey,
      photo_sha256: shaA,
      time_source: "DEVICE_CLOCK_UNVERIFIED",
    };

    // 9-key iOS offline check-in -> 201 and 1 VPSTTT object with If-None-Match: * and x-amz-meta-sha256.
    const res1 = await postAttendanceCheckIn(buildReq(baseMeta), env, {
      resolveSession,
      repository: repo.repository,
      storage: attStorage,
      now: () => nowMs,
    });
    assert.equal(res1.status, 201);
    const body1 = await res1.json();
    assert.equal(body1.checkin.replayed, false);
    assert.equal(repo.rows.length, 1);
    assert.equal(srv.objects.size, 1);

    const [storedKey, storedObj] = [...srv.objects.entries()][0];
    assert.ok(storedKey.startsWith(`production/attendance-checkins/${ACTOR.app_user_id}/${idemKey}/`));
    assert.equal(storedObj.metadata.sha256, shaA);
    const putReq = srv.requests.find((r) => r.method === "PUT" && r.path.includes(storedKey));
    assert.equal(putReq?.ifNoneMatch, "*");

    // Replay same Idempotency-Key with 11-key payload -> 200 replayed: true, still 1 DB row & 1 VPSTTT object.
    const res2 = await postAttendanceCheckIn(
      buildReq({ ...baseMeta, time_token: null, elapsed_since_anchor_ms: null }),
      env,
      { resolveSession, repository: repo.repository, storage: attStorage, now: () => nowMs },
    );
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.checkin.replayed, true);
    assert.equal(body2.checkin.checkin_id, body1.checkin.checkin_id);
    assert.equal(repo.rows.length, 1);
    assert.equal(srv.objects.size, 1);

    // Direct ensureCheckInPhoto conditional PUT collision (If-None-Match: * -> 412).
    const fixedObjId = "e3000000-0000-4000-8000-000000000001";
    const first = await attStorage.ensureCheckInPhoto({
      app_user_id: ACTOR.app_user_id,
      idempotency_key: idemKey,
      object_id: fixedObjId,
      photo_sha256: shaA,
      bytes: jpegA,
    });
    assert.deepEqual(first, {
      ok: true,
      storage_key: `production/attendance-checkins/${ACTOR.app_user_id}/${idemKey}/${fixedObjId}.jpg`,
      created_now: true,
    });

    const reqsBeforeSameCollision = srv.requests.length;
    const sameCollision = await attStorage.ensureCheckInPhoto({
      app_user_id: ACTOR.app_user_id,
      idempotency_key: idemKey,
      object_id: fixedObjId,
      photo_sha256: shaA,
      bytes: jpegA,
    });
    assert.deepEqual(sameCollision, {
      ok: true,
      storage_key: first.storage_key,
      created_now: false,
    });
    assert.equal(
      srv.requests.slice(reqsBeforeSameCollision).some((r) => r.method === "HEAD"),
      true,
    );

    const diffCollision = await attStorage.ensureCheckInPhoto({
      app_user_id: ACTOR.app_user_id,
      idempotency_key: idemKey,
      object_id: fixedObjId,
      photo_sha256: sha256Hex(jpegB),
      bytes: jpegB,
    });
    assert.deepEqual(diffCollision, { ok: false, kind: "conflict" });
    assert.deepEqual(srv.objects.get(first.storage_key).bytes, jpegA);
  } finally {
    await srv.close();
  }
});

test("misconfigured VPSTTT fails closed across all 4 adapters & APIs with zero Cloudflare/VPSTTT requests", async () => {
  const srv = await createMockVpstttServer();
  const outboundSpy = [];
  try {
    const validBase = makeVpstttEnv(srv.endpoint);
    const badConfigs = [
      { ...validBase, VPSTTT_STORAGE_ENDPOINT: undefined },
      { ...validBase, VPSTTT_STORAGE_ENDPOINT: "http://127.0.0.1:9000" },
      { ...validBase, VPSTTT_STORAGE_BUCKET: "INVALID_BUCKET" },
      { ...validBase, VPSTTT_STORAGE_REGION: undefined },
      { ...validBase, VPSTTT_STORAGE_ACCESS_KEY_ID: "<vpsttt-access-key>" },
      { ...validBase, VPSTTT_STORAGE_FORCE_PATH_STYLE: "yes" },
    ];

    const entryId = "a2000000-0000-4000-8000-000000000009";
    const documentId = "b2000000-0000-4000-8000-000000000009";
    const resolveSession = async () => ({ actor: { ok: true, actor: ACTOR }, response_headers: {} });
    const repo = createDirectEntryRepo();
    const attRepo = createAttendanceRepo();

    for (const badEnv of badConfigs) {
      const docStorage = createR2DocumentStorage(badEnv);
      const attStorage = createR2AttendanceStorage(badEnv);
      const vfinStorage = createR2VendorFinanceEvidenceStorage(badEnv);
      const saStorage = createR2SalaryAdvanceEvidenceStorage(badEnv);

      assert.equal(docStorage.available(), false);
      assert.equal(attStorage.available(), false);
      assert.equal(vfinStorage.available(), false);
      assert.equal(saStorage.available(), false);

      let multipartRead = false;
      const unreadMultipartReq = new Request(`${APP_ORIGIN}/api/attendance/check-in`, {
        method: "POST",
        headers: {
          origin: APP_ORIGIN,
          host: "bi2.hrpartner.vn",
          "content-type": "multipart/form-data; boundary=testboundary",
          "idempotency-key": randomUUID(),
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("--testboundary--\r\n"));
            controller.close();
          },
        }),
        duplex: "half",
      });
      const rawGetReader = unreadMultipartReq.body.getReader.bind(unreadMultipartReq.body);
      unreadMultipartReq.body.getReader = () => {
        multipartRead = true;
        return rawGetReader();
      };
      const attRes = await postAttendanceCheckIn(unreadMultipartReq, badEnv, {
        resolveSession,
        repository: attRepo.repository,
        storage: attStorage,
      });
      assert.equal(attRes.status, 503);
      assert.deepEqual(await attRes.json(), { ok: false, code: "ATTENDANCE_UNAVAILABLE" });
      assert.equal(multipartRead, false);
      assert.equal(unreadMultipartReq.bodyUsed, false);

      const reserveRes = await reserveDirectEntryDocument(
        new Request(`${APP_ORIGIN}/api/direct-entry/entries/${entryId}/documents`, {
          method: "POST",
          headers: {
            origin: APP_ORIGIN,
            host: "bi2.hrpartner.vn",
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({
            document_type: "CCCD_FRONT",
            expected_entry_version: 1,
            size_bytes: PNG_BYTES.byteLength,
            mime_type: "image/png",
          }),
        }),
        entryId,
        "true",
        { resolveSession, repository: repo.repository, storage: docStorage },
      );
      assert.equal(reserveRes.status, 503);
      assert.deepEqual(await reserveRes.json(), { ok: false, code: "DOCUMENT_STORAGE_UNAVAILABLE" });

      const finalizeRes = await finalizeDirectEntryDocument(
        new Request(`${APP_ORIGIN}/api/direct-entry/entries/${entryId}/documents/${documentId}/finalize`, {
          method: "POST",
          headers: {
            origin: APP_ORIGIN,
            host: "bi2.hrpartner.vn",
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({ expected_entry_version: 1 }),
        }),
        entryId,
        documentId,
        "true",
        { resolveSession, repository: repo.repository, storage: docStorage },
      );
      assert.equal(finalizeRes.status, 503);

      const dlRes = await downloadDirectEntryDocument(
        new Request(`${APP_ORIGIN}/x`),
        entryId,
        documentId,
        "true",
        { resolveSession, repository: repo.repository, storage: docStorage },
      );
      assert.equal(dlRes.status, 503);

      const prevRes = await previewWorkerPortraitDocument(
        new Request(`${APP_ORIGIN}/x`),
        entryId,
        documentId,
        "true",
        { resolveSession, repository: repo.repository, storage: docStorage },
      );
      assert.equal(prevRes.status, 503);
    }

    assert.equal(srv.requests.length, 0);
    assert.equal(outboundSpy.length, 0);
  } finally {
    await srv.close();
  }
});

test("Cloudflare R2 backwards compatibility holds when provider is omitted or cloudflare_r2", () => {
  const baseR2 = {
    DOCUMENT_STORAGE_ENVIRONMENT: "production",
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_BUCKET_NAME: DOCUMENT_BUCKETS.production,
    R2_ACCESS_KEY_ID: "R2SYNTHETICACCESSKEY01",
    R2_SECRET_ACCESS_KEY: "r2-synthetic-secret-value-0001",
  };
  for (const env of [baseR2, { ...baseR2, DOCUMENT_STORAGE_PROVIDER: "cloudflare_r2" }]) {
    const cfg = loadR2Config(env);
    assert.ok(cfg);
    assert.equal(cfg.provider, "cloudflare_r2");
    assert.equal(cfg.endpoint, `https://${baseR2.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    assert.equal(cfg.region, "auto");
    assert.equal(cfg.forcePathStyle, false);
    assert.equal(cfg.bucket, DOCUMENT_BUCKETS.production);
    const s3Cfg = buildR2S3ClientConfig(cfg);
    assert.equal(s3Cfg.endpoint, `https://${baseR2.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    assert.equal(s3Cfg.region, "auto");
    assert.equal(s3Cfg.forcePathStyle, false);
  }
  assert.equal(loadR2Config({ ...baseR2, R2_BUCKET_NAME: "vpsttt-clone-bucket" }), null);
});
