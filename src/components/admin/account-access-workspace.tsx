"use client";

import Link from "next/link";
import { useRef, useState, type KeyboardEvent } from "react";

import {
  AccountGlobalRolesPanel,
  type AccountGlobalRolesFixtureSnapshot,
} from "@/components/admin/account-global-roles-panel";
import { AccountManager } from "@/components/admin/account-manager";
import { buttonClasses } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { cn } from "@/lib/utils";

export type AccountWorkspaceTab = "accounts" | "global-roles";

export function AccountAccessWorkspace({
  canManageGlobalRoles,
  initialTab = "accounts",
  initialAccountRef = null,
  initialGlobalRolesSnapshot,
}: {
  canManageGlobalRoles: boolean;
  initialTab?: AccountWorkspaceTab;
  initialAccountRef?: string | null;
  initialGlobalRolesSnapshot?: AccountGlobalRolesFixtureSnapshot;
}) {
  const [activeTab, setActiveTab] = useState<AccountWorkspaceTab>(initialTab);
  const [selectedAccountRef, setSelectedAccountRef] = useState<string | null>(initialAccountRef);
  const accountsTabRef = useRef<HTMLButtonElement | null>(null);
  const globalRolesTabRef = useRef<HTMLButtonElement | null>(null);

  const handleOpenGlobalRolesForAccount = (accountRef: string) => {
    setSelectedAccountRef(accountRef);
    setActiveTab("global-roles");
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const order: readonly AccountWorkspaceTab[] = ["accounts", "global-roles"];
    const currentIdx = order.indexOf(activeTab);
    let nextTab: AccountWorkspaceTab | null = null;

    if (event.key === "ArrowRight") {
      nextTab = order[(currentIdx + 1) % order.length];
    } else if (event.key === "ArrowLeft") {
      nextTab = order[(currentIdx - 1 + order.length) % order.length];
    } else if (event.key === "Home") {
      nextTab = order[0];
    } else if (event.key === "End") {
      nextTab = order[order.length - 1];
    }

    if (!nextTab) return;
    event.preventDefault();
    setActiveTab(nextTab);
    const targetRef = nextTab === "accounts" ? accountsTabRef.current : globalRolesTabRef.current;
    targetRef?.focus();
    if (typeof targetRef?.scrollIntoView === "function") {
      targetRef.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  const effectiveAccessHref = selectedAccountRef
    ? `/admin/access/effective?account=${encodeURIComponent(selectedAccountRef)}`
    : "/admin/access/effective";

  return (
    <PageShell dataTestId="account-access-workspace">
      <PageHeader
        eyebrow="Quản trị truy cập"
        title="Tài khoản truy cập & Vai trò toàn cục"
        description="Quản lý tài khoản đăng nhập, phân loại cá nhân/dùng chung/dịch vụ, liên kết hồ sơ nhân sự và gán vai trò toàn cục."
        actions={
          <Link
            href={effectiveAccessHref}
            className={buttonClasses({ variant: "secondary", size: "md" })}
          >
            Xem quyền hiệu lực
          </Link>
        }
      />

      <div className="border-b border-border">
        <div
          role="tablist"
          aria-label="Phân khu quản trị tài khoản"
          className="flex flex-nowrap gap-1 overflow-x-auto whitespace-nowrap"
        >
          <button
            ref={accountsTabRef}
            id="tab-accounts-overview"
            type="button"
            role="tab"
            aria-selected={activeTab === "accounts"}
            tabIndex={activeTab === "accounts" ? 0 : -1}
            onClick={() => setActiveTab("accounts")}
            onKeyDown={handleTabKeyDown}
            className={cn(
              "relative flex-none min-h-11 sm:min-h-10 px-4 text-sm font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              "aria-selected:text-primary after:pointer-events-none after:content-[''] after:absolute after:inset-x-0 after:bottom-0 after:border-b-[3px] after:border-transparent aria-selected:after:border-primary",
            )}
          >
            Tài khoản & Liên kết
          </button>
          <button
            ref={globalRolesTabRef}
            id="tab-accounts-global-roles"
            type="button"
            role="tab"
            aria-selected={activeTab === "global-roles"}
            tabIndex={activeTab === "global-roles" ? 0 : -1}
            onClick={() => setActiveTab("global-roles")}
            onKeyDown={handleTabKeyDown}
            className={cn(
              "relative flex-none min-h-11 sm:min-h-10 px-4 text-sm font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              "aria-selected:text-primary after:pointer-events-none after:content-[''] after:absolute after:inset-x-0 after:bottom-0 after:border-b-[3px] after:border-transparent aria-selected:after:border-primary",
            )}
          >
            Vai trò toàn cục
          </button>
        </div>
      </div>

      <div
        role="tabpanel"
        aria-labelledby="tab-accounts-overview"
        hidden={activeTab !== "accounts"}
      >
        {activeTab === "accounts" ? (
          <div className="space-y-4">
            <AccountManager embedded onOpenGlobalRoles={handleOpenGlobalRolesForAccount} />
          </div>
        ) : null}
      </div>

      <div
        role="tabpanel"
        aria-labelledby="tab-accounts-global-roles"
        hidden={activeTab !== "global-roles"}
      >
        {activeTab === "global-roles" ? (
          <AccountGlobalRolesPanel
            canManageGlobalRoles={canManageGlobalRoles}
            selectedAccountRef={selectedAccountRef}
            onSelectedAccountRefChange={setSelectedAccountRef}
            initialFixtureSnapshot={initialGlobalRolesSnapshot}
          />
        ) : null}
      </div>
    </PageShell>
  );
}
