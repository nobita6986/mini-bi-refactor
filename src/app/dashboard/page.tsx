import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import {
  canViewCccdReviewReport,
  canViewDeepWorkforceReport,
  canViewDuplicateCccdReport,
  canViewOffboardingReport,
} from "@/lib/auth/direct-entry-page-access";
import { decideSessionPageAccess } from "@/lib/auth/session-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { fetchCutoverReporting } from "@/lib/reporting/p2-w04a-reporting-server";
import { fetchCutoverReportingOptions } from "@/lib/reporting/p2-w04a-options-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tổng quan tuyển dụng — Hệ thống báo cáo HRP" };

type SearchParams = Record<string, string | string[] | undefined>;
type DashboardTab = "general" | "deep" | "team" | "cccd-review" | "duplicate-cccd" | "offboarding";

function normalizedDashboardTab(value: string | string[] | undefined): DashboardTab | null {
  return typeof value === "string" &&
    (value === "general" || value === "deep" || value === "team" || value === "cccd-review" || value === "duplicate-cccd" || value === "offboarding") ? value : null;
}

function normalizedDashboardPath(params: SearchParams, tab: DashboardTab, removeSource: boolean): string {
  const query = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (key === "tab" || (removeSource && key === "source") || raw === undefined) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) query.append(key, value);
  }
  query.set("tab", tab);
  return "/dashboard?" + query.toString();
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();

  // P1.7-H04: /dashboard khong con duoc bao ve boi Basic Auth, nen phai xac thuc
  // session/actor TRUOC khi doc bat ky du lieu reporting nao.
  //
  // P3-W06A R1: dung `resolveActorForRequest` (React cache, request-scoped)
  // thay vi goi truc tiep `getDirectEntryActor`/`resolveSessionWithBoundedRetry`
  // o day. Layout (AppShell) da goi cung function o cung render pass → cache
  // hit → chi 1 lan Supabase getUser + 1 lan actor repository resolution cho
  // ca layout va page.
  const actor = await resolveActorForRequest().catch(() => null);

  switch (decideSessionPageAccess(actor)) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/dashboard");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW":
      break;
  }

  // ALLOW is returned only when actor.ok is true; narrow before the scoped fetch.
  if (!actor?.ok) {
    return <TemporaryUnavailable />;
  }
  if (actor.actor.partner_account) {
    redirect(
      actor.actor.partner_account.must_change_password ||
        actor.actor.partner_account.account_state === "ACTIVE_MUST_CHANGE_PASSWORD"
        ? "/partner/change-password"
        : "/partner",
    );
  }

  const params = await searchParams;
  const rawTab = params.tab;
  const tab = normalizedDashboardTab(rawTab);
  const sourcePresent = params.source !== undefined;
  if (rawTab !== undefined && tab === null) {
    redirect(normalizedDashboardPath(params, "general", false));
  }
  // P3.1-HF-R3-R1: the CCCD report tab is server-gated. An unauthorized deep link is
  // normalized back to the general tab; the CCCD API/RPC still enforces independently.
  const canViewCccdReview = canViewCccdReviewReport(actor);
  if (tab === "cccd-review" && !canViewCccdReview) {
    redirect(normalizedDashboardPath(params, "general", false));
  }
  const canViewDuplicateCccd = canViewDuplicateCccdReport(actor);
  if (tab === "duplicate-cccd" && !canViewDuplicateCccd) {
    redirect(normalizedDashboardPath(params, "general", false));
  }
  const canViewOffboarding = canViewOffboardingReport(actor.actor);
  if (tab === "offboarding" && !canViewOffboarding) {
    redirect(normalizedDashboardPath(params, "general", false));
  }
  const canViewDeep = canViewDeepWorkforceReport(actor);
  if (tab === "deep" && !canViewDeep) {
    redirect(normalizedDashboardPath(params, "general", false));
  }
  // `source` is a general-dashboard filter; the deep, team and CCCD tabs never consume it.
  if ((tab === "deep" || tab === "team" || tab === "cccd-review" || tab === "duplicate-cccd" || tab === "offboarding") && sourcePresent) {
    redirect(normalizedDashboardPath(params, tab, true));
  }
  const [report, options] = await Promise.all([
    fetchCutoverReporting(params, actor.actor),
    fetchCutoverReportingOptions(actor.actor),
  ]);
  // P3-W06C: the dashboard audience comes from the DB-authoritative W05A scoped
  // payload, never from a UI role. A failed read passes null so the view fails
  // closed to the narrowest scope instead of claiming the company-wide one.
  return (
    <DashboardView
      report={report}
      optionsResult={options}
      audience={report.ok ? report.audience : null}
      canViewCccdReview={canViewCccdReview}
      canViewDuplicateCccd={canViewDuplicateCccd}
      canViewOffboarding={canViewOffboarding}
    />
  );
}
