import assert from "node:assert/strict";
import test from "node:test";

import {
  CCCD_REVIEW_MANUAL_RESOLUTION_MIGRATION_NAME,
  CCCD_REVIEW_MANUAL_RESOLUTION_RPC_SIGNATURE,
  PRE_WAVE2_CCCD_REVIEW_MIGRATION_NAME,
  PRE_WAVE2_CCCD_REVIEW_RPC_SIGNATURES,
} from "./lib/migration-validation.mjs";
import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  createMigratedDatabase,
  seedSubmissionReadFixture,
} from "./lib/s04c-submission-read-fixture.mjs";

const migrations = await createMigratedDatabase();
const db = migrations.db;
await seedSubmissionReadFixture(db);
const projectId = PROJECT_ID;
const recruiterId = RECRUITER_A;

await db.query(
  "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)" +
    " values ($1,'document_upload','2020-01-01',true),($1,'document_view','2020-01-01',true)",
  [ACTORS.owner.app_user_id],
);

await db.query(
  "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)" +
    " values ($1,'document_upload','2020-01-01',true),($1,'document_view','2020-01-01',true)",
  [ACTORS.otherOwner.app_user_id],
);

const QR_CANDIDATE_MATCH = {
  source: "CCCD_QR",
  authenticity: "UNVERIFIED_QR_TEXT",
  national_id: "079095008811",
  display_name: "Lê Thị Hồng Nhung",
  date_of_birth: "12/04/1996",
  date_of_birth_iso: "1996-04-12",
  gender: "FEMALE",
  gender_label: "Nữ",
  address: "45 Lê Lợi, Quận 1, TP. Hồ Chí Minh",
  national_id_issued_at: "15/06/2022",
  national_id_issued_at_iso: "2022-06-15",
};

const QR_CANDIDATE_MISMATCH = {
  source: "CCCD_QR",
  authenticity: "UNVERIFIED_QR_TEXT",
  national_id: "079095009922",
  display_name: "Trần Văn Khác",
  date_of_birth: "01/01/1990",
  date_of_birth_iso: "1990-01-01",
  gender: "MALE",
  gender_label: "Nam",
  address: "99 Hai Bà Trưng, Quận 3, TP. Hồ Chí Minh",
  national_id_issued_at: "10/10/2021",
  national_id_issued_at_iso: "2021-10-10",
};

async function createBatchV2(actor, contractVersion, rows, idempotencyKey) {
  const res = await db.query(
    "select public.direct_entry_create_full_profile_batch_v2_unscoped_h03($1::uuid, $2::uuid, $3::text, $4::jsonb, $5::text) as data",
    [actor.auth_subject, actor.app_user_id, contractVersion, JSON.stringify(rows), idempotencyKey],
  );
  return res.rows[0].data;
}

async function reserveAndFinalizeCccd(entryId, entryVersion, docType, keySuffix) {
  const reserved = await db.query(
    "select public.direct_entry_reserve_document_direct_upload(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text, " +
      "$6::text, 512, 'image/jpeg', null) as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      entryVersion,
      docType,
      `res-${keySuffix}`,
    ],
  );
  const docId = reserved.rows[0].data.document_id;
  const verAfterReserve = reserved.rows[0].data.entry_version;
  const finalized = await db.query(
    "select public.direct_entry_finalize_document_direct_upload(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, " +
      "$6::text, 'validated', $7::text, 512, 'image/jpeg') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      docId,
      verAfterReserve,
      `fin-${keySuffix}`,
      "a".repeat(64),
    ],
  );
  return {
    documentId: docId,
    entryVersion: finalized.rows[0].data.entry_version,
  };
}

test("Pre-Wave-2 migration enforces Forced RLS, default-deny table ACLs, and service_role-only SECURITY DEFINER RPCs", async () => {
  assert.ok(
    migrations.migrationNames.includes(PRE_WAVE2_CCCD_REVIEW_MIGRATION_NAME),
    "migration inventory includes 20261026180000_pre_wave2_cccd_reconciliation_and_review.sql",
  );

  const { rows: tableMeta } = await db.query(
    `select c.relrowsecurity, c.relforcerowsecurity,
            (select count(*)::int from pg_catalog.pg_policy pol where pol.polrelid = c.oid) as policy_count
       from pg_catalog.pg_class c
      where c.oid = 'public.direct_entry_cccd_reconciliations'::pg_catalog.regclass`,
  );
  assert.deepEqual(tableMeta[0], {
    relrowsecurity: true,
    relforcerowsecurity: true,
    policy_count: 0,
  });

  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const { rows } = await db.query(
        "select pg_catalog.has_table_privilege($1, 'public.direct_entry_cccd_reconciliations', $2) as allowed",
        [role, priv],
      );
      assert.equal(rows[0].allowed, false);
    }
  }

  assert.ok(migrations.migrationNames.includes(CCCD_REVIEW_MANUAL_RESOLUTION_MIGRATION_NAME));
  for (const sig of [
    ...PRE_WAVE2_CCCD_REVIEW_RPC_SIGNATURES,
    CCCD_REVIEW_MANUAL_RESOLUTION_RPC_SIGNATURE,
  ]) {
    const { rows } = await db.query(
      `select p.prosecdef,
              p.proconfig,
              pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
         from pg_catalog.pg_proc p
        where p.oid = $1::pg_catalog.regprocedure`,
      [sig],
    );
    assert.deepEqual(rows[0], {
      prosecdef: true,
      proconfig: ["search_path=pg_catalog, public"],
      anon_exec: false,
      auth_exec: false,
      service_exec: true,
    });
  }
});

test("worker-profile/1.2 requires 12-digit CCCD and allows blank display_name, while worker-profile/1.1 (Grid) stays unchanged", async () => {
  // 1. worker-profile/1.1 (Grid mode) still rejects blank display_name and allows omitted national_id
  await assert.rejects(
    createBatchV2(
      ACTORS.owner,
      "worker-profile/1.1",
      [
        {
          project_id: projectId,
          first_work_date: "2026-04-01",
          recruiter_id: recruiterId,
          provider_type: "hrp",
          labor_type: "TEMPORARY",
          display_name: "",
          worker_details: {
            gender: { state: "omitted" },
            date_of_birth: { state: "omitted" },
            national_id: { state: "provided", value: "079095008800" },
            national_id_issued_at: { state: "omitted" },
            national_id_issued_place: { state: "omitted" },
            address: { state: "omitted" },
            phone: { state: "omitted" },
          },
          general_note: { state: "omitted" },
          payment: null,
          employment: { initial_status: "ON" },
        },
      ],
      "11111111-1111-4111-8111-000000000001",
    ),
    (err) => err.code === "22023",
  );

  const gridCreated = await createBatchV2(
    ACTORS.owner,
    "worker-profile/1.1",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-01",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "Nguyễn Văn Lưới",
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "omitted" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "ON" },
      },
    ],
    "11111111-1111-4111-8111-000000000002",
  );
  assert.equal(gridCreated.entry_ids.length, 1);

  // 2. worker-profile/1.2 (Form & Android) rejects omitted national_id
  await assert.rejects(
    createBatchV2(
      ACTORS.owner,
      "worker-profile/1.2",
      [
        {
          project_id: projectId,
          first_work_date: "2026-04-01",
          recruiter_id: recruiterId,
          provider_type: "hrp",
          labor_type: "TEMPORARY",
          display_name: "Có Tên Nhưng Thiếu CCCD",
          worker_details: {
            gender: { state: "omitted" },
            date_of_birth: { state: "omitted" },
            national_id: { state: "omitted" },
            national_id_issued_at: { state: "omitted" },
            national_id_issued_place: { state: "omitted" },
            address: { state: "omitted" },
            phone: { state: "omitted" },
          },
          general_note: { state: "omitted" },
          payment: null,
          employment: { initial_status: "ON" },
        },
      ],
      "11111111-1111-4111-8111-000000000003",
    ),
    (err) => err.code === "22023",
  );

  // 3. worker-profile/1.2 succeeds with blank display_name ("") and valid 12-digit national_id,
  //    and initializes PENDING reconciliation row.
  const formCreated = await createBatchV2(
    ACTORS.owner,
    "worker-profile/1.2",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-01",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "",
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: "079095008811" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "provided", value: "0909123456" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "ON" },
      },
    ],
    "11111111-1111-4111-8111-000000000004",
  );
  const entryId = formCreated.entry_ids[0];

  const { rows: recRows } = await db.query(
    "select status, entered_national_id, qr_national_id from public.direct_entry_cccd_reconciliations where entry_id = $1",
    [entryId],
  );
  assert.deepEqual(recRows[0], {
    status: "PENDING",
    entered_national_id: "079095008811",
    qr_national_id: null,
  });
});

test("MATCHED_INITIAL auto-fills blank display_name and personal fields from QR, preserves OCC compatibility for concurrent uploads, and non-QR back side never downgrades MATCHED_INITIAL", async () => {
  const created = await createBatchV2(
    ACTORS.owner,
    "worker-profile/1.2",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-02",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "",
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: QR_CANDIDATE_MATCH.national_id },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "provided", value: "0912000111" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "ON" },
      },
    ],
    "11111111-1111-4111-8111-000000000005",
  );
  const entryId = created.entry_ids[0];

  // Upload CCCD_FRONT
  const front = await reserveAndFinalizeCccd(entryId, 1, "CCCD_FRONT", "match-front");
  await db.query(
    "select public.direct_entry_prepare_cccd_qr_extraction($1::uuid, $2::uuid, $3::uuid, $4::uuid, null)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, front.documentId],
  );

  // Complete QR extraction with matching CCCD and apply_blank_fields = true (no expected_entry_version, simulating background worker)
  const completed = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, null, 'idem-match-autofill') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      front.documentId,
      JSON.stringify(QR_CANDIDATE_MATCH),
    ],
  );
  assert.equal(completed.rows[0].data.extraction.reconciliation_status, "MATCHED_INITIAL");
  assert.equal(completed.rows[0].data.reconciliation.status, "MATCHED_INITIAL");
  assert.deepEqual(completed.rows[0].data.extraction.applied_fields, [
    "address",
    "date_of_birth",
    "display_name",
    "gender",
    "national_id_issued_at",
  ]);

  // Verify blank display_name and personal fields were filled on direct_entries, while phone stayed intact
  const { rows: entryRows } = await db.query(
    "select version, worker_details from public.direct_entries where entry_id = $1",
    [entryId],
  );
  const versionAfterAutoFill = entryRows[0].version;
  assert.equal(versionAfterAutoFill, front.entryVersion + 1);
  assert.equal(entryRows[0].worker_details.display_name, QR_CANDIDATE_MATCH.display_name);
  assert.deepEqual(entryRows[0].worker_details.date_of_birth, {
    state: "provided",
    value: QR_CANDIDATE_MATCH.date_of_birth,
  });
  assert.deepEqual(entryRows[0].worker_details.gender, {
    state: "provided",
    value: QR_CANDIDATE_MATCH.gender,
  });
  assert.deepEqual(entryRows[0].worker_details.address, {
    state: "provided",
    value: QR_CANDIDATE_MATCH.address,
  });
  assert.deepEqual(entryRows[0].worker_details.national_id_issued_at, {
    state: "provided",
    value: QR_CANDIDATE_MATCH.national_id_issued_at,
  });
  assert.deepEqual(entryRows[0].worker_details.phone, {
    state: "provided",
    value: "0912000111",
  });

  // Verify OCC compatibility: client holding pre-autofill version (front.entryVersion) can still upload CCCD_BACK!
  const back = await reserveAndFinalizeCccd(entryId, front.entryVersion, "CCCD_BACK", "match-back");
  await db.query(
    "select public.direct_entry_prepare_cccd_qr_extraction($1::uuid, $2::uuid, $3::uuid, $4::uuid, null)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, back.documentId],
  );
  const backNoQr = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'NO_QR_FOUND', 'QR_NOT_DETECTED', null, null, true, null, 'idem-match-back-noqr') as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, back.documentId],
  );
  // Entry reconciliation MUST remain MATCHED_INITIAL even though CCCD_BACK had NO_QR_FOUND!
  assert.equal(backNoQr.rows[0].data.reconciliation.status, "MATCHED_INITIAL");
});

test("MISMATCH and QR_UNREADABLE queue, creator scope vs out-of-scope isolation, and direct resolutions (UPDATE_ENTERED_CCCD and STANDARDIZE_FROM_QR)", async () => {
  // Create an entry with CCCD 079095007733 and blank display_name
  const created = await createBatchV2(
    ACTORS.owner,
    "worker-profile/1.2",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-03",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "",
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: "079095007733" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "ON" },
      },
    ],
    "11111111-1111-4111-8111-000000000006",
  );
  const entryId = created.entry_ids[0];

  const front = await reserveAndFinalizeCccd(entryId, 1, "CCCD_FRONT", "mismatch-front");
  await db.query(
    "select public.direct_entry_prepare_cccd_qr_extraction($1::uuid, $2::uuid, $3::uuid, $4::uuid, null)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, front.documentId],
  );

  // Complete QR with MISMATCH candidate ("079095009922" != "079095007733")
  const mismatched = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, null, 'idem-mismatch-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      front.documentId,
      JSON.stringify(QR_CANDIDATE_MISMATCH),
    ],
  );
  assert.equal(mismatched.rows[0].data.reconciliation.status, "MISMATCH");
  assert.deepEqual(mismatched.rows[0].data.extraction.applied_fields, []);

  // Verify worker_details was NOT modified on MISMATCH (display_name is still "", national_id is still "079095007733")
  const { rows: afterMismatch } = await db.query(
    "select version, worker_details from public.direct_entries where entry_id = $1",
    [entryId],
  );
  assert.equal(afterMismatch[0].worker_details.display_name, "");
  assert.equal(afterMismatch[0].worker_details.national_id.value, "079095007733");

  // 1. Creator (ACTORS.owner) sees the entry in NEEDS_REVIEW / MISMATCH queue
  const ownerQueue = await db.query(
    "select public.direct_entry_list_cccd_review_queue($1::uuid, $2::uuid, 'MISMATCH', 1, 20) as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id],
  );
  const queueItem = ownerQueue.rows[0].data.items.find((item) => item.entry_id === entryId);
  assert.ok(queueItem, "creator must see their own created MISMATCH entry in review queue");
  assert.equal(queueItem.reconciliation_status, "MISMATCH");
  assert.equal(queueItem.entered_national_id, "079095007733");
  assert.equal(queueItem.entered_national_id_masked, "••••••••7733");
  assert.equal(queueItem.qr_national_id, "079095009922");
  assert.equal(queueItem.qr_national_id_masked, "••••••••9922");
  assert.ok(["project_manager", "creator_own"].includes(queueItem.actor_authority));

  // 2. Unrelated recruiter (ACTORS.otherOwner) does NOT see ACTORS.owner's entry in the review queue
  //    and is denied from resolving it
  const otherQueue = await db.query(
    "select public.direct_entry_list_cccd_review_queue($1::uuid, $2::uuid, 'ALL', 1, 50) as data",
    [ACTORS.otherOwner.auth_subject, ACTORS.otherOwner.app_user_id],
  );
  assert.equal(
    otherQueue.rows[0].data.items.some((item) => item.entry_id === entryId),
    false,
    "unrelated recruiter must not see out-of-scope worker CCCD in review queue",
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_resolve_cccd_review($1::uuid, $2::uuid, $3::uuid, $4::integer, 'UPDATE_ENTERED_CCCD', $5::jsonb, 'idem-other-deny')",
      [
        ACTORS.otherOwner.auth_subject,
        ACTORS.otherOwner.app_user_id,
        entryId,
        afterMismatch[0].version,
        JSON.stringify({ national_id: "079095009922", apply_blank_fields_from_qr: true }),
      ],
    ),
    (err) => err.code === "42501",
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_apply_cccd_manual_resolution($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, 'idem-manual-deny')",
      [
        ACTORS.otherOwner.auth_subject,
        ACTORS.otherOwner.app_user_id,
        entryId,
        afterMismatch[0].version,
        JSON.stringify({ national_id: "079095009922", display_name: "Tên ngoài phạm vi" }),
      ],
    ),
    (err) => err.code === "42501",
  );

  // 3. Creator resolves via UPDATE_ENTERED_CCCD to match QR ("079095009922") with apply_blank_fields_from_qr = true
  const resolvedUpdate = await db.query(
    "select public.direct_entry_resolve_cccd_review($1::uuid, $2::uuid, $3::uuid, $4::integer, 'UPDATE_ENTERED_CCCD', $5::jsonb, 'idem-resolve-update-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      afterMismatch[0].version,
      JSON.stringify({
        national_id: "079095009922",
        apply_blank_fields_from_qr: true,
        note: "Sửa lại số CCCD bị gõ nhầm",
      }),
    ],
  );
  assert.equal(resolvedUpdate.rows[0].data.reconciliation.status, "RESOLVED_EDITED_CCCD");
  assert.equal(resolvedUpdate.rows[0].data.reused, false);
  assert.ok(resolvedUpdate.rows[0].data.changed_fields.includes("national_id"));
  assert.ok(resolvedUpdate.rows[0].data.changed_fields.includes("display_name"));

  // Replay with same idempotency key returns reused = true
  const replayedUpdate = await db.query(
    "select public.direct_entry_resolve_cccd_review($1::uuid, $2::uuid, $3::uuid, $4::integer, 'UPDATE_ENTERED_CCCD', $5::jsonb, 'idem-resolve-update-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      afterMismatch[0].version,
      JSON.stringify({
        national_id: "079095009922",
        apply_blank_fields_from_qr: true,
        note: "Sửa lại số CCCD bị gõ nhầm",
      }),
    ],
  );
  assert.equal(replayedUpdate.rows[0].data.reused, true);

  const manualPayload = {
    national_id: "079095004466",
    display_name: "Nguyễn Thị Minh Anh",
    date_of_birth: "09/12/1998",
    gender: "FEMALE",
    address: null,
    national_id_issued_at: "10/02/2024",
    reason: "Đã đối chiếu CCCD bản chính với người lao động",
  };
  const manualResolution = await db.query(
    "select public.direct_entry_apply_cccd_manual_resolution($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, 'idem-manual-save-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      resolvedUpdate.rows[0].data.entry_version,
      JSON.stringify(manualPayload),
    ],
  );
  assert.equal(manualResolution.rows[0].data.action, "MANUAL_UPDATE_DETAILS");
  assert.equal(manualResolution.rows[0].data.reconciliation.status, "RESOLVED_EDITED_CCCD");
  assert.equal(manualResolution.rows[0].data.reconciliation.resolution_action, "MANUAL_UPDATE_DETAILS");
  assert.ok(manualResolution.rows[0].data.changed_fields.includes("national_id"));
  const afterLateQr = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, null, 'idem-qr-after-manual') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      front.documentId,
      JSON.stringify({
        ...QR_CANDIDATE_MISMATCH,
        national_id: manualPayload.national_id,
        address: "Địa chỉ lấy từ QR đến muộn",
      }),
    ],
  );
  assert.equal(afterLateQr.rows[0].data.reconciliation.status, "RESOLVED_EDITED_CCCD");
  assert.equal(afterLateQr.rows[0].data.reconciliation.resolution_action, "MANUAL_UPDATE_DETAILS");
  const manualReplay = await db.query(
    "select public.direct_entry_apply_cccd_manual_resolution($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, 'idem-manual-save-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      resolvedUpdate.rows[0].data.entry_version,
      JSON.stringify(manualPayload),
    ],
  );
  assert.equal(manualReplay.rows[0].data.reused, true);
  await assert.rejects(
    db.query(
      "select public.direct_entry_apply_cccd_manual_resolution($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, 'idem-manual-stale')",
      [
        ACTORS.owner.auth_subject,
        ACTORS.owner.app_user_id,
        entryId,
        resolvedUpdate.rows[0].data.entry_version,
        JSON.stringify(manualPayload),
      ],
    ),
    (err) => err.code === "PT409",
  );
  const { rows: manuallySaved } = await db.query(
    "select version, worker_details from public.direct_entries where entry_id = $1",
    [entryId],
  );
  assert.equal(manuallySaved[0].worker_details.national_id.value, manualPayload.national_id);
  assert.equal(manuallySaved[0].worker_details.display_name, manualPayload.display_name);
  assert.equal(manuallySaved[0].worker_details.date_of_birth.value, manualPayload.date_of_birth);
  assert.equal(manuallySaved[0].worker_details.gender.value, "FEMALE");
  assert.equal(manuallySaved[0].worker_details.address.state, "omitted");
  assert.equal(manuallySaved[0].worker_details.national_id_issued_at.value, manualPayload.national_id_issued_at);
  assert.equal(manuallySaved[0].worker_details.phone.state, "omitted");
  const { rows: manualAudit } = await db.query(
    "select action, changed_fields from public.direct_entry_audit_events where resource_ref = $1 and action = 'cccd_review_manual_update_worker_details'",
    [entryId],
  );
  assert.equal(manualAudit.length, 1);
  assert.ok(manualAudit[0].changed_fields.includes("address"));

  // 4. Test STANDARDIZE_FROM_QR on a second MISMATCH entry
  const created2 = await createBatchV2(
    ACTORS.owner,
    "worker-profile/1.2",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-04",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "Tên Nhập Tay Cũ",
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: "079095006644" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "ON" },
      },
    ],
    "11111111-1111-4111-8111-000000000007",
  );
  const entryId2 = created2.entry_ids[0];
  const front2 = await reserveAndFinalizeCccd(entryId2, 1, "CCCD_FRONT", "std-front");
  await db.query(
    "select public.direct_entry_prepare_cccd_qr_extraction($1::uuid, $2::uuid, $3::uuid, $4::uuid, null)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId2, front2.documentId],
  );
  await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, null, 'idem-std-qr') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId2,
      front2.documentId,
      JSON.stringify({
        ...QR_CANDIDATE_MATCH,
        national_id: "079095005566",
        display_name: "Tên Chuẩn Theo QR",
      }),
    ],
  );

  const standardized = await db.query(
    "select public.direct_entry_resolve_cccd_review($1::uuid, $2::uuid, $3::uuid, $4::integer, 'STANDARDIZE_FROM_QR', $5::jsonb, 'idem-std-resolve') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId2,
      front2.entryVersion,
      JSON.stringify({
        fields: ["national_id", "display_name", "date_of_birth", "gender", "address", "national_id_issued_at"],
        note: "Chuẩn hóa toàn bộ theo QR CCCD",
      }),
    ],
  );
  assert.equal(standardized.rows[0].data.reconciliation.status, "RESOLVED_FROM_QR");
  const { rows: afterStd } = await db.query(
    "select worker_details from public.direct_entries where entry_id = $1",
    [entryId2],
  );
  assert.equal(afterStd[0].worker_details.display_name, "Tên Chuẩn Theo QR");
  assert.equal(afterStd[0].worker_details.national_id.value, "079095005566");
  assert.equal(afterStd[0].worker_details.gender.value, "FEMALE");
});

test("PRE-W2-HF migration aligns owners and keeps direct_entry_create_full_profile_batch_with_portrait_stages idempotent on replay", async () => {
  assert.ok(
    migrations.migrationNames.includes("20261026210000_pre_w2_hf_form_save_owner_and_stage_alignment.sql"),
    "migration inventory includes 20261026210000_pre_w2_hf_form_save_owner_and_stage_alignment.sql",
  );

  const stageId = "e8000000-0000-4000-8000-000000000001";
  const stageCreateKey = "e9000000-0000-4000-8000-000000000001";
  const batchIdemKey = "ea000000-0000-4000-8000-000000000001";

  await db.query(
    "select public.direct_entry_create_worker_document_stage_idempotent(" +
      "$1::uuid, $2::uuid, $3::uuid, 'WORKER_PORTRAIT', 'image/jpeg', 512, $4, $5)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, stageId, "b".repeat(64), stageCreateKey],
  );
  await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid, $2::uuid, $3::uuid, $4::text)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, stageId, batchIdemKey],
  );

  const rowsPayload = [
    {
      project_id: projectId,
      first_work_date: "2026-04-04",
      recruiter_id: recruiterId,
      provider_type: "hrp",
      labor_type: "TEMPORARY",
      display_name: "",
      worker_details: {
        gender: { state: "provided", value: "MALE" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "provided", value: "079095007788" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      general_note: { state: "omitted" },
      payment: null,
      employment: { initial_status: "ON" },
    },
  ];

  const firstCall = await db.query(
    "select public.direct_entry_create_full_profile_batch_with_portrait_stages(" +
      "$1::uuid, $2::uuid, 'worker-profile/1.2', $3::jsonb, $4::text, $5::uuid[]) as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      JSON.stringify(rowsPayload),
      batchIdemKey,
      [stageId],
    ],
  );
  assert.equal(firstCall.rows[0].data.entry_ids.length, 1);
  assert.equal(firstCall.rows[0].data.replayed, false);

  const replayedCall = await db.query(
    "select public.direct_entry_create_full_profile_batch_with_portrait_stages(" +
      "$1::uuid, $2::uuid, 'worker-profile/1.2', $3::jsonb, $4::text, $5::uuid[]) as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      JSON.stringify(rowsPayload),
      batchIdemKey,
      [stageId],
    ],
  );
  assert.equal(replayedCall.rows[0].data.submission_id, firstCall.rows[0].data.submission_id);
  assert.equal(replayedCall.rows[0].data.replayed, true);
});

test("Hồ sơ thiếu & Lịch sử chỉnh sửa NLĐ: enforces Recruiter view-only, QLDA cross-creator upload in managed project, 3-Admin allowlist, and complete revision history without storage_key", async () => {
  assert.ok(
    migrations.migrationNames.includes("20261031120000_worker_edit_history_admin.sql"),
    "migration inventory includes 20261031120000_worker_edit_history_admin.sql",
  );

  // 1. Verify Forced RLS on direct_entry_worker_revision_snapshots and service_role-only RPC ACLs
  const { rows: snapMeta } = await db.query(
    `select c.relrowsecurity, c.relforcerowsecurity,
            (select count(*)::int from pg_catalog.pg_policy pol where pol.polrelid = c.oid) as policy_count
       from pg_catalog.pg_class c
      where c.oid = 'public.direct_entry_worker_revision_snapshots'::pg_catalog.regclass`,
  );
  assert.deepEqual(snapMeta[0], {
    relrowsecurity: true,
    relforcerowsecurity: true,
    policy_count: 0,
  });

  // 2. Seed actors:
  // - recruiterOnly: linked to RECRUITER_A, NOT a QLDA, has document_upload grant (to prove server still blocks Recruiter upload on non-created entry!)
  // - allowlistedAdmin: lienvu@hrpartner.vn with worker_edit_history_view + entry_admin + document_upload @ all
  // - nonAllowlistedAdmin: otheradmin@hrpartner.vn with full admin triple ONLY (no worker_edit_history_view)
  const recruiterOnly = {
    auth_subject: "11000000-0000-4000-8000-000000000091",
    app_user_id: "21000000-0000-4000-8000-000000000091",
  };
  const allowlistedAdmin = {
    auth_subject: "11000000-0000-4000-8000-000000000092",
    app_user_id: "21000000-0000-4000-8000-000000000092",
  };
  const nonAllowlistedAdmin = {
    auth_subject: "11000000-0000-4000-8000-000000000093",
    app_user_id: "21000000-0000-4000-8000-000000000093",
  };

  await db.query(
    "insert into auth.users(id, email) values ($1, 'recruiter.a@hrpartner.vn'), ($2, 'lienvu@hrpartner.vn'), ($3, 'otheradmin@hrpartner.vn')",
    [recruiterOnly.auth_subject, allowlistedAdmin.auth_subject, nonAllowlistedAdmin.auth_subject],
  );
  await db.query(
    "insert into public.direct_entry_app_users(app_user_id, auth_subject, enabled, display_name) values " +
      "($1, $2, true, 'Người Tuyển A'), ($3, $4, true, 'Liên Vũ'), ($5, $6, true, 'Admin Khác')",
    [
      recruiterOnly.app_user_id,
      recruiterOnly.auth_subject,
      allowlistedAdmin.app_user_id,
      allowlistedAdmin.auth_subject,
      nonAllowlistedAdmin.app_user_id,
      nonAllowlistedAdmin.auth_subject,
    ],
  );

  // Link recruiterOnly to RECRUITER_A
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links(app_user_id, recruiter_id, verified, valid_from, is_current) " +
      "values ($1, $2, true, '2020-01-01', true)",
    [recruiterOnly.app_user_id, recruiterId],
  );
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, is_current) " +
      "values ($1, 'entry_own', '2020-01-01', true), ($1, 'document_upload', '2020-01-01', true)",
    [recruiterOnly.app_user_id],
  );
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id, scope_kind, valid_from, is_current) " +
      "values ($1, 'own', '2020-01-01', true)",
    [recruiterOnly.app_user_id],
  );

  // Grant allowlistedAdmin full admin + worker_edit_history_view + document_upload @ all
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, is_current) values " +
      "($1, 'entry_admin', '2020-01-01', true), " +
      "($1, 'recruiter_master_manage', '2020-01-01', true), " +
      "($1, 'team_master_manage', '2020-01-01', true), " +
      "($1, 'worker_edit_history_view', '2020-01-01', true), " +
      "($1, 'document_upload', '2020-01-01', true)",
    [allowlistedAdmin.app_user_id],
  );
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id, scope_kind, valid_from, is_current) " +
      "values ($1, 'all', '2020-01-01', true)",
    [allowlistedAdmin.app_user_id],
  );

  const allowlistOnlyDirectEdit = await db.query(
    "select public.direct_entry_resolve_direct_edit_authority(" +
      "$1::uuid, $2::uuid, $3::uuid, null, $4::text, false, null) as authority",
    [allowlistedAdmin.auth_subject, allowlistedAdmin.app_user_id, recruiterId, projectId],
  );
  assert.equal(
    allowlistOnlyDirectEdit.rows[0].authority,
    null,
    "History allowlist must not grant general direct-edit authority",
  );
  const fullAdminDirectEdit = await db.query(
    "select public.direct_entry_resolve_direct_edit_authority(" +
      "$1::uuid, $2::uuid, $3::uuid, null, $4::text, true, null) as authority",
    [allowlistedAdmin.auth_subject, allowlistedAdmin.app_user_id, recruiterId, projectId],
  );
  assert.equal(fullAdminDirectEdit.rows[0].authority, "admin_all");

  // Grant nonAllowlistedAdmin full admin triple WITHOUT worker_edit_history_view (WP5B-2 Group A enforces paired worker_edit_history_view @ ALL)
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, is_current) values " +
      "($1, 'entry_admin', '2020-01-01', true), " +
      "($1, 'recruiter_master_manage', '2020-01-01', true), " +
      "($1, 'team_master_manage', '2020-01-01', true)",
    [nonAllowlistedAdmin.app_user_id],
  );
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id, scope_kind, valid_from, is_current) " +
      "values ($1, 'all', '2020-01-01', true)",
    [nonAllowlistedAdmin.app_user_id],
  );

  // 3. Create a worker in PROJECT_ID (managed by ACTORS.owner QLDA), entered by ACTORS.otherOwner (a DIFFERENT creator!), recruited by RECRUITER_A
  const crossCreatorBatch = await createBatchV2(
    ACTORS.otherOwner,
    "worker-profile/1.2",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-12",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "Phạm Thị Thiếu Hồ Sơ",
        worker_details: {
          gender: { state: "provided", value: "FEMALE" },
          date_of_birth: { state: "provided", value: "1998-05-20" },
          national_id: { state: "provided", value: "079098001234" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "provided", value: "Quận 7, TP.HCM" },
          phone: { state: "provided", value: "0912345678" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "UNCONFIRMED" },
      },
    ],
    "eb000000-0000-4000-8000-000000000001",
  );
  const targetEntryId = crossCreatorBatch.entry_ids[0];

  // 4. Recruiter (recruiterOnly):
  // - Sees the worker in Hồ sơ thiếu with scope_kind = 'recruited' and can_upload = false
  // - Cannot upload documents (server rejects with 42501)
  const recruiterMissingRes = await db.query(
    "select public.direct_entry_list_missing_document_workers($1::uuid, $2::uuid, 'ALL', $3::text, 'UNCONFIRMED', '079098001234', 1, 25) as data",
    [recruiterOnly.auth_subject, recruiterOnly.app_user_id, projectId],
  );
  const recruiterMissing = recruiterMissingRes.rows[0].data;
  assert.equal(recruiterMissing.scope_kind, "recruited");
  assert.equal(recruiterMissing.can_upload, false);
  assert.equal(recruiterMissing.items.length, 1);
  assert.equal(recruiterMissing.items[0].entry_id, targetEntryId);
  assert.equal(recruiterMissing.items[0].can_upload, false);
  assert.deepEqual(recruiterMissing.items[0].missing_documents, [
    "WORKER_PORTRAIT",
    "CCCD_FRONT",
    "CCCD_BACK",
    "EMPLOYMENT_CONTRACT",
  ]);

  await assert.rejects(
    db.query(
      "select public.direct_entry_reserve_document_direct_upload($1::uuid, $2::uuid, $3::uuid, 1, 'WORKER_PORTRAIT', 'recruiter-upload-attempt', 512, 'image/jpeg', 'Bổ sung hồ sơ còn thiếu từ màn Review thông tin NLĐ')",
      [recruiterOnly.auth_subject, recruiterOnly.app_user_id, targetEntryId],
    ),
    (err) => err.code === "42501",
    "Recruiter must be rejected by server when attempting to upload documents",
  );

  // 5. Other admins without (Recruiter, QLDA, worker_edit_history_view @ ALL) are rejected from Hồ sơ thiếu
  await assert.rejects(
    db.query(
      "select public.direct_entry_list_missing_document_workers($1::uuid, $2::uuid, 'ALL', null, 'ALL', null, 1, 25)",
      [nonAllowlistedAdmin.auth_subject, nonAllowlistedAdmin.app_user_id],
    ),
    (err) => err.code === "42501",
    "Admin without worker_edit_history_view / QLDA / recruiter link must be denied missing documents list",
  );

  // 6. QLDA (ACTORS.owner, assigned project manager of projectId):
  // - Sees the worker in Hồ sơ thiếu with scope_kind = 'project' and can_upload = true
  // - CAN upload all 4 document types even though the worker was entered by ACTORS.otherOwner!
  const qldaMissingBeforeRes = await db.query(
    "select public.direct_entry_list_missing_document_workers($1::uuid, $2::uuid, 'ALL', $3::text, 'UNCONFIRMED', '079098001234', 1, 25) as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, projectId],
  );
  const qldaMissingBefore = qldaMissingBeforeRes.rows[0].data;
  assert.equal(qldaMissingBefore.scope_kind, "project");
  assert.equal(qldaMissingBefore.can_upload, true);
  assert.equal(qldaMissingBefore.items.length, 1);
  assert.equal(qldaMissingBefore.items[0].entry_id, targetEntryId);
  assert.equal(qldaMissingBefore.items[0].can_upload, true);

  let currentVersion = qldaMissingBefore.items[0].entry_version;
  for (const [idx, docType] of [
    "WORKER_PORTRAIT",
    "CCCD_FRONT",
    "CCCD_BACK",
    "EMPLOYMENT_CONTRACT",
  ].entries()) {
    const up = await reserveAndFinalizeCccd(
      targetEntryId,
      currentVersion,
      docType,
      `qlda-supp-${idx}-${docType}`,
    );
    currentVersion = up.entryVersion;
  }

  // Once all 4 documents are uploaded and finalized, the worker disappears from Hồ sơ thiếu
  const qldaMissingAfterRes = await db.query(
    "select public.direct_entry_list_missing_document_workers($1::uuid, $2::uuid, 'ALL', $3::text, 'UNCONFIRMED', '079098001234', 1, 25) as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, projectId],
  );
  assert.equal(qldaMissingAfterRes.rows[0].data.items.length, 0);

  // 7. 3-Admin allowlist (allowlistedAdmin = lienvu@hrpartner.vn):
  // - Can view Hồ sơ thiếu with scope_kind = 'all' and can_upload = true
  const adminMissingRes = await db.query(
    "select public.direct_entry_list_missing_document_workers($1::uuid, $2::uuid, 'ALL', null, 'ALL', null, 1, 25) as data",
    [allowlistedAdmin.auth_subject, allowlistedAdmin.app_user_id],
  );
  assert.equal(adminMissingRes.rows[0].data.scope_kind, "all");
  assert.equal(adminMissingRes.rows[0].data.can_upload, true);

  // 8. Lịch sử chỉnh sửa NLĐ:
  // - Denied to nonAllowlistedAdmin, QLDA, and Recruiter
  for (const deniedActor of [nonAllowlistedAdmin, ACTORS.owner, recruiterOnly]) {
    await assert.rejects(
      db.query(
        "select public.worker_edit_history_search($1::uuid, $2::uuid, null, null, " +
          "(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 92, (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date, $3::text, $4::text, null, 50, null)",
        [deniedActor.auth_subject, deniedActor.app_user_id, projectId, recruiterId],
      ),
      (err) => err.code === "42501",
    );
  }

  // - Allowed to admin holding paired worker_edit_history_view @ ALL: returns NEW_ENTRY and DOCUMENT_CHANGE revisions
  const historySearchRes = await db.query(
    "select public.worker_edit_history_search($1::uuid, $2::uuid, null, null, " +
      "(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 92, (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date, $3::text, $4::text, null, 50, null) as data",
    [allowlistedAdmin.auth_subject, allowlistedAdmin.app_user_id, projectId, recruiterId],
  );
  const historySearch = historySearchRes.rows[0].data;
  const targetHistory = historySearch.rows.filter((row) => row.entry_id === targetEntryId);
  assert.ok(targetHistory.length >= 5, "Expected initial creation + 4 supplementary document revisions");
  assert.ok(targetHistory.some((r) => r.action_group === "NEW_ENTRY"));
  assert.ok(targetHistory.some((r) => r.action_group === "DOCUMENT_CHANGE"));
  assert.ok(targetHistory.every((r) => r.national_id === "079098001234"));
  assert.ok(targetHistory.every((r) => r.snapshot_state === "COMPLETE"));

  const latestRevisionId = historySearch.rows[0].revision_id;
  const historyDetailRes = await db.query(
    "select public.worker_edit_history_get_revision($1::uuid, $2::uuid, $3::uuid, $4::uuid) as data",
    [allowlistedAdmin.auth_subject, allowlistedAdmin.app_user_id, targetEntryId, latestRevisionId],
  );
  const historyDetail = historyDetailRes.rows[0].data;
  assert.equal(historyDetail.entry_id, targetEntryId);
  assert.equal(historyDetail.snapshot_state, "COMPLETE");
  assert.equal(historyDetail.after_snapshot.documents.length, 4);
  assert.equal(JSON.stringify(historyDetail).includes("storage_key"), false);

  const legacyRevision = await db.query(
    "insert into public.direct_entry_revisions(entry_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot, created_at) " +
      "select $1, 99, $2, r.reason_id, " +
      "jsonb_build_object('worker_details', jsonb_build_object(" +
      "'display_name', 'Phạm Thị Tên Cũ', 'national_id', jsonb_build_object('state', 'provided', 'value', '079098009876'))), " +
      "public.direct_entry_entry_snapshot($1), clock_timestamp() - interval '10 days' " +
      "from public.direct_entry_revisions r where r.entry_id = $1 order by r.version desc limit 1 " +
      "returning revision_id",
    [targetEntryId, allowlistedAdmin.app_user_id],
  );
  assert.equal(legacyRevision.rowCount, 1);
  const legacyHistory = await db.query(
    "select public.worker_edit_history_search($1::uuid, $2::uuid, null, null, " +
      "(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 92, (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date, $3::text, $4::text, null, 50, null) as data",
    [allowlistedAdmin.auth_subject, allowlistedAdmin.app_user_id, projectId, recruiterId],
  );
  assert.ok(
    legacyHistory.rows[0].data.rows.some(
      (row) => row.revision_id === legacyRevision.rows[0].revision_id && row.snapshot_state === "LEGACY_LIMITED",
    ),
    "Legacy revisions should remain searchable by their recorded before/after identity values",
  );
});

