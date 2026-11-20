export type BlobValidationOutcome =
  | { ok: true }
  | { ok: false; reason: "EMPTY_BLOB" | "UNEXPECTED_CONTENT_TYPE" | "CORRUPT_ARCHIVE" };

const ERROR_PAYLOAD_MIME_TYPES = new Set([
  "application/json",
  "application/problem+json",
  "text/plain",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
]);

function normalizeMimeType(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.toLowerCase().split(";")[0]?.trim() ?? "";
}

/**
 * Xác minh Blob tải về thực sự có dữ liệu sử dụng được trước khi kích hoạt tải file
 * và báo Toast thành công (UIUX-S2-06):
 * - Từ chối Blob rỗng (`size <= 0`) hoặc không hợp lệ.
 * - Từ chối payload JSON/HTML/text lỗi bị trả kèm HTTP 200 ngoài ý muốn (trừ khi MIME đó nằm trong `allowedMimeTypes`).
 */
export function validateDownloadableExportBlob(input: {
  blob: { size: number; type?: string } | null | undefined;
  contentTypeHeader?: string | null;
  allowedMimeTypes?: readonly string[];
}): BlobValidationOutcome {
  const { blob, contentTypeHeader, allowedMimeTypes } = input;
  if (!blob || typeof blob.size !== "number" || !Number.isFinite(blob.size) || blob.size <= 0) {
    return { ok: false, reason: "EMPTY_BLOB" };
  }

  const allowedSet = new Set(
    (allowedMimeTypes ?? []).map((mime) => normalizeMimeType(mime)).filter(Boolean),
  );
  const headerMime = normalizeMimeType(contentTypeHeader);
  const blobMime = normalizeMimeType(blob.type);
  const effectiveMime = headerMime || blobMime;

  if (effectiveMime && !allowedSet.has(effectiveMime)) {
    if (ERROR_PAYLOAD_MIME_TYPES.has(effectiveMime)) {
      return { ok: false, reason: "UNEXPECTED_CONTENT_TYPE" };
    }
    if (allowedSet.size > 0 && effectiveMime !== "application/octet-stream") {
      return { ok: false, reason: "UNEXPECTED_CONTENT_TYPE" };
    }
  }

  return { ok: true };
}

/**
 * Kiểm tra nội dung HTML báo cáo xuất ngoại tuyến thực sự hoàn chỉnh trước khi tạo Blob tải về.
 */
export function validateHtmlExportDocument(html: string | null | undefined): boolean {
  if (typeof html !== "string") return false;
  const trimmed = html.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  return lower.includes("<!doctype html>") && lower.includes("</html>");
}
