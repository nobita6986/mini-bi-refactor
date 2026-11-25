"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  DepartmentSelectPicker,
  RecruiterConfirmPicker,
  type SelectedDepartmentOption,
} from "@/components/admin/org-entity-picker";
import type { Wp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
import { Alert } from "@/components/ui/alert";
import { StatusBadge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import {
  buildLinkAccountPersonRequest,
  classifyAccountOrgMutation,
  newAccountIntentKey,
  projectAccountItem,
} from "@/lib/admin/account-access-model";
import {
  buildCreateAccountRequest,
  buildPersonnelFromAccountRequest,
  buildReconcileRequest,
  classifyAccountOperationResponse,
  newAccountOperationKey,
} from "@/lib/admin/account-operation-ui-model";
import {
  classifyPermissionGroupMutationResponse,
  isRecruitmentOperationalGroup,
  newGroupMutationIdempotencyKey,
  projectPermissionGroupsEnvelope,
  summarizeGroupBusinessActions,
  type PermissionGroupSummary,
} from "@/lib/admin/permission-group-ui-model";
import {
  EMPLOYEE_CODE_MAX_LENGTH,
  FULL_NAME_MAX_LENGTH,
  REASON_MAX_LENGTH,
  buildCreatePersonRequest,
  classifyPersonOrgMutationResponse,
  newOrgIdempotencyKey,
  projectPersonDetailEnvelope,
  type MutatePersonRpcProjection,
} from "@/lib/admin/person-org-ui-model";
import {
  classifyProvisionStep2Response,
  clearVerifiedCheckpoint,
  getBrowserOrigin,
  getBrowserSessionStorage,
  persistAndVerifyCheckpoint,
  resolveNextStep4AccountVersion,
  type CheckpointStorageLike,
  type ProvisionCheckpointV2,
  type ProvisionStep4Group,
  type ProvisionStep4Role,
  type ProvisionStep5Recruiter,
} from "@/lib/admin/provision-checkpoint-v2";
import {
  newRoleMutationIdempotencyKey,
} from "@/lib/admin/role-effective-access-model";
import {
  parseActiveTeamCatalogOptions,
  type ActiveTeamSelectOption,
} from "@/lib/admin/team-catalog-model";
import type { AdminPersonnel, PersonnelPosition } from "@/lib/direct-entry/personnel-catalog-contract";

export type ProvisionExistingPersonSnapshot = {
  person_id: string;
  employee_code: string;
  full_name: string;
  version: number;
  recruiter_id: string | null;
};

export type ProvisionStepperMode =
  | { kind: "create-person" }
  | { kind: "open-login-existing"; person: ProvisionExistingPersonSnapshot }
  | { kind: "resume-checkpoint"; checkpoint: ProvisionCheckpointV2 };

export type ProvisionStepperProps = {
  open: boolean;
  mode: ProvisionStepperMode | null;
  checkpointActorScope: string;
  workspaceGuard: Wp4WorkspaceGuard;
  canManageGlobalRoles?: boolean;
  onClose: () => void;
  onCompleted: (result: {
    personId: string;
    accountRef: string | null;
    openedLogin: boolean;
  }) => void;
  onCheckpointChanged?: () => void;
  onSessionLost: (message: string, unauthenticated: boolean) => void;
  /** Injectable storage & origin for deterministic unit/fault-injection testing. */
  storage?: CheckpointStorageLike | null;
  originOverride?: string;
};

const LEGACY_ROLE_TO_SEED_GROUP_CODE: Readonly<Record<string, string>> = {
  ADMIN: "SYSTEM_ADMIN",
  HR_OPERATOR: "HR_CATALOG_OPERATOR",
  RECRUITER: "RECRUITER_OPERATIONS",
};

const TERMINAL_FAILED_INTENT_STATES = new Set(["CONFLICT", "FAILED", "EXPIRED", "BLOCKED"]);

function stepBadge(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case "COMMITTED":
      return { label: "Đã lưu", tone: "success" };
    case "SKIPPED_EXISTING":
      return { label: "Hồ sơ có sẵn", tone: "info" };
    case "SKIPPED":
      return { label: "Không áp dụng", tone: "neutral" };
    case "IN_FLIGHT":
      return { label: "Đang xử lý", tone: "primary" };
    case "UNCERTAIN":
      return { label: "Chưa rõ kết quả", tone: "warning" };
    case "INTENT_RECORDED":
    case "NEEDS_RECONCILE":
      return { label: "Cần đối chiếu", tone: "warning" };
    default:
      return { label: "Chờ thực hiện", tone: "neutral" };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function AccountProvisionAndLinkStepper({
  open,
  mode,
  checkpointActorScope,
  workspaceGuard,
  canManageGlobalRoles = true,
  onClose,
  onCompleted,
  onCheckpointChanged,
  onSessionLost,
  storage,
  originOverride,
}: ProvisionStepperProps) {
  const notify = useNotify();
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const notifyRef = useRef(notify);
  const onCompletedRef = useRef(onCompleted);
  const onCheckpointChangedRef = useRef(onCheckpointChanged);
  const onSessionLostRef = useRef(onSessionLost);

  useEffect(() => {
    notifyRef.current = notify;
    onCompletedRef.current = onCompleted;
    onCheckpointChangedRef.current = onCheckpointChanged;
    onSessionLostRef.current = onSessionLost;
  }, [notify, onCheckpointChanged, onCompleted, onSessionLost]);

  const resolveStorage = useCallback(
    (): CheckpointStorageLike | null =>
      storage !== undefined ? storage : getBrowserSessionStorage(),
    [storage],
  );
  const resolveOrigin = useCallback(
    (): string => originOverride ?? getBrowserOrigin(),
    [originOverride],
  );

  // Form fields (Step 1 Person)
  const [employeeCode, setEmployeeCode] = useState("");
  const [fullName, setFullName] = useState("");
  const [joinedOn, setJoinedOn] = useState("");
  const [selectedDepartment, setSelectedDepartment] = useState<SelectedDepartmentOption | null>(
    null,
  );
  const [reason, setReason] = useState("");

  // Toggle + Step 2 Account fields (password stays strictly in RAM!)
  const [wantLogin, setWantLogin] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");

  // Step 4 Permission Groups & optional Step 5 inline Recruitment setup
  const [availableGroups, setAvailableGroups] = useState<readonly PermissionGroupSummary[]>([]);
  const [availableTeams, setAvailableTeams] = useState<readonly ActiveTeamSelectOption[]>([]);
  const [inlineTeamsError, setInlineTeamsError] = useState<string | null>(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [activateRecruiterInline, setActivateRecruiterInline] = useState(false);
  const [inlineRecruiterPosition, setInlineRecruiterPosition] = useState<PersonnelPosition>("STAFF");
  const [inlineRecruiterTeamId, setInlineRecruiterTeamId] = useState("");
  const [step5PartialFailure, setStep5PartialFailure] = useState<string | null>(null);

  // Step 3 mismatch confirmation state
  const [mismatchConfirmRequired, setMismatchConfirmRequired] = useState(false);
  const [confirmedRecruiter, setConfirmedRecruiter] = useState<AdminPersonnel | null>(null);

  // Active checkpoint & runtime state
  const [checkpoint, setCheckpoint] = useState<ProvisionCheckpointV2 | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifyingResume, setVerifyingResume] = useState(false);
  const [resumeServerError, setResumeServerError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "error" | "warning" | "info" | "success";
    title: string;
    message: string;
  } | null>(null);
  const [step2AllowNewLoginEdit, setStep2AllowNewLoginEdit] = useState(false);
  const [step2NeedsPasswordReentry, setStep2NeedsPasswordReentry] = useState(false);
  const [step3VersionConflict, setStep3VersionConflict] = useState(false);
  const [step3TeamAssignmentBlocked, setStep3TeamAssignmentBlocked] = useState(false);
  const [step3HardBlocked, setStep3HardBlocked] = useState(false);
  const [step4PartialFailure, setStep4PartialFailure] = useState<string | null>(null);
  const [step4VersionConflict, setStep4VersionConflict] = useState(false);
  const [verifiedStep4AccountVersion, setVerifiedStep4AccountVersion] = useState<number | null>(null);

  const clearRamPasswords = useCallback(() => {
    setPassword("");
    setPasswordConfirm("");
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlightRef.current = false;
    };
  }, []);

  // Load active permission groups & recruitment teams when stepper opens
  useEffect(() => {
    if (!open || !canManageGlobalRoles) return;
    const tracked = workspaceGuard.trackController();
    void (async () => {
      try {
        const [grpResp, teamResp] = await Promise.all([
          fetch("/api/admin/access/groups?include_inactive=false", {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          }),
          fetch("/api/admin/catalog/teams?include_inactive=false&page=1&page_size=100", {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          }),
        ]);
        if (!mountedRef.current || !workspaceGuard.isActive(tracked.epoch, tracked.controller)) {
          return;
        }
        if (grpResp.status === 200) {
          const grpJson = await grpResp.json().catch(() => null);
          const projected = projectPermissionGroupsEnvelope(grpJson);
          if (projected) setAvailableGroups(projected.groups.filter((g) => g.active));
        }
        if (teamResp.status === 200) {
          const teamJson = await teamResp.json().catch(() => null);
          const parsedTeams = parseActiveTeamCatalogOptions(teamJson);
          if (parsedTeams.ok) {
            setAvailableTeams(parsedTeams.teams);
            setInlineTeamsError(null);
          } else {
            setAvailableTeams([]);
            setInlineTeamsError("Không thể đọc danh sách tổ đội tuyển dụng đang hoạt động.");
          }
        } else {
          setAvailableTeams([]);
          setInlineTeamsError("Không tải được danh sách tổ đội tuyển dụng đang hoạt động.");
        }
      } catch {
        if (!mountedRef.current || !workspaceGuard.isActive(tracked.epoch, tracked.controller)) {
          return;
        }
        setInlineTeamsError("Không thể kết nối máy chủ để tải danh sách tổ đội tuyển dụng.");
      } finally {
        tracked.release();
      }
    })();
    return () => {
      tracked.controller.abort();
      tracked.release();
    };
  }, [canManageGlobalRoles, open, workspaceGuard]);

  // Initialize state cleanly whenever dialog opens / mode changes
  useEffect(() => {
    let cancelled = false;
    let tracked: ReturnType<Wp4WorkspaceGuard["trackController"]> | null = null;
    void (async () => {
      await Promise.resolve();
      if (cancelled || !mountedRef.current) return;

      if (!open || !mode) {
        inFlightRef.current = false;
        setBusy(false);
        setVerifyingResume(false);
        setResumeServerError(null);
        setFeedback(null);
        setCheckpoint(null);
        setMismatchConfirmRequired(false);
        setConfirmedRecruiter(null);
        setStep2AllowNewLoginEdit(false);
        setStep2NeedsPasswordReentry(false);
        setStep3VersionConflict(false);
        setStep3TeamAssignmentBlocked(false);
        setStep3HardBlocked(false);
        setStep4PartialFailure(null);
        setStep4VersionConflict(false);
        setVerifiedStep4AccountVersion(null);
        setStep5PartialFailure(null);
        clearRamPasswords();
        return;
      }

      setFeedback(null);
      setResumeServerError(null);
      setMismatchConfirmRequired(false);
      setConfirmedRecruiter(null);
      setStep2AllowNewLoginEdit(false);
      setStep2NeedsPasswordReentry(false);
      setStep3VersionConflict(false);
      setStep3TeamAssignmentBlocked(false);
      setStep3HardBlocked(false);
      setStep4PartialFailure(null);
      setStep4VersionConflict(false);
      setVerifiedStep4AccountVersion(null);
      setStep5PartialFailure(null);
      clearRamPasswords();

      if (mode.kind === "create-person") {
        setCheckpoint(null);
        setEmployeeCode("");
        setFullName("");
        setJoinedOn("");
        setSelectedDepartment(null);
        setReason("");
        setWantLogin(false);
        setLoginId("");
        setSelectedGroupIds([]);
        setActivateRecruiterInline(false);
        setInlineRecruiterPosition("STAFF");
        setInlineRecruiterTeamId("");
        return;
      }

      if (mode.kind === "open-login-existing") {
        setCheckpoint(null);
        setEmployeeCode(mode.person.employee_code);
        setFullName(mode.person.full_name);
        setJoinedOn("");
        setSelectedDepartment(null);
        setReason(`Mở tài khoản đăng nhập cho nhân viên ${mode.person.employee_code}`);
        setWantLogin(true);
        setLoginId("");
        setSelectedGroupIds([]);
        setActivateRecruiterInline(false);
        setInlineRecruiterPosition("STAFF");
        setInlineRecruiterTeamId("");
        return;
      }

      // mode.kind === "resume-checkpoint": untrusted storage hint -> hydrate read-only state & verify on server!
      const cp = mode.checkpoint;
      setCheckpoint(cp);
      setWantLogin(cp.flow_kind !== "CREATE_EMPLOYEE_ONLY");
      setEmployeeCode(
        cp.step1_person.payload_snapshot?.employee_code ?? cp.step1_person.existing_employee_code ?? "",
      );
      setFullName(
        cp.step1_person.payload_snapshot?.full_name ?? cp.step1_person.existing_full_name ?? "",
      );
      setJoinedOn(cp.step1_person.payload_snapshot?.joined_on ?? "");
      setReason(
        cp.step1_person.payload_snapshot?.reason ??
          cp.step3_link.payload_snapshot?.reason ??
          cp.step2_account.non_secret_snapshot?.reason ??
          "",
      );
      setLoginId(cp.step2_account.non_secret_snapshot?.login_id ?? "");
      setSelectedGroupIds((cp.step4_groups ?? []).map((g) => g.group_id));
      setActivateRecruiterInline(Boolean(cp.step5_recruiter?.enabled));
      setInlineRecruiterPosition(cp.step5_recruiter?.position ?? "STAFF");
      setInlineRecruiterTeamId(cp.step5_recruiter?.team_id ?? "");
      const cpStep1Settled =
        cp.step1_person.status === "COMMITTED" || cp.step1_person.status === "SKIPPED_EXISTING";
      if (
        cpStep1Settled &&
        cp.flow_kind !== "CREATE_EMPLOYEE_ONLY" &&
        (cp.step2_account.status === "UNCERTAIN" ||
          cp.step2_account.status === "IN_FLIGHT" ||
          (cp.step2_account.status === "INTENT_RECORDED" && cp.step2_account.intent_id === null)) &&
        cp.step2_account.intent_id === null
      ) {
        setStep2NeedsPasswordReentry(true);
      }
      if (
        cpStep1Settled &&
        (((cp.step2_account.status === "NEEDS_RECONCILE" ||
          cp.step2_account.status === "INTENT_RECORDED") &&
          cp.step2_account.intent_state !== null &&
          TERMINAL_FAILED_INTENT_STATES.has(cp.step2_account.intent_state)) ||
          (cp.step2_account.status === "IDLE" && cp.step2_account.idempotency_key === null))
      ) {
        setStep2AllowNewLoginEdit(true);
      }

      // Server-side verification of committed objects before allowing resume actions
      const personIdToVerify = cp.step1_person.committed_person_id;
      if (!personIdToVerify) {
        return;
      }

      tracked = workspaceGuard.trackController();
      setVerifyingResume(true);
      try {
        const personResp = await fetch(
          `/api/admin/organization/persons/${encodeURIComponent(personIdToVerify)}`,
          {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (cancelled || !mountedRef.current || !workspaceGuard.isActive(tracked.epoch, tracked.controller)) {
          return;
        }
        const personJson: unknown = await personResp.json().catch(() => null);
        if (cancelled || !mountedRef.current || !workspaceGuard.isActive(tracked.epoch, tracked.controller)) {
          return;
        }
        if (personResp.status === 401 || personResp.status === 403) {
          clearRamPasswords();
          workspaceGuard.invalidateSession();
          onSessionLostRef.current(
            personResp.status === 401
              ? "Phiên đăng nhập đã hết hiệu lực."
              : "Tài khoản hiện tại không có quyền tiếp tục thao tác này.",
            personResp.status === 401,
          );
          return;
        }
        if (personResp.status === 404) {
          setResumeServerError(
            "Hồ sơ nhân viên trong bản lưu tạm không còn tồn tại trên máy chủ. Hệ thống không tự tạo lại; hãy xóa bản lưu tạm và kiểm tra lại danh sách Người dùng.",
          );
          return;
        }
        if (personResp.status !== 200) {
          setResumeServerError(
            "Không thể xác minh trạng thái hồ sơ nhân viên hiện tại trên máy chủ. Vui lòng thử lại sau.",
          );
          return;
        }
        const projected = projectPersonDetailEnvelope(personJson, personIdToVerify);
        if (!projected) {
          setResumeServerError("Phản hồi xác minh hồ sơ nhân viên chưa đầy đủ.");
          return;
        }
        // P2 #12: Fail fast BEFORE Step 2 if person became INACTIVE or was already linked to another account on server (avoid orphan Auth account).
        if (
          cp.flow_kind !== "CREATE_EMPLOYEE_ONLY" &&
          cp.step2_account.status !== "COMMITTED" &&
          cp.step2_account.committed_account_ref === null
        ) {
          if (projected.person.status !== "ACTIVE") {
            setResumeServerError(
              "Hồ sơ nhân viên trên máy chủ hiện đang Ngừng làm việc. Hệ thống tạm dừng bước mở đăng nhập để tránh tạo tài khoản thừa; hãy xóa bản lưu tạm và kiểm tra lại hồ sơ.",
            );
            return;
          }
          if (projected.person.active_account_link !== null) {
            setResumeServerError(
              "Hồ sơ nhân viên trên máy chủ đã có tài khoản đăng nhập. Hệ thống tạm dừng bước mở đăng nhập để tránh tạo trùng; hãy xóa bản lưu tạm và mở hồ sơ nhân viên.",
            );
            return;
          }
        }
        // Always capture authoritative account_version when person is already linked to the committed account (PR27-R2/P2).
        if (
          projected.person.active_account_link &&
          cp.step2_account.committed_account_ref &&
          projected.person.active_account_link.account_ref === cp.step2_account.committed_account_ref
        ) {
          setVerifiedStep4AccountVersion(projected.person.active_account_link.account_version);
        }
        // If person is already linked to the committed account on server & no remaining steps -> clean finish!
        if (
          projected.person.active_account_link &&
          cp.step2_account.committed_account_ref &&
          projected.person.active_account_link.account_ref === cp.step2_account.committed_account_ref &&
          cp.step3_link.status !== "COMMITTED"
        ) {
          const syncedCp: ProvisionCheckpointV2 = {
            ...cp,
            updated_at: nowIso(),
            step3_link: {
              ...cp.step3_link,
              status: "COMMITTED",
              post_link_account_version: projected.person.active_account_link.account_version,
              post_link_person_version: projected.person.version,
            },
          };
          const remainingRoles = syncedCp.step4_roles.filter((r) => r.status !== "COMMITTED");
          const remainingGroups = (syncedCp.step4_groups ?? []).filter((g) => g.status !== "COMMITTED");
          const hasPendingRecruiter =
            syncedCp.step5_recruiter?.enabled === true &&
            syncedCp.step5_recruiter.status !== "COMMITTED" &&
            syncedCp.step5_recruiter.status !== "SKIPPED";
          if (remainingRoles.length === 0 && remainingGroups.length === 0 && !hasPendingRecruiter) {
            clearVerifiedCheckpoint({
              expectedOrigin: resolveOrigin(),
              expectedActorScope: checkpointActorScope,
              expectedClientFlowId: cp.client_flow_id,
              storage: resolveStorage(),
            });
            onCheckpointChangedRef.current?.();
            notifyRef.current.success({
              title: "Đã xác minh trên máy chủ: hồ sơ và tài khoản đăng nhập đã hoàn tất.",
            });
            onCompletedRef.current({
              personId: projected.person.person_id,
              accountRef: projected.person.active_account_link.account_ref,
              openedLogin: true,
            });
            return;
          }
          persistAndVerifyCheckpoint(syncedCp, resolveStorage());
          setCheckpoint(syncedCp);
          onCheckpointChangedRef.current?.();
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (cancelled || !mountedRef.current || (tracked && !workspaceGuard.isActive(tracked.epoch, tracked.controller))) {
          return;
        }
        setResumeServerError(
          "Không thể kết nối máy chủ để kiểm tra tiến trình trước khi tiếp tục.",
        );
      } finally {
        tracked?.release();
        if (!cancelled && mountedRef.current && (!tracked || workspaceGuard.isActive(tracked.epoch))) {
          setVerifyingResume(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      tracked?.controller.abort();
      tracked?.release();
    };
  }, [
    checkpointActorScope,
    clearRamPasswords,
    mode,
    open,
    resolveOrigin,
    resolveStorage,
    workspaceGuard,
  ]);

  const handleSessionLossInside = useCallback(
    (message: string, unauthenticated: boolean) => {
      clearRamPasswords();
      inFlightRef.current = false;
      workspaceGuard.invalidateSession();
      if (mountedRef.current) {
        setBusy(false);
      }
      onSessionLostRef.current(message, unauthenticated);
    },
    [clearRamPasswords, workspaceGuard],
  );

  const persistCpOrReport = useCallback(
    (nextCp: ProvisionCheckpointV2): ProvisionCheckpointV2 | null => {
      const res = persistAndVerifyCheckpoint(nextCp, resolveStorage());
      if (!res.ok) {
        if (res.reason === "ACTIVE_CHECKPOINT_CONFLICT") {
          onCheckpointChangedRef.current?.();
        }
        setFeedback({
          tone: res.reason === "ACTIVE_CHECKPOINT_CONFLICT" ? "warning" : "error",
          title:
            res.reason === "ACTIVE_CHECKPOINT_CONFLICT"
              ? "Đang có tiến trình chưa hoàn tất trong phiên hiện tại"
              : "Không thể lưu trạng thái tạm trước khi gửi",
          message: res.message,
        });
        return null;
      }
      setCheckpoint(res.checkpoint);
      onCheckpointChangedRef.current?.();
      return res.checkpoint;
    },
    [resolveStorage],
  );

  const finishAndClearCheckpoint = useCallback(
    (
      result: { personId: string; accountRef: string | null; openedLogin: boolean },
      toast: string,
      clientFlowId: string,
    ) => {
      clearRamPasswords();
      clearVerifiedCheckpoint({
        expectedOrigin: resolveOrigin(),
        expectedActorScope: checkpointActorScope,
        expectedClientFlowId: clientFlowId,
        storage: resolveStorage(),
      });
      onCheckpointChangedRef.current?.();
      notifyRef.current.success({ title: toast });
      onCompletedRef.current(result);
    },
    [
      checkpointActorScope,
      clearRamPasswords,
      resolveOrigin,
      resolveStorage,
    ],
  );

  // =========================================================================
  // Step 5 (Optional Inline): Activate Recruiter & Assign Team (PR #28)
  // =========================================================================
  const runStep5Recruiter = useCallback(
    async (
      baseCp: ProvisionCheckpointV2,
      callerEpoch: number,
    ): Promise<void> => {
      const personId = baseCp.step1_person.committed_person_id;
      const accountRef = baseCp.step2_account.committed_account_ref;
      const step5 = baseCp.step5_recruiter;
      if (!personId || !accountRef || !step5 || !step5.enabled || step5.status === "COMMITTED" || step5.status === "SKIPPED") {
        if (personId) {
          finishAndClearCheckpoint(
            { personId, accountRef, openedLogin: true },
            "Đã hoàn tất thêm người dùng, mở đăng nhập và xếp nhóm quyền.",
            baseCp.client_flow_id,
          );
        }
        return;
      }

      let currentCp = baseCp;
      let recruiterId = step5.committed_recruiter_id;
      let recruiterVersion = step5.committed_recruiter_version ?? null;

      // 5a: Create personnel/recruiter profile from account if not yet committed
      if (!recruiterId) {
        const key5a = step5.idempotency_key ?? newAccountOperationKey();
        const frozenVer5a =
          step5.expected_account_version ??
          resolveNextStep4AccountVersion(currentCp, verifiedStep4AccountVersion) ??
          currentCp.step3_link.post_link_account_version ??
          currentCp.step2_account.committed_account_version ??
          1;
        const loginIdValue = currentCp.step2_account.non_secret_snapshot?.login_id ?? loginId;
        const built = buildPersonnelFromAccountRequest({
          accountRef,
          expectedAccountVersion: frozenVer5a,
          loginId: loginIdValue,
          personnelPosition: step5.position,
          reason:
            currentCp.step1_person.payload_snapshot?.reason ??
            "Kích hoạt hồ sơ tính công tuyển dụng khi thêm người dùng",
          idempotencyKey: key5a,
        });
        if (!built.ok) {
          setStep5PartialFailure(built.message);
          setFeedback({
            tone: "warning",
            title: "Đã lưu tài khoản và nhóm quyền — chưa kích hoạt xong tuyển dụng",
            message: built.message,
          });
          return;
        }
        const persisted5a = persistCpOrReport({
          ...currentCp,
          updated_at: nowIso(),
          step5_recruiter: {
            ...step5,
            status: "IN_FLIGHT",
            idempotency_key: key5a,
            expected_account_version: frozenVer5a,
          },
        });
        if (!persisted5a) return;
        currentCp = persisted5a;

        const tracked = workspaceGuard.trackController();
        try {
          const response = await fetch("/api/admin/catalog/personnel/from-account", {
            method: "POST",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": key5a,
            },
            body: JSON.stringify(built.body),
          });
          if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch, tracked.controller)) return;
          const rawJson: unknown = await response.json().catch(() => null);
          if (response.status === 401 || response.status === 403) {
            handleSessionLossInside("Phiên đăng nhập không còn hợp lệ.", response.status === 401);
            return;
          }
          const recObj =
            typeof rawJson === "object" && rawJson !== null && "personnel" in rawJson
              ? ((rawJson as Record<string, unknown>).personnel as Record<string, unknown> | null)
              : null;
          const extractedRecruiterId =
            recObj && typeof recObj.recruiter_id === "string"
              ? recObj.recruiter_id
              : recObj && typeof recObj.id === "string"
                ? recObj.id
                : null;
          const extractedRecruiterVersion =
            recObj &&
            typeof recObj.version === "number" &&
            Number.isSafeInteger(recObj.version) &&
            recObj.version >= 1
              ? recObj.version
              : null;
          if ((response.status === 200 || response.status === 201) && extractedRecruiterId) {
            recruiterId = extractedRecruiterId.toLowerCase();
            recruiterVersion = extractedRecruiterVersion ?? 1;
            const updated = persistCpOrReport({
              ...currentCp,
              updated_at: nowIso(),
              step5_recruiter: {
                ...currentCp.step5_recruiter!,
                committed_recruiter_id: recruiterId,
                committed_recruiter_version: recruiterVersion,
                status: currentCp.step5_recruiter!.team_id ? "IDLE" : "COMMITTED",
              },
            });
            if (!updated) return;
            currentCp = updated;
          } else {
            const classified5a = classifyAccountOperationResponse(response.status, rawJson, {
              operation: "personnel_from_account",
            });
            const isTeamAssignmentConflict5a = classified5a.kind === "active-team-assignment";
            const msg = isTeamAssignmentConflict5a
              ? classified5a.message
              : typeof rawJson === "object" &&
                  rawJson !== null &&
                  typeof (rawJson as Record<string, unknown>).message === "string"
                ? String((rawJson as Record<string, unknown>).message)
                : "Chưa kích hoạt được hồ sơ tuyển dụng lúc này.";
            const isUncertain5a = response.status >= 500;
            const isVersionConflict5a = response.status === 409;
            persistCpOrReport({
              ...currentCp,
              updated_at: nowIso(),
              step5_recruiter: {
                ...currentCp.step5_recruiter!,
                status: isUncertain5a ? "UNCERTAIN" : "IDLE",
                ...(isUncertain5a
                  ? {}
                  : {
                      idempotency_key: null,
                      expected_account_version: null,
                    }),
              },
            });
            if (isUncertain5a) {
              setStep5PartialFailure(null);
              setFeedback({
                tone: "warning",
                title: "Chưa nhận được xác nhận khi kích hoạt tuyển dụng",
                message:
                  "Hồ sơ, tài khoản và nhóm quyền đã được lưu. Hệ thống giữ nguyên yêu cầu đang chờ để bạn bấm \"Tiếp tục thiết lập tuyển dụng\" mà không tạo trùng.",
              });
            } else {
              if (isVersionConflict5a) {
                setStep4VersionConflict(true);
              }
              setStep5PartialFailure(msg);
              setFeedback({
                tone: "warning",
                title: isTeamAssignmentConflict5a
                  ? "Nhân sự đang có phân công Tổ đội hoặc Trưởng nhóm tuyển dụng"
                  : isVersionConflict5a
                    ? "Dữ liệu tài khoản vừa thay đổi trước khi kích hoạt tuyển dụng"
                    : "Đã tạo người dùng và nhóm quyền — chưa hoàn tất bước tuyển dụng",
                message: isTeamAssignmentConflict5a
                  ? `${msg} Sau khi thu hồi hoặc đóng phân công ở Danh mục Tổ đội/Nhóm trưởng, hãy bấm "Tải lại dữ liệu tài khoản mới nhất" rồi bấm "Tiếp tục thiết lập tuyển dụng" (các bước 1–4 đã lưu được giữ nguyên), hoặc bấm "Đóng & Mở hồ sơ".`
                  : isVersionConflict5a
                    ? "Hãy bấm \"Tải lại dữ liệu tài khoản\" rồi thử lại, hoặc bấm \"Đóng & Mở hồ sơ\" để thiết lập tuyển dụng sau."
                    : `${msg} Bạn có thể thử lại hoặc bấm "Đóng & Mở hồ sơ" để thiết lập tuyển dụng sau.`,
              });
            }
            return;
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
          persistCpOrReport({
            ...currentCp,
            updated_at: nowIso(),
            step5_recruiter: { ...currentCp.step5_recruiter!, status: "UNCERTAIN" },
          });
          setStep5PartialFailure(null);
          setFeedback({
            tone: "warning",
            title: "Mất kết nối khi kích hoạt tuyển dụng",
            message:
              "Hồ sơ, tài khoản và nhóm quyền đã được lưu. Bản phục hồi vẫn được giữ nguyên — hãy bấm \"Tiếp tục thiết lập tuyển dụng\" hoặc đóng tạm để hoàn tất sau mà không tạo trùng.",
          });
          return;
        } finally {
          tracked.release();
        }
      }

      // 5b: Assign Recruitment team if selected
      if (recruiterId && currentCp.step5_recruiter?.team_id) {
        const teamId = currentCp.step5_recruiter.team_id;
        const key5b = currentCp.step5_recruiter.team_idempotency_key ?? newOrgIdempotencyKey();
        const persisted5b = persistCpOrReport({
          ...currentCp,
          updated_at: nowIso(),
          step5_recruiter: {
            ...currentCp.step5_recruiter,
            status: "IN_FLIGHT",
            team_idempotency_key: key5b,
          },
        });
        if (!persisted5b) return;
        currentCp = persisted5b;

        const tracked = workspaceGuard.trackController();
        try {
          const response = await fetch(
            `/api/admin/catalog/personnel/${encodeURIComponent(recruiterId)}/team-memberships/${encodeURIComponent(teamId)}`,
            {
              method: "POST",
              cache: "no-store",
              signal: tracked.controller.signal,
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Idempotency-Key": key5b,
              },
              body: JSON.stringify({
                expected_version: recruiterVersion ?? 1,
                reason: "Xếp tổ đội tuyển dụng khi tạo người dùng mới",
                idempotency_key: key5b,
              }),
            },
          );
          if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch, tracked.controller)) return;
          if (response.status === 401 || response.status === 403) {
            handleSessionLossInside("Phiên đăng nhập không còn hợp lệ.", response.status === 401);
            return;
          }
          if (response.status !== 200 && response.status !== 201) {
            const rawJson: unknown = await response.json().catch(() => null);
            const msg =
              typeof rawJson === "object" &&
              rawJson !== null &&
              typeof (rawJson as Record<string, unknown>).message === "string"
                ? String((rawJson as Record<string, unknown>).message)
                : "Chưa xếp được tổ đội tuyển dụng lúc này.";
            const isUncertain5b = response.status >= 500;
            persistCpOrReport({
              ...currentCp,
              updated_at: nowIso(),
              step5_recruiter: {
                ...currentCp.step5_recruiter!,
                status: isUncertain5b ? "UNCERTAIN" : "IDLE",
              },
            });
            if (isUncertain5b) {
              setStep5PartialFailure(null);
              setFeedback({
                tone: "warning",
                title: "Chưa nhận được xác nhận khi xếp tổ đội tuyển dụng",
                message:
                  "Hồ sơ tính công tuyển dụng đã được kích hoạt. Bản phục hồi vẫn được giữ nguyên — hãy bấm \"Tiếp tục thiết lập tuyển dụng\" hoặc đóng tạm để đồng bộ an toàn.",
              });
            } else {
              setStep5PartialFailure(msg);
              setFeedback({
                tone: "warning",
                title: "Đã tạo hồ sơ tuyển dụng — chưa xếp xong tổ đội",
                message: `${msg} Bạn có thể thử lại hoặc bấm "Đóng & Mở hồ sơ" để xếp tổ đội sau.`,
              });
            }
            return;
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
          persistCpOrReport({
            ...currentCp,
            updated_at: nowIso(),
            step5_recruiter: { ...currentCp.step5_recruiter!, status: "UNCERTAIN" },
          });
          setStep5PartialFailure(null);
          setFeedback({
            tone: "warning",
            title: "Mất kết nối khi xếp tổ đội tuyển dụng",
            message:
              "Hồ sơ, tài khoản và hồ sơ tính công tuyển dụng đã được lưu. Bản phục hồi vẫn được giữ nguyên — hãy bấm \"Tiếp tục thiết lập tuyển dụng\" hoặc đóng tạm để hoàn tất sau.",
          });
          return;
        } finally {
          tracked.release();
        }
      }

      finishAndClearCheckpoint(
        { personId, accountRef, openedLogin: true },
        "Đã hoàn tất thêm người dùng, mở đăng nhập, xếp nhóm quyền và thiết lập tuyển dụng.",
        currentCp.client_flow_id,
      );
    },
    [finishAndClearCheckpoint, handleSessionLossInside, loginId, persistCpOrReport, verifiedStep4AccountVersion, workspaceGuard],
  );

  // =========================================================================
  // Step 4 (PR #28): Permission Group Assignments (Sequential with PR27-R2 version tracking)
  // =========================================================================
  const runStep4Groups = useCallback(
    async (
      baseCp: ProvisionCheckpointV2,
      startAccountVersion: number | null,
      callerEpoch: number,
    ): Promise<void> => {
      let currentCp = baseCp;
      let currentAccountVersion = startAccountVersion;
      const accountRef = currentCp.step2_account.committed_account_ref;
      const personId = currentCp.step1_person.committed_person_id;
      if (!accountRef || !personId) return;

      const groups = currentCp.step4_groups ?? [];
      for (let idx = 0; idx < groups.length; idx += 1) {
        const groupEntry = groups[idx];
        if (!groupEntry || groupEntry.status === "COMMITTED") continue;

        const isDispatchedReplay =
          (groupEntry.status === "IN_FLIGHT" || groupEntry.status === "UNCERTAIN") &&
          groupEntry.payload_snapshot !== null;
        const frozenExpectedVersion = isDispatchedReplay
          ? groupEntry.payload_snapshot!.expected_account_version
          : currentAccountVersion;

        if (frozenExpectedVersion === null) {
          setStep4VersionConflict(true);
          setStep4PartialFailure(
            "Chưa có dữ liệu tài khoản mới nhất sau nhóm quyền đã lưu trước đó.",
          );
          setFeedback({
            tone: "warning",
            title: "Cần tải lại dữ liệu tài khoản trước khi thêm nhóm quyền tiếp theo",
            message:
              "Hãy bấm \"Tải lại dữ liệu tài khoản mới nhất\" để đồng bộ trạng thái rồi tiếp tục.",
          });
          return;
        }

        const frozenReason =
          groupEntry.payload_snapshot?.reason ??
          (currentCp.step1_person.payload_snapshot?.reason ||
            currentCp.step3_link.payload_snapshot?.reason ||
            "Xếp nhóm quyền khởi tạo khi thêm người dùng");
        const safeReason =
          frozenReason.trim().length >= 3
            ? frozenReason.trim().slice(0, 500)
            : "Xếp nhóm quyền khởi tạo cho người dùng";

        const nextGroups: ProvisionStep4Group[] = (currentCp.step4_groups ?? []).map((g, i) =>
          i === idx
            ? {
                ...g,
                status: "IN_FLIGHT",
                payload_snapshot: {
                  group_id: g.group_id,
                  expected_account_version: frozenExpectedVersion,
                  reason: safeReason,
                },
              }
            : g,
        );
        const persisted = persistCpOrReport({
          ...currentCp,
          updated_at: nowIso(),
          step4_groups: nextGroups,
        });
        if (!persisted) return;
        currentCp = persisted;

        const tracked = workspaceGuard.trackController();
        try {
          const response = await fetch(
            `/api/admin/access/accounts/${encodeURIComponent(accountRef)}/groups`,
            {
              method: "POST",
              cache: "no-store",
              signal: tracked.controller.signal,
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Idempotency-Key": groupEntry.idempotency_key,
              },
              body: JSON.stringify({
                group_id: groupEntry.group_id,
                expected_account_version: frozenExpectedVersion,
                reason: safeReason,
              }),
            },
          );
          if (
            !mountedRef.current ||
            !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
            !workspaceGuard.isActive(tracked.epoch, tracked.controller)
          ) {
            return;
          }
          const rawJson: unknown = await response.json().catch(() => null);
          if (
            !mountedRef.current ||
            !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
            !workspaceGuard.isActive(tracked.epoch, tracked.controller)
          ) {
            return;
          }
          const outcome = classifyPermissionGroupMutationResponse<{
            account_version?: number;
            membership?: { account_version?: number };
          }>(response.status, rawJson);

          if (outcome.kind === "session-lost") {
            handleSessionLossInside(outcome.message, outcome.unauthenticated);
            return;
          }
          if (outcome.kind === "uncertain") {
            const uncertainGroups: ProvisionStep4Group[] = (currentCp.step4_groups ?? []).map((g, i) =>
              i === idx ? { ...g, status: "UNCERTAIN" } : g,
            );
            persistCpOrReport({ ...currentCp, updated_at: nowIso(), step4_groups: uncertainGroups });
            setFeedback({
              tone: "warning",
              title: `Chưa nhận xác nhận khi thêm vào nhóm "${groupEntry.group_name}"`,
              message:
                "Hồ sơ và tài khoản đăng nhập đã được lưu. Bấm tiếp tục để đồng bộ nhóm quyền an toàn mà không bị trùng.",
            });
            return;
          }
          if (outcome.kind === "conflict" && outcome.code === "VERSION_CONFLICT") {
            const settledGroups: ProvisionStep4Group[] = (currentCp.step4_groups ?? []).map((g, i) =>
              i === idx ? { ...g, status: "IDLE", payload_snapshot: null, committed_account_version: null } : g,
            );
            persistCpOrReport({ ...currentCp, updated_at: nowIso(), step4_groups: settledGroups });
            setStep4VersionConflict(true);
            setStep4PartialFailure(outcome.message);
            setFeedback({
              tone: "warning",
              title: `Dữ liệu tài khoản vừa thay đổi khi thêm vào nhóm "${groupEntry.group_name}"`,
              message: outcome.message,
            });
            return;
          }
          if (outcome.kind !== "applied") {
            const settledGroups: ProvisionStep4Group[] = (currentCp.step4_groups ?? []).map((g, i) =>
              i === idx ? { ...g, status: "IDLE", payload_snapshot: null } : g,
            );
            persistCpOrReport({ ...currentCp, updated_at: nowIso(), step4_groups: settledGroups });
            setStep4PartialFailure(outcome.message);
            setFeedback({
              tone: "warning",
              title: `Đã tạo người dùng — chưa thêm được vào nhóm "${groupEntry.group_name}"`,
              message: `${outcome.message} Bạn có thể đóng hộp thoại và mở hồ sơ người dùng để xếp nhóm sau.`,
            });
            return;
          }

          const resolvedVersion =
            outcome.data?.membership?.account_version ?? outcome.data?.account_version;
          const nextVersion =
            typeof resolvedVersion === "number" && resolvedVersion >= 1
              ? resolvedVersion
              : null;
          currentAccountVersion = nextVersion;
          if (nextVersion !== null) setVerifiedStep4AccountVersion(nextVersion);

          const committedGroups: ProvisionStep4Group[] = (currentCp.step4_groups ?? []).map((g, i) =>
            i === idx ? { ...g, status: "COMMITTED", committed_account_version: nextVersion } : g,
          );
          const afterGroupCp = persistCpOrReport({
            ...currentCp,
            updated_at: nowIso(),
            step4_groups: committedGroups,
          });
          if (!afterGroupCp) return;
          currentCp = afterGroupCp;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
          const uncertainGroups: ProvisionStep4Group[] = (currentCp.step4_groups ?? []).map((g, i) =>
            i === idx ? { ...g, status: "UNCERTAIN" } : g,
          );
          persistCpOrReport({ ...currentCp, updated_at: nowIso(), step4_groups: uncertainGroups });
          setFeedback({
            tone: "warning",
            title: `Mất kết nối khi thêm vào nhóm "${groupEntry.group_name}"`,
            message:
              "Hồ sơ và tài khoản đăng nhập đã được lưu. Bấm tiếp tục để đồng bộ an toàn mà không bị trùng.",
          });
          return;
        } finally {
          tracked.release();
        }
      }

      if (currentCp.step5_recruiter?.enabled && currentCp.step5_recruiter.status !== "COMMITTED") {
        await runStep5Recruiter(currentCp, callerEpoch);
        return;
      }

      finishAndClearCheckpoint(
        { personId, accountRef, openedLogin: true },
        "Đã hoàn tất thêm người dùng, mở đăng nhập và xếp nhóm quyền.",
        currentCp.client_flow_id,
      );
    },
    [finishAndClearCheckpoint, handleSessionLossInside, persistCpOrReport, runStep5Recruiter, workspaceGuard],
  );

  // =========================================================================
  // Step 4 Legacy Resume Fallback: Global Roles (only for pre-upgrade saved state)
  // =========================================================================
  const runStep4Roles = useCallback(
    async (
      baseCp: ProvisionCheckpointV2,
      startAccountVersion: number | null,
      callerEpoch: number,
    ): Promise<void> => {
      let currentCp = baseCp;
      let currentAccountVersion = startAccountVersion;
      const accountRef = currentCp.step2_account.committed_account_ref;
      const personId = currentCp.step1_person.committed_person_id;
      if (!accountRef || !personId) return;

      // Resolve canonical seed groups for any pre-upgrade legacy step4_roles checkpoint
      let groupsCatalog = availableGroups;
      if (groupsCatalog.length === 0) {
        const grpTracked = workspaceGuard.trackController();
        try {
          const grpResp = await fetch("/api/admin/access/groups?include_inactive=false", {
            method: "GET",
            cache: "no-store",
            signal: grpTracked.controller.signal,
            headers: { Accept: "application/json" },
          });
          if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch, grpTracked.controller)) return;
          if (grpResp.status === 401 || grpResp.status === 403) {
            handleSessionLossInside("Phiên đăng nhập không còn hợp lệ.", grpResp.status === 401);
            return;
          }
          if (grpResp.status === 200) {
            const grpJson = await grpResp.json().catch(() => null);
            const projected = projectPermissionGroupsEnvelope(grpJson);
            if (projected) {
              groupsCatalog = projected.groups.filter((g) => g.active);
              setAvailableGroups(groupsCatalog);
            }
          }
        } catch {
          // Handled below if matching group is unavailable.
        } finally {
          grpTracked.release();
        }
      }

      for (let idx = 0; idx < currentCp.step4_roles.length; idx += 1) {
        const roleEntry = currentCp.step4_roles[idx];
        if (!roleEntry || roleEntry.status === "COMMITTED") continue;

        // Already-dispatched UNCERTAIN/IN_FLIGHT items MUST replay their exact frozen
        // payload_snapshot (expected_version + idempotency_key) without masking OCC.
        const isDispatchedReplay =
          (roleEntry.status === "IN_FLIGHT" || roleEntry.status === "UNCERTAIN") &&
          roleEntry.payload_snapshot !== null;
        const frozenExpectedVersion = isDispatchedReplay
          ? roleEntry.payload_snapshot!.expected_version
          : currentAccountVersion;

        if (frozenExpectedVersion === null) {
          setStep4VersionConflict(true);
          setStep4PartialFailure(
            "Chưa xác định được dữ liệu tài khoản hiện hành sau các nhóm quyền đã xếp trước đó.",
          );
          setFeedback({
            tone: "warning",
            title: "Cần tải lại dữ liệu tài khoản mới nhất trước khi tiếp tục",
            message:
              "Nhóm quyền trước đó đã được lưu nhưng chưa có dữ liệu tài khoản xác nhận mới nhất. Hãy bấm \"Tải lại dữ liệu tài khoản mới nhất\" để lấy trạng thái mới nhất từ máy chủ.",
          });
          return;
        }

        const targetGroupCode = LEGACY_ROLE_TO_SEED_GROUP_CODE[roleEntry.role_code];
        const matchedGroup = targetGroupCode
          ? groupsCatalog.find((g) => g.code === targetGroupCode) ?? null
          : null;
        if (!matchedGroup) {
          const msg = "Không tìm thấy nhóm quyền tương ứng để tiếp tục bản lưu tạm trước nâng cấp.";
          setStep4PartialFailure(msg);
          setFeedback({
            tone: "warning",
            title: "Hồ sơ & tài khoản đã liên kết — cần xếp nhóm quyền trên hồ sơ",
            message: `${msg} Bạn có thể bấm "Đóng & Mở hồ sơ" để xếp nhóm quyền trực tiếp trên trang chi tiết người dùng.`,
          });
          return;
        }

        const frozenReason =
          roleEntry.payload_snapshot?.reason ??
          (currentCp.step1_person.payload_snapshot?.reason ||
            currentCp.step3_link.payload_snapshot?.reason ||
            "Xếp nhóm quyền khởi tạo khi mở tài khoản nhân viên");
        const safeReason =
          frozenReason.trim().length >= 3
            ? frozenReason.trim().slice(0, 500)
            : "Xếp nhóm quyền khởi tạo cho nhân viên";

        const nextRoles: ProvisionStep4Role[] = currentCp.step4_roles.map((r, i) =>
          i === idx
            ? {
                ...r,
                status: "IN_FLIGHT",
                payload_snapshot: {
                  role_code: r.role_code,
                  expected_version: frozenExpectedVersion,
                  reason: safeReason,
                },
              }
            : r,
        );
        const persisted = persistCpOrReport({
          ...currentCp,
          updated_at: nowIso(),
          step4_roles: nextRoles,
        });
        if (!persisted) return;
        currentCp = persisted;

        const tracked = workspaceGuard.trackController();
        try {
          const response = await fetch(
            `/api/admin/access/accounts/${encodeURIComponent(accountRef)}/groups`,
            {
              method: "POST",
              cache: "no-store",
              signal: tracked.controller.signal,
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Idempotency-Key": roleEntry.idempotency_key,
              },
              body: JSON.stringify({
                group_id: matchedGroup.group_id,
                expected_account_version: frozenExpectedVersion,
                reason: safeReason,
              }),
            },
          );
          if (
            !mountedRef.current ||
            !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
            !workspaceGuard.isActive(tracked.epoch, tracked.controller)
          ) {
            return;
          }
          const rawJson: unknown = await response.json().catch(() => null);
          if (
            !mountedRef.current ||
            !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
            !workspaceGuard.isActive(tracked.epoch, tracked.controller)
          ) {
            return;
          }
          const outcome = classifyPermissionGroupMutationResponse<{
            account_version?: number;
            membership?: { account_version?: number };
          }>(response.status, rawJson);

          if (outcome.kind === "session-lost") {
            handleSessionLossInside(outcome.message, outcome.unauthenticated);
            return;
          }

          if (outcome.kind === "uncertain") {
            const uncertainRoles: ProvisionStep4Role[] = currentCp.step4_roles.map((r, i) =>
              i === idx ? { ...r, status: "UNCERTAIN" } : r,
            );
            persistCpOrReport({
              ...currentCp,
              updated_at: nowIso(),
              step4_roles: uncertainRoles,
            });
            setFeedback({
              tone: "warning",
              title: `Chưa xác nhận kết quả thêm vào nhóm "${matchedGroup.name}"`,
              message:
                "Hồ sơ nhân viên và tài khoản đã liên kết thành công. Yêu cầu đang chờ vẫn được giữ nguyên để thử gửi lại an toàn mà không bị trùng.",
            });
            return;
          }

          if (outcome.kind === "conflict" && outcome.code === "VERSION_CONFLICT") {
            const settledRoles: ProvisionStep4Role[] = currentCp.step4_roles.map((r, i) =>
              i === idx
                ? {
                    ...r,
                    status: "IDLE",
                    payload_snapshot: null,
                    committed_account_version: null,
                  }
                : r,
            );
            persistCpOrReport({
              ...currentCp,
              updated_at: nowIso(),
              step4_roles: settledRoles,
            });
            setStep4VersionConflict(true);
            setStep4PartialFailure(outcome.message);
            setFeedback({
              tone: "warning",
              title: `Dữ liệu tài khoản vừa thay đổi khi thêm vào nhóm "${matchedGroup.name}"`,
              message: `${outcome.message} Bấm "Tải lại dữ liệu tài khoản mới nhất" để đối chiếu và tiếp tục, hoặc bấm "Đóng & Mở hồ sơ" để xếp nhóm sau.`,
            });
            return;
          }

          if (outcome.kind !== "applied") {
            const settledRoles: ProvisionStep4Role[] = currentCp.step4_roles.map((r, i) =>
              i === idx ? { ...r, status: "IDLE", payload_snapshot: null } : r,
            );
            persistCpOrReport({
              ...currentCp,
              updated_at: nowIso(),
              step4_roles: settledRoles,
            });
            setStep4PartialFailure(outcome.message);
            setFeedback({
              tone: "warning",
              title: `Hồ sơ & tài khoản đã liên kết — chưa thêm được vào nhóm "${matchedGroup.name}"`,
              message: `${outcome.message} Bạn có thể bấm "Đóng & Mở hồ sơ" để xếp nhóm quyền sau.`,
            });
            return;
          }

          const resolvedVersion =
            outcome.data?.membership?.account_version ?? outcome.data?.account_version;
          const nextVersion =
            typeof resolvedVersion === "number" && resolvedVersion >= 1 ? resolvedVersion : null;
          currentAccountVersion = nextVersion;
          if (nextVersion !== null) setVerifiedStep4AccountVersion(nextVersion);
          const committedRoles: ProvisionStep4Role[] = currentCp.step4_roles.map((r, i) =>
            i === idx
              ? {
                  ...r,
                  status: "COMMITTED",
                  committed_account_version: nextVersion,
                }
              : r,
          );
          const afterRoleCp = persistCpOrReport({
            ...currentCp,
            updated_at: nowIso(),
            step4_roles: committedRoles,
          });
          if (!afterRoleCp) return;
          currentCp = afterRoleCp;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
          const uncertainRoles: ProvisionStep4Role[] = currentCp.step4_roles.map((r, i) =>
            i === idx ? { ...r, status: "UNCERTAIN" } : r,
          );
          persistCpOrReport({
            ...currentCp,
            updated_at: nowIso(),
            step4_roles: uncertainRoles,
          });
          setFeedback({
            tone: "warning",
            title: `Mất kết nối khi thêm vào nhóm "${matchedGroup.name}"`,
            message:
              "Hồ sơ nhân viên và tài khoản đã liên kết thành công. Bấm tiếp tục để đồng bộ nhóm quyền an toàn mà không bị trùng.",
          });
          return;
        } finally {
          tracked.release();
        }
      }

      if ((currentCp.step4_groups ?? []).some((g) => g.status !== "COMMITTED")) {
        await runStep4Groups(currentCp, currentAccountVersion, callerEpoch);
        return;
      }
      if (currentCp.step5_recruiter?.enabled && currentCp.step5_recruiter.status !== "COMMITTED") {
        await runStep5Recruiter(currentCp, callerEpoch);
        return;
      }

      finishAndClearCheckpoint(
        { personId, accountRef, openedLogin: true },
        "Đã hoàn tất mở tài khoản, liên kết hồ sơ nhân viên và xếp nhóm quyền.",
        currentCp.client_flow_id,
      );
    },
    [availableGroups, finishAndClearCheckpoint, handleSessionLossInside, persistCpOrReport, runStep4Groups, runStep5Recruiter, workspaceGuard],
  );

  // =========================================================================
  // Step 3: Link Account -> Person (`POST /api/admin/access/accounts/[ref]/person-link`)
  // =========================================================================
  const runStep3Link = useCallback(
    async (
      baseCp: ProvisionCheckpointV2,
      callerEpoch: number,
      overrideConfirmedRecruiterId?: string | null,
      forceNewLinkKey = false,
    ): Promise<void> => {
      const personId = baseCp.step1_person.committed_person_id;
      const accountRef = baseCp.step2_account.committed_account_ref;
      const expectedAccountVersion =
        baseCp.step3_link.payload_snapshot?.expected_account_version ??
        baseCp.step2_account.committed_account_version;
      const expectedPersonVersion =
        baseCp.step3_link.payload_snapshot?.expected_person_version ??
        baseCp.step1_person.committed_person_version;

      if (!personId || !accountRef || !expectedAccountVersion || !expectedPersonVersion) {
        setFeedback({
          tone: "error",
          title: "Thiếu tham chiếu để gắn tài khoản vào hồ sơ",
          message: "Vui lòng kiểm tra trạng thái hồ sơ trên máy chủ trước khi tiếp tục.",
        });
        return;
      }

      const linkKey =
        forceNewLinkKey || !baseCp.step3_link.idempotency_key
          ? newAccountIntentKey()
          : baseCp.step3_link.idempotency_key;

      const linkReason =
        baseCp.step3_link.payload_snapshot?.reason ??
        (baseCp.step1_person.payload_snapshot?.reason ||
          baseCp.step2_account.non_secret_snapshot?.reason ||
          "Gắn tài khoản đăng nhập vào hồ sơ nhân viên");

      const confirmedRecruiterId =
        overrideConfirmedRecruiterId !== undefined
          ? overrideConfirmedRecruiterId
          : baseCp.step3_link.payload_snapshot?.confirmed_recruiter_id ?? null;

      const built = buildLinkAccountPersonRequest({
        personId,
        expectedAccountVersion,
        expectedPersonVersion,
        confirmedRecruiterId,
        reason: linkReason.slice(0, REASON_MAX_LENGTH),
        idempotencyKey: linkKey,
      });
      if (!built.ok) {
        setFeedback({
          tone: "error",
          title: "Dữ liệu liên kết không hợp lệ",
          message: built.message,
        });
        return;
      }

      const persisted = persistCpOrReport({
        ...baseCp,
        updated_at: nowIso(),
        step3_link: {
          ...baseCp.step3_link,
          status: "IN_FLIGHT",
          idempotency_key: built.idempotencyKey,
          payload_snapshot: {
            person_id: built.body.person_id,
            account_ref: accountRef,
            expected_account_version: built.body.expected_account_version,
            expected_person_version: built.body.expected_person_version,
            confirmed_recruiter_id: built.body.confirmed_recruiter_id ?? null,
            reason: built.body.reason,
          },
        },
      });
      if (!persisted) return;

      const tracked = workspaceGuard.trackController();
      try {
        const response = await fetch(
          `/api/admin/access/accounts/${encodeURIComponent(accountRef)}/person-link`,
          {
            method: "POST",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": built.idempotencyKey,
            },
            body: JSON.stringify(built.body),
          },
        );
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller)
        ) {
          return;
        }
        const rawJson: unknown = await response.json().catch(() => null);
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller)
        ) {
          return;
        }

        const outcome = classifyAccountOrgMutation(response.status, rawJson, "link");
        if (outcome.kind === "session-lost") {
          handleSessionLossInside(outcome.message, response.status === 401);
          return;
        }

        if (outcome.kind === "uncertain") {
          persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step3_link: {
              ...persisted.step3_link,
              status: "UNCERTAIN",
            },
          });
          setFeedback({
            tone: "warning",
            title: "Chưa rõ kết quả gắn tài khoản vào hồ sơ",
            message:
              "Hồ sơ nhân viên và tài khoản đều đã tạo thành công. Khóa gửi trùng và phiên bản gốc của bước liên kết được giữ nguyên để thử gửi lại an toàn.",
          });
          return;
        }

        if (outcome.kind === "recruiter-mismatch") {
          persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step3_link: {
              ...persisted.step3_link,
              status: "IDLE",
            },
          });
          setMismatchConfirmRequired(true);
          setFeedback({
            tone: "warning",
            title: "Cần xác nhận hồ sơ tính công tuyển dụng",
            message: outcome.message,
          });
          return;
        }

        if (outcome.kind === "hard-conflict" || outcome.kind === "link-forbidden") {
          persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step3_link: {
              ...persisted.step3_link,
              status: "IDLE",
            },
          });
          setStep3HardBlocked(true);
          setFeedback({
            tone: "error",
            title: "Không thể tự động gắn tài khoản vào hồ sơ",
            message: `${outcome.message} Hồ sơ nhân viên và tài khoản đã tạo vẫn được giữ nguyên trong danh sách Người dùng.`,
          });
          return;
        }

        if (outcome.kind === "active-team-assignment") {
          persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step3_link: {
              ...persisted.step3_link,
              status: "IDLE",
              idempotency_key: null,
              payload_snapshot: null,
            },
          });
          setStep3TeamAssignmentBlocked(true);
          setStep3VersionConflict(false);
          setFeedback({
            tone: "warning",
            title: "Nhân sự hoặc tài khoản đang giữ phân công Tổ đội / Trưởng nhóm",
            message: `${outcome.message} Hồ sơ nhân viên và tài khoản đã lưu (Bước 1–2) vẫn được giữ nguyên. Sau khi thu hồi phân công Trưởng nhóm hoặc kết thúc thành viên Tổ, hãy bấm "Tải lại dữ liệu mới nhất từ máy chủ" rồi thử lại riêng Bước 3.`,
          });
          return;
        }

        if (outcome.kind === "conflict") {
          persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step3_link: {
              ...persisted.step3_link,
              status: "IDLE",
            },
          });
          setStep3TeamAssignmentBlocked(false);
          setStep3VersionConflict(true);
          setFeedback({
            tone: "warning",
            title: "Dữ liệu vừa thay đổi trong lúc gắn tài khoản",
            message: outcome.message,
          });
          return;
        }

        if (outcome.kind !== "applied") {
          persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step3_link: {
              ...persisted.step3_link,
              status: "IDLE",
            },
          });
          setStep3HardBlocked(true);
          setFeedback({
            tone: "error",
            title: "Không thể gắn tài khoản vào hồ sơ",
            message: outcome.message,
          });
          return;
        }

        const postLinkAccountVersion = outcome.projection.account_version;
        const postLinkPersonVersion = outcome.projection.person_version;
        const committedCp = persistCpOrReport({
          ...persisted,
          updated_at: nowIso(),
          step3_link: {
            ...persisted.step3_link,
            status: "COMMITTED",
            post_link_account_version: postLinkAccountVersion,
            post_link_person_version: postLinkPersonVersion,
          },
        });
        if (!committedCp) return;

        const hasPendingGroups = (committedCp.step4_groups ?? []).some(
          (g) => g.status !== "COMMITTED",
        );
        const hasPendingRoles = committedCp.step4_roles.some((r) => r.status !== "COMMITTED");
        const hasPendingRecruiter =
          committedCp.step5_recruiter?.enabled === true &&
          committedCp.step5_recruiter.status !== "COMMITTED" &&
          committedCp.step5_recruiter.status !== "SKIPPED";

        if (hasPendingGroups) {
          await runStep4Groups(committedCp, postLinkAccountVersion, callerEpoch);
          return;
        }
        if (hasPendingRoles) {
          await runStep4Roles(committedCp, postLinkAccountVersion, callerEpoch);
          return;
        }
        if (hasPendingRecruiter) {
          await runStep5Recruiter(committedCp, callerEpoch);
          return;
        }

        finishAndClearCheckpoint(
          { personId, accountRef, openedLogin: true },
          committedCp.flow_kind === "OPEN_LOGIN_FOR_EXISTING_EMPLOYEE"
            ? "Đã mở tài khoản đăng nhập cho nhân viên."
            : "Đã thêm người dùng và mở tài khoản đăng nhập hoàn tất.",
          committedCp.client_flow_id,
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
        persistCpOrReport({
          ...persisted,
          updated_at: nowIso(),
          step3_link: {
            ...persisted.step3_link,
            status: "UNCERTAIN",
          },
        });
        setFeedback({
          tone: "warning",
          title: "Mất kết nối khi gắn tài khoản vào hồ sơ",
          message:
            "Hồ sơ nhân viên và tài khoản đã tạo thành công. Hãy bấm thử lại để hoàn tất bước gắn tài khoản mà không tạo trùng.",
        });
      } finally {
        tracked.release();
      }
    },
    [
      finishAndClearCheckpoint,
      handleSessionLossInside,
      persistCpOrReport,
      runStep4Groups,
      runStep4Roles,
      runStep5Recruiter,
      workspaceGuard,
    ],
  );

  // =========================================================================
  // Step 2a: Create Account (`POST /api/admin/access/accounts`)
  // =========================================================================
  const runStep2CreateAccount = useCallback(
    async (
      baseCp: ProvisionCheckpointV2,
      ramPassword: string,
      ramPasswordConfirm: string,
      callerEpoch: number,
    ): Promise<void> => {
      const snap = baseCp.step2_account.non_secret_snapshot;
      const accountKey = baseCp.step2_account.idempotency_key;
      if (!snap || !accountKey) {
        setFeedback({
          tone: "error",
          title: "Thiếu thông tin tài khoản để tiếp tục",
          message: "Không tìm thấy thông tin tài khoản trong tiến trình hiện tại.",
        });
        return;
      }

      const built = buildCreateAccountRequest({
        loginId: snap.login_id,
        displayName: snap.display_name,
        password: ramPassword,
        passwordConfirm: ramPasswordConfirm,
        reason: snap.reason,
        idempotencyKey: accountKey,
      });
      if (!built.ok) {
        setFeedback({
          tone: "error",
          title: "Thông tin đăng nhập chưa hợp lệ",
          message: built.message,
        });
        return;
      }

      const persisted = persistCpOrReport({
        ...baseCp,
        updated_at: nowIso(),
        step2_account: {
          ...baseCp.step2_account,
          status: "IN_FLIGHT",
        },
      });
      if (!persisted) return;

      const tracked = workspaceGuard.trackController();
      try {
        const response = await fetch("/api/admin/access/accounts", {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": accountKey,
          },
          body: JSON.stringify(built.body),
        });
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller)
        ) {
          return;
        }
        const rawJson: unknown = await response.json().catch(() => null);
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller)
        ) {
          return;
        }

        const outcome = classifyProvisionStep2Response(response.status, rawJson, {
          operation: "create_account",
        });

        if (outcome.kind === "denied") {
          handleSessionLossInside(outcome.message, response.status === 401);
          return;
        }

        if (outcome.kind === "applied") {
          clearRamPasswords();
          setStep2NeedsPasswordReentry(false);
          const committedCp = persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step2_account: {
              ...persisted.step2_account,
              status: "COMMITTED",
              intent_id: outcome.account.intentId,
              intent_state: "APPLIED",
              committed_account_ref: outcome.account.accountRef,
              committed_account_version: outcome.account.accountVersion,
            },
          });
          if (!committedCp) return;
          await runStep3Link(committedCp, callerEpoch);
          return;
        }

        if (outcome.kind === "needs-reconcile") {
          clearRamPasswords();
          setStep2NeedsPasswordReentry(false);
          const reconcileKey =
            persisted.step2_account.reconcile_idempotency_key ?? newAccountIntentKey();
          const isTerminalFail = TERMINAL_FAILED_INTENT_STATES.has(outcome.state);
          persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step2_account: {
              ...persisted.step2_account,
              status: "NEEDS_RECONCILE",
              intent_id: outcome.intentId,
              intent_state: outcome.state,
              reconcile_idempotency_key: reconcileKey,
            },
          });
          setStep2AllowNewLoginEdit(isTerminalFail);
          setFeedback({
            tone: isTerminalFail ? "error" : "warning",
            title: isTerminalFail
              ? "Mở tài khoản đăng nhập chưa thành công"
              : "Cần kiểm tra kết quả mở đăng nhập",
            message: isTerminalFail
              ? `${outcome.message} Hồ sơ nhân viên ở Bước 1 đã được lưu an toàn — bạn có thể đổi tên đăng nhập khác hoặc đóng hộp thoại để mở hồ sơ nhân viên.`
              : `${outcome.message} Mật khẩu đã được xóa khỏi bộ nhớ tạm. Bấm "Kiểm tra lại kết quả mở đăng nhập" — thao tác kiểm tra không cần nhập lại mật khẩu và không tạo thêm tài khoản trùng.`,
          });
          return;
        }

        if (outcome.kind === "conflict" || outcome.kind === "invalid") {
          clearRamPasswords();
          setStep2AllowNewLoginEdit(true);
          persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step2_account: {
              ...persisted.step2_account,
              status: "IDLE",
              idempotency_key: null,
              intent_id: null,
              intent_state: null,
              reconcile_idempotency_key: null,
            },
          });
          setFeedback({
            tone: outcome.kind === "conflict" ? "warning" : "error",
            title:
              outcome.kind === "conflict"
                ? "Tên đăng nhập bị trùng hoặc yêu cầu đang xử lý"
                : "Thông tin tạo tài khoản chưa hợp lệ",
            message: `${outcome.message} Hồ sơ nhân viên vẫn được giữ an toàn — bạn có thể chọn tên đăng nhập khác hoặc kiểm tra lại danh sách Người dùng.`,
          });
          return;
        }

        // unavailable / malformed 200 / 5xx -> keep frozen request key!
        if (outcome.manualCheckRequired || !outcome.preserveIdempotencyKey) {
          clearRamPasswords();
        }
        persistCpOrReport({
          ...persisted,
          updated_at: nowIso(),
          step2_account: {
            ...persisted.step2_account,
            status: "UNCERTAIN",
          },
        });
        setFeedback({
          tone: "warning",
          title: "Chưa nhận được xác nhận tạo tài khoản",
          message:
            "Mật khẩu không lưu vào trình duyệt. Bấm \"Thử đồng bộ lại\" để máy chủ kiểm tra lại đúng yêu cầu trước mà không tạo trùng tài khoản.",
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
        persistCpOrReport({
          ...persisted,
          updated_at: nowIso(),
          step2_account: {
            ...persisted.step2_account,
            status: "UNCERTAIN",
          },
        });
        setFeedback({
          tone: "warning",
          title: "Mất kết nối khi mở tài khoản đăng nhập",
          message:
            "Hồ sơ nhân viên đã lưu an toàn. Bấm \"Thử đồng bộ lại\" để gửi lại đúng yêu cầu trước mà không tạo trùng tài khoản.",
        });
      } finally {
        tracked.release();
      }
    },
    [
      clearRamPasswords,
      handleSessionLossInside,
      persistCpOrReport,
      runStep3Link,
      workspaceGuard,
    ],
  );

  // =========================================================================
  // Step 2b: Reconcile CREATE_ACCOUNT intent (`POST /intents/[intentId]/reconcile`)
  // =========================================================================
  const runStep2Reconcile = useCallback(
    async (baseCp: ProvisionCheckpointV2, callerEpoch: number): Promise<void> => {
      const intentId = baseCp.step2_account.intent_id;
      if (!intentId) return;

      const reconcileKey =
        baseCp.step2_account.reconcile_idempotency_key ?? newAccountIntentKey();
      const built = buildReconcileRequest(reconcileKey);
      if (!built.ok) {
        setFeedback({
          tone: "error",
          title: "Không tạo được yêu cầu đối chiếu",
          message: built.message,
        });
        return;
      }

      const persisted = persistCpOrReport({
        ...baseCp,
        updated_at: nowIso(),
        step2_account: {
          ...baseCp.step2_account,
          reconcile_idempotency_key: reconcileKey,
        },
      });
      if (!persisted) return;

      const tracked = workspaceGuard.trackController();
      try {
        const response = await fetch(
          `/api/admin/access/accounts/intents/${encodeURIComponent(intentId)}/reconcile`,
          {
            method: "POST",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": reconcileKey,
            },
            body: JSON.stringify(built.body),
          },
        );
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller)
        ) {
          return;
        }
        const rawJson: unknown = await response.json().catch(() => null);
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller)
        ) {
          return;
        }

        const outcome = classifyProvisionStep2Response(response.status, rawJson, {
          operation: "reconcile_create_account",
          expectedIntentId: intentId,
        });

        if (outcome.kind === "denied") {
          handleSessionLossInside(outcome.message, response.status === 401);
          return;
        }

        if (outcome.kind === "applied") {
          const committedCp = persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step2_account: {
              ...persisted.step2_account,
              status: "COMMITTED",
              intent_state: "APPLIED",
              committed_account_ref: outcome.account.accountRef,
              committed_account_version: outcome.account.accountVersion,
            },
          });
          if (!committedCp) return;
          await runStep3Link(committedCp, callerEpoch);
          return;
        }

        if (outcome.kind === "needs-reconcile") {
          const isTerminalFail = TERMINAL_FAILED_INTENT_STATES.has(outcome.state);
          persistCpOrReport({
            ...persisted,
            updated_at: nowIso(),
            step2_account: {
              ...persisted.step2_account,
              status: "NEEDS_RECONCILE",
              intent_id: outcome.intentId,
              intent_state: outcome.state,
            },
          });
          setStep2AllowNewLoginEdit(isTerminalFail);
          const stateTitleMap: Record<string, string> = {
            FAILED: "Mở tài khoản không thành công",
            EXPIRED: "Yêu cầu mở tài khoản đã hết hạn",
            CONFLICT: "Tên đăng nhập đã được sử dụng",
            BLOCKED: "Yêu cầu mở tài khoản cần kiểm tra lại",
            INDETERMINATE: "Chưa xác định được kết quả mở tài khoản",
            IN_FLIGHT: "Yêu cầu mở tài khoản đang được xử lý",
            PENDING: "Yêu cầu mở tài khoản đang chờ xử lý",
          };
          setFeedback({
            tone: isTerminalFail ? "error" : "warning",
            title: stateTitleMap[outcome.state] ?? "Chưa hoàn tất kiểm tra kết quả mở đăng nhập",
            message: outcome.message,
          });
          return;
        }

        setFeedback({
          tone: outcome.kind === "conflict" ? "warning" : "error",
          title: "Chưa hoàn tất kiểm tra yêu cầu mở tài khoản",
          message: outcome.message,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
        setFeedback({
          tone: "warning",
          title: "Mất kết nối khi kiểm tra yêu cầu mở tài khoản",
          message:
            "Yêu cầu đang chờ được giữ nguyên. Bạn có thể bấm \"Kiểm tra lại kết quả mở đăng nhập\" an toàn mà không tạo trùng.",
        });
      } finally {
        tracked.release();
      }
    },
    [handleSessionLossInside, persistCpOrReport, runStep3Link, workspaceGuard],
  );

  // =========================================================================
  // Step 1: Create Person (`POST /api/admin/organization/persons`)
  // =========================================================================
  const runStep1CreatePerson = useCallback(
    async (
      baseCp: ProvisionCheckpointV2,
      ramPassword: string,
      ramPasswordConfirm: string,
      callerEpoch: number,
    ): Promise<void> => {
      const snap = baseCp.step1_person.payload_snapshot;
      const personKey = baseCp.step1_person.idempotency_key;
      if (!snap || !personKey) return;

      const built = buildCreatePersonRequest({
        employeeCode: snap.employee_code,
        fullName: snap.full_name,
        joinedOn: snap.joined_on,
        initialDepartmentRef: snap.initial_department_ref,
        accountRef: null,
        expectedAccountVersion: null,
        recruiterId: null,
        reason: snap.reason,
        idempotencyKey: personKey,
      });
      if (!built.ok) {
        clearVerifiedCheckpoint({
          expectedOrigin: resolveOrigin(),
          expectedActorScope: checkpointActorScope,
          expectedClientFlowId: baseCp.client_flow_id,
          storage: resolveStorage(),
        });
        setCheckpoint(null);
        onCheckpointChangedRef.current?.();
        setFeedback({
          tone: "error",
          title: "Thông tin nhân viên chưa hợp lệ",
          message: built.message,
        });
        return;
      }

      const tracked = workspaceGuard.trackController();
      try {
        const response = await fetch("/api/admin/organization/persons", {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": built.idempotencyKey,
          },
          body: JSON.stringify(built.body),
        });
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller)
        ) {
          return;
        }
        const rawJson: unknown = await response.json().catch(() => null);
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(callerEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller)
        ) {
          return;
        }

        const outcome = classifyPersonOrgMutationResponse(response.status, rawJson, "create");
        if (outcome.kind === "session-lost") {
          handleSessionLossInside(outcome.message, outcome.sessionState === "unauthenticated");
          return;
        }

        if (outcome.kind === "uncertain") {
          persistCpOrReport({
            ...baseCp,
            updated_at: nowIso(),
            step1_person: {
              ...baseCp.step1_person,
              status: "UNCERTAIN",
            },
          });
          setFeedback({
            tone: "warning",
            title: "Chưa rõ kết quả tạo hồ sơ nhân viên",
            message:
              "Thông tin tạo mới đã được giữ lại an toàn. Bấm \"Thử đồng bộ lại\" để xác nhận với máy chủ mà không tạo trùng nhân viên.",
          });
          return;
        }

        if (outcome.kind !== "applied") {
          // Deterministic rejection (400 / 409 DUPLICATE_CODE): clear checkpoint so Admin can edit cleanly
          clearVerifiedCheckpoint({
            expectedOrigin: resolveOrigin(),
            expectedActorScope: checkpointActorScope,
            expectedClientFlowId: baseCp.client_flow_id,
            storage: resolveStorage(),
          });
          setCheckpoint(null);
          onCheckpointChangedRef.current?.();
          setFeedback({
            tone: outcome.kind === "conflict" ? "warning" : "error",
            title: "Không thể tạo hồ sơ nhân viên",
            message: outcome.message,
          });
          return;
        }

        const createdPerson = (outcome.data as MutatePersonRpcProjection).person;
        const afterStep1Cp = persistCpOrReport({
          ...baseCp,
          updated_at: nowIso(),
          step1_person: {
            ...baseCp.step1_person,
            status: "COMMITTED",
            committed_person_id: createdPerson.person_id,
            committed_person_version: createdPerson.version,
            existing_employee_code: createdPerson.employee_code,
            existing_full_name: createdPerson.full_name,
            existing_recruiter_id: createdPerson.recruiter_id,
          },
        });
        if (!afterStep1Cp) return;

        if (afterStep1Cp.flow_kind === "CREATE_EMPLOYEE_ONLY") {
          finishAndClearCheckpoint(
            { personId: createdPerson.person_id, accountRef: null, openedLogin: false },
            outcome.replayed
              ? "Đã đối chiếu: hồ sơ nhân viên đã được tạo trước đó."
              : "Đã tạo hồ sơ nhân viên mới.",
            afterStep1Cp.client_flow_id,
          );
          return;
        }

        if (!ramPassword) {
          setFeedback({
            tone: "info",
            title: "Bước 1 đã hoàn tất — nhập mật khẩu tạm để tiếp tục Bước 2",
            message:
              "Hồ sơ nhân viên đã được lưu. Vì lý do bảo mật, mật khẩu tạm không tự lưu khi tải lại trang; hãy nhập mật khẩu tạm để tiếp tục mở đăng nhập (không tạo trùng).",
          });
          return;
        }

        await runStep2CreateAccount(afterStep1Cp, ramPassword, ramPasswordConfirm, callerEpoch);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
        persistCpOrReport({
          ...baseCp,
          updated_at: nowIso(),
          step1_person: {
            ...baseCp.step1_person,
            status: "UNCERTAIN",
          },
        });
        setFeedback({
          tone: "warning",
          title: "Mất kết nối khi lưu hồ sơ nhân viên",
          message:
            "Thông tin đã được giữ lại an toàn. Bấm \"Thử đồng bộ lại\" để gửi lại đúng yêu cầu trước mà không tạo trùng nhân viên.",
        });
      } finally {
        tracked.release();
      }
    },
    [
      checkpointActorScope,
      finishAndClearCheckpoint,
      handleSessionLossInside,
      persistCpOrReport,
      resolveOrigin,
      resolveStorage,
      runStep2CreateAccount,
      workspaceGuard,
    ],
  );

  // Derive fresh-flow mode when checkpoint === null (including after deterministic Step 1 rejection during resume-checkpoint).
  const effectiveFreshMode:
    | { kind: "create-person" }
    | { kind: "open-login-existing"; person: ProvisionExistingPersonSnapshot }
    | null = !mode
    ? null
    : mode.kind !== "resume-checkpoint"
      ? mode
      : mode.checkpoint.flow_kind === "OPEN_LOGIN_FOR_EXISTING_EMPLOYEE" &&
          mode.checkpoint.step1_person.committed_person_id &&
          mode.checkpoint.step1_person.committed_person_version
        ? {
            kind: "open-login-existing",
            person: {
              person_id: mode.checkpoint.step1_person.committed_person_id,
              employee_code: mode.checkpoint.step1_person.existing_employee_code ?? "",
              full_name: mode.checkpoint.step1_person.existing_full_name ?? "",
              version: mode.checkpoint.step1_person.committed_person_version,
              recruiter_id: mode.checkpoint.step1_person.existing_recruiter_id,
            },
          }
        : { kind: "create-person" };

  // =========================================================================
  // Primary form submit / Resume handler
  // =========================================================================
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mode || busy || inFlightRef.current || verifyingResume || resumeServerError) return;

    const callerEpoch = workspaceGuard.getEpoch();

    // Case A: Starting a fresh flow (no active checkpoint yet)
    if (!checkpoint) {
      const origin = resolveOrigin();

      if (effectiveFreshMode?.kind === "create-person") {
        // Validate Step 1 + optional Step 2 BEFORE persisting checkpoint
        const personKey = newOrgIdempotencyKey();
        const step1Check = buildCreatePersonRequest({
          employeeCode,
          fullName,
          joinedOn: joinedOn.trim() || null,
          initialDepartmentRef: selectedDepartment?.department_id ?? null,
          accountRef: null,
          expectedAccountVersion: null,
          recruiterId: null,
          reason,
          idempotencyKey: personKey,
        });
        if (!step1Check.ok) {
          setFeedback({
            tone: "error",
            title: "Thông tin nhân viên chưa hợp lệ",
            message: step1Check.message,
          });
          return;
        }

        let accountKey: string | null = null;
        let step2Snapshot: ProvisionCheckpointV2["step2_account"]["non_secret_snapshot"] = null;
        if (wantLogin) {
          accountKey = newAccountIntentKey();
          const step2Check = buildCreateAccountRequest({
            loginId,
            displayName: step1Check.body.full_name,
            password,
            passwordConfirm,
            reason: step1Check.body.reason,
            idempotencyKey: accountKey,
          });
          if (!step2Check.ok) {
            setFeedback({
              tone: "error",
              title: "Thông tin đăng nhập chưa hợp lệ",
              message: step2Check.message,
            });
            return;
          }
          step2Snapshot = {
            login_id: String(step2Check.body.login_id),
            display_name: String(step2Check.body.display_name),
            reason: typeof step2Check.body.reason === "string" ? step2Check.body.reason : null,
          };
        }

        const step4Groups: ProvisionStep4Group[] = wantLogin
          ? selectedGroupIds
              .map((gid) => availableGroups.find((g) => g.group_id === gid))
              .filter((g): g is PermissionGroupSummary => Boolean(g))
              .map((grp) => ({
                group_id: grp.group_id,
                group_name: grp.name,
                status: "IDLE",
                idempotency_key: newGroupMutationIdempotencyKey(),
                payload_snapshot: null,
              }))
          : [];
        const step5Recruiter: ProvisionStep5Recruiter | null =
          wantLogin && activateRecruiterInline
            ? {
                enabled: true,
                position: inlineRecruiterPosition,
                team_id: inlineRecruiterTeamId.trim() || null,
                status: "IDLE",
                idempotency_key: null,
                team_idempotency_key: null,
                committed_recruiter_id: null,
              }
            : null;

        const initialCp: ProvisionCheckpointV2 = {
          schema_version: 2,
          client_flow_id: newOrgIdempotencyKey(),
          env_origin: origin,
          actor_scope: checkpointActorScope,
          flow_kind: wantLogin ? "CREATE_EMPLOYEE_WITH_LOGIN" : "CREATE_EMPLOYEE_ONLY",
          updated_at: nowIso(),
          step1_person: {
            status: "IN_FLIGHT",
            idempotency_key: step1Check.idempotencyKey,
            payload_snapshot: {
              employee_code: step1Check.body.employee_code,
              full_name: step1Check.body.full_name,
              joined_on: step1Check.body.joined_on ?? null,
              initial_department_ref: step1Check.body.initial_department_ref ?? null,
              reason: step1Check.body.reason,
            },
            committed_person_id: null,
            committed_person_version: null,
            existing_employee_code: null,
            existing_full_name: null,
            existing_recruiter_id: null,
          },
          step2_account: wantLogin
            ? {
                status: "IDLE",
                idempotency_key: accountKey,
                non_secret_snapshot: step2Snapshot,
                intent_id: null,
                intent_state: null,
                reconcile_idempotency_key: null,
                committed_account_ref: null,
                committed_account_version: null,
              }
            : {
                status: "SKIPPED",
                idempotency_key: null,
                non_secret_snapshot: null,
                intent_id: null,
                intent_state: null,
                reconcile_idempotency_key: null,
                committed_account_ref: null,
                committed_account_version: null,
              },
          step3_link: wantLogin
            ? {
                status: "IDLE",
                idempotency_key: newAccountIntentKey(),
                payload_snapshot: null,
                post_link_account_version: null,
                post_link_person_version: null,
              }
            : {
                status: "SKIPPED",
                idempotency_key: null,
                payload_snapshot: null,
                post_link_account_version: null,
                post_link_person_version: null,
              },
          step4_roles: [],
          step4_groups: step4Groups,
          step5_recruiter: step5Recruiter,
        };

        // R1/P1 MANDATORY: Persist + read-back verify BEFORE Step 1 POST /persons!
        const persisted = persistCpOrReport(initialCp);
        if (!persisted) return;

        inFlightRef.current = true;
        setBusy(true);
        setFeedback(null);
        try {
          await runStep1CreatePerson(persisted, password, passwordConfirm, callerEpoch);
        } finally {
          inFlightRef.current = false;
          if (mountedRef.current && workspaceGuard.isActive(callerEpoch)) {
            setBusy(false);
          }
        }
        return;
      }

      if (effectiveFreshMode?.kind === "open-login-existing") {
        const targetPerson = effectiveFreshMode.person;
        const accountKey = newAccountIntentKey();
        const trimmedReason = reason.trim();
        if (trimmedReason.length < 1 || trimmedReason.length > REASON_MAX_LENGTH) {
          setFeedback({
            tone: "error",
            title: "Lý do mở tài khoản là bắt buộc",
            message: `Vui lòng nhập lý do từ 1 đến ${REASON_MAX_LENGTH} ký tự để lưu vết kiểm toán bước liên kết.`,
          });
          return;
        }
        const step2Check = buildCreateAccountRequest({
          loginId,
          displayName: targetPerson.full_name,
          password,
          passwordConfirm,
          reason: trimmedReason,
          idempotencyKey: accountKey,
        });
        if (!step2Check.ok) {
          setFeedback({
            tone: "error",
            title: "Thông tin đăng nhập chưa hợp lệ",
            message: step2Check.message,
          });
          return;
        }

        const step4Groups: ProvisionStep4Group[] = selectedGroupIds
          .map((gid) => availableGroups.find((g) => g.group_id === gid))
          .filter((g): g is PermissionGroupSummary => Boolean(g))
          .map((grp) => ({
            group_id: grp.group_id,
            group_name: grp.name,
            status: "IDLE",
            idempotency_key: newGroupMutationIdempotencyKey(),
            payload_snapshot: null,
          }));
        const step5Recruiter: ProvisionStep5Recruiter | null =
          activateRecruiterInline && !targetPerson.recruiter_id
            ? {
                enabled: true,
                position: inlineRecruiterPosition,
                team_id: inlineRecruiterTeamId.trim() || null,
                status: "IDLE",
                idempotency_key: null,
                team_idempotency_key: null,
                committed_recruiter_id: null,
              }
            : null;

        const initialCp: ProvisionCheckpointV2 = {
          schema_version: 2,
          client_flow_id: newOrgIdempotencyKey(),
          env_origin: origin,
          actor_scope: checkpointActorScope,
          flow_kind: "OPEN_LOGIN_FOR_EXISTING_EMPLOYEE",
          updated_at: nowIso(),
          step1_person: {
            status: "SKIPPED_EXISTING",
            idempotency_key: null,
            payload_snapshot: null,
            committed_person_id: targetPerson.person_id,
            committed_person_version: targetPerson.version,
            existing_employee_code: targetPerson.employee_code,
            existing_full_name: targetPerson.full_name,
            existing_recruiter_id: targetPerson.recruiter_id,
          },
          step2_account: {
            status: "IN_FLIGHT",
            idempotency_key: accountKey,
            non_secret_snapshot: {
              login_id: String(step2Check.body.login_id),
              display_name: String(step2Check.body.display_name),
              reason: trimmedReason,
            },
            intent_id: null,
            intent_state: null,
            reconcile_idempotency_key: null,
            committed_account_ref: null,
            committed_account_version: null,
          },
          step3_link: {
            status: "IDLE",
            idempotency_key: newAccountIntentKey(),
            payload_snapshot: null,
            post_link_account_version: null,
            post_link_person_version: null,
          },
          step4_roles: [],
          step4_groups: step4Groups,
          step5_recruiter: step5Recruiter,
        };

        const persisted = persistCpOrReport(initialCp);
        if (!persisted) return;

        inFlightRef.current = true;
        setBusy(true);
        setFeedback(null);
        try {
          await runStep2CreateAccount(persisted, password, passwordConfirm, callerEpoch);
        } finally {
          inFlightRef.current = false;
          if (mountedRef.current && workspaceGuard.isActive(callerEpoch)) {
            setBusy(false);
          }
        }
        return;
      }

      return;
    }

    // Case B: Continuing / Retrying / Reconciling an existing checkpoint
    inFlightRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      // B1: Step 1 still IN_FLIGHT or UNCERTAIN -> replay exact K_person + snapshot
      if (
        checkpoint.step1_person.status === "IN_FLIGHT" ||
        checkpoint.step1_person.status === "UNCERTAIN"
      ) {
        await runStep1CreatePerson(checkpoint, password, passwordConfirm, callerEpoch);
        return;
      }

      // B2: Step 2 needs reconcile with intent_id (0 password, 0 second Auth call!)
      if (
        (checkpoint.step2_account.status === "NEEDS_RECONCILE" ||
          checkpoint.step2_account.status === "INTENT_RECORDED") &&
        checkpoint.step2_account.intent_id &&
        !step2AllowNewLoginEdit
      ) {
        await runStep2Reconcile(checkpoint, callerEpoch);
        return;
      }

      // B2b: Step 2 after terminal failure / 409 conflict where Admin enters a NEW login_id
      if (
        step2AllowNewLoginEdit &&
        checkpoint.step2_account.status !== "COMMITTED" &&
        checkpoint.step2_account.status !== "SKIPPED"
      ) {
        const freshAccountKey = newAccountIntentKey();
        const displayName =
          checkpoint.step1_person.existing_full_name ??
          checkpoint.step1_person.payload_snapshot?.full_name ??
          fullName;
        const step2Reason =
          checkpoint.step1_person.payload_snapshot?.reason ??
          checkpoint.step2_account.non_secret_snapshot?.reason ??
          reason.trim();
        const builtCheck = buildCreateAccountRequest({
          loginId,
          displayName,
          password,
          passwordConfirm,
          reason: step2Reason || null,
          idempotencyKey: freshAccountKey,
        });
        if (!builtCheck.ok) {
          setFeedback({
            tone: "error",
            title: "Thông tin đăng nhập mới chưa hợp lệ",
            message: builtCheck.message,
          });
          return;
        }
        const updatedCp = persistCpOrReport({
          ...checkpoint,
          updated_at: nowIso(),
          step2_account: {
            status: "IN_FLIGHT",
            idempotency_key: freshAccountKey,
            non_secret_snapshot: {
              login_id: String(builtCheck.body.login_id),
              display_name: String(builtCheck.body.display_name),
              reason: typeof builtCheck.body.reason === "string" ? builtCheck.body.reason : null,
            },
            intent_id: null,
            intent_state: null,
            reconcile_idempotency_key: null,
            committed_account_ref: null,
            committed_account_version: null,
          },
        });
        if (!updatedCp) return;
        setStep2AllowNewLoginEdit(false);
        await runStep2CreateAccount(updatedCp, password, passwordConfirm, callerEpoch);
        return;
      }

      // B2c: Step 2 UNCERTAIN / IN_FLIGHT / IDLE / INTENT_RECORDED (without intent_id) -> replay EXACT frozen K_account!
      if (
        checkpoint.step2_account.status === "IDLE" ||
        checkpoint.step2_account.status === "IN_FLIGHT" ||
        checkpoint.step2_account.status === "UNCERTAIN" ||
        checkpoint.step2_account.status === "INTENT_RECORDED"
      ) {
        await runStep2CreateAccount(checkpoint, password, passwordConfirm, callerEpoch);
        return;
      }

      // B3: Step 3 Link pending/uncertain/mismatch
      if (
        checkpoint.step3_link.status === "IDLE" ||
        checkpoint.step3_link.status === "IN_FLIGHT" ||
        checkpoint.step3_link.status === "UNCERTAIN"
      ) {
        if (mismatchConfirmRequired) {
          if (!confirmedRecruiter) {
            setFeedback({
              tone: "error",
              title: "Chưa chọn hồ sơ tính công để xác nhận",
              message: "Vui lòng chọn đúng hồ sơ tính công tuyển dụng cần giữ khi liên kết.",
            });
            return;
          }
          setMismatchConfirmRequired(false);
          await runStep3Link(checkpoint, callerEpoch, confirmedRecruiter.recruiter_id, true);
          return;
        }
        await runStep3Link(
          checkpoint,
          callerEpoch,
          confirmedRecruiter?.recruiter_id ?? undefined,
        );
        return;
      }

      // B4: Step 4 Permission Groups pending/uncertain
      if ((checkpoint.step4_groups ?? []).some((g) => g.status !== "COMMITTED")) {
        if (step4VersionConflict) return;
        const startVersion = resolveNextStep4AccountVersion(
          checkpoint,
          verifiedStep4AccountVersion,
        );
        setStep4PartialFailure(null);
        await runStep4Groups(checkpoint, startVersion, callerEpoch);
        return;
      }

      // B4-legacy: Step 4 Roles pending/uncertain (only for pre-upgrade saved state)
      if (checkpoint.step4_roles.some((r) => r.status !== "COMMITTED")) {
        if (step4VersionConflict) return;
        const startVersion = resolveNextStep4AccountVersion(
          checkpoint,
          verifiedStep4AccountVersion,
        );
        setStep4PartialFailure(null);
        await runStep4Roles(checkpoint, startVersion, callerEpoch);
        return;
      }

      // B5: Optional inline Recruitment activation & team
      if (
        checkpoint.step5_recruiter?.enabled &&
        checkpoint.step5_recruiter.status !== "COMMITTED" &&
        checkpoint.step5_recruiter.status !== "SKIPPED"
      ) {
        setStep5PartialFailure(null);
        await runStep5Recruiter(checkpoint, callerEpoch);
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && workspaceGuard.isActive(callerEpoch)) {
        setBusy(false);
      }
    }
  };

  // Explicit server version reload ONLY for Step 3 409 VERSION_CONFLICT
  const handleStep3ReloadVersions = async () => {
    if (!checkpoint || busy || inFlightRef.current) return;
    const personId = checkpoint.step1_person.committed_person_id;
    const accountRef = checkpoint.step2_account.committed_account_ref;
    if (!personId || !accountRef) return;

    const callerEpoch = workspaceGuard.getEpoch();
    const tracked = workspaceGuard.trackController();
    inFlightRef.current = true;
    setBusy(true);
    try {
      const [pResp, aResp] = await Promise.all([
        fetch(`/api/admin/organization/persons/${encodeURIComponent(personId)}`, {
          method: "GET",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: { Accept: "application/json" },
        }),
        fetch(`/api/admin/access/accounts/${encodeURIComponent(accountRef)}`, {
          method: "GET",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: { Accept: "application/json" },
        }),
      ]);
      if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch, tracked.controller)) {
        return;
      }
      if (pResp.status === 401 || pResp.status === 403 || aResp.status === 401 || aResp.status === 403) {
        handleSessionLossInside("Phiên đăng nhập không còn hợp lệ.", pResp.status === 401 || aResp.status === 401);
        return;
      }
      const pJson: unknown = await pResp.json().catch(() => null);
      const aJson: unknown = await aResp.json().catch(() => null);
      const projectedP = pResp.status === 200 ? projectPersonDetailEnvelope(pJson, personId) : null;
      const projectedA = aResp.status === 200 ? projectAccountItem(aJson) : null;
      if (!projectedP || !projectedA) {
        setFeedback({
          tone: "warning",
          title: "Không tải được phiên bản mới nhất",
          message: "Vui lòng thử tải lại hoặc mở hồ sơ nhân viên để kiểm tra thủ công.",
        });
        return;
      }
      if (projectedP.person.active_account_link?.account_ref === accountRef) {
        const syncedCp = persistCpOrReport({
          ...checkpoint,
          updated_at: nowIso(),
          step3_link: {
            ...checkpoint.step3_link,
            status: "COMMITTED",
            post_link_account_version: projectedA.version,
            post_link_person_version: projectedP.person.version,
          },
        });
        setStep3VersionConflict(false);
        setStep3TeamAssignmentBlocked(false);
        const hasPendingRoles = Boolean(
          syncedCp?.step4_roles.some((r) => r.status !== "COMMITTED"),
        );
        const hasPendingGroups = Boolean(
          (syncedCp?.step4_groups ?? []).some((g) => g.status !== "COMMITTED"),
        );
        const hasPendingRecruiter = Boolean(
          syncedCp?.step5_recruiter?.enabled &&
            syncedCp.step5_recruiter.status !== "COMMITTED" &&
            syncedCp.step5_recruiter.status !== "SKIPPED",
        );
        if (syncedCp && !hasPendingRoles && !hasPendingGroups && !hasPendingRecruiter) {
          finishAndClearCheckpoint(
            { personId, accountRef, openedLogin: true },
            "Đã xác minh trên máy chủ: tài khoản và hồ sơ nhân viên đã được liên kết.",
            syncedCp.client_flow_id,
          );
          return;
        }
        setVerifiedStep4AccountVersion(projectedA.version);
        setFeedback({
          tone: "info",
          title: "Đã xác minh liên kết trên máy chủ",
          message: "Bạn có thể tiếp tục hoàn tất các bước nhóm quyền và tuyển dụng còn lại.",
        });
        return;
      }

      // Still unlinked with newer versions: prepare fresh K_link for explicit confirmation
      const refreshedCp = persistCpOrReport({
        ...checkpoint,
        updated_at: nowIso(),
        step1_person: {
          ...checkpoint.step1_person,
          committed_person_version: projectedP.person.version,
        },
        step2_account: {
          ...checkpoint.step2_account,
          committed_account_version: projectedA.version,
        },
        step3_link: {
          status: "IDLE",
          idempotency_key: newAccountIntentKey(),
          payload_snapshot: null,
          post_link_account_version: null,
          post_link_person_version: null,
        },
      });
      if (refreshedCp) {
        setStep3VersionConflict(false);
        setStep3TeamAssignmentBlocked(false);
        setFeedback({
          tone: "info",
          title: "Đã cập nhật phiên bản mới nhất từ máy chủ",
          message: "Hãy bấm xác nhận để thực hiện bước liên kết với phiên bản hiện hành.",
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối khi tải phiên bản mới nhất",
        message: "Vui lòng thử tải lại hoặc đóng tạm để kiểm tra lại sau.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      if (mountedRef.current && workspaceGuard.isActive(callerEpoch)) {
        setBusy(false);
      }
    }
  };

  // Explicit server version reload ONLY for Step 4 409 VERSION_CONFLICT or missing legacy committed role version (PR27-R2/P2)
  const handleStep4ReloadAccountVersion = async () => {
    if (!checkpoint || busy || inFlightRef.current) return;
    const accountRef = checkpoint.step2_account.committed_account_ref;
    if (!accountRef) return;

    const callerEpoch = workspaceGuard.getEpoch();
    const tracked = workspaceGuard.trackController();
    inFlightRef.current = true;
    setBusy(true);
    try {
      const aResp = await fetch(`/api/admin/access/accounts/${encodeURIComponent(accountRef)}`, {
        method: "GET",
        cache: "no-store",
        signal: tracked.controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch, tracked.controller)) {
        return;
      }
      if (aResp.status === 401 || aResp.status === 403) {
        handleSessionLossInside("Phiên đăng nhập không còn hợp lệ.", aResp.status === 401);
        return;
      }
      const aJson: unknown = await aResp.json().catch(() => null);
      const projectedA = aResp.status === 200 ? projectAccountItem(aJson) : null;
      if (!projectedA) {
        setFeedback({
          tone: "warning",
          title: "Không tải được dữ liệu tài khoản mới nhất",
          message: "Vui lòng thử tải lại hoặc đóng hộp thoại để mở hồ sơ người dùng và xếp nhóm quyền thủ công.",
        });
        return;
      }

      // Rotate idempotency_key ONLY for deterministically-rejected IDLE items (never COMMITTED/UNCERTAIN/IN_FLIGHT!).
      const refreshedRoles: ProvisionStep4Role[] = checkpoint.step4_roles.map((r) =>
        r.status === "IDLE" && r.payload_snapshot === null
          ? { ...r, idempotency_key: newRoleMutationIdempotencyKey() }
          : r,
      );
      const refreshedGroups: ProvisionStep4Group[] | undefined = checkpoint.step4_groups?.map((g) =>
        g.status === "IDLE" && g.payload_snapshot === null
          ? { ...g, idempotency_key: newGroupMutationIdempotencyKey() }
          : g,
      );
      const refreshedStep5 =
        checkpoint.step5_recruiter && checkpoint.step5_recruiter.status === "IDLE"
          ? {
              ...checkpoint.step5_recruiter,
              idempotency_key: null,
              expected_account_version: null,
            }
          : checkpoint.step5_recruiter;
      const refreshedCp = persistCpOrReport({
        ...checkpoint,
        updated_at: nowIso(),
        step4_roles: refreshedRoles,
        ...(refreshedGroups !== undefined ? { step4_groups: refreshedGroups } : {}),
        ...(refreshedStep5 !== undefined ? { step5_recruiter: refreshedStep5 } : {}),
      });
      if (refreshedCp) {
        setVerifiedStep4AccountVersion(projectedA.version);
        setStep4VersionConflict(false);
        setStep4PartialFailure(null);
        setStep5PartialFailure(null);
        const hasPendingStep4 =
          refreshedRoles.some((r) => r.status !== "COMMITTED") ||
          (refreshedGroups ?? []).some((g) => g.status !== "COMMITTED");
        setFeedback({
          tone: "info",
          title: "Đã cập nhật dữ liệu tài khoản mới nhất",
          message: hasPendingStep4
            ? "Hãy bấm \"Tiếp tục xếp nhóm quyền còn lại\" để hoàn tất."
            : "Hãy bấm \"Tiếp tục thiết lập tuyển dụng\" để hoàn tất.",
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối khi tải dữ liệu tài khoản mới nhất",
        message: "Vui lòng thử tải lại hoặc đóng hộp thoại để kiểm tra trên hồ sơ người dùng.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      if (mountedRef.current && workspaceGuard.isActive(callerEpoch)) {
        setBusy(false);
      }
    }
  };

  const handleDiscardLocalCheckpoint = () => {
    clearRamPasswords();
    if (checkpoint) {
      clearVerifiedCheckpoint({
        expectedOrigin: resolveOrigin(),
        expectedActorScope: checkpointActorScope,
        expectedClientFlowId: checkpoint.client_flow_id,
        storage: resolveStorage(),
        forceCorruptCleanup: true,
      });
    } else {
      clearVerifiedCheckpoint({
        expectedOrigin: resolveOrigin(),
        expectedActorScope: checkpointActorScope,
        storage: resolveStorage(),
        forceCorruptCleanup: true,
        corruptOnly: true,
      });
    }
    onCheckpointChangedRef.current?.();
    onClose();
  };

  const step1Settled =
    checkpoint !== null &&
    (checkpoint.step1_person.status === "COMMITTED" ||
      checkpoint.step1_person.status === "SKIPPED_EXISTING");

  const step2HasReconcilableIntent =
    step1Settled &&
    (checkpoint.step2_account.status === "NEEDS_RECONCILE" ||
      checkpoint.step2_account.status === "INTENT_RECORDED") &&
    checkpoint.step2_account.intent_id !== null &&
    !step2AllowNewLoginEdit;

  const step2PreIntentUncertain =
    step1Settled &&
    checkpoint.flow_kind !== "CREATE_EMPLOYEE_ONLY" &&
    (checkpoint.step2_account.status === "UNCERTAIN" ||
      checkpoint.step2_account.status === "IN_FLIGHT" ||
      (checkpoint.step2_account.status === "INTENT_RECORDED" &&
        checkpoint.step2_account.intent_id === null)) &&
    checkpoint.step2_account.intent_id === null;

  const isCoreStepUncertain =
    checkpoint !== null &&
    (checkpoint.step1_person.status === "IN_FLIGHT" ||
      checkpoint.step1_person.status === "UNCERTAIN" ||
      step2PreIntentUncertain ||
      step2HasReconcilableIntent ||
      checkpoint.step3_link.status === "IN_FLIGHT" ||
      checkpoint.step3_link.status === "UNCERTAIN");

  const isStep4Or5Uncertain =
    checkpoint !== null &&
    (checkpoint.step4_roles.some((r) => r.status === "IN_FLIGHT" || r.status === "UNCERTAIN") ||
      (checkpoint.step4_groups ?? []).some(
        (g) => g.status === "IN_FLIGHT" || g.status === "UNCERTAIN",
      ) ||
      checkpoint.step5_recruiter?.status === "IN_FLIGHT" ||
      checkpoint.step5_recruiter?.status === "UNCERTAIN");

  const isUncertainState = isCoreStepUncertain || isStep4Or5Uncertain;

  const needsPasswordReentryForFrozenStep2 =
    step2NeedsPasswordReentry && step2PreIntentUncertain;

  // Core steps (1-3) keep PR27-R1/R2 close lock during unresolved UNCERTAIN/IN_FLIGHT;
  // Step 4/5 UNCERTAIN allows temporary close WITHOUT wiping the browser checkpoint (UX-04).
  const isCloseDisabled =
    busy ||
    verifyingResume ||
    (isCoreStepUncertain &&
      !needsPasswordReentryForFrozenStep2 &&
      !step3HardBlocked &&
      !step3VersionConflict &&
      !step3TeamAssignmentBlocked &&
      !mismatchConfirmRequired &&
      !resumeServerError);

  const committedPersonId = checkpoint?.step1_person.committed_person_id ?? null;
  const committedAccountRef = checkpoint?.step2_account.committed_account_ref ?? null;

  // Only allow "Đóng & Mở hồ sơ" (which clears checkpoint AND navigates to profile)
  // when NO step is IN_FLIGHT/UNCERTAIN and a deterministic Step 4/5 error settled to IDLE.
  const canClearAndOpenProfile =
    !isUncertainState &&
    Boolean(step4PartialFailure || step5PartialFailure) &&
    committedPersonId !== null &&
    checkpoint !== null;

  const showStep5Progress =
    wantLogin && Boolean(activateRecruiterInline || checkpoint?.step5_recruiter?.enabled);

  const step1Locked =
    busy ||
    verifyingResume ||
    effectiveFreshMode?.kind === "open-login-existing" ||
    checkpoint !== null;

  const step2NonSecretLocked =
    busy ||
    verifyingResume ||
    (checkpoint !== null && !step2AllowNewLoginEdit);

  const showPasswordInputs =
    wantLogin &&
    (checkpoint === null ||
      (step1Settled &&
        (step2AllowNewLoginEdit ||
          step2PreIntentUncertain ||
          (checkpoint.step2_account.status === "IDLE" &&
            checkpoint.step2_account.intent_id === null))));

  const hasSelectedRecruitmentGroup = selectedGroupIds.some((gid) => {
    const grp = availableGroups.find((g) => g.group_id === gid);
    return grp ? isRecruitmentOperationalGroup(grp) : false;
  });

  const dialogTitle =
    effectiveFreshMode?.kind === "open-login-existing" && mode?.kind !== "resume-checkpoint"
      ? `Mở tài khoản đăng nhập — ${effectiveFreshMode.person.full_name}`
      : mode?.kind === "resume-checkpoint"
        ? "Tiếp tục hoàn tất thêm người dùng & mở đăng nhập"
        : "Thêm người dùng mới";

  const primaryButtonLabel = (() => {
    if (busy) return "Đang xử lý…";
    if (!checkpoint) {
      if (effectiveFreshMode?.kind === "open-login-existing") return "Mở đăng nhập";
      return wantLogin ? "Tạo người dùng & Mở đăng nhập" : "Tạo hồ sơ người dùng";
    }
    if (checkpoint.step1_person.status === "UNCERTAIN" || checkpoint.step1_person.status === "IN_FLIGHT") {
      return "Thử đồng bộ lại bước 1";
    }
    if (step2HasReconcilableIntent) {
      return "Kiểm tra lại kết quả mở đăng nhập";
    }
    if (step2AllowNewLoginEdit) {
      return "Tạo tài khoản với tên đăng nhập mới";
    }
    if (step2PreIntentUncertain) {
      return needsPasswordReentryForFrozenStep2
        ? "Đồng bộ lại mở đăng nhập với mật khẩu vừa nhập"
        : "Thử đồng bộ lại bước mở đăng nhập";
    }
    if (checkpoint.step2_account.status === "IDLE" && checkpoint.flow_kind !== "CREATE_EMPLOYEE_ONLY") {
      return "Tiếp tục mở tài khoản đăng nhập";
    }
    if (checkpoint.step3_link.status !== "COMMITTED" && checkpoint.step3_link.status !== "SKIPPED") {
      return mismatchConfirmRequired
        ? "Xác nhận hồ sơ tính công & Tiếp tục"
        : checkpoint.step3_link.status === "UNCERTAIN"
          ? "Thử đồng bộ lại bước gắn tài khoản"
          : "Gắn tài khoản vào hồ sơ";
    }
    if (
      (checkpoint.step4_groups ?? []).some((g) => g.status !== "COMMITTED") ||
      checkpoint.step4_roles.some((r) => r.status !== "COMMITTED")
    ) {
      return "Tiếp tục xếp nhóm quyền còn lại";
    }
    return "Tiếp tục thiết lập tuyển dụng";
  })();

  const step4Badge = (() => {
    const grpList = checkpoint ? (checkpoint.step4_groups ?? []) : null;
    const roleList = checkpoint ? checkpoint.step4_roles : null;
    const totalSelected = checkpoint
      ? (grpList?.length ?? 0) + (roleList?.length ?? 0)
      : selectedGroupIds.length;
    if (!wantLogin || totalSelected === 0) {
      return { label: "Cơ bản", tone: "neutral" as BadgeTone };
    }
    if (
      checkpoint &&
      (grpList ?? []).every((g) => g.status === "COMMITTED") &&
      (roleList ?? []).every((r) => r.status === "COMMITTED")
    ) {
      return { label: "Đã lưu", tone: "success" as BadgeTone };
    }
    if (
      checkpoint &&
      ((grpList ?? []).some((g) => g.status === "UNCERTAIN") ||
        (roleList ?? []).some((r) => r.status === "UNCERTAIN"))
    ) {
      return { label: "Chưa rõ", tone: "warning" as BadgeTone };
    }
    return { label: `${totalSelected} nhóm`, tone: "neutral" as BadgeTone };
  })();

  const renderFeedbackAlert = () =>
    feedback ? (
      <Alert
        tone={feedback.tone === "success" ? "info" : feedback.tone}
        role={feedback.tone === "error" || feedback.tone === "warning" ? "alert" : "status"}
        title={feedback.title}
      >
        <p>{feedback.message}</p>
        {step3VersionConflict || step3TeamAssignmentBlocked ? (
          <div className="mt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void handleStep3ReloadVersions()}
            >
              Tải lại dữ liệu mới nhất từ máy chủ
            </Button>
          </div>
        ) : null}
        {step4VersionConflict ? (
          <div className="mt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void handleStep4ReloadAccountVersion()}
            >
              Tải lại dữ liệu tài khoản mới nhất
            </Button>
          </div>
        ) : null}
      </Alert>
    ) : null;

  const showFeedbackAtTop = Boolean(
    feedback &&
      (isUncertainState ||
        step4PartialFailure ||
        step5PartialFailure ||
        step3VersionConflict ||
        step3TeamAssignmentBlocked ||
        step4VersionConflict ||
        resumeServerError ||
        mismatchConfirmRequired),
  );

  return (
    <FormDialog
      open={open && mode !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isCloseDisabled) {
          // Temporary close via Esc/backdrop NEVER wipes checkpoint (preserves recovery banner & frozen keys).
          clearRamPasswords();
          onCheckpointChangedRef.current?.();
          onClose();
        }
      }}
      title={dialogTitle}
      description={
        wantLogin
          ? showStep5Progress
            ? "Thực hiện lần lượt: Thông tin người dùng → Tài khoản đăng nhập → Gắn hồ sơ → Nhóm quyền → Tuyển dụng. Các bước đã lưu trên máy chủ sẽ không bị tạo lại."
            : "Thực hiện lần lượt: Thông tin người dùng → Tài khoản đăng nhập → Gắn hồ sơ → Nhóm quyền. Các bước đã lưu trên máy chủ sẽ không bị tạo lại."
          : "Tạo hồ sơ nhân viên (chưa mở đăng nhập). Bạn có thể mở đăng nhập bất cứ lúc nào sau đó."
      }
      closeDisabled={isCloseDisabled}
      contentClassName="sm:w-[min(46rem,calc(100vw-2rem))]"
      dataTestId="provision-and-link-stepper-dialog"
    >
      <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
        {/* Progress Stepper Banner */}
        <ol
          aria-label="Tiến trình thực hiện"
          data-testid="provision-stepper-progress"
          className={`grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-muted/40 p-3 text-xs ${
            showStep5Progress ? "sm:grid-cols-5" : "sm:grid-cols-4"
          }`}
        >
          <li className="flex flex-col items-start gap-1.5 rounded-md border border-border/60 bg-surface px-2.5 py-2">
            <span className="font-medium text-foreground">1. Hồ sơ</span>
            <StatusBadge
              tone={stepBadge(checkpoint?.step1_person.status ?? (mode?.kind === "open-login-existing" ? "SKIPPED_EXISTING" : "IDLE")).tone}
            >
              {stepBadge(checkpoint?.step1_person.status ?? (mode?.kind === "open-login-existing" ? "SKIPPED_EXISTING" : "IDLE")).label}
            </StatusBadge>
          </li>
          <li className="flex flex-col items-start gap-1.5 rounded-md border border-border/60 bg-surface px-2.5 py-2">
            <span className="font-medium text-foreground">2. Đăng nhập</span>
            <StatusBadge tone={stepBadge(checkpoint?.step2_account.status ?? (wantLogin ? "IDLE" : "SKIPPED")).tone}>
              {stepBadge(checkpoint?.step2_account.status ?? (wantLogin ? "IDLE" : "SKIPPED")).label}
            </StatusBadge>
          </li>
          <li className="flex flex-col items-start gap-1.5 rounded-md border border-border/60 bg-surface px-2.5 py-2">
            <span className="font-medium text-foreground">3. Gắn hồ sơ</span>
            <StatusBadge tone={stepBadge(checkpoint?.step3_link.status ?? (wantLogin ? "IDLE" : "SKIPPED")).tone}>
              {stepBadge(checkpoint?.step3_link.status ?? (wantLogin ? "IDLE" : "SKIPPED")).label}
            </StatusBadge>
          </li>
          <li className="flex flex-col items-start gap-1.5 rounded-md border border-border/60 bg-surface px-2.5 py-2">
            <span className="font-medium text-foreground">4. Nhóm quyền</span>
            <StatusBadge tone={step4Badge.tone}>{step4Badge.label}</StatusBadge>
          </li>
          {showStep5Progress ? (
            <li
              className="flex flex-col items-start gap-1.5 rounded-md border border-border/60 bg-surface px-2.5 py-2"
              aria-current={
                checkpoint?.step5_recruiter?.status === "IN_FLIGHT" ||
                checkpoint?.step5_recruiter?.status === "UNCERTAIN"
                  ? "step"
                  : undefined
              }
            >
              <span className="font-medium text-foreground">5. Tuyển dụng</span>
              <StatusBadge tone={stepBadge(checkpoint?.step5_recruiter?.status ?? "IDLE").tone}>
                {stepBadge(checkpoint?.step5_recruiter?.status ?? "IDLE").label}
              </StatusBadge>
            </li>
          ) : null}
        </ol>

        {showFeedbackAtTop ? renderFeedbackAlert() : null}

        {verifyingResume ? (
          <p role="status" className="text-sm text-muted">
            Đang kiểm tra trạng thái đã lưu trên máy chủ…
          </p>
        ) : null}

        {resumeServerError ? (
          <Alert tone="error" role="alert" title="Không thể tiếp tục tự động">
            <p>{resumeServerError}</p>
          </Alert>
        ) : null}

        {committedPersonId ? (
          <Alert tone="info" role="status" title="Hồ sơ nhân viên đã lưu trên máy chủ">
            <p>
              Người dùng <strong>{fullName || employeeCode}</strong> ({employeeCode}) đã được lưu
              trên máy chủ và sẽ không bị tạo lại.{" "}
              <Link
                href={`/admin/organization/persons/${encodeURIComponent(committedPersonId)}`}
                className="font-medium text-primary underline"
              >
                Mở hồ sơ người dùng
              </Link>
            </p>
          </Alert>
        ) : null}

        {/* Part A: Step 1 Person Fields */}
        {effectiveFreshMode?.kind === "create-person" ? (
          <fieldset className="space-y-3 rounded-lg border border-border p-3.5">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Phần 1 — Thông tin nhân viên
            </legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1 text-sm font-medium text-foreground">
                <label htmlFor="create-person-employee-code">Mã nhân viên (bắt buộc)</label>
                <input
                  id="create-person-employee-code"
                  type="text"
                  required
                  value={employeeCode}
                  maxLength={EMPLOYEE_CODE_MAX_LENGTH}
                  disabled={step1Locked}
                  placeholder="Nhập mã nhân sự nội bộ (2–64 ký tự)"
                  onChange={(e) => setEmployeeCode(e.target.value)}
                  className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                />
              </div>
              <div className="flex flex-col gap-1 text-sm font-medium text-foreground">
                <label htmlFor="create-person-full-name">Họ và tên (bắt buộc)</label>
                <input
                  id="create-person-full-name"
                  type="text"
                  required
                  value={fullName}
                  maxLength={FULL_NAME_MAX_LENGTH}
                  disabled={step1Locked}
                  placeholder="Nhập họ tên đầy đủ"
                  onChange={(e) => setFullName(e.target.value)}
                  className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                />
              </div>
              <div className="flex flex-col gap-1 text-sm font-medium text-foreground">
                <label htmlFor="create-person-joined-on">Ngày gia nhập (tùy chọn)</label>
                <input
                  id="create-person-joined-on"
                  type="date"
                  value={joinedOn}
                  disabled={step1Locked}
                  onChange={(e) => setJoinedOn(e.target.value)}
                  className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                />
              </div>
              <DepartmentSelectPicker
                id="create-person-initial-department"
                label="Phòng ban ban đầu (tùy chọn)"
                selectedId={selectedDepartment?.department_id ?? null}
                onSelect={setSelectedDepartment}
                includeInactive={false}
                allowClear
                emptyLabel="Chưa gán phòng ban ngay"
                disabled={step1Locked}
                onSessionLost={(msg) => handleSessionLossInside(msg, false)}
              />
            </div>

            <div className="flex flex-col gap-1 text-sm font-medium text-foreground">
              <label htmlFor="create-person-reason">Lý do thao tác (bắt buộc)</label>
              <textarea
                id="create-person-reason"
                required
                rows={2}
                value={reason}
                maxLength={REASON_MAX_LENGTH}
                disabled={step1Locked}
                placeholder="Ví dụ: Tiếp nhận nhân viên mới vào phòng ban…"
                onChange={(e) => setReason(e.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-2 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
              />
            </div>
          </fieldset>
        ) : (
          <div className="flex flex-col gap-1 text-sm font-medium text-foreground">
            <label htmlFor="open-login-reason">Lý do mở tài khoản đăng nhập (bắt buộc)</label>
            <textarea
              id="open-login-reason"
              required
              rows={2}
              value={reason}
              maxLength={REASON_MAX_LENGTH}
              disabled={step2NonSecretLocked}
              onChange={(e) => setReason(e.target.value)}
              className="rounded-md border border-border bg-surface px-3 py-2 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
            />
          </div>
        )}

        {/* Toggle: open login now (only in fresh create-person mode) */}
        {effectiveFreshMode?.kind === "create-person" && !checkpoint ? (
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm font-medium text-foreground">
            <input
              id="provision-want-login-toggle"
              type="checkbox"
              checked={wantLogin}
              disabled={busy}
              onChange={(e) => {
                setWantLogin(e.target.checked);
                if (!e.target.checked) {
                  clearRamPasswords();
                  setSelectedGroupIds([]);
                  setActivateRecruiterInline(false);
                  setInlineRecruiterTeamId("");
                }
              }}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span>Mở tài khoản đăng nhập cho người dùng này ngay</span>
          </label>
        ) : null}

        {/* Part B: Step 2 Login & Step 4 Permission Groups */}
        {wantLogin ? (
          <fieldset
            data-testid="provision-login-fieldset"
            className="space-y-3 rounded-lg border border-border p-3.5"
          >
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Phần 2 — Tài khoản đăng nhập &amp; Nhóm quyền
            </legend>

            {needsPasswordReentryForFrozenStep2 ? (
              <Alert
                tone="warning"
                role="status"
                title="Cần nhập lại mật khẩu tạm để tiếp tục sau khi tải lại trang"
              >
                <p>
                  Mật khẩu tạm không bao giờ được lưu trong trình duyệt. Hãy nhập lại mật khẩu tạm
                  bên dưới để máy chủ kiểm tra và hoàn tất đúng yêu cầu trước đó mà không tạo trùng
                  tài khoản, hoặc kiểm tra danh sách Người dùng trước khi đóng.
                </p>
              </Alert>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1 text-sm font-medium text-foreground sm:col-span-2">
                <label htmlFor="provision-login-id">Tên đăng nhập (bắt buộc, không chứa @)</label>
                <input
                  id="provision-login-id"
                  type="text"
                  required
                  autoComplete="off"
                  value={loginId}
                  maxLength={64}
                  disabled={step2NonSecretLocked}
                  placeholder="Ví dụ: an.nv (chữ thường, số, ., _, -)"
                  onChange={(e) => setLoginId(e.target.value)}
                  className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                />
              </div>

              {showPasswordInputs ? (
                <>
                  <div className="flex flex-col gap-1 text-sm font-medium text-foreground">
                    <label htmlFor="provision-password">
                      {needsPasswordReentryForFrozenStep2
                        ? "Nhập lại mật khẩu tạm để tiếp tục"
                        : "Mật khẩu tạm (tối thiểu 8 ký tự)"}
                    </label>
                    <input
                      id="provision-password"
                      type="password"
                      required
                      autoComplete="new-password"
                      value={password}
                      disabled={busy || (checkpoint !== null && !step2AllowNewLoginEdit && !needsPasswordReentryForFrozenStep2 && !(step1Settled && checkpoint.step2_account.status === "IDLE"))}
                      onChange={(e) => setPassword(e.target.value)}
                      className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                    />
                  </div>
                  <div className="flex flex-col gap-1 text-sm font-medium text-foreground">
                    <label htmlFor="provision-password-confirm">Xác nhận mật khẩu tạm</label>
                    <input
                      id="provision-password-confirm"
                      type="password"
                      required
                      autoComplete="new-password"
                      value={passwordConfirm}
                      disabled={busy || (checkpoint !== null && !step2AllowNewLoginEdit && !needsPasswordReentryForFrozenStep2 && !(step1Settled && checkpoint.step2_account.status === "IDLE"))}
                      onChange={(e) => setPasswordConfirm(e.target.value)}
                      className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                    />
                  </div>
                </>
              ) : null}
            </div>

            {canManageGlobalRoles ? (
              <div className="space-y-3 border-t border-border pt-3">
                <p className="text-xs text-muted">
                  Tài khoản mới mặc định có quyền chấm công, nghỉ phép và nộp báo cáo được giao.
                  Chọn thêm <strong>nhóm quyền theo phòng ban</strong> nếu cần cấp quyền vận hành ngay:
                </p>
                {availableGroups.length === 0 ? (
                  <p className="text-xs text-muted italic">
                    Có thể xếp nhóm quyền ngay sau khi lưu trong trang chi tiết người dùng.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {availableGroups.map((grp) => {
                      const checked = selectedGroupIds.includes(grp.group_id);
                      const summary = summarizeGroupBusinessActions(grp).slice(0, 2).join(" · ");
                      return (
                        <label
                          key={grp.group_id}
                          className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={checkpoint !== null || busy}
                            onChange={(e) => {
                              const nextIds = e.target.checked
                                ? [...selectedGroupIds, grp.group_id]
                                : selectedGroupIds.filter((id) => id !== grp.group_id);
                              setSelectedGroupIds(nextIds);
                              if (e.target.checked && isRecruitmentOperationalGroup(grp)) {
                                setActivateRecruiterInline(true);
                                if (grp.team_id && !inlineRecruiterTeamId) {
                                  setInlineRecruiterTeamId(grp.team_id);
                                }
                              }
                            }}
                            className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                          />
                          <span className="min-w-0 space-y-0.5">
                            <span className="block font-medium text-foreground">
                              {grp.name}
                            </span>
                            <span className="block text-[11px] text-primary">
                              {grp.department_name}
                              {grp.team_name ? ` · ${grp.team_name}` : ""}
                            </span>
                            {summary ? (
                              <span className="block truncate text-muted">{summary}</span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {hasSelectedRecruitmentGroup ? (
                  <div className="space-y-2.5 rounded-lg border border-primary/30 bg-primary/5 p-3">
                    <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                      <input
                        type="checkbox"
                        checked={activateRecruiterInline}
                        disabled={checkpoint !== null || busy}
                        onChange={(e) => setActivateRecruiterInline(e.target.checked)}
                        className="h-4 w-4 rounded border-border accent-primary"
                      />
                      <span>Kích hoạt hồ sơ tính công tuyển dụng ngay để dùng phân hệ Tuyển dụng</span>
                    </label>
                    {activateRecruiterInline ? (
                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        <div className="flex flex-col gap-1 text-xs">
                          <label htmlFor="inline-recruiter-position" className="font-medium text-muted">
                            Vị trí tuyển dụng
                          </label>
                          <select
                            id="inline-recruiter-position"
                            value={inlineRecruiterPosition}
                            disabled={checkpoint !== null || busy}
                            onChange={(e) =>
                              setInlineRecruiterPosition(e.target.value as PersonnelPosition)
                            }
                            className="min-h-10 rounded-md border border-border bg-surface px-2.5 text-xs text-foreground"
                          >
                            <option value="STAFF">Nhân viên tuyển dụng</option>
                            <option value="TEAM_LEADER">Trưởng nhóm tuyển dụng</option>
                          </select>
                        </div>
                        <div className="flex flex-col gap-1 text-xs">
                          <label htmlFor="inline-recruiter-team" className="font-medium text-muted">
                            Xếp vào tổ đội tuyển dụng (tùy chọn)
                          </label>
                          <select
                            id="inline-recruiter-team"
                            value={inlineRecruiterTeamId}
                            disabled={checkpoint !== null || busy}
                            onChange={(e) => setInlineRecruiterTeamId(e.target.value)}
                            className="min-h-10 rounded-md border border-border bg-surface px-2.5 text-xs text-foreground"
                          >
                            <option value="">Chọn sau</option>
                            {availableTeams.map((team) => (
                              <option key={team.team_id} value={team.team_id}>
                                {team.display_name} ({team.code})
                              </option>
                            ))}
                          </select>
                          {inlineTeamsError ? (
                            <p className="text-[11px] text-warning" role="status">
                              {inlineTeamsError}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {/* Step 3 recruiter confirmation picker */}
        {mismatchConfirmRequired ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50/40 p-3 dark:border-amber-800 dark:bg-amber-950/20">
            <RecruiterConfirmPicker
              id="provision-recruiter-confirm-picker"
              label="Xác nhận hồ sơ tính công tuyển dụng cần giữ (bắt buộc)"
              initialSearch={fullName || employeeCode}
              selectedRecruiterId={confirmedRecruiter?.recruiter_id ?? null}
              onSelect={setConfirmedRecruiter}
              disabled={busy}
              onSessionLost={(msg) => handleSessionLossInside(msg, false)}
            />
          </div>
        ) : null}

        {!showFeedbackAtTop ? renderFeedbackAlert() : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <div>
            {checkpoint &&
            (needsPasswordReentryForFrozenStep2 ||
              step2AllowNewLoginEdit ||
              step3HardBlocked ||
              step4PartialFailure ||
              step5PartialFailure ||
              isStep4Or5Uncertain ||
              resumeServerError) ? (
              <Button
                type="button"
                variant="danger-outline"
                size="sm"
                disabled={busy}
                onClick={handleDiscardLocalCheckpoint}
              >
                Đã kiểm tra · Xóa bản lưu tạm
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canClearAndOpenProfile && committedPersonId && checkpoint && !isCloseDisabled ? (
              <Link
                href={`/admin/organization/persons/${encodeURIComponent(committedPersonId)}`}
                className={buttonClasses({ variant: "secondary", size: "md" })}
                onClick={() => {
                  clearRamPasswords();
                  clearVerifiedCheckpoint({
                    expectedOrigin: resolveOrigin(),
                    expectedActorScope: checkpointActorScope,
                    expectedClientFlowId: checkpoint.client_flow_id,
                    storage: resolveStorage(),
                  });
                  onCheckpointChangedRef.current?.();
                  onCompletedRef.current({
                    personId: committedPersonId,
                    accountRef: committedAccountRef,
                    openedLogin: true,
                  });
                }}
              >
                Đóng &amp; Mở hồ sơ
              </Link>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="md"
                disabled={isCloseDisabled}
                onClick={() => {
                  if (isCloseDisabled) return;
                  clearRamPasswords();
                  // Temporary close: NEVER wipe browser recovery checkpoint when steps remain UNCERTAIN/pending!
                  onCheckpointChangedRef.current?.();
                  onClose();
                }}
              >
                {checkpoint ? "Đóng tạm" : "Hủy"}
              </Button>
            )}
            {!resumeServerError &&
            !step3HardBlocked &&
            !step3VersionConflict &&
            !step3TeamAssignmentBlocked &&
            !step4VersionConflict ? (
              <Button
                type="submit"
                variant="primary"
                size="md"
                loading={busy}
                disabled={busy || verifyingResume}
              >
                {primaryButtonLabel}
              </Button>
            ) : null}
          </div>
        </div>
      </form>
    </FormDialog>
  );
}
