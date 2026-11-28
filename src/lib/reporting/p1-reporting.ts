import type { ReportingFilters } from "./p1-filter";

export type RunStatus = "running" | "succeeded" | "partial" | "failed";

/** Source sau khi join latest run status (đầu vào của read-model). */
export interface ReportingSource {
  id: string;
  drive_file_id: string;
  file_name: string;
  active: boolean;
  is_test: boolean;
  latest_run_status: RunStatus | null;
  last_successful_sync_at: string | null;
  last_seen_at: string | null;
}

export type RecruitmentChannel = "hrp_direct" | "hrp_ctv" | "vendor";

/** Fact của snapshot hiện hành (có cả key và display). */
export interface ReportingFact {
  source_id: string;
  business_date: string;
  project_key: string;
  project_display: string;
  recruiter_key: string;
  recruiter_display: string;
  provider_type_key: string;
  provider_type_display: string;
  employment_type_key: string;
  employment_type_display: string;
  recruited_count: number;
  team_id?: string | null;
  team_code?: string | null;
  team_display_name?: string | null;
  team_active?: boolean | null;
  collaborator_id?: string | null;
  collaborator_display?: string | null;
  recruitment_channel?: RecruitmentChannel | string | null;
}

export type ReportingSourceStatus =
  | "covered"
  | "incomplete"
  | "stale_snapshot"
  | "never_succeeded"
  | "running"
  | "no_run";

export interface ReportingSourceStatusRow {
  id: string;
  drive_file_id: string;
  fileName: string;
  latestRunStatus: RunStatus | null;
  lastSuccessfulSyncAt: string | null;
  lastSeenAt: string | null;
  /** Đã từng có snapshot thành công (last_successful_sync_at != null). */
  everSucceeded: boolean;
  /** Có ít nhất một fact trong snapshot hiện hành (độc lập filter). */
  hasCurrentFacts: boolean;
  /** Có facts đang được cộng vào result (sau filter), kể cả snapshot partial. */
  contributes: boolean;
  status: ReportingSourceStatus;
}

/** Bucket của một breakdown theo chiều (identity = key; display chỉ để trình bày). */
export interface ReportingBucket {
  key: string;
  display: string;
  recruitedCount: number;
}

export interface ReportingCoverage {
  expected: number;
  succeeded: number;
  partial: number;
  failed: number;
  neverSucceeded: number;
  coverageRatio: number | null;
}

/**
 * Breakdown chéo project × provider_type (P1-T1-W04-R7).
 * Mọi phép tính dùng recruited_count; unknown/invalid KHÔNG nhập vào hrp/vendor
 * và KHÔNG nằm trong mẫu số của share.
 */
export interface ProjectProviderMix {
  projectKey: string;
  projectDisplay: string;
  projectTotal: number;
  hrpCount: number;
  vendorCount: number;
  unknownCount: number;
  invalidCount: number;
  knownTotal: number;
  hrpShare: number | null;
  vendorShare: number | null;
  knownCoverage: number | null;
}

export interface ReportingData {
  applied: ReportingFilters;
  recruitedTotal: number;
  byDate: Record<string, number>;
  byProject: Record<string, ReportingBucket>;
  byRecruiter: Record<string, ReportingBucket>;
  byProvider: Record<string, ReportingBucket>;
  byChannel: Record<string, ReportingBucket>;
  byCollaborator: Record<string, ReportingBucket>;
  byEmployment: Record<string, ReportingBucket>;
  byTeam: Record<string, ReportingBucket>;
  /** Breakdown chéo project × provider, tính từ CHÍNH tập facts đã filter. */
  projectProviderMix: ProjectProviderMix[];
  coverage: ReportingCoverage;
  sources: ReportingSourceStatusRow[];
  /** Extent của RESULT sau mọi filter (min/max business_date của facts đã lọc). */
  dateExtent: { min: string | null; max: string | null };
  empty: { noSources: boolean; noFacts: boolean; noMatches: boolean };
}

/** Mô tả fact query sẽ được áp dụng xuống DB (để server query + test kiểm chứng). */
export interface ReportingFactQuery {
  scopeIds: string[];
  source?: string;
  from?: string;
  to?: string;
  project?: string;
  recruiter?: string;
  provider?: string;
  collaborator?: string;
  employment?: string;
}

export const REPORTING_QUERY_FAILED_CODE = "REPORTING_QUERY_FAILED";
export const REPORTING_QUERY_FAILED_MESSAGE =
  "Không tải được dữ liệu báo cáo. Đây không phải trạng thái không có dữ liệu.";

export type ReportingComputeResult =
  | { ok: true; data: ReportingData }
  | { ok: false; code: string; message: string };

/** Kết quả lỗi query — KHÔNG bao giờ là dữ liệu với số 0. */
export function reportingQueryFailed(): { ok: false; code: string; message: string } {
  return { ok: false, code: REPORTING_QUERY_FAILED_CODE, message: REPORTING_QUERY_FAILED_MESSAGE };
}

/**
 * Lập fact query cần đẩy xuống DB. Khi scope rỗng => skip (không query facts).
 * Scope luôn được lọc ở DB (không tải fixture ra khỏi DB); các filter khác
 * cũng truyền xuống DB; read-model chỉ validate/filter lại phòng thủ.
 */
export function buildReportingFactQuery(
  filters: ReportingFilters,
  scopeIds: ReadonlySet<string>
): { skip: boolean; query: ReportingFactQuery } {
  const ids = Array.from(scopeIds);
  return {
    skip: ids.length === 0,
    query: {
      scopeIds: ids,
      source: filters.source,
      from: filters.from,
      to: filters.to,
      project: filters.project,
      recruiter: filters.recruiter,
      provider: filters.provider,
      collaborator: filters.collaborator,
      employment: filters.employment,
    },
  };
}

/** Chuẩn hóa kênh tuyển của một fact (`hrp_direct` | `hrp_ctv` | `vendor` | sentinel). */
export function resolveFactRecruitmentChannel(
  fact: Pick<ReportingFact, "provider_type_key" | "collaborator_id" | "recruitment_channel">
): string {
  if (typeof fact.recruitment_channel === "string" && fact.recruitment_channel !== "") {
    return fact.recruitment_channel;
  }
  if (fact.provider_type_key === "vendor") return "vendor";
  if (fact.provider_type_key === "hrp") {
    return typeof fact.collaborator_id === "string" && fact.collaborator_id.trim() !== ""
      ? "hrp_ctv"
      : "hrp_direct";
  }
  return fact.provider_type_key;
}

/** Kiểm tra thuần một fact có khớp `ReportingFilters` (bao gồm kênh tuyển và CTV) hay không. */
export function matchesReportingFilters(
  fact: ReportingFact,
  filters: ReportingFilters
): boolean {
  if (filters.source && fact.source_id !== filters.source) return false;
  if (filters.from && fact.business_date < filters.from) return false;
  if (filters.to && fact.business_date > filters.to) return false;
  if (filters.project && fact.project_key !== filters.project) return false;
  if (filters.recruiter && fact.recruiter_key !== filters.recruiter) return false;
  if (filters.provider) {
    if (filters.provider === "hrp_direct" || filters.provider === "hrp_ctv") {
      if (resolveFactRecruitmentChannel(fact) !== filters.provider) return false;
    } else if (fact.provider_type_key !== filters.provider) {
      return false;
    }
  }
  if (filters.collaborator) {
    const collabId = typeof fact.collaborator_id === "string" ? fact.collaborator_id.trim() : "";
    if (collabId !== filters.collaborator) return false;
  }
  if (filters.employment && fact.employment_type_key !== filters.employment) return false;
  return true;
}

function sumBy(rows: ReportingFact[], key: keyof ReportingFact): Record<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const k = String(row[key]);
    map.set(k, (map.get(k) ?? 0) + row.recruited_count);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/**
 * Chọn display cho một bucket (identity = key).
 * 1) Chọn display có tổng recruited_count lớn nhất.
 * 2) Hòa => chọn ổn định bằng localeCompare("vi") (nhỏ nhất trước).
 * 3) Sentinel luôn hiển thị nhãn cố định.
 */
export function selectDisplay(key: string, displayCounts: ReadonlyMap<string, number>): string {
  if (key === "__unknown__") return "Không xác định";
  if (key === "__invalid__") return "Không hợp lệ";
  let best = "";
  let bestCount = -1;
  for (const [display, count] of displayCounts) {
    if (
      count > bestCount ||
      (count === bestCount && (best === "" || display.localeCompare(best, "vi") < 0))
    ) {
      best = display;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Group một chiều theo KEY (không theo display). Kết quả: Record<key, bucket>.
 * Tổng recruitedCount của mọi bucket bằng tổng recruited_count của rows đầu vào.
 */
function groupByDimension(
  rows: ReportingFact[],
  keyField: keyof ReportingFact,
  displayField: keyof ReportingFact
): Record<string, ReportingBucket> {
  const buckets = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const k = String(row[keyField]);
    const d = String(row[displayField]);
    let byDisplay = buckets.get(k);
    if (!byDisplay) {
      byDisplay = new Map();
      buckets.set(k, byDisplay);
    }
    byDisplay.set(d, (byDisplay.get(d) ?? 0) + row.recruited_count);
  }
  const out: Record<string, ReportingBucket> = {};
  for (const k of [...buckets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const byDisplay = buckets.get(k)!;
    let total = 0;
    for (const count of byDisplay.values()) total += count;
    out[k] = { key: k, display: selectDisplay(k, byDisplay), recruitedCount: total };
  }
  return out;
}

export const UNKNOWN_TEAM_BUCKET_KEY = "unknown";
export const UNKNOWN_TEAM_DISPLAY = "Không xác định";

export function teamBucketKey(teamCode: string): string {
  const bytes = new TextEncoder().encode(teamCode);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return "team." + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const CHANNEL_DISPLAY_LABELS: Record<string, string> = {
  hrp_direct: "HRP trực tiếp",
  hrp_ctv: "Qua CTV",
  vendor: "Vendor",
  __unknown__: "Không xác định",
  __invalid__: "Không hợp lệ",
};

function groupByChannel(rows: ReportingFact[]): Record<string, ReportingBucket> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const channel = resolveFactRecruitmentChannel(row);
    counts.set(channel, (counts.get(channel) ?? 0) + row.recruited_count);
  }
  const out: Record<string, ReportingBucket> = {};
  for (const key of [...counts.keys()].sort()) {
    out[key] = {
      key,
      display: CHANNEL_DISPLAY_LABELS[key] ?? key,
      recruitedCount: counts.get(key)!,
    };
  }
  return out;
}

function groupByCollaborator(rows: ReportingFact[]): Record<string, ReportingBucket> {
  const buckets = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = typeof row.collaborator_id === "string" ? row.collaborator_id.trim() : "";
    if (!key) continue;
    const display =
      typeof row.collaborator_display === "string" && row.collaborator_display.trim() !== ""
        ? row.collaborator_display.trim()
        : key;
    let byDisplay = buckets.get(key);
    if (!byDisplay) {
      byDisplay = new Map();
      buckets.set(key, byDisplay);
    }
    byDisplay.set(display, (byDisplay.get(display) ?? 0) + row.recruited_count);
  }
  const out: Record<string, ReportingBucket> = {};
  for (const key of [...buckets.keys()].sort()) {
    const byDisplay = buckets.get(key)!;
    let total = 0;
    for (const count of byDisplay.values()) total += count;
    out[key] = { key, display: selectDisplay(key, byDisplay), recruitedCount: total };
  }
  return out;
}

function groupByTeam(rows: ReportingFact[]): Record<string, ReportingBucket> {
  const buckets = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const known = typeof row.team_code === "string" && row.team_code !== ""
      && typeof row.team_display_name === "string" && row.team_display_name !== "";
    const key = known ? teamBucketKey(row.team_code!) : UNKNOWN_TEAM_BUCKET_KEY;
    const display = known
      ? row.team_display_name! + (row.team_active === false ? " (Đã ngừng hoạt động)" : "")
      : UNKNOWN_TEAM_DISPLAY;
    let byDisplay = buckets.get(key);
    if (!byDisplay) {
      byDisplay = new Map();
      buckets.set(key, byDisplay);
    }
    byDisplay.set(display, (byDisplay.get(display) ?? 0) + row.recruited_count);
  }
  const out: Record<string, ReportingBucket> = {};
  for (const key of [...buckets.keys()].sort()) {
    const byDisplay = buckets.get(key)!;
    let total = 0;
    for (const count of byDisplay.values()) total += count;
    out[key] = {
      key,
      display: key === UNKNOWN_TEAM_BUCKET_KEY ? UNKNOWN_TEAM_DISPLAY : selectDisplay(key, byDisplay),
      recruitedCount: total,
    };
  }
  return out;
}

function isProjectSentinel(key: string): boolean {
  return key === "__unknown__" || key === "__invalid__";
}

/**
 * Sort hiển thị: project sentinel xuống cuối; vendor_share giảm dần (share null xuống cuối);
 * known_total giảm dần; cuối cùng projectDisplay theo localeCompare("vi").
 */
function compareProjectMix(a: ProjectProviderMix, b: ProjectProviderMix): number {
  const as = isProjectSentinel(a.projectKey);
  const bs = isProjectSentinel(b.projectKey);
  if (as !== bs) return as ? 1 : -1;
  const av = a.vendorShare;
  const bv = b.vendorShare;
  if (av === null && bv !== null) return 1;
  if (av !== null && bv === null) return -1;
  if (av !== null && bv !== null && av !== bv) return bv - av;
  if (a.knownTotal !== b.knownTotal) return b.knownTotal - a.knownTotal;
  return a.projectDisplay.localeCompare(b.projectDisplay, "vi");
}

/**
 * Breakdown chéo project × provider_type (P1-T1-W04-R7).
 *
 * - Group theo project_KEY; display chọn bằng selectDisplay (dùng chung quy tắc breakdown).
 * - projectTotal = hrp + vendor + unknown + invalid (key provider ngoài danh mục tính vào invalid).
 * - knownTotal = hrp + vendor; hrpShare/vendorShare = count / knownTotal (null khi knownTotal = 0).
 * - knownCoverage = knownTotal / projectTotal (null khi projectTotal = 0).
 * - Tổng projectTotal của mọi dự án = tổng recruited_count của rows đầu vào.
 */
export function buildProjectProviderMix(rows: ReportingFact[]): ProjectProviderMix[] {
  const groups = new Map<
    string,
    { displays: Map<string, number>; hrp: number; vendor: number; unknown: number; invalid: number; total: number }
  >();
  for (const row of rows) {
    let g = groups.get(row.project_key);
    if (!g) {
      g = { displays: new Map(), hrp: 0, vendor: 0, unknown: 0, invalid: 0, total: 0 };
      groups.set(row.project_key, g);
    }
    g.displays.set(row.project_display, (g.displays.get(row.project_display) ?? 0) + row.recruited_count);
    g.total += row.recruited_count;
    if (row.provider_type_key === "hrp") g.hrp += row.recruited_count;
    else if (row.provider_type_key === "vendor") g.vendor += row.recruited_count;
    else if (row.provider_type_key === "__unknown__") g.unknown += row.recruited_count;
    else g.invalid += row.recruited_count;
  }

  const out: ProjectProviderMix[] = [];
  for (const [key, g] of groups) {
    const knownTotal = g.hrp + g.vendor;
    out.push({
      projectKey: key,
      projectDisplay: selectDisplay(key, g.displays),
      projectTotal: g.total,
      hrpCount: g.hrp,
      vendorCount: g.vendor,
      unknownCount: g.unknown,
      invalidCount: g.invalid,
      knownTotal,
      hrpShare: knownTotal > 0 ? g.hrp / knownTotal : null,
      vendorShare: knownTotal > 0 ? g.vendor / knownTotal : null,
      knownCoverage: g.total > 0 ? knownTotal / g.total : null,
    });
  }
  out.sort(compareProjectMix);
  return out;
}

function sourceStatus(
  s: ReportingSource,
  hasCurrentFacts: boolean
): ReportingSourceStatus {
  if (s.latest_run_status === "succeeded") return "covered";
  if (s.latest_run_status === "partial") return "incomplete";
  if (s.latest_run_status === "failed") return hasCurrentFacts ? "stale_snapshot" : "never_succeeded";
  if (s.latest_run_status === "running") return "running";
  return "no_run";
}

/**
 * Read-model thuần cho reporting BoD P1 (contract p1-reporting/0.1).
 *
 * - Scope = active=true AND is_test=false (sources đầu vào đã là scope).
 * - Facts đầu vào đã được lọc ở DB (scope + source + date + dimensions);
 *   read-model vẫn lọc lại phòng thủ.
 * - `sourcesWithFacts`: tập source_id có ít nhất một fact trong snapshot hiện hành
 *   (độc lập filter), để phân biệt stale_snapshot vs never_succeeded.
 */
export function computeReporting(
  sources: ReportingSource[],
  facts: ReportingFact[],
  filters: ReportingFilters,
  sourcesWithFacts?: ReadonlySet<string>
): ReportingData {
  const scope = sources.filter((s) => s.active && !s.is_test);
  const scopeIds = new Set(scope.map((s) => s.id));

  const scopeFacts = facts.filter((f) => scopeIds.has(f.source_id));

  const rows = scopeFacts.filter((f) => matchesReportingFilters(f, filters));

  const recruitedTotal = rows.reduce((a, r) => a + r.recruited_count, 0);

  // Coverage/status chỉ phản ánh scope (hoặc source được chọn nếu có source filter).
  const visible = filters.source ? scope.filter((s) => s.id === filters.source) : scope;
  const succeeded = visible.filter((s) => s.latest_run_status === "succeeded").length;
  const partial = visible.filter((s) => s.latest_run_status === "partial").length;
  const failed = visible.filter((s) => s.latest_run_status === "failed").length;
  const neverSucceeded = visible.filter((s) => s.last_successful_sync_at === null).length;
  const coverageRatio = visible.length === 0 ? null : (visible.length - neverSucceeded) / visible.length;

  const contributingIds = new Set(rows.map((r) => r.source_id));
  const hasCurrentFactsOf = (s: ReportingSource): boolean =>
    sourcesWithFacts ? sourcesWithFacts.has(s.id) : scopeFacts.some((f) => f.source_id === s.id);

  const sourceRows: ReportingSourceStatusRow[] = visible.map((s) => {
    const everSucceeded = s.last_successful_sync_at !== null;
    const hasCurrentFacts = hasCurrentFactsOf(s);
    const contributes = contributingIds.has(s.id);
    return {
      id: s.id,
      drive_file_id: s.drive_file_id,
      fileName: s.file_name,
      latestRunStatus: s.latest_run_status,
      lastSuccessfulSyncAt: s.last_successful_sync_at,
      lastSeenAt: s.last_seen_at,
      everSucceeded,
      hasCurrentFacts,
      contributes,
      status: sourceStatus(s, hasCurrentFacts),
    };
  });

  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (const f of rows) {
    if (minDate === null || f.business_date < minDate) minDate = f.business_date;
    if (maxDate === null || f.business_date > maxDate) maxDate = f.business_date;
  }

  return {
    applied: filters,
    recruitedTotal,
    byDate: sumBy(rows, "business_date"),
    byProject: groupByDimension(rows, "project_key", "project_display"),
    byRecruiter: groupByDimension(rows, "recruiter_key", "recruiter_display"),
    byProvider: groupByDimension(rows, "provider_type_key", "provider_type_display"),
    byChannel: groupByChannel(rows),
    byCollaborator: groupByCollaborator(rows),
    byEmployment: groupByDimension(rows, "employment_type_key", "employment_type_display"),
    byTeam: groupByTeam(rows),
    projectProviderMix: buildProjectProviderMix(rows),
    coverage: { expected: visible.length, succeeded, partial, failed, neverSucceeded, coverageRatio },
    sources: sourceRows,
    dateExtent: { min: minDate, max: maxDate },
    empty: {
      noSources: scope.length === 0,
      noFacts: scope.length > 0 && !visible.some(hasCurrentFactsOf),
      noMatches: scope.length > 0 && visible.some(hasCurrentFactsOf) && rows.length === 0,
    },
  };
}

/** Dòng thô từ view reporting_dimension_options_v01 (dimension, key, display, weight). */
export interface DimensionOptionRow {
  dimension: string;
  key: string;
  display: string;
  recruited_count: number;
}

/** Một lựa chọn filter (identity = key; display chỉ để trình bày). */
export interface DimensionOption {
  key: string;
  display: string;
}

export interface DimensionOptions {
  projects: DimensionOption[];
  recruiters: DimensionOption[];
  providers: DimensionOption[];
  employments: DimensionOption[];
  collaborators: DimensionOption[];
}

/**
 * Gom danh mục dimension từ view options (scope active && !is_test, đã lọc ở DB).
 * Group theo (dimension, key), chọn display theo đúng quy tắc (max recruited_count,
 * hòa thì localeCompare("vi"), sentinel cố định) — dùng chung selectDisplay để không
 * trùng business formula với breakdown.
 */
export function buildDimensionOptions(rows: DimensionOptionRow[]): DimensionOptions {
  const groups: Record<string, Map<string, Map<string, number>>> = {
    project: new Map(),
    recruiter: new Map(),
    provider: new Map(),
    employment: new Map(),
    collaborator: new Map(),
  };
  for (const row of rows) {
    const byKey = groups[row.dimension];
    if (!byKey) continue;
    let byDisplay = byKey.get(row.key);
    if (!byDisplay) {
      byDisplay = new Map();
      byKey.set(row.key, byDisplay);
    }
    byDisplay.set(row.display, (byDisplay.get(row.display) ?? 0) + row.recruited_count);
  }
  const toArray = (byKey: Map<string, Map<string, number>>): DimensionOption[] =>
    [...byKey.entries()]
      .map(([key, byDisplay]) => ({ key, display: selectDisplay(key, byDisplay) }))
      .sort((a, b) => a.display.localeCompare(b.display, "vi"));
  return {
    projects: toArray(groups.project),
    recruiters: toArray(groups.recruiter),
    providers: toArray(groups.provider),
    employments: toArray(groups.employment),
    collaborators: toArray(groups.collaborator),
  };
}
