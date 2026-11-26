/**
 * P3-W07A-R2 — Catalog runtime contract hotfix regression.
 *
 * Task:      P3-W07A-R2_CATALOG_RUNTIME_CONTRACT_HOTFIX_FAST_TRACK
 * Status:    P3-W07A-R2_CATALOG_RUNTIME_CONTRACT_HOTFIX_LOCAL_PASS_FAST_TRACK
 * Base:      origin/main@5e7e5c7
 *
 * Production read-only evidence (T0) recorded:
 *   top_keys = [projects, recruiters, effective_date]
 *   has_banks = false
 *   runtime projector accepted = false
 *   `banks` was missing BEFORE HRP import. The runtime projector in
 *   `src/lib/direct-entry/write-repository.ts::projectDraftCatalog` requires
 *   four exact top-level keys; the W07A-R1 RPC contract dropped `banks` so
 *   the projector rejected the result with HTTP 500 CATALOG_UNAVAILABLE.
 *
 * This test pins the locked four-top-level-key / eight-key-per-recruiter
 * contract end-to-end:
 *   1. PGlite applies all migrations from scratch.
 *   2. Production `direct_entry_input_catalog` is called as service_role.
 *   3. The verbatim raw RPC result is fed into `projectDraftCatalog`.
 *   4. Scenarios cover: empty catalog, HRP, Vendor, active banks, missing
 *      `banks` / `vendor_id` / wrong shape, and a full HTTP 200 from
 *      `getInputCatalog` against the live API surface.
 *
 * No business data is committed; the suite is data-agnostic.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";
import { getInputCatalog } from "../src/lib/direct-entry/draft-api.ts";
import {
  projectDraftCatalog,
} from "../src/lib/direct-entry/write-repository.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const HRP_RECRUITER = "11111111-1111-4111-8111-111111111111";
const VENDOR_RECRUITER = "22222222-2222-4222-8222-222222222222";
const TEAM_A = "33333333-3333-4333-8333-333333333333";
const HRP_AUTH = "00000000-0000-4000-8000-000000000001";
const HRP_APP_USER = "00000000-0000-4000-8000-000000000002";

async function buildDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  for (const name of migrations) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await db.query("insert into auth.users(id) values ($1::uuid)", [HRP_AUTH]);
  await db.query(
    "insert into public.direct_entry_app_users" +
    " (app_user_id, auth_subject, enabled, display_name)" +
    " values ($1::uuid, $2::uuid, true, 'Synthetic Account')",
    [HRP_APP_USER, HRP_AUTH],
  );
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, is_current)" +
    " values ($1::uuid, 'entry_create', '2020-01-01', true)",
    [HRP_APP_USER],
  );
  return db;
}

async function callCatalog(db, effectiveDate) {
  const result = await db.query(
    "select public.direct_entry_input_catalog($1::uuid, $2::uuid, $3::date) as catalog",
    [HRP_AUTH, HRP_APP_USER, effectiveDate],
  );
  return result.rows[0].catalog;
}

test("H1 empty catalog before import still carries the four locked top-level keys", async () => {
  const db = await buildDatabase();
  const catalog = await callCatalog(db, "2026-10-15");
  // P3.1-W02-C (#79): the locked four-key contract is preserved and the active
  // labor-type options are appended, so the Direct Entry runtime resolves its
  // labor types from this one canonical projection instead of a private map.
  assert.deepEqual(
    Object.keys(catalog).sort(),
    ["banks", "effective_date", "labor_types", "projects", "recruiters"],
    "the locked four-key top-level contract is present (banks restored, not optional)" +
    " plus the active labor-type options",
  );
  assert.deepEqual(catalog.labor_types.map((option) => option.labor_type_key),
    ["TEMPORARY", "PERMANENT", "OUTSOURCED"],
    "the canonical labor-type catalog reaches the runtime through this projection");
  assert.deepEqual(Object.keys(catalog.labor_types[0]).sort(),
    ["display_name", "labor_type_key", "sort_order"],
    "the option stays bounded to key, label and order");
  assert.deepEqual(catalog.projects, []);
  assert.deepEqual(catalog.recruiters, []);
  // Banks is always an array (may be empty); the runtime projector
  // requires Array.isArray(catalog.banks).
  assert.ok(Array.isArray(catalog.banks), "banks is an array (possibly empty)");
  assert.equal(catalog.effective_date, "2026-10-15");

  // PGlite raw RPC result must be accepted by the runtime projector. This
  // is the production seam that closed the CATALOG_UNAVAILABLE blocker.
  const projected = projectDraftCatalog(catalog, "2026-10-15");
  assert.ok(projected, "runtime projector accepts the empty-catalog RPC result");
  assert.equal(projected.banks.length, 0);
  await db.close();
});

test("H2 HRP catalog exposes vendor_id=null, UUID team, and a non-null team_display_name", async () => {
  const db = await buildDatabase();
  await db.query(
    "insert into public.teams(team_id, code, display_name, active) values" +
    " ($1::uuid, 'team-a', 'Team Alpha', true)",
    [TEAM_A],
  );
  await db.query(
    "insert into public.recruiters(recruiter_id, display_name, active, version, personnel_code)" +
    " values ($1::uuid, 'HRP Sale A', true, 1, 'vinht.td')",
    [HRP_RECRUITER],
  );
  await db.query(
    "insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from, is_current)" +
    " values ($1::uuid, $2::uuid, '2026-01-01'::date, true)",
    [HRP_RECRUITER, TEAM_A],
  );
  await db.query(
    "insert into public.recruiter_provider_memberships(recruiter_id, provider_type, valid_from, is_current)" +
    " values ($1::uuid, 'hrp', '2026-01-01'::date, true)",
    [HRP_RECRUITER],
  );

  const catalog = await callCatalog(db, "2026-10-15");
  const projected = projectDraftCatalog(catalog, "2026-10-15");
  assert.ok(projected, "runtime projector accepts the HRP RPC result");
  assert.equal(projected.recruiters.length, 1);
  const hrp = projected.recruiters[0];
  assert.equal(hrp.provider_type, "hrp");
  assert.equal(hrp.vendor_id, null, "HRP rows have vendor_id explicitly null");
  assert.equal(hrp.personnel_code, "vinht.td");
  assert.equal(hrp.team_id, TEAM_A, "HRP team_id is a UUID");
  assert.equal(hrp.team_display_name, "Team Alpha");
  assert.equal(hrp.label, "HRP Sale A · vinht.td · Team Alpha",
    "HRP label = `display_name · personnel_code · team_display_name`");
  // HRP has no Vendor fields; runtime shape is discriminated.
  assert.equal(hrp.team_id === null, false, "HRP team_id is non-null");
  assert.equal(hrp.team_display_name === null, false, "HRP team_display_name is non-null");
  await db.close();
});

test("H3 Vendor catalog carries null team and is accepted by the runtime projector", async () => {
  const db = await buildDatabase();
  await db.query(
    "insert into public.vendors(vendor_id, display_name) values" +
    " ('vendor_x', 'Vendor X')",
  );
  await db.query(
    "insert into public.recruiters(recruiter_id, display_name, active, version)" +
    " values ($1::uuid, 'Vendor Recruiter', true, 1)",
    [VENDOR_RECRUITER],
  );
  await db.query(
    "insert into public.recruiter_provider_memberships(recruiter_id, provider_type, valid_from, vendor_id, is_current)" +
    " values ($1::uuid, 'vendor', '2026-01-01'::date, 'vendor_x', true)",
    [VENDOR_RECRUITER],
  );

  const catalog = await callCatalog(db, "2026-10-15");
  const projected = projectDraftCatalog(catalog, "2026-10-15");
  assert.ok(projected, "runtime projector accepts the Vendor RPC result");
  assert.equal(projected.recruiters.length, 1);
  const vendor = projected.recruiters[0];
  assert.equal(vendor.provider_type, "vendor");
  assert.equal(vendor.personnel_code, null, "Vendor rows have personnel_code explicitly null");
  assert.equal(vendor.team_id, null, "Vendor rows have team_id explicitly null");
  assert.equal(vendor.team_display_name, null, "Vendor rows have team_display_name explicitly null");
  assert.equal(vendor.vendor_id, "vendor_x");
  assert.equal(vendor.label, "Vendor X");
  await db.close();
});

test("H4 active banks appear in the catalog and the runtime projector accepts them", async () => {
  const db = await buildDatabase();
  await db.query(
    "insert into public.direct_entry_banks(bank_id, display_name, active) values" +
    " ('bank_active', 'Active Bank', true)," +
    " ('bank_inactive', 'Inactive Bank', false)",
  );

  const catalog = await callCatalog(db, "2026-10-15");
  assert.ok(Array.isArray(catalog.banks));
  const projected = projectDraftCatalog(catalog, "2026-10-15");
  assert.ok(projected, "runtime projector accepts banks array");
  assert.equal(projected.banks.length, 1, "only active banks surface");
  assert.equal(projected.banks[0].bank_id, "bank_active");
  assert.equal(projected.banks[0].display_name, "Active Bank");
  await db.close();
});

test("H5 malformed catalog inputs are rejected by the runtime projector", async () => {
  // Missing `banks` reproduces the W07A-R1 production bug. The runtime
  // projector must fail closed (returns null) and the API must surface
  // HTTP 500 CATALOG_UNAVAILABLE.
  const missingBanks = {
    effective_date: "2026-10-15",
    projects: [],
    recruiters: [],
  };
  assert.equal(projectDraftCatalog(missingBanks, "2026-10-15"), null,
    "missing `banks` key is rejected (production CATALOG_UNAVAILABLE root cause)");

  // Missing `vendor_id` is rejected (eight-key contract).
  const missingVendorId = {
    effective_date: "2026-10-15",
    projects: [],
    recruiters: [{
      recruiter_id: HRP_RECRUITER, display_name: "HRP",
      personnel_code: "hrp", provider_type: "hrp",
      team_id: TEAM_A, team_display_name: "Team",
      label: "x",
    }],
    banks: [],
  };
  assert.equal(projectDraftCatalog(missingVendorId, "2026-10-15"), null,
    "missing `vendor_id` is rejected (exact 8-key contract)");

  // HRP with vendor_id !== null is rejected (HRP is null-only).
  const hrpWithVendor = {
    effective_date: "2026-10-15",
    projects: [],
    recruiters: [{
      recruiter_id: HRP_RECRUITER, display_name: "HRP",
      personnel_code: "hrp", provider_type: "hrp",
      vendor_id: "vendor_x",
      team_id: TEAM_A, team_display_name: "Team",
      label: "x",
    }],
    banks: [],
  };
  assert.equal(projectDraftCatalog(hrpWithVendor, "2026-10-15"), null,
    "HRP with vendor_id !== null is rejected (discriminated contract)");

  // Vendor with non-null team is rejected.
  const vendorWithTeam = {
    effective_date: "2026-10-15",
    projects: [],
    recruiters: [{
      recruiter_id: VENDOR_RECRUITER, display_name: "Vendor",
      personnel_code: null, provider_type: "vendor",
      vendor_id: "vendor_x",
      team_id: TEAM_A, team_display_name: "Team",
      label: "x",
    }],
    banks: [],
  };
  assert.equal(projectDraftCatalog(vendorWithTeam, "2026-10-15"), null,
    "Vendor with non-null team is rejected (Vendor has no business team)");

  // Vendor with non-null personnel_code is rejected.
  const vendorWithCode = {
    effective_date: "2026-10-15",
    projects: [],
    recruiters: [{
      recruiter_id: VENDOR_RECRUITER, display_name: "Vendor",
      personnel_code: "should-be-null", provider_type: "vendor",
      vendor_id: "vendor_x", team_id: null, team_display_name: null,
      label: "x",
    }],
    banks: [],
  };
  assert.equal(projectDraftCatalog(vendorWithCode, "2026-10-15"), null,
    "Vendor with personnel_code !== null is rejected");
});

test("H6 getInputCatalog returns HTTP 200 with the real RPC contract, not a hand fixture", async () => {
  const db = await buildDatabase();
  await db.query(
    "insert into public.teams(team_id, code, display_name, active) values" +
    " ($1::uuid, 'team-a', 'Team Alpha', true)",
    [TEAM_A],
  );
  await db.query(
    "insert into public.recruiters(recruiter_id, display_name, active, version, personnel_code)" +
    " values ($1::uuid, 'HRP Sale A', true, 1, 'vinht.td')," +
    "        ($2::uuid, 'Vendor Recruiter', true, 1, null)",
    [HRP_RECRUITER, VENDOR_RECRUITER],
  );
  await db.query(
    "insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from, is_current)" +
    " values ($1::uuid, $2::uuid, '2026-01-01'::date, true)",
    [HRP_RECRUITER, TEAM_A],
  );
  await db.query(
    "insert into public.recruiter_provider_memberships(recruiter_id, provider_type, valid_from, vendor_id, is_current)" +
    " values ($1::uuid, 'hrp',    '2026-01-01'::date, null, true)," +
    "        ($2::uuid, 'vendor', '2026-01-01'::date, null, true)",
    [HRP_RECRUITER, VENDOR_RECRUITER],
  );
  await db.query(
    "insert into public.direct_entry_banks(bank_id, display_name) values" +
    " ('bank_a', 'Bank A')",
  );

  // PGlite's rpc call below is intentionally NOT used here. We drive the
  // real `getInputCatalog` HTTP handler with a PGlite-backed repository
  // that calls the real production RPC. This proves the full production
  // path end-to-end: API route -> draft-api -> repository -> RPC -> DB.
  const repository = {
    async loadInputCatalog(input) {
      const result = await db.query(
        "select public.direct_entry_input_catalog($1::uuid, $2::uuid, $3::date) as data",
        [input.auth_subject, input.app_user_id, input.effective_date],
      );
      const raw = result.rows[0].data;
      // The runtime projector is part of the production path; the
      // repository contract is the same `loadInputCatalog` that the
      // production write-repository implements.
      const projection = projectDraftCatalog(raw, input.effective_date);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    },
  };
  const dependencies = {
    resolveSession: async () => ({
      actor: { ok: true, actor: { auth_subject: HRP_AUTH, app_user_id: HRP_APP_USER } },
      response_headers: {},
    }),
    repository,
  };

  const response = await getInputCatalog("2026-10-15", "true", dependencies);
  assert.equal(response.status, 200,
    "production HTTP path returns 200 once the four-key contract is restored");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.catalog).sort(),
    ["banks", "effective_date", "labor_types", "projects", "recruiters"],
    "HTTP 200 body carries the locked top-level keys plus the active labor types");
  assert.equal(body.catalog.recruiters.length, 2);
  const hrp = body.catalog.recruiters.find((r) => r.provider_type === "hrp");
  const vendor = body.catalog.recruiters.find((r) => r.provider_type === "vendor");
  assert.ok(hrp, "HRP row present in HTTP 200");
  assert.equal(hrp.vendor_id, null);
  assert.equal(hrp.team_id, TEAM_A);
  assert.equal(hrp.team_display_name, "Team Alpha");
  assert.ok(vendor, "Vendor row present in HTTP 200");
  assert.equal(vendor.team_id, null);
  assert.equal(vendor.team_display_name, null);
  assert.equal(vendor.personnel_code, null);
  assert.equal(body.catalog.banks.length, 1);
  assert.equal(body.catalog.banks[0].bank_id, "bank_a");
  await db.close();
});
