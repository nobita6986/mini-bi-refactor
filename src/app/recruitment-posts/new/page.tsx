import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { RecruitmentPostForm } from "@/components/recruitment-posts/recruitment-post-form";
import { resolveInternalBiPartnerBlock } from "@/lib/navigation/partner-page-guard";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { decideRecruitmentPostsPageAccess } from "@/lib/recruitment-posts/recruitment-post-ui-model";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tạo phiếu tuyển dụng — Hệ thống báo cáo HRP",
};

export default async function NewRecruitmentPostPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  await connection();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const rawCopyFrom = resolvedSearchParams?.copy_from;
  const copyFromBriefId = Array.isArray(rawCopyFrom)
    ? rawCopyFrom[0]
    : rawCopyFrom;
  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decideRecruitmentPostsPageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=%2Frecruitment-posts%2Fnew");
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
      return (
        <RecruitmentPostForm
          mode="create"
          copyFromBriefId={
            typeof copyFromBriefId === "string" ? copyFromBriefId : undefined
          }
          actorDisplayName={actor && actor.ok ? actor.actor.display_name : ""}
        />
      );
    }
  }
}
