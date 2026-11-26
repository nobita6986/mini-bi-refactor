import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseReaderDetail, renderWorkReportFieldValue } from "../../../lib/work-reports/reader-ui-model.ts";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../../../lib/work-reports/contracts.ts";

const rendererPath = new URL("./work-report-form-renderer.tsx", import.meta.url);
const inboxPath = new URL("./my-obligations.tsx", import.meta.url);
const assignmentManagerPath = new URL("./assignment-manager.tsx", import.meta.url);
const assignmentPagePath = new URL("../../../app/work-reports/assignments/page.tsx", import.meta.url);

test("dynamic renderer covers all eight F0 field types and preserves disabled fieldset semantics", async () => {
  const source = await readFile(rendererPath, "utf8");
  for (const type of ["textarea", "integer", "decimal", "date", "boolean", "single_select", "multi_select"]) {
    assert.ok(source.includes(`field.field_type === "${type}"`), `renderer missing ${type}`);
  }
  assert.match(source, /type="text"/);
  assert.match(source, /validateWorkReportSubmission\(schema, payload/);
  assert.match(source, /disabled=\{!canEdit \|\| busy\}/);
  assert.match(source, /Lịch sử các lần nộp/);
});

test("inbox exposes loading, explicit retryable error states, and separates overdue items into history", async () => {
  const source = await readFile(inboxPath, "utf8");
  assert.match(source, /Đang tải nghĩa vụ báo cáo/);
  assert.match(source, /Không tải được danh sách báo cáo/);
  assert.match(source, /Tải lại/);
  assert.match(source, /is_overdue\?: boolean/);
  assert.match(source, /if \(item\.is_overdue\) return false/);
  assert.match(source, /if \(item\.is_overdue\) return true/);
  assert.match(source, /Quá hạn · Bản nháp chưa nộp/);
  assert.match(source, /Quá hạn · Chưa nộp/);
});

test("rejected reports show the reviewer reason and can be resubmitted after the deadline, while overdue unsubmitted reports lock editing and handle 409 WORK_REPORT_DEADLINE_PASSED", async () => {
  const source = await readFile(rendererPath, "utf8");
  assert.match(source, /latest_review_event\?: \{ decision: string; reason: string \| null; reviewed_at: string \}/);
  assert.match(source, /detail\.submission\?\.state === "REJECTED" \|\| now === null/);
  assert.match(source, /Báo cáo cần nộp lại/);
  assert.match(source, /latest_review_event\?\.reason/);
  assert.match(source, /const isOverdue = Boolean\(detail\.obligation\.is_overdue\) \|\| serverDeadlinePassed/);
  assert.match(source, /const canEdit = !isOverdue &&/);
  assert.match(source, /if \(code === "WORK_REPORT_DEADLINE_PASSED"\)/);
  assert.match(source, /setServerDeadlinePassed\(true\)/);
  assert.match(source, /Kỳ báo cáo đã quá hạn/);
});

test("assignment manager provides Tạo đợt giao form, pre-confirmation summary, state filters, lazy-loaded per-person progress detail, and revocation confirmation including DRAFT", async () => {
  const source = await readFile(assignmentManagerPath, "utf8");
  assert.match(source, /Tạo đợt giao/);
  assert.match(source, /Tóm tắt đợt giao trước khi xác nhận/);
  assert.match(source, /Xác nhận tạo đợt giao/);
  assert.match(source, /Đang hoạt động/);
  assert.match(source, /Tạm dừng/);
  assert.match(source, /Đã thu hồi/);
  assert.match(source, /fetch\(`\/api\/work-reports\/assignments\/\$\{encodeURIComponent\(assignment\.assignment_id\)\}`/);
  assert.match(source, /Tiến độ từng thành viên — kỳ gần nhất/);
  assert.match(source, /Lịch sử thay đổi đợt giao gần nhất/);
  assert.match(source, /Xác nhận thu hồi đợt giao báo cáo/);
  assert.match(source, /đang lưu bản nháp chưa nộp/);
  assert.match(source, /DRAFT/);
  assert.match(source, /Các báo cáo đã nộp và toàn bộ lịch sử bài nộp được giữ nguyên, không bị xóa/);
});

test("assignment manager removes duplicate secondary nav buttons, moves collapse toggle into CardHeader, and keeps responsive non-clipping table layout", async () => {
  const source = await readFile(assignmentManagerPath, "utf8");
  const cardSource = await readFile(new URL("../../ui/card.tsx", import.meta.url), "utf8");

  // CardHeader accepts optional action without breaking existing callers
  assert.match(cardSource, /action\?: ReactNode/);

  // Duplicate secondary nav buttons removed; URL->state sync preserved
  assert.doesNotMatch(source, /Đợt giao \(\{assignments\.length\}\)/);
  assert.doesNotMatch(source, /Nhóm nhận báo cáo \(\{groups\.length\}\)/);
  assert.match(source, /parseWorkReportAssignmentTab\(searchParams\.get\("tab"\)\)/);

  // Collapse toggle lives in Tạo đợt giao CardHeader with busy lock; collapsed state offers clear reopen button; groups subview preserves Tạo nhóm nhận báo cáo
  assert.match(source, /<CardHeader[\s\S]*title="Tạo đợt giao"[\s\S]*action=\{[\s\S]*disabled=\{busy\}[\s\S]*Thu gọn biểu mẫu/);
  assert.match(source, /!showCreateForm[\s\S]*disabled=\{busy\}[\s\S]*Mở biểu mẫu tạo đợt giao/);
  assert.match(source, /Tạo nhóm nhận báo cáo/);
  assert.match(source, /<fieldset disabled=\{busy\}/);
  assert.match(source, /Chỉnh sửa lại/);

  // Table wrapper confines horizontal overflow cleanly and action buttons wrap instead of clipping
  assert.match(
    source,
    /role="region"[\s\S]*aria-labelledby="assignment-tracking-title"[\s\S]*tabIndex=\{0\}[\s\S]*max-w-full overflow-x-auto overscroll-x-contain/,
  );
  assert.match(source, /<th scope="col" className="px-2\.5 py-2\.5 text-left font-bold leading-tight min-w-0">Mẫu báo cáo & Đối tượng nhận<\/th>/);
  assert.match(source, /data-card-actions="true"[\s\S]*<div className="flex flex-wrap items-center justify-end gap-1\.5">/);
  assert.doesNotMatch(source, /md:flex-nowrap/);
  assert.doesNotMatch(source, /data-card-actions="true"[^>]*whitespace-nowrap/);
});

test("assignment page resolves the request actor and requires report_assign scope server-side (including delegated read-only probe)", async () => {
  const source = await readFile(assignmentPagePath, "utf8");
  assert.match(source, /resolveActorForRequest\(\)/);
  assert.match(source, /resolveWorkReportAssignmentAccessForRequest\(\)/);
  assert.match(source, /resolveWorkReportShellActorForRequest\(\)/);
  assert.match(source, /decideWorkReportAssignmentsPageAccess\(\{[\s\S]*actor,[\s\S]*hasWorkReportAssignmentAccess:[\s\S]*assignmentAccessStatus:/);
  assert.match(source, /case "TEMPORARY_UNAVAILABLE": return <TemporaryUnavailable \/>/);
  assert.match(source, /case "ACCESS_DENIED": return <AccessDenied \/>/);
  assert.doesNotMatch(source, /actor\.(?:role|title)|role_name|job_title/i);
});

test("assignment form loads scoped templates, targets, and custom cross-team groups without accepting client identity", async () => {
  const source = await readFile(assignmentManagerPath, "utf8");
  assert.match(source, /response\.status === 403/);
  assert.match(source, /WORK_REPORT_ACCESS_DENIED/);
  assert.match(source, /fetch\(`\/api\/work-reports\/assignments\$\{query\}`/);
  assert.match(source, /fetch\("\/api\/work-reports\/groups"/);
  assert.match(source, /Danh sách nhân viên được xác định từ liên kết tài khoản và thành viên nhóm hiện hành/);
  assert.doesNotMatch(source, /nhập mã định danh|UUID, cách nhau/i);
  assert.match(source, /(!teamId && targetKind !== "GROUP")/);
  assert.match(source, /<option value="GROUP">Nhóm báo cáo tùy chỉnh<\/option>/);
  assert.match(source, /target_group_id: targetKind === "GROUP" \? targetGroupId : null/);
  assert.match(source, /Ngừng sử dụng/);
  assert.doesNotMatch(source, /method:\s*"DELETE"/i);
});

test("multi-line field labels preserve line breaks across employee form renderer and read-only/review renderer", async () => {
  const formRendererSource = await readFile(rendererPath, "utf8");
  const readonlySource = await readFile(new URL("../reader/report-readonly-content.tsx", import.meta.url), "utf8");
  assert.match(formRendererSource, /<label htmlFor=\{field\.field_key\} className="block whitespace-pre-line break-words text-sm font-medium">/);
  assert.match(readonlySource, /<p className="whitespace-pre-line break-words text-sm font-medium">\{field\.label\}<\/p>/);

  const multilineSchema = structuredClone(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  multilineSchema.sections[0].fields[0].label = "Số cuộc gọi\n(trong ca trực)";
  const parsed = parseReaderDetail({
    ok: true,
    data: {
      obligation: {
        period_key: "2026-10-24",
        period_start_date: "2026-10-24",
        period_end_date: "2026-10-24",
        due_at: "2026-10-24T16:59:59Z",
        snapshot_team_display_name: "Team A",
        snapshot_team_code: "TEAM_A",
        obligation_status: "ACTIVE",
      },
      template: {
        template_code: "DAILY_V1",
        display_name: "Báo cáo ngày",
        schema_json: multilineSchema,
      },
      submission: null,
      latest_review_event: null,
      revisions: [],
    },
  });
  assert.ok(parsed, "multi-line field label passes reader detail validation");
  assert.equal(parsed.template.schema_json.sections[0].fields[0].label, "Số cuộc gọi\n(trong ca trực)");
  assert.equal(parsed.template.schema_json.sections[0].fields[0].field_key, "calls_made");
});

test("read-only value renderer covers all eight field types without raw JSON or option keys", () => {
  const selectField = { field_type: "single_select", options: [{ option_key: "opt_a", label: "Lựa chọn A" }] };
  const multiField = { field_type: "multi_select", options: [{ option_key: "opt_a", label: "A" }, { option_key: "opt_b", label: "B" }] };
  assert.equal(renderWorkReportFieldValue({ field_type: "text" }, "  giữ nguyên  "), "  giữ nguyên  ");
  assert.equal(renderWorkReportFieldValue({ field_type: "textarea" }, "dòng 1\ndòng 2"), "dòng 1\ndòng 2");
  assert.equal(renderWorkReportFieldValue({ field_type: "integer" }, 42), "42");
  assert.equal(renderWorkReportFieldValue({ field_type: "decimal" }, 3.5), "3.5");
  assert.equal(renderWorkReportFieldValue({ field_type: "date" }, "2026-10-01"), "2026-10-01");
  assert.equal(renderWorkReportFieldValue({ field_type: "boolean" }, true), "Có");
  assert.equal(renderWorkReportFieldValue({ field_type: "boolean" }, false), "Không");
  assert.equal(renderWorkReportFieldValue(selectField, "opt_a"), "Lựa chọn A");
  assert.equal(renderWorkReportFieldValue(multiField, ["opt_a", "opt_b"]), "A, B");
  assert.equal(renderWorkReportFieldValue({ field_type: "text" }, null), "—");
  assert.equal(renderWorkReportFieldValue({ field_type: "integer" }, undefined), "—");
  // Never echo a technical option key when a label exists.
  assert.equal(renderWorkReportFieldValue(selectField, "opt_a").includes("opt_a"), false);
});

test("reader detail parser fails closed on malformed schema and revisions", () => {
  const base = {
    obligation: {
      period_key: "2026-10", period_start_date: "2026-10-01", period_end_date: "2026-10-31",
      due_at: "2026-10-31T00:00:00Z", snapshot_team_display_name: null, snapshot_team_code: null,
      obligation_status: "ACTIVE",
    },
    template: { template_code: "T1", display_name: "Tên mẫu", schema_json: {} },
    submission: null,
    latest_review_event: null,
    revisions: [],
  };
  assert.equal(parseReaderDetail({ ok: true, data: base }), null, "schema_json:{} must be rejected");

  const badRevision = {
    ...base,
    template: { ...base.template, schema_json: RECRUITMENT_DAILY_TEMPLATE_SCHEMA },
    revisions: [{ revision_id: "not-a-uuid", revision_no: 1, payload_json: {}, created_at: "2026-10-01T00:00:00Z" }],
  };
  assert.equal(parseReaderDetail({ ok: true, data: badRevision }), null, "invalid revision must be rejected");

  const valid = {
    ...badRevision,
    revisions: [{ revision_id: "11111111-1111-4111-8111-111111111111", revision_no: 1, payload_json: {}, created_at: "2026-10-01T00:00:00Z" }],
  };
  assert.ok(parseReaderDetail({ ok: true, data: valid }), "valid detail projects");
});

test("shared read-only renderer reuses the model and never renders raw JSON", async () => {
  const source = await readFile(new URL("../reader/report-readonly-content.tsx", import.meta.url), "utf8");
  assert.match(source, /renderWorkReportFieldValue\(field, payload\[field\.field_key\]\)/);
  assert.match(source, /whitespace-pre-wrap break-words/);
  assert.match(source, /ReportRevisionList/);
  assert.match(source, /ReportReviewHistory/);
  assert.match(source, /Lịch sử các lần nộp/);
  assert.doesNotMatch(source, /JSON\.stringify|payload_json/);
  // The review inbox must share this single read-only path, not a second renderer.
  const inbox = await readFile(new URL("./review-inbox.tsx", import.meta.url), "utf8");
  assert.match(inbox, /ReportReadonlyContent/);
  assert.doesNotMatch(inbox, /function renderValue/);
});
