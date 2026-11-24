"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { AccountGroupsSection } from "@/components/admin/account-groups-section";
import {
  DepartmentSelectPicker,
  PersonSearchPicker,
  RecruiterConfirmPicker,
  type SelectedDepartmentOption,
} from "@/components/admin/org-entity-picker";
import { useWp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import {
  buildAccountStateRequest,
  buildLinkAccountPersonRequest,
  classifyAccountMutation,
  classifyAccountOrgMutation,
  newAccountIntentKey,
} from "@/lib/admin/account-access-model";
import {
  buildEditDisplayNameRequest,
  buildResetPasswordRequest,
  classifyAccountOperationResponse,
  newAccountOperationKey,
} from "@/lib/admin/account-operation-ui-model";
import {
  buildCreatePersonRequest,
  classifyPersonOrgMutationResponse,
  classifyPersonOrgReadError,
  EMPLOYEE_CODE_MAX_LENGTH,
  FULL_NAME_MAX_LENGTH,
  newOrgIdempotencyKey,
  REASON_MAX_LENGTH,
  type MutatePersonRpcProjection,
  type PersonSummaryProjection,
} from "@/lib/admin/person-org-ui-model";
import {
  formatUserDirectoryConflictReason,
  projectUserDirectoryEntryEnvelope,
  userDirectoryLoginBadge,
  type UserDirectoryEntryDetail,
} from "@/lib/admin/user-directory-ui-model";
import type { AdminPersonnel } from "@/lib/direct-entry/personnel-catalog-contract";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; entry: UserDirectoryEntryDetail }
  | { kind: "not-found"; message: string }
  | { kind: "denied"; message: string; unauthenticated: boolean }
  | { kind: "error"; message: string; retryable: boolean };

type CompleteProfileMode = "create" | "link-existing";

type DialogKind =
  | { kind: "complete-profile"; expectedVersion: number }
  | { kind: "edit-display-name"; expectedVersion: number }
  | { kind: "toggle-login"; nextEnabled: boolean; expectedVersion: number }
  | { kind: "reset-password"; manualCheckLocked: boolean };

const DEFAULT_CREATE_PERSON_REASON =
  "Hoàn thiện hồ sơ nhân viên và phòng ban cho tài khoản hiện hữu";
const DEFAULT_LINK_PERSON_REASON =
  "Liên kết tài khoản đăng nhập hiện hữu với hồ sơ nhân viên";

export function AccountDirectoryDetailManager({
  accountRef,
  canManageGroups = true,
  onNavigateToPerson,
}: {
  accountRef: string;
  canManageGroups?: boolean;
  onNavigateToPerson?: (personId: string) => void;
}) {
  const notify = useNotify();
  const workspaceGuard = useWp4WorkspaceGuard();
  const reasonId = useId();
  const displayNameId = useId();
  const pwdId = useId();
  const pwdConfirmId = useId();
  const employeeCodeId = useId();
  const fullNameId = useId();
  const joinedOnId = useId();
  const completeReasonId = useId();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [latestAccountVersion, setLatestAccountVersion] = useState<number | null>(null);
  const [completedPersonNotice, setCompletedPersonNotice] = useState<{
    personId: string;
    fullName: string;
    employeeCode: string | null;
  } | null>(null);

  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [completeMode, setCompleteMode] = useState<CompleteProfileMode>("create");
  const [employeeCodeInput, setEmployeeCodeInput] = useState("");
  const [fullNameInput, setFullNameInput] = useState("");
  const [joinedOnInput, setJoinedOnInput] = useState("");
  const [selectedDepartment, setSelectedDepartment] = useState<SelectedDepartmentOption | null>(null);
  const [selectedExistingPerson, setSelectedExistingPerson] =
    useState<PersonSummaryProjection | null>(null);
  const [needsRecruiterConfirm, setNeedsRecruiterConfirm] = useState(false);
  const [confirmedRecruiter, setConfirmedRecruiter] = useState<AdminPersonnel | null>(null);
  const [pendingCompleteKey, setPendingCompleteKey] = useState<string | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [reason, setReason] = useState("");
  // In-memory password state — NEVER stored in local/session storage
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [pendingToggleKey, setPendingToggleKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "error" | "warning" | "info";
    title: string;
    message: string;
  } | null>(null);

  const reqSeqRef = useRef(0);
  const inFlightRef = useRef(false);

  const clearPasswords = useCallback(() => {
    setNewPassword("");
    setConfirmPassword("");
  }, []);

  useEffect(() => {
    return () => {
      inFlightRef.current = false;
      setNewPassword("");
      setConfirmPassword("");
    };
  }, []);

  const handleSessionLost = useCallback(
    (message: string, unauthenticated = false) => {
      inFlightRef.current = false;
      workspaceGuard.invalidateSession();
      reqSeqRef.current += 1;
      clearPasswords();
      setDialog(null);
      setBusy(false);
      setState({ kind: "denied", message, unauthenticated });
    },
    [clearPasswords, workspaceGuard],
  );

  useEffect(() => {
    const reqSeq = ++reqSeqRef.current;
    const tracked = workspaceGuard.trackController();

    void (async () => {
      await Promise.resolve();
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== reqSeqRef.current) {
        tracked.release();
        return;
      }
      setState({ kind: "loading" });
      try {
        const response = await fetch(
          `/api/admin/organization/user-directory/detail?account_ref=${encodeURIComponent(accountRef)}`,
          {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== reqSeqRef.current) {
          return;
        }
        const payload = await response.json().catch(() => null);
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== reqSeqRef.current) {
          return;
        }
        if (response.status !== 200) {
          const err = classifyPersonOrgReadError(response.status, payload);
          if (err.kind === "unauthenticated" || err.kind === "denied") {
            handleSessionLost(err.message, err.kind === "unauthenticated");
            return;
          }
          if (err.kind === "not-found") {
            setState({ kind: "not-found", message: err.message });
            return;
          }
          setState({ kind: "error", message: err.message, retryable: err.retryable });
          return;
        }
        const projected = projectUserDirectoryEntryEnvelope(payload);
        if (!projected || !projected.entry.account) {
          setState({
            kind: "error",
            message: "Phản hồi chi tiết tài khoản chưa đầy đủ.",
            retryable: true,
          });
          return;
        }
        setLatestAccountVersion(projected.entry.account.version);
        setState({ kind: "ready", entry: projected.entry });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== reqSeqRef.current) {
          return;
        }
        setState({
          kind: "error",
          message: "Không thể kết nối máy chủ để tải thông tin người dùng.",
          retryable: true,
        });
      } finally {
        tracked.release();
      }
    })();

    return () => {
      reqSeqRef.current += 1;
      tracked.controller.abort();
      tracked.release();
    };
  }, [accountRef, handleSessionLost, reloadToken, workspaceGuard]);

  const reloadNow = useCallback(() => {
    setReloadToken((v) => v + 1);
  }, []);

  const closeDialog = useCallback(() => {
    if (busy) return;
    clearPasswords();
    setDialog(null);
    setReason("");
    setPendingToggleKey(null);
    setPendingCompleteKey(null);
    setConflictLocked(false);
    setFeedback(null);
    setSelectedDepartment(null);
    setSelectedExistingPerson(null);
    setNeedsRecruiterConfirm(false);
    setConfirmedRecruiter(null);
  }, [busy, clearPasswords]);

  const entry = state.kind === "ready" ? state.entry : null;
  const account = entry?.account ?? null;
  const effectiveVersion = latestAccountVersion ?? account?.version ?? 1;

  const openCompleteProfileDialog = useCallback(() => {
    if (!entry || !account || entry.person || entry.link_conflict || busy) return;
    setCompleteMode("create");
    setEmployeeCodeInput("");
    setFullNameInput(account.display_name ?? entry.display_name ?? "");
    setJoinedOnInput("");
    setSelectedDepartment(null);
    setSelectedExistingPerson(null);
    setNeedsRecruiterConfirm(false);
    setConfirmedRecruiter(null);
    setReason(DEFAULT_CREATE_PERSON_REASON);
    setPendingCompleteKey(null);
    setConflictLocked(false);
    setFeedback(null);
    setDialog({
      kind: "complete-profile",
      expectedVersion: effectiveVersion,
    });
  }, [account, busy, effectiveVersion, entry]);

  const recheckCompleteProfileStatus = async () => {
    if (busy || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    const tracked = workspaceGuard.trackController();
    try {
      const response = await fetch(
        `/api/admin/organization/user-directory/detail?account_ref=${encodeURIComponent(accountRef)}`,
        {
          method: "GET",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: { Accept: "application/json" },
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      if (response.status !== 200) {
        const err = classifyPersonOrgReadError(response.status, payload);
        if (err.kind === "unauthenticated" || err.kind === "denied") {
          handleSessionLost(err.message, err.kind === "unauthenticated");
          return;
        }
        setFeedback({
          tone: "warning",
          title: "Không thể kiểm tra lại trạng thái trên máy chủ",
          message: err.message,
        });
        return;
      }
      const projected = projectUserDirectoryEntryEnvelope(payload);
      if (!projected || !projected.entry.account) {
        setFeedback({
          tone: "warning",
          title: "Phản hồi kiểm tra trạng thái chưa đầy đủ",
          message: "Yêu cầu đang chờ vẫn được giữ nguyên để thử lại an toàn.",
        });
        return;
      }
      setLatestAccountVersion(projected.entry.account.version);
      setState({ kind: "ready", entry: projected.entry });
      if (projected.entry.person_id && projected.entry.person) {
        const linkedPersonId = projected.entry.person_id;
        setPendingCompleteKey(null);
        setDialog(null);
        setFeedback(null);
        setCompletedPersonNotice({
          personId: linkedPersonId,
          fullName: projected.entry.person.full_name,
          employeeCode: projected.entry.person.employee_code,
        });
        notify.success({
          title: "Hồ sơ nhân viên đã được hoàn thiện trước đó",
          description: "Tài khoản này đã gắn với hồ sơ nhân viên đầy đủ.",
        });
        onNavigateToPerson?.(linkedPersonId);
        return;
      }
      setFeedback({
        tone: "info",
        title: "Tài khoản vẫn chưa có hồ sơ nhân viên",
        message:
          "Hệ thống vẫn giữ nguyên thông tin vừa nhập. Bạn có thể bấm gửi lại ngay để hoàn thiện an toàn mà không tạo trùng.",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối khi kiểm tra lại",
        message: "Yêu cầu đang chờ vẫn được giữ nguyên để bạn thử lại an toàn.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const submitCompleteProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !dialog ||
      dialog.kind !== "complete-profile" ||
      !account ||
      inFlightRef.current ||
      busy ||
      conflictLocked
    ) {
      return;
    }

    if (completeMode === "create") {
      const idempotencyKey = pendingCompleteKey ?? newOrgIdempotencyKey();
      const built = buildCreatePersonRequest({
        employeeCode: employeeCodeInput,
        fullName: fullNameInput,
        joinedOn: joinedOnInput || null,
        initialDepartmentRef: selectedDepartment?.department_id ?? null,
        accountRef: account.account_ref,
        expectedAccountVersion: dialog.expectedVersion,
        recruiterId: null,
        reason,
        idempotencyKey,
      });
      if (!built.ok) {
        setFeedback({ tone: "error", title: "Thông tin nhân viên chưa hợp lệ", message: built.message });
        return;
      }

      setPendingCompleteKey(built.idempotencyKey);
      setFeedback(null);
      inFlightRef.current = true;
      setBusy(true);
      const tracked = workspaceGuard.trackController();
      try {
        const response = await fetch("/api/admin/organization/persons", {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": built.idempotencyKey,
          },
          body: JSON.stringify(built.body),
        });
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
        const payload = await response.json().catch(() => null);
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

        const outcome = classifyPersonOrgMutationResponse(response.status, payload, "create");
        if (outcome.kind === "session-lost") {
          handleSessionLost(outcome.message, outcome.sessionState === "unauthenticated");
          return;
        }
        if (outcome.kind === "applied") {
          const created = outcome.data as MutatePersonRpcProjection;
          const nextPersonId = created.person.person_id;
          setPendingCompleteKey(null);
          setDialog(null);
          setReason("");
          setFeedback(null);
          setCompletedPersonNotice({
            personId: nextPersonId,
            fullName: created.person.full_name,
            employeeCode: created.person.employee_code,
          });
          notify.success({
            title: "Đã bổ sung hồ sơ nhân viên",
            description:
              "Hồ sơ nhân viên và phòng ban đã được gắn trực tiếp vào tài khoản đăng nhập hiện hữu.",
          });
          onNavigateToPerson?.(nextPersonId);
          reloadNow();
          return;
        }
        if (outcome.kind === "conflict") {
          setPendingCompleteKey(null);
          setConflictLocked(true);
          setFeedback({
            tone: "warning",
            title: "Dữ liệu tài khoản đã thay đổi",
            message: outcome.message,
          });
          return;
        }
        if (
          outcome.kind === "business-error" &&
          outcome.code === "PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"
        ) {
          setPendingCompleteKey(null);
          setConflictLocked(true);
          setFeedback({
            tone: "warning",
            title: "Tài khoản đang giữ phân công Tổ đội hoặc Trưởng nhóm tuyển dụng",
            message: outcome.message,
          });
          return;
        }
        if (
          outcome.kind === "business-error" ||
          outcome.kind === "invalid" ||
          outcome.kind === "not-found" ||
          outcome.kind === "active-head-block"
        ) {
          setPendingCompleteKey(null);
          setFeedback({
            tone: "error",
            title: "Không thể hoàn thiện hồ sơ nhân viên",
            message: outcome.message,
          });
          return;
        }
        setFeedback({
          tone: "warning",
          title: "Chưa nhận được xác nhận từ máy chủ",
          message:
            "Hệ thống đã giữ nguyên yêu cầu vừa gửi để tránh tạo trùng. Hãy kiểm tra lại trạng thái trên máy chủ hoặc thử gửi lại.",
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
        setFeedback({
          tone: "warning",
          title: "Mất kết nối trong lúc lưu hồ sơ nhân viên",
          message:
            "Chưa rõ máy chủ đã lưu hồ sơ hay chưa. Hãy kiểm tra lại trạng thái hoặc bấm gửi lại để đồng bộ an toàn mà không tạo trùng.",
        });
      } finally {
        tracked.release();
        inFlightRef.current = false;
        setBusy(false);
      }
      return;
    }

    // Mode: link-existing (explicit manual selection of an unlinked Person — zero auto-matching)
    if (!selectedExistingPerson) {
      setFeedback({
        tone: "error",
        title: "Chưa chọn hồ sơ nhân viên",
        message: "Hãy tìm và chọn thủ công đúng hồ sơ nhân viên chưa gắn tài khoản từ danh sách.",
      });
      return;
    }
    if (needsRecruiterConfirm && !confirmedRecruiter) {
      setFeedback({
        tone: "error",
        title: "Cần xác nhận hồ sơ tính công tuyển dụng",
        message:
          "Tài khoản và hồ sơ nhân viên đang có thông tin tuyển dụng khác nhau. Vui lòng chọn đúng hồ sơ tính công cần giữ trước khi liên kết.",
      });
      return;
    }

    const idempotencyKey = pendingCompleteKey ?? newAccountIntentKey();
    const built = buildLinkAccountPersonRequest({
      personId: selectedExistingPerson.person_id,
      expectedAccountVersion: dialog.expectedVersion,
      expectedPersonVersion: selectedExistingPerson.version,
      confirmedRecruiterId: confirmedRecruiter?.recruiter_id ?? null,
      reason,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", title: "Thông tin liên kết chưa hợp lệ", message: built.message });
      return;
    }

    setPendingCompleteKey(built.idempotencyKey);
    setFeedback(null);
    inFlightRef.current = true;
    setBusy(true);
    const tracked = workspaceGuard.trackController();
    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(account.account_ref)}/person-link`,
        {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": built.idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

      const outcome = classifyAccountOrgMutation(response.status, payload, "link");
      if (outcome.kind === "session-lost") {
        handleSessionLost(outcome.message, response.status === 401);
        return;
      }
      if (outcome.kind === "applied") {
        const linkedPersonId = selectedExistingPerson.person_id;
        setPendingCompleteKey(null);
        setDialog(null);
        setReason("");
        setFeedback(null);
        setCompletedPersonNotice({
          personId: linkedPersonId,
          fullName: selectedExistingPerson.full_name,
          employeeCode: selectedExistingPerson.employee_code,
        });
        notify.success({
          title: "Đã gắn tài khoản vào hồ sơ nhân viên",
          description: `Tài khoản hiện đã liên kết với ${selectedExistingPerson.full_name} (${selectedExistingPerson.employee_code}).`,
        });
        onNavigateToPerson?.(linkedPersonId);
        reloadNow();
        return;
      }
      if (outcome.kind === "recruiter-mismatch") {
        setPendingCompleteKey(null);
        setNeedsRecruiterConfirm(true);
        setFeedback({
          tone: "warning",
          title: "Cần xác nhận hồ sơ tính công tuyển dụng",
          message: outcome.message,
        });
        return;
      }
      if (outcome.kind === "active-team-assignment") {
        setPendingCompleteKey(null);
        setConflictLocked(true);
        setFeedback({
          tone: "warning",
          title: "Nhân sự hoặc tài khoản đang giữ phân công Tổ đội hoặc Trưởng nhóm",
          message: outcome.message,
        });
        return;
      }
      if (outcome.kind === "conflict") {
        setPendingCompleteKey(null);
        setConflictLocked(true);
        setFeedback({
          tone: "warning",
          title: "Dữ liệu đã thay đổi",
          message: outcome.message,
        });
        return;
      }
      if (
        outcome.kind === "hard-conflict" ||
        outcome.kind === "link-forbidden" ||
        outcome.kind === "personal-assignments-block" ||
        outcome.kind === "invalid"
      ) {
        setPendingCompleteKey(null);
        setFeedback({
          tone: "error",
          title: "Không thể gắn tài khoản vào hồ sơ đã chọn",
          message: outcome.message,
        });
        return;
      }
      setFeedback({
        tone: "warning",
        title: "Chưa nhận được xác nhận từ máy chủ",
        message:
          "Hệ thống đã giữ nguyên yêu cầu vừa gửi. Hãy kiểm tra lại trạng thái trên máy chủ hoặc thử gửi lại để đồng bộ an toàn.",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối trong lúc liên kết hồ sơ",
        message:
          "Chưa rõ máy chủ đã liên kết hay chưa. Hãy kiểm tra lại trạng thái hoặc bấm gửi lại để đồng bộ an toàn.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const submitEditDisplayName = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !dialog ||
      dialog.kind !== "edit-display-name" ||
      !account ||
      inFlightRef.current ||
      busy ||
      conflictLocked
    ) {
      return;
    }
    const idempotencyKey = pendingToggleKey ?? newAccountOperationKey();
    const built = buildEditDisplayNameRequest({
      displayName: displayNameInput,
      expectedVersion: dialog.expectedVersion,
      reason,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", title: "Tên hiển thị chưa hợp lệ", message: built.message });
      return;
    }

    setPendingToggleKey(idempotencyKey);
    setFeedback(null);
    inFlightRef.current = true;
    setBusy(true);
    const tracked = workspaceGuard.trackController();
    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(account.account_ref)}/display-name`,
        {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

      const outcome = classifyAccountOperationResponse(response.status, payload, {
        operation: "edit_display_name",
        expectedAccountRef: accountRef,
      });
      if (outcome.kind === "denied") {
        handleSessionLost(outcome.message, response.status === 401);
        return;
      }
      if (outcome.kind === "applied") {
        setPendingToggleKey(null);
        setDialog(null);
        setReason("");
        notify.success({ title: "Đã cập nhật tên hiển thị" });
        reloadNow();
        return;
      }
      if (outcome.kind === "conflict") {
        setPendingToggleKey(null);
        setConflictLocked(true);
        setFeedback({ tone: "warning", title: "Dữ liệu đã thay đổi", message: outcome.message });
        return;
      }
      if (outcome.kind === "invalid") {
        setPendingToggleKey(null);
        setFeedback({ tone: "error", title: "Không thể cập nhật tên hiển thị", message: outcome.message });
        return;
      }
      setFeedback({
        tone: "warning",
        title: "Chưa nhận được xác nhận từ máy chủ",
        message: "Bấm lưu lần nữa để đồng bộ an toàn mà không bị trùng.",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối mạng",
        message: "Chưa rõ thay đổi đã lưu hay chưa. Bấm lưu lần nữa để đồng bộ an toàn.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const submitToggleLogin = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || dialog.kind !== "toggle-login" || !account || inFlightRef.current || busy || conflictLocked) {
      return;
    }

    const idempotencyKey = pendingToggleKey ?? newAccountIntentKey();
    const built = buildAccountStateRequest({
      expectedVersion: dialog.expectedVersion,
      reason,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", title: "Dữ liệu chưa hợp lệ", message: built.message });
      return;
    }

    setPendingToggleKey(idempotencyKey);
    setFeedback(null);
    inFlightRef.current = true;
    setBusy(true);
    const tracked = workspaceGuard.trackController();

    try {
      const action = dialog.nextEnabled ? "enable" : "disable";
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(account.account_ref)}/${action}`,
        {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

      const outcome = classifyAccountMutation(response.status, payload);
      if (outcome.kind === "unauthenticated" || outcome.kind === "denied" || outcome.kind === "actor-not-available") {
        handleSessionLost(outcome.message, outcome.kind === "unauthenticated");
        return;
      }
      if (outcome.kind === "applied") {
        setPendingToggleKey(null);
        setDialog(null);
        setReason("");
        notify.success({
          title: dialog.nextEnabled ? "Đã mở lại đăng nhập" : "Đã khóa đăng nhập",
          description: "Lịch sử làm việc và dữ liệu đã nộp vẫn được giữ nguyên.",
        });
        reloadNow();
        return;
      }
      if (outcome.kind === "conflict") {
        setPendingToggleKey(null);
        setConflictLocked(true);
        setFeedback({ tone: "warning", title: "Dữ liệu đã thay đổi", message: outcome.message });
        return;
      }
      if (outcome.kind === "invalid" || outcome.kind === "not-found") {
        setPendingToggleKey(null);
        setFeedback({ tone: "error", title: "Không thể cập nhật", message: outcome.message });
        return;
      }
      setFeedback({
        tone: "warning",
        title: "Chưa nhận được xác nhận từ máy chủ",
        message: "Bấm xác nhận lại để đồng bộ trạng thái an toàn mà không bị trùng.",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối mạng",
        message: "Chưa rõ thao tác đã lưu hay chưa. Bấm xác nhận lần nữa để đồng bộ an toàn.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const submitResetPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !dialog ||
      dialog.kind !== "reset-password" ||
      dialog.manualCheckLocked ||
      !account ||
      inFlightRef.current ||
      busy
    ) {
      return;
    }

    const resetKey = newAccountOperationKey();
    const built = buildResetPasswordRequest({
      password: newPassword,
      passwordConfirm: confirmPassword,
      reason,
      idempotencyKey: resetKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", title: "Mật khẩu chưa hợp lệ", message: built.message });
      return;
    }

    setFeedback(null);
    inFlightRef.current = true;
    setBusy(true);
    const tracked = workspaceGuard.trackController();

    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(account.account_ref)}/reset-password`,
        {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": resetKey,
          },
          body: JSON.stringify(built.body),
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

      const outcome = classifyAccountOperationResponse(response.status, payload, {
        operation: "reset_password",
      });
      if (outcome.kind === "denied") {
        handleSessionLost(outcome.message, response.status === 401);
        return;
      }
      if (outcome.kind === "applied") {
        clearPasswords();
        setDialog(null);
        setReason("");
        notify.success({
          title: "Đã đặt lại mật khẩu",
          description: "Người dùng sẽ dùng mật khẩu mới ở lần đăng nhập tiếp theo.",
        });
        return;
      }
      if (
        outcome.kind === "needs-reconcile" ||
        (outcome.kind === "unavailable" && outcome.manualCheckRequired)
      ) {
        // Never blindly retry Auth password writes on uncertain responses!
        clearPasswords();
        setDialog({ kind: "reset-password", manualCheckLocked: true });
        setFeedback({
          tone: "warning",
          title: "Cần xác minh mật khẩu trước khi thao tác tiếp",
          message: outcome.message,
        });
        return;
      }
      setFeedback({
        tone: outcome.kind === "invalid" ? "error" : "warning",
        title: "Không đặt lại được mật khẩu",
        message: outcome.message,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      clearPasswords();
      setDialog({ kind: "reset-password", manualCheckLocked: true });
      setFeedback({
        tone: "warning",
        title: "Mất kết nối trong lúc đặt lại mật khẩu",
        message:
          "Hệ thống không tự gửi lại yêu cầu đổi mật khẩu để tránh ghi đè ngoài ý muốn. Hãy kiểm tra lại trạng thái đăng nhập của người dùng trước khi thử lại.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  return (
    <PageShell
      dataTestId="account-directory-detail-page"
      className="max-w-none px-0 py-0 sm:px-0 sm:py-0 lg:px-0"
    >
      <div className="mb-3">
        <Link
          href="/admin/organization/persons"
          className="text-sm font-medium text-primary hover:underline"
        >
          ← Quay lại danh sách Người dùng
        </Link>
      </div>

      {state.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải thông tin người dùng…
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
        </Alert>
      ) : null}

      {state.kind === "not-found" ? (
        <Card>
          <ErrorState title="Không tìm thấy người dùng" detail={state.message} />
        </Card>
      ) : null}

      {state.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState title="Không tải được thông tin người dùng" detail={state.message} />
            {state.retryable ? (
              <Button type="button" variant="secondary" onClick={reloadNow}>
                Thử tải lại
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {entry && account ? (
        <div className="space-y-5">
          <PageHeader
            eyebrow="Quản trị hệ thống · Người dùng"
            title={entry.display_name}
            badge={
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={userDirectoryLoginBadge(entry.login_state).tone} dot>
                  {userDirectoryLoginBadge(entry.login_state).label}
                </StatusBadge>
                {entry.link_conflict ? (
                  <StatusBadge tone="warning">Cần kiểm tra xung đột</StatusBadge>
                ) : !entry.person ? (
                  <StatusBadge tone="info">Tài khoản chưa gắn hồ sơ nhân viên</StatusBadge>
                ) : null}
              </div>
            }
            description={
              account.login_id
                ? `Tên đăng nhập: ${account.login_id}`
                : "Tài khoản đăng nhập cá nhân hiện hữu trong hệ thống."
            }
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {entry.person_id && !entry.link_conflict ? (
                  <Link
                    href={`/admin/organization/persons/${encodeURIComponent(entry.person_id)}`}
                    className={buttonClasses({ variant: "primary", size: "md" })}
                  >
                    Mở hồ sơ nhân viên đầy đủ
                  </Link>
                ) : !entry.person && !entry.link_conflict ? (
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    onClick={openCompleteProfileDialog}
                  >
                    Bổ sung thông tin nhân viên
                  </Button>
                ) : null}
                <Button type="button" variant="secondary" size="md" onClick={reloadNow}>
                  Làm mới
                </Button>
              </div>
            }
          />

          {completedPersonNotice ? (
            <Alert tone="info" role="status" title="Đã hoàn thiện hồ sơ nhân viên">
              <p>
                Tài khoản hiện đã gắn trực tiếp với hồ sơ{" "}
                <strong>{completedPersonNotice.fullName}</strong>
                {completedPersonNotice.employeeCode ? (
                  <>
                    {" "}
                    (<span className="font-mono">{completedPersonNotice.employeeCode}</span>)
                  </>
                ) : null}
                .
              </p>
              <div className="mt-2">
                <Link
                  href={`/admin/organization/persons/${encodeURIComponent(completedPersonNotice.personId)}`}
                  className={buttonClasses({ variant: "primary", size: "sm" })}
                >
                  Mở hồ sơ nhân viên đầy đủ
                </Link>
              </div>
            </Alert>
          ) : null}

          {entry.link_conflict && entry.conflict_details ? (
            <Alert tone="warning" role="alert" title="Cần kiểm tra xung đột hồ sơ — tài khoản">
              <p>{formatUserDirectoryConflictReason(entry.conflict_details.reason)}</p>
              {entry.conflict_details.related_person_ids.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {entry.conflict_details.related_person_ids.map((pid) => (
                    <Link
                      key={pid}
                      href={`/admin/organization/persons/${encodeURIComponent(pid)}`}
                      className={buttonClasses({ variant: "secondary", size: "sm" })}
                    >
                      Mở hồ sơ liên quan
                    </Link>
                  ))}
                </div>
              ) : null}
            </Alert>
          ) : null}

          {!entry.person && !entry.link_conflict ? (
            <div data-testid="account-only-person-completion-card">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <CardHeader
                    title="Thông tin nhân viên & Phòng ban"
                    description="Tài khoản đăng nhập này chưa gắn hồ sơ nhân viên và phòng ban. Bạn có thể tạo hồ sơ nhân viên mới gắn trực tiếp vào tài khoản này (không tạo lại tài khoản đăng nhập) hoặc chọn thủ công một hồ sơ nhân viên chưa gắn tài khoản."
                  />
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={openCompleteProfileDialog}
                  >
                    Bổ sung thông tin nhân viên
                  </Button>
                </div>
              </Card>
            </div>
          ) : null}

          <Card>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <CardHeader
                title="Đăng nhập & Bảo mật"
                description="Khóa hoặc mở đăng nhập chỉ ảnh hưởng khả năng đăng nhập; lịch sử chấm công, nghỉ phép và báo cáo luôn được giữ nguyên."
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setDisplayNameInput(account.display_name ?? entry.display_name);
                    setReason("");
                    setFeedback(null);
                    setConflictLocked(false);
                    setPendingToggleKey(null);
                    setDialog({
                      kind: "edit-display-name",
                      expectedVersion: effectiveVersion,
                    });
                  }}
                >
                  Sửa tên hiển thị
                </Button>
                <Button
                  type="button"
                  variant={account.enabled ? "danger-outline" : "primary"}
                  size="sm"
                  onClick={() => {
                    setReason("");
                    setFeedback(null);
                    setConflictLocked(false);
                    setPendingToggleKey(null);
                    setDialog({
                      kind: "toggle-login",
                      nextEnabled: !account.enabled,
                      expectedVersion: effectiveVersion,
                    });
                  }}
                >
                  {account.enabled ? "Khóa đăng nhập" : "Mở đăng nhập"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    clearPasswords();
                    setReason("");
                    setFeedback(null);
                    setDialog({ kind: "reset-password", manualCheckLocked: false });
                  }}
                >
                  Đặt lại mật khẩu
                </Button>
              </div>
            </div>
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium text-muted">Tên hiển thị</dt>
                <dd className="mt-1 font-medium text-foreground">
                  {account.display_name ?? entry.display_name}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Tên đăng nhập</dt>
                <dd className="mt-1 font-mono text-xs text-foreground">
                  {account.login_id ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Trạng thái đăng nhập</dt>
                <dd className="mt-1">
                  <StatusBadge tone={account.enabled ? "success" : "warning"} dot>
                    {account.enabled ? "Đang mở đăng nhập" : "Đã khóa đăng nhập"}
                  </StatusBadge>
                </dd>
              </div>
            </dl>
          </Card>

          <AccountGroupsSection
            accountRef={account.account_ref}
            canManageGroups={canManageGroups}
            workspaceGuard={workspaceGuard}
            reloadToken={reloadToken}
            onSessionLost={handleSessionLost}
            onAccountVersionChanged={setLatestAccountVersion}
          />
        </div>
      ) : null}

      <FormDialog
        open={dialog?.kind === "edit-display-name"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title="Sửa tên hiển thị"
        description="Cập nhật tên hiển thị của người dùng trên toàn hệ thống."
        closeDisabled={busy}
      >
        {dialog?.kind === "edit-display-name" ? (
          <form onSubmit={submitEditDisplayName} className="space-y-4">
            {feedback ? (
              <Alert tone={feedback.tone} role="alert" title={feedback.title}>
                <p>{feedback.message}</p>
                {conflictLocked ? (
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        closeDialog();
                        reloadNow();
                      }}
                    >
                      Tải lại dữ liệu mới nhất
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor={displayNameId} className="block text-sm font-medium text-foreground">
                Tên hiển thị <span aria-hidden="true">*</span>
              </label>
              <input
                id={displayNameId}
                type="text"
                required
                maxLength={256}
                value={displayNameInput}
                disabled={busy || conflictLocked || pendingToggleKey !== null}
                onChange={(e) => setDisplayNameInput(e.target.value)}
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor={reasonId} className="block text-sm font-medium text-foreground">
                Lý do thao tác (không bắt buộc)
              </label>
              <textarea
                id={reasonId}
                rows={2}
                maxLength={4000}
                value={reason}
                disabled={busy || conflictLocked || pendingToggleKey !== null}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ghi chú ngắn gọn nếu cần…"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeDialog}>
                Đóng
              </Button>
              <Button type="submit" variant="primary" disabled={busy || conflictLocked}>
                {busy ? "Đang lưu…" : pendingToggleKey ? "Thử đồng bộ lại" : "Lưu tên hiển thị"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      <FormDialog
        open={dialog?.kind === "toggle-login"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title={
          dialog?.kind === "toggle-login" && dialog.nextEnabled
            ? "Mở lại đăng nhập"
            : "Khóa đăng nhập người dùng"
        }
        description="Thao tác chỉ thay đổi khả năng đăng nhập vào hệ thống và giữ nguyên lịch sử dữ liệu."
        closeDisabled={busy}
      >
        {dialog?.kind === "toggle-login" ? (
          <form onSubmit={submitToggleLogin} className="space-y-4">
            {feedback ? (
              <Alert tone={feedback.tone} role="alert" title={feedback.title}>
                <p>{feedback.message}</p>
                {conflictLocked ? (
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        closeDialog();
                        reloadNow();
                      }}
                    >
                      Tải lại dữ liệu mới nhất
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor={reasonId} className="block text-sm font-medium text-foreground">
                Lý do thao tác (không bắt buộc)
              </label>
              <textarea
                id={reasonId}
                rows={2}
                maxLength={4000}
                value={reason}
                disabled={busy || conflictLocked || pendingToggleKey !== null}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ghi chú ngắn gọn nếu cần…"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeDialog}>
                Đóng
              </Button>
              <Button
                type="submit"
                variant={dialog.nextEnabled ? "primary" : "danger"}
                disabled={busy || conflictLocked}
              >
                {busy
                  ? "Đang lưu…"
                  : pendingToggleKey
                    ? "Thử đồng bộ lại"
                    : dialog.nextEnabled
                      ? "Xác nhận mở đăng nhập"
                      : "Xác nhận khóa đăng nhập"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      <FormDialog
        open={dialog?.kind === "reset-password"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title="Đặt lại mật khẩu"
        description="Mật khẩu mới có hiệu lực ngay sau khi lưu. Hệ thống không lưu mật khẩu trong trình duyệt."
        closeDisabled={busy}
      >
        {dialog?.kind === "reset-password" ? (
          <form onSubmit={submitResetPassword} className="space-y-4">
            {feedback ? (
              <Alert tone={feedback.tone} role="alert" title={feedback.title}>
                <p>{feedback.message}</p>
              </Alert>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor={pwdId} className="block text-sm font-medium text-foreground">
                Mật khẩu mới
              </label>
              <input
                id={pwdId}
                type="password"
                autoComplete="new-password"
                value={newPassword}
                disabled={busy || dialog.manualCheckLocked}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor={pwdConfirmId} className="block text-sm font-medium text-foreground">
                Nhập lại mật khẩu mới
              </label>
              <input
                id={pwdConfirmId}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                disabled={busy || dialog.manualCheckLocked}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeDialog}>
                Đóng
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || dialog.manualCheckLocked}
              >
                {busy ? "Đang lưu…" : "Xác nhận đặt lại mật khẩu"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      <FormDialog
        open={dialog?.kind === "complete-profile"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title="Bổ sung thông tin nhân viên"
        description="Gắn hồ sơ nhân viên và phòng ban vào chính tài khoản đăng nhập này mà không tạo lại tài khoản đăng nhập mới."
        closeDisabled={busy}
        contentClassName="sm:max-w-2xl"
      >
        {dialog?.kind === "complete-profile" && account ? (
          <form onSubmit={submitCompleteProfile} className="space-y-4">
            {feedback ? (
              <Alert tone={feedback.tone} role="alert" title={feedback.title}>
                <p>{feedback.message}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {conflictLocked ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        closeDialog();
                        reloadNow();
                      }}
                    >
                      Tải lại dữ liệu mới nhất
                    </Button>
                  ) : null}
                  {pendingCompleteKey ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void recheckCompleteProfileStatus()}
                    >
                      Kiểm tra lại trạng thái trên máy chủ
                    </Button>
                  ) : null}
                </div>
              </Alert>
            ) : null}

            <fieldset
              disabled={busy || conflictLocked || pendingCompleteKey !== null}
              className="space-y-2 rounded-lg border border-border bg-surface-muted/30 p-3"
            >
              <legend className="px-1 text-sm font-medium text-foreground">
                Chọn cách hoàn thiện hồ sơ nhân viên
              </legend>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-1.5 text-sm hover:bg-surface">
                <input
                  type="radio"
                  name="complete-profile-mode"
                  value="create"
                  checked={completeMode === "create"}
                  onChange={() => {
                    setCompleteMode("create");
                    setReason(DEFAULT_CREATE_PERSON_REASON);
                    setFeedback(null);
                    setNeedsRecruiterConfirm(false);
                    setConfirmedRecruiter(null);
                  }}
                  className="mt-1 h-4 w-4 accent-primary"
                />
                <span>
                  <span className="block font-medium text-foreground">
                    Tạo hồ sơ nhân viên mới &amp; chọn phòng ban
                  </span>
                  <span className="block text-xs text-muted">
                    Tạo hồ sơ nhân viên mới cho tài khoản{" "}
                    <strong className="font-mono">{account.login_id ?? entry?.display_name}</strong>{" "}
                    và gắn trực tiếp trong một bước xác nhận.
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-1.5 text-sm hover:bg-surface">
                <input
                  type="radio"
                  name="complete-profile-mode"
                  value="link-existing"
                  checked={completeMode === "link-existing"}
                  onChange={() => {
                    setCompleteMode("link-existing");
                    setReason(DEFAULT_LINK_PERSON_REASON);
                    setFeedback(null);
                    setNeedsRecruiterConfirm(false);
                    setConfirmedRecruiter(null);
                  }}
                  className="mt-1 h-4 w-4 accent-primary"
                />
                <span>
                  <span className="block font-medium text-foreground">
                    Gắn với hồ sơ nhân viên đã có (chưa có tài khoản)
                  </span>
                  <span className="block text-xs text-muted">
                    Tìm và chọn thủ công đúng hồ sơ nhân viên hiện hữu để liên kết. Hệ thống không tự
                    ghép theo tên hay email.
                  </span>
                </span>
              </label>
            </fieldset>

            {completeMode === "create" ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label
                      htmlFor={employeeCodeId}
                      className="block text-sm font-medium text-foreground"
                    >
                      Mã nhân viên <span className="text-red-600">*</span>
                    </label>
                    <input
                      id={employeeCodeId}
                      type="text"
                      required
                      maxLength={EMPLOYEE_CODE_MAX_LENGTH}
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={employeeCodeInput}
                      disabled={busy || conflictLocked || pendingCompleteKey !== null}
                      onChange={(e) => setEmployeeCodeInput(e.target.value)}
                      placeholder="VD: NV001"
                      className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={joinedOnId} className="block text-sm font-medium text-foreground">
                      Ngày gia nhập (tùy chọn)
                    </label>
                    <input
                      id={joinedOnId}
                      type="date"
                      value={joinedOnInput}
                      disabled={busy || conflictLocked || pendingCompleteKey !== null}
                      onChange={(e) => setJoinedOnInput(e.target.value)}
                      className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor={fullNameId} className="block text-sm font-medium text-foreground">
                    Họ và tên <span className="text-red-600">*</span>
                  </label>
                  <input
                    id={fullNameId}
                    type="text"
                    required
                    maxLength={FULL_NAME_MAX_LENGTH}
                    value={fullNameInput}
                    disabled={busy || conflictLocked || pendingCompleteKey !== null}
                    onChange={(e) => setFullNameInput(e.target.value)}
                    placeholder="Nhập họ và tên nhân viên"
                    className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                  />
                </div>

                <DepartmentSelectPicker
                  id="complete-profile-department"
                  label="Phòng ban (tùy chọn)"
                  selectedId={selectedDepartment?.department_id ?? null}
                  onSelect={setSelectedDepartment}
                  includeInactive={false}
                  allowClear={true}
                  emptyLabel="Chưa gán phòng ban ngay"
                  disabled={busy || conflictLocked || pendingCompleteKey !== null}
                  onSessionLost={(msg) => handleSessionLost(msg, false)}
                />
              </div>
            ) : (
              <div className="space-y-4">
                <PersonSearchPicker
                  id="complete-profile-existing-person"
                  label="Chọn hồ sơ nhân viên chưa gắn tài khoản"
                  selectedPersonId={selectedExistingPerson?.person_id ?? null}
                  onSelect={(person) => {
                    setSelectedExistingPerson(person);
                    setNeedsRecruiterConfirm(false);
                    setConfirmedRecruiter(null);
                  }}
                  linkState="unlinked"
                  disabled={busy || conflictLocked || pendingCompleteKey !== null}
                  onSessionLost={(msg) => handleSessionLost(msg, false)}
                />

                {selectedExistingPerson ? (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                    <p className="font-medium text-foreground">
                      Hồ sơ đã chọn: {selectedExistingPerson.full_name} (
                      <span className="font-mono text-xs">{selectedExistingPerson.employee_code}</span>)
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      Phòng ban:{" "}
                      {selectedExistingPerson.active_department?.name ?? "Chưa gán phòng ban"}
                    </p>
                  </div>
                ) : null}

                {needsRecruiterConfirm ? (
                  <RecruiterConfirmPicker
                    id="complete-profile-recruiter-confirm"
                    label="Xác nhận hồ sơ tính công tuyển dụng cần giữ"
                    selectedRecruiterId={confirmedRecruiter?.recruiter_id ?? null}
                    onSelect={setConfirmedRecruiter}
                    disabled={busy || conflictLocked || pendingCompleteKey !== null}
                    onSessionLost={(msg) => handleSessionLost(msg, false)}
                  />
                ) : null}
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor={completeReasonId} className="block text-sm font-medium text-foreground">
                Lý do thao tác <span className="text-red-600">*</span>
              </label>
              <textarea
                id={completeReasonId}
                required
                rows={2}
                maxLength={REASON_MAX_LENGTH}
                value={reason}
                disabled={busy || conflictLocked || pendingCompleteKey !== null}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ghi chú ngắn gọn lý do bổ sung / liên kết hồ sơ…"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeDialog}>
                Đóng
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || conflictLocked || (completeMode === "link-existing" && !selectedExistingPerson)}
              >
                {busy
                  ? "Đang lưu…"
                  : pendingCompleteKey
                    ? "Thử gửi lại đúng yêu cầu"
                    : completeMode === "create"
                      ? "Tạo hồ sơ & gắn tài khoản"
                      : "Xác nhận gắn hồ sơ nhân viên"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </PageShell>
  );
}
