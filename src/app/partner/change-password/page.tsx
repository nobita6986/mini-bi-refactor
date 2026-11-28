import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { decidePartnerPortalPageAccess } from "@/lib/partner/portal-access";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Đổi mật khẩu đối tác — HR Partner",
};

export default async function PartnerChangePasswordPage() {
  await connection();
  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decidePartnerPortalPageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
    allowMustChangePassword: true,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/partner/change-password");
    case "ACCOUNT_PENDING_ACTIVATION":
      redirect("/activate");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "PARTNER_FORBIDDEN":
      redirect("/dashboard/account/password");
    case "ALLOW":
      break;
  }

  const partner = actor?.ok ? actor.actor.partner_account : undefined;
  const mustChange = Boolean(
    partner &&
      (partner.must_change_password ||
        partner.account_state === "ACTIVE_MUST_CHANGE_PASSWORD"),
  );

  return (
    <PageShell className="max-w-2xl">
      <PageHeader
        eyebrow="Cổng đối tác · Bảo mật"
        title="Đổi mật khẩu"
        description="Cập nhật mật khẩu mới cho tài khoản đối tác của bạn."
        actions={
          !mustChange ? (
            <Link
              href="/partner/profile"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Về hồ sơ của tôi
            </Link>
          ) : null
        }
      />

      {mustChange ? (
        <Alert tone="warning" title="Yêu cầu đổi mật khẩu lần đầu">
          <p>
            Để bảo vệ tài khoản, bạn cần đổi mật khẩu khỏi mật khẩu khởi tạo trước khi xem dữ liệu hoặc chỉnh sửa hồ sơ.
          </p>
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Thiết lập mật khẩu mới"
          description="Mật khẩu mới tối thiểu 8 ký tự và không được trùng với mật khẩu hiện tại."
        />
        <ChangePasswordForm
          destination="/login?next=/partner/change-password"
          successRedirectTo="/partner"
          isFirstLogin={mustChange}
        />
      </Card>
    </PageShell>
  );
}
