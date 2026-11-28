import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADMIN_SECTIONS,
  groupAdminSections,
  isAdminSectionActive,
  visibleAdminSections,
} from "../../lib/admin/admin-navigation.ts";
import {
  buildCollaboratorCreateRequest,
  buildCollaboratorListQuery,
  buildCollaboratorSetActiveRequest,
  buildCollaboratorUpdateRequest,
  classifyCollaboratorMutation,
  collaboratorListConfirmsId,
  projectCollaboratorItem,
  projectCollaboratorListForQuery,
} from "../../lib/direct-entry/collaborator-catalog-contract.ts";

const managerSource = readFileSync(
  new URL("./collaborator-catalog-manager.tsx", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(
  new URL("../../app/admin/catalog/collaborators/page.tsx", import.meta.url),
  "utf8",
);

const KEY = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-11-28T06:00:00Z";

function makeNavActor(capabilities, scopes) {
  const effective_grants = [];
  for (const s of scopes) {
    const scope_kind = s.kind === "all" ? "ALL" : s.kind === "team" ? "CONTEXT_TEAM" : "OWN";
    const scope_id = s.kind === "team" ? (s.reference ?? "team-1") : null;
    for (const cap of capabilities) {
      effective_grants.push({
        capability: cap,
        scope_kind,
        scope_id,
        source_type: "LEGACY_BRIDGE",
        source_id: "00000000-0000-4000-8000-000000000001",
      });
    }
  }
  return { capabilities, scopes, effective_grants };
}

test("collaborator manager provides list loading, empty, denied, error and retry states", () => {
  for (const state of ['"loading"', '"loaded"', '"denied"', '"unavailable"', '"error"']) {
    assert.ok(managerSource.includes(state), `missing state ${state}`);
  }
  assert.match(managerSource, /Danh mục cộng tác viên/);
  assert.match(managerSource, /Đang tải danh sách cộng tác viên/);
  assert.match(managerSource, /Chưa có cộng tác viên phù hợp/);
  assert.match(managerSource, /Không có quyền xem danh mục cộng tác viên/);
  assert.match(managerSource, /Thử tải lại/);
  assert.match(managerSource, /Bao gồm cộng tác viên ngừng hoạt động/);
});

test("create, rename and active flows use collaborator routes without valid_from or rendered OCC version", () => {
  assert.match(managerSource, /url: "\/api\/admin\/catalog\/collaborators"/);
  assert.match(managerSource, /method: "PATCH",\s*operation: "update"/);
  assert.match(managerSource, /\/active`[\s\S]{0,160}method: "POST",\s*operation: "set-active"/);
  assert.match(managerSource, /buildCollaboratorCreateRequest/);
  assert.match(managerSource, /buildCollaboratorUpdateRequest/);
  assert.match(managerSource, /buildCollaboratorSetActiveRequest/);
  assert.match(managerSource, /"Idempotency-Key": String\(intent\.body\.idempotency_key\)/);
  assert.match(managerSource, /expectedVersion: dialog\.collaborator\.version/);
  assert.match(managerSource, /Lý do thay đổi/);
  assert.doesNotMatch(managerSource, /valid_from|validFrom|Ngày hiệu lực/);
  assert.doesNotMatch(managerSource, /Phiên bản|revision_count|collaborator\.version\}/);
});

test("OCC and applied writes lock actions until authoritative reload succeeds", () => {
  assert.match(managerSource, /outcome\.kind === "applied" \|\| outcome\.kind === "conflict"/);
  assert.match(managerSource, /setConflictIntent\(intent\)/);
  assert.match(managerSource, /await reloadAuthoritative\(intent\)/);
  assert.match(managerSource, /projectCollaboratorItem\(await response\.json\(\)\)/);
  assert.match(managerSource, /collaboratorListConfirmsId\(list, createdId\)/);
  assert.match(managerSource, /Thao tác vẫn đang bị khóa/);
});

test("collaborator admin page enforces server session and adminAreaNavPredicate without vendor referrer tabs", () => {
  assert.match(pageSource, /resolveActorForRequest\(\)/);
  assert.match(pageSource, /adminAreaNavPredicate\(actor\.actor\)/);
  assert.match(pageSource, /redirect\("\/login\?next=\/admin\/catalog\/collaborators"\)/);
  assert.doesNotMatch(pageSource, /vendorReferrer|referral-report|referrers/);
});

test("admin navigation registers Cộng tác viên inside Danh mục tuyển dụng for adminAreaNavPredicate actors only", () => {
  const ctvSection = ADMIN_SECTIONS.find((s) => s.id === "collaborators");
  assert.deepEqual(
    ctvSection && { id: ctvSection.id, label: ctvSection.label, href: ctvSection.href },
    { id: "collaborators", label: "Cộng tác viên", href: "/admin/catalog/collaborators" },
  );
  assert.equal(isAdminSectionActive("/admin/catalog/collaborators", "/admin/catalog/collaborators"), true);

  const catalogActor = makeNavActor(["catalog_master_manage"], [{ kind: "all" }]);
  const fullAdmin = makeNavActor(
    ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    [{ kind: "all" }],
  );
  const bodActor = makeNavActor(["entry_privileged_edit"], [{ kind: "all" }]);
  const tlActor = makeNavActor(
    ["team_manager_assign", "report_view", "report_analytics_view"],
    [{ kind: "team" }],
  );

  assert.equal(
    visibleAdminSections(catalogActor).some((s) => s.id === "collaborators"),
    true,
  );
  assert.equal(
    visibleAdminSections(fullAdmin).some((s) => s.id === "collaborators"),
    true,
  );
  assert.equal(
    visibleAdminSections(bodActor).some((s) => s.id === "collaborators"),
    false,
  );
  assert.equal(
    visibleAdminSections(tlActor).some((s) => s.id === "collaborators"),
    false,
  );

  const grouped = groupAdminSections(visibleAdminSections(catalogActor));
  const recruitmentGroup = grouped.find((item) => item.type === "group" && item.id === "recruitment");
  assert.ok(recruitmentGroup && recruitmentGroup.type === "group");
  assert.equal(
    recruitmentGroup.sections.some((s) => s.id === "collaborators"),
    true,
  );
});

test("UI contract helpers build strict payloads and classify responses cleanly", () => {
  const query = buildCollaboratorListQuery({ search: "  ctv ", includeInactive: false, page: 1 });
  assert.equal(query?.toString(), "include_inactive=false&page=1&page_size=25&search=ctv");

  const createReq = buildCollaboratorCreateRequest({
    collaboratorId: " CTV_01 ",
    displayName: " Lê Thị CTV ",
    reason: "",
    idempotencyKey: KEY,
  });
  assert.deepEqual(createReq, {
    ok: true,
    body: {
      expected_version: 0,
      collaborator_id: "CTV_01",
      display_name: "Lê Thị CTV",
      reason: null,
      idempotency_key: KEY,
    },
  });

  assert.equal(
    buildCollaboratorCreateRequest({
      collaboratorId: "__system_vendor__",
      displayName: "Bad",
      idempotencyKey: KEY,
    }).ok,
    false,
  );

  const updateReq = buildCollaboratorUpdateRequest({
    displayName: "Tên mới",
    expectedVersion: 1,
    reason: "  Sửa tên ",
    idempotencyKey: KEY,
  });
  assert.deepEqual(updateReq, {
    ok: true,
    body: {
      expected_version: 1,
      display_name: "Tên mới",
      reason: "Sửa tên",
      idempotency_key: KEY,
    },
  });

  const activeReq = buildCollaboratorSetActiveRequest({
    active: false,
    expectedVersion: 2,
    reason: null,
    idempotencyKey: KEY,
  });
  assert.deepEqual(activeReq, {
    ok: true,
    body: {
      active: false,
      expected_version: 2,
      reason: null,
      idempotency_key: KEY,
    },
  });

  const item = {
    collaborator_id: "CTV_01",
    display_name: "Lê Thị CTV",
    active: true,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
  const listPayload = {
    ok: true,
    list: { items: [item], total: 1, page: 1, page_size: 25 },
  };
  const projectedList = projectCollaboratorListForQuery(listPayload, {
    search: "",
    includeInactive: false,
    page: 1,
  });
  assert.ok(projectedList);
  assert.equal(collaboratorListConfirmsId(projectedList, "CTV_01"), true);
  assert.equal(collaboratorListConfirmsId(projectedList, "CTV_99"), false);
  assert.deepEqual(projectCollaboratorItem({ ok: true, collaborator: item }), item);

  assert.equal(
    classifyCollaboratorMutation(200, {
      ok: true,
      collaborator: {
        collaborator_id: "CTV_01",
        display_name: "Lê Thị CTV",
        active: true,
        version: 1,
      },
    }).kind,
    "applied",
  );
  assert.equal(classifyCollaboratorMutation(409, null).kind, "conflict");
  assert.equal(classifyCollaboratorMutation(403, null).kind, "denied");
  assert.equal(classifyCollaboratorMutation(404, null).kind, "not-found");
  assert.equal(classifyCollaboratorMutation(400, null).kind, "invalid");
  assert.equal(classifyCollaboratorMutation(500, null).kind, "unavailable");
});
