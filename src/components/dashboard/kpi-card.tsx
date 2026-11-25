"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  formatKpiIntegerValue,
  interpolateKpiIntegerFrame,
  isAnimatableKpiInteger,
  KPI_TRANSITION_DURATION_MS,
  resolveKpiTransitionPlan,
  resolveRenderedKpiNumeric,
} from "./kpi-motion";

export function KpiCard({
  label,
  value,
  hint,
  accent,
  variant = "default",
  animateNumeric = true,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent: string;
  variant?: "default" | "compact";
  animateNumeric?: boolean;
}) {
  const compact = variant === "compact";
  const hasMountedRef = useRef(false);
  const displayedValueRef = useRef<unknown>(value);
  const lastUpdateAtRef = useRef<number | null>(null);
  const [displayedNumeric, setDisplayedNumeric] = useState<number | null>(() =>
    isAnimatableKpiInteger(value) ? value : null,
  );

  useEffect(() => {
    const nowMs =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const elapsedSinceLastUpdateMs =
      hasMountedRef.current && lastUpdateAtRef.current !== null
        ? Math.max(0, nowMs - lastUpdateAtRef.current)
        : null;

    const plan = resolveKpiTransitionPlan({
      previousValue: displayedValueRef.current,
      nextValue: value,
      hasMounted: hasMountedRef.current,
      animateNumeric,
      elapsedSinceLastUpdateMs,
      durationMs: KPI_TRANSITION_DURATION_MS,
    });
    hasMountedRef.current = true;
    lastUpdateAtRef.current = nowMs;

    if (!plan.shouldAnimate || plan.fromValue === null || plan.toValue === null) {
      const settledNumeric = isAnimatableKpiInteger(value) ? value : null;
      displayedValueRef.current = value;
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) {
          setDisplayedNumeric((cur) => (cur === settledNumeric ? cur : settledNumeric));
        }
      });
      return () => {
        cancelled = true;
      };
    }

    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      const targetNumeric = plan.toValue;
      displayedValueRef.current = targetNumeric;
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) {
          setDisplayedNumeric((cur) => (cur === targetNumeric ? cur : targetNumeric));
        }
      });
      return () => {
        cancelled = true;
      };
    }

    const fromValue = plan.fromValue;
    const toValue = plan.toValue;
    const durationMs = plan.durationMs;
    let startTime: number | null = null;
    let rafId = 0;

    const tick = (now: number) => {
      if (startTime === null) {
        startTime = now;
      }
      const elapsed = now - startTime;
      const progress = durationMs <= 0 ? 1 : Math.min(1, elapsed / durationMs);
      if (progress >= 1) {
        displayedValueRef.current = toValue;
        setDisplayedNumeric(toValue);
        return;
      }
      const current = interpolateKpiIntegerFrame(fromValue, toValue, progress);
      displayedValueRef.current = current;
      setDisplayedNumeric(current);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);

    return () => {
      if (rafId && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [value, animateNumeric]);

  const numericValue = isAnimatableKpiInteger(value) ? value : null;
  const effectiveDisplayedNumeric = resolveRenderedKpiNumeric({
    value,
    displayedNumeric,
    animateNumeric,
  });
  const renderedValue: ReactNode =
    effectiveDisplayedNumeric !== null ? formatKpiIntegerValue(effectiveDisplayedNumeric) : value;
  const authoritativeNumericText =
    numericValue !== null ? formatKpiIntegerValue(numericValue) : undefined;

  return (
    <div
      className={
        compact
          ? "group relative flex h-full min-h-28 flex-col overflow-hidden rounded-[20px] border border-border/80 bg-surface p-4 shadow-[var(--shadow-card)] transition-[box-shadow,border-color,transform] duration-[var(--ui-motion-hover,160ms)] hover:-translate-y-[1px] hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-card-hover)]"
          : "group relative overflow-hidden rounded-[20px] border border-border/80 bg-surface p-5 shadow-[var(--shadow-card)] transition-[box-shadow,border-color,transform] duration-[var(--ui-motion-hover,160ms)] hover:-translate-y-[1px] hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-card-hover)]"
      }
    >
      <div
        className="pointer-events-none absolute -right-5 -top-5 h-24 w-24 rounded-full opacity-[0.14] transition-opacity duration-200 group-hover:opacity-25"
        style={{
          backgroundImage: `repeating-linear-gradient(135deg, ${accent} 0px, ${accent} 1.5px, transparent 1.5px, transparent 6px)`,
        }}
        aria-hidden
      />
      <p className="flex items-center gap-2.5 text-xs font-medium tracking-wide text-muted">
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-surface-muted/80"
          aria-hidden
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: accent }}
          />
        </span>
        <span className="truncate">{label}</span>
      </p>
      <div
        className={
          "mt-2.5 font-semibold tracking-tight tabular-nums text-[var(--navy)] transition-opacity duration-[var(--ui-motion-kpi,220ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none " +
          (compact ? "text-2xl" : "text-3xl")
        }
        data-kpi-final-value={authoritativeNumericText}
      >
        {renderedValue}
      </div>
      {hint ? <p className={"text-xs text-muted/85 " + (compact ? "mt-auto pt-1" : "mt-1.5")}>{hint}</p> : null}
    </div>
  );
}
