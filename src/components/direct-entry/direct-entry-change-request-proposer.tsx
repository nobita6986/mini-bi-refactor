"use client";

/**
 * P1.6-W04-S04C-S03B1 - Proposer tao change request ENTRY_FIELD cho mot dot da SUBMITTED.
 *
 * - Chi ho tro target_kind ENTRY_FIELD voi 5 field khong PII. Cac loai khac (thong tin ca nhan,
 *   thanh toan, trang thai lam viec, tai lieu) khong duoc gui va khong gia vo la da ho tro.
 * - Mot POST duy nhat cho 1..N entry (atomic). Khong optimistic update.
 * - Khong goi change-request detail endpoint; khong render raw proposal/JSON.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog, Dialog } from "radix-ui";

import { DdmmDateInput } from "@/components/direct-entry/direct-entry-ddmm-date-input";
import { RecruiterTypeahead, type PickerOption } from "@/components/direct-entry/typeahead-picker-smoke";
import { useNotify } from "@/components/ui/notify-provider";
import {
  buildProposerItems,
  changeRequestErrorMessage,
  changedProposerFields,
  normalizeReason,
  projectProposerEntry,
  projectionSlice,
  proposalFromDraft,
  proposerErrorMessage,
  PROPOSER_FIELD_LABELS,
  summarizeProposal,
  type ProposerEntryDraft,
  type ProposerEntryProjection,
  type ProposerFields,
} from "@/lib/direct-entry/change-request-proposer";
import {
  projectChangeRequestCreate,
  projectChangeRequestCreated,
  REASON_MAX_LENGTH,
  type ChangeRequestItem,
} from "@/lib/direct-entry/change-request-contract";
import {
  allowedWorkStatusTargets,
  buildChangeRequestItem,
  buildPaymentProposal,
  buildWorkerDetailsProposal,
  buildWorkStatusProposal,
  hcmTodayDate,
  proposalErrorMessage,
  workerFormFromDetails,
  type ProposalBuildError,
  type WorkerForm,
} from "@/lib/direct-entry/change-request-proposal-builders";
import {
  DOCUMENT_STAGING_MESSAGE,
  OPTIONAL_STATE_LABELS,
  PAYMENT_STATE_LABELS,
  WORKER_FIELD_LABELS,
  WORK_STATUS_LABELS,
  projectEntrySensitiveContext,
  type EntrySensitiveContext,
} from "@/lib/direct-entry/change-request-read-projection";
import type { WorkerFieldForm } from "@/lib/direct-entry/change-request-proposal-builders";
import {
  PAYMENT_STATES,
  type PaymentInput,
  type PaymentState,
} from "@/lib/direct-entry/payment-contract";
import type { WorkerStatus } from "@/lib/contracts/direct-entry-v1";
import {
  DETAIL_KEYS,
  projectSubmissionDetail,
} from "@/lib/direct-entry/submission-read-contract";
import type { SubmissionReadItem } from "@/lib/direct-entry/submission-read-contract";
import {
  clearIntentKey,
  EMPTY_INTENT_KEY,
  resolveIntentKey,
  type TransitionIntentKeyState,
} from "@/lib/direct-entry/submission-lifecycle";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";
import { sortedActiveLaborTypes } from "@/lib/direct-entry/labor-type-catalog-ui";

import styles from "./direct-entry-shell.module.css";

/** Target kind UI ho tro trong S03B4A. DOCUMENT chua co staging boundary => khong chon duoc. */
type ProposerTargetKind = "ENTRY_FIELD" | "WORKER" | "PAYMENT" | "WORK_STATUS" | "ENTRY_VOID";

const PROPOSER_KIND_LABELS: Readonly<Record<ProposerTargetKind, string>> = Object.freeze({
  ENTRY_FIELD: "Thông tin dòng nhập liệu",
  WORKER: "Thông tin cá nhân người lao động",
  PAYMENT: "Thông tin tài khoản ngân hàng",
  WORK_STATUS: "Trạng thái làm việc",
  ENTRY_VOID: "Đề nghị hủy hồ sơ trùng",
});

const PROPOSER_KINDS: readonly ProposerTargetKind[] =
  ["ENTRY_FIELD", "WORKER", "PAYMENT", "WORK_STATUS", "ENTRY_VOID"];

type SensitiveBuildError = ProposalBuildError | "ENTRY_SELECT_REQUIRED" | "ITEM_INVALID";

function sensitiveErrorMessage(code: SensitiveBuildError): string {
  if (code === "ENTRY_SELECT_REQUIRED") return "Chọn một dòng để đề xuất thay đổi.";
  if (code === "ITEM_INVALID") return "Yêu cầu thay đổi không hợp lệ.";
  return proposalErrorMessage(code);
}

export type ChangeRequestProposerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submission: SubmissionReadItem | null;
  catalogFor: (date: string) => DraftCatalog | undefined;
  ensureCatalog: (date: string) => Promise<DraftCatalog>;
  onCreated: (input: { request_id: string; items: number }) => void;
  onConflict: () => void;
  onUnauthorized: () => void;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function baselineOf(entry: ProposerEntryProjection): ProposerFields {
  return {
    employee_code: entry.employee_code,
    first_work_date: entry.first_work_date,
    project_id: entry.project_id,
    recruiter_id: entry.recruiter_id,
    collaborator_id: entry.collaborator_id,
    labor_type: entry.labor_type,
  };
}

function optionsFor(catalog: DraftCatalog | undefined): PickerOption[] {
  return catalog?.recruiters.map((recruiter) => ({
    id: recruiter.recruiter_id,
    // P3-W07A: server-side `label` is the canonical UI string.
    label: recruiter.label,
    groupLabel: recruiter.provider_type.toUpperCase() + " · " + (recruiter.team_display_name ?? "—"),
    provider: recruiter.provider_type.toUpperCase(),
    team: recruiter.team_display_name ?? "—",
  })) ?? [];
}

export function DirectEntryChangeRequestProposer({
  open,
  onOpenChange,
  submission,
  catalogFor,
  ensureCatalog,
  onCreated,
  onConflict,
  onUnauthorized,
}: ChangeRequestProposerProps) {
  const [entryState, setEntryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [entryMessage, setEntryMessage] = useState("");
  const [entries, setEntries] = useState<ProposerEntryProjection[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ProposerFields>>({});
  const [reason, setReason] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const notify = useNotify();
  const intentKey = useRef<TransitionIntentKeyState>(EMPTY_INTENT_KEY);
  const loadedSubmission = useRef<string | null>(null);
  // S03B4A: target kind nhay cam (worker_details/PAYMENT/WORK_STATUS) dung MOT dong moi request.
  const [kind, setKind] = useState<ProposerTargetKind>("ENTRY_FIELD");
  const [contexts, setContexts] = useState<Record<string, EntrySensitiveContext>>({});
  const [singleEntryId, setSingleEntryId] = useState<string | null>(null);
  const [workerForm, setWorkerForm] = useState<WorkerForm | null>(null);
  const [paymentDraft, setPaymentDraft] = useState<PaymentInput>({
    state: "omitted", account_number: null, bank_id: null, account_holder_name: null,
  });
  const [statusDraft, setStatusDraft] = useState<{
    status: WorkerStatus; effectiveDate: string; leaveReason: string;
  } | null>(null);

  // Chi reset form khi MO submission khac; lan tai lai do catalog doi identity khong duoc xoa
  // lua chon/draft nguoi dung dang nhap.
  useEffect(() => {
    if (!open) loadedSubmission.current = null;
  }, [open]);

  useEffect(() => {
    if (!open || !submission) return undefined;
    const submissionId = submission.submission_id;
    const isNewSubmission = loadedSubmission.current !== submissionId;
    let cancelled = false;
    async function load() {
      if (isNewSubmission) setEntryState("loading");
      try {
        const detailResponse = await fetch(
          "/api/direct-entry/submissions/" + encodeURIComponent(submission!.submission_id),
          { cache: "no-store", credentials: "same-origin" },
        );
        const detailBody = await readJson(detailResponse);
        const detail = projectSubmissionDetail(
          projectionSlice(detailBody, DETAIL_KEYS),
          { submission_id: submission!.submission_id },
        );
        if (!detailResponse.ok || !detail) throw new Error("SUBMISSION_UNAVAILABLE");
        const loaded: ProposerEntryProjection[] = [];
        const loadedContexts: Record<string, EntrySensitiveContext> = {};
        for (const entryId of detail.entry_ids) {
          const response = await fetch(
            "/api/direct-entry/entries/" + encodeURIComponent(entryId),
            { cache: "no-store", credentials: "same-origin" },
          );
          const body = await readJson(response);
          const slice = projectionSlice(body, ["entry"]);
          const entry = slice ? projectProposerEntry(slice.entry) : null;
          if (!response.ok || !entry || entry.entry_id !== entryId) {
            throw new Error("ENTRY_UNAVAILABLE");
          }
          loaded.push(entry);
          // Ngu canh nhay cam: server da redact theo capability; thieu quyen thi coi nhu KHONG CO.
          const context = slice ? projectEntrySensitiveContext(slice.entry) : null;
          if (context) loadedContexts[entry.entry_id] = context;
        }
        // P3-W07C-R6-R1: khong tai catalog theo first_work_date cua tung ban nhap.
        // Chi catalog ngay HCM cua trang duoc bao dam.
        await ensureCatalog(hcmTodayDate()).catch(() => null);
        if (cancelled) return;
        setEntries(loaded);
        setContexts(loadedContexts);
        if (isNewSubmission) {
          setDrafts({});
          setSelected([]);
          setSingleEntryId(null);
          setWorkerForm(null);
          setPaymentDraft({ state: "omitted", account_number: null, bank_id: null,
            account_holder_name: null });
          setStatusDraft(null);
          setKind("ENTRY_FIELD");
          setReason("");
          setStatusMessage("");
          loadedSubmission.current = submissionId;
        }
        setEntryState("ready");
        setEntryMessage("");
      } catch (cause) {
        if (cancelled) return;
        setEntryState("error");
        setEntryMessage(cause instanceof Error ? cause.message : "CHANGE_REQUEST_UNAVAILABLE");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [ensureCatalog, open, submission]);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.includes(entry.entry_id)),
    [entries, selected],
  );

  const proposerDrafts: ProposerEntryDraft[] = useMemo(
    () => selectedEntries.map((entry) => {
      const baseline = baselineOf(entry);
      return {
        entry_id: entry.entry_id,
        expected_version: entry.expected_version,
        baseline,
        draft: drafts[entry.entry_id] ?? baseline,
      };
    }),
    [drafts, selectedEntries],
  );

  const buildResult = useMemo(() => buildProposerItems(proposerDrafts), [proposerDrafts]);
  const activeBankIds = useMemo(() => {
    const ids = new Set<string>();
    // P3-W07C-R6-R1: bank id lay tu catalog HIEN TAI (actor-scoped); khong con
    // phu thuoc first_work_date cua tung ban nhap.
    for (const bank of catalogFor(hcmTodayDate())?.banks ?? []) ids.add(bank.bank_id);
    return ids;
  }, [catalogFor]);

  const singleEntry = useMemo(
    () => entries.find((entry) => entry.entry_id === singleEntryId) ?? null,
    [entries, singleEntryId],
  );

  /** Item cho target kind nhay cam: MOT dong, di qua builder + validator cua contract. */
  const sensitiveBuild = useMemo<
    { ok: true; item: ChangeRequestItem } | { ok: false; code: SensitiveBuildError }
  >(() => {
    if (kind === "ENTRY_FIELD") return { ok: false, code: "ENTRY_SELECT_REQUIRED" };
    if (!singleEntry) return { ok: false, code: "ENTRY_SELECT_REQUIRED" };
    const context = contexts[singleEntry.entry_id] ?? null;
    let built: { ok: true; proposal: Record<string, unknown> } |
      { ok: false; code: ProposalBuildError };
    if (kind === "ENTRY_VOID") {
      built = { ok: true, proposal: {} };
    } else if (kind === "WORKER") {
      const baseline = context?.workerDetails ?? null;
      if (!baseline) return { ok: false, code: "WORKER_UNAVAILABLE" };
      built = buildWorkerDetailsProposal(baseline,
        workerForm ?? workerFormFromDetails(baseline));
    } else if (kind === "PAYMENT") {
      const payment = context?.payment ?? null;
      const baseline: PaymentInput | null = payment === null ? null : {
        state: payment.state, account_number: payment.account_number,
        bank_id: payment.bank_id, account_holder_name: payment.account_holder_name,
      };
      built = buildPaymentProposal({ baseline, draft: paymentDraft, activeBankIds });
    } else {
      built = buildWorkStatusProposal({
        baseline: context?.employmentStatus ?? null,
        status: statusDraft?.status ?? "ON",
        effectiveDate: statusDraft?.effectiveDate ?? "",
        leaveReason: statusDraft?.leaveReason ?? "",
        today: hcmTodayDate(),
      });
    }
    if (!built.ok) return { ok: false, code: built.code };
    const targetKind = kind === "WORKER" ? "ENTRY_FIELD" : kind;
    const item = buildChangeRequestItem({
      entryId: singleEntry.entry_id,
      expectedVersion: singleEntry.expected_version,
      targetKind,
      proposal: built.proposal,
    });
    if (!item) return { ok: false, code: "ITEM_INVALID" };
    return { ok: true, item };
  }, [activeBankIds, contexts, kind, paymentDraft, singleEntry, statusDraft, workerForm]);

  const itemsToSend = useMemo<ChangeRequestItem[] | null>(() => {
    if (kind === "ENTRY_FIELD") return buildResult.ok ? buildResult.items : null;
    return sensitiveBuild.ok ? [sensitiveBuild.item] : null;
  }, [buildResult, kind, sensitiveBuild]);

  const canSubmit = itemsToSend !== null && reason.length <= REASON_MAX_LENGTH && !busy &&
    entryState === "ready";

  /** Chọn một dòng cho target kind nhạy cảm và khởi tạo form từ context server đã xác thực. */
  function selectSingleEntry(entry: ProposerEntryProjection) {
    setSingleEntryId(entry.entry_id);
    const context = contexts[entry.entry_id] ?? null;
    setWorkerForm(context?.workerDetails ? workerFormFromDetails(context.workerDetails) : null);
    const payment = context?.payment ?? null;
    setPaymentDraft(payment && payment.state === "provided"
      ? {
        state: "provided",
        account_number: payment.account_number,
        bank_id: payment.bank_id,
        account_holder_name: payment.account_holder_name,
      }
      : { state: payment?.state ?? "omitted", account_number: null, bank_id: null,
        account_holder_name: null });
    const status = context?.employmentStatus ?? null;
    setStatusDraft(status
      ? { status: allowedWorkStatusTargets(status.status)[0] ?? status.status,
        effectiveDate: hcmTodayDate(), leaveReason: "" }
      : null);
    setStatusMessage("");
  }

  function toggleEntry(entryId: string) {
    setSelected((current) => current.includes(entryId)
      ? current.filter((id) => id !== entryId)
      : [...current, entryId]);
    setStatusMessage("");
  }

  function editEntry(entryId: string, patch: Partial<ProposerFields>) {
    setDrafts((current) => {
      const entry = entries.find((item) => item.entry_id === entryId);
      const base = current[entryId] ?? (entry ? baselineOf(entry) : null);
      if (!base) return current;
      return { ...current, [entryId]: { ...base, ...patch } };
    });
    setStatusMessage("");
  }

  const submit = useCallback(async () => {
    if (itemsToSend === null) {
      setStatusMessage(kind === "ENTRY_FIELD"
        ? proposerErrorMessage(buildResult.ok ? "NO_ENTRY" : buildResult.code)
        : sensitiveErrorMessage(sensitiveBuild.ok ? "ITEM_INVALID" : sensitiveBuild.code));
      return;
    }
    const normalized = normalizeReason(reason);
    if (reason.length > REASON_MAX_LENGTH) {
      setStatusMessage("Lý do tối đa 4000 ký tự.");
      return;
    }
    const signature = JSON.stringify({ items: itemsToSend, reason: normalized });
    const intent = "change_request_create:" + signature;
    const resolved = resolveIntentKey(intentKey.current, intent, () => crypto.randomUUID());
    intentKey.current = resolved.state;
    const body = {
      items: itemsToSend,
      reason: normalized,
      idempotency_key: resolved.key,
    };
    const validated = projectChangeRequestCreate(body);
    if (!validated.ok) {
      setStatusMessage("Yêu cầu thay đổi không hợp lệ.");
      return;
    }
    setBusy(true);
    setStatusMessage("");
    try {
      const response = await fetch("/api/direct-entry/change-requests", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": resolved.key,
        },
        body: JSON.stringify(validated.value),
      });
      const payload = await readJson(response);
      if (response.ok) {
        const created = projectChangeRequestCreated(
          projectionSlice(payload, ["request_id", "state", "items"]),
          itemsToSend.length,
        );
        if (!created) {
          notify.error({
            title: changeRequestErrorMessage(500),
            dedupeKey: "cr-propose-err",
          });
          return;
        }
        intentKey.current = clearIntentKey(resolved.state, intent);
        onCreated({ request_id: created.request_id, items: created.items });
        onOpenChange(false);
        return;
      }
      const status = response.status;
      if (status === 409) {
        intentKey.current = clearIntentKey(resolved.state, intent);
        notify.warning({
          title: changeRequestErrorMessage(409),
          dedupeKey: "cr-propose-conflict",
        });
        onConflict();
        return;
      }
      if (status >= 500) {
        notify.error({
          title: changeRequestErrorMessage(status),
          dedupeKey: "cr-propose-err",
        });
        return;
      }
      intentKey.current = clearIntentKey(resolved.state, intent);
      notify.error({
        title: changeRequestErrorMessage(status),
        dedupeKey: "cr-propose-err",
      });
      if (status === 401 || status === 403) onUnauthorized();
    } catch {
      notify.error({
        title: changeRequestErrorMessage(0),
        dedupeKey: "cr-propose-err",
      });
    } finally {
      setBusy(false);
    }
  }, [buildResult, itemsToSend, kind, notify, onConflict, onCreated, onOpenChange, onUnauthorized,
    reason, sensitiveBuild]);

  const summaryLines = kind === "ENTRY_VOID"
    ? (singleEntry === null ? [] : [
      (contexts[singleEntry.entry_id]?.workerDetails?.display_name ?? "Người lao động") +
      " · " + singleEntry.employee_code + " · " + singleEntry.first_work_date +
      " · " + (catalogFor(hcmTodayDate())?.projects.find((item) =>
        item.project_id === singleEntry.project_id)?.display_name ?? "Dự án đã chọn"),
    ])
    : proposerDrafts.map((draft) => {
    const entry = entries.find((item) => item.entry_id === draft.entry_id);
    const changed = changedProposerFields(draft.baseline, draft.draft)
      .map((field) => PROPOSER_FIELD_LABELS[field]).join(", ");
    return (entry ? entry.employee_code : draft.entry_id) + ": " + (changed || "chưa có thay đổi");
  });

  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      if (!busy) onOpenChange(next);
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.drawerOverlay} />
        <Dialog.Content className={styles.drawer} aria-describedby="change-request-proposer-description">
          <Dialog.Title className={styles.drawerTitle}>Yêu cầu thay đổi</Dialog.Title>
          <Dialog.Description id="change-request-proposer-description" className={styles.drawerDescription}>
            Đề xuất thay đổi cho đợt đã gửi chính thức: thông tin dòng nhập liệu, thông tin cá
            nhân người lao động, thông tin tài khoản ngân hàng và trạng thái làm việc. Quyền quyết định cuối
            cùng do hệ thống kiểm tra khi duyệt.
          </Dialog.Description>

          <div className={styles.notice} aria-live="polite">
            {entryState === "loading" && "Đang tải các dòng của đợt…"}
            {entryState === "error" &&
              `Không tải được dòng của đợt (${entryMessage}).`}
            {entryState === "ready" && entries.length === 0 &&
              "Đợt này không có dòng nào để đề xuất thay đổi."}
          </div>

          <div className={styles.drawerFields}>
            {entryState === "ready" && entries.length > 0 && (
              <div className={styles.field}>
                <label htmlFor="change-request-kind">Loại yêu cầu thay đổi</label>
                <select
                  id="change-request-kind"
                  aria-label="Loại yêu cầu thay đổi"
                  value={kind}
                  onChange={(event) => {
                    const next = event.target.value as ProposerTargetKind;
                    if (!PROPOSER_KINDS.includes(next)) return;
                    setKind(next);
                    setSingleEntryId(null);
                    setWorkerForm(null);
                    setPaymentDraft({ state: "omitted", account_number: null, bank_id: null,
                      account_holder_name: null });
                    setStatusDraft(null);
                    setStatusMessage("");
                  }}
                >
                  {PROPOSER_KINDS.map((value) => (
                    <option key={value} value={value}>{PROPOSER_KIND_LABELS[value]}</option>
                  ))}
                  <option value="DOCUMENT" disabled>{DOCUMENT_STAGING_MESSAGE}</option>
                </select>
              </div>
            )}

            {kind === "ENTRY_FIELD" && entryState === "ready" && entries.map((entry) => {
              const isSelected = selected.includes(entry.entry_id);
              // P3-W07C-R6-R1: doi ngay trong change request khong doi catalog
              // Du an / Nguoi tuyen; dung catalog hien tai (actor-scoped).
              const catalog = catalogFor(hcmTodayDate());
              const baseline = baselineOf(entry);
              const draft = drafts[entry.entry_id] ?? baseline;
              return (
                <div key={entry.entry_id} className={styles.proposerEntry}>
                  <label className={styles.proposerChoice}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      aria-label={"Chọn dòng " + entry.employee_code}
                      onChange={() => toggleEntry(entry.entry_id)}
                    />
                    <span>
                      <strong>{entry.employee_code}</strong>
                      {" · "}{entry.first_work_date}
                    </span>
                  </label>
                  {isSelected && (
                    <div className={styles.proposerFields}>
                      <div className={styles.field}>
                        <label htmlFor={"cr-code-" + entry.entry_id}>Mã người lao động</label>
                        <input
                          id={"cr-code-" + entry.entry_id}
                          aria-label={"Mã người lao động của " + entry.employee_code}
                          value={draft.employee_code}
                          onChange={(event) => editEntry(entry.entry_id, {
                            employee_code: event.target.value,
                          })}
                        />
                      </div>
                      <div className={styles.field}>
                        <label htmlFor={"cr-date-" + entry.entry_id}>Ngày đầu tiên đi làm</label>
                        {/* P3-W07C-R6-R1: DD/MM/YYYY bat buoc, khong dung type="date". */}
                        <DdmmDateInput
                          ariaLabel={"Ngày đầu tiên đi làm của " + entry.employee_code}
                          value={draft.first_work_date}
                          onCommit={(iso) => editEntry(entry.entry_id, { first_work_date: iso })}
                        />
                      </div>
                      <div className={styles.field}>
                        <label htmlFor={"cr-project-" + entry.entry_id}>Dự án</label>
                        <select
                          id={"cr-project-" + entry.entry_id}
                          aria-label={"Dự án của " + entry.employee_code}
                          value={draft.project_id}
                          onChange={(event) => editEntry(entry.entry_id, {
                            project_id: event.target.value,
                          })}
                        >
                          <option value="">Chọn dự án</option>
                          {catalog?.projects.map((project) => (
                            <option key={project.project_id} value={project.project_id}>
                              {project.display_name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className={styles.field}>
                        <RecruiterTypeahead
                          id={"cr-recruiter-" + entry.entry_id}
                          options={optionsFor(catalog)}
                          value={draft.recruiter_id}
                          label={"Người tuyển của " + entry.employee_code}
                          onChange={(recruiterId) => {
                            const selectedRecruiter = catalog?.recruiters.find(
                              (item) => item.recruiter_id === recruiterId,
                            );
                            editEntry(entry.entry_id, {
                              recruiter_id: recruiterId,
                              ...(selectedRecruiter?.provider_type === "vendor"
                                ? { collaborator_id: null }
                                : {}),
                            });
                          }}
                        />
                      </div>
                      {(() => {
                        const selectedRecruiter = catalog?.recruiters.find(
                          (item) => item.recruiter_id === draft.recruiter_id,
                        );
                        const isVendor = selectedRecruiter?.provider_type === "vendor";
                        const activeCollaborators = (catalog?.collaborators ?? []).filter(
                          (collaborator) => collaborator.active,
                        );
                        const currentId = isVendor ? "" : (draft.collaborator_id ?? "");
                        const currentInActive = currentId !== "" &&
                          activeCollaborators.some((c) => c.collaborator_id === currentId);
                        return (
                          <div className={styles.field}>
                            <label htmlFor={"cr-collaborator-" + entry.entry_id}>Cộng tác viên (CTV)</label>
                            <select
                              id={"cr-collaborator-" + entry.entry_id}
                              aria-label={"CTV của " + entry.employee_code}
                              disabled={isVendor}
                              value={currentId}
                              onChange={(event) => editEntry(entry.entry_id, {
                                collaborator_id: event.target.value === "" ? null : event.target.value,
                              })}
                            >
                              <option value="">
                                {isVendor ? "Vendor không gắn CTV" : "Không qua CTV"}
                              </option>
                              {!isVendor && currentId !== "" && !currentInActive && (
                                <option value={currentId} disabled>
                                  {entry.collaborator_display_name
                                    ? `${entry.collaborator_display_name} (${currentId}) — Ngừng hoạt động`
                                    : `${currentId} — Ngừng hoạt động`}
                                </option>
                              )}
                              {activeCollaborators.map((collaborator) => (
                                <option key={collaborator.collaborator_id} value={collaborator.collaborator_id}>
                                  {collaborator.display_name} ({collaborator.collaborator_id})
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })()}
                      <div className={styles.field}>
                        <label htmlFor={"cr-labor-" + entry.entry_id}>Loại hình lao động</label>
                        <select
                          id={"cr-labor-" + entry.entry_id}
                          aria-label={"Loại hình lao động của " + entry.employee_code}
                          value={(catalog?.labor_types ?? []).some((option) =>
                            option.labor_type_key === draft.labor_type) ? draft.labor_type : ""}
                          onChange={(event) => editEntry(entry.entry_id, {
                            labor_type: event.target.value,
                          })}
                        >
                          <option value="">Chọn loại hình</option>
                          {sortedActiveLaborTypes(catalog?.labor_types).map((option) => (
                            <option key={option.labor_type_key} value={option.labor_type_key}>
                              {option.display_name}
                            </option>
                          ))}
                        </select>
                        <small>Hiện tại: {entry.labor_type_display}</small>
                      </div>
                      <p className={styles.submissionHint}>
                        Thay đổi: {changedProposerFields(baseline, draft)
                          .map((field) => PROPOSER_FIELD_LABELS[field]).join(", ") || "chưa có"}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}

            {kind !== "ENTRY_FIELD" && entryState === "ready" && entries.length > 0 && (
              <fieldset className={styles.proposerFields}>
                <legend>
                  {kind === "ENTRY_VOID" ? "Chọn chính xác một hồ sơ trùng" : "Chọn một dòng để đề xuất"}
                </legend>
                {entries.map((entry) => (
                  <label key={entry.entry_id} className={styles.proposerChoice}>
                    <input
                      type="radio"
                      name="change-request-entry"
                      aria-label={"Chọn một dòng " + entry.employee_code}
                      checked={singleEntryId === entry.entry_id}
                      onChange={() => selectSingleEntry(entry)}
                    />
                    <span>
                      <strong>{entry.employee_code}</strong>
                      {" · "}{entry.first_work_date}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            {kind === "WORKER" && singleEntry !== null && entryState === "ready" && (
              <div className={styles.proposerFields}>
                {workerForm === null ? (
                  <p className={styles.submissionHint} data-testid="proposer-worker-unavailable">
                    {sensitiveErrorMessage("WORKER_UNAVAILABLE")}
                  </p>
                ) : (
                  <>
                    <div className={styles.field}>
                      <label htmlFor="worker-display-name">Họ tên</label>
                      <input id="worker-display-name" aria-label="Họ tên người lao động"
                        value={workerForm.display_name}
                        onChange={(event) => setWorkerForm({ ...workerForm,
                          display_name: event.target.value })} />
                    </div>
                    {(["date_of_birth", "national_id", "address", "phone"] as const).map((field) => (
                      <div key={field} className={styles.field}>
                        <label htmlFor={"worker-" + field}>{WORKER_FIELD_LABELS[field]}</label>
                        <div className={styles.proposerFields}>
                          <select
                            aria-label={"Trạng thái " + WORKER_FIELD_LABELS[field]}
                            value={workerForm[field].state}
                            onChange={(event) => {
                              const state = event.target.value as WorkerFieldForm["state"];
                              setWorkerForm({ ...workerForm,
                                [field]: { state, text: state === "provided"
                                  ? workerForm[field].text : "" } });
                            }}
                          >
                            <option value="omitted">{OPTIONAL_STATE_LABELS.omitted}</option>
                            <option value="unknown">{OPTIONAL_STATE_LABELS.unknown}</option>
                            <option value="intentionally_blank">
                              {OPTIONAL_STATE_LABELS.intentionally_blank}
                            </option>
                            <option value="provided">Có giá trị</option>
                          </select>
                          <input
                            id={"worker-" + field}
                            aria-label={WORKER_FIELD_LABELS[field] + " người lao động"}
                            value={workerForm[field].text}
                            disabled={workerForm[field].state !== "provided"}
                            onChange={(event) => setWorkerForm({ ...workerForm,
                              [field]: { state: "provided", text: event.target.value } })}
                          />
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {kind === "PAYMENT" && singleEntry !== null && entryState === "ready" && (
              <div className={styles.proposerFields}>
                <div className={styles.field}>
                  <label htmlFor="payment-state">Trạng thái thông tin tài khoản ngân hàng</label>
                  <select
                    id="payment-state"
                    aria-label="Trạng thái thông tin tài khoản ngân hàng"
                    value={paymentDraft.state}
                    onChange={(event) => {
                      const state = event.target.value as PaymentState;
                      setPaymentDraft(state === "provided"
                        ? { ...paymentDraft, state, account_number: paymentDraft.account_number ?? "" }
                        : { state, account_number: null, bank_id: null, account_holder_name: null });
                      setStatusMessage("");
                    }}
                  >
                    {PAYMENT_STATES.map((state) => (
                      <option key={state} value={state}>{PAYMENT_STATE_LABELS[state]}</option>
                    ))}
                  </select>
                </div>
                {paymentDraft.state === "provided" && (
                  <>
                    <div className={styles.field}>
                      <label htmlFor="payment-account">Số tài khoản</label>
                      <input id="payment-account" aria-label="Số tài khoản" inputMode="numeric"
                        value={paymentDraft.account_number ?? ""}
                        onChange={(event) => setPaymentDraft({ ...paymentDraft,
                          account_number: event.target.value })} />
                    </div>
                    <div className={styles.field}>
                      <label htmlFor="payment-bank">Ngân hàng</label>
                      <select id="payment-bank" aria-label="Ngân hàng"
                        value={paymentDraft.bank_id ?? ""}
                        onChange={(event) => setPaymentDraft({ ...paymentDraft,
                          bank_id: event.target.value || null })}>
                        <option value="">Chọn ngân hàng</option>
                        {(catalogFor(hcmTodayDate())?.banks ?? []).map((bank) => (
                          <option key={bank.bank_id} value={bank.bank_id}>{bank.display_name}</option>
                        ))}
                      </select>
                    </div>
                    <div className={styles.field}>
                      <label htmlFor="payment-holder">Tên chủ tài khoản</label>
                      <input id="payment-holder" aria-label="Tên chủ tài khoản"
                        value={paymentDraft.account_holder_name ?? ""}
                        onChange={(event) => setPaymentDraft({ ...paymentDraft,
                          account_holder_name: event.target.value })} />
                    </div>
                  </>
                )}
              </div>
            )}

            {kind === "WORK_STATUS" && singleEntry !== null && entryState === "ready" && (
              <div className={styles.proposerFields}>
                {statusDraft === null ? (
                  <p className={styles.submissionHint} data-testid="proposer-status-unavailable">
                    {sensitiveErrorMessage("STATUS_INVALID")}
                  </p>
                ) : (
                  <>
                    <p className={styles.submissionHint}>
                      Trạng thái hiện tại:{" "}
                      {WORK_STATUS_LABELS[contexts[singleEntry.entry_id]?.employmentStatus?.status ??
                        "UNCONFIRMED"]}
                    </p>
                    <div className={styles.field}>
                      <label htmlFor="status-target">Trạng thái làm việc</label>
                      <select id="status-target" aria-label="Trạng thái làm việc"
                        value={statusDraft.status}
                        onChange={(event) => setStatusDraft({ ...statusDraft,
                          status: event.target.value as WorkerStatus })}>
                        {(allowedWorkStatusTargets(
                          contexts[singleEntry.entry_id]?.employmentStatus?.status ?? null,
                        )).map((status) => (
                          <option key={status} value={status}>{WORK_STATUS_LABELS[status]}</option>
                        ))}
                      </select>
                    </div>
                    <div className={styles.field}>
                      <label htmlFor="status-date">Ngày hiệu lực</label>
                      <input id="status-date" type="date" aria-label="Ngày hiệu lực"
                        value={statusDraft.effectiveDate}
                        min={contexts[singleEntry.entry_id]?.employmentStatus?.effective_date}
                        max={hcmTodayDate()}
                        onChange={(event) => setStatusDraft({ ...statusDraft,
                          effectiveDate: event.target.value })} />
                    </div>
                    {statusDraft.status === "OFF" && (
                      <div className={styles.field}>
                        <label htmlFor="status-reason">Lý do nghỉ việc</label>
                        <textarea id="status-reason" aria-label="Lý do nghỉ việc" rows={3}
                          maxLength={4000}
                          value={statusDraft.leaveReason}
                          onChange={(event) => setStatusDraft({ ...statusDraft,
                            leaveReason: event.target.value })} />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {kind !== "ENTRY_FIELD" && singleEntry !== null && entryState === "ready" && (
              <div className={styles.proposerSummary} aria-live="polite">
                <strong>Tóm tắt 1 dòng sẽ gửi</strong>
                <ul>
                  <li>{singleEntry.employee_code + ": " + PROPOSER_KIND_LABELS[kind]}</li>
                </ul>
                <p className={styles.submissionHint}>
                  {sensitiveBuild.ok
                    ? "Trường thay đổi: " + Object.keys(sensitiveBuild.item.proposal).join(", ")
                    : sensitiveErrorMessage(sensitiveBuild.code)}
                </p>
              </div>
            )}

            {entryState === "ready" && entries.length > 0 && (
              <div className={styles.field}>
                <label htmlFor="change-request-reason">
                  {kind === "ENTRY_VOID" ? "Lý do đề nghị hủy hồ sơ trùng (không bắt buộc)" : "Lý do thay đổi (không bắt buộc)"}
                </label>
                <textarea
                  id="change-request-reason"
                  aria-label="Lý do thay đổi"
                  rows={3}
                  value={reason}
                  maxLength={4000}
                  onChange={(event) => { setReason(event.target.value); setStatusMessage(""); }}
                />
              </div>
            )}

            {entryState === "ready" && (proposerDrafts.length > 0 || kind === "ENTRY_VOID") && (
              <div className={styles.proposerSummary} aria-live="polite">
                <strong>
                  {kind === "ENTRY_VOID" ? "Hồ sơ được đề nghị hủy" :
                    `Tóm tắt ${proposerDrafts.length} dòng sẽ gửi`}
                </strong>
                <ul>
                  {summaryLines.map((line, index) => <li key={index}>{line}</li>)}
                </ul>
                {kind === "ENTRY_VOID" && (
                  <p className={styles.submissionHint}>
                    Chỉ đánh dấu hồ sơ này đã hủy sau khi được duyệt; dữ liệu và lịch sử vẫn được giữ.
                  </p>
                )}
                {buildResult.ok && (
                  <p className={styles.submissionHint}>
                    Trường thay đổi: {summarizeProposal(
                      proposalFromDraft(proposerDrafts[0].baseline, proposerDrafts[0].draft),
                    ) || "—"}
                  </p>
                )}
              </div>
            )}

            {statusMessage && <p role="alert">{statusMessage}</p>}
          </div>

          <div className={styles.drawerActions}>
            <Dialog.Close asChild>
              <button type="button" className={styles.secondaryButton} disabled={busy}>
                Hủy
              </button>
            </Dialog.Close>
            <button
              type="button"
              className={styles.primaryButton}
              aria-busy={busy}
              disabled={!canSubmit}
              onClick={() => {
                if (itemsToSend === null) {
                  setStatusMessage(kind === "ENTRY_FIELD"
                    ? proposerErrorMessage(buildResult.ok ? "NO_ENTRY" : buildResult.code)
                    : sensitiveErrorMessage(sensitiveBuild.ok ? "ITEM_INVALID" : sensitiveBuild.code));
                  return;
                }
                if (reason.length > REASON_MAX_LENGTH) {
                  setStatusMessage("Lý do tối đa 4000 ký tự.");
                  return;
                }
                setConfirmOpen(true);
              }}
            >
              {busy ? "Đang gửi…" : kind === "ENTRY_VOID" ? "Xem lại đề nghị hủy" : "Xem lại và gửi"}
            </button>
          </div>

          <AlertDialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className={styles.drawerOverlay} />
              <AlertDialog.Content className={styles.confirmDialog}>
                <AlertDialog.Title className={styles.drawerTitle}>
                  {kind === "ENTRY_VOID" ? "Gửi đề nghị hủy hồ sơ trùng?" : "Gửi yêu cầu thay đổi?"}
                </AlertDialog.Title>
                <AlertDialog.Description className={styles.drawerDescription}>
                  {kind === "ENTRY_VOID"
                    ? "Nếu được duyệt, hồ sơ này được đánh dấu hủy riêng (không phải Đã nghỉ), được giữ trong lịch sử và không còn tính vào báo cáo tuyển dụng."
                    : `Yêu cầu được gửi trong một lần cho tất cả ${itemsToSend?.length ?? 0} dòng đã chọn (atomic). Nếu một dòng không hợp lệ, toàn bộ yêu cầu không được tạo.`}
                </AlertDialog.Description>
                <ul className={styles.proposerConfirmList}>
                  {summaryLines.map((line, index) => <li key={index}>{line}</li>)}
                </ul>
                <div className={styles.drawerActions}>
                  <AlertDialog.Cancel asChild>
                    <button type="button" className={styles.secondaryButton}>Hủy</button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => { setConfirmOpen(false); void submit(); }}
                    >
                      {kind === "ENTRY_VOID" ? "Gửi đề nghị hủy" : "Gửi yêu cầu"}
                    </button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
