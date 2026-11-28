// Mirror của public.recruitment_dimension_key(text) trong database — NFC → trim →
// gộp khoảng trắng → lowercase. Inline ở đây để module thuần có thể chạy trong Node test
// (không phụ thuộc path alias "@/"); DATABASE vẫn là nguồn chân lý cho khóa gộp nhóm.
function normalizeFilterKey(value: string): string | null {
  const collapsed = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  return collapsed.toLowerCase();
}

/** Giá trị hợp lệ cho filter `provider` (mở rộng thêm kênh CTV). */
export const PROVIDER_FILTER_VALUES = [
  "hrp",
  "hrp_direct",
  "hrp_ctv",
  "vendor",
  "__unknown__",
  "__invalid__",
] as const;
export type ProviderFilter = (typeof PROVIDER_FILTER_VALUES)[number];

/** Giá trị hợp lệ cho filter `employment`. */
export const EMPLOYMENT_FILTER_VALUES = ["thời vụ", "chính thức", "__unknown__", "__invalid__"] as const;
export type EmploymentFilter = (typeof EMPLOYMENT_FILTER_VALUES)[number];

/** Trạng thái lao động được dùng làm bộ lọc as-of trên dashboard. */
export const WORK_STATUS_FILTER_VALUES = ["ON", "OFF", "UNCONFIRMED"] as const;
export type WorkStatusFilter = (typeof WORK_STATUS_FILTER_VALUES)[number];

export interface ReportingFilters {
  from?: string;
  to?: string;
  project?: string;
  recruiter?: string;
  provider?: ProviderFilter;
  collaborator?: string;
  employment?: EmploymentFilter;
  status?: WorkStatusFilter;
  source?: string;
}

export const INVALID_FILTER_CODE = "INVALID_FILTER";

export type FilterParseResult =
  | { ok: true; filters: ReportingFilters }
  | { ok: false; code: string; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLLABORATOR_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

/** Kiểm tra ngày lịch thật (2026-02-30 => false). */
export function isRealCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parts = value.split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return dt.getUTCFullYear() === parts[0] && dt.getUTCMonth() === parts[1] - 1 && dt.getUTCDate() === parts[2];
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value === undefined ? undefined : value;
}

/**
 * Parse + validate filter báo cáo.
 * `scopeSourceIds`: tập source ID thuộc reporting scope. Nếu `source` là UUID hợp lệ
 * nhưng ngoài scope => lỗi validation (không fallback "All").
 */
export function parseReportingFilters(
  params: Record<string, string | string[] | undefined>,
  scopeSourceIds?: ReadonlySet<string>
): FilterParseResult {
  const fail = (message: string): FilterParseResult => ({ ok: false, code: INVALID_FILTER_CODE, message });

  const from = firstString(params.from);
  const to = firstString(params.to);
  const project = firstString(params.project);
  const recruiter = firstString(params.recruiter);
  const provider = firstString(params.provider);
  const collaborator = firstString(params.collaborator);
  const employment = firstString(params.employment);
  const status = firstString(params.status);
  const source = firstString(params.source);

  const filters: ReportingFilters = {};

  if (from !== undefined && from !== "") {
    if (!isRealCalendarDate(from)) return fail("from phải là ngày lịch hợp lệ YYYY-MM-DD");
    filters.from = from;
  }
  if (to !== undefined && to !== "") {
    if (!isRealCalendarDate(to)) return fail("to phải là ngày lịch hợp lệ YYYY-MM-DD");
    filters.to = to;
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    return fail("from không được lớn hơn to");
  }

  if (project !== undefined && project !== "") {
    const key = normalizeFilterKey(project);
    if (!key) return fail("project không hợp lệ");
    filters.project = key;
  }
  if (recruiter !== undefined && recruiter !== "") {
    const key = normalizeFilterKey(recruiter);
    if (!key) return fail("recruiter không hợp lệ");
    filters.recruiter = key;
  }

  if (provider !== undefined && provider !== "") {
    if (!(PROVIDER_FILTER_VALUES as readonly string[]).includes(provider)) {
      return fail("provider phải là hrp|hrp_direct|hrp_ctv|vendor|__unknown__|__invalid__");
    }
    filters.provider = provider as ProviderFilter;
  }
  if (collaborator !== undefined && collaborator !== "") {
    const normalized = collaborator.normalize("NFC").trim();
    if (
      normalized === "__system_vendor__" ||
      !COLLABORATOR_ID_RE.test(normalized)
    ) {
      return fail("collaborator không hợp lệ");
    }
    filters.collaborator = normalized;
  }
  if (employment !== undefined && employment !== "") {
    if (!(EMPLOYMENT_FILTER_VALUES as readonly string[]).includes(employment)) {
      return fail("employment phải là thời vụ|chính thức|__unknown__|__invalid__");
    }
    filters.employment = employment as EmploymentFilter;
  }

  if (status !== undefined && status !== "") {
    if (!(WORK_STATUS_FILTER_VALUES as readonly string[]).includes(status)) {
      return fail("status phải là ON|OFF|UNCONFIRMED");
    }
    filters.status = status as WorkStatusFilter;
  }

  if (source !== undefined && source !== "") {
    if (!UUID_RE.test(source)) return fail("source phải là UUID hợp lệ");
    const normalized = source.toLowerCase();
    if (scopeSourceIds && !scopeSourceIds.has(normalized)) {
      return fail("source không thuộc reporting scope");
    }
    filters.source = normalized;
  }

  return { ok: true, filters };
}
