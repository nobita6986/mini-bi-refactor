"use client";

import { useRef, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { parseAsString, useQueryStates } from "nuqs";

import type { ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";
import { CccdReviewPanel } from "@/components/reporting/cccd-review-panel";
import { DuplicateCccdReportPanel } from "@/components/reporting/duplicate-cccd-report-panel";
import { OffboardingReportPanel } from "@/components/workforce/offboarding-report-panel";
import { DetailedRecruitmentMatrixPanel } from "./detailed-recruitment-matrix-panel";
import { TeamReportView, type TeamReportViewConfig } from "./team-report-view";

/**
 * P3-W06D-R2 - BoD "Báo cáo chi tiết nhóm" uses the SAME report implementation
 * as the Team Leader report (`TeamReportView`), so the report is only built once.
 */
const bodTeamReportConfig: TeamReportViewConfig = {
  eyebrow: "BoD · Báo cáo chi tiết nhóm",
  title: "Báo cáo chi tiết nhóm",
  description: "Số người tuyển theo ngày, dự án, người tuyển và loại hình. Chọn một nhóm để xem chi tiết từng dòng.",
  scopeNote: "Chọn một nhóm để xem báo cáo chi tiết của nhóm đó.",
  emptyTitle: "Chưa có dữ liệu tuyển dụng theo nhóm",
  emptyDescription: "Hiện chưa có dữ liệu để hiển thị.",
  noMatchesDetail: "Không có nhóm nào khớp bộ lọc đang chọn.",
  showMemberRanking: true,
  showProjectProviderMix: false,
  showRecruiterFilter: true,
  requireTeamSelection: true,
  kpiAriaLabel: "Chỉ số báo cáo chi tiết nhóm",
  kpiPrimaryLabel: "Tổng tuyển mới",
  kpiPrimaryHint: "số người tuyển",
  kpiSecondaryLabel: "Người tuyển có đóng góp",
  kpiSecondaryHint: "trong phạm vi báo cáo",
  memberTitle: "Đóng góp của người tuyển",
  memberDescription: "Xếp hạng số người tuyển của từng người tuyển trong phạm vi báo cáo.",
  memberAriaLabel: "Đóng góp của người tuyển",
  pickerHeading: "Tuyển dụng theo nhóm",
  pickerDescription: "Chọn một nhóm để xem báo cáo và các dòng chi tiết đã được máy chủ làm sạch.",
  pickerTitle: "Danh sách nhóm",
};

const queryParsers = {
  tab: parseAsString,
  source: parseAsString,
};

type TabKey = "general" | "deep" | "team" | "cccd-review" | "duplicate-cccd" | "offboarding";

type TabDef = { key: TabKey; label: string; panelId: string };

/**
 * P3.1-HF-R3-R1 / WF-04 Hotfix / PRE-WAVE-2 / Detailed Recruitment Matrix:
 * 1. "Báo cáo tổng quát" (mặc định)
 * 2. "Báo cáo chi tiết" (tạm ẩn "Báo cáo chuyên sâu" trên UI nhưng giữ nguyên API/RPC/component; chỉ hiển thị cho actor có scope = "all", tức primaryTabLabel === undefined)
 * 3. "Báo cáo theo nhóm" (chỉ hiển thị cho actor có scope = "all")
 * 4. "Review thông tin NLĐ" (nằm ngay trước "Báo cáo CCCD trùng", hiển thị khi canViewCccdReview === true)
 * 5. "Báo cáo CCCD trùng" (hiển thị khi canViewDuplicateCccd === true)
 * 6. "Báo cáo NLĐ nghỉ việc" (hiển thị khi canViewOffboarding === true)
 */
const tabs: readonly TabDef[] = [
  { key: "general", label: "Báo cáo tổng quát", panelId: "bod-panel-general" },
  { key: "deep", label: "Báo cáo chi tiết", panelId: "bod-panel-deep" },
  { key: "team", label: "Báo cáo theo nhóm", panelId: "bod-panel-team" },
  { key: "cccd-review", label: "Review thông tin NLĐ", panelId: "bod-panel-cccd-review" },
  { key: "duplicate-cccd", label: "Báo cáo CCCD trùng", panelId: "bod-panel-duplicate-cccd" },
  { key: "offboarding", label: "Báo cáo NLĐ nghỉ việc", panelId: "bod-panel-offboarding" },
];

export function BodDashboardTabs({
  general,
  primaryTabLabel,
  data,
  generatedAt,
  optionsResult,
  canViewCccdReview,
  canViewDuplicateCccd,
  canViewOffboarding,
}: {
  general: ReactNode;
  /** Scoped dashboards get their own first tab, never the all-scope deep or team report. */
  primaryTabLabel?: string;
  data: ReportingData;
  generatedAt?: string;
  optionsResult: ReportingOptionsResult;
  canViewCccdReview?: boolean;
  canViewDuplicateCccd: boolean;
  canViewOffboarding: boolean;
}) {
  const effectiveCanViewCccdReview = canViewCccdReview ?? canViewDuplicateCccd;
  const [{ tab: rawTab, source }, setQuery] = useQueryStates(queryParsers, {
    history: "push",
    shallow: true,
    scroll: false,
  });
  const [isPending, startTransition] = useTransition();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visibleTabs = tabs.filter((tab) =>
    tab.key === "cccd-review"
      ? effectiveCanViewCccdReview
      : tab.key === "duplicate-cccd"
      ? canViewDuplicateCccd
      : tab.key === "offboarding"
        ? canViewOffboarding
      : tab.key === "deep"
        ? primaryTabLabel === undefined
        : tab.key === "team"
          ? primaryTabLabel === undefined
          : true,
  ).map((tab) => tab.key === "general" && primaryTabLabel
    ? { ...tab, label: primaryTabLabel }
    : tab);
  const activeTab: TabKey =
    primaryTabLabel === undefined && rawTab === "deep"
      ? "deep"
      : primaryTabLabel === undefined && rawTab === "team"
        ? "team"
        : rawTab === "cccd-review" && effectiveCanViewCccdReview
          ? "cccd-review"
        : rawTab === "duplicate-cccd" && canViewDuplicateCccd
          ? "duplicate-cccd"
          : rawTab === "offboarding" && canViewOffboarding
            ? "offboarding"
          : "general";

  function selectTab(next: TabKey): void {
    const needsAuthoritativeReload = (next === "deep" || next === "team") && source !== null;
    startTransition(() => {
      void setQuery(
        { tab: next, source: next === "general" ? source : null },
        { history: "push", shallow: !needsAuthoritativeReload, scroll: false },
      );
    });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % visibleTabs.length;
    else if (event.key === "ArrowLeft") next = (index + visibleTabs.length - 1) % visibleTabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visibleTabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(visibleTabs[next].key);
    requestAnimationFrame(() => tabRefs.current[next]?.focus());
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-4 sm:px-6" aria-busy={isPending}>
      <div role="tablist" aria-label="Báo cáo" className="inline-flex flex-wrap items-center gap-1 self-start rounded-[20px] border border-border/80 bg-surface p-1 shadow-[var(--shadow-card)] md:rounded-full">
        {visibleTabs.map((tab, index) => (
          <button
            key={tab.key}
            ref={(element) => { tabRefs.current[index] = element; }}
            type="button"
            role="tab"
            id={`bod-tab-${tab.key}`}
            aria-selected={activeTab === tab.key}
            aria-controls={tab.panelId}
            tabIndex={activeTab === tab.key ? 0 : -1}
            onClick={() => selectTab(tab.key)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            className={`min-h-11 sm:min-h-9 rounded-full px-4 text-sm transition-[color,background-color,box-shadow] duration-[var(--ui-motion-tab,200ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${activeTab === tab.key
              ? "bg-primary font-semibold text-on-primary shadow-[0_6px_16px_-6px_var(--primary)]"
              : "font-medium text-muted hover:bg-surface-muted hover:text-[var(--navy)]"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "general" ? (
        <div id="bod-panel-general" role="tabpanel" aria-labelledby="bod-tab-general" tabIndex={0} data-ui-panel-motion="true" className="pt-4">
          {general}
        </div>
      ) : activeTab === "deep" && primaryTabLabel === undefined ? (
        <div id="bod-panel-deep" role="tabpanel" aria-labelledby="bod-tab-deep" tabIndex={0} data-ui-panel-motion="true" className="pt-4">
          <DetailedRecruitmentMatrixPanel
            data={data}
            generatedAt={generatedAt}
            optionsResult={optionsResult}
          />
        </div>
      ) : activeTab === "team" && primaryTabLabel === undefined ? (
        <div id="bod-panel-team" role="tabpanel" aria-labelledby="bod-tab-team" tabIndex={0} data-ui-panel-motion="true" className="pt-4">
          <TeamReportView
            data={data}
            generatedAt={generatedAt}
            optionsResult={optionsResult}
            view={bodTeamReportConfig}
          />
        </div>
      ) : activeTab === "cccd-review" ? (
        <div id="bod-panel-cccd-review" role="tabpanel" aria-labelledby="bod-tab-cccd-review" tabIndex={0} data-ui-panel-motion="true" className="pt-4">
          <CccdReviewPanel />
        </div>
      ) : activeTab === "duplicate-cccd" ? (
        <div id="bod-panel-duplicate-cccd" role="tabpanel" aria-labelledby="bod-tab-duplicate-cccd" tabIndex={0} data-ui-panel-motion="true" className="pt-4">
          <DuplicateCccdReportPanel />
        </div>
      ) : (
        <div id="bod-panel-offboarding" role="tabpanel" aria-labelledby="bod-tab-offboarding" tabIndex={0} data-ui-panel-motion="true" className="pt-4">
          <OffboardingReportPanel />
        </div>
      )}
    </div>
  );
}
