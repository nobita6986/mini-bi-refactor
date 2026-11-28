import { redirect } from "next/navigation";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { Card, CardHeader } from "@/components/ui/card";
import { decideSessionPageAccess } from "@/lib/auth/session-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Đổi mật khẩu — Hệ thống báo cáo HRP" };

export default async function ChangePasswordPage() {
  // P3-W09A-R1: use the request-scoped resolver shared with the AppShell and
  // Dashboard. Layout already called `resolveNavActorForAppShell` earlier in
  // the same render pass, so the React cache returns the same actor we would
  // otherwise fetch a second time. The shared resolver also runs H07 bounded
  // retry and pins `cookieWriteMode: "read-only"` for Server Components.
  const actor = await resolveActorForRequest().catch(() => null);

  switch (decideSessionPageAccess(actor)) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/dashboard/account/password");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW":
      break;
  }
  if (actor?.ok && actor.actor.partner_account) {
    redirect("/partner/change-password");
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Đổi mật khẩu
        </h1>
        <p className="mt-2 text-sm text-muted">
          Cập nhật mật khẩu cho tài khoản đang đăng nhập. Hệ thống sẽ xác minh lại
          mật khẩu hiện tại trước khi áp dụng thay đổi.
        </p>
      </header>
      <Card>
        <CardHeader
          title="Mật khẩu mới"
          description="Mật khẩu phải có tối thiểu 8 ký tự và không được trùng mật khẩu hiện tại."
        />
        <ChangePasswordForm destination="/login?next=/dashboard/account/password" />
      </Card>
    </main>
  );
}
