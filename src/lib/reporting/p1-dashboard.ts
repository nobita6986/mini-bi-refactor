import type { DimensionOptions, ReportingBucket, ReportingSourceStatus } from "./p1-reporting";

export interface TrendPoint {
  date: string;
  count: number;
}

export interface SourceOption {
  id: string;
  fileName: string;
}

/** Giới hạn zero-fill trend (ngày) để chống range bệnh lý từ URL. */
export const MAX_TREND_DAYS = 1096;

/**
 * Dựng daily trend zero-fill trong khoảng hiển thị.
 * - from/to có thì zero-fill cả khoảng (kể cả ngày trống).
 * - thiếu thì dùng extent của dữ liệu (không thêm 0 đầu/cuối).
 * - range quá dài (> MAX_TREND_DAYS) thì bỏ zero-fill, trả đúng các ngày có data.
 */
export function buildDailyTrend(
  byDate: Record<string, number>,
  from?: string,
  to?: string
): TrendPoint[] {
  const dates = Object.keys(byDate).sort();
  if (dates.length === 0 && !from && !to) return [];

  const minDate = from ?? dates[0] ?? null;
  const maxDate = to ?? dates[dates.length - 1] ?? null;
  if (!minDate || !maxDate) return dates.map((d) => ({ date: d, count: byDate[d] }));
  if (minDate > maxDate) return dates.map((d) => ({ date: d, count: byDate[d] }));

  const start = Date.parse(minDate + "T00:00:00.000Z");
  const end = Date.parse(maxDate + "T00:00:00.000Z");
  if (Number.isNaN(start) || Number.isNaN(end)) return dates.map((d) => ({ date: d, count: byDate[d] }));
  if ((end - start) / 86_400_000 > MAX_TREND_DAYS) {
    return dates.map((d) => ({ date: d, count: byDate[d] }));
  }

  const points: TrendPoint[] = [];
  let cur = start;
  while (cur <= end) {
    const date = new Date(cur).toISOString().slice(0, 10);
    points.push({ date, count: byDate[date] ?? 0 });
    cur += 86_400_000;
  }
  return points;
}

/** Sort bucket giảm dần theo recruitedCount; hòa thì ổn định theo display tiếng Việt. */
export function sortBuckets(buckets: Record<string, ReportingBucket>): ReportingBucket[] {
  return Object.values(buckets).sort((a, b) => {
    if (a.recruitedCount !== b.recruitedCount) return b.recruitedCount - a.recruitedCount;
    return a.display.localeCompare(b.display, "vi");
  });
}

/** Top N bucket (cho chart); full list vẫn dùng sortBuckets riêng để không mất dữ liệu. */
export function topBuckets(buckets: Record<string, ReportingBucket>, n: number): ReportingBucket[] {
  return sortBuckets(buckets).slice(0, n);
}

export const SOURCE_STATUS_LABELS: Record<ReportingSourceStatus, string> = {
  covered: "Đã đồng bộ",
  incomplete: "Chưa đầy đủ",
  stale_snapshot: "Đang dùng snapshot cũ",
  never_succeeded: "Chưa có snapshot thành công",
  running: "Đang đồng bộ",
  no_run: "Chưa chạy",
};

export function sourceStatusLabel(status: ReportingSourceStatus): string {
  return SOURCE_STATUS_LABELS[status];
}

export interface ReportingOptionsCatalog {
  dimensions: DimensionOptions;
  sources: SourceOption[];
}

/** Danh mục cố định provider/employment cho filter (bao gồm kênh trực tiếp và qua CTV). */
export const PROVIDER_OPTIONS = [
  { key: "hrp", display: "Tổng tuyển của NVTD" },
  { key: "hrp_direct", display: "HRP trực tiếp" },
  { key: "hrp_ctv", display: "Qua CTV" },
  { key: "vendor", display: "Vendor" },
  { key: "__unknown__", display: "Không xác định" },
  { key: "__invalid__", display: "Không hợp lệ" },
] as const;

export const EMPLOYMENT_OPTIONS = [
  { key: "thời vụ", display: "Thời vụ" },
  { key: "chính thức", display: "Chính thức" },
  { key: "__unknown__", display: "Không xác định" },
  { key: "__invalid__", display: "Không hợp lệ" },
] as const;

export const WORK_STATUS_OPTIONS = [
  { key: "ON", display: "Đang làm" },
  { key: "OFF", display: "Đã nghỉ" },
  { key: "UNCONFIRMED", display: "Đang chờ việc" },
] as const;

/** Source option hiển thị bằng file_name (không dùng full drive_file_id làm nhãn). */
export function buildSourceOptions(sources: { id: string; file_name: string }[]): SourceOption[] {
  return sources
    .map((s) => ({ id: s.id, fileName: s.file_name || s.id }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName, "vi"));
}
