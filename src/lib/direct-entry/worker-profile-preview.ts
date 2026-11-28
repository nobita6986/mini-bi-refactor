/**
 * P1.6-I04C3-R3A - Preview model catalog-agnostic cho ho so NLĐ day du.
 *
 * Tach hai buoc: (1) parse/normalize o worker-profile-paste.ts; (2) resolve catalog qua seam
 * duoc tiem vao o day. Module KHONG hard-code project/recruiter/bank id, KHONG goi API,
 * KHONG giu actor/capability/scope, KHONG chua server DTO hay document metadata.
 */
import {
  matchCatalogReference,
  type PasteCatalogOption,
} from "./excel-paste-import.ts";
import {
  WORKER_PROFILE_CONTRACT_VERSION,
  issue,
  type ResolvedColumn,
  type WorkerProfileIssue,
} from "./worker-profile-import-contract.ts";
import {
  parseWorkerProfilePaste,
  type WorkerProfileRow,
} from "./worker-profile-paste.ts";

export type { PasteCatalogOption };

export type PasteCatalogCollaboratorOption = {
  id: string;
  label: string;
  active: boolean;
};

export type PasteCatalogSource = {
  projects: readonly PasteCatalogOption[];
  recruiters: readonly PasteCatalogOption[];
  labor_types: readonly PasteCatalogOption[];
  collaborators?: readonly PasteCatalogCollaboratorOption[];
};

/** Caller cung cap nguon catalog theo ngay hieu luc (co the la cache cua trang). */
export type PasteCatalogLoader = (effectiveDate: string) => PasteCatalogSource | null;

export type PasteCatalogResolver = {
  resolve(effectiveDate: string): PasteCatalogSource | null;
  /** So lan loader duoc goi cho ngay do (ky vong 1 sau lan tai thanh cong dau tien). */
  loadCount(effectiveDate: string): number;
  resolvedDates(): string[];
};

/**
 * Memoize theo effective date: moi ngay chi tai catalog MOT LAN sau khi tai thanh cong.
 * Ket qua null (chua tai duoc) khong duoc cache de lan render sau con thu lai duoc.
 */
export function createPasteCatalogResolver(load: PasteCatalogLoader): PasteCatalogResolver {
  const cache = new Map<string, PasteCatalogSource>();
  const attempts = new Map<string, number>();
  return {
    resolve(effectiveDate) {
      const cached = cache.get(effectiveDate);
      if (cached) return cached;
      attempts.set(effectiveDate, (attempts.get(effectiveDate) ?? 0) + 1);
      const loaded = load(effectiveDate);
      if (loaded) cache.set(effectiveDate, loaded);
      return loaded;
    },
    loadCount(effectiveDate) {
      return attempts.get(effectiveDate) ?? 0;
    },
    resolvedDates() {
      return [...cache.keys()].sort();
    },
  };
}

/** Danh tinh cua cac dong CHUA LUU dang co tren trang, do caller truyen vao. */
export type ExistingProfileIdentity = {
  employeeCode?: string;
  nationalId?: string;
  phone?: string;
};

export type WorkerProfilePreviewRow = {
  sourceRow: number;
  row: WorkerProfileRow;
  resolved: {
    project_id: string | null;
    recruiter_id: string | null;
    provider_type: "hrp" | "vendor" | null;
    collaborator_id?: string | null;
  };
  labels: { project: string; recruiter: string; laborType: string };
  issues: WorkerProfileIssue[];
  warnings: WorkerProfileIssue[];
  canProceed: boolean;
};

export type WorkerProfilePreview = {
  contractVersion: string;
  columns: readonly ResolvedColumn[];
  rows: WorkerProfilePreviewRow[];
  /** Tat ca issue (header + theo dong). */
  issues: WorkerProfileIssue[];
  /** Chi issue o muc bang/header. */
  headerIssues: WorkerProfileIssue[];
  totalRows: number;
  validRows: number;
  errorCount: number;
  warningCount: number;
  canProceed: boolean;
  catalogDates: readonly string[];
};

/** Mask giu lai `visible` ky tu cuoi; phan con lai thay bang dau cham. */
export function maskSensitiveTail(value: string, visible = 4): string {
  if (value.length <= visible) return "\u2022".repeat(value.length);
  return "\u2022".repeat(value.length - visible) + value.slice(-visible);
}

export function maskNationalId(value: string): string {
  return maskSensitiveTail(value, 4);
}

export function maskAccountNumber(value: string): string {
  return maskSensitiveTail(value, 4);
}

function addIssue(target: WorkerProfileIssue[], entry: WorkerProfileIssue): void {
  target.push(entry);
}

function resolveRow(
  row: WorkerProfileRow,
  source: PasteCatalogSource | null,
): { resolved: WorkerProfilePreviewRow["resolved"]; labels: WorkerProfilePreviewRow["labels"];
  issues: WorkerProfileIssue[] } {
  const issues: WorkerProfileIssue[] = [];
  const resolved: WorkerProfilePreviewRow["resolved"] =
    { project_id: null, recruiter_id: null, provider_type: null };
  const labels: WorkerProfilePreviewRow["labels"] =
    { project: row.project_label, recruiter: row.recruiter_label, laborType: row.labor_type };
  if (source === null) {
    addIssue(issues, issue("PASTE_CATALOG_UNAVAILABLE", "error", row.sourceRow, null));
    return { resolved, labels, issues };
  }

  const project = matchCatalogReference(row.project_label, source.projects);
  if (project.ok) resolved.project_id = project.id;
  else addIssue(issues, issue(project.reason === "AMBIGUOUS" ? "PASTE_CATALOG_AMBIGUOUS" :
    "PASTE_CATALOG_MISSING", "error", row.sourceRow, "project_id"));

  const recruiter = matchCatalogReference(row.recruiter_label, source.recruiters);
  if (recruiter.ok) {
    resolved.recruiter_id = recruiter.id;
    resolved.provider_type = source.recruiters.find((option) => option.id === recruiter.id)
      ?.provider_type ?? null;
  }
  else addIssue(issues, issue(recruiter.reason === "AMBIGUOUS" ? "PASTE_CATALOG_AMBIGUOUS" :
    "PASTE_CATALOG_MISSING", "error", row.sourceRow, "recruiter_id"));

  const laborType = matchCatalogReference(row.labor_type, source.labor_types);
  if (laborType.ok) {
    labels.laborType = source.labor_types.find((option) => option.id === laborType.id)?.label ??
      row.labor_type;
  } else {
    addIssue(issues, issue("PASTE_LABOR_TYPE_INVALID", "error", row.sourceRow, "labor_type"));
    labels.laborType = row.labor_type === "" ? "" : row.labor_type + " · không còn hoạt động";
  }

  // R4-S02: STK / tên ngân hàng / tên chủ tài khoản là TEXT metadata để đối chiếu.
  // KHONG resolve qua direct_entry_banks, KHONG phu thuoc banks=0, KHONG tao bank_id.
  return { resolved, labels, issues };
}

function duplicateIssues(
  row: WorkerProfileRow,
  index: number,
  firstSeen: ReadonlyMap<string, number>,
  existing: readonly ExistingProfileIdentity[],
): WorkerProfileIssue[] {
  const issues: WorkerProfileIssue[] = [];
  const nationalId = row.worker.national_id.state === "provided" ? row.worker.national_id.value : null;
  const phone = row.worker.phone.state === "provided" ? row.worker.phone.value : null;

  const codeFirst = row.employee_code === "" ? undefined : firstSeen.get("code:" + row.employee_code);
  if (codeFirst !== undefined) {
    addIssue(issues, issue("PASTE_DUPLICATE_EMPLOYEE_CODE", "error", row.sourceRow, "employee_code"));
  }
  if (nationalId !== null && firstSeen.has("nid:" + nationalId)) {
    addIssue(issues, issue("PASTE_DUPLICATE_NATIONAL_ID", "error", row.sourceRow, "national_id"));
  }
  if (phone !== null && firstSeen.has("phone:" + phone)) {
    addIssue(issues, issue("PASTE_DUPLICATE_PHONE", "warning", row.sourceRow, "phone"));
  }
  void index;

  if (row.employee_code !== "" &&
      existing.some((item) => item.employeeCode === row.employee_code)) {
    addIssue(issues, issue("PASTE_EXISTING_EMPLOYEE_CODE", "error", row.sourceRow, "employee_code"));
  }
  if (nationalId !== null && existing.some((item) => item.nationalId === nationalId)) {
    addIssue(issues, issue("PASTE_EXISTING_NATIONAL_ID", "error", row.sourceRow, "national_id"));
  }
  if (phone !== null && existing.some((item) => item.phone === phone)) {
    addIssue(issues, issue("PASTE_EXISTING_PHONE", "warning", row.sourceRow, "phone"));
  }
  return issues;
}

export function buildWorkerProfilePreview(input: {
  text: string;
  referenceDate: string;
  resolver: PasteCatalogResolver;
  existing?: readonly ExistingProfileIdentity[];
  employeeCodeMode?: "required" | "server-generated";
}): WorkerProfilePreview {
  const parsed = parseWorkerProfilePaste({ text: input.text,
    referenceDate: input.referenceDate, employeeCodeMode: input.employeeCodeMode });
  const existing = input.existing ?? [];
  const rows: WorkerProfilePreviewRow[] = [];

  // Duplicate detection: trong khoi paste + voi cac dong chua luu do caller cung cap.
  const firstSeen = new Map<string, number>();
  for (const row of parsed.rows) {
    if (row.employee_code !== "") firstSeen.set("code:" + row.employee_code, row.sourceRow);
    if (row.worker.national_id.state === "provided") {
      firstSeen.set("nid:" + row.worker.national_id.value, row.sourceRow);
    }
    if (row.worker.phone.state === "provided") {
      firstSeen.set("phone:" + row.worker.phone.value, row.sourceRow);
    }
  }
  const seenOnce = new Map<string, number>();
  for (const row of parsed.rows) {
    const duplicate = duplicateIssues(row, 0, seenOnce, existing);
    if (row.employee_code !== "") seenOnce.set("code:" + row.employee_code, row.sourceRow);
    if (row.worker.national_id.state === "provided") {
      seenOnce.set("nid:" + row.worker.national_id.value, row.sourceRow);
    }
    if (row.worker.phone.state === "provided") {
      seenOnce.set("phone:" + row.worker.phone.value, row.sourceRow);
    }

    const source = row.first_work_date === "" ? null
      : input.resolver.resolve(row.first_work_date);
    const resolution = resolveRow(row, source);

    const ownIssues = parsed.issues.filter((item) => item.row === row.sourceRow);
    const all = [...ownIssues, ...resolution.issues, ...duplicate];
    const rowIssues = all.filter((item) => item.severity === "error");
    const rowWarnings = all.filter((item) => item.severity === "warning");
    rows.push({
      sourceRow: row.sourceRow,
      row,
      resolved: resolution.resolved,
      labels: resolution.labels,
      issues: rowIssues,
      warnings: rowWarnings,
      canProceed: rowIssues.length === 0,
    });
  }

  const tableIssues = parsed.issues.filter((item) =>
    item.row === 0 || !parsed.rows.some((row) => row.sourceRow === item.row));
  const allIssues = [
    ...tableIssues,
    ...rows.flatMap((row) => [...row.issues, ...row.warnings]),
  ];
  const errorCount = allIssues.filter((item) => item.severity === "error").length;
  const warningCount = allIssues.filter((item) => item.severity === "warning").length;
  const catalogDates = [...new Set(parsed.rows.map((row) => row.first_work_date)
    .filter((date) => date !== ""))].sort();

  return {
    contractVersion: WORKER_PROFILE_CONTRACT_VERSION,
    columns: parsed.columns,
    rows,
    issues: allIssues,
    headerIssues: tableIssues,
    totalRows: parsed.rows.length,
    validRows: rows.filter((row) => row.canProceed).length,
    errorCount,
    warningCount,
    canProceed: errorCount === 0 && rows.length > 0 && parsed.rows.length > 0,
    catalogDates,
  };
}
