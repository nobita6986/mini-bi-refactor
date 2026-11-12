import assert from "node:assert/strict";
import test from "node:test";

import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "./contracts.ts";
import {
  createWorkReportDelegation,
  listWorkReportDelegations,
  revokeWorkReportDelegation,
} from "./delegation-api.ts";
import { createDelegationRepository } from "./delegation-repository.ts";
import {
  decideWorkReportReview,
  getWorkReportReviewSubmission,
  listPendingWorkReportReviews,
} from "./review-api.ts";
import { createReviewRepository } from "./review-repository.ts";

const AUTH = "10000000-0000-4000-8000-000000000001";
const APP = "20000000-0000-4000-8000-000000000001";
const DELEGATE_APP = "20000000-0000-4000-8000-000000000002";
const ASSIGNEE_APP = "20000000-0000-4000-8000-000000000003";
const TEMPLATE_ID = "30000000-0000-4000-8000-000000000001";
const VERSION_ID = "40000000-0000-4000-8000-000000000001";
const TEAM_A = "50000000-0000-4000-8000-000000000001";
const OBLIGATION_ID = "70000000-0000-4000-8000-000000000001";
const SUBMISSION_ID = "80000000-0000-4000-8000-000000000001";
const REVISION_ID = "90000000-0000-4000-8000-000000000001";
const REVIEW_EVENT_ID = "a0000000-0000-4000-8000-000000000001";
const DELEGATION_ID = "b0000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "c0000000-0000-4000-8000-000000000001";

const activeSession = async () => ({
  actor: {
    ok: true,
    actor: { auth_subject: AUTH, app_user_id: APP },
  },
});

const SAMPLE_PENDING_LIST = {
  items: [
    {
      obligation_id: OBLIGATION_ID,
      submission_id: SUBMISSION_ID,
      template_id: TEMPLATE_ID,
      template_code: "RECRUITMENT_DAILY_V1",
      template_name: "Báo cáo tuyển dụng ngày",
      period_key: "2026-10-20",
      period_start_date: "2026-10-20",
      period_end_date: "2026-10-20",
      due_at: "2026-10-20T16:59:59Z",
      assignee_app_user_id: ASSIGNEE_APP,
      assignee_display_name: "Staff A1",
      snapshot_team_id: TEAM_A,
      team_display_name: "Nhóm Tuyển Dụng A",
      submitted_at: "2026-10-20T10:00:00Z",
      is_late: false,
      has_post_deadline_amendment: false,
      submission_version: 2,
    },
  ],
  next_cursor: `2026-10-20T10:00:00.000000Z|${OBLIGATION_ID}`,
  has_more: false,
};

const SAMPLE_REVIEW_DETAIL = {
  obligation: {
    obligation_id: OBLIGATION_ID,
    assignment_id: "60000000-0000-4000-8000-000000000001",
    template_id: TEMPLATE_ID,
    template_version_id: VERSION_ID,
    assignee_app_user_id: ASSIGNEE_APP,
    assignee_display_name: "Staff A1",
    snapshot_team_id: TEAM_A,
    team_display_name: "Nhóm Tuyển Dụng A",
    period_type: "DAILY",
    period_key: "2026-10-20",
    period_start_date: "2026-10-20",
    period_end_date: "2026-10-20",
    due_at: "2026-10-20T16:59:59Z",
    is_mandatory: true,
    obligation_status: "ACTIVE",
    reopened_until: null,
    version: 1,
  },
  template: {
    template_code: "RECRUITMENT_DAILY_V1",
    display_name: "Báo cáo tuyển dụng ngày",
    requires_review: true,
    schema_json: RECRUITMENT_DAILY_TEMPLATE_SCHEMA,
  },
  submission: {
    submission_id: SUBMISSION_ID,
    state: "PENDING_REVIEW",
    draft_payload_json: { calls_made: 15 },
    first_submitted_at: "2026-10-20T10:00:00Z",
    latest_submitted_at: "2026-10-20T10:00:00Z",
    is_late: false,
    has_post_deadline_amendment: false,
    current_revision_id: REVISION_ID,
    version: 2,
  },
  revisions: [
    {
      revision_id: REVISION_ID,
      revision_no: 1,
      payload_json: { calls_made: 15 },
      created_at: "2026-10-20T10:00:00Z",
    },
  ],
};

const SAMPLE_DECISION_RESULT = {
  obligation_id: OBLIGATION_ID,
  submission_id: SUBMISSION_ID,
  revision_id: REVISION_ID,
  review_event_id: REVIEW_EVENT_ID,
  state: "APPROVED",
  version: 3,
  acting_scope_kind: "team",
  acting_team_id: TEAM_A,
  delegation_id: null,
};

const SAMPLE_DELEGATIONS_PAYLOAD = {
  items: [
    {
      delegation_id: DELEGATION_ID,
      grantor_user_id: APP,
      grantor_display_name: "Team Leader A",
      delegate_app_user_id: DELEGATE_APP,
      delegate_display_name: "Delegate A",
      capability: "report_review",
      template_id: TEMPLATE_ID,
      template_code: "RECRUITMENT_DAILY_V1",
      template_name: "Báo cáo tuyển dụng ngày",
      scope_kind: "team",
      scope_id: TEAM_A,
      scope_team_id: TEAM_A,
      scope_label: "Nhóm Tuyển Dụng A",
      effective_from: "2026-10-20T00:00:00Z",
      effective_to: null,
      state: "ACTIVE",
      status: "ACTIVE",
      is_current: true,
      is_effective: true,
      revoked_at: null,
      version: 1,
      created_at: "2026-10-20T01:00:00Z",
    },
  ],
  options: {
    delegates: [{ app_user_id: DELEGATE_APP, display_name: "Delegate A", team_id: TEAM_A }],
    templates: [
      {
        template_id: TEMPLATE_ID,
        template_code: "RECRUITMENT_DAILY_V1",
        display_name: "Báo cáo tuyển dụng ngày",
      },
    ],
    scopes: [{ kind: "team", id: TEAM_A, label: "Nhóm Tuyển Dụng A" }],
    capabilities: ["report_assign", "report_review"],
  },
};

function postJson(url, body, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      Host: "localhost",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("review API enforces feature flag, metadata-only inbox, CSRF, reason requirement, version conflict and self-review denial", async () => {
  let capturedDecisionArgs = null;
  const repo = createReviewRepository(async (name, args) => {
    if (name === "work_report_list_pending_reviews") {
      return { data: SAMPLE_PENDING_LIST, error: null };
    }
    if (name === "work_report_get_review_submission") {
      return { data: SAMPLE_REVIEW_DETAIL, error: null };
    }
    if (name === "work_report_decide_review") {
      capturedDecisionArgs = args;
      return { data: SAMPLE_DECISION_RESULT, error: null };
    }
    return { data: null, error: { code: "P0002" } };
  });
  const deps = { resolveSession: activeSession, repository: repo };

  // Feature flag off -> 404
  const flagOff = await listPendingWorkReportReviews(
    new Request("http://localhost/api/work-reports/reviews"),
    "false",
    deps,
  );
  assert.equal(flagOff.status, 404);

  // Valid inbox list -> 200 with metadata only
  const listRes = await listPendingWorkReportReviews(
    new Request(`http://localhost/api/work-reports/reviews?template_id=${TEMPLATE_ID}&page_size=50`),
    "true",
    deps,
  );
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.ok, true);
  assert.equal(listBody.items.length, 1);
  assert.equal("payload_json" in listBody.items[0], false);
  assert.equal(listBody.next_cursor, SAMPLE_PENDING_LIST.next_cursor);

  // Repository rejects inbox items that accidentally contain payload_json
  const leakyRepo = createReviewRepository(async () => ({
    data: {
      ...SAMPLE_PENDING_LIST,
      items: [{ ...SAMPLE_PENDING_LIST.items[0], payload_json: { secret: 1 } }],
    },
    error: null,
  }));
  const leakyRes = await listPendingWorkReportReviews(
    new Request("http://localhost/api/work-reports/reviews"),
    "true",
    { resolveSession: activeSession, repository: leakyRepo },
  );
  assert.equal(leakyRes.status, 503);

  // Reviewer detail -> 200 with detail
  const detailRes = await getWorkReportReviewSubmission(
    new Request(`http://localhost/api/work-reports/reviews/${OBLIGATION_ID}`),
    OBLIGATION_ID,
    "true",
    deps,
  );
  assert.equal(detailRes.status, 200);
  const detailBody = await detailRes.json();
  assert.equal(detailBody.ok, true);
  assert.equal(detailBody.detail.submission.submission_id, SUBMISSION_ID);

  // Reject without reason -> 400 WORK_REPORT_REVIEW_REASON_REQUIRED
  const rejectNoReason = await decideWorkReportReview(
    postJson(`http://localhost/api/work-reports/reviews/${OBLIGATION_ID}/decision`, {
      decision: "REJECT",
      reason: "   ",
      expected_version: 2,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    OBLIGATION_ID,
    "true",
    deps,
  );
  assert.equal(rejectNoReason.status, 400);
  assert.equal((await rejectNoReason.json()).code, "WORK_REPORT_REVIEW_REASON_REQUIRED");

  // Client authority field in body -> 400 CLIENT_AUTHORITY_FIELD_FORBIDDEN
  const clientAuthField = await decideWorkReportReview(
    postJson(`http://localhost/api/work-reports/reviews/${OBLIGATION_ID}/decision`, {
      decision: "APPROVE",
      expected_version: 2,
      idempotency_key: IDEMPOTENCY_KEY,
      actor: { app_user_id: APP },
    }),
    OBLIGATION_ID,
    "true",
    deps,
  );
  assert.equal(clientAuthField.status, 400);
  assert.equal((await clientAuthField.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");

  // Approve normalizes "APPROVE" -> "APPROVED"
  const approveRes = await decideWorkReportReview(
    postJson(`http://localhost/api/work-reports/reviews/${OBLIGATION_ID}/decision`, {
      decision: "APPROVE",
      reason: null,
      expected_version: 2,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    OBLIGATION_ID,
    "true",
    deps,
  );
  assert.equal(approveRes.status, 200);
  assert.equal(capturedDecisionArgs.p_decision, "APPROVED");
  const approveBody = await approveRes.json();
  assert.equal(approveBody.state, "APPROVED");

  // Self-review forbidden -> 403 WORK_REPORT_SELF_REVIEW_FORBIDDEN
  const selfReviewRepo = createReviewRepository(async () => ({
    data: null,
    error: { code: "42501", message: "WORK_REPORT_SELF_REVIEW_FORBIDDEN" },
  }));
  const selfReviewRes = await decideWorkReportReview(
    postJson(`http://localhost/api/work-reports/reviews/${OBLIGATION_ID}/decision`, {
      decision: "APPROVED",
      expected_version: 2,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    OBLIGATION_ID,
    "true",
    { resolveSession: activeSession, repository: selfReviewRepo },
  );
  assert.equal(selfReviewRes.status, 403);
  assert.equal((await selfReviewRes.json()).code, "WORK_REPORT_SELF_REVIEW_FORBIDDEN");

  // Version conflict -> 409 WORK_REPORT_VERSION_CONFLICT
  for (const sqlstate of ["40001", "PT409"]) {
    const conflictRepo = createReviewRepository(async () => ({
      data: null,
      error: { code: sqlstate, message: "WORK_REPORT_VERSION_CONFLICT" },
    }));
    const conflictRes = await decideWorkReportReview(
      postJson(`http://localhost/api/work-reports/reviews/${OBLIGATION_ID}/decision`, {
        decision: "APPROVED",
        expected_version: 1,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      OBLIGATION_ID,
      "true",
      { resolveSession: activeSession, repository: conflictRepo },
    );
    assert.equal(conflictRes.status, 409);
    assert.equal((await conflictRes.json()).code, "WORK_REPORT_VERSION_CONFLICT");
  }
});

test("delegation API validates capabilities, date normalization, client authority fields, and versioned revoke", async () => {
  let capturedCreateArgs = null;
  const repo = createDelegationRepository(async (name, args) => {
    if (name === "work_report_list_delegations") {
      return { data: SAMPLE_DELEGATIONS_PAYLOAD, error: null };
    }
    if (name === "work_report_create_delegation") {
      capturedCreateArgs = args;
      return {
        data: { delegation_id: DELEGATION_ID, state: "ACTIVE", version: 1 },
        error: null,
      };
    }
    if (name === "work_report_revoke_delegation") {
      return {
        data: { delegation_id: DELEGATION_ID, state: "REVOKED", version: 2 },
        error: null,
      };
    }
    return { data: null, error: { code: "P0002" } };
  });
  const deps = { resolveSession: activeSession, repository: repo };

  // List delegations -> 200
  const listRes = await listWorkReportDelegations(
    new Request("http://localhost/api/work-reports/delegations"),
    "true",
    deps,
  );
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.ok, true);
  assert.equal(listBody.data.items.length, 1);
  assert.deepEqual(listBody.data.options.capabilities, ["report_assign", "report_review"]);

  // Reject delegating report_delegate -> 400 WORK_REPORT_DELEGATION_INVALID
  const badCapRes = await createWorkReportDelegation(
    postJson("http://localhost/api/work-reports/delegations", {
      capability: "report_delegate",
      delegate_app_user_id: DELEGATE_APP,
      template_id: TEMPLATE_ID,
      scope_kind: "team",
      scope_id: TEAM_A,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    "true",
    deps,
  );
  assert.equal(badCapRes.status, 400);
  assert.equal((await badCapRes.json()).code, "WORK_REPORT_DELEGATION_INVALID");

  // Reject client-supplied actor/role while allowing target capability/scope_kind
  const forbiddenAuthRes = await createWorkReportDelegation(
    postJson("http://localhost/api/work-reports/delegations", {
      capability: "report_review",
      delegate_app_user_id: DELEGATE_APP,
      template_id: TEMPLATE_ID,
      scope_kind: "team",
      scope_id: TEAM_A,
      idempotency_key: IDEMPOTENCY_KEY,
      role: "BoD",
    }),
    "true",
    deps,
  );
  assert.equal(forbiddenAuthRes.status, 400);
  assert.equal((await forbiddenAuthRes.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");

  // Reject client-supplied effective_from or effective_to -> 400 WORK_REPORT_DELEGATION_INVALID
  for (const invalidWindow of [
    { effective_from: "2026-10-20" },
    { effective_to: "2026-10-31" },
    { effective_from: "2026-10-20", effective_to: "2026-10-31" },
  ]) {
    const windowRes = await createWorkReportDelegation(
      postJson("http://localhost/api/work-reports/delegations", {
        capability: "report_review",
        delegate_app_user_id: DELEGATE_APP,
        template_id: TEMPLATE_ID,
        scope_kind: "team",
        scope_id: TEAM_A,
        ...invalidWindow,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      "true",
      deps,
    );
    assert.equal(windowRes.status, 400);
    assert.equal((await windowRes.json()).code, "WORK_REPORT_DELEGATION_INVALID");
  }

  // Valid create without start/expiration dates -> server applies immediate effect (null/null passed to RPC)
  const createRes = await createWorkReportDelegation(
    postJson("http://localhost/api/work-reports/delegations", {
      capability: "report_review",
      delegate_app_user_id: DELEGATE_APP,
      template_id: TEMPLATE_ID,
      scope_kind: "team",
      scope_id: TEAM_A,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    "true",
    deps,
  );
  assert.equal(createRes.status, 200);
  assert.equal(capturedCreateArgs.p_capability, "report_review");
  assert.equal(capturedCreateArgs.p_scope_kind, "team");
  assert.equal(capturedCreateArgs.p_scope_team_id, TEAM_A);
  assert.equal(capturedCreateArgs.p_effective_from, null);
  assert.equal(capturedCreateArgs.p_effective_to, null);

  // Revoke delegation -> 200
  const revokeRes = await revokeWorkReportDelegation(
    postJson(`http://localhost/api/work-reports/delegations/${DELEGATION_ID}/revoke`, {
      expected_version: 1,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    DELEGATION_ID,
    "true",
    deps,
  );
  assert.equal(revokeRes.status, 200);
  const revokeBody = await revokeRes.json();
  assert.equal(revokeBody.state, "REVOKED");
  assert.equal(revokeBody.version, 2);
});
