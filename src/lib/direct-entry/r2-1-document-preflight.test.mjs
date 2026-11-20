import assert from "node:assert/strict";
import test from "node:test";

import { resolveActor, reserveDirectEntryDocument } from "./document-api.ts";
import { previewCccdDocument } from "./document-finalize-api.ts";
import { postFullProfileBatch } from "./full-profile-api.ts";
import { postWorkerPortraitStage } from "./worker-portrait-stage-api.ts";

const AUTH = "91000000-0000-4000-8000-000000000001";
const APP = "92000000-0000-4000-8000-000000000001";
const ENTRY_ID = "93000000-0000-4000-8000-000000000001";
const STAGE_ID = "94000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "95000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "96000000-0000-4000-8000-000000000001";
const TEAM_ID = "97000000-0000-4000-8000-000000000001";

function sessionWithCapabilities(capabilities) {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: AUTH,
        app_user_id: APP,
        display_name: "Synthetic Actor",
        enabled: true,
        capabilities,
        scopes: [{ kind: "own", reference: APP, valid_from: "2020-01-01", valid_to: null }],
        self_recruiter_suggestion: null,
        session: { provider: "supabase", verification: "getUser", authenticated_at: null },
      },
    },
    response_headers: {},
  });
}

test("document-api preflight allows document_upload or draft-PM change_request_create on upload, never on document_view", async () => {
  // 1. Standard uploader with document_upload -> allowed for upload
  const uploader = await resolveActor({
    resolveSession: sessionWithCapabilities(["document_upload"]),
    repository: {},
    storage: {},
  }, "document_upload");
  assert.equal(uploader.ok, true);

  // 2. Project Manager with change_request_create -> allowed for draft upload preflight (DB enforces entry scope)
  const pmUpload = await resolveActor({
    resolveSession: sessionWithCapabilities(["change_request_create"]),
    repository: {},
    storage: {},
  }, "document_upload");
  assert.equal(pmUpload.ok, true);

  // 3. Project Manager with change_request_create ONLY -> denied for document_view (no broad OR widening)
  const pmView = await resolveActor({
    resolveSession: sessionWithCapabilities(["change_request_create"]),
    repository: {},
    storage: {},
  }, "document_view");
  assert.equal(pmView.ok, false);
  assert.equal(pmView.response.status, 403);
  assert.deepEqual(await pmView.response.json(), { ok: false, code: "DOCUMENT_DENIED" });

  // 4. Actor with neither capability -> denied for reserveDirectEntryDocument before storage/DB
  let reserveCalled = false;
  const deniedRes = await reserveDirectEntryDocument(
    new Request(`https://example.test/api/direct-entry/entries/${ENTRY_ID}/documents`, {
      method: "POST",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": "application/json",
        "idempotency-key": IDEMPOTENCY_KEY,
      },
      body: JSON.stringify({
        document_type: "CCCD_FRONT",
        expected_entry_version: 1,
        size_bytes: 1024,
        mime_type: "image/jpeg",
      }),
    }),
    ENTRY_ID,
    "true",
    {
      resolveSession: sessionWithCapabilities(["entry_own"]),
      storage: { available: () => true },
      repository: {
        async reserveDocumentUpload() {
          reserveCalled = true;
          throw new Error("should not be called");
        },
      },
    },
  );
  assert.equal(deniedRes.status, 403);
  assert.deepEqual(await deniedRes.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(reserveCalled, false);

  // 5. Direct-edit / review capabilities without document_upload are denied at upload preflight
  for (const caps of [
    ["entry_privileged_edit"],
    ["entry_admin"],
    ["entry_admin", "entry_privileged_edit"],
    ["team_manager_assign"],
    ["change_review"],
  ]) {
    const deniedDirectEdit = await resolveActor({
      resolveSession: sessionWithCapabilities(caps),
      repository: {},
      storage: {},
    }, "document_upload");
    assert.equal(deniedDirectEdit.ok, false, `expected deny for ${caps.join(",")}`);
    assert.equal(deniedDirectEdit.response.status, 403);
    assert.deepEqual(await deniedDirectEdit.response.json(), { ok: false, code: "DOCUMENT_DENIED" });
  }
});

test("full-profile-api preflight requires explicit document_upload when staging documents and does not widen to change_request_create", async () => {
  const makeBatchRequest = () =>
    new Request("https://example.test/api/direct-entry/full-profile", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": "application/json",
        "idempotency-key": IDEMPOTENCY_KEY,
      },
      body: JSON.stringify({
        contract_version: "worker-profile/1.0",
        rows: [{
          project_id: "project_synthetic_01",
          first_work_date: "2025-03-04",
          employee_code: "hrp-2025-000001",
          recruiter_id: ENTRY_ID,
          labor_type: "TEMPORARY",
          display_name: "Worker Test",
          portrait_stage_id: STAGE_ID,
          worker: { national_id: { state: "provided", value: "012345678901" } },
        }],
      }),
    });

  let claimCalls = 0;
  // Denied when actor only has entry_create + change_request_create (missing document_upload)
  const denied = await postFullProfileBatch(makeBatchRequest(), "true", {
    resolveSession: sessionWithCapabilities(["entry_create", "change_request_create"]),
    repository: {
      async createFullProfileBatch() {
        throw new Error("should not be called");
      },
    },
    portraitStages: {
      async claim() {
        claimCalls += 1;
        return { ok: false, kind: "denied" };
      },
    },
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(claimCalls, 0);

  // Allowed past preflight when actor holds document_upload
  const allowedPreflight = await postFullProfileBatch(makeBatchRequest(), "true", {
    resolveSession: sessionWithCapabilities(["entry_create", "document_upload"]),
    repository: {
      async createFullProfileBatch() {
        throw new Error("should not be called");
      },
      async createFullProfileBatchWithPortraitStages() {
        throw new Error("should not be called");
      },
    },
    documentRepository: {},
    documentStorage: {},
    portraitStages: {
      async claim() {
        claimCalls += 1;
        return { ok: false, kind: "denied" };
      },
    },
  });
  assert.equal(claimCalls, 1, "actor with document_upload passes preflight and reaches stage claim");
  assert.equal(allowedPreflight.status, 404);
});

test("worker-portrait-stage-api preflight requires explicit document_upload and rejects change_request_create-only actor", async () => {
  const makeMultipartRequest = () => {
    const boundary = "----R21Boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="test.jpg"',
      "Content-Type: image/jpeg",
      "",
      "fake-bytes",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    return new Request("https://example.test/api/direct-entry/worker-portrait-stages", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "idempotency-key": IDEMPOTENCY_KEY,
      },
      body,
    });
  };

  let storageChecked = false;
  const denied = await postWorkerPortraitStage(makeMultipartRequest(), "true", {
    resolveSession: sessionWithCapabilities(["entry_create", "change_request_create"]),
    storage: {
      available() {
        storageChecked = true;
        return true;
      },
    },
    repository: {},
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(storageChecked, false);

  const allowedPreflight = await postWorkerPortraitStage(makeMultipartRequest(), "true", {
    resolveSession: sessionWithCapabilities(["entry_create", "document_upload"]),
    storage: {
      available() {
        storageChecked = true;
        return false;
      },
    },
    repository: {},
  });
  assert.equal(storageChecked, true, "actor with document_upload passes preflight");
  assert.equal(allowedPreflight.status, 503);
});

function sessionWithActor(overrides = {}) {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: AUTH,
        app_user_id: APP,
        display_name: "Synthetic Actor",
        enabled: true,
        capabilities: [],
        scopes: [{ kind: "own", reference: APP, valid_from: "2020-01-01", valid_to: null }],
        self_recruiter_suggestion: null,
        session: { provider: "supabase", verification: "getUser", authenticated_at: null },
        ...overrides,
      },
    },
    response_headers: {},
  });
}

function makeFullProfileStageRequest() {
  return new Request("https://example.test/api/direct-entry/full-profile", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": IDEMPOTENCY_KEY,
    },
    body: JSON.stringify({
      contract_version: "worker-profile/1.0",
      rows: [{
        project_id: "project_synthetic_01",
        first_work_date: "2025-03-04",
        employee_code: "hrp-2025-000001",
        recruiter_id: ENTRY_ID,
        labor_type: "TEMPORARY",
        display_name: "Worker Test",
        portrait_stage_id: STAGE_ID,
        worker: { national_id: { state: "provided", value: "012345678901" } },
      }],
    }),
  });
}

function makePortraitStageRequest() {
  const boundary = "----Wp8c2Boundary";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="test.jpg"',
    "Content-Type: image/jpeg",
    "",
    "fake-bytes",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return new Request("https://example.test/api/direct-entry/worker-portrait-stages", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "idempotency-key": IDEMPOTENCY_KEY,
    },
    body,
  });
}

function makePreviewCccdRequest() {
  return new Request(
    `https://example.test/api/direct-entry/entries/${ENTRY_ID}/documents/${DOCUMENT_ID}/cccd-preview`,
    { method: "GET" },
  );
}

const CONTEXTUAL_PM_ROLE = {
  role_code: "PROJECT_MANAGER",
  display_name: "QLDA",
  assignment_mode: "CONTEXTUAL",
  scope_kind: "CONTEXT_PROJECT",
  scope_id: "proj_a",
  assignment_id: null,
  is_protected: false,
  can_revoke: true,
  cannot_revoke_reason: null,
};

const CONTEXTUAL_TL_ROLE = {
  role_code: "TEAM_LEADER",
  display_name: "Trưởng nhóm",
  assignment_mode: "CONTEXTUAL",
  scope_kind: "CONTEXT_TEAM",
  scope_id: TEAM_ID,
  assignment_id: null,
  is_protected: false,
  can_revoke: true,
  cannot_revoke_reason: null,
};

test("WP8C-2: mirror-cleared managed actor with paired document_upload @ OWN is allowed on document-api, full-profile-api, and worker-portrait-stage-api", async () => {
  const resolveSession = sessionWithActor({
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

  const docRes = await resolveActor({ resolveSession, repository: {}, storage: {} }, "document_upload");
  assert.equal(docRes.ok, true);

  let claimCalls = 0;
  const fullProfileRes = await postFullProfileBatch(makeFullProfileStageRequest(), "true", {
    resolveSession,
    repository: {
      async createFullProfileBatch() {
        throw new Error("should not be called");
      },
      async createFullProfileBatchWithPortraitStages() {
        throw new Error("should not be called");
      },
    },
    documentRepository: {},
    documentStorage: {},
    portraitStages: {
      async claim() {
        claimCalls += 1;
        return { ok: false, kind: "denied" };
      },
    },
  });
  assert.equal(claimCalls, 1);
  assert.equal(fullProfileRes.status, 404);

  let storageChecked = false;
  const stageRes = await postWorkerPortraitStage(makePortraitStageRequest(), "true", {
    resolveSession,
    storage: {
      available() {
        storageChecked = true;
        return false;
      },
    },
    repository: {},
  });
  assert.equal(storageChecked, true);
  assert.equal(stageRes.status, 503);
});

test("WP8C-2: mirror-cleared contextual PROJECT_MANAGER is allowed on document-api upload only, denied on document_view, full-profile stages, and worker-portrait-stage", async () => {
  const resolveSession = sessionWithActor({
    capabilities: [],
    effective_grants: [],
    assigned_roles: [CONTEXTUAL_PM_ROLE],
  });

  const uploadRes = await resolveActor({ resolveSession, repository: {}, storage: {} }, "document_upload");
  assert.equal(uploadRes.ok, true);

  const viewRes = await resolveActor({ resolveSession, repository: {}, storage: {} }, "document_view");
  assert.equal(viewRes.ok, false);
  assert.equal(viewRes.response.status, 403);
  assert.deepEqual(await viewRes.response.json(), { ok: false, code: "DOCUMENT_DENIED" });

  let claimCalls = 0;
  const fullProfileRes = await postFullProfileBatch(makeFullProfileStageRequest(), "true", {
    resolveSession,
    repository: {
      async createFullProfileBatch() {
        throw new Error("should not be called");
      },
      async createFullProfileBatchWithPortraitStages() {
        throw new Error("should not be called");
      },
    },
    documentRepository: {},
    documentStorage: {},
    portraitStages: {
      async claim() {
        claimCalls += 1;
        return { ok: false, kind: "denied" };
      },
    },
  });
  assert.equal(fullProfileRes.status, 403);
  assert.deepEqual(await fullProfileRes.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(claimCalls, 0);

  let storageChecked = false;
  const stageRes = await postWorkerPortraitStage(makePortraitStageRequest(), "true", {
    resolveSession,
    storage: {
      available() {
        storageChecked = true;
        return true;
      },
    },
    repository: {},
  });
  assert.equal(stageRes.status, 403);
  assert.deepEqual(await stageRes.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(storageChecked, false);
});

test("WP8C-2: managed actor with stale legacy capabilities but empty effective_grants is denied on all 4 document surfaces", async () => {
  const resolveSession = sessionWithActor({
    capabilities: ["document_upload"],
    effective_grants: [],
  });

  const docRes = await resolveActor({ resolveSession, repository: {}, storage: {} }, "document_upload");
  assert.equal(docRes.ok, false);
  assert.equal(docRes.response.status, 403);
  assert.deepEqual(await docRes.response.json(), { ok: false, code: "DOCUMENT_DENIED" });

  let previewRepoCalls = 0;
  const previewRes = await previewCccdDocument(
    makePreviewCccdRequest(),
    ENTRY_ID,
    DOCUMENT_ID,
    "true",
    {
      resolveSession,
      storage: { available: () => true },
      repository: {
        async getDocumentContext() {
          previewRepoCalls += 1;
          return { ok: false, kind: "denied" };
        },
      },
    },
  );
  assert.equal(previewRes.status, 403);
  assert.deepEqual(await previewRes.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(previewRepoCalls, 0);

  let claimCalls = 0;
  const fullProfileRes = await postFullProfileBatch(makeFullProfileStageRequest(), "true", {
    resolveSession,
    repository: {
      async createFullProfileBatch() {
        throw new Error("should not be called");
      },
      async createFullProfileBatchWithPortraitStages() {
        throw new Error("should not be called");
      },
    },
    documentRepository: {},
    documentStorage: {},
    portraitStages: {
      async claim() {
        claimCalls += 1;
        return { ok: false, kind: "denied" };
      },
    },
  });
  assert.equal(fullProfileRes.status, 403);
  assert.deepEqual(await fullProfileRes.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(claimCalls, 0);

  let storageChecked = false;
  const stageRes = await postWorkerPortraitStage(makePortraitStageRequest(), "true", {
    resolveSession,
    storage: {
      available() {
        storageChecked = true;
        return true;
      },
    },
    repository: {},
  });
  assert.equal(stageRes.status, 403);
  assert.deepEqual(await stageRes.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(storageChecked, false);
});

test("WP8C-2: document_upload only at CONTEXT_TEAM is denied on strict OWN|ALL stage APIs, and entry_admin+entry_privileged_edit without document_upload is denied on document-api upload", async () => {
  const teamOnlySession = sessionWithActor({
    capabilities: [],
    effective_grants: [
      {
        capability: "document_upload",
        scope_kind: "CONTEXT_TEAM",
        scope_id: TEAM_ID,
        source_type: "CONTEXTUAL_ASSIGNMENT",
        source_id: null,
      },
    ],
  });

  let claimCalls = 0;
  const fullProfileRes = await postFullProfileBatch(makeFullProfileStageRequest(), "true", {
    resolveSession: teamOnlySession,
    repository: {
      async createFullProfileBatch() {
        throw new Error("should not be called");
      },
      async createFullProfileBatchWithPortraitStages() {
        throw new Error("should not be called");
      },
    },
    documentRepository: {},
    documentStorage: {},
    portraitStages: {
      async claim() {
        claimCalls += 1;
        return { ok: false, kind: "denied" };
      },
    },
  });
  assert.equal(fullProfileRes.status, 403);
  assert.deepEqual(await fullProfileRes.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(claimCalls, 0);

  let storageChecked = false;
  const stageRes = await postWorkerPortraitStage(makePortraitStageRequest(), "true", {
    resolveSession: teamOnlySession,
    storage: {
      available() {
        storageChecked = true;
        return true;
      },
    },
    repository: {},
  });
  assert.equal(stageRes.status, 403);
  assert.deepEqual(await stageRes.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(storageChecked, false);

  const adminWithoutUpload = await resolveActor({
    resolveSession: sessionWithActor({
      capabilities: [],
      effective_grants: [
        {
          capability: "entry_admin",
          scope_kind: "ALL",
          scope_id: null,
          source_type: "ROLE_BUNDLE",
          source_id: null,
        },
        {
          capability: "entry_privileged_edit",
          scope_kind: "ALL",
          scope_id: null,
          source_type: "ROLE_BUNDLE",
          source_id: null,
        },
      ],
    }),
    repository: {},
    storage: {},
  }, "document_upload");
  assert.equal(adminWithoutUpload.ok, false);
  assert.equal(adminWithoutUpload.response.status, 403);
  assert.deepEqual(await adminWithoutUpload.response.json(), { ok: false, code: "DOCUMENT_DENIED" });
});

test("WP8C-2: previewCccdDocument admits mirror-cleared contextual TEAM_LEADER and PROJECT_MANAGER past preflight and denies stale legacy document_view with empty effective_grants", async () => {
  for (const role of [CONTEXTUAL_TL_ROLE, CONTEXTUAL_PM_ROLE]) {
    let repoCalls = 0;
    const res = await previewCccdDocument(
      makePreviewCccdRequest(),
      ENTRY_ID,
      DOCUMENT_ID,
      "true",
      {
        resolveSession: sessionWithActor({
          capabilities: [],
          effective_grants: [],
          assigned_roles: [role],
        }),
        storage: { available: () => true },
        repository: {
          async getDocumentContext() {
            repoCalls += 1;
            return { ok: false, kind: "denied" };
          },
        },
      },
    );
    assert.equal(repoCalls, 1, `contextual ${role.role_code} must reach repository`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { ok: false, code: "ENTRY_NOT_FOUND" });
  }

  let staleRepoCalls = 0;
  const staleRes = await previewCccdDocument(
    makePreviewCccdRequest(),
    ENTRY_ID,
    DOCUMENT_ID,
    "true",
    {
      resolveSession: sessionWithActor({
        capabilities: ["document_view"],
        effective_grants: [],
      }),
      storage: { available: () => true },
      repository: {
        async getDocumentContext() {
          staleRepoCalls += 1;
          return { ok: false, kind: "denied" };
        },
      },
    },
  );
  assert.equal(staleRes.status, 403);
  assert.deepEqual(await staleRes.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(staleRepoCalls, 0);
});
