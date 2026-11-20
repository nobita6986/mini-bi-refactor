import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  getDirectEntryCccdQr,
  processDirectEntryCccdQr,
  triggerBackgroundCccdQrExtraction,
} from "./cccd-qr-api.ts";
import { createCccdQrRepository } from "./cccd-qr-repository.ts";
import { finalizeDirectEntryDocument } from "./document-finalize-api.ts";
import { sha256Hex } from "./document-r2-contract.ts";

const ENTRY_ID = "a2000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "b2000000-0000-4000-8000-000000000001";
const EXTRACTION_ID = "e2000000-0000-4000-8000-000000000001";
const AUTH_SUB = "91000000-0000-4000-8000-000000000001";
const APP_USER_ID = "92000000-0000-4000-8000-000000000001";
const STORAGE_KEY = `p1.6/c2000000-0000-4000-8000-000000000001/CCCD_FRONT/1/${DOCUMENT_ID}`;
const PNG_BYTES = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  0,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
);

const CANDIDATE_DATA = {
  source: "CCCD_QR",
  authenticity: "UNVERIFIED_QR_TEXT",
  national_id: "079095001234",
  display_name: "Nguyễn Văn An",
  date_of_birth: "15/08/1995",
  date_of_birth_iso: "1995-08-15",
  gender: "MALE",
  gender_label: "Nam",
  address: "123 Nguyễn Trãi, Quận 1, TP. Hồ Chí Minh",
  national_id_issued_at: "20/10/2021",
  national_id_issued_at_iso: "2021-10-20",
};

const MERGE_PREVIEW = {
  display_name: "kept_existing",
  national_id: "eligible_blank",
  date_of_birth: "eligible_blank",
  gender: "eligible_blank",
  address: "eligible_blank",
  national_id_issued_at: "eligible_blank",
};

function makeExtractionRecord(overrides = {}) {
  return {
    extraction_id: EXTRACTION_ID,
    entry_id: ENTRY_ID,
    document_id: DOCUMENT_ID,
    document_type: "CCCD_FRONT",
    document_version: 1,
    status: "PENDING",
    error_code: null,
    error_field: null,
    candidate_data: null,
    field_merge_preview: MERGE_PREVIEW,
    applied_fields: [],
    skipped_fields: [],
    attempts: 0,
    created_at: "2026-10-25T00:00:00.000Z",
    updated_at: "2026-10-25T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function makeGetRequest(query = "") {
  return new Request(
    `https://example.test/api/direct-entry/entries/${ENTRY_ID}/cccd-qr${query}`,
    {
      method: "GET",
      headers: { host: "example.test" },
    },
  );
}

function makePostRequest(body = {}, { headers = {}, idem = "idem-qr-1" } = {}) {
  return new Request(
    `https://example.test/api/direct-entry/entries/${ENTRY_ID}/cccd-qr`,
    {
      method: "POST",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": "application/json",
        ...(idem ? { "idempotency-key": idem } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

test("finalizeDirectEntryDocument triggers non-blocking background QR extraction for CCCD_FRONT and still returns 200 OK even if background QR hook throws", async () => {
  const hookCalls = [];
  const finalizeReq = new Request(
    `https://example.test/api/direct-entry/entries/${ENTRY_ID}/documents/${DOCUMENT_ID}/finalize`,
    {
      method: "POST",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": "application/json",
        "idempotency-key": "idem-finalize-1",
      },
      body: JSON.stringify({ expected_entry_version: 2 }),
    },
  );

  const deps = {
    resolveSession: async () => ({
      actor: {
        ok: true,
        actor: {
          auth_subject: AUTH_SUB,
          app_user_id: APP_USER_ID,
          enabled: true,
          capabilities: ["document_upload", "document_view"],
        },
      },
      response_headers: {},
    }),
    storage: {
      available: () => true,
      async createUploadUrl() {
        throw new Error("unused");
      },
      async headStaged() {
        return { kind: "found", size_bytes: PNG_BYTES.length, content_type: "image/png" };
      },
      async readStaged() {
        return PNG_BYTES;
      },
      async promote() {},
      async deleteStaged() {},
      async createDownloadUrl() {
        throw new Error("unused");
      },
      async readFinal() {
        return PNG_BYTES;
      },
    },
    repository: {
      async reserveDocumentUpload() {
        throw new Error("unused");
      },
      async getDocumentContext() {
        return {
          ok: true,
          data: {
            document_id: DOCUMENT_ID,
            document_type: "CCCD_FRONT",
            version: 1,
            entry_version: 2,
            size_bytes: PNG_BYTES.length,
            mime_type: "image/png",
            storage_key: STORAGE_KEY,
            checksum_sha256: null,
            upload_status: "QUEUED",
            scan_status: "PENDING",
            validation_status: "PENDING",
          },
        };
      },
      async finalizeDocument() {
        return {
          ok: true,
          data: {
            document_id: DOCUMENT_ID,
            version: 1,
            entry_version: 3,
            reused: false,
            upload_status: "READY",
            scan_status: "NOT_REQUIRED",
            validation_status: "VALIDATED",
          },
        };
      },
    },
    onCccdImageFinalized(input) {
      hookCalls.push(input);
      throw new Error("simulated background QR hook failure");
    },
  };

  const response = await finalizeDirectEntryDocument(
    finalizeReq,
    ENTRY_ID,
    DOCUMENT_ID,
    "true",
    deps,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.upload_status, "READY");
  assert.equal(body.validation_status, "VALIDATED");
  assert.equal(body.entry_version, 3);
  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].entry_id, ENTRY_ID);
  assert.equal(hookCalls[0].document_id, DOCUMENT_ID);
  assert.equal(hookCalls[0].document_type, "CCCD_FRONT");
});

test("getDirectEntryCccdQr performs self-healing lazy completion when an eligible CCCD document is READY in R2 and extraction is PENDING", async () => {
  let completed = false;
  const deps = {
    resolveSession: async () => ({
      actor: {
        ok: true,
        actor: {
          auth_subject: AUTH_SUB,
          app_user_id: APP_USER_ID,
          enabled: true,
          capabilities: ["document_upload", "document_view"],
        },
      },
      response_headers: {},
    }),
    storage: {
      available: () => true,
      async readFinal() {
        return PNG_BYTES;
      },
    },
    decodeQr: async () => ({
      status: "SUCCEEDED",
      candidate_data: CANDIDATE_DATA,
      error_code: null,
      error_field: null,
    }),
    qrRepository: {
      async getExtractions() {
        const record = completed
          ? makeExtractionRecord({
              status: "SUCCEEDED",
              candidate_data: CANDIDATE_DATA,
              completed_at: "2026-10-25T00:01:00.000Z",
            })
          : null;
        return {
          ok: true,
          data: {
            entry_id: ENTRY_ID,
            entry_version: 2,
            latest: record,
            extractions: record ? [record] : [],
            eligible_documents: [
              {
                document_id: DOCUMENT_ID,
                document_type: "CCCD_FRONT",
                document_version: 1,
                mime_type: "image/png",
              },
            ],
          },
        };
      },
      async prepareExtraction() {
        return {
          ok: true,
          data: {
            entry_id: ENTRY_ID,
            entry_version: 2,
            document_id: DOCUMENT_ID,
            document_type: "CCCD_FRONT",
            document_version: 1,
            storage_key: STORAGE_KEY,
            mime_type: "image/png",
            size_bytes: PNG_BYTES.length,
            checksum_sha256: sha256Hex(PNG_BYTES),
            extraction: makeExtractionRecord({ status: "PENDING" }),
          },
        };
      },
      async completeExtraction() {
        completed = true;
        return {
          ok: true,
          data: {
            entry_id: ENTRY_ID,
            entry_version: 2,
            reused: false,
            extraction: makeExtractionRecord({
              status: "SUCCEEDED",
              candidate_data: CANDIDATE_DATA,
              completed_at: "2026-10-25T00:01:00.000Z",
            }),
          },
        };
      },
    },
  };

  const res = await getDirectEntryCccdQr(makeGetRequest(), ENTRY_ID, "true", deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, "SUCCEEDED");
  assert.equal(body.latest.candidate_data.national_id, "079095001234");
  assert.equal(Object.hasOwn(body.latest.candidate_data, "legacy_national_id"), false);
});

test("triggerBackgroundCccdQrExtraction runs decode + completeExtraction asynchronously and swallows errors without rejecting", async () => {
  const calls = [];
  const qrRepository = {
    async prepareExtraction(input) {
      calls.push(["prepare", input]);
      return {
        ok: true,
        data: {
          entry_id: ENTRY_ID,
          entry_version: 2,
          document_id: DOCUMENT_ID,
          document_type: "CCCD_FRONT",
          document_version: 1,
          storage_key: STORAGE_KEY,
          mime_type: "image/png",
          size_bytes: PNG_BYTES.length,
          checksum_sha256: sha256Hex(PNG_BYTES),
          extraction: makeExtractionRecord({ status: "PENDING" }),
        },
      };
    },
    async completeExtraction(input) {
      calls.push(["complete", input]);
      return {
        ok: true,
        data: {
          entry_id: ENTRY_ID,
          entry_version: 2,
          reused: false,
          extraction: makeExtractionRecord({
            status: input.status,
            candidate_data: input.candidate_data,
          }),
        },
      };
    },
    async getExtractions() {
      throw new Error("unused");
    },
  };

  await triggerBackgroundCccdQrExtraction({
    auth_subject: AUTH_SUB,
    app_user_id: APP_USER_ID,
    entry_id: ENTRY_ID,
    document_id: DOCUMENT_ID,
    document_type: "CCCD_FRONT",
    image_bytes: PNG_BYTES,
    qrRepository,
    decodeQr: async () => ({
      status: "SUCCEEDED",
      candidate_data: CANDIDATE_DATA,
      error_code: null,
      error_field: null,
    }),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "prepare");
  assert.equal(calls[1][0], "complete");
  assert.equal(calls[1][1].status, "SUCCEEDED");
  assert.equal(calls[1][1].apply_blank_fields, true);
  assert.equal(calls[1][1].idempotency_key, `bg:${DOCUMENT_ID}`);
});

test("getDirectEntryCccdQr and processDirectEntryCccdQr enforce feature gate, CSRF, auth, capabilities, and entry scope before R2 access", async () => {
  let sessionsCalled = 0;
  let storageCalled = 0;
  const baseDeps = {
    resolveSession: async () => {
      sessionsCalled += 1;
      return {
        actor: {
          ok: true,
          actor: {
            auth_subject: AUTH_SUB,
            app_user_id: APP_USER_ID,
            enabled: true,
            capabilities: ["document_upload", "document_view"],
          },
        },
        response_headers: {},
      };
    },
    qrRepository: {
      async prepareExtraction() {
        return { ok: false, kind: "denied" };
      },
      async completeExtraction() {
        throw new Error("must not be called");
      },
      async getExtractions() {
        return { ok: false, kind: "denied" };
      },
    },
    storage: {
      available: () => true,
      async readFinal() {
        storageCalled += 1;
        return PNG_BYTES;
      },
    },
  };

  // 1. Feature gate off -> 404 before resolveSession
  const gateGet = await getDirectEntryCccdQr(makeGetRequest(), ENTRY_ID, "false", baseDeps);
  assert.equal(gateGet.status, 404);
  assert.equal((await gateGet.json()).code, "NOT_FOUND");
  assert.equal(sessionsCalled, 0);

  const gatePost = await processDirectEntryCccdQr(makePostRequest(), ENTRY_ID, undefined, baseDeps);
  assert.equal(gatePost.status, 404);
  assert.equal((await gatePost.json()).code, "NOT_FOUND");
  assert.equal(sessionsCalled, 0);

  // 2. CSRF rejected on POST -> 403 before resolveSession
  const csrfPost = await processDirectEntryCccdQr(
    makePostRequest({}, { headers: { origin: "https://evil.example.com" } }),
    ENTRY_ID,
    "true",
    baseDeps,
  );
  assert.equal(csrfPost.status, 403);
  assert.equal((await csrfPost.json()).code, "CSRF_REJECTED");
  assert.equal(sessionsCalled, 0);

  // 3. Forbidden client authority fields rejected on POST -> 400 before resolveSession
  const authorityPost = await processDirectEntryCccdQr(
    makePostRequest({ app_user_id: APP_USER_ID }),
    ENTRY_ID,
    "true",
    baseDeps,
  );
  assert.equal(authorityPost.status, 400);
  assert.equal((await authorityPost.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.equal(sessionsCalled, 0);

  // 4. Capability denied -> 403 DOCUMENT_DENIED
  const noCapDeps = {
    ...baseDeps,
    resolveSession: async () => ({
      actor: {
        ok: true,
        actor: {
          auth_subject: AUTH_SUB,
          app_user_id: APP_USER_ID,
          enabled: true,
          capabilities: ["draft_create"],
        },
      },
      response_headers: {},
    }),
  };
  const deniedGet = await getDirectEntryCccdQr(makeGetRequest(), ENTRY_ID, "true", noCapDeps);
  assert.equal(deniedGet.status, 403);
  assert.equal((await deniedGet.json()).code, "DOCUMENT_DENIED");

  const deniedPost = await processDirectEntryCccdQr(
    makePostRequest(),
    ENTRY_ID,
    "true",
    noCapDeps,
  );
  assert.equal(deniedPost.status, 403);
  assert.equal((await deniedPost.json()).code, "DOCUMENT_DENIED");

  // 5. Out-of-scope entry -> 404 ENTRY_NOT_FOUND with zero R2 reads
  const scopeDeniedGet = await getDirectEntryCccdQr(makeGetRequest(), ENTRY_ID, "true", baseDeps);
  assert.equal(scopeDeniedGet.status, 404);
  assert.equal((await scopeDeniedGet.json()).code, "ENTRY_NOT_FOUND");
  assert.equal(storageCalled, 0);

  const scopeDeniedPost = await processDirectEntryCccdQr(
    makePostRequest(),
    ENTRY_ID,
    "true",
    baseDeps,
  );
  assert.equal(scopeDeniedPost.status, 404);
  assert.equal((await scopeDeniedPost.json()).code, "ENTRY_NOT_FOUND");
  assert.equal(storageCalled, 0);
});

test("processDirectEntryCccdQr handles FAILED_RETRYABLE on transient R2 read failure, succeeds on retry, is idempotent on terminal states, and supports OCC apply_blank_fields", async () => {
  let currentExtraction = makeExtractionRecord({ status: "PENDING" });
  let r2Available = false;
  let entryVersion = 2;
  let storageReads = 0;

  const deps = {
    resolveSession: async () => ({
      actor: {
        ok: true,
        actor: {
          auth_subject: AUTH_SUB,
          app_user_id: APP_USER_ID,
          enabled: true,
          capabilities: ["document_upload", "document_view"],
        },
      },
      response_headers: {},
    }),
    storage: {
      available: () => true,
      async readFinal() {
        storageReads += 1;
        if (!r2Available) {
          throw new Error("transient R2 outage");
        }
        return PNG_BYTES;
      },
    },
    decodeQr: async () => ({
      status: "SUCCEEDED",
      candidate_data: CANDIDATE_DATA,
      error_code: null,
      error_field: null,
    }),
    qrRepository: {
      async prepareExtraction() {
        return {
          ok: true,
          data: {
            entry_id: ENTRY_ID,
            entry_version: entryVersion,
            document_id: DOCUMENT_ID,
            document_type: "CCCD_FRONT",
            document_version: 1,
            storage_key: STORAGE_KEY,
            mime_type: "image/png",
            size_bytes: PNG_BYTES.length,
            checksum_sha256: sha256Hex(PNG_BYTES),
            extraction: currentExtraction,
          },
        };
      },
      async completeExtraction(input) {
        if (input.apply_blank_fields) {
          if (input.expected_entry_version !== entryVersion) {
            return { ok: false, kind: "conflict" };
          }
          entryVersion += 1;
          currentExtraction = makeExtractionRecord({
            status: "SUCCEEDED",
            candidate_data: CANDIDATE_DATA,
            applied_fields: [
              "national_id",
              "date_of_birth",
              "gender",
              "address",
              "national_id_issued_at",
            ],
            skipped_fields: ["display_name"],
            attempts: currentExtraction.attempts,
            completed_at: "2026-10-25T00:01:00.000Z",
          });
          return {
            ok: true,
            data: {
              entry_id: ENTRY_ID,
              entry_version: entryVersion,
              reused: false,
              extraction: currentExtraction,
            },
          };
        }

        currentExtraction = makeExtractionRecord({
          status: input.status,
          error_code: input.error_code,
          error_field: input.error_field,
          candidate_data: input.candidate_data,
          attempts: currentExtraction.attempts + 1,
          completed_at:
            input.status === "SUCCEEDED" ? "2026-10-25T00:01:00.000Z" : null,
        });
        return {
          ok: true,
          data: {
            entry_id: ENTRY_ID,
            entry_version: entryVersion,
            reused: false,
            extraction: currentExtraction,
          },
        };
      },
      async getExtractions() {
        return {
          ok: true,
          data: {
            entry_id: ENTRY_ID,
            entry_version: entryVersion,
            latest: currentExtraction,
            extractions: [currentExtraction],
            eligible_documents: [
              {
                document_id: DOCUMENT_ID,
                document_type: "CCCD_FRONT",
                document_version: 1,
                mime_type: "image/png",
              },
            ],
          },
        };
      },
    },
  };

  // 1. Transient R2 failure -> FAILED_RETRYABLE (HTTP 200 with structured status, entry unharmed)
  const res1 = await processDirectEntryCccdQr(
    makePostRequest({}, { idem: "idem-try-1" }),
    ENTRY_ID,
    "true",
    deps,
  );
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.ok, true);
  assert.equal(body1.extraction.status, "FAILED_RETRYABLE");
  assert.equal(body1.extraction.error_code, "QR_STORAGE_UNAVAILABLE");
  assert.equal(storageReads, 1);

  // 2. Retry when R2 recovers -> SUCCEEDED with candidate_data and UNVERIFIED_QR_TEXT authenticity
  r2Available = true;
  const res2 = await processDirectEntryCccdQr(
    makePostRequest({}, { idem: "idem-try-2" }),
    ENTRY_ID,
    "true",
    deps,
  );
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.extraction.status, "SUCCEEDED");
  assert.equal(body2.extraction.candidate_data.national_id, "079095001234");
  assert.equal(body2.extraction.candidate_data.authenticity, "UNVERIFIED_QR_TEXT");
  assert.equal(storageReads, 2);

  // 3. Subsequent retry on already SUCCEEDED document -> reused: true without re-reading R2
  const res3 = await processDirectEntryCccdQr(
    makePostRequest({}, { idem: "idem-try-3" }),
    ENTRY_ID,
    "true",
    deps,
  );
  assert.equal(res3.status, 200);
  const body3 = await res3.json();
  assert.equal(body3.reused, true);
  assert.equal(body3.extraction.status, "SUCCEEDED");
  assert.equal(storageReads, 2);

  // 4. Explicit apply_blank_fields with stale expected_entry_version -> 409 ENTRY_VERSION_CONFLICT
  const resConflict = await processDirectEntryCccdQr(
    makePostRequest(
      { apply_blank_fields: true, expected_entry_version: 99 },
      { idem: "idem-apply-conflict" },
    ),
    ENTRY_ID,
    "true",
    deps,
  );
  assert.equal(resConflict.status, 409);
  assert.equal((await resConflict.json()).code, "ENTRY_VERSION_CONFLICT");

  // 5. Explicit apply_blank_fields with matching expected_entry_version -> applies blank fields and bumps version
  const resApply = await processDirectEntryCccdQr(
    makePostRequest(
      { apply_blank_fields: true, expected_entry_version: 2 },
      { idem: "idem-apply-ok" },
    ),
    ENTRY_ID,
    "true",
    deps,
  );
  assert.equal(resApply.status, 200);
  const bodyApply = await resApply.json();
  assert.equal(bodyApply.entry_version, 3);
  assert.deepEqual(bodyApply.extraction.applied_fields, [
    "national_id",
    "date_of_birth",
    "gender",
    "address",
    "national_id_issued_at",
  ]);
  assert.deepEqual(bodyApply.extraction.skipped_fields, ["display_name"]);
});

test("createCccdQrRepository fails closed on malformed RPC projections and classifies SQLSTATE errors", async () => {
  const repoDenied = createCccdQrRepository(async () => ({
    data: null,
    error: { code: "42501", message: "forbidden" },
  }));
  assert.deepEqual(
    await repoDenied.getExtractions({
      auth_subject: AUTH_SUB,
      app_user_id: APP_USER_ID,
      entry_id: ENTRY_ID,
    }),
    { ok: false, kind: "denied" },
  );

  // Reject SUCCEEDED row missing candidate_data (fail-closed projection)
  const repoInvalidProjection = createCccdQrRepository(async () => ({
    data: {
      entry_id: ENTRY_ID,
      entry_version: 1,
      reused: false,
      extraction: makeExtractionRecord({ status: "SUCCEEDED", candidate_data: null }),
    },
    error: null,
  }));
  assert.deepEqual(
    await repoInvalidProjection.completeExtraction({
      auth_subject: AUTH_SUB,
      app_user_id: APP_USER_ID,
      entry_id: ENTRY_ID,
      document_id: DOCUMENT_ID,
      status: "SUCCEEDED",
      error_code: null,
      error_field: null,
      candidate_data: CANDIDATE_DATA,
      apply_blank_fields: false,
      expected_entry_version: null,
      idempotency_key: "idem-1",
    }),
    { ok: false, kind: "unavailable" },
  );
});

test("CCCD QR route and finalize route preserve feature gate and background extraction wiring", async () => {
  const qrRouteSource = await readFile(
    path.join(process.cwd(), "src/app/api/direct-entry/entries/[entryId]/cccd-qr/route.ts"),
    "utf8",
  );
  assert.match(qrRouteSource, /process\.env\.DIRECT_ENTRY_API_ENABLED/);
  assert.match(qrRouteSource, /getDirectEntryCccdQr/);
  assert.match(qrRouteSource, /processDirectEntryCccdQr/);

  const finalizeRouteSource = await readFile(
    path.join(
      process.cwd(),
      "src/app/api/direct-entry/entries/[entryId]/documents/[documentId]/finalize/route.ts",
    ),
    "utf8",
  );
  assert.match(finalizeRouteSource, /triggerBackgroundCccdQrExtraction/);
  assert.match(finalizeRouteSource, /onCccdImageFinalized/);
});

test("WP8C-2: CCCD QR preflight enforces paired effective_grants and contextual PROJECT_MANAGER while denying stale legacy mirrors", async () => {
  const makeSpyDeps = (actorOverrides) => {
    let getCalls = 0;
    let prepareCalls = 0;
    return {
      getCalls: () => getCalls,
      prepareCalls: () => prepareCalls,
      deps: {
        resolveSession: async () => ({
          actor: {
            ok: true,
            actor: {
              auth_subject: AUTH_SUB,
              app_user_id: APP_USER_ID,
              display_name: "Synthetic QR Actor",
              enabled: true,
              capabilities: [],
              scopes: [{ kind: "own", reference: APP_USER_ID, valid_from: "2020-01-01", valid_to: null }],
              self_recruiter_suggestion: null,
              session: { provider: "supabase", verification: "getUser", authenticated_at: null },
              ...actorOverrides,
            },
          },
          response_headers: {},
        }),
        storage: {
          available: () => true,
          async readFinal() {
            throw new Error("should not be called");
          },
        },
        qrRepository: {
          async getExtractions() {
            getCalls += 1;
            return { ok: false, kind: "denied" };
          },
          async prepareExtraction() {
            prepareCalls += 1;
            return { ok: false, kind: "denied" };
          },
          async completeExtraction() {
            throw new Error("should not be called");
          },
        },
      },
    };
  };

  // 1. Mirror-cleared actor with paired document_upload @ OWN passes both read and write preflight
  const uploader = makeSpyDeps({
    capabilities: [],
    effective_grants: [
      {
        capability: "document_upload",
        scope_kind: "OWN",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: null,
      },
    ],
  });
  const uploaderRead = await getDirectEntryCccdQr(makeGetRequest(), ENTRY_ID, "true", uploader.deps);
  assert.equal(uploaderRead.status, 404);
  assert.equal((await uploaderRead.json()).code, "ENTRY_NOT_FOUND");
  assert.equal(uploader.getCalls(), 1);

  const uploaderWrite = await processDirectEntryCccdQr(makePostRequest(), ENTRY_ID, "true", uploader.deps);
  assert.equal(uploaderWrite.status, 404);
  assert.equal((await uploaderWrite.json()).code, "ENTRY_NOT_FOUND");
  assert.equal(uploader.prepareCalls(), 1);

  // 2. Mirror-cleared contextual PROJECT_MANAGER passes both read and write preflight
  const contextualPm = makeSpyDeps({
    capabilities: [],
    effective_grants: [],
    assigned_roles: [
      {
        role_code: "PROJECT_MANAGER",
        display_name: "QLDA",
        assignment_mode: "CONTEXTUAL",
        scope_kind: "CONTEXT_PROJECT",
        scope_id: "proj_a",
        assignment_id: null,
        is_protected: false,
        can_revoke: true,
        cannot_revoke_reason: null,
      },
    ],
  });
  const pmRead = await getDirectEntryCccdQr(makeGetRequest(), ENTRY_ID, "true", contextualPm.deps);
  assert.equal(pmRead.status, 404);
  assert.equal((await pmRead.json()).code, "ENTRY_NOT_FOUND");
  assert.equal(contextualPm.getCalls(), 1);

  const pmWrite = await processDirectEntryCccdQr(makePostRequest(), ENTRY_ID, "true", contextualPm.deps);
  assert.equal(pmWrite.status, 404);
  assert.equal((await pmWrite.json()).code, "ENTRY_NOT_FOUND");
  assert.equal(contextualPm.prepareCalls(), 1);

  // 3. Mirror-cleared HR_OPERATOR with paired document_view @ ALL passes read and is denied (403 DOCUMENT_DENIED) on write
  const hrOperator = makeSpyDeps({
    capabilities: [],
    effective_grants: [
      {
        capability: "document_view",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: null,
      },
    ],
  });
  const hrRead = await getDirectEntryCccdQr(makeGetRequest(), ENTRY_ID, "true", hrOperator.deps);
  assert.equal(hrRead.status, 404);
  assert.equal((await hrRead.json()).code, "ENTRY_NOT_FOUND");
  assert.equal(hrOperator.getCalls(), 1);

  const hrWrite = await processDirectEntryCccdQr(makePostRequest(), ENTRY_ID, "true", hrOperator.deps);
  assert.equal(hrWrite.status, 403);
  assert.deepEqual(await hrWrite.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(hrOperator.prepareCalls(), 0);

  // 4. Managed actor with stale legacy capabilities and empty effective_grants is denied on both read and write
  const staleLegacy = makeSpyDeps({
    capabilities: ["document_upload", "document_view"],
    effective_grants: [],
  });
  const staleRead = await getDirectEntryCccdQr(makeGetRequest(), ENTRY_ID, "true", staleLegacy.deps);
  assert.equal(staleRead.status, 403);
  assert.deepEqual(await staleRead.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(staleLegacy.getCalls(), 0);

  const staleWrite = await processDirectEntryCccdQr(makePostRequest(), ENTRY_ID, "true", staleLegacy.deps);
  assert.equal(staleWrite.status, 403);
  assert.deepEqual(await staleWrite.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(staleLegacy.prepareCalls(), 0);
});
