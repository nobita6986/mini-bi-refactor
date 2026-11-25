"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useNotify } from "@/components/ui/notify-provider";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  applyDelegationCreateDraftEdit,
  classifyDelegationMutationError,
  createDelegationIdempotencyKey,
  createInitialDelegationCreateDraftState,
  isDelegationViewData,
  submitDelegationCreateAttempt,
  type DelegatedCapability,
  type DelegationCreateDraftState,
  type DelegationListItem,
  type DelegationViewData,
} from "@/lib/work-reports/delegation-ui-model";

const inputClass = "min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || body.ok !== true) {
    throw new Error(isRecord(body) && typeof body.code === "string" ? body.code : "WORK_REPORT_UNAVAILABLE");
  }
  return body;
}

async function fetchDelegations(): Promise<DelegationViewData> {
  const body = await readBody(await fetch("/api/work-reports/delegations", { cache: "no-store" }));
  if (!isDelegationViewData(body.data)) throw new Error("WORK_REPORT_RESPONSE_INVALID");
  return body.data;
}

export function DelegationManager() {
  const notify = useNotify();
  const [data, setData] = useState<DelegationViewData | null>(null);
  const [draftState, setDraftState] = useState<DelegationCreateDraftState>(() =>
    createInitialDelegationCreateDraftState(),
  );
  const revokeIdempotencyKeysRef = useRef<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyDraftEdit = (
    patch: Partial<
      Pick<
        DelegationCreateDraftState,
        "capability" | "delegate_id" | "template_id" | "scope_index"
      >
    >,
  ) => {
    const nextState = applyDelegationCreateDraftEdit(draftState, patch);
    if (nextState.ambiguous_retry_locked) {
      return;
    }
    setDraftState(nextState);
    setError(null);
  };

  async function refresh() {
    setLoading(true);
    try {
      setData(await fetchDelegations());
      if (!draftState.ambiguous_retry_locked) {
        setError(null);
      }
    } catch {
      if (!draftState.ambiguous_retry_locked) {
        setData(null);
      }
      setError("Không tải được danh sách ủy quyền trong phạm vi quyền hiện tại.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void fetchDelegations()
      .then((result) => {
        if (active) {
          setData(result);
          setError(null);
        }
      })
      .catch(() => {
        if (active) {
          setData(null);
          setError("Không tải được danh sách ủy quyền trong phạm vi quyền hiện tại.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedScope =
    data && draftState.scope_index !== ""
      ? data.options.scopes[Number(draftState.scope_index)]
      : undefined;

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) {
      setError("Chọn quyền, người nhận, mẫu và phạm vi hợp lệ.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const attempt = await submitDelegationCreateAttempt({
        state: draftState,
        selectedScope,
      });
      setDraftState(attempt.next_state);
      if (!attempt.ok) {
        setError(attempt.message);
        if (attempt.submitted_payload) {
          notify.error({ title: attempt.message });
        }
        return;
      }
      notify.success({ title: "Đã tạo ủy quyền." });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(item: DelegationListItem) {
    if (!window.confirm("Thu hồi ủy quyền này?")) return;
    setBusy(true);
    setError(null);
    const attemptKey = `${item.delegation_id}:${item.version}`;
    const idempotency_key =
      revokeIdempotencyKeysRef.current.get(attemptKey) ??
      createDelegationIdempotencyKey();
    revokeIdempotencyKeysRef.current.set(attemptKey, idempotency_key);
    try {
      const response = await fetch(
        `/api/work-reports/delegations/${encodeURIComponent(item.delegation_id)}/revoke`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotency_key,
          },
          body: JSON.stringify({ expected_version: item.version, idempotency_key }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const classified = classifyDelegationMutationError(
          body,
          response.status,
          "revoke",
        );
        if (classified.shouldRotateIdempotencyKey) {
          revokeIdempotencyKeysRef.current.delete(attemptKey);
        }
        setError(classified.message);
        notify.error({ title: classified.message });
        return;
      }
      if (!isRecord(body) || body.ok !== true) {
        const msg =
          "Phản hồi thu hồi ủy quyền không hợp lệ nên chưa rõ kết quả. Bạn có thể bấm Thu hồi lại an toàn.";
        setError(msg);
        notify.error({ title: msg });
        return;
      }
      revokeIdempotencyKeysRef.current.delete(attemptKey);
      notify.success({ title: "Đã thu hồi ủy quyền." });
      await refresh();
    } catch {
      const msg =
        "Mất phản hồi khi thu hồi ủy quyền. Khóa Idempotency-Key đã được giữ nguyên; bạn có thể bấm Thu hồi lại an toàn.";
      setError(msg);
      notify.error({ title: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <StatusBanner tone="info" title="Ủy quyền hiệu lực ngay theo thời gian máy chủ">
        Danh sách người nhận, mẫu và phạm vi do máy chủ cung cấp. Ủy quyền có hiệu lực ngay khi tạo và kết thúc ngay khi thu hồi; quyền được kiểm tra lại ở mọi thao tác, ủy quyền không thể được ủy quyền tiếp từ giao diện này.
      </StatusBanner>
      {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
      <div className="flex justify-end">
        <Button variant="secondary" disabled={loading || busy} onClick={() => void refresh()}>
          Tải lại
        </Button>
      </div>
      {loading && !data ? (
        <p role="status" className="text-sm text-muted">
          Đang tải danh sách ủy quyền…
        </p>
      ) : null}
      {data ? (
        <>
          {data.options.capabilities.length > 0 &&
          data.options.delegates.length > 0 &&
          data.options.templates.length > 0 &&
          data.options.scopes.length > 0 ? (
            <form
              onSubmit={(event) => void create(event)}
              className="w-full space-y-4 rounded-xl border border-border bg-surface p-4 sm:p-6 shadow-[var(--shadow-card)]"
            >
              <h2 className="font-semibold">Tạo ủy quyền</h2>
              <label className="block space-y-1.5 text-sm font-medium">
                Quyền được ủy quyền
                <select
                  required
                  disabled={busy || draftState.ambiguous_retry_locked}
                  className={inputClass}
                  value={draftState.capability}
                  onChange={(event) =>
                    applyDraftEdit({
                      capability: event.target.value as DelegatedCapability,
                    })
                  }
                >
                  <option value="">Chọn quyền</option>
                  {data.options.capabilities.map((item) => (
                    <option key={item} value={item}>
                      {item === "report_review" ? "Duyệt báo cáo" : "Giao báo cáo"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1.5 text-sm font-medium">
                Người nhận
                <select
                  required
                  disabled={busy || draftState.ambiguous_retry_locked}
                  className={inputClass}
                  value={draftState.delegate_id}
                  onChange={(event) =>
                    applyDraftEdit({ delegate_id: event.target.value })
                  }
                >
                  <option value="">Chọn người nhận</option>
                  {data.options.delegates.map((item) => (
                    <option key={item.app_user_id} value={item.app_user_id}>
                      {item.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1.5 text-sm font-medium">
                Mẫu báo cáo
                <select
                  required
                  disabled={busy || draftState.ambiguous_retry_locked}
                  className={inputClass}
                  value={draftState.template_id}
                  onChange={(event) =>
                    applyDraftEdit({ template_id: event.target.value })
                  }
                >
                  <option value="">Chọn mẫu</option>
                  {data.options.templates.map((item) => (
                    <option
                      key={`${item.template_id}:${item.version_id}`}
                      value={item.template_id}
                    >
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1.5 text-sm font-medium">
                Phạm vi
                <select
                  required
                  disabled={busy || draftState.ambiguous_retry_locked}
                  className={inputClass}
                  value={draftState.scope_index}
                  onChange={(event) =>
                    applyDraftEdit({ scope_index: event.target.value })
                  }
                >
                  <option value="">Chọn phạm vi</option>
                  {data.options.scopes.map((item, index) => (
                    <option
                      key={`${item.scope_kind}:${item.scope_id ?? "all"}`}
                      value={index}
                    >
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs text-muted">
                Thời điểm bắt đầu hiệu lực được máy chủ ghi nhận ngay khi tạo; quyền được ủy nhiệm có hiệu lực đến khi thu hồi.
              </p>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy
                  ? "Đang lưu…"
                  : draftState.ambiguous_retry_locked
                    ? "Thử gửi lại ủy quyền"
                    : "Tạo ủy quyền"}
              </Button>
            </form>
          ) : (
            <StatusBanner>
              Máy chủ chưa cấp lựa chọn để tạo ủy quyền trong phạm vi hiện tại.
            </StatusBanner>
          )}
          <section
            className="space-y-3"
            aria-labelledby="work-report-delegations-title"
          >
            <div>
              <h2 id="work-report-delegations-title" className="text-lg font-semibold">
                Ủy quyền đã tạo
              </h2>
              <p className="text-sm text-muted">
                Chỉ hiển thị các ủy quyền trong phạm vi máy chủ cho phép.
              </p>
            </div>
            {data.items.length === 0 ? (
              <p className="rounded-[22px] border border-border/80 bg-surface p-4 text-sm text-muted shadow-[var(--shadow-card)]">
                Chưa có ủy quyền.
              </p>
            ) : (
              <div className="relative overflow-hidden rounded-xl [border-radius:22px] border border-border/80 bg-surface shadow-[var(--shadow-card)]">
                <div className="relative overflow-x-auto">
                  <table className="r22-card-table w-full border-collapse text-left text-sm">
                    <thead className="border-b border-border bg-surface-muted text-xs font-bold uppercase tracking-wider text-[var(--navy)]">
                      <tr>
                        <th scope="col" className="px-3.5 py-3 text-left font-bold whitespace-nowrap">Người nhận ủy quyền</th>
                        <th scope="col" className="px-3.5 py-3 text-left font-bold whitespace-nowrap">Quyền ủy nhiệm</th>
                        <th scope="col" className="px-3.5 py-3 text-left font-bold whitespace-nowrap">Mẫu báo cáo & Phạm vi</th>
                        <th scope="col" className="px-3.5 py-3 text-left font-bold whitespace-nowrap">Thời hạn hiệu lực</th>
                        <th scope="col" className="px-3.5 py-3 text-left font-bold whitespace-nowrap">Trạng thái</th>
                        <th scope="col" className="px-3.5 py-3 text-right font-bold whitespace-nowrap">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item) => {
                        const itemStatus = item.status ?? item.state ?? "ACTIVE";
                        const isRevoked = itemStatus === "REVOKED" || item.state === "REVOKED";
                        const endLabel =
                          item.effective_to ??
                          (item.revoked_at
                            ? `Thu hồi lúc ${item.revoked_at}`
                            : "Đến khi thu hồi");
                        return (
                          <tr
                            key={item.delegation_id}
                            className="border-b border-border/65 last:border-b-0 transition-colors hover:bg-[var(--selected-bg)] align-middle"
                          >
                            <td className="px-3.5 py-2.5 align-middle font-semibold text-[var(--navy)]" data-card-header="true">
                              {item.delegate_display_name}
                            </td>
                            <td className="px-3.5 py-2.5 align-middle whitespace-nowrap" data-label="Quyền ủy nhiệm">
                              <span className="inline-flex items-center rounded-full border border-primary/25 bg-[var(--selected-bg)] px-2.5 py-0.5 text-xs font-semibold text-primary">
                                {item.capability === "report_review" ? "Duyệt báo cáo" : "Giao báo cáo"}
                              </span>
                            </td>
                            <td className="px-3.5 py-2.5 align-middle" data-label="Mẫu báo cáo & Phạm vi">
                              <div className="font-medium text-foreground">{item.template_name}</div>
                              <div className="text-xs text-muted">{item.scope_label}</div>
                            </td>
                            <td className="px-3.5 py-2.5 align-middle font-mono text-xs text-muted whitespace-nowrap" data-label="Thời hạn hiệu lực">
                              {item.effective_from} – {endLabel}
                            </td>
                            <td className="px-3.5 py-2.5 align-middle font-mono text-xs whitespace-nowrap" data-label="Trạng thái">
                              <span
                                className={
                                  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium " +
                                  (isRevoked
                                    ? "border-border bg-muted/12 text-muted"
                                    : "border-emerald-500/30 bg-emerald-500/12 text-emerald-800 dark:text-emerald-200")
                                }
                              >
                                {itemStatus}
                              </span>
                            </td>
                            <td className="px-3.5 py-2.5 align-middle text-right whitespace-nowrap" data-card-actions="true">
                              {!isRevoked ? (
                                <Button
                                  variant="danger-outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => void revoke(item)}
                                >
                                  Thu hồi
                                </Button>
                              ) : (
                                <span className="text-xs text-muted">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
