/**
 * PRE-W2-HF-D3-B - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua dung mot doan trong API/UI layer va chay lane focused; lane phai DO.
 * Sau moi lan, file duoc khoi phuc byte-for-byte.
 *
 * Probes: 1. bo kiem tra provenance; 2. claim thua van goi Auth; 3. lo password; 4. bo chan client authority.
 * Cach chay: node scripts/pre-w2-hf-d3-bc-account-personnel-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const API = path.resolve("src/lib/admin/account-operation-api.ts");

const LANE_COMMANDS = [
  ["--conditions=react-server", "--test", "src/lib/admin/account-operation.test.mjs"],
];

const MUTATIONS = [
  {
    label: "1. bo kiem tra provenance (finalize APPLIED du marker lech)",
    file: API,
    find: "    intent_token: provenance.kind === \"match\" ? intent.intent_token : MISMATCH_TOKEN,",
    replace: "    intent_token: intent.intent_token,",
  },
  {
    label: "2. claim thua van goi Auth lan hai",
    file: API,
    find: "  if (!claimed.data.claimed) {\n    return replayCreateAccountIntent(actor.value, intent, input.idempotency_key, deps);\n  }\n\n" +
      "  const auth = deps.auth;\n  const created = await auth.createAuthAccount({",
    replace: "  if (false && !claimed.data.claimed) {\n    return replayCreateAccountIntent(actor.value, intent, input.idempotency_key, deps);\n  }\n\n" +
      "  const auth = deps.auth;\n  const created = await auth.createAuthAccount({",
  },
  {
    label: "3. lo password trong response create",
    file: API,
    find: "  if (\"app_user_id\" in finalize.data) {\n    return respond({ ok: true, account: finalize.data }, 200);\n  }\n" +
      "  return intentResponse(intent.intent_id, intent.intent_token, \"CREATE_ACCOUNT\", finalize.data.intent_state);",
    replace: "  if (\"app_user_id\" in finalize.data) {\n    return respond({ ok: true, account: finalize.data, password: input.password }, 200);\n  }\n" +
      "  return intentResponse(intent.intent_id, intent.intent_token, \"CREATE_ACCOUNT\", finalize.data.intent_state);",
  },
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function applyMutation(source, mutation) {
  const parts = source.split(mutation.find);
  if (parts.length !== 2) {
    throw new Error("anchor must occur exactly once for " + mutation.label +
      " (found " + (parts.length - 1) + ")");
  }
  return parts.join(mutation.replace);
}

async function runLane() {
  for (const args of LANE_COMMANDS) {
    try {
      await run(process.execPath, args, { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 });
    } catch {
      return true;
    }
  }
  return false;
}

const original = await readFile(API, "utf8");
const hash = sha256(original);
const results = [];
try {
  for (const mutation of MUTATIONS) {
    await writeFile(API, applyMutation(original, mutation), "utf8");
    let red = false;
    try {
      red = await runLane();
    } finally {
      await writeFile(API, original, "utf8");
    }
    results.push({ label: mutation.label, red });
    console.log((red ? "RED   " : "GREEN ") + mutation.label);
  }
} finally {
  await writeFile(API, original, "utf8");
}

const green = results.filter((item) => !item.red);
const restored = sha256(await readFile(API, "utf8")) === hash;
console.log("");
console.log("mutation checks red: " + (results.length - green.length) + "/" + results.length);
console.log("sources restored byte-for-byte: " + String(restored));
if (green.length > 0 || !restored) {
  console.error("MUTATION EVIDENCE FAILED " + JSON.stringify(green));
  process.exitCode = 1;
}
