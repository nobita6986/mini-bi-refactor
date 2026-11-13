import assert from "node:assert/strict";
import test from "node:test";

import {
  computeCreatePersonFingerprint,
  computeLinkAccountPersonFingerprint,
  computeSetAccountTypeFingerprint,
  computeTransferPersonDepartmentFingerprint,
  computeUnlinkAccountPersonFingerprint,
  computeUpdatePersonFingerprint,
  ORGANIZATION_ERROR_CODES,
  organizationErrorStatus,
  parseCreatePersonBody,
  parseGetPersonParams,
  parseLinkAccountPersonBody,
  parseListPersonsQuery,
  parseSetAccountTypeBody,
  parseTransferPersonDepartmentBody,
  parseUnlinkAccountPersonBody,
  parseUpdatePersonBody,
  projectGetPersonResponse,
  projectLinkAccountPersonResponse,
  projectListPersonsResponse,
  projectMutatePersonResponse,
  projectSetAccountTypeResponse,
  projectTransferPersonDepartmentResponse,
  projectUnlinkAccountPersonResponse,
} from "./person-contract.ts";
import {
  computeBackfillManifestFingerprint,
  validateBackfillManifest,
  WP3B_BACKFILL_SCHEMA_VERSION,
} from "../../../scripts/lib/wp3b-backfill-manifest.mjs";

const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
const DEPT_ID = "20000000-0000-4000-8000-000000000002";
const PERSON_ID = "30000000-0000-4000-8000-000000000003";
const ACCOUNT_ID = "40000000-0000-4000-8000-000000000004";
const RECRUITER_ID = "50000000-0000-4000-8000-000000000005";
const MEMBERSHIP_ID = "60000000-0000-4000-8000-000000000006";
const MEMBERSHIP_ID_2 = "60000000-0000-4000-8000-000000000007";
const LINK_ID = "70000000-0000-4000-8000-000000000008";
const HEAD_ID = "80000000-0000-4000-8000-000000000009";
const IDEMP_KEY = "90000000-0000-4000-8000-000000000010";
const IDEMP_KEY_2 = "90000000-0000-4000-8000-000000000011";

test("organization query parsers validate status, link_state, department_id, and ISO UTC as_of", () => {
  const validList = parseListPersonsQuery(
    new URL(
      `https://bi.local/api/admin/organization/persons?search=%20Nguyen%20&status=all&department_id=${DEPT_ID.toUpperCase()}&link_state=linked&as_of=2026-11-13T09:00:00%2B07:00&page=2&page_size=50`,
    ),
  );
  assert.equal(validList.ok, true);
  assert.deepEqual(validList.value, {
    search: "Nguyen",
    status: "all",
    department_id: DEPT_ID,
    link_state: "linked",
    as_of: "2026-11-13T02:00:00.000Z",
    page: 2,
    page_size: 50,
  });

  const validGet = parseGetPersonParams(
    PERSON_ID.toUpperCase(),
    new URL(`https://bi.local/api/admin/organization/persons/${PERSON_ID}?as_of=2026-11-13T09:00:00Z`),
  );
  assert.equal(validGet.ok, true);
  assert.deepEqual(validGet.value, {
    person_id: PERSON_ID,
    as_of: "2026-11-13T09:00:00.000Z",
  });

  // Calendar-only as_of rejected
  const badAsOf = parseListPersonsQuery(
    new URL("https://bi.local/api/admin/organization/persons?as_of=2026-11-13"),
  );
  assert.equal(badAsOf.ok, false);
  assert.equal(badAsOf.code, "ORG_VALIDATION_ERROR");

  // Unknown query params rejected
  const unknownParam = parseListPersonsQuery(
    new URL("https://bi.local/api/admin/organization/persons?foo=bar"),
  );
  assert.equal(unknownParam.ok, false);
  assert.equal(unknownParam.code, "ORG_VALIDATION_ERROR");

  // Authority & schedule fields rejected on query
  const forbiddenQuery = parseListPersonsQuery(
    new URL("https://bi.local/api/admin/organization/persons?started_at=2026-11-13T00:00:00Z"),
  );
  assert.equal(forbiddenQuery.ok, false);
  assert.equal(forbiddenQuery.code, "CLIENT_SCHEDULE_FIELD_FORBIDDEN");
});

test("organization mutation parsers enforce employee_code, idempotency, paired account fields, and block schedule/authority injection", () => {
  const createValid = parseCreatePersonBody(
    {
      employee_code: "TD-001",
      full_name: "Nguyễn Văn An",
      joined_on: "2026-01-15",
      initial_department_ref: DEPT_ID,
      account_ref: ACCOUNT_ID,
      expected_account_version: 2,
      recruiter_id: RECRUITER_ID,
      reason: "Tạo hồ sơ nhân sự mới",
      idempotency_key: IDEMP_KEY,
    },
    IDEMP_KEY,
  );
  assert.equal(createValid.ok, true);
  assert.equal(createValid.value.employee_code, "TD-001");
  assert.equal(createValid.value.expected_account_version, 2);

  // Synthetic hrp-YYYY-NNNNNN rejected (OD-WP3-03)
  const syntheticHrp = parseCreatePersonBody(
    {
      employee_code: "hrp-2026-000123",
      full_name: "Synthetic",
      reason: "Test",
      idempotency_key: IDEMP_KEY,
    },
    IDEMP_KEY,
  );
  assert.equal(syntheticHrp.ok, false);
  assert.equal(syntheticHrp.code, "ORG_VALIDATION_ERROR");

  // account_ref requires expected_account_version and vice versa
  assert.equal(
    parseCreatePersonBody(
      {
        employee_code: "TD-002",
        full_name: "Thiếu version",
        account_ref: ACCOUNT_ID,
        reason: "Test",
        idempotency_key: IDEMP_KEY,
      },
      IDEMP_KEY,
    ).code,
    "ORG_VALIDATION_ERROR",
  );
  assert.equal(
    parseCreatePersonBody(
      {
        employee_code: "TD-002",
        full_name: "Thừa version",
        expected_account_version: 1,
        reason: "Test",
        idempotency_key: IDEMP_KEY,
      },
      IDEMP_KEY,
    ).code,
    "ORG_VALIDATION_ERROR",
  );

  // Idempotency key invalid vs mismatch
  assert.equal(
    parseUpdatePersonBody(
      {
        expected_person_version: 1,
        employee_code: "TD-001",
        full_name: "Updated",
        joined_on: null,
        status: "ACTIVE",
        reason: "Update",
        idempotency_key: IDEMP_KEY,
      },
      "not-a-uuid",
    ).code,
    "IDEMPOTENCY_KEY_INVALID",
  );
  assert.equal(
    parseUpdatePersonBody(
      {
        expected_person_version: 1,
        employee_code: "TD-001",
        full_name: "Updated",
        joined_on: null,
        status: "ACTIVE",
        reason: "Update",
        idempotency_key: IDEMP_KEY,
      },
      IDEMP_KEY_2,
    ).code,
    "IDEMPOTENCY_KEY_MISMATCH",
  );

  // Client schedule & authority fields forbidden across mutations
  for (const field of ["started_at", "ended_at", "valid_from", "effective_from"]) {
    const res = parseTransferPersonDepartmentBody(
      {
        target_department_ref: DEPT_ID,
        expected_person_version: 1,
        expected_current_membership_id: MEMBERSHIP_ID,
        reason: "Transfer",
        idempotency_key: IDEMP_KEY,
        [field]: "2026-11-13T00:00:00Z",
      },
      IDEMP_KEY,
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "CLIENT_SCHEDULE_FIELD_FORBIDDEN");
  }

  for (const field of ["role", "capabilities", "app_user_id", "auth_subject"]) {
    const res = parseSetAccountTypeBody(
      {
        account_type: "SHARED",
        expected_account_version: 1,
        reason: "Classify",
        idempotency_key: IDEMP_KEY,
        [field]: "full_admin",
      },
      IDEMP_KEY,
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  // Link & unlink parsers
  assert.equal(
    parseLinkAccountPersonBody(
      {
        person_id: PERSON_ID,
        expected_account_version: 1,
        expected_person_version: 2,
        confirmed_recruiter_id: RECRUITER_ID,
        reason: "Link account",
        idempotency_key: IDEMP_KEY,
      },
      IDEMP_KEY,
    ).ok,
    true,
  );
  assert.equal(
    parseUnlinkAccountPersonBody(
      {
        expected_account_version: 2,
        expected_person_version: 3,
        expected_link_id: LINK_ID,
        reason: "Unlink account",
        idempotency_key: IDEMP_KEY,
      },
      IDEMP_KEY,
    ).ok,
    true,
  );
});

test("organization fingerprints isolate operation and target cleanly and error taxonomy maps statuses", () => {
  const createBody = parseCreatePersonBody(
    {
      employee_code: "TD-001",
      full_name: "Nguyễn Văn An",
      reason: "Create",
      idempotency_key: IDEMP_KEY,
    },
    IDEMP_KEY,
  ).value;
  const fCreate1 = computeCreatePersonFingerprint(ACTOR_ID, createBody);
  const fCreate2 = computeCreatePersonFingerprint(ACTOR_ID, {
    ...createBody,
    employee_code: "TD-002",
  });
  assert.notEqual(fCreate1, fCreate2);
  assert.equal(fCreate1, computeCreatePersonFingerprint(ACTOR_ID, createBody));

  const updBody = parseUpdatePersonBody(
    {
      expected_person_version: 1,
      employee_code: "TD-001",
      full_name: "Nguyễn Văn An",
      joined_on: null,
      status: "ACTIVE",
      reason: "Update",
      idempotency_key: IDEMP_KEY,
    },
    IDEMP_KEY,
  ).value;
  assert.notEqual(
    computeUpdatePersonFingerprint(ACTOR_ID, PERSON_ID, updBody),
    computeUpdatePersonFingerprint(ACTOR_ID, ACCOUNT_ID, updBody),
  );

  const transferBody = parseTransferPersonDepartmentBody(
    {
      target_department_ref: DEPT_ID,
      expected_person_version: 1,
      expected_current_membership_id: MEMBERSHIP_ID,
      reason: "Transfer",
      idempotency_key: IDEMP_KEY,
    },
    IDEMP_KEY,
  ).value;
  assert.equal(
    computeTransferPersonDepartmentFingerprint(ACTOR_ID, PERSON_ID, transferBody).length,
    64,
  );

  const typeBody = parseSetAccountTypeBody(
    {
      account_type: "SERVICE",
      expected_account_version: 1,
      reason: "Classify",
      idempotency_key: IDEMP_KEY,
    },
    IDEMP_KEY,
  ).value;
  assert.notEqual(
    computeSetAccountTypeFingerprint(ACTOR_ID, ACCOUNT_ID, typeBody),
    computeSetAccountTypeFingerprint(ACTOR_ID, PERSON_ID, typeBody),
  );

  const linkBody = parseLinkAccountPersonBody(
    {
      person_id: PERSON_ID,
      expected_account_version: 1,
      expected_person_version: 1,
      reason: "Link",
      idempotency_key: IDEMP_KEY,
    },
    IDEMP_KEY,
  ).value;
  const unlinkBody = parseUnlinkAccountPersonBody(
    {
      expected_account_version: 2,
      expected_person_version: 2,
      expected_link_id: LINK_ID,
      reason: "Unlink",
      idempotency_key: IDEMP_KEY,
    },
    IDEMP_KEY,
  ).value;
  assert.notEqual(
    computeLinkAccountPersonFingerprint(ACTOR_ID, ACCOUNT_ID, linkBody),
    computeUnlinkAccountPersonFingerprint(ACTOR_ID, ACCOUNT_ID, unlinkBody),
  );

  for (const code of ORGANIZATION_ERROR_CODES) {
    assert.ok(Number.isInteger(organizationErrorStatus(code)));
  }
  assert.equal(organizationErrorStatus("PERSON_IS_ACTIVE_DEPARTMENT_HEAD"), 409);
  assert.equal(organizationErrorStatus("IDEMPOTENCY_KEY_MISMATCH"), 400);
});

test("strict response projectors accept canonical WP3 shapes and fail closed on widened PII/extra keys", () => {
  const activeAccountLink = {
    link_id: LINK_ID,
    account_ref: ACCOUNT_ID,
    login_id: "an.nv",
    display_name: "Nguyễn Văn An",
    enabled: true,
    account_version: 2,
    started_at: "2026-11-13T02:00:00.000Z",
    source_kind: "ADMIN_MUTATION",
    evidence_date: null,
    version: 1,
  };
  const activeDepartment = {
    membership_id: MEMBERSHIP_ID,
    department_id: DEPT_ID,
    system_key: "RECRUITMENT",
    code: "RECRUITMENT",
    name: "Phòng Tuyển dụng",
    started_at: "2026-11-13T02:00:00.000Z",
    source_kind: "ADMIN_MUTATION",
    evidence_date: null,
    version: 1,
  };
  const summary = {
    person_id: PERSON_ID,
    employee_code: "TD-001",
    full_name: "Nguyễn Văn An",
    status: "ACTIVE",
    joined_on: "2026-01-15",
    recruiter_id: RECRUITER_ID,
    version: 2,
    active_account_link: activeAccountLink,
    active_department: activeDepartment,
  };
  const detail = {
    ...summary,
    department_history: [{ ...activeDepartment, ended_at: null }],
    head_assignments: [
      {
        head_assignment_id: HEAD_ID,
        department_id: DEPT_ID,
        system_key: "RECRUITMENT",
        code: "RECRUITMENT",
        name: "Phòng Tuyển dụng",
        started_at: "2026-11-13T03:00:00.000Z",
        ended_at: null,
        source_kind: "ADMIN_MUTATION",
        evidence_date: null,
        version: 1,
      },
    ],
  };

  assert.ok(
    projectListPersonsResponse({
      authorization_date: "2026-11-13",
      as_of: "2026-11-13T09:00:00.000Z",
      search: null,
      status: "active",
      department_id: null,
      link_state: "all",
      page: 1,
      page_size: 25,
      total: 1,
      has_more: false,
      persons: [summary],
    }),
  );
  assert.equal(
    projectListPersonsResponse({
      authorization_date: "2026-11-13",
      as_of: "2026-11-13T09:00:00.000Z",
      search: null,
      status: "active",
      department_id: null,
      link_state: "all",
      page: 1,
      page_size: 25,
      total: 1,
      has_more: false,
      persons: [{ ...summary, email: "leak@example.test" }],
    }),
    null,
  );

  assert.ok(
    projectGetPersonResponse({
      authorization_date: "2026-11-13",
      as_of: "2026-11-13T09:00:00.000Z",
      person: detail,
    }),
  );
  assert.ok(projectMutatePersonResponse({ replayed: false, person: detail }));
  assert.ok(
    projectTransferPersonDepartmentResponse({
      replayed: false,
      person_version: 3,
      closed_membership: {
        membership_id: MEMBERSHIP_ID,
        department_id: DEPT_ID,
        started_at: "2026-11-13T02:00:00.000Z",
        ended_at: "2026-11-13T04:00:00.000Z",
        version: 2,
      },
      active_membership: {
        ...activeDepartment,
        membership_id: MEMBERSHIP_ID_2,
        started_at: "2026-11-13T04:00:00.000Z",
        ended_at: null,
      },
    }),
  );
  assert.ok(
    projectSetAccountTypeResponse({
      replayed: false,
      account: { account_ref: ACCOUNT_ID, account_type: "SHARED", version: 2 },
    }),
  );
  assert.ok(
    projectLinkAccountPersonResponse({
      replayed: false,
      account_version: 2,
      person_version: 2,
      link: {
        link_id: LINK_ID,
        account_ref: ACCOUNT_ID,
        person_id: PERSON_ID,
        employee_code: "TD-001",
        full_name: "Nguyễn Văn An",
        started_at: "2026-11-13T02:00:00.000Z",
        source_kind: "ADMIN_MUTATION",
        evidence_date: null,
        version: 1,
      },
    }),
  );
  assert.ok(
    projectUnlinkAccountPersonResponse({
      replayed: false,
      account_version: 3,
      person_version: 3,
      ended_link: {
        link_id: LINK_ID,
        account_ref: ACCOUNT_ID,
        person_id: PERSON_ID,
        started_at: "2026-11-13T02:00:00.000Z",
        ended_at: "2026-11-13T05:00:00.000Z",
        version: 2,
      },
    }),
  );
});

test("WP3B backfill manifest validator enforces fingerprints, OD-WP3-03/04 rules, and evidence invariants", () => {
  const baseManifest = {
    schema_version: WP3B_BACKFILL_SCHEMA_VERSION,
    approved_by: "Owner",
    approved_at: "2026-11-13T10:00:00+07:00",
    actor_app_user_id: ACTOR_ID,
    reason: "Backfill chuẩn hóa nhân sự đợt 1",
    account_classifications: [
      {
        account_ref: ACCOUNT_ID,
        account_type: "NORMAL",
        evidence_note: "Xác nhận tài khoản cá nhân",
      },
    ],
    persons: [
      {
        employee_code: "KT-001",
        full_name: "Trần Thị Kế Toán",
        status: "ACTIVE",
        joined_on: "2025-03-01",
        recruiter_id: null,
        account_ref: ACCOUNT_ID,
        link_source_kind: "BACKFILL_DATE_EVIDENCE",
        link_evidence_date: "2025-03-01",
        department_membership: {
          department_code: "ACCOUNTING",
          source_kind: "BACKFILL_DATE_EVIDENCE",
          evidence_date: "2025-03-01",
        },
      },
    ],
    department_heads: [
      {
        department_code: "ACCOUNTING",
        employee_code: "KT-001",
        source_kind: "BACKFILL_CURRENT_STATE_ONLY",
        evidence_date: null,
      },
    ],
    quarantined_exceptions: [],
  };

  const valid = validateBackfillManifest(baseManifest);
  assert.equal(valid.ok, true);
  assert.equal(valid.manifest_fingerprint, computeBackfillManifestFingerprint(baseManifest));

  // Matching explicit fingerprint succeeds
  assert.equal(
    validateBackfillManifest({
      ...baseManifest,
      manifest_fingerprint: valid.manifest_fingerprint,
    }).ok,
    true,
  );

  // Tampered fingerprint fails
  assert.equal(
    validateBackfillManifest({
      ...baseManifest,
      manifest_fingerprint: "0".repeat(64),
    }).ok,
    false,
  );

  // Synthetic hrp code rejected
  const badHrp = structuredClone(baseManifest);
  badHrp.persons[0].employee_code = "hrp-2026-000001";
  badHrp.department_heads = [];
  assert.equal(validateBackfillManifest(badHrp).ok, false);

  // BACKFILL_DATE_EVIDENCE without evidence_date rejected
  const missingDate = structuredClone(baseManifest);
  missingDate.persons[0].department_membership.evidence_date = null;
  assert.equal(validateBackfillManifest(missingDate).ok, false);

  // BACKFILL_CURRENT_STATE_ONLY with evidence_date rejected
  const extraDate = structuredClone(baseManifest);
  extraDate.department_heads[0].evidence_date = "2026-11-13";
  assert.equal(validateBackfillManifest(extraDate).ok, false);

  // INACTIVE person cannot be designated HEAD
  const inactiveHead = structuredClone(baseManifest);
  inactiveHead.persons[0].status = "INACTIVE";
  assert.equal(validateBackfillManifest(inactiveHead).ok, false);
});
