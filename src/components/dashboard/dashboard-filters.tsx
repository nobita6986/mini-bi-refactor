"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { parseAsString, useQueryStates } from "nuqs";

import { CatalogFilterCombobox } from "@/components/ui/catalog-filter-combobox";
import { useNotify } from "@/components/ui/notify-provider";
import { buildCompanyDisplayNames } from "@/lib/display/company-display-name";
import { EMPLOYMENT_OPTIONS, PROVIDER_OPTIONS, WORK_STATUS_OPTIONS } from "@/lib/reporting/p1-dashboard";
import type { ReportingOptionsCatalog } from "@/lib/reporting/p1-dashboard";
import {
  computeDatePresets,
  countActiveFilterCriteria,
  EXPLICIT_ALL_TIME_RANGE_PARAM,
  isAllTimeActive,
  matchDatePreset,
  resolveDashboardDateRange,
} from "@/lib/reporting/p1-date-presets";
import { cn } from "@/lib/utils";

const parsers = {
  from: parseAsString,
  to: parseAsString,
  range: parseAsString,
  project: parseAsString,
  recruiter: parseAsString,
  provider: parseAsString,
  employment: parseAsString,
  status: parseAsString,
  source: parseAsString,
};

const inputClass =
  "h-11 w-full rounded-lg border border-border bg-surface-muted px-2.5 text-sm font-medium text-foreground transition-colors focus:border-primary focus:bg-surface focus:outline-none focus:ring-2 focus:ring-ring/30";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

export function DashboardFilters({
  options,
  showRecruiter = true,
}: {
  options: ReportingOptionsCatalog;
  /** The own-scope dashboard hides the recruiter filter (scope is one person). */
  showRecruiter?: boolean;
}) {
  // P3-UI-COMPANY-DISPLAY-NAMES: danh sach chon hien thi ten gon; gia tri value
  // van la project key nen khong doi khoa lien ket hay ket qua loc.
  const projectDisplayNames = useMemo(
    () => buildCompanyDisplayNames(options.dimensions.projects.map((o) => ({ key: o.key, fullName: o.display }))),
    [options.dimensions.projects],
  );
  const projectFilterOptions = useMemo(
    () => options.dimensions.projects.map((o) => ({
      id: o.key,
      label: projectDisplayNames.get(o.key) ?? o.display,
      keywords: o.display,
    })),
    [options.dimensions.projects, projectDisplayNames],
  );
  const recruiterFilterOptions = useMemo(
    () => options.dimensions.recruiters.map((o) => ({ id: o.key, label: o.display, keywords: o.key })),
    [options.dimensions.recruiters],
  );
  const notify = useNotify();
  const [isPending, startTransition] = useTransition();
  const filterRefreshRequestedRef = useRef(false);
  const observedFilterTransitionRef = useRef(false);
  const [filters, setFilters] = useQueryStates(parsers, { shallow: false, scroll: false, startTransition });
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (isPending) {
      if (filterRefreshRequestedRef.current) observedFilterTransitionRef.current = true;
      return;
    }
    if (!filterRefreshRequestedRef.current || !observedFilterTransitionRef.current) return;
    filterRefreshRequestedRef.current = false;
    observedFilterTransitionRef.current = false;
    notify.success({ title: "Đã áp dụng bộ lọc và cập nhật báo cáo." });
  }, [isPending, notify]);

  function applyFilters(values: Parameters<typeof setFilters>[0]) {
    filterRefreshRequestedRef.current = true;
    void setFilters(values);
  }

  const now = new Date();
  const presets = computeDatePresets(now);
  const resolvedDate = resolveDashboardDateRange(
    { from: filters.from, to: filters.to, range: filters.range },
    now,
  );
  const effectiveFrom = resolvedDate.from;
  const effectiveTo = resolvedDate.to;
  const activePresetKey = matchDatePreset(effectiveFrom, effectiveTo, now);
  const allTime = isAllTimeActive(effectiveFrom, effectiveTo);
  const activeCount = countActiveFilterCriteria({
    ...filters,
    from: effectiveFrom,
    to: effectiveTo,
  });
  const countLabel = activeCount === 1 ? "1 tiêu chí đang áp dụng" : activeCount + " tiêu chí đang áp dụng";

  const chip = (active: boolean) =>
    cn(
      "inline-flex h-11 shrink-0 items-center rounded-lg border px-3.5 text-xs font-medium transition-colors duration-[180ms] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      active
        ? "border-primary bg-primary text-on-primary shadow-2xs"
        : "border-border bg-surface-muted text-foreground hover:border-primary/40 hover:bg-[var(--selected-bg)] hover:text-primary"
    );

  return (
    <>
      <section aria-label="Bộ lọc báo cáo" className="rounded-[10px] border border-border bg-surface/95 p-4 shadow-[var(--shadow-card)] md:sticky md:top-2 md:z-20 md:backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--navy)]">Bộ lọc</h2>
            <span className="inline-flex items-center rounded-md bg-[var(--selected-bg)] px-2.5 py-0.5 text-xs font-medium text-primary">{countLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" aria-expanded={advancedOpen} aria-controls="advanced-filters" onClick={() => setAdvancedOpen((o) => !o)} className="inline-flex h-11 items-center rounded-lg border border-border bg-surface px-3.5 text-sm font-medium text-[var(--navy)] transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none hover:border-primary/40 hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
              <span aria-hidden className="mr-1">{advancedOpen ? "▾" : "▸"}</span>
              Bộ lọc nâng cao
            </button>
            {activeCount > 0 || allTime ? (
              <button type="button" onClick={() => applyFilters(null)} className="inline-flex h-11 items-center rounded-lg bg-primary px-3.5 text-sm font-medium text-on-primary transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none hover:bg-[var(--primary-hover)] focus:outline-none focus:ring-2 focus:ring-ring/40">
                Xóa bộ lọc
              </button>
            ) : null}
          </div>
        </div>

        <div role="group" aria-label="Khoảng thời gian nhanh" className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {presets.map((p) => (
            <button key={p.key} type="button" aria-pressed={activePresetKey === p.key} onClick={() => applyFilters({ from: p.from, to: p.to, range: null })} className={chip(activePresetKey === p.key)}>
              {p.label}
            </button>
          ))}
          <button type="button" aria-pressed={allTime} onClick={() => applyFilters({ from: null, to: null, range: EXPLICIT_ALL_TIME_RANGE_PARAM })} className={chip(allTime)}>
            Tất cả thời gian
          </button>
        </div>
      </section>

      <div id="advanced-filters" hidden={!advancedOpen} data-ui-panel-motion="true" className="mt-2 rounded-[10px] border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="f-from" label="Từ ngày">
            <input
              id="f-from"
              type="date"
              className={inputClass}
              value={effectiveFrom ?? ""}
              onChange={(e) => {
                const nextFrom = e.target.value || null;
                const nextTo = effectiveTo;
                applyFilters({
                  from: nextFrom,
                  to: nextTo,
                  range: nextFrom === null && nextTo === null ? EXPLICIT_ALL_TIME_RANGE_PARAM : null,
                });
              }}
            />
          </Field>
          <Field id="f-to" label="Đến ngày">
            <input
              id="f-to"
              type="date"
              className={inputClass}
              value={effectiveTo ?? ""}
              onChange={(e) => {
                const nextFrom = effectiveFrom;
                const nextTo = e.target.value || null;
                applyFilters({
                  from: nextFrom,
                  to: nextTo,
                  range: nextFrom === null && nextTo === null ? EXPLICIT_ALL_TIME_RANGE_PARAM : null,
                });
              }}
            />
          </Field>
          <CatalogFilterCombobox
            id="f-project"
            label="Dự án"
            allLabel="Tất cả dự án"
            placeholder="Gõ tên dự án để tìm"
            options={projectFilterOptions}
            value={filters.project ?? ""}
            onChange={(value) => applyFilters({ project: value || null })}
          />
          {showRecruiter ? (
            <CatalogFilterCombobox
              id="f-recruiter"
              label="Người tuyển"
              allLabel="Tất cả người tuyển"
              placeholder="Gõ tên người tuyển để tìm"
              options={recruiterFilterOptions}
              value={filters.recruiter ?? ""}
              onChange={(value) => applyFilters({ recruiter: value || null })}
            />
          ) : null}
          <Field id="f-provider" label="HRP/Vendor">
            <select id="f-provider" className={inputClass} value={filters.provider ?? ""} onChange={(e) => applyFilters({ provider: e.target.value || null })}>
              <option value="">Tất cả</option>
              {PROVIDER_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.display}</option>)}
            </select>
          </Field>
          <Field id="f-employment" label="Loại hình làm việc">
            <select id="f-employment" className={inputClass} value={filters.employment ?? ""} onChange={(e) => applyFilters({ employment: e.target.value || null })}>
              <option value="">Tất cả</option>
              {EMPLOYMENT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.display}</option>)}
            </select>
          </Field>
          <Field id="f-status" label="Trạng thái làm việc">
            <select id="f-status" className={inputClass} value={filters.status ?? ""} onChange={(e) => applyFilters({ status: e.target.value || null })}>
              <option value="">Tất cả trạng thái</option>
              {WORK_STATUS_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.display}</option>)}
            </select>
          </Field>
        </div>
      </div>
    </>
  );
}
