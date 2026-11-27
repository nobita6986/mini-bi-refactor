import {
  adminAreaNavPredicate,
  adminSecurityNavPredicate,
  attendanceReportNavPredicate,
  recruitmentLocationCatalogNavPredicate,
  vendorReferrerNavPredicate,
  workerEditHistoryNavPredicate,
  type NavActorProjection,
  type NavCapabilityPredicate,
} from "../navigation/registry-capability.ts";
import { effectiveAccessAdminNavPredicate } from "./effective-access-page-guard.ts";

export type AdminSection = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
};

export type AdminSectionMenuItem =
  | { readonly type: "section"; readonly section: AdminSection }
  | {
      readonly id: "recruitment";
      readonly type: "group";
      readonly label: "Danh mục tuyển dụng";
      readonly sections: readonly AdminSection[];
    };

type AdminSectionConfig = AdminSection & {
  readonly visible: NavCapabilityPredicate;
};

export const ADMIN_SECTIONS: readonly AdminSectionConfig[] = [
  { id: "organization-persons", label: "Người dùng", href: "/admin/organization/persons", visible: adminSecurityNavPredicate },
  { id: "permission-groups", label: "Nhóm quyền", href: "/admin/access/groups", visible: effectiveAccessAdminNavPredicate },
  { id: "departments", label: "Phòng ban", href: "/admin/departments", visible: adminSecurityNavPredicate },
  { id: "personnel", label: "Hồ sơ tính công tuyển dụng", href: "/admin/catalog/personnel", visible: adminAreaNavPredicate },
  { id: "teams", label: "Tổ đội tuyển dụng", href: "/admin/catalog/teams", visible: (actor) => adminAreaNavPredicate(actor) && !adminSecurityNavPredicate(actor) },
  { id: "labor-types", label: "Loại hình lao động", href: "/admin/catalog/labor-types", visible: adminAreaNavPredicate },
  { id: "provinces", label: "Tỉnh/Thành", href: "/admin/catalog/provinces", visible: recruitmentLocationCatalogNavPredicate },
  { id: "industrial-parks", label: "Khu công nghiệp", href: "/admin/catalog/industrial-parks", visible: recruitmentLocationCatalogNavPredicate },
  { id: "project-team-scopes", label: "Phân công Dự án ↔ Tổ đội", href: "/admin/catalog/project-team-scopes", visible: adminSecurityNavPredicate },
  { id: "vendors", label: "Vendor (NCC)", href: "/admin/catalog/vendors", visible: (actor) => adminAreaNavPredicate(actor) || vendorReferrerNavPredicate(actor) },
  { id: "vendor-referrals", label: "Người giới thiệu Vendor", href: "/admin/vendor-referrals", visible: vendorReferrerNavPredicate },
  { id: "attendance", label: "Báo cáo chấm công", href: "/admin/attendance", visible: attendanceReportNavPredicate },
  { id: "worker-edit-history", label: "Lịch sử chỉnh sửa NLĐ", href: "/admin/worker-edit-history", visible: workerEditHistoryNavPredicate },
];

const RECRUITMENT_SECTION_IDS = new Set([
  "personnel",
  "teams",
  "labor-types",
  "provinces",
  "industrial-parks",
  "project-team-scopes",
  "vendors",
]);

export function groupAdminSections(sections: readonly AdminSection[]): AdminSectionMenuItem[] {
  const recruitmentSections = sections.filter((section) => RECRUITMENT_SECTION_IDS.has(section.id));
  const result: AdminSectionMenuItem[] = [];
  let recruitmentInserted = false;

  for (const section of sections) {
    if (RECRUITMENT_SECTION_IDS.has(section.id)) {
      if (!recruitmentInserted && recruitmentSections.length > 0) {
        result.push({
          type: "group",
          id: "recruitment",
          label: "Danh mục tuyển dụng",
          sections: recruitmentSections,
        });
        recruitmentInserted = true;
      }
      continue;
    }
    result.push({ type: "section", section });
  }

  return result;
}

export function isAdminSectionActive(pathname: string, href: string): boolean {
  const cleanPath = pathname.split("?")[0] ?? pathname;
  if (cleanPath === href || cleanPath.startsWith(`${href}/`)) {
    return true;
  }
  return false;
}

export function visibleAdminSections(actor: NavActorProjection | null): readonly AdminSection[] {
  if (!actor) return [];
  return ADMIN_SECTIONS
    .filter((section) => section.visible(actor))
    .map(({ id, label, href }) => ({ id, label, href }));
}
