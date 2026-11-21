"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  DepartmentSelectPicker,
  type SelectedDepartmentOption,
} from "@/components/admin/org-entity-picker";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  ACCOUNT_ORG_MAX_REASON_LENGTH,
  buildSetAccountClassificationRequest,
  classifyAccountOrgMutation,
  newAccountIntentKey,
  projectAccountItem,
} from "@/lib/admin/account-access-model";
import {
  buildCreateAccountRequest,
  buildReconcileRequest,
  newAccountOperationKey,
} from "@/lib/admin/account-operation-ui-model";
import {
  buildCreatePersonRequest,
  classifyPersonOrgMutationResponse,
  EMPLOYEE_CODE_MAX_LENGTH,
  FULL_NAME_MAX_LENGTH,
  newOrgIdempotencyKey,
  REASON_MAX_LENGTH,
  type MutatePersonRpcProjection,
} from "@/lib/admin/person-org-ui-model";
import { classifyProvisionStep2Response } from "@/lib/admin/provision-checkpoint-v2";
import type { ExistingAccount } from "@/lib/direct-entry/app-user-access-contract";

export type AuxiliaryTrackedRequest = {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly release: () => void;
};

type SpecialAccountType = "SHARED" | "SERVICE";

const TERMINAL_FAILED_INTENT_STATES = new Set(["CONFLICT", "FAILED", "EXPIRED", "BLOCKED"]);

export function AccountSpecialCreateDialog({
  open,
  trackRequest,
  isRequestActive,
  onLockChange,
  onClose,
  onApplied,
  onSessionLost,
}: {
  open: boolean;
  trackRequest: () => AuxiliaryTrackedRequest;
  isRequestActive: (epoch: number, controller?: AbortController) => boolean;
  onLockChange?: (locked: boolean) => void;
  onClose: () => void;
  onApplied: () => void;
  onSessionLost: () => void;
}) {
  const notify = useNotify();
  const [targetType, setTargetType] = useState<SpecialAccountType>("SHARED");
  const [loginId, setLoginId] = useState("");
  const [displayName, setDisplayName] = useState("");
  // RAM-only passwords — cleared immediately after Step 1 settles or dialog closes.
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [reason, setReason] = useState("");

  const [step1Status, setStep1Status] = useState<"idle" | "uncertain" | "needs-reconcile" | "committed">("idle");
  const [step1Key, setStep1Key] = useState<string | null>(null);
  const [step1ReconcileKey, setStep1ReconcileKey] = useState<string | null>(null);
  const [step1IntentId, setStep1IntentId] = useState<string | null>(null);
  const [step1IntentState, setStep1IntentState] = useState<string | null>(null);
  const [createdAccountRef, setCreatedAccountRef] = useState<string | null>(null);
  const [createdAccountVersion, setCreatedAccountVersion] = useState<number | null>(null);

  const [step2Status, setStep2Status] = useState<"idle" | "uncertain" | "conflict">("idle");
  const [step2Key, setStep2Key] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  const clearRamPasswords = useCallback(() => {
    setPassword("");
    setPasswordConfirm("");
  }, []);

  const resetAll = useCallback(() => {
    inFlightRef.current = false;
    clearRamPasswords();
    setTargetType("SHARED");
    setLoginId("");
    setDisplayName("");
    setReason("");
    setStep1Status("idle");
    setStep1Key(null);
    setStep1ReconcileKey(null);
    setStep1IntentId(null);
    setStep1IntentState(null);
    setCreatedAccountRef(null);
    setCreatedAccountVersion(null);
    setStep2Status("idle");
    setStep2Key(null);
    setBusy(false);
    setErrorMsg(null);
    setInfoMsg(null);
  }, [clearRamPasswords]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlightRef.current = false;
      setPassword("");
      setPasswordConfirm("");
    };
  }, []);

  const isCloseLocked =
    busy ||
    step1Status === "uncertain" ||
    step1Status === "needs-reconcile" ||
    (step1Status === "committed" && step2Status === "uncertain");

  useEffect(() => {
    onLockChange?.(isCloseLocked);
    return () => {
      onLockChange?.(false);
    };
  }, [isCloseLocked, onLockChange]);

  const runStep2Classification = async (
    accountRef: string,
    expectedVersion: number,
    existingKey?: string,
  ) => {
    const idempotencyKey = existingKey ?? newAccountIntentKey();
    const req = buildSetAccountClassificationRequest({
      expectedAccountVersion: expectedVersion,
      accountType: targetType,
      reason,
      idempotencyKey,
    });
    if (!req.ok) {
      setErrorMsg(req.message);
      return;
    }

    setBusy(true);
    setErrorMsg(null);
    setStep2Key(req.idempotencyKey);
    const tracked = trackRequest();
    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(accountRef)}/classification`,
        {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": req.idempotencyKey,
          },
          body: JSON.stringify(req.body),
        },
      );
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;
      const payload: unknown = await response.json().catch(() => null);
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;

      const outcome = classifyAccountOrgMutation(response.status, payload, "classification");
      if (outcome.kind === "applied") {
        notify.success({
          title:
            targetType === "SHARED"
              ? "Đã tạo và phân loại Tài khoản dùng chung (SHARED)."
              : "Đã tạo và phân loại Tài khoản tích hợp hệ thống (SERVICE).",
        });
        resetAll();
        onApplied();
        return;
      }
      if (outcome.kind === "session-lost") {
        resetAll();
        onSessionLost();
        return;
      }
      if (outcome.kind === "uncertain") {
        setStep2Status("uncertain");
        setErrorMsg(outcome.message);
        return;
      }
      if (outcome.kind === "conflict") {
        setStep2Status("conflict");
        setStep2Key(null);
        setErrorMsg(outcome.message);
        return;
      }
      setStep2Status("idle");
      setStep2Key(null);
      setErrorMsg(outcome.message);
    } catch {
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;
      setStep2Status("uncertain");
      setErrorMsg(
        "Mất kết nối khi phân loại tài khoản đặc biệt. Tài khoản đã tạo trên máy chủ và sẽ không bị tạo lại; bấm thử lại đúng bước phân loại.",
      );
    } finally {
      tracked.release();
      if (mountedRef.current && isRequestActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const handleRefreshVersionForStep2 = async () => {
    if (!createdAccountRef || busy) return;
    setBusy(true);
    setErrorMsg(null);
    const tracked = trackRequest();
    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(createdAccountRef)}`,
        {
          method: "GET",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: { Accept: "application/json" },
        },
      );
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;
      if (response.status === 401 || response.status === 403) {
        resetAll();
        onSessionLost();
        return;
      }
      const account = response.status === 200 ? projectAccountItem(await response.json().catch(() => null)) : null;
      if (!account || account.account_ref !== createdAccountRef) {
        setErrorMsg("Không tải được phiên bản mới nhất của tài khoản vừa tạo.");
        return;
      }
      setCreatedAccountVersion(account.version);
      setStep2Status("idle");
      setStep2Key(null);
      setInfoMsg("Đã đồng bộ phiên bản mới nhất của tài khoản. Bấm tiếp tục để hoàn tất phân loại.");
    } catch {
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;
      setErrorMsg("Mất kết nối khi tải lại phiên bản tài khoản.");
    } finally {
      tracked.release();
      if (mountedRef.current && isRequestActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const runStep1Reconcile = async () => {
    if (!step1IntentId || busy || inFlightRef.current) return;
    const key = step1ReconcileKey ?? newAccountOperationKey();
    const req = buildReconcileRequest(key);
    if (!req.ok) {
      setErrorMsg(req.message);
      return;
    }
    inFlightRef.current = true;
    setStep1ReconcileKey(key);
    setBusy(true);
    setErrorMsg(null);
    const tracked = trackRequest();
    try {
      const response = await fetch(
        `/api/admin/access/accounts/intents/${encodeURIComponent(step1IntentId)}/reconcile`,
        {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(req.body),
        },
      );
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;
      const payload: unknown = await response.json().catch(() => null);
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;

      const parsed = classifyProvisionStep2Response(response.status, payload, {
        operation: "reconcile_create_account",
        expectedIntentId: step1IntentId,
      });
      if (parsed.kind === "denied") {
        resetAll();
        onSessionLost();
        return;
      }
      if (parsed.kind === "applied") {
        clearRamPasswords();
        setStep1ReconcileKey(null);
        setStep1Status("committed");
        setCreatedAccountRef(parsed.account.accountRef);
        setCreatedAccountVersion(parsed.account.accountVersion);
        setInfoMsg("Đã đối soát xong tài khoản bước 1. Đang chuyển sang bước 2 phân loại…");
        setBusy(false);
        inFlightRef.current = false;
        await runStep2Classification(parsed.account.accountRef, parsed.account.accountVersion);
        return;
      }
      if (parsed.kind === "needs-reconcile") {
        if (TERMINAL_FAILED_INTENT_STATES.has(parsed.state)) {
          // Terminal failed intent (CONFLICT / FAILED / EXPIRED / BLOCKED): unlock close & allow editing with a fresh key.
          clearRamPasswords();
          setStep1Status("idle");
          setStep1Key(null);
          setStep1ReconcileKey(null);
          setStep1IntentId(null);
          setStep1IntentState(parsed.state);
          setErrorMsg(
            `${parsed.message} (Trạng thái kết thúc: ${parsed.state}). Bạn có thể đóng hộp thoại hoặc nhập tên đăng nhập khác với khóa yêu cầu mới.`,
          );
          return;
        }
        setStep1IntentId(parsed.intentId);
        setStep1IntentState(parsed.state);
        setErrorMsg(parsed.message);
        return;
      }
      setErrorMsg(parsed.message);
    } catch {
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;
      setErrorMsg("Mất kết nối khi đối soát bước 1. Khóa đối soát được giữ nguyên; có thể bấm đối soát lại an toàn.");
    } finally {
      inFlightRef.current = false;
      tracked.release();
      if (mountedRef.current && isRequestActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || inFlightRef.current) return;
    setErrorMsg(null);
    setInfoMsg(null);

    if (step1Status === "needs-reconcile") {
      await runStep1Reconcile();
      return;
    }

    if (step1Status === "committed" && createdAccountRef && createdAccountVersion !== null) {
      if (step2Status === "conflict") return;
      inFlightRef.current = true;
      try {
        await runStep2Classification(createdAccountRef, createdAccountVersion, step2Key ?? undefined);
      } finally {
        inFlightRef.current = false;
      }
      return;
    }

    // Validate Step 2 reason upfront before calling Step 1 so we don't strand an unclassified account!
    const precheckStep2 = buildSetAccountClassificationRequest({
      expectedAccountVersion: 1,
      accountType: targetType,
      reason,
      idempotencyKey: newAccountIntentKey(),
    });
    if (!precheckStep2.ok) {
      setErrorMsg(precheckStep2.message);
      return;
    }

    const idempotencyKey = step1Key ?? newAccountOperationKey();
    const req = buildCreateAccountRequest({
      loginId,
      displayName,
      password,
      passwordConfirm,
      reason,
      idempotencyKey,
    });
    if (!req.ok) {
      setErrorMsg(req.message);
      return;
    }

    inFlightRef.current = true;
    setBusy(true);
    setStep1Key(idempotencyKey);
    const tracked = trackRequest();
    try {
      const response = await fetch("/api/admin/access/accounts", {
        method: "POST",
        cache: "no-store",
        signal: tracked.controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(req.body),
      });
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;
      const payload: unknown = await response.json().catch(() => null);
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;

      const parsed = classifyProvisionStep2Response(response.status, payload, {
        operation: "create_account",
      });
      if (parsed.kind === "denied") {
        resetAll();
        onSessionLost();
        return;
      }
      if (parsed.kind === "applied") {
        clearRamPasswords();
        setStep1Status("committed");
        setCreatedAccountRef(parsed.account.accountRef);
        setCreatedAccountVersion(parsed.account.accountVersion);
        setBusy(false);
        inFlightRef.current = false;
        await runStep2Classification(parsed.account.accountRef, parsed.account.accountVersion);
        return;
      }
      if (parsed.kind === "needs-reconcile") {
        clearRamPasswords();
        if (TERMINAL_FAILED_INTENT_STATES.has(parsed.state)) {
          setStep1Status("idle");
          setStep1Key(null);
          setStep1ReconcileKey(null);
          setStep1IntentId(null);
          setStep1IntentState(parsed.state);
          setErrorMsg(
            `${parsed.message} (Trạng thái kết thúc: ${parsed.state}). Bạn có thể đóng hộp thoại hoặc nhập tên đăng nhập khác với khóa yêu cầu mới.`,
          );
          return;
        }
        setStep1Status("needs-reconcile");
        setStep1ReconcileKey(null);
        setStep1IntentId(parsed.intentId);
        setStep1IntentState(parsed.state);
        setErrorMsg(parsed.message);
        return;
      }
      if (parsed.kind === "unavailable" && parsed.preserveIdempotencyKey) {
        setStep1Status("uncertain");
        setErrorMsg(parsed.message);
        return;
      }
      setStep1Key(null);
      setStep1Status("idle");
      setErrorMsg(parsed.message);
    } catch {
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;
      setStep1Status("uncertain");
      setErrorMsg(
        "Mất kết nối trong lúc tạo tài khoản bước 1. Đã giữ nguyên khóa idempotency; bấm thử lại đúng yêu cầu.",
      );
    } finally {
      inFlightRef.current = false;
      tracked.release();
      if (mountedRef.current && isRequestActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const step1InputsLocked = busy || step1Status !== "idle";

  return (
    <FormDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isCloseLocked) {
          resetAll();
          onClose();
        }
      }}
      closeDisabled={isCloseLocked}
      title="Tạo tài khoản đặc biệt (2 bước)"
      description="Bước 1 tạo tài khoản đăng nhập; Bước 2 phân loại ngay sang Tài khoản dùng chung (SHARED) hoặc Tài khoản tích hợp hệ thống (SERVICE)."
      dataTestId="special-account-create-dialog"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-muted/40 p-2.5 text-xs">
        <StatusBadge
          tone={
            step1Status === "committed"
              ? "success"
              : step1Status === "needs-reconcile" || step1Status === "uncertain"
                ? "warning"
                : "neutral"
          }
        >
          1. Tạo tài khoản:{" "}
          {step1Status === "committed"
            ? "Đã lưu"
            : step1Status === "needs-reconcile"
              ? `Chờ đối soát (${step1IntentState ?? ""})`
              : step1Status === "uncertain"
                ? "Chưa rõ"
                : "Chưa chạy"}
        </StatusBadge>
        <StatusBadge
          tone={step2Status === "uncertain" || step2Status === "conflict" ? "warning" : "neutral"}
        >
          2. Phân loại {targetType}:{" "}
          {step2Status === "uncertain"
            ? "Chưa rõ"
            : step2Status === "conflict"
              ? "Xung đột phiên bản"
              : "Chờ bước 1"}
        </StatusBadge>
      </div>

      <StatusBanner tone="info" title="Lưu ý về phạm vi Tài khoản đặc biệt">
        Tài khoản dùng chung (SHARED) và Tài khoản tích hợp hệ thống (SERVICE) không gắn hồ sơ nhân
        viên và không thuộc danh sách chấm công, nghỉ phép hoặc báo cáo công việc định kỳ.
      </StatusBanner>

      {infoMsg ? (
        <Alert tone="info" role="status" title="Tiến trình 2 bước">
          <p>{infoMsg}</p>
        </Alert>
      ) : null}

      {errorMsg ? (
        <Alert tone="warning" role="alert" title="Cần xử lý trước khi hoàn tất">
          <p>{errorMsg}</p>
          {step2Status === "conflict" ? (
            <div className="mt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void handleRefreshVersionForStep2()}
              >
                Tải lại phiên bản tài khoản
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : null}

      <form onSubmit={(e) => void handleSubmit(e)} className="mt-3 space-y-3.5">
        <div>
          <label htmlFor="special-account-type" className="mb-1 block text-sm font-medium text-foreground">
            Loại tài khoản đặc biệt <span className="text-red-600">*</span>
          </label>
          <select
            id="special-account-type"
            disabled={busy || step2Status === "uncertain"}
            value={targetType}
            onChange={(e) => setTargetType(e.target.value as SpecialAccountType)}
            className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
          >
            <option value="SHARED">Tài khoản dùng chung (SHARED)</option>
            <option value="SERVICE">Tài khoản tích hợp hệ thống (SERVICE)</option>
          </select>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="special-account-login-id" className="mb-1 block text-sm font-medium text-foreground">
              Tên đăng nhập <span className="text-red-600">*</span>
            </label>
            <input
              id="special-account-login-id"
              type="text"
              required
              autoComplete="off"
              disabled={step1InputsLocked}
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              placeholder="Ví dụ: kiosk.td hoặc n8n.sync"
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-foreground disabled:opacity-60"
            />
          </div>
          <div>
            <label htmlFor="special-account-display-name" className="mb-1 block text-sm font-medium text-foreground">
              Tên hiển thị <span className="text-red-600">*</span>
            </label>
            <input
              id="special-account-display-name"
              type="text"
              required
              disabled={step1InputsLocked}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ví dụ: Máy chấm công kho 1"
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground disabled:opacity-60"
            />
          </div>
        </div>

        {step1Status === "idle" || step1Status === "uncertain" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="special-account-password" className="mb-1 block text-sm font-medium text-foreground">
                Mật khẩu khởi tạo <span className="text-red-600">*</span>
              </label>
              <input
                id="special-account-password"
                type="password"
                required
                autoComplete="new-password"
                disabled={step1InputsLocked}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Tối thiểu 8 ký tự"
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground disabled:opacity-60"
              />
            </div>
            <div>
              <label htmlFor="special-account-password-confirm" className="mb-1 block text-sm font-medium text-foreground">
                Xác nhận mật khẩu <span className="text-red-600">*</span>
              </label>
              <input
                id="special-account-password-confirm"
                type="password"
                required
                autoComplete="new-password"
                disabled={step1InputsLocked}
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground disabled:opacity-60"
              />
            </div>
          </div>
        ) : null}

        <div>
          <label htmlFor="special-account-reason" className="mb-1 block text-sm font-medium text-foreground">
            Lý do tạo &amp; phân loại <span className="text-red-600">*</span>
          </label>
          <textarea
            id="special-account-reason"
            required
            rows={2}
            maxLength={ACCOUNT_ORG_MAX_REASON_LENGTH}
            disabled={busy || step1Status === "uncertain" || step1Status === "needs-reconcile" || step2Status === "uncertain"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ghi rõ mục đích dùng chung hoặc tích hợp hệ thống (1–500 ký tự)…"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60"
          />
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="secondary"
            disabled={isCloseLocked}
            onClick={() => {
              if (!isCloseLocked) {
                resetAll();
                onClose();
              }
            }}
          >
            Hủy
          </Button>
          {step2Status !== "conflict" ? (
            <Button type="submit" variant="primary" loading={busy} disabled={busy}>
              {busy
                ? "Đang xử lý…"
                : step1Status === "needs-reconcile"
                  ? "Đối soát kết quả tạo tài khoản"
                  : step1Status === "uncertain"
                    ? "Thử gửi lại bước 1 (cùng khóa)"
                    : step1Status === "committed"
                      ? `Hoàn tất bước 2: Phân loại ${targetType}`
                      : `Tạo tài khoản & Phân loại ${targetType}`}
            </Button>
          ) : null}
        </div>
      </form>
    </FormDialog>
  );
}

export function AccountLegacyCreatePersonDialog({
  account,
  trackRequest,
  isRequestActive,
  onLockChange,
  onClose,
  onApplied,
  onReloadRequested,
  onSessionLost,
}: {
  account: ExistingAccount | null;
  trackRequest: () => AuxiliaryTrackedRequest;
  isRequestActive: (epoch: number, controller?: AbortController) => boolean;
  onLockChange?: (locked: boolean) => void;
  onClose: () => void;
  onApplied: () => void;
  onReloadRequested: () => Promise<boolean>;
  onSessionLost: () => void;
}) {
  const notify = useNotify();
  const [employeeCode, setEmployeeCode] = useState("");
  const [fullName, setFullName] = useState(account?.display_name ?? "");
  const [joinedOn, setJoinedOn] = useState("");
  const [selectedDepartment, setSelectedDepartment] = useState<SelectedDepartmentOption | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<{
    body: Record<string, unknown>;
    idempotencyKey: string;
    message: string;
  } | null>(null);
  const [uncertainInspected, setUncertainInspected] = useState(false);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlightRef.current = false;
    };
  }, []);

  const isDialogLocked = busy || reconciling || pendingIntent !== null;
  const isInputLocked = isDialogLocked || conflictLocked;

  useEffect(() => {
    onLockChange?.(isDialogLocked);
    return () => {
      onLockChange?.(false);
    };
  }, [isDialogLocked, onLockChange]);

  const dispatchCreate = async (body: Record<string, unknown>, idempotencyKey: string) => {
    if (busy || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setFormError(null);
    setConflictNotice(null);
    setUncertainInspected(false);
    const tracked = trackRequest();
    try {
      const response = await fetch("/api/admin/organization/persons", {
        method: "POST",
        cache: "no-store",
        signal: tracked.controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;
      const payload: unknown = await response.json().catch(() => null);
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;

      const outcome = classifyPersonOrgMutationResponse(response.status, payload, "create");
      if (outcome.kind === "applied") {
        const result = outcome.data as MutatePersonRpcProjection;
        notify.success({
          title: "Đã tạo hồ sơ nhân viên và liên kết với tài khoản cũ.",
          dedupeKey: `wp13-legacy-create-person:${result.person.person_id}`,
          action: {
            label: "Mở hồ sơ nhân viên",
            href: `/admin/organization/persons/${encodeURIComponent(result.person.person_id)}`,
          },
        });
        setPendingIntent(null);
        setUncertainInspected(false);
        setConflictLocked(false);
        onApplied();
        return;
      }
      if (outcome.kind === "session-lost") {
        setPendingIntent(null);
        setUncertainInspected(false);
        onSessionLost();
        return;
      }
      if (outcome.kind === "uncertain") {
        setPendingIntent({ body, idempotencyKey, message: outcome.message });
        return;
      }
      setPendingIntent(null);
      setUncertainInspected(false);
      if (outcome.kind === "conflict") {
        setConflictNotice(outcome.message);
        setConflictLocked(true);
        return;
      }
      setFormError(outcome.message);
    } catch {
      if (!isRequestActive(tracked.epoch, tracked.controller) || !mountedRef.current) return;
      setPendingIntent({
        body,
        idempotencyKey,
        message:
          "Mất kết nối trong lúc tạo hồ sơ nhân viên từ tài khoản cũ. Đã giữ nguyên khóa idempotency; thử lại đúng yêu cầu hoặc tải lại để đối chiếu.",
      });
    } finally {
      inFlightRef.current = false;
      tracked.release();
      if (mountedRef.current && isRequestActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const handleReload = async () => {
    if (busy || reconciling || inFlightRef.current) return;
    const hadPendingUncertain = pendingIntent !== null;
    inFlightRef.current = true;
    setReconciling(true);
    try {
      const ok = await onReloadRequested();
      if (!mountedRef.current) return;
      if (!ok) {
        setFormError("Không tải được danh sách mới nhất. Khóa yêu cầu vẫn được giữ nguyên.");
        return;
      }
      if (hadPendingUncertain) {
        // WP12 §3.10 / R1-OCC: Reloading after uncertain 503/network drop NEVER wipes pendingIntent (frozen key + version).
        setUncertainInspected(true);
        setPendingIntent((prev) =>
          prev
            ? {
                ...prev,
                message:
                  "Đã tải danh sách tài khoản mới nhất ở nền để đối chiếu. Khóa idempotency và phiên bản gốc vẫn được giữ nguyên — hãy bấm \"Thử lại đúng yêu cầu\" để máy chủ xác nhận an toàn, hoặc đóng nếu bạn đã xác minh hồ sơ được tạo xong.",
              }
            : null,
        );
        return;
      }
      setConflictLocked(false);
      onClose();
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setReconciling(false);
      }
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!account || isInputLocked || inFlightRef.current) return;
    const idempotencyKey = newOrgIdempotencyKey();
    const req = buildCreatePersonRequest({
      employeeCode,
      fullName,
      joinedOn: joinedOn || null,
      initialDepartmentRef: selectedDepartment?.department_id ?? null,
      accountRef: account.account_ref,
      expectedAccountVersion: account.version,
      reason,
      idempotencyKey,
    });
    if (!req.ok) {
      setFormError(req.message);
      return;
    }
    void dispatchCreate(req.body, req.idempotencyKey);
  };

  return (
    <FormDialog
      open={account !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isDialogLocked) {
          onClose();
        }
      }}
      closeDisabled={isDialogLocked}
      title="Tạo hồ sơ nhân viên từ tài khoản cũ"
      description="Tạo mới hồ sơ nhân sự nội bộ và gắn trực tiếp vào tài khoản cá nhân chưa liên kết này."
      dataTestId="legacy-create-person-dialog"
    >
      {account ? (
        <div className="mb-3 rounded-lg border border-border bg-surface-muted/40 p-3 text-xs space-y-1">
          <p className="font-semibold text-foreground">
            Tài khoản đối chiếu: {account.display_name ?? "Chưa cập nhật tên"}
          </p>
          {account.login_id ? (
            <p className="font-mono text-muted">Tên đăng nhập: {account.login_id}</p>
          ) : null}
        </div>
      ) : null}

      {pendingIntent ? (
        <Alert tone="warning" role="alert" title="Chưa nhận được xác nhận từ máy chủ">
          <p>{pendingIntent.message}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={busy || reconciling}
              onClick={() => void dispatchCreate(pendingIntent.body, pendingIntent.idempotencyKey)}
            >
              Thử lại đúng yêu cầu
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || reconciling}
              onClick={() => void handleReload()}
            >
              Tải lại để đối chiếu
            </Button>
            {uncertainInspected ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy || reconciling}
                onClick={() => {
                  setPendingIntent(null);
                  setUncertainInspected(false);
                  onClose();
                }}
              >
                Đã xác minh trên máy chủ · Đóng
              </Button>
            ) : null}
          </div>
        </Alert>
      ) : null}

      {conflictNotice ? (
        <Alert tone="warning" role="alert" title="Dữ liệu tài khoản hoặc hồ sơ vừa thay đổi">
          <p>{conflictNotice}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || reconciling}
              onClick={() => void handleReload()}
            >
              Tải lại danh sách
            </Button>
            <Link
              href="/admin/catalog/personnel"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Kiểm tra Danh mục hồ sơ tính công
            </Link>
          </div>
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-3 space-y-3.5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="legacy-person-code" className="mb-1 block text-sm font-medium text-foreground">
              Mã nhân viên (nhập tay) <span className="text-red-600">*</span>
            </label>
            <input
              id="legacy-person-code"
              type="text"
              required
              maxLength={EMPLOYEE_CODE_MAX_LENGTH}
              disabled={isInputLocked}
              value={employeeCode}
              onChange={(e) => setEmployeeCode(e.target.value)}
              placeholder="2–64 ký tự (không dùng hrp-YYYY-XXXXXX)"
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-foreground disabled:opacity-60"
            />
          </div>
          <div>
            <label htmlFor="legacy-person-name" className="mb-1 block text-sm font-medium text-foreground">
              Họ và tên <span className="text-red-600">*</span>
            </label>
            <input
              id="legacy-person-name"
              type="text"
              required
              maxLength={FULL_NAME_MAX_LENGTH}
              disabled={isInputLocked}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground disabled:opacity-60"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="legacy-person-joined-on" className="mb-1 block text-sm font-medium text-foreground">
              Ngày gia nhập (tùy chọn)
            </label>
            <input
              id="legacy-person-joined-on"
              type="date"
              disabled={isInputLocked}
              value={joinedOn}
              onChange={(e) => setJoinedOn(e.target.value)}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-foreground disabled:opacity-60"
            />
          </div>
          <DepartmentSelectPicker
            id="legacy-person-department"
            label="Phòng ban ban đầu (tùy chọn)"
            selectedId={selectedDepartment?.department_id ?? null}
            onSelect={setSelectedDepartment}
            allowClear
            emptyLabel="Chưa gán phòng ban ngay"
            disabled={isInputLocked}
            onSessionLost={() => onSessionLost()}
          />
        </div>

        <div>
          <label htmlFor="legacy-person-reason" className="mb-1 block text-sm font-medium text-foreground">
            Lý do đối chiếu &amp; tạo hồ sơ <span className="text-red-600">*</span>
          </label>
          <textarea
            id="legacy-person-reason"
            required
            rows={2}
            maxLength={REASON_MAX_LENGTH}
            disabled={isInputLocked}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ví dụ: Đối chiếu tài khoản cũ và lập hồ sơ nhân viên nội bộ…"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60"
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
              if (!isDialogLocked) onClose();
            }}
          >
            Hủy
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={isInputLocked}>
            {busy ? "Đang lưu…" : "Tạo hồ sơ & Liên kết"}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}
