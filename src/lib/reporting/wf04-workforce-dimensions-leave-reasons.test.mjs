import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CANONICAL_LEAVE_REASON_CATALOG,
  classifyLeaveReasonCategory,
  deriveWorkforceAttentionInsights,
  evaluateWorkforceSnapshotAndTransitions,
  formatCoverageRatePercent,
  formatShareRatePercent,
  parseWorkforceOverviewPayload,
  parseWorkforceProjectPagePayload,
  parseWorkforceReportingPayload,
  resolveWorkforceDeepReportingForActor,
  resolveWorkforceOverviewForActor,
  resolveWorkforceProjectPageForActor,
  WORKFORCE_DIMENSION_ATTRIBUTION_NOTE,
  WORKFORCE_DIMENSION_KIND_LABELS,
  WORKFORCE_HIGHLIGHT_MIN_SAMPLE_SIZE,
  WORKFORCE_LEAVE_REASON_CATEGORY_LABELS,
  WORKFORCE_LEAVE_REASON_STANDARDIZATION_NOTE,
  WORKFORCE_PROJECT_DEFAULT_PAGE_SIZE,
} from "./wf04-workforce-dimensions-leave-reasons.ts";
import { canViewDeepWorkforceReport } from "../auth/direct-entry-page-access.ts";

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

test("WF-04 (1): 2.7 Dimensional quality reconciles 100% with snapshot, waiting, duration, and retention across all 4 dimensions (including inactive teams & unknown buckets)", () => {
  const episodes = [
    // Ep 1: Project A, Team Alpha (active), Recruiter 1, Provider HRP -> ON (2026-06-01), still ON at 2026-10-15 (matured D7, D30, D90)
    {
      entry_id: uuid(1),
      first_work_date: "2026-06-01",
      submission_state: "SUBMITTED",
      deleted_at: null,
      voided_at: null,
      project_key: "prj-a",
      project_display: "PRJ-A · Dự án Alpha",
      recruiter_key: "rec-1",
      recruiter_display: "Nguyễn Tuyển Dụng 1",
      team_code: "TEAM-ALPHA",
      team_display_name: "Nhóm Tuyển Dụng 1",
      team_active: true,
      provider_key: "hrp",
    },
    // Ep 2: Project A, Team Beta (INACTIVE), Recruiter 1, Provider HRP -> UNCONFIRMED (2026-09-01) -> ON (2026-09-06) -> OFF (2026-09-20, day 14 of ON: retained D7, exited D30)
    {
      entry_id: uuid(2),
      first_work_date: "2026-09-01",
      submission_state: "SUBMITTED",
      deleted_at: null,
      voided_at: null,
      project_key: "prj-a",
      project_display: "PRJ-A · Dự án Alpha",
      recruiter_key: "rec-1",
      recruiter_display: "Nguyễn Tuyển Dụng 1",
      team_code: "TEAM-BETA",
      team_display_name: "Nhóm Cũ Beta",
      team_active: false,
      provider_key: "hrp",
    },
    // Ep 3: Missing all dimensions (unknown) -> UNCONFIRMED (2026-10-10), still waiting at 2026-10-15
    {
      entry_id: uuid(3),
      first_work_date: "2026-10-10",
      submission_state: "SUBMITTED",
      deleted_at: null,
      voided_at: null,
      project_key: null,
      recruiter_key: null,
      team_code: null,
      provider_key: null,
    },
    // Ep 4: Project B, Team Alpha, Recruiter 2, Provider Vendor -> Eligible at 2026-10-15 but no events yet (unknown status)
    {
      entry_id: uuid(4),
      first_work_date: "2026-10-12",
      submission_state: "SUBMITTED",
      deleted_at: null,
      voided_at: null,
      project_key: "prj-b",
      project_display: "PRJ-B · Dự án Beta",
      recruiter_key: "rec-2",
      recruiter_display: "Trần Tuyển Dụng 2",
      team_code: "TEAM-ALPHA",
      team_display_name: "Nhóm Tuyển Dụng 1",
      team_active: true,
      provider_key: "vendor",
    },
  ];

  const events = [
    { event_id: uuid(101), entry_id: uuid(1), status: "ON", effective_date: "2026-06-01", version: 1 },
    { event_id: uuid(201), entry_id: uuid(2), status: "UNCONFIRMED", effective_date: "2026-09-01", version: 1 },
    { event_id: uuid(202), entry_id: uuid(2), status: "ON", effective_date: "2026-09-06", version: 2 },
    {
      event_id: uuid(203),
      entry_id: uuid(2),
      status: "OFF",
      effective_date: "2026-09-20",
      version: 3,
      leave_reason_text: "Về quê chăm gia đình",
    },
    { event_id: uuid(301), entry_id: uuid(3), status: "UNCONFIRMED", effective_date: "2026-10-10", version: 1 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  const { snapshot, waiting, duration, retention, dimensions } = res;
  assert.equal(dimensions.eligibleEpisodeTotal, 4);

  for (const group of [
    dimensions.byProject,
    dimensions.byTeam,
    dimensions.byRecruiter,
    dimensions.byProvider,
  ]) {
    assert.equal(group.eligibleEpisodeTotal, snapshot.eligibleEpisodeTotal);
    assert.equal(group.knownEpisodeCount + group.unknownEpisodeCount, snapshot.eligibleEpisodeTotal);
    assert.equal(group.knownEpisodeCount, 3);
    assert.equal(group.unknownEpisodeCount, 1);

    const sumEligible = group.buckets.reduce((acc, b) => acc + b.eligibleEpisodeCount, 0);
    const sumOn = group.buckets.reduce((acc, b) => acc + b.onCount, 0);
    const sumWait = group.buckets.reduce((acc, b) => acc + b.unconfirmedCount, 0);
    const sumOff = group.buckets.reduce((acc, b) => acc + b.offCount, 0);
    const sumUnk = group.buckets.reduce((acc, b) => acc + b.unknownCount, 0);
    const sumWaitingEp = group.buckets.reduce((acc, b) => acc + b.waitingEpisodeCount, 0);
    const sumPlaced = group.buckets.reduce((acc, b) => acc + b.placedToOnEpisodeCount, 0);
    const sumWaitingDays = group.buckets.reduce((acc, b) => acc + b.totalWaitingDays, 0);
    const sumEverOn = group.buckets.reduce((acc, b) => acc + b.everOnEpisodeCount, 0);
    const sumOnDays = group.buckets.reduce((acc, b) => acc + b.totalOnDays, 0);
    const sumD7Matured = group.buckets.reduce((acc, b) => acc + b.checkpoints.d7.maturedCount, 0);
    const sumD30Matured = group.buckets.reduce((acc, b) => acc + b.checkpoints.d30.maturedCount, 0);
    const sumD90Matured = group.buckets.reduce((acc, b) => acc + b.checkpoints.d90.maturedCount, 0);

    assert.equal(sumEligible, snapshot.eligibleEpisodeTotal);
    assert.equal(sumOn, snapshot.onCount);
    assert.equal(sumWait, snapshot.unconfirmedCount);
    assert.equal(sumOff, snapshot.offCount);
    assert.equal(sumUnk, snapshot.unknownCount);
    assert.equal(sumWaitingEp, waiting.waitingEpisodeTotal);
    assert.equal(sumPlaced, waiting.placedToOn.episodeCount);
    assert.equal(sumWaitingDays, waiting.allWaiting.totalWaitingDays);
    assert.equal(sumEverOn, duration.everOnEpisodeCount);
    assert.equal(sumOnDays, duration.allEverOn.totalOnDays);
    assert.equal(sumD7Matured, retention.checkpoints.d7.maturedCount);
    assert.equal(sumD30Matured, retention.checkpoints.d30.maturedCount);
    assert.equal(sumD90Matured, retention.checkpoints.d90.maturedCount);
  }

  // Verify inactive team keeps historical attribution and displays '(Ngừng hoạt động)'
  const inactiveTeamBucket = dimensions.byTeam.buckets.find((b) => b.key === "team-beta");
  assert.ok(inactiveTeamBucket);
  assert.equal(inactiveTeamBucket.active, false);
  assert.equal(inactiveTeamBucket.display, "Nhóm Cũ Beta (Ngừng hoạt động)");
  assert.equal(inactiveTeamBucket.offCount, 1);

  // Verify unknown bucket is last and labeled 'Không xác định'
  const unknownProjectBucket = dimensions.byProject.buckets.at(-1);
  assert.ok(unknownProjectBucket);
  assert.equal(unknownProjectBucket.key, "unknown");
  assert.equal(unknownProjectBucket.isUnknown, true);
  assert.equal(unknownProjectBucket.display, "Không xác định");
  assert.equal(unknownProjectBucket.unconfirmedCount, 1);
});

test("WF-04 (2): 2.8 Leave reason classification, supersession filtering, ON->OFF vs UNCONFIRMED->OFF split, and zero raw-text leakage", () => {
  // Direct unit check on classifyLeaveReasonCategory across all 10 canonical buckets
  assert.equal(classifyLeaveReasonCategory("Về quê chăm con nhỏ"), "personal_or_family");
  assert.equal(classifyLeaveReasonCategory("Ốm đau nằm viện điều trị"), "health");
  assert.equal(classifyLeaveReasonCategory("Chê lương thấp, phụ cấp ít"), "compensation_or_benefits");
  assert.equal(classifyLeaveReasonCategory("Không quen làm ca đêm, công việc áp lực"), "work_conditions_or_shift");
  assert.equal(classifyLeaveReasonCategory("Nhà xa chỗ làm, không có xe đưa đón"), "relocation_or_distance");
  assert.equal(classifyLeaveReasonCategory("Hết hợp đồng thời vụ cuối dự án"), "contract_or_project_end");
  assert.equal(classifyLeaveReasonCategory("Vi phạm nội quy, tự ý bỏ việc"), "discipline_or_performance");
  assert.equal(classifyLeaveReasonCategory("Xin nghỉ để đi học nghề khác"), "other_career_or_study");
  assert.equal(classifyLeaveReasonCategory("Không thích màu áo đồng phục"), "unclassified_free_text");
  assert.equal(classifyLeaveReasonCategory("   "), "missing_or_unknown");
  assert.equal(classifyLeaveReasonCategory(null), "missing_or_unknown");

  const episodes = [
    // Ep 1: ON -> OFF (superseded with 'Lương thấp') -> OFF (replacement with 'Về quê cưới vợ') -> should classify as personal_or_family!
    { entry_id: uuid(1), first_work_date: "2026-10-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 2: UNCONFIRMED -> OFF (without ever entering ON) with free text not matching standard keywords -> unclassified_free_text, fromUnconfirmedWithoutOnCount = 1
    { entry_id: uuid(2), first_work_date: "2026-10-02", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 3: ON -> OFF with null reason -> missing_or_unknown
    { entry_id: uuid(3), first_work_date: "2026-10-03", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 4: ON (10-01) -> OFF (10-05, 'Ốm đau') -> ON (10-10):
    //       At asOf 2026-10-15, Ep 4 is ON (so NOT in as_of offEpisodeTotal),
    //       but its 10-05 ON->OFF transition IS in period [2026-10-01 .. 2026-10-15]!
    { entry_id: uuid(4), first_work_date: "2026-10-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
  ];

  const events = [
    { event_id: uuid(101), entry_id: uuid(1), status: "ON", effective_date: "2026-10-01", version: 1 },
    {
      event_id: uuid(102),
      entry_id: uuid(1),
      status: "OFF",
      effective_date: "2026-10-08",
      version: 2,
      leave_reason_text: "Chê lương thấp",
    },
    {
      event_id: uuid(103),
      entry_id: uuid(1),
      status: "OFF",
      effective_date: "2026-10-08",
      version: 3,
      supersedes_event_id: uuid(102),
      leave_reason_text: "Về quê chăm sóc gia đình",
    },

    { event_id: uuid(201), entry_id: uuid(2), status: "UNCONFIRMED", effective_date: "2026-10-02", version: 1 },
    {
      event_id: uuid(202),
      entry_id: uuid(2),
      status: "OFF",
      effective_date: "2026-10-09",
      version: 2,
      leave_reason_text: "Ghi chú riêng không thuộc từ khóa chuẩn",
    },

    { event_id: uuid(301), entry_id: uuid(3), status: "ON", effective_date: "2026-10-03", version: 1 },
    {
      event_id: uuid(302),
      entry_id: uuid(3),
      status: "OFF",
      effective_date: "2026-10-11",
      version: 2,
      leave_reason_text: null,
    },

    { event_id: uuid(401), entry_id: uuid(4), status: "ON", effective_date: "2026-10-01", version: 1 },
    {
      event_id: uuid(402),
      entry_id: uuid(4),
      status: "OFF",
      effective_date: "2026-10-05",
      version: 2,
      leave_reason_text: "Bị ốm phải nghỉ điều trị",
    },
    { event_id: uuid(403), entry_id: uuid(4), status: "ON", effective_date: "2026-10-10", version: 3 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  const lr = res.leaveReasons;
  assert.equal(lr.offEpisodeTotal, 3); // Ep 1, Ep 2, Ep 3 (Ep 4 is ON at 2026-10-15)
  assert.equal(lr.withReasonEpisodeCount, 2); // Ep 1 & Ep 2
  assert.equal(lr.standardizedEpisodeCount, 1); // Ep 1 (personal_or_family; superseded compensation event 102 is ignored!)
  assert.equal(lr.unclassifiedFreeTextEpisodeCount, 1); // Ep 2
  assert.equal(lr.missingReasonEpisodeCount, 1); // Ep 3
  assert.equal(lr.reasonCoverageRate, 2 / 3);
  assert.equal(lr.standardizationRate, 1 / 2);

  const byKey = new Map(lr.byCategory.map((c) => [c.key, c]));
  assert.equal(byKey.get("compensation_or_benefits").episodeCount, 0); // Superseded event 102 excluded!
  assert.equal(byKey.get("personal_or_family").episodeCount, 1);
  assert.equal(byKey.get("personal_or_family").fromOnCount, 1);
  assert.equal(byKey.get("personal_or_family").fromUnconfirmedWithoutOnCount, 0);

  assert.equal(byKey.get("unclassified_free_text").episodeCount, 1);
  assert.equal(byKey.get("unclassified_free_text").fromOnCount, 0);
  assert.equal(byKey.get("unclassified_free_text").fromUnconfirmedWithoutOnCount, 1);

  assert.equal(byKey.get("missing_or_unknown").episodeCount, 1);
  assert.equal(byKey.get("missing_or_unknown").fromOnCount, 1);

  // Period leave reasons in [2026-10-01 .. 2026-10-15] includes Ep 4's 10-05 OFF transition!
  assert.equal(lr.periodLeaveReasons.applicable, true);
  if (lr.periodLeaveReasons.applicable) {
    assert.equal(lr.periodLeaveReasons.offTransitionEventTotal, 4); // Ep 1, 2, 3, 4
    assert.equal(lr.periodLeaveReasons.offTransitionEpisodeTotal, 4);
    assert.equal(lr.periodLeaveReasons.onToOffEventTotal, 3); // Ep 1, 3, 4
    assert.equal(lr.periodLeaveReasons.unconfirmedToOffEventTotal, 1); // Ep 2
    assert.equal(lr.periodLeaveReasons.withReasonEventCount, 3); // Ep 1, 2, 4
    assert.equal(lr.periodLeaveReasons.standardizedEventCount, 2); // Ep 1 (personal), Ep 4 (health)
    assert.equal(lr.periodLeaveReasons.unclassifiedFreeTextEventCount, 1); // Ep 2
    assert.equal(lr.periodLeaveReasons.missingReasonEventCount, 1); // Ep 3

    const periodHealth = lr.periodLeaveReasons.byCategory.find((c) => c.key === "health");
    assert.equal(periodHealth.eventCount, 1);
    assert.equal(periodHealth.onToOffEventCount, 1);
  }

  // Ensure no raw free-text string is leaked anywhere in the serialized result
  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes("Về quê chăm sóc gia đình"));
  assert.ok(!serialized.includes("Ghi chú riêng không thuộc từ khóa chuẩn"));
  assert.ok(!serialized.includes("Bị ốm phải nghỉ điều trị"));
});

test("WF-04 (3): Deterministic 'Điểm cần chú ý' (deriveWorkforceAttentionInsights) enforces minimum sample size guard (>= 3) and never misleads from 1-episode buckets", () => {
  // Case A: Small sample (< 3 episodes in project) -> triggers sample guard instead of claiming a 1-episode project has worst D30 retention
  const smallSampleRes = evaluateWorkforceSnapshotAndTransitions({
    episodes: [
      {
        entry_id: uuid(1),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-1",
        project_display: "PRJ-1 · Dự án Mẫu Nhỏ",
      },
    ],
    events: [
      { event_id: uuid(101), entry_id: uuid(1), status: "ON", effective_date: "2026-06-01", version: 1 },
      { event_id: uuid(102), entry_id: uuid(1), status: "OFF", effective_date: "2026-06-05", version: 2 },
    ],
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  const smallInsights = deriveWorkforceAttentionInsights({ status: "ready", ...smallSampleRes });
  const d30GuardInsight = smallInsights.find((i) => i.id === "d30-retention-sample-guard");
  assert.ok(
    d30GuardInsight,
    "Must emit d30-retention-sample-guard when no dimension bucket has >= 3 matured D30 episodes",
  );
  assert.ok(d30GuardInsight.detail.includes(`≥ ${WORKFORCE_HIGHLIGHT_MIN_SAMPLE_SIZE}`));

  // Case B: Project Alpha has 3 matured D30 episodes (1 retained, 2 exited => 33,3%), Project Beta has 1 matured episode (0 retained => 0%).
  //         Must pick Project Alpha (matured = 3 >= 3), NOT Project Beta (matured = 1 < 3)!
  const qualifiedRes = evaluateWorkforceSnapshotAndTransitions({
    episodes: [
      {
        entry_id: uuid(1),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-a",
        project_display: "PRJ-A · Dự án Đủ Mẫu Alpha",
        team_code: "TEAM-1",
        team_display_name: "Nhóm 1",
        team_active: true,
      },
      {
        entry_id: uuid(2),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-a",
        project_display: "PRJ-A · Dự án Đủ Mẫu Alpha",
        team_code: "TEAM-1",
        team_display_name: "Nhóm 1",
        team_active: true,
      },
      {
        entry_id: uuid(3),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-a",
        project_display: "PRJ-A · Dự án Đủ Mẫu Alpha",
        team_code: "TEAM-2",
        team_display_name: "Nhóm 2",
        team_active: true,
      },
      {
        entry_id: uuid(4),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-b",
        project_display: "PRJ-B · Dự án Một Người Beta",
        team_code: "TEAM-2",
        team_display_name: "Nhóm 2",
        team_active: true,
      },
    ],
    events: [
      { event_id: uuid(101), entry_id: uuid(1), status: "ON", effective_date: "2026-06-01", version: 1 },
      { event_id: uuid(201), entry_id: uuid(2), status: "ON", effective_date: "2026-06-01", version: 1 },
      { event_id: uuid(202), entry_id: uuid(2), status: "OFF", effective_date: "2026-06-10", version: 2, leave_reason_text: "Lương thấp" },
      { event_id: uuid(301), entry_id: uuid(3), status: "ON", effective_date: "2026-06-01", version: 1 },
      { event_id: uuid(302), entry_id: uuid(3), status: "OFF", effective_date: "2026-06-12", version: 2, leave_reason_text: "Thu nhập thấp" },
      { event_id: uuid(401), entry_id: uuid(4), status: "ON", effective_date: "2026-06-01", version: 1 },
      { event_id: uuid(402), entry_id: uuid(4), status: "OFF", effective_date: "2026-06-05", version: 2, leave_reason_text: "Lương không đủ" },
    ],
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  const qualifiedInsights = deriveWorkforceAttentionInsights({ status: "ready", ...qualifiedRes });
  const d30Focus = qualifiedInsights.find((i) => i.id === "d30-retention-focus");
  assert.ok(d30Focus);
  assert.ok(d30Focus.title.includes("PRJ-A · Dự án Đủ Mẫu Alpha"));
  assert.ok(!d30Focus.title.includes("Dự án Một Người Beta"));

  const leaveTop = qualifiedInsights.find((i) => i.id === "leave-reason-top");
  assert.ok(leaveTop);
  assert.ok(leaveTop.title.includes(WORKFORCE_LEAVE_REASON_CATEGORY_LABELS.compensation_or_benefits));

  // Case C (Regression Blocker 1 — Cross-dimension D30 retention):
  // Both a Project (PRJ-ALPHA: 2/3 retained = 66,7%) and a Team (Nhóm Cần Lưu Ý: 1/3 retained = 33,3%)
  // pass the minimum sample guard (>= 3), and the Team has a strictly lower D30 retention rate than the Project.
  // Result MUST select the Team ("Nhóm"), NOT the Project just because Project is evaluated first.
  const crossDimD30Res = evaluateWorkforceSnapshotAndTransitions({
    episodes: [
      {
        entry_id: uuid(11),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-alpha",
        project_display: "PRJ-ALPHA · Dự án Alpha",
        team_code: "TEAM-CORE",
        team_display_name: "Nhóm Core",
        team_active: true,
      },
      {
        entry_id: uuid(12),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-alpha",
        project_display: "PRJ-ALPHA · Dự án Alpha",
        team_code: "TEAM-RISK",
        team_display_name: "Nhóm Cần Lưu Ý",
        team_active: true,
      },
      {
        entry_id: uuid(13),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-alpha",
        project_display: "PRJ-ALPHA · Dự án Alpha",
        team_code: "TEAM-RISK",
        team_display_name: "Nhóm Cần Lưu Ý",
        team_active: true,
      },
      {
        entry_id: uuid(14),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-beta",
        project_display: "PRJ-BETA · Dự án Beta",
        team_code: "TEAM-CORE",
        team_display_name: "Nhóm Core",
        team_active: true,
      },
      {
        entry_id: uuid(15),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-beta",
        project_display: "PRJ-BETA · Dự án Beta",
        team_code: "TEAM-CORE",
        team_display_name: "Nhóm Core",
        team_active: true,
      },
      {
        entry_id: uuid(16),
        first_work_date: "2026-06-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-beta",
        project_display: "PRJ-BETA · Dự án Beta",
        team_code: "TEAM-RISK",
        team_display_name: "Nhóm Cần Lưu Ý",
        team_active: true,
      },
    ],
    events: [
      // Ep 11 (prj-alpha, TEAM-CORE): retained D30
      { event_id: uuid(1101), entry_id: uuid(11), status: "ON", effective_date: "2026-06-01", version: 1 },
      // Ep 12 (prj-alpha, TEAM-RISK): exited before D30
      { event_id: uuid(1201), entry_id: uuid(12), status: "ON", effective_date: "2026-06-01", version: 1 },
      { event_id: uuid(1202), entry_id: uuid(12), status: "OFF", effective_date: "2026-06-10", version: 2, leave_reason_text: "Lương thấp" },
      // Ep 13 (prj-alpha, TEAM-RISK): retained D30
      { event_id: uuid(1301), entry_id: uuid(13), status: "ON", effective_date: "2026-06-01", version: 1 },
      // Ep 14 (prj-beta, TEAM-CORE): retained D30
      { event_id: uuid(1401), entry_id: uuid(14), status: "ON", effective_date: "2026-06-01", version: 1 },
      // Ep 15 (prj-beta, TEAM-CORE): retained D30
      { event_id: uuid(1501), entry_id: uuid(15), status: "ON", effective_date: "2026-06-01", version: 1 },
      // Ep 16 (prj-beta, TEAM-RISK): exited before D30
      { event_id: uuid(1601), entry_id: uuid(16), status: "ON", effective_date: "2026-06-01", version: 1 },
      { event_id: uuid(1602), entry_id: uuid(16), status: "OFF", effective_date: "2026-06-12", version: 2, leave_reason_text: "Lương thấp" },
    ],
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  const crossDimD30Insights = deriveWorkforceAttentionInsights({
    status: "ready",
    ...crossDimD30Res,
  });
  const crossDimD30Focus = crossDimD30Insights.find((i) => i.id === "d30-retention-focus");
  assert.ok(crossDimD30Focus);
  assert.equal(
    crossDimD30Focus.title,
    "Nhóm có tỷ lệ duy trì D30 thấp nhất: Nhóm Cần Lưu Ý (33,3%)",
  );
  assert.ok(
    crossDimD30Focus.detail.includes("Duy trì liên tục 1/3 đợt đã đủ tuổi D30 (rời sớm 2 đợt"),
  );
  assert.ok(!crossDimD30Focus.title.includes("Dự án"));

  // Case D (Regression Blocker 2 — Cross-dimension Waiting duration):
  // Both a Team (Nhóm Tuyển Dụng 2: 3 waiting episodes, avg 7,3 ngày) and a Project (PRJ-SLOW · Dự án Chờ Lâu: 3 waiting episodes, avg 10,0 ngày)
  // pass the minimum sample guard (>= 3), and the Project has a strictly higher average waiting duration than the Team.
  // Result MUST select the Project ("Dự án"), NOT the Team just because Team is evaluated first.
  const crossDimWaitingRes = evaluateWorkforceSnapshotAndTransitions({
    episodes: [
      {
        entry_id: uuid(21),
        first_work_date: "2026-10-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-fast",
        project_display: "PRJ-FAST · Dự án Nhanh",
        team_code: "TEAM-1",
        team_display_name: "Nhóm Tuyển Dụng 1",
        team_active: true,
      },
      {
        entry_id: uuid(22),
        first_work_date: "2026-10-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-slow",
        project_display: "PRJ-SLOW · Dự án Chờ Lâu",
        team_code: "TEAM-1",
        team_display_name: "Nhóm Tuyển Dụng 1",
        team_active: true,
      },
      {
        entry_id: uuid(23),
        first_work_date: "2026-10-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-slow",
        project_display: "PRJ-SLOW · Dự án Chờ Lâu",
        team_code: "TEAM-2",
        team_display_name: "Nhóm Tuyển Dụng 2",
        team_active: true,
      },
      {
        entry_id: uuid(24),
        first_work_date: "2026-10-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-fast",
        project_display: "PRJ-FAST · Dự án Nhanh",
        team_code: "TEAM-1",
        team_display_name: "Nhóm Tuyển Dụng 1",
        team_active: true,
      },
      {
        entry_id: uuid(25),
        first_work_date: "2026-10-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-fast",
        project_display: "PRJ-FAST · Dự án Nhanh",
        team_code: "TEAM-2",
        team_display_name: "Nhóm Tuyển Dụng 2",
        team_active: true,
      },
      {
        entry_id: uuid(26),
        first_work_date: "2026-10-01",
        submission_state: "SUBMITTED",
        deleted_at: null,
        voided_at: null,
        project_key: "prj-slow",
        project_display: "PRJ-SLOW · Dự án Chờ Lâu",
        team_code: "TEAM-2",
        team_display_name: "Nhóm Tuyển Dụng 2",
        team_active: true,
      },
    ],
    events: [
      // Ep 21 (prj-fast, TEAM-1): 2 waiting days
      { event_id: uuid(2101), entry_id: uuid(21), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1 },
      { event_id: uuid(2102), entry_id: uuid(21), status: "ON", effective_date: "2026-10-03", version: 2 },
      // Ep 22 (prj-slow, TEAM-1): 10 waiting days
      { event_id: uuid(2201), entry_id: uuid(22), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1 },
      { event_id: uuid(2202), entry_id: uuid(22), status: "ON", effective_date: "2026-10-11", version: 2 },
      // Ep 23 (prj-slow, TEAM-2): 10 waiting days
      { event_id: uuid(2301), entry_id: uuid(23), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1 },
      { event_id: uuid(2302), entry_id: uuid(23), status: "ON", effective_date: "2026-10-11", version: 2 },
      // Ep 24 (prj-fast, TEAM-1): 2 waiting days
      { event_id: uuid(2401), entry_id: uuid(24), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1 },
      { event_id: uuid(2402), entry_id: uuid(24), status: "ON", effective_date: "2026-10-03", version: 2 },
      // Ep 25 (prj-fast, TEAM-2): 2 waiting days
      { event_id: uuid(2501), entry_id: uuid(25), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1 },
      { event_id: uuid(2502), entry_id: uuid(25), status: "ON", effective_date: "2026-10-03", version: 2 },
      // Ep 26 (prj-slow, TEAM-2): 10 waiting days
      { event_id: uuid(2601), entry_id: uuid(26), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1 },
      { event_id: uuid(2602), entry_id: uuid(26), status: "ON", effective_date: "2026-10-11", version: 2 },
    ],
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  const crossDimWaitingInsights = deriveWorkforceAttentionInsights({
    status: "ready",
    ...crossDimWaitingRes,
  });
  const crossDimWaitingFocus = crossDimWaitingInsights.find(
    (i) => i.id === "waiting-duration-focus",
  );
  assert.ok(crossDimWaitingFocus);
  assert.equal(
    crossDimWaitingFocus.title,
    "Dự án có thời gian chờ trung bình cao nhất: PRJ-SLOW · Dự án Chờ Lâu (10 ngày)",
  );
  assert.ok(
    crossDimWaitingFocus.detail.includes(
      "Tổng 30 ngày chờ trên 3 đợt từng chờ việc (hiện còn chờ 0 đợt",
    ),
  );
  assert.ok(!crossDimWaitingFocus.title.includes("Nhóm"));
});

test("WF-04 (4): Fail-closed payload validation rejects broken dimension reconciliation, duplicate bucket keys, or raw leave reason leaks", () => {
  const validBucket = {
    key: "b1",
    display: "Bucket 1",
    is_unknown: false,
    active: true,
    eligible_episode_count: 1,
    on_count: 0,
    unconfirmed_count: 0,
    off_count: 1,
    unknown_count: 0,
    waiting_episode_count: 0,
    completed_waiting_episode_count: 0,
    placed_to_on_episode_count: 0,
    exited_without_on_episode_count: 0,
    currently_waiting_episode_count: 0,
    total_waiting_days: 0,
    ever_on_episode_count: 1,
    never_on_episode_count: 0,
    continuously_retained_count: 0,
    exited_from_on_count: 1,
    total_on_days: 10,
    checkpoints: {
      d7: { checkpoint_days: 7, matured_count: 1, immature_count: 0, retained_count: 1, exited_count: 0 },
      d30: { checkpoint_days: 30, matured_count: 1, immature_count: 0, retained_count: 0, exited_count: 1 },
      d90: { checkpoint_days: 90, matured_count: 1, immature_count: 0, retained_count: 0, exited_count: 1 },
    },
  };

  const basePayload = {
    snapshot: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 1,
      on_count: 0,
      unconfirmed_count: 0,
      off_count: 1,
      unknown_count: 0,
      future_episode_count: 0,
    },
    transitions: { applicable: false, reason: "all_time", from_date: null, to_date: null },
    balance: { applicable: false, reason: "all_time", from_date: null, to_date: null },
    waiting: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 1,
      waiting_episode_total: 0,
      direct_on_episode_count: 1,
      direct_off_episode_count: 0,
      unknown_episode_count: 0,
      all_waiting: { episode_count: 0, interval_count: 0, total_waiting_days: 0, max_waiting_days: null },
      completed_waiting: { episode_count: 0, interval_count: 0, total_waiting_days: 0, max_waiting_days: null },
      placed_to_on: { episode_count: 0, interval_count: 0, total_waiting_days: 0, max_waiting_days: null },
      exited_without_on: { episode_count: 0, interval_count: 0, total_waiting_days: 0, max_waiting_days: null },
      currently_waiting: { episode_count: 0, interval_count: 0, total_waiting_days: 0, max_waiting_days: null },
      period_waiting: { applicable: false, reason: "all_time", from_date: null, to_date: null },
    },
    duration: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 1,
      known_status_episode_count: 1,
      unknown_status_episode_count: 0,
      ever_on_episode_count: 1,
      never_on_episode_count: 0,
      all_ever_on: { episode_count: 1, interval_count: 1, total_on_days: 10, max_on_days: 10 },
      currently_on: { episode_count: 0, interval_count: 0, total_on_days: 0, max_on_days: null },
      exited_after_on: { episode_count: 1, interval_count: 1, total_on_days: 10, max_on_days: 10 },
      distribution: { days_0_to_7_count: 0, days_8_to_30_count: 1, days_31_to_90_count: 0, days_91_plus_count: 0 },
      period_presence: { applicable: false, reason: "all_time", from_date: null, to_date: null },
    },
    retention: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 1,
      cohort_episode_total: 1,
      never_entered_on_count: 0,
      unknown_status_episode_count: 0,
      continuously_retained_count: 0,
      exited_from_on_total: 1,
      checkpoints: {
        d7: { checkpoint_days: 7, matured_count: 1, immature_count: 0, retained_count: 1, exited_count: 0 },
        d30: { checkpoint_days: 30, matured_count: 1, immature_count: 0, retained_count: 0, exited_count: 1 },
        d90: { checkpoint_days: 90, matured_count: 1, immature_count: 0, retained_count: 0, exited_count: 1 },
      },
      period_cohort: { applicable: false, reason: "all_time", from_date: null, to_date: null },
    },
    dimensions: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 1,
      by_recruiter: [structuredClone(validBucket)],
      by_team: [structuredClone(validBucket)],
      by_provider: [structuredClone(validBucket)],
      by_project: [structuredClone(validBucket)],
    },
    leave_reasons: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      off_episode_total: 1,
      with_reason_episode_count: 1,
      standardized_episode_count: 1,
      unclassified_free_text_episode_count: 0,
      missing_reason_episode_count: 0,
      by_category: CANONICAL_LEAVE_REASON_CATALOG.map((c) => ({
        key: c.key,
        kind: c.kind,
        episode_count: c.key === "personal_or_family" ? 1 : 0,
        from_on_count: c.key === "personal_or_family" ? 1 : 0,
        from_unconfirmed_without_on_count: 0,
      })),
      period_leave_reasons: { applicable: false, reason: "all_time", from_date: null, to_date: null },
    },
  };

  assert.equal(parseWorkforceReportingPayload(basePayload).status, "ready");

  // 1. Break dimension reconciliation (by_project total_on_days mismatch)
  const brokenDim = structuredClone(basePayload);
  brokenDim.dimensions.by_project[0].total_on_days = 9;
  const resBrokenDim = parseWorkforceReportingPayload(brokenDim);
  assert.equal(resBrokenDim.status, "unavailable");
  assert.equal(resBrokenDim.reason, "dimension_reconciliation_invariant_violated");

  // 2. Inject forbidden raw text field into leave_reasons category row
  const leakedRaw = structuredClone(basePayload);
  leakedRaw.leave_reasons.by_category[0].leave_reason_text = "Lý do thô";
  const resLeaked = parseWorkforceReportingPayload(leakedRaw);
  assert.equal(resLeaked.status, "unavailable");
  assert.equal(resLeaked.reason, "leave_reason_raw_text_leak_detected");

  // 3. Break leave_reasons category sum invariant
  const brokenLrSum = structuredClone(basePayload);
  brokenLrSum.leave_reasons.by_category[0].episode_count = 0;
  brokenLrSum.leave_reasons.by_category[0].from_on_count = 0;
  const resBrokenLr = parseWorkforceReportingPayload(brokenLrSum);
  assert.equal(resBrokenLr.status, "unavailable");
  assert.equal(resBrokenLr.reason, "leave_reasons_category_sum_invariant_violated");
});

test("WF-04 (5): Visual clarity UI contract guards in dashboard-shared.tsx", () => {
  assert.equal(formatShareRatePercent(null), "—");
  assert.equal(formatShareRatePercent(0.25), "25%");
  assert.equal(formatCoverageRatePercent(0.875), "87,5%");

  const sharedPath = path.resolve(process.cwd(), "src/components/dashboard/dashboard-shared.tsx");
  const sharedSrc = fs.readFileSync(sharedPath, "utf8");

  assert.ok(
    sharedSrc.includes("Điểm cần chú ý tại ngày mốc"),
    "Must render deterministic 'Điểm cần chú ý' summary block",
  );
  assert.ok(
    sharedSrc.includes("Cơ cấu 100% trạng thái tại ngày mốc"),
    "Must render 100% stacked composition bar for WF-01 snapshot",
  );
  assert.ok(
    sharedSrc.includes("Chất lượng lực lượng theo chiều phân tích"),
    "Must render WF-04 2.7 dimensional quality section",
  );
  assert.ok(
    sharedSrc.includes('role="tablist"'),
    "Must render interactive dimension tab switcher",
  );
  assert.ok(
    sharedSrc.includes("Phân tích lý do nghỉ việc &amp; độ phủ dữ liệu"),
    "Must render WF-04 2.8 leave reason analysis section",
  );
  assert.ok(
    sharedSrc.includes("WORKFORCE_DIMENSION_ATTRIBUTION_NOTE") &&
      sharedSrc.includes("WORKFORCE_LEAVE_REASON_STANDARDIZATION_NOTE"),
    "Must render dimension attribution and leave reason standardization notes",
  );
  assert.ok(WORKFORCE_DIMENSION_KIND_LABELS.PROJECT.includes("Theo dự án"));
  assert.ok(WORKFORCE_DIMENSION_ATTRIBUTION_NOTE.includes("(Ngừng hoạt động)"));
  assert.ok(WORKFORCE_LEAVE_REASON_STANDARDIZATION_NOTE.includes("đã xác minh"));
});

test("WF-04 Hotfix (6): Tab navigation order, content split (Báo cáo tổng quát vs Báo cáo chuyên sâu), font unification, and lazy-loading contract", () => {
  const pageSrc = fs.readFileSync(path.resolve(process.cwd(), "src/app/dashboard/page.tsx"), "utf8");
  const tabsSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/dashboard/bod-dashboard-tabs.tsx"),
    "utf8",
  );
  const sharedSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/dashboard/dashboard-shared.tsx"),
    "utf8",
  );
  const serverSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/reporting/p2-w04a-reporting-server.ts"),
    "utf8",
  );
  const teamViewSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/dashboard/team-dashboard-view.tsx"),
    "utf8",
  );
  const teamReportSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/dashboard/team-report-view.tsx"),
    "utf8",
  );
  const ownViewSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/dashboard/own-dashboard-view.tsx"),
    "utf8",
  );
  const routeSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/reporting/workforce-deep/route.ts"),
    "utf8",
  );

  // 1. Tab order: Báo cáo tổng quát -> Báo cáo chi tiết (thay vị trí Báo cáo chuyên sâu trên UI) -> Báo cáo theo nhóm -> Báo cáo CCCD trùng
  const idxGeneral = tabsSrc.indexOf('key: "general", label: "Báo cáo tổng quát"');
  const idxDeep = tabsSrc.indexOf('key: "deep", label: "Báo cáo chi tiết"');
  const idxTeam = tabsSrc.indexOf('key: "team", label: "Báo cáo theo nhóm"');
  const idxCccd = tabsSrc.indexOf('key: "duplicate-cccd", label: "Báo cáo CCCD trùng"');
  const idxOffboarding = tabsSrc.indexOf('key: "offboarding", label: "Báo cáo NLĐ nghỉ việc"');
  assert.ok(
    idxGeneral >= 0 && idxDeep > idxGeneral && idxTeam > idxDeep &&
      idxCccd > idxTeam && idxOffboarding > idxCccd,
  );

  // 2. WorkforceSnapshotSection on Báo cáo tổng quát only renders Trạng thái lao động tại ngày chốt + Biến động trạng thái trong kỳ
  const snapshotFnStart = sharedSrc.indexOf("export function WorkforceSnapshotSection");
  const snapshotFnEnd = sharedSrc.indexOf("export const WorkforceStatusSection");
  const deepFnStart = sharedSrc.indexOf("export function WorkforceDeepSection");
  assert.ok(snapshotFnStart >= 0 && snapshotFnEnd > snapshotFnStart && deepFnStart > snapshotFnEnd);
  const snapshotSectionCode = sharedSrc.slice(snapshotFnStart, snapshotFnEnd);

  assert.ok(snapshotSectionCode.includes("Hiện trạng & biến động trạng thái lao động"));
  assert.ok(snapshotSectionCode.includes("Trạng thái lao động tại ngày chốt"));
  assert.ok(snapshotSectionCode.includes("Biến động trạng thái trong kỳ"));
  assert.ok(!snapshotSectionCode.includes("Snapshot trạng thái lao động"));
  // Full-width separate row for business note
  assert.ok(
    snapshotSectionCode.includes("mt-2 w-full rounded-lg border border-border bg-muted/10 px-3 py-2 text-xs text-muted"),
  );
  // Deep sections MUST NOT exist inside WorkforceSnapshotSection
  assert.ok(!snapshotSectionCode.includes("Đối soát cân bằng đầu kỳ / cuối kỳ"));
  assert.ok(!snapshotSectionCode.includes("Thời gian chờ việc &amp; tỷ lệ bố trí việc"));
  assert.ok(!snapshotSectionCode.includes("Thâm niên làm việc &amp; ngày hiện diện theo trạng thái"));
  assert.ok(!snapshotSectionCode.includes("Nghỉ sớm &amp; giữ chân theo mốc D7 / D30 / D90"));
  assert.ok(!snapshotSectionCode.includes("Chất lượng lực lượng theo chiều phân tích"));
  assert.ok(!snapshotSectionCode.includes("Phân tích lý do nghỉ việc &amp; độ phủ dữ liệu"));

  // 3. WorkforceDeepSection renders all moved deep sections + server-side project pagination ("Tải thêm")
  const deepSectionCode = sharedSrc.slice(deepFnStart);
  assert.ok(deepSectionCode.includes("Điểm cần chú ý tại ngày mốc"));
  assert.ok(deepSectionCode.includes("Đối soát cân bằng đầu kỳ / cuối kỳ"));
  assert.ok(deepSectionCode.includes("Thời gian chờ việc &amp; tỷ lệ bố trí việc"));
  assert.ok(deepSectionCode.includes("Thâm niên làm việc &amp; ngày hiện diện theo trạng thái"));
  assert.ok(deepSectionCode.includes("Nghỉ sớm &amp; giữ chân theo mốc D7 / D30 / D90"));
  assert.ok(deepSectionCode.includes("Chất lượng lực lượng theo chiều phân tích"));
  assert.ok(deepSectionCode.includes("Phân tích lý do nghỉ việc &amp; độ phủ dữ liệu"));
  assert.ok(deepSectionCode.includes("Tải thêm"));
  assert.ok(deepSectionCode.includes("/api/reporting/workforce-deep"));
  assert.ok(deepSectionCode.includes("AbortController"));
  assert.ok(deepSectionCode.includes("requestSeqRef"));
  assert.ok(deepSectionCode.includes("useNotify()"));

  // 4. Font unification: no font-mono inside dashboard-shared.tsx
  assert.ok(!sharedSrc.includes("font-mono"), "dashboard-shared.tsx must not use font-mono");
  assert.ok(sharedSrc.includes("tabular-nums"), "dashboard-shared.tsx keeps tabular-nums for numbers");

  // 5. Lazy loading & scope=all guard on server and client
  assert.ok(serverSrc.includes("resolveWorkforceOverviewForActor"));
  assert.ok(!serverSrc.includes("resolveWorkforceReportingForActor"));
  assert.ok(serverSrc.includes('audience.kind === "all"'));
  assert.ok(pageSrc.includes("canViewDeepWorkforceReport(actor)"));
  assert.ok(routeSrc.includes("guardApiSession"));
  assert.ok(routeSrc.includes("fetchWorkforceDeepReport"));

  // 6. Team Leader & Recruiter views do not render WorkforceSnapshotSection or fallback card
  assert.ok(!teamViewSrc.includes("WorkforceSnapshotSection"));
  assert.ok(!teamReportSrc.includes("WorkforceSnapshotSection"));
  assert.ok(!ownViewSrc.includes("WorkforceSnapshotSection"));
});

test("WF-04 Hotfix (7): Authority helper, overview/project_page parsers, and paged attention insights", async () => {
  // 1. canViewDeepWorkforceReport authority matrix (paired @ ALL)
  const makeActor = (scopes, effective_grants) => ({
    ok: true,
    actor: {
      auth_subject: uuid(900),
      app_user_id: uuid(901),
      display_name: "Test User",
      enabled: true,
      capabilities: ["entry_admin"],
      scopes,
      effective_grants: effective_grants ?? (scopes.some((s) => s.kind === "all")
        ? [{ capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE", source_id: uuid(902) }]
        : []),
      self_recruiter_suggestion: null,
      session: { provider: "supabase", verification: "getUser", authenticated_at: null },
    },
  });
  assert.equal(canViewDeepWorkforceReport(makeActor([{ kind: "all", reference: "all" }])), true);
  assert.equal(
    canViewDeepWorkforceReport(
      makeActor([{ kind: "all", reference: "all" }], [{ capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE", source_id: uuid(902) }]),
    ),
    false,
  );
  assert.equal(canViewDeepWorkforceReport(makeActor([{ kind: "team", reference: uuid(10) }])), false);
  assert.equal(canViewDeepWorkforceReport(makeActor([{ kind: "own", reference: "own" }])), false);
  assert.equal(canViewDeepWorkforceReport(null), false);
  assert.equal(canViewDeepWorkforceReport({ ok: false, reason: "UNAUTHENTICATED" }), false);

  // 2. Overview parser & resolver (only snapshot + transitions, requires audience === "all")
  const overviewPayload = {
    audience: { audience: "all" },
    mode: "overview",
    snapshot: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 3,
      on_count: 2,
      unconfirmed_count: 1,
      off_count: 0,
      unknown_count: 0,
      future_episode_count: 0,
    },
    transitions: {
      applicable: false,
      reason: "all_time",
      from_date: null,
      to_date: null,
    },
  };
  const parsedOverview = parseWorkforceOverviewPayload(overviewPayload);
  assert.equal(parsedOverview.status, "ready");
  if (parsedOverview.status === "ready") {
    assert.equal(parsedOverview.snapshot.eligibleEpisodeTotal, 3);
    assert.equal(parsedOverview.snapshot.onCount, 2);
    assert.equal("balance" in parsedOverview, false);
    assert.equal("dimensions" in parsedOverview, false);
  }

  let capturedOverviewArgs = null;
  const overviewForAll = await resolveWorkforceOverviewForActor({
    actor: { auth_subject: uuid(1), app_user_id: uuid(2) },
    filters: { from: "2026-10-01", to: "2026-10-15" },
    callWorkforceRpc: async (args) => {
      capturedOverviewArgs = args;
      return { data: overviewPayload };
    },
  });
  assert.equal(overviewForAll.status, "ready");
  assert.equal(capturedOverviewArgs.p_filters.mode, "overview");

  // Team audience must be rejected by resolveWorkforceOverviewForActor even if RPC were called
  const overviewForTeam = await resolveWorkforceOverviewForActor({
    actor: { auth_subject: uuid(1), app_user_id: uuid(2) },
    filters: { from: "2026-10-01", to: "2026-10-15" },
    callWorkforceRpc: async () => ({
      data: {
        ...overviewPayload,
        audience: { audience: "team", team_id: uuid(10), team_code: "T1", team_display_name: "Team 1" },
      },
    }),
  });
  assert.equal(overviewForTeam.status, "unavailable");
  assert.equal(overviewForTeam.reason, "audience_mismatch");

  // 3. Project page parser & resolver (5 rows/page default)
  assert.equal(WORKFORCE_PROJECT_DEFAULT_PAGE_SIZE, 5);
  const sampleProjectBucket = {
    key: "prj-6",
    display: "Dự án 6",
    is_unknown: false,
    active: true,
    eligible_episode_count: 4,
    on_count: 2,
    unconfirmed_count: 1,
    off_count: 1,
    unknown_count: 0,
    waiting_episode_count: 2,
    completed_waiting_episode_count: 1,
    placed_to_on_episode_count: 1,
    exited_without_on_episode_count: 0,
    currently_waiting_episode_count: 1,
    total_waiting_days: 6,
    avg_waiting_days_per_episode: 3,
    placement_rate_of_waiting: 0.5,
    placement_rate_of_completed_waiting: 1,
    ever_on_episode_count: 3,
    never_on_episode_count: 1,
    continuously_retained_count: 2,
    exited_from_on_count: 1,
    total_on_days: 45,
    avg_on_days_per_episode: 15,
    checkpoints: {
      d7: { checkpoint_days: 7, matured_count: 3, immature_count: 0, retained_count: 3, exited_count: 0, retention_rate: 1, attrition_rate: 0 },
      d30: { checkpoint_days: 30, matured_count: 3, immature_count: 0, retained_count: 2, exited_count: 1, retention_rate: 2 / 3, attrition_rate: 1 / 3 },
      d90: { checkpoint_days: 90, matured_count: 0, immature_count: 3, retained_count: 0, exited_count: 0, retention_rate: null, attrition_rate: null },
    },
  };
  const projectPagePayload = {
    audience: { audience: "all" },
    mode: "project_page",
    by_project_page: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      total_count: 6,
      page_size: 5,
      has_more: false,
      next_cursor: null,
      rows: [sampleProjectBucket],
    },
  };
  const parsedPage = parseWorkforceProjectPagePayload(projectPagePayload);
  assert.equal(parsedPage.status, "ready");
  if (parsedPage.status === "ready") {
    assert.equal(parsedPage.totalCount, 6);
    assert.equal(parsedPage.pageSize, 5);
    assert.equal(parsedPage.hasMore, false);
    assert.equal(parsedPage.nextCursor, null);
    assert.equal(parsedPage.rows.length, 1);
    assert.equal(parsedPage.rows[0].key, "prj-6");
  }

  const missingCursorRes = await resolveWorkforceProjectPageForActor({
    actor: { auth_subject: uuid(1), app_user_id: uuid(2) },
    filters: {},
    cursor: "   ",
    callWorkforceRpc: async () => ({ data: projectPagePayload }),
  });
  assert.equal(missingCursorRes.status, "unavailable");
  assert.equal(missingCursorRes.reason, "missing_cursor");

  let capturedDeepArgs = null;
  await resolveWorkforceDeepReportingForActor({
    actor: { auth_subject: uuid(1), app_user_id: uuid(2) },
    filters: { from: "2026-10-01", to: "2026-10-15" },
    callWorkforceRpc: async (args) => {
      capturedDeepArgs = args;
      return { data: null };
    },
  });
  assert.equal(capturedDeepArgs.p_filters.mode, "deep");
  assert.equal(capturedDeepArgs.p_filters.project_limit, "5");
});

