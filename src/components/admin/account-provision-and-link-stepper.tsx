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
  buildReconcileRequest,
} from "@/lib/admin/account-operation-ui-model";
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
  type ProvisionStep4Role,
} from "@/lib/admin/provision-checkpoint-v2";
import {
  buildAssignGlobalRoleRequest,
  classifyRoleMutationResponse,
  newRoleMutationIdempotencyKey,
} from "@/lib/admin/role-effective-access-model";
import type { GlobalRoleCode } from "@/lib/auth/role-access-contract";
import type { AdminPersonnel } from "@/lib/direct-entry/personnel-catalog-contract";

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

const OPTIONAL_INIT_ROLES: ReadonlyArray<{
  code: Exclude<GlobalRoleCode, "EMPLOYEE_BASE">;
  label: string;
  hint: string;
}> = [
  {
    code: "RECRUITER",
    label: "Tuyển dụng (Recruiter)",
    hint: "Nhập liệu và theo dõi tuyển dụng theo phạm vi được giao.",
  },
  {
    code: "HR_OPERATOR",
    label: "Điều phối nhân sự (HR Operator)",
    hint: "Quản trị danh mục hồ sơ tính công, nhóm, loại hình lao động và NCC.",
  },
  {
    code: "ADMIN",
    label: "BoD/Admin",
    hint: "Toàn quyền quản trị hệ thống (đồng nhất cho mọi thành viên BoD/Admin).",
  },
];

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

  // Step 4 optional extra roles
  const [selectedExtraRoles, setSelectedExtraRoles] = useState<
    Array<Exclude<GlobalRoleCode, "EMPLOYEE_BASE">>
  >([]);

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
        setStep3HardBlocked(false);
        setStep4PartialFailure(null);
        setStep4VersionConflict(false);
        setVerifiedStep4AccountVersion(null);
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
      setStep3HardBlocked(false);
      setStep4PartialFailure(null);
      setStep4VersionConflict(false);
      setVerifiedStep4AccountVersion(null);
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
        setSelectedExtraRoles([]);
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
        setSelectedExtraRoles([]);
        return;
      }

      // mode.kind === "resume-checkpoint": untrusted storage hint -> hydrate read-only snapshot & verify on server!
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
      setSelectedExtraRoles(
        cp.step4_roles
          .map((r) => r.role_code)
          .filter((c): c is Exclude<GlobalRoleCode, "EMPLOYEE_BASE"> => c !== "EMPLOYEE_BASE"),
      );
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
            "Hồ sơ nhân viên lưu trong checkpoint không còn tồn tại trên máy chủ. Hệ thống không tự tạo lại; hãy xóa bản nháp cục bộ và đối chiếu thủ công.",
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
          setResumeServerError("Phản hồi xác minh hồ sơ nhân viên không đúng định dạng chuẩn.");
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
              "Hồ sơ nhân viên trên máy chủ hiện ở trạng thái Ngừng hoạt động. Hệ thống chặn Bước 2 để tránh tạo tài khoản đăng nhập mồ côi; hãy xóa bản nháp cục bộ và kiểm tra lại hồ sơ.",
            );
            return;
          }
          if (projected.person.active_account_link !== null) {
            setResumeServerError(
              "Hồ sơ nhân viên trên máy chủ đã được liên kết với một tài khoản đăng nhập khác. Hệ thống chặn Bước 2 để tránh tạo tài khoản đăng nhập mồ côi; hãy xóa bản nháp cục bộ và mở hồ sơ nhân viên.",
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
        // If person is already linked to the committed account on server & no remaining roles -> clean finish!
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
          if (remainingRoles.length === 0) {
            clearVerifiedCheckpoint({
              expectedOrigin: resolveOrigin(),
              expectedActorScope: checkpointActorScope,
              expectedClientFlowId: cp.client_flow_id,
              storage: resolveStorage(),
            });
            onCheckpointChangedRef.current?.();
            notifyRef.current.success({
              title: "Đã xác minh trên máy chủ: hồ sơ nhân viên và tài khoản đã được liên kết hoàn tất.",
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
          "Không thể kết nối máy chủ để xác minh checkpoint trước khi tiếp tục.",
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
              : "Không thể lưu checkpoint phục hồi trước khi gửi",
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
  // Step 4: Optional Global Roles (Sequential with frozen K_role[i])
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

      for (let idx = 0; idx < currentCp.step4_roles.length; idx += 1) {
        const roleEntry = currentCp.step4_roles[idx];
        if (!roleEntry || roleEntry.status === "COMMITTED") continue;

        // Already-dispatched UNCERTAIN/IN_FLIGHT roles MUST replay their exact frozen
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
            "Chưa xác định được phiên bản tài khoản hiện hành sau các vai trò đã cấp trước đó.",
          );
          setFeedback({
            tone: "warning",
            title: "Cần tải lại phiên bản tài khoản mới nhất trước khi cấp vai trò tiếp theo",
            message:
              "Vai trò trước đó đã được cấp nhưng chưa có phiên bản tài khoản xác nhận mới nhất. Hãy bấm \"Tải lại phiên bản tài khoản mới nhất\" để lấy đúng phiên bản từ máy chủ (không tự suy diễn phiên bản).",
          });
          return;
        }

        const frozenReason =
          roleEntry.payload_snapshot?.reason ??
          (currentCp.step1_person.payload_snapshot?.reason ||
            currentCp.step3_link.payload_snapshot?.reason ||
            "Cấp vai trò khởi tạo khi mở tài khoản nhân viên");
        const safeReason =
          frozenReason.trim().length >= 3
            ? frozenReason.trim().slice(0, 500)
            : "Cấp vai trò khởi tạo cho nhân viên";

        const built = buildAssignGlobalRoleRequest({
          roleCode: roleEntry.role_code,
          expectedVersion: frozenExpectedVersion,
          reason: safeReason,
          idempotencyKey: roleEntry.idempotency_key,
        });
        if (!built.ok) {
          setStep4PartialFailure(built.message);
          setFeedback({
            tone: "warning",
            title: "Hồ sơ & tài khoản đã liên kết, nhưng chưa cấp xong vai trò",
            message: built.message,
          });
          return;
        }

        const nextRoles: ProvisionStep4Role[] = currentCp.step4_roles.map((r, i) =>
          i === idx
            ? {
                ...r,
                status: "IN_FLIGHT",
                payload_snapshot: {
                  role_code: built.body.role_code,
                  expected_version: built.body.expected_version,
                  reason: built.body.reason,
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
            `/api/admin/access/accounts/${encodeURIComponent(accountRef)}/roles`,
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
          const outcome = classifyRoleMutationResponse(response.status, rawJson, accountRef);

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
              title: `Chưa xác nhận kết quả cấp vai trò ${roleEntry.role_code}`,
              message:
                "Hồ sơ nhân viên và tài khoản đã liên kết thành công. Khóa yêu cầu và phiên bản gốc của bước cấp vai trò vẫn được giữ nguyên để thử gửi lại an toàn.",
            });
            return;
          }

          if (outcome.kind === "version-conflict") {
            // Deterministic 409 OCC: transition rejected role back to IDLE and require explicit authoritative reload.
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
              title: `Xung đột phiên bản tài khoản khi cấp vai trò ${roleEntry.role_code} (409)`,
              message: `${outcome.message} Bấm "Tải lại phiên bản tài khoản mới nhất" để đối chiếu và tiếp tục, hoặc đóng hộp thoại để mở Hồ sơ nhân viên.`,
            });
            return;
          }

          if (outcome.kind !== "applied") {
            // Transition deterministic failure out of IN_FLIGHT -> IDLE (and clear stale payload_snapshot so retry cannot replay stale expected_version).
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
              title: `Hồ sơ & tài khoản đã liên kết — chưa cấp được vai trò ${roleEntry.role_code}`,
              message: `${outcome.message} Bạn có thể đóng hộp thoại và mở Hồ sơ nhân viên để cấp vai trò sau.`,
            });
            return;
          }

          // Persist the authoritative server-returned account_version alongside COMMITTED (PR27-R2/P2).
          currentAccountVersion = outcome.result.account_version;
          setVerifiedStep4AccountVersion(outcome.result.account_version);
          const committedRoles: ProvisionStep4Role[] = currentCp.step4_roles.map((r, i) =>
            i === idx
              ? {
                  ...r,
                  status: "COMMITTED",
                  committed_account_version: outcome.result.account_version,
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
            title: `Mất phản hồi khi cấp vai trò ${roleEntry.role_code}`,
            message:
              "Hồ sơ nhân viên và tài khoản đã liên kết thành công. Hãy bấm thử gửi lại cùng khóa yêu cầu để xác nhận bước cấp vai trò.",
          });
          return;
        } finally {
          tracked.release();
        }
      }

      finishAndClearCheckpoint(
        { personId, accountRef, openedLogin: true },
        "Đã hoàn tất mở tài khoản, liên kết hồ sơ nhân viên và cấp vai trò.",
        currentCp.client_flow_id,
      );
    },
    [finishAndClearCheckpoint, handleSessionLossInside, persistCpOrReport, workspaceGuard],
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
            title: "Cần xác nhận hồ sơ tính công tuyển dụng (RECRUITER_LINK_MISMATCH)",
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
            title: "Không thể tự động gắn tài khoản (xung đột danh tính)",
            message: `${outcome.message} Hồ sơ nhân viên và tài khoản đã tạo vẫn được giữ nguyên — hãy đối chiếu thủ công tại Đối chiếu dữ liệu cũ.`,
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
          setStep3VersionConflict(true);
          setFeedback({
            tone: "warning",
            title: "Xung đột phiên bản dữ liệu khi liên kết (409)",
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

        const hasPendingRoles = committedCp.step4_roles.some((r) => r.status !== "COMMITTED");
        if (!hasPendingRoles) {
          finishAndClearCheckpoint(
            { personId, accountRef, openedLogin: true },
            committedCp.flow_kind === "OPEN_LOGIN_FOR_EXISTING_EMPLOYEE"
              ? "Đã mở tài khoản đăng nhập và liên kết vào hồ sơ nhân viên."
              : "Đã tạo hồ sơ nhân viên, mở tài khoản đăng nhập và liên kết hoàn tất.",
            committedCp.client_flow_id,
          );
          return;
        }

        await runStep4Roles(committedCp, postLinkAccountVersion, callerEpoch);
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
            "Hồ sơ nhân viên và tài khoản đã tạo thành công. Giữ nguyên khóa gửi trùng và phiên bản gốc để thử gửi lại bước liên kết.",
        });
      } finally {
        tracked.release();
      }
    },
    [
      finishAndClearCheckpoint,
      handleSessionLossInside,
      persistCpOrReport,
      runStep4Roles,
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
          message: "Không tìm thấy snapshot tài khoản hợp lệ trong tiến trình hiện tại.",
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
              ? `Tạo tài khoản chưa thành công (${outcome.state})`
              : `Cần đối chiếu yêu cầu tạo tài khoản (${outcome.state})`,
            message: isTerminalFail
              ? `${outcome.message} Hồ sơ nhân viên ở Bước 1 đã được lưu an toàn — bạn có thể đổi tên đăng nhập khác (tạo khóa yêu cầu mới) hoặc đóng hộp thoại để mở hồ sơ nhân viên.`
              : `${outcome.message} Mật khẩu đã được xóa khỏi bộ nhớ tạm. Bấm "Đối chiếu kết quả tạo tài khoản" — thao tác đối chiếu KHÔNG cần nhập lại mật khẩu và KHÔNG gọi lại hệ thống xác thực để tạo mới.`,
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
                ? "Xung đột tên đăng nhập / yêu cầu đang xử lý (409)"
                : "Thông tin tạo tài khoản không hợp lệ (400)",
            message: `${outcome.message} Hệ thống KHÔNG tự gắn tài khoản có sẵn của thao tác khác. Hồ sơ nhân viên ở Bước 1 vẫn được giữ an toàn — bạn có thể nhập tên đăng nhập khác hoặc kiểm tra tại Đối chiếu dữ liệu cũ.`,
          });
          return;
        }

        // unavailable / malformed 200 / 5xx -> keep frozen K_account!
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
          title: "Chưa xác nhận được kết quả tạo tài khoản",
          message:
            "Khóa gửi trùng và thông tin tài khoản đã được đóng băng (mật khẩu không lưu vào storage). Bấm \"Thử gửi lại cùng yêu cầu\" để máy chủ đối chiếu đúng khóa cũ mà không tạo trùng tài khoản Auth.",
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
            "Hồ sơ nhân viên đã lưu an toàn. Khóa gửi trùng K_account được giữ nguyên để thử gửi lại cùng yêu cầu (0 tạo trùng tài khoản Auth).",
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
          setFeedback({
            tone: isTerminalFail ? "error" : "warning",
            title: `Kết quả đối chiếu: ${outcome.state}`,
            message: outcome.message,
          });
          return;
        }

        setFeedback({
          tone: outcome.kind === "conflict" ? "warning" : "error",
          title: "Chưa hoàn tất đối chiếu yêu cầu tạo tài khoản",
          message: outcome.message,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
        setFeedback({
          tone: "warning",
          title: "Mất kết nối khi đối chiếu yêu cầu tạo tài khoản",
          message:
            "Khóa đối chiếu được giữ nguyên. Bạn có thể bấm \"Đối chiếu kết quả tạo tài khoản\" lại an toàn.",
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
              "Khóa gửi trùng K_person và dữ liệu gốc đã được lưu trong checkpoint trước khi gửi. Bấm \"Thử gửi lại cùng yêu cầu\" để xác nhận an toàn mà không tạo trùng nhân viên.",
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
              "Hồ sơ nhân viên đã được xác nhận trên máy chủ. Mật khẩu không được lưu qua lần tải lại trang; hãy nhập mật khẩu tạm để chạy Bước 2 mở tài khoản bằng đúng khóa K_account đã chuẩn bị.",
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
            "Checkpoint đã được ghi trước khi gửi. Bấm \"Thử gửi lại cùng yêu cầu\" để gửi lại đúng khóa K_person (0 tạo trùng).",
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

        const step4Roles: ProvisionStep4Role[] = wantLogin
          ? selectedExtraRoles.map((roleCode) => ({
              role_code: roleCode,
              status: "IDLE",
              idempotency_key: newRoleMutationIdempotencyKey(),
              payload_snapshot: null,
            }))
          : [];

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
          step4_roles: step4Roles,
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

        const step4Roles: ProvisionStep4Role[] = selectedExtraRoles.map((roleCode) => ({
          role_code: roleCode,
          status: "IDLE",
          idempotency_key: newRoleMutationIdempotencyKey(),
          payload_snapshot: null,
        }));

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
          step4_roles: step4Roles,
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
        await runStep3Link(checkpoint, callerEpoch);
        return;
      }

      // B4: Step 4 Roles pending/uncertain
      if (checkpoint.step4_roles.some((r) => r.status !== "COMMITTED")) {
        if (step4VersionConflict) return;
        const startVersion = resolveNextStep4AccountVersion(
          checkpoint,
          verifiedStep4AccountVersion,
        );
        setStep4PartialFailure(null);
        await runStep4Roles(checkpoint, startVersion, callerEpoch);
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
        if (syncedCp && !syncedCp.step4_roles.some((r) => r.status !== "COMMITTED")) {
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
          message: "Bạn có thể tiếp tục cấp các vai trò còn lại.",
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
        setFeedback({
          tone: "info",
          title: "Đã cập nhật phiên bản mới nhất từ máy chủ",
          message: "Hãy bấm xác nhận để thực hiện bước liên kết với phiên bản hiện hành.",
        });
      }
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
          title: "Không tải được phiên bản tài khoản mới nhất",
          message: "Vui lòng thử tải lại hoặc đóng hộp thoại để mở Hồ sơ nhân viên và cấp vai trò thủ công.",
        });
        return;
      }

      // Rotate idempotency_key ONLY for deterministically-rejected IDLE roles (never COMMITTED/UNCERTAIN/IN_FLIGHT!).
      const refreshedRoles: ProvisionStep4Role[] = checkpoint.step4_roles.map((r) =>
        r.status === "IDLE" && r.payload_snapshot === null
          ? { ...r, idempotency_key: newRoleMutationIdempotencyKey() }
          : r,
      );
      const refreshedCp = persistCpOrReport({
        ...checkpoint,
        updated_at: nowIso(),
        step4_roles: refreshedRoles,
      });
      if (refreshedCp) {
        setVerifiedStep4AccountVersion(projectedA.version);
        setStep4VersionConflict(false);
        setStep4PartialFailure(null);
        setFeedback({
          tone: "info",
          title: `Đã cập nhật phiên bản tài khoản mới nhất (v${projectedA.version})`,
          message: "Hãy bấm \"Tiếp tục cấp vai trò còn lại\" để gán các vai trò chưa cấp với phiên bản hiện hành.",
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!mountedRef.current || !workspaceGuard.isActive(callerEpoch)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối khi tải phiên bản tài khoản mới nhất",
        message: "Vui lòng thử tải lại hoặc đóng hộp thoại để kiểm tra trên Hồ sơ nhân viên.",
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

  const isUncertainState =
    checkpoint !== null &&
    (checkpoint.step1_person.status === "IN_FLIGHT" ||
      checkpoint.step1_person.status === "UNCERTAIN" ||
      step2PreIntentUncertain ||
      step2HasReconcilableIntent ||
      checkpoint.step3_link.status === "IN_FLIGHT" ||
      checkpoint.step3_link.status === "UNCERTAIN" ||
      checkpoint.step4_roles.some((r) => r.status === "IN_FLIGHT" || r.status === "UNCERTAIN"));

  const needsPasswordReentryForFrozenStep2 =
    step2NeedsPasswordReentry && step2PreIntentUncertain;

  const isCloseDisabled =
    busy ||
    verifyingResume ||
    (isUncertainState &&
      !needsPasswordReentryForFrozenStep2 &&
      !step3HardBlocked &&
      !step3VersionConflict &&
      !mismatchConfirmRequired &&
      !step4PartialFailure &&
      !step4VersionConflict &&
      !resumeServerError);

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

  const committedPersonId = checkpoint?.step1_person.committed_person_id ?? null;

  const dialogTitle =
    effectiveFreshMode?.kind === "open-login-existing" && mode?.kind !== "resume-checkpoint"
      ? `Mở tài khoản đăng nhập — ${effectiveFreshMode.person.full_name}`
      : mode?.kind === "resume-checkpoint"
        ? "Tiếp tục / Đối chiếu tiến trình tạo nhân viên & mở đăng nhập"
        : "Thêm nhân viên mới";

  const primaryButtonLabel = (() => {
    if (busy) return "Đang xử lý…";
    if (!checkpoint) {
      if (effectiveFreshMode?.kind === "open-login-existing") return "Mở tài khoản & Liên kết";
      return wantLogin ? "Tạo nhân viên & Mở đăng nhập" : "Tạo hồ sơ nhân viên";
    }
    if (checkpoint.step1_person.status === "UNCERTAIN" || checkpoint.step1_person.status === "IN_FLIGHT") {
      return "Thử gửi lại bước 1 (cùng K_person)";
    }
    if (step2HasReconcilableIntent) {
      return "Đối chiếu kết quả tạo tài khoản";
    }
    if (step2AllowNewLoginEdit) {
      return "Tạo tài khoản với tên đăng nhập mới";
    }
    if (step2PreIntentUncertain) {
      return needsPasswordReentryForFrozenStep2
        ? "Gửi lại đúng khóa K_account với mật khẩu vừa nhập"
        : "Thử gửi lại bước 2 (cùng K_account)";
    }
    if (checkpoint.step2_account.status === "IDLE" && checkpoint.flow_kind !== "CREATE_EMPLOYEE_ONLY") {
      return "Tiếp tục bước 2: Mở tài khoản đăng nhập";
    }
    if (checkpoint.step3_link.status !== "COMMITTED" && checkpoint.step3_link.status !== "SKIPPED") {
      return mismatchConfirmRequired
        ? "Xác nhận hồ sơ tính công & Liên kết"
        : checkpoint.step3_link.status === "UNCERTAIN"
          ? "Thử gửi lại bước 3 (cùng K_link)"
          : "Gắn tài khoản vào hồ sơ";
    }
    return "Tiếp tục cấp vai trò còn lại";
  })();

  return (
    <FormDialog
      open={open && mode !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isCloseDisabled) {
          clearRamPasswords();
          if (step4PartialFailure && committedPersonId && checkpoint) {
            clearVerifiedCheckpoint({
              expectedOrigin: resolveOrigin(),
              expectedActorScope: checkpointActorScope,
              expectedClientFlowId: checkpoint.client_flow_id,
              storage: resolveStorage(),
            });
            onCheckpointChangedRef.current?.();
          }
          onClose();
        }
      }}
      title={dialogTitle}
      description={
        wantLogin
          ? "Thực hiện tuần tự: Hồ sơ nhân viên → Tài khoản đăng nhập → Liên kết hồ sơ → Vai trò bổ sung. Mỗi bước có mã đối chiếu riêng; bước đã lưu không bị tạo lại."
          : "Tạo hồ sơ nhân viên nội bộ (chưa mở tài khoản đăng nhập). Có thể mở đăng nhập bất cứ lúc nào sau đó."
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
          className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-muted/40 p-3 text-xs sm:grid-cols-4"
        >
          <li className="flex flex-col items-start gap-1.5 rounded-md border border-border/60 bg-surface px-2.5 py-2">
            <span className="font-medium text-foreground">1. Hồ sơ nhân viên</span>
            <StatusBadge
              tone={stepBadge(checkpoint?.step1_person.status ?? (mode?.kind === "open-login-existing" ? "SKIPPED_EXISTING" : "IDLE")).tone}
            >
              {stepBadge(checkpoint?.step1_person.status ?? (mode?.kind === "open-login-existing" ? "SKIPPED_EXISTING" : "IDLE")).label}
            </StatusBadge>
          </li>
          <li className="flex flex-col items-start gap-1.5 rounded-md border border-border/60 bg-surface px-2.5 py-2">
            <span className="font-medium text-foreground">2. Tài khoản</span>
            <StatusBadge tone={stepBadge(checkpoint?.step2_account.status ?? (wantLogin ? "IDLE" : "SKIPPED")).tone}>
              {stepBadge(checkpoint?.step2_account.status ?? (wantLogin ? "IDLE" : "SKIPPED")).label}
            </StatusBadge>
          </li>
          <li className="flex flex-col items-start gap-1.5 rounded-md border border-border/60 bg-surface px-2.5 py-2">
            <span className="font-medium text-foreground">3. Liên kết</span>
            <StatusBadge tone={stepBadge(checkpoint?.step3_link.status ?? (wantLogin ? "IDLE" : "SKIPPED")).tone}>
              {stepBadge(checkpoint?.step3_link.status ?? (wantLogin ? "IDLE" : "SKIPPED")).label}
            </StatusBadge>
          </li>
          <li className="flex flex-col items-start gap-1.5 rounded-md border border-border/60 bg-surface px-2.5 py-2">
            <span className="font-medium text-foreground">4. Vai trò</span>
            <StatusBadge
              tone={
                !wantLogin || (checkpoint ? checkpoint.step4_roles.length === 0 : selectedExtraRoles.length === 0)
                  ? "neutral"
                  : checkpoint && checkpoint.step4_roles.every((r) => r.status === "COMMITTED")
                    ? "success"
                    : checkpoint && checkpoint.step4_roles.some((r) => r.status === "UNCERTAIN")
                      ? "warning"
                      : "neutral"
              }
            >
              {!wantLogin || (checkpoint ? checkpoint.step4_roles.length === 0 : selectedExtraRoles.length === 0)
                ? "Mặc định"
                : checkpoint && checkpoint.step4_roles.every((r) => r.status === "COMMITTED")
                  ? "Đã lưu"
                  : checkpoint && checkpoint.step4_roles.some((r) => r.status === "UNCERTAIN")
                    ? "Chưa rõ"
                    : `${checkpoint ? checkpoint.step4_roles.length : selectedExtraRoles.length} vai trò`}
            </StatusBadge>
          </li>
        </ol>

        {verifyingResume ? (
          <p role="status" className="text-sm text-muted">
            Đang xác minh trạng thái thực tế của checkpoint trên máy chủ…
          </p>
        ) : null}

        {resumeServerError ? (
          <Alert tone="error" role="alert" title="Không thể tiếp tục tự động từ checkpoint">
            <p>{resumeServerError}</p>
          </Alert>
        ) : null}

        {committedPersonId ? (
          <Alert tone="info" role="status" title="Hồ sơ nhân viên đã lưu trên máy chủ">
            <p>
              Nhân viên <strong>{fullName || employeeCode}</strong> ({employeeCode}) đã có hồ sơ trên máy chủ và sẽ không bị tạo lại.{" "}
              <Link
                href={`/admin/organization/persons/${encodeURIComponent(committedPersonId)}`}
                className="font-medium text-primary underline"
              >
                Mở hồ sơ nhân viên
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
                  placeholder="Nhập mã nhân sự nội bộ (không dùng hrp-YYYY-XXXXXX)"
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
            <label htmlFor="open-login-reason">Lý do mở tài khoản &amp; liên kết (bắt buộc)</label>
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
                  setSelectedExtraRoles([]);
                }
              }}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span>Mở tài khoản đăng nhập cho nhân viên này ngay</span>
          </label>
        ) : null}

        {/* Part B: Step 2 Login & Optional Step 4 Roles (mounted ONLY when wantLogin is true!) */}
        {wantLogin ? (
          <fieldset
            data-testid="provision-login-fieldset"
            className="space-y-3 rounded-lg border border-border p-3.5"
          >
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Phần 2 — Tài khoản đăng nhập &amp; Vai trò khởi tạo
            </legend>

            {needsPasswordReentryForFrozenStep2 ? (
              <Alert
                tone="warning"
                role="status"
                title="Chưa có mã đối chiếu (intent_id) sau khi tải lại trang"
              >
                <p>
                  Mật khẩu tạm không bao giờ được lưu vào bộ nhớ trình duyệt. Hệ thống <strong>không</strong> tự đoán tài khoản theo tên đăng nhập và <strong>không</strong> sinh khóa yêu cầu mới. Bạn có hai lựa chọn an toàn:
                </p>
                <ul className="mt-1 list-disc pl-5 space-y-1">
                  <li>
                    Nhập lại mật khẩu tạm bên dưới để gửi lại <strong>đúng khóa K_account và snapshot đã đóng băng</strong> (máy chủ sẽ đối chiếu khóa cũ mà không tạo trùng tài khoản Auth nếu đã ghi nhận).
                  </li>
                  <li>
                    Hoặc mở{" "}
                    <Link
                      href="/admin/access/accounts?view=unlinked"
                      className="font-medium text-primary underline"
                    >
                      Đối chiếu dữ liệu cũ
                    </Link>{" "}
                    để kiểm tra thủ công.
                  </li>
                </ul>
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
                        ? "Nhập lại mật khẩu tạm để đối chiếu cùng khóa"
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
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-xs text-muted">
                  Hệ thống tự cấp vai trò <strong>Nhân viên cơ bản (EMPLOYEE_BASE)</strong> khi mở tài khoản. Chọn thêm vai trò toàn hệ thống nếu cần cấp ngay (tùy chọn):
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {OPTIONAL_INIT_ROLES.map((role) => {
                    const checked = selectedExtraRoles.includes(role.code);
                    return (
                      <label
                        key={role.code}
                        className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={checkpoint !== null || busy}
                          onChange={(e) => {
                            setSelectedExtraRoles((prev) =>
                              e.target.checked
                                ? [...prev, role.code]
                                : prev.filter((c) => c !== role.code),
                            );
                          }}
                          className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                        />
                        <span className="space-y-0.5">
                          <span className="block font-medium text-foreground">{role.label}</span>
                          <span className="block text-muted">{role.hint}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {/* Step 3 RECRUITER_LINK_MISMATCH explicit confirmation picker */}
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

        {feedback ? (
          <Alert
            tone={feedback.tone === "success" ? "info" : feedback.tone}
            role={feedback.tone === "error" ? "alert" : "status"}
            title={feedback.title}
          >
            <p>{feedback.message}</p>
            {step3VersionConflict ? (
              <div className="mt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleStep3ReloadVersions()}
                >
                  Tải lại phiên bản mới nhất từ máy chủ
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
                  Tải lại phiên bản tài khoản mới nhất
                </Button>
              </div>
            ) : null}
            {step3HardBlocked || needsPasswordReentryForFrozenStep2 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href="/admin/access/accounts?view=unlinked"
                  className={buttonClasses({ variant: "secondary", size: "sm" })}
                >
                  Mở Đối chiếu dữ liệu cũ
                </Link>
              </div>
            ) : null}
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <div>
            {checkpoint && (needsPasswordReentryForFrozenStep2 || step2AllowNewLoginEdit || step3HardBlocked || step4PartialFailure || resumeServerError) ? (
              <Button
                type="button"
                variant="danger-outline"
                size="sm"
                disabled={busy}
                onClick={handleDiscardLocalCheckpoint}
              >
                Đã đối chiếu thủ công · Xóa bản nháp cục bộ
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="md"
              disabled={isCloseDisabled}
              onClick={() => {
                if (!isCloseDisabled) {
                  clearRamPasswords();
                  if (step4PartialFailure && committedPersonId && checkpoint) {
                    clearVerifiedCheckpoint({
                      expectedOrigin: resolveOrigin(),
                      expectedActorScope: checkpointActorScope,
                      expectedClientFlowId: checkpoint.client_flow_id,
                      storage: resolveStorage(),
                    });
                    onCheckpointChangedRef.current?.();
                  }
                  onClose();
                }
              }}
            >
              {step4PartialFailure && committedPersonId ? "Đóng & Mở hồ sơ" : "Hủy"}
            </Button>
            {!resumeServerError && !step3HardBlocked && !step3VersionConflict && !step4VersionConflict ? (
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
