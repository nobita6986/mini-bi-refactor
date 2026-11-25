"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusBadge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
  RowActionCluster,
} from "@/components/ui/data-table";
import { useNotify } from "@/components/ui/notify-provider";
import { StatusBanner } from "@/components/ui/status-banner";
import { WorkReportFormRenderer, type WorkReportRendererDetail } from "./work-report-form-renderer";

type Obligation = {
  obligation_id: string;
  template_name: string;
  period_key: string;
  period_start_date: string;
  period_end_date: string;
  due_at: string;
  obligation_status: string;
  submission_state: string;
  submission_version: number | null;
  is_overdue?: boolean;
};

function isActionableObligation(item: Obligation): boolean {
  if (item.obligation_status !== "ACTIVE") return false;
  if (item.is_overdue) return false;
  return (
    item.submission_state === "NOT_STARTED" ||
    item.submission_state === "DRAFT" ||
    item.submission_state === "REJECTED"
  );
}

function isHistoryObligation(item: Obligation): boolean {
  if (item.is_overdue) return true;
  if (item.obligation_status !== "ACTIVE") return true;
  return !isActionableObligation(item);
}

function submissionStateLabel(item: Obligation): string {
  if (item.is_overdue) {
    if (item.submission_state === "DRAFT") return "Quá hạn · Bản nháp chưa nộp";
    return "Quá hạn · Chưa nộp";
  }
  switch (item.submission_state) {
    case "NOT_STARTED":
      return "Chưa bắt đầu";
    case "DRAFT":
      return "Đang lưu nháp";
    case "REJECTED":
      return "Cần chỉnh sửa & nộp lại";
    case "SUBMITTED":
    case "PENDING_REVIEW":
      return "Đã nộp · Chờ duyệt";
    case "APPROVED":
      return "Đã duyệt";
    default:
      return item.submission_state;
  }
}

function submissionStateTone(item: Obligation): BadgeTone {
  if (item.is_overdue) return "danger";
  switch (item.submission_state) {
    case "APPROVED":
      return "success";
    case "SUBMITTED":
    case "PENDING_REVIEW":
      return "info";
    case "REJECTED":
      return "danger";
    case "DRAFT":
      return "warning";
    default:
      return "neutral";
  }
}

export function MyObligations({ history = false }: { history?: boolean }) {
  const notify = useNotify();
  const [items, setItems] = useState<Obligation[]>([]);
  const [selected, setSelected] = useState<{ detail: WorkReportRendererDetail; periodStart: string; periodEnd: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/work-reports/obligations", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result?.ok || !Array.isArray(result.data)) throw new Error("unavailable");
      setItems(result.data); setError(null);
    } catch { setError("Không tải được danh sách báo cáo. Vui lòng tải lại trang."); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/work-reports/obligations", { cache: "no-store" }).then(async (response) => {
      const result = await response.json();
      if (!response.ok || !result?.ok || !Array.isArray(result.data)) throw new Error("unavailable");
      if (active) { setItems(result.data); setError(null); }
    }).catch(() => { if (active) setError("Không tải được danh sách báo cáo. Vui lòng tải lại trang."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function open(item: Obligation) {
    setSelected(null); setError(null);
    try {
      const response = await fetch(`/api/work-reports/obligations/${item.obligation_id}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result?.ok || !result.data) throw new Error("unavailable");
      setSelected({ detail: result.data, periodStart: item.period_start_date, periodEnd: item.period_end_date });
    } catch {
      const msg = "Không tải được nội dung báo cáo. Hãy kiểm tra quyền truy cập hoặc thử lại.";
      setError(msg);
      notify.error({ title: msg });
    }
  }

  const visibleItems = items.filter((item) =>
    history ? isHistoryObligation(item) : isActionableObligation(item),
  );

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted">
        {history
          ? "Các báo cáo đã nộp và các kỳ báo cáo đã quá hạn của bạn."
          : "Nghĩa vụ báo cáo cần thực hiện trong kỳ hiện hành."}
      </p>
      <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy}>{busy ? "Đang tải…" : "Tải lại"}</Button>
    </div>
    {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
    {busy && items.length === 0 ? <p role="status" className="text-sm text-muted">Đang tải nghĩa vụ báo cáo…</p> : null}
    {!busy && visibleItems.length === 0 ? <StatusBanner>Không có báo cáo nào trong danh sách này.</StatusBanner> : null}
    {visibleItems.length > 0 ? (
      <DataTableContainer>
        <table className={DATA_TABLE_CLASS}>
          <thead className={DATA_TABLE_HEAD_CLASS}>
            <tr>
              <th scope="col" className={DATA_TABLE_TH_CLASS}>Mẫu báo cáo</th>
              <th scope="col" className={DATA_TABLE_TH_CLASS}>Kỳ báo cáo</th>
              <th scope="col" className={DATA_TABLE_TH_CLASS}>Hạn nộp</th>
              <th scope="col" className={DATA_TABLE_TH_CLASS}>Trạng thái</th>
              <th scope="col" className={DATA_TABLE_TH_CLASS + " text-right"}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {visibleItems.map((item) => (
              <tr key={item.obligation_id} className={DATA_TABLE_ROW_CLASS}>
                <td className={DATA_TABLE_TD_CLASS + " font-semibold text-[var(--navy)]"} data-card-header="true">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{item.template_name}</span>
                    {item.is_overdue ? (
                      <StatusBadge tone="danger">Quá hạn</StatusBadge>
                    ) : item.submission_state === "REJECTED" ? (
                      <StatusBadge tone="warning">Cần nộp lại</StatusBadge>
                    ) : null}
                  </div>
                </td>
                <td className={DATA_TABLE_TD_CLASS + " whitespace-nowrap"} data-label="Kỳ báo cáo">
                  <span className="inline-flex items-center rounded-md border border-border/80 bg-surface-muted/75 px-2 py-0.5 font-mono text-xs font-medium text-[var(--navy)]">
                    Kỳ {item.period_key}
                  </span>
                </td>
                <td className={DATA_TABLE_TD_CLASS + " font-mono text-xs tabular-nums text-muted whitespace-nowrap"} data-label="Hạn nộp">
                  {new Date(item.due_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}
                </td>
                <td className={DATA_TABLE_TD_CLASS + " whitespace-nowrap"} data-label="Trạng thái">
                  <StatusBadge tone={submissionStateTone(item)} dot>
                    {submissionStateLabel(item)}
                  </StatusBadge>
                </td>
                <td className={DATA_TABLE_TD_CLASS + " text-right whitespace-nowrap"} data-card-actions="true">
                  <RowActionCluster>
                    <Button
                      variant={history || item.is_overdue ? "secondary" : "soft"}
                      size="sm"
                      onClick={() => void open(item)}
                    >
                      {history || item.is_overdue
                        ? "Xem lịch sử"
                        : item.submission_state === "NOT_STARTED"
                          ? "Bắt đầu"
                          : item.submission_state === "REJECTED"
                            ? "Sửa & nộp lại"
                            : "Mở báo cáo"}
                    </Button>
                  </RowActionCluster>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTableContainer>
    ) : null}
    {selected ? <div className="rounded-[22px] border border-border/80 bg-surface p-4 sm:p-6 shadow-[var(--shadow-card)]">
      <div className="mb-5 flex justify-end"><Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Đóng</Button></div>
      <WorkReportFormRenderer key={selected.detail.obligation.obligation_id} detail={{ ...selected.detail,
        obligation: { ...selected.detail.obligation, period_start_date: selected.periodStart, period_end_date: selected.periodEnd } }}
        onSaved={() => { void refresh(); const item = items.find((candidate) => candidate.obligation_id === selected.detail.obligation.obligation_id);
          if (item) void open(item); }} />
    </div> : null}
  </div>;
}
