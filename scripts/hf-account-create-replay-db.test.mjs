/**
 * Việc C — End-to-end PGlite DB + API regression suite for CREATE_ACCOUNT replay & recovery.
 *
 * Wires REAL SQL migrations (direct_entry_account_operation_begin/claim/read/finish/
 * finalize_create + direct_entry_get_app_user_admin) through the real repositories
 * (`createAccountOperationRepository`, `createAccountAccessRepository`) and API handlers
 * (`createAccount`, `reconcileIntent`).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { createAccount, reconcileIntent } from "../src/lib/admin/account-operation-api.ts";
import { createAccountOperationRepository } from "../src/lib/admin/account-operation-repository.ts";
import { createAccountAccessRepository } from "../src/lib/direct-entry/app-user-access-repository.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text unique);";

const ADMIN_A = {
  auth_subject: "11000000-0000-4000-8000-000000000001",
  app_user_id: "21000000-0000-4000-8000-000000000001",
  email: "admin.a@hrpartner.vn",
  display_name: "Admin A",
};
const ADMIN_B = {
  auth_subject: "11000000-0000-4000-8000-000000000002",
  app_user_id: "21000000-0000-4000-8000-000000000002",
  email: "admin.b@hrpartner.vn",
  display_name: "Admin B",
};
const SECRET_PASSWORD = "SecretReplayPass!2026#XYZ";

const RPC_SPECS = {
  direct_entry_account_operation_begin: [
    ["p_auth_subject", "uuid"],
    ["p_actor_app_user_id", "uuid"],
    ["p_kind", "text"],
    ["p_login_id", "text"],
    ["p_display_name", "text"],
    ["p_account_ref", "uuid"],
    ["p_reason", "text"],
    ["p_idempotency_key", "text"],
  ],
  direct_entry_account_operation_claim: [
    ["p_auth_subject", "uuid"],
    ["p_actor_app_user_id", "uuid"],
    ["p_intent_id", "uuid"],
    ["p_intent_token", "uuid"],
  ],
  direct_entry_account_operation_read: [
    ["p_auth_subject", "uuid"],
    ["p_actor_app_user_id", "uuid"],
    ["p_intent_id", "uuid"],
  ],
  direct_entry_account_operation_finish: [
    ["p_auth_subject", "uuid"],
    ["p_actor_app_user_id", "uuid"],
    ["p_intent_id", "uuid"],
    ["p_outcome", "text"],
    ["p_failure_code", "text"],
  ],
  direct_entry_account_operation_finalize_create: [
    ["p_auth_subject", "uuid"],
    ["p_actor_app_user_id", "uuid"],
    ["p_intent_id", "uuid"],
    ["p_intent_token", "uuid"],
    ["p_created_auth_subject", "uuid"],
    ["p_idempotency_key", "text"],
  ],
  direct_entry_get_app_user_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_target_app_user_id", "uuid"],
  ],
};

function createPgliteRpc(db) {
  return async (name, args) => {
    const spec = RPC_SPECS[name];
    if (!spec) {
      throw new Error(`Unexpected RPC in replay test: ${name}`);
    }
    const placeholders = spec.map(([param, type], index) => `${param} := $${index + 1}::${type}`).join(", ");
    const values = spec.map(([param]) => (args[param] === undefined ? null : args[param]));
    try {
      const res = await db.query(`select public.${name}(${placeholders}) as data`, values);
      return { data: res.rows[0]?.data ?? null, error: null };
    } catch (error) {
      return {
        data: null,
        error: { code: error?.code, message: error?.message },
      };
    }
  };
}

function createAuthHarness(db) {
  const usersByEmail = new Map();
  const usersById = new Map();
  const stats = {
    createCalls: 0,
    readProvenanceCalls: 0,
    findByLoginCalls: 0,
    resetCalls: 0,
  };
  let nextCreateBehavior = null;
  let nextProvenanceBehavior = null;

  async function insertAuthUser(loginId, intentToken) {
    const email = `${loginId}@hrpartner.vn`;
    if (usersByEmail.has(email)) {
      return null;
    }
    const id = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
    const record = { id, email, intent_token: intentToken };
    usersByEmail.set(email, record);
    usersById.set(id, record);
    return record;
  }

  return {
    stats,
    insertAuthUser,
    setNextCreateBehavior(fn) {
      nextCreateBehavior = fn;
    },
    setNextProvenanceBehavior(fn) {
      nextProvenanceBehavior = fn;
    },
    auth: {
      async createAuthAccount({ login_id, intent_token }) {
        stats.createCalls += 1;
        if (nextCreateBehavior) {
          const behavior = nextCreateBehavior;
          nextCreateBehavior = null;
          return behavior({ login_id, intent_token, insertAuthUser });
        }
        const created = await insertAuthUser(login_id, intent_token);
        if (!created) return { kind: "failure", code: "email_exists" };
        return { kind: "created", auth_subject: created.id };
      },
      async readAuthUserProvenance({ auth_subject, intent_token }) {
        stats.readProvenanceCalls += 1;
        if (nextProvenanceBehavior) {
          const behavior = nextProvenanceBehavior;
          nextProvenanceBehavior = null;
          return behavior({ auth_subject, intent_token });
        }
        const found = usersById.get(auth_subject);
        if (!found) return { kind: "missing" };
        return found.intent_token === intent_token
          ? { kind: "match", auth_subject: found.id }
          : { kind: "mismatch", auth_subject: found.id };
      },
      async findAuthUserByLoginId({ login_id, intent_token }) {
        stats.findByLoginCalls += 1;
        const found = usersByEmail.get(`${login_id}@hrpartner.vn`);
        if (!found) return { kind: "missing" };
        return found.intent_token === intent_token
          ? { kind: "match", auth_subject: found.id }
          : { kind: "mismatch", auth_subject: found.id };
      },
      async resetAuthPassword() {
        stats.resetCalls += 1;
        throw new Error("resetAuthPassword must not be called in create-account replay tests");
      },
    },
  };
}

function makeRequest(body) {
  const headers = {
    origin: "https://example.test",
    host: "example.test",
    "content-type": "application/json",
  };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: stream,
  };
}

async function seedAdmin(db, admin) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [admin.auth_subject, admin.email]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, authz_managed, display_name) values ($1, $2, true, true, $3)",
    [admin.app_user_id, admin.auth_subject, admin.display_name],
  );
  await db.query(
    `insert into public.authz_user_group_members (group_id, app_user_id, source_kind, reason)
     select g.group_id, $1::uuid, 'ADMIN_ASSIGNMENT', 'Account replay test admin'
       from public.authz_user_groups g where g.code = 'SYSTEM_ADMIN'`,
    [admin.app_user_id],
  );
}

let db;
let rpc;
let repository;
let accountAccess;
let harness;
const allResponses = [];

function depsFor(admin) {
  return {
    resolveSession: async () => ({
      actor: {
        ok: true,
        actor: { auth_subject: admin.auth_subject, app_user_id: admin.app_user_id },
      },
    }),
    repository,
    accountAccess,
    auth: harness.auth,
  };
}

async function postCreate(admin, payload) {
  const response = await createAccount(makeRequest(payload), "true", depsFor(admin));
  const text = await response.text();
  allResponses.push(text);
  assert.equal(text.includes(SECRET_PASSWORD), false, "password must never appear in createAccount response");
  return { status: response.status, body: JSON.parse(text) };
}

async function postReconcile(admin, intentId, idempotencyKey) {
  const response = await reconcileIntent(
    makeRequest({ idempotency_key: idempotencyKey }),
    intentId,
    "true",
    depsFor(admin),
  );
  const text = await response.text();
  allResponses.push(text);
  assert.equal(text.includes(SECRET_PASSWORD), false, "password must never appear in reconcileIntent response");
  return { status: response.status, body: JSON.parse(text) };
}

async function countRows(sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

before(async () => {
  db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    await db.exec(sql);
  }
  await seedAdmin(db, ADMIN_A);
  await seedAdmin(db, ADMIN_B);
  rpc = createPgliteRpc(db);
  repository = createAccountOperationRepository(rpc);
  accountAccess = createAccountAccessRepository(rpc);
  harness = createAuthHarness(db);
});

after(async () => {
  if (db) await db.close();
});

test("E2E (a): lost HTTP response after commit replays exact app_user_id & version with 1 DB row and 1 Auth call", async () => {
  const key = randomUUID();
  const payload = {
    login_id: "lost.commit",
    display_name: "Lost Commit User",
    password: SECRET_PASSWORD,
    password_confirm: SECRET_PASSWORD,
    reason: "create lost commit",
    idempotency_key: key,
  };
  const usersBefore = await countRows("select count(*) from public.direct_entry_app_users");
  const authBefore = harness.stats.createCalls;
  const findBefore = harness.stats.findByLoginCalls;

  // Initial call commits in DB + Auth, then assume client never saw the HTTP response.
  const first = await postCreate(ADMIN_A, payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal("replayed" in first.body, false);
  const createdUserId = first.body.account.app_user_id;
  const createdVersion = first.body.account.version;
  const createdRevisionId = first.body.account.revision_id;
  const createdIntentId = first.body.account.intent_id;

  // Replay with the exact same idempotency_key.
  const replay = await postCreate(ADMIN_A, payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.ok, true);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.account.app_user_id, createdUserId);
  assert.equal(replay.body.account.version, createdVersion);
  assert.equal(replay.body.account.revision_id, createdRevisionId);
  assert.equal(replay.body.account.display_name, "Lost Commit User");
  assert.equal(replay.body.account.intent_id, createdIntentId);
  assert.equal(replay.body.account.intent_state, "APPLIED");
  assert.equal(replay.body.intent.intent_id, createdIntentId);
  assert.equal(replay.body.intent.kind, "CREATE_ACCOUNT");
  assert.equal(replay.body.intent.state, "APPLIED");
  assert.equal(replay.body.intent.account_ref, createdUserId);

  assert.equal(
    await countRows("select count(*) from public.direct_entry_app_users"),
    usersBefore + 1,
    "exactly 1 direct_entry_app_users row created",
  );
  assert.equal(harness.stats.createCalls - authBefore, 1, "exactly 1 Auth create call");
  assert.equal(harness.stats.findByLoginCalls - findBefore, 0, "no Auth login lookup on replay");
});

test("E2E (b): IN_FLIGHT and INDETERMINATE replay -> /reconcile -> APPLIED -> replay again (incl. after PII purge)", async () => {
  // Part 1: IN_FLIGHT replay -> reconcile -> replay original create key (hydrates via get_app_user_admin).
  const inFlightKey = randomUUID();
  const inFlightPayload = {
    login_id: "inflight.recover",
    display_name: "InFlight Recover User",
    password: SECRET_PASSWORD,
    password_confirm: SECRET_PASSWORD,
    reason: "in-flight scenario",
    idempotency_key: inFlightKey,
  };
  const began = await repository.begin({
    auth_subject: ADMIN_A.auth_subject,
    app_user_id: ADMIN_A.app_user_id,
    kind: "CREATE_ACCOUNT",
    login_id: inFlightPayload.login_id,
    display_name: inFlightPayload.display_name,
    account_ref: null,
    reason: inFlightPayload.reason,
    idempotency_key: inFlightKey,
  });
  assert.equal(began.ok, true);
  const claimed = await repository.claim({
    auth_subject: ADMIN_A.auth_subject,
    app_user_id: ADMIN_A.app_user_id,
    intent_id: began.data.intent_id,
    intent_token: began.data.intent_token,
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.data.claimed, true);

  // Suppose worker 1 created the Auth user with the provenance token before hanging.
  const inFlightAuthUser = await harness.insertAuthUser(inFlightPayload.login_id, began.data.intent_token);
  assert.ok(inFlightAuthUser);

  const authBeforeInFlightReplay = harness.stats.createCalls;
  const findBeforeInFlightReplay = harness.stats.findByLoginCalls;
  const inFlightReplay = await postCreate(ADMIN_A, inFlightPayload);
  assert.equal(inFlightReplay.status, 200);
  assert.deepEqual(inFlightReplay.body, {
    ok: true,
    replayed: true,
    intent: {
      intent_id: began.data.intent_id,
      intent_token: began.data.intent_token,
      kind: "CREATE_ACCOUNT",
      state: "IN_FLIGHT",
      account_ref: null,
    },
  });
  assert.equal(harness.stats.createCalls, authBeforeInFlightReplay, "IN_FLIGHT replay never calls Auth create");
  assert.equal(harness.stats.findByLoginCalls, findBeforeInFlightReplay, "IN_FLIGHT replay never searches Auth");

  const inFlightReconcile = await postReconcile(ADMIN_A, began.data.intent_id, randomUUID());
  assert.equal(inFlightReconcile.status, 200);
  assert.equal(inFlightReconcile.body.ok, true);
  assert.equal(inFlightReconcile.body.account.auth_subject, inFlightAuthUser.id);
  assert.equal(inFlightReconcile.body.account.display_name, "InFlight Recover User");
  const inFlightAccountId = inFlightReconcile.body.account.app_user_id;

  // Replaying original POST /accounts key (different from reconcile key) resolves via direct_entry_get_app_user_admin.
  const findBeforeHydrate = harness.stats.findByLoginCalls;
  const afterReconcileReplay = await postCreate(ADMIN_A, inFlightPayload);
  assert.equal(afterReconcileReplay.status, 200);
  assert.deepEqual(afterReconcileReplay.body, {
    ok: true,
    replayed: true,
    account: {
      app_user_id: inFlightAccountId,
      auth_subject: inFlightAuthUser.id,
      display_name: "InFlight Recover User",
      version: 1,
      revision_id: null,
      intent_id: began.data.intent_id,
      intent_state: "APPLIED",
    },
    intent: {
      intent_id: began.data.intent_id,
      intent_token: began.data.intent_token,
      kind: "CREATE_ACCOUNT",
      state: "APPLIED",
      account_ref: inFlightAccountId,
    },
  });
  assert.equal(harness.stats.findByLoginCalls, findBeforeHydrate, "APPLIED replay never searches Auth by login_id");

  // Part 2: INDETERMINATE (Auth creates user then times out as unknown) -> replay -> /reconcile -> APPLIED -> replay again.
  const indetKey = randomUUID();
  const indetPayload = {
    login_id: "indet.recover",
    display_name: "Indet Recover User",
    password: SECRET_PASSWORD,
    password_confirm: SECRET_PASSWORD,
    reason: "indeterminate scenario",
    idempotency_key: indetKey,
  };
  let indetAuthId;
  harness.setNextCreateBehavior(async ({ login_id, intent_token, insertAuthUser }) => {
    const created = await insertAuthUser(login_id, intent_token);
    indetAuthId = created.id;
    return { kind: "unknown" };
  });

  const authBeforeIndet = harness.stats.createCalls;
  const firstIndet = await postCreate(ADMIN_A, indetPayload);
  assert.equal(firstIndet.status, 200);
  assert.equal(firstIndet.body.ok, true);
  assert.equal("replayed" in firstIndet.body, false);
  assert.equal(firstIndet.body.intent.state, "INDETERMINATE");
  assert.equal(firstIndet.body.intent.account_ref, null);
  const indetIntentId = firstIndet.body.intent.intent_id;
  const indetToken = firstIndet.body.intent.intent_token;

  const findBeforeIndetReplay = harness.stats.findByLoginCalls;
  const replayIndet = await postCreate(ADMIN_A, indetPayload);
  assert.equal(replayIndet.status, 200);
  assert.deepEqual(replayIndet.body, {
    ok: true,
    replayed: true,
    intent: {
      intent_id: indetIntentId,
      intent_token: indetToken,
      kind: "CREATE_ACCOUNT",
      state: "INDETERMINATE",
      account_ref: null,
    },
  });
  assert.equal(harness.stats.createCalls - authBeforeIndet, 1, "INDETERMINATE replay makes zero extra Auth create calls");
  assert.equal(harness.stats.findByLoginCalls, findBeforeIndetReplay);

  const reconcileKey = randomUUID();
  const reconciled = await postReconcile(ADMIN_A, indetIntentId, reconcileKey);
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.ok, true);
  assert.equal(reconciled.body.account.auth_subject, indetAuthId);
  assert.equal(reconciled.body.account.version, 1);
  const indetAppUserId = reconciled.body.account.app_user_id;

  // Replay reconcile with same reconcileKey -> hits finalizeCreate cache, zero Auth calls.
  const findBeforeReconcileReplay = harness.stats.findByLoginCalls;
  const reconcileReplay = await postReconcile(ADMIN_A, indetIntentId, reconcileKey);
  assert.equal(reconcileReplay.status, 200);
  assert.equal(reconcileReplay.body.ok, true);
  assert.equal(reconcileReplay.body.replayed, true);
  assert.equal(reconcileReplay.body.account.app_user_id, indetAppUserId);
  assert.equal(reconcileReplay.body.account.revision_id, reconciled.body.account.revision_id);
  assert.equal(reconcileReplay.body.intent.state, "APPLIED");
  assert.equal(reconcileReplay.body.intent.account_ref, indetAppUserId);
  assert.equal(harness.stats.findByLoginCalls, findBeforeReconcileReplay, "APPLIED reconcile never calls Auth");

  // Simulate 30-day PII purge (login_id = null, display_name = null) and call reconcile with a new key.
  await db.query(
    "update public.direct_entry_account_operation_intents" +
    " set login_id = null, display_name = null, pii_purged_at = now(), tombstone_until = now() + interval '150 days'" +
    " where intent_id = $1",
    [indetIntentId],
  );
  const postPurgeReconcile = await postReconcile(ADMIN_A, indetIntentId, randomUUID());
  assert.equal(postPurgeReconcile.status, 200);
  assert.equal(postPurgeReconcile.body.ok, true);
  assert.equal(postPurgeReconcile.body.replayed, true);
  assert.equal(postPurgeReconcile.body.account.app_user_id, indetAppUserId);
  assert.equal(postPurgeReconcile.body.account.display_name, "Indet Recover User");
  assert.equal(postPurgeReconcile.body.account.version, 1);
  assert.equal(postPurgeReconcile.body.intent.state, "APPLIED");
  assert.equal(postPurgeReconcile.body.intent.account_ref, indetAppUserId);
  assert.equal(harness.stats.findByLoginCalls, findBeforeReconcileReplay, "post-PII-purge reconcile never calls Auth");
});

test("E2E (c): same idempotency_key with different login_id, display_name, or reason is rejected 400 with 0 Auth calls", async () => {
  const key = randomUUID();
  const basePayload = {
    login_id: "idem.conflict",
    display_name: "Original Name",
    password: SECRET_PASSWORD,
    password_confirm: SECRET_PASSWORD,
    reason: "original reason",
    idempotency_key: key,
  };
  const first = await postCreate(ADMIN_A, basePayload);
  assert.equal(first.status, 200);

  const authBefore = harness.stats.createCalls;
  const findBefore = harness.stats.findByLoginCalls;
  for (const [label, mutated] of [
    ["different login_id", { ...basePayload, login_id: "idem.conflict.other" }],
    ["different display_name", { ...basePayload, display_name: "Different Name" }],
    ["different reason", { ...basePayload, reason: "different reason" }],
  ]) {
    const res = await postCreate(ADMIN_A, mutated);
    assert.equal(res.status, 400, label);
    assert.deepEqual(res.body, { ok: false, code: "ACCOUNT_OPERATION_INVALID" }, label);
  }
  assert.equal(harness.stats.createCalls, authBefore, "zero Auth create calls on idempotency mismatch");
  assert.equal(harness.stats.findByLoginCalls, findBefore, "zero Auth lookup calls on idempotency mismatch");
});

test("E2E (d): two Admins on same login_id — live conflict 409 & failed/conflicted replay never returns other Admin's account", async () => {
  // (i) Live conflict: Admin A has live INDETERMINATE intent; Admin B with different request gets 409, 0 Auth calls, no leak.
  const keyLiveA = randomUUID();
  harness.setNextCreateBehavior(async () => ({ kind: "unknown" }));
  const liveA = await postCreate(ADMIN_A, {
    login_id: "two.admin.live",
    display_name: "Admin A Target",
    password: SECRET_PASSWORD,
    password_confirm: SECRET_PASSWORD,
    reason: "admin a live",
    idempotency_key: keyLiveA,
  });
  assert.equal(liveA.status, 200);
  assert.equal(liveA.body.intent.state, "INDETERMINATE");

  const authBeforeLiveB = harness.stats.createCalls;
  const findBeforeLiveB = harness.stats.findByLoginCalls;
  const liveB = await postCreate(ADMIN_B, {
    login_id: "two.admin.live",
    display_name: "Admin B Target",
    password: SECRET_PASSWORD,
    password_confirm: SECRET_PASSWORD,
    reason: "admin b live",
    idempotency_key: randomUUID(),
  });
  assert.equal(liveB.status, 409);
  assert.deepEqual(liveB.body, { ok: false, code: "ACCOUNT_OPERATION_CONFLICT" });
  assert.equal(harness.stats.createCalls, authBeforeLiveB, "Admin B makes 0 Auth calls on live conflict");
  assert.equal(harness.stats.findByLoginCalls, findBeforeLiveB);
  assert.equal(JSON.stringify(liveB.body).includes(liveA.body.intent.intent_id), false, "Admin B never sees Admin A intent");

  // (ii-a) Admin A ends in CONFLICT -> replay returns CONFLICT, never calls Auth.
  const keyConflictA = randomUUID();
  harness.setNextCreateBehavior(async () => ({ kind: "failure", code: "email_exists" }));
  const conflictA = await postCreate(ADMIN_A, {
    login_id: "two.admin.conflict",
    display_name: "Admin A Conflict",
    password: SECRET_PASSWORD,
    password_confirm: SECRET_PASSWORD,
    reason: "admin a conflict",
    idempotency_key: keyConflictA,
  });
  assert.equal(conflictA.status, 200);
  assert.equal(conflictA.body.intent.state, "CONFLICT");

  const authBeforeConflictReplay = harness.stats.createCalls;
  const conflictReplayA = await postCreate(ADMIN_A, {
    login_id: "two.admin.conflict",
    display_name: "Admin A Conflict",
    password: SECRET_PASSWORD,
    password_confirm: SECRET_PASSWORD,
    reason: "admin a conflict",
    idempotency_key: keyConflictA,
  });
  assert.equal(conflictReplayA.status, 200);
  assert.deepEqual(conflictReplayA.body, {
    ok: true,
    replayed: true,
    intent: {
      intent_id: conflictA.body.intent.intent_id,
      intent_token: conflictA.body.intent.intent_token,
      kind: "CREATE_ACCOUNT",
      state: "CONFLICT",
      account_ref: null,
    },
  });
  assert.equal(harness.stats.createCalls, authBeforeConflictReplay);

  // (ii-b) Admin A's intent finishes FAILED -> Admin B later creates same login_id & succeeds ->
  //        Admin A replays old key -> MUST get FAILED, NEVER Admin B's account!
  const keyFailedA = randomUUID();
  const failedPayloadA = {
    login_id: "two.admin.failed",
    display_name: "Admin A Failed",
    password: SECRET_PASSWORD,
    password_confirm: SECRET_PASSWORD,
    reason: "admin a failed",
    idempotency_key: keyFailedA,
  };
  const beganA = await repository.begin({
    auth_subject: ADMIN_A.auth_subject,
    app_user_id: ADMIN_A.app_user_id,
    kind: "CREATE_ACCOUNT",
    login_id: failedPayloadA.login_id,
    display_name: failedPayloadA.display_name,
    account_ref: null,
    reason: failedPayloadA.reason,
    idempotency_key: keyFailedA,
  });
  assert.equal(beganA.ok, true);
  const claimedA = await repository.claim({
    auth_subject: ADMIN_A.auth_subject,
    app_user_id: ADMIN_A.app_user_id,
    intent_id: beganA.data.intent_id,
    intent_token: beganA.data.intent_token,
  });
  assert.equal(claimedA.ok, true);
  assert.equal(claimedA.data.claimed, true);
  const finishedA = await repository.finish({
    auth_subject: ADMIN_A.auth_subject,
    app_user_id: ADMIN_A.app_user_id,
    intent_id: beganA.data.intent_id,
    outcome: "FAILED",
    failure_code: "auth_error",
  });
  assert.equal(finishedA.ok, true);

  // Now Admin B creates the same login_id and succeeds.
  const successB = await postCreate(ADMIN_B, {
    login_id: "two.admin.failed",
    display_name: "Admin B Succeeded",
    password: SECRET_PASSWORD,
    password_confirm: SECRET_PASSWORD,
    reason: "admin b succeeds",
    idempotency_key: randomUUID(),
  });
  assert.equal(successB.status, 200);
  assert.equal(successB.body.ok, true);
  const adminBAccountId = successB.body.account.app_user_id;
  assert.ok(adminBAccountId);

  // Admin A replays their old key -> gets FAILED, NEVER Admin B's account!
  const authBeforeFailedReplay = harness.stats.createCalls;
  const findBeforeFailedReplay = harness.stats.findByLoginCalls;
  const replayFailedA = await postCreate(ADMIN_A, failedPayloadA);
  assert.equal(replayFailedA.status, 200);
  assert.deepEqual(replayFailedA.body, {
    ok: true,
    replayed: true,
    intent: {
      intent_id: beganA.data.intent_id,
      intent_token: beganA.data.intent_token,
      kind: "CREATE_ACCOUNT",
      state: "FAILED",
      account_ref: null,
    },
  });
  assert.equal("account" in replayFailedA.body, false, "FAILED replay must not include an account");
  assert.equal(
    JSON.stringify(replayFailedA.body).includes(adminBAccountId),
    false,
    "Admin A replay must NEVER return Admin B's account",
  );
  assert.equal(harness.stats.createCalls, authBeforeFailedReplay);
  assert.equal(harness.stats.findByLoginCalls, findBeforeFailedReplay);
});

test("E2E (e): zero password in DB tables (intents, idempotency, audit, reasons, app_users) or any HTTP response", async () => {
  assert.ok(allResponses.length > 0, "at least one HTTP response captured");
  for (const responseText of allResponses) {
    assert.equal(responseText.includes(SECRET_PASSWORD), false, "no password in any HTTP response");
  }

  for (const table of [
    "public.direct_entry_account_operation_intents",
    "public.direct_entry_rpc_idempotency",
    "public.direct_entry_audit_events",
    "public.direct_entry_restricted_reasons",
    "public.direct_entry_app_users",
    "public.direct_entry_app_user_revisions",
  ]) {
    const rows = (await db.query(`select * from ${table}`)).rows;
    const serialized = JSON.stringify(rows);
    assert.equal(serialized.includes(SECRET_PASSWORD), false, `password must never appear in ${table}`);
  }
});
