"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  DepartmentSelectPicker,
  PersonSearchPicker,
  type SelectedDepartmentOption,
} from "@/components/admin/org-entity-picker";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
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
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import {
  ACCOUNTING_DEFAULT_POLICY_DESCRIPTION,
  DEPARTMENT_NAME_MAX_LENGTH,
  DEPARTMENT_UI_MAX_REASON_LENGTH,
  DEPARTMENT_UI_MAX_SEARCH_LENGTH,
  DEPARTMENT_WP3_MAX_REASON_LENGTH,
  RECRUITMENT_DEFAULT_POLICY_DESCRIPTION,
  buildAccountingCandidatesQuery,
  buildAccountingMembershipsQuery,
  buildAssignAccountingMemberRequest,
  buildAssignDepartmentPersonMemberRequest,
  buildDepartmentHeadsQuery,
  buildDepartmentPersonMembershipsQuery,
  buildDesignateDepartmentHeadRequest,
  buildEndAccountingMemberRequest,
  buildEndDepartmentHeadRequest,
  buildEndDepartmentPersonMemberRequest,
  buildRecruitmentTeamsQuery,
  buildUpdateDepartmentRequest,
  canManageDepartmentMemberships,
  canToggleDepartmentActive,
  candidateAvailabilityBadge,
  classifyDepartmentMutationResponse,
  classifyDepartmentReadError,
  departmentDefaultPolicyDescription,
  departmentScaleSummary,
  formatAccountSecondaryMeta,
  isCandidateAssignable,
  membershipStateBadge,
  newDepartmentIdempotencyKey,
  normalizeDepartmentUuid,
  projectAccountingCandidatesEnvelope,
  projectAccountingMembershipsEnvelope,
  projectDepartmentDetailEnvelope,
  projectDepartmentHeadsListEnvelope,
  projectDepartmentMutationEnvelope,
  projectDepartmentPersonMemberMutationEnvelope,
  projectDepartmentPersonMembershipsListEnvelope,
  projectDesignateDepartmentHeadEnvelope,
  projectEndDepartmentHeadEnvelope,
  projectRecruitmentTeamsEnvelope,
  resolveWp3DepartmentMutationResult,
  sanitizeDepartmentSearchInput,
  visibleRecruitmentTeams,
  type DepartmentWp3MutationResult,
} from "@/lib/admin/department-ui-model";
import {
  buildTransferPersonDepartmentRequest,
  classifyPersonOrgMutationResponse,
  type PersonSummaryProjection,
} from "@/lib/admin/person-org-ui-model";
import type {
  AccountingCandidateListProjection,
  AccountingCandidateProjection,
  AccountingMembershipListProjection,
  AccountingMembershipProjection,
  DepartmentDetailProjection,
  DepartmentHeadsListProjection,
  DepartmentPersonMembershipStatusFilter,
  DepartmentPersonMembershipsListProjection,
  PersonDeptMembershipProjection,
  RecruitmentTeamListProjection,
} from "@/lib/departments/department-contract";

const INPUT_CLASS =
  "min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm text-foreground " +
  "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const TEXTAREA_CLASS =
  "min-h-24 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm text-foreground " +
  "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

type DepartmentDetailLoadState =
  | { kind: "loading" }
  | { kind: "ready"; detail: DepartmentDetailProjection }
  | { kind: "denied"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "error"; message: string; retryable: boolean };

type SubListLoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string; retryable: boolean };

type AccountingDialogState =
  | { kind: "assign" }
  | { kind: "end"; membership: AccountingMembershipProjection }
  | null;

type DialogFeedback = {
  tone: "error" | "warning";
  message: string;
  needsReload: boolean;
} | null;

export function DepartmentDetailManager({
  departmentId,
}: {
  departmentId: string;
}) {
  const normalizedDepartmentId = normalizeDepartmentUuid(departmentId);
  const [detailState, setDetailState] = useState<DepartmentDetailLoadState>({
    kind: "loading",
  });
  const [detailReloadToken, setDetailReloadToken] = useState(0);

  useEffect(() => {
    if (!normalizedDepartmentId) return;

    const controller = new AbortController();
    void (async () => {
      setDetailState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/${encodeURIComponent(normalizedDepartmentId)}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDetailState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải thông tin Phòng ban.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setDetailState({ kind: "denied", message: failure.message });
          return;
        }
        if (failure.kind === "not-found") {
          setDetailState({ kind: "not-found", message: failure.message });
          return;
        }
        setDetailState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectDepartmentDetailEnvelope(payload, normalizedDepartmentId);
      if (!projected) {
        setDetailState({
          kind: "error",
          message: "Phản hồi thông tin Phòng ban không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setDetailState({ kind: "ready", detail: projected });
    })();

    return () => controller.abort();
  }, [normalizedDepartmentId, detailReloadToken]);

  const reloadDetail = () => {
    if (!normalizedDepartmentId) return;
    setDetailState({ kind: "loading" });
    setDetailReloadToken((value) => value + 1);
  };

  const handleSessionLost = useCallback((message: string) => {
    setDetailState({ kind: "denied", message });
  }, []);

  const handleChildMutated = useCallback(() => {
    setDetailReloadToken((value) => value + 1);
  }, []);

  const effectiveState: DepartmentDetailLoadState = normalizedDepartmentId
    ? detailState
    : {
        kind: "not-found",
        message: "Mã định danh phòng ban trên đường dẫn không hợp lệ.",
      };

  return (
    <PageShell
      dataTestId="department-detail-page"
      className="max-w-none px-0 py-0 sm:px-0 sm:py-0 lg:px-0"
    >
      <div>
        <Link
          href="/admin/departments"
          className="inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-md px-1 text-sm font-medium text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          ← Danh sách Phòng ban
        </Link>
      </div>

      {effectiveState.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải thông tin Phòng ban…
          </p>
        </Card>
      ) : null}

      {effectiveState.kind === "denied" ? (
        <Alert tone="error" role="alert" title="Không có quyền truy cập">
          {effectiveState.message}
        </Alert>
      ) : null}

      {effectiveState.kind === "not-found" ? (
        <Card>
          <div className="space-y-4">
            <EmptyState
              title="Không tìm thấy Phòng ban"
              description={effectiveState.message}
            />
            <div className="flex justify-center">
              <Link
                href="/admin/departments"
                className={buttonClasses({ variant: "secondary", size: "md" })}
              >
                Quay lại danh sách Phòng ban
              </Link>
            </div>
          </div>
        </Card>
      ) : null}

      {effectiveState.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState
              title="Không tải được thông tin Phòng ban"
              detail={effectiveState.message}
            />
            {effectiveState.retryable ? (
              <div>
                <Button variant="secondary" onClick={reloadDetail}>
                  Thử tải lại
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {effectiveState.kind === "ready" ? (
        <div className="space-y-6">
          <DepartmentGovernanceHeaderCard
            detail={effectiveState.detail}
            onReloadDetail={reloadDetail}
            onSessionLost={handleSessionLost}
          />

          <DepartmentHeadManagementSection
            detail={effectiveState.detail}
            parentReloadToken={detailReloadToken}
            onMutated={handleChildMutated}
            onSessionLost={handleSessionLost}
          />

          <DepartmentPersonMembershipsSection
            detail={effectiveState.detail}
            parentReloadToken={detailReloadToken}
            onMutated={handleChildMutated}
            onSessionLost={handleSessionLost}
          />

          {effectiveState.detail.department.system_key === "RECRUITMENT" ? (
            <RecruitmentDepartmentReadOnlySection
              detail={effectiveState.detail}
              parentReloadToken={detailReloadToken}
              onReloadDetail={reloadDetail}
            />
          ) : effectiveState.detail.department.system_key === "ACCOUNTING" ? (
            <AccountingDepartmentMembershipsSection
              detail={effectiveState.detail}
              parentReloadToken={detailReloadToken}
              onReloadDetail={reloadDetail}
              onMembershipMutated={() => setDetailReloadToken((value) => value + 1)}
            />
          ) : null}
        </div>
      ) : null}
    </PageShell>
  );
}

type Wp3DialogPendingIntent<T> = {
  url: string;
  method: "POST" | "PATCH";
  idempotencyKey: string;
  body: Record<string, unknown>;
  expectCreated: boolean;
  projector: (payload: unknown) => T | null;
  successMessage: string;
  uncertain: boolean;
};

function DepartmentGovernanceHeaderCard({
  detail,
  onReloadDetail,
  onSessionLost,
}: {
  detail: DepartmentDetailProjection;
  onReloadDetail: () => void;
  onSessionLost: (message: string) => void;
}) {
  const notify = useNotify();
  const department = detail.department;
  const isCustom = canToggleDepartmentActive(department);

  const [dialog, setDialog] = useState<"rename" | "toggle" | null>(null);
  const [nameInput, setNameInput] = useState(department.name);
  const [reasonInput, setReasonInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<Wp3DialogPendingIntent<unknown> | null>(null);
  const [feedback, setFeedback] = useState<DialogFeedback>(null);

  const resetDialog = () => {
    setPendingIntent(null);
    setFeedback(null);
    setDialog(null);
  };

  const openRename = () => {
    setNameInput(department.name);
    setReasonInput("");
    setPendingIntent(null);
    setFeedback(null);
    setDialog("rename");
  };

  const openToggle = () => {
    if (!isCustom) return;
    setNameInput(department.name);
    setReasonInput("");
    setPendingIntent(null);
    setFeedback(null);
    setDialog("toggle");
  };

  const executeIntent = async (intent: Wp3DialogPendingIntent<unknown>) => {
    setBusy(true);
    setFeedback(null);
    try {
      let response: Response;
      try {
        response = await fetch(intent.url, {
          method: intent.method,
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": intent.idempotencyKey,
          },
          body: JSON.stringify(intent.body),
        });
      } catch {
        setPendingIntent({ ...intent, uncertain: true });
        setFeedback({
          tone: "warning",
          message:
            "Mất kết nối hoặc hết thời gian chờ phản hồi. Nội dung và khóa gửi trùng được giữ nguyên để thử gửi lại hoặc tải lại đối chiếu.",
          needsReload: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      const outcome: DepartmentWp3MutationResult<unknown> = resolveWp3DepartmentMutationResult(
        response.status,
        payload,
        intent.projector,
        intent.expectCreated,
      );
      if (outcome.ok) {
        notify.success({ title: intent.successMessage });
        resetDialog();
        onReloadDetail();
        return;
      }
      const { failure } = outcome;
      if (failure.kind === "session-lost") {
        resetDialog();
        onSessionLost(failure.message);
        return;
      }
      if (failure.kind === "uncertain" && failure.preserveIdempotencyKey) {
        setPendingIntent({ ...intent, uncertain: true });
        setFeedback({
          tone: "warning",
          message: failure.message,
          needsReload: true,
        });
        return;
      }
      setPendingIntent(null);
      setFeedback({
        tone: failure.kind === "conflict" ? "warning" : "error",
        message: failure.message,
        needsReload: failure.needsReload,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dialog || busy) return;
    if (pendingIntent?.uncertain) {
      void executeIntent(pendingIntent);
      return;
    }

    const idempotencyKey = pendingIntent?.idempotencyKey ?? newDepartmentIdempotencyKey();
    const nextActive = dialog === "toggle" ? !department.is_active : department.is_active;
    const built = buildUpdateDepartmentRequest({
      expectedDepartmentVersion: department.version,
      name: dialog === "rename" ? nameInput : department.name,
      isActive: nextActive,
      reason: reasonInput,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", message: built.message, needsReload: false });
      return;
    }
    const intent: Wp3DialogPendingIntent<unknown> = {
      url: `/api/admin/departments/${encodeURIComponent(department.department_id)}`,
      method: "PATCH",
      idempotencyKey: built.idempotencyKey,
      body: built.body,
      expectCreated: false,
      projector: projectDepartmentMutationEnvelope,
      successMessage:
        dialog === "rename"
          ? `Đã đổi tên phòng ban thành “${built.body.name}”.`
          : nextActive
            ? `Đã kích hoạt lại phòng ban “${department.name}”.`
            : `Đã ngừng hoạt động phòng ban “${department.name}”.`,
      uncertain: false,
    };
    setPendingIntent(intent);
    void executeIntent(intent);
  };

  const fieldsLocked = busy || pendingIntent?.uncertain === true;

  return (
    <Card data-testid="department-governance-header">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-foreground">{department.name}</h1>
              <StatusBadge tone={isCustom ? "info" : "neutral"}>
                {isCustom ? "Phòng tùy chỉnh" : "Phòng mặc định hệ thống"}
              </StatusBadge>
              <StatusBadge tone={department.is_active ? "success" : "neutral"} dot>
                {department.is_active ? "Đang hoạt động" : "Ngừng hoạt động"}
              </StatusBadge>
            </div>
            <p className="font-mono text-xs text-muted">
              Mã: {department.code} · Ngày hiệu lực hệ thống: {detail.authorization_date}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onReloadDetail}>
              Tải lại
            </Button>
            <Button variant="secondary" size="sm" onClick={openRename}>
              Đổi tên
            </Button>
            {isCustom ? (
              <Button
                variant={department.is_active ? "secondary" : "primary"}
                size="sm"
                onClick={openToggle}
              >
                {department.is_active ? "Ngừng hoạt động" : "Kích hoạt lại"}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
            <div className="text-xs text-muted">Quy mô hiện tại</div>
            <div className="mt-1 font-medium text-foreground tabular-nums">
              {departmentScaleSummary(department)}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
            <div className="text-xs text-muted">Trưởng phòng (HEAD) hiện tại</div>
            <div className="mt-1 font-medium text-foreground">
              {department.active_head ? (
                <Link
                  href={`/admin/organization/persons/${encodeURIComponent(department.active_head.person_id)}`}
                  className="text-primary hover:underline"
                >
                  {department.active_head.full_name} ({department.active_head.employee_code})
                </Link>
              ) : (
                "Chưa bổ nhiệm"
              )}
            </div>
          </div>
        </div>

        <Alert tone="info" title="Chính sách phân quyền mặc định (chỉ đọc)">
          {departmentDefaultPolicyDescription(department)}
        </Alert>
      </div>

      <FormDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) resetDialog();
        }}
        title={
          dialog === "rename"
            ? "Đổi tên phòng ban"
            : department.is_active
              ? "Ngừng hoạt động phòng ban tùy chỉnh"
              : "Kích hoạt lại phòng ban tùy chỉnh"
        }
        description="Thay đổi có hiệu lực ngay sau khi xác nhận."
        descriptionId="department-header-dialog-desc"
        closeDisabled={busy}
        dataTestId="department-header-dialog"
      >
        {dialog ? (
          <form className="space-y-4" onSubmit={handleSubmit}>
            {dialog === "rename" ? (
              <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
                Tên phòng ban mới (bắt buộc)
                <input
                  required
                  value={nameInput}
                  disabled={fieldsLocked}
                  maxLength={DEPARTMENT_NAME_MAX_LENGTH}
                  onChange={(event) => {
                    setPendingIntent(null);
                    setNameInput(event.target.value);
                  }}
                  className={INPUT_CLASS}
                />
              </label>
            ) : (
              <Alert tone={department.is_active ? "warning" : "info"} title={department.name}>
                {department.is_active
                  ? "Ngừng hoạt động chỉ thành công khi phòng ban không còn thành viên hay Trưởng phòng đang hiệu lực."
                  : "Kích hoạt lại phòng ban tùy chỉnh để tiếp nhận thành viên."}
              </Alert>
            )}

            <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
              Lý do thao tác (bắt buộc)
              <textarea
                required
                rows={3}
                value={reasonInput}
                disabled={fieldsLocked}
                maxLength={DEPARTMENT_WP3_MAX_REASON_LENGTH}
                placeholder="Nhập lý do cập nhật phòng ban…"
                onChange={(event) => {
                  setPendingIntent(null);
                  setReasonInput(event.target.value);
                }}
                className={TEXTAREA_CLASS}
              />
            </label>

            {feedback ? (
              <Alert
                tone={feedback.tone}
                role="alert"
                title={feedback.tone === "warning" ? "Cần xác nhận hoặc tải lại" : "Không thể lưu thay đổi"}
              >
                <p>{feedback.message}</p>
                {feedback.needsReload ? (
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        resetDialog();
                        onReloadDetail();
                      }}
                    >
                      Tải lại để đối chiếu
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button variant="secondary" size="md" disabled={busy} onClick={resetDialog}>
                Hủy
              </Button>
              <Button
                type="submit"
                variant={dialog === "toggle" && department.is_active ? "danger" : "primary"}
                size="md"
                loading={busy}
                disabled={busy}
              >
                {pendingIntent?.uncertain ? "Thử gửi lại cùng yêu cầu" : "Xác nhận"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </Card>
  );
}

function DepartmentHeadManagementSection({
  detail,
  parentReloadToken,
  onMutated,
  onSessionLost,
}: {
  detail: DepartmentDetailProjection;
  parentReloadToken: number;
  onMutated: () => void;
  onSessionLost: (message: string) => void;
}) {
  const notify = useNotify();
  const department = detail.department;
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<SubListLoadState<DepartmentHeadsListProjection>>({
    kind: "loading",
  });

  const [dialog, setDialog] = useState<"designate" | "end" | null>(null);
  const [candidatesState, setCandidatesState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; items: readonly PersonDeptMembershipProjection[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [selectedPersonId, setSelectedPersonId] = useState<string>("");
  const [reasonInput, setReasonInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<Wp3DialogPendingIntent<unknown> | null>(null);
  const [feedback, setFeedback] = useState<DialogFeedback>(null);

  useEffect(() => {
    const query = buildDepartmentHeadsQuery({
      departmentId: department.department_id,
      includeHistory: true,
      page,
    });
    if (!query) return;

    const controller = new AbortController();
    void (async () => {
      setState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/${encodeURIComponent(department.department_id)}/head?${query.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          kind: "error",
          message: "Không thể kết nối máy chủ để tải dữ liệu Trưởng phòng.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setState({ kind: "denied", message: failure.message });
          onSessionLost(failure.message);
          return;
        }
        setState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectDepartmentHeadsListEnvelope(payload, department.department_id);
      if (!projected) {
        setState({
          kind: "error",
          message: "Phản hồi danh sách Trưởng phòng không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }
      setState({ kind: "ready", data: projected });
    })();

    return () => controller.abort();
  }, [department.department_id, onSessionLost, page, parentReloadToken, reloadToken]);

  useEffect(() => {
    if (dialog !== "designate") return;
    const query = buildDepartmentPersonMembershipsQuery({
      departmentId: department.department_id,
      status: "active",
      search: "",
      page: 1,
      pageSize: 100,
    });
    if (!query) return;

    const controller = new AbortController();
    void (async () => {
      setCandidatesState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/${encodeURIComponent(department.department_id)}/memberships?${query.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCandidatesState({
          kind: "error",
          message: "Không tải được danh sách thành viên phòng ban.",
        });
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        setDialog(null);
        onSessionLost("Phiên đăng nhập hoặc quyền quản trị không còn hiệu lực.");
        return;
      }
      if (response.status !== 200) {
        setCandidatesState({
          kind: "error",
          message: "Không tải được danh sách thành viên hợp lệ của phòng ban.",
        });
        return;
      }
      const projected = projectDepartmentPersonMembershipsListEnvelope(
        payload,
        department.department_id,
      );
      if (!projected) {
        setCandidatesState({
          kind: "error",
          message: "Phản hồi danh sách thành viên không đúng định dạng.",
        });
        return;
      }
      const eligible = projected.memberships.filter(
        (member) =>
          member.person_status === "ACTIVE" &&
          member.ended_at === null &&
          member.person_id !== department.active_head?.person_id,
      );
      setCandidatesState({ kind: "ready", items: eligible });
    })();

    return () => controller.abort();
  }, [department.active_head?.person_id, department.department_id, dialog, onSessionLost]);

  const reloadHeads = () => setReloadToken((value) => value + 1);

  const resetDialog = () => {
    setPendingIntent(null);
    setFeedback(null);
    setDialog(null);
  };

  const openDesignateDialog = () => {
    setSelectedPersonId("");
    setReasonInput("");
    setPendingIntent(null);
    setFeedback(null);
    setDialog("designate");
  };

  const openEndDialog = () => {
    setReasonInput("");
    setPendingIntent(null);
    setFeedback(null);
    setDialog("end");
  };

  const executeHeadIntent = async (intent: Wp3DialogPendingIntent<unknown>) => {
    setBusy(true);
    setFeedback(null);
    try {
      let response: Response;
      try {
        response = await fetch(intent.url, {
          method: intent.method,
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": intent.idempotencyKey,
          },
          body: JSON.stringify(intent.body),
        });
      } catch {
        setPendingIntent({ ...intent, uncertain: true });
        setFeedback({
          tone: "warning",
          message:
            "Mất kết nối hoặc hết thời gian chờ phản hồi. Nội dung và khóa gửi trùng được giữ nguyên để thử lại hoặc tải lại đối chiếu.",
          needsReload: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      const outcome = resolveWp3DepartmentMutationResult(
        response.status,
        payload,
        intent.projector,
        false,
      );
      if (outcome.ok) {
        notify.success({ title: intent.successMessage });
        resetDialog();
        reloadHeads();
        onMutated();
        return;
      }
      const { failure } = outcome;
      if (failure.kind === "session-lost") {
        resetDialog();
        onSessionLost(failure.message);
        return;
      }
      if (failure.kind === "uncertain" && failure.preserveIdempotencyKey) {
        setPendingIntent({ ...intent, uncertain: true });
        setFeedback({
          tone: "warning",
          message: failure.message,
          needsReload: true,
        });
        return;
      }
      setPendingIntent(null);
      setFeedback({
        tone: failure.kind === "conflict" ? "warning" : "error",
        message: failure.message,
        needsReload: failure.needsReload,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleHeadSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dialog || busy) return;
    if (pendingIntent?.uncertain) {
      void executeHeadIntent(pendingIntent);
      return;
    }

    const idempotencyKey = pendingIntent?.idempotencyKey ?? newDepartmentIdempotencyKey();
    const activeHead =
      state.kind === "ready" ? state.data.active_head : department.active_head;

    if (dialog === "designate") {
      const built = buildDesignateDepartmentHeadRequest({
        personId: selectedPersonId,
        expectedDepartmentVersion: department.version,
        expectedCurrentHeadAssignmentId: activeHead?.head_assignment_id ?? null,
        reason: reasonInput,
        idempotencyKey,
      });
      if (!built.ok) {
        setFeedback({ tone: "error", message: built.message, needsReload: false });
        return;
      }
      const intent: Wp3DialogPendingIntent<unknown> = {
        url: `/api/admin/departments/${encodeURIComponent(department.department_id)}/head`,
        method: "POST",
        idempotencyKey: built.idempotencyKey,
        body: built.body,
        expectCreated: false,
        projector: projectDesignateDepartmentHeadEnvelope,
        successMessage: activeHead
          ? "Đã thay đổi Trưởng phòng (hiệu lực ngay)."
          : "Đã bổ nhiệm Trưởng phòng (hiệu lực ngay).",
        uncertain: false,
      };
      setPendingIntent(intent);
      void executeHeadIntent(intent);
      return;
    }

    if (!activeHead) {
      setFeedback({
        tone: "warning",
        message: "Hiện không có Trưởng phòng đang hiệu lực để kết thúc. Vui lòng tải lại.",
        needsReload: true,
      });
      return;
    }
    const built = buildEndDepartmentHeadRequest({
      expectedDepartmentVersion: department.version,
      expectedCurrentHeadAssignmentId: activeHead.head_assignment_id,
      reason: reasonInput,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", message: built.message, needsReload: false });
      return;
    }
    const intent: Wp3DialogPendingIntent<unknown> = {
      url: `/api/admin/departments/${encodeURIComponent(department.department_id)}/head/end`,
      method: "POST",
      idempotencyKey: built.idempotencyKey,
      body: built.body,
      expectCreated: false,
      projector: projectEndDepartmentHeadEnvelope,
      successMessage: "Đã kết thúc chức danh Trưởng phòng hiện tại.",
      uncertain: false,
    };
    setPendingIntent(intent);
    void executeHeadIntent(intent);
  };

  const activeHead = state.kind === "ready" ? state.data.active_head : department.active_head;
  const fieldsLocked = busy || pendingIntent?.uncertain === true;
  const historyPageCount =
    state.kind === "ready"
      ? Math.min(1000, Math.max(1, Math.ceil(state.data.total / Math.max(1, state.data.page_size))))
      : 1;

  return (
    <Card data-testid="department-head-section">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardHeader
            title="Trưởng phòng (HEAD) & Lịch sử chức danh"
            description="Trưởng phòng phải là nhân sự đang hoạt động (ACTIVE) thuộc chính phòng ban này. Mọi bổ nhiệm, thay thế hoặc kết thúc có hiệu lực ngay."
          />
          <div className="flex flex-wrap gap-2">
            {department.is_active ? (
              <Button variant="primary" size="sm" onClick={openDesignateDialog}>
                {activeHead ? "Thay Trưởng phòng" : "Bổ nhiệm Trưởng phòng"}
              </Button>
            ) : null}
            {activeHead ? (
              <Button variant="secondary" size="sm" onClick={openEndDialog}>
                Kết thúc chức danh Trưởng phòng
              </Button>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface-muted/40 p-4 text-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            Trưởng phòng hiện hành
          </div>
          {activeHead ? (
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <div>
                <Link
                  href={`/admin/organization/persons/${encodeURIComponent(activeHead.person_id)}`}
                  className="font-semibold text-primary hover:underline"
                >
                  {activeHead.full_name}
                </Link>{" "}
                <span className="font-mono text-xs text-muted">({activeHead.employee_code})</span>
              </div>
              <div className="font-mono text-xs text-muted">
                Bắt đầu: {activeHead.started_at.slice(0, 10)}
              </div>
            </div>
          ) : (
            <p className="mt-1 text-sm text-muted">
              Phòng ban hiện chưa có Trưởng phòng hiệu lực.
            </p>
          )}
        </div>

        {state.kind === "loading" ? (
          <p role="status" className="py-4 text-center text-sm text-muted">
            Đang tải lịch sử Trưởng phòng…
          </p>
        ) : state.kind === "error" ? (
          <div className="space-y-2">
            <ErrorState title="Không tải được lịch sử Trưởng phòng" detail={state.message} />
            {state.retryable ? (
              <Button variant="secondary" size="sm" onClick={reloadHeads}>
                Thử tải lại
              </Button>
            ) : null}
          </div>
        ) : state.kind === "ready" && state.data.history.length > 0 ? (
          <DataTableContainer
            dataTestId="department-heads-history-table"
            footer={
              <OffsetPager
                page={state.data.page}
                pageCount={historyPageCount}
                total={state.data.total}
                previousDisabled={state.data.page <= 1}
                nextDisabled={!state.data.has_more && state.data.page >= historyPageCount}
                onPageChange={(nextPage) => setPage(nextPage)}
                className="mt-0 border-t-0 pt-0"
              />
            }
          >
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Nhân sự
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Trạng thái
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Bắt đầu
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Kết thúc
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {state.data.history.map((item) => (
                  <tr key={item.head_assignment_id} className={DATA_TABLE_ROW_CLASS}>
                    <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                      <Link
                        href={`/admin/organization/persons/${encodeURIComponent(item.person_id)}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {item.full_name}
                      </Link>
                      <div className="font-mono text-xs text-muted">{item.employee_code}</div>
                    </td>
                    <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                      <StatusBadge tone={item.ended_at === null ? "success" : "neutral"} dot>
                        {item.ended_at === null ? "Đương nhiệm" : "Đã kết thúc"}
                      </StatusBadge>
                    </td>
                    <td data-label="Bắt đầu" className={`${DATA_TABLE_TD_CLASS} font-mono text-xs`}>
                      {item.started_at.slice(0, 10)}
                    </td>
                    <td data-label="Kết thúc" className={`${DATA_TABLE_TD_CLASS} font-mono text-xs`}>
                      {item.ended_at ? item.ended_at.slice(0, 10) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTableContainer>
        ) : state.kind === "ready" ? (
          <p className="text-xs text-muted">Chưa có lịch sử bổ nhiệm Trưởng phòng.</p>
        ) : null}
      </div>

      <FormDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) resetDialog();
        }}
        title={
          dialog === "designate"
            ? activeHead
              ? "Xác nhận thay Trưởng phòng"
              : "Bổ nhiệm Trưởng phòng"
            : "Xác nhận kết thúc chức danh Trưởng phòng"
        }
        description="Thao tác áp dụng ngay lập tức; không đặt lịch tương lai."
        descriptionId="department-head-dialog-desc"
        closeDisabled={busy}
        dataTestId="department-head-dialog"
      >
        {dialog ? (
          <form className="space-y-4" onSubmit={handleHeadSubmit}>
            {dialog === "designate" ? (
              <>
                {activeHead ? (
                  <Alert tone="warning" title="Thay thế Trưởng phòng hiện hành">
                    Trưởng phòng hiện tại{" "}
                    <strong>
                      {activeHead.full_name} ({activeHead.employee_code})
                    </strong>{" "}
                    sẽ được kết thúc chức danh ngay khi bổ nhiệm người mới.
                  </Alert>
                ) : null}
                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">
                    Chọn thành viên ACTIVE thuộc phòng ban {department.name}
                  </div>
                  {candidatesState.kind === "loading" ? (
                    <p role="status" className="text-xs text-muted">
                      Đang tải thành viên hợp lệ…
                    </p>
                  ) : candidatesState.kind === "error" ? (
                    <Alert tone="error" role="alert" title="Lỗi tải danh sách">
                      {candidatesState.message}
                    </Alert>
                  ) : candidatesState.kind === "ready" && candidatesState.items.length === 0 ? (
                    <Alert tone="info" title="Chưa có thành viên đủ điều kiện">
                      Trưởng phòng phải là nhân sự đang hoạt động (ACTIVE) thuộc chính phòng ban này. Hãy thêm nhân sự vào phòng trước khi bổ nhiệm.
                    </Alert>
                  ) : candidatesState.kind === "ready" ? (
                    <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-border p-2">
                      {candidatesState.items.map((member) => {
                        const selected = selectedPersonId === member.person_id;
                        return (
                          <label
                            key={member.membership_id}
                            className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${
                              selected
                                ? "border-primary bg-primary/10"
                                : "border-border/70 bg-surface hover:border-primary/40"
                            }`}
                          >
                            <span className="flex items-center gap-2">
                              <input
                                type="radio"
                                name="department-head-candidate"
                                checked={selected}
                                disabled={fieldsLocked}
                                onChange={() => {
                                  setPendingIntent(null);
                                  setSelectedPersonId(member.person_id);
                                }}
                              />
                              <span>
                                <span className="font-medium text-foreground">{member.full_name}</span>{" "}
                                <span className="font-mono text-xs text-muted">
                                  ({member.employee_code})
                                </span>
                              </span>
                            </span>
                            <StatusBadge tone="success">ACTIVE</StatusBadge>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </>
            ) : activeHead ? (
              <Alert tone="warning" title="Kết thúc chức danh Trưởng phòng hiện tại">
                Xác nhận kết thúc ngay chức danh Trưởng phòng của{" "}
                <strong>
                  {activeHead.full_name} ({activeHead.employee_code})
                </strong>
                . Nhân sự vẫn là thành viên phòng ban cho đến khi được chuyển hoặc kết thúc thành viên.
              </Alert>
            ) : null}

            <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
              Lý do thao tác (bắt buộc)
              <textarea
                required
                rows={3}
                value={reasonInput}
                disabled={fieldsLocked}
                maxLength={DEPARTMENT_WP3_MAX_REASON_LENGTH}
                placeholder="Nhập lý do bổ nhiệm, thay thế hoặc kết thúc Trưởng phòng…"
                onChange={(event) => {
                  setPendingIntent(null);
                  setReasonInput(event.target.value);
                }}
                className={TEXTAREA_CLASS}
              />
            </label>

            {feedback ? (
              <Alert
                tone={feedback.tone}
                role="alert"
                title={feedback.tone === "warning" ? "Cần xác nhận hoặc tải lại" : "Không thể thực hiện"}
              >
                <p>{feedback.message}</p>
                {feedback.needsReload ? (
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        resetDialog();
                        reloadHeads();
                        onMutated();
                      }}
                    >
                      Tải lại để đối chiếu
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button variant="secondary" size="md" disabled={busy} onClick={resetDialog}>
                Hủy
              </Button>
              <Button
                type="submit"
                variant={dialog === "end" ? "danger" : "primary"}
                size="md"
                loading={busy}
                disabled={busy || (dialog === "designate" && !selectedPersonId && !pendingIntent?.uncertain)}
              >
                {pendingIntent?.uncertain
                  ? "Thử gửi lại cùng yêu cầu"
                  : dialog === "end"
                    ? "Xác nhận kết thúc chức danh"
                    : activeHead
                      ? "Xác nhận thay Trưởng phòng"
                      : "Xác nhận bổ nhiệm"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </Card>
  );
}

function DepartmentPersonMembershipsSection({
  detail,
  parentReloadToken,
  onMutated,
  onSessionLost,
}: {
  detail: DepartmentDetailProjection;
  parentReloadToken: number;
  onMutated: () => void;
  onSessionLost: (message: string) => void;
}) {
  const notify = useNotify();
  const department = detail.department;

  const [statusFilter, setStatusFilter] = useState<DepartmentPersonMembershipStatusFilter>("active");
  const [searchInput, setSearchInput] = useState("");
  const [searchApplied, setSearchApplied] = useState("");
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<SubListLoadState<DepartmentPersonMembershipsListProjection>>({
    kind: "loading",
  });

  const [dialog, setDialog] = useState<
    | { kind: "add" }
    | { kind: "transfer"; membership: PersonDeptMembershipProjection }
    | { kind: "end"; membership: PersonDeptMembershipProjection }
    | null
  >(null);
  const [selectedPerson, setSelectedPerson] = useState<PersonSummaryProjection | null>(null);
  const [selectedTargetDept, setSelectedTargetDept] = useState<SelectedDepartmentOption | null>(null);
  const [reasonInput, setReasonInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<Wp3DialogPendingIntent<unknown> | null>(null);
  const [feedback, setFeedback] = useState<DialogFeedback>(null);

  useEffect(() => {
    const query = buildDepartmentPersonMembershipsQuery({
      departmentId: department.department_id,
      status: statusFilter,
      search: searchApplied,
      page,
    });
    if (!query) return;

    const controller = new AbortController();
    void (async () => {
      setState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/${encodeURIComponent(department.department_id)}/memberships?${query.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          kind: "error",
          message: "Không thể kết nối máy chủ để tải danh sách thành viên phòng ban.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setState({ kind: "denied", message: failure.message });
          onSessionLost(failure.message);
          return;
        }
        setState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectDepartmentPersonMembershipsListEnvelope(
        payload,
        department.department_id,
      );
      if (!projected) {
        setState({
          kind: "error",
          message: "Phản hồi danh sách thành viên phòng ban không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }
      setState({ kind: "ready", data: projected });
    })();

    return () => controller.abort();
  }, [department.department_id, onSessionLost, page, parentReloadToken, reloadToken, searchApplied, statusFilter]);

  const reloadMemberships = () => setReloadToken((value) => value + 1);

  const resetDialog = () => {
    setPendingIntent(null);
    setFeedback(null);
    setDialog(null);
  };

  const openAddDialog = () => {
    setSelectedPerson(null);
    setReasonInput("");
    setPendingIntent(null);
    setFeedback(null);
    setDialog({ kind: "add" });
  };

  const openTransferDialog = (membership: PersonDeptMembershipProjection) => {
    setSelectedTargetDept(null);
    setReasonInput("");
    setPendingIntent(null);
    setFeedback(null);
    setDialog({ kind: "transfer", membership });
  };

  const openEndDialog = (membership: PersonDeptMembershipProjection) => {
    setReasonInput("");
    setPendingIntent(null);
    setFeedback(null);
    setDialog({ kind: "end", membership });
  };

  const executeIntent = async (
    intent: Wp3DialogPendingIntent<unknown>,
    usePersonClassifier = false,
  ) => {
    setBusy(true);
    setFeedback(null);
    try {
      let response: Response;
      try {
        response = await fetch(intent.url, {
          method: intent.method,
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": intent.idempotencyKey,
          },
          body: JSON.stringify(intent.body),
        });
      } catch {
        setPendingIntent({ ...intent, uncertain: true });
        setFeedback({
          tone: "warning",
          message:
            "Mất kết nối hoặc hết thời gian chờ phản hồi. Dữ liệu và khóa gửi trùng được giữ nguyên để thử lại hoặc tải lại đối chiếu.",
          needsReload: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (usePersonClassifier) {
        const outcome = classifyPersonOrgMutationResponse(
          response.status,
          payload,
          "transfer-department",
        );
        if (outcome.kind === "applied") {
          notify.success({ title: intent.successMessage });
          resetDialog();
          reloadMemberships();
          onMutated();
          return;
        }
        if (outcome.kind === "session-lost") {
          resetDialog();
          onSessionLost(outcome.message);
          return;
        }
        if (outcome.kind === "uncertain" && outcome.preserveIdempotencyKey) {
          setPendingIntent({ ...intent, uncertain: true });
          setFeedback({
            tone: "warning",
            message: outcome.message,
            needsReload: true,
          });
          return;
        }
        setPendingIntent(null);
        setFeedback({
          tone: outcome.kind === "conflict" || outcome.kind === "active-head-block" ? "warning" : "error",
          message: outcome.message,
          needsReload: outcome.kind === "conflict" || outcome.kind === "not-found",
        });
        return;
      }

      const outcome = resolveWp3DepartmentMutationResult(
        response.status,
        payload,
        intent.projector,
        intent.expectCreated,
      );
      if (outcome.ok) {
        notify.success({ title: intent.successMessage });
        resetDialog();
        reloadMemberships();
        onMutated();
        return;
      }
      const { failure } = outcome;
      if (failure.kind === "session-lost") {
        resetDialog();
        onSessionLost(failure.message);
        return;
      }
      if (failure.kind === "uncertain" && failure.preserveIdempotencyKey) {
        setPendingIntent({ ...intent, uncertain: true });
        setFeedback({
          tone: "warning",
          message: failure.message,
          needsReload: true,
        });
        return;
      }
      setPendingIntent(null);
      setFeedback({
        tone: failure.kind === "conflict" || failure.kind === "active-head" ? "warning" : "error",
        message: failure.message,
        needsReload: failure.needsReload,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dialog || busy) return;

    if (pendingIntent?.uncertain) {
      const usePerson =
        dialog.kind === "transfer" ||
        (dialog.kind === "add" &&
          selectedPerson?.active_department !== null &&
          selectedPerson?.active_department?.department_id !== department.department_id);
      void executeIntent(pendingIntent, usePerson);
      return;
    }

    const idempotencyKey = pendingIntent?.idempotencyKey ?? newDepartmentIdempotencyKey();

    if (dialog.kind === "add") {
      if (!selectedPerson) {
        setFeedback({ tone: "error", message: "Vui lòng chọn nhân sự nội bộ.", needsReload: false });
        return;
      }
      if (selectedPerson.active_department?.department_id === department.department_id) {
        setFeedback({
          tone: "warning",
          message: "Nhân sự này hiện đã thuộc phòng ban này.",
          needsReload: false,
        });
        return;
      }

      if (selectedPerson.active_department) {
        const built = buildTransferPersonDepartmentRequest({
          targetDepartmentRef: department.department_id,
          expectedPersonVersion: selectedPerson.version,
          expectedCurrentMembershipId: selectedPerson.active_department.membership_id,
          reason: reasonInput,
          idempotencyKey,
        });
        if (!built.ok) {
          setFeedback({ tone: "error", message: built.message, needsReload: false });
          return;
        }
        const intent: Wp3DialogPendingIntent<unknown> = {
          url: `/api/admin/organization/persons/${encodeURIComponent(selectedPerson.person_id)}/transfer-department`,
          method: "POST",
          idempotencyKey: built.idempotencyKey,
          body: built.body,
          expectCreated: false,
          projector: projectDepartmentPersonMemberMutationEnvelope,
          successMessage: `Đã chuyển ${selectedPerson.full_name} sang phòng ban ${department.name}.`,
          uncertain: false,
        };
        setPendingIntent(intent);
        void executeIntent(intent, true);
        return;
      }

      const built = buildAssignDepartmentPersonMemberRequest({
        personId: selectedPerson.person_id,
        expectedPersonVersion: selectedPerson.version,
        reason: reasonInput,
        idempotencyKey,
      });
      if (!built.ok) {
        setFeedback({ tone: "error", message: built.message, needsReload: false });
        return;
      }
      const intent: Wp3DialogPendingIntent<unknown> = {
        url: `/api/admin/departments/${encodeURIComponent(department.department_id)}/memberships`,
        method: "POST",
        idempotencyKey: built.idempotencyKey,
        body: built.body,
        expectCreated: true,
        projector: projectDepartmentPersonMemberMutationEnvelope,
        successMessage: `Đã thêm ${selectedPerson.full_name} vào phòng ban ${department.name}.`,
        uncertain: false,
      };
      setPendingIntent(intent);
      void executeIntent(intent, false);
      return;
    }

    if (dialog.kind === "transfer") {
      if (!selectedTargetDept) {
        setFeedback({ tone: "error", message: "Vui lòng chọn phòng ban đích.", needsReload: false });
        return;
      }
      const built = buildTransferPersonDepartmentRequest({
        targetDepartmentRef: selectedTargetDept.department_id,
        expectedPersonVersion: dialog.membership.person_version,
        expectedCurrentMembershipId: dialog.membership.membership_id,
        reason: reasonInput,
        idempotencyKey,
      });
      if (!built.ok) {
        setFeedback({ tone: "error", message: built.message, needsReload: false });
        return;
      }
      const intent: Wp3DialogPendingIntent<unknown> = {
        url: `/api/admin/organization/persons/${encodeURIComponent(dialog.membership.person_id)}/transfer-department`,
        method: "POST",
        idempotencyKey: built.idempotencyKey,
        body: built.body,
        expectCreated: false,
        projector: projectDepartmentPersonMemberMutationEnvelope,
        successMessage: `Đã chuyển ${dialog.membership.full_name} sang phòng ban ${selectedTargetDept.name}.`,
        uncertain: false,
      };
      setPendingIntent(intent);
      void executeIntent(intent, true);
      return;
    }

    const built = buildEndDepartmentPersonMemberRequest({
      expectedPersonVersion: dialog.membership.person_version,
      reason: reasonInput,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", message: built.message, needsReload: false });
      return;
    }
    const intent: Wp3DialogPendingIntent<unknown> = {
      url: `/api/admin/departments/${encodeURIComponent(department.department_id)}/memberships/${encodeURIComponent(dialog.membership.membership_id)}/end`,
      method: "POST",
      idempotencyKey: built.idempotencyKey,
      body: built.body,
      expectCreated: false,
      projector: projectDepartmentPersonMemberMutationEnvelope,
      successMessage: `Đã kết thúc thành viên ${dialog.membership.full_name} khỏi phòng ban.`,
      uncertain: false,
    };
    setPendingIntent(intent);
    void executeIntent(intent, false);
  };

  const fieldsLocked = busy || pendingIntent?.uncertain === true;
  const pageCount =
    state.kind === "ready"
      ? Math.min(1000, Math.max(1, Math.ceil(state.data.total / Math.max(1, state.data.page_size))))
      : 1;

  return (
    <Card data-testid="department-person-memberships-section">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardHeader
            title="Thành viên Nhân sự nội bộ"
            description="Quản lý danh sách Nhân sự nội bộ trực thuộc phòng ban. Mỗi nhân sự ACTIVE chỉ thuộc tối đa một phòng ban tại một thời điểm."
          />
          {department.is_active ? (
            <Button variant="primary" size="md" onClick={openAddDialog}>
              Thêm hoặc chuyển thành viên
            </Button>
          ) : null}
        </div>

        <FilterToolbar>
          <form
            className="flex flex-1 flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setSearchApplied(sanitizeDepartmentSearchInput(searchInput));
              setPage(1);
            }}
          >
            <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs font-medium text-muted">
              Tìm theo họ tên hoặc mã nhân sự
              <input
                value={searchInput}
                maxLength={DEPARTMENT_UI_MAX_SEARCH_LENGTH}
                placeholder="Nhập họ tên hoặc mã nhân sự…"
                onChange={(event) => setSearchInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
            <label className="flex w-44 flex-col gap-1 text-xs font-medium text-muted">
              Trạng thái thành viên
              <select
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value as DepartmentPersonMembershipStatusFilter);
                  setPage(1);
                }}
                className={INPUT_CLASS}
              >
                <option value="active">Đang hiệu lực</option>
                <option value="ended">Đã kết thúc</option>
                <option value="all">Tất cả</option>
              </select>
            </label>
            <Button type="submit" variant="secondary" size="md">
              Tìm kiếm
            </Button>
          </form>
        </FilterToolbar>

        {state.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted">
            Đang tải thành viên phòng ban…
          </p>
        ) : state.kind === "error" ? (
          <div className="space-y-2">
            <ErrorState title="Không tải được thành viên phòng ban" detail={state.message} />
            {state.retryable ? (
              <Button variant="secondary" size="sm" onClick={reloadMemberships}>
                Thử tải lại
              </Button>
            ) : null}
          </div>
        ) : state.kind === "ready" && state.data.memberships.length === 0 ? (
          <EmptyState
            title="Chưa có thành viên phù hợp"
            description="Thử đổi bộ lọc trạng thái hoặc thêm nhân sự nội bộ vào phòng ban."
          />
        ) : state.kind === "ready" ? (
          <DataTableContainer
            dataTestId="department-person-memberships-table"
            footer={
              <OffsetPager
                page={state.data.page}
                pageCount={pageCount}
                total={state.data.total}
                previousDisabled={state.data.page <= 1}
                nextDisabled={!state.data.has_more && state.data.page >= pageCount}
                onPageChange={(nextPage) => setPage(nextPage)}
                className="mt-0 border-t-0 pt-0"
              />
            }
          >
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Nhân sự nội bộ
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Vai trò &amp; trạng thái
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Hiệu lực phòng ban
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {state.data.memberships.map((member) => {
                  const isActiveRow = member.ended_at === null;
                  return (
                    <tr key={member.membership_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                        <Link
                          href={`/admin/organization/persons/${encodeURIComponent(member.person_id)}`}
                          className="font-semibold text-primary hover:underline"
                        >
                          {member.full_name}
                        </Link>
                        <div className="font-mono text-xs text-muted">{member.employee_code}</div>
                      </td>
                      <td data-label="Vai trò & trạng thái" className={DATA_TABLE_TD_CLASS}>
                        <div className="flex flex-wrap gap-1.5">
                          <StatusBadge
                            tone={member.person_status === "ACTIVE" ? "success" : "neutral"}
                            dot
                          >
                            {member.person_status}
                          </StatusBadge>
                          {member.is_department_head ? (
                            <StatusBadge tone="primary">Trưởng phòng</StatusBadge>
                          ) : null}
                          <StatusBadge tone={isActiveRow ? "info" : "neutral"}>
                            {isActiveRow ? "Đang thuộc phòng" : "Đã kết thúc"}
                          </StatusBadge>
                        </div>
                      </td>
                      <td data-label="Hiệu lực phòng ban" className={`${DATA_TABLE_TD_CLASS} font-mono text-xs`}>
                        <div>Bắt đầu: {member.started_at.slice(0, 10)}</div>
                        <div>Kết thúc: {member.ended_at ? member.ended_at.slice(0, 10) : "—"}</div>
                      </td>
                      <td data-card-actions="true" className={`${DATA_TABLE_TD_CLASS} text-right`}>
                        <RowActionCluster>
                          <Link
                            href={`/admin/organization/persons/${encodeURIComponent(member.person_id)}`}
                            className={buttonClasses({ variant: "secondary", size: "sm" })}
                          >
                            Hồ sơ
                          </Link>
                          {isActiveRow && member.person_status === "ACTIVE" ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => openTransferDialog(member)}
                            >
                              Chuyển phòng
                            </Button>
                          ) : null}
                          {isActiveRow ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => openEndDialog(member)}
                            >
                              Kết thúc thành viên
                            </Button>
                          ) : null}
                        </RowActionCluster>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        ) : null}
      </div>

      <FormDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) resetDialog();
        }}
        title={
          dialog?.kind === "add"
            ? `Thêm hoặc chuyển thành viên vào ${department.name}`
            : dialog?.kind === "transfer"
              ? `Chuyển phòng ban cho ${dialog.membership.full_name}`
              : dialog?.kind === "end"
                ? `Kết thúc thành viên ${dialog.membership.full_name}`
                : "Thành viên phòng ban"
        }
        description="Thao tác áp dụng ngay lập tức; không có trường đặt lịch hiệu lực."
        descriptionId="department-person-member-dialog-desc"
        closeDisabled={busy}
        dataTestId="department-person-member-dialog"
      >
        {dialog ? (
          <form className="space-y-4" onSubmit={handleSubmit}>
            {dialog.kind === "add" ? (
              <div className="space-y-3">
                <PersonSearchPicker
                  id="dept-add-member-picker"
                  label="Tìm và chọn nhân sự nội bộ (ACTIVE)"
                  selectedPersonId={selectedPerson?.person_id ?? null}
                  onSelect={(person) => {
                    setPendingIntent(null);
                    setSelectedPerson(person);
                  }}
                  disabled={fieldsLocked}
                  onSessionLost={(message) => {
                    resetDialog();
                    onSessionLost(message);
                  }}
                />
                {selectedPerson?.active_department ? (
                  selectedPerson.active_department.department_id === department.department_id ? (
                    <Alert tone="warning" title="Đã thuộc phòng ban này">
                      Nhân sự này hiện đã là thành viên đang hiệu lực của {department.name}.
                    </Alert>
                  ) : (
                    <Alert tone="info" title="Sẽ chuyển từ phòng ban hiện tại">
                      {selectedPerson.full_name} đang thuộc{" "}
                      <strong>{selectedPerson.active_department.name}</strong>. Xác nhận
                      sẽ kết thúc phòng cũ và chuyển ngay sang {department.name}.
                    </Alert>
                  )
                ) : null}
              </div>
            ) : null}

            {dialog.kind === "transfer" ? (
              <div className="space-y-3">
                {dialog.membership.is_department_head ? (
                  <Alert tone="warning" title="Nhân sự đang là Trưởng phòng">
                    {dialog.membership.full_name} đang giữ chức danh Trưởng phòng tại{" "}
                    {department.name}. Theo quy tắc nghiệp vụ (PERSON_IS_ACTIVE_DEPARTMENT_HEAD),
                    phải kết thúc hoặc thay Trưởng phòng trước khi chuyển sang phòng ban khác.
                  </Alert>
                ) : null}
                <DepartmentSelectPicker
                  id="dept-transfer-target-picker"
                  label="Chọn phòng ban đích đang hoạt động"
                  selectedId={selectedTargetDept?.department_id ?? null}
                  excludeDepartmentId={department.department_id}
                  allowClear={false}
                  emptyLabel="Không có phòng ban đích phù hợp"
                  disabled={fieldsLocked}
                  onSelect={(dept) => {
                    setPendingIntent(null);
                    setSelectedTargetDept(dept);
                  }}
                  onSessionLost={(message) => {
                    resetDialog();
                    onSessionLost(message);
                  }}
                />
              </div>
            ) : null}

            {dialog.kind === "end" ? (
              <Alert tone="warning" title={dialog.membership.full_name}>
                {dialog.membership.is_department_head
                  ? "Lưu ý: Nhân sự này đang giữ chức danh Trưởng phòng. Cần kết thúc hoặc thay chức danh Trưởng phòng trước khi kết thúc thành viên khỏi phòng ban."
                  : `Xác nhận kết thúc tư cách thành viên của ${dialog.membership.full_name} (${dialog.membership.employee_code}) tại ${department.name} ngay lập tức.`}
              </Alert>
            ) : null}

            <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
              Lý do thao tác (bắt buộc)
              <textarea
                required
                rows={3}
                value={reasonInput}
                disabled={fieldsLocked}
                maxLength={DEPARTMENT_WP3_MAX_REASON_LENGTH}
                placeholder="Nhập lý do điều chuyển hoặc cập nhật thành viên…"
                onChange={(event) => {
                  setPendingIntent(null);
                  setReasonInput(event.target.value);
                }}
                className={TEXTAREA_CLASS}
              />
            </label>

            {feedback ? (
              <Alert
                tone={feedback.tone}
                role="alert"
                title={feedback.tone === "warning" ? "Cần lưu ý hoặc tải lại" : "Không thể lưu thay đổi"}
              >
                <p>{feedback.message}</p>
                {feedback.needsReload ? (
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        resetDialog();
                        reloadMemberships();
                        onMutated();
                      }}
                    >
                      Tải lại để đối chiếu
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button variant="secondary" size="md" disabled={busy} onClick={resetDialog}>
                Hủy
              </Button>
              <Button
                type="submit"
                variant={dialog.kind === "end" ? "danger" : "primary"}
                size="md"
                loading={busy}
                disabled={
                  busy ||
                  (dialog.kind === "add" &&
                    (!selectedPerson ||
                      selectedPerson.active_department?.department_id === department.department_id) &&
                    !pendingIntent?.uncertain) ||
                  (dialog.kind === "transfer" && !selectedTargetDept && !pendingIntent?.uncertain)
                }
              >
                {pendingIntent?.uncertain
                  ? "Thử gửi lại cùng yêu cầu"
                  : dialog.kind === "add"
                    ? selectedPerson?.active_department
                      ? "Xác nhận chuyển vào phòng"
                      : "Xác nhận thêm thành viên"
                    : dialog.kind === "transfer"
                      ? "Xác nhận chuyển phòng"
                      : "Xác nhận kết thúc thành viên"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </Card>
  );
}

function RecruitmentDepartmentReadOnlySection({
  detail,
  parentReloadToken,
  onReloadDetail,
}: {
  detail: DepartmentDetailProjection;
  parentReloadToken: number;
  onReloadDetail: () => void;
}) {
  const department = detail.department;
  const [searchInput, setSearchInput] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [includeInactive, setIncludeInactive] = useState(true);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [teamsState, setTeamsState] = useState<SubListLoadState<RecruitmentTeamListProjection>>({
    kind: "loading",
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchFilter(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const query = buildRecruitmentTeamsQuery({
        search: searchFilter,
        includeInactive,
        page,
      });
      if (!query) {
        setTeamsState({
          kind: "error",
          message: "Bộ lọc tìm kiếm nhóm không hợp lệ.",
          retryable: true,
        });
        return;
      }

      setTeamsState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/recruitment/teams?${query.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setTeamsState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải danh sách Nhóm.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setTeamsState({ kind: "denied", message: failure.message });
          return;
        }
        setTeamsState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectRecruitmentTeamsEnvelope(
        payload,
        { search: searchFilter, includeInactive, page },
        department.department_id,
      );
      if (!projected) {
        setTeamsState({
          kind: "error",
          message: "Phản hồi danh sách Nhóm không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setTeamsState({ kind: "ready", data: projected });
    })();

    return () => controller.abort();
  }, [
    department.department_id,
    includeInactive,
    page,
    parentReloadToken,
    reloadToken,
    searchFilter,
  ]);

  const reloadTeams = () => {
    setTeamsState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const teams =
    teamsState.kind === "ready" ? visibleRecruitmentTeams(teamsState.data.teams) : [];
  const pageCount =
    teamsState.kind === "ready"
      ? Math.max(1, Math.ceil(teamsState.data.total / Math.max(1, teamsState.data.page_size)))
      : 1;

  return (
    <div className="space-y-4" data-testid="recruitment-department-readonly-panel">
      <PageHeader
        eyebrow="Chi tiết Phòng ban"
        title={department.name}
        badge={
          <StatusBadge tone={department.is_active ? "success" : "neutral"} dot>
            {department.is_active ? "Đang hoạt động" : "Ngừng hoạt động"}
          </StatusBadge>
        }
        description={`Mã hệ thống: ${department.code} · Ngày hiệu lực: ${detail.authorization_date} · ${departmentScaleSummary(department)}`}
        actions={
          <Button variant="secondary" size="md" onClick={onReloadDetail}>
            Làm mới
          </Button>
        }
      />

      <Alert tone="info" role="status" title="Chế độ chỉ đọc — Vỏ Phòng Tuyển dụng">
        <p>{RECRUITMENT_DEFAULT_POLICY_DESCRIPTION}</p>
        <p>
          Phòng Tuyển dụng không hỗ trợ gán thành viên trực tiếp và không cho phép chỉnh sửa
          Nhóm, Team Leader, thành viên tuyển dụng hoặc phạm vi Dự án ↔ Nhóm tại đây.
        </p>
      </Alert>

      <Card>
        <CardHeader
          title="Danh sách Nhóm trực thuộc (chỉ đọc)"
          description={
            teamsState.kind === "ready"
              ? `${teamsState.data.total} nhóm kinh doanh được chiếu từ danh mục hiện hành`
              : "Tra cứu danh sách Nhóm hiện hữu thuộc nghiệp vụ tuyển dụng."
          }
        />

        <FilterToolbar
          className="mb-4"
          actions={
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Bộ lọc trạng thái nhóm">
              <Button
                variant={includeInactive ? "soft" : "secondary"}
                size="md"
                aria-pressed={includeInactive}
                onClick={() => {
                  setIncludeInactive(true);
                  setPage(1);
                }}
              >
                Tất cả nhóm
              </Button>
              <Button
                variant={!includeInactive ? "soft" : "secondary"}
                size="md"
                aria-pressed={!includeInactive}
                onClick={() => {
                  setIncludeInactive(false);
                  setPage(1);
                }}
              >
                Chỉ nhóm đang hoạt động
              </Button>
            </div>
          }
        >
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              setSearchFilter(searchInput);
              setPage(1);
              reloadTeams();
            }}
          >
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-foreground">
              Tìm theo mã hoặc tên nhóm
              <input
                type="search"
                value={searchInput}
                maxLength={DEPARTMENT_UI_MAX_SEARCH_LENGTH}
                placeholder="Nhập mã hoặc tên nhóm…"
                onChange={(event) =>
                  setSearchInput(sanitizeDepartmentSearchInput(event.target.value))
                }
                className={INPUT_CLASS}
              />
            </label>
            <Button type="submit" variant="secondary" size="md">
              Lọc
            </Button>
          </form>
        </FilterToolbar>

        {teamsState.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted">
            Đang tải danh sách Nhóm…
          </p>
        ) : null}

        {teamsState.kind === "denied" ? (
          <Alert tone="error" role="alert" title="Không có quyền truy cập">
            {teamsState.message}
          </Alert>
        ) : null}

        {teamsState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState
              title="Không tải được danh sách Nhóm"
              detail={teamsState.message}
            />
            {teamsState.retryable ? (
              <Button variant="secondary" onClick={reloadTeams}>
                Thử tải lại
              </Button>
            ) : null}
          </div>
        ) : null}

        {teamsState.kind === "ready" && teams.length === 0 ? (
          <EmptyState
            title="Không có nhóm phù hợp"
            description={
              searchFilter.trim()
                ? "Không tìm thấy nhóm nào khớp với từ khóa hiện tại."
                : "Hiện chưa có nhóm nào để hiển thị."
            }
          />
        ) : null}

        {teamsState.kind === "ready" && teams.length > 0 ? (
          <>
            <DataTableContainer dataTestId="recruitment-teams-readonly-table">
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Tên nhóm
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Mã nhóm
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Trạng thái
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {teams.map((team) => (
                    <tr key={team.team_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-card-header="true" className={`${DATA_TABLE_TD_CLASS} font-medium`}>
                        {team.display_name}
                      </td>
                      <td data-label="Mã nhóm" className={`${DATA_TABLE_TD_CLASS} font-mono text-xs sm:text-sm`}>
                        {team.code}
                      </td>
                      <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                        <StatusBadge tone={team.active ? "success" : "neutral"} dot>
                          {team.active ? "Đang hoạt động" : "Ngừng hoạt động"}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTableContainer>

            <OffsetPager
              page={page}
              pageCount={pageCount}
              total={teamsState.data.total}
              ariaLabel="Phân trang danh sách nhóm thuộc Phòng Tuyển dụng"
              nextDisabled={!teamsState.data.has_more}
              onPageChange={(nextPage) => setPage(nextPage)}
            />
          </>
        ) : null}
      </Card>
    </div>
  );
}

function AccountingDepartmentMembershipsSection({
  detail,
  parentReloadToken,
  onReloadDetail,
  onMembershipMutated,
}: {
  detail: DepartmentDetailProjection;
  parentReloadToken: number;
  onReloadDetail: () => void;
  onMembershipMutated: () => void;
}) {
  const notify = useNotify();
  const department = detail.department;
  const canManage = canManageDepartmentMemberships(department);

  const [searchInput, setSearchInput] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [includeHistory, setIncludeHistory] = useState(false);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [membershipsState, setMembershipsState] =
    useState<SubListLoadState<AccountingMembershipListProjection>>({
      kind: "loading",
    });

  const [dialog, setDialog] = useState<AccountingDialogState>(null);
  const [busy, setBusy] = useState(false);
  const [dialogFeedback, setDialogFeedback] = useState<DialogFeedback>(null);

  // Assign dialog state
  const [candidateSearchInput, setCandidateSearchInput] = useState("");
  const [candidateSearchFilter, setCandidateSearchFilter] = useState("");
  const [candidatePage, setCandidatePage] = useState(1);
  const [candidateReloadToken, setCandidateReloadToken] = useState(0);
  const [candidatesState, setCandidatesState] =
    useState<SubListLoadState<AccountingCandidateListProjection>>({
      kind: "loading",
    });
  const [selectedCandidate, setSelectedCandidate] =
    useState<AccountingCandidateProjection | null>(null);
  const [assignReason, setAssignReason] = useState("");

  // End dialog state
  const [endReason, setEndReason] = useState("");

  const pendingIntentRef = useRef<{ signature: string; key: string } | null>(null);

  const openAssignDialog = () => {
    if (!canManage) return;
    pendingIntentRef.current = null;
    setDialogFeedback(null);
    setCandidateSearchInput("");
    setCandidateSearchFilter("");
    setCandidatePage(1);
    setSelectedCandidate(null);
    setAssignReason("");
    setDialog({ kind: "assign" });
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchFilter(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setCandidateSearchFilter(candidateSearchInput);
      setCandidatePage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [candidateSearchInput]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const query = buildAccountingMembershipsQuery({
        search: searchFilter,
        includeHistory,
        page,
      });
      if (!query) {
        setMembershipsState({
          kind: "error",
          message: "Bộ lọc thành viên Phòng Kế toán không hợp lệ.",
          retryable: true,
        });
        return;
      }

      setMembershipsState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/accounting/memberships?${query.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMembershipsState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải danh sách thành viên.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setMembershipsState({ kind: "denied", message: failure.message });
          return;
        }
        setMembershipsState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectAccountingMembershipsEnvelope(
        payload,
        { search: searchFilter, includeHistory, page },
        department.department_id,
      );
      if (!projected) {
        setMembershipsState({
          kind: "error",
          message: "Phản hồi danh sách thành viên Phòng Kế toán không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setMembershipsState({ kind: "ready", data: projected });
    })();

    return () => controller.abort();
  }, [
    department.department_id,
    includeHistory,
    page,
    parentReloadToken,
    reloadToken,
    searchFilter,
  ]);

  useEffect(() => {
    if (dialog?.kind !== "assign") return;

    const controller = new AbortController();
    void (async () => {
      const query = buildAccountingCandidatesQuery({
        search: candidateSearchFilter,
        page: candidatePage,
      });
      if (!query) {
        setCandidatesState({
          kind: "error",
          message: "Từ khóa tìm kiếm ứng viên không hợp lệ.",
          retryable: true,
        });
        return;
      }

      setCandidatesState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/accounting/candidates?${query.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCandidatesState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải danh sách tài khoản ứng viên.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setCandidatesState({ kind: "denied", message: failure.message });
          return;
        }
        setCandidatesState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectAccountingCandidatesEnvelope(
        payload,
        { search: candidateSearchFilter, page: candidatePage },
        department.department_id,
      );
      if (!projected) {
        setCandidatesState({
          kind: "error",
          message: "Phản hồi danh sách ứng viên không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setCandidatesState({ kind: "ready", data: projected });
      setSelectedCandidate((current) => {
        if (!current) return null;
        const refreshed = projected.candidates.find(
          (item) => item.account_ref === current.account_ref,
        );
        if (!refreshed) return current;
        return isCandidateAssignable(refreshed) ? refreshed : null;
      });
    })();

    return () => controller.abort();
  }, [
    candidatePage,
    candidateReloadToken,
    candidateSearchFilter,
    department.department_id,
    dialog?.kind,
  ]);

  const reloadMemberships = () => {
    setMembershipsState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const reloadCandidates = () => {
    setCandidatesState({ kind: "loading" });
    setCandidateReloadToken((value) => value + 1);
  };

  const openEndDialog = (membership: AccountingMembershipProjection) => {
    if (!canManage || membership.valid_to !== null) return;
    pendingIntentRef.current = null;
    setDialogFeedback(null);
    setEndReason("");
    setDialog({ kind: "end", membership });
  };

  async function handleAssignSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDialogFeedback(null);

    if (!selectedCandidate) {
      setDialogFeedback({
        tone: "error",
        message: "Vui lòng chọn một tài khoản từ danh sách ứng viên bên trên.",
        needsReload: false,
      });
      return;
    }

    const signature = JSON.stringify({
      op: "assign",
      accountRef: selectedCandidate.account_ref,
      expectedPairVersion: selectedCandidate.pair_version,
      effectiveFrom: null,
      reason: assignReason.trim(),
    });
    const intentKey =
      pendingIntentRef.current?.signature === signature
        ? pendingIntentRef.current.key
        : newDepartmentIdempotencyKey();
    pendingIntentRef.current = { signature, key: intentKey };

    const built = buildAssignAccountingMemberRequest({
      accountRef: selectedCandidate.account_ref,
      expectedPairVersion: selectedCandidate.pair_version,
      authorizationDate: detail.authorization_date,
      effectiveFrom: null,
      reason: assignReason,
      idempotencyKey: intentKey,
    });
    if (!built.ok) {
      setDialogFeedback({
        tone: "error",
        message: built.message,
        needsReload: false,
      });
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/admin/departments/accounting/memberships", {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": built.idempotencyKey,
        },
        body: JSON.stringify(built.body),
      });
      const payload: unknown = await response.json().catch(() => null);
      const outcome = classifyDepartmentMutationResponse(response.status, payload, "assign");
      setBusy(false);

      if (outcome.kind === "applied") {
        pendingIntentRef.current = null;
        setDialog(null);
        setSelectedCandidate(null);
        notify.success({ title: outcome.message });
        reloadMemberships();
        onMembershipMutated();
        return;
      }

      if (outcome.resetIdempotencyKey) {
        pendingIntentRef.current = null;
      }

      setDialogFeedback({
        tone: outcome.kind === "conflict" ? "warning" : "error",
        message: outcome.message,
        needsReload: outcome.kind === "conflict" || outcome.kind === "not-found",
      });
    } catch {
      setBusy(false);
      setDialogFeedback({
        tone: "error",
        message: "Không nhận được phản hồi từ máy chủ. Bạn có thể gửi lại an toàn.",
        needsReload: false,
      });
    }
  }

  async function handleEndSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDialogFeedback(null);
    if (dialog?.kind !== "end") return;

    const target = dialog.membership;
    const signature = JSON.stringify({
      op: "end",
      membershipId: target.membership_id,
      expectedPairVersion: target.pair_version,
      effectiveTo: null,
      reason: endReason.trim(),
    });
    const intentKey =
      pendingIntentRef.current?.signature === signature
        ? pendingIntentRef.current.key
        : newDepartmentIdempotencyKey();
    pendingIntentRef.current = { signature, key: intentKey };

    const built = buildEndAccountingMemberRequest({
      membershipId: target.membership_id,
      expectedPairVersion: target.pair_version,
      membershipState: target.state,
      validFrom: target.valid_from,
      authorizationDate: detail.authorization_date,
      effectiveTo: null,
      reason: endReason,
      idempotencyKey: intentKey,
    });
    if (!built.ok) {
      setDialogFeedback({
        tone: "error",
        message: built.message,
        needsReload: false,
      });
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/departments/accounting/memberships/${encodeURIComponent(built.membershipId)}/end`,
        {
          method: "POST",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": built.idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      const outcome = classifyDepartmentMutationResponse(response.status, payload, "end");
      setBusy(false);

      if (outcome.kind === "applied") {
        pendingIntentRef.current = null;
        setDialog(null);
        notify.success({ title: outcome.message });
        reloadMemberships();
        onMembershipMutated();
        return;
      }

      if (outcome.resetIdempotencyKey) {
        pendingIntentRef.current = null;
      }

      setDialogFeedback({
        tone: outcome.kind === "conflict" ? "warning" : "error",
        message: outcome.message,
        needsReload: outcome.kind === "conflict" || outcome.kind === "not-found",
      });
    } catch {
      setBusy(false);
      setDialogFeedback({
        tone: "error",
        message: "Không nhận được phản hồi từ máy chủ. Bạn có thể gửi lại an toàn.",
        needsReload: false,
      });
    }
  }

  const memberships =
    membershipsState.kind === "ready" ? membershipsState.data.memberships : [];
  const membershipPageCount =
    membershipsState.kind === "ready"
      ? Math.max(
          1,
          Math.ceil(
            membershipsState.data.total / Math.max(1, membershipsState.data.page_size),
          ),
        )
      : 1;
  const candidatePageCount =
    candidatesState.kind === "ready"
      ? Math.max(
          1,
          Math.ceil(
            candidatesState.data.total / Math.max(1, candidatesState.data.page_size),
          ),
        )
      : 1;

  return (
    <div className="space-y-4" data-testid="accounting-department-memberships-panel">
      <PageHeader
        eyebrow="Chi tiết Phòng ban"
        title={department.name}
        badge={
          <StatusBadge tone={department.is_active ? "success" : "neutral"} dot>
            {department.is_active ? "Đang hoạt động" : "Ngừng hoạt động"}
          </StatusBadge>
        }
        description={`Mã hệ thống: ${department.code} · Ngày hiệu lực: ${detail.authorization_date} · ${departmentScaleSummary(department)}`}
        actions={
          <>
            <Button variant="secondary" size="md" onClick={onReloadDetail}>
              Làm mới
            </Button>
            {canManage ? (
              <Link
                href="/finance/project-assignments"
                className={buttonClasses({ variant: "secondary", size: "md" })}
              >
                Phân công dự án &amp; vai trò toàn cục
              </Link>
            ) : null}
            {canManage ? (
              <Button variant="primary" size="md" onClick={openAssignDialog}>
                Gán thành viên
              </Button>
            ) : null}
          </>
        }
      />

      <Card>
        <CardHeader
          title="Quyền mặc định Phòng Kế toán (chỉ đọc)"
          description="Chính sách cố định theo phòng ban hệ thống; áp dụng tự động khi tư cách thành viên đang hiệu lực."
        />
        <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-border bg-surface-muted/60 px-4 py-3">
          <StatusBadge tone="primary" dot>
            Chính sách cố định
          </StatusBadge>
          <span className="text-sm font-semibold text-foreground">
            {departmentDefaultPolicyDescription(department)}
          </span>
        </div>
        <p className="mt-2.5 text-xs text-muted">
          Tài khoản đang có tư cách thành viên hiệu lực tại Phòng Kế toán tự động nhận quyền{" "}
          <strong>{ACCOUNTING_DEFAULT_POLICY_DESCRIPTION}</strong>. Khi kết thúc tư cách thành viên,
          quyền mặc định này ngừng hiệu lực mà không ảnh hưởng tới các quyền độc lập khác của tài khoản.
        </p>
      </Card>

      <Card>
        <CardHeader
          title={
            includeHistory
              ? "Thành viên hiện tại & lịch sử Phòng Kế toán"
              : "Thành viên hiện tại & sắp hiệu lực"
          }
          description={
            membershipsState.kind === "ready"
              ? `${membershipsState.data.total} bản ghi · Ngày hiệu lực hệ thống: ${membershipsState.data.authorization_date}`
              : "Tra cứu và quản lý tư cách thành viên Phòng Kế toán."
          }
        />

        <FilterToolbar
          className="mb-4"
          actions={
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Chế độ xem lịch sử thành viên"
            >
              <Button
                variant={!includeHistory ? "soft" : "secondary"}
                size="md"
                aria-pressed={!includeHistory}
                onClick={() => {
                  setIncludeHistory(false);
                  setPage(1);
                }}
              >
                Hiện tại &amp; sắp hiệu lực
              </Button>
              <Button
                variant={includeHistory ? "soft" : "secondary"}
                size="md"
                aria-pressed={includeHistory}
                onClick={() => {
                  setIncludeHistory(true);
                  setPage(1);
                }}
              >
                Bao gồm lịch sử
              </Button>
            </div>
          }
        >
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              setSearchFilter(searchInput);
              setPage(1);
              reloadMemberships();
            }}
          >
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-foreground">
              Tìm thành viên
              <input
                type="search"
                value={searchInput}
                maxLength={DEPARTMENT_UI_MAX_SEARCH_LENGTH}
                placeholder="Tìm theo tên hiển thị, tài khoản đăng nhập hoặc mã nhân sự…"
                onChange={(event) =>
                  setSearchInput(sanitizeDepartmentSearchInput(event.target.value))
                }
                className={INPUT_CLASS}
              />
            </label>
            <Button type="submit" variant="secondary" size="md">
              Lọc
            </Button>
          </form>
        </FilterToolbar>

        {membershipsState.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted">
            Đang tải danh sách thành viên Phòng Kế toán…
          </p>
        ) : null}

        {membershipsState.kind === "denied" ? (
          <Alert tone="error" role="alert" title="Không có quyền truy cập">
            {membershipsState.message}
          </Alert>
        ) : null}

        {membershipsState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState
              title="Không tải được danh sách thành viên Phòng Kế toán"
              detail={membershipsState.message}
            />
            {membershipsState.retryable ? (
              <Button variant="secondary" onClick={reloadMemberships}>
                Thử tải lại
              </Button>
            ) : null}
          </div>
        ) : null}

        {membershipsState.kind === "ready" && memberships.length === 0 ? (
          <EmptyState
            title={
              includeHistory
                ? "Chưa có bản ghi thành viên hoặc lịch sử phù hợp"
                : "Chưa có thành viên đang hiệu lực tại Phòng Kế toán"
            }
            description={
              searchFilter.trim()
                ? "Không tìm thấy thành viên nào khớp với từ khóa hiện tại."
                : includeHistory
                  ? "Phòng Kế toán hiện chưa có lịch sử gán thành viên."
                  : "Nhấn “Gán thành viên” để thêm tài khoản chính tắc vào Phòng Kế toán."
            }
          />
        ) : null}

        {membershipsState.kind === "ready" && memberships.length > 0 ? (
          <>
            <DataTableContainer dataTestId="accounting-memberships-table">
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Thành viên
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Trạng thái
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Thời gian hiệu lực
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Ghi nhận &amp; Lịch sử
                    </th>
                    <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                      Thao tác
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {memberships.map((membership) => {
                    const badge = membershipStateBadge(membership.state);
                    const secondaryMeta = formatAccountSecondaryMeta(membership);
                    return (
                      <tr key={membership.membership_id} className={DATA_TABLE_ROW_CLASS}>
                        <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-foreground">
                              {membership.display_name}
                            </span>
                            {!membership.account_enabled ? (
                              <StatusBadge tone="neutral">
                                Tài khoản ngừng hoạt động
                              </StatusBadge>
                            ) : null}
                          </div>
                          {secondaryMeta ? (
                            <div className="mt-0.5 text-xs text-muted">{secondaryMeta}</div>
                          ) : null}
                        </td>
                        <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                          <StatusBadge tone={badge.tone} dot>
                            {badge.label}
                          </StatusBadge>
                        </td>
                        <td
                          data-label="Thời gian hiệu lực"
                          className={`${DATA_TABLE_TD_CLASS} font-mono text-xs sm:text-sm tabular-nums whitespace-nowrap`}
                        >
                          {membership.valid_from} → {membership.valid_to ?? "Hiện tại"}
                        </td>
                        <td data-label="Ghi nhận" className={DATA_TABLE_TD_CLASS}>
                          <div className="text-xs sm:text-sm text-foreground">
                            Gán bởi: {membership.granted_by_display_name}
                          </div>
                          {membership.revoked_by_display_name ? (
                            <div className="mt-0.5 text-xs text-muted">
                              Kết thúc bởi: {membership.revoked_by_display_name}
                            </div>
                          ) : null}
                        </td>
                        <td
                          data-card-actions="true"
                          className={`${DATA_TABLE_TD_CLASS} text-right`}
                        >
                          <RowActionCluster>
                            {membership.valid_to === null && canManage ? (
                              <Button
                                variant="danger-outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => openEndDialog(membership)}
                              >
                                Kết thúc
                              </Button>
                            ) : (
                              <span className="text-xs text-muted">Chỉ xem</span>
                            )}
                          </RowActionCluster>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DataTableContainer>

            <OffsetPager
              page={page}
              pageCount={membershipPageCount}
              total={membershipsState.data.total}
              ariaLabel="Phân trang danh sách thành viên Phòng Kế toán"
              nextDisabled={!membershipsState.data.has_more}
              onPageChange={(nextPage) => setPage(nextPage)}
            />
          </>
        ) : null}
      </Card>

      <FormDialog
        open={dialog?.kind === "assign"}
        onOpenChange={(open) => {
          if (!open && !busy) {
            pendingIntentRef.current = null;
            setDialogFeedback(null);
            setDialog(null);
          }
        }}
        title="Gán thành viên vào Phòng Kế toán"
        description="Tìm và chọn tài khoản chính tắc từ hệ thống. Lý do thao tác là bắt buộc và được lưu kiểm toán."
        descriptionId="assign-accounting-member-desc"
        closeDisabled={busy}
        dataTestId="assign-accounting-member-dialog"
      >
        <form className="space-y-4" onSubmit={handleAssignSubmit}>
          <div className="rounded-lg border border-border bg-surface-muted/60 px-3.5 py-2.5 text-xs text-muted">
            Quyền mặc định chỉ đọc sẽ áp dụng khi hiệu lực:{" "}
            <strong className="text-foreground">{ACCOUNTING_DEFAULT_POLICY_DESCRIPTION}</strong>
          </div>

          <section aria-labelledby="accounting-candidate-picker-heading" className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3
                id="accounting-candidate-picker-heading"
                className="text-sm font-semibold text-foreground"
              >
                1. Chọn tài khoản chính tắc
              </h3>
              {selectedCandidate ? (
                <StatusBadge tone="primary" dot>
                  Đã chọn: {selectedCandidate.display_name}
                </StatusBadge>
              ) : null}
            </div>

            <label className="flex flex-col gap-1 text-xs sm:text-sm font-medium text-foreground">
              Tìm ứng viên
              <input
                type="search"
                value={candidateSearchInput}
                disabled={busy}
                maxLength={DEPARTMENT_UI_MAX_SEARCH_LENGTH}
                placeholder="Nhập tên hiển thị, tài khoản đăng nhập hoặc mã nhân sự…"
                onChange={(event) =>
                  setCandidateSearchInput(sanitizeDepartmentSearchInput(event.target.value))
                }
                className={INPUT_CLASS}
              />
            </label>

            {candidatesState.kind === "loading" ? (
              <p role="status" className="py-4 text-center text-sm text-muted">
                Đang tải danh sách tài khoản ứng viên…
              </p>
            ) : null}

            {candidatesState.kind === "denied" ? (
              <Alert tone="error" role="alert" title="Không có quyền truy cập">
                {candidatesState.message}
              </Alert>
            ) : null}

            {candidatesState.kind === "error" ? (
              <div className="space-y-2">
                <ErrorState
                  title="Không tải được danh sách ứng viên"
                  detail={candidatesState.message}
                />
                {candidatesState.retryable ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={reloadCandidates}
                  >
                    Thử tải lại ứng viên
                  </Button>
                ) : null}
              </div>
            ) : null}

            {candidatesState.kind === "ready" &&
            candidatesState.data.candidates.length === 0 ? (
              <EmptyState
                title="Không tìm thấy tài khoản phù hợp"
                description="Thử nhập từ khóa khác theo tên hiển thị, tài khoản đăng nhập hoặc mã nhân sự."
              />
            ) : null}

            {candidatesState.kind === "ready" &&
            candidatesState.data.candidates.length > 0 ? (
              <>
                <div
                  role="radiogroup"
                  aria-labelledby="accounting-candidate-picker-heading"
                  className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-surface"
                >
                  {candidatesState.data.candidates.map((candidate) => {
                    const assignable = isCandidateAssignable(candidate);
                    const availability = candidateAvailabilityBadge(candidate);
                    const isSelected =
                      selectedCandidate?.account_ref === candidate.account_ref;
                    const meta = formatAccountSecondaryMeta(candidate);
                    return (
                      <label
                        key={candidate.account_ref}
                        className={`flex items-start justify-between gap-3 px-3.5 py-2.5 text-sm transition-colors ${
                          assignable
                            ? "cursor-pointer hover:bg-surface-hover"
                            : "cursor-not-allowed opacity-65"
                        } ${isSelected ? "bg-primary/8" : ""}`}
                      >
                        <div className="flex min-w-0 items-start gap-2.5">
                          <input
                            type="radio"
                            name="accounting-candidate"
                            className="mt-1 size-4 shrink-0 accent-primary"
                            checked={isSelected}
                            disabled={busy || !assignable}
                            onChange={() => {
                              if (!assignable) return;
                              pendingIntentRef.current = null;
                              setDialogFeedback(null);
                              setSelectedCandidate(candidate);
                            }}
                          />
                          <div className="min-w-0">
                            <div className="font-medium text-foreground">
                              {candidate.display_name}
                            </div>
                            {meta ? (
                              <div className="mt-0.5 text-xs text-muted">{meta}</div>
                            ) : null}
                          </div>
                        </div>
                        <StatusBadge tone={availability.tone}>
                          {availability.label}
                        </StatusBadge>
                      </label>
                    );
                  })}
                </div>

                <OffsetPager
                  page={candidatePage}
                  pageCount={candidatePageCount}
                  total={candidatesState.data.total}
                  ariaLabel="Phân trang danh sách tài khoản ứng viên"
                  disabled={busy}
                  nextDisabled={!candidatesState.data.has_more}
                  onPageChange={(nextPage) => setCandidatePage(nextPage)}
                />
              </>
            ) : null}
          </section>

          <div className="rounded-lg border border-border bg-surface-muted/60 px-3.5 py-2.5 text-xs text-muted">
            2. Ngày bắt đầu hiệu lực:{" "}
            <strong className="font-mono text-foreground">{detail.authorization_date}</strong> (áp
            dụng ngay theo ngày nghiệp vụ hệ thống).
          </div>

          <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
            3. Lý do gán thành viên (bắt buộc)
            <textarea
              required
              rows={3}
              value={assignReason}
              disabled={busy}
              maxLength={DEPARTMENT_UI_MAX_REASON_LENGTH}
              placeholder="Nhập lý do bổ nhiệm hoặc phân công phụ trách kế toán Vendor…"
              onChange={(event) => {
                pendingIntentRef.current = null;
                setAssignReason(event.target.value);
              }}
              className={TEXTAREA_CLASS}
            />
          </label>

          {dialogFeedback ? (
            <Alert
              tone={dialogFeedback.tone}
              role="alert"
              title={
                dialogFeedback.tone === "warning"
                  ? "Cần đồng bộ lại dữ liệu"
                  : "Không thể gán thành viên"
              }
            >
              <p>{dialogFeedback.message}</p>
              {dialogFeedback.needsReload ? (
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setDialogFeedback(null);
                      reloadCandidates();
                      reloadMemberships();
                      onMembershipMutated();
                    }}
                  >
                    Tải lại danh sách ứng viên
                  </Button>
                </div>
              ) : null}
            </Alert>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => {
                pendingIntentRef.current = null;
                setDialogFeedback(null);
                setDialog(null);
              }}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={busy}
              disabled={busy || !selectedCandidate || assignReason.trim().length === 0}
            >
              {busy ? "Đang lưu…" : "Xác nhận gán thành viên"}
            </Button>
          </div>
        </form>
      </FormDialog>

      <FormDialog
        open={dialog?.kind === "end"}
        onOpenChange={(open) => {
          if (!open && !busy) {
            pendingIntentRef.current = null;
            setDialogFeedback(null);
            setDialog(null);
          }
        }}
        title="Kết thúc tư cách thành viên Phòng Kế toán"
        description="Quyền mặc định “Xem và ghi nhận tài chính Vendor” sẽ ngừng hiệu lực từ thời điểm kết thúc."
        descriptionId="end-accounting-member-desc"
        closeDisabled={busy}
        dataTestId="end-accounting-member-dialog"
      >
        {dialog?.kind === "end" ? (
          <form className="space-y-4" onSubmit={handleEndSubmit}>
            <div className="space-y-1 rounded-lg border border-border bg-surface-muted/60 px-3.5 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-foreground">
                  {dialog.membership.display_name}
                </span>
                <StatusBadge
                  tone={membershipStateBadge(dialog.membership.state).tone}
                  dot
                >
                  {membershipStateBadge(dialog.membership.state).label}
                </StatusBadge>
              </div>
              {formatAccountSecondaryMeta(dialog.membership) ? (
                <div className="text-xs text-muted">
                  {formatAccountSecondaryMeta(dialog.membership)}
                </div>
              ) : null}
              <div className="font-mono text-xs tabular-nums text-muted">
                Hiệu lực từ: {dialog.membership.valid_from}
              </div>
            </div>

            {dialog.membership.state === "CURRENT" ? (
              <div className="rounded-lg border border-border bg-surface-muted/60 px-3.5 py-2.5 text-xs text-muted">
                Ngày kết thúc hiệu lực:{" "}
                <strong className="font-mono text-foreground">{detail.authorization_date}</strong>{" "}
                (kết thúc ngay trong ngày hiệu lực hệ thống).
              </div>
            ) : (
              <Alert tone="info" role="status" title="Hủy lịch tham gia sắp hiệu lực">
                Bản ghi này chưa tới ngày bắt đầu ({dialog.membership.valid_from}) nên sẽ được
                chuyển sang lịch sử ngay khi xác nhận.
              </Alert>
            )}

            <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
              Lý do kết thúc (bắt buộc)
              <textarea
                required
                rows={3}
                value={endReason}
                disabled={busy}
                maxLength={DEPARTMENT_UI_MAX_REASON_LENGTH}
                placeholder="Nhập lý do điều chuyển hoặc kết thúc phân công tại Phòng Kế toán…"
                onChange={(event) => {
                  pendingIntentRef.current = null;
                  setEndReason(event.target.value);
                }}
                className={TEXTAREA_CLASS}
              />
            </label>

            {dialogFeedback ? (
              <Alert
                tone={dialogFeedback.tone}
                role="alert"
                title={
                  dialogFeedback.tone === "warning"
                    ? "Cần đồng bộ lại dữ liệu"
                    : "Không thể kết thúc tư cách thành viên"
                }
              >
                <p>{dialogFeedback.message}</p>
                {dialogFeedback.needsReload ? (
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        pendingIntentRef.current = null;
                        setDialogFeedback(null);
                        setDialog(null);
                        reloadMemberships();
                        onMembershipMutated();
                      }}
                    >
                      Tải lại dữ liệu mới nhất
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                size="md"
                disabled={busy}
                onClick={() => {
                  pendingIntentRef.current = null;
                  setDialogFeedback(null);
                  setDialog(null);
                }}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                variant="danger"
                size="md"
                loading={busy}
                disabled={busy || endReason.trim().length === 0}
              >
                {busy ? "Đang lưu…" : "Xác nhận kết thúc"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </div>
  );
}
