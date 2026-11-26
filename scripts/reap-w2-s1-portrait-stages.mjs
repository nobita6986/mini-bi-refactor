import { randomUUID } from "node:crypto";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";
import { createR2DocumentStorage } from "../src/lib/direct-entry/r2-document-storage.ts";
import { createWorkerPortraitStageRepository } from "../src/lib/direct-entry/worker-portrait-stage-repository.ts";
import {
  isW2S1PortraitStageReaperStagingEnvironment,
  runWorkerPortraitStageReaper,
} from "../src/lib/direct-entry/worker-portrait-stage-reaper.ts";

if (process.env.W2S1_PORTRAIT_STAGE_REAPER_ENABLED !== "true") {
  throw new Error("W2S1_PORTRAIT_STAGE_REAPER_ENABLED must be true");
}
if (!isW2S1PortraitStageReaperStagingEnvironment(process.env)) {
  throw new Error("portrait reaper is restricted to the configured staging DB and confirmed Preview bucket");
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY;
if (!supabaseUrl || !serviceKey) throw new Error("portrait reaper Supabase configuration missing");

const storage = createR2DocumentStorage(process.env);
if (!storage.available()) throw new Error("portrait reaper object storage configuration missing");

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const repository = createWorkerPortraitStageRepository(
  (name, args) => supabase.rpc(name, args),
);
const result = await runWorkerPortraitStageReaper({
  repository,
  storage,
  createClaimToken: randomUUID,
});
console.log(
  `[w2s1] portrait stage reaper claimed=${result.claimed} ` +
  `deleted=${result.deleted} failed=${result.failed}`,
);
if (result.failed > 0) process.exitCode = 1;
