import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const HERE = new URL("./", import.meta.url);
const view = readFileSync(new URL("./dashboard-view.tsx", HERE), "utf8");
const tabs = readFileSync(new URL("./bod-dashboard-tabs.tsx", HERE), "utf8");
const leader = readFileSync(new URL("./team-dashboard-view.tsx", HERE), "utf8");
const report = readFileSync(new URL("./team-report-view.tsx", HERE), "utf8");
const detail = readFileSync(new URL("./team-entry-detail.tsx", HERE), "utf8");
const request = readFileSync(new URL("./team-report-request.ts", HERE), "utf8");
const chart = readFileSync(new URL("./team-bucket-chart.tsx", HERE), "utf8");
const server = readFileSync(new URL("../../lib/reporting/p3-w06d-team-report-server.ts", HERE), "utf8");
const core = readFileSync(new URL("../../lib/reporting/p3-w06d-team-report-core.ts", HERE), "utf8");
const route = readFileSync(new URL("../../app/api/reporting/team-report/route.ts", HERE), "utf8");
const page = readFileSync(new URL("../../app/dashboard/page.tsx", HERE), "utf8");
const nav = readFileSync(new URL("../../lib/admin/admin-navigation.ts", HERE), "utf8");
const navTest = readFileSync(new URL("../../lib/admin/admin-navigation.test.mjs", HERE), "utf8");
const accountTest = readFileSync(new URL("../admin/account-manager.test.mjs", HERE), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", HERE), "utf8"));

test("W06D: DB audience still selects the correct report body", () => {
  assert.match(view, /resolveDashboardMode\(\{ ok: report\.ok, audience \}\)/);
  assert.match(view, /mode\.kind === "team"/);
  assert.match(view, /mode\.kind === "own"/);
  assert.match(view, /<BodDashboardTabs/);
  assert.match(view, /if \(mode\.kind === "team"\)[\s\S]*?primaryTabLabel="Báo cáo theo nhóm"/);
  assert.match(view, /if \(mode\.kind === "own"\)[\s\S]*?primaryTabLabel="Tổng quan cá nhân"/);
  assert.match(tabs, /Báo cáo tổng quát/);
  assert.match(tabs, /Báo cáo theo nhóm/);
});

test("every dashboard audience gets the CCCD sibling tab without widening scoped reports", () => {
  assert.match(view, /primaryTabLabel="Báo cáo theo nhóm"/);
  assert.match(view, /primaryTabLabel="Tổng quan cá nhân"/);
  assert.match(tabs, /tab\.key === "team"\s*\?\s*primaryTabLabel === undefined/);
  assert.match(tabs, /tab\.key === "duplicate-cccd"[\s\S]*canViewDuplicateCccd/);
  assert.match(tabs, /<DuplicateCccdReportPanel \/>/);
});

test("W06D: tab URL/history and source normalization use the locked contract", () => {
  assert.match(tabs, /parseAsString/);
  for (const fragment of [
    "useQueryStates(queryParsers",
    "history: \"push\"",
    "shallow: true",
    "scroll: false",
    "needsAuthoritativeReload",
    "shallow: !needsAuthoritativeReload",
  ]) assert.ok(tabs.includes(fragment), fragment);
  assert.match(tabs, /rawTab === "duplicate-cccd" && canViewDuplicateCccd[\s\S]*: "general";/);
  assert.match(tabs, /source: next === "general" \? source : null/);
  assert.match(tabs, /history: "push", shallow: !needsAuthoritativeReload, scroll: false/);
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tabpanel"/);
  assert.match(tabs, /aria-selected/);
  assert.match(tabs, /aria-controls/);
  assert.match(tabs, /tabIndex=\{activeTab === tab\.key \? 0 : -1\}/);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) assert.ok(tabs.includes(key));
  assert.match(page, /normalizedDashboardTab/);
  assert.match(page, /params\.source !== undefined/);
  assert.match(page, /normalizedDashboardPath\(params, tab, true\)/);
  assert.match(page, /if \(key === "tab" \|\| \(removeSource && key === "source"\)/);
});

test("W06D: missing tab defaults general; repeated or malformed tab normalizes general", () => {
  assert.match(page, /type DashboardTab = "general" \| "deep" \| "team" \| "cccd-review" \| "duplicate-cccd" \| "offboarding"/);
  assert.match(page, /typeof value === "string" &&[\s\S]*value === "cccd-review" \|\| value === "duplicate-cccd" \|\| value === "offboarding"/);
  assert.match(page, /rawTab !== undefined && tab === null/);
  assert.match(page, /normalizedDashboardPath\(params, "general", false\)/);
  assert.match(page, /query\.set\("tab", tab\)/);
});

test("W06D: direct team tab with source normalizes before reporting fetch", () => {
  const normalize = page.indexOf("normalizedDashboardPath(params, tab, true)");
  const fetch = page.indexOf("fetchCutoverReporting(params, actor.actor)");
  assert.ok(normalize >= 0 && normalize < fetch);
  assert.match(page, /params\.source !== undefined/);
});

test("W06D-R2: one shared report component serves both Team Leader and BoD", () => {
  assert.match(leader, /import \{ TeamReportView, type TeamReportViewConfig \} from "\.\/team-report-view"/);
  assert.match(tabs, /import \{ TeamReportView, type TeamReportViewConfig \} from "\.\/team-report-view"/);
  assert.match(leader, /<TeamReportView/);
  assert.match(tabs, /<TeamReportView/);
  assert.doesNotMatch(leader, /TeamReportingPanel/);
  assert.doesNotMatch(tabs, /TeamReportingPanel/);
});

test("W06D-R2: 'Theo HRP/Vendor của nhóm' card is removed from the shared report", () => {
  assert.doesNotMatch(report, /Theo HRP\/Vendor của nhóm/);
  assert.doesNotMatch(report, /ProviderDonut/);
  assert.doesNotMatch(leader, /Theo HRP\/Vendor của nhóm/);
});

test("W06D-R2: picker precedes the report body and the entry-level detail is last", () => {
  const picker = report.indexOf("<TeamPicker");
  const selection = report.indexOf("<TeamReportSelection");
  const body = report.indexOf("<TeamReportBody");
  const entry = report.indexOf("<TeamEntryDetail");
  assert.ok(picker >= 0 && selection >= 0 && body >= 0 && entry >= 0,
    "picker, selection, body and detail are rendered");
  assert.ok(picker < selection && selection < body && body < entry,
    "render order: picker < selection < body < entry detail");

  const member = report.indexOf("aria-label={view.memberAriaLabel}");
  const trend = report.indexOf('aria-label="Xu hướng tuyển dụng của nhóm"');
  const project = report.indexOf('title="Theo dự án trong nhóm"');
  const employment = report.indexOf('title="Theo loại hình làm việc của nhóm"');
  assert.ok(member >= 0 && member < trend && trend < project && project < employment,
    "member < trend < project < employment");
  assert.match(report, /Danh sách chi tiết từng dòng/);
  assert.match(report, /aria-label="Danh sách nhóm báo cáo"/);
});

test("W06D-R2: Team Leader report runs on DB-scoped data with no client authority", () => {
  for (const source of [leader, report, detail, core, server]) {
    assert.doesNotMatch(source, /team_memberships|recruiter_team|Admin Catalog/);
  }
  for (const source of [leader, report, detail]) {
    assert.doesNotMatch(source, /createServiceSupabaseClient|\.rpc\(/);
  }
  assert.match(leader, /view: ScopedDashboardView/);
  assert.match(report, /data\.byTeam/);
  assert.match(report, /sortBuckets\(data\.byTeam\)/);
});

test("W06D-R2: BoD team selection loads THAT team from the authorized endpoint", () => {
  assert.match(request, /\/api\/reporting\/team-report/);
  assert.match(request, /bucket_key: bucketKey/);
  assert.doesNotMatch(request, /team-drill-down/);
  assert.match(report, /teamReportUrl\(data, bucket\.key, null\)/);
  assert.match(report, /if \(!response\.ok \|\| !isTeamReportPayload\(payload\) \|\| payload\.report === null\)/);
  // The no-selection fallback body (Team Leader path) still exists; the BoD
  // path is gated by `requireTeamSelection` (see the R3 tests below).
  assert.match(report, /<TeamReportBody data=\{data\} view=\{view\} \/>/);
});

test("W06D-R2: the server re-resolves the audience and verifies the bucket (no client audience)", () => {
  assert.match(server, /direct_entry_reporting_scoped_facts/);
  assert.match(server, /resolveReportingAudienceProjection\(payload\.audience\)/);
  assert.match(server, /authorizeBucket\(rawAudienceKind\(payload\.audience\), decoded, teamFacts\.length > 0\)/);
  assert.doesNotMatch(server, /params\.(audience|kind|dbKind)/);
  assert.match(core, /if \(dbKind === null \|\| dbKind === "own"\) return "denied";/);
  assert.match(core, /return dbKind === "all" \? "ok" : "denied";/);
  assert.match(core, /return dbKind === "team" \? "denied" : "invalid";/);
});

test("W06D-R2: the team-report route owns auth, runtime, no-store headers and status mapping", () => {
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /await guardApiSession\(\)/);
  assert.match(server, /cache-control.*private, no-store/);
  assert.match(server, /x-content-type-options.*nosniff/);
  assert.match(server, /referrer-policy.*no-referrer/);
  assert.match(server, /status: 400/);
  assert.match(server, /status: 403/);
  assert.match(server, /status: 503/);
});

test("W06D: bucket selection is accessible and internal identifiers stay off the surface", () => {
  assert.match(report, /aria-pressed=\{selectedKey === bucket\.key\}/);
  assert.match(report, /<button/);
  assert.match(report, /bucket\.display/);
  assert.match(report, /bucket\.recruitedCount/);
  assert.doesNotMatch(report, /<[^>]+>\{(?:bucket|selectedBucket)\.key\}<\/|title=\{[^}]*\.key/);
  for (const forbidden of ["team_id", "team_code", "auth_subject", "app_user_id", "entry_id", "submission_id"]) {
    assert.doesNotMatch(report, new RegExp(forbidden));
    assert.doesNotMatch(detail, new RegExp(forbidden));
  }
  assert.match(detail, /UNKNOWN_TEAM_BUCKET_KEY/);
  assert.match(detail, /\{bucket\.display\}/);
});

test("W06D: detail request uses the authorized endpoint, an opaque cursor and seven fields", () => {
  assert.match(request, /limit: "25"/);
  assert.match(request, /params\.set\("cursor", cursor\)/);
  assert.doesNotMatch(request, /params\.set\("source"/);
  for (const field of [
    "business_date", "project_display", "recruiter_display", "provider_type_display",
    "employment_type_display", "recruited_count", "first_work_date",
  ]) assert.match(detail, new RegExp(field));
  assert.match(detail, /scope="col"/);
  assert.match(detail, /<caption className="sr-only"/);
  assert.match(detail, /teamReportUrl\(data, bucket\.key, nextCursor\)/);
});

test("W06D-R2: team/filter change resets the selection and the detail rows", () => {
  assert.match(report, /selection\.signature === dataSignature/);
  assert.match(report, /setSelection\(\{ signature: dataSignature, key \}\)/);
  assert.match(report, /key=\{dataSignature \+ "\|" \+ selectedBucket\.key\}/);
  assert.match(request, /export function teamReportDataSignature/);
  assert.match(report, /\[data, bucket, reloadToken\]/);
  assert.match(report, /<TeamReportSelection/);
});

test("W06D-R3: BoD with no team selected shows only the picker and never requests a team report", () => {
  // BoD (audience `all`) must pick a team before any report body is rendered.
  assert.match(tabs, /requireTeamSelection: true/);
  assert.match(report, /requireTeamSelection: boolean/);

  const picker = report.indexOf("<TeamPicker");
  const selection = report.indexOf("<TeamReportSelection");
  const gate = report.indexOf("view.requireTeamSelection ?");
  const prompt = report.indexOf("Chọn một nhóm trong danh sách để xem báo cáo chi tiết của nhóm đó.");
  const body = report.indexOf("<TeamReportBody data={data} view={view} />");
  assert.ok(picker >= 0 && selection >= 0 && gate >= 0 && prompt >= 0 && body >= 0,
    "picker, selection, required gate, prompt and fallback body exist");
  assert.ok(picker < selection && selection < gate && gate < prompt && prompt < body,
    "render order: picker < selection < required gate < prompt < fallback body");

  // The only team-report fetch lives inside TeamReportSelection, which is
  // rendered exclusively when a bucket is selected -> no request without one.
  const fetchCall = report.indexOf("fetch(teamReportUrl(data, bucket.key, null)");
  assert.ok(fetchCall >= 0 && report.indexOf("function TeamReportSelection(") < fetchCall);
  assert.ok(fetchCall > gate, "the fetch sits behind the selection gate");

  // A required-selection view never auto-selects a single bucket.
  assert.match(report, /!view\.requireTeamSelection && buckets\.length === 1/);
});

test("W06D-R3: selecting a team replaces the audience payload with that team's report", () => {
  assert.match(report, /<TeamReportBody data=\{report\} view=\{view\} \/>/);
  assert.match(report, /setReport\(payload\.report\)/);
  assert.match(report, /setDetail\(payload\.detail\)/);
  assert.match(report, /if \(!response\.ok \|\| !isTeamReportPayload\(payload\) \|\| payload\.report === null\)/);
});

test("W06D-R3: a filter change resets the selection so the team body disappears", () => {
  assert.match(report, /selection !== null && selection\.signature === dataSignature/);
  assert.match(report, /key=\{dataSignature \+ "\|" \+ selectedBucket\.key\}/);
  assert.match(report, /\[data, bucket, reloadToken\]/);
  assert.match(report, /if \(report === null \|\| detail === null\) \{\s*return <p role="status">Đang tải báo cáo nhóm…<\/p>;/);
});

test("W06D-R3: the Team Leader keeps the audience-scoped report (no selection gate)", () => {
  assert.match(leader, /requireTeamSelection: false/);
  assert.doesNotMatch(leader, /requireTeamSelection: true/);
});

test("W06D-R3: the offboarding tab follows CCCD and both panels stay server-gated", () => {
  assert.match(tabs, /\{ key: "duplicate-cccd", label: "Báo cáo CCCD trùng", panelId: "bod-panel-duplicate-cccd" \}/);
  assert.match(tabs, /\{ key: "offboarding", label: "Báo cáo NLĐ nghỉ việc", panelId: "bod-panel-offboarding" \}/);
  assert.ok(tabs.indexOf('key: "duplicate-cccd"') < tabs.indexOf('key: "offboarding"'));
  assert.match(tabs, /<DuplicateCccdReportPanel \/>/);
  assert.match(tabs, /<OffboardingReportPanel \/>/);
  assert.match(tabs, /canViewDuplicateCccd/);
  assert.match(tabs, /canViewOffboarding/);
  assert.match(tabs, /tab\.key === "duplicate-cccd"[\s\S]*canViewDuplicateCccd/);
  assert.match(tabs, /id="bod-panel-duplicate-cccd"/);
  assert.match(tabs, /id="bod-panel-offboarding"/);
});

test("W06D: unknown split, load-more/end and retry are explicit", () => {
  assert.match(detail, /Tổng hợp từ dữ liệu cũ \(tổng hợp theo ngày, không phải entry-level\)/);
  assert.match(detail, /Anomaly Direct Entry \(không gán được team\)/);
  assert.match(detail, /Không tải được chi tiết nhóm/);
  assert.match(detail, /Thử tải lại/);
  assert.match(detail, /Chưa có dòng chi tiết/);
  assert.match(detail, /Đang tải thêm/);
  assert.match(detail, /Tải thêm/);
  assert.match(detail, /Đã hiển thị hết kết quả/);
  assert.match(detail, /requestId\.current/);
  assert.match(detail, /AbortController/);
  assert.match(detail, /useNotify\(\)/);
  assert.doesNotMatch(detail, /IntersectionObserver|setInterval|setTimeout/);
  assert.match(report, /Đang tải báo cáo nhóm/);
  assert.match(report, /Không tải được báo cáo nhóm/);
});

test("W06D: mobile contract uses bounded inner table overflow, not body-level overflow", () => {
  assert.match(detail, /overflow-x-auto/);
  assert.doesNotMatch(detail, /overflow-x-scroll|w-screen|min-w-screen|fixed inset-0/);
  assert.match(chart, /grid-cols-1/);
});

test("W06D: approved Admin navigation labels are exact and routes remain unchanged", () => {
  assert.match(nav, /id: "personnel", label: "Hồ sơ tính công tuyển dụng", href: "\/admin\/catalog\/personnel"/);
  assert.match(nav, /id: "organization-persons", label: "Nhân sự nội bộ", href: "\/admin\/organization\/persons"/);
  assert.match(nav, /id: "accounts", label: "Tài khoản truy cập", href: "\/admin\/access\/accounts"/);
  assert.match(navTest, /Hồ sơ tính công tuyển dụng/);
  assert.match(navTest, /Nhân sự nội bộ/);
  assert.match(navTest, /Tài khoản truy cập/);
  assert.match(accountTest, /label: "Tài khoản truy cập"/);
});

test("W06D: focused lane is registered once and canonical test invokes it once", () => {
  assert.ok(packageJson.scripts["test:p3-w06d"]);
  assert.match(packageJson.scripts["test:p3-w06d"], /team-reporting-ui\.test\.mjs/);
  assert.match(packageJson.scripts["test:p3-w06d"], /p3-w06d-team-report-core\.test\.mjs/);
  const occurrences = packageJson.scripts.test.match(/test:p3-w06d/g) ?? [];
  assert.equal(occurrences.length, 1);
});
