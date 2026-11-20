import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATALOG_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const NORMALIZED_KEY_PATTERN = /^[a-z0-9]+$/;

export type AdminProvince = {
  province_id: string;
  province_code: string;
  display_name: string;
  normalized_key: string;
  active: boolean;
  version: number;
  industrial_park_count: number;
  active_industrial_park_count: number;
  revision_count: number;
};

export type AdminProvinceList = {
  authorization_date: string;
  include_inactive: boolean;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  provinces: AdminProvince[];
};

export type AdminProvinceMutation = {
  province_id: string;
  province_code: string;
  display_name: string;
  normalized_key: string;
  active: boolean;
  version: number;
  revision_id: string;
};

export type AdminProvinceCreateResult = AdminProvinceMutation & {
  created: true;
};

export type AdminIndustrialPark = {
  industrial_park_id: string;
  industrial_park_code: string;
  province_id: string;
  province_code: string;
  province_display_name: string;
  province_active: boolean;
  display_name: string;
  normalized_key: string;
  active: boolean;
  version: number;
  revision_count: number;
};

export type AdminIndustrialParkList = {
  authorization_date: string;
  province_id: string | null;
  include_inactive: boolean;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  industrial_parks: AdminIndustrialPark[];
};

export type AdminIndustrialParkMutation = {
  industrial_park_id: string;
  industrial_park_code: string;
  province_id: string;
  province_code: string;
  province_display_name: string;
  display_name: string;
  normalized_key: string;
  active: boolean;
  version: number;
  revision_id: string;
};

export type AdminIndustrialParkCreateResult = AdminIndustrialParkMutation & {
  created: true;
};

export type RecruitmentLocationAuthorityGrant = {
  capability: string;
  scope_kind: string;
  scope_id?: string | null;
};

export type RecruitmentLocationAuthorityActor = {
  enabled?: boolean;
  capabilities: readonly string[];
  scopes: readonly { kind: string }[];
  effective_grants?: readonly RecruitmentLocationAuthorityGrant[];
};

function hasLocationPairedAll(
  grants: readonly RecruitmentLocationAuthorityGrant[],
  capability: string,
): boolean {
  return grants.some(
    (grant) =>
      grant !== null &&
      typeof grant === "object" &&
      grant.capability === capability &&
      grant.scope_kind === "ALL" &&
      (grant.scope_id === null || grant.scope_id === undefined),
  );
}

/**
 * Canonical Full Admin / BOD authority predicate for managing Recruitment
 * Provinces & Industrial Parks. Shared by UI and API layers and matches
 * `public.recruitment_location_is_admin_or_bod` in SQL:
 * - When `effective_grants` is present (WP5 paired model): strictly evaluates
 *   paired `ALL` grants with zero fallback to flat `capabilities` / `scopes`:
 *     (entry_admin AND recruiter_master_manage AND team_master_manage) at ALL
 *     OR entry_privileged_edit at ALL
 *     OR (report_analytics_view AND report_view) both at ALL.
 * - Legacy fallback (only when `effective_grants` is absent in unit fixtures):
 *   flat `scope = "all"` AND one of the 3 branches above.
 */
export function canManageRecruitmentLocations(
  actor: RecruitmentLocationAuthorityActor | null | undefined,
): boolean {
  if (!actor || actor.enabled === false) {
    return false;
  }
  if (actor.effective_grants !== undefined) {
    if (!Array.isArray(actor.effective_grants)) {
      return false;
    }
    const grants = actor.effective_grants;
    const isFullAdmin =
      hasLocationPairedAll(grants, "entry_admin") &&
      hasLocationPairedAll(grants, "recruiter_master_manage") &&
      hasLocationPairedAll(grants, "team_master_manage");
    if (isFullAdmin) {
      return true;
    }
    if (hasLocationPairedAll(grants, "entry_privileged_edit")) {
      return true;
    }
    return (
      hasLocationPairedAll(grants, "report_analytics_view") &&
      hasLocationPairedAll(grants, "report_view")
    );
  }
  if (
    !Array.isArray(actor.capabilities) ||
    !Array.isArray(actor.scopes)
  ) {
    return false;
  }
  const hasAllScope = actor.scopes.some((scope) => scope?.kind === "all");
  if (!hasAllScope) {
    return false;
  }
  const caps = new Set(actor.capabilities);
  const isFullAdmin =
    caps.has("entry_admin") &&
    caps.has("recruiter_master_manage") &&
    caps.has("team_master_manage");
  if (isFullAdmin) {
    return true;
  }
  if (caps.has("entry_privileged_edit")) {
    return true;
  }
  return caps.has("report_analytics_view") && caps.has("report_view");
}

export function normalizeLocationKey(
  rawText: string,
  stripLeadingType: "none" | "province" | "industrial_park" = "none",
): string {
  const folded = rawText
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();

  let tokenized = folded.replace(/[^a-z0-9]+/g, " ").trim();

  if (stripLeadingType === "industrial_park") {
    tokenized = tokenized.replace(/^(?:khu cong nghiep|kcn)(?:\s+|$)+/, "");
  } else if (stripLeadingType === "province") {
    tokenized = tokenized.replace(
      /^(?:thanh pho trung uong|thanh pho|tinh|tp)(?:\s+|$)+/,
      "",
    );
  }

  return tokenized.replace(/[^a-z0-9]+/g, "");
}

export function normalizeProvinceKey(displayName: string): string {
  return normalizeLocationKey(displayName, "province");
}

export function normalizeIndustrialParkKey(displayName: string): string {
  return normalizeLocationKey(displayName, "industrial_park");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(record, key),
    )
  );
}

function readUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

function readCatalogCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CATALOG_CODE_PATTERN.test(trimmed) ? trimmed : null;
}

function readNormalizedKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed.length <= 256 &&
    NORMALIZED_KEY_PATTERN.test(trimmed)
    ? trimmed
    : null;
}

function readNonEmptyText(value: unknown, maxLength = 256): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function readInt(value: unknown, min: number, max = 1_000_000): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

const ADMIN_PROVINCE_ITEM_KEYS = [
  "province_id",
  "province_code",
  "display_name",
  "normalized_key",
  "active",
  "version",
  "industrial_park_count",
  "active_industrial_park_count",
  "revision_count",
] as const;

const ADMIN_PROVINCE_LIST_KEYS = [
  "authorization_date",
  "include_inactive",
  "search",
  "page",
  "page_size",
  "total",
  "provinces",
] as const;

const ADMIN_PROVINCE_MUTATION_KEYS = [
  "province_id",
  "province_code",
  "display_name",
  "normalized_key",
  "active",
  "version",
  "revision_id",
] as const;

const ADMIN_PROVINCE_CREATE_KEYS = [
  ...ADMIN_PROVINCE_MUTATION_KEYS,
  "created",
] as const;

const ADMIN_INDUSTRIAL_PARK_ITEM_KEYS = [
  "industrial_park_id",
  "industrial_park_code",
  "province_id",
  "province_code",
  "province_display_name",
  "province_active",
  "display_name",
  "normalized_key",
  "active",
  "version",
  "revision_count",
] as const;

const ADMIN_INDUSTRIAL_PARK_LIST_KEYS = [
  "authorization_date",
  "province_id",
  "include_inactive",
  "search",
  "page",
  "page_size",
  "total",
  "industrial_parks",
] as const;

const ADMIN_INDUSTRIAL_PARK_MUTATION_KEYS = [
  "industrial_park_id",
  "industrial_park_code",
  "province_id",
  "province_code",
  "province_display_name",
  "display_name",
  "normalized_key",
  "active",
  "version",
  "revision_id",
] as const;

const ADMIN_INDUSTRIAL_PARK_CREATE_KEYS = [
  ...ADMIN_INDUSTRIAL_PARK_MUTATION_KEYS,
  "created",
] as const;

export function projectAdminProvince(raw: unknown): AdminProvince | null {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ADMIN_PROVINCE_ITEM_KEYS)) {
    return null;
  }

  const provinceId = readUuid(raw.province_id);
  const provinceCode = readCatalogCode(raw.province_code);
  const displayName = readNonEmptyText(raw.display_name, 256);
  const normalizedKey = readNormalizedKey(raw.normalized_key);
  const active = typeof raw.active === "boolean" ? raw.active : null;
  const version = readInt(raw.version, 1);
  const parkCount = readInt(raw.industrial_park_count, 0);
  const activeParkCount = readInt(raw.active_industrial_park_count, 0);
  const revisionCount = readInt(raw.revision_count, 0);

  if (
    !provinceId ||
    !provinceCode ||
    !displayName ||
    !normalizedKey ||
    active === null ||
    version === null ||
    parkCount === null ||
    activeParkCount === null ||
    revisionCount === null
  ) {
    return null;
  }

  return {
    province_id: provinceId,
    province_code: provinceCode,
    display_name: displayName,
    normalized_key: normalizedKey,
    active,
    version,
    industrial_park_count: parkCount,
    active_industrial_park_count: activeParkCount,
    revision_count: revisionCount,
  };
}

export function projectAdminProvinceList(
  raw: unknown,
): AdminProvinceList | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, ADMIN_PROVINCE_LIST_KEYS) ||
    typeof raw.authorization_date !== "string" ||
    !isRealCalendarDate(raw.authorization_date) ||
    typeof raw.include_inactive !== "boolean" ||
    !Array.isArray(raw.provinces)
  ) {
    return null;
  }

  const search =
    raw.search === null ? null : readNonEmptyText(raw.search, 256);
  if (raw.search !== null && search === null) return null;

  const page = readInt(raw.page, 1, 1000);
  const pageSize = readInt(raw.page_size, 1, 100);
  const total = readInt(raw.total, 0);
  if (page === null || pageSize === null || total === null) return null;

  const provinces: AdminProvince[] = [];
  for (const item of raw.provinces) {
    const projected = projectAdminProvince(item);
    if (!projected) return null;
    provinces.push(projected);
  }

  return {
    authorization_date: raw.authorization_date,
    include_inactive: raw.include_inactive,
    search,
    page,
    page_size: pageSize,
    total,
    provinces,
  };
}

function projectProvinceMutationFields(
  raw: Record<string, unknown>,
): AdminProvinceMutation | null {
  const provinceId = readUuid(raw.province_id);
  const provinceCode = readCatalogCode(raw.province_code);
  const displayName = readNonEmptyText(raw.display_name, 256);
  const normalizedKey = readNormalizedKey(raw.normalized_key);
  const active = typeof raw.active === "boolean" ? raw.active : null;
  const version = readInt(raw.version, 1);
  const revisionId = readUuid(raw.revision_id);

  if (
    !provinceId ||
    !provinceCode ||
    !displayName ||
    !normalizedKey ||
    active === null ||
    version === null ||
    !revisionId
  ) {
    return null;
  }

  return {
    province_id: provinceId,
    province_code: provinceCode,
    display_name: displayName,
    normalized_key: normalizedKey,
    active,
    version,
    revision_id: revisionId,
  };
}

export function projectAdminProvinceMutation(
  raw: unknown,
): AdminProvinceMutation | null {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ADMIN_PROVINCE_MUTATION_KEYS)) {
    return null;
  }
  return projectProvinceMutationFields(raw);
}

export function projectAdminProvinceCreateResult(
  raw: unknown,
): AdminProvinceCreateResult | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, ADMIN_PROVINCE_CREATE_KEYS) ||
    raw.created !== true
  ) {
    return null;
  }
  const base = projectProvinceMutationFields(raw);
  return base ? { ...base, created: true } : null;
}

export function projectAdminIndustrialPark(
  raw: unknown,
): AdminIndustrialPark | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, ADMIN_INDUSTRIAL_PARK_ITEM_KEYS)
  ) {
    return null;
  }

  const industrialParkId = readUuid(raw.industrial_park_id);
  const industrialParkCode = readCatalogCode(raw.industrial_park_code);
  const provinceId = readUuid(raw.province_id);
  const provinceCode = readCatalogCode(raw.province_code);
  const provinceDisplayName = readNonEmptyText(raw.province_display_name, 256);
  const provinceActive =
    typeof raw.province_active === "boolean" ? raw.province_active : null;
  const displayName = readNonEmptyText(raw.display_name, 256);
  const normalizedKey = readNormalizedKey(raw.normalized_key);
  const active = typeof raw.active === "boolean" ? raw.active : null;
  const version = readInt(raw.version, 1);
  const revisionCount = readInt(raw.revision_count, 0);

  if (
    !industrialParkId ||
    !industrialParkCode ||
    !provinceId ||
    !provinceCode ||
    !provinceDisplayName ||
    provinceActive === null ||
    !displayName ||
    !normalizedKey ||
    active === null ||
    version === null ||
    revisionCount === null
  ) {
    return null;
  }

  return {
    industrial_park_id: industrialParkId,
    industrial_park_code: industrialParkCode,
    province_id: provinceId,
    province_code: provinceCode,
    province_display_name: provinceDisplayName,
    province_active: provinceActive,
    display_name: displayName,
    normalized_key: normalizedKey,
    active,
    version,
    revision_count: revisionCount,
  };
}

export function projectAdminIndustrialParkList(
  raw: unknown,
): AdminIndustrialParkList | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, ADMIN_INDUSTRIAL_PARK_LIST_KEYS) ||
    typeof raw.authorization_date !== "string" ||
    !isRealCalendarDate(raw.authorization_date) ||
    typeof raw.include_inactive !== "boolean" ||
    !Array.isArray(raw.industrial_parks)
  ) {
    return null;
  }

  const provinceId =
    raw.province_id === null ? null : readUuid(raw.province_id);
  if (raw.province_id !== null && provinceId === null) return null;

  const search =
    raw.search === null ? null : readNonEmptyText(raw.search, 256);
  if (raw.search !== null && search === null) return null;

  const page = readInt(raw.page, 1, 1000);
  const pageSize = readInt(raw.page_size, 1, 100);
  const total = readInt(raw.total, 0);
  if (page === null || pageSize === null || total === null) return null;

  const industrialParks: AdminIndustrialPark[] = [];
  for (const item of raw.industrial_parks) {
    const projected = projectAdminIndustrialPark(item);
    if (!projected) return null;
    industrialParks.push(projected);
  }

  return {
    authorization_date: raw.authorization_date,
    province_id: provinceId,
    include_inactive: raw.include_inactive,
    search,
    page,
    page_size: pageSize,
    total,
    industrial_parks: industrialParks,
  };
}

function projectIndustrialParkMutationFields(
  raw: Record<string, unknown>,
): AdminIndustrialParkMutation | null {
  const industrialParkId = readUuid(raw.industrial_park_id);
  const industrialParkCode = readCatalogCode(raw.industrial_park_code);
  const provinceId = readUuid(raw.province_id);
  const provinceCode = readCatalogCode(raw.province_code);
  const provinceDisplayName = readNonEmptyText(raw.province_display_name, 256);
  const displayName = readNonEmptyText(raw.display_name, 256);
  const normalizedKey = readNormalizedKey(raw.normalized_key);
  const active = typeof raw.active === "boolean" ? raw.active : null;
  const version = readInt(raw.version, 1);
  const revisionId = readUuid(raw.revision_id);

  if (
    !industrialParkId ||
    !industrialParkCode ||
    !provinceId ||
    !provinceCode ||
    !provinceDisplayName ||
    !displayName ||
    !normalizedKey ||
    active === null ||
    version === null ||
    !revisionId
  ) {
    return null;
  }

  return {
    industrial_park_id: industrialParkId,
    industrial_park_code: industrialParkCode,
    province_id: provinceId,
    province_code: provinceCode,
    province_display_name: provinceDisplayName,
    display_name: displayName,
    normalized_key: normalizedKey,
    active,
    version,
    revision_id: revisionId,
  };
}

export function projectAdminIndustrialParkMutation(
  raw: unknown,
): AdminIndustrialParkMutation | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, ADMIN_INDUSTRIAL_PARK_MUTATION_KEYS)
  ) {
    return null;
  }
  return projectIndustrialParkMutationFields(raw);
}

export function projectAdminIndustrialParkCreateResult(
  raw: unknown,
): AdminIndustrialParkCreateResult | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, ADMIN_INDUSTRIAL_PARK_CREATE_KEYS) ||
    raw.created !== true
  ) {
    return null;
  }
  const base = projectIndustrialParkMutationFields(raw);
  return base ? { ...base, created: true } : null;
}
