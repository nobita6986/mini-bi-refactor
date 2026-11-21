"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  AccountProvisionAndLinkStepper,
  type ProvisionStepperMode,
} from "@/components/admin/account-provision-and-link-stepper";
import { AccountGroupsSection } from "@/components/admin/account-groups-section";
import {
  DepartmentSelectPicker,
  type SelectedDepartmentOption,
} from "@/components/admin/org-entity-picker";
import { useWp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
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
  buildAccountStateRequest,
  classifyAccountMutation,
  newAccountIntentKey,
} from "@/lib/admin/account-access-model";
import {
  buildPersonnelFromAccountRequest,
  buildResetPasswordRequest,
  classifyAccountOperationResponse,
  newAccountOperationKey,
} from "@/lib/admin/account-operation-ui-model";
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
import { projectPersonnelItem } from "@/lib/admin/personnel-catalog-model";
import {
  clearVerifiedCheckpoint,
  getBrowserOrigin,
  getBrowserSessionStorage,
  readVerifiedCheckpoint,
  type CheckpointStorageLike,
  type ProvisionCheckpointV2,
} from "@/lib/admin/provision-checkpoint-v2";
import type { AdminPersonnel, PersonnelPosition } from "@/lib/direct-entry/personnel-catalog-contract";

type PersonDetailLoadState =
  | { kind: "loading" }
  | { kind: "ready"; person: PersonDetailProjection; authorizationDate: string }
  | { kind: "denied"; message: string; unauthenticated: boolean }
  | { kind: "not-found"; message: string }
  | { kind: "error"; message: string; retryable: boolean };

type RecruiterLoadState =
  | { kind: "idle" }
  | { kind: "loading"; recruiterId: string }
  | { kind: "ready"; personnel: AdminPersonnel }
  | { kind: "error"; recruiterId: string; message: string };

type PersonDialogState =
  | {
      kind: "edit";
      baselinePersonId: string;
      baselinePersonVersion: number;
      conflictLocked: boolean;
    }
  | {
      kind: "assign-dept";
      baselinePersonId: string;
      baselinePersonVersion: number;
      conflictLocked: boolean;
    }
  | {
      kind: "transfer-dept" | "end-dept";
      baselinePersonId: string;
      baselinePersonVersion: number;
      baselineDepartmentId: string;
      baselineDepartmentName: string;
      baselineMembershipId: string;
      conflictLocked: boolean;
    }
  | {
      kind: "toggle-login";
      accountRef: string;
      nextEnabled: boolean;
      expectedAccountVersion: number;
      conflictLocked: boolean;
    }
  | {
      kind: "reset-password";
      accountRef: string;
      loginId: string | null;
      conflictLocked: boolean;
      manualCheckLocked: boolean;
    }
  | {
      kind: "activate-recruiter";
      accountRef: string;
      loginId: string;
      expectedAccountVersion: number;
      conflictLocked: boolean;
    };

type PendingDetailIntent =
  | {
      family: "person-org";
      url: string;
      method: "PATCH" | "POST";
      op: PersonOrgMutationOp;
      body: Record<string, unknown>;
      idempotencyKey: string;
      message: string;
    }
  | {
      family: "toggle-login";
      url: string;
      nextEnabled: boolean;
      body: Record<string, unknown>;
      idempotencyKey: string;
      message: string;
    }
  | {
      family: "activate-recruiter";
      url: string;
      loginId: string;
      body: Record<string, unknown>;
      idempotencyKey: string;
      message: string;
    };

export function PersonDetailManager({
  personId,
  checkpointActorScope = "",
  canManageGlobalRoles = true,
  storage,
  originOverride,
}: {
  personId: string;
  checkpointActorScope?: string;
  canManageGlobalRoles?: boolean;
  storage?: CheckpointStorageLike | null;
  originOverride?: string;
}) {
  const notify = useNotify();

  const [state, setState] = useState<PersonDetailLoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [accountAccessReloadToken, setAccountAccessReloadToken] = useState(0);
  const [recruiterReloadToken, setRecruiterReloadToken] = useState(0);
  const [latestAccountVersion, setLatestAccountVersion] = useState<number | null>(null);
  const [recruiterState, setRecruiterState] = useState<RecruiterLoadState>({ kind: "idle" });

  const reqSeqRef = useRef(0);
  const recruiterReqSeqRef = useRef(0);
  const lastPersonIdRef = useRef(personId);
  const workspaceGuard = useWp4WorkspaceGuard();

  const [stepperMode, setStepperMode] = useState<ProvisionStepperMode | null>(null);
  const [pendingCheckpoint, setPendingCheckpoint] = useState<ProvisionCheckpointV2 | null>(null);
  const [checkpointTick, setCheckpointTick] = useState(0);

  const [dialog, setDialog] = useState<PersonDialogState | null>(null);
  const [employeeCode, setEmployeeCode] = useState("");
  const [fullName, setFullName] = useState("");
  const [joinedOn, setJoinedOn] = useState("");
  const [personStatus, setPersonStatus] = useState<PersonStatus>("ACTIVE");
  const [selectedTargetDept, setSelectedTargetDept] = useState<SelectedDepartmentOption | null>(
    null,
  );
  const [reason, setReason] = useState("");
  // RAM-only reset password fields — NEVER persisted or echoed.
  const [resetPassword, setResetPassword] = useState("");
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState("");
  // Opt-in Block 4 recruitment activation fields.
  const [recruiterPosition, setRecruiterPosition] = useState<PersonnelPosition>("STAFF");

  const [formError, setFormError] = useState<string | null>(null);
  const [activeHeadBlockMsg, setActiveHeadBlockMsg] = useState<string | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingDetailIntent | null>(null);
  const [uncertainInspected, setUncertainInspected] = useState(false);
  const inFlightRef = useRef(false);

  const resolveStorage = useCallback(
    () => (storage !== undefined ? storage : getBrowserSessionStorage()),
    [storage],
  );
  const resolveOrigin = useCallback(
    () => (originOverride !== undefined ? originOverride : getBrowserOrigin()),
    [originOverride],
  );

  const clearRamResetPasswords = useCallback(() => {
    setResetPassword("");
    setResetPasswordConfirm("");
  }, []);

  const [corruptCheckpointMessage, setCorruptCheckpointMessage] = useState<string | null>(null);

  const refreshCheckpointBanner = useCallback(() => {
    setCheckpointTick((v) => v + 1);
  }, []);

  const syncCheckpointStateNow = useCallback((): boolean => {
    if (!checkpointActorScope) {
      setPendingCheckpoint(null);
      setCorruptCheckpointMessage(null);
      return false;
    }
    const result = readVerifiedCheckpoint({
      storage: resolveStorage(),
      expectedOrigin: resolveOrigin(),
      expectedActorScope: checkpointActorScope,
    });
    if (result.kind === "valid") {
      setPendingCheckpoint(result.checkpoint);
      setCorruptCheckpointMessage(null);
      return true;
    }
    if (result.kind === "corrupt") {
      setPendingCheckpoint(null);
      setCorruptCheckpointMessage(result.message);
      return true;
    }
    setPendingCheckpoint(null);
    setCorruptCheckpointMessage(null);
    return false;
  }, [checkpointActorScope, resolveOrigin, resolveStorage]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      syncCheckpointStateNow();
    });
    return () => {
      cancelled = true;
    };
  }, [checkpointTick, syncCheckpointStateNow]);

  const handleClearCorruptCheckpoint = useCallback(() => {
    if (!checkpointActorScope) return;
    clearVerifiedCheckpoint({
      storage: resolveStorage(),
      expectedOrigin: resolveOrigin(),
      expectedActorScope: checkpointActorScope,
      forceCorruptCleanup: true,
      corruptOnly: true,
    });
    refreshCheckpointBanner();
  }, [checkpointActorScope, refreshCheckpointBanner, resolveOrigin, resolveStorage]);

  // Clear RAM-only passwords & synchronous in-flight guard on unmount.
  useEffect(() => {
    return () => {
      inFlightRef.current = false;
      setResetPassword("");
      setResetPasswordConfirm("");
    };
  }, []);

  const handleSessionLost = useCallback(
    (message: string, unauthenticated = false) => {
      inFlightRef.current = false;
      workspaceGuard.invalidateSession();
      reqSeqRef.current += 1;
      recruiterReqSeqRef.current += 1;
      clearRamResetPasswords();
      setBusy(false);
      setDialog(null);
      setStepperMode(null);
      setPendingCheckpoint(null);
      setCorruptCheckpointMessage(null);
      setPendingIntent(null);
      setUncertainInspected(false);
      setConflictMsg(null);
      setActiveHeadBlockMsg(null);
      setFormError(null);
      setSelectedTargetDept(null);
      setLatestAccountVersion(null);
      setRecruiterState({ kind: "idle" });
      setState({ kind: "denied", message, unauthenticated });
    },
    [clearRamResetPasswords, workspaceGuard],
  );

  const handlePickerSessionLost = useCallback(
    (message: string) => {
      handleSessionLost(message, false);
    },
    [handleSessionLost],
  );

  const handleSelectTargetDept = useCallback((dept: SelectedDepartmentOption | null) => {
    setSelectedTargetDept(dept);
  }, []);

  const handleStepperClose = useCallback(() => {
    setStepperMode(null);
    refreshCheckpointBanner();
  }, [refreshCheckpointBanner]);

  const handleStepperCompleted = useCallback(() => {
    setStepperMode(null);
    refreshCheckpointBanner();
    setReloadToken((v) => v + 1);
    setAccountAccessReloadToken((v) => v + 1);
    setRecruiterReloadToken((v) => v + 1);
  }, [refreshCheckpointBanner]);

  const handleAccountVersionChanged = useCallback((version: number) => {
    setLatestAccountVersion(version);
  }, []);

  const closeDialog = useCallback(() => {
    clearRamResetPasswords();
    setDialog(null);
    setPendingIntent(null);
    setUncertainInspected(false);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setFormError(null);
    setSelectedTargetDept(null);
  }, [clearRamResetPasswords]);

  useEffect(() => {
    const personChanged = lastPersonIdRef.current !== personId;
    if (personChanged) {
      lastPersonIdRef.current = personId;
      inFlightRef.current = false;
      workspaceGuard.invalidateSession();
    }
    const reqSeq = ++reqSeqRef.current;
    const tracked = workspaceGuard.trackController();
    const controller: AbortController = tracked.controller;
    void (async () => {
      if (personChanged) {
        clearRamResetPasswords();
        setDialog(null);
        setStepperMode(null);
        setPendingIntent(null);
        setUncertainInspected(false);
        setConflictMsg(null);
        setActiveHeadBlockMsg(null);
        setFormError(null);
        setBusy(false);
        setSelectedTargetDept(null);
        setLatestAccountVersion(null);
        setRecruiterState({ kind: "idle" });
      }
      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== reqSeqRef.current) {
        tracked.release();
        return;
      }
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
        tracked.release();
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== reqSeqRef.current) {
          return;
        }
        setState({
          kind: "error",
          message: "Không thể kết nối máy chủ để tải chi tiết Nhân sự.",
          retryable: true,
        });
        return;
      }

      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== reqSeqRef.current) {
        tracked.release();
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      tracked.release();
      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== reqSeqRef.current) {
        return;
      }

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
          message: "Phản hồi chi tiết Nhân sự không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setLatestAccountVersion(projected.person.active_account_link?.account_version ?? null);
      setState({
        kind: "ready",
        person: projected.person,
        authorizationDate: projected.authorization_date,
      });
    })();

    return () => {
      reqSeqRef.current += 1;
      controller.abort();
      tracked.release();
    };
  }, [clearRamResetPasswords, handleSessionLost, personId, reloadToken, workspaceGuard]);

  const person = state.kind === "ready" ? state.person : null;
  const recruiterId = person?.recruiter_id ?? null;

  // Block 4: Parallel read of `GET /api/admin/catalog/personnel/[recruiterId]` with local error degrade.
  useEffect(() => {
    if (!recruiterId) {
      return;
    }
    const reqSeq = ++recruiterReqSeqRef.current;
    const tracked = workspaceGuard.trackController();
    const controller: AbortController = tracked.controller;
    void (async () => {
      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== recruiterReqSeqRef.current) {
        tracked.release();
        return;
      }
      setRecruiterState({ kind: "loading", recruiterId });
      let response: Response;
      try {
        response = await fetch(`/api/admin/catalog/personnel/${encodeURIComponent(recruiterId)}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        tracked.release();
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== recruiterReqSeqRef.current) {
          return;
        }
        setRecruiterState({
          kind: "error",
          recruiterId,
          message: "Không thể kết nối máy chủ để tải hồ sơ tính công tuyển dụng.",
        });
        return;
      }

      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== recruiterReqSeqRef.current) {
        tracked.release();
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      tracked.release();
      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== recruiterReqSeqRef.current) {
        return;
      }

      if (response.status === 401 || response.status === 403) {
        const failure = classifyPersonOrgReadError(response.status, payload);
        handleSessionLost(failure.message, failure.kind === "unauthenticated");
        return;
      }

      if (response.status !== 200) {
        setRecruiterState({
          kind: "error",
          recruiterId,
          message:
            response.status === 404
              ? "Không tìm thấy hồ sơ tính công tuyển dụng tương ứng."
              : "Không tải được hồ sơ tính công tuyển dụng. Các khối thông tin khác vẫn hoạt động bình thường.",
        });
        return;
      }

      const projected = projectPersonnelItem(payload);
      if (!projected || projected.recruiter_id !== recruiterId) {
        setRecruiterState({
          kind: "error",
          recruiterId,
          message: "Phản hồi hồ sơ tính công tuyển dụng không khớp định dạng chuẩn.",
        });
        return;
      }

      setRecruiterState({ kind: "ready", personnel: projected });
    })();

    return () => {
      recruiterReqSeqRef.current += 1;
      controller.abort();
      tracked.release();
    };
  }, [handleSessionLost, recruiterId, recruiterReloadToken, workspaceGuard]);

  const reloadDetail = useCallback(() => {
    if (busy || pendingIntent !== null) return;
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setFormError(null);
    setReloadToken((v) => v + 1);
    setAccountAccessReloadToken((v) => v + 1);
    setRecruiterReloadToken((v) => v + 1);
  }, [busy, pendingIntent]);

  const activeHeadAssignments = useMemo(
    () => (person ? person.head_assignments.filter((item) => item.ended_at === null) : []),
    [person],
  );

  const authoritativeAccountVersion = useMemo(() => {
    if (!person?.active_account_link) return null;
    if (latestAccountVersion !== null && latestAccountVersion >= person.active_account_link.account_version) {
      return latestAccountVersion;
    }
    return person.active_account_link.account_version;
  }, [latestAccountVersion, person]);

  const openEditDialog = () => {
    if (!person || busy || pendingIntent !== null) return;
    setEmployeeCode(person.employee_code);
    setFullName(person.full_name);
    setJoinedOn(person.joined_on ?? "");
    setPersonStatus(person.status);
    setReason("");
    setFormError(null);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setPendingIntent(null);
    setDialog({
      kind: "edit",
      baselinePersonId: person.person_id,
      baselinePersonVersion: person.version,
      conflictLocked: false,
    });
  };

  const openDeptDialog = (kind: "assign-dept" | "transfer-dept" | "end-dept") => {
    if (!person || busy || pendingIntent !== null) return;
    setSelectedTargetDept(null);
    setReason("");
    setFormError(null);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setPendingIntent(null);
    if (kind === "assign-dept") {
      setDialog({
        kind,
        baselinePersonId: person.person_id,
        baselinePersonVersion: person.version,
        conflictLocked: false,
      });
      return;
    }
    if (!person.active_department) {
      return;
    }
    setDialog({
      kind,
      baselinePersonId: person.person_id,
      baselinePersonVersion: person.version,
      baselineDepartmentId: person.active_department.department_id,
      baselineDepartmentName: person.active_department.name,
      baselineMembershipId: person.active_department.membership_id,
      conflictLocked: false,
    });
  };

  const openToggleLoginDialog = () => {
    if (!person?.active_account_link || authoritativeAccountVersion === null || busy || pendingIntent !== null) {
      return;
    }
    setReason("");
    setFormError(null);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setPendingIntent(null);
    setDialog({
      kind: "toggle-login",
      accountRef: person.active_account_link.account_ref,
      nextEnabled: !person.active_account_link.enabled,
      expectedAccountVersion: authoritativeAccountVersion,
      conflictLocked: false,
    });
  };

  const openResetPasswordDialog = () => {
    if (!person?.active_account_link || busy || pendingIntent !== null) return;
    clearRamResetPasswords();
    setReason("");
    setFormError(null);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setPendingIntent(null);
    setDialog({
      kind: "reset-password",
      accountRef: person.active_account_link.account_ref,
      loginId: person.active_account_link.login_id,
      conflictLocked: false,
      manualCheckLocked: false,
    });
  };

  const openActivateRecruiterDialog = () => {
    if (
      !person ||
      person.status !== "ACTIVE" ||
      person.recruiter_id !== null ||
      !person.active_account_link?.enabled ||
      !person.active_account_link.login_id ||
      authoritativeAccountVersion === null ||
      busy ||
      pendingIntent !== null
    ) {
      return;
    }
    setRecruiterPosition("STAFF");
    setReason("");
    setFormError(null);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setPendingIntent(null);
    setDialog({
      kind: "activate-recruiter",
      accountRef: person.active_account_link.account_ref,
      loginId: person.active_account_link.login_id,
      expectedAccountVersion: authoritativeAccountVersion,
      conflictLocked: false,
    });
  };

  const dispatchIntent = async (intent: PendingDetailIntent) => {
    if (busy || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setFormError(null);
    setConflictMsg(null);
    setActiveHeadBlockMsg(null);
    setUncertainInspected(false);
    const tracked = workspaceGuard.trackController();
    const controller: AbortController = tracked.controller;
    try {
      const response = await fetch(intent.url, {
        method: intent.family === "person-org" ? intent.method : "POST",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": intent.idempotencyKey,
        },
        body: JSON.stringify(intent.body),
      });
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;
      const payload: unknown = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;

      if (intent.family === "person-org") {
        const outcome = classifyPersonOrgMutationResponse(response.status, payload, intent.op);
        if (outcome.kind === "applied") {
          notify.success({
            title: outcome.message,
            dedupeKey: `wp4-person-detail:${personId}:${intent.op}`,
          });
          closeDialog();
          setReloadToken((v) => v + 1);
          setAccountAccessReloadToken((v) => v + 1);
          return;
        }
        if (outcome.kind === "session-lost") {
          handleSessionLost(outcome.message, outcome.sessionState === "unauthenticated");
          return;
        }
        if (outcome.kind === "uncertain") {
          setPendingIntent({ ...intent, message: outcome.message });
          return;
        }
        setPendingIntent(null);
        if (outcome.kind === "active-head-block") {
          setActiveHeadBlockMsg(outcome.message);
          return;
        }
        if (outcome.kind === "conflict") {
          setConflictMsg(outcome.message);
          setDialog((prev) => (prev ? { ...prev, conflictLocked: true } : null));
          return;
        }
        setFormError(outcome.message);
        return;
      }

      if (intent.family === "toggle-login") {
        const outcome = classifyAccountMutation(response.status, payload);
        if (outcome.kind === "applied") {
          notify.success({
            title: intent.nextEnabled
              ? "Đã mở lại đăng nhập cho tài khoản."
              : "Đã khóa đăng nhập cho tài khoản.",
            dedupeKey: `wp13-person-toggle-login:${personId}:${intent.nextEnabled}`,
          });
          closeDialog();
          setReloadToken((v) => v + 1);
          setAccountAccessReloadToken((v) => v + 1);
          return;
        }
        if (
          outcome.kind === "unauthenticated" ||
          outcome.kind === "denied" ||
          outcome.kind === "actor-not-available"
        ) {
          handleSessionLost(outcome.message, outcome.kind === "unauthenticated");
          return;
        }
        if (outcome.kind === "unavailable") {
          setPendingIntent({ ...intent, message: outcome.message });
          return;
        }
        setPendingIntent(null);
        if (outcome.kind === "conflict") {
          setConflictMsg(outcome.message);
          setDialog((prev) => (prev ? { ...prev, conflictLocked: true } : null));
          return;
        }
        setFormError(outcome.message);
        return;
      }

      // intent.family === "activate-recruiter"
      const outcome = classifyAccountOperationResponse(response.status, payload, {
        operation: "personnel_from_account",
        expectedPersonnelCode: intent.loginId,
      });
      if (outcome.kind === "applied") {
        notify.success({
          title: "Đã kích hoạt hồ sơ tính công tuyển dụng cho nhân viên.",
          dedupeKey: `wp13-person-recruiter-activate:${personId}`,
        });
        closeDialog();
        setReloadToken((v) => v + 1);
        setAccountAccessReloadToken((v) => v + 1);
        setRecruiterReloadToken((v) => v + 1);
        return;
      }
      if (outcome.kind === "denied") {
        handleSessionLost(outcome.message, response.status === 401);
        return;
      }
      if (outcome.kind === "unavailable" && outcome.preserveIdempotencyKey) {
        setPendingIntent({ ...intent, message: outcome.message });
        return;
      }
      setPendingIntent(null);
      if (outcome.kind === "conflict") {
        setConflictMsg(
          "Tài khoản đã có hồ sơ tính công tuyển dụng hoặc phiên bản vừa thay đổi. Kiểm tra tại Danh mục hồ sơ tính công hoặc tải lại dữ liệu mới nhất.",
        );
        setDialog((prev) => (prev ? { ...prev, conflictLocked: true } : null));
        return;
      }
      setFormError(outcome.message);
    } catch {
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;
      setPendingIntent({
        ...intent,
        message:
          "Mất kết nối trong lúc lưu thay đổi. Đã giữ nguyên dữ liệu và khóa idempotency; bạn có thể thử lại đúng yêu cầu hoặc tải lại để đối chiếu.",
      });
    } finally {
      inFlightRef.current = false;
      tracked.release();
      if (workspaceGuard.isActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  /**
   * Strictly isolated RESET_PASSWORD flow:
   * - Never touches Checkpoint V2 or `/intents/[id]/reconcile`
   * - Clears RAM passwords immediately on applied, conflict, denied,
   *   AUTH_APPLIED_UNRECORDED / INDETERMINATE / RESULT_UNRECORDED, or network drop
   * - Locks manual check with 0 second Auth retry on uncertain auth results.
   */
  const dispatchResetPassword = async (
    accountRef: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ) => {
    if (busy || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setFormError(null);
    setConflictMsg(null);
    const tracked = workspaceGuard.trackController();
    const controller: AbortController = tracked.controller;
    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(accountRef)}/reset-password`,
        {
          method: "POST",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;
      const payload: unknown = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;

      const outcome = classifyAccountOperationResponse(response.status, payload, {
        operation: "reset_password",
      });
      if (outcome.kind === "applied") {
        clearRamResetPasswords();
        notify.success({
          title: "Đã đặt lại mật khẩu đăng nhập.",
          dedupeKey: `wp13-person-reset-pw:${accountRef}`,
        });
        closeDialog();
        return;
      }
      if (outcome.kind === "denied") {
        clearRamResetPasswords();
        handleSessionLost(outcome.message, response.status === 401);
        return;
      }
      if (outcome.kind === "conflict") {
        clearRamResetPasswords();
        setConflictMsg(outcome.message);
        setDialog((prev) =>
          prev?.kind === "reset-password" ? { ...prev, conflictLocked: true } : prev,
        );
        return;
      }
      if (
        outcome.kind === "needs-reconcile" ||
        (outcome.kind === "unavailable" &&
          (outcome.manualCheckRequired || !outcome.preserveIdempotencyKey))
      ) {
        clearRamResetPasswords();
        const msg =
          outcome.kind === "unavailable"
            ? outcome.message
            : "Chưa xác định được kết quả đổi mật khẩu. Không dùng đối soát tạo tài khoản và không gửi lại tự động; hãy kiểm tra đăng nhập thực tế trước.";
        setFormError(msg);
        setDialog((prev) =>
          prev?.kind === "reset-password" ? { ...prev, manualCheckLocked: true } : prev,
        );
        return;
      }
      if (outcome.kind === "unavailable") {
        clearRamResetPasswords();
        setFormError(
          "Không nhận được xác nhận từ máy chủ khi đặt lại mật khẩu. Không tự gửi lại Auth lần hai; hãy kiểm tra thủ công hoặc mở thao tác mới sau khi xác minh.",
        );
        setDialog((prev) =>
          prev?.kind === "reset-password" ? { ...prev, manualCheckLocked: true } : prev,
        );
        return;
      }
      setFormError(outcome.message);
    } catch {
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;
      clearRamResetPasswords();
      setFormError(
        "Mất kết nối trong lúc đặt lại mật khẩu. Đã xóa mật khẩu khỏi bộ nhớ và không tự gửi lại Auth; hãy kiểm tra đăng nhập thực tế trước khi thực hiện thao tác mới.",
      );
      setDialog((prev) =>
        prev?.kind === "reset-password" ? { ...prev, manualCheckLocked: true } : prev,
      );
    } finally {
      inFlightRef.current = false;
      tracked.release();
      if (workspaceGuard.isActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const reconcileFromServer = async () => {
    if (busy || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setFormError(null);
    const hadPendingUncertain = pendingIntent !== null;
    const reqSeq = ++reqSeqRef.current;
    const tracked = workspaceGuard.trackController();
    const controller: AbortController = tracked.controller;
    try {
      const response = await fetch(
        `/api/admin/organization/persons/${encodeURIComponent(personId)}`,
        {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== reqSeqRef.current) {
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== reqSeqRef.current) {
        return;
      }
      if (response.status !== 200) {
        const failure = classifyPersonOrgReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          handleSessionLost(failure.message, failure.kind === "unauthenticated");
          return;
        }
        if (failure.kind === "not-found") {
          setState({ kind: "not-found", message: failure.message });
          closeDialog();
          return;
        }
        setFormError(failure.message);
        return;
      }
      const projected = projectPersonDetailEnvelope(payload, personId);
      if (!projected) {
        setFormError(
          "Phản hồi chi tiết nhân sự không hợp lệ; yêu cầu chờ xác nhận vẫn được giữ nguyên.",
        );
        return;
      }
      setLatestAccountVersion(projected.person.active_account_link?.account_version ?? null);
      setState({
        kind: "ready",
        person: projected.person,
        authorizationDate: projected.authorization_date,
      });
      setAccountAccessReloadToken((v) => v + 1);
      setRecruiterReloadToken((v) => v + 1);
      if (hadPendingUncertain) {
        // WP12 §3.10 / R1-OCC: Reloading after 503/network drop NEVER wipes pendingIntent (frozen idempotency key & expected_version).
        setUncertainInspected(true);
        setPendingIntent((prev) =>
          prev
            ? {
                ...prev,
                message: `Đã tải trạng thái hiện tại từ máy chủ (hồ sơ v${projected.person.version}). Khóa idempotency và phiên bản gốc vẫn được giữ nguyên — hãy bấm "Thử lại đúng yêu cầu" để xác nhận an toàn hoặc đóng nếu bạn đã xác minh thay đổi đã được áp dụng.`,
              }
            : null,
        );
        return;
      }
      closeDialog();
    } catch {
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;
      setFormError(
        "Không thể kết nối máy chủ để đối chiếu. Yêu cầu chờ xác nhận vẫn được giữ nguyên.",
      );
    } finally {
      inFlightRef.current = false;
      tracked.release();
      if (workspaceGuard.isActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const submitDialog = (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || busy || inFlightRef.current || pendingIntent || dialog.conflictLocked) return;
    if (dialog.kind === "reset-password" && dialog.manualCheckLocked) return;

    if (dialog.kind === "edit") {
      const idempotencyKey = newOrgIdempotencyKey();
      const req = buildUpdatePersonRequest({
        expectedPersonVersion: dialog.baselinePersonVersion,
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
      void dispatchIntent({
        family: "person-org",
        url: `/api/admin/organization/persons/${encodeURIComponent(dialog.baselinePersonId)}`,
        method: "PATCH",
        op: "update",
        body: req.body,
        idempotencyKey: req.idempotencyKey,
        message: "",
      });
      return;
    }

    if (dialog.kind === "assign-dept") {
      if (!selectedTargetDept) {
        setFormError("Vui lòng chọn phòng ban cần gán từ danh sách.");
        return;
      }
      const idempotencyKey = newOrgIdempotencyKey();
      const req = buildAssignPersonDepartmentRequest({
        personId: dialog.baselinePersonId,
        expectedPersonVersion: dialog.baselinePersonVersion,
        reason,
        idempotencyKey,
      });
      if (!req.ok) {
        setFormError(req.message);
        return;
      }
      void dispatchIntent({
        family: "person-org",
        url: `/api/admin/departments/${encodeURIComponent(selectedTargetDept.department_id)}/memberships`,
        method: "POST",
        op: "assign-department",
        body: req.body,
        idempotencyKey: req.idempotencyKey,
        message: "",
      });
      return;
    }

    if (dialog.kind === "transfer-dept") {
      if (!selectedTargetDept) {
        setFormError("Vui lòng chọn phòng ban đích từ danh sách.");
        return;
      }
      const idempotencyKey = newOrgIdempotencyKey();
      const req = buildTransferPersonDepartmentRequest({
        targetDepartmentRef: selectedTargetDept.department_id,
        expectedPersonVersion: dialog.baselinePersonVersion,
        expectedCurrentMembershipId: dialog.baselineMembershipId,
        reason,
        idempotencyKey,
      });
      if (!req.ok) {
        setFormError(req.message);
        return;
      }
      void dispatchIntent({
        family: "person-org",
        url: `/api/admin/organization/persons/${encodeURIComponent(dialog.baselinePersonId)}/transfer-department`,
        method: "POST",
        op: "transfer-department",
        body: req.body,
        idempotencyKey: req.idempotencyKey,
        message: "",
      });
      return;
    }

    if (dialog.kind === "end-dept") {
      const idempotencyKey = newOrgIdempotencyKey();
      const req = buildEndPersonDepartmentRequest({
        expectedPersonVersion: dialog.baselinePersonVersion,
        reason,
        idempotencyKey,
      });
      if (!req.ok) {
        setFormError(req.message);
        return;
      }
      void dispatchIntent({
        family: "person-org",
        url: `/api/admin/departments/${encodeURIComponent(dialog.baselineDepartmentId)}/memberships/${encodeURIComponent(dialog.baselineMembershipId)}/end`,
        method: "POST",
        op: "end-department",
        body: req.body,
        idempotencyKey: req.idempotencyKey,
        message: "",
      });
      return;
    }

    if (dialog.kind === "toggle-login") {
      const idempotencyKey = newAccountIntentKey();
      const req = buildAccountStateRequest({
        expectedVersion: dialog.expectedAccountVersion,
        reason,
        idempotencyKey,
      });
      if (!req.ok) {
        setFormError(req.message);
        return;
      }
      const actionPath = dialog.nextEnabled ? "enable" : "disable";
      void dispatchIntent({
        family: "toggle-login",
        url: `/api/admin/access/accounts/${encodeURIComponent(dialog.accountRef)}/${actionPath}`,
        nextEnabled: dialog.nextEnabled,
        body: req.body,
        idempotencyKey,
        message: "",
      });
      return;
    }

    if (dialog.kind === "reset-password") {
      const idempotencyKey = newAccountOperationKey();
      const req = buildResetPasswordRequest({
        password: resetPassword,
        passwordConfirm: resetPasswordConfirm,
        reason,
        idempotencyKey,
      });
      if (!req.ok) {
        setFormError(req.message);
        return;
      }
      void dispatchResetPassword(dialog.accountRef, req.body, idempotencyKey);
      return;
    }

    if (dialog.kind === "activate-recruiter") {
      const idempotencyKey = newAccountOperationKey();
      const req = buildPersonnelFromAccountRequest({
        accountRef: dialog.accountRef,
        expectedAccountVersion: dialog.expectedAccountVersion,
        loginId: dialog.loginId,
        personnelPosition: recruiterPosition,
        validFrom: null,
        reason,
        idempotencyKey,
      });
      if (!req.ok) {
        setFormError(req.message);
        return;
      }
      void dispatchIntent({
        family: "activate-recruiter",
        url: "/api/admin/catalog/personnel/from-account",
        loginId: dialog.loginId,
        body: req.body,
        idempotencyKey,
        message: "",
      });
    }
  };

  const isDialogLocked = busy || pendingIntent !== null;
  const isManualCheckLocked = dialog?.kind === "reset-password" && dialog.manualCheckLocked;
  const isFormInputLocked = isDialogLocked || Boolean(dialog?.conflictLocked) || isManualCheckLocked;
  const statusMeta = person ? personStatusBadge(person.status) : null;

  const isReasonRequired =
    dialog?.kind === "edit" ||
    dialog?.kind === "assign-dept" ||
    dialog?.kind === "transfer-dept" ||
    dialog?.kind === "end-dept";

  const dialogTitle = (() => {
    switch (dialog?.kind) {
      case "edit":
        return "Sửa hồ sơ Nhân sự";
      case "assign-dept":
        return "Gán phòng ban ngay";
      case "transfer-dept":
        return "Chuyển phòng ban ngay";
      case "end-dept":
        return "Kết thúc thành viên phòng ban";
      case "toggle-login":
        return dialog.nextEnabled ? "Mở lại đăng nhập tài khoản" : "Khóa đăng nhập tài khoản";
      case "reset-password":
        return "Đặt lại mật khẩu đăng nhập";
      case "activate-recruiter":
        return "Kích hoạt nghiệp vụ tuyển dụng";
      default:
        return "";
    }
  })();

  const dialogDescription = (() => {
    switch (dialog?.kind) {
      case "reset-password":
        return "Mật khẩu mới chỉ lưu tạm trong RAM khi gửi và sẽ bị xóa ngay sau phản hồi.";
      case "toggle-login":
        return "Khóa/mở đăng nhập chỉ ảnh hưởng quyền truy cập hệ thống, tách biệt với trạng thái hồ sơ nhân sự.";
      case "activate-recruiter":
        return "Tạo hồ sơ tính công tuyển dụng từ tài khoản đăng nhập đang hoạt động.";
      default:
        return "Mọi thay đổi áp dụng ngay tại thời điểm xác nhận; không đặt lịch tương lai.";
    }
  })();

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
          ← Quay lại danh sách Người dùng
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={reloadDetail}
            disabled={
              state.kind === "loading" ||
              state.kind === "denied" ||
              isDialogLocked ||
              dialog !== null ||
              stepperMode !== null
            }
          >
            Tải lại hồ sơ
          </Button>
        </div>
      </div>

      {pendingCheckpoint && state.kind !== "denied" ? (
        <Alert
          tone="warning"
          role="status"
          title="Có tiến trình thêm người dùng / mở đăng nhập đang dang dở"
        >
          <div className="space-y-2">
            <p>
              Hồ sơ{" "}
              <strong>
                {pendingCheckpoint.step1_person.existing_full_name ??
                  pendingCheckpoint.step1_person.payload_snapshot?.full_name ??
                  "Chưa rõ họ tên"}
              </strong>{" "}
              (
              <span className="font-mono">
                {pendingCheckpoint.step1_person.existing_employee_code ??
                  pendingCheckpoint.step1_person.payload_snapshot?.employee_code ??
                  "—"}
              </span>
              ) đang có tiến trình chưa hoàn tất. Hãy bấm tiếp tục để đồng bộ với máy chủ trước khi
              mở thao tác mới.
            </p>
            <div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={stepperMode !== null}
                onClick={() =>
                  setStepperMode({ kind: "resume-checkpoint", checkpoint: pendingCheckpoint })
                }
              >
                Tiếp tục hoàn tất
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      {corruptCheckpointMessage && !pendingCheckpoint && state.kind !== "denied" ? (
        <Alert
          tone="warning"
          role="alert"
          title="Tiến trình lưu tạm trong trình duyệt không thể đọc được"
        >
          <div className="space-y-2">
            <p>{corruptCheckpointMessage}</p>
            <div>
              <Button
                type="button"
                variant="danger-outline"
                size="sm"
                onClick={handleClearCorruptCheckpoint}
              >
                Đã kiểm tra · Xóa bản lưu tạm lỗi
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      {state.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải chi tiết Nhân sự…
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
            eyebrow={`Mã nhân viên: ${person.employee_code}`}
            title={person.full_name}
            badge={
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge tone={statusMeta.tone} dot>
                  {statusMeta.label}
                </StatusBadge>
                {person.active_account_link ? (
                  <StatusBadge
                    tone={person.active_account_link.enabled ? "success" : "warning"}
                    dot
                  >
                    {person.active_account_link.enabled
                      ? "Đang mở đăng nhập"
                      : "Đang khóa đăng nhập"}
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="neutral">Chưa có tài khoản</StatusBadge>
                )}
              </div>
            }
            description={`Ngày gia nhập: ${formatOrgDate(person.joined_on)} · Ngày hiệu lực tổ chức: ${formatOrgDate(state.kind === "ready" ? state.authorizationDate : null)}`}
            actions={
              <Button variant="primary" size="md" onClick={openEditDialog} disabled={isDialogLocked}>
                Sửa hồ sơ
              </Button>
            }
          />

          <StatusBanner tone="info" title="Trạng thái hồ sơ nhân sự độc lập với khóa tài khoản">
            Chuyển trạng thái hồ sơ sang <strong>Ngừng hoạt động</strong> không tự khóa tài khoản
            đăng nhập liên kết. Nếu nhân sự nghỉ việc cần chặn đăng nhập hệ thống, hãy dùng nút{" "}
            <strong>Khóa đăng nhập</strong> ngay tại khối <strong>Tài khoản đăng nhập</strong> bên
            dưới.
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

          {/* Blocks 1 & 2 side by side on desktop, stacked cleanly on mobile 390px */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* BLOCK 1: Nhân viên & Tổ chức */}
            <div data-testid="person-block-1-org">
            <Card>
              <CardHeader
                title="1. Nhân viên & Tổ chức"
                description="Mỗi nhân sự chỉ thuộc tối đa một phòng ban chính tại một thời điểm."
              />
              <div className="space-y-4">
                <dl className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-surface-muted/30 p-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted">Mã nhân viên</dt>
                    <dd className="font-mono font-medium text-foreground">{person.employee_code}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Ngày gia nhập</dt>
                    <dd className="font-mono text-foreground">{formatOrgDate(person.joined_on)}</dd>
                  </div>
                </dl>

                {person.active_department ? (
                  <div className="space-y-3">
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
                          disabled={isDialogLocked}
                          onClick={() => openDeptDialog("transfer-dept")}
                        >
                          Chuyển phòng ban
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={isDialogLocked}
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
                        disabled={isDialogLocked}
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

                {/* Collapsible non-exclusive history disclosures (closed by default) */}
                <div className="space-y-2 border-t border-border pt-3">
                  <details className="rounded-lg border border-border bg-surface p-3">
                    <summary className="cursor-pointer select-none text-sm font-medium text-foreground">
                      Lịch sử phòng ban ({person.department_history.length})
                    </summary>
                    <div className="mt-3">
                      {person.department_history.length === 0 ? (
                        <p className="text-xs text-muted">Chưa có lịch sử tham gia phòng ban.</p>
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
                                  Nguồn
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
                                    <StatusBadge
                                      tone={item.ended_at === null ? "success" : "neutral"}
                                    >
                                      {item.ended_at === null ? "Đang hiệu lực" : "Đã kết thúc"}
                                    </StatusBadge>
                                  </td>
                                  <td data-label="Bắt đầu" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                                    {formatOrgTimestamp(item.started_at)}
                                  </td>
                                  <td data-label="Kết thúc" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                                    {item.ended_at ? formatOrgTimestamp(item.ended_at) : "—"}
                                  </td>
                                  <td data-label="Nguồn" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                                    {formatPersonSourceKind(item.source_kind, item.evidence_date)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </DataTableContainer>
                      )}
                    </div>
                  </details>

                  <details className="rounded-lg border border-border bg-surface p-3">
                    <summary className="cursor-pointer select-none text-sm font-medium text-foreground">
                      Lịch sử chức danh Trưởng phòng ({person.head_assignments.length})
                    </summary>
                    <div className="mt-3">
                      {person.head_assignments.length === 0 ? (
                        <p className="text-xs text-muted">
                          Nhân sự chưa từng được bổ nhiệm chức danh Trưởng phòng.
                        </p>
                      ) : (
                        <DataTableContainer>
                          <table className={DATA_TABLE_CLASS}>
                            <thead className={DATA_TABLE_HEAD_CLASS}>
                              <tr>
                                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                                  Phòng ban phụ trách
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
                                  Nguồn
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {person.head_assignments.map((item) => (
                                <tr key={item.head_assignment_id} className={DATA_TABLE_ROW_CLASS}>
                                  <td
                                    data-label="Phòng ban phụ trách"
                                    className={DATA_TABLE_TD_CLASS}
                                  >
                                    <Link
                                      href={`/admin/departments/${encodeURIComponent(item.department_id)}`}
                                      className="font-medium text-foreground hover:text-primary hover:underline"
                                    >
                                      {item.name}
                                    </Link>
                                    <p className="font-mono text-xs text-muted">{item.code}</p>
                                  </td>
                                  <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                                    <StatusBadge
                                      tone={item.ended_at === null ? "primary" : "neutral"}
                                    >
                                      {item.ended_at === null
                                        ? "Đang giữ chức danh"
                                        : "Đã kết thúc"}
                                    </StatusBadge>
                                  </td>
                                  <td data-label="Bắt đầu" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                                    {formatOrgTimestamp(item.started_at)}
                                  </td>
                                  <td data-label="Kết thúc" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                                    {item.ended_at ? formatOrgTimestamp(item.ended_at) : "—"}
                                  </td>
                                  <td data-label="Nguồn" className={`${DATA_TABLE_TD_CLASS} text-xs`}>
                                    {formatPersonSourceKind(item.source_kind, item.evidence_date)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </DataTableContainer>
                      )}
                    </div>
                  </details>
                </div>
              </div>
            </Card>
            </div>

            {/* BLOCK 2: Tài khoản đăng nhập */}
            <div data-testid="person-block-2-login">
            <Card>
              <CardHeader
                title="2. Tài khoản đăng nhập"
                description="Quản lý đăng nhập của riêng nhân viên này. Tách biệt với trạng thái làm việc."
              />
              {person.active_account_link ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-border bg-surface-muted/40 p-3.5 text-sm space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-mono text-sm font-semibold text-foreground">
                        {person.active_account_link.login_id ?? "Chưa có tên đăng nhập"}
                      </p>
                      <StatusBadge
                        tone={person.active_account_link.enabled ? "success" : "warning"}
                        dot
                      >
                        {person.active_account_link.enabled
                          ? "Đang mở đăng nhập"
                          : "Đang khóa đăng nhập"}
                      </StatusBadge>
                    </div>
                    <p className="text-xs text-muted">
                      Tên hiển thị đồng bộ từ họ tên hồ sơ:{" "}
                      <strong className="text-foreground">
                        {person.active_account_link.display_name ?? person.full_name}
                      </strong>
                    </p>
                    <p className="text-xs text-muted">
                      Liên kết từ: {formatOrgTimestamp(person.active_account_link.started_at)} ·{" "}
                      {formatPersonSourceKind(
                        person.active_account_link.source_kind,
                        person.active_account_link.evidence_date,
                      )}
                    </p>
                  </div>

                  <p className="text-xs text-muted">
                    Khóa đăng nhập chỉ chặn phiên đăng nhập hệ thống, không tắt nghĩa vụ chấm công /
                    báo cáo và không đổi trạng thái nhân sự.
                  </p>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isDialogLocked}
                      onClick={openResetPasswordDialog}
                    >
                      Đặt lại mật khẩu
                    </Button>
                    <Button
                      variant={person.active_account_link.enabled ? "danger-outline" : "primary"}
                      size="sm"
                      disabled={isDialogLocked}
                      onClick={openToggleLoginDialog}
                    >
                      {person.active_account_link.enabled
                        ? "Khóa đăng nhập"
                        : "Mở lại đăng nhập"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted">
                    Nhân viên này chưa có tài khoản đăng nhập hệ thống.
                  </p>
                  {person.status === "ACTIVE" ? (
                    <div className="space-y-2.5">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={
                          isDialogLocked ||
                          stepperMode !== null ||
                          pendingCheckpoint !== null ||
                          corruptCheckpointMessage !== null
                        }
                        onClick={() => {
                          if (
                            isDialogLocked ||
                            stepperMode !== null ||
                            pendingCheckpoint !== null ||
                            corruptCheckpointMessage !== null
                          ) {
                            return;
                          }
                          if (syncCheckpointStateNow()) return;
                          setStepperMode({
                            kind: "open-login-existing",
                            person: {
                              person_id: person.person_id,
                              employee_code: person.employee_code,
                              full_name: person.full_name,
                              version: person.version,
                              recruiter_id: person.recruiter_id,
                            },
                          });
                        }}
                      >
                        Mở tài khoản đăng nhập
                      </Button>
                      {pendingCheckpoint !== null || corruptCheckpointMessage !== null ? (
                        <p className="text-xs text-amber-700 dark:text-amber-300">
                          Đang có tiến trình chưa hoàn tất ở đầu trang. Hãy bấm{" "}
                          <strong>Tiếp tục hoàn tất</strong> trước khi mở tài khoản mới.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-xs text-muted">
                      Hồ sơ đang Ngừng làm việc. Cần chuyển trạng thái sang Đang làm việc trước khi
                      mở tài khoản đăng nhập mới.
                    </p>
                  )}
                </div>
              )}
            </Card>
            </div>
          </div>

          {/* BLOCK 3: Nhóm quyền & Phân công */}
          <section data-testid="person-block-3-roles" className="space-y-2">
            {person.active_account_link ? (
              <AccountGroupsSection
                accountRef={person.active_account_link.account_ref}
                canManageGroups={canManageGlobalRoles}
                workspaceGuard={workspaceGuard}
                reloadToken={accountAccessReloadToken}
                onSessionLost={handleSessionLost}
                onAccountVersionChanged={handleAccountVersionChanged}
              />
            ) : (
              <Card>
                <CardHeader
                  title="3. Nhóm quyền & Phân công"
                  description="Quyền thao tác được quản lý theo nhóm gắn với phòng ban."
                />
                <p className="text-sm text-muted">
                  Chưa có tài khoản đăng nhập. Hãy mở tài khoản đăng nhập ở mục phía trên để xếp vào
                  nhóm quyền phù hợp.
                </p>
              </Card>
            )}
          </section>

          {/* BLOCK 4: Nghiệp vụ Tuyển dụng */}
          <div data-testid="person-block-4-recruitment">
          <Card>
            <CardHeader
              title="4. Nghiệp vụ Tuyển dụng"
              description="Hồ sơ tính công tuyển dụng, phân Nhóm và phân công Dự án của nhân sự (nếu có)."
            />
            {person.recruiter_id ? (
              <div className="space-y-4">
                {recruiterState.kind === "loading" ? (
                  <p role="status" className="text-sm text-muted">
                    Đang tải hồ sơ tính công tuyển dụng…
                  </p>
                ) : recruiterState.kind === "error" ? (
                  <div className="space-y-2">
                    <Alert tone="warning" role="alert" title="Không tải được hồ sơ tính công">
                      <p>{recruiterState.message}</p>
                    </Alert>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setRecruiterReloadToken((v) => v + 1)}
                    >
                      Thử tải lại khối Tuyển dụng
                    </Button>
                  </div>
                ) : recruiterState.kind === "ready" ? (
                  <dl className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-surface-muted/35 p-3.5 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="text-xs text-muted">Mã hồ sơ tính công</dt>
                      <dd className="font-mono font-medium text-foreground">
                        {recruiterState.personnel.personnel_code ?? "Chưa cập nhật"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Vị trí</dt>
                      <dd className="font-medium text-foreground">
                        {recruiterState.personnel.personnel_position === "TEAM_LEADER"
                          ? "Trưởng nhóm (TEAM_LEADER)"
                          : "Nhân viên (STAFF)"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Trạng thái hồ sơ tính công</dt>
                      <dd className="mt-0.5">
                        <StatusBadge tone={recruiterState.personnel.active ? "success" : "neutral"}>
                          {recruiterState.personnel.active ? "Đang hoạt động" : "Ngừng hoạt động"}
                        </StatusBadge>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Nhóm hiện tại</dt>
                      <dd className="mt-0.5 flex flex-wrap gap-1">
                        {recruiterState.personnel.team_names.length > 0 ? (
                          recruiterState.personnel.team_names.map((teamName) => (
                            <StatusBadge key={teamName} tone="info">
                              {teamName}
                            </StatusBadge>
                          ))
                        ) : (
                          <span className="text-xs text-muted">Chưa vào nhóm</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/admin/catalog/personnel?recruiter=${encodeURIComponent(person.recruiter_id)}`}
                    className={buttonClasses({ variant: "primary", size: "sm" })}
                  >
                    Mở hồ sơ tính công &amp; phân Nhóm
                  </Link>
                  <Link
                    href="/admin/catalog/teams"
                    className={buttonClasses({ variant: "secondary", size: "sm" })}
                  >
                    Mở quản lý Nhóm &amp; Trưởng nhóm
                  </Link>
                  <Link
                    href="/direct-entry/projects"
                    className={buttonClasses({ variant: "secondary", size: "sm" })}
                  >
                    Mở phân công Dự án (PM)
                  </Link>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted">
                  Nhân viên này hiện chưa có <strong>Hồ sơ tính công tuyển dụng</strong>. Chỉ kích
                  hoạt nếu nhân sự trực tiếp tham gia tuyển dụng / ghi nhận NLĐ.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      isDialogLocked ||
                      person.status !== "ACTIVE" ||
                      !person.active_account_link?.enabled ||
                      !person.active_account_link.login_id
                    }
                    onClick={openActivateRecruiterDialog}
                  >
                    Kích hoạt nghiệp vụ tuyển dụng
                  </Button>
                  <Link
                    href="/admin/catalog/personnel"
                    className={buttonClasses({ variant: "ghost", size: "sm" })}
                  >
                    Xem Danh mục hồ sơ tính công
                  </Link>
                </div>
                {person.status !== "ACTIVE" || !person.active_account_link?.enabled ? (
                  <p className="text-xs text-muted">
                    Yêu cầu hồ sơ nhân viên đang hoạt động và có tài khoản đăng nhập đang mở để kích
                    hoạt tự động từ tài khoản.
                  </p>
                ) : null}
              </div>
            )}
          </Card>
          </div>
        </>
      ) : null}

      {/* Shared Provision & Link Stepper (Open login for existing employee OR Resume checkpoint) */}
      <AccountProvisionAndLinkStepper
        open={stepperMode !== null}
        mode={stepperMode}
        checkpointActorScope={checkpointActorScope}
        workspaceGuard={workspaceGuard}
        canManageGlobalRoles={canManageGlobalRoles}
        storage={storage}
        originOverride={originOverride}
        onClose={handleStepperClose}
        onCompleted={handleStepperCompleted}
        onCheckpointChanged={refreshCheckpointBanner}
        onSessionLost={handleSessionLost}
      />

      {/* Detail Mutation Dialogs (Block 1 Edit/Dept, Block 2 Toggle/Reset/Unlink, Block 4 Activate Recruiter) */}
      <FormDialog
        open={dialog !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isDialogLocked) {
            closeDialog();
          }
        }}
        closeDisabled={isDialogLocked}
        title={dialogTitle}
        description={dialogDescription}
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
                onClick={() => void dispatchIntent(pendingIntent)}
              >
                {busy ? "Đang thử lại…" : "Thử lại đúng yêu cầu"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void reconcileFromServer()}
              >
                Tải lại để đối chiếu
              </Button>
              {uncertainInspected ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={closeDialog}
                >
                  Đã xác minh trên máy chủ · Đóng
                </Button>
              ) : null}
            </div>
          </Alert>
        ) : null}

        {conflictMsg ? (
          <Alert tone="warning" role="alert" title="Dữ liệu vừa thay đổi ở máy chủ">
            <p>{conflictMsg}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void reconcileFromServer()}
              >
                Tải bản mới nhất
              </Button>
              {dialog?.kind === "activate-recruiter" ? (
                <Link
                  href="/admin/catalog/personnel"
                  className={buttonClasses({ variant: "secondary", size: "sm" })}
                >
                  Mở Danh mục hồ sơ tính công
                </Link>
              ) : null}
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
                  Mã nhân viên <span className="text-red-600">*</span>
                </label>
                <input
                  id="edit-person-employee-code"
                  type="text"
                  required
                  maxLength={EMPLOYEE_CODE_MAX_LENGTH}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={isFormInputLocked}
                  value={employeeCode}
                  onChange={(event) => setEmployeeCode(event.target.value)}
                  placeholder="Nhập mã nhân sự nội bộ (2–64 ký tự, không dùng hrp-YYYY-XXXXXX)"
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
                  disabled={isFormInputLocked}
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
                    disabled={isFormInputLocked}
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
                    disabled={isFormInputLocked}
                    value={personStatus}
                    onChange={(event) => setPersonStatus(event.target.value as PersonStatus)}
                    className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                  >
                    <option value="ACTIVE">Đang làm việc</option>
                    <option value="INACTIVE">Ngừng làm việc</option>
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
              onSelect={handleSelectTargetDept}
              excludeDepartmentId={
                dialog.kind === "transfer-dept" ? dialog.baselineDepartmentId : null
              }
              allowClear={false}
              emptyLabel="Không có phòng ban khả dụng"
              disabled={isFormInputLocked}
              onSessionLost={handlePickerSessionLost}
            />
          ) : null}

          {dialog?.kind === "end-dept" && person ? (
            <Alert tone="warning" title="Xác nhận kết thúc phòng ban hiện hành">
              Nhân sự <strong>{person.full_name}</strong> sẽ kết thúc tư cách thành viên tại{" "}
              <strong>{dialog.baselineDepartmentName}</strong> ngay lập tức. Nếu đang giữ chức danh
              Trưởng phòng, vui lòng kết thúc chức danh Trưởng phòng trước.
            </Alert>
          ) : null}

          {dialog?.kind === "toggle-login" && person ? (
            <Alert
              tone={dialog.nextEnabled ? "info" : "warning"}
              title={
                dialog.nextEnabled
                  ? "Xác nhận mở lại đăng nhập"
                  : "Xác nhận khóa đăng nhập hệ thống"
              }
            >
              {dialog.nextEnabled ? (
                <p>
                  Tài khoản của <strong>{person.full_name}</strong> sẽ được phép đăng nhập lại hệ
                  thống. Trạng thái hồ sơ nhân viên giữ nguyên.
                </p>
              ) : (
                <p>
                  Tài khoản của <strong>{person.full_name}</strong> sẽ bị chặn đăng nhập ngay. Khóa
                  đăng nhập không thay đổi trạng thái làm việc và không xóa lịch sử chấm công hoặc
                  báo cáo đã có.
                </p>
              )}
            </Alert>
          ) : null}

          {dialog?.kind === "reset-password" ? (
            <>
              {dialog.loginId ? (
                <p className="text-sm text-muted">
                  Tài khoản: <strong className="font-mono text-foreground">{dialog.loginId}</strong>
                </p>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="person-reset-password"
                    className="mb-1 block text-sm font-medium text-foreground"
                  >
                    Mật khẩu mới <span className="text-red-600">*</span>
                  </label>
                  <input
                    id="person-reset-password"
                    type="password"
                    required
                    autoComplete="new-password"
                    disabled={isFormInputLocked}
                    value={resetPassword}
                    onChange={(event) => setResetPassword(event.target.value)}
                    placeholder="Tối thiểu 8 ký tự"
                    className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label
                    htmlFor="person-reset-password-confirm"
                    className="mb-1 block text-sm font-medium text-foreground"
                  >
                    Xác nhận mật khẩu mới <span className="text-red-600">*</span>
                  </label>
                  <input
                    id="person-reset-password-confirm"
                    type="password"
                    required
                    autoComplete="new-password"
                    disabled={isFormInputLocked}
                    value={resetPasswordConfirm}
                    onChange={(event) => setResetPasswordConfirm(event.target.value)}
                    placeholder="Nhập lại mật khẩu mới"
                    className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                  />
                </div>
              </div>
            </>
          ) : null}

          {dialog?.kind === "activate-recruiter" ? (
            <>
              <StatusBanner tone="info" title="Lưu ý trước khi kích hoạt nghiệp vụ tuyển dụng">
                Thao tác tạo <strong>Hồ sơ tính công tuyển dụng</strong> với mã{" "}
                <strong className="font-mono">{dialog.loginId}</strong> cho người dùng này. Nếu
                người dùng từng có hồ sơ tính công trước đây, vui lòng kiểm tra tại{" "}
                <Link href="/admin/catalog/personnel" className="font-medium underline">
                  Danh mục hồ sơ tính công
                </Link>
                .
              </StatusBanner>
              <div>
                <label
                  htmlFor="activate-recruiter-position"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  Vị trí tuyển dụng
                </label>
                <select
                  id="activate-recruiter-position"
                  disabled={isFormInputLocked}
                  value={recruiterPosition}
                  onChange={(event) =>
                    setRecruiterPosition(event.target.value as PersonnelPosition)
                  }
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                >
                  <option value="STAFF">Nhân viên tuyển dụng (STAFF)</option>
                  <option value="TEAM_LEADER">Trưởng nhóm tuyển dụng (TEAM_LEADER)</option>
                </select>
              </div>
            </>
          ) : null}

          <div>
            <label
              htmlFor="person-detail-reason"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              Lý do thao tác{" "}
              {isReasonRequired ? (
                <span className="text-red-600">*</span>
              ) : (
                <span className="text-xs font-normal text-muted">(tùy chọn)</span>
              )}
            </label>
            <textarea
              id="person-detail-reason"
              required={isReasonRequired}
              rows={2}
              maxLength={REASON_MAX_LENGTH}
              disabled={isFormInputLocked}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                isReasonRequired
                  ? "Nhập lý do thay đổi (1–500 ký tự)…"
                  : "Ghi chú lý do thao tác (không bắt buộc)…"
              }
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
              disabled={isDialogLocked}
              onClick={() => {
                if (!isDialogLocked) {
                  closeDialog();
                }
              }}
            >
              {isManualCheckLocked ? "Đóng" : "Hủy"}
            </Button>
            {!isManualCheckLocked ? (
              <Button type="submit" variant="primary" disabled={isFormInputLocked}>
                {busy ? "Đang lưu…" : "Xác nhận"}
              </Button>
            ) : null}
          </div>
        </form>
      </FormDialog>
    </PageShell>
  );
}
