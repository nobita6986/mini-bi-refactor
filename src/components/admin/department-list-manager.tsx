"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

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
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import {
  DEPARTMENT_CODE_MAX_LENGTH,
  DEPARTMENT_NAME_MAX_LENGTH,
  DEPARTMENT_WP3_MAX_REASON_LENGTH,
  buildCreateDepartmentRequest,
  buildDepartmentListQuery,
  buildUpdateDepartmentRequest,
  canToggleDepartmentActive,
  classifyDepartmentReadError,
  departmentDefaultPolicyDescription,
  departmentMembershipModeLabel,
  departmentScaleSummary,
  newDepartmentIdempotencyKey,
  projectDepartmentListEnvelope,
  projectDepartmentMutationEnvelope,
  resolveWp3DepartmentMutationResult,
} from "@/lib/admin/department-ui-model";
import type {
  DepartmentListProjection,
  DepartmentProjection,
} from "@/lib/departments/department-contract";

const INPUT_CLASS =
  "min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm text-foreground " +
  "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const TEXTAREA_CLASS =
  "min-h-24 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm text-foreground " +
  "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

type DepartmentListLoadState =
  | { kind: "loading" }
  | { kind: "ready"; list: DepartmentListProjection }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string; retryable: boolean };

type DepartmentDialogState =
  | { kind: "create" }
  | { kind: "rename"; department: DepartmentProjection }
  | { kind: "toggle"; department: DepartmentProjection; nextActive: boolean }
  | null;

type PendingDepartmentIntent = {
  url: string;
  method: "POST" | "PATCH";
  idempotencyKey: string;
  body: Record<string, unknown>;
  expectCreated: boolean;
  successMessage: string;
  uncertain: boolean;
};

type DialogFeedback = {
  tone: "error" | "warning";
  message: string;
  needsReload: boolean;
} | null;

export function DepartmentListManager() {
  const notify = useNotify();
  const [state, setState] = useState<DepartmentListLoadState>({ kind: "loading" });
  const [includeInactive, setIncludeInactive] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const [dialog, setDialog] = useState<DepartmentDialogState>(null);
  const [codeInput, setCodeInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingDepartmentIntent | null>(null);
  const [feedback, setFeedback] = useState<DialogFeedback>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setState({ kind: "loading" });
      const query = buildDepartmentListQuery({ includeInactive });
      let response: Response;
      try {
        response = await fetch(`/api/admin/departments?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải danh sách Phòng ban.",
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
          return;
        }
        setState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectDepartmentListEnvelope(payload);
      if (!projected) {
        setState({
          kind: "error",
          message: "Phản hồi danh sách Phòng ban không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setState({ kind: "ready", list: projected });
    })();

    return () => controller.abort();
  }, [includeInactive, reloadToken]);

  const reloadList = () => {
    setState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const resetDialogState = () => {
    setPendingIntent(null);
    setFeedback(null);
    setDialog(null);
  };

  const openCreateDialog = () => {
    setCodeInput("");
    setNameInput("");
    setReasonInput("");
    setPendingIntent(null);
    setFeedback(null);
    setDialog({ kind: "create" });
  };

  const openRenameDialog = (department: DepartmentProjection) => {
    setCodeInput(department.code);
    setNameInput(department.name);
    setReasonInput("");
    setPendingIntent(null);
    setFeedback(null);
    setDialog({ kind: "rename", department });
  };

  const openToggleDialog = (department: DepartmentProjection) => {
    if (!canToggleDepartmentActive(department)) return;
    setCodeInput(department.code);
    setNameInput(department.name);
    setReasonInput("");
    setPendingIntent(null);
    setFeedback(null);
    setDialog({ kind: "toggle", department, nextActive: !department.is_active });
  };

  const executeIntent = async (intent: PendingDepartmentIntent) => {
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
            "Mất kết nối hoặc hết thời gian chờ phản hồi. Nội dung và khóa gửi trùng được giữ nguyên để thử lại đúng yêu cầu hoặc tải lại để đối chiếu.",
          needsReload: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      const outcome = resolveWp3DepartmentMutationResult(
        response.status,
        payload,
        projectDepartmentMutationEnvelope,
        intent.expectCreated,
      );

      if (outcome.ok) {
        const msg = outcome.data.replayed
          ? `${intent.successMessage} (khớp yêu cầu đã ghi nhận trước đó).`
          : intent.successMessage;
        notify.success({ title: msg });
        resetDialogState();
        reloadList();
        return;
      }

      const { failure } = outcome;
      if (failure.kind === "session-lost") {
        resetDialogState();
        setState({ kind: "denied", message: failure.message });
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

  const handleDialogSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dialog || busy) return;

    if (pendingIntent?.uncertain) {
      void executeIntent(pendingIntent);
      return;
    }

    const idempotencyKey = pendingIntent?.idempotencyKey ?? newDepartmentIdempotencyKey();

    if (dialog.kind === "create") {
      const built = buildCreateDepartmentRequest({
        code: codeInput,
        name: nameInput,
        reason: reasonInput,
        idempotencyKey,
      });
      if (!built.ok) {
        setFeedback({ tone: "error", message: built.message, needsReload: false });
        return;
      }
      const nextIntent: PendingDepartmentIntent = {
        url: "/api/admin/departments",
        method: "POST",
        idempotencyKey: built.idempotencyKey,
        body: built.body,
        expectCreated: true,
        successMessage: `Đã tạo phòng ban tùy chỉnh “${built.body.name}”.`,
        uncertain: false,
      };
      setPendingIntent(nextIntent);
      void executeIntent(nextIntent);
      return;
    }

    if (dialog.kind === "rename") {
      const built = buildUpdateDepartmentRequest({
        expectedDepartmentVersion: dialog.department.version,
        name: nameInput,
        isActive: dialog.department.is_active,
        reason: reasonInput,
        idempotencyKey,
      });
      if (!built.ok) {
        setFeedback({ tone: "error", message: built.message, needsReload: false });
        return;
      }
      const nextIntent: PendingDepartmentIntent = {
        url: `/api/admin/departments/${encodeURIComponent(dialog.department.department_id)}`,
        method: "PATCH",
        idempotencyKey: built.idempotencyKey,
        body: built.body,
        expectCreated: false,
        successMessage: `Đã đổi tên phòng ban thành “${built.body.name}”.`,
        uncertain: false,
      };
      setPendingIntent(nextIntent);
      void executeIntent(nextIntent);
      return;
    }

    const built = buildUpdateDepartmentRequest({
      expectedDepartmentVersion: dialog.department.version,
      name: dialog.department.name,
      isActive: dialog.nextActive,
      reason: reasonInput,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", message: built.message, needsReload: false });
      return;
    }
    const nextIntent: PendingDepartmentIntent = {
      url: `/api/admin/departments/${encodeURIComponent(dialog.department.department_id)}`,
      method: "PATCH",
      idempotencyKey: built.idempotencyKey,
      body: built.body,
      expectCreated: false,
      successMessage: dialog.nextActive
        ? `Đã kích hoạt lại phòng ban “${dialog.department.name}”.`
        : `Đã ngừng hoạt động phòng ban “${dialog.department.name}”.`,
      uncertain: false,
    };
    setPendingIntent(nextIntent);
    void executeIntent(nextIntent);
  };

  const fieldsLocked = busy || pendingIntent?.uncertain === true;

  return (
    <PageShell
      dataTestId="departments-admin-page"
      className="max-w-none px-0 py-0 sm:px-0 sm:py-0 lg:px-0"
    >
      <PageHeader
        eyebrow="Tổ chức hệ thống"
        title="Phòng ban"
        description="Quản trị Phòng ban hệ thống và phòng ban tùy chỉnh dành cho Full Admin. Đổi tên, quản lý thành viên Nhân sự nội bộ và Trưởng phòng áp dụng ngay, không đặt lịch."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={reloadList}
              disabled={state.kind === "loading"}
            >
              Làm mới
            </Button>
            {state.kind !== "denied" ? (
              <Button variant="primary" size="md" onClick={openCreateDialog}>
                Tạo phòng ban tùy chỉnh
              </Button>
            ) : null}
          </div>
        }
      />

      {state.kind !== "denied" ? (
        <FilterToolbar>
          <div className="w-full sm:w-72">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Hiển thị trạng thái phòng ban
              <select
                aria-label="Lọc trạng thái phòng ban"
                value={includeInactive ? "true" : "false"}
                onChange={(event) => {
                  setIncludeInactive(event.target.value === "true");
                }}
                className={INPUT_CLASS}
              >
                <option value="true">Tất cả (gồm ngừng hoạt động)</option>
                <option value="false">Chỉ phòng đang hoạt động</option>
              </select>
            </label>
          </div>
        </FilterToolbar>
      ) : null}

      {state.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải danh sách Phòng ban…
          </p>
        </Card>
      ) : null}

      {state.kind === "denied" ? (
        <Alert tone="error" role="alert" title="Không có quyền truy cập">
          {state.message}
        </Alert>
      ) : null}

      {state.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState
              title="Không tải được danh sách Phòng ban"
              detail={state.message}
            />
            {state.retryable ? (
              <div>
                <Button variant="secondary" onClick={reloadList}>
                  Thử tải lại
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {state.kind === "ready" && state.list.departments.length === 0 ? (
        <Card>
          <div className="space-y-4">
            <EmptyState
              title="Chưa có phòng ban phù hợp"
              description="Thử chuyển bộ lọc sang bao gồm phòng ngừng hoạt động hoặc tạo phòng ban tùy chỉnh mới."
            />
            <div className="flex justify-center gap-2">
              <Button variant="secondary" onClick={reloadList}>
                Thử tải lại
              </Button>
              <Button variant="primary" onClick={openCreateDialog}>
                Tạo phòng ban tùy chỉnh
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {state.kind === "ready" && state.list.departments.length > 0 ? (
        <Card>
          <CardHeader
            title="Danh sách Phòng ban"
            description={`Ngày hiệu lực hệ thống: ${state.list.authorization_date} · ${state.list.departments.length} phòng ban`}
          />
          <DataTableContainer dataTestId="departments-list-table">
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Phòng ban
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Trạng thái
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Trưởng phòng (HEAD)
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Quy mô hiện tại
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Chế độ &amp; Quyền mặc định (chỉ đọc)
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {state.list.departments.map((department) => {
                  const isAccounting = department.system_key === "ACCOUNTING";
                  const isCustom = canToggleDepartmentActive(department);
                  return (
                    <tr
                      key={department.department_id}
                      data-testid={`department-row-${(department.system_key ?? department.code).toLowerCase()}`}
                      className={DATA_TABLE_ROW_CLASS}
                    >
                      <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-foreground">{department.name}</span>
                          <StatusBadge tone={isCustom ? "info" : "neutral"}>
                            {isCustom ? "Tùy chỉnh" : "Mặc định hệ thống"}
                          </StatusBadge>
                        </div>
                        <div className="mt-0.5 font-mono text-xs text-muted">
                          Mã: {department.code}
                        </div>
                      </td>
                      <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                        <StatusBadge tone={department.is_active ? "success" : "neutral"} dot>
                          {department.is_active ? "Đang hoạt động" : "Ngừng hoạt động"}
                        </StatusBadge>
                      </td>
                      <td data-label="Trưởng phòng" className={DATA_TABLE_TD_CLASS}>
                        {department.active_head ? (
                          <div>
                            <Link
                              href={`/admin/organization/persons/${encodeURIComponent(department.active_head.person_id)}`}
                              className="font-medium text-primary hover:underline"
                            >
                              {department.active_head.full_name}
                            </Link>
                            <div className="font-mono text-xs text-muted">
                              {department.active_head.employee_code}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted">Chưa bổ nhiệm</span>
                        )}
                      </td>
                      <td
                        data-label="Quy mô hiện tại"
                        className={`${DATA_TABLE_TD_CLASS} tabular-nums`}
                      >
                        {departmentScaleSummary(department)}
                      </td>
                      <td data-label="Quyền mặc định" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-1">
                          <StatusBadge tone={isAccounting ? "primary" : "neutral"}>
                            {departmentMembershipModeLabel(department)}
                          </StatusBadge>
                          <p className="max-w-md text-xs text-muted whitespace-normal">
                            {departmentDefaultPolicyDescription(department)}
                          </p>
                        </div>
                      </td>
                      <td
                        data-card-actions="true"
                        className={`${DATA_TABLE_TD_CLASS} text-right`}
                      >
                        <RowActionCluster>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openRenameDialog(department)}
                          >
                            Đổi tên
                          </Button>
                          {isCustom ? (
                            <Button
                              variant={department.is_active ? "secondary" : "primary"}
                              size="sm"
                              onClick={() => openToggleDialog(department)}
                            >
                              {department.is_active ? "Ngừng hoạt động" : "Kích hoạt lại"}
                            </Button>
                          ) : null}
                          <Link
                            href={`/admin/departments/${encodeURIComponent(department.department_id)}`}
                            className={buttonClasses({
                              variant: isAccounting ? "primary" : "secondary",
                              size: "sm",
                            })}
                          >
                            {isAccounting
                              ? "Quản lý thành viên"
                              : department.system_key === "RECRUITMENT"
                                ? "Chi tiết & Nhóm"
                                : "Chi tiết & nhân sự"}
                          </Link>
                        </RowActionCluster>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        </Card>
      ) : null}

      <FormDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            resetDialogState();
          }
        }}
        title={
          dialog?.kind === "create"
            ? "Tạo phòng ban tùy chỉnh"
            : dialog?.kind === "rename"
              ? "Đổi tên phòng ban"
              : dialog?.kind === "toggle"
                ? dialog.nextActive
                  ? "Kích hoạt lại phòng ban"
                  : "Ngừng hoạt động phòng ban"
                : "Phòng ban"
        }
        description={
          dialog?.kind === "create"
            ? "Tạo phòng ban tùy chỉnh để tổ chức nhân sự nội bộ và bổ nhiệm Trưởng phòng. Thao tác có hiệu lực ngay."
            : dialog?.kind === "rename"
              ? "Cập nhật tên hiển thị phòng ban. Mã phòng ban và quyền mặc định giữ nguyên."
              : dialog?.kind === "toggle"
                ? dialog.nextActive
                  ? "Phòng ban tùy chỉnh sẽ hoạt động trở lại để tiếp nhận thành viên."
                  : "Chỉ ngừng hoạt động được khi phòng ban không còn thành viên hay Trưởng phòng đang hiệu lực."
                : undefined
        }
        descriptionId="department-list-dialog-desc"
        closeDisabled={busy}
        dataTestId="department-list-dialog"
      >
        {dialog ? (
          <form className="space-y-4" onSubmit={handleDialogSubmit}>
            {dialog.kind === "create" ? (
              <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
                Mã phòng ban (bắt buộc)
                <input
                  required
                  value={codeInput}
                  disabled={fieldsLocked}
                  maxLength={DEPARTMENT_CODE_MAX_LENGTH}
                  placeholder="VD: VAN_HANH_MIEN_NAM"
                  onChange={(event) => {
                    setPendingIntent(null);
                    setCodeInput(event.target.value);
                  }}
                  className={INPUT_CLASS}
                />
                <span className="text-xs font-normal text-muted">
                  2–64 ký tự chữ hoa (A-Z), số (0-9), dấu gạch dưới `_` hoặc gạch ngang `-`.
                </span>
              </label>
            ) : (
              <div className="rounded-lg border border-border bg-surface-muted/50 px-3 py-2 text-xs text-muted">
                Mã phòng ban: <span className="font-mono font-medium text-foreground">{dialog.department.code}</span>
              </div>
            )}

            {dialog.kind === "create" || dialog.kind === "rename" ? (
              <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
                Tên phòng ban (bắt buộc)
                <input
                  required
                  value={nameInput}
                  disabled={fieldsLocked}
                  maxLength={DEPARTMENT_NAME_MAX_LENGTH}
                  placeholder="Nhập tên phòng ban…"
                  onChange={(event) => {
                    setPendingIntent(null);
                    setNameInput(event.target.value);
                  }}
                  className={INPUT_CLASS}
                />
              </label>
            ) : (
              <Alert tone={dialog.nextActive ? "info" : "warning"} title={dialog.department.name}>
                {dialog.nextActive
                  ? "Xác nhận kích hoạt lại phòng ban tùy chỉnh này ngay lập tức."
                  : "Xác nhận ngừng hoạt động phòng ban tùy chỉnh này. Nếu vẫn còn thành viên hoặc Trưởng phòng hiệu lực, hệ thống sẽ từ chối và yêu cầu kết thúc trước."}
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
                placeholder="Nhập lý do thay đổi cơ cấu phòng ban…"
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
                        resetDialogState();
                        reloadList();
                      }}
                    >
                      Tải lại để đối chiếu
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
                onClick={resetDialogState}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                variant={dialog.kind === "toggle" && !dialog.nextActive ? "danger" : "primary"}
                size="md"
                loading={busy}
                disabled={busy}
              >
                {pendingIntent?.uncertain
                  ? "Thử gửi lại cùng yêu cầu"
                  : dialog.kind === "create"
                    ? "Tạo phòng ban"
                    : dialog.kind === "rename"
                      ? "Lưu tên mới"
                      : dialog.nextActive
                        ? "Xác nhận kích hoạt"
                        : "Xác nhận ngừng hoạt động"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </PageShell>
  );
}
