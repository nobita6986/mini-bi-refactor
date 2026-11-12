"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";

import { AttendanceVerificationBadge } from "@/components/attendance/attendance-verification-badge";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
} from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { FloatingTableNav } from "@/components/ui/floating-table-nav";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { OffsetPager } from "@/components/ui/offset-pager";
import {
  ATTENDANCE_BUSINESS_TIMEZONE,
  ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE,
  formatCoordinatePair,
  formatDistanceMeters,
  getVietnamTodayIsoDate,
  newAttendanceHqIntentKey,
  resolveAttendanceEmployeeDisplayIdentity,
  shiftIsoDateDays,
} from "@/lib/attendance/attendance-report-contract";
import {
  ATTENDANCE_SLOT_MAX_COUNT,
  ATTENDANCE_SLOT_MIN_COUNT,
  DEFAULT_ATTENDANCE_SLOT_POLICY,
  DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID,
  projectAssignBranchResult,
  projectAssignSlotPolicyResult,
  projectAttendanceBranchesAdminList,
  projectAttendanceMonthlyMatrixReport,
  projectAttendanceSlotPoliciesAdminList,
  projectCreateSlotPolicyResult,
  projectUnassignBranchResult,
  projectUnassignSlotPolicyResult,
  projectUpsertBranchResult,
  projectUpsertSlotPolicyProfileResult,
  type AttendanceBranchAdminItemProjection,
  type AttendanceBranchAssignmentAdminItemProjection,
  type AttendanceBranchesAdminListProjection,
  type AttendanceMonthlyMatrixDayCellProjection,
  type AttendanceMonthlyMatrixEmployeeRowProjection,
  type AttendanceMonthlyMatrixReportProjection,
  type AttendanceSlotPoliciesAdminListProjection,
  type AttendanceSlotPolicyAssignmentAdminItemProjection,
  type AttendanceSlotPolicyProfileAdminItemProjection,
  type AttendanceSlotPolicyProjection,
} from "@/lib/attendance/attendance-monthly-matrix-contract";
import {
  MATRIX_LEGEND_ITEMS,
  MATRIX_SLOT_SHORT_LABELS,
  buildAssignEmployeeToBranchPayload,
  buildAssignEmployeeToSlotPolicyPayload,
  buildCreateSlotPolicyPayload,
  buildGoogleMapsCoordinatesUrl,
  buildMonthlyMatrixExportUrl,
  buildMonthlyMatrixReportQuery,
  buildUnassignEmployeeFromBranchPayload,
  buildUnassignEmployeeFromSlotPolicyPayload,
  buildUpsertBranchPayload,
  buildUpsertSlotPolicyProfilePayload,
  describeBranchAssignmentStatus,
  describeMatrixDayCell,
  describeSlotPolicyAssignmentStatus,
  formatEmployeeSlotPolicySummaryLabel,
  formatMatrixWeekdayLabel,
  getVietnamCurrentYearMonth,
  mapBranchAdminMutationError,
  mapMonthlyMatrixExportError,
  mapMonthlyMatrixReportError,
  mapSlotPolicyMutationError,
  validateMonthlyMatrixFilters,
  type MatrixEmployeeFilterMode,
} from "@/lib/attendance/attendance-monthly-matrix-ui-model";
import { attendanceMonthlyMatrixExportFilename } from "@/lib/attendance/attendance-monthly-matrix-xlsx";
import { cn } from "@/lib/utils";

const VI_INTEGER = new Intl.NumberFormat("vi-VN");
const VI_DECIMAL = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const INPUT_CLASS =
  "w-full min-h-11 sm:min-h-10 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring/30";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractErrorCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.code === "string" && payload.code.trim() !== "") {
    return payload.code.trim();
  }
  if (isRecord(payload.error) && typeof payload.error.code === "string") {
    return payload.error.code.trim();
  }
  return null;
}

type MatrixLoadState =
  | { kind: "loading" }
  | { kind: "ready"; report: AttendanceMonthlyMatrixReportProjection }
  | { kind: "denied"; detail: string }
  | { kind: "error"; detail: string };

type MatrixAppliedFilters = {
  yearMonth: string;
  branchId: string;
  filterMode: MatrixEmployeeFilterMode;
  employeeId: string;
  search: string;
  page: number;
};

function MatrixDayCell({ cell }: { cell: AttendanceMonthlyMatrixDayCellProjection }) {
  const presentation = describeMatrixDayCell(cell);

  const cellToneClass =
    presentation.tone === "red"
      ? "border-red-300/80 bg-red-50/90 text-red-950 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-100"
      : presentation.tone === "amber"
        ? "border-amber-300/80 bg-amber-50/85 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/35 dark:text-amber-100"
        : "border-emerald-300/80 bg-emerald-50/80 text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-100";

  return (
    <div
      className={cn(
        "flex min-h-[10.5rem] w-56 flex-col justify-between gap-1.5 rounded-lg border p-2 text-xs",
        cellToneClass,
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <span
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold",
            presentation.tone === "red"
              ? "bg-red-200/80 text-red-950 dark:bg-red-900/70 dark:text-red-100"
              : presentation.tone === "amber"
                ? "bg-amber-200/80 text-amber-950 dark:bg-amber-900/70 dark:text-amber-100"
                : "bg-emerald-200/80 text-emerald-950 dark:bg-emerald-900/70 dark:text-emerald-100",
          )}
        >
          {presentation.statusLabel}
        </span>
        <div className="flex items-center gap-1">
          <span
            title={`Áp dụng khung giờ ${presentation.policyProfileNameUsed} phiên bản v${presentation.policyVersionUsed}`}
            className="rounded border border-current/20 px-1 py-0.5 font-mono text-[10px] opacity-80"
          >
            KG {presentation.policyProfileNameUsed} v{presentation.policyVersionUsed}
          </span>
          {presentation.targetBadgeLabel ? (
            <span className="rounded border border-current/25 px-1 py-0.5 font-mono text-[10px] font-medium">
              {presentation.targetBadgeLabel}
            </span>
          ) : null}
        </div>
      </div>

      {/* Daily Slots (Dynamic 1..12 slots from effective policy) */}
      <div className="space-y-1">
        {presentation.slots.map((slot) => {
          const slotRowClass =
            slot.tone === "emerald"
              ? "border-emerald-300/80 bg-white/80 text-emerald-950 dark:border-emerald-800/60 dark:bg-emerald-950/50 dark:text-emerald-100"
              : slot.tone === "amber"
                ? "border-amber-400/90 bg-amber-100/85 text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/60 dark:text-amber-100"
                : slot.tone === "sky"
                  ? "border-sky-300/90 bg-sky-50/90 text-sky-950 dark:border-sky-800/60 dark:bg-sky-950/50 dark:text-sky-100"
                  : "border-red-300/90 bg-red-100/85 text-red-950 dark:border-red-800/70 dark:bg-red-950/55 dark:text-red-100";

          return (
            <div
              key={slot.slotCode}
              className={cn(
                "rounded border px-1.5 py-1 text-[11px] leading-tight",
                slotRowClass,
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="font-semibold">
                  {slot.slotShortLabel}{" "}
                  <span className="font-mono font-normal opacity-80">
                    ({slot.targetTime})
                  </span>
                </span>
                <div className="flex flex-wrap items-center gap-1">
                  {slot.slotStatus === "EXPLAINED_APPROVED" ? (
                    <span className="rounded bg-emerald-200/90 px-1 py-0.5 text-[10px] font-bold text-emerald-950 dark:bg-emerald-900/80 dark:text-emerald-100">
                      Giải trình được duyệt
                    </span>
                  ) : slot.slotStatus === "MISSING" ? (
                    <span className="rounded bg-red-200/90 px-1 py-0.5 text-[10px] font-bold text-red-950 dark:bg-red-900/80 dark:text-red-100">
                      Chưa có lượt chấm
                    </span>
                  ) : slot.slotStatus === "LEAVE_COVERED" && slot.checkins.length === 0 ? (
                    <span className="rounded bg-sky-200/80 px-1 py-0.5 text-[10px] font-semibold text-sky-950 dark:bg-sky-900/70 dark:text-sky-100">
                      {slot.statusLabel}
                    </span>
                  ) : null}

                  {slot.slotStatus !== "EXPLAINED_APPROVED" &&
                  slot.explanationStatusLabel ? (
                    <span
                      className={cn(
                        "rounded px-1 py-0.5 text-[10px] font-bold",
                        slot.explanationBadgeTone === "red"
                          ? "bg-red-300/95 text-red-950 dark:bg-red-900/90 dark:text-red-100"
                          : slot.explanationBadgeTone === "amber"
                            ? "bg-amber-300/95 text-amber-950 dark:bg-amber-900/90 dark:text-amber-100"
                            : "bg-emerald-200/90 text-emerald-950 dark:bg-emerald-900/80 dark:text-emerald-100",
                      )}
                    >
                      {slot.explanationStatusLabel}
                    </span>
                  ) : null}
                </div>
              </div>

              {slot.checkins.length > 0 ? (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {slot.checkins.map((c) => (
                    <span
                      key={c.checkinId}
                      className="inline-flex items-center gap-1 rounded bg-black/5 px-1 py-0.5 font-mono text-[11px] font-semibold tabular-nums dark:bg-white/10"
                    >
                      <span>{c.timeLocal}</span>
                      {c.deviationBadgeLabel ? (
                        <span className="rounded bg-amber-300/90 px-1 py-0.2 text-[10px] font-sans font-bold text-amber-950 dark:bg-amber-800 dark:text-amber-100">
                          {c.deviationBadgeLabel}
                        </span>
                      ) : null}
                    </span>
                  ))}
                </div>
              ) : null}

              {slot.explanation?.reason ? (
                <p
                  title={slot.explanation.reason}
                  className="mt-1 truncate text-[10px] opacity-85"
                >
                  Lý do: {slot.explanation.reason}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {presentation.hasCheckin ? (
        <div className="flex items-center justify-between gap-1.5 border-t border-current/15 pt-1">
          {presentation.verification ? (
            <AttendanceVerificationBadge indicator={presentation.verification} />
          ) : null}
          {presentation.distanceLabel ? (
            <p className="font-mono text-[11px] font-medium opacity-90">
              {presentation.distanceLabel}
            </p>
          ) : null}
        </div>
      ) : null}

      {presentation.hasApprovedLeave ? (
        <div className="space-y-1 border-t border-current/15 pt-1">
          {presentation.leaveBadges.length > 0 ? (
            presentation.leaveBadges.map((leave) => (
              <div
                key={leave.requestId}
                className="rounded bg-white/75 px-1.5 py-0.5 text-[11px] font-semibold text-red-900 shadow-2xs dark:bg-black/30 dark:text-red-100"
              >
                Nghỉ phép: {leave.leaveTypeLabel} · Buổi: {leave.sessionLabel}
              </div>
            ))
          ) : (
            <div className="rounded bg-white/75 px-1.5 py-0.5 text-[11px] font-semibold text-red-900 dark:bg-black/30 dark:text-red-100">
              Nghỉ phép ({VI_DECIMAL.format(presentation.approvedLeaveUnits)} công)
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MatrixEmployeeStickySummary({
  row,
}: {
  row: AttendanceMonthlyMatrixEmployeeRowProjection;
}) {
  const lateOrEarlyCheckinCount = row.days.reduce(
    (sum, day) => sum + day.late_or_early_checkin_count,
    0,
  );
  const missingSlotCount = row.days.reduce(
    (sum, day) => sum + day.missing_slot_count,
    0,
  );
  const employeeIdentity = resolveAttendanceEmployeeDisplayIdentity({
    displayName: row.employee_display_name,
    personnelCode: row.personnel_code,
  });

  return (
    <div className="w-64 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-foreground">
          {employeeIdentity.displayName}
        </span>
        {!row.enabled ? (
          <StatusBadge tone="neutral">Ngừng kích hoạt</StatusBadge>
        ) : null}
      </div>
      <p className="font-mono text-xs text-muted">
        {employeeIdentity.personnelCode
          ? `Mã NS: ${employeeIdentity.personnelCode}`
          : "Chưa liên kết mã NS"}
      </p>
      <div className="text-xs text-muted">
        {row.branch ? (
          <span>
            Chi nhánh:{" "}
            <strong className="font-medium text-foreground">
              {row.branch.branch_code} — {row.branch.display_name}
            </strong>
          </span>
        ) : (
          <span>Đích tính khoảng cách: Trụ sở (HQ)</span>
        )}
      </div>
      <div className="text-xs text-muted">
        Khung giờ:{" "}
        <strong className="font-medium text-foreground">
          {formatEmployeeSlotPolicySummaryLabel(row)}
        </strong>
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1 text-[11px]">
        <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
          Check-in: {VI_INTEGER.format(row.summary.checkin_day_count)} ngày (
          {VI_INTEGER.format(row.summary.total_checkins)} lượt)
        </span>
        <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
          Lệch ngưỡng: {VI_INTEGER.format(lateOrEarlyCheckinCount)} lượt
        </span>
        <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-900 dark:bg-red-950/60 dark:text-red-200">
          Nghỉ phép: {VI_INTEGER.format(row.summary.approved_leave_day_count)} ngày (
          {VI_DECIMAL.format(row.summary.approved_leave_units)} công)
        </span>
        <span className="rounded bg-red-50 px-1.5 py-0.5 font-medium text-red-800 dark:bg-red-950/40 dark:text-red-200">
          Mốc chưa chấm: {VI_INTEGER.format(missingSlotCount)} mốc (
          {VI_INTEGER.format(row.summary.no_checkin_day_count)} ngày)
        </span>
      </div>
      <p className="text-[11px] text-muted">
        Khoảng cách tính được: {VI_INTEGER.format(row.summary.distance_computed_count)} lượt
        {row.summary.min_distance_meters !== null &&
        row.summary.max_distance_meters !== null
          ? ` (${formatDistanceMeters(row.summary.min_distance_meters)} – ${formatDistanceMeters(row.summary.max_distance_meters)})`
          : ""}
      </p>
    </div>
  );
}

type SlotPolicyDialogMode =
  | { kind: "closed" }
  | { kind: "history" }
  | { kind: "create" }
  | { kind: "assignments" };

type SlotDraftItem = {
  id: string;
  slotLabel: string;
  targetTime: string;
  graceBeforeInput: string;
  graceAfterInput: string;
};

function createSlotDraftsFromPolicy(
  policy: Pick<AttendanceSlotPolicyProjection, "version" | "slots">,
): SlotDraftItem[] {
  return policy.slots.map((slot, index) => ({
    id: `v${policy.version}-slot-${index + 1}-${slot.target_time}`,
    slotLabel: slot.slot_label || `Time ${index + 1}`,
    targetTime: slot.target_time,
    graceBeforeInput: String(slot.grace_before_minutes),
    graceAfterInput: String(slot.grace_after_minutes),
  }));
}

function suggestNextSlotTargetTime(existingSlots: readonly SlotDraftItem[]): string {
  const last = existingSlots[existingSlots.length - 1];
  if (!last || !/^([01]\d|2[0-3]):[0-5]\d$/.test(last.targetTime)) {
    return "17:30";
  }
  const [hh, mm] = last.targetTime.split(":").map((part) => Number(part));
  const totalMinutes = (hh ?? 0) * 60 + (mm ?? 0);
  const nextMinutes = Math.min(23 * 60 + 59, totalMinutes + 60);
  const nextHh = String(Math.floor(nextMinutes / 60)).padStart(2, "0");
  const nextMm = String(nextMinutes % 60).padStart(2, "0");
  return `${nextHh}:${nextMm}`;
}

export function AttendanceSlotPolicySummaryCard({
  activeReport = null,
  canManageSlotPolicyFallback,
  onPolicyCreated,
}: {
  activeReport?: AttendanceMonthlyMatrixReportProjection | null;
  canManageSlotPolicyFallback?: boolean;
  onPolicyCreated?: () => void;
}) {
  const router = useRouter();
  const notify = useNotify();

  const [dialogMode, setDialogMode] = useState<SlotPolicyDialogMode>({ kind: "closed" });
  const [policiesData, setPoliciesData] =
    useState<AttendanceSlotPoliciesAdminListProjection | null>(null);
  const [loadingPolicies, setLoadingPolicies] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID,
  );
  const [createTargetMode, setCreateTargetMode] = useState<"existing" | "new">(
    "existing",
  );
  const [profileCodeInput, setProfileCodeInput] = useState("");
  const [profileNameInput, setProfileNameInput] = useState("");
  const [profileDescInput, setProfileDescInput] = useState("");
  const [profileActiveInput, setProfileActiveInput] = useState(true);

  const [effectiveFromInput, setEffectiveFromInput] = useState("");
  const [slotsInput, setSlotsInput] = useState<SlotDraftItem[]>(() =>
    createSlotDraftsFromPolicy(DEFAULT_ATTENDANCE_SLOT_POLICY),
  );
  const [assignEmployeeIdInput, setAssignEmployeeIdInput] = useState("");
  const [assignProfileIdInput, setAssignProfileIdInput] = useState("");
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const canManageSlotPolicy =
    activeReport?.viewer.can_manage_slot_policy === true ||
    policiesData?.viewer.can_manage_slot_policy === true ||
    canManageSlotPolicyFallback === true;

  const availableProfiles: AttendanceSlotPolicyProfileAdminItemProjection[] = useMemo(() => {
    if (policiesData?.profiles && policiesData.profiles.length > 0) {
      return policiesData.profiles;
    }
    return (activeReport?.slot_policy.profiles ?? []).map((p) => ({
      profile_id: p.profile_id,
      profile_code: p.profile_code,
      display_name: p.display_name,
      description: p.description,
      is_default: p.is_default,
      active: p.active,
      version: p.version,
      active_assignment_count: 0,
      current_policy: p.current_policy,
      latest_policy: p.latest_policy,
      versions: p.month_policies,
    }));
  }, [activeReport?.slot_policy.profiles, policiesData]);

  const assignableProfiles = useMemo(
    () => availableProfiles.filter((prof) => prof.active && !prof.is_default),
    [availableProfiles],
  );

  const selectedProfile = useMemo(
    () =>
      availableProfiles.find((p) => p.profile_id === selectedProfileId) ??
      availableProfiles[0] ??
      null,
    [availableProfiles, selectedProfileId],
  );

  const populateFormFromPolicy = useCallback(
    (
      seedPolicy: AttendanceSlotPolicyProjection,
      businessDate: string,
      profile?: AttendanceSlotPolicyProfileAdminItemProjection | null,
    ) => {
      const defaultDate =
        seedPolicy.effective_from_date >= businessDate
          ? shiftIsoDateDays(seedPolicy.effective_from_date, 1)
          : businessDate;
      setEffectiveFromInput(defaultDate);
      setSlotsInput(createSlotDraftsFromPolicy(seedPolicy));
      if (profile) {
        setProfileCodeInput(profile.profile_code);
        setProfileNameInput(profile.display_name);
        setProfileDescInput(profile.description ?? "");
        setProfileActiveInput(profile.active);
      }
    },
    [],
  );

  function handleUpdateSlotDraft(
    index: number,
    patch: Partial<Omit<SlotDraftItem, "id">>,
  ) {
    setSlotsInput((current) =>
      current.map((item, idx) => (idx === index ? { ...item, ...patch } : item)),
    );
  }

  function handleAddSlotDraft() {
    setSlotsInput((current) => {
      if (current.length >= ATTENDANCE_SLOT_MAX_COUNT) {
        return current;
      }
      const nextIndex = current.length + 1;
      return [
        ...current,
        {
          id: `draft-slot-${Date.now()}-${nextIndex}`,
          slotLabel: `Time ${nextIndex}`,
          targetTime: suggestNextSlotTargetTime(current),
          graceBeforeInput: "15",
          graceAfterInput: "15",
        },
      ];
    });
  }

  function handleRemoveSlotDraft(index: number) {
    setSlotsInput((current) => {
      if (current.length <= ATTENDANCE_SLOT_MIN_COUNT) {
        return current;
      }
      return current.filter((_, idx) => idx !== index);
    });
  }

  function handleMoveSlotDraft(index: number, direction: -1 | 1) {
    setSlotsInput((current) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (!moved) return current;
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function handleSortSlotsByTime() {
    setSlotsInput((current) =>
      [...current].sort((a, b) => a.targetTime.localeCompare(b.targetTime)),
    );
  }

  function handleResetDefaultFiveSlots() {
    setSlotsInput(createSlotDraftsFromPolicy(DEFAULT_ATTENDANCE_SLOT_POLICY));
  }

  const fetchSlotPolicies = useCallback(
    async (openModeAfterLoad?: "history" | "create" | "assignments") => {
      setLoadingPolicies(true);
      setLoadError(null);
      try {
        const response = await fetch("/api/admin/attendance/slot-policies", {
          method: "GET",
          cache: "no-store",
        });
        if (response.status === 401) {
          setLoadingPolicies(false);
          router.replace("/login?next=/admin/attendance");
          return;
        }
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (!response.ok || !isRecord(payload) || payload.ok !== true) {
          setLoadError("Không tải được lịch sử cấu hình khung giờ chấm công.");
          setLoadingPolicies(false);
          return;
        }
        const projected = projectAttendanceSlotPoliciesAdminList(payload);
        if (!projected) {
          setLoadError("Dữ liệu cấu hình khung giờ chấm công không đúng định dạng chuẩn.");
          setLoadingPolicies(false);
          return;
        }
        setPoliciesData(projected);
        setLoadingPolicies(false);
        if (openModeAfterLoad === "create") {
          const targetProf =
            (projected.profiles ?? []).find((p) => p.profile_id === selectedProfileId) ??
            projected.profiles?.[0] ??
            null;
          populateFormFromPolicy(
            targetProf?.latest_policy ?? projected.latest_policy,
            projected.business_date,
            targetProf,
          );
        } else if (openModeAfterLoad === "assignments") {
          const nonDefaultActive = (projected.profiles ?? []).filter(
            (p) => !p.is_default && p.active,
          );
          const preferredProfileId =
            nonDefaultActive.find((p) => p.profile_id === selectedProfileId)
              ?.profile_id ??
            nonDefaultActive[0]?.profile_id ??
            "";
          setAssignProfileIdInput((current) =>
            current && nonDefaultActive.some((p) => p.profile_id === current)
              ? current
              : preferredProfileId,
          );
        }
      } catch {
        setLoadError("Không thể kết nối máy chủ để tải cấu hình khung giờ chấm công.");
        setLoadingPolicies(false);
      }
    },
    [populateFormFromPolicy, router, selectedProfileId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/admin/attendance/slot-policies", {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          router.replace("/login?next=/admin/attendance");
          return;
        }
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (controller.signal.aborted) return;
        if (!response.ok || !isRecord(payload) || payload.ok !== true) {
          setLoadError("Không tải được lịch sử cấu hình khung giờ chấm công.");
          return;
        }
        const projected = projectAttendanceSlotPoliciesAdminList(payload);
        if (!projected) {
          setLoadError("Dữ liệu cấu hình khung giờ chấm công không đúng định dạng chuẩn.");
          return;
        }
        setPoliciesData(projected);
      } catch (err) {
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        setLoadError("Không thể kết nối máy chủ để tải cấu hình khung giờ chấm công.");
      }
    })();
    return () => {
      controller.abort();
    };
  }, [router]);

  function openHistoryDialog() {
    setMutationError(null);
    setDialogMode({ kind: "history" });
    void fetchSlotPolicies("history");
  }

  function openAssignmentsDialog() {
    setMutationError(null);
    setAssignProfileIdInput((current) =>
      current && assignableProfiles.some((p) => p.profile_id === current)
        ? current
        : assignableProfiles.find((p) => p.profile_id === selectedProfileId)
            ?.profile_id ??
            assignableProfiles[0]?.profile_id ??
            "",
    );
    setDialogMode({ kind: "assignments" });
    void fetchSlotPolicies("assignments");
  }

  function openCreateDialog(initialMode: "existing" | "new" = "existing") {
    setMutationError(null);
    setCreateTargetMode(initialMode);
    const todayVn = policiesData?.business_date ?? getVietnamTodayIsoDate();
    if (initialMode === "new") {
      setProfileCodeInput("");
      setProfileNameInput("");
      setProfileDescInput("");
      setProfileActiveInput(true);
      setEffectiveFromInput(todayVn);
      setSlotsInput([
        {
          id: "new-slot-1",
          slotLabel: "Time 1",
          targetTime: "08:00",
          graceBeforeInput: "15",
          graceAfterInput: "15",
        },
        {
          id: "new-slot-2",
          slotLabel: "Time 2",
          targetTime: "17:00",
          graceBeforeInput: "15",
          graceAfterInput: "15",
        },
      ]);
    } else {
      const seed =
        selectedProfile?.latest_policy ??
        policiesData?.latest_policy ??
        activeReport?.slot_policy.current_policy ??
        null;
      if (seed) {
        populateFormFromPolicy(seed, todayVn, selectedProfile);
      }
    }
    setDialogMode({ kind: "create" });
    if (initialMode === "existing") {
      void fetchSlotPolicies("create");
    } else {
      void fetchSlotPolicies();
    }
  }

  function closeDialog() {
    if (mutationBusy) return;
    setDialogMode({ kind: "closed" });
    setMutationError(null);
  }

  async function handleSaveSlotPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBusy || !canManageSlotPolicy) return;

    const idempotencyKey = newAttendanceHqIntentKey();
    const mappedSlots = slotsInput.map((item) => ({
      slotLabel: item.slotLabel,
      targetTime: item.targetTime,
      graceBeforeInput: item.graceBeforeInput,
      graceAfterInput: item.graceAfterInput,
    }));

    let built;
    if (createTargetMode === "new") {
      built = buildUpsertSlotPolicyProfilePayload({
        profileId: null,
        profileCode: profileCodeInput,
        displayName: profileNameInput,
        description: profileDescInput,
        active: true,
        expectedProfileVersion: 0,
        effectiveFromDate: effectiveFromInput,
        slots: mappedSlots,
        expectedVersion: 0,
        idempotencyKey,
      });
    } else if (selectedProfile) {
      built = buildUpsertSlotPolicyProfilePayload({
        profileId: selectedProfile.profile_id,
        profileCode: selectedProfile.profile_code,
        displayName:
          selectedProfile.is_default
            ? selectedProfile.display_name
            : profileNameInput || selectedProfile.display_name,
        description: selectedProfile.is_default
          ? (selectedProfile.description ?? "")
          : profileDescInput,
        active: selectedProfile.is_default ? true : profileActiveInput,
        expectedProfileVersion: selectedProfile.version,
        effectiveFromDate: effectiveFromInput,
        slots: mappedSlots,
        expectedVersion: selectedProfile.latest_policy.version,
        idempotencyKey,
      });
    } else {
      const latestVersion =
        policiesData?.latest_policy.version ??
        activeReport?.slot_policy.current_policy.version ??
        1;
      built = buildCreateSlotPolicyPayload({
        effectiveFromDate: effectiveFromInput,
        slots: mappedSlots,
        expectedVersion: latestVersion,
        idempotencyKey,
      });
    }

    if (!built.ok) {
      setMutationError(built.message);
      return;
    }

    setMutationBusy(true);
    setMutationError(null);

    try {
      const response = await fetch("/api/admin/attendance/slot-policies", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(built.body),
      });

      if (response.status === 401) {
        setMutationBusy(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapSlotPolicyMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setMutationError(mapped.message);
        if (mapped.isConflict) {
          void fetchSlotPolicies();
        }
        setMutationBusy(false);
        return;
      }

      const projected =
        projectUpsertSlotPolicyProfileResult(payload) ??
        projectCreateSlotPolicyResult({
          replayed: payload.replayed,
          policy: payload.policy,
          ...(payload.profile ? { profile: payload.profile } : {}),
        });
      if (!projected || !projected.policy) {
        setMutationError("Phản hồi lưu khung giờ chấm công không đúng định dạng chuẩn.");
        setMutationBusy(false);
        return;
      }

      setMutationBusy(false);
      const createdProfileId =
        projected.profile?.profile_id ?? projected.policy.profile_id;
      if (typeof createdProfileId === "string" && createdProfileId.length > 0) {
        setSelectedProfileId(createdProfileId);
        if (
          (projected.profile &&
            !projected.profile.is_default &&
            projected.profile.active) ||
          projected.policy.is_default === false
        ) {
          setAssignProfileIdInput(createdProfileId);
        }
      }
      setDialogMode({ kind: "closed" });
      notify.success({
        title: `Đã lưu cấu hình ${projected.policy.profile_name || "Mặc định"} v${projected.policy.version}`,
        description: `Hiệu lực từ ngày ${projected.policy.effective_from_date} (${projected.policy.slots.map((s) => s.target_time).join(" · ")})`,
      });
      void fetchSlotPolicies();
      onPolicyCreated?.();
    } catch {
      setMutationBusy(false);
      setMutationError("Không thể kết nối máy chủ khi lưu khung giờ chấm công.");
    }
  }

  async function handleAssignEmployeeToProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBusy || !canManageSlotPolicy) return;

    const targetProf =
      availableProfiles.find((p) => p.profile_id === assignProfileIdInput) ?? null;
    const targetEmpOption =
      (policiesData?.employee_options ?? []).find(
        (e) => e.app_user_id === assignEmployeeIdInput,
      ) ?? null;
    const openAssignment =
      (policiesData?.assignments ?? []).find(
        (a) =>
          a.app_user_id === assignEmployeeIdInput &&
          a.valid_to === null &&
          !a.superseded_same_day,
      ) ?? null;
    const expectedAssignmentVersion =
      targetEmpOption?.current_assignment_version ?? openAssignment?.version ?? 0;
    const idempotencyKey = newAttendanceHqIntentKey();
    const built = buildAssignEmployeeToSlotPolicyPayload({
      appUserId: assignEmployeeIdInput,
      profile: targetProf,
      expectedVersion: expectedAssignmentVersion,
      idempotencyKey,
      todayVn: policiesData?.business_date,
    });
    if (!built.ok) {
      setMutationError(built.message);
      return;
    }

    setMutationBusy(true);
    setMutationError(null);
    try {
      const response = await fetch("/api/admin/attendance/slot-policies/assignments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(built.body),
      });
      if (response.status === 401) {
        setMutationBusy(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapSlotPolicyMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setMutationError(mapped.message);
        if (mapped.isConflict) {
          void fetchSlotPolicies("assignments");
        }
        setMutationBusy(false);
        return;
      }
      const projected = projectAssignSlotPolicyResult(payload);
      if (!projected) {
        setMutationError("Phản hồi gán cấu hình khung giờ không đúng định dạng chuẩn.");
        setMutationBusy(false);
        return;
      }
      setMutationBusy(false);
      setAssignEmployeeIdInput("");
      notify.success({
        title: "Đã cập nhật cấu hình khung giờ cho nhân viên",
        description: `${projected.assignment.employee_display_name} → ${projected.assignment.profile_name} (từ ${projected.assignment.valid_from})`,
      });
      void fetchSlotPolicies("assignments");
      onPolicyCreated?.();
    } catch {
      setMutationBusy(false);
      setMutationError("Không thể kết nối máy chủ khi gán cấu hình khung giờ.");
    }
  }

  async function handleUnassignEmployeeFromProfile(
    assignment: AttendanceSlotPolicyAssignmentAdminItemProjection,
  ) {
    if (mutationBusy || !canManageSlotPolicy) return;
    const idempotencyKey = newAttendanceHqIntentKey();
    const built = buildUnassignEmployeeFromSlotPolicyPayload({
      expectedVersion: assignment.version,
      idempotencyKey,
      todayVn: policiesData?.business_date,
    });
    if (!built.ok) {
      setMutationError(built.message);
      return;
    }
    setMutationBusy(true);
    setMutationError(null);
    try {
      const response = await fetch(
        `/api/admin/attendance/slot-policies/assignments/${encodeURIComponent(assignment.assignment_id)}/unassign`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );
      if (response.status === 401) {
        setMutationBusy(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapSlotPolicyMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setMutationError(mapped.message);
        if (mapped.isConflict) {
          void fetchSlotPolicies("assignments");
        }
        setMutationBusy(false);
        return;
      }
      const projected = projectUnassignSlotPolicyResult(payload);
      if (!projected) {
        setMutationError("Phản hồi hủy gán cấu hình khung giờ không đúng định dạng chuẩn.");
        setMutationBusy(false);
        return;
      }
      setMutationBusy(false);
      notify.success({
        title: "Đã đưa nhân viên về cấu hình Mặc định",
        description: `${projected.assignment.employee_display_name} quay về cấu hình Mặc định từ hôm nay.`,
      });
      void fetchSlotPolicies("assignments");
      onPolicyCreated?.();
    } catch {
      setMutationBusy(false);
      setMutationError("Không thể kết nối máy chủ khi hủy gán cấu hình khung giờ.");
    }
  }

  const reportProfiles = activeReport?.slot_policy.profiles ?? [];
  const selectedReportProfile =
    reportProfiles.find((p) => p.profile_id === selectedProfileId) ??
    reportProfiles[0] ??
    null;
  const activeSummaryProfile = selectedProfile ?? selectedReportProfile ?? null;
  const currentPolicy =
    selectedProfile?.current_policy ??
    selectedReportProfile?.current_policy ??
    policiesData?.current_policy ??
    activeReport?.slot_policy.current_policy ??
    null;
  const monthPolicies =
    selectedReportProfile?.month_policies ??
    activeReport?.slot_policy.month_policies ??
    [];
  const profilePills =
    availableProfiles.length > 0
      ? availableProfiles.map((p) => ({
          profile_id: p.profile_id,
          profile_code: p.profile_code,
          display_name: p.display_name,
          is_default: p.is_default,
          slot_count: p.current_policy.slots.length,
          active_assignment_count: p.active_assignment_count,
        }))
      : reportProfiles.map((p) => ({
          profile_id: p.profile_id,
          profile_code: p.profile_code,
          display_name: p.display_name,
          is_default: p.is_default,
          slot_count: p.current_policy.slots.length,
          active_assignment_count: 0,
        }));
  const employeeOptionsForAssign =
    policiesData?.employee_options ?? activeReport?.employee_options ?? [];
  const historyVersions = useMemo(() => {
    if (policiesData?.profiles && policiesData.profiles.length > 0) {
      return policiesData.profiles.flatMap((prof) =>
        prof.versions.map((ver) => ({
          ...ver,
          profile_id: ver.profile_id ?? prof.profile_id,
          profile_code: ver.profile_code ?? prof.profile_code,
          profile_name: ver.profile_name ?? prof.display_name,
          is_default: ver.is_default ?? prof.is_default,
        })),
      );
    }
    return policiesData?.versions ?? [];
  }, [policiesData]);

  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <CardHeader
          title={`Cấu hình khung giờ chấm công (${currentPolicy ? `${currentPolicy.profile_name || "Mặc định"} · ${currentPolicy.slots.length} mốc` : "linh hoạt"})`}
          description="Quản trị đa cấu hình khung giờ chấm công theo tên (Mặc định, Hành chính, Tuyển dụng...) và gán nhân viên vào cấu hình phù hợp có hiệu lực tức thời mà vẫn bảo toàn nguyên vẹn lịch sử báo cáo."
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={openHistoryDialog}
          >
            Lịch sử phiên bản khung giờ
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={openAssignmentsDialog}
          >
            Phân công nhân viên
          </Button>
          {canManageSlotPolicy ? (
            <>
              <Button
                type="button"
                variant="soft"
                size="sm"
                onClick={() => openCreateDialog("existing")}
              >
                Cấu hình khung giờ mới
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => openCreateDialog("new")}
              >
                + Tạo cấu hình có tên
              </Button>
            </>
          ) : activeReport || policiesData ? (
            <StatusBadge tone="neutral">Chỉ xem (BoD)</StatusBadge>
          ) : null}
        </div>
      </div>

      {profilePills.length > 1 ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 border-b border-border/70 pb-3">
          <span className="mr-1 text-xs font-medium text-muted">Cấu hình đang xem:</span>
          {profilePills.map((prof) => {
            const isSelected = prof.profile_id === (activeSummaryProfile?.profile_id ?? selectedProfileId);
            return (
              <button
                key={prof.profile_id}
                type="button"
                onClick={() => setSelectedProfileId(prof.profile_id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                  isSelected
                    ? "border-accent bg-accent/10 text-foreground"
                    : "border-border bg-surface text-muted hover:text-foreground",
                )}
              >
                <span>{prof.display_name}</span>
                <span className="font-mono text-[11px] opacity-80">
                  ({prof.slot_count} mốc
                  {!prof.is_default ? ` · ${prof.active_assignment_count} NV` : ""})
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {currentPolicy ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {currentPolicy.slots.map((slot) => (
              <div
                key={slot.slot_code}
                className="rounded-xl border border-border bg-surface-muted/45 p-3 text-xs"
              >
                <p className="font-semibold text-foreground">
                  {slot.slot_label || MATRIX_SLOT_SHORT_LABELS[slot.slot_code]} (
                  {slot.session_code === "AM" ? "Ca sáng" : "Ca chiều"})
                </p>
                <p className="mt-1 font-mono text-lg font-bold tabular-nums text-foreground">
                  {slot.target_time}
                </p>
                <p className="mt-0.5 text-muted">
                  Ngưỡng cho phép:{" "}
                  <strong className="font-mono text-foreground">
                    -{slot.grace_before_minutes}p / +{slot.grace_after_minutes}p
                  </strong>
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>
              Phiên bản hiện hành:{" "}
              <strong className="font-mono text-foreground">
                v{currentPolicy.version}
              </strong>{" "}
              (hiệu lực từ{" "}
              <span className="font-mono text-foreground">
                {currentPolicy.effective_from_date}
              </span>
              {currentPolicy.effective_to_date
                ? ` đến ${currentPolicy.effective_to_date}`
                : ""}
              ) · Người cấu hình:{" "}
              <strong className="text-foreground">
                {currentPolicy.configured_by_display_name}
              </strong>
            </span>
            {monthPolicies.length > 0 ? (
              <span>
                Phiên bản áp dụng trong tháng đang xem:{" "}
                {monthPolicies.map((mp) => (
                  <span
                    key={mp.version}
                    className="ml-1 inline-flex items-center rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground"
                  >
                    v{mp.version} (từ {mp.effective_from_date}:{" "}
                    {mp.slots.map((s) => s.target_time).join("/")})
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">Đang tải thông tin khung giờ chấm công...</p>
      )}

      {/* Dialog: Slot Policy Version History */}
      <FormDialog
        open={dialogMode.kind === "history"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        title="Lịch sử phiên bản khung giờ chấm công"
        description="Mỗi ngày nghiệp vụ trong báo cáo ma trận tháng tự động áp dụng phiên bản khung giờ có hiệu lực tại ngày đó."
        closeAriaLabel="Đóng lịch sử khung giờ chấm công"
        contentClassName="sm:w-[min(56rem,calc(100vw-2rem))]"
      >
        <div className="space-y-4">
          {loadError ? (
            <Alert tone="error" role="alert" title="Không tải được lịch sử khung giờ">
              <p>{loadError}</p>
            </Alert>
          ) : null}

          {loadingPolicies && !policiesData ? (
            <p className="py-6 text-center text-sm text-muted">
              Đang tải lịch sử phiên bản khung giờ...
            </p>
          ) : policiesData ? (
            <DataTableContainer>
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Phiên bản &amp; Hiệu lực
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Các mốc Ca sáng (&lt; 12:00)
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Các mốc Ca chiều (&ge; 12:00)
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Audit cấu hình
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {historyVersions.map((p) => {
                    const amSlots = p.slots.filter((s) => s.session_code === "AM");
                    const pmSlots = p.slots.filter((s) => s.session_code === "PM");
                    return (
                      <tr key={`${p.profile_id ?? "default"}-${p.version}`} className={DATA_TABLE_ROW_CLASS}>
                        <td data-label="Phiên bản & Hiệu lực" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5 text-xs">
                            <p className="font-semibold text-foreground">
                              {p.profile_name || "Mặc định"}{" "}
                              <span className="font-mono text-muted">
                                ({p.profile_code || "DEFAULT"})
                              </span>
                            </p>
                            <p className="font-mono font-semibold text-foreground">
                              Phiên bản v{p.version} ({p.slots.length} mốc)
                            </p>
                            <p className="font-mono text-muted">
                              Từ: {p.effective_from_date}
                              {p.effective_to_date ? ` → ${p.effective_to_date}` : " → Nay"}
                            </p>
                          </div>
                        </td>
                        <td data-label="Các mốc Ca sáng (< 12:00)" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5 font-mono text-xs">
                            {amSlots.length > 0 ? (
                              amSlots.map((slot) => (
                                <p key={slot.slot_code}>
                                  {slot.slot_label || `Time ${slot.slot_index}`}:{" "}
                                  <strong>{slot.target_time}</strong> (-
                                  {slot.grace_before_minutes}p / +{slot.grace_after_minutes}p)
                                </p>
                              ))
                            ) : (
                              <p className="text-muted">—</p>
                            )}
                          </div>
                        </td>
                        <td data-label="Các mốc Ca chiều (>= 12:00)" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5 font-mono text-xs">
                            {pmSlots.length > 0 ? (
                              pmSlots.map((slot) => (
                                <p key={slot.slot_code}>
                                  {slot.slot_label || `Time ${slot.slot_index}`}:{" "}
                                  <strong>{slot.target_time}</strong> (-
                                  {slot.grace_before_minutes}p / +{slot.grace_after_minutes}p)
                                </p>
                              ))
                            ) : (
                              <p className="text-muted">—</p>
                            )}
                          </div>
                        </td>
                        <td data-label="Audit cấu hình" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5 text-xs">
                            <p className="font-medium text-foreground">
                              {p.configured_by_display_name}
                            </p>
                            <p className="font-mono text-muted">{p.configured_at_local}</p>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DataTableContainer>
          ) : null}

          <div className="flex justify-end gap-2">
            {canManageSlotPolicy ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => openCreateDialog("existing")}
              >
                Tạo phiên bản khung giờ mới
              </Button>
            ) : null}
            <Button type="button" variant="secondary" size="sm" onClick={closeDialog}>
              Đóng
            </Button>
          </div>
        </div>
      </FormDialog>

      {/* Dialog: Create / Update Slot Policy Profile & Date-Effective Version */}
      <FormDialog
        open={dialogMode.kind === "create"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        title={
          createTargetMode === "new"
            ? "Tạo cấu hình khung giờ chấm công mới (có tên riêng)"
            : "Tạo phiên bản khung giờ chấm công mới"
        }
        description="Phiên bản mới sẽ áp dụng từ ngày bắt đầu hiệu lực được chọn cho cấu hình đó và không ghi đè dữ liệu lịch sử của các ngày trước."
        closeAriaLabel="Đóng hộp thoại cấu hình khung giờ chấm công"
        contentClassName="sm:w-[min(48rem,calc(100vw-2rem))]"
      >
        <form onSubmit={handleSaveSlotPolicy} className="space-y-4">
          {mutationError ? (
            <Alert tone="error" role="alert" title="Không thể lưu khung giờ chấm công">
              <p>{mutationError}</p>
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-muted/40 p-2">
            <Button
              type="button"
              variant={createTargetMode === "existing" ? "primary" : "ghost"}
              size="sm"
              disabled={mutationBusy}
              onClick={() => {
                setCreateTargetMode("existing");
                const todayVn = policiesData?.business_date ?? getVietnamTodayIsoDate();
                const seed =
                  selectedProfile?.latest_policy ??
                  policiesData?.latest_policy ??
                  activeReport?.slot_policy.current_policy ??
                  null;
                if (seed) {
                  populateFormFromPolicy(seed, todayVn, selectedProfile);
                }
              }}
            >
              Tạo phiên bản mới cho cấu hình hiện có
            </Button>
            <Button
              type="button"
              variant={createTargetMode === "new" ? "primary" : "ghost"}
              size="sm"
              disabled={mutationBusy}
              onClick={() => {
                setCreateTargetMode("new");
                setProfileCodeInput("");
                setProfileNameInput("");
                setProfileDescInput("");
                setProfileActiveInput(true);
                setEffectiveFromInput(
                  policiesData?.business_date ?? getVietnamTodayIsoDate(),
                );
              }}
            >
              + Tạo cấu hình có tên mới
            </Button>
          </div>

          {createTargetMode === "existing" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="slot-policy-profile-select"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Cấu hình khung giờ cần tạo phiên bản mới
                </label>
                <select
                  id="slot-policy-profile-select"
                  value={selectedProfile?.profile_id ?? selectedProfileId}
                  disabled={mutationBusy}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    setSelectedProfileId(nextId);
                    const nextProf =
                      availableProfiles.find((p) => p.profile_id === nextId) ?? null;
                    if (nextProf) {
                      populateFormFromPolicy(
                        nextProf.latest_policy,
                        policiesData?.business_date ?? getVietnamTodayIsoDate(),
                        nextProf,
                      );
                    }
                  }}
                  className={INPUT_CLASS}
                >
                  {(availableProfiles.length > 0
                    ? availableProfiles
                    : [
                        {
                          profile_id: DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID,
                          profile_code: "DEFAULT",
                          display_name: "Mặc định",
                          is_default: true,
                        },
                      ]
                  ).map((prof) => (
                    <option key={prof.profile_id} value={prof.profile_id}>
                      {prof.display_name} ({prof.profile_code})
                    </option>
                  ))}
                </select>
              </div>
              {selectedProfile && !selectedProfile.is_default ? (
                <div>
                  <label
                    htmlFor="slot-policy-existing-name"
                    className="mb-1 block text-xs font-medium text-muted"
                  >
                    Tên hiển thị cấu hình
                  </label>
                  <input
                    id="slot-policy-existing-name"
                    type="text"
                    maxLength={128}
                    required
                    value={profileNameInput}
                    disabled={mutationBusy}
                    onChange={(event) => setProfileNameInput(event.target.value)}
                    className={INPUT_CLASS}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="slot-policy-new-code"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Mã cấu hình (VD: HANH_CHINH, TUYEN_DUNG)
                </label>
                <input
                  id="slot-policy-new-code"
                  type="text"
                  maxLength={64}
                  required
                  placeholder="HANH_CHINH"
                  value={profileCodeInput}
                  disabled={mutationBusy}
                  onChange={(event) =>
                    setProfileCodeInput(event.target.value.toUpperCase())
                  }
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label
                  htmlFor="slot-policy-new-name"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Tên cấu hình (VD: Hành chính 2 mốc)
                </label>
                <input
                  id="slot-policy-new-name"
                  type="text"
                  maxLength={128}
                  required
                  placeholder="Hành chính 2 mốc"
                  value={profileNameInput}
                  disabled={mutationBusy}
                  onChange={(event) => setProfileNameInput(event.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label
                  htmlFor="slot-policy-new-desc"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Mô tả ngắn (tùy chọn)
                </label>
                <input
                  id="slot-policy-new-desc"
                  type="text"
                  maxLength={500}
                  placeholder="Chấm công 2 lượt 08:00 & 17:00"
                  value={profileDescInput}
                  disabled={mutationBusy}
                  onChange={(event) => setProfileDescInput(event.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
          )}

          <div>
            <label
              htmlFor="slot-policy-effective-from"
              className="mb-1 block text-xs font-medium text-muted"
            >
              Ngày bắt đầu hiệu lực (YYYY-MM-DD, từ hôm nay và sau phiên bản mới nhất)
            </label>
            <input
              id="slot-policy-effective-from"
              type="date"
              required
              value={effectiveFromInput}
              disabled={mutationBusy}
              onChange={(event) => setEffectiveFromInput(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>

          <div className="space-y-3 rounded-xl border border-border bg-surface-muted/35 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                Danh sách mốc chấm công ({slotsInput.length}/{ATTENDANCE_SLOT_MAX_COUNT} mốc) &amp; ngưỡng dung sai (0–240 phút)
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={mutationBusy || slotsInput.length <= 1}
                  onClick={handleSortSlotsByTime}
                >
                  Sắp xếp theo giờ chuẩn
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={mutationBusy}
                  onClick={handleResetDefaultFiveSlots}
                >
                  Khôi phục 5 mốc mặc định
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={
                    mutationBusy || slotsInput.length >= ATTENDANCE_SLOT_MAX_COUNT
                  }
                  onClick={handleAddSlotDraft}
                >
                  + Thêm mốc
                </Button>
              </div>
            </div>

            <div className="space-y-2.5">
              {slotsInput.map((slotDraft, idx) => (
                <div
                  key={slotDraft.id}
                  className="rounded-lg border border-border bg-surface p-2.5"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-foreground">
                      Mốc #{idx + 1} (SLOT_{idx + 1})
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={mutationBusy || idx === 0}
                        onClick={() => handleMoveSlotDraft(idx, -1)}
                        aria-label={`Di chuyển mốc ${idx + 1} lên`}
                      >
                        Lên
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={mutationBusy || idx === slotsInput.length - 1}
                        onClick={() => handleMoveSlotDraft(idx, 1)}
                        aria-label={`Di chuyển mốc ${idx + 1} xuống`}
                      >
                        Xuống
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={
                          mutationBusy ||
                          slotsInput.length <= ATTENDANCE_SLOT_MIN_COUNT
                        }
                        onClick={() => handleRemoveSlotDraft(idx)}
                        aria-label={`Xóa mốc ${idx + 1}`}
                      >
                        Xóa mốc
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-4">
                    <div>
                      <label
                        htmlFor={`slot-${idx + 1}-label`}
                        className="mb-1 block text-xs font-medium text-muted"
                      >
                        Tên mốc
                      </label>
                      <input
                        id={`slot-${idx + 1}-label`}
                        type="text"
                        maxLength={64}
                        required
                        value={slotDraft.slotLabel}
                        disabled={mutationBusy}
                        onChange={(event) =>
                          handleUpdateSlotDraft(idx, {
                            slotLabel: event.target.value,
                          })
                        }
                        className={INPUT_CLASS}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`slot-${idx + 1}-time`}
                        className="mb-1 block text-xs font-medium text-muted"
                      >
                        Giờ chuẩn (HH:MM)
                      </label>
                      <input
                        id={`slot-${idx + 1}-time`}
                        type="time"
                        required
                        value={slotDraft.targetTime}
                        disabled={mutationBusy}
                        onChange={(event) =>
                          handleUpdateSlotDraft(idx, {
                            targetTime: event.target.value,
                          })
                        }
                        className={INPUT_CLASS}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`slot-${idx + 1}-before`}
                        className="mb-1 block text-xs font-medium text-muted"
                      >
                        Lệch trước (phút)
                      </label>
                      <input
                        id={`slot-${idx + 1}-before`}
                        type="number"
                        min={0}
                        max={240}
                        required
                        value={slotDraft.graceBeforeInput}
                        disabled={mutationBusy}
                        onChange={(event) =>
                          handleUpdateSlotDraft(idx, {
                            graceBeforeInput: event.target.value,
                          })
                        }
                        className={INPUT_CLASS}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`slot-${idx + 1}-after`}
                        className="mb-1 block text-xs font-medium text-muted"
                      >
                        Lệch sau (phút)
                      </label>
                      <input
                        id={`slot-${idx + 1}-after`}
                        type="number"
                        min={0}
                        max={240}
                        required
                        value={slotDraft.graceAfterInput}
                        disabled={mutationBusy}
                        onChange={(event) =>
                          handleUpdateSlotDraft(idx, {
                            graceAfterInput: event.target.value,
                          })
                        }
                        className={INPUT_CLASS}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={mutationBusy}
              onClick={closeDialog}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={mutationBusy}
            >
              {mutationBusy ? "Đang lưu..." : "Lưu phiên bản khung giờ mới"}
            </Button>
          </div>
        </form>
      </FormDialog>

      {/* Dialog: Employee Slot Policy Assignments */}
      <FormDialog
        open={dialogMode.kind === "assignments"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        title="Phân công nhân viên theo cấu hình khung giờ"
        description="Nhân viên chưa được gán riêng sẽ tự động dùng cấu hình Mặc định. Việc gán mới, chuyển cấu hình hoặc hủy gán về Mặc định có hiệu lực ngay từ hôm nay và không làm thay đổi lịch sử những ngày trước."
        closeAriaLabel="Đóng hộp thoại phân công nhân viên theo khung giờ"
        contentClassName="sm:w-[min(56rem,calc(100vw-2rem))]"
      >
        <div className="space-y-4">
          {loadError ? (
            <Alert tone="error" role="alert" title="Không tải được danh sách cấu hình khung giờ">
              <p>{loadError}</p>
            </Alert>
          ) : null}

          {mutationError ? (
            <Alert tone="error" role="alert" title="Không thể cập nhật phân công khung giờ">
              <p>{mutationError}</p>
            </Alert>
          ) : null}

          {canManageSlotPolicy ? (
            <form
              onSubmit={handleAssignEmployeeToProfile}
              className="grid gap-3 rounded-xl border border-border bg-surface-muted/40 p-3 sm:grid-cols-3"
            >
              <div>
                <label
                  htmlFor="slot-policy-assign-employee"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Chọn nhân viên (tài khoản BI)
                </label>
                <select
                  id="slot-policy-assign-employee"
                  required
                  value={assignEmployeeIdInput}
                  disabled={mutationBusy}
                  onChange={(event) => setAssignEmployeeIdInput(event.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">-- Chọn nhân viên --</option>
                  {employeeOptionsForAssign.map((emp) => {
                    const resolved = resolveAttendanceEmployeeDisplayIdentity({
                      displayName: emp.display_name,
                      personnelCode: emp.personnel_code,
                    });
                    const currentProfileName =
                      "current_profile_name" in emp
                        ? emp.current_profile_name
                        : "slot_profile_name" in emp
                          ? emp.slot_profile_name
                          : undefined;
                    return (
                      <option key={emp.app_user_id} value={emp.app_user_id}>
                        {resolved.displayName}
                        {resolved.personnelCode ? ` (${resolved.personnelCode})` : ""}
                        {currentProfileName
                          ? ` · Đang dùng: ${currentProfileName}`
                          : ""}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label
                  htmlFor="slot-policy-assign-profile"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Cấu hình khung giờ áp dụng ngay
                </label>
                <select
                  id="slot-policy-assign-profile"
                  required
                  value={assignProfileIdInput}
                  disabled={mutationBusy}
                  onChange={(event) => setAssignProfileIdInput(event.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">-- Chọn cấu hình khung giờ --</option>
                  {assignableProfiles.map((prof) => (
                    <option key={prof.profile_id} value={prof.profile_id}>
                      {prof.display_name} ({prof.profile_code} ·{" "}
                      {prof.current_policy.slots.length} mốc:{" "}
                      {prof.current_policy.slots.map((s) => s.target_time).join("/")})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={mutationBusy}
                  className="w-full"
                >
                  {mutationBusy ? "Đang áp dụng..." : "Áp dụng ngay từ hôm nay"}
                </Button>
              </div>
            </form>
          ) : null}

          {loadingPolicies && !policiesData ? (
            <p className="py-6 text-center text-sm text-muted">
              Đang tải danh sách phân công khung giờ...
            </p>
          ) : (policiesData?.assignments ?? []).length === 0 ? (
            <p className="rounded-xl border border-border bg-surface-muted/30 py-6 text-center text-sm text-muted">
              Chưa có nhân viên nào được gán cấu hình riêng (toàn bộ đang áp dụng cấu hình Mặc định).
            </p>
          ) : (
            <DataTableContainer>
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Nhân sự
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Cấu hình khung giờ
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Kỳ hiệu lực &amp; Trạng thái
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Thao tác
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(policiesData?.assignments ?? []).map((item) => {
                    const statusView = describeSlotPolicyAssignmentStatus(item);
                    const identity = resolveAttendanceEmployeeDisplayIdentity({
                      displayName: item.employee_display_name,
                      personnelCode: item.personnel_code,
                    });
                    return (
                      <tr key={item.assignment_id} className={DATA_TABLE_ROW_CLASS}>
                        <td data-label="Nhân sự" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5 text-xs">
                            <p className="font-semibold text-foreground">
                              {identity.displayName}
                            </p>
                            {identity.personnelCode ? (
                              <p className="font-mono text-muted">
                                Mã NS: {identity.personnelCode}
                              </p>
                            ) : null}
                          </div>
                        </td>
                        <td data-label="Cấu hình khung giờ" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5 text-xs">
                            <p className="font-semibold text-foreground">
                              {item.profile_name}
                            </p>
                            <p className="font-mono text-muted">{item.profile_code}</p>
                          </div>
                        </td>
                        <td data-label="Kỳ hiệu lực & Trạng thái" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-1 text-xs">
                            <StatusBadge
                              tone={
                                statusView.tone === "emerald"
                                  ? "success"
                                  : statusView.tone === "amber"
                                    ? "warning"
                                    : "neutral"
                              }
                            >
                              {statusView.statusLabel}
                            </StatusBadge>
                            <p className="font-mono text-muted">{statusView.rangeLabel}</p>
                          </div>
                        </td>
                        <td data-label="Thao tác" className={DATA_TABLE_TD_CLASS}>
                          {canManageSlotPolicy && statusView.canUnassign ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={mutationBusy}
                              onClick={() => void handleUnassignEmployeeFromProfile(item)}
                            >
                              Hủy gán (Về Mặc định)
                            </Button>
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DataTableContainer>
          )}

          <div className="flex justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={closeDialog}>
              Đóng
            </Button>
          </div>
        </div>
      </FormDialog>
    </Card>
  );
}

export function AttendanceMonthlyMatrixSection() {
  const router = useRouter();
  const notify = useNotify();
  const initialMonth = useMemo(() => getVietnamCurrentYearMonth(), []);

  const [yearMonthInput, setYearMonthInput] = useState(initialMonth);
  const [branchIdInput, setBranchIdInput] = useState("");
  const [filterModeInput, setFilterModeInput] =
    useState<MatrixEmployeeFilterMode>("search");
  const [employeeIdInput, setEmployeeIdInput] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [filterError, setFilterError] = useState<string | null>(null);

  const [appliedFilters, setAppliedFilters] = useState<MatrixAppliedFilters>({
    yearMonth: initialMonth,
    branchId: "",
    filterMode: "search",
    employeeId: "",
    search: "",
    page: 1,
  });
  const [reloadToken, setReloadToken] = useState(0);
  const [loadState, setLoadState] = useState<MatrixLoadState>({ kind: "loading" });
  const [lastReport, setLastReport] =
    useState<AttendanceMonthlyMatrixReportProjection | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<{
    message: string;
    canRetry: boolean;
  } | null>(null);
  const [legendExpanded, setLegendExpanded] = useState(false);
  const matrixTableContainerRef = useRef<HTMLDivElement | null>(null);

  const requestReload = useCallback(() => {
    setLoadState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const query = buildMonthlyMatrixReportQuery({
        yearMonth: appliedFilters.yearMonth,
        branchId: appliedFilters.branchId,
        filterMode: appliedFilters.filterMode,
        employeeId: appliedFilters.employeeId,
        search: appliedFilters.search,
        page: appliedFilters.page,
        pageSize: ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE,
      });

      let response: Response;
      try {
        response = await fetch(`/api/admin/attendance/monthly-matrix?${query}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        setLoadState({
          kind: "error",
          detail: "Không thể kết nối máy chủ để tải ma trận chấm công tháng. Vui lòng thử lại.",
        });
        return;
      }

      if (controller.signal.aborted) return;

      if (response.status === 401) {
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (controller.signal.aborted) return;

      if (response.status === 403) {
        setLastReport(null);
        setLoadState({
          kind: "denied",
          detail: mapMonthlyMatrixReportError(403, extractErrorCode(payload)),
        });
        return;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const code = extractErrorCode(payload);
        setLoadState({
          kind: "error",
          detail: mapMonthlyMatrixReportError(response.status, code),
        });
        return;
      }

      const projected = projectAttendanceMonthlyMatrixReport(payload.report);
      if (!projected) {
        setLoadState({
          kind: "error",
          detail: "Dữ liệu phản hồi ma trận chấm công tháng không đúng định dạng chuẩn.",
        });
        return;
      }

      setLastReport(projected);
      setLoadState({ kind: "ready", report: projected });
    })();

    return () => {
      controller.abort();
    };
  }, [appliedFilters, reloadToken, router]);

  const activeReport = loadState.kind === "ready" ? loadState.report : lastReport;
  const isFetching = loadState.kind === "loading";

  function handleFilterModeChange(nextMode: MatrixEmployeeFilterMode) {
    setFilterModeInput(nextMode);
    if (nextMode === "employee") {
      setSearchInput("");
    } else {
      setEmployeeIdInput("");
    }
  }

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateMonthlyMatrixFilters({
      yearMonth: yearMonthInput,
      filterMode: filterModeInput,
      employeeId: employeeIdInput,
      search: searchInput,
    });
    if (validationError) {
      setFilterError(validationError);
      return;
    }
    setFilterError(null);
    setExportError(null);
    setLoadState({ kind: "loading" });
    setAppliedFilters({
      yearMonth: yearMonthInput.trim(),
      branchId: branchIdInput.trim(),
      filterMode: filterModeInput,
      employeeId: filterModeInput === "employee" ? employeeIdInput.trim() : "",
      search: filterModeInput === "search" ? searchInput.trim() : "",
      page: 1,
    });
  }

  function handleResetCurrentMonth() {
    const currentMonth = getVietnamCurrentYearMonth();
    setYearMonthInput(currentMonth);
    setBranchIdInput("");
    setFilterModeInput("search");
    setEmployeeIdInput("");
    setSearchInput("");
    setFilterError(null);
    setExportError(null);
    setLoadState({ kind: "loading" });
    setAppliedFilters({
      yearMonth: currentMonth,
      branchId: "",
      filterMode: "search",
      employeeId: "",
      search: "",
      page: 1,
    });
  }

  async function handleExportExcel() {
    if (exporting) return;
    setExporting(true);
    setExportError(null);

    const exportUrl = buildMonthlyMatrixExportUrl({
      yearMonth: appliedFilters.yearMonth,
      branchId: appliedFilters.branchId,
      filterMode: appliedFilters.filterMode,
      employeeId: appliedFilters.employeeId,
      search: appliedFilters.search,
    });

    try {
      const response = await fetch(exportUrl, {
        method: "GET",
        cache: "no-store",
      });

      if (response.status === 401) {
        setExporting(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }

      if (!response.ok) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        const code = extractErrorCode(payload);
        const message = mapMonthlyMatrixExportError(response.status, code);
        const canRetry =
          response.status === 409 ||
          code === "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE" ||
          response.status >= 500;
        setExportError({ message, canRetry });
        notify.error({ title: "Không thể xuất Excel ma trận tháng", description: message });
        setExporting(false);
        return;
      }

      const blob = await response.blob();
      const filename = attendanceMonthlyMatrixExportFilename(appliedFilters.yearMonth);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      notify.success({
        title: "Đã xuất Excel ma trận chấm công tháng",
        description: `Tệp ${filename} đã được tải xuống.`,
      });
    } catch {
      const message =
        "Không thể kết nối máy chủ khi xuất tệp Excel ma trận chấm công. Vui lòng thử lại.";
      setExportError({ message, canRetry: true });
      notify.error({ title: "Lỗi xuất Excel", description: message });
    } finally {
      setExporting(false);
    }
  }

  if (loadState.kind === "denied") {
    return <ErrorState title="Không có quyền truy cập" detail={loadState.detail} />;
  }

  if (loadState.kind === "error" && !activeReport) {
    return (
      <div className="space-y-4">
        <ErrorState
          title="Không tải được ma trận chấm công tháng"
          detail={loadState.detail}
        />
        <div>
          <Button variant="secondary" onClick={requestReload}>
            Thử tải lại
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {loadState.kind === "error" ? (
        <Alert tone="error" role="alert" title="Không thể làm mới ma trận tháng">
          <p>{loadState.detail}</p>
        </Alert>
      ) : null}

      <form onSubmit={handleFilterSubmit}>
        <FilterToolbar
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isFetching}
                onClick={handleResetCurrentMonth}
              >
                Tháng hiện tại
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={isFetching}
              >
                Áp dụng bộ lọc
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={exporting}
                disabled={exporting || isFetching}
                onClick={() => void handleExportExcel()}
              >
                {exporting ? "Đang xuất Excel..." : "Xuất Excel ma trận tháng"}
              </Button>
            </>
          }
          summary={
            <>
              <span>
                Tháng đang xem:{" "}
                <strong className="font-mono text-foreground">
                  {activeReport?.filters.year_month ?? appliedFilters.yearMonth}
                </strong>
                {activeReport
                  ? ` (${activeReport.filters.from_date} → ${activeReport.filters.to_date})`
                  : ""}
              </span>
              <span>Múi giờ nghiệp vụ: {ATTENDANCE_BUSINESS_TIMEZONE}</span>
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label
                htmlFor="matrix-year-month"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Tháng báo cáo (YYYY-MM)
              </label>
              <input
                id="matrix-year-month"
                type="month"
                value={yearMonthInput}
                onChange={(event) => setYearMonthInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label
                htmlFor="matrix-branch-filter"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Chi nhánh HRP
              </label>
              <select
                id="matrix-branch-filter"
                value={branchIdInput}
                onChange={(event) => setBranchIdInput(event.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Tất cả chi nhánh &amp; trụ sở</option>
                {(activeReport?.branch_options ?? []).map((branch) => (
                  <option key={branch.branch_id} value={branch.branch_id}>
                    {branch.branch_code} — {branch.display_name}
                    {branch.active ? "" : " (Ngừng hoạt động)"}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="matrix-employee-mode"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Cách lọc nhân sự
              </label>
              <select
                id="matrix-employee-mode"
                value={filterModeInput}
                onChange={(event) =>
                  handleFilterModeChange(event.target.value as MatrixEmployeeFilterMode)
                }
                className={INPUT_CLASS}
              >
                <option value="search">Tìm theo tên hoặc mã NS</option>
                <option value="employee">Chọn nhân sự cụ thể</option>
              </select>
            </div>

            {filterModeInput === "employee" ? (
              <div>
                <label
                  htmlFor="matrix-employee-select"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Nhân sự cụ thể
                </label>
                <select
                  id="matrix-employee-select"
                  value={employeeIdInput}
                  onChange={(event) => setEmployeeIdInput(event.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">Tất cả nhân sự</option>
                  {(activeReport?.employee_options ?? []).map((emp) => {
                    const resolved = resolveAttendanceEmployeeDisplayIdentity({
                      displayName: emp.display_name,
                      personnelCode: emp.personnel_code,
                    });
                    return (
                      <option key={emp.app_user_id} value={emp.app_user_id}>
                        {resolved.displayName}
                        {resolved.personnelCode ? ` (${resolved.personnelCode})` : ""}
                        {emp.branch_code ? ` · CN ${emp.branch_code}` : ""}
                      </option>
                    );
                  })}
                </select>
              </div>
            ) : (
              <div>
                <label
                  htmlFor="matrix-search-input"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Từ khóa tên / mã nhân sự
                </label>
                <input
                  id="matrix-search-input"
                  type="search"
                  maxLength={100}
                  placeholder="Nhập tên hoặc mã nhân sự..."
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
            )}
          </div>
        </FilterToolbar>
      </form>

      {filterError ? (
        <Alert tone="error" role="alert" title="Bộ lọc ma trận chưa hợp lệ">
          <p>{filterError}</p>
        </Alert>
      ) : null}

      {exportError ? (
        <Alert tone="error" role="alert" title="Không thể xuất Excel ma trận tháng">
          <p>{exportError.message}</p>
          {exportError.canRetry ? (
            <div className="mt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={exporting}
                onClick={() => void handleExportExcel()}
              >
                Thử xuất lại
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : null}

      {/* Monthly Overview KPI Cards */}
      <section aria-label="Tổng quan chấm công tháng" className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">
          Tổng quan ma trận tháng
        </h2>
        {activeReport ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Tổng nhân sự trong kỳ
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">
                {VI_INTEGER.format(activeReport.overview.total_employees)}
              </p>
              <p className="mt-1 text-xs text-muted">
                Có check-in:{" "}
                <strong className="font-mono text-foreground">
                  {VI_INTEGER.format(activeReport.overview.employees_with_checkins)}
                </strong>{" "}
                nhân sự
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Số ngày &amp; lượt check-in
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                {VI_INTEGER.format(activeReport.overview.total_checkin_days)}{" "}
                <span className="text-sm font-normal text-muted">ngày</span>
              </p>
              <p className="mt-1 text-xs text-muted">
                Tổng lượt check-in:{" "}
                <strong className="font-mono text-foreground">
                  {VI_INTEGER.format(activeReport.overview.total_checkins)}
                </strong>{" "}
                lượt
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Nghỉ phép đã duyệt
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-red-700 dark:text-red-300">
                {VI_INTEGER.format(activeReport.overview.total_approved_leave_days)}{" "}
                <span className="text-sm font-normal text-muted">ngày</span>
              </p>
              <p className="mt-1 text-xs text-muted">
                {VI_DECIMAL.format(activeReport.overview.total_approved_leave_units)} công phép trên{" "}
                <strong className="font-mono text-foreground">
                  {VI_INTEGER.format(activeReport.overview.employees_with_approved_leave)}
                </strong>{" "}
                nhân sự
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Tín hiệu Chưa có lượt chấm
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-red-700 dark:text-red-300">
                {VI_INTEGER.format(activeReport.overview.total_no_checkin_days)}{" "}
                <span className="text-sm font-normal text-muted">ngày</span>
              </p>
              <p className="mt-1 text-xs text-muted">
                Ngày chưa có lượt chấm và không có phép:{" "}
                <strong className="font-mono text-foreground">
                  {VI_INTEGER.format(
                    activeReport.overview.total_no_checkin_without_leave_days,
                  )}
                </strong>
              </p>
            </Card>
          </div>
        ) : (
          <Card>
            <p className="text-sm text-muted">Đang tải tổng quan ma trận tháng...</p>
          </Card>
        )}
      </section>

      {/* Matrix Table */}
      <Card>
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <CardHeader
              title={`Báo cáo tháng ${activeReport?.filters.year_month ?? appliedFilters.yearMonth}`}
              description="Mỗi ô ngày hiển thị đầy đủ các mốc giờ chuẩn theo phiên bản cấu hình đang có hiệu lực tại ngày đó. Toàn bộ lượt check-in trong ngày được gán vào mốc có giờ chuẩn gần nhất (nếu cách đều 2 mốc liền kề thì ưu tiên mốc sớm hơn) và hiển thị từng thời điểm chấm công cụ thể."
            />
          </div>

          <div
            aria-label="Chú giải màu sắc và quy tắc khung giờ"
            className="rounded-xl border border-border bg-surface-muted/40 p-3 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-foreground">
                Chú giải màu sắc &amp; tín hiệu rà soát HR HRP
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={legendExpanded}
                aria-controls="attendance-matrix-color-legend"
                onClick={() => setLegendExpanded((prev) => !prev)}
              >
                {legendExpanded ? "Thu gọn chú giải màu sắc" : "Mở chú giải màu sắc"}
              </Button>
            </div>
            <div
              id="attendance-matrix-color-legend"
              hidden={!legendExpanded}
              className={cn("mt-2 space-y-2", !legendExpanded && "hidden")}
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {MATRIX_LEGEND_ITEMS.map((item) => {
                  const badgeClass =
                    item.tone === "emerald"
                      ? "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
                      : item.tone === "amber"
                        ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
                        : item.tone === "sky"
                          ? "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200"
                          : "border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200";
                  return (
                    <div
                      key={item.key}
                      className="rounded-lg border border-border/80 bg-surface p-2"
                    >
                      <span
                        className={cn(
                          "inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-semibold",
                          badgeClass,
                        )}
                      >
                        {item.badgeText}
                      </span>
                      <p className="mt-1 text-[11px] font-medium text-foreground">
                        {item.title}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-snug text-muted">
                        {item.description}
                      </p>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted">
                <strong>Lưu ý nghiệp vụ:</strong> Hệ thống áp dụng thống nhất bộ mốc giờ chuẩn theo cấu hình đang có hiệu lực cho mọi nhân viên và không tự suy luận nghĩa vụ số lượt chấm của từng nhân sự. Nhãn{" "}
                <strong className="text-foreground">“Chưa có lượt chấm”</strong> và cảnh báo{" "}
                <strong className="text-foreground">Sớm/Muộn Xp</strong> là tín hiệu để HR HRP kiểm tra và đối chiếu theo quy định từng bộ phận.
              </p>
            </div>
          </div>
        </div>

        {!activeReport ? (
          <p className="py-8 text-center text-sm text-muted">
            Đang tải dữ liệu ma trận chấm công tháng...
          </p>
        ) : activeReport.items.length === 0 ? (
          <EmptyState
            title="Không có nhân sự phù hợp trong tháng đã chọn"
            description="Thử chọn lại chi nhánh HRP hoặc xóa bộ lọc nhân sự/từ khóa."
          />
        ) : (
          <>
            <div
              ref={matrixTableContainerRef}
              className="max-h-[75vh] overflow-auto rounded-xl border border-border"
            >
              <table className="min-w-max border-collapse text-left text-sm">
                <thead className={cn(DATA_TABLE_HEAD_CLASS, "sticky top-0 z-20")}>
                  <tr>
                    <th
                      scope="col"
                      className="sticky left-0 z-30 min-w-[17rem] border-b border-r border-border bg-surface px-3 py-3 text-xs font-semibold uppercase tracking-wide text-muted shadow-[1px_0_0_var(--border)]"
                    >
                      Nhân sự &amp; Tổng hợp tháng
                    </th>
                    {activeReport.calendar_days.map((calDay) => (
                      <th
                        key={calDay.business_date}
                        scope="col"
                        title={calDay.business_date}
                        className="min-w-[14.5rem] border-b border-r border-border bg-surface px-2 py-2 text-center text-xs font-semibold text-foreground last:border-r-0"
                      >
                        <div className="font-mono text-sm">
                          Ngày {String(calDay.day_of_month).padStart(2, "0")}
                        </div>
                        <div className="text-[11px] font-normal text-muted">
                          {formatMatrixWeekdayLabel(calDay.day_of_week)} · {calDay.business_date.slice(5)}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeReport.items.map((row) => (
                    <tr
                      key={row.app_user_id}
                      className="border-b border-border/80 align-top last:border-b-0"
                    >
                      <td className="sticky left-0 z-10 border-r border-border bg-surface px-3 py-3 shadow-[1px_0_0_var(--border)]">
                        <MatrixEmployeeStickySummary row={row} />
                      </td>
                      {row.days.map((cell) => (
                        <td
                          key={cell.business_date}
                          className="border-r border-border/60 p-1.5 align-top last:border-r-0"
                        >
                          <MatrixDayCell cell={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <FloatingTableNav
              containerRef={matrixTableContainerRef}
              tableLabel="Báo cáo tháng"
            />

            <OffsetPager
              page={activeReport.pagination.page}
              pageCount={activeReport.pagination.total_pages}
              total={activeReport.pagination.total_rows}
              disabled={isFetching}
              ariaLabel="Phân trang ma trận chấm công tháng"
              onPageChange={(nextPage) => {
                setLoadState({ kind: "loading" });
                setAppliedFilters((current) => ({ ...current, page: nextPage }));
              }}
            />
          </>
        )}
      </Card>
    </div>
  );
}

type BranchesLoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: AttendanceBranchesAdminListProjection }
  | { kind: "denied"; detail: string }
  | { kind: "error"; detail: string };

type BranchDialogMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; branch: AttendanceBranchAdminItemProjection }
  | { kind: "assign"; preselectedBranchId?: string }
  | {
      kind: "unassign";
      assignment: AttendanceBranchAssignmentAdminItemProjection;
    };

export function AttendanceBranchesAdminSection() {
  const router = useRouter();
  const notify = useNotify();

  const [includeInactive, setIncludeInactive] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [loadState, setLoadState] = useState<BranchesLoadState>({ kind: "loading" });
  const [lastData, setLastData] =
    useState<AttendanceBranchesAdminListProjection | null>(null);

  const [assignmentBranchFilter, setAssignmentBranchFilter] = useState("");
  const [assignmentStatusFilter, setAssignmentStatusFilter] = useState<
    "all" | "effective" | "upcoming" | "closed"
  >("all");

  const [dialogMode, setDialogMode] = useState<BranchDialogMode>({ kind: "closed" });
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [conflictBanner, setConflictBanner] = useState<string | null>(null);

  // Branch upsert form state
  const [branchCodeInput, setBranchCodeInput] = useState("");
  const [branchNameInput, setBranchNameInput] = useState("");
  const [branchAddressInput, setBranchAddressInput] = useState("");
  const [branchLatInput, setBranchLatInput] = useState("");
  const [branchLonInput, setBranchLonInput] = useState("");
  const [branchActiveInput, setBranchActiveInput] = useState(true);

  // Assignment form state
  const [assignUserIdInput, setAssignUserIdInput] = useState("");
  const [assignBranchIdInput, setAssignBranchIdInput] = useState("");
  const [assignValidFromInput, setAssignValidFromInput] = useState("");

  // Unassign form state
  const [unassignValidToInput, setUnassignValidToInput] = useState("");

  const requestReload = useCallback(() => {
    setLoadState({ kind: "loading" });
    setConflictBanner(null);
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const params = new URLSearchParams({
        include_inactive: includeInactive ? "true" : "false",
      });

      let response: Response;
      try {
        response = await fetch(`/api/admin/attendance/branches?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        setLoadState({
          kind: "error",
          detail: "Không thể kết nối máy chủ để tải danh sách chi nhánh HRP.",
        });
        return;
      }

      if (controller.signal.aborted) return;

      if (response.status === 401) {
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (controller.signal.aborted) return;

      if (response.status === 403) {
        setLastData(null);
        setLoadState({
          kind: "denied",
          detail: "Tài khoản hiện tại không có quyền xem danh sách chi nhánh HRP.",
        });
        return;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        setLoadState({
          kind: "error",
          detail: "Không tải được dữ liệu quản trị chi nhánh HRP. Vui lòng thử lại.",
        });
        return;
      }

      const projected = projectAttendanceBranchesAdminList({
        viewer: payload.viewer,
        business_date: payload.business_date,
        include_inactive: payload.include_inactive,
        branches: payload.branches,
        assignments: payload.assignments,
        employee_options: payload.employee_options,
      });

      if (!projected) {
        setLoadState({
          kind: "error",
          detail: "Dữ liệu danh sách chi nhánh HRP không đúng định dạng chuẩn.",
        });
        return;
      }

      setLastData(projected);
      setLoadState({ kind: "ready", data: projected });
    })();

    return () => {
      controller.abort();
    };
  }, [includeInactive, reloadToken, router]);

  const activeData = loadState.kind === "ready" ? loadState.data : lastData;
  const isFetching = loadState.kind === "loading";
  const canManageBranches = activeData?.viewer.can_manage_branches === true;

  const activeBranches = useMemo(
    () => (activeData?.branches ?? []).filter((branch) => branch.active),
    [activeData],
  );

  const filteredAssignments = useMemo(() => {
    const rows = activeData?.assignments ?? [];
    return rows.filter((item) => {
      if (assignmentBranchFilter !== "" && item.branch_id !== assignmentBranchFilter) {
        return false;
      }
      if (assignmentStatusFilter === "effective") {
        return item.valid_to === null && item.effective;
      }
      if (assignmentStatusFilter === "upcoming") {
        return item.valid_to === null && !item.effective;
      }
      if (assignmentStatusFilter === "closed") {
        return item.valid_to !== null;
      }
      return true;
    });
  }, [activeData, assignmentBranchFilter, assignmentStatusFilter]);

  function closeDialog() {
    if (mutationBusy) return;
    setDialogMode({ kind: "closed" });
    setMutationError(null);
  }

  function openCreateBranchDialog() {
    setMutationError(null);
    setBranchCodeInput("");
    setBranchNameInput("");
    setBranchAddressInput("");
    setBranchLatInput("");
    setBranchLonInput("");
    setBranchActiveInput(true);
    setDialogMode({ kind: "create" });
  }

  function openEditBranchDialog(branch: AttendanceBranchAdminItemProjection) {
    setMutationError(null);
    setBranchCodeInput(branch.branch_code);
    setBranchNameInput(branch.display_name);
    setBranchAddressInput(branch.address);
    setBranchLatInput(branch.latitude === null ? "" : String(branch.latitude));
    setBranchLonInput(branch.longitude === null ? "" : String(branch.longitude));
    setBranchActiveInput(branch.active);
    setDialogMode({ kind: "edit", branch });
  }

  function openAssignDialog(preselectedBranchId?: string) {
    setMutationError(null);
    setAssignUserIdInput("");
    const defaultBranchId =
      preselectedBranchId ?? activeBranches[0]?.branch_id ?? "";
    setAssignBranchIdInput(defaultBranchId);
    setAssignValidFromInput(activeData?.business_date ?? "");
    setDialogMode({ kind: "assign", preselectedBranchId });
  }

  function openUnassignDialog(assignment: AttendanceBranchAssignmentAdminItemProjection) {
    setMutationError(null);
    setUnassignValidToInput(activeData?.business_date ?? assignment.valid_from);
    setDialogMode({ kind: "unassign", assignment });
  }

  async function handleSaveBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBusy || !canManageBranches) return;

    const isEdit = dialogMode.kind === "edit";
    const expectedVersion = isEdit ? dialogMode.branch.version : 0;
    const idempotencyKey = newAttendanceHqIntentKey();

    const built = buildUpsertBranchPayload({
      branchCode: branchCodeInput,
      displayName: branchNameInput,
      address: branchAddressInput,
      latitudeInput: branchLatInput,
      longitudeInput: branchLonInput,
      active: branchActiveInput,
      expectedVersion,
      idempotencyKey,
    });

    if (!built.ok) {
      setMutationError(built.message);
      return;
    }

    setMutationBusy(true);
    setMutationError(null);

    const url = isEdit
      ? `/api/admin/attendance/branches/${encodeURIComponent(dialogMode.branch.branch_id)}`
      : "/api/admin/attendance/branches";
    const method = isEdit ? "PUT" : "POST";

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(built.body),
      });

      if (response.status === 401) {
        setMutationBusy(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapBranchAdminMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setMutationError(mapped.message);
        if (mapped.isConflict) {
          setConflictBanner(mapped.message);
        }
        setMutationBusy(false);
        return;
      }

      const projected = projectUpsertBranchResult({
        replayed: payload.replayed,
        branch: payload.branch,
      });
      if (!projected) {
        setMutationError("Phản hồi lưu chi nhánh không đúng định dạng chuẩn.");
        setMutationBusy(false);
        return;
      }

      setMutationBusy(false);
      setDialogMode({ kind: "closed" });
      notify.success({
        title: isEdit ? "Đã cập nhật chi nhánh HRP" : "Đã tạo chi nhánh HRP mới",
        description: `${projected.branch.branch_code} — ${projected.branch.display_name} (v${projected.branch.version})`,
      });
      requestReload();
    } catch {
      setMutationBusy(false);
      setMutationError("Không thể kết nối máy chủ khi lưu chi nhánh HRP.");
    }
  }

  async function handleQuickToggleBranchActive(
    branch: AttendanceBranchAdminItemProjection,
  ) {
    if (mutationBusy || !canManageBranches) return;
    const idempotencyKey = newAttendanceHqIntentKey();
    const built = buildUpsertBranchPayload({
      branchCode: branch.branch_code,
      displayName: branch.display_name,
      address: branch.address,
      latitudeInput: branch.latitude === null ? "" : String(branch.latitude),
      longitudeInput: branch.longitude === null ? "" : String(branch.longitude),
      active: !branch.active,
      expectedVersion: branch.version,
      idempotencyKey,
    });
    if (!built.ok) {
      notify.error({ title: "Không thể đổi trạng thái", description: built.message });
      return;
    }

    setMutationBusy(true);
    try {
      const response = await fetch(
        `/api/admin/attendance/branches/${encodeURIComponent(branch.branch_id)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapBranchAdminMutationError(
          response.status,
          extractErrorCode(payload),
        );
        if (mapped.isConflict) setConflictBanner(mapped.message);
        notify.error({ title: "Không thể đổi trạng thái chi nhánh", description: mapped.message });
        setMutationBusy(false);
        return;
      }

      setMutationBusy(false);
      notify.success({
        title: !branch.active ? "Đã kích hoạt chi nhánh" : "Đã ngừng hoạt động chi nhánh",
        description: `${branch.branch_code} — ${branch.display_name}`,
      });
      requestReload();
    } catch {
      setMutationBusy(false);
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể kết nối máy chủ khi đổi trạng thái chi nhánh.",
      });
    }
  }

  async function handleAssignEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBusy || !canManageBranches) return;

    const selectedBranch =
      (activeData?.branches ?? []).find((b) => b.branch_id === assignBranchIdInput) ??
      null;
    const idempotencyKey = newAttendanceHqIntentKey();
    const todayVn = activeData?.business_date ?? getVietnamTodayIsoDate();

    const built = buildAssignEmployeeToBranchPayload({
      appUserId: assignUserIdInput,
      branch: selectedBranch,
      validFrom: assignValidFromInput || todayVn,
      idempotencyKey,
      todayVn,
    });

    if (!built.ok) {
      setMutationError(built.message);
      return;
    }

    setMutationBusy(true);
    setMutationError(null);

    try {
      const response = await fetch("/api/admin/attendance/branches/assignments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(built.body),
      });

      if (response.status === 401) {
        setMutationBusy(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapBranchAdminMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setMutationError(mapped.message);
        if (mapped.isConflict) setConflictBanner(mapped.message);
        setMutationBusy(false);
        return;
      }

      const projected = projectAssignBranchResult({
        replayed: payload.replayed,
        assignment: payload.assignment,
      });
      if (!projected) {
        setMutationError("Phản hồi phân công chi nhánh không đúng định dạng chuẩn.");
        setMutationBusy(false);
        return;
      }

      setMutationBusy(false);
      setDialogMode({ kind: "closed" });
      notify.success({
        title: "Đã gán nhân viên vào chi nhánh HRP",
        description: `Chi nhánh ${projected.assignment.branch_code} · hiệu lực từ ${projected.assignment.valid_from}`,
      });
      requestReload();
    } catch {
      setMutationBusy(false);
      setMutationError("Không thể kết nối máy chủ khi phân công chi nhánh.");
    }
  }

  async function handleUnassignEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBusy || !canManageBranches || dialogMode.kind !== "unassign") return;

    const targetAssignment = dialogMode.assignment;
    const idempotencyKey = newAttendanceHqIntentKey();
    const todayVn = activeData?.business_date ?? getVietnamTodayIsoDate();

    const built = buildUnassignEmployeeFromBranchPayload({
      validTo: unassignValidToInput || todayVn,
      expectedVersion: targetAssignment.version,
      idempotencyKey,
      todayVn,
    });

    if (!built.ok) {
      setMutationError(built.message);
      return;
    }

    setMutationBusy(true);
    setMutationError(null);

    try {
      const response = await fetch(
        `/api/admin/attendance/branches/assignments/${encodeURIComponent(targetAssignment.assignment_id)}/unassign`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );

      if (response.status === 401) {
        setMutationBusy(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapBranchAdminMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setMutationError(mapped.message);
        if (mapped.isConflict) setConflictBanner(mapped.message);
        setMutationBusy(false);
        return;
      }

      const projected = projectUnassignBranchResult({
        replayed: payload.replayed,
        assignment: payload.assignment,
      });
      if (!projected) {
        setMutationError("Phản hồi kết thúc phân công không đúng định dạng chuẩn.");
        setMutationBusy(false);
        return;
      }

      setMutationBusy(false);
      setDialogMode({ kind: "closed" });
      notify.success({
        title: "Đã kết thúc phân công chi nhánh",
        description: `Hiệu lực đến ngày ${projected.assignment.valid_to ?? ""}`,
      });
      requestReload();
    } catch {
      setMutationBusy(false);
      setMutationError("Không thể kết nối máy chủ khi kết thúc phân công chi nhánh.");
    }
  }

  if (loadState.kind === "denied") {
    return <ErrorState title="Không có quyền truy cập" detail={loadState.detail} />;
  }

  if (loadState.kind === "error" && !activeData) {
    return (
      <div className="space-y-4">
        <ErrorState
          title="Không tải được danh sách chi nhánh HRP"
          detail={loadState.detail}
        />
        <div>
          <Button variant="secondary" onClick={requestReload}>
            Thử tải lại
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {conflictBanner ? (
        <Alert tone="warning" role="alert" title="Xung đột phiên bản dữ liệu">
          <p>{conflictBanner}</p>
          <div className="mt-2">
            <Button variant="secondary" size="sm" onClick={requestReload}>
              Tải lại danh sách chi nhánh
            </Button>
          </div>
        </Alert>
      ) : null}

      {/* 1. Danh mục Chi nhánh HRP */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardHeader
            title="Quản trị Chi nhánh HRP"
            description="Danh mục chi nhánh văn phòng/tuyển dụng dùng để đối chiếu khoảng cách chấm công cho nhân sự được phân công."
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(event) => setIncludeInactive(event.target.checked)}
                className="h-4 w-4 rounded border-border text-accent focus:ring-ring/40"
              />
              Hiển thị cả chi nhánh ngừng hoạt động
            </label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={isFetching}
              onClick={requestReload}
            >
              Làm mới
            </Button>
            {canManageBranches ? (
              <>
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  disabled={mutationBusy}
                  onClick={() => openAssignDialog()}
                >
                  Phân công nhân viên
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={mutationBusy}
                  onClick={openCreateBranchDialog}
                >
                  Thêm chi nhánh HRP
                </Button>
              </>
            ) : activeData ? (
              <StatusBadge tone="neutral">Chỉ xem (BoD)</StatusBadge>
            ) : null}
          </div>
        </div>

        {!activeData ? (
          <p className="py-8 text-center text-sm text-muted">
            Đang tải danh sách chi nhánh HRP...
          </p>
        ) : activeData.branches.length === 0 ? (
          <EmptyState
            title="Chưa có chi nhánh HRP nào"
            description={
              canManageBranches
                ? "Bấm Thêm chi nhánh HRP để khởi tạo chi nhánh đầu tiên."
                : "Hiện chưa có chi nhánh nào được cấu hình trong hệ thống."
            }
          />
        ) : (
          <DataTableContainer>
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Mã &amp; Tên chi nhánh
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Địa chỉ &amp; Tọa độ GPS
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Trạng thái
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Nhân sự hiệu lực
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Cập nhật gần nhất
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody>
                {activeData.branches.map((branch) => {
                  const mapsUrl = buildGoogleMapsCoordinatesUrl(
                    branch.latitude,
                    branch.longitude,
                  );
                  return (
                    <tr key={branch.branch_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-label="Mã & Tên chi nhánh" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5">
                          <p className="font-semibold text-foreground">
                            {branch.display_name}
                          </p>
                          <p className="font-mono text-xs text-muted">
                            Mã CN: {branch.branch_code} · v{branch.version}
                          </p>
                        </div>
                      </td>
                      <td data-label="Địa chỉ & Tọa độ GPS" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5 text-xs">
                          <p className="max-w-xs break-words text-foreground">
                            {branch.address || "Chưa nhập địa chỉ"}
                          </p>
                          {mapsUrl &&
                          branch.latitude !== null &&
                          branch.longitude !== null ? (
                            <p className="font-mono tabular-nums">
                              <a
                                href={mapsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary underline decoration-primary/50 underline-offset-2 hover:text-primary/80"
                              >
                                {formatCoordinatePair(branch.latitude, branch.longitude)}
                              </a>
                            </p>
                          ) : (
                            <p className="text-amber-700 dark:text-amber-300">
                              Chưa cấu hình tọa độ
                            </p>
                          )}
                        </div>
                      </td>
                      <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                        {branch.active ? (
                          <StatusBadge tone="success" dot>
                            Đang hoạt động
                          </StatusBadge>
                        ) : (
                          <StatusBadge tone="neutral" dot>
                            Ngừng hoạt động
                          </StatusBadge>
                        )}
                      </td>
                      <td data-label="Nhân sự hiệu lực" className={DATA_TABLE_TD_CLASS}>
                        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                          {VI_INTEGER.format(branch.active_assignment_count)}
                        </span>
                      </td>
                      <td data-label="Cập nhật gần nhất" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5 text-xs">
                          <p className="font-medium text-foreground">
                            {branch.updated_by_display_name}
                          </p>
                          <p className="font-mono text-muted">{branch.updated_at.slice(0, 10)}</p>
                        </div>
                      </td>
                      <td data-label="Thao tác" className={DATA_TABLE_TD_CLASS}>
                        {canManageBranches ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={mutationBusy}
                              onClick={() => openEditBranchDialog(branch)}
                            >
                              Sửa
                            </Button>
                            {branch.active ? (
                              <Button
                                type="button"
                                variant="soft"
                                size="sm"
                                disabled={mutationBusy}
                                onClick={() => openAssignDialog(branch.branch_id)}
                              >
                                Gán NV
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={mutationBusy}
                              onClick={() => void handleQuickToggleBranchActive(branch)}
                            >
                              {branch.active ? "Ngừng" : "Kích hoạt"}
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted">Chỉ xem</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        )}
      </Card>

      {/* 2. Danh sách & Lịch sử phân công nhân viên vào Chi nhánh HRP */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardHeader
            title="Phân công nhân viên theo Chi nhánh HRP"
            description="Theo dõi phân công đang hiệu lực, sắp hiệu lực và lịch sử phân công chi nhánh của nhân viên."
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <select
              aria-label="Lọc phân công theo chi nhánh"
              value={assignmentBranchFilter}
              onChange={(event) => setAssignmentBranchFilter(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">Tất cả chi nhánh</option>
              {(activeData?.branches ?? []).map((branch) => (
                <option key={branch.branch_id} value={branch.branch_id}>
                  {branch.branch_code} — {branch.display_name}
                </option>
              ))}
            </select>
            <select
              aria-label="Lọc trạng thái hiệu lực phân công"
              value={assignmentStatusFilter}
              onChange={(event) =>
                setAssignmentStatusFilter(
                  event.target.value as "all" | "effective" | "upcoming" | "closed",
                )
              }
              className={INPUT_CLASS}
            >
              <option value="all">Tất cả trạng thái</option>
              <option value="effective">Đang hiệu lực</option>
              <option value="upcoming">Sắp hiệu lực</option>
              <option value="closed">Đã kết thúc (Lịch sử)</option>
            </select>
          </div>
        </div>

        {!activeData ? (
          <p className="py-8 text-center text-sm text-muted">
            Đang tải lịch sử phân công chi nhánh...
          </p>
        ) : filteredAssignments.length === 0 ? (
          <EmptyState
            title="Chưa có bản ghi phân công chi nhánh phù hợp"
            description="Nhân sự chưa được phân công chi nhánh sẽ mặc định tính khoảng cách chấm công theo Trụ sở (HQ)."
          />
        ) : (
          <DataTableContainer>
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Nhân viên
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Chi nhánh HRP
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Khoảng thời gian hiệu lực
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Trạng thái
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredAssignments.map((assignment) => {
                  const statusInfo = describeBranchAssignmentStatus(assignment);
                  const employeeIdentity = resolveAttendanceEmployeeDisplayIdentity({
                    displayName: assignment.employee_display_name,
                    personnelCode: assignment.personnel_code,
                  });
                  return (
                    <tr key={assignment.assignment_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-label="Nhân viên" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5">
                          <p className="font-medium text-foreground">
                            {employeeIdentity.displayName}
                          </p>
                          <p className="font-mono text-xs text-muted">
                            {employeeIdentity.personnelCode
                              ? `Mã NS: ${employeeIdentity.personnelCode}`
                              : "Chưa có mã NS"}
                          </p>
                        </div>
                      </td>
                      <td data-label="Chi nhánh HRP" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5">
                          <p className="font-medium text-foreground">
                            {assignment.branch_name}
                          </p>
                          <p className="font-mono text-xs text-muted">
                            {assignment.branch_code}
                          </p>
                        </div>
                      </td>
                      <td data-label="Khoảng thời gian hiệu lực" className={DATA_TABLE_TD_CLASS}>
                        <p className="font-mono text-xs text-foreground">
                          {statusInfo.rangeLabel}
                        </p>
                        <p className="text-[11px] text-muted">
                          Phiên bản phân công: v{assignment.version}
                        </p>
                      </td>
                      <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                        <StatusBadge
                          tone={
                            statusInfo.tone === "emerald"
                              ? "success"
                              : statusInfo.tone === "amber"
                                ? "warning"
                                : "neutral"
                          }
                          dot
                        >
                          {statusInfo.statusLabel}
                        </StatusBadge>
                      </td>
                      <td data-label="Thao tác" className={DATA_TABLE_TD_CLASS}>
                        {canManageBranches && statusInfo.canUnassign ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={mutationBusy}
                            onClick={() => openUnassignDialog(assignment)}
                          >
                            Kết thúc phân công
                          </Button>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        )}
      </Card>

      {/* Dialog: Create / Edit Branch */}
      <FormDialog
        open={dialogMode.kind === "create" || dialogMode.kind === "edit"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        title={
          dialogMode.kind === "edit"
            ? `Cập nhật chi nhánh ${dialogMode.branch.branch_code}`
            : "Thêm chi nhánh HRP mới"
        }
        description="Vĩ độ và kinh độ phải cùng nhập hoặc cùng để trống. Khi để trống, khoảng cách chấm công của chi nhánh sẽ báo chưa cấu hình tọa độ."
        closeAriaLabel="Đóng hộp thoại chi nhánh"
      >
        <form onSubmit={handleSaveBranch} className="space-y-4">
          {mutationError ? (
            <Alert tone="error" role="alert" title="Không thể lưu chi nhánh">
              <p>{mutationError}</p>
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="branch-code-input"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Mã chi nhánh (A-Z, 0-9, ., _, :, -)
              </label>
              <input
                id="branch-code-input"
                type="text"
                required
                maxLength={64}
                placeholder="VD: HN-CAU-GIAY"
                value={branchCodeInput}
                disabled={mutationBusy}
                onChange={(event) => setBranchCodeInput(event.target.value.toUpperCase())}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label
                htmlFor="branch-name-input"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Tên hiển thị chi nhánh
              </label>
              <input
                id="branch-name-input"
                type="text"
                required
                maxLength={256}
                placeholder="VD: Chi nhánh Cầu Giấy"
                value={branchNameInput}
                disabled={mutationBusy}
                onChange={(event) => setBranchNameInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="branch-address-input"
              className="mb-1 block text-xs font-medium text-muted"
            >
              Địa chỉ chi nhánh (tối đa 500 ký tự)
            </label>
            <input
              id="branch-address-input"
              type="text"
              maxLength={500}
              placeholder="Số nhà, đường, quận/huyện, tỉnh/thành..."
              value={branchAddressInput}
              disabled={mutationBusy}
              onChange={(event) => setBranchAddressInput(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="branch-lat-input"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Vĩ độ (Latitude: -90 đến 90)
              </label>
              <input
                id="branch-lat-input"
                type="text"
                inputMode="decimal"
                placeholder="VD: 21.028511"
                value={branchLatInput}
                disabled={mutationBusy}
                onChange={(event) => setBranchLatInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label
                htmlFor="branch-lon-input"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Kinh độ (Longitude: -180 đến 180)
              </label>
              <input
                id="branch-lon-input"
                type="text"
                inputMode="decimal"
                placeholder="VD: 105.804817"
                value={branchLonInput}
                disabled={mutationBusy}
                onChange={(event) => setBranchLonInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={branchActiveInput}
              disabled={mutationBusy}
              onChange={(event) => setBranchActiveInput(event.target.checked)}
              className="h-4 w-4 rounded border-border text-accent focus:ring-ring/40"
            />
            Chi nhánh đang hoạt động
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={mutationBusy}
              onClick={closeDialog}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={mutationBusy}
            >
              {mutationBusy ? "Đang lưu..." : "Lưu chi nhánh"}
            </Button>
          </div>
        </form>
      </FormDialog>

      {/* Dialog: Assign Employee to Branch */}
      <FormDialog
        open={dialogMode.kind === "assign"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        title="Phân công nhân viên vào Chi nhánh HRP"
        description="Chỉ cho phép gán nhân viên mới vào chi nhánh đang hoạt động. Khoảng hiệu lực không được chồng lấn với phân công khác của cùng nhân viên."
        closeAriaLabel="Đóng hộp thoại phân công chi nhánh"
      >
        <form onSubmit={handleAssignEmployee} className="space-y-4">
          {mutationError ? (
            <Alert tone="error" role="alert" title="Không thể phân công chi nhánh">
              <p>{mutationError}</p>
            </Alert>
          ) : null}

          <div>
            <label
              htmlFor="assign-employee-select"
              className="mb-1 block text-xs font-medium text-muted"
            >
              Nhân viên ({"`app_user_id`"})
            </label>
            <select
              id="assign-employee-select"
              required
              value={assignUserIdInput}
              disabled={mutationBusy}
              onChange={(event) => setAssignUserIdInput(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">-- Chọn nhân viên --</option>
              {(activeData?.employee_options ?? []).map((emp) => {
                const resolved = resolveAttendanceEmployeeDisplayIdentity({
                  displayName: emp.display_name,
                  personnelCode: emp.personnel_code,
                });
                return (
                  <option key={emp.app_user_id} value={emp.app_user_id}>
                    {resolved.displayName}
                    {resolved.personnelCode ? ` (${resolved.personnelCode})` : ""}
                    {emp.enabled ? "" : " [Đã khóa]"}
                  </option>
                );
              })}
            </select>
          </div>

          <div>
            <label
              htmlFor="assign-branch-select"
              className="mb-1 block text-xs font-medium text-muted"
            >
              Chi nhánh HRP (đang hoạt động)
            </label>
            <select
              id="assign-branch-select"
              required
              value={assignBranchIdInput}
              disabled={mutationBusy}
              onChange={(event) => setAssignBranchIdInput(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">-- Chọn chi nhánh đang hoạt động --</option>
              {activeBranches.map((branch) => (
                <option key={branch.branch_id} value={branch.branch_id}>
                  {branch.branch_code} — {branch.display_name} (v{branch.version})
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs text-muted">
            Phân công có hiệu lực ngay từ ngày nghiệp vụ hiện tại ({" "}
            <strong className="font-mono text-foreground">
              {activeData?.business_date ?? getVietnamTodayIsoDate()}
            </strong>
            ).
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={mutationBusy}
              onClick={closeDialog}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={mutationBusy}
              disabled={mutationBusy || activeBranches.length === 0}
            >
              {mutationBusy ? "Đang phân công..." : "Xác nhận phân công"}
            </Button>
          </div>
        </form>
      </FormDialog>

      {/* Dialog: Unassign / Close Branch Assignment */}
      <FormDialog
        open={dialogMode.kind === "unassign"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        title="Kết thúc phân công Chi nhánh HRP"
        description={
          dialogMode.kind === "unassign"
            ? `Nhân viên: ${
                resolveAttendanceEmployeeDisplayIdentity({
                  displayName: dialogMode.assignment.employee_display_name,
                  personnelCode: dialogMode.assignment.personnel_code,
                }).displayName
              } · Chi nhánh: ${dialogMode.assignment.branch_code} (hiệu lực từ ${dialogMode.assignment.valid_from})`
            : undefined
        }
        closeAriaLabel="Đóng hộp thoại kết thúc phân công"
      >
        <form onSubmit={handleUnassignEmployee} className="space-y-4">
          {mutationError ? (
            <Alert tone="error" role="alert" title="Không thể kết thúc phân công">
              <p>{mutationError}</p>
            </Alert>
          ) : null}

          <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs text-muted">
            Việc kết thúc phân công có hiệu lực ngay tại ngày nghiệp vụ hiện tại ({" "}
            <strong className="font-mono text-foreground">
              {activeData?.business_date ?? getVietnamTodayIsoDate()}
            </strong>
            ).
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={mutationBusy}
              onClick={closeDialog}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={mutationBusy}
            >
              {mutationBusy ? "Đang xử lý..." : "Kết thúc phân công"}
            </Button>
          </div>
        </form>
      </FormDialog>
    </div>
  );
}
