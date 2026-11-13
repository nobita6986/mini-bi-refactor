"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  DepartmentSelectPicker,
  type SelectedDepartmentOption,
} from "@/components/admin/org-entity-picker";
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
} from "@/components/ui/data-table";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  buildAssignPersonDepartmentRequest,
  buildEndPersonDepartmentRequest,
  buildTransferPersonDepartmentRequest,
  buildUpdatePersonRequest,
  classifyPersonOrgMutationResponse,
  classifyPersonOrgReadError,
  EMPLOYEE_CODE_MAX_LENGTH,
  formatOrgDate,
  formatOrgTimestamp,
  formatPersonSourceKind,
  FULL_NAME_MAX_LENGTH,
  newOrgIdempotencyKey,
  personStatusBadge,
  projectPersonDetailEnvelope,
  REASON_MAX_LENGTH,
  type PersonDetailProjection,
  type PersonOrgMutationOp,
  type PersonStatus,
} from "@/lib/admin/person-org-ui-model";

type PersonDetailLoadState =
  | { kind: "loading" }
  | { kind: "ready"; person: PersonDetailProjection; authorizationDate: string }
  | { kind: "denied"; message: string; unauthenticated: boolean }
  | { kind: "not-found"; message: string }
  | { kind: "error"; message: string; retryable: boolean };

type PersonDialogState =
  | { kind: "edit" }
  | { kind: "assign-dept" }
  | { kind: "transfer-dept" }
  | { kind: "end-dept" };

type PendingDetailIntent = {
  url: string;
  method: "PATCH" | "POST";
  op: PersonOrgMutationOp;
  body: Record<string, unknown>;
  idempotencyKey: string;
  message: string;
};

export function PersonDetailManager({ personId }: { personId: string }) {
  const notify = useNotify();

  const [state, setState] = useState<PersonDetailLoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const reqSeqRef = useRef(0);

  const [dialog, setDialog] = useState<PersonDialogState | null>(null);
  const [employeeCode, setEmployeeCode] = useState("");
  const [fullName, setFullName] = useState("");
  const [joinedOn, setJoinedOn] = useState("");
  const [personStatus, setPersonStatus] = useState<PersonStatus>("ACTIVE");
  const [selectedTargetDept, setSelectedTargetDept] = useState<SelectedDepartmentOption | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [activeHeadBlockMsg, setActiveHeadBlockMsg] = useState<string | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingDetailIntent | null>(null);

  const handleSessionLost = useCallback((message: string, unauthenticated = false) => {
    setDialog(null);
    setPendingIntent(null);
    setState({ kind: "denied", message, unauthenticated });
  }, []);

  useEffect(() => {
    const reqSeq = ++reqSeqRef.current;
    const controller = new AbortController();
    void (async () => {
      setState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(`/api/admin/organization/persons/${encodeURIComponent(personId)}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (reqSeq !== reqSeqRef.current) return;
        setState({
          kind: "error",
          message: "Không thể kết nối máy chủ để tải chi tiết Nhân sự nội bộ.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted || reqSeq !== reqSeqRef.current) return;

      if (response.status !== 200) {
        const failure = classifyPersonOrgReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          handleSessionLost(failure.message, failure.kind === "unauthenticated");
          return;
        }
        if (failure.kind === "not-found") {
          setState({ kind: "not-found", message: failure.message });
          return;
        }
        setState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectPersonDetailEnvelope(payload, personId);
      if (!projected) {
        setState({
          kind: "error",
          message: "Phản hồi chi tiết Nhân sự nội bộ không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setState({
        kind: "ready",
        person: projected.person,
        authorizationDate: projected.authorization_date,
      });
    })();

    return () => controller.abort();
  }, [handleSessionLost, personId, reloadToken]);

  const reloadDetail = useCallback(() => {
    setPendingIntent(null);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setFormError(null);
    setReloadToken((v) => v + 1);
  }, []);

  const person = state.kind === "ready" ? state.person : null;

  const activeHeadAssignments = useMemo(
    () => (person ? person.head_assignments.filter((item) => item.ended_at === null) : []),
    [person],
  );

  const openEditDialog = () => {
    if (!person) return;
    setEmployeeCode(person.employee_code);
    setFullName(person.full_name);
    setJoinedOn(person.joined_on ?? "");
    setPersonStatus(person.status);
    setReason("");
    setFormError(null);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setPendingIntent(null);
    setDialog({ kind: "edit" });
  };

  const openDeptDialog = (kind: "assign-dept" | "transfer-dept" | "end-dept") => {
    setSelectedTargetDept(null);
    setReason("");
    setFormError(null);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setPendingIntent(null);
    setDialog({ kind });
  };

  const dispatchIntent = async (
    url: string,
    method: "PATCH" | "POST",
    op: PersonOrgMutationOp,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ) => {
    setBusy(true);
    setFormError(null);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    try {
      const response = await fetch(url, {
        method,
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      const outcome = classifyPersonOrgMutationResponse(response.status, payload, op);

      if (outcome.kind === "applied") {
        notify.success({
          title: outcome.message,
          dedupeKey: `wp4-person-detail:${personId}:${op}`,
        });
        setPendingIntent(null);
        setDialog(null);
        setReloadToken((v) => v + 1);
        return;
      }

      if (outcome.kind === "session-lost") {
        handleSessionLost(outcome.message, outcome.sessionState === "unauthenticated");
        return;
      }

      if (outcome.kind === "uncertain") {
        setPendingIntent({
          url,
          method,
          op,
          body,
          idempotencyKey,
          message: outcome.message,
        });
        return;
      }

      setPendingIntent(null);
      if (outcome.kind === "active-head-block") {
        setActiveHeadBlockMsg(outcome.message);
        return;
      }
      if (outcome.kind === "conflict") {
        setConflictMsg(outcome.message);
        return;
      }
      setFormError(outcome.message);
    } catch {
      setPendingIntent({
        url,
        method,
        op,
        body,
        idempotencyKey,
        message:
          "Mất kết nối trong lúc lưu thay đổi. Đã giữ nguyên dữ liệu và khóa idempotency; bạn có thể thử lại đúng yêu cầu hoặc tải lại để đối chiếu.",
      });
    } finally {
      setBusy(false);
    }
  };

  const submitDialog = (event: FormEvent) => {
    event.preventDefault();
    if (!person || !dialog || busy || pendingIntent) return;
    const idempotencyKey = newOrgIdempotencyKey();

    if (dialog.kind === "edit") {
      const req = buildUpdatePersonRequest({
        expectedPersonVersion: person.version,
        employeeCode,
        fullName,
        joinedOn: joinedOn || null,
        status: personStatus,
        reason,
        idempotencyKey,
      });
      if (!req.ok) {
        setFormError(req.message);
        return;
      }
      void dispatchIntent(
        `/api/admin/organization/persons/${encodeURIComponent(person.person_id)}`,
        "PATCH",
        "update",
        req.body,
        req.idempotencyKey,
      );
      return;
    }

    if (dialog.kind === "assign-dept") {
      if (!selectedTargetDept) {
        setFormError("Vui lòng chọn phòng ban cần gán từ danh sách.");
        return;
      }
      const req = buildAssignPersonDepartmentRequest({
        personId: person.person_id,
        expectedPersonVersion: person.version,
        reason,
        idempotencyKey,
      });
      if (!req.ok) {
        setFormError(req.message);
        return;
      }
      void dispatchIntent(
        `/api/admin/departments/${encodeURIComponent(selectedTargetDept.department_id)}/memberships`,
        "POST",
        "assign-department",
        req.body,
        req.idempotencyKey,
      );
      return;
    }

    if (dialog.kind === "transfer-dept") {
      if (!person.active_department) {
        setFormError("Nhân sự chưa có phòng ban hiện hành để chuyển.");
        return;
      }
      if (!selectedTargetDept) {
        setFormError("Vui lòng chọn phòng ban đích từ danh sách.");
        return;
      }
      const req = buildTransferPersonDepartmentRequest({
        targetDepartmentRef: selectedTargetDept.department_id,
        expectedPersonVersion: person.version,
        expectedCurrentMembershipId: person.active_department.membership_id,
        reason,
        idempotencyKey,
      });
      if (!req.ok) {
        setFormError(req.message);
        return;
      }
      void dispatchIntent(
        `/api/admin/organization/persons/${encodeURIComponent(person.person_id)}/transfer-department`,
        "POST",
        "transfer-department",
        req.body,
        req.idempotencyKey,
      );
      return;
    }

    if (dialog.kind === "end-dept") {
      if (!person.active_department) {
        setFormError("Nhân sự không có thành viên phòng ban đang hiệu lực.");
        return;
      }
      const req = buildEndPersonDepartmentRequest({
        expectedPersonVersion: person.version,
        reason,
        idempotencyKey,
      });
      if (!req.ok) {
        setFormError(req.message);
        return;
      }
      void dispatchIntent(
        `/api/admin/departments/${encodeURIComponent(person.active_department.department_id)}/memberships/${encodeURIComponent(person.active_department.membership_id)}/end`,
        "POST",
        "end-department",
        req.body,
        req.idempotencyKey,
      );
    }
  };

  const isDialogLocked = busy || pendingIntent !== null;
  const statusMeta = person ? personStatusBadge(person.status) : null;

  return (
    <PageShell
      dataTestId="person-detail-page"
      className="max-w-none px-0 py-0 sm:px-0 sm:py-0 lg:px-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/admin/organization/persons"
          className="inline-flex min-h-10 items-center text-sm font-medium text-primary hover:underline"
        >
          ← Quay lại Nhân sự nội bộ
        </Link>
        <Button
          variant="secondary"
          size="sm"
          onClick={reloadDetail}
          disabled={state.kind === "loading"}
        >
          Tải lại hồ sơ
        </Button>
      </div>

      {state.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải chi tiết Nhân sự nội bộ…
          </p>
        </Card>
      ) : null}

      {state.kind === "denied" ? (
        <Alert
          tone="error"
          role="alert"
          title={state.unauthenticated ? "Phiên đăng nhập đã hết hạn" : "Không có quyền truy cập"}
        >
          <p>{state.message}</p>
          {state.unauthenticated ? (
            <div className="mt-2">
              <Link
                href={`/login?next=${encodeURIComponent(`/admin/organization/persons/${personId}`)}`}
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                Đăng nhập lại
              </Link>
            </div>
          ) : null}
        </Alert>
      ) : null}

      {state.kind === "not-found" ? (
        <Card>
          <ErrorState title="Không tìm thấy hồ sơ nhân sự" detail={state.message} />
        </Card>
      ) : null}

      {state.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState title="Không tải được hồ sơ nhân sự" detail={state.message} />
            {state.retryable ? (
              <div>
                <Button variant="secondary" onClick={reloadDetail}>
                  Thử tải lại
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {person && statusMeta ? (
        <>
          <PageHeader
            eyebrow={`Mã nhân sự: ${person.employee_code}`}
            title={person.full_name}
            badge={
              <StatusBadge tone={statusMeta.tone} dot>
                {statusMeta.label}
              </StatusBadge>
            }
            description={`Ngày gia nhập: ${formatOrgDate(person.joined_on)} · Ngày hiệu lực tổ chức: ${formatOrgDate(state.kind === "ready" ? state.authorizationDate : null)}`}
            actions={
              <Button variant="primary" size="md" onClick={openEditDialog}>
                Sửa hồ sơ
              </Button>
            }
          />

          <StatusBanner tone="info" title="Trạng thái hồ sơ người độc lập với khóa tài khoản">
            Chuyển trạng thái hồ sơ sang <strong>Ngừng hoạt động</strong> không tự khóa tài khoản
            đăng nhập liên kết. Nếu nhân sự nghỉ việc cần chặn đăng nhập hệ thống, hãy khóa tài
            khoản riêng tại{" "}
            <Link href="/admin/access/accounts" className="font-medium underline">
              Tài khoản truy cập
            </Link>
            .
          </StatusBanner>

          {activeHeadAssignments.length > 0 ? (
            <Alert tone="warning" title="Đang giữ chức danh Trưởng phòng">
              Nhân sự này hiện đang là Trưởng phòng tại{" "}
              {activeHeadAssignments.map((head, index) => (
                <span key={head.head_assignment_id}>
                  {index > 0 ? ", " : ""}
                  <Link
                    href={`/admin/departments/${encodeURIComponent(head.department_id)}`}
                    className="font-semibold underline"
                  >
                    {head.name}
                  </Link>
                </span>
              ))}
              . Bạn phải kết thúc hoặc thay thế chức danh Trưởng phòng tại trang Phòng ban trước
              khi chuyển phòng, kết thúc phòng ban hoặc ngừng hoạt động hồ sơ người.
            </Alert>
          ) : null}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Phòng ban hiện hành"
                description="Mỗi nhân sự chỉ thuộc tối đa một phòng ban chính tại một thời điểm."
              />
              {person.active_department ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-border bg-surface-muted/40 p-3.5 text-sm space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link
                        href={`/admin/departments/${encodeURIComponent(person.active_department.department_id)}`}
                        className="text-base font-semibold text-foreground hover:text-primary hover:underline"
                      >
                        {person.active_department.name}
                      </Link>
                      <span className="font-mono text-xs text-muted">
                        {person.active_department.code}
                      </span>
                    </div>
                    <p className="text-xs text-muted">
                      Bắt đầu: {formatOrgTimestamp(person.active_department.started_at)} ·{" "}
                      {formatPersonSourceKind(
                        person.active_department.source_kind,
                        person.active_department.evidence_date,
                      )}
                    </p>
                  </div>
                  {person.status === "ACTIVE" ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openDeptDialog("transfer-dept")}
                      >
                        Chuyển phòng ban
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => openDeptDialog("end-dept")}
                      >
                        Kết thúc phòng ban
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted">
                      Hồ sơ đang ở trạng thái Ngừng hoạt động nên không thể chuyển phòng ban.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted">Nhân sự hiện chưa thuộc phòng ban nào.</p>
                  {person.status === "ACTIVE" ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => openDeptDialog("assign-dept")}
                    >
                      Gán phòng ban
                    </Button>
                  ) : (
                    <p className="text-xs text-muted">
                      Cần kích hoạt lại hồ sơ người trước khi gán phòng ban.
                    </p>
                  )}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Tài khoản đăng nhập liên kết"
                description="Quản lý nối/ngắt liên kết hoặc đổi phân loại NORMAL/SHARED/SERVICE tại Tài khoản truy cập."
              />
              {person.active_account_link ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border bg-surface-muted/40 p-3.5 text-sm space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-foreground">
                        {person.active_account_link.display_name ??
                          person.active_account_link.login_id ??
                          "Tài khoản đang liên kết"}
                      </p>
                      <StatusBadge
                        tone={person.active_account_link.enabled ? "success" : "warning"}
                      >
                        {person.active_account_link.enabled
                          ? "Đang mở đăng nhập"
                          : "Đã khóa đăng nhập"}
                      </StatusBadge>
                    </div>
                    {person.active_account_link.login_id ? (
                      <p className="font-mono text-xs text-muted">
                        Tên đăng nhập: {person.active_account_link.login_id}
                      </p>
                    ) : null}
                    <p className="text-xs text-muted">
                      Liên kết từ: {formatOrgTimestamp(person.active_account_link.started_at)} ·{" "}
                      {formatPersonSourceKind(
                        person.active_account_link.source_kind,
                        person.active_account_link.evidence_date,
                      )}
                    </p>
                  </div>
                  <Link
                    href="/admin/access/accounts"
                    className={buttonClasses({ variant: "secondary", size: "sm" })}
                  >
                    Quản trị tại Tài khoản truy cập
                  </Link>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted">
                    Hồ sơ nhân sự này chưa được liên kết với tài khoản đăng nhập nào.
                  </p>
                  <Link
                    href="/admin/access/accounts"
                    className={buttonClasses({ variant: "secondary", size: "sm" })}
                  >
                    Mở Tài khoản truy cập để liên kết
                  </Link>
                </div>
              )}
            </Card>
          </div>

          <section className="space-y-2.5">
            <h2 className="text-base font-semibold text-foreground">
              Lịch sử phòng ban ({person.department_history.length})
            </h2>
            {person.department_history.length === 0 ? (
              <Card>
                <p className="text-sm text-muted">Chưa có lịch sử tham gia phòng ban.</p>
              </Card>
            ) : (
              <DataTableContainer>
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
                        Bắt đầu
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Kết thúc
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Nguồn ghi nhận
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {person.department_history.map((item) => (
                      <tr key={item.membership_id} className={DATA_TABLE_ROW_CLASS}>
                        <td data-label="Phòng ban" className={DATA_TABLE_TD_CLASS}>
                          <Link
                            href={`/admin/departments/${encodeURIComponent(item.department_id)}`}
                            className="font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {item.name}
                          </Link>
                          <p className="font-mono text-xs text-muted">{item.code}</p>
                        </td>
                        <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                          <StatusBadge tone={item.ended_at === null ? "success" : "neutral"}>
                            {item.ended_at === null ? "Đang hiệu lực" : "Đã kết thúc"}
                          </StatusBadge>
                        </td>
                        <td data-label="Bắt đầu" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                          {formatOrgTimestamp(item.started_at)}
                        </td>
                        <td data-label="Kết thúc" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                          {item.ended_at ? formatOrgTimestamp(item.ended_at) : "—"}
                        </td>
                        <td data-label="Nguồn ghi nhận" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                          {formatPersonSourceKind(item.source_kind, item.evidence_date)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTableContainer>
            )}
          </section>

          <section className="space-y-2.5">
            <h2 className="text-base font-semibold text-foreground">
              Lịch sử chức danh Trưởng phòng ({person.head_assignments.length})
            </h2>
            {person.head_assignments.length === 0 ? (
              <Card>
                <p className="text-sm text-muted">
                  Nhân sự chưa từng được bổ nhiệm chức danh Trưởng phòng.
                </p>
              </Card>
            ) : (
              <DataTableContainer>
                <table className={DATA_TABLE_CLASS}>
                  <thead className={DATA_TABLE_HEAD_CLASS}>
                    <tr>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Phòng ban phụ trách
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Trạng thái chức danh
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Bắt đầu
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Kết thúc
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Nguồn ghi nhận
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {person.head_assignments.map((item) => (
                      <tr key={item.head_assignment_id} className={DATA_TABLE_ROW_CLASS}>
                        <td data-label="Phòng ban phụ trách" className={DATA_TABLE_TD_CLASS}>
                          <Link
                            href={`/admin/departments/${encodeURIComponent(item.department_id)}`}
                            className="font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {item.name}
                          </Link>
                          <p className="font-mono text-xs text-muted">{item.code}</p>
                        </td>
                        <td data-label="Trạng thái chức danh" className={DATA_TABLE_TD_CLASS}>
                          <StatusBadge tone={item.ended_at === null ? "primary" : "neutral"}>
                            {item.ended_at === null ? "Đang giữ chức danh" : "Đã kết thúc"}
                          </StatusBadge>
                        </td>
                        <td data-label="Bắt đầu" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                          {formatOrgTimestamp(item.started_at)}
                        </td>
                        <td data-label="Kết thúc" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                          {item.ended_at ? formatOrgTimestamp(item.ended_at) : "—"}
                        </td>
                        <td data-label="Nguồn ghi nhận" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                          {formatPersonSourceKind(item.source_kind, item.evidence_date)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTableContainer>
            )}
          </section>
        </>
      ) : null}

      <FormDialog
        open={dialog !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) {
            setDialog(null);
            setPendingIntent(null);
          }
        }}
        closeDisabled={busy}
        title={
          dialog?.kind === "edit"
            ? "Sửa hồ sơ Nhân sự nội bộ"
            : dialog?.kind === "assign-dept"
              ? "Gán phòng ban ngay"
              : dialog?.kind === "transfer-dept"
                ? "Chuyển phòng ban ngay"
                : "Kết thúc thành viên phòng ban"
        }
        description="Mọi thay đổi áp dụng ngay tại thời điểm xác nhận; không đặt lịch tương lai."
        descriptionId="person-detail-dialog-desc"
      >
        {pendingIntent ? (
          <Alert tone="warning" role="alert" title="Chưa nhận được xác nhận từ máy chủ">
            <p>{pendingIntent.message}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void dispatchIntent(
                    pendingIntent.url,
                    pendingIntent.method,
                    pendingIntent.op,
                    pendingIntent.body,
                    pendingIntent.idempotencyKey,
                  )
                }
              >
                {busy ? "Đang thử lại…" : "Thử lại đúng yêu cầu"}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={reloadDetail}>
                Tải lại để đối chiếu
              </Button>
            </div>
          </Alert>
        ) : null}

        {conflictMsg ? (
          <Alert tone="warning" role="alert" title="Hồ sơ vừa được cập nhật">
            <p>{conflictMsg}</p>
            <div className="mt-2">
              <Button variant="secondary" size="sm" onClick={reloadDetail}>
                Tải bản mới nhất
              </Button>
            </div>
          </Alert>
        ) : null}

        {activeHeadBlockMsg ? (
          <Alert tone="error" role="alert" title="Đang giữ chức danh Trưởng phòng">
            <p>{activeHeadBlockMsg}</p>
            {activeHeadAssignments[0] ? (
              <div className="mt-2">
                <Link
                  href={`/admin/departments/${encodeURIComponent(activeHeadAssignments[0].department_id)}`}
                  className={buttonClasses({ variant: "secondary", size: "sm" })}
                >
                  Mở {activeHeadAssignments[0].name} để xử lý Trưởng phòng
                </Link>
              </div>
            ) : null}
          </Alert>
        ) : null}

        <form onSubmit={submitDialog} className="mt-3 space-y-4">
          {dialog?.kind === "edit" ? (
            <>
              <div>
                <label
                  htmlFor="edit-person-employee-code"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  Mã nhân sự nội bộ <span className="text-red-600">*</span>
                </label>
                <input
                  id="edit-person-employee-code"
                  type="text"
                  required
                  maxLength={EMPLOYEE_CODE_MAX_LENGTH}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={isDialogLocked}
                  value={employeeCode}
                  onChange={(event) => setEmployeeCode(event.target.value)}
                  placeholder="Nhập mã nhân sự nội bộ (2–64 ký tự)"
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                />
              </div>

              <div>
                <label
                  htmlFor="edit-person-full-name"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  Họ và tên <span className="text-red-600">*</span>
                </label>
                <input
                  id="edit-person-full-name"
                  type="text"
                  required
                  maxLength={FULL_NAME_MAX_LENGTH}
                  disabled={isDialogLocked}
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="edit-person-joined-on"
                    className="mb-1 block text-sm font-medium text-foreground"
                  >
                    Ngày gia nhập (tùy chọn)
                  </label>
                  <input
                    id="edit-person-joined-on"
                    type="date"
                    disabled={isDialogLocked}
                    value={joinedOn}
                    onChange={(event) => setJoinedOn(event.target.value)}
                    className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                  />
                </div>

                <div>
                  <label
                    htmlFor="edit-person-status"
                    className="mb-1 block text-sm font-medium text-foreground"
                  >
                    Trạng thái hồ sơ
                  </label>
                  <select
                    id="edit-person-status"
                    disabled={isDialogLocked}
                    value={personStatus}
                    onChange={(event) => setPersonStatus(event.target.value as PersonStatus)}
                    className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                  >
                    <option value="ACTIVE">Đang hoạt động (ACTIVE)</option>
                    <option value="INACTIVE">Ngừng hoạt động (INACTIVE)</option>
                  </select>
                </div>
              </div>

              {personStatus === "INACTIVE" ? (
                <StatusBanner tone="warning" title="Lưu ý khi ngừng hoạt động hồ sơ người">
                  Ngừng hoạt động hồ sơ nhân sự nội bộ không tự khóa tài khoản đăng nhập. Nếu nhân
                  sự đang là Trưởng phòng, phải kết thúc chức danh Trưởng phòng trước.
                </StatusBanner>
              ) : null}
            </>
          ) : null}

          {dialog?.kind === "assign-dept" || dialog?.kind === "transfer-dept" ? (
            <DepartmentSelectPicker
              id="person-target-department"
              label={dialog.kind === "assign-dept" ? "Chọn phòng ban" : "Chọn phòng ban đích"}
              selectedId={selectedTargetDept?.department_id ?? null}
              onSelect={(dept) => setSelectedTargetDept(dept)}
              excludeDepartmentId={
                dialog.kind === "transfer-dept"
                  ? person?.active_department?.department_id ?? null
                  : null
              }
              allowClear={false}
              emptyLabel="Không có phòng ban khả dụng"
              disabled={isDialogLocked}
              onSessionLost={(msg) => handleSessionLost(msg)}
            />
          ) : null}

          {dialog?.kind === "end-dept" && person?.active_department ? (
            <Alert tone="warning" title="Xác nhận kết thúc phòng ban hiện hành">
              Nhân sự <strong>{person.full_name}</strong> sẽ kết thúc tư cách thành viên tại{" "}
              <strong>{person.active_department.name}</strong> ngay lập tức. Nếu đang giữ chức
              danh Trưởng phòng, vui lòng kết thúc chức danh Trưởng phòng trước.
            </Alert>
          ) : null}

          <div>
            <label
              htmlFor="person-detail-reason"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              Lý do thao tác <span className="text-red-600">*</span>
            </label>
            <textarea
              id="person-detail-reason"
              required
              rows={2}
              maxLength={REASON_MAX_LENGTH}
              disabled={isDialogLocked}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Nhập lý do thay đổi (1–500 ký tự)…"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
            />
          </div>

          {formError ? (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">
              {formError}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setDialog(null);
                setPendingIntent(null);
              }}
            >
              Hủy
            </Button>
            <Button type="submit" variant="primary" disabled={isDialogLocked}>
              {busy ? "Đang lưu…" : "Xác nhận"}
            </Button>
          </div>
        </form>
      </FormDialog>
    </PageShell>
  );
}
