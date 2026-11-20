import assert from "node:assert/strict";
import test from "node:test";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "./contracts.ts";
import { listMyWorkReportObligations, getWorkReportSubmission, writeWorkReportSubmission } from "./submission-api.ts";
import { createSubmissionRepository } from "./submission-repository.ts";

const actor = { auth_subject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", app_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function deps(repository = {}) { return { resolveSession: async () => ({ actor: { ok: true, actor } }), repository }; }
function post(body) { return new Request(`https://bi.test/api/work-reports/submissions/${id}/submit`, { method: "POST",
  headers: { host: "bi.test", origin: "https://bi.test", "sec-fetch-site": "same-origin", "content-type": "application/json" },
  body: JSON.stringify(body) }); }

test("obligations inbox is session scoped and maps RPC failure to explicit error", async () => {
  let input;
  const response = await listMyWorkReportObligations(new Request("https://bi.test/api/work-reports/obligations?status=ACTIVE"), "true", deps({
    listMine: async (value) => { input = value; return { ok: true, data: [] }; },
  }));
  assert.equal(response.status, 200);
  assert.equal(input.app_user_id, actor.app_user_id);
  assert.equal(input.status, "ACTIVE");
  assert.equal((await listMyWorkReportObligations(new Request("https://bi.test/api/work-reports/obligations?team_id=x"), "true", deps())).status, 400);
});

test("submission mutation rejects client-supplied actor and mismatched idempotency header", async () => {
  const forged = await writeWorkReportSubmission(post({ payload_json: { calls_made: 1, app_user_id: actor.app_user_id },
    expected_version: null, idempotency_key: "submit-1" }), id, "submit", "true", deps());
  assert.equal(forged.status, 400);
  const mismatch = post({ payload_json: { calls_made: 1 }, expected_version: null, idempotency_key: "submit-1" });
  mismatch.headers.set("idempotency-key", "submit-2");
  assert.equal((await writeWorkReportSubmission(mismatch, id, "submit", "true", deps())).status, 400);
});

test("draft, submit, and resubmit use the current server actor and OCC version", async () => {
  const calls = [];
  const repository = {
    saveDraft: async (input) => { calls.push(["draft", input]); return { ok: true, data: { version: 1 } }; },
    submit: async (input) => { calls.push(["submit", input]); return { ok: true, data: { version: input.expected_version + 1 } }; },
  };
  for (const [action, expectedVersion] of [["draft", null], ["submit", 1], ["submit", 2]]) {
    const response = await writeWorkReportSubmission(post({ payload_json: { calls_made: 3 }, expected_version: expectedVersion,
      idempotency_key: `${action}-${expectedVersion}` }), id, action, "true", deps(repository));
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls.map(([name]) => name), ["draft", "submit", "submit"]);
  assert.equal(calls[2][1].expected_version, 2);
  assert.equal(calls[1][1].app_user_id, actor.app_user_id);
});

test("cross-user read denial is returned as 403, never as a successful empty record", async () => {
  const response = await getWorkReportSubmission(new Request(`https://bi.test/api/work-reports/obligations/${id}`), id, "true", deps({
    get: async () => ({ ok: false, kind: "denied" }),
  }));
  assert.equal(response.status, 403);
});

test("SQLSTATE 42501 with WORK_REPORT_DEADLINE_PASSED maps to HTTP 409 WORK_REPORT_DEADLINE_PASSED while true permission 42501 stays HTTP 403 WORK_REPORT_ACCESS_DENIED", async () => {
  const deadlineRepo = createSubmissionRepository(async () => ({
    data: null,
    error: { code: "42501", message: "WORK_REPORT_DEADLINE_PASSED" },
  }));
  for (const action of ["draft", "submit"]) {
    const res = await writeWorkReportSubmission(
      post({ payload_json: { calls_made: 5 }, expected_version: null, idempotency_key: `expired-${action}` }),
      id,
      action,
      "true",
      deps(deadlineRepo),
    );
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, code: "WORK_REPORT_DEADLINE_PASSED" });
  }

  const deniedRepo = createSubmissionRepository(async () => ({
    data: null,
    error: { code: "42501", message: "WORK_REPORT_ACCESS_DENIED" },
  }));
  for (const action of ["draft", "submit"]) {
    const res = await writeWorkReportSubmission(
      post({ payload_json: { calls_made: 5 }, expected_version: null, idempotency_key: `denied-${action}` }),
      id,
      action,
      "true",
      deps(deniedRepo),
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, code: "WORK_REPORT_ACCESS_DENIED" });
  }
});

test("submission repository preserves server is_overdue boolean on obligations and submission detail", async () => {
  const repo = createSubmissionRepository(async (fn) => {
    if (fn === "work_report_list_my_obligations") {
      return {
        data: {
          items: [
            {
              obligation_id: id,
              template_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              template_version_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              template_code: "TPL_DAILY",
              template_name: "Báo cáo ngày",
              period_type: "DAILY",
              period_key: "2026-10-20",
              period_start_date: "2026-10-20",
              period_end_date: "2026-10-20",
              due_at: "2026-10-20T16:59:59Z",
              is_mandatory: true,
              obligation_status: "ACTIVE",
              reopened_until: null,
              is_overdue: true,
              version: 1,
              submission_id: null,
              submission_state: "NOT_STARTED",
              submission_version: null,
              schema_json: RECRUITMENT_DAILY_TEMPLATE_SCHEMA,
            },
          ],
        },
        error: null,
      };
    }
    return {
      data: {
        obligation: {
          obligation_id: id,
          template_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          assignee_app_user_id: actor.app_user_id,
          period_key: "2026-10-20",
          due_at: "2026-10-20T16:59:59Z",
          obligation_status: "ACTIVE",
          reopened_until: null,
          is_overdue: true,
          version: 1,
        },
        template: {
          template_code: "TPL_DAILY",
          display_name: "Báo cáo ngày",
          schema_json: RECRUITMENT_DAILY_TEMPLATE_SCHEMA,
        },
        submission: null,
        latest_review_event: null,
        revisions: [],
      },
      error: null,
    };
  });

  const listRes = await listMyWorkReportObligations(
    new Request("https://bi.test/api/work-reports/obligations"),
    "true",
    deps(repo),
  );
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.equal(listJson.data[0].is_overdue, true);

  const detailRes = await getWorkReportSubmission(
    new Request(`https://bi.test/api/work-reports/obligations/${id}`),
    id,
    "true",
    deps(repo),
  );
  assert.equal(detailRes.status, 200);
  const detailJson = await detailRes.json();
  assert.equal(detailJson.data.obligation.is_overdue, true);
});

test("WP8D nav probe: hasActiveObligations calls read-only RPC, enforces exact 1-key boolean payload, and fails closed on errors/malformed data", async () => {
  const calls = [];
  const makeRepo = (handler) => createSubmissionRepository(async (name, args) => {
    calls.push([name, args]);
    return handler(name, args);
  });

  const trueRes = await makeRepo(async () => ({
    data: { has_active_obligations: true },
    error: null,
  })).hasActiveObligations(actor);
  assert.deepEqual(trueRes, { ok: true, data: { has_active_obligations: true } });
  assert.deepEqual(calls[0], [
    "work_report_has_active_obligations",
    { p_auth_subject: actor.auth_subject, p_app_user_id: actor.app_user_id },
  ]);

  const falseRes = await makeRepo(async () => ({
    data: { has_active_obligations: false },
    error: null,
  })).hasActiveObligations(actor);
  assert.deepEqual(falseRes, { ok: true, data: { has_active_obligations: false } });

  const deniedRes = await makeRepo(async () => ({
    data: null,
    error: { code: "42501", message: "WORK_REPORT_ACTOR_DENIED" },
  })).hasActiveObligations(actor);
  assert.deepEqual(deniedRes, { ok: false, kind: "denied" });

  const rpcErrRes = await makeRepo(async () => ({
    data: null,
    error: { code: "25006", message: "cannot execute in a read-only transaction" },
  })).hasActiveObligations(actor);
  assert.deepEqual(rpcErrRes, { ok: false, kind: "unavailable" });

  const thrownRes = await makeRepo(async () => {
    throw new Error("socket hang up");
  }).hasActiveObligations(actor);
  assert.deepEqual(thrownRes, { ok: false, kind: "unavailable" });

  const malformedPayloads = [
    null,
    undefined,
    true,
    false,
    "true",
    1,
    [],
    {},
    { has_active_obligations: "true" },
    { has_active_obligations: 1 },
    { has_active_obligations: null },
    { has_active_obligations: true, extra_field: "no-pii-leak" },
    { items: [] },
  ];
  for (const payload of malformedPayloads) {
    const res = await makeRepo(async () => ({ data: payload, error: null })).hasActiveObligations(actor);
    assert.deepEqual(
      res,
      { ok: false, kind: "unavailable" },
      `malformed probe payload ${JSON.stringify(payload)} must fail closed`,
    );
  }
});
