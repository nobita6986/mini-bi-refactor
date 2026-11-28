/**
 * P1.6-W04-S04C-S02B - Hop dong doc/list change request.
 *
 * Pure validator + projection: khong I/O, khong doc session, khong goi DB.
 * Authority (mapping actor, capability, effective scope tung entry) do RPC
 * public.direct_entry_list_change_requests / direct_entry_read_change_request quyet dinh.
 *
 * Projection fail-closed: dung key, dung kieu, khong fallback []/false/0, khong type assertion.
 */
import {
  CHANGE_REQUEST_STATES,
  projectChangeRequestProposal,
  type ChangeRequestState,
  type ChangeRequestTargetKind,
} from "./change-request-contract.ts";
import {
  projectDocumentReadProposal,
  projectPaymentReadProposal,
  projectWorkStatusReadProposal,
  projectWorkerDetails,
} from "./change-request-read-projection.ts";

export const LIST_DEFAULT_PAGE_SIZE = 20;
export const LIST_MAX_PAGE_SIZE = 50;
export const LIST_MAX_ENTRY_IDS = 100;
export const LIST_QUERY_KEYS = ["page_size", "cursor", "state", "days"] as const;
export const CHANGE_REQUEST_QUEUE_FILTERS = [
  "PENDING",
  "RESOLVED",
  "PROPOSER_PENDING",
  "PROPOSER_RESOLVED",
  "REVIEWER_PENDING",
  "REVIEWER_RESOLVED",
  "GLOBAL_AUDIT",
] as const;
export type ChangeRequestQueueFilter = (typeof CHANGE_REQUEST_QUEUE_FILTERS)[number];

export const LIST_PAGE_KEYS = ["requests", "page_size", "has_more", "next_cursor"] as const;
export const LIST_ITEM_KEYS = [
  "request_id", "state", "version", "created_at", "item_count", "entry_ids",
  "can_withdraw", "can_decide", "proposer_display_name", "summary",
] as const;
export const DETAIL_KEYS = [
  "request_id", "state", "version", "created_at", "request_reason", "items",
  "can_withdraw", "can_decide",
] as const;
// P3.1-W02C-R2: labor_type_display la field display-only NGOAI proposal. Proposal van giu
// nguyen key nghiep vu trong write-shape; nhan do server resolve va khong bao gio duoc nhet
// vao proposal.
export const DETAIL_ITEM_KEYS = [
  "entry_id", "target_kind", "expected_version", "proposal", "labor_type_display",
] as const;
const DETAIL_ITEM_OPTIONAL_KEYS = ["collaborator_display"] as const;

/** Cursor opaque do DB sinh: <yyyyMMddHH24MISSUS UTC>:<request_id>. */
const CURSOR = /^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** created_at do DB tra ve dang ISO UTC voi dung 6 chu so micro giay. */
const ISO_UTC_MICROS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE_TEXT = /^[1-9][0-9]{0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function isSubmissionStateValue(value: unknown): value is ChangeRequestState {
  return typeof value === "string" && CHANGE_REQUEST_STATES.some((state) => state === value);
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC_MICROS.test(value) &&
    !Number.isNaN(Date.parse(value));
}

export type ChangeRequestListQuery = {
  page_size: number;
  cursor: string | null;
  state: ChangeRequestState | ChangeRequestQueueFilter | null;
  days: 3 | 7 | 30 | null;
};

export type ChangeRequestAuditListItem = ChangeRequestListItem & {
  decided_by_display_name: string;
  decided_at: string;
};

export type ChangeRequestProjection<T> =
  | { ok: true; value: T }
  | { ok: false; code: "CHANGE_REQUEST_QUERY_INVALID" };

const QUERY_INVALID = { ok: false, code: "CHANGE_REQUEST_QUERY_INVALID" } as const;

/**
 * Query list: only page_size | cursor | state | days are accepted.
 * Tham so la khac (order, column, limit, offset, sql...) bi tu choi de khong co duong
 * client dieu khien SQL/order.
 */
export function projectChangeRequestListQuery(
  searchParams: URLSearchParams,
): ChangeRequestProjection<ChangeRequestListQuery> {
  for (const key of searchParams.keys()) {
    if (!(LIST_QUERY_KEYS as readonly string[]).includes(key)) return QUERY_INVALID;
  }
  if ([...searchParams.keys()].length !== new Set(searchParams.keys()).size) return QUERY_INVALID;

  const rawPageSize = searchParams.get("page_size");
  let pageSize = LIST_DEFAULT_PAGE_SIZE;
  if (rawPageSize !== null) {
    if (!PAGE_SIZE_TEXT.test(rawPageSize)) return QUERY_INVALID;
    pageSize = Number(rawPageSize);
    if (pageSize < 1 || pageSize > LIST_MAX_PAGE_SIZE) return QUERY_INVALID;
  }

  const rawCursor = searchParams.get("cursor");
  if (rawCursor !== null && !CURSOR.test(rawCursor)) return QUERY_INVALID;

  const rawState = searchParams.get("state");
  if (rawState !== null && !isSubmissionStateValue(rawState) &&
      !CHANGE_REQUEST_QUEUE_FILTERS.some((state) => state === rawState)) return QUERY_INVALID;
  const rawDays = searchParams.get("days");
  let days: ChangeRequestListQuery["days"] = null;
  if (rawDays !== null && rawDays !== "all") {
    if (rawDays !== "3" && rawDays !== "7" && rawDays !== "30") return QUERY_INVALID;
    days = Number(rawDays) as 3 | 7 | 30;
  }
  if (rawState === "GLOBAL_AUDIT" ? rawDays === null : rawDays !== null) return QUERY_INVALID;

  return {
    ok: true,
    value: {
      page_size: pageSize,
      cursor: rawCursor,
      state: rawState as ChangeRequestListQuery["state"],
      days,
    },
  };
}

export type ChangeRequestListItem = {
  request_id: string;
  state: ChangeRequestState;
  version: number;
  created_at: string;
  item_count: number;
  entry_ids: string[];
  can_withdraw: boolean;
  can_decide: boolean;
  proposer_display_name: string;
  summary: string;
  decided_by_display_name?: string | null;
  decided_at?: string | null;
};

export type ChangeRequestListPage = {
  requests: ChangeRequestListItem[];
  page_size: number;
  has_more: boolean;
  next_cursor: string | null;
};

function projectListItem(value: unknown, audit = false): ChangeRequestListItem | null {
  const auditKeys = ["decided_by_display_name", "decided_at"] as const;
  if (!isRecord(value) || !hasExactKeys(value, audit ? [...LIST_ITEM_KEYS, ...auditKeys] : LIST_ITEM_KEYS)) {
    return null;
  }
  if (typeof value.request_id !== "string" || !UUID.test(value.request_id)) return null;
  if (!isSubmissionStateValue(value.state)) return null;
  if (!isPositiveVersion(value.version)) return null;
  if (!isCanonicalTimestamp(value.created_at)) return null;
  if (typeof value.item_count !== "number" || !Number.isSafeInteger(value.item_count) ||
      value.item_count < 1) return null;
  if (!Array.isArray(value.entry_ids) || value.entry_ids.length < 1 ||
      value.entry_ids.length > LIST_MAX_ENTRY_IDS) return null;
  const entryIds: string[] = [];
  const seen = new Set<string>();
  for (const entryId of value.entry_ids) {
    if (typeof entryId !== "string" || !UUID.test(entryId)) return null;
    if (seen.has(entryId)) return null;
    seen.add(entryId);
    entryIds.push(entryId);
  }
  if (entryIds.length !== value.item_count) return null;
  if (typeof value.can_withdraw !== "boolean" || typeof value.can_decide !== "boolean") return null;
  if (value.can_withdraw === true && value.can_decide === true) return null;
  if (typeof value.proposer_display_name !== "string" ||
      value.proposer_display_name.trim().length < 1 || value.proposer_display_name.length > 120) return null;
  if (typeof value.summary !== "string" || value.summary.trim().length < 1 || value.summary.length > 160) return null;
  if (audit && (typeof value.decided_by_display_name !== "string" ||
      value.decided_by_display_name.trim().length < 1 || value.decided_by_display_name.length > 120 ||
      !isCanonicalTimestamp(value.decided_at))) return null;
  return {
    request_id: value.request_id,
    state: value.state,
    version: value.version,
    created_at: value.created_at,
    item_count: value.item_count,
    entry_ids: entryIds,
    can_withdraw: value.can_withdraw,
    can_decide: value.can_decide,
    proposer_display_name: value.proposer_display_name,
    summary: value.summary,
    ...(audit ? {
      decided_by_display_name: value.decided_by_display_name as string,
      decided_at: value.decided_at as string,
    } : {}),
  };
}

export function projectChangeRequestListPage(
  value: unknown,
  expected: { page_size: number; audit?: boolean },
): ChangeRequestListPage | null {
  if (!isRecord(value) || !hasExactKeys(value, LIST_PAGE_KEYS)) return null;
  if (!Array.isArray(value.requests) || value.requests.length > expected.page_size) return null;
  if (typeof value.page_size !== "number" || value.page_size !== expected.page_size) return null;
  if (typeof value.has_more !== "boolean") return null;
  const requests: ChangeRequestListItem[] = [];
  for (const raw of value.requests) {
    const item = projectListItem(raw, expected.audit === true);
    if (!item) return null;
    requests.push(item);
  }
  const cursor = value.next_cursor;
  if (value.has_more) {
    if (typeof cursor !== "string" || !CURSOR.test(cursor)) return null;
  } else if (cursor !== null) {
    return null;
  }
  return {
    requests,
    page_size: value.page_size,
    has_more: value.has_more,
    next_cursor: value.has_more ? (cursor as string) : null,
  };
}

/**
 * P1.6-W04-S04C-S03B3-R1: key khong bao gio duoc xuat hien trong proposal cua response doc.
 * Server da redact (direct_entry_change_request_proposal_projection); day la lop fail-closed thu
 * hai o boundary: neu mot regression tra raw key thi projection tra null thay vi render ra UI.
 */
export const READ_SENSITIVE_PROPOSAL_KEYS = [
  "idempotency_key", "checksum_sha256", "storage_key", "storage_url",
  "signed_url", "public_url", "bucket",
] as const;

function findSensitiveProposalKey(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSensitiveProposalKey(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((READ_SENSITIVE_PROPOSAL_KEYS as readonly string[]).includes(key)) return key;
    const found = findSensitiveProposalKey(child, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * P1.6-W04-S04C-S03B4A: vocabulary proposal cua RESPONSE DOC (da lam sach o server), khac
 * vocabulary mutation. DOCUMENT omits idempotency_key/checksum_sha256 and storage metadata.
 */
export const READ_PROPOSAL_KEYS: Readonly<Record<ChangeRequestTargetKind, readonly string[]>> =
  Object.freeze({
    ENTRY_FIELD: [
      "project_id", "first_work_date", "employee_code", "recruiter_id", "labor_type",
      "collaborator_id", "worker_details",
    ],
    PAYMENT: ["state", "account_number", "bank_id", "account_holder_name"],
    WORK_STATUS: ["status", "effective_date", "leave_reason"],
    DOCUMENT: ["document_type", "size_bytes", "mime_type"],
    ENTRY_VOID: [],
  });

const ENTRY_FIELD_NON_PII_KEYS = [
  "project_id", "first_work_date", "employee_code", "recruiter_id", "labor_type", "collaborator_id",
] as const;

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/**
 * Strict-project proposal da lam sach theo tung target kind. Tra null khi key la, sai kieu,
 * raw sensitive key, hoac hinh dang khong duoc ho tro (khong fallback ve {}).
 * Gia tri tra ve la ban da validate nguyen ven (khong tu them/bot field).
 */
export function projectReadProposal(
  kind: ChangeRequestTargetKind,
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (kind === "ENTRY_VOID") return Object.keys(value).length === 0 ? {} : null;
  const allowed: readonly string[] | undefined = READ_PROPOSAL_KEYS[kind];
  if (!allowed || !hasOnlyKeys(value, allowed) || Object.keys(value).length < 1) return null;
  if (kind === "ENTRY_FIELD") {
    const nonPii: Record<string, unknown> = {};
    for (const key of ENTRY_FIELD_NON_PII_KEYS) {
      if (key in value) nonPii[key] = value[key];
    }
    if (Object.keys(nonPii).length > 0 && !projectChangeRequestProposal("ENTRY_FIELD", nonPii)) {
      return null;
    }
    if ("worker_details" in value) {
      if (!projectWorkerDetails(value.worker_details)) return null;
    }
    return { ...value };
  }
  if (kind === "PAYMENT") {
    return projectPaymentReadProposal(value) ? { ...value } : null;
  }
  if (kind === "WORK_STATUS") {
    return projectWorkStatusReadProposal(value) ? { ...value } : null;
  }
  return projectDocumentReadProposal(value) ? { ...value } : null;
}

export type ChangeRequestDetailItem = {
  entry_id: string;
  target_kind: ChangeRequestTargetKind;
  expected_version: number;
  proposal: Record<string, unknown>;
  /** Nhan cua proposal.labor_type; null khi item khong mang labor type. */
  labor_type_display: string | null;
  collaborator_display?: string | null;
};

export type ChangeRequestDetail = {
  request_id: string;
  state: ChangeRequestState;
  version: number;
  created_at: string;
  request_reason: string | null;
  items: ChangeRequestDetailItem[];
  can_withdraw: boolean;
  can_decide: boolean;
};

function projectDetailItem(value: unknown): ChangeRequestDetailItem | null {
  if (!isRecord(value)) return null;
  const itemKeys = Object.keys(value);
  const allowedItemKeys = new Set<string>([...DETAIL_ITEM_KEYS, ...DETAIL_ITEM_OPTIONAL_KEYS]);
  if (!DETAIL_ITEM_KEYS.every((key) => Object.hasOwn(value, key)) ||
      itemKeys.some((key) => !allowedItemKeys.has(key))) return null;
  if (typeof value.entry_id !== "string" || !UUID.test(value.entry_id)) return null;
  if (typeof value.target_kind !== "string") return null;
  if (!isPositiveVersion(value.expected_version)) return null;
  const kind = value.target_kind as ChangeRequestTargetKind;
  if (findSensitiveProposalKey(value.proposal) !== null) return null;
  const proposal = projectReadProposal(kind, value.proposal);
  if (!proposal) return null;
  if (Object.hasOwn(value, "collaborator_display") &&
      value.collaborator_display !== null &&
      (typeof value.collaborator_display !== "string" || value.collaborator_display.trim().length < 1)) {
    return null;
  }

  // P3.1-W02C-R2: item co labor type thi BAT BUOC co nhan khong rong; item khong co
  // labor type thi BAT BUOC la null. Lech mot trong hai => unavailable, khong render
  // key tho va khong bao gio render mot nhan fallback.
  const proposalLaborType = typeof proposal.labor_type === "string" && proposal.labor_type.length > 0
    ? proposal.labor_type
    : null;
  if (proposalLaborType === null) {
    if (value.labor_type_display !== null) return null;
  } else if (typeof value.labor_type_display !== "string" ||
      value.labor_type_display.length < 1) {
    return null;
  }
  return {
    entry_id: value.entry_id,
    target_kind: kind,
    expected_version: value.expected_version,
    proposal,
    labor_type_display: value.labor_type_display,
    ...(Object.hasOwn(value, "collaborator_display")
      ? { collaborator_display: value.collaborator_display as string | null }
      : {}),
  };
}

export function projectChangeRequestDetail(
  value: unknown,
  expected: { request_id: string },
): ChangeRequestDetail | null {
  if (!isRecord(value) || !hasExactKeys(value, DETAIL_KEYS)) return null;
  if (typeof value.request_id !== "string" || !UUID.test(value.request_id)) return null;
  if (value.request_id !== expected.request_id) return null;
  if (!isSubmissionStateValue(value.state)) return null;
  if (!isPositiveVersion(value.version)) return null;
  if (!isCanonicalTimestamp(value.created_at)) return null;
  if (value.request_reason !== null &&
      (typeof value.request_reason !== "string" || value.request_reason.trim().length < 1 ||
       value.request_reason.length > 4000)) return null;
  if (!Array.isArray(value.items) || value.items.length < 1 ||
      value.items.length > LIST_MAX_ENTRY_IDS) return null;
  const items: ChangeRequestDetailItem[] = [];
  const seen = new Set<string>();
  for (const raw of value.items) {
    const item = projectDetailItem(raw);
    if (!item) return null;
    if (seen.has(item.entry_id)) return null;
    seen.add(item.entry_id);
    items.push(item);
  }
  if (typeof value.can_withdraw !== "boolean" || typeof value.can_decide !== "boolean") return null;
  if (value.can_withdraw === true && value.can_decide === true) return null;
  return {
    request_id: value.request_id,
    state: value.state,
    version: value.version,
    created_at: value.created_at,
    request_reason: value.request_reason,
    items,
    can_withdraw: value.can_withdraw,
    can_decide: value.can_decide,
  };
}
