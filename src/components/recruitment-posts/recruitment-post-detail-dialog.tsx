"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { StatusBanner } from "@/components/ui/status-banner";
import type { RecruitmentPostDetailViewModel } from "@/lib/recruitment-posts/recruitment-post-ui-model";

function DetailField({
  label,
  value,
  mono = false,
  multiline = false,
  fullWidth = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
  fullWidth?: boolean;
}) {
  return (
    <div
      className={
        fullWidth
          ? "min-w-0 space-y-1 rounded-lg bg-surface-muted/75 px-3 py-2 sm:col-span-2"
          : "min-w-0 space-y-1 rounded-lg bg-surface-muted/75 px-3 py-2"
      }
    >
      <dt className="text-[11px] font-normal uppercase tracking-wider text-muted">{label}</dt>
      <dd
        className={[
          "text-sm font-medium text-foreground break-words",
          mono ? "font-mono tabular-nums" : "",
          multiline ? "whitespace-pre-line font-normal text-foreground" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

export function RecruitmentPostDetailDialog({
  open,
  onOpenChange,
  detail,
  loading,
  error,
  onRetry,
  onWithdraw,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: RecruitmentPostDetailViewModel | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onWithdraw?: (detail: RecruitmentPostDetailViewModel) => void;
}) {
  const titleText = detail
    ? `Chi tiết tin tuyển dụng — ${detail.section1General.projectName}`
    : "Chi tiết tin tuyển dụng";
  const descriptionText = detail
    ? `${detail.section1General.provinceName} · ${detail.section1General.industrialParkName} · Cập nhật lần cuối: ${detail.updatedAtDisplay} (${detail.updatedByDisplayName})`
    : "Thông tin chi tiết phiếu yêu cầu tuyển dụng theo mẫu chuẩn.";

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={titleText}
      description={descriptionText}
      descriptionId="recruitment-post-detail-description"
      closeAriaLabel="Đóng hộp thoại chi tiết tin tuyển dụng"
      contentClassName="sm:w-[min(56rem,calc(100vw-2rem))] lg:w-[min(64rem,calc(100vw-2rem))] border-t-2 border-t-primary"
      dataTestId="recruitment-post-detail-dialog"
    >
      <div className="space-y-5">
        {error ? (
          <StatusBanner
            tone="error"
            title="Không thể tải chi tiết tin tuyển dụng"
            dataTestId="recruitment-post-detail-error"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{error}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="recruitment-post-detail-retry"
                onClick={onRetry}
                disabled={loading}
              >
                Thử lại
              </Button>
            </div>
          </StatusBanner>
        ) : null}

        {loading && !detail ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="recruitment-post-detail-loading"
            className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-muted"
          >
            Đang tải chi tiết tin tuyển dụng…
          </div>
        ) : null}

        {detail ? (
          <div
            data-testid="recruitment-post-detail-content"
            className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start"
          >
            <div className="space-y-5 lg:col-span-5">
            {/* Phần 1 — Thông tin chung dự án */}
            <section
              aria-labelledby="recruitment-post-detail-sec-1"
              className="rounded-[10px] border border-border border-t-[3px] border-t-primary bg-surface p-4 shadow-[var(--shadow-card)] space-y-3"
            >
              <h3
                id="recruitment-post-detail-sec-1"
                className="text-sm font-semibold tracking-tight text-[var(--navy)] border-b border-primary/20 pb-2"
              >
                1. Thông tin chung dự án
              </h3>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <DetailField
                  label="Dự án"
                  value={detail.section1General.projectName}
                />
                <DetailField
                  label="Tên khách hàng"
                  value={detail.section1General.customerNameDisplay}
                />
                <DetailField
                  label="Tỉnh/Thành"
                  value={detail.section1General.provinceName}
                />
                <DetailField
                  label="Khu công nghiệp"
                  value={detail.section1General.industrialParkName}
                />
                <DetailField
                  label="Vốn đầu tư"
                  value={detail.section1General.investmentOriginDisplay}
                />
                <DetailField
                  label="Ngành sản xuất"
                  value={detail.section1General.manufacturingIndustryDisplay}
                />
                <DetailField
                  label="Mô tả công việc"
                  value={detail.section1General.jobDescriptionDisplay}
                  multiline
                  fullWidth
                />
                <DetailField
                  label="Môi trường làm việc"
                  value={detail.section1General.environmentTypesDisplay}
                />
                <DetailField
                  label="Tư thế làm việc"
                  value={detail.section1General.workPosturesDisplay}
                />
                <DetailField
                  label="Ca làm việc"
                  value={detail.section1General.shiftPatternDisplay}
                />
                <DetailField
                  label="Chi tiết ca / giờ làm việc"
                  value={detail.section1General.shiftDetailsDisplay}
                  multiline
                />
                <DetailField
                  label="Hình thức tuyển dụng"
                  value={detail.section1General.laborTypesDisplay}
                />
                <DetailField
                  label="Số lượng dự kiến"
                  value={detail.section1General.expectedHeadcountDisplay}
                  mono
                />
                <DetailField
                  label="Thời gian cung ứng"
                  value={detail.section1General.supplyScheduleTextDisplay}
                  fullWidth
                />
                <DetailField
                  label="Người phụ trách dự án"
                  value={detail.section1General.managerNameDisplay}
                />
                <DetailField
                  label="Số điện thoại người phụ trách"
                  value={detail.section1General.managerPhoneDisplay}
                  mono
                />
              </dl>
            </section>

            {/* Phần 2 — Yêu cầu ứng viên */}
            <section
              aria-labelledby="recruitment-post-detail-sec-2"
              className="rounded-[10px] border border-border bg-surface p-4 shadow-[var(--shadow-card)] space-y-3"
            >
              <h3
                id="recruitment-post-detail-sec-2"
                className="text-sm font-semibold tracking-tight text-[var(--navy)] border-b border-primary/20 pb-2"
              >
                2. Yêu cầu ứng viên
              </h3>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <DetailField
                  label="Độ tuổi từ"
                  value={detail.section2CandidateRequirements.ageFromDisplay}
                  mono
                />
                <DetailField
                  label="Độ tuổi đến"
                  value={detail.section2CandidateRequirements.ageToDisplay}
                  mono
                />
                <DetailField
                  label="Giới tính"
                  value={detail.section2CandidateRequirements.genderDisplay}
                />
                <DetailField
                  label="Trình độ tối thiểu"
                  value={
                    detail.section2CandidateRequirements.minimumEducationDisplay
                  }
                />
                <DetailField
                  label="Yêu cầu kinh nghiệm"
                  value={
                    detail.section2CandidateRequirements
                      .experienceRequiredDisplay
                  }
                />
                <DetailField
                  label="Chi tiết kinh nghiệm"
                  value={
                    detail.section2CandidateRequirements
                      .experienceDetailsDisplay
                  }
                  multiline
                />
                <DetailField
                  label="Nhận lao động từng làm tại khách hàng"
                  value={
                    detail.section2CandidateRequirements
                      .acceptsFormerWorkersDisplay
                  }
                />
                <DetailField
                  label="Hình thức kiểm tra đầu vào"
                  value={
                    detail.section2CandidateRequirements.entryTestFormatDisplay
                  }
                />
                <DetailField
                  label="Yêu cầu khác"
                  value={
                    detail.section2CandidateRequirements
                      .otherRequirementsDisplay
                  }
                  multiline
                  fullWidth
                />
              </dl>
            </section>
            </div>

            <div className="space-y-5 lg:col-span-7">
            {/* Phần 3 — Lương, thưởng và phúc lợi */}
            <section
              aria-labelledby="recruitment-post-detail-sec-3"
              className="rounded-[10px] border border-border border-t-[3px] border-t-primary bg-surface p-4 shadow-[var(--shadow-card)] space-y-3"
            >
              <h3
                id="recruitment-post-detail-sec-3"
                className="text-sm font-semibold tracking-tight text-[var(--navy)] border-b border-primary/20 pb-2"
              >
                3. Lương, thưởng và phúc lợi
              </h3>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <DetailField
                  label="Lương cơ bản"
                  value={
                    detail.section3CompensationBenefits.baseSalaryVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Điều kiện lương cơ bản"
                  value={
                    detail.section3CompensationBenefits
                      .baseSalaryConditionsDisplay
                  }
                />
                <DetailField
                  label="Thưởng chuyên cần"
                  value={
                    detail.section3CompensationBenefits
                      .attendanceBonusVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Điều kiện thưởng chuyên cần"
                  value={
                    detail.section3CompensationBenefits
                      .attendanceBonusConditionsDisplay
                  }
                />
                <DetailField
                  label="Phụ cấp đời sống"
                  value={
                    detail.section3CompensationBenefits
                      .livingAllowanceVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Điều kiện phụ cấp đời sống"
                  value={
                    detail.section3CompensationBenefits
                      .livingAllowanceConditionsDisplay
                  }
                />
                <DetailField
                  label="Phụ cấp thâm niên"
                  value={
                    detail.section3CompensationBenefits
                      .seniorityAllowanceVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Điều kiện phụ cấp thâm niên"
                  value={
                    detail.section3CompensationBenefits
                      .seniorityAllowanceConditionsDisplay
                  }
                />
                <DetailField
                  label="Phụ cấp soi kính"
                  value={
                    detail.section3CompensationBenefits
                      .eyesightAllowanceVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Điều kiện phụ cấp soi kính"
                  value={
                    detail.section3CompensationBenefits
                      .eyesightAllowanceConditionsDisplay
                  }
                />
                <DetailField
                  label="Phụ cấp khác"
                  value={
                    detail.section3CompensationBenefits
                      .otherAllowanceTextDisplay
                  }
                  multiline
                  fullWidth
                />
                <DetailField
                  label="Thu nhập bình quân tối thiểu"
                  value={
                    detail.section3CompensationBenefits
                      .averageIncomeMinVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Thu nhập bình quân tối đa"
                  value={
                    detail.section3CompensationBenefits
                      .averageIncomeMaxVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Ngày thanh toán lương"
                  value={
                    detail.section3CompensationBenefits
                      .salaryPaymentScheduleDisplay
                  }
                  fullWidth
                />
                <DetailField
                  label="Ứng lương"
                  value={
                    detail.section3CompensationBenefits
                      .salaryAdvanceAvailableDisplay
                  }
                />
                <DetailField
                  label="Mức ứng lương"
                  value={
                    detail.section3CompensationBenefits
                      .salaryAdvanceAmountVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Lịch/ngày ứng lương"
                  value={
                    detail.section3CompensationBenefits
                      .salaryAdvanceScheduleDisplay
                  }
                  fullWidth
                />
                <DetailField
                  label="Lương tuần"
                  value={
                    detail.section3CompensationBenefits
                      .weeklySalaryAvailableDisplay
                  }
                />
                <DetailField
                  label="Ngày thanh toán lương tuần"
                  value={
                    detail.section3CompensationBenefits
                      .weeklySalaryPaymentScheduleDisplay
                  }
                />
                <DetailField
                  label="Ca ngày 8 giờ"
                  value={
                    detail.section3CompensationBenefits.dayShift8hVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Ca ngày 11 giờ"
                  value={
                    detail.section3CompensationBenefits.dayShift11hVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Ca đêm 8 giờ"
                  value={
                    detail.section3CompensationBenefits.nightShift8hVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Ca đêm 11 giờ"
                  value={
                    detail.section3CompensationBenefits.nightShift11hVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Chủ nhật ngày 11 giờ"
                  value={
                    detail.section3CompensationBenefits.sundayDay11hVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Chủ nhật đêm 11 giờ"
                  value={
                    detail.section3CompensationBenefits.sundayNight11hVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Lễ ngày 11 giờ"
                  value={
                    detail.section3CompensationBenefits.holidayDay11hVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Lễ đêm 11 giờ"
                  value={
                    detail.section3CompensationBenefits
                      .holidayNight11hVndDisplay
                  }
                  mono
                />
                <DetailField
                  label="Đồng phục / bảo hộ"
                  value={
                    detail.section3CompensationBenefits.ppeProvidedDisplay
                  }
                />
                <DetailField
                  label="Chi tiết đồng phục / bảo hộ"
                  value={detail.section3CompensationBenefits.ppeDetailsDisplay}
                />
                <DetailField
                  label="Phúc lợi khác"
                  value={
                    detail.section3CompensationBenefits.otherBenefitsDisplay
                  }
                  multiline
                  fullWidth
                />
              </dl>
            </section>

            {/* Phần 4 — Hồ sơ ứng viên cần chuẩn bị */}
            <section
              aria-labelledby="recruitment-post-detail-sec-4"
              className="rounded-[10px] border border-border bg-surface p-4 shadow-[var(--shadow-card)] space-y-3"
            >
              <h3
                id="recruitment-post-detail-sec-4"
                className="text-sm font-semibold tracking-tight text-[var(--navy)] border-b border-primary/20 pb-2"
              >
                4. Hồ sơ ứng viên cần chuẩn bị
              </h3>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <DetailField
                  label="CCCD gốc và bản sao"
                  value={
                    detail.section4ApplicationDocuments
                      .requireOriginalCccdAndCopyDisplay
                  }
                />
                <DetailField
                  label="Sơ yếu lý lịch có xác nhận"
                  value={
                    detail.section4ApplicationDocuments
                      .requireCertifiedResumeDisplay
                  }
                />
                <DetailField
                  label="Giấy khám sức khỏe trong vòng 6 tháng"
                  value={
                    detail.section4ApplicationDocuments
                      .requireHealthCertificateWithin6MonthsDisplay
                  }
                />
                <DetailField
                  label="Ảnh 3x4"
                  value={
                    detail.section4ApplicationDocuments.requirePhoto3x4Display
                  }
                />
                <DetailField
                  label="Bằng cấp hoặc chứng chỉ"
                  value={
                    detail.section4ApplicationDocuments
                      .requireDegreeOrCertificateDisplay
                  }
                />
                <DetailField
                  label="Sổ BHXH"
                  value={
                    detail.section4ApplicationDocuments
                      .requireSocialInsuranceBookDisplay
                  }
                />
                <DetailField
                  label="Giấy tờ khác"
                  value={
                    detail.section4ApplicationDocuments
                      .requireOtherDocumentsDisplay
                  }
                />
                <DetailField
                  label="Nội dung giấy tờ khác"
                  value={
                    detail.section4ApplicationDocuments
                      .otherDocumentsTextDisplay
                  }
                  multiline
                />
              </dl>
            </section>
            </div>

            <div className="lg:col-span-12 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
              <span>
                Đăng bởi: {detail.createdByDisplayName} ({detail.publishedAtDisplay})
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {detail.allowedActions.canEdit ? (
                  <Link
                    href={`/recruitment-posts/${encodeURIComponent(detail.briefId)}/edit`}
                    data-testid={`recruitment-post-detail-edit-${detail.briefId}`}
                    className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    Sửa tin
                  </Link>
                ) : null}
                {detail.allowedActions.canWithdraw && onWithdraw ? (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    data-testid={`recruitment-post-detail-withdraw-${detail.briefId}`}
                    onClick={() => onWithdraw(detail)}
                  >
                    Rút tin
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                >
                  Đóng
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </FormDialog>
  );
}
