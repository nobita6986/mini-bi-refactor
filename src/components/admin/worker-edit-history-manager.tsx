"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DATA_TABLE_CLASS, DATA_TABLE_HEAD_CLASS, DATA_TABLE_ROW_CLASS, DATA_TABLE_TD_CLASS, DATA_TABLE_TH_CLASS, DataTableContainer } from "@/components/ui/data-table";
import { CatalogFilterCombobox, type CatalogFilterOption } from "@/components/ui/catalog-filter-combobox";
import { parseDirectEntryCatalogResponse } from "@/lib/direct-entry/catalog-response";
import { hcmTodayDate } from "@/lib/direct-entry/change-request-proposal-builders";
import {
  workerCccdPreviewUrl,
  workerPortraitPreviewUrl,
} from "@/lib/direct-entry/worker-detail-projection";
import {
  type WorkerEditHistoryActionGroup,
  type WorkerEditHistoryRevision,
  type WorkerEditHistoryRow,
  type WorkerEditHistorySearch,
  normalizeWorkerEditHistoryEmployeeCode,
  projectWorkerEditHistoryRevision,
  projectWorkerEditHistorySearch,
  resolveSnapshotRecruiterDisplay,
  resolveSnapshotTeamDisplay,
} from "@/lib/admin/worker-edit-history-contract";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";

type SearchDraft = {
  fromDate: string;
  toDate: string;
  employeeCode: string;
  projectId: string;
  recruiterId: string;
  actionGroup: WorkerEditHistoryActionGroup | "";
};

type DetailState = { key: string; kind: "loading" } | { key: string; kind: "ready"; value: WorkerEditHistoryRevision } | { key: string; kind: "error"; message: string };

const ACTION_LABELS: Record<WorkerEditHistoryActionGroup, string> = {
  NEW_ENTRY: "Nhập mới",
  DUPLICATE_WITHDRAWN: "Rút trùng",
  PROFILE_EDIT: "Sửa thông tin",
  STATUS_CHANGE: "Thay đổi trạng thái",
  DOCUMENT_CHANGE: "Cập nhật hồ sơ / ảnh",
};

const FIELD_LABELS: Record<string, string> = {
  worker_details: "Thông tin cá nhân",
  payment: "Thông tin tài khoản ngân hàng",
  document_metadata: "Hồ sơ / ảnh",
  document_lifecycle: "Trạng thái hồ sơ / ảnh",
  ENTRY_VOID: "Rút hồ sơ trùng",
  display_name: "Họ và tên",
  gender: "Giới tính",
  date_of_birth: "Ngày sinh",
  national_id: "CCCD",
  national_id_issued_at: "Ngày cấp CCCD",
  national_id_issued_place: "Nơi cấp CCCD",
  address: "Địa chỉ",
  phone: "Số điện thoại",
  employee_code: "Mã NLĐ",
  project_id: "Dự án",
  provider_type: "Nguồn tuyển",
  team_id: "Nhóm",
  team_name: "Nhóm",
  project_name: "Dự án",
  recruiter_id: "Người tuyển",
  recruiter_name: "Người tuyển",
  labor_type: "Loại hình lao động",
  first_work_date: "Ngày đầu làm việc",
  employment_status: "Trạng thái làm việc",
  documents: "Hồ sơ / ảnh",
  account_number: "Số tài khoản",
  account_holder_name: "Tên chủ tài khoản",
  bank_id: "Mã ngân hàng",
  bank_name: "Ngân hàng",
  state: "Trạng thái dữ liệu",
  status: "Trạng thái làm việc",
  voided_at: "Thời điểm rút hồ sơ trùng",
  effective_date: "Ngày hiệu lực",
  leave_date: "Ngày nghỉ việc",
  leave_reason_text: "Lý do nghỉ việc",
  upload_status: "Trạng thái tải lên",
  scan_status: "Trạng thái quét",
  validation_status: "Trạng thái kiểm tra",
};
const WORKER_DETAIL_FIELDS = new Set([
  "display_name", "gender", "date_of_birth", "national_id", "national_id_issued_at",
  "national_id_issued_place", "address", "phone",
]);
const PAYMENT_FIELDS = new Set(["state", "account_number", "account_holder_name", "bank_id", "bank_name"]);
const EMPLOYMENT_STATUS_FIELDS = new Set(["status", "effective_date", "leave_date", "leave_reason_text"]);
const CURRENT_WORKER_FIELDS = [
  "display_name", "gender", "date_of_birth", "national_id", "national_id_issued_at",
  "national_id_issued_place", "address", "phone", "employee_code", "project_name",
  "recruiter_name", "team_id", "provider_type", "labor_type", "first_work_date",
  "employment_status.status", "employment_status.effective_date", "employment_status.leave_date",
  "employment_status.leave_reason_text", "voided_at", "payment.state", "payment.account_holder_name",
  "payment.account_number", "payment.bank_id", "payment.bank_name",
];

const INPUT_CLASS = "min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
const ACTION_OPTIONS = Object.entries(ACTION_LABELS) as [WorkerEditHistoryActionGroup, string][];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldLabel(value: string): string {
  const leaf = value.split(".").at(-1) ?? value;
  return FIELD_LABELS[value] ?? FIELD_LABELS[leaf] ?? value;
}

function errorMessage(code: unknown): string {
  switch (code) {
    case "UNAUTHENTICATED": return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case "ACTOR_NOT_AVAILABLE":
    case "WORKER_EDIT_HISTORY_ACCESS_DENIED": return "Tài khoản không được cấp quyền xem lịch sử này.";
    case "WORKER_EDIT_HISTORY_QUERY_INVALID": return "Bộ lọc lịch sử không hợp lệ. Hãy kiểm tra khoảng ngày, mã NLĐ, dự án hoặc người tuyển.";
    case "WORKER_EDIT_HISTORY_NOT_FOUND": return "Không tìm thấy revision này.";
    default: return "Không tải được dữ liệu lịch sử. Vui lòng thử lại.";
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Ho_Chi_Minh",
  }).format(date);
}

function defaultHistoryDates(): { fromDate: string; toDate: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const end = Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day")));
  const iso = (milliseconds: number) => new Date(milliseconds).toISOString().slice(0, 10);
  return { fromDate: iso(end - 29 * 86_400_000), toDate: iso(end) };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatValue).join(", ");
  return JSON.stringify(value, null, 2);
}

function fieldValue(snapshot: Record<string, unknown> | null, key: string): unknown {
  if (!snapshot) return null;
  let value: unknown = snapshot;
  let path = key.split(".");
  if (path.length === 1 && WORKER_DETAIL_FIELDS.has(key)) path = ["worker_details", key];
  else if (path.length === 1 && PAYMENT_FIELDS.has(key)) path = ["payment", key];
  else if (path.length === 1 && EMPLOYMENT_STATUS_FIELDS.has(key)) path = ["employment_status", key];
  for (const part of path) {
    if (!isRecord(value)) return null;
    value = value[part];
  }
  return isRecord(value) && "value" in value ? value.value : value;
}

function expandChangedFields(changedFields: string[]): string[] {
  const fields = changedFields.flatMap((field) => {
    if (field === "worker_details") return [...WORKER_DETAIL_FIELDS];
    if (field === "payment") return [...PAYMENT_FIELDS].map((key) => `payment.${key}`);
    if (field === "employment_status") return [...EMPLOYMENT_STATUS_FIELDS].map((key) => `employment_status.${key}`);
    if (field === "ENTRY_VOID") return ["voided_at"];
    if (field === "recruiter_id") return ["recruiter_name"];
    if (field === "team_id") return ["team_name"];
    return [field];
  });
  return [...new Set(fields)];
}

function snapshotFieldValue(
  snapshot: Record<string, unknown> | null,
  field: string,
  resolvedRecruiters: Record<string, string>,
  resolvedTeams: Record<string, string>,
): unknown {
  if (field === "recruiter_id" || field === "recruiter_name") {
    return resolveSnapshotRecruiterDisplay(snapshot, resolvedRecruiters);
  }
  if (field === "team_id" || field === "team_name") {
    return resolveSnapshotTeamDisplay(snapshot, resolvedTeams);
  }
  return fieldValue(snapshot, field);
}

function SnapshotPanel({ title, snapshot, changedFields, resolvedRecruiters, resolvedTeams }: {
  title: string;
  snapshot: Record<string, unknown> | null;
  changedFields: string[];
  resolvedRecruiters: Record<string, string>;
  resolvedTeams: Record<string, string>;
}) {
  const visibleFields = changedFields.length
    ? expandChangedFields(changedFields)
    : Object.keys(FIELD_LABELS).filter((field) => field !== "recruiter_id" && field !== "team_id");
  return (
    <section className="min-w-0 rounded-xl border border-border p-4">
      <h4 className="mb-3 text-sm font-semibold text-foreground">{title}</h4>
      {!snapshot ? <p className="text-sm text-muted">Chưa có hồ sơ trước lần ghi này.</p> : (
        <dl className="space-y-2">
          {visibleFields.map((field) => (
            <div key={field} className="grid gap-1 border-b border-border/60 pb-2 sm:grid-cols-[minmax(8rem,0.7fr)_minmax(0,1.3fr)]">
              <dt className="text-sm text-muted">{fieldLabel(field)}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words text-sm text-foreground">
                {formatValue(snapshotFieldValue(snapshot, field, resolvedRecruiters, resolvedTeams))}
              </dd>
            </div>
          ))}
          {visibleFields.length === 0 ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(snapshot, null, 2)}</pre> : null}
        </dl>
      )}
    </section>
  );
}

function DocumentHistory({ entryId, events }: { entryId: string; events: Record<string, unknown>[] }) {
  if (!events.length) return <p className="text-sm text-muted">Không ghi nhận sự kiện hồ sơ/ảnh trong revision này.</p>;
  return (
    <ul className="space-y-3">
      {events.map((event, index) => {
        const documentId = typeof event.document_id === "string" ? event.document_id : "";
        const type = typeof event.document_type === "string" ? event.document_type : "Tài liệu";
        const preview = documentId && type === "WORKER_PORTRAIT"
          ? workerPortraitPreviewUrl(entryId, documentId)
          : documentId && (type === "CCCD_FRONT" || type === "CCCD_BACK")
            ? workerCccdPreviewUrl(entryId, documentId)
            : null;
        const contractUrl = documentId && type === "EMPLOYMENT_CONTRACT"
          ? `/api/direct-entry/entries/${encodeURIComponent(entryId)}/documents/${encodeURIComponent(documentId)}/download`
          : null;
        return (
          <li key={`${documentId}-${String(event.created_at ?? index)}-${index}`} className="rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm">{type} · v{formatValue(event.version)}</strong>
              <span className="text-xs text-muted">{typeof event.created_at === "string" ? formatDateTime(event.created_at) : ""}</span>
            </div>
            <p className="mt-1 text-sm text-muted">
              Người tải: {formatValue(event.uploader_display_name)} · Trạng thái: {formatValue(event.event_status)} · Kiểm tra: {formatValue(event.validation_status)}
            </p>
            {preview ? <a className="mt-3 inline-block text-sm font-medium text-primary underline" href={preview} target="_blank" rel="noreferrer">Mở ảnh qua quyền tài liệu hiện có</a> : null}
            {contractUrl ? <a className="mt-3 inline-block text-sm font-medium text-primary underline" href={contractUrl}>Tải hợp đồng qua quyền tài liệu hiện có</a> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function WorkerEditHistoryManager() {
  const today = hcmTodayDate();
  const [draft, setDraft] = useState<SearchDraft>(() => ({ ...defaultHistoryDates(), employeeCode: "", projectId: "", recruiterId: "", actionGroup: "" }));
  const [catalog, setCatalog] = useState<DraftCatalog | null>(null);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [appliedQuery, setAppliedQuery] = useState<URLSearchParams | null>(null);
  const [result, setResult] = useState<WorkerEditHistorySearch | null>(null);
  const [listState, setListState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState<WorkerEditHistoryRow | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const projectOptions = useMemo<CatalogFilterOption[]>(
    () => (catalog?.projects ?? []).map((project) => ({ id: project.project_id, label: project.display_name, keywords: project.project_id })),
    [catalog],
  );
  const recruiterOptions = useMemo<CatalogFilterOption[]>(
    () => (catalog?.recruiters ?? []).map((recruiter) => ({
      id: recruiter.recruiter_id,
      label: recruiter.label,
      keywords: `${recruiter.display_name} ${recruiter.personnel_code ?? ""}`,
    })),
    [catalog],
  );
  const detailKey = selected ? `${selected.entry_id}/${selected.revision_id}` : "";
  const detailUrl = useMemo(() => detailKey ? `/api/admin/worker-edit-history/${detailKey}` : "", [detailKey]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/direct-entry/catalog?effective_date=${encodeURIComponent(today)}`, {
      cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal,
    }).then(async (response) => {
      const payload: unknown = await response.json();
      const parsed = response.ok ? parseDirectEntryCatalogResponse(payload, today) : null;
      if (!parsed) throw new Error("catalog unavailable");
      if (!controller.signal.aborted) {
        setCatalog(parsed);
        setCatalogState("ready");
      }
    }).catch(() => {
      if (!controller.signal.aborted) setCatalogState("unavailable");
    });
    return () => controller.abort();
  }, [today]);

  async function loadPage(query: URLSearchParams, append: boolean) {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setListState("loading");
    setListError("");
    try {
      const response = await fetch(`/api/admin/worker-edit-history?${query.toString()}`, { cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) return;
      const payload: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok || !isRecord(payload) || payload.ok !== true) throw new Error(errorMessage(isRecord(payload) ? payload.code : null));
      const data = projectWorkerEditHistorySearch(payload.data);
      if (!data) throw new Error("Dữ liệu lịch sử trả về không đúng định dạng.");
      setResult((previous) => append && previous ? { ...data, rows: [...previous.rows, ...data.rows] } : data);
      setListState("ready");
    } catch (error) {
      if (controller.signal.aborted) return;
      setListError(error instanceof Error ? error.message : "Không tải được dữ liệu lịch sử.");
      setListState("error");
    } finally {
      if (listRequest.current === controller) listRequest.current = null;
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    listRequest.current?.abort();
    listRequest.current = null;
    const fromDate = draft.fromDate;
    const toDate = draft.toDate;
    if (!fromDate || !toDate) {
      setListError("Vui lòng chọn đủ ngày bắt đầu và ngày kết thúc.");
      setListState("error");
      return;
    }
    const fromDay = Date.parse(`${fromDate}T00:00:00Z`);
    const toDay = Date.parse(`${toDate}T00:00:00Z`);
    if (!Number.isFinite(fromDay) || !Number.isFinite(toDay) || toDay < fromDay || toDay - fromDay > 92 * 86_400_000) {
      setListError("Khoảng ngày không hợp lệ hoặc dài quá 93 ngày.");
      setListState("error");
      return;
    }
    const parsedEmployeeCode = normalizeWorkerEditHistoryEmployeeCode(draft.employeeCode);
    if (!parsedEmployeeCode.ok) {
      setListError("Mã NLĐ không hợp lệ (tối đa 64 ký tự và không chứa khoảng trắng).");
      setListState("error");
      return;
    }
    const query = new URLSearchParams({ page_size: "50", from_date: fromDate, to_date: toDate });
    if (parsedEmployeeCode.value !== null) query.set("employee_code", parsedEmployeeCode.value);
    if (draft.projectId) query.set("project_id", draft.projectId);
    if (draft.recruiterId) query.set("recruiter_id", draft.recruiterId);
    if (draft.actionGroup) query.set("action_group", draft.actionGroup);
    setAppliedQuery(query);
    setSelected(null);
    setDetail(null);
    setResult(null);
    void loadPage(query, false);
  }

  function loadMore() {
    if (!appliedQuery || !result?.next_cursor || listState === "loading") return;
    const query = new URLSearchParams(appliedQuery);
    query.set("cursor", result.next_cursor);
    void loadPage(query, true);
  }

  function clearFilters() {
    listRequest.current?.abort();
    listRequest.current = null;
    setDraft({ ...defaultHistoryDates(), employeeCode: "", projectId: "", recruiterId: "", actionGroup: "" });
    setAppliedQuery(null);
    setResult(null);
    setSelected(null);
    setDetail(null);
    setListState("idle");
    setListError("");
  }

  useEffect(() => {
    if (!detailUrl || !selected) return;
    const controller = new AbortController();
    const key = detailKey;
    void fetch(detailUrl, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok || !isRecord(payload) || payload.ok !== true || !isRecord(payload.data)) {
          throw new Error(errorMessage(isRecord(payload) ? payload.code : null));
        }
        const revision = projectWorkerEditHistoryRevision(payload.data);
        if (!revision) throw new Error("Chi tiết lịch sử trả về không đúng định dạng.");
        return revision;
      })
      .then((value) => {
        if (!controller.signal.aborted) setDetail({ key, kind: "ready", value });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDetail({ key, kind: "error", message: error instanceof Error ? error.message : "Không tải được chi tiết." });
      });
    return () => controller.abort();
  }, [detailKey, detailUrl, selected]);

  useEffect(() => () => listRequest.current?.abort(), []);

  const currentDetail =
    detail?.key === detailKey
      ? detail
      : selected && detailKey
        ? ({ key: detailKey, kind: "loading" } as const)
        : null;

  return (
    <main className="space-y-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Quản trị nhân sự</p>
        <h1 className="mt-1 text-2xl font-semibold text-foreground">Lịch sử chỉnh sửa NLĐ</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted">Tra cứu các lần nhập mới, rút trùng, sửa thông tin, đổi trạng thái và cập nhật hồ sơ. Mỗi dòng là một revision.</p>
      </header>

      <Alert title="Phạm vi dữ liệu">
        <p>Hiển thị các lần chỉnh sửa của mọi NLĐ trong khoảng ngày đã chọn (mặc định 30 ngày gần nhất, tối đa 93 ngày). Có thể lọc theo mã NLĐ, dự án, người tuyển và nhóm thay đổi. CCCD, tài khoản ngân hàng và các thông tin khác hiển thị nguyên giá trị.</p>
      </Alert>

      <Card>
        <CardHeader title="Điều kiện lọc" description="Trang không tự tải lịch sử. Chọn khoảng ngày và các bộ lọc tùy chọn, sau đó bấm Tải lịch sử." />
        <search>
          <form onSubmit={submitSearch} className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1 text-sm font-medium">Từ ngày
              <input className={INPUT_CLASS} type="date" value={draft.fromDate} onChange={(event) => setDraft({ ...draft, fromDate: event.target.value })} />
            </label>
            <label className="space-y-1 text-sm font-medium">Đến ngày
              <input className={INPUT_CLASS} type="date" value={draft.toDate} onChange={(event) => setDraft({ ...draft, toDate: event.target.value })} />
            </label>
            <CatalogFilterCombobox id="worker-edit-history-project" label="Dự án" allLabel="Tất cả dự án" placeholder={catalogState === "loading" ? "Đang tải danh mục…" : "Gõ tên dự án để tìm"} options={projectOptions} value={draft.projectId} disabled={catalogState !== "ready"} onChange={(projectId) => setDraft((current) => ({ ...current, projectId }))} />
            <CatalogFilterCombobox id="worker-edit-history-recruiter" label="Người tuyển" allLabel="Tất cả người tuyển" placeholder={catalogState === "loading" ? "Đang tải danh mục…" : "Gõ tên hoặc mã người tuyển"} options={recruiterOptions} value={draft.recruiterId} disabled={catalogState !== "ready"} onChange={(recruiterId) => setDraft((current) => ({ ...current, recruiterId }))} />
            <div className="flex min-w-0 flex-col gap-1 text-sm font-medium">
              <label htmlFor="worker-edit-history-employee-code">Mã NLĐ</label>
              <input
                id="worker-edit-history-employee-code"
                name="employee_code"
                type="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="search"
                maxLength={64}
                placeholder="Ví dụ: hrp-2026-000123"
                className={INPUT_CLASS}
                value={draft.employeeCode}
                onChange={(event) => setDraft((current) => ({ ...current, employeeCode: event.target.value }))}
              />
            </div>
            <label className="space-y-1 text-sm font-medium">Nhóm thay đổi
              <select className={INPUT_CLASS} value={draft.actionGroup} onChange={(event) => setDraft({ ...draft, actionGroup: event.target.value as SearchDraft["actionGroup"] })}>
                <option value="">Tất cả nhóm</option>
                {ACTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <Button type="submit" variant="primary" loading={listState === "loading"}>Tải lịch sử</Button>
              <Button type="button" onClick={clearFilters}>Xóa lọc</Button>
            </div>
          </form>
        </search>
        {listState === "error" ? <div className="mt-4"><Alert tone="error" title={listError} /></div> : null}
      </Card>

      {catalogState === "unavailable" ? <Alert tone="warning" title="Không tải được danh mục dự án và người tuyển">Có thể lọc theo ngày và nhóm thay đổi. Hãy thử tải lại trang để dùng bộ lọc dự án/người tuyển.</Alert> : null}
      {listState === "idle" ? <Card><p className="text-sm text-muted">Chọn khoảng ngày (mặc định 30 ngày gần nhất) và bấm “Tải lịch sử” để xem các chỉnh sửa của mọi NLĐ.</p></Card> : null}

      {result ? <Card>
        <CardHeader title="Kết quả lịch sử" description={`${result.rows.length} revision trên trang hiện tại${result.has_more ? " · còn kết quả tiếp theo" : ""}`} />
        {listState === "loading" && result.rows.length === 0 ? <p className="text-sm text-muted">Đang tải…</p> : null}
        {result.rows.length === 0 ? <p className="text-sm text-muted">Không có revision khớp điều kiện đã chọn.</p> : (
          <DataTableContainer>
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}><tr>
                <th className={DATA_TABLE_TH_CLASS}>Thời gian</th><th className={DATA_TABLE_TH_CLASS}>Người lao động / CCCD</th><th className={DATA_TABLE_TH_CLASS}>Dự án</th><th className={DATA_TABLE_TH_CLASS}>Nhóm thay đổi</th><th className={DATA_TABLE_TH_CLASS}>Người thực hiện</th><th className={DATA_TABLE_TH_CLASS}>Nội dung / revision</th>
              </tr></thead>
              <tbody>{result.rows.map((row) => (
                <tr key={row.revision_id} className={`${DATA_TABLE_ROW_CLASS} ${selected?.revision_id === row.revision_id ? "bg-primary/5" : ""}`}>
                  <td className={DATA_TABLE_TD_CLASS}>{formatDateTime(row.created_at)}</td>
                  <td className={DATA_TABLE_TD_CLASS}><div className="font-medium">{row.display_name} · {row.employee_code}</div><div className="font-mono text-xs text-muted">{row.national_id ?? "Chưa có CCCD"}</div></td>
                  <td className={DATA_TABLE_TD_CLASS}>{row.project_name}<div className="text-xs text-muted">Người tuyển: {row.recruiter_name}</div></td>
                  <td className={DATA_TABLE_TD_CLASS}>{ACTION_LABELS[row.action_group]}</td>
                  <td className={DATA_TABLE_TD_CLASS}>{row.actor_display_name}<div className="text-xs text-muted">{row.reason_text || "Không có lý do"}</div></td>
                  <td className={DATA_TABLE_TD_CLASS}><Button size="sm" onClick={() => setSelected(row)}>Xem v{row.version}</Button><div className="mt-1 max-w-64 text-xs text-muted">{row.changed_fields.map(fieldLabel).join(", ") || row.audit_actions.join(", ")}</div></td>
                </tr>
              ))}</tbody>
            </table>
          </DataTableContainer>
        )}
        {result.has_more ? <div className="mt-4"><Button onClick={loadMore} loading={listState === "loading"}>Tải thêm</Button></div> : null}
      </Card> : null}

      {selected ? <Card>
        <CardHeader title={`Chi tiết revision v${selected.version} · ${selected.display_name}`} description={`${selected.employee_code} · ${selected.project_name} · ${formatDateTime(selected.created_at)}`} />
        {!currentDetail || currentDetail.kind === "loading" ? <p className="text-sm text-muted">Đang tải chi tiết…</p> : null}
        {currentDetail?.kind === "error" ? <Alert tone="error" title={currentDetail.message} /> : null}
        {currentDetail?.kind === "ready" ? <div className="space-y-5">
          <div className="flex flex-wrap gap-2 text-sm"><span className="rounded-full bg-muted/20 px-3 py-1">{ACTION_LABELS[selected.action_group]}</span><span className="rounded-full bg-muted/20 px-3 py-1">Người sửa: {selected.actor_display_name}</span><span className="rounded-full bg-muted/20 px-3 py-1">{currentDetail.value.snapshot_state === "COMPLETE" ? "Có snapshot đầy đủ" : "Lịch sử cũ: chỉ có dữ liệu giới hạn"}</span></div>
          {selected.reason_text ? <Alert title="Lý do">{selected.reason_text}</Alert> : null}
          {currentDetail.value.snapshot_state === "LEGACY_LIMITED" ? <Alert tone="warning" title="Revision cũ chưa có snapshot đầy đủ">Hệ thống chỉ hiển thị được dữ liệu revision và audit còn lưu từ trước khi bật lịch sử mới.</Alert> : null}
          <SnapshotPanel
            title="Thông tin hiện tại của NLĐ"
            snapshot={currentDetail.value.current_snapshot}
            changedFields={CURRENT_WORKER_FIELDS}
            resolvedRecruiters={currentDetail.value.resolved_recruiters}
            resolvedTeams={currentDetail.value.resolved_teams}
          />
          <div className="grid gap-4 xl:grid-cols-2">
            <SnapshotPanel
              title="Trước thay đổi"
              snapshot={currentDetail.value.before_snapshot}
              changedFields={selected.changed_fields}
              resolvedRecruiters={currentDetail.value.resolved_recruiters}
              resolvedTeams={currentDetail.value.resolved_teams}
            />
            <SnapshotPanel
              title="Sau thay đổi"
              snapshot={currentDetail.value.after_snapshot}
              changedFields={selected.changed_fields}
              resolvedRecruiters={currentDetail.value.resolved_recruiters}
              resolvedTeams={currentDetail.value.resolved_teams}
            />
          </div>
          <section className="space-y-3"><h3 className="font-semibold">Trạng thái làm việc</h3>{currentDetail.value.employment_status_events.length ? currentDetail.value.employment_status_events.map((event, index) => <div key={`${String(event.event_id)}-${index}`} className="rounded-lg border border-border p-3 text-sm">{formatValue(event.status)} · hiệu lực {formatValue(event.effective_date)} · người thực hiện {formatValue(event.actor_display_name)} · {formatValue(event.reason_text)}</div>) : <p className="text-sm text-muted">Không có sự kiện trạng thái gắn với revision này.</p>}</section>
          <section className="space-y-3"><h3 className="font-semibold">Hồ sơ / ảnh và người tải</h3><DocumentHistory entryId={currentDetail.value.entry_id} events={currentDetail.value.document_events} /></section>
          <section className="space-y-3"><h3 className="font-semibold">Audit</h3>{currentDetail.value.audit_events.length ? currentDetail.value.audit_events.map((event, index) => <div key={`${String(event.event_id)}-${index}`} className="rounded-lg border border-border p-3 text-sm">{formatValue(event.action)} · {formatValue(event.outcome)} · {formatValue(event.actor_display_name)} · {formatValue(event.reason_text)}<div className="mt-1 text-xs text-muted">{formatValue(event.changed_fields)} · {typeof event.created_at === "string" ? formatDateTime(event.created_at) : ""}</div></div>) : <p className="text-sm text-muted">Không có audit event cho revision này.</p>}</section>
        </div> : null}
      </Card> : null}
    </main>
  );
}
