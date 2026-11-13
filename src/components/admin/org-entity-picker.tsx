"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { StatusBadge } from "@/components/ui/badge";
import { OffsetPager } from "@/components/ui/offset-pager";
import {
  ACCOUNT_LIST_PAGE_SIZE,
  buildAccountListQuery,
  projectAccountListForQuery,
} from "@/lib/admin/account-access-model";
import {
  buildPersonnelListQuery,
  PERSONNEL_PAGE_SIZE,
  projectPersonnelListForQuery,
} from "@/lib/admin/personnel-catalog-model";
import {
  accountTypeLabel,
  buildPersonListQuery,
  DEFAULT_ORG_PAGE_SIZE,
  projectPersonListEnvelope,
  sanitizeOrgSearchInput,
  type PersonLinkState,
  type PersonSummaryProjection,
} from "@/lib/admin/person-org-ui-model";
import {
  projectDepartmentListResponse,
  type DepartmentProjection,
} from "@/lib/departments/department-contract";
import type { ExistingAccount } from "@/lib/direct-entry/app-user-access-contract";
import type { AdminPersonnel } from "@/lib/direct-entry/personnel-catalog-contract";

export type SelectedDepartmentOption = {
  department_id: string;
  code: string;
  name: string;
  is_active: boolean;
  version: number;
};

export type SelectedAccountOption = {
  account_ref: string;
  version: number;
  display_name: string | null;
  login_id: string | null;
  enabled: boolean;
};

function unwrapDepartmentsOk(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== "ok") rest[k] = v;
  }
  return rest;
}

export function DepartmentSelectPicker({
  id,
  label,
  selectedId,
  onSelect,
  excludeDepartmentId = null,
  includeInactive = false,
  allowClear = true,
  emptyLabel = "Không chọn phòng ban",
  disabled = false,
  onSessionLost,
}: {
  id: string;
  label: string;
  selectedId: string | null;
  onSelect: (dept: SelectedDepartmentOption | null) => void;
  excludeDepartmentId?: string | null;
  includeInactive?: boolean;
  allowClear?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
  onSessionLost?: (message: string) => void;
}) {
  const filterId = useId();
  const [departments, setDepartments] = useState<readonly DepartmentProjection[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [filterText, setFilterText] = useState("");
  const seqRef = useRef(0);

  useEffect(() => {
    const reqSeq = ++seqRef.current;
    const controller = new AbortController();
    void (async () => {
      setStatus("loading");
      try {
        const response = await fetch(
          `/api/admin/departments?include_inactive=${includeInactive ? "true" : "false"}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (controller.signal.aborted || reqSeq !== seqRef.current) return;
        const payload = await response.json().catch(() => null);
        if (controller.signal.aborted || reqSeq !== seqRef.current) return;
        if (response.status === 401 || response.status === 403) {
          setDepartments([]);
          setStatus("error");
          onSessionLost?.("Phiên đăng nhập hoặc quyền quản trị đã hết hiệu lực.");
          return;
        }
        if (response.status !== 200) {
          setStatus("error");
          return;
        }
        const rest = unwrapDepartmentsOk(payload);
        const projected = rest ? projectDepartmentListResponse(rest) : null;
        if (!projected) {
          setStatus("error");
          return;
        }
        setDepartments(projected.departments);
        setStatus("ready");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (reqSeq !== seqRef.current) return;
        setStatus("error");
      }
    })();
    return () => controller.abort();
  }, [includeInactive, onSessionLost]);

  const filtered = useMemo(() => {
    const term = filterText.trim().toLowerCase();
    return departments.filter((dept) => {
      if (excludeDepartmentId && dept.department_id === excludeDepartmentId.toLowerCase()) {
        return false;
      }
      if (!dept.is_active && !includeInactive) return false;
      if (!term) return true;
      return (
        dept.name.toLowerCase().includes(term) ||
        dept.code.toLowerCase().includes(term)
      );
    });
  }, [departments, excludeDepartmentId, filterText, includeInactive]);

  const selectedDept = useMemo(
    () => departments.find((d) => d.department_id === selectedId) ?? null,
    [departments, selectedId],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {selectedDept && allowClear ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect(null)}
            className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          >
            Bỏ chọn phòng ban
          </button>
        ) : null}
      </div>

      <input
        id={filterId}
        type="search"
        value={filterText}
        disabled={disabled}
        onChange={(event) => setFilterText(sanitizeOrgSearchInput(event.target.value))}
        placeholder="Tìm nhanh theo tên hoặc mã phòng ban…"
        aria-label={`Tìm ${label.toLowerCase()}`}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
      />

      {status === "loading" ? (
        <p role="status" className="text-xs text-muted">
          Đang tải danh sách phòng ban…
        </p>
      ) : status === "error" ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          Không tải được danh sách phòng ban.
        </p>
      ) : filtered.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5 text-xs text-muted">
          {filterText.trim()
            ? "Không tìm thấy phòng ban khớp từ khóa."
            : emptyLabel}
        </p>
      ) : (
        <div
          id={id}
          role="listbox"
          aria-label={label}
          className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-surface-muted/20 p-2"
        >
          {allowClear ? (
            <button
              type="button"
              role="option"
              aria-selected={selectedId === null}
              disabled={disabled}
              onClick={() => onSelect(null)}
              className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                selectedId === null
                  ? "border-primary bg-primary/10 font-medium text-foreground"
                  : "border-transparent bg-surface text-muted hover:border-border"
              }`}
            >
              <span>{emptyLabel}</span>
            </button>
          ) : null}
          {filtered.map((dept) => {
            const isSelected = selectedId === dept.department_id;
            return (
              <button
                key={dept.department_id}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={disabled}
                onClick={() =>
                  onSelect({
                    department_id: dept.department_id,
                    code: dept.code,
                    name: dept.name,
                    is_active: dept.is_active,
                    version: dept.version,
                  })
                }
                className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 ${
                  isSelected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border/70 bg-surface text-foreground hover:border-primary/40"
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{dept.name}</span>
                  <span className="block font-mono text-xs text-muted">{dept.code}</span>
                </span>
                {!dept.is_active ? (
                  <StatusBadge tone="neutral">Ngừng hoạt động</StatusBadge>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function PersonSearchPicker({
  id,
  label,
  selectedPersonId,
  onSelect,
  linkState = "all",
  disabled = false,
  onSessionLost,
  requireUnassignedDepartment = false,
}: {
  id: string;
  label: string;
  selectedPersonId: string | null;
  onSelect: (person: PersonSummaryProjection | null) => void;
  linkState?: PersonLinkState;
  disabled?: boolean;
  onSessionLost?: (message: string) => void;
  requireUnassignedDepartment?: boolean;
}) {
  const searchId = useId();
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; persons: readonly PersonSummaryProjection[]; total: number; page: number }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const seqRef = useRef(0);

  useEffect(() => {
    const reqSeq = ++seqRef.current;
    const controller = new AbortController();
    void (async () => {
      const filter = {
        search: appliedSearch,
        status: "active" as const,
        departmentId: null,
        linkState,
        page,
        pageSize: DEFAULT_ORG_PAGE_SIZE,
      };
      const query = buildPersonListQuery(filter);
      if (!query) {
        setState({ kind: "error", message: "Từ khóa tìm kiếm nhân sự không hợp lệ." });
        return;
      }
      setState({ kind: "loading" });
      try {
        const response = await fetch(`/api/admin/organization/persons?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (controller.signal.aborted || reqSeq !== seqRef.current) return;
        const payload = await response.json().catch(() => null);
        if (controller.signal.aborted || reqSeq !== seqRef.current) return;
        if (response.status === 401 || response.status === 403) {
          setState({ kind: "error", message: "Phiên hoặc quyền quản trị đã hết hiệu lực." });
          onSessionLost?.("Phiên đăng nhập hoặc quyền quản trị đã hết hiệu lực.");
          return;
        }
        if (response.status !== 200) {
          setState({ kind: "error", message: "Không tải được danh sách Nhân sự nội bộ." });
          return;
        }
        const projected = projectPersonListEnvelope(payload, filter);
        if (!projected) {
          setState({ kind: "error", message: "Phản hồi danh sách nhân sự không hợp lệ." });
          return;
        }
        setState({
          kind: "ready",
          persons: projected.persons,
          total: projected.total,
          page: projected.page,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (reqSeq !== seqRef.current) return;
        setState({ kind: "error", message: "Mất kết nối khi tìm Nhân sự nội bộ." });
      }
    })();
    return () => controller.abort();
  }, [appliedSearch, linkState, onSessionLost, page]);

  const pageCount =
    state.kind === "ready"
      ? Math.max(1, Math.ceil(state.total / DEFAULT_ORG_PAGE_SIZE))
      : 1;

  return (
    <div className="space-y-2">
      <label htmlFor={searchId} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={searchId}
          type="search"
          disabled={disabled}
          value={searchInput}
          onChange={(event) => {
            const sanitized = sanitizeOrgSearchInput(event.target.value);
            setSearchInput(sanitized);
            setAppliedSearch(sanitized);
            setPage(1);
          }}
          placeholder="Tìm theo họ tên hoặc mã nhân sự…"
          className="min-w-48 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
        />
      </div>

      {state.kind === "loading" ? (
        <p role="status" className="text-xs text-muted">
          Đang tải danh sách nhân sự nội bộ…
        </p>
      ) : state.kind === "error" ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {state.message}
        </p>
      ) : state.persons.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5 text-xs text-muted">
          Không tìm thấy nhân sự nội bộ phù hợp.
        </p>
      ) : (
        <div className="space-y-2">
          <div
            id={id}
            role="listbox"
            aria-label={label}
            className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-surface-muted/20 p-2"
          >
            {state.persons.map((person) => {
              const isSelected = selectedPersonId === person.person_id;
              const alreadyInDept = Boolean(person.active_department);
              const blockedByDept = requireUnassignedDepartment && alreadyInDept;
              return (
                <button
                  key={person.person_id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={disabled || blockedByDept}
                  onClick={() => onSelect(person)}
                  className={`flex w-full items-start justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60 ${
                    isSelected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/70 bg-surface text-foreground hover:border-primary/40"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {person.full_name} ·{" "}
                      <span className="font-mono text-xs">{person.employee_code}</span>
                    </span>
                    <span className="block text-xs text-muted">
                      {person.active_department
                        ? `Đang thuộc: ${person.active_department.name}`
                        : "Chưa gán phòng ban"}
                      {" · "}
                      {person.active_account_link
                        ? `Tài khoản: ${person.active_account_link.display_name ?? person.active_account_link.login_id ?? "Đã liên kết"}`
                        : "Chưa liên kết tài khoản"}
                    </span>
                  </span>
                  {blockedByDept ? (
                    <StatusBadge tone="warning">Đã có phòng</StatusBadge>
                  ) : isSelected ? (
                    <StatusBadge tone="primary">Đã chọn</StatusBadge>
                  ) : null}
                </button>
              );
            })}
          </div>
          {pageCount > 1 ? (
            <OffsetPager
              page={state.page}
              pageCount={pageCount}
              total={state.total}
              disabled={disabled}
              onPageChange={(next) => setPage(next)}
              className="mt-2 pt-2"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

export function AccountSearchPicker({
  id,
  label,
  selectedAccountRef,
  onSelect,
  disabled = false,
  onSessionLost,
}: {
  id: string;
  label: string;
  selectedAccountRef: string | null;
  onSelect: (account: SelectedAccountOption | null) => void;
  disabled?: boolean;
  onSessionLost?: (message: string) => void;
}) {
  const searchId = useId();
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; accounts: readonly ExistingAccount[]; total: number; page: number }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const seqRef = useRef(0);

  useEffect(() => {
    const reqSeq = ++seqRef.current;
    const controller = new AbortController();
    void (async () => {
      const filter = { search: searchInput, enabled: "all" as const, page };
      const query = buildAccountListQuery(filter);
      if (!query) {
        setState({ kind: "error", message: "Từ khóa tìm tài khoản không hợp lệ." });
        return;
      }
      setState({ kind: "loading" });
      try {
        const response = await fetch(`/api/admin/access/accounts?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (controller.signal.aborted || reqSeq !== seqRef.current) return;
        const payload = await response.json().catch(() => null);
        if (controller.signal.aborted || reqSeq !== seqRef.current) return;
        if (response.status === 401 || response.status === 403) {
          setState({ kind: "error", message: "Phiên hoặc quyền quản trị đã hết hiệu lực." });
          onSessionLost?.("Phiên đăng nhập hoặc quyền quản trị đã hết hiệu lực.");
          return;
        }
        if (response.status !== 200) {
          setState({ kind: "error", message: "Không tải được danh sách tài khoản truy cập." });
          return;
        }
        const projected = projectAccountListForQuery(payload, filter);
        if (!projected) {
          setState({ kind: "error", message: "Phản hồi danh sách tài khoản không hợp lệ." });
          return;
        }
        setState({
          kind: "ready",
          accounts: projected.accounts,
          total: projected.total,
          page: projected.page,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (reqSeq !== seqRef.current) return;
        setState({ kind: "error", message: "Mất kết nối khi tải danh sách tài khoản." });
      }
    })();
    return () => controller.abort();
  }, [onSessionLost, page, searchInput]);

  const pageCount =
    state.kind === "ready"
      ? Math.max(1, Math.ceil(state.total / ACCOUNT_LIST_PAGE_SIZE))
      : 1;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={searchId} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {selectedAccountRef ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect(null)}
            className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          >
            Bỏ chọn tài khoản
          </button>
        ) : null}
      </div>

      <input
        id={searchId}
        type="search"
        disabled={disabled}
        value={searchInput}
        onChange={(event) => {
          setSearchInput(sanitizeOrgSearchInput(event.target.value));
          setPage(1);
        }}
        placeholder="Tìm theo tên hiển thị hoặc tên đăng nhập…"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
      />

      {state.kind === "loading" ? (
        <p role="status" className="text-xs text-muted">
          Đang tải danh sách tài khoản…
        </p>
      ) : state.kind === "error" ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {state.message}
        </p>
      ) : state.accounts.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5 text-xs text-muted">
          Không tìm thấy tài khoản phù hợp.
        </p>
      ) : (
        <div className="space-y-2">
          <div
            id={id}
            role="listbox"
            aria-label={label}
            className="max-h-52 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-surface-muted/20 p-2"
          >
            {state.accounts.map((account) => {
              const eligible =
                account.account_type === "NORMAL" && account.active_person_link === null;
              const isSelected = selectedAccountRef === account.account_ref;
              const typeMeta = accountTypeLabel(account.account_type);
              return (
                <button
                  key={account.account_ref}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={disabled || !eligible}
                  onClick={() =>
                    onSelect({
                      account_ref: account.account_ref,
                      version: account.version,
                      display_name: account.display_name,
                      login_id: account.login_id,
                      enabled: account.enabled,
                    })
                  }
                  className={`flex w-full items-start justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60 ${
                    isSelected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/70 bg-surface text-foreground hover:border-primary/40"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {account.display_name ?? "Chưa đặt tên hiển thị"}
                      {account.login_id ? ` · ${account.login_id}` : ""}
                    </span>
                    <span className="block text-xs text-muted">
                      {typeMeta.shortLabel}
                      {account.active_person_link
                        ? ` · Đã nối với ${account.active_person_link.full_name} (${account.active_person_link.employee_code})`
                        : account.account_type === "NORMAL"
                          ? " · Chưa liên kết hồ sơ người"
                          : " · Không được liên kết hồ sơ người"}
                    </span>
                  </span>
                  <StatusBadge tone={account.enabled ? "success" : "neutral"}>
                    {account.enabled ? "Đang mở" : "Đã khóa"}
                  </StatusBadge>
                </button>
              );
            })}
          </div>
          {pageCount > 1 ? (
            <OffsetPager
              page={state.page}
              pageCount={pageCount}
              total={state.total}
              disabled={disabled}
              onPageChange={(next) => setPage(next)}
              className="mt-2 pt-2"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

export function RecruiterConfirmPicker({
  id,
  label,
  initialSearch = "",
  selectedRecruiterId,
  onSelect,
  disabled = false,
  onSessionLost,
}: {
  id: string;
  label: string;
  initialSearch?: string;
  selectedRecruiterId: string | null;
  onSelect: (recruiter: AdminPersonnel | null) => void;
  disabled?: boolean;
  onSessionLost?: (message: string) => void;
}) {
  const searchId = useId();
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; personnel: readonly AdminPersonnel[]; total: number; page: number }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const seqRef = useRef(0);

  useEffect(() => {
    const reqSeq = ++seqRef.current;
    const controller = new AbortController();
    void (async () => {
      const filter = { search: searchInput, includeInactive: true, page };
      const query = buildPersonnelListQuery(filter);
      if (!query) {
        setState({ kind: "error", message: "Từ khóa tìm hồ sơ tính công tuyển dụng không hợp lệ." });
        return;
      }
      setState({ kind: "loading" });
      try {
        const response = await fetch(`/api/admin/catalog/personnel?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (controller.signal.aborted || reqSeq !== seqRef.current) return;
        const payload = await response.json().catch(() => null);
        if (controller.signal.aborted || reqSeq !== seqRef.current) return;
        if (response.status === 401 || response.status === 403) {
          setState({ kind: "error", message: "Phiên hoặc quyền quản trị đã hết hiệu lực." });
          onSessionLost?.("Phiên đăng nhập hoặc quyền quản trị đã hết hiệu lực.");
          return;
        }
        if (response.status !== 200) {
          setState({ kind: "error", message: "Không tải được danh sách hồ sơ tính công tuyển dụng." });
          return;
        }
        const projected = projectPersonnelListForQuery(payload, filter);
        if (!projected) {
          setState({ kind: "error", message: "Phản hồi danh sách hồ sơ tính công không hợp lệ." });
          return;
        }
        setState({
          kind: "ready",
          personnel: projected.personnel,
          total: projected.total,
          page: projected.page,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (reqSeq !== seqRef.current) return;
        setState({ kind: "error", message: "Mất kết nối khi tải hồ sơ tính công tuyển dụng." });
      }
    })();
    return () => controller.abort();
  }, [onSessionLost, page, searchInput]);

  const pageCount =
    state.kind === "ready"
      ? Math.max(1, Math.ceil(state.total / PERSONNEL_PAGE_SIZE))
      : 1;

  return (
    <div className="space-y-2">
      <label htmlFor={searchId} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        id={searchId}
        type="search"
        disabled={disabled}
        value={searchInput}
        onChange={(event) => {
          setSearchInput(sanitizeOrgSearchInput(event.target.value));
          setPage(1);
          onSelect(null);
        }}
        placeholder="Tìm theo tên hoặc mã hồ sơ tính công…"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
      />
      {state.kind === "loading" ? (
        <p role="status" className="text-xs text-muted">
          Đang tải hồ sơ tính công tuyển dụng…
        </p>
      ) : state.kind === "error" ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {state.message}
        </p>
      ) : state.personnel.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5 text-xs text-muted">
          Không tìm thấy hồ sơ tính công tuyển dụng khớp từ khóa.
        </p>
      ) : (
        <div className="space-y-2">
          <div
            id={id}
            role="listbox"
            aria-label={label}
            className="max-h-44 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-surface-muted/20 p-2"
          >
            {state.personnel.map((row) => {
              const isSelected = selectedRecruiterId === row.recruiter_id;
              return (
                <button
                  key={row.recruiter_id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={disabled}
                  onClick={() => onSelect(row)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 ${
                    isSelected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/70 bg-surface text-foreground hover:border-primary/40"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{row.display_name}</span>
                    <span className="block font-mono text-xs text-muted">
                      {row.personnel_code ?? "Chưa có mã"}
                    </span>
                  </span>
                  <StatusBadge tone={row.active ? "success" : "neutral"}>
                    {row.active ? "Hoạt động" : "Ngừng"}
                  </StatusBadge>
                </button>
              );
            })}
          </div>
          {pageCount > 1 ? (
            <OffsetPager
              page={state.page}
              pageCount={pageCount}
              total={state.total}
              disabled={disabled}
              onPageChange={(next) => setPage(next)}
              className="mt-2 pt-2"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
