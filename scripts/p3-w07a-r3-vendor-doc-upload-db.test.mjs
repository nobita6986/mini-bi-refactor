/**
 * P3-W07A-R3 / P1.7-H06 document upload DB acceptance.
 *
 * Proves the reserved hidden Vendor team, Vendor catalog/report projections,
 * and the narrow assigned-project-manager DRAFT upload exception. REVIEW and
 * SUBMITTED remain locked for ordinary project managers.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";
import { projectEntry } from "../src/lib/direct-entry/write-api.ts";
import { projectEntryDetail } from "../src/lib/direct-entry/document-detail-projection.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const MIGRATION = "20261009010000_p3_w07a_r3_vendor_hidden_team_and_document_upload.sql";
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

const MANAGER_AUTH = "00000000-0000-4000-8000-000000000101";
const MANAGER_APP = "00000000-0000-4000-8000-000000000201";
const CATALOG_AUTH = "00000000-0000-4000-8000-000000000102";
const CATALOG_APP = "00000000-0000-4000-8000-000000000202";
const RECRUITER = "00000000-0000-4000-8000-000000000301";
const TEAM = "00000000-0000-4000-8000-000000000302";
const PROJECT = "vendor_upload_project";
const VENDOR = "vendor_upload_company";

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  for (const name of names) await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.ok(names.includes(MIGRATION), "migration inventory includes the named W07A-R3 migration");
  return db;
}

async function insertActor(db, auth, app, capabilities) {
  await db.query("insert into auth.users(id) values ($1::uuid)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users" +
      " (app_user_id,auth_subject,enabled,display_name) values ($1::uuid,$2::uuid,true,$3)",
    [app, auth, "Synthetic account"],
  );
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)" +
        " values ($1::uuid,$2,'2020-01-01',true)",
      [app, capability],
    );
  }
}

async function readEntry(db, auth, app, entryId) {
  const { rows } = await db.query(
    "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as entry",
    [auth, app, entryId],
  );
  return rows[0].entry;
}

test("P3-W07A-R3 Vendor stays hidden as a team; assigned PM uploads only on DRAFT", async () => {
  const db = await buildDb();
  try {
    await db.query(
      "insert into public.teams(team_id,code,display_name,active)" +
        " values ($1::uuid,'vendor_upload_business_team','Business Team',true)",
      [TEAM],
    );
    await db.query(
      "insert into public.direct_entry_projects(project_id,display_name,active)" +
        " values ($1,'Vendor project',true)",
      [PROJECT],
    );
    await db.query("insert into public.vendors(vendor_id,display_name,active) values ($1,'Vendor Company',true)", [VENDOR]);
    await db.query(
      "insert into public.recruiters(recruiter_id,display_name,active,version)" +
        " values ($1::uuid,'Vendor Recruiter',true,1)",
      [RECRUITER],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships" +
        " (recruiter_id,provider_type,valid_from,vendor_id,is_current)" +
        " values ($1::uuid,'vendor','2020-01-01',$2,true)",
      [RECRUITER, VENDOR],
    );

    // This manager has no entry_admin, document_upload, or scope grant. The
    // verified project assignment is the sole authority for this DRAFT row.
    await insertActor(db, MANAGER_AUTH, MANAGER_APP, ["entry_own", "change_request_create"]);
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
        " (app_user_id,recruiter_id,verified,valid_from,is_current)" +
        " values ($1::uuid,$2::uuid,true,'2020-01-01',true)",
      [MANAGER_APP, RECRUITER],
    );
    await db.query(
      "insert into public.direct_entry_project_manager_assignments" +
        " (project_id,manager_recruiter_id,valid_from,is_current) values ($1,$2::uuid,'2020-01-01',true)",
      [PROJECT, RECRUITER],
    );
    await insertActor(db, CATALOG_AUTH, CATALOG_APP, ["entry_create"]);

    const catalog = (await db.query(
      "select public.direct_entry_input_catalog($1::uuid,$2::uuid,'2026-10-09'::date) as value",
      [CATALOG_AUTH, CATALOG_APP],
    )).rows[0].value;
    const vendorOption = catalog.recruiters.find((item) => item.recruiter_id === RECRUITER);
    assert.ok(vendorOption);
    assert.equal(vendorOption.provider_type, "vendor");
    assert.equal(vendorOption.team_id, null);
    assert.equal(vendorOption.team_display_name, null);
    assert.equal(vendorOption.label, "Vendor Company");
    assert.equal((await db.query(
      "select count(*)::int as count from public.teams where code='__system_vendor__'",
    )).rows[0].count, 0, "Vendor team is lazy so catalog bootstrap still sees an empty business target");

    const create = (await db.query(
      "select public.direct_entry_create_full_profile_batch_v2(" +
        "$1::uuid,$2::uuid,'worker-profile/1.1',$3::jsonb,$4::text) as value",
      [MANAGER_AUTH, MANAGER_APP, JSON.stringify([{
        project_id: PROJECT,
        first_work_date: "2026-10-09",
        provider_type: "vendor",
        recruiter_id: RECRUITER,
        labor_type: "TEMPORARY",
        display_name: "Vendor DRAFT Worker",
        worker_details: {
          date_of_birth: { state: "provided", value: "1990-01-01" },
          national_id: { state: "provided", value: "012345678901" },
          address: { state: "provided", value: "Test address" },
          phone: { state: "provided", value: "0900000000" },
        },
      }]), "00000000-0000-4000-8000-000000000901"],
    )).rows[0].value;
    assert.equal(create.entry_ids.length, 1);
    const entryId = create.entry_ids[0];
    const systemTeam = (await db.query(
      "select team_id::text,code,display_name,active from public.teams where code='__system_vendor__'",
    )).rows[0];
    assert.deepEqual(systemTeam, {
      team_id: systemTeam.team_id,
      code: "__system_vendor__",
      display_name: "Vendor",
      active: true,
    });
    await assert.rejects(
      db.query(
        "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)" +
          " values ($1::uuid,$2::uuid,'2020-01-01')",
        [RECRUITER, systemTeam.team_id],
      ),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      db.query(
        "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)" +
          " values ($1::uuid,'team',$2::uuid,'2020-01-01')",
        [MANAGER_APP, systemTeam.team_id],
      ),
      (error) => error.code === "23514",
    );
    const storedTeam = (await db.query(
      "select e.team_id::text,t.code,t.display_name,e.provider_type" +
        " from public.direct_entries e join public.teams t on t.team_id=e.team_id" +
        " where e.entry_id=$1::uuid",
      [entryId],
    )).rows[0];
    assert.equal(storedTeam.team_id, systemTeam.team_id);
    assert.equal(storedTeam.code, "__system_vendor__");
    assert.equal(storedTeam.display_name, "Vendor");
    assert.equal(storedTeam.provider_type, "vendor");

    const drafts = (await db.query(
      "select public.direct_entry_list_own_drafts($1::uuid,$2::uuid) as value",
      [MANAGER_AUTH, MANAGER_APP],
    )).rows[0].value;
    const listedDraft = drafts.drafts.find((item) => item.entry_id === entryId);
    assert.ok(listedDraft);
    assert.equal(listedDraft.team_display_name, "Không áp dụng");

    const firstReserve = (await db.query(
      "select public.direct_entry_reserve_document_direct_upload(" +
        "$1::uuid,$2::uuid,$3::uuid,1,'CCCD_FRONT','vendor-draft-upload-01',1024," +
        "'application/pdf','PM upload before submission') as value",
      [MANAGER_AUTH, MANAGER_APP, entryId],
    )).rows[0].value;
    assert.equal(firstReserve.upload_status, "QUEUED");
    let projection = await readEntry(db, MANAGER_AUTH, MANAGER_APP, entryId);
    assert.equal(projection.scope_kind, "project");
    assert.deepEqual(projection.worker_portrait, {
      origin: null, added_at: null, status: "MISSING", current: null,
    });
    assert.ok(projectEntry(projection), "worker detail API accepts the sanitized document projection");

    const finalized = (await db.query(
      "select public.direct_entry_finalize_document_direct_upload(" +
        "$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::integer,$6::text,'validated',$7::text," +
        "$8::bigint,'application/pdf') as value",
      [MANAGER_AUTH, MANAGER_APP, entryId, firstReserve.document_id,
        firstReserve.entry_version, "vendor-draft-upload-final-01", "a".repeat(64), 1024],
    )).rows[0].value;
    assert.equal(finalized.upload_status, "READY");
    projection = await readEntry(db, MANAGER_AUTH, MANAGER_APP, entryId);
    assert.equal(projection.documents.length, 1);
    assert.equal(projection.documents[0].validation_status, "VALIDATED");
    assert.deepEqual(projection.worker_portrait, {
      origin: null, added_at: null, status: "MISSING", current: null,
    });
    assert.equal("storage_key" in projection.documents[0], false);
    assert.equal("filename" in projection.documents[0], false);
    assert.ok(projectEntry(projection));
    const detail = projectEntryDetail({ ok: true, entry: projection }, entryId);
    assert.ok(detail, "entry-detail projector accepts the repaired DB validation_status field");
    assert.equal(detail.documents[0].validation_status, "VALIDATED");
    assert.equal("storage_key" in detail.documents[0], false);
    assert.equal("checksum_sha256" in detail.documents[0], false);

    const submissionId = (await db.query(
      "select submission_id::text from public.direct_entries where entry_id=$1::uuid",
      [entryId],
    )).rows[0].submission_id;
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)" +
        " values ($1::uuid,'submission_create','2020-01-01',true)",
      [MANAGER_APP],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from,is_current)" +
        " values ($1::uuid,'own','2020-01-01',true)",
      [MANAGER_APP],
    );
    await seedLegacyReviewSubmission(db, submissionId);
    const versionBeforeDeniedReviewUpload = (await db.query(
      "select version from public.direct_entries where entry_id=$1::uuid", [entryId],
    )).rows[0].version;
    await assert.rejects(
      db.query(
        "select public.direct_entry_reserve_document_direct_upload(" +
          "$1::uuid,$2::uuid,$3::uuid,$4::integer,'CCCD_BACK','vendor-review-upload-01',1024," +
          "'application/pdf','Must remain locked in review')",
        [MANAGER_AUTH, MANAGER_APP, entryId, versionBeforeDeniedReviewUpload],
      ),
      (error) => error.code === "42501",
    );
    await db.query(
      "select public.direct_entry_transition_submission($1::uuid,$2::uuid,$3::uuid,2,'SUBMITTED','vendor-submit-01')",
      [MANAGER_AUTH, MANAGER_APP, submissionId],
    );
    const beforeSubmittedAttempt = (await db.query(
      "select e.version, (select count(*)::int from public.direct_entry_document_versions d" +
        " where d.candidate_id=e.candidate_id) as documents," +
        " (select count(*)::int from public.direct_entry_rpc_idempotency i" +
        " where i.app_user_id=$2::uuid) as idempotency" +
        " from public.direct_entries e where e.entry_id=$1::uuid",
      [entryId, MANAGER_APP],
    )).rows[0];
    await assert.rejects(
      db.query(
        "select public.direct_entry_reserve_document_direct_upload(" +
          "$1::uuid,$2::uuid,$3::uuid,$4::integer,'CCCD_BACK','vendor-submitted-upload-01',1024," +
          "'application/pdf','Must remain locked after submission')",
        [MANAGER_AUTH, MANAGER_APP, entryId, beforeSubmittedAttempt.version],
      ),
      (error) => error.code === "42501",
    );
    const afterSubmittedAttempt = (await db.query(
      "select e.version, (select count(*)::int from public.direct_entry_document_versions d" +
        " where d.candidate_id=e.candidate_id) as documents," +
        " (select count(*)::int from public.direct_entry_rpc_idempotency i"+
        " where i.app_user_id=$2::uuid) as idempotency"+
        " from public.direct_entries e where e.entry_id=$1::uuid",
      [entryId, MANAGER_APP],
    )).rows[0];
    assert.deepEqual(afterSubmittedAttempt, beforeSubmittedAttempt,
      "denied post-submit upload leaves entry, documents and idempotency ledger unchanged");

    const reportOptions = (await db.query(
      "select dimension,key,display from public.direct_entry_reporting_dimension_options_v01",
    )).rows;
    assert.equal(reportOptions.some((item) => item.dimension === "team"), false,
      "no team business dimension is added for the hidden internal Vendor team");
    assert.ok(reportOptions.some((item) => item.dimension === "provider" && item.display === "Vendor"),
      "Vendor remains represented only as the provider dimension");
    const factColumns = (await db.query(
      "select column_name from information_schema.columns" +
        " where table_schema='public' and table_name='direct_entry_reporting_facts_v01'",
    )).rows.map((row) => row.column_name);
    const teamFactColumns = factColumns.filter((name) => name.includes("team"));
    assert.deepEqual(teamFactColumns, ["team_id", "team_code", "team_display_name", "team_active"],
      "R9 reporting facts append the four server-side team projection columns");
  } finally {
    await db.close();
  }
});
