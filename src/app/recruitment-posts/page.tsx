import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { RecruitmentPostFeedWorkspace } from "@/components/recruitment-posts/recruitment-post-feed-workspace";
import { resolveInternalBiPartnerBlock } from "@/lib/navigation/partner-page-guard";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import {
  decideRecruitmentPostsPageAccess,
  parseRecruitmentPostFeedTab,
} from "@/lib/recruitment-posts/recruitment-post-ui-model";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tin tuyển dụng — Hệ thống báo cáo HRP",
};

export default async function RecruitmentPostsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  await connection();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const initialTab = parseRecruitmentPostFeedTab(resolvedSearchParams?.tab);
  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decideRecruitmentPostsPageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=%2Frecruitment-posts");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW": {
      const partnerBlock = resolveInternalBiPartnerBlock(actor);
      if (partnerBlock === "REDIRECT_CHANGE_PASSWORD") {
        redirect("/partner/change-password");
      }
      if (partnerBlock === "ACCESS_DENIED") {
        return <AccessDenied />;
      }
      return <RecruitmentPostFeedWorkspace initialTab={initialTab} />;
    }
  }
}
