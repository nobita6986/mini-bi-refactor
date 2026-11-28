"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
  RowActionCluster,
} from "@/components/ui/data-table";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { OffsetPager } from "@/components/ui/offset-pager";
import { isRealCalendarDate } from "@/lib/analytics/identity/identity-shared.mjs";
import { formatTimestamp } from "@/lib/format";
import {
  VENDOR_REFERRER_DEFAULT_CANDIDATE_LIMIT,
  VENDOR_REFERRER_DEFAULT_PAGE_SIZE,
  VENDOR_REFERRER_SEARCH_MAX,
  isValidUuid,
  projectAssignMutationResult,
  projectCandidateList,
  projectRevokeMutationResult,
  projectVendorHistory,
  projectVendorList,
  type EligibleCandidate,
  type ReferrerLinkHistory,
  type VendorHistoryResponse,
  type VendorListResponse,
  type VendorReferrerAction,
  type VendorWithReferrer,
} from "@/lib/vendor-referrals/vendor-referrer-contract";

type VendorListState =
  | { kind: "loading" }
  | { kind: "loaded"; data: VendorListResponse }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

type CandidateListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; items: readonly EligibleCandidate[]; total: number }
  | { kind: "error"; message: string };

type HistoryDialogState =
  | { kind: "loading"; vendor: VendorWithReferrer }
  | { kind: "loaded"; vendor: VendorWithReferrer; data: VendorHistoryResponse }
  | { kind: "error"; vendor: VendorWithReferrer; message: string };

type MutationDialogState =
  | { kind: "assign"; mode: "assign" | "replace"; vendor: VendorWithReferrer }
  | { kind: "revoke"; vendor: VendorWithReferrer };

type PendingReferrerIntent = {
  operation: "assign" | "revoke";
  vendorId: string;
  url: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
  retry: boolean;
};

const INPUT_CLASS =
  "min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground " +
  "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";

export function newReferrerIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildReferrerVendorListQuery(input: {
  search: string;
  includeInactive: boolean;
  page: number;
  pageSize?: number;
}): URLSearchParams | null {
  const search = input.search.trim();
  const pageSize = input.pageSize ?? VENDOR_REFERRER_DEFAULT_PAGE_SIZE;
  if (
    search.length > VENDOR_REFERRER_SEARCH_MAX ||
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    input.page > 1000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    return null;
  }
  const params = new URLSearchParams({
    include_inactive: String(input.includeInactive),
    page: String(input.page),
    page_size: String(pageSize),
  });
  if (search !== "") {
    params.set("search", search);
  }
  return params;
}

export function buildReferrerCandidateQuery(input: {
  search?: string;
  limit?: number;
} = {}): URLSearchParams | null {
  const search = (input.search ?? "").trim();
  const limit = input.limit ?? VENDOR_REFERRER_DEFAULT_CANDIDATE_LIMIT;
  if (
    search.length > VENDOR_REFERRER_SEARCH_MAX ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  ) {
    return null;
  }
  const params = new URLSearchParams({ limit: String(limit) });
  if (search !== "") {
    params.set("search", search);
  }
  return params;
}

export function formatCandidateOptionLabel(candidate: EligibleCandidate): string {
  return `${candidate.full_name} · ${candidate.employee_code} · ${candidate.department_name}`;
}

export function filterReferrerCandidates(
  candidates: readonly EligibleCandidate[],
  searchQuery: string,
): EligibleCandidate[] {
  const needle = searchQuery.trim().toLocaleLowerCase("vi");
  if (!needle) return [...candidates];
  return candidates.filter((candidate) => {
    const haystack = [
      candidate.full_name,
      candidate.employee_code,
      candidate.department_name,
      candidate.personnel_code ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase("vi");
    return haystack.includes(needle);
  });
}

export function validateAssignReferrerInput(input: {
  vendor: Pick<VendorWithReferrer, "active" | "current_link">;
  referrerPersonId: string;
  effectiveDate: string;
}):
  | {
      ok: true;
      referrer_person_id: string;
      effective_date: string;
      expected_current_link_id: string | null;
    }
  | { ok: false; message: string } {
  if (!input.vendor.active) {
    return {
      ok: false,
      message: "Vendor đã ngừng hoạt động — không thể gán hoặc thay thế người giới thiệu.",
    };
  }
  const personId = input.referrerPersonId.trim().toLowerCase();
  if (!isValidUuid(personId)) {
    return { ok: false, message: "Vui lòng chọn NVTD giới thiệu hợp lệ." };
  }
  if (input.vendor.current_link && input.vendor.current_link.referrer_person_id === personId) {
    return {
      ok: false,
      message: "NVTD này đang là người giới thiệu hiện tại của Vendor. Vui lòng chọn NVTD khác.",
    };
  }
  const effectiveDate = input.effectiveDate.trim();
  if (!isRealCalendarDate(effectiveDate)) {
    return { ok: false, message: "Ngày hiệu lực không hợp lệ (định dạng YYYY-MM-DD)." };
  }
  if (input.vendor.current_link && effectiveDate < input.vendor.current_link.effective_from) {
    return {
      ok: false,
      message: `Ngày hiệu lực không được sớm hơn liên kết hiện tại (${input.vendor.current_link.effective_from}).`,
    };
  }
  return {
    ok: true,
    referrer_person_id: personId,
    effective_date: effectiveDate,
    expected_current_link_id: input.vendor.current_link?.link_id ?? null,
  };
}

export function validateRevokeReferrerInput(input: {
  vendor: Pick<VendorWithReferrer, "current_link">;
  effectiveDate: string;
}):
  | {
      ok: true;
      effective_date: string;
      expected_current_link_id: string;
    }
  | { ok: false; message: string } {
  if (!input.vendor.current_link) {
    return { ok: false, message: "Vendor hiện chưa có người giới thiệu đang hiệu lực để thu hồi." };
  }
  const effectiveDate = input.effectiveDate.trim();
  if (!isRealCalendarDate(effectiveDate)) {
    return { ok: false, message: "Ngày hiệu lực không hợp lệ (định dạng YYYY-MM-DD)." };
  }
  if (effectiveDate < input.vendor.current_link.effective_from) {
    return {
      ok: false,
      message: `Ngày hiệu lực thu hồi không được sớm hơn ngày bắt đầu liên kết hiện tại (${input.vendor.current_link.effective_from}).`,
    };
  }
  return {
    ok: true,
    effective_date: effectiveDate,
    expected_current_link_id: input.vendor.current_link.link_id,
  };
}

export function classifyReferrerApiFailure(
  status: number,
  payload: unknown,
): {
  kind: "conflict" | "denied" | "unauthenticated" | "not-found" | "invalid" | "unavailable";
  message: string;
} {
  const code =
    typeof payload === "object" &&
    payload !== null &&
    "code" in payload &&
    typeof (payload as { code?: unknown }).code === "string"
      ? (payload as { code: string }).code
      : null;

  if (status === 401 || code === "UNAUTHENTICATED") {
    return { kind: "unauthenticated", message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." };
  }
  if (status === 403 || code === "VENDOR_REFERRER_DENIED" || code === "ACTOR_NOT_AVAILABLE") {
    return {
      kind: "denied",
      message: "Chỉ Ban Giám đốc (BoD) được phân quyền mới có thể thao tác người giới thiệu Vendor.",
    };
  }
  if (status === 404 || code === "VENDOR_REFERRER_NOT_FOUND") {
    return { kind: "not-found", message: "Không tìm thấy Vendor hoặc chức năng chưa được kích hoạt." };
  }
  if (status === 409 || code === "VENDOR_REFERRER_CONFLICT") {
    return {
      kind: "conflict",
      message:
        "Dữ liệu liên kết người giới thiệu đã thay đổi ở nơi khác, Vendor đã ngừng hoạt động, hoặc ngày hiệu lực xung đột với liên kết hiện tại. Vui lòng tải lại dữ liệu mới nhất.",
    };
  }
  if (status === 400 || status === 422 || code === "VENDOR_REFERRER_INVALID") {
    return {
      kind: "invalid",
      message:
        "Thông tin không hợp lệ (kiểm tra người giới thiệu, ngày hiệu lực hoặc trạng thái nhân sự/Vendor).",
    };
  }
  return {
    kind: "unavailable",
    message: "Dịch vụ tạm thời không khả dụng. Có thể thử lại an toàn với cùng khóa idempotency.",
  };
}

export function classifyReferrerLinkInterval(link: ReferrerLinkHistory): {
  label: string;
  tone: BadgeTone;
  isSameDaySuperseded: boolean;
} {
  if (link.is_current) {
    return { label: "Đang hiệu lực", tone: "success", isSameDaySuperseded: false };
  }
  const isSameDaySuperseded =
    link.effective_to !== null && link.effective_from === link.effective_to;
  return {
    label: "Đã kết thúc",
    tone: "neutral",
    isSameDaySuperseded,
  };
}

export function formatReferrerAuditAction(action: VendorReferrerAction): {
  label: string;
  tone: BadgeTone;
} {
  switch (action) {
    case "ASSIGN":
      return { label: "Gán mới", tone: "success" };
    case "REPLACE":
      return { label: "Thay thế", tone: "info" };
    case "REVOKE":
      return { label: "Thu hồi", tone: "warning" };
  }
}

export function VendorReferrerPanel() {
  const notify = useNotify();
  const [listState, setListState] = useState<VendorListState>({ kind: "loading" });
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);

  const [candidatesState, setCandidatesState] = useState<CandidateListState>({ kind: "idle" });
  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidatesReloadToken, setCandidatesReloadToken] = useState(0);

  const [mutationDialog, setMutationDialog] = useState<MutationDialogState | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingReferrerIntent | null>(null);
  const [conflictState, setConflictState] = useState<{ vendorId: string; message: string } | null>(
    null,
  );

  const [historyDialog, setHistoryDialog] = useState<HistoryDialogState | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const query = buildReferrerVendorListQuery({ search, includeInactive, page });
      if (!query) {
        setListState({ kind: "error" });
        return;
      }
      let response: Response;
      try {
        response = await fetch(`/api/admin/vendor-referrals/vendors?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setListState({ kind: "unavailable" });
        return;
      }

      if (response.status === 401 || response.status === 403) {
        setListState({ kind: "denied" });
        return;
      }
      if (response.status !== 200) {
        setListState(
          response.status === 404 || response.status >= 500
            ? { kind: "unavailable" }
            : { kind: "error" },
        );
        return;
      }

      try {
        const json: unknown = await response.json();
        const rawData =
          typeof json === "object" && json !== null && "ok" in json && (json as { ok: unknown }).ok === true
            ? (json as { data?: unknown }).data
            : null;
        const projected = projectVendorList(rawData);
        if (!projected) {
          setListState({ kind: "error" });
          return;
        }
        const pageCount = Math.min(
          1000,
          Math.max(1, Math.ceil(projected.total / Math.max(1, projected.page_size))),
        );
        if (page > pageCount) {
          setPage(pageCount);
          return;
        }
        setListState({ kind: "loaded", data: projected });
      } catch {
        setListState({ kind: "error" });
      }
    })();

    return () => controller.abort();
  }, [includeInactive, page, reloadToken, search]);

  useEffect(() => {
    if (mutationDialog?.kind !== "assign") return;
    const controller = new AbortController();
    void (async () => {
      setCandidatesState({ kind: "loading" });
      const query = buildReferrerCandidateQuery({ limit: 500 });
      if (!query) {
        setCandidatesState({ kind: "error", message: "Tham số tải danh sách NVTD không hợp lệ." });
        return;
      }
      try {
        const response = await fetch(`/api/admin/vendor-referrals/candidates?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        const json: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const failure = classifyReferrerApiFailure(response.status, json);
          setCandidatesState({ kind: "error", message: failure.message });
          return;
        }
        const rawData =
          typeof json === "object" && json !== null && "ok" in json && (json as { ok: unknown }).ok === true
            ? (json as { data?: unknown }).data
            : null;
        const projected = projectCandidateList(rawData);
        if (!projected) {
          setCandidatesState({
            kind: "error",
            message: "Phản hồi danh sách NVTD từ máy chủ không hợp lệ.",
          });
          return;
        }
        setCandidatesState({ kind: "loaded", items: projected.items, total: projected.total });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCandidatesState({
          kind: "error",
          message: "Không tải được danh sách NVTD đủ điều kiện do lỗi kết nối.",
        });
      }
    })();
    return () => controller.abort();
  }, [candidatesReloadToken, mutationDialog]);

  const filteredCandidates = useMemo(() => {
    if (candidatesState.kind !== "loaded") return [];
    return filterReferrerCandidates(candidatesState.items, candidateSearch);
  }, [candidateSearch, candidatesState]);

  const selectedCandidate = useMemo(() => {
    if (candidatesState.kind !== "loaded" || !selectedPersonId) return null;
    return candidatesState.items.find((item) => item.person_id === selectedPersonId) ?? null;
  }, [candidatesState, selectedPersonId]);

  const reloadVendors = () => {
    setListState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const openAssignDialog = (vendor: VendorWithReferrer) => {
    if (!vendor.active) {
      notify.warning({
        title: "Vendor đã ngừng hoạt động — không thể gán hoặc thay thế người giới thiệu.",
      });
      return;
    }
    if (listState.kind !== "loaded") {
      notify.warning({ title: "Cần tải danh sách Vendor từ máy chủ để lấy ngày hiệu lực mặc định." });
      return;
    }
    setSelectedPersonId("");
    setCandidateSearch("");
    setEffectiveDate(listState.data.authorization_date);
    setFormError(null);
    setConflictState(null);
    setPendingIntent(null);
    setMutationDialog({
      kind: "assign",
      mode: vendor.current_link ? "replace" : "assign",
      vendor,
    });
  };

  const openRevokeDialog = (vendor: VendorWithReferrer) => {
    if (!vendor.current_link) return;
    if (listState.kind !== "loaded") {
      notify.warning({ title: "Cần tải danh sách Vendor từ máy chủ để lấy ngày hiệu lực mặc định." });
      return;
    }
    setEffectiveDate(listState.data.authorization_date);
    setFormError(null);
    setConflictState(null);
    setPendingIntent(null);
    setMutationDialog({ kind: "revoke", vendor });
  };

  const openHistoryDialog = async (vendor: VendorWithReferrer) => {
    setHistoryDialog({ kind: "loading", vendor });
    try {
      const response = await fetch(
        `/api/admin/vendor-referrals/vendors/${encodeURIComponent(vendor.vendor_id)}/history`,
        {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      );
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = classifyReferrerApiFailure(response.status, json);
        setHistoryDialog({ kind: "error", vendor, message: failure.message });
        return;
      }
      const rawData =
        typeof json === "object" && json !== null && "ok" in json && (json as { ok: unknown }).ok === true
          ? (json as { data?: unknown }).data
          : null;
      const projected = projectVendorHistory(rawData, "api");
      if (!projected) {
        setHistoryDialog({
          kind: "error",
          vendor,
          message: "Dữ liệu lịch sử người giới thiệu từ máy chủ không hợp lệ.",
        });
        return;
      }
      setHistoryDialog({ kind: "loaded", vendor, data: projected });
    } catch {
      setHistoryDialog({
        kind: "error",
        vendor,
        message: "Không thể tải lịch sử người giới thiệu do lỗi kết nối.",
      });
    }
  };

  const recoverFromConflict = async () => {
    setConflictState(null);
    setPendingIntent(null);
    setFormError(null);
    setMutationDialog(null);
    reloadVendors();
    notify.success({ title: "Đang tải lại trạng thái mới nhất từ máy chủ." });
  };

  const sendIntent = async (intent: PendingReferrerIntent) => {
    setBusy(true);
    setFormError(null);
    try {
      let response: Response;
      try {
        response = await fetch(intent.url, {
          method: "POST",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": intent.idempotencyKey,
          },
          body: JSON.stringify(intent.body),
        });
      } catch {
        setPendingIntent({ ...intent, retry: true });
        notify.error({
          title: "Không nhận được phản hồi. Có thể thử lại đúng thao tác với cùng khóa idempotency.",
        });
        return;
      }

      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = classifyReferrerApiFailure(response.status, json);
        if (failure.kind === "conflict") {
          setPendingIntent(null);
          setConflictState({ vendorId: intent.vendorId, message: failure.message });
          notify.warning({ title: failure.message });
          return;
        }
        if (failure.kind === "unavailable") {
          setPendingIntent({ ...intent, retry: true });
          notify.error({ title: failure.message });
          return;
        }
        setPendingIntent(null);
        setFormError(failure.message);
        notify.error({ title: failure.message });
        return;
      }

      const rawData =
        typeof json === "object" && json !== null && "ok" in json && (json as { ok: unknown }).ok === true
          ? (json as { data?: unknown }).data
          : null;
      const projected =
        intent.operation === "assign"
          ? projectAssignMutationResult(rawData)
          : projectRevokeMutationResult(rawData);
      if (!projected) {
        setPendingIntent({ ...intent, retry: true });
        notify.error({ title: "Phản hồi xác nhận không đúng định dạng. Có thể thử lại an toàn." });
        return;
      }

      setPendingIntent(null);
      setConflictState(null);
      setMutationDialog(null);
      reloadVendors();
      notify.success({
        title:
          projected.action === "ASSIGN"
            ? "Đã gán người giới thiệu Vendor."
            : projected.action === "REPLACE"
              ? "Đã thay thế người giới thiệu Vendor."
              : "Đã thu hồi người giới thiệu Vendor.",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!mutationDialog || busy || conflictState) return;

    const idempotencyKey = newReferrerIdempotencyKey();
    if (mutationDialog.kind === "assign") {
      const checked = validateAssignReferrerInput({
        vendor: mutationDialog.vendor,
        referrerPersonId: selectedPersonId,
        effectiveDate,
      });
      if (!checked.ok) {
        setFormError(checked.message);
        return;
      }
      const intent: PendingReferrerIntent = {
        operation: "assign",
        vendorId: mutationDialog.vendor.vendor_id,
        url: `/api/admin/vendor-referrals/vendors/${encodeURIComponent(mutationDialog.vendor.vendor_id)}/assign`,
        idempotencyKey,
        retry: false,
        body: {
          referrer_person_id: checked.referrer_person_id,
          effective_date: checked.effective_date,
          expected_current_link_id: checked.expected_current_link_id,
          idempotency_key: idempotencyKey,
        },
      };
      setPendingIntent(intent);
      void sendIntent(intent);
      return;
    }

    const checked = validateRevokeReferrerInput({
      vendor: mutationDialog.vendor,
      effectiveDate,
    });
    if (!checked.ok) {
      setFormError(checked.message);
      return;
    }
    const intent: PendingReferrerIntent = {
      operation: "revoke",
      vendorId: mutationDialog.vendor.vendor_id,
      url: `/api/admin/vendor-referrals/vendors/${encodeURIComponent(mutationDialog.vendor.vendor_id)}/revoke`,
      idempotencyKey,
      retry: false,
      body: {
        effective_date: checked.effective_date,
        expected_current_link_id: checked.expected_current_link_id,
        idempotency_key: idempotencyKey,
      },
    };
    setPendingIntent(intent);
    void sendIntent(intent);
  };

  const data = listState.kind === "loaded" ? listState.data : null;
  const pageCount = data
    ? Math.min(1000, Math.max(1, Math.ceil(data.total / Math.max(1, data.page_size))))
    : 1;
  const locked = busy || conflictState !== null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Quản lý người giới thiệu Vendor"
          description={
            data
              ? `${data.total} Vendor · Mốc ngày nghiệp vụ: ${data.authorization_date} (GMT+7). Một NVTD có thể giới thiệu nhiều Vendor; lịch sử gán/thay thế được bảo toàn theo ngày.`
              : "Gán, thay thế, thu hồi và tra cứu lịch sử NVTD giới thiệu theo từng Vendor."
          }
        />

        <form
          className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setSearch(searchInput.trim());
            setListState({ kind: "loading" });
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
            Tìm kiếm Vendor hoặc người giới thiệu
            <input
              type="text"
              value={searchInput}
              maxLength={VENDOR_REFERRER_SEARCH_MAX}
              placeholder="Nhập mã Vendor, tên Vendor, mã NV hoặc tên NVTD..."
              onChange={(event) => setSearchInput(event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => {
                setIncludeInactive(event.target.checked);
                setPage(1);
                setListState({ kind: "loading" });
              }}
            />
            Bao gồm Vendor ngừng hoạt động
          </label>
          <div className="flex items-end gap-2">
            <Button type="submit" variant="secondary">
              Tìm kiếm
            </Button>
            {search !== "" ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSearchInput("");
                  setSearch("");
                  setPage(1);
                  setListState({ kind: "loading" });
                }}
              >
                Xóa lọc
              </Button>
            ) : null}
          </div>
        </form>

        {listState.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted">
            Đang tải danh sách Vendor và người giới thiệu…
          </p>
        ) : null}
        {listState.kind === "denied" ? (
          <ErrorState
            title="Không có quyền quản lý người giới thiệu Vendor"
            detail="Chức năng này chỉ dành cho tài khoản Ban Giám đốc (BoD) được phân quyền."
          />
        ) : null}
        {listState.kind === "unavailable" ? (
          <div className="space-y-3">
            <ErrorState title="Dịch vụ quản lý người giới thiệu hiện không khả dụng" />
            <Button type="button" variant="secondary" onClick={reloadVendors}>
              Thử tải lại
            </Button>
          </div>
        ) : null}
        {listState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState
              title="Không tải được danh sách người giới thiệu Vendor"
              detail="Phản hồi từ máy chủ không hợp lệ. Vui lòng thử lại."
            />
            <Button type="button" variant="secondary" onClick={reloadVendors}>
              Thử tải lại
            </Button>
          </div>
        ) : null}

        {data ? (
          data.items.length === 0 ? (
            <EmptyState
              title="Không có Vendor phù hợp"
              description="Thử thay đổi từ khóa tìm kiếm hoặc bật tùy chọn hiển thị Vendor ngừng hoạt động."
            />
          ) : (
            <DataTableContainer
              footer={
                <OffsetPager
                  className="mt-0 border-t-0 pt-0"
                  page={page}
                  pageCount={pageCount}
                  total={data.total}
                  ariaLabel="Phân trang danh sách người giới thiệu Vendor"
                  previousLabel="Trang trước"
                  nextLabel="Trang sau"
                  onPageChange={(nextPage) => {
                    setPage(nextPage);
                    setListState({ kind: "loading" });
                  }}
                />
              }
            >
              <table className={DATA_TABLE_CLASS}>
                <caption className="sr-only">
                  Danh sách Vendor và NVTD giới thiệu hiện tại
                </caption>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Vendor
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Trạng thái
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Người giới thiệu hiện tại
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Lịch sử
                    </th>
                    <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                      Thao tác
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((vendor) => (
                    <tr key={vendor.vendor_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                        <div className="font-medium text-foreground">{vendor.display_name}</div>
                        <div className="font-mono text-xs text-muted">{vendor.vendor_id}</div>
                      </td>
                      <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                        <StatusBadge tone={vendor.active ? "success" : "neutral"} dot>
                          {vendor.active ? "Đang hoạt động" : "Ngừng hoạt động"}
                        </StatusBadge>
                        {!vendor.active ? (
                          <p className="mt-1 text-xs text-muted">
                            Ngừng hoạt động — không thể gán/thay thế
                          </p>
                        ) : null}
                      </td>
                      <td data-label="Người giới thiệu hiện tại" className={DATA_TABLE_TD_CLASS}>
                        {vendor.current_link ? (
                          <div className="space-y-0.5">
                            <div className="font-medium text-foreground">
                              {vendor.current_link.referrer_full_name}
                            </div>
                            <div className="text-xs text-muted">
                              <span className="font-mono">
                                {vendor.current_link.referrer_employee_code}
                              </span>
                              {vendor.current_link.referrer_department_name
                                ? ` · ${vendor.current_link.referrer_department_name}`
                                : ""}
                            </div>
                            <div className="text-xs text-muted">
                              Hiệu lực từ{" "}
                              <span className="font-mono tabular-nums">
                                {vendor.current_link.effective_from}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted">Chưa gán người giới thiệu</span>
                        )}
                      </td>
                      <td data-label="Lịch sử" className={DATA_TABLE_TD_CLASS}>
                        <span className="font-mono text-xs tabular-nums text-muted">
                          {vendor.history_count} liên kết
                        </span>
                      </td>
                      <td data-card-actions="true" className={`${DATA_TABLE_TD_CLASS} text-right`}>
                        <RowActionCluster>
                          {vendor.current_link ? (
                            <>
                              <Button
                                size="sm"
                                variant="soft"
                                disabled={!vendor.active || locked}
                                title={
                                  !vendor.active
                                    ? "Không thể thay thế người giới thiệu trên Vendor ngừng hoạt động"
                                    : undefined
                                }
                                onClick={() => openAssignDialog(vendor)}
                              >
                                Thay thế
                              </Button>
                              <Button
                                size="sm"
                                variant="danger-outline"
                                disabled={locked}
                                onClick={() => openRevokeDialog(vendor)}
                              >
                                Thu hồi
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={!vendor.active || locked}
                              title={
                                !vendor.active
                                  ? "Không thể gán người giới thiệu trên Vendor ngừng hoạt động"
                                  : undefined
                              }
                              onClick={() => openAssignDialog(vendor)}
                            >
                              Gán người giới thiệu
                            </Button>
                          )}
                          {vendor.current_link ? (
                            <Link
                              href={"/admin/catalog/vendors?tab=referral-report&vendor_id=" + encodeURIComponent(vendor.vendor_id)}
                              className={buttonClasses({ variant: "outline", size: "sm" })}
                            >
                              Xem lượt tuyển
                            </Link>
                          ) : null}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void openHistoryDialog(vendor)}
                          >
                            Xem lịch sử
                          </Button>
                        </RowActionCluster>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTableContainer>
          )
        ) : null}
      </Card>

      <FormDialog
        open={mutationDialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy && !conflictState) {
            setMutationDialog(null);
            setPendingIntent(null);
            setFormError(null);
          }
        }}
        closeDisabled={busy || conflictState !== null}
        descriptionId="vendor-referrer-mutation-description"
        title={
          mutationDialog?.kind === "assign"
            ? mutationDialog.mode === "assign"
              ? "Gán người giới thiệu Vendor"
              : "Thay thế người giới thiệu Vendor"
            : "Thu hồi người giới thiệu Vendor"
        }
        description={
          mutationDialog
            ? `${mutationDialog.vendor.display_name} (${mutationDialog.vendor.vendor_id})`
            : undefined
        }
      >
        {pendingIntent?.retry ? (
          <div className="mb-4">
            <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
              <p>Hệ thống giữ nguyên khóa idempotency để tránh ghi trùng khi thử lại.</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                disabled={busy}
                onClick={() => void sendIntent(pendingIntent)}
              >
                {busy ? "Đang gửi lại…" : "Thử lại thao tác"}
              </Button>
            </Alert>
          </div>
        ) : null}

        {conflictState ? (
          <div className="mb-4">
            <Alert tone="warning" title="Phát hiện xung đột cập nhật (409)">
              <p>{conflictState.message}</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                disabled={busy}
                onClick={() => void recoverFromConflict()}
              >
                Tải lại dữ liệu mới nhất
              </Button>
            </Alert>
          </div>
        ) : null}

        {mutationDialog ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            {mutationDialog.vendor.current_link ? (
              <div className="rounded-xl border border-border bg-surface-muted p-3 text-xs">
                <p className="font-semibold text-foreground">Người giới thiệu hiện tại</p>
                <p className="mt-1 text-foreground">
                  {mutationDialog.vendor.current_link.referrer_full_name} ·{" "}
                  <span className="font-mono">
                    {mutationDialog.vendor.current_link.referrer_employee_code}
                  </span>
                  {mutationDialog.vendor.current_link.referrer_department_name
                    ? ` · ${mutationDialog.vendor.current_link.referrer_department_name}`
                    : ""}
                </p>
                <p className="mt-0.5 text-muted">
                  Hiệu lực từ{" "}
                  <span className="font-mono tabular-nums">
                    {mutationDialog.vendor.current_link.effective_from}
                  </span>
                </p>
              </div>
            ) : null}

            {mutationDialog.kind === "assign" ? (
              <div className="space-y-2">
                <label
                  htmlFor="referrer-candidate-search"
                  className="block text-sm font-medium text-foreground"
                >
                  Chọn NVTD giới thiệu (HRP đủ điều kiện, liên phòng ban) *
                </label>
                <input
                  id="referrer-candidate-search"
                  type="text"
                  value={candidateSearch}
                  maxLength={VENDOR_REFERRER_SEARCH_MAX}
                  placeholder="Tìm theo họ tên, mã nhân viên hoặc phòng ban..."
                  onChange={(event) => setCandidateSearch(event.target.value)}
                  className={INPUT_CLASS}
                />

                {candidatesState.kind === "loading" ? (
                  <p role="status" className="text-xs text-muted">
                    Đang tải danh sách NVTD đủ điều kiện…
                  </p>
                ) : candidatesState.kind === "error" ? (
                  <div className="space-y-2 rounded-lg border border-status-danger-border bg-status-danger-bg p-3 text-xs text-status-danger-text">
                    <p>{candidatesState.message}</p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setCandidatesReloadToken((v) => v + 1)}
                    >
                      Tải lại danh sách NVTD
                    </Button>
                  </div>
                ) : candidatesState.kind === "loaded" ? (
                  <div
                    role="listbox"
                    aria-label="Danh sách NVTD giới thiệu đủ điều kiện"
                    className="max-h-52 space-y-1 overflow-y-auto rounded-xl border border-border bg-surface p-1.5"
                  >
                    {filteredCandidates.length === 0 ? (
                      <p className="px-2.5 py-3 text-center text-xs text-muted">
                        Không có NVTD phù hợp với từ khóa tìm kiếm.
                      </p>
                    ) : (
                      filteredCandidates.map((candidate) => {
                        const isSameAsCurrent =
                          mutationDialog.vendor.current_link?.referrer_person_id ===
                          candidate.person_id;
                        const selected = selectedPersonId === candidate.person_id;
                        return (
                          <button
                            key={candidate.person_id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            disabled={isSameAsCurrent}
                            onClick={() => {
                              setSelectedPersonId(candidate.person_id);
                              setFormError(null);
                            }}
                            className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                              selected
                                ? "border border-primary/40 bg-[var(--selected-bg)] font-semibold text-primary"
                                : isSameAsCurrent
                                  ? "cursor-not-allowed opacity-55 text-muted"
                                  : "text-foreground hover:bg-surface-hover"
                            }`}
                          >
                            <span className="min-w-0 truncate">
                              {formatCandidateOptionLabel(candidate)}
                            </span>
                            {isSameAsCurrent ? (
                              <span className="shrink-0 text-[11px] text-muted">
                                Đang gán hiện tại
                              </span>
                            ) : selected ? (
                              <span className="shrink-0 text-[11px] font-semibold">Đã chọn</span>
                            ) : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : null}

                {selectedCandidate ? (
                  <p className="text-xs text-primary">
                    Đã chọn: <strong>{formatCandidateOptionLabel(selectedCandidate)}</strong>
                  </p>
                ) : null}
              </div>
            ) : (
              <Alert tone="warning" title="Xác nhận thu hồi liên kết">
                <p>
                  Các lượt có ngày vào làm trước ngày thu hồi vẫn được tính cho người giới thiệu hiện tại.
                </p>
              </Alert>
            )}

            <label
              htmlFor="referrer-effective-date"
              className="flex flex-col gap-1 text-sm font-medium text-foreground"
            >
              Ngày hiệu lực (giờ Việt Nam)
              <input
                id="referrer-effective-date"
                type="date"
                value={effectiveDate}
                aria-describedby="referrer-effective-date-help"
                required
                onChange={(event) => {
                  setEffectiveDate(event.target.value);
                  setFormError(null);
                }}
                className={INPUT_CLASS}
              />
            </label>

            <p id="referrer-effective-date-help" className="text-sm text-muted">
              {mutationDialog.kind === "assign"
                ? "Các lượt có ngày vào làm từ ngày đã chọn sẽ được tính cho người giới thiệu."
                : "Các lượt có ngày vào làm từ ngày đã chọn sẽ vào nhóm Vendor chưa có người giới thiệu."}
            </p>

            {formError ? (
              <p role="alert" className="text-sm font-medium text-rose-700 dark:text-rose-300">
                {formError}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Button
                type="button"
                variant="secondary"
                disabled={busy || conflictState !== null}
                onClick={() => setMutationDialog(null)}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                variant={mutationDialog.kind === "revoke" ? "danger" : "primary"}
                disabled={busy || conflictState !== null}
              >
                {busy
                  ? "Đang lưu…"
                  : mutationDialog.kind === "assign"
                    ? mutationDialog.mode === "assign"
                      ? "Xác nhận gán"
                      : "Xác nhận thay thế"
                    : "Xác nhận thu hồi"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      <FormDialog
        open={historyDialog !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryDialog(null);
        }}
        contentClassName="sm:w-[min(52rem,calc(100vw-2rem))]"
        descriptionId="vendor-referrer-history-description"
        title="Lịch sử người giới thiệu Vendor"
        description={
          historyDialog
            ? `${historyDialog.vendor.display_name} (${historyDialog.vendor.vendor_id})`
            : undefined
        }
      >
        {historyDialog?.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted">
            Đang tải lịch sử liên kết và nhật ký kiểm toán…
          </p>
        ) : null}

        {historyDialog?.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState title="Không tải được lịch sử" detail={historyDialog.message} />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void openHistoryDialog(historyDialog.vendor)}
            >
              Thử lại
            </Button>
          </div>
        ) : null}

        {historyDialog?.kind === "loaded" ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-muted p-3 text-xs">
              <div>
                <span className="font-semibold text-foreground">
                  {historyDialog.data.vendor.display_name}
                </span>{" "}
                <span className="font-mono text-muted">
                  ({historyDialog.data.vendor.vendor_id})
                </span>
              </div>
              <StatusBadge tone={historyDialog.data.vendor.active ? "success" : "neutral"} dot>
                {historyDialog.data.vendor.active ? "Đang hoạt động" : "Ngừng hoạt động"}
              </StatusBadge>
            </div>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-[var(--navy)]">
                Các khoảng hiệu lực ({historyDialog.data.links.length})
              </h3>
              {historyDialog.data.links.length === 0 ? (
                <EmptyState
                  title="Chưa có lịch sử gán người giới thiệu"
                  description="Vendor này chưa từng được gán NVTD giới thiệu."
                />
              ) : (
                <div className="space-y-2">
                  {historyDialog.data.links.map((link) => {
                    const status = classifyReferrerLinkInterval(link);
                    return (
                      <div
                        key={link.link_id}
                        className="rounded-xl border border-border bg-surface p-3 text-xs space-y-1.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium text-foreground">
                            {link.referrer_full_name} ·{" "}
                            <span className="font-mono">{link.referrer_employee_code}</span>
                            {link.referrer_department_name
                              ? ` · ${link.referrer_department_name}`
                              : ""}
                          </div>
                          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                        </div>
                        <div className="text-muted">
                          Khoảng hiệu lực:{" "}
                          <span className="font-mono tabular-nums text-foreground">
                            {link.effective_from} → {link.effective_to ?? "Hiện tại"}
                          </span>
                          {status.isSameDaySuperseded ? (
                            <span className="ml-2 inline-flex rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-800 dark:text-amber-200">
                              Thay thế cùng ngày [{link.effective_from}, {link.effective_to}) — không
                              tính lượt
                            </span>
                          ) : null}
                        </div>
                        <div className="text-muted">
                          Người gán{" "}
                          {link.created_by_display_name} ({formatTimestamp(link.created_at)})
                        </div>
                        {link.ended_at ? (
                          <div className="text-muted">
                            Người kết thúc{" "}
                            {link.ended_by_display_name ?? "—"} ({formatTimestamp(link.ended_at)})
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-[var(--navy)]">
                Nhật ký thao tác ({historyDialog.data.audit_events.length})
              </h3>
              {historyDialog.data.audit_events.length === 0 ? (
                <EmptyState title="Chưa có nhật ký thao tác" />
              ) : (
                <div className="space-y-2">
                  {historyDialog.data.audit_events.map((eventItem) => {
                    const badge = formatReferrerAuditAction(eventItem.action);
                    return (
                      <div
                        key={eventItem.event_id}
                        className="rounded-xl border border-border bg-surface p-3 text-xs space-y-1"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                            <span className="font-mono tabular-nums text-muted">
                              Hiệu lực {eventItem.effective_date}
                            </span>
                          </div>
                          <span className="text-muted">{formatTimestamp(eventItem.created_at)}</span>
                        </div>
                        <div className="text-foreground">
                          {eventItem.previous_referrer_full_name
                            ? `${eventItem.previous_referrer_full_name} → ${eventItem.referrer_full_name ?? "Không có"}`
                            : eventItem.referrer_full_name ?? "—"}
                        </div>
                        <div className="text-muted">
                          Người thực hiện <span className="text-foreground">{eventItem.actor_display_name}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        ) : null}
      </FormDialog>
    </div>
  );
}
