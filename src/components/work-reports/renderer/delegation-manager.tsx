"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useNotify } from "@/components/ui/notify-provider";
import { StatusBanner } from "@/components/ui/status-banner";

type DelegatedCapability = "report_assign" | "report_review";
type ScopeOption = { scope_kind: "all" | "team"; scope_id: string | null; label: string };
type Delegation = {
  delegation_id: string;
  capability: DelegatedCapability;
  delegate_app_user_id: string;
  delegate_display_name: string;
  template_id: string;
  template_name: string;
  template_version_id?: string;
  scope_kind: "all" | "team";
  scope_id: string | null;
  scope_label: string;
  effective_from: string;
  effective_to: string | null;
  revoked_at?: string | null;
  state?: string;
  status?: string;
  version: number;
};
type Data = {
  items: Delegation[];
  options: {
    delegates: Array<{ app_user_id: string; display_name: string }>;
    templates: Array<{ template_id: string; version_id: string; name: string }>;
    scopes: ScopeOption[];
    capabilities: DelegatedCapability[];
  };
};

const inputClass = "min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || body.ok !== true) {
    throw new Error(isRecord(body) && typeof body.code === "string" ? body.code : "WORK_REPORT_UNAVAILABLE");
  }
  return body;
}

async function fetchDelegations(): Promise<Data> {
  const body = await readBody(await fetch("/api/work-reports/delegations", { cache: "no-store" }));
  if (!isData(body.data)) throw new Error("WORK_REPORT_RESPONSE_INVALID");
  return body.data;
}

function isData(value: unknown): value is Data {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.options)) return false;
  const options = value.options;
  return Array.isArray(options.delegates) && options.delegates.every((item) => isRecord(item) && typeof item.app_user_id === "string" && typeof item.display_name === "string") &&
    Array.isArray(options.templates) && options.templates.every((item) => isRecord(item) && typeof item.template_id === "string" && typeof item.version_id === "string" && typeof item.name === "string") &&
    Array.isArray(options.scopes) && options.scopes.every((item) => isRecord(item) && (item.scope_kind === "all" || item.scope_kind === "team") && (item.scope_id === null || typeof item.scope_id === "string") && typeof item.label === "string") &&
    Array.isArray(options.capabilities) && options.capabilities.every((item) => item === "report_assign" || item === "report_review");
}

export function DelegationManager() {
  const notify = useNotify();
  const [data, setData] = useState<Data | null>(null);
  const [delegateId, setDelegateId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [scopeIndex, setScopeIndex] = useState("");
  const [capability, setCapability] = useState<DelegatedCapability | "">("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setData(await fetchDelegations());
      setError(null);
    } catch {
      setData(null);
      setError("Không tải được danh sách ủy quyền trong phạm vi quyền hiện tại.");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    void fetchDelegations().then((result) => {
      if (active) { setData(result); setError(null); }
    }).catch(() => {
      if (active) { setData(null); setError("Không tải được danh sách ủy quyền trong phạm vi quyền hiện tại."); }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const selectedScope = data && scopeIndex !== "" ? data.options.scopes[Number(scopeIndex)] : undefined;

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !capability || !delegateId || !templateId || !selectedScope) {
      setError("Chọn quyền, người nhận, mẫu và phạm vi hợp lệ.");
      return;
    }
    setBusy(true); setError(null);
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch("/api/work-reports/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({ capability, delegate_app_user_id: delegateId, template_id: templateId,
          scope_kind: selectedScope.scope_kind, scope_id: selectedScope.scope_kind === "team" ? selectedScope.scope_id : null,
          idempotency_key }),
      });
      await readBody(response);
      notify.success({ title: "Đã tạo ủy quyền." });
      await refresh();
    } catch {
      const msg = "Không tạo được ủy quyền. Máy chủ có thể đã từ chối quyền hoặc phạm vi này.";
      setError(msg);
      notify.error({ title: msg });
    } finally { setBusy(false); }
  }

  async function revoke(item: Delegation) {
    if (!window.confirm("Thu hồi ủy quyền này?")) return;
    setBusy(true); setError(null);
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch(`/api/work-reports/delegations/${encodeURIComponent(item.delegation_id)}/revoke`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({ expected_version: item.version, idempotency_key }),
      });
      await readBody(response);
      notify.success({ title: "Đã thu hồi ủy quyền." });
      await refresh();
    } catch {
      const msg = "Không thu hồi được ủy quyền. Hãy tải lại danh sách và thử lại.";
      setError(msg);
      notify.error({ title: msg });
    } finally { setBusy(false); }
  }

  return <div className="space-y-5">
    <StatusBanner tone="info" title="Ủy quyền hiệu lực ngay theo thời gian máy chủ">Danh sách người nhận, mẫu và phạm vi do máy chủ cung cấp. Ủy quyền có hiệu lực ngay khi tạo và kết thúc ngay khi thu hồi; quyền được kiểm tra lại ở mọi thao tác, ủy quyền không thể được ủy quyền tiếp từ giao diện này.</StatusBanner>
    {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
    <div className="flex justify-end"><Button variant="secondary" disabled={loading || busy} onClick={() => void refresh()}>Tải lại</Button></div>
    {loading && !data ? <p role="status" className="text-sm text-muted">Đang tải danh sách ủy quyền…</p> : null}
    {data ? <>
      {data.options.capabilities.length > 0 && data.options.delegates.length > 0 && data.options.templates.length > 0 && data.options.scopes.length > 0 ?
        <form onSubmit={(event) => void create(event)} className="max-w-2xl space-y-4 rounded-xl border border-border p-4 sm:p-6">
          <h2 className="font-semibold">Tạo ủy quyền</h2>
          <label className="block space-y-1.5 text-sm font-medium">Quyền được ủy quyền<select required className={inputClass} value={capability} onChange={(event) => setCapability(event.target.value as DelegatedCapability)}>
            <option value="">Chọn quyền</option>{data.options.capabilities.map((item) => <option key={item} value={item}>{item === "report_review" ? "Duyệt báo cáo" : "Giao báo cáo"}</option>)}
          </select></label>
          <label className="block space-y-1.5 text-sm font-medium">Người nhận<select required className={inputClass} value={delegateId} onChange={(event) => setDelegateId(event.target.value)}>
            <option value="">Chọn người nhận</option>{data.options.delegates.map((item) => <option key={item.app_user_id} value={item.app_user_id}>{item.display_name}</option>)}
          </select></label>
          <label className="block space-y-1.5 text-sm font-medium">Mẫu báo cáo<select required className={inputClass} value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            <option value="">Chọn mẫu</option>{data.options.templates.map((item) => <option key={`${item.template_id}:${item.version_id}`} value={item.template_id}>{item.name}</option>)}
          </select></label>
          <label className="block space-y-1.5 text-sm font-medium">Phạm vi<select required className={inputClass} value={scopeIndex} onChange={(event) => setScopeIndex(event.target.value)}>
            <option value="">Chọn phạm vi</option>{data.options.scopes.map((item, index) => <option key={`${item.scope_kind}:${item.scope_id ?? "all"}`} value={index}>{item.label}</option>)}
          </select></label>
          <p className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs text-muted">
            Thời điểm bắt đầu hiệu lực được máy chủ ghi nhận ngay khi tạo; quyền được ủy nhiệm có hiệu lực đến khi thu hồi.
          </p>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? "Đang lưu…" : "Tạo ủy quyền"}</Button>
        </form> : <StatusBanner>Máy chủ chưa cấp lựa chọn để tạo ủy quyền trong phạm vi hiện tại.</StatusBanner>}
      <section className="space-y-3" aria-labelledby="work-report-delegations-title">
        <div><h2 id="work-report-delegations-title" className="text-lg font-semibold">Ủy quyền đã tạo</h2><p className="text-sm text-muted">Chỉ hiển thị các ủy quyền trong phạm vi máy chủ cho phép.</p></div>
        {data.items.length === 0 ? <p className="rounded-xl border border-border p-4 text-sm text-muted">Chưa có ủy quyền.</p> : <ul className="space-y-3">{data.items.map((item) => {
          const itemStatus = item.status ?? item.state ?? "ACTIVE";
          const endLabel = item.effective_to ?? (item.revoked_at ? `Thu hồi lúc ${item.revoked_at}` : "Đến khi thu hồi");
          return <li key={item.delegation_id} className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1"><h3 className="font-semibold">{item.delegate_display_name} · {item.capability === "report_review" ? "Duyệt báo cáo" : "Giao báo cáo"}</h3><p className="text-sm text-muted">{item.template_name} · {item.scope_label}</p><p className="text-xs text-muted">{item.effective_from} – {endLabel} · {itemStatus}</p></div>
            {itemStatus !== "REVOKED" && item.state !== "REVOKED" && <Button variant="secondary" disabled={busy} onClick={() => void revoke(item)}>Thu hồi</Button>}
          </li>;
        })}</ul>}
      </section>
    </> : null}
  </div>;
}
