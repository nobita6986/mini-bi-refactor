import { Suspense, type ReactNode } from "react";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import {
  workReportAnalyticsPredicate,
  workReportAssignmentPredicate,
  workReportDelegationPredicate,
  workReportReviewPredicate,
  workReportTemplateManagePredicate,
  workReportViewPredicate,
  type NavActorProjection,
} from "@/lib/navigation/registry-capability";
import {
  WorkReportsModuleNav,
  type WorkReportsActiveKey,
  type WorkReportsNavLink,
  type WorkReportsSubNavLink,
} from "./work-reports-nav";

export function buildWorkReportsNavLinks(actor: NavActorProjection | null): readonly WorkReportsNavLink[] {
  const links: WorkReportsNavLink[] = [
    {
      href: "/work-reports",
      label: "Báo cáo của tôi",
      activeKey: "my-reports-root",
      matchKeys: ["my", "history"],
      subLinks: [
        { href: "/work-reports", label: "Cần làm", activeKey: "my" },
        { href: "/work-reports/my-reports", label: "Lịch sử", activeKey: "history" },
      ],
    },
  ];

  if (actor) {
    const canAssign = workReportAssignmentPredicate(actor);
    const canTrack = workReportAnalyticsPredicate(actor) || workReportViewPredicate(actor);
    if (canAssign || canTrack) {
      const managementSubLinks: WorkReportsSubNavLink[] = [];
      if (canAssign) {
        managementSubLinks.push(
          { href: "/work-reports/assignments", label: "Đợt giao", activeKey: "assignments" },
          {
            href: "/work-reports/assignments?tab=groups",
            label: "Nhóm nhận báo cáo",
            activeKey: "groups",
          },
        );
      }
      if (canTrack) {
        managementSubLinks.push({
          href: "/work-reports/analytics",
          label: "Theo dõi",
          activeKey: "analytics",
        });
      }
      links.push({
        href: managementSubLinks[0].href,
        label: "Quản lý báo cáo",
        activeKey: "management",
        matchKeys: ["assignments", "groups", "analytics"],
        subLinks: managementSubLinks,
      });
    }

    if (workReportReviewPredicate(actor)) {
      links.push({
        href: "/work-reports/reviews",
        label: "Cần duyệt",
        activeKey: "reviews",
        matchKeys: ["reviews"],
      });
    }

    const canManageTemplates = workReportTemplateManagePredicate(actor);
    const canDelegate = workReportDelegationPredicate(actor);
    if (canManageTemplates || canDelegate) {
      const settingsSubLinks: WorkReportsSubNavLink[] = [];
      if (canManageTemplates) {
        settingsSubLinks.push({
          href: "/work-reports/templates",
          label: "Mẫu báo cáo",
          activeKey: "templates",
        });
      }
      if (canDelegate) {
        settingsSubLinks.push({
          href: "/work-reports/delegations",
          label: "Ủy quyền",
          activeKey: "delegations",
        });
      }
      links.push({
        href: settingsSubLinks[0].href,
        label: "Thiết lập",
        activeKey: "settings",
        matchKeys: ["templates", "delegations"],
        subLinks: settingsSubLinks,
      });
    }
  }

  return links;
}

export function WorkReportsShell({
  actor = null,
  active,
  title,
  description,
  children,
}: {
  actor?: NavActorProjection | null;
  active?: WorkReportsActiveKey;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageShell>
      <PageHeader eyebrow="Báo cáo công việc" title={title} description={description} />
      <Suspense fallback={null}>
        <WorkReportsModuleNav active={active} links={buildWorkReportsNavLinks(actor)} />
      </Suspense>
      {children}
    </PageShell>
  );
}
