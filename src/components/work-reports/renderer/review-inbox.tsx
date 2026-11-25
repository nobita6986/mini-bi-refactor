"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/ui/badge";
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
import { ReportReadonlyContent } from "@/components/work-reports/reader/report-readonly-content";
import type { WorkReportTemplateSchema } from "@/lib/work-reports/contracts.ts";

type ReviewItem = {
  obligation_id: string; template_name: string; template_version: number; assignee_label: string;
  team_label: string | null; period_key: string; due_at: string; submitted_at: string;
  state: "PENDING_REVIEW"; version: number;
};
type ReviewDetail = {
  obligation: { obligation_id: string; period_key: string; period_start_date: string; period_end_date: string; due_at: string; version: number };
  template: { template_code: string; display_name: string; schema_json: WorkReportTemplateSchema };
  submission: { submission_id: string; state: string; first_submitted_at: string | null; latest_submitted_at: string | null; is_late: boolean; has_post_deadline_amendment: boolean; current_revision_id: string; version: number };
  current_revision: { revision_id: string; revision_no: number; payload_json: Record<string, unknown>; created_at: string };
  assignee_display_name: string; team_display_name: string | null;
  review_events: Array<{ decision: string; reason: string | null; reviewed_at: string; reviewer_display_name: string }>;
};
type Page = { items: ReviewItem[]; next_cursor: string | null; has_more: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const dateTime = (value: string | null) => value ? new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "—";

async function fetchReviewPage(cursor: string | null): Promise<Page> {
  const query = new URLSearchParams({ page_size: "50" });
  if (cursor) query.set("cursor", cursor);
  const body = await readBody(await fetch(`/api/work-reports/reviews?${query}`, { cache: "no-store" }));
  if (!Array.isArray(body.items) || !(body.next_cursor === null || typeof body.next_cursor === "string") || typeof body.has_more !== "boolean") {
    throw new Error("WORK_REPORT_RESPONSE_INVALID");
  }
  return { items: body.items as ReviewItem[], next_cursor: body.next_cursor, has_more: body.has_more };
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || body.ok !== true) {
    throw new Error(isRecord(body) && typeof body.code === "string" ? body.code : "WORK_REPORT_UNAVAILABLE");
  }
  return body;
}

function isReviewDetail(value: unknown): value is ReviewDetail {
  return isRecord(value) && isRecord(value.obligation) && isRecord(value.template) && isRecord(value.submission) &&
    isRecord(value.current_revision) && isRecord(value.current_revision.payload_json) &&
    typeof value.template.display_name === "string" && isRecord(value.template.schema_json) &&
    Array.isArray(value.template.schema_json.sections) && Array.isArray(value.review_events);
}

export function ReviewInbox() {
  const notify = useNotify();
  const [page, setPage] = useState<Page | null>(null);
  const [detail, setDetail] = useState<{ item: ReviewItem; value: ReviewDetail } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextCursor: string | null = null, append = false) => {
    setLoading(true); setError(null);
    try {
      const nextPage = await fetchReviewPage(nextCursor);
      setPage((current) => ({
        items: append && current ? [...current.items, ...nextPage.items] : nextPage.items,
        next_cursor: nextPage.next_cursor, has_more: nextPage.has_more,
      }));
      setCursor(nextPage.next_cursor);
    } catch {
      const msg = "Không tải được hàng đợi duyệt trong phạm vi quyền hiện tại.";
      if (!append) setPage(null);
      setError(msg);
      if (append) notify.error({ title: msg });
    } finally { setLoading(false); }
  }, [notify]);

  useEffect(() => {
    let active = true;
    void fetchReviewPage(null).then((nextPage) => {
      if (active) { setPage(nextPage); setCursor(nextPage.next_cursor); setError(null); }
    }).catch(() => {
      if (active) { setPage(null); setError("Không tải được hàng đợi duyệt trong phạm vi quyền hiện tại."); }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  async function open(item: ReviewItem) {
    setDetail(null); setError(null); setReason(""); setBusy(true);
    try {
      const body = await readBody(await fetch(`/api/work-reports/reviews/${encodeURIComponent(item.obligation_id)}`, { cache: "no-store" }));
      if (!isReviewDetail(body.detail)) throw new Error("WORK_REPORT_RESPONSE_INVALID");
      setDetail({ item, value: body.detail });
    } catch {
      const msg = "Không mở được nội dung báo cáo trong phạm vi duyệt hiện tại.";
      setError(msg);
      notify.error({ title: msg });
    } finally { setBusy(false); }
  }

  async function decide(decision: "APPROVE" | "REJECT") {
    if (!detail) return;
    const normalizedReason = reason.trim();
    if (decision === "REJECT" && !normalizedReason) { setError("Cần nhập lý do từ chối."); return; }
    setBusy(true); setError(null);
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch(`/api/work-reports/reviews/${encodeURIComponent(detail.item.obligation_id)}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({ decision, reason: normalizedReason || null,
          expected_version: detail.value.submission.version, idempotency_key }),
      });
      await readBody(response);
      notify.success({ title: decision === "APPROVE" ? "Đã duyệt báo cáo." : "Đã từ chối báo cáo." });
      setDetail(null);
      await load();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      const msg = code === "WORK_REPORT_SELF_REVIEW_FORBIDDEN" ? "Bạn không thể tự duyệt báo cáo của mình." :
        code === "WORK_REPORT_VERSION_CONFLICT" ? "Báo cáo đã được xử lý ở nơi khác. Hãy tải lại hàng đợi." :
          "Không thể xử lý báo cáo. Vui lòng thử lại hoặc kiểm tra quyền hiện tại.";
      setError(msg);
      if (code === "WORK_REPORT_VERSION_CONFLICT") notify.warning({ title: msg });
      else notify.error({ title: msg });
    } finally { setBusy(false); }
  }

  return <div className="space-y-5">
    {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
    {loading && !page ? <p role="status" className="text-sm text-muted">Đang tải hàng đợi duyệt…</p> : null}
    {page && page.items.length === 0 ? <StatusBanner>Không có báo cáo đang chờ duyệt trong phạm vi của bạn.</StatusBanner> : null}
    {page && page.items.length > 0 ? (
      <DataTableContainer>
        <table className={DATA_TABLE_CLASS}>
          <thead className={DATA_TABLE_HEAD_CLASS}>
            <tr>
              <th scope="col" className={DATA_TABLE_TH_CLASS}>Mẫu báo cáo</th>
              <th scope="col" className={DATA_TABLE_TH_CLASS}>Người nộp & Nhóm</th>
              <th scope="col" className={DATA_TABLE_TH_CLASS}>Kỳ báo cáo</th>
              <th scope="col" className={DATA_TABLE_TH_CLASS}>Thời điểm nộp & Hạn</th>
              <th scope="col" className={DATA_TABLE_TH_CLASS}>Trạng thái</th>
              <th scope="col" className={DATA_TABLE_TH_CLASS + " text-right"}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((item) => (
              <tr key={item.obligation_id} className={DATA_TABLE_ROW_CLASS}>
                <td className={DATA_TABLE_TD_CLASS + " font-semibold text-[var(--navy)]"} data-card-header="true">
                  {item.template_name}{" "}
                  <span className="ml-1 inline-flex items-center rounded-md border border-border/80 bg-surface-muted/75 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted">
                    v{item.template_version}
                  </span>
                </td>
                <td className={DATA_TABLE_TD_CLASS} data-label="Người nộp & Nhóm">
                  <div className="font-medium text-foreground">{item.assignee_label}</div>
                  {item.team_label ? <div className="text-xs text-muted">{item.team_label}</div> : null}
                </td>
                <td className={DATA_TABLE_TD_CLASS + " whitespace-nowrap"} data-label="Kỳ báo cáo">
                  <span className="inline-flex items-center rounded-md border border-border/80 bg-surface-muted/75 px-2 py-0.5 font-mono text-xs font-medium text-[var(--navy)]">
                    Kỳ {item.period_key}
                  </span>
                </td>
                <td className={DATA_TABLE_TD_CLASS + " font-mono text-xs tabular-nums text-muted whitespace-nowrap"} data-label="Thời điểm nộp & Hạn">
                  <div>Nộp: {dateTime(item.submitted_at)}</div>
                  <div>Hạn: {dateTime(item.due_at)}</div>
                </td>
                <td className={DATA_TABLE_TD_CLASS + " whitespace-nowrap"} data-label="Trạng thái">
                  <StatusBadge tone="warning" dot>Chờ duyệt</StatusBadge>
                </td>
                <td className={DATA_TABLE_TD_CLASS + " text-right whitespace-nowrap"} data-card-actions="true">
                  <RowActionCluster>
                    <Button variant="soft" size="sm" disabled={busy} onClick={() => void open(item)}>
                      Xem và xử lý
                    </Button>
                  </RowActionCluster>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTableContainer>
    ) : null}
    {page?.has_more && cursor ? <div className="flex justify-center"><Button variant="secondary" disabled={loading} onClick={() => void load(cursor, true)}>{loading ? "Đang tải…" : "Tải thêm"}</Button></div> : null}
    {detail ? <section className="space-y-4 rounded-[22px] border border-border/80 bg-surface p-4 sm:p-6 shadow-[var(--shadow-card)]" aria-labelledby="review-detail-title">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="review-detail-title" className="text-lg font-semibold">{detail.value.template.display_name}</h2><p className="text-sm text-muted">{detail.value.assignee_display_name}{detail.value.team_display_name ? ` · ${detail.value.team_display_name}` : ""} · Kỳ {detail.value.obligation.period_key}</p><p className="text-xs text-muted">Nộp {dateTime(detail.value.submission.latest_submitted_at)} · Bản {detail.value.current_revision.revision_no} · {detail.value.submission.state}</p></div><Button variant="ghost" onClick={() => setDetail(null)}>Đóng</Button></div>
      <ReportReadonlyContent schema={detail.value.template.schema_json} payload={detail.value.current_revision.payload_json} />
      {detail.value.review_events.length ? <details><summary className="cursor-pointer text-sm font-medium">Lịch sử duyệt ({detail.value.review_events.length})</summary><ul className="mt-2 space-y-2 text-sm text-muted">{detail.value.review_events.map((event, index) => <li key={`${event.reviewed_at}:${index}`}>{event.decision} · {event.reviewer_display_name} · {dateTime(event.reviewed_at)}{event.reason ? ` · ${event.reason}` : ""}</li>)}</ul></details> : null}
      <label className="block space-y-1.5 text-sm font-medium">Lý do (bắt buộc khi từ chối)<textarea className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy} onClick={() => void decide("APPROVE")}>{busy ? "Đang xử lý…" : "Đồng ý"}</Button><Button variant="secondary" disabled={busy || !reason.trim()} onClick={() => void decide("REJECT")}>Từ chối</Button></div>
    </section> : null}
  </div>;
}
