import { randomUUID } from "node:crypto";

import {
  loadR2Config,
  resolveDocumentStorageProvider,
  type DocumentObjectStorage,
} from "./r2-document-storage.ts";
import { DOCUMENT_BUCKETS } from "./document-r2-contract.ts";
import type { SubmissionObjectCleanup } from "./worker-portrait-stage-repository.ts";

export const W2S1_STAGING_SUPABASE_REF = "oyykqfxkyqhxgrfntokl";

export function isW2S1PortraitStageReaperStagingEnvironment(
  env: Record<string, string | undefined>,
): boolean {
  let url: URL;
  try {
    url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== `${W2S1_STAGING_SUPABASE_REF}.supabase.co` ||
    env.DOCUMENT_STORAGE_ENVIRONMENT?.trim() !== "preview"
  ) {
    return false;
  }
  const provider = resolveDocumentStorageProvider(env);
  if (provider === "cloudflare_r2") {
    return env.R2_BUCKET_NAME?.trim() === DOCUMENT_BUCKETS.preview;
  }
  if (provider === "vpsttt") {
    const config = loadR2Config(env);
    return config?.provider === "vpsttt" && config.bucket === DOCUMENT_BUCKETS.preview;
  }
  return false;
}

type CleanupRepository = {
  claimExpiredCleanup(input: {
    claim_token: string;
    limit: number;
  }): Promise<{ ok: true; data: string[] } | { ok: false; kind: string }>;
  completeCleanup(input: {
    stage_id: string;
    claim_token: string;
  }): Promise<{ ok: true; data: true } | { ok: false; kind: string }>;
  claimSubmissionObjectCleanup(input: {
    claim_token: string;
    limit: number;
  }): Promise<{ ok: true; data: SubmissionObjectCleanup[] } | { ok: false; kind: string }>;
  completeSubmissionObjectCleanup(input: {
    cleanup_id: string;
    claim_token: string;
  }): Promise<{ ok: true; data: true } | { ok: false; kind: string }>;
};

export const PORTRAIT_STAGE_REAPER_BATCH_SIZE = 50;

export async function runWorkerPortraitStageReaper(input: {
  repository: CleanupRepository;
  storage: Pick<DocumentObjectStorage,
    "deleteEnrollmentPortraitStage" | "deleteStaged" | "deleteFinal"> &
    Partial<Pick<DocumentObjectStorage, "hasProductionObjects">>;
  createClaimToken?: () => string;
}): Promise<{ claimed: number; deleted: number; failed: number }> {
  if (typeof input.storage.hasProductionObjects === "function") {
    const hasProd = await input.storage.hasProductionObjects();
    if (hasProd) {
      throw new Error("PORTRAIT_STAGE_REAPER_PRODUCTION_BUCKET_BLOCKED");
    }
  }
  const claimToken = (input.createClaimToken ?? randomUUID)();
  const claimed = await input.repository.claimExpiredCleanup({
    claim_token: claimToken,
    limit: PORTRAIT_STAGE_REAPER_BATCH_SIZE,
  });
  if (!claimed.ok) throw new Error("PORTRAIT_STAGE_REAPER_CLAIM_FAILED");

  let deleted = 0;
  let failed = 0;
  for (const stageId of claimed.data) {
    try {
      await input.storage.deleteEnrollmentPortraitStage(stageId);
    } catch {
      failed += 1;
      continue;
    }
    const completed = await input.repository.completeCleanup({
      stage_id: stageId,
      claim_token: claimToken,
    });
    if (!completed.ok) {
      failed += 1;
      continue;
    }
    deleted += 1;
  }

  const submissionCleanup = await input.repository.claimSubmissionObjectCleanup({
    claim_token: claimToken,
    limit: PORTRAIT_STAGE_REAPER_BATCH_SIZE,
  });
  if (!submissionCleanup.ok) throw new Error("SUBMISSION_OBJECT_CLEANUP_CLAIM_FAILED");
  for (const object of submissionCleanup.data) {
    try {
      if (object.object_kind === "PORTRAIT_STAGE") {
        if (!object.stage_id) throw new Error("SUBMISSION_OBJECT_CLEANUP_INVALID");
        await input.storage.deleteEnrollmentPortraitStage(object.stage_id);
      } else if (object.object_kind === "DOCUMENT_STAGED") {
        if (!object.storage_key) throw new Error("SUBMISSION_OBJECT_CLEANUP_INVALID");
        await input.storage.deleteStaged(object.storage_key);
      } else {
        if (!object.storage_key) throw new Error("SUBMISSION_OBJECT_CLEANUP_INVALID");
        await input.storage.deleteFinal(object.storage_key);
      }
    } catch {
      failed += 1;
      continue;
    }
    const completed = await input.repository.completeSubmissionObjectCleanup({
      cleanup_id: object.cleanup_id,
      claim_token: claimToken,
    });
    if (!completed.ok) {
      failed += 1;
      continue;
    }
    deleted += 1;
  }

  return {
    claimed: claimed.data.length + submissionCleanup.data.length,
    deleted,
    failed,
  };
}
