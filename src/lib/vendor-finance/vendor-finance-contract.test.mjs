import assert from "node:assert/strict";
import test from "node:test";

import {
  PG_BIGINT_MAX,
  PG_BIGINT_MIN,
  VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
  checkForbiddenVendorFinanceClientFields,
  computeApplyOpeningBatchFingerprint,
  computeApplySharedAdvanceOffsetFingerprint,
  computeClassifySubLedgerFingerprint,
  computeFundSharedAdvanceFingerprint,
  computeRecordEntryFingerprint,
  computeRecordPaymentWithOffsetFingerprint,
  computeRecordVendorRefundFingerprint,
  computeReverseSharedAdvanceMovementFingerprint,
  decodeSharedAdvanceMovementsCursor,
  decodeVendorEntriesCursor,
  encodeSharedAdvanceMovementsCursor,
  encodeVendorEntriesCursor,
  parseApplyOpeningBatchBody,
  parseApplySharedAdvanceOffsetBody,
  parseAssignGlobalRoleBody,
  parseAssignProjectAccountantBody,
  parseClassifyVendorSubLedgerBody,
  parseCreateVendorReconciliationBody,
  parseEndGlobalRoleBody,
  parseEndProjectAccountantBody,
  parseExportVendorFinanceVendorsBody,
  parseExportVendorFinanceVendorsQuery,
  parseFinalizeVendorFinanceEvidenceBody,
  parseFundSharedAdvanceBody,
  parseListSharedAdvanceMovementsQuery,
  parseListVendorFinanceEntriesQuery,
  parseListVendorFinanceVendorsQuery,
  parseMonthlyReportQuery,
  parseNonNegativeMinorAmount,
  parsePositiveMinorAmount,
  parsePreviewOpeningBatchBody,
  parseRecordPaymentWithOffsetBody,
  parseRecordVendorFinanceEntryBody,
  parseRecordVendorRefundBody,
  parseReserveVendorFinanceEvidenceBody,
  parseReverseSharedAdvanceMovementBody,
  parseReverseVendorFinanceEntryBody,
  parseSignedMinorAmount,
  projectApplySharedAdvanceOffsetMutation,
  projectClassifySubLedgerMutation,
  projectFundSharedAdvanceMutation,
  projectMonthlyReport,
  projectOpeningApplyMutation,
  projectRecordPaymentWithOffsetMutation,
  projectReverseSharedAdvanceMovementMutation,
  projectSharedAdvanceMovement,
  projectVendorFinanceEntry,
  projectVendorFinanceVendorDetail,
  projectVendorFinanceVendorExport,
  projectVendorReconciliation,
  vendorFinanceHttpStatusForError,
} from "./vendor-finance-contract.ts";

const IDEM_1 = "11111111-1111-4111-8111-111111111111";
const ENTRY_ID = "22222222-2222-4222-8222-222222222222";
const BATCH_ID = "33333333-3333-4333-8333-333333333333";
const REC_ID = "44444444-4444-4444-8444-444444444444";
const ACC_A = "55555555-5555-4555-8555-555555555555";
const SHA_OK = "a".repeat(64);

function makeCanonicalEntry(overrides = {}) {
  return {
    entry_id: ENTRY_ID,
    vendor_id: "VND_ALPHA",
    vendor_display_name_snapshot: "Công ty TNHH Alpha",
    vendor_active: true,
    ledger_scope: "PROJECT_ACCOUNTANT",
    project_id: "PRJ_NORTH",
    project_display_name_snapshot: "Dự án Miền Bắc",
    accountant_ref: ACC_A,
    responsible_accountant_display_name: "Trần Thị Kế Toán A",
    contract_type: "SEASONAL",
    vendor_sequence: 1,
    cursor_sequence: 1,
    document_no: "VFIN-2026-000001",
    document_kind: "PAYROLL_VOUCHER",
    document_title_vi: "Phiếu ghi nhận lương nhà cung cấp",
    entry_type: "PAYROLL_RECORDED",
    amount_minor: "9007199254740993",
    balance_before_minor: "0",
    balance_delta_minor: "9007199254740993",
    balance_after_minor: "9007199254740993",
    effective_date: "2026-10-24",
    reason: "Chốt bảng lương kỳ 10/2026",
    opening_batch_id: null,
    reverses_entry_id: null,
    reverses_document_no: null,
    reversed_by_entry_id: null,
    reversed_by_document_no: null,
    can_reverse: true,
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Trần Thị Kế Toán A",
    created_at: "2026-10-24T02:00:00.000Z",
    internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
    ...overrides,
  };
}

test("money parsers accept lossless decimal strings above MAX_SAFE_INTEGER and up to int8 bounds", () => {
  const aboveSafe = parsePositiveMinorAmount("9007199254740993");
  assert.equal(aboveSafe.ok, true);
  assert.equal(aboveSafe.canonical, "9007199254740993");
  assert.equal(aboveSafe.value, BigInt("9007199254740993"));

  const maxPos = parsePositiveMinorAmount(PG_BIGINT_MAX.toString());
  assert.equal(maxPos.ok, true);
  assert.equal(maxPos.value, PG_BIGINT_MAX);

  const zeroNonNeg = parseNonNegativeMinorAmount("0");
  assert.equal(zeroNonNeg.ok, true);
  assert.equal(zeroNonNeg.canonical, "0");

  const minSigned = parseSignedMinorAmount(PG_BIGINT_MIN.toString());
  assert.equal(minSigned.ok, true);
  assert.equal(minSigned.value, PG_BIGINT_MIN);
});

test("money parsers reject floats, numbers, zero/negatives, leading zeros, scientific notation, and int8 overflow", () => {
  for (const bad of [0, 100, 12.5, "0", "-1", "-0", "+100", "0100", "100.5", "1e6", " 100 ", ""]) {
    const res = parsePositiveMinorAmount(bad);
    assert.equal(res.ok, false, `expected rejection for ${String(bad)}`);
    assert.equal(res.code, "VENDOR_FINANCE_AMOUNT_INVALID");
  }

  const posOverflow = parsePositiveMinorAmount("9223372036854775808");
  assert.deepEqual(posOverflow, { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" });

  const hugeOverflow = parsePositiveMinorAmount("100000000000000000000");
  assert.deepEqual(hugeOverflow, { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" });

  const negSignedZero = parseSignedMinorAmount("-0");
  assert.deepEqual(negSignedZero, { ok: false, code: "VENDOR_FINANCE_AMOUNT_INVALID" });

  const negOverflow = parseSignedMinorAmount("-9223372036854775809");
  assert.deepEqual(negOverflow, { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" });
});

test("checkForbiddenVendorFinanceClientFields rejects client authority & server-computed ledger fields at any depth", () => {
  const forbiddenPayloads = [
    { app_user_id: IDEM_1 },
    { auth_subject: IDEM_1 },
    { capabilities: ["vendor_finance_record"] },
    { scopes: [{ kind: "all" }] },
    { balance_delta_minor: "-500000" },
    { balance_before_minor: "0" },
    { balance_after_minor: "500000" },
    { document_no: "VFIN-2026-999999" },
    { vendor_sequence: 9 },
    { vendor_display_name_snapshot: "Spoofed Name" },
    { responsible_accountant_user_id: ACC_A },
    { system_balance_minor: "0" },
    { difference_minor: "0" },
    { authority_source: "full_admin" },
    { storage_key: "vfin-01/entry/a/b" },
    {
      items: [
        {
          vendor_id: "VND_1",
          entry_type: "OPENING_PAYABLE",
          amount_minor: "100",
          balanceAfterMinor: "100",
        },
      ],
    },
  ];

  for (const payload of forbiddenPayloads) {
    assert.deepEqual(checkForbiddenVendorFinanceClientFields(payload), {
      ok: false,
      code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
    });
  }
});

test("parseRecordVendorFinanceEntryBody enforces project_id, contract_type (SEASONAL|OFFICIAL), normal entry enum, positive integer strings, real date, reason & idempotency match", () => {
  const ok = parseRecordVendorFinanceEntryBody(
    {
      project_id: "PRJ_NORTH",
      contract_type: "SEASONAL",
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "25000000",
      effective_date: "2026-10-24",
      reason: "  Thanh toán đợt 1  ",
      idempotency_key: IDEM_1.toUpperCase(),
    },
    IDEM_1,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.value.project_id, "PRJ_NORTH");
  assert.equal(ok.value.contract_type, "SEASONAL");
  assert.equal(ok.value.reason, "Thanh toán đợt 1");
  assert.equal(ok.value.idempotency_key, IDEM_1);

  // Missing project_id -> rejected
  const missingProject = parseRecordVendorFinanceEntryBody(
    {
      contract_type: "OFFICIAL",
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "25000000",
      effective_date: "2026-10-24",
      reason: "Thanh toán đợt 1",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.deepEqual(missingProject, { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" });

  // Missing or UNCLASSIFIED contract_type on new entry -> rejected
  const unclass = parseRecordVendorFinanceEntryBody(
    {
      project_id: "PRJ_NORTH",
      contract_type: "UNCLASSIFIED",
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "25000000",
      effective_date: "2026-10-24",
      reason: "Thanh toán đợt 1",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.deepEqual(unclass, { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" });

  // OPENING_* and REVERSAL cannot be submitted to normal record endpoint
  for (const forbiddenType of ["OPENING_PAYABLE", "OPENING_ADVANCE", "REVERSAL"]) {
    const res = parseRecordVendorFinanceEntryBody(
      {
        project_id: "PRJ_NORTH",
        contract_type: "OFFICIAL",
        entry_type: forbiddenType,
        amount_minor: "1000",
        effective_date: "2026-10-24",
        reason: "test",
        idempotency_key: IDEM_1,
      },
      null,
    );
    assert.deepEqual(res, { ok: false, code: "VENDOR_FINANCE_ENTRY_TYPE_INVALID" });
  }

  // Impossible calendar date
  const badDate = parseRecordVendorFinanceEntryBody(
    {
      project_id: "PRJ_NORTH",
      contract_type: "SEASONAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "1000",
      effective_date: "2026-02-30",
      reason: "test",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.deepEqual(badDate, { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" });

  // Mismatched Idempotency-Key header vs body
  const mismatch = parseRecordVendorFinanceEntryBody(
    {
      project_id: "PRJ_NORTH",
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "1000",
      effective_date: "2026-10-24",
      reason: "test",
      idempotency_key: IDEM_1,
    },
    ENTRY_ID,
  );
  assert.deepEqual(mismatch, { ok: false, code: "IDEMPOTENCY_KEY_MISMATCH" });
});

test("opening batch parsers require project_id & contract_type (SEASONAL|OFFICIAL), skip zero-amount rows in fingerprint, reject duplicate vendors, negative amounts, __system_vendor__, and all-zero batches", () => {
  const previewOk = parsePreviewOpeningBatchBody({
    project_id: "PRJ_NORTH",
    contract_type: "SEASONAL",
    cutoff_date: "2026-10-01",
    items: [
      { vendor_id: "VND_1", entry_type: "OPENING_PAYABLE", amount_minor: "1500000" },
      { vendor_id: "VND_2", entry_type: "OPENING_ADVANCE", amount_minor: "0" },
    ],
  });
  assert.equal(previewOk.ok, true);
  assert.equal(previewOk.value.project_id, "PRJ_NORTH");
  assert.equal(previewOk.value.contract_type, "SEASONAL");

  // Duplicate vendor_id
  const dup = parsePreviewOpeningBatchBody({
    project_id: "PRJ_NORTH",
    contract_type: "OFFICIAL",
    cutoff_date: "2026-10-01",
    items: [
      { vendor_id: "VND_1", entry_type: "OPENING_PAYABLE", amount_minor: "100" },
      { vendor_id: "VND_1", entry_type: "OPENING_ADVANCE", amount_minor: "200" },
    ],
  });
  assert.deepEqual(dup, { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR" });

  // Reserved __system_vendor__
  const sysVendor = parsePreviewOpeningBatchBody({
    project_id: "PRJ_NORTH",
    contract_type: "SEASONAL",
    cutoff_date: "2026-10-01",
    items: [{ vendor_id: "__system_vendor__", entry_type: "OPENING_PAYABLE", amount_minor: "100" }],
  });
  assert.deepEqual(sysVendor, { ok: false, code: "VENDOR_FINANCE_VENDOR_INVALID" });

  // All zero rows -> VENDOR_FINANCE_OPENING_BATCH_EMPTY
  const allZero = parseApplyOpeningBatchBody(
    {
      project_id: "PRJ_NORTH",
      contract_type: "SEASONAL",
      cutoff_date: "2026-10-01",
      items: [{ vendor_id: "VND_1", entry_type: "OPENING_PAYABLE", amount_minor: "0" }],
      reason: "Khởi tạo",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.deepEqual(allZero, { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_EMPTY" });

  // Deterministic fingerprint invariant to item order and zero-amount rows, bound to project_id and contract_type
  const fpA = computeApplyOpeningBatchFingerprint({
    project_id: "PRJ_NORTH",
    contract_type: "SEASONAL",
    cutoff_date: "2026-10-01",
    items: [
      { vendor_id: "VND_B", entry_type: "OPENING_ADVANCE", amount_minor: "500" },
      { vendor_id: "VND_Z", entry_type: "OPENING_PAYABLE", amount_minor: "0" },
      { vendor_id: "VND_A", entry_type: "OPENING_PAYABLE", amount_minor: "1000" },
    ],
    reason: "Cutover",
  });
  const fpB = computeApplyOpeningBatchFingerprint({
    project_id: "PRJ_NORTH",
    contract_type: "SEASONAL",
    cutoff_date: "2026-10-01",
    items: [
      { vendor_id: "VND_A", entry_type: "OPENING_PAYABLE", amount_minor: "1000" },
      { vendor_id: "VND_B", entry_type: "OPENING_ADVANCE", amount_minor: "500" },
    ],
    reason: "Cutover",
  });
  const fpOtherProject = computeApplyOpeningBatchFingerprint({
    project_id: "PRJ_SOUTH",
    contract_type: "SEASONAL",
    cutoff_date: "2026-10-01",
    items: [
      { vendor_id: "VND_A", entry_type: "OPENING_PAYABLE", amount_minor: "1000" },
      { vendor_id: "VND_B", entry_type: "OPENING_ADVANCE", amount_minor: "500" },
    ],
    reason: "Cutover",
  });
  const fpOtherContract = computeApplyOpeningBatchFingerprint({
    project_id: "PRJ_NORTH",
    contract_type: "OFFICIAL",
    cutoff_date: "2026-10-01",
    items: [
      { vendor_id: "VND_A", entry_type: "OPENING_PAYABLE", amount_minor: "1000" },
      { vendor_id: "VND_B", entry_type: "OPENING_ADVANCE", amount_minor: "500" },
    ],
    reason: "Cutover",
  });
  assert.equal(fpA, fpB);
  assert.notEqual(fpA, fpOtherProject);
  assert.notEqual(fpA, fpOtherContract);

  const recFpA = computeRecordEntryFingerprint({
    project_id: "PRJ_NORTH",
    contract_type: "SEASONAL",
    vendor_id: "VND_A",
    entry_type: "DEBT_RECORDED",
    amount_minor: "1000",
    effective_date: "2026-10-24",
    reason: "Test",
  });
  const recFpB = computeRecordEntryFingerprint({
    project_id: "PRJ_SOUTH",
    contract_type: "SEASONAL",
    vendor_id: "VND_A",
    entry_type: "DEBT_RECORDED",
    amount_minor: "1000",
    effective_date: "2026-10-24",
    reason: "Test",
  });
  const recFpC = computeRecordEntryFingerprint({
    project_id: "PRJ_NORTH",
    contract_type: "OFFICIAL",
    vendor_id: "VND_A",
    entry_type: "DEBT_RECORDED",
    amount_minor: "1000",
    effective_date: "2026-10-24",
    reason: "Test",
  });
  assert.notEqual(recFpA, recFpB);
  assert.notEqual(recFpA, recFpC);
});

test("reconciliation, reverse, sub-ledger classification, admin governance, and evidence parsers validate project/accountant/contract_type bindings, OCC versions, and MIME/size/hash bounds", () => {
  const recNeg = parseCreateVendorReconciliationBody(
    {
      project_id: "PRJ_NORTH",
      accountant_ref: ACC_A.toUpperCase(),
      contract_type: "OFFICIAL",
      as_of_date: "2026-10-24",
      confirmed_balance_minor: "-3500000",
      reason: "NCC xác nhận còn dư ứng 3.5M",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.equal(recNeg.ok, true);
  assert.equal(recNeg.value.project_id, "PRJ_NORTH");
  assert.equal(recNeg.value.accountant_ref, ACC_A);
  assert.equal(recNeg.value.contract_type, "OFFICIAL");
  assert.equal(recNeg.value.confirmed_balance_minor, "-3500000");

  // Explicit legacy sub-ledger classification parser (UNCLASSIFIED -> SEASONAL | OFFICIAL)
  const classifyOk = parseClassifyVendorSubLedgerBody(
    {
      project_id: "PRJ_NORTH",
      accountant_ref: ACC_A,
      target_contract_type: "SEASONAL",
      reason: "Xác nhận chứng từ hợp đồng thời vụ T09/2026",
      idempotency_key: IDEM_1,
    },
    IDEM_1,
  );
  assert.equal(classifyOk.ok, true);
  assert.equal(classifyOk.value.target_contract_type, "SEASONAL");
  assert.equal(
    computeClassifySubLedgerFingerprint({
      vendor_id: "VND_ALPHA",
      project_id: "PRJ_NORTH",
      accountant_ref: ACC_A,
      target_contract_type: "SEASONAL",
      reason: "Xác nhận chứng từ hợp đồng thời vụ T09/2026",
    }).length,
    64,
  );
  assert.deepEqual(
    parseClassifyVendorSubLedgerBody(
      {
        project_id: "PRJ_NORTH",
        accountant_ref: ACC_A,
        target_contract_type: "UNCLASSIFIED",
        reason: "Không hợp lệ",
        idempotency_key: IDEM_1,
      },
      null,
    ),
    { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" },
  );

  // Reverse body never accepts contract_type (inherits from original entry)
  assert.deepEqual(
    parseReverseVendorFinanceEntryBody(
      {
        contract_type: "OFFICIAL",
        reason: "Nhập nhầm NCC",
        idempotency_key: IDEM_1,
      },
      null,
    ),
    { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" },
  );

  const revDefaultDate = parseReverseVendorFinanceEntryBody(
    {
      reason: "Nhập nhầm NCC",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.equal(revDefaultDate.ok, true);
  assert.equal(revDefaultDate.value.effective_date, null);

  // Admin parsers: project accountant assign/end, project-vendor link, global role assign/end
  const todayVn = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date());
  const assignPa = parseAssignProjectAccountantBody(
    {
      project_id: "PRJ_NORTH",
      accountant_ref: ACC_A,
      valid_from: todayVn,
      expected_version: 0,
      reason: "Phân công ban đầu",
      idempotency_key: IDEM_1,
    },
    IDEM_1,
  );
  assert.equal(assignPa.ok, true);

  const endPa = parseEndProjectAccountantBody(
    {
      expected_version: 1,
      valid_to: todayVn,
      reason: "Bàn giao cuối tháng",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.equal(endPa.ok, true);

  const assignGr = parseAssignGlobalRoleBody(
    {
      account_ref: ACC_A,
      role_code: "GLOBAL_RECONCILER",
      valid_from: null,
      expected_version: 0,
      reason: "BoD đối soát toàn cục",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.equal(assignGr.ok, true);

  const endGrZeroRejected = parseEndGlobalRoleBody(
    {
      expected_version: 0,
      valid_to: null,
      reason: "Thu hồi",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.deepEqual(endGrZeroRejected, { ok: false, code: "VENDOR_FINANCE_GLOBAL_ROLE_INVALID" });

  const evOk = parseReserveVendorFinanceEvidenceBody(
    {
      target_kind: "ENTRY",
      target_id: ENTRY_ID,
      mime_type: "image/png",
      size_bytes: 1024,
      checksum_sha256: SHA_OK.toUpperCase(),
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.equal(evOk.ok, true);
  assert.equal(evOk.value.checksum_sha256, SHA_OK);

  const evPdfRejected = parseReserveVendorFinanceEvidenceBody(
    {
      target_kind: "ENTRY",
      target_id: ENTRY_ID,
      mime_type: "application/pdf",
      size_bytes: 1024,
      checksum_sha256: SHA_OK,
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.deepEqual(evPdfRejected, { ok: false, code: "VENDOR_FINANCE_EVIDENCE_MIME_INVALID" });

  assert.deepEqual(parseFinalizeVendorFinanceEvidenceBody({}), { ok: true });
  assert.deepEqual(parseFinalizeVendorFinanceEvidenceBody({ extra: 1 }), {
    ok: false,
    code: "VENDOR_FINANCE_PAYLOAD_INVALID",
  });
});

test("v3 keyset cursor & monthly report query parsers bind scope (vendor, project, accountant, contract_type, month) and reject cross-subledger replay", () => {
  const cursor = encodeVendorEntriesCursor({
    vendor_id: "VND_ALPHA",
    before_sequence: 42,
    project_id: "PRJ_NORTH",
    accountant_ref: ACC_A,
    ledger_scope: "PROJECT_ACCOUNTANT",
    contract_type: "SEASONAL",
    month: "2026-10",
  });
  assert.deepEqual(
    decodeVendorEntriesCursor(cursor, "VND_ALPHA", {
      project_id: "PRJ_NORTH",
      accountant_ref: ACC_A,
      ledger_scope: "PROJECT_ACCOUNTANT",
      contract_type: "SEASONAL",
      month: "2026-10",
    }),
    { ok: true, before_sequence: 42 },
  );
  // Cross-project, cross-accountant, or cross-contract-type cursor replay -> rejected!
  assert.deepEqual(
    decodeVendorEntriesCursor(cursor, "VND_ALPHA", {
      project_id: "PRJ_SOUTH",
      accountant_ref: ACC_A,
      ledger_scope: "PROJECT_ACCOUNTANT",
      contract_type: "SEASONAL",
      month: "2026-10",
    }),
    { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" },
  );
  assert.deepEqual(
    decodeVendorEntriesCursor(cursor, "VND_ALPHA", {
      project_id: "PRJ_NORTH",
      accountant_ref: ACC_A,
      ledger_scope: "PROJECT_ACCOUNTANT",
      contract_type: "OFFICIAL",
      month: "2026-10",
    }),
    { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" },
  );
  assert.deepEqual(decodeVendorEntriesCursor(cursor, "VND_OTHER"), {
    ok: false,
    code: "VENDOR_FINANCE_CURSOR_INVALID",
  });

  const entriesUrl = new URL(
    `https://bi.local/api/vendor-finance/vendors/VND_ALPHA/entries?cursor=${cursor}&project_id=PRJ_NORTH&accountant_ref=${ACC_A}&ledger_scope=PROJECT_ACCOUNTANT&contract_type=SEASONAL&month=2026-10&entry_type=PAYROLL_RECORDED&page_size=20`,
  );
  const parsedEntries = parseListVendorFinanceEntriesQuery(entriesUrl, "VND_ALPHA");
  assert.equal(parsedEntries.ok, true);
  assert.equal(parsedEntries.value.before_sequence, 42);
  assert.equal(parsedEntries.value.project_id, "PRJ_NORTH");
  assert.equal(parsedEntries.value.contract_type, "SEASONAL");
  assert.equal(parsedEntries.value.month, "2026-10");

  const monthlyUrl = new URL(
    `https://bi.local/api/vendor-finance/reports/monthly?month=2026-10&project_id=PRJ_NORTH&accountant_ref=${ACC_A}&contract_type=OFFICIAL`,
  );
  const parsedMonthly = parseMonthlyReportQuery(monthlyUrl);
  assert.equal(parsedMonthly.ok, true);
  assert.equal(parsedMonthly.value.month, "2026-10");
  assert.equal(parsedMonthly.value.contract_type, "OFFICIAL");

  const dupParamUrl = new URL("https://bi.local/api/vendor-finance/vendors?page=1&page=2");
  assert.deepEqual(parseListVendorFinanceVendorsQuery(dupParamUrl), {
    ok: false,
    code: "VENDOR_FINANCE_QUERY_INVALID",
  });
});

test("response projectors are strictly fail-closed on arithmetic mismatch, fake project revenue, extra PII/storage_key fields, or tampered disclaimer", () => {
  const validEntry = makeCanonicalEntry();
  assert.ok(projectVendorFinanceEntry(validEntry));

  // Arithmetic chain tamper: before + delta !== after -> fail closed (null)
  assert.equal(
    projectVendorFinanceEntry(makeCanonicalEntry({ balance_after_minor: "999" })),
    null,
  );

  // Leaked PII or storage_key -> fail closed (null)
  assert.equal(
    projectVendorFinanceEntry({ ...validEntry, app_user_id: IDEM_1 }),
    null,
  );

  // Tampered internal disclaimer -> fail closed (null)
  assert.equal(
    projectVendorFinanceEntry(makeCanonicalEntry({ internal_disclaimer: "Fake bank receipt" })),
    null,
  );

  // Reconciliation difference arithmetic check: confirmed - system === difference
  const validRec = {
    reconciliation_id: REC_ID,
    vendor_id: "VND_ALPHA",
    ledger_scope: "PROJECT_ACCOUNTANT",
    project_id: "PRJ_NORTH",
    project_display_name_snapshot: "Dự án Miền Bắc",
    accountant_ref: ACC_A,
    responsible_accountant_display_name: "Trần Thị Kế Toán A",
    contract_type: "SEASONAL",
    as_of_date: "2026-10-24",
    system_balance_minor: "1000000",
    confirmed_balance_minor: "850000",
    difference_minor: "-150000",
    ledger_sequence_at_reconciliation: 4,
    reason: "Đối soát tháng 10",
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Trần Thị Kế Toán A",
    created_at: "2026-10-24T02:00:00.000Z",
  };
  assert.ok(projectVendorReconciliation(validRec));
  assert.equal(
    projectVendorReconciliation({ ...validRec, difference_minor: "150000" }),
    null,
  );

  // Vendor detail projection preserves MULTI_LEDGER non-netted sub-ledgers & allowed_entry_types
  const detail = projectVendorFinanceVendorDetail({
    authorization_date: "2026-10-24",
    allowed_actions: {
      visibility_scope: "ALL",
      can_view: true,
      can_record: true,
      can_reconcile: true,
      can_manage_project_assignments: true,
      allowed_entry_types: ["PAYMENT_RECORDED", "ADJUSTMENT_INCREASE", "ADJUSTMENT_DECREASE"],
    },
    selected_sub_ledger: null,
    sub_ledgers: [
      {
        ledger_scope: "PROJECT_ACCOUNTANT",
        project_id: "PRJ_NORTH",
        project_display_name: "Dự án Miền Bắc",
        project_active: true,
        accountant_ref: ACC_A,
        responsible_accountant_display_name: "Trần Thị Kế Toán A",
        contract_type: "SEASONAL",
        is_active_assignment: true,
        current_balance_minor: "10000000",
        balance_direction: "PAYABLE",
        latest_sequence: 1,
        entry_count: 1,
        has_opening_entry: false,
        eligible_for_opening: false,
        can_record_entry: true,
        can_reconcile: true,
        can_classify_contract_type: false,
        classification: null,
      },
    ],
    vendor: {
      vendor_id: "VND_ALPHA",
      display_name: "Công ty TNHH Alpha",
      active: false,
      current_balance_minor: "0",
      balance_direction: "MULTI_LEDGER",
      latest_sequence: 1,
      entry_count: 1,
      has_opening_entry: false,
      eligible_for_opening: false,
      totals: {
        opening_payable_minor: "0",
        opening_advance_minor: "0",
        debt_recorded_minor: "10000000",
        payroll_recorded_minor: "0",
        payment_recorded_minor: "0",
        advance_recorded_minor: "0",
        adjustment_increase_minor: "0",
        adjustment_decrease_minor: "0",
        reversed_entry_count: 0,
      },
      latest_reconciliation: validRec,
      recent_reconciliations: [validRec],
    },
  });
  assert.ok(detail);
  assert.equal(detail.vendor.balance_direction, "MULTI_LEDGER");

  // Opening batch apply requires entries.length === batch.vendor_count
  assert.ok(
    projectOpeningApplyMutation({
      batch: {
        batch_id: BATCH_ID,
        ledger_scope: "PROJECT_ACCOUNTANT",
        project_id: "PRJ_NORTH",
        project_display_name_snapshot: "Dự án Miền Bắc",
        accountant_ref: ACC_A,
        responsible_accountant_display_name: "Trần Thị Kế Toán A",
        contract_type: "SEASONAL",
        cutoff_date: "2026-10-01",
        vendor_count: 1,
        skipped_zero_count: 2,
        total_payable_minor: "9007199254740993",
        total_advance_minor: "0",
        net_balance_minor: "9007199254740993",
        reason: "Chốt số dư đầu kỳ",
        created_by_display_name: "Trần Thị Kế Toán A",
        created_at: "2026-10-24T02:00:00.000Z",
      },
      entries: [makeCanonicalEntry({ entry_type: "OPENING_PAYABLE", opening_batch_id: BATCH_ID })],
      replayed: false,
    }),
  );

  // Classification mutation projector validates exact keys
  assert.ok(
    projectClassifySubLedgerMutation({
      classification: {
        classification_id: BATCH_ID,
        vendor_id: "VND_ALPHA",
        project_id: "PRJ_NORTH",
        project_display_name_snapshot: "Dự án Miền Bắc",
        accountant_ref: ACC_A,
        responsible_accountant_display_name: "Trần Thị Kế Toán A",
        source_contract_type: "UNCLASSIFIED",
        target_contract_type: "OFFICIAL",
        classified_entry_count: 3,
        classified_reconciliation_count: 1,
        closing_balance_minor: "15000000",
        reason: "Đối chiếu chứng từ gốc",
        classified_by_display_name: "Trần Thị Kế Toán A",
        classified_at: "2026-10-24T02:00:00.000Z",
      },
      replayed: false,
    }),
  );

  // Monthly report projector requires MISSING_CANONICAL_SOURCE and null project_revenue_minor (never fake "0")
  const validMonthly = {
    authorization_date: "2026-10-24",
    allowed_actions: {
      visibility_scope: "ALL",
      can_view: true,
      can_record: false,
      can_reconcile: true,
      can_manage_project_assignments: false,
    },
    filters: {
      month: "2026-10",
      project_id: null,
      accountant_ref: null,
      vendor_id: null,
      contract_type: "all",
    },
    totals: {
      project_revenue_status: "MISSING_CANONICAL_SOURCE",
      project_revenue_minor: null,
      project_accountant_book_count: 1,
      sub_ledger_count: 1,
      obligations_in_month_minor: "10000000",
      paid_in_month_minor: "4000000",
      advanced_in_month_minor: "0",
      paid_and_advanced_in_month_minor: "4000000",
      closing_payable_minor: "6000000",
      closing_advance_minor: "0",
    },
    project_accountant_summaries: [],
    rows: [],
    legacy_unallocated_rows: [],
  };
  assert.ok(projectMonthlyReport(validMonthly));
  assert.equal(
    projectMonthlyReport({
      ...validMonthly,
      totals: { ...validMonthly.totals, project_revenue_minor: "0" },
    }),
    null,
    "faking project_revenue_minor as '0' must fail closed",
  );

  // VFIN-02 & VFIN-03 HTTP error statuses
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_RECONCILE_DENIED"), 403);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_ADMIN_DENIED"), 403);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_ASSIGNMENT_VERSION_CONFLICT"), 409);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_GLOBAL_ROLE_VERSION_CONFLICT"), 409);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_CONTRACT_TYPE_INVALID"), 422);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_CONTRACT_TYPE_ALREADY_CLASSIFIED"), 409);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_CONTRACT_TYPE_TARGET_NOT_EMPTY"), 409);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE"), 422);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE"), 422);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND"), 404);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_MOVEMENT_ALREADY_REVERSED"), 409);
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED"), 422);
});

test("VFIN-04 shared advance & export parsers, cursors, fingerprints, and projectors enforce strict invariants", () => {
  // 1. Fund and Refund reject project_id / contract_type / accountant_ref as forbidden client authority fields
  for (const forbiddenBody of [
    {
      project_id: "PRJ_NORTH",
      amount_minor: "10000000",
      effective_date: "2026-10-24",
      reason: "Ứng tiền cho Vendor",
      idempotency_key: IDEM_1,
    },
    {
      contract_type: "SEASONAL",
      amount_minor: "10000000",
      effective_date: "2026-10-24",
      reason: "Ứng tiền cho Vendor",
      idempotency_key: IDEM_1,
    },
  ]) {
    assert.deepEqual(parseFundSharedAdvanceBody(forbiddenBody, IDEM_1), {
      ok: false,
      code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
    });
    assert.deepEqual(parseRecordVendorRefundBody(forbiddenBody, IDEM_1), {
      ok: false,
      code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
    });
  }

  const fundOk = parseFundSharedAdvanceBody(
    {
      amount_minor: "100000000",
      effective_date: "2026-10-24",
      reason: "Ứng tiền dùng chung cho Vendor Alpha",
      idempotency_key: IDEM_1,
    },
    IDEM_1,
  );
  assert.equal(fundOk.ok, true);
  assert.equal(
    computeFundSharedAdvanceFingerprint({ vendor_id: "VND_ALPHA", ...fundOk.value }).length,
    64,
  );

  const refundOk = parseRecordVendorRefundBody(
    {
      amount_minor: "25000000",
      effective_date: "2026-10-24",
      reason: "Vendor hoàn ứng tiền mặt",
      idempotency_key: IDEM_1,
    },
    IDEM_1,
  );
  assert.equal(refundOk.ok, true);
  assert.equal(
    computeRecordVendorRefundFingerprint({ vendor_id: "VND_ALPHA", ...refundOk.value }).length,
    64,
  );

  // 2. Apply offset requires project_id & contract_type ('SEASONAL' | 'OFFICIAL')
  const offsetOk = parseApplySharedAdvanceOffsetBody(
    {
      project_id: "PRJ_NORTH",
      contract_type: "OFFICIAL",
      amount_minor: "40000000",
      effective_date: "2026-10-24",
      reason: "Khấu trừ ứng vào công nợ chính thức dự án Bắc",
      idempotency_key: IDEM_1,
    },
    IDEM_1,
  );
  assert.equal(offsetOk.ok, true);
  assert.equal(
    computeApplySharedAdvanceOffsetFingerprint({ vendor_id: "VND_ALPHA", ...offsetOk.value }).length,
    64,
  );

  const revMovOk = parseReverseSharedAdvanceMovementBody(
    {
      effective_date: "2026-10-25",
      reason: "Đảo bút toán ứng nhầm số tiền",
      idempotency_key: IDEM_1,
    },
    IDEM_1,
  );
  assert.equal(revMovOk.ok, true);
  assert.equal(
    computeReverseSharedAdvanceMovementFingerprint({ movement_id: ENTRY_ID, ...revMovOk.value }).length,
    64,
  );

  // 3. Shared advance keyset cursor binds vendor_id
  const movCursor = encodeSharedAdvanceMovementsCursor({
    vendor_id: "VND_ALPHA",
    before_sequence: 12,
  });
  assert.deepEqual(decodeSharedAdvanceMovementsCursor(movCursor, "VND_ALPHA"), {
    ok: true,
    before_sequence: 12,
  });
  assert.deepEqual(decodeSharedAdvanceMovementsCursor(movCursor, "VND_OTHER"), {
    ok: false,
    code: "VENDOR_FINANCE_CURSOR_INVALID",
  });
  const movQuery = parseListSharedAdvanceMovementsQuery(
    new URL(`https://bi.local/api/vendor-finance/vendors/VND_ALPHA/shared-advances?cursor=${movCursor}&page_size=20`),
    "VND_ALPHA",
  );
  assert.equal(movQuery.ok, true);
  assert.equal(movQuery.value.before_sequence, 12);

  // 4. Export query & body parsers reject pagination params and preserve filter parity
  assert.deepEqual(
    parseExportVendorFinanceVendorsQuery(new URL("https://bi.local/api/vendor-finance/vendors/export?page=1")),
    { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" },
  );
  const expQuery = parseExportVendorFinanceVendorsQuery(
    new URL(
      "https://bi.local/api/vendor-finance/vendors/export?project_id=PRJ_NORTH&contract_type=SEASONAL&balance_filter=payable&search=Alpha",
    ),
  );
  assert.equal(expQuery.ok, true);
  const expBody = parseExportVendorFinanceVendorsBody({
    project_id: "PRJ_NORTH",
    contract_type: "SEASONAL",
    balance_filter: "payable",
    search: "Alpha",
  });
  assert.deepEqual(expBody, expQuery);

  // 5. Projectors validate shared advance movement & offset arithmetic and fail closed on mismatch
  const sampleMov = {
    movement_id: REC_ID,
    vendor_id: "VND_ALPHA",
    vendor_display_name_snapshot: "Công ty TNHH Alpha",
    vendor_active: true,
    vendor_advance_sequence: 1,
    cursor_sequence: 1,
    document_no: "VFIN-2026-000201",
    document_kind: "ADVANCE_OFFSET_VOUCHER",
    document_title_vi: "Phiếu khấu trừ số dư ứng dùng chung vào công nợ dự án",
    movement_type: "PROJECT_OFFSET_APPLIED",
    amount_minor: "40000000",
    balance_before_minor: "100000000",
    balance_delta_minor: "-40000000",
    balance_after_minor: "60000000",
    effective_date: "2026-10-24",
    reason: "Khấu trừ ứng",
    project_entry_id: ENTRY_ID,
    project_id: "PRJ_NORTH",
    project_display_name_snapshot: "Dự án Miền Bắc",
    accountant_ref: ACC_A,
    responsible_accountant_display_name: "Trần Thị Kế Toán A",
    contract_type: "OFFICIAL",
    reverses_movement_id: null,
    reverses_document_no: null,
    reversed_by_movement_id: null,
    reversed_by_document_no: null,
    can_reverse: true,
    can_attach_evidence: false,
    evidence: null,
    created_by_display_name: "Trần Thị Kế Toán A",
    created_at: "2026-10-24T02:00:00.000Z",
    internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
  };
  assert.ok(projectSharedAdvanceMovement(sampleMov));
  assert.equal(
    projectSharedAdvanceMovement({ ...sampleMov, can_attach_evidence: true }),
    null,
    "shared advance movement does not support evidence attachment",
  );
  // Redacted cross-project movement (project fields, reason, and created_by_display_name all null)
  assert.ok(
    projectSharedAdvanceMovement({
      ...sampleMov,
      reason: null,
      project_entry_id: null,
      project_id: null,
      project_display_name_snapshot: null,
      accountant_ref: null,
      responsible_accountant_display_name: null,
      contract_type: null,
      can_reverse: false,
      created_by_display_name: null,
    }),
  );
  // Partial redaction (reason null while project_id non-null) must fail closed
  assert.equal(
    projectSharedAdvanceMovement({ ...sampleMov, reason: null }),
    null,
  );
  assert.equal(
    projectSharedAdvanceMovement({ ...sampleMov, balance_after_minor: "70000000" }),
    null,
  );
  assert.equal(
    projectSharedAdvanceMovement({ ...sampleMov, balance_after_minor: "-1" }),
    null,
    "negative shared advance balance must fail closed",
  );

  const sampleOffsetEntry = makeCanonicalEntry({
    entry_type: "ADVANCE_OFFSET_RECORDED",
    document_kind: "ADVANCE_OFFSET_VOUCHER",
    contract_type: "OFFICIAL",
    amount_minor: "40000000",
    balance_before_minor: "90000000",
    balance_delta_minor: "-40000000",
    balance_after_minor: "50000000",
  });
  assert.ok(
    projectApplySharedAdvanceOffsetMutation({
      movement: sampleMov,
      entry: sampleOffsetEntry,
      shared_advance_balance_minor: "60000000",
      replayed: false,
    }),
  );
  assert.ok(
    projectFundSharedAdvanceMutation({
      movement: {
        ...sampleMov,
        movement_type: "ADVANCE_FUNDED",
        document_kind: "ADVANCE_VOUCHER",
        balance_before_minor: "0",
        balance_delta_minor: "40000000",
        balance_after_minor: "40000000",
        project_entry_id: null,
        project_id: null,
        project_display_name_snapshot: null,
        accountant_ref: null,
        responsible_accountant_display_name: null,
        contract_type: null,
      },
      shared_advance_balance_minor: "40000000",
      replayed: false,
    }),
  );
  assert.ok(
    projectReverseSharedAdvanceMovementMutation({
      reversal_movement: {
        ...sampleMov,
        movement_type: "REVERSAL",
        document_kind: "DEBT_ADJUSTMENT_VOUCHER",
        balance_before_minor: "60000000",
        balance_delta_minor: "40000000",
        balance_after_minor: "100000000",
        reverses_movement_id: REC_ID,
        reverses_document_no: "VFIN-2026-000201",
        can_reverse: false,
      },
      reversed_movement: {
        ...sampleMov,
        reversed_by_movement_id: BATCH_ID,
        reversed_by_document_no: "VFIN-2026-000203",
        can_reverse: false,
      },
      reversal_entry: makeCanonicalEntry({
        entry_type: "REVERSAL",
        document_kind: "DEBT_ADJUSTMENT_VOUCHER",
        contract_type: "OFFICIAL",
        amount_minor: "40000000",
        balance_before_minor: "50000000",
        balance_delta_minor: "40000000",
        balance_after_minor: "90000000",
        reverses_entry_id: ENTRY_ID,
        reverses_document_no: "VFIN-2026-000202",
        can_reverse: false,
      }),
      reversed_entry: {
        ...sampleOffsetEntry,
        reversed_by_entry_id: BATCH_ID,
        reversed_by_document_no: "VFIN-2026-000204",
        can_reverse: false,
      },
      shared_advance_balance_minor: "100000000",
      replayed: false,
    }),
  );

  // Evidence target_kind rejects SHARED_ADVANCE_MOVEMENT
  const evReserve = parseReserveVendorFinanceEvidenceBody(
    {
      target_kind: "SHARED_ADVANCE_MOVEMENT",
      target_id: REC_ID,
      mime_type: "image/png",
      size_bytes: 1024,
      checksum_sha256: SHA_OK,
      idempotency_key: IDEM_1,
    },
    IDEM_1,
  );
  assert.deepEqual(evReserve, { ok: false, code: "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID" });

  // Export projector validates row cap and items length
  assert.ok(
    projectVendorFinanceVendorExport({
      authorization_date: "2026-10-24",
      filters: {
        search: null,
        active: "all",
        balance_filter: "all",
        project_id: null,
        accountant_ref: null,
        ledger_scope: "all",
        contract_type: "all",
      },
      row_cap: 10000,
      total: 0,
      vendors: [],
    }),
  );

  // VFIN-05 combined payment + shared advance offset body parser, fingerprint, projector & error status
  const settleOk = parseRecordPaymentWithOffsetBody(
    {
      project_id: "PRJ_NORTH",
      contract_type: "OFFICIAL",
      payment_amount_minor: "6000000",
      offset_amount_minor: "4000000",
      effective_date: "2026-10-24",
      reason: "  Thanh toán 6tr + khấu trừ 4tr  ",
      idempotency_key: IDEM_1,
    },
    IDEM_1,
  );
  assert.equal(settleOk.ok, true);
  assert.equal(settleOk.value.payment_amount_minor, "6000000");
  assert.equal(settleOk.value.offset_amount_minor, "4000000");
  assert.equal(settleOk.value.reason, "Thanh toán 6tr + khấu trừ 4tr");

  const settleZeroPay = parseRecordPaymentWithOffsetBody(
    {
      project_id: "PRJ_NORTH",
      contract_type: "OFFICIAL",
      payment_amount_minor: "0",
      offset_amount_minor: "4000000",
      effective_date: "2026-10-24",
      reason: "Invalid zero payment",
      idempotency_key: IDEM_1,
    },
    IDEM_1,
  );
  assert.deepEqual(settleZeroPay, { ok: false, code: "VENDOR_FINANCE_AMOUNT_INVALID" });

  const settleOverflowSum = parseRecordPaymentWithOffsetBody(
    {
      project_id: "PRJ_NORTH",
      contract_type: "OFFICIAL",
      payment_amount_minor: PG_BIGINT_MAX.toString(),
      offset_amount_minor: "1",
      effective_date: "2026-10-24",
      reason: "Overflow sum",
      idempotency_key: IDEM_1,
    },
    IDEM_1,
  );
  assert.deepEqual(settleOverflowSum, { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" });

  const fpSettle1 = computeRecordPaymentWithOffsetFingerprint({
    vendor_id: "VND_ALPHA",
    ...settleOk.value,
  });
  const fpSettle2 = computeRecordPaymentWithOffsetFingerprint({
    vendor_id: "VND_ALPHA",
    ...settleOk.value,
    payment_amount_minor: "5000000",
  });
  assert.match(fpSettle1, /^[0-9a-f]{64}$/);
  assert.notEqual(fpSettle1, fpSettle2);

  const samplePaymentEntry = makeCanonicalEntry({
    entry_type: "PAYMENT_RECORDED",
    document_kind: "PAYMENT_VOUCHER",
    contract_type: "OFFICIAL",
    amount_minor: "6000000",
    balance_before_minor: "10000000",
    balance_delta_minor: "-6000000",
    balance_after_minor: "4000000",
  });
  assert.ok(
    projectRecordPaymentWithOffsetMutation({
      payment_entry: samplePaymentEntry,
      offset_entry: {
        ...sampleOffsetEntry,
        entry_id: BATCH_ID,
      },
      movement: {
        ...sampleMov,
        project_entry_id: BATCH_ID,
      },
      shared_advance_balance_minor: "0",
      replayed: false,
    }),
  );
  // Fail-closed if payment_entry is not PAYMENT_RECORDED or movement.project_entry_id != offset_entry.entry_id
  assert.equal(
    projectRecordPaymentWithOffsetMutation({
      payment_entry: sampleOffsetEntry,
      offset_entry: sampleOffsetEntry,
      movement: sampleMov,
      shared_advance_balance_minor: "0",
      replayed: false,
    }),
    null,
  );
  assert.equal(vendorFinanceHttpStatusForError("VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE"), 422);
});
