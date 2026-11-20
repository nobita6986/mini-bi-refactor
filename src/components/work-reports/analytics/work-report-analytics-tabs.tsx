"use client";

import { useState } from "react";
import { ReadableSubmissions } from "../reader/readable-submissions";
import { WorkReportAnalytics } from "./work-report-analytics";

const tabClass =
  "inline-flex min-h-11 items-center rounded-t-lg px-3.5 text-sm font-medium whitespace-nowrap " +
  "transition-[color,background-color,transform] duration-[var(--ui-motion-hover,160ms)] " +
  "ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring/40 active:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none";

export function WorkReportAnalyticsTabs({
  canViewAnalytics = true,
  canViewSubmissions,
}: {
  canViewAnalytics?: boolean;
  canViewSubmissions: boolean;
}) {
  const [tab, setTab] = useState<"submissions" | "summary">(
    canViewSubmissions ? "submissions" : "summary",
  );
  const activeTab: "submissions" | "summary" =
    tab === "summary" && !canViewAnalytics && canViewSubmissions
      ? "submissions"
      : tab === "submissions" && !canViewSubmissions && canViewAnalytics
        ? "summary"
        : tab;
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Chế độ xem Theo dõi báo cáo" className="flex flex-wrap gap-1 border-b border-border">
        {canViewAnalytics ? (
          <button
            type="button"
            role="tab"
            id="analytics-tab-summary"
            aria-selected={activeTab === "summary"}
            aria-controls="analytics-panel-summary"
            className={tabClass + (activeTab === "summary"
              ? " border-b-2 border-primary bg-primary/5 text-foreground"
              : " text-muted hover:text-foreground")}
            onClick={() => setTab("summary")}
          >
            Tổng quan
          </button>
        ) : null}
        {canViewSubmissions ? (
          <button
            type="button"
            role="tab"
            id="analytics-tab-submissions"
            aria-selected={activeTab === "submissions"}
            aria-controls="analytics-panel-submissions"
            className={tabClass + (activeTab === "submissions"
              ? " border-b-2 border-primary bg-primary/5 text-foreground"
              : " text-muted hover:text-foreground")}
            onClick={() => setTab("submissions")}
          >
            Bài nộp
          </button>
        ) : null}
      </div>
      <div
        role="tabpanel"
        id={activeTab === "submissions" ? "analytics-panel-submissions" : "analytics-panel-summary"}
        aria-labelledby={activeTab === "submissions" ? "analytics-tab-submissions" : "analytics-tab-summary"}
      >
        {activeTab === "submissions" && canViewSubmissions ? (
          <ReadableSubmissions />
        ) : canViewAnalytics ? (
          <WorkReportAnalytics canViewSubmissions={canViewSubmissions} />
        ) : null}
      </div>
    </div>
  );
}
