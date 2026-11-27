/**
 * P3.1-W01A - capability contract foundation (focused lane).
 *
 * Proves the append-only migration #67 (20261009030000_p3_1_w01a_capability_contract_foundation.sql)
 * keeps all stored grant tokens while the active direct-entry-auth contract agrees on the
 * current non-retired capability tokens, that the
 * extension keeps every existing grant, that unknown tokens are still rejected, and that the two
 * new tokens carry the locked reason / expected version / scope-kind policy without opening
 * Direct Entry or full-Admin surfaces.
 *
 * No Production access, no network, no browser: PGlite applies the real local migrations.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  CAPABILITIES,
  DIRECT_ENTRY_AUTH_CONTRACT_VERSION,
  authorizeDirectEntry,
  validateClientBusinessPayload,
} from "../src/lib/auth/direct-entry-v2.ts";
import {
  decideDirectEntryPageAccess,
  decideProjectOperationsPageAccess,
} from "../src/lib/auth/direct-entry-page-access.ts";
import {
  adminAuthorityNavPredicate,
  directEntryNavPredicate,
  projectAdminNavPredicate,
  workerOperationsNavPredicate,
} from "../src/lib/navigation/registry-capability.ts";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const NEW_MIGRATION = "20261009030000_p3_1_w01a_capability_contract_foundation.sql";
const FOUNDATION_MIGRATION = "20261002170000_p1_6_direct_entry_foundation.sql";
const CAPABILITY_CHECK = "direct_entry_capability_grants_capability_check";
const V1_CONTRACT = path.resolve("src/lib/contracts/direct-entry-v1.ts");

const NEW_TOKENS = ["catalog_master_manage", "team_manager_assign"];
const F1_WORK_REPORT_TOKENS = [
  "report_form_manage",
  "report_assign",
  "report_view",
  "report_analytics_view",
];
const F2_WORK_REPORT_TOKENS = ["report_review", "report_delegate"];
const VFIN_TOKENS = ["vendor_finance_view", "vendor_finance_record"];
const DUPLICATE_CCCD_TOKENS = ["duplicate_cccd_withdraw"];
const WORKER_EDIT_HISTORY_MIGRATION = "20261031120000_worker_edit_history_admin.sql";
const WORKER_EDIT_HISTORY_TOKENS = ["worker_edit_history_view"];
const POST_LEGACY_GROUP_ONLY_TOKENS = ["vendor_referrer_manage"];
const LEGACY_TOKEN_COUNT = 21;
const RETIRED_TOKENS = ["pii_view", "pii_export", "payment_view", "payment_edit"];
const TOKEN_COUNT = 33;
const ACTIVE_TOKEN_COUNT = 30;
const UNKNOWN_TOKEN = "unknown_capability_probe";

const AUTH_SUBJECT = "10000000-0000-4000-8000-00000000c001";
const APP_USER_ID = "20000000-0000-4000-8000-00000000c001";
const TEAM_ID = "94000000-0000-4000-8000-00000000000a";
const RESOURCE_REF = "00000000-0000-4000-8000-00000000c001";
const TIMESTAMP = "2026-10-09T03:00:00Z";
const EFFECTIVE_DATE = "2026-10-09";
const REASON_REF = "reason_synthetic_01";

async function migrationNames() {
  return (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
}

async function readMigration(name) {
  return readFile(path.join(MIGRATION_DIR, name), "utf8");
}

async function database(names) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  for (const name of names.filter((n) => n <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")) await db.exec(await readMigration(name));
  return db;
}

/** Effective capability vocabulary, read from the schema itself (not from migration text). */
async function schemaVocabulary(db) {
  const { rows } = await db.query(
    `select pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and t.relname = 'direct_entry_capability_grants'
        and c.contype = 'c'
        and c.conname = $1`,
    [CAPABILITY_CHECK],
  );
  assert.equal(rows.length, 1, "the canonical capability CHECK constraint must exist");
  return [...String(rows[0].definition).matchAll(/'([^']+)'::text/g)].map((match) => match[1]);
}

/** Vocabulary of the frozen foundation migration, parsed from its inline column CHECK. */
function foundationVocabulary(sql) {
  const match = sql.match(/capability text not null check \(capability in \(([\s\S]*?)\)\)/);
  assert.ok(match, "foundation capability CHECK must be readable");
  return [...match[1].matchAll(/'([^']+)'/g)].map((token) => token[1]);
}

/** Vocabulary of the v1 contract union, parsed from source so the parity test can go red. */
function v1Vocabulary(source) {
  const match = source.match(/export type Capability =([\s\S]*?);/);
  assert.ok(match, "v1 Capability union must be readable");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((token) => token[1]);
}

const ALL_SCOPE = { kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null };
const TEAM_SCOPE = { kind: "team", reference: TEAM_ID, valid_from: "2026-01-01", valid_to: null };

function actor({ capabilities, scopes }) {
  return {
    auth_subject: AUTH_SUBJECT,
    app_user_id: APP_USER_ID,
    display_name: "Synthetic Contract Actor",
    enabled: true,
    capabilities,
    scopes,
    self_recruiter_suggestion: null,
    session: { provider: "supabase", verification: "getUser", authenticated_at: null },
  };
}

function resourceFor(kind) {
  return {
    reference: RESOURCE_REF,
    scope: {
      kind,
      reference: kind === "all" ? "all" : TEAM_ID,
      effective_date: EFFECTIVE_DATE,
    },
    created_by_user_id: null,
    current_version: 4,
  };
}

test("the auth contract is versioned as direct-entry-auth/1.7 without retired capabilities", () => {
  assert.equal(DIRECT_ENTRY_AUTH_CONTRACT_VERSION, "direct-entry-auth/1.7");
  assert.equal(CAPABILITIES.length, ACTIVE_TOKEN_COUNT);
  for (const token of RETIRED_TOKENS) assert.equal(CAPABILITIES.includes(token), false, token);
  for (const token of NEW_TOKENS) assert.ok(CAPABILITIES.includes(token), token);
  for (const token of F1_WORK_REPORT_TOKENS) assert.ok(CAPABILITIES.includes(token), token);
  for (const token of F2_WORK_REPORT_TOKENS) assert.ok(CAPABILITIES.includes(token), token);
  for (const token of VFIN_TOKENS) assert.ok(CAPABILITIES.includes(token), token);
  for (const token of DUPLICATE_CCCD_TOKENS) assert.ok(CAPABILITIES.includes(token), token);
  for (const token of WORKER_EDIT_HISTORY_TOKENS) assert.ok(CAPABILITIES.includes(token), token);
  for (const token of POST_LEGACY_GROUP_ONLY_TOKENS) assert.ok(CAPABILITIES.includes(token), token);
});

test("database preserves legacy grant storage while active SQL and TypeScript agree", async () => {
  const db = await database(await migrationNames());
  const schemaTokens = await schemaVocabulary(db);
  assert.equal(schemaTokens.length, TOKEN_COUNT);
  assert.deepEqual(
    schemaTokens.filter((token) => !RETIRED_TOKENS.includes(token)).concat(POST_LEGACY_GROUP_ONLY_TOKENS).sort(),
    [...CAPABILITIES].sort(),
  );
  for (const token of NEW_TOKENS) assert.ok(schemaTokens.includes(token), token);
  await db.close();

  const v1Tokens = v1Vocabulary(await readFile(V1_CONTRACT, "utf8"));
  assert.deepEqual([...v1Tokens].sort(), [...CAPABILITIES].sort());
  for (const token of RETIRED_TOKENS) assert.equal(v1Tokens.includes(token), false, token);
});

test("migration 67 is append-only: the frozen foundation vocabulary is untouched", async () => {
  const names = await migrationNames();
  assert.ok(names.includes(NEW_MIGRATION), "migration #67 must exist");
  assert.ok(names.includes(WORKER_EDIT_HISTORY_MIGRATION), "worker history capability migration must exist");
  assert.ok(NEW_MIGRATION > FOUNDATION_MIGRATION, "migration #67 must sort after the foundation");

  // No historical migration was edited to know about the new tokens. Migrations
  // appended AFTER #67 may legitimately consume the vocabulary.
  for (const name of names) {
    if (name >= NEW_MIGRATION) continue;
    const sql = await readMigration(name);
    for (const token of NEW_TOKENS) {
      assert.equal(sql.includes(token), false, token + " must not appear in " + name);
    }
  }

  // The later worker-history capability belongs only to its own forward migration; it must not
  // be retrofitted into the frozen #67 foundation or any intervening migration.
  for (const name of names) {
    if (name >= WORKER_EDIT_HISTORY_MIGRATION) continue;
    const sql = await readMigration(name);
    for (const token of WORKER_EDIT_HISTORY_TOKENS) {
      assert.equal(sql.includes(token), false, token + " must not appear in " + name);
    }
  }

  const foundationTokens = foundationVocabulary(await readMigration(FOUNDATION_MIGRATION));
  assert.equal(foundationTokens.length, LEGACY_TOKEN_COUNT);
  assert.deepEqual(
    [...foundationTokens].sort(),
    [...CAPABILITIES]
      .filter(
        (token) =>
          !NEW_TOKENS.includes(token) &&
          !F1_WORK_REPORT_TOKENS.includes(token) &&
          !F2_WORK_REPORT_TOKENS.includes(token) &&
          !VFIN_TOKENS.includes(token) &&
          !DUPLICATE_CCCD_TOKENS.includes(token) &&
          !WORKER_EDIT_HISTORY_TOKENS.includes(token) &&
          !POST_LEGACY_GROUP_ONLY_TOKENS.includes(token),
      )
      .concat(RETIRED_TOKENS)
      .sort(),
  );

  const db = await database(names);
  const schemaTokens = await schemaVocabulary(db);
  assert.deepEqual(
    schemaTokens.filter((token) => !foundationTokens.includes(token)).sort(),
    [...NEW_TOKENS, ...F1_WORK_REPORT_TOKENS, ...F2_WORK_REPORT_TOKENS, ...VFIN_TOKENS,
      ...DUPLICATE_CCCD_TOKENS, ...WORKER_EDIT_HISTORY_TOKENS].sort(),
  );
  await db.close();
});

test("the vocabulary extension keeps every existing capability grant", async () => {
  const names = await migrationNames();
  const before = names.filter((name) => name < NEW_MIGRATION);
  const db = await database(before);

  await db.query("insert into auth.users (id) values ($1::uuid)", [AUTH_SUBJECT]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name)
     values ($1::uuid, $2::uuid, 'Synthetic Contract Actor')`,
    [APP_USER_ID, AUTH_SUBJECT],
  );

  const legacy = ["entry_admin", "entry_restore", "pii_export", "audit_view"];
  for (const [index, capability] of legacy.entries()) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to)
       values ($1::uuid, $2, $3::date, $4::date)`,
      [APP_USER_ID, capability, "2020-01-0" + (index + 1), "2021-01-0" + (index + 1)],
    );
  }

  // Before #67 the two foundation tokens are not part of the vocabulary yet.
  for (const token of NEW_TOKENS) {
    await assert.rejects(
      db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
         values ($1::uuid, $2, '2022-01-01'::date)`,
        [APP_USER_ID, token],
      ),
      (error) => error.code === "23514",
      token + " must be rejected before migration #67",
    );
  }

  await db.exec(await readMigration(NEW_MIGRATION));

  const { rows } = await db.query(
    `select capability, valid_from::text as valid_from
       from public.direct_entry_capability_grants
      where app_user_id = $1::uuid order by valid_from`,
    [APP_USER_ID],
  );
  assert.deepEqual(rows.map((row) => row.capability), legacy);
  assert.deepEqual(rows.map((row) => row.valid_from), ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"]);

  for (const [index, token] of NEW_TOKENS.entries()) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to)
       values ($1::uuid, $2, $3::date, $4::date)`,
      [APP_USER_ID, token, "2022-01-0" + (index + 1), "2023-01-0" + (index + 1)],
    );
  }
  const { rows: accepted } = await db.query(
    `select count(*)::int as total from public.direct_entry_capability_grants where app_user_id = $1::uuid`,
    [APP_USER_ID],
  );
  assert.equal(accepted[0].total, legacy.length + NEW_TOKENS.length);

  await assert.rejects(
    db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
       values ($1::uuid, $2, '2024-01-01'::date)`,
      [APP_USER_ID, UNKNOWN_TOKEN],
    ),
    (error) => error.code === "23514",
    "an unknown capability token must stay rejected",
  );

  await db.close();
});

test("catalog_master_manage requires reason, expected version and effective all scope", () => {
  const catalogOperator = actor({ capabilities: ["catalog_master_manage"], scopes: [ALL_SCOPE] });
  const base = { actor: catalogOperator, action: "catalog_master_manage", timestamp: TIMESTAMP };

  assert.equal(
    authorizeDirectEntry({ ...base, resource: resourceFor("all"), expected_version: 4 }).code,
    "REASON_REQUIRED",
  );
  assert.equal(
    authorizeDirectEntry({ ...base, resource: resourceFor("all"), reason_ref: REASON_REF }).code,
    "EXPECTED_VERSION_REQUIRED",
  );
  assert.equal(
    authorizeDirectEntry({
      ...base, resource: resourceFor("team"), reason_ref: REASON_REF, expected_version: 4,
    }).code,
    "ACTION_SCOPE_MISMATCH",
  );
  assert.equal(
    authorizeDirectEntry({
      ...base, resource: resourceFor("all"), reason_ref: REASON_REF, expected_version: 3,
    }).code,
    "VERSION_CONFLICT",
  );

  const allowed = authorizeDirectEntry({
    ...base, resource: resourceFor("all"), reason_ref: REASON_REF, expected_version: 4,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.audit.capability, "catalog_master_manage");
  assert.equal(allowed.audit.outcome, "ALLOW");
});

test("team_manager_assign requires reason, expected version and effective team scope", () => {
  const leader = actor({ capabilities: ["team_manager_assign"], scopes: [TEAM_SCOPE] });
  const base = { actor: leader, action: "team_manager_assign", timestamp: TIMESTAMP };

  assert.equal(
    authorizeDirectEntry({ ...base, resource: resourceFor("team"), expected_version: 4 }).code,
    "REASON_REQUIRED",
  );
  assert.equal(
    authorizeDirectEntry({ ...base, resource: resourceFor("team"), reason_ref: REASON_REF }).code,
    "EXPECTED_VERSION_REQUIRED",
  );
  assert.equal(
    authorizeDirectEntry({
      ...base, resource: resourceFor("all"), reason_ref: REASON_REF, expected_version: 4,
    }).code,
    "ACTION_SCOPE_MISMATCH",
  );

  const allowed = authorizeDirectEntry({
    ...base, resource: resourceFor("team"), reason_ref: REASON_REF, expected_version: 4,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.audit.capability, "team_manager_assign");
});

test("an all-scope grant never substitutes the team scope of team_manager_assign", () => {
  const allScopedLeader = actor({ capabilities: ["team_manager_assign"], scopes: [ALL_SCOPE] });
  const base = {
    actor: allScopedLeader,
    action: "team_manager_assign",
    timestamp: TIMESTAMP,
    reason_ref: REASON_REF,
    expected_version: 4,
  };
  assert.equal(authorizeDirectEntry({ ...base, resource: resourceFor("all") }).code,
    "ACTION_SCOPE_MISMATCH");
  assert.equal(authorizeDirectEntry({ ...base, resource: resourceFor("team") }).code,
    "SCOPE_DENIED");

  const teamScopedCatalog = actor({ capabilities: ["catalog_master_manage"], scopes: [TEAM_SCOPE] });
  assert.equal(
    authorizeDirectEntry({
      actor: teamScopedCatalog,
      action: "catalog_master_manage",
      timestamp: TIMESTAMP,
      reason_ref: REASON_REF,
      expected_version: 4,
      resource: resourceFor("team"),
    }).code,
    "ACTION_SCOPE_MISMATCH",
  );
});

test("Team Leader opens team review and Project Operations, but not Direct Entry or Admin", () => {
  const projected = {
    capabilities: ["catalog_master_manage"],
    scopes: [{ kind: "all" }, { kind: "team" }, { kind: "own" }],
  };
  assert.equal(directEntryNavPredicate(projected), false);
  assert.equal(workerOperationsNavPredicate(projected), false);
  assert.equal(projectAdminNavPredicate(projected), false);
  assert.equal(adminAuthorityNavPredicate(projected), false);

  const teamLeader = { capabilities: ["team_manager_assign"], scopes: [TEAM_SCOPE] };
  assert.equal(directEntryNavPredicate(teamLeader), false);
  assert.equal(workerOperationsNavPredicate(teamLeader), true);
  assert.equal(projectAdminNavPredicate(teamLeader), true);
  assert.equal(adminAuthorityNavPredicate(teamLeader), false);

  const resolution = {
    ok: true,
    actor: actor({ capabilities: ["team_manager_assign"], scopes: [TEAM_SCOPE] }),
  };
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: resolution }), "ACCESS_DENIED");
  assert.equal(
    decideProjectOperationsPageAccess({ uiEnabled: true, actor: resolution }),
    "ALLOW",
  );
});

test("client-supplied actor, capability and scope fields are still rejected", () => {
  for (const payload of [
    { actor: { app_user_id: APP_USER_ID } },
    { capability: NEW_TOKENS[0] },
    { capabilities: [...NEW_TOKENS] },
    { scope: { kind: "all" } },
    { scopes: [{ kind: "team" }] },
    { nested: { role: "admin" } },
  ]) {
    const result = validateClientBusinessPayload(payload);
    assert.equal(result.ok, false);
    assert.equal(result.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }
});

test("VFIN-01 tokens require effective all scope, reason on record, and never open Direct Entry or Full Admin", () => {
  const vfinDirectActor = actor({
    capabilities: ["vendor_finance_view", "vendor_finance_record"],
    scopes: [ALL_SCOPE],
  });
  assert.equal(
    authorizeDirectEntry({
      actor: vfinDirectActor,
      action: "vendor_finance_view",
      timestamp: TIMESTAMP,
      resource: resourceFor("all"),
    }).allowed,
    true,
  );
  assert.equal(
    authorizeDirectEntry({
      actor: vfinDirectActor,
      action: "vendor_finance_record",
      timestamp: TIMESTAMP,
      resource: resourceFor("all"),
    }).code,
    "REASON_REQUIRED",
  );
  assert.equal(
    authorizeDirectEntry({
      actor: vfinDirectActor,
      action: "vendor_finance_record",
      timestamp: TIMESTAMP,
      reason_ref: REASON_REF,
      resource: resourceFor("all"),
    }).allowed,
    true,
  );
  assert.equal(
    authorizeDirectEntry({
      actor: actor({ capabilities: ["vendor_finance_view", "vendor_finance_record"], scopes: [TEAM_SCOPE] }),
      action: "vendor_finance_view",
      timestamp: TIMESTAMP,
      resource: resourceFor("team"),
    }).code,
    "ACTION_SCOPE_MISMATCH",
  );

  const navProjected = {
    capabilities: ["vendor_finance_view", "vendor_finance_record"],
    scopes: [{ kind: "all" }],
  };
  assert.equal(directEntryNavPredicate(navProjected), false);
  assert.equal(workerOperationsNavPredicate(navProjected), false);
  assert.equal(projectAdminNavPredicate(navProjected), false);
  assert.equal(adminAuthorityNavPredicate(navProjected), false);
});
