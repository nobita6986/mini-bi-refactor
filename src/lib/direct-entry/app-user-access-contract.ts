import { projectOptionalActionReason } from "./action-reason.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON_MAX = 4000;

export const ACCOUNT_TYPES = ["NORMAL", "SHARED", "SERVICE"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type ActivePersonLinkSummary = {
  link_id: string;
  person_id: string;
  employee_code: string;
  full_name: string;
  started_at: string;
  person_version: number;
};

export type ExistingAccount = {
  account_ref: string;
  display_name: string | null;
  login_id: string | null;
  enabled: boolean;
  version: number;
  account_type: AccountType;
  active_person_link: ActivePersonLinkSummary | null;
};
export type ExistingAccountList = {
  search: string | null;
  enabled: "all" | "true" | "false";
  page: number;
  page_size: number;
  total: number;
  accounts: ExistingAccount[];
};

export type AccountListQuery = {
  search: string | null;
  enabled: "all" | "true" | "false";
  page: number;
  page_size: number;
};

export type AccountAccessParsed<T> =
  | { ok: true; value: T }
  | { ok: false; code: "ACCOUNT_INVALID" };

export function projectActivePersonLink(value: unknown): ActivePersonLinkSummary | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !==
    "employee_code,full_name,link_id,person_id,person_version,started_at"
  ) {
    return null;
  }
  if (typeof row.link_id !== "string" || !UUID.test(row.link_id)) return null;
  if (typeof row.person_id !== "string" || !UUID.test(row.person_id)) return null;
  if (typeof row.employee_code !== "string" || row.employee_code.trim() === "" ||
      row.employee_code !== row.employee_code.trim() || row.employee_code.length > 64) return null;
  if (typeof row.full_name !== "string" || row.full_name.trim() === "" ||
      row.full_name !== row.full_name.trim() || row.full_name.length > 160) return null;
  if (typeof row.started_at !== "string" || row.started_at.trim() === "" ||
      Number.isNaN(Date.parse(row.started_at))) return null;
  if (typeof row.person_version !== "number" ||
      !Number.isSafeInteger(row.person_version) || row.person_version < 1) return null;
  return {
    link_id: row.link_id,
    person_id: row.person_id,
    employee_code: row.employee_code,
    full_name: row.full_name,
    started_at: row.started_at,
    person_version: row.person_version,
  };
}

export function projectExistingAccount(value: unknown): ExistingAccount | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !==
      "account_ref,account_type,active_person_link,display_name,enabled,login_id,version") return null;
  if (typeof row.account_ref !== "string" || !UUID.test(row.account_ref)) return null;
  if (row.display_name !== null && (typeof row.display_name !== "string" ||
      row.display_name !== row.display_name.trim() || row.display_name === "" ||
      row.display_name.length > 256)) return null;
  if (row.login_id !== null && (typeof row.login_id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.login_id))) return null;
  if (typeof row.enabled !== "boolean" || typeof row.version !== "number" ||
      !Number.isSafeInteger(row.version) || row.version < 1) return null;
  if (typeof row.account_type !== "string" ||
      !(ACCOUNT_TYPES as readonly string[]).includes(row.account_type)) return null;
  const activePersonLink = row.active_person_link === null
    ? null
    : projectActivePersonLink(row.active_person_link);
  if (row.active_person_link !== null && !activePersonLink) return null;
  return {
    account_ref: row.account_ref,
    display_name: row.display_name as string | null,
    login_id: row.login_id as string | null,
    enabled: row.enabled,
    version: row.version,
    account_type: row.account_type as AccountType,
    active_person_link: activePersonLink,
  };
}

export function projectExistingAccountList(value: unknown): ExistingAccountList | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).sort().join(",") !== "accounts,enabled,page,page_size,search,total") return null;
  if (envelope.search !== null && (typeof envelope.search !== "string" ||
      envelope.search !== envelope.search.trim() || envelope.search === "" || envelope.search.length > 256)) return null;
  if (envelope.enabled !== "all" && envelope.enabled !== "true" && envelope.enabled !== "false") return null;
  if (typeof envelope.page !== "number" || !Number.isSafeInteger(envelope.page) || envelope.page < 1) return null;
  if (typeof envelope.page_size !== "number" || !Number.isSafeInteger(envelope.page_size) || envelope.page_size < 1 || envelope.page_size > 100) return null;
  if (typeof envelope.total !== "number" || !Number.isSafeInteger(envelope.total) || envelope.total < 0 || !Array.isArray(envelope.accounts)) return null;
  const accounts = envelope.accounts.map(projectExistingAccount);
  if (accounts.some((account) => account === null)) return null;
  return {
    search: envelope.search,
    enabled: envelope.enabled,
    page: envelope.page,
    page_size: envelope.page_size,
    total: envelope.total,
    accounts: accounts as ExistingAccount[],
  };
}

function integer(value: unknown, min: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : null;
}

export function parseAccountListQuery(url: URL): AccountAccessParsed<AccountListQuery> {
  const allowed = new Set(["search", "enabled", "page", "page_size"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) return { ok: false, code: "ACCOUNT_INVALID" };
  for (const key of allowed) if (url.searchParams.getAll(key).length > 1) return { ok: false, code: "ACCOUNT_INVALID" };
  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null && (rawSearch.trim() === "" || rawSearch.length > 256)) return { ok: false, code: "ACCOUNT_INVALID" };
  const search = rawSearch === null ? null : rawSearch.trim();
  const enabled = url.searchParams.get("enabled") ?? "all";
  if (enabled !== "all" && enabled !== "true" && enabled !== "false") return { ok: false, code: "ACCOUNT_INVALID" };
  const rawPage = url.searchParams.get("page") ?? "1";
  const rawPageSize = url.searchParams.get("page_size") ?? "25";
  if (!/^\d{1,6}$/.test(rawPage) || !/^\d{1,6}$/.test(rawPageSize)) return { ok: false, code: "ACCOUNT_INVALID" };
  const page = Number(rawPage);
  const page_size = Number(rawPageSize);
  if (page < 1 || page > 1000 || page_size < 1 || page_size > 100) return { ok: false, code: "ACCOUNT_INVALID" };
  return { ok: true, value: { search, enabled, page, page_size } };
}

export type AccountMutationRequest = {
  expected_version: number;
  reason: string | null;
  idempotency_key: string;
};

export function parseAccountMutation(body: unknown): AccountAccessParsed<AccountMutationRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, code: "ACCOUNT_INVALID" };
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["expected_version", "reason", "idempotency_key"].includes(key)) ||
      !("expected_version" in record) || !("idempotency_key" in record)) {
    return { ok: false, code: "ACCOUNT_INVALID" };
  }
  const expected_version = integer(record.expected_version, 1);
  const reason = projectOptionalActionReason(record.reason, REASON_MAX);
  const idempotency_key = typeof record.idempotency_key === "string" && UUID.test(record.idempotency_key)
    ? record.idempotency_key : null;
  if (expected_version === null || !reason.ok || idempotency_key === null) return { ok: false, code: "ACCOUNT_INVALID" };
  return { ok: true, value: { expected_version, reason: reason.value, idempotency_key } };
}

export function parseAccountRef(value: string): string | null {
  return UUID.test(value) ? value : null;
}
