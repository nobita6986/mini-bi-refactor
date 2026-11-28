"use client";

/**
 * P1.6-W04-S04C-S03B2 - Reviewer xem xet va quyet dinh change request ENTRY_FIELD.
 *
 * - Chi goi change-request detail endpoint khi nguoi dung mo "Xem xet" (khong tai truoc).
 * - Detail duoc strict-project bang projectChangeRequestDetail roi map ngay sang view model an toan;
 *   khong luu/khong render raw JSON, khong hien thi UUID lam noi dung chinh.
 * - Before/after strict-project; worker details come only from server-authorized projections.
 * - can_decide chi la display hint; quyet dinh that do server/RPC quyet dinh.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog, Dialog } from "radix-ui";

import { useNotify } from "@/components/ui/notify-provider";
import { hcmTodayDate } from "@/lib/direct-entry/change-request-proposal-builders";

import {
  CHANGE_REQUEST_STATE_LABELS,
  normalizeReason,
  projectionSlice,
  projectProposerEntry,
  type ProposerEntryProjection,
} from "@/lib/direct-entry/change-request-proposer";
import { projectChangeRequestStateResult } from "@/lib/direct-entry/change-request-contract";
import type { ChangeRequestDecision } from "@/lib/direct-entry/change-request-contract";
import {
  buildDecisionRequest,
  buildReviewerViewModel,
  catalogCollaboratorLabel,
  catalogProjectLabel,
  catalogRecruiterLabel,
  decisionIntentSignature,
  REVIEW_DECISION_LABELS,
  REVIEW_TARGET_KIND_LABELS,
  reviewerErrorMessage,
  reviewDecisionMessage,
  reviewDecisionState,
  STALE_REVIEW_MESSAGE,
  reviewerUnsupportedMessage,
  unsupportedReviewerViewModel,
  type ReviewerUnsupportedReason,
  type ReviewerViewModel,
} from "@/lib/direct-entry/change-request-reviewer";
import {
  projectChangeRequestDetail,
  type ChangeRequestDetailItem,
  type ChangeRequestListItem,
} from "@/lib/direct-entry/change-request-read-contract";
import {
  projectEntrySensitiveContext,
  optionalValueText,
  projectWorkerDetails,
  WORKER_FIELD_LABELS,
  type EntrySensitiveContext,
} from "@/lib/direct-entry/change-request-read-projection";
import { genderUiLabel } from "@/lib/direct-entry/display-labels";
import type { OptionalValue } from "@/lib/contracts/direct-entry-v1";
import {
  clearIntentKey,
  EMPTY_INTENT_KEY,
  resolveIntentKey,
  shortRef,
  type TransitionIntentKeyState,
} from "@/lib/direct-entry/submission-lifecycle";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";

import styles from "./direct-entry-shell.module.css";

const DETAIL_KEYS = [
  "request_id", "state", "version", "created_at", "request_reason", "items",
  "can_withdraw", "can_decide",
] as const;
const DECISION_RESULT_KEYS = ["request_id", "state", "version"] as const;
const ENTRY_KEYS = ["entry"] as const;
const HISTORY_FIELD_LABELS: Readonly<Record<string, string>> = {
  project_id: "Dự án", first_work_date: "Ngày bắt đầu làm việc", employee_code: "Mã người lao động",
  recruiter_id: "Người tuyển", collaborator_id: "CTV", labor_type: "Loại hình lao động",
  worker_details: "Thông tin cá nhân",
  status: "Trạng thái làm việc", effective_date: "Ngày hiệu lực", leave_reason: "Lý do nghỉ việc",
  state: "Trạng thái thanh toán", account_number: "Số tài khoản", bank_id: "Ngân hàng",
  account_holder_name: "Tên chủ tài khoản", document_type: "Loại tài liệu",
  size_bytes: "Dung lượng", mime_type: "Định dạng",
};

function historyRows(item: ChangeRequestDetailItem, catalog?: DraftCatalog): Array<[string, string]> {
  if (item.target_kind === "ENTRY_VOID") {
    return [["Kết quả", "Hồ sơ được đánh dấu hủy riêng; dữ liệu và lịch sử được giữ lại."]];
  }
  return Object.entries(item.proposal).flatMap<[string, string]>(([key, value]): [string, string][] => {
    const label = HISTORY_FIELD_LABELS[key] ?? "Thông tin đề xuất";
    if (key === "labor_type" && item.labor_type_display) return [[label, item.labor_type_display]];
    if (key === "worker_details") {
      const detail = projectWorkerDetails(value);
      if (!detail) return [[label, "Đã đề xuất cập nhật thông tin cá nhân"]];
      return Object.entries(detail).map(([field, fieldValue]): [string, string] => {
        if (field === "display_name") {
          return [WORKER_FIELD_LABELS.display_name, fieldValue as string];
        }
        const workerField = field as Exclude<keyof typeof WORKER_FIELD_LABELS, "display_name">;
        const optionalValue = fieldValue as OptionalValue<string>;
        const valueText = field === "gender" && optionalValue.state === "provided"
          ? genderUiLabel(optionalValue.value)
          : optionalValueText(optionalValue);
        return [WORKER_FIELD_LABELS[workerField], valueText];
      });
    }
    if (key === "project_id") return [[label, catalog?.projects.find((item) => item.project_id === value)?.display_name ?? "Dự án đã chọn"]];
    if (key === "recruiter_id") return [[label, catalog?.recruiters.find((item) => item.recruiter_id === value)?.display_name ?? "Người tuyển đã chọn"]];
    if (key === "collaborator_id") {
      if (value === null) return [[label, "Không qua CTV"]];
      return [[
        label,
        item.collaborator_display ??
          catalogCollaboratorLabel(catalog, String(value)) ??
          "CTV đã chọn",
      ]];
    }
    if (key === "bank_id") return [[label, catalog?.banks.find((item) => item.bank_id === value)?.display_name ?? "Ngân hàng đã chọn"]];
    if (key === "status" && value === "ON") return [[label, "Đang làm việc"]];
    if (key === "status" && value === "UNCONFIRMED") return [[label, "Đang chờ việc"]];
    if (key === "status" && value === "OFF") return [[label, "Đã nghỉ"]];
    if (value === null) return [[label, "—"]];
    if (typeof value === "string" || typeof value === "number") return [[label, String(value)]];
    return [[label, "Đã có nội dung đề xuất"]];
  });
}

export type ChangeRequestReviewerProps = {
  request: ChangeRequestListItem | null;
  onOpenChange: (open: boolean) => void;
  catalogFor: (date: string) => DraftCatalog | undefined;
  ensureCatalog: (date: string) => Promise<DraftCatalog>;
  onDecided: (message: string) => void;
  onConflict: (message: string) => void;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function DirectEntryChangeRequestReviewer({
  request,
  onOpenChange,
  catalogFor,
  ensureCatalog,
  onDecided,
  onConflict,
}: ChangeRequestReviewerProps) {
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadMessage, setLoadMessage] = useState("");
  const [model, setModel] = useState<ReviewerViewModel | null>(null);
  const [requestReason, setRequestReason] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<readonly ChangeRequestDetailItem[]>([]);
  const [historyNames, setHistoryNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [canViewOwnRequest, setCanViewOwnRequest] = useState(false);
  const [reason, setReason] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [busy, setBusy] = useState<ChangeRequestDecision | null>(null);
  const [confirmDecision, setConfirmDecision] = useState<ChangeRequestDecision | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const notify = useNotify();
  const intentKey = useRef<TransitionIntentKeyState>(EMPTY_INTENT_KEY);
  const lastRequestId = useRef<string | null>(null);
  // Radix Dialog khong tu tra focus khi khong dung Dialog.Trigger; ghi lai nut da mo dialog.
  const openerRef = useRef<HTMLElement | null>(null);

  const formatField = useCallback(
    (entry: ProposerEntryProjection, field: string, value: string,
      authoritativeDisplay?: string | null): string | null => {
      // P3-W07C-R6-R1: nhan Du an / Nguoi tuyen lay tu catalog HIEN TAI (actor-scoped),
      // khong theo first_work_date cua ban ghi.
      const catalog = catalogFor(hcmTodayDate());
      if (field === "project_id") return catalogProjectLabel(catalog, value);
      if (field === "recruiter_id") return catalogRecruiterLabel(catalog, value);
      if (field === "collaborator_id") {
        if (value === "") return "Không qua CTV";
        return authoritativeDisplay ?? catalogCollaboratorLabel(catalog, value);
      }
      if (field === "labor_type") return authoritativeDisplay ?? null;
      return value;
    },
    [catalogFor],
  );

  // Bank id -> nhan catalog tu catalog hien tai; khong giai duoc thi fail-closed.
  const bankLabelFromCatalog = useCallback((bankId: string): string | null => {
    const catalog = catalogFor(hcmTodayDate());
    return catalog?.banks.find((bank) => bank.bank_id === bankId)?.display_name ?? null;
  }, [catalogFor]);

  useEffect(() => {
    if (!request) return undefined;
    const requestId = request.request_id;
    // Mo mot yeu cau khac thi moi reset trang thai; tai lai sau 409/loi thi giu nguyen
    // ly do da nhap va thong bao vua hien de nguoi dung con thay.
    const isNewRequest = lastRequestId.current !== requestId;
    lastRequestId.current = requestId;
    let cancelled = false;
    async function load() {
      if (isNewRequest) {
        setLoadState("loading");
        setModel(null);
        setRequestReason(null);
        setHistoryItems([]);
        setHistoryNames(new Map());
        setCanViewOwnRequest(false);
      }
      setLoadMessage("");
      if (isNewRequest) {
        setStatusMessage("");
        setReason("");
        setConfirmDecision(null);
        openerRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      }
      try {
        const detailResponse = await fetch(
          "/api/direct-entry/change-requests/" + encodeURIComponent(requestId),
          { cache: "no-store", credentials: "same-origin" },
        );
        const detailBody = await readJson(detailResponse);
        if (!detailResponse.ok) throw new Error("CHANGE_REQUEST_UNAVAILABLE");
        const detail = projectChangeRequestDetail(
          projectionSlice(detailBody, DETAIL_KEYS),
          { request_id: requestId },
        );
        if (!detail) {
          // Payload khong qua duoc projection strict: fail-closed, khong render gi.
          if (cancelled) return;
          setModel(unsupportedReviewerViewModel(requestId, "PROPOSAL"));
          setLoadState("ready");
          return;
        }
        setRequestReason(detail.request_reason);
        setHistoryItems(detail.items);
        setCanViewOwnRequest(detail.can_withdraw);
        const terminal = detail.state !== "PENDING";
        const readOnlyView = terminal || !detail.can_decide;
        if (readOnlyView) {
          // R2.2 Read-only mode P0: render truc tiep tu detail.items[].proposal immutable,
          // KHONG goi /api/direct-entry/entries/[entryId] de tranh 403 lam gay lich su sau khi doi phan cong.
          await ensureCatalog(hcmTodayDate()).catch(() => null);
          if (cancelled) return;
          setHistoryNames(new Map());
          if (terminal) {
            setModel({ kind: "terminal", request_id: detail.request_id, state: detail.state });
          } else {
            setModel({ kind: "terminal", request_id: detail.request_id, state: detail.state });
          }
          setLoadState("ready");
          return;
        }
        const entries = new Map<string, ProposerEntryProjection>();
        const contexts = new Map<string, EntrySensitiveContext>();
        const names = new Map<string, string>();
        // Phan loai dung nguyen nhan khi khong doc duoc entry, de dialog bao dung taxonomy
        // thay vi nhan chung "can phien ban giao dien hoac quyen xem khac".
        let entryFailure: ReviewerUnsupportedReason | null = null;
        for (const item of detail.items) {
          let response: Response;
          try {
            response = await fetch(
              "/api/direct-entry/entries/" + encodeURIComponent(item.entry_id),
              { cache: "no-store", credentials: "same-origin" },
            );
          } catch (cause) {
            if (terminal) continue;
            throw cause;
          }
          const body = await readJson(response);
          const slice = projectionSlice(body, ENTRY_KEYS);
          const context = slice ? projectEntrySensitiveContext(slice.entry) : null;
          if (context?.workerDetails) names.set(item.entry_id, context.workerDetails.display_name);
          if (terminal) continue;
          const entry = slice ? projectProposerEntry(slice.entry) : null;
          if (!response.ok) {
            entryFailure ??= (response.status === 403 || response.status === 404)
              ? "ENTRY_DENIED"
              : "ENTRY_UNAVAILABLE";
            continue;
          }
          if (!entry || entry.entry_id !== item.entry_id) {
            entryFailure ??= "ENTRY";
            continue;
          }
          entries.set(entry.entry_id, entry);
          // Sensitive context is strict-projected separately and remains server-authorized.
          if (context) contexts.set(entry.entry_id, context);
        }
        if (cancelled) return;
        setHistoryNames(names);
        if (terminal) {
          setModel({ kind: "terminal", request_id: detail.request_id, state: detail.state });
          setLoadState("ready");
          return;
        }
        if (entryFailure !== null && entries.size < detail.items.length) {
          if (cancelled) return;
          setModel(unsupportedReviewerViewModel(requestId, entryFailure));
          setLoadState("ready");
          return;
        }
        // P3-W07C-R6-R1: khong tai catalog theo first_work_date cua tung ban ghi.
        await ensureCatalog(hcmTodayDate()).catch(() => null);
        if (cancelled) return;
        setModel(buildReviewerViewModel({
          detail, entries, format: formatField, contexts, bankLabel: bankLabelFromCatalog,
        }));
        setLoadState("ready");
      } catch (cause) {
        if (cancelled) return;
        setModel(null);
        setLoadState("error");
        setLoadMessage(cause instanceof Error ? cause.message : "CHANGE_REQUEST_UNAVAILABLE");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [bankLabelFromCatalog, ensureCatalog, formatField, reloadToken, request]);

  // Nut quyet dinh van duoc render khi dang gui (disabled + "Dang gui…"), chi an khi request
  // khong con o trang thai cho quyet dinh.
  const canDecide = loadState === "ready" && model?.kind === "reviewable";
  const canReject = request?.state === "PENDING" && request.can_decide === true &&
    (canDecide || model?.kind === "stale" || model?.kind === "unsupported" ||
      model?.kind === "readonly" || loadState === "error");

  const decide = useCallback(async (decision: ChangeRequestDecision) => {
    if (!request || (decision === "approve" && !canDecide) || (decision === "reject" && !canReject)) return;
    const requestId = request.request_id;
    const expectedVersion = model && "version" in model ? model.version : request.version;
    const trimmed = normalizeReason(reason);
    const intent = decisionIntentSignature(requestId, decision, trimmed);
    const resolved = resolveIntentKey(intentKey.current, intent, () => crypto.randomUUID());
    intentKey.current = resolved.state;
    const payload = buildDecisionRequest({
      decision,
      expectedVersion,
      reason: trimmed,
      idempotencyKey: resolved.key,
    });
    if (!payload) {
      setStatusMessage(reviewerErrorMessage(400));
      return;
    }
    setBusy(decision);
    setStatusMessage("");
    try {
      const response = await fetch(
        "/api/direct-entry/change-requests/" + encodeURIComponent(requestId) + "/decision",
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": resolved.key,
          },
          body: JSON.stringify(payload),
        },
      );
      const body = await readJson(response);
      if (response.ok) {
        const updated = projectChangeRequestStateResult(
          projectionSlice(body, DECISION_RESULT_KEYS),
          {
            request_id: requestId,
            expected_version: expectedVersion,
            state: reviewDecisionState(decision),
          },
        );
        if (!updated) {
          // 2xx nhung ket qua khong doc duoc: giu nguyen key de lan thu lai van idempotent.
          notify.error({
            title: reviewerErrorMessage(500),
            dedupeKey: "cr-review-err:" + requestId,
          });
          return;
        }
        intentKey.current = clearIntentKey(resolved.state, intent);
        setModel({ kind: "terminal", request_id: updated.request_id, state: updated.state });
        const message = reviewDecisionMessage(decision, shortRef(updated.request_id));
        onDecided(message);
        onOpenChange(false);
        return;
      }
      const status = response.status;
      if (status >= 500) {
        notify.error({
          title: reviewerErrorMessage(status),
          dedupeKey: "cr-review-err:" + requestId,
        });
        return;
      }
      intentKey.current = clearIntentKey(resolved.state, intent);
      if (status === 409) {
        onConflict(reviewerErrorMessage(status));
        setReloadToken((current) => current + 1);
      } else if (status === 401 || status === 403) {
        onConflict(reviewerErrorMessage(status));
      } else {
        notify.error({
          title: reviewerErrorMessage(status),
          dedupeKey: "cr-review-err:" + requestId,
        });
      }
    } catch {
      notify.error({
        title: reviewerErrorMessage(0),
        dedupeKey: "cr-review-err:" + requestId,
      });
    } finally {
      setBusy(null);
    }
  }, [canDecide, canReject, model, notify, onConflict, onDecided, onOpenChange, reason, request]);

  const entryCount = useMemo(
    () => (model && "items" in model ? model.items.length : 0),
    [model],
  );

  return (
    <Dialog.Root open={request !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay data-ui-overlay-motion="true" className={styles.drawerOverlay} />
        {request && (
          <Dialog.Content
            className={styles.drawer}
            data-testid="reviewer-dialog"
            data-ui-drawer-motion="right"
            onCloseAutoFocus={(event) => {
              const opener = openerRef.current;
              if (opener && opener.isConnected) {
                event.preventDefault();
                opener.focus();
              }
            }}
          >
            <Dialog.Title className={styles.drawerTitle}>Xem xét yêu cầu thay đổi</Dialog.Title>
            <Dialog.Description className={styles.drawerDescription}>
              Yêu cầu {shortRef(request.request_id)} · {CHANGE_REQUEST_STATE_LABELS[request.state]}
              {entryCount > 0 ? " · " + entryCount + " dòng" : ""}
              {" · Người đề xuất: " + request.proposer_display_name}
            </Dialog.Description>

            <div className={styles.drawerFields}>
              <div className={styles.notice} aria-live="polite">
                {loadState === "loading" && "Đang tải chi tiết yêu cầu thay đổi…"}
                {loadState === "error" &&
                  "Không tải được chi tiết yêu cầu thay đổi (" + loadMessage + ")."}
              </div>

              {model?.kind === "unsupported" && (
                <p className={styles.notice} data-testid="reviewer-unsupported"
                  data-reason={model.reason}>
                  {reviewerUnsupportedMessage(model.reason)}
                </p>
              )}

              {requestReason !== null && (
                <section className={styles.proposerEntry} aria-label="Lý do đề xuất">
                  <strong>Lý do đề xuất</strong>
                  <p className={`${styles.submissionHint} ${styles.reviewerReason}`}>
                    {requestReason}
                  </p>
                </section>
              )}

              {model?.kind === "terminal" && (
                <>
                  <p className={styles.submissionTerminalNote} data-testid="reviewer-terminal">
                    {model.state === "PENDING"
                      ? "Yêu cầu đang ở trạng thái chờ duyệt. Nội dung bên dưới là bản chụp đề xuất đã gửi."
                      : `Yêu cầu đã ở trạng thái ${CHANGE_REQUEST_STATE_LABELS[model.state]} và không còn chờ quyết định.`}
                  </p>
                  <section aria-label="Nội dung đề xuất" data-testid="change-request-history-detail">
                    <strong>Nội dung đề xuất</strong>
                    {historyItems.map((item) => (
                      <div key={item.entry_id} className={styles.proposerEntry}>
                        <strong>{historyNames.get(item.entry_id) ?? "Người lao động"}</strong>
                        <p className={styles.submissionHint}>
                          {REVIEW_TARGET_KIND_LABELS[item.target_kind] ?? "Yêu cầu thay đổi"}
                        </p>
                        <dl className={styles.profileFieldList}>{historyRows(item, catalogFor(hcmTodayDate())).map(([label, value], index) => (
                          <div key={label + index}><dt>{label}</dt><dd>{value}</dd></div>
                        ))}</dl>
                      </div>
                    ))}
                  </section>
                </>
              )}

              {canViewOwnRequest && model?.kind === "unsupported" && historyItems.length > 0 && (
                <section aria-label="Nội dung đề xuất" data-testid="change-request-history-detail">
                  <strong>Nội dung đề xuất</strong>
                  {historyItems.map((item) => (
                    <div key={item.entry_id} className={styles.proposerEntry}>
                      <strong>{historyNames.get(item.entry_id) ?? "Người lao động"}</strong>
                      <p className={styles.submissionHint}>
                        {REVIEW_TARGET_KIND_LABELS[item.target_kind] ?? "Yêu cầu thay đổi"}
                      </p>
                      <dl className={styles.profileFieldList}>{historyRows(item, catalogFor(hcmTodayDate())).map(([label, value], index) => (
                        <div key={label + index}><dt>{label}</dt><dd>{value}</dd></div>
                      ))}</dl>
                    </div>
                  ))}
                </section>
              )}

              {model?.kind === "stale" && (
                <p role="status" className={styles.submissionBlocked} data-testid="reviewer-stale">
                  {STALE_REVIEW_MESSAGE}
                </p>
              )}

              {model?.kind === "readonly" && (
                <p role="status" className={styles.submissionBlocked} data-testid="reviewer-readonly">
                  {model.message}
                </p>
              )}

              {(model?.kind === "reviewable" || model?.kind === "stale" ||
                model?.kind === "readonly") && (
                <>
                  {model.items.map((entry) => (
                    <div key={entry.entry_id} className={styles.proposerEntry}>
                      <strong>{entry.worker_name ?? "Tên người lao động chưa được cấp quyền hiển thị"}</strong>
                      <p className={styles.submissionHint} data-testid="reviewer-item-project">
                        Dự án: {entry.project_name ?? "Chưa tải được tên dự án"}
                      </p>
                      <p className={styles.submissionHint} data-testid="reviewer-item-kind">
                        {REVIEW_TARGET_KIND_LABELS[entry.targetKind] ?? entry.targetKind}
                      </p>
                      {entry.message !== null && (
                        <p className={styles.submissionHint} data-testid="reviewer-item-message">
                          {entry.message}
                        </p>
                      )}
                      {entry.rows.length === 0 ? (
                        <p className={styles.submissionHint}>
                          Không còn thay đổi so với dữ liệu hiện tại.
                        </p>
                      ) : (
                        <table className={styles.reviewerTable}>
                          <caption className={styles.submissionHint}>
                            So sánh giá trị hiện tại và giá trị đề xuất của {entry.worker_name ?? "người lao động"}
                          </caption>
                          <thead>
                            <tr><th scope="col">Trường</th><th scope="col">Hiện tại</th><th scope="col">Đề xuất</th></tr>
                          </thead>
                          <tbody>
                            {entry.rows.map((row) => (
                              <tr key={row.field}>
                                <th scope="row">{row.label}</th>
                                <td data-label="Hiện tại" className={styles.reviewerCellBefore}>{row.before}</td>
                                <td data-label="Đề xuất" className={styles.reviewerCellAfter}>{row.after}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ))}

                  {(model.kind === "reviewable" || model.kind === "stale") && (
                    <div className={styles.field}>
                      <label htmlFor="change-request-decision-reason">
                        Lý do quyết định (không bắt buộc)
                      </label>
                      <textarea
                        id="change-request-decision-reason"
                        aria-label="Lý do quyết định"
                        rows={3}
                        maxLength={4000}
                        value={reason}
                        onChange={(event) => {
                          setReason(event.target.value);
                          setStatusMessage("");
                        }}
                      />
                    </div>
                  )}

                  <p className={styles.submissionHint}>
                    Quyết định áp dụng atomic cho toàn bộ {entryCount} dòng của yêu cầu: nếu một dòng
                    không áp dụng được, toàn bộ yêu cầu không thay đổi.
                  </p>
                </>
              )}

              {canReject && !canDecide && model?.kind !== "stale" && (
                <div className={styles.field}>
                  <label htmlFor="change-request-decision-reason">
                    Lý do từ chối (không bắt buộc)
                  </label>
                  <textarea
                    id="change-request-decision-reason"
                    aria-label="Lý do từ chối"
                    rows={3}
                    maxLength={4000}
                    value={reason}
                    onChange={(event) => {
                      setReason(event.target.value);
                      setStatusMessage("");
                    }}
                  />
                </div>
              )}

              {statusMessage && (
                <p role="alert" data-testid="reviewer-status">{statusMessage}</p>
              )}
            </div>

            <div className={styles.drawerActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={loadState === "loading" || busy !== null}
                onClick={() => setReloadToken((current) => current + 1)}
              >
                Tải lại
              </button>
              <Dialog.Close asChild>
                <button type="button" className={styles.secondaryButton} disabled={busy !== null}>
                  Đóng
                </button>
              </Dialog.Close>
              {(canDecide || canReject) && (
                <>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    aria-busy={busy === "reject"}
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmDecision("reject");
                    }}
                  >
                    {busy === "reject" ? "Đang gửi…" : REVIEW_DECISION_LABELS.reject}
                  </button>
                  {canDecide && <button
                    type="button"
                    className={styles.primaryButton}
                    aria-busy={busy === "approve"}
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmDecision("approve");
                    }}
                  >
                    {busy === "approve" ? "Đang gửi…" : REVIEW_DECISION_LABELS.approve}
                  </button>}
                </>
              )}
            </div>

            <AlertDialog.Root open={confirmDecision !== null} onOpenChange={(open) => {
              if (!open) setConfirmDecision(null);
            }}>
              <AlertDialog.Portal>
                <AlertDialog.Overlay className={styles.drawerOverlay} />
                {confirmDecision && (
                  <AlertDialog.Content className={styles.confirmDialog}>
                    <AlertDialog.Title className={styles.drawerTitle}>
                      {confirmDecision === "approve" ? "Duyệt yêu cầu thay đổi?" : "Từ chối yêu cầu thay đổi?"}
                    </AlertDialog.Title>
                    <AlertDialog.Description className={styles.drawerDescription}>
                      Quyết định áp dụng atomic cho toàn bộ {entryCount} dòng của yêu cầu này. Nếu một
                      dòng không áp dụng được, toàn bộ yêu cầu không thay đổi.
                    </AlertDialog.Description>
                    <div className={styles.drawerActions}>
                      <AlertDialog.Cancel asChild>
                        <button type="button" className={styles.secondaryButton}>Hủy</button>
                      </AlertDialog.Cancel>
                      <AlertDialog.Action asChild>
                        <button
                          type="button"
                          className={styles.primaryButton}
                          onClick={() => {
                            const decision = confirmDecision;
                            setConfirmDecision(null);
                            void decide(decision);
                          }}
                        >
                          {confirmDecision === "approve" ? "Duyệt yêu cầu" : "Từ chối yêu cầu"}
                        </button>
                      </AlertDialog.Action>
                    </div>
                  </AlertDialog.Content>
                )}
              </AlertDialog.Portal>
            </AlertDialog.Root>
          </Dialog.Content>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}
