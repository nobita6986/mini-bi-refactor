import { MapPin } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { RecruitmentPostCardViewModel } from "@/lib/recruitment-posts/recruitment-post-ui-model";
import { cn } from "@/lib/utils";

export function RecruitmentPostCard({
  card,
  onViewDetail,
  onExport,
  isExporting = false,
  onWithdraw,
  showStatusBadge = false,
  canRepost,
}: {
  card: RecruitmentPostCardViewModel;
  onViewDetail: (briefId: string) => void;
  onExport?: (briefId: string) => void;
  isExporting?: boolean;
  onWithdraw?: (card: RecruitmentPostCardViewModel) => void;
  showStatusBadge?: boolean;
  canRepost?: boolean;
}) {
  const isPublished = card.status === "PUBLISHED";
  const isWithdrawn = card.status === "WITHDRAWN";
  const allowRepost = Boolean(canRepost) && isWithdrawn;

  return (
    <Card className="flex h-full flex-col gap-4 rounded-[10px] border-border bg-surface p-4 sm:p-5 shadow-[var(--shadow-card)] transition-[border-color,box-shadow] duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-card-hover)] motion-reduce:transition-none">
      <div
        data-testid={`recruitment-post-card-${card.briefId}`}
        className="flex h-full flex-col justify-between gap-4"
      >
        <div className="flex flex-col gap-3.5">
          <div
            data-testid="recruitment-post-card-header"
            data-status={card.status}
            className={cn(
              "border-l-4 pl-3.5 py-0.5 space-y-2",
              isWithdrawn
                ? "border-l-muted/60"
                : "border-l-primary",
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="min-w-0 flex-1 text-base font-semibold tracking-tight text-[var(--navy)] sm:text-lg leading-snug break-words">
                {card.projectName}
              </h2>
              {showStatusBadge ? (
                <StatusBadge
                  tone={isWithdrawn ? "neutral" : "success"}
                  dot={!isWithdrawn}
                  dataTestId={`recruitment-post-status-badge-${card.briefId}`}
                >
                  {card.statusBadgeLabel}
                </StatusBadge>
              ) : null}
            </div>
            <div className="space-y-1 pt-0.5">
              <p className="text-xs sm:text-sm text-muted break-words">
                <span className="font-medium text-foreground/85">Khách hàng:</span>{" "}
                {card.customerNameDisplay}
              </p>
              <p className="flex items-start gap-1.5 text-xs sm:text-sm text-muted break-words">
                <MapPin
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 break-words">
                  <span className="font-medium text-foreground/85">Địa điểm:</span>{" "}
                  {card.locationDisplay}
                </span>
              </p>
            </div>
          </div>

          <div
            data-testid="recruitment-post-card-actions"
            className="flex flex-wrap items-center gap-2 border-y border-border py-2.5"
          >
            <Button
              type="button"
              variant="soft"
              size="sm"
              data-testid={`recruitment-post-view-detail-${card.briefId}`}
              onClick={() => onViewDetail(card.briefId)}
            >
              Xem chi tiết
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="recruitment-post-export"
              data-brief-id={card.briefId}
              disabled={isExporting}
              onClick={() => onExport?.(card.briefId)}
            >
              {isExporting ? "Đang xuất…" : "Xuất bản tin"}
            </Button>
            {isPublished && card.allowedActions.canEdit ? (
              <Link
                href={`/recruitment-posts/${encodeURIComponent(card.briefId)}/edit`}
                data-testid={`recruitment-post-edit-${card.briefId}`}
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                Sửa
              </Link>
            ) : null}
            {isPublished && card.allowedActions.canWithdraw && onWithdraw ? (
              <Button
                type="button"
                variant="danger"
                size="sm"
                data-testid={`recruitment-post-withdraw-${card.briefId}`}
                onClick={() => onWithdraw(card)}
              >
                Rút tin
              </Button>
            ) : null}
            {isWithdrawn && allowRepost ? (
              <Link
                href={`/recruitment-posts/new?copy_from=${encodeURIComponent(card.briefId)}`}
                data-testid={`recruitment-post-repost-${card.briefId}`}
                className={buttonClasses({ variant: "soft", size: "sm" })}
              >
                Đăng lại
              </Link>
            ) : null}
          </div>

          <div
            data-testid="recruitment-post-card-job"
            className="px-0.5 space-y-1"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Công việc</p>
            <p className="text-sm font-normal leading-relaxed text-foreground whitespace-pre-line break-words line-clamp-3">
              {card.jobDescriptionDisplay}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-2.5 text-sm">
            <div
              data-testid="recruitment-post-card-labor-types"
              className="min-w-0 rounded-lg bg-surface-muted px-3 py-2.5 space-y-0.5"
            >
              <dt className="text-[11px] font-normal uppercase tracking-wider text-muted">Hình thức tuyển</dt>
              <dd className="text-sm font-medium text-[var(--navy)] break-words">
                {card.laborTypesDisplay}
              </dd>
            </div>

            <div
              data-testid="recruitment-post-card-headcount"
              className="min-w-0 rounded-lg bg-surface-muted px-3 py-2.5 space-y-0.5"
            >
              <dt className="text-[11px] font-normal uppercase tracking-wider text-muted">
                Số lượng dự kiến
              </dt>
              <dd className="font-mono text-sm font-semibold tabular-nums text-[var(--navy)] break-words">
                {card.expectedHeadcountDisplay}
              </dd>
            </div>

            <div
              data-testid="recruitment-post-card-candidate"
              className="col-span-2 sm:col-span-1 min-w-0 sm:border-r sm:border-border sm:pr-3 py-1 space-y-0.5"
            >
              <dt className="text-[11px] font-normal uppercase tracking-wider text-muted">
                Giới tính &amp; độ tuổi
              </dt>
              <dd className="text-sm font-normal text-foreground break-words">
                {card.genderAndAgeDisplay}
              </dd>
            </div>

            <div
              data-testid="recruitment-post-card-contact"
              className="col-span-2 sm:col-span-1 min-w-0 sm:pl-1 py-1 space-y-0.5"
            >
              <dt className="text-[11px] font-normal uppercase tracking-wider text-muted">
                Người phụ trách &amp; điện thoại
              </dt>
              <dd className="text-sm font-medium tabular-nums text-foreground break-words">
                {card.managerContactDisplay}
              </dd>
            </div>

            <div
              data-testid="recruitment-post-card-compensation"
              className="col-span-2 min-w-0 rounded-lg border border-primary/20 bg-[var(--selected-bg)] px-3.5 py-2.5 space-y-1"
            >
              <dt className="text-[11px] font-medium uppercase tracking-wider text-primary">
                Lương cơ bản &amp; thu nhập dự kiến
              </dt>
              <dd className="font-mono text-sm sm:text-base font-semibold tabular-nums text-primary break-words">
                {card.baseSalaryAndIncomeDisplay}
              </dd>
            </div>
          </dl>
        </div>

        <div
          data-testid="recruitment-post-card-footer"
          className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2.5 text-xs text-muted"
        >
          <span className="break-words">
            Người đăng &amp; cập nhật gần nhất: {card.createdByAndUpdatedAtDisplay}
          </span>
        </div>
      </div>
    </Card>
  );
}

