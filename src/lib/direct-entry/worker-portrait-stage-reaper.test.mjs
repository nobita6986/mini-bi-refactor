import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isW2S1PortraitStageReaperStagingEnvironment,
  runWorkerPortraitStageReaper,
} from "./worker-portrait-stage-reaper.ts";

const STAGE_A = "a1000000-0000-4000-8000-000000000001";
const STAGE_B = "a1000000-0000-4000-8000-000000000002";
const TOKEN = "b1000000-0000-4000-8000-000000000001";
const CLEANUP_A = "c1000000-0000-4000-8000-000000000001";
const DOCUMENT_KEY = "p1.6/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/CCCD_FRONT/1/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("reaper configuration accepts only the isolated staging Supabase project and Preview bucket", () => {
  const staging = {
    NEXT_PUBLIC_SUPABASE_URL: "https://oyykqfxkyqhxgrfntokl.supabase.co",
    DOCUMENT_STORAGE_ENVIRONMENT: "preview",
    R2_BUCKET_NAME: "hrp-bi-preview",
  };
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment(staging), true);
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment({
    ...staging,
    NEXT_PUBLIC_SUPABASE_URL: "https://production.supabase.co",
  }), false);
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment({
    ...staging,
    DOCUMENT_STORAGE_ENVIRONMENT: "production",
  }), false);
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment({
    ...staging,
    R2_BUCKET_NAME: "hrp-bi-product",
  }), false);
});

test("reaper configuration supports VPSTTT staging with decoupled non-production bucket and fails closed otherwise", () => {
  const vpstttStaging = {
    NEXT_PUBLIC_SUPABASE_URL: "https://oyykqfxkyqhxgrfntokl.supabase.co",
    DOCUMENT_STORAGE_ENVIRONMENT: "preview",
    DOCUMENT_STORAGE_PROVIDER: "vpsttt",
    VPSTTT_STORAGE_ENDPOINT: "https://s3.synthetic.test:9000",
    VPSTTT_STORAGE_REGION: "ap-southeast-1",
    VPSTTT_STORAGE_BUCKET: "vpsttt-staging-bucket",
    VPSTTT_STORAGE_ACCESS_KEY_ID: "VPSTTTSYNTHETICKEY01",
    VPSTTT_STORAGE_SECRET_ACCESS_KEY: "vpsttt-synthetic-secret-key-0123456789",
  };
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment(vpstttStaging), true);
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment({
    ...vpstttStaging,
    VPSTTT_STORAGE_BUCKET: "hrp-bi-product",
  }), false);
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment({
    ...vpstttStaging,
    VPSTTT_STORAGE_ENDPOINT: undefined,
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_BUCKET_NAME: "hrp-bi-preview",
    R2_ACCESS_KEY_ID: "SYNTHETICACCESSKEY01",
    R2_SECRET_ACCESS_KEY: "synthetic-secret-value-0001",
  }), false);
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment({
    ...vpstttStaging,
    DOCUMENT_STORAGE_ENVIRONMENT: "production",
  }), false);
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment({
    ...vpstttStaging,
    DOCUMENT_STORAGE_PROVIDER: "unknown-provider",
  }), false);
});

function dependencies({ deleteFailure } = {}) {
  const calls = [];
  return {
    calls,
    repository: {
      async claimExpiredCleanup(input) {
        calls.push(["claim", input]);
        return { ok: true, data: [STAGE_A, STAGE_B] };
      },
      async completeCleanup(input) {
        calls.push(["complete", input]);
        return { ok: true, data: true };
      },
      async claimSubmissionObjectCleanup(input) {
        calls.push(["claim-submission", input]);
        return { ok: true, data: [] };
      },
      async completeSubmissionObjectCleanup(input) {
        calls.push(["complete-submission", input]);
        return { ok: true, data: true };
      },
    },
    storage: {
      async deleteEnrollmentPortraitStage(stageId) {
        calls.push(["delete", stageId]);
        if (stageId === deleteFailure) throw new Error("synthetic storage failure");
      },
      async deleteStaged(storageKey) { calls.push(["delete-staged", storageKey]); },
      async deleteFinal(storageKey) { calls.push(["delete-final", storageKey]); },
    },
  };
}

test("reaper deletes each claimed object by stage id, then acknowledges cleanup", async () => {
  const d = dependencies();
  const result = await runWorkerPortraitStageReaper({
    ...d,
    createClaimToken: () => TOKEN,
  });

  assert.deepEqual(result, { claimed: 2, deleted: 2, failed: 0 });
  assert.deepEqual(d.calls, [
    ["claim", { claim_token: TOKEN, limit: 50 }],
    ["delete", STAGE_A],
    ["complete", { stage_id: STAGE_A, claim_token: TOKEN }],
    ["delete", STAGE_B],
    ["complete", { stage_id: STAGE_B, claim_token: TOKEN }],
    ["claim-submission", { claim_token: TOKEN, limit: 50 }],
  ]);
});

test("failed object deletion leaves cleanup pending for lease-based retry", async () => {
  const d = dependencies({ deleteFailure: STAGE_A });
  const result = await runWorkerPortraitStageReaper({
    ...d,
    createClaimToken: () => TOKEN,
  });

  assert.deepEqual(result, { claimed: 2, deleted: 1, failed: 1 });
  assert.equal(d.calls.some(([name, stageId]) => name === "complete" && stageId === STAGE_A), false);
  assert.equal(d.calls.some(([name, value]) =>
    name === "complete" && value.stage_id === STAGE_B), true);
});

test("database claim failures are surfaced instead of reported as a successful empty run", async () => {
  await assert.rejects(
    runWorkerPortraitStageReaper({
      repository: {
        async claimExpiredCleanup() { return { ok: false, kind: "unavailable" }; },
        async completeCleanup() { return { ok: true, data: true }; },
        async claimSubmissionObjectCleanup() { return { ok: true, data: [] }; },
        async completeSubmissionObjectCleanup() { return { ok: true, data: true }; },
      },
      storage: {
        async deleteEnrollmentPortraitStage() {},
        async deleteStaged() {},
        async deleteFinal() {},
      },
    }),
    /PORTRAIT_STAGE_REAPER_CLAIM_FAILED/,
  );
});

test("submission cleanup deletes the matching object type and leaves failed items retryable", async () => {
  const calls = [];
  const d = dependencies();
  d.repository.claimSubmissionObjectCleanup = async () => ({
    ok: true,
    data: [
      { cleanup_id: CLEANUP_A, object_kind: "DOCUMENT_STAGED", stage_id: null, storage_key: DOCUMENT_KEY },
      {
        cleanup_id: "c1000000-0000-4000-8000-000000000002",
        object_kind: "DOCUMENT_FINAL",
        stage_id: null,
        storage_key: DOCUMENT_KEY,
      },
      {
        cleanup_id: "c1000000-0000-4000-8000-000000000003",
        object_kind: "PORTRAIT_STAGE",
        stage_id: STAGE_A,
        storage_key: null,
      },
    ],
  });
  d.repository.completeSubmissionObjectCleanup = async (input) => {
    calls.push(["complete-submission", input]);
    return { ok: true, data: true };
  };
  d.storage.deleteStaged = async (key) => {
    calls.push(["delete-staged", key]);
    throw new Error("storage failure");
  };
  d.storage.deleteFinal = async (key) => calls.push(["delete-final", key]);

  const result = await runWorkerPortraitStageReaper({
    ...d,
    createClaimToken: () => TOKEN,
  });
  assert.deepEqual(result, { claimed: 5, deleted: 4, failed: 1 });
  assert.deepEqual(calls, [
    ["delete-staged", DOCUMENT_KEY],
    ["delete-final", DOCUMENT_KEY],
    ["complete-submission", {
      cleanup_id: "c1000000-0000-4000-8000-000000000002", claim_token: TOKEN,
    }],
    ["complete-submission", {
      cleanup_id: "c1000000-0000-4000-8000-000000000003", claim_token: TOKEN,
    }],
  ]);
});
