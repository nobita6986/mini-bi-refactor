/**
 * W2S1 - Strict client projection cho chi tiet NLĐ (entry detail + worker_portrait).
 *
 * Server (`src/lib/direct-entry/write-api.ts#projectEntry`) da fail-closed; lop nay
 * chi giu DUNG cac field UI duoc phep doc va cung fail-closed:
 *  - thieu/sai kieu/sai entry_id, key la trong `worker_portrait`/`current` => null;
 *  - `origin`/`is_current` la su that server tra ve, UI KHONG suy luan tu
 *    version/SUPERSEDED/thu tu mang;
 *  - `legacy_added` bat buoc co `added_at`; `ENROLLMENT` khong duoc co `added_at`;
 *  - khong nhan storage key, signed URL hay truong la.
 *
 * Module thuan (khong import server-only), chay duoc trong Node test va client.
 */

export const WORKER_PORTRAIT_STATUSES = [
  "MISSING", "QUEUED", "UPLOADING", "QUARANTINED", "SCANNING", "READY", "FAILED", "SUPERSEDED",
] as const;
export type WorkerPortraitStatus = (typeof WORKER_PORTRAIT_STATUSES)[number];

export type WorkerPortraitOrigin = "ENROLLMENT" | "LEGACY_ADDED";

export type WorkerPortraitCurrent = {
  document_id: string;
  version: number;
  checksum_sha256: string;
  mime_type: "image/jpeg" | "image/png";
  size_bytes: number;
};

export type WorkerPortraitProjection = {
  origin: WorkerPortraitOrigin | null;
  added_at: string | null;
  status: WorkerPortraitStatus;
  current: WorkerPortraitCurrent | null;
};

export type WorkerDetailDocumentType = "CCCD_FRONT" | "CCCD_BACK" | "EMPLOYMENT_CONTRACT";

export type WorkerDetailDocument = {
  document_id: string;
  document_type: WorkerDetailDocumentType;
  version: number;
  size_bytes: number;
  mime_type: string;
  upload_status: string;
  scan_status: string;
  validation_status: string;
};

/** Complete worker profile returned after server-side view and row-scope authorization. */
export type WorkerDetailWorker = {
  kind: "full";
  display_name: string;
  gender: "MALE" | "FEMALE" | "OTHER" | null;
  date_of_birth: string | null;
  national_id: string | null;
  national_id_issued_at: string | null;
  national_id_issued_place: string | null;
  address: string | null;
  phone: string | null;
};

export type WorkerDetailEmployment = {
  status: "UNCONFIRMED" | "ON" | "OFF";
  effective_date: string;
  version: number;
};

export type WorkerDetailCreator = {
  displayName: string | null;
  loginId: string | null;
};

export type WorkerDetailProjection = {
  entryId: string;
  entryVersion: number;
  createdAt: string;
  createdBy: WorkerDetailCreator;
  worker: WorkerDetailWorker;
  employment: WorkerDetailEmployment;
  /** `hrp` | `vendor` do server quyet dinh (khong suy tu UI). */
  providerType: "hrp" | "vendor";
  providerLabel: string;
  collaboratorId?: string | null;
  collaboratorDisplayName?: string | null;
  documents: WorkerDetailDocument[];
  /** null khi actor thieu `document_view` (server khong tra du lieu portrait). */
  portrait: WorkerPortraitProjection | null;
  paymentBankName?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ISO_UTC_MICROS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const DOCUMENT_TYPES: readonly WorkerDetailDocumentType[] = [
  "CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT",
];
const DOCUMENT_KEYS = [
  "document_id", "document_type", "version", "size_bytes", "mime_type",
  "upload_status", "scan_status", "validation_status", "created_at", "updated_at",
] as const;
const PORTRAIT_KEYS = ["origin", "added_at", "status", "current"] as const;
const PORTRAIT_CURRENT_KEYS = [
  "document_id", "version", "checksum_sha256", "mime_type", "size_bytes",
] as const;
const WORKER_PROJECTION_KEYS = [
  "display_name", "gender", "date_of_birth", "national_id", "national_id_issued_at",
  "national_id_issued_place", "address", "phone",
] as const;
const OPTIONAL_STATES = ["omitted", "unknown", "intentionally_blank"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function projectOptionalState(value: unknown): "omitted" | "unknown" | "intentionally_blank" | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.state !== "string") return null;
  return (OPTIONAL_STATES as readonly string[]).includes(value.state)
    ? value.state as "omitted" | "unknown" | "intentionally_blank"
    : null;
}

/** Doc mot OptionalValue<string>/<Gender>; `provided` tra value, state khac tra null. */
function projectOptionalValue(
  value: unknown,
  maxLength: number,
  options?: { allowBlankProvided?: boolean },
): { ok: true; value: string | null } | { ok: false } {
  if (!isRecord(value)) return { ok: false };
  if (value.state === "provided") {
    if (Object.keys(value).length !== 2 || typeof value.value !== "string" ||
        value.value.length > maxLength) return { ok: false };
    if (value.value.trim().length < 1) {
      return options?.allowBlankProvided ? { ok: true, value: null } : { ok: false };
    }
    return { ok: true, value: value.value };
  }
  if (projectOptionalState(value) === null) return { ok: false };
  return { ok: true, value: null };
}

/** Truong optional trong `WorkerDetails` co the vang mat; vang mat == chua khai bao. */
function projectOptionalField(
  value: unknown,
  maxLength: number,
  options?: { allowBlankProvided?: boolean },
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined) return { ok: true, value: null };
  return projectOptionalValue(value, maxLength, options);
}

function projectWorker(value: unknown): WorkerDetailWorker | null {
  if (!isRecord(value)) return null;
  if (typeof value.display_name !== "string" ||
      value.display_name.length > 256 ||
      (value.display_name.length > 0 && value.display_name.trim().length < 1) ||
      Object.keys(value).some((key) => !(WORKER_PROJECTION_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const gender = projectOptionalField(value.gender, 16);
  if (!gender.ok) return null;
  if (gender.value !== null && !["MALE", "FEMALE", "OTHER"].includes(gender.value)) return null;
  const dateOfBirth = projectOptionalField(value.date_of_birth, 32);
  const nationalId = projectOptionalField(value.national_id, 64);
  const issuedAt = projectOptionalField(value.national_id_issued_at, 32);
  const issuedPlace = projectOptionalField(value.national_id_issued_place, 256);
  const address = projectOptionalField(value.address, 1024, { allowBlankProvided: true });
  const phone = projectOptionalField(value.phone, 64, { allowBlankProvided: true });
  if (!dateOfBirth.ok || !nationalId.ok || !issuedAt.ok || !issuedPlace.ok ||
      !address.ok || !phone.ok) return null;
  return {
    kind: "full",
    display_name: value.display_name,
    gender: gender.value as "MALE" | "FEMALE" | "OTHER" | null,
    date_of_birth: dateOfBirth.value,
    national_id: nationalId.value,
    national_id_issued_at: issuedAt.value,
    national_id_issued_place: issuedPlace.value,
    address: address.value,
    phone: phone.value,
  };
}

function projectPortraitCurrent(value: unknown, origin: WorkerPortraitOrigin | null): WorkerPortraitCurrent | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, PORTRAIT_CURRENT_KEYS)) return undefined;
  if (origin === null) return undefined;
  if (typeof value.document_id !== "string" || !UUID.test(value.document_id)) return undefined;
  if (!isPositiveInt(value.version)) return undefined;
  if (typeof value.checksum_sha256 !== "string" || !SHA256.test(value.checksum_sha256)) return undefined;
  if (value.mime_type !== "image/jpeg" && value.mime_type !== "image/png") return undefined;
  if (!isPositiveInt(value.size_bytes)) return undefined;
  return {
    document_id: value.document_id,
    version: value.version,
    checksum_sha256: value.checksum_sha256,
    mime_type: value.mime_type,
    size_bytes: value.size_bytes,
  };
}

export function projectWorkerPortrait(value: unknown): WorkerPortraitProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, PORTRAIT_KEYS)) return null;
  if (!(value.origin === null || value.origin === "ENROLLMENT" || value.origin === "LEGACY_ADDED")) {
    return null;
  }
  const origin = value.origin as WorkerPortraitOrigin | null;
  if (!(value.added_at === null ||
      (typeof value.added_at === "string" && Number.isFinite(Date.parse(value.added_at))))) {
    return null;
  }
  // LEGACY_ADDED bat buoc co added_at; ENROLLMENT/null khong duoc co.
  if ((origin === "LEGACY_ADDED") !== (value.added_at !== null)) return null;
  if (typeof value.status !== "string" ||
      !(WORKER_PORTRAIT_STATUSES as readonly string[]).includes(value.status)) return null;
  const current = projectPortraitCurrent(value.current, origin);
  if (current === undefined) return null;
  return {
    origin,
    added_at: value.added_at as string | null,
    status: value.status as WorkerPortraitStatus,
    current,
  };
}

function projectDocuments(value: unknown): WorkerDetailDocument[] | null {
  if (!Array.isArray(value)) return null;
  const documents: WorkerDetailDocument[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || Object.keys(raw).some((key) => !(DOCUMENT_KEYS as readonly string[]).includes(key))) {
      return null;
    }
    if (typeof raw.document_id !== "string" || !UUID.test(raw.document_id)) return null;
    if (typeof raw.document_type !== "string" ||
        !(DOCUMENT_TYPES as readonly string[]).includes(raw.document_type)) return null;
    if (!isPositiveInt(raw.version)) return null;
    if (!isPositiveInt(raw.size_bytes)) return null;
    if (typeof raw.mime_type !== "string" || typeof raw.upload_status !== "string" ||
        typeof raw.scan_status !== "string" || typeof raw.validation_status !== "string") return null;
    documents.push({
      document_id: raw.document_id,
      document_type: raw.document_type as WorkerDetailDocumentType,
      version: raw.version,
      size_bytes: raw.size_bytes,
      mime_type: raw.mime_type,
      upload_status: raw.upload_status,
      scan_status: raw.scan_status,
      validation_status: raw.validation_status,
    });
  }
  return documents;
}

function projectEmployment(value: unknown): WorkerDetailEmployment | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["status", "effective_date", "version"].includes(key))) {
    return null;
  }
  if (!(value.status === "UNCONFIRMED" || value.status === "ON" || value.status === "OFF")) return null;
  if (typeof value.effective_date !== "string" || !ISO_DATE.test(value.effective_date)) return null;
  if (!isPositiveInt(value.version)) return null;
  return { status: value.status, effective_date: value.effective_date, version: value.version };
}

function projectCreator(value: unknown): WorkerDetailCreator | null {
  if (!isRecord(value) || !hasExactKeys(value, ["display_name", "login_id"])) return null;
  if ((value.display_name !== null && (typeof value.display_name !== "string" ||
      value.display_name.length < 1 || value.display_name.length > 256)) ||
      (value.login_id !== null && (typeof value.login_id !== "string" ||
        value.login_id.length < 1 || value.login_id.length > 256)) ||
      (value.display_name === null && value.login_id === null)) return null;
  return { displayName: value.display_name as string | null, loginId: value.login_id as string | null };
}

/**
 * Doc body `{ ok: true, entry: {...} }` cua GET /api/direct-entry/entries/{entryId}.
 * Tra null (fail-closed) khi thieu/sai kieu, sai entry_id, hoac co field la.
 */
export function projectWorkerDetail(value: unknown, expectedEntryId: string): WorkerDetailProjection | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.entry)) return null;
  const entry = value.entry;
  if (entry.entry_id !== expectedEntryId) return null;
  if (!isPositiveInt(entry.version)) return null;
  if (typeof entry.created_at !== "string" || !ISO_UTC_MICROS.test(entry.created_at) ||
      !Number.isFinite(Date.parse(entry.created_at))) return null;
  const createdBy = projectCreator(entry.created_by);
  if (createdBy === null) return null;
  const worker = projectWorker(entry.worker_details);
  if (worker === null) return null;
  const employment = projectEmployment(entry.employment_status);
  if (employment === null) return null;
  const documents = projectDocuments(entry.documents);
  if (documents === null) return null;
  if (entry.provider_type !== "hrp" && entry.provider_type !== "vendor") return null;
  if (Object.hasOwn(entry, "collaborator_id") && entry.collaborator_id !== null &&
      (typeof entry.collaborator_id !== "string" || entry.collaborator_id.trim().length === 0)) {
    return null;
  }
  if (Object.hasOwn(entry, "collaborator_display_name") && entry.collaborator_display_name !== null &&
      (typeof entry.collaborator_display_name !== "string" || entry.collaborator_display_name.trim().length === 0)) {
    return null;
  }
  const collaboratorId = typeof entry.collaborator_id === "string"
    ? entry.collaborator_id.trim()
    : null;
  const collaboratorDisplayName = typeof entry.collaborator_display_name === "string"
    ? entry.collaborator_display_name.trim()
    : null;
  if (!("worker_portrait" in entry)) return null;
  const portrait = entry.worker_portrait === null ? null : projectWorkerPortrait(entry.worker_portrait);
  if (entry.worker_portrait !== null && portrait === null) return null;
  const paymentBankName =
    isRecord(entry.payment) && typeof entry.payment.bank_name === "string"
      ? entry.payment.bank_name.trim() || null
      : null;
  const providerLabel = entry.provider_type === "vendor"
    ? "Vendor"
    : collaboratorId
      ? (collaboratorDisplayName ? `CTV · ${collaboratorDisplayName}` : "CTV")
      : "HRP";
  return {
    entryId: entry.entry_id,
    entryVersion: entry.version,
    createdAt: entry.created_at,
    createdBy,
    worker,
    employment,
    providerType: entry.provider_type,
    providerLabel,
    ...(Object.hasOwn(entry, "collaborator_id") ? { collaboratorId } : {}),
    ...(Object.hasOwn(entry, "collaborator_display_name") ? { collaboratorDisplayName } : {}),
    documents,
    portrait,
    ...(paymentBankName !== null ? { paymentBankName } : {}),
  };
}

export type DetailFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Mot GET duy nhat cho mot lan mo chi tiet; moi loi mang/HTTP/projection => null. */
export async function fetchWorkerDetail(
  entryId: string,
  fetchImpl: DetailFetch,
): Promise<WorkerDetailProjection | null> {
  try {
    const response = await fetchImpl(
      "/api/direct-entry/entries/" + encodeURIComponent(entryId),
      { cache: "no-store", credentials: "same-origin" },
    );
    if (!response.ok) return null;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    return projectWorkerDetail(body, entryId);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Nhan hien thi (pure)                                                      */
/* ------------------------------------------------------------------------- */

export const WORKER_PORTRAIT_STATUS_LABELS: Readonly<Record<WorkerPortraitStatus, string>> =
  Object.freeze({
    MISSING: "Chưa có ảnh",
    QUEUED: "Đang chờ xử lý",
    UPLOADING: "Đang tải lên",
    QUARANTINED: "Đang cách ly",
    SCANNING: "Đang kiểm tra",
    READY: "Sẵn sàng",
    FAILED: "Xử lý thất bại",
    SUPERSEDED: "Đã thay thế",
  });

/**
 * Nhan nguon goc do SERVER quyet dinh. `LEGACY_ADDED` luon kem ngay bo sung va
 * khong bao gio duoc mo ta la anh onboarding/nhap moi.
 */
export function workerPortraitOriginLabel(origin: WorkerPortraitOrigin | null, addedAt: string | null): string {
  if (origin === "ENROLLMENT") return "Ảnh nhập mới";
  if (origin === "LEGACY_ADDED") {
    return addedAt === null ? "Ảnh bổ sung" : "Ảnh bổ sung · " + addedAt.slice(0, 10);
  }
  return "Chưa xác định nguồn ảnh";
}

/**
 * Chinh sach gui anh ho so.
 *
 * Reserve/finalize thanh cong KHONG lam anh moi tro thanh `current`: contract W2S1 yeu cau anh
 * THAY THE phai qua buoc duyet (ly do nhap khong thay cho buoc duyet). Vi backend hien chua co
 * API duyet anh thay the, UI chi cho gui anh DAU TIEN (`current === null`) va khoa thay the khi
 * da co `current`. `current` luon doc tu projection server tra ve, khong bao gio ghi cuc bo.
 */
/** Vong doi CHUA co ket qua cuoi => khong cho gui anh khac. QUARANTINED cung thuoc nhom nay:
 *  anh dang bi cach ly/cho xu ly, gui them se tao ban ghi chong cheo. */
export const WORKER_PORTRAIT_IN_FLIGHT_STATUSES = [
  "QUEUED", "UPLOADING", "QUARANTINED", "SCANNING",
] as const;

export type WorkerPortraitUploadPolicyReason =
  | "HIDDEN"
  | "REPLACEMENT_REQUIRES_APPROVAL"
  | "IN_FLIGHT";

export type WorkerPortraitUploadPolicy =
  | { allow: true }
  | { allow: false; reason: WorkerPortraitUploadPolicyReason };

export const PORTRAIT_HIDDEN_MESSAGE = "Ảnh NLĐ được ẩn theo quyền truy cập.";
export const PORTRAIT_REPLACEMENT_REQUIRES_APPROVAL_MESSAGE =
  "Ảnh NLĐ hiện hành chỉ được thay thế sau khi ảnh mới được duyệt. Luồng duyệt ảnh thay thế " +
  "chưa khả dụng — đang chờ API duyệt; không thể tải ảnh thay thế ở đây.";
export const PORTRAIT_IN_FLIGHT_MESSAGE =
  "Ảnh đã gửi đang được xử lý. Chờ kết quả trước khi gửi ảnh khác.";

export function workerPortraitUploadPolicy(
  portrait: WorkerPortraitProjection | null,
): WorkerPortraitUploadPolicy {
  if (portrait === null) return { allow: false, reason: "HIDDEN" };
  if (portrait.current !== null) return { allow: false, reason: "REPLACEMENT_REQUIRES_APPROVAL" };
  if ((WORKER_PORTRAIT_IN_FLIGHT_STATUSES as readonly string[]).includes(portrait.status)) {
    return { allow: false, reason: "IN_FLIGHT" };
  }
  return { allow: true };
}

export function workerPortraitUploadPolicyMessage(
  reason: WorkerPortraitUploadPolicyReason,
): string {
  if (reason === "HIDDEN") return PORTRAIT_HIDDEN_MESSAGE;
  if (reason === "IN_FLIGHT") return PORTRAIT_IN_FLIGHT_MESSAGE;
  return PORTRAIT_REPLACEMENT_REQUIRES_APPROVAL_MESSAGE;
}

export const WORKER_PORTRAIT_MAX_BYTES = 10 * 1024 * 1024;
export const WORKER_PORTRAIT_MIME_TYPES = ["image/jpeg", "image/png"] as const;

export type WorkerPortraitFileCheck =
  | { ok: true; mimeType: "image/jpeg" | "image/png" }
  | { ok: false; code: "DOCUMENT_FILE_REQUIRED" | "DOCUMENT_SIZE_INVALID" | "DOCUMENT_MIME_INVALID" };

/**
 * Kiem tra tep truoc khi gui: file rong, vuot dung luong hoac sai MIME deu bi tu choi tai client
 * (server van la authority cuoi). Dung lai trong ca buoc chon tep lan trong ham upload.
 */
export function checkWorkerPortraitFile(
  file: { size: number; type: string } | null | undefined,
): WorkerPortraitFileCheck {
  if (!file) return { ok: false, code: "DOCUMENT_FILE_REQUIRED" };
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > WORKER_PORTRAIT_MAX_BYTES) {
    return { ok: false, code: "DOCUMENT_SIZE_INVALID" };
  }
  if (!(WORKER_PORTRAIT_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, code: "DOCUMENT_MIME_INVALID" };
  }
  return { ok: true, mimeType: file.type as "image/jpeg" | "image/png" };
}

/** Trang thai chi co o tai lieu (khong co o portrait); vong doi dung chung o tren. */
const DOCUMENT_ONLY_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  MISSING: "Chưa có hồ sơ",
  PENDING: "Chờ kiểm tra",
  CLEAN: "Đã kiểm tra",
  NOT_REQUIRED: "Không yêu cầu quét",
  VALIDATED: "Đã kiểm tra định dạng",
  REJECTED: "Bị từ chối",
});

export function workerDocumentStatusLabel(status: string): string {
  return DOCUMENT_ONLY_STATUS_LABELS[status] ??
    (WORKER_PORTRAIT_STATUS_LABELS as Readonly<Record<string, string>>)[status] ??
    "Không xác định";
}

export function workerDocumentReady(document: WorkerDetailDocument): boolean {
  return document.upload_status === "READY" &&
    document.validation_status === "VALIDATED" &&
    (document.scan_status === "CLEAN" || document.scan_status === "NOT_REQUIRED");
}

/** Private same-origin preview route; khong phai storage key hay signed URL. */
export function workerPortraitPreviewUrl(entryId: string, documentId: string): string {
  return "/api/direct-entry/entries/" + encodeURIComponent(entryId) +
    "/documents/" + encodeURIComponent(documentId) + "/preview";
}

/**
 * Route preview RIENG cho CCCD (migration #114). Khac portrait: chi nhan CCCD
 * READY + VALIDATED + CLEAN/NOT_REQUIRED, dung `document_view` + purpose `cccd_preview`,
 * KHONG co fallback `entry_privileged_edit`. Khong bao gio dung portrait preview cho CCCD.
 */
export function workerCccdPreviewUrl(entryId: string, documentId: string): string {
  return "/api/direct-entry/entries/" + encodeURIComponent(entryId) +
    "/documents/" + encodeURIComponent(documentId) + "/cccd-preview";
}

/** Chi hien khung anh khi server coi tai lieu la san sang va la anh (JPEG/PNG). */
export function workerCccdPreviewable(document: WorkerDetailDocument): boolean {
  return workerDocumentReady(document) &&
    (document.mime_type === "image/jpeg" || document.mime_type === "image/png");
}

export function workerPortraitUploadUrl(entryId: string, documentId?: string): string {
  const base = "/api/direct-entry/entries/" + encodeURIComponent(entryId) + "/documents";
  return documentId === undefined ? base : base + "/" + encodeURIComponent(documentId) + "/finalize";
}
