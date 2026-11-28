import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVendorCreateRequest,
  buildVendorListQuery,
  buildVendorSetActiveRequest,
  buildVendorUpdateRequest,
  classifyVendorMutation,
  projectVendorItem,
  projectVendorListForQuery,
} from "./vendor-catalog-model.ts";

const KEY = "10000000-0000-4000-8000-000000000001";
const PARTNER_ACCOUNT = {
  partner_account_id: "30000000-0000-4000-8000-000000000001",
  partner_kind: "VENDOR",
  vendor_id: "SUP-01",
  collaborator_id: null,
  partner_id: "SUP-01",
  canonical_code: "sup-01",
  account_state: "UNPROVISIONED",
  app_user_id: null,
  username: null,
  activated_at: null,
  must_change_password: false,
  password_changed_at: null,
  activation_expires_at: null,
  activation_attempts: 0,
  version: 1,
};

const vendor = {
  vendor_id: "SUP-01",
  display_name: "Nhà cung cấp A",
  address: "789 Vo Van Tan, Q.3",
  phone: "0901234567",
  active: true,
  version: 4,
  revision_count: 6,
  recruiter_id: null,
  partner_account: PARTNER_ACCOUNT,
};

test("strict list and item projections retain only contracted vendor fields and query echo", () => {
  const list = projectVendorListForQuery({
    ok: true,
    list: {
      authorization_date: "2026-10-11",
      include_inactive: true,
      search: "SUP",
      page: 1,
      page_size: 25,
      total: 1,
      vendors: [vendor],
    },
  }, { search: "SUP", includeInactive: true, page: 1 });
  assert.equal(list?.vendors[0]?.vendor_id, "SUP-01");
  assert.equal(list?.vendors[0]?.address, "789 Vo Van Tan, Q.3");
  assert.equal(list?.vendors[0]?.phone, "0901234567");
  assert.equal(list?.vendors[0]?.partner_account?.account_state, "UNPROVISIONED");
  assert.equal(projectVendorItem({ ok: true, vendor: { ...vendor, unexpected: true } }), null);
  assert.equal(projectVendorItem({ ok: true, vendor: { ...vendor, partner_account: null } })?.partner_account, null);
  assert.equal(projectVendorListForQuery({
    ok: true,
    list: {
      authorization_date: "2026-10-11", include_inactive: true, search: "else",
      page: 1, page_size: 25, total: 1, vendors: [vendor],
    },
  }, { search: "SUP", includeInactive: true, page: 1 }), null);
});

test("search, inactive filter and pagination use bounded explicit API query", () => {
  const query = buildVendorListQuery({ search: "  ABC ", includeInactive: true, page: 3 });
  assert.equal(query?.toString(), "include_inactive=true&page=3&page_size=25&search=ABC");
  assert.equal(buildVendorListQuery({ search: "x", includeInactive: false, page: 1001 }), null);
});

test("create matches API request contract and validates optional address/phone cleanly", () => {
  const result = buildVendorCreateRequest({
    vendorId: "SUP-02",
    displayName: "Nhà cung cấp B",
    effectiveDate: "2032-02-29",
    reason: "Tạo mới",
    idempotencyKey: KEY,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.body).sort(), [
    "display_name", "expected_version", "idempotency_key", "reason", "valid_from", "vendor_id",
  ]);
  assert.equal(result.body.expected_version, 0);
  assert.equal(result.body.valid_from, "2032-02-29");

  const withContact = buildVendorCreateRequest({
    vendorId: "SUP-02",
    displayName: "Nhà cung cấp B",
    effectiveDate: "2032-02-29",
    address: "  100 Nguyen Hue  ",
    phone: " +84 909-123-456 ",
    idempotencyKey: KEY,
  });
  assert.equal(withContact.ok, true);
  if (withContact.ok) {
    assert.equal(withContact.body.address, "100 Nguyen Hue");
    assert.equal(withContact.body.phone, "+84 909-123-456");
  }

  const withBlankContact = buildVendorCreateRequest({
    vendorId: "SUP-02",
    displayName: "Nhà cung cấp B",
    effectiveDate: "2032-02-29",
    address: "   ",
    phone: "",
    idempotencyKey: KEY,
  });
  assert.equal(withBlankContact.ok, true);
  if (withBlankContact.ok) {
    assert.equal(withBlankContact.body.address, null);
    assert.equal(withBlankContact.body.phone, null);
  }

  assert.equal(buildVendorCreateRequest({
    vendorId: "SUP-02", displayName: "Nhà cung cấp B", effectiveDate: "2032-02-29",
    address: "bad\naddress", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildVendorCreateRequest({
    vendorId: "SUP-02", displayName: "Nhà cung cấp B", effectiveDate: "2032-02-29",
    phone: "123", idempotencyKey: KEY,
  }).ok, false);

  const withoutReason = buildVendorCreateRequest({ vendorId: "SUP-01", displayName: "Vendor",
    effectiveDate: "2032-02-29", idempotencyKey: KEY });
  assert.equal(withoutReason.ok, true);
  if (withoutReason.ok) assert.equal(withoutReason.body.reason, null);
  const blankReason = buildVendorCreateRequest({ vendorId: "SUP-01", displayName: "Vendor",
    effectiveDate: "2032-02-29", reason: "  ", idempotencyKey: KEY });
  assert.equal(blankReason.ok, true);
  if (blankReason.ok) assert.equal(blankReason.body.reason, null);
  assert.equal(buildVendorCreateRequest({
    vendorId: "SUP-02", displayName: "Nhà cung cấp B", effectiveDate: "2026-02-29",
    reason: "Tạo mới", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildVendorCreateRequest({
    vendorId: "SUP-02", displayName: "Nhà cung cấp B", effectiveDate: "",
    reason: "Tạo mới", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildVendorCreateRequest({
    vendorId: "__system_vendor__", displayName: "Reserved", effectiveDate: "2026-10-11",
    reason: "x", idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildVendorCreateRequest({
    vendorId: "SUP-02", displayName: "Nhà cung cấp B", effectiveDate: "2024-02-29",
    reason: "Tạo mới", idempotencyKey: KEY,
  }).ok, true);
});

test("update and set-active send exact expected-version, optional contact, reason and idempotency fields", () => {
  const update = buildVendorUpdateRequest({
    displayName: "Tên mới", expectedVersion: 4, reason: "Đổi tên", idempotencyKey: KEY,
  });
  const active = buildVendorSetActiveRequest({
    active: false, expectedVersion: 4, reason: "Ngừng", idempotencyKey: KEY,
  });
  assert.equal(update.ok, true);
  assert.equal(active.ok, true);
  const withoutReason = buildVendorUpdateRequest({ displayName: "Tên", expectedVersion: 2,
    idempotencyKey: KEY });
  assert.equal(withoutReason.ok, true);
  if (withoutReason.ok) assert.equal(withoutReason.body.reason, null);
  if (update.ok) {
    assert.deepEqual(Object.keys(update.body).sort(),
      ["display_name", "expected_version", "idempotency_key", "reason"]);
  }
  const updateWithContact = buildVendorUpdateRequest({
    displayName: "Tên mới", expectedVersion: 4, address: " 50 Dong Khoi ",
    phone: "0909888777", idempotencyKey: KEY,
  });
  assert.equal(updateWithContact.ok, true);
  if (updateWithContact.ok) {
    assert.deepEqual(Object.keys(updateWithContact.body).sort(),
      ["address", "display_name", "expected_version", "idempotency_key", "phone", "reason"]);
    assert.equal(updateWithContact.body.address, "50 Dong Khoi");
    assert.equal(updateWithContact.body.phone, "0909888777");
  }
  if (active.ok) {
    assert.deepEqual(Object.keys(active.body).sort(),
      ["active", "expected_version", "idempotency_key", "reason"]);
  }
  assert.equal(buildVendorUpdateRequest({
    displayName: "Tên", expectedVersion: 0, reason: "x", idempotencyKey: KEY,
  }).ok, false);
});

test("mutation results map applied, stale OCC, PARTNER_CODE_CONFLICT, denied and invalid", () => {
  const applied = {
    ok: true,
    vendor: {
      vendor_id: "SUP-01",
      display_name: "Nhà cung cấp A",
      address: null,
      phone: null,
      active: true,
      version: 5,
      revision_id: "revision",
      recruiter_id: null,
      partner_account: null,
    },
  };
  assert.equal(classifyVendorMutation(200, applied, "update").kind, "applied");
  assert.equal(classifyVendorMutation(409, null, "update").kind, "conflict");
  const codeConflict = classifyVendorMutation(409, { ok: false, code: "PARTNER_CODE_CONFLICT" }, "create");
  assert.equal(codeConflict.kind, "conflict");
  if (codeConflict.kind === "conflict") {
    assert.match(codeConflict.message, /Nhà cung cấp hoặc Cộng tác viên/);
    assert.match(codeConflict.message, /không phân biệt chữ hoa\/thường/);
  }
  assert.equal(classifyVendorMutation(403, null, "update").kind, "denied");
  assert.equal(classifyVendorMutation(400, null, "create").kind, "invalid");
});
