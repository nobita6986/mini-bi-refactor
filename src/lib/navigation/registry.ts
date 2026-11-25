/**
 * Navigation registry thuần (Server-safe, không 'use client').
 *
 * Mục đích:
 * - Đăng ký tất cả menu items mà App Shell render.
 * - Cung cấp metadata ổn định cho P1.6/P2/P3 (status, capability, visibility).
 * - Tách biệt "đăng ký" với "render" để có thể test thuần + filter ở client.
 *
 * Không phải authorization: `capability` chỉ là metadata, không thay thế RBAC.
 * P3 sẽ thay thế `capability` bằng check thật từ session/role.
 *
 * Current entries are filtered by viewport, feature availability and actor capability.
 * Pipeline Check (Google Sheets → n8n) đã được dự án loại bỏ và không còn
 * là product feature; route cũ vẫn được redirect server-side về /dashboard.
 */

import type { ComponentType, SVGProps } from "react";
import {
  Banknote,
  Building2,
  CalendarDays,
  ClipboardList,
  FileDiff,
  LayoutDashboard,
  NotebookPen,
  Receipt,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

import {
  resolveWorkReportManagementPath,
  type NavActorProjection,
} from "./registry-capability.ts";

/** Trạng thái vòng đời của một nav entry. */
export type NavStatus = "current" | "planned";

/**
 * Capability metadata cho P3. Hiện tại CHỈ là khai báo tĩnh;
 *   predicate thuần lọc theo actor đã resolve.
 *
 * - "any": mọi phiên đều có thể thấy.
 * - "owner" | "finance" | "hrp": token kế thừa từ W04 navigation
 *   (giữ tương thích ngược cho entry dự định mở rộng về sau).
 * - "admin_area": catalog operator (catalog_master_manage + effective all)
 *   hoặc Full Admin triple + effective all.
 * - "entry_own" | "entry_team" | "entry_admin": token lấy từ capability set
 *   của Direct Entry (src/lib/contracts/direct-entry-v1.ts). Direct Entry
 *   có thể được truy cập bởi bất kỳ trong ba actor trên, nên metadata
 *   được biểu diễn bằng MỘT trong các token này (chọn token đại diện
 *   cho actor có quyền rộng nhất — admin). App Shell hiện chưa filter;
 *   P3 sẽ dùng session thật để quyết định render/ẩn.
 */
export type NavCapability =
  | "any"
  | "owner"
  | "finance"
  | "hrp"
  | "entry_own"
  | "entry_team"
  | "entry_admin"
  | "project_admin"
  | "admin_area"
  | "attendance_report"
  | "worker_operations"
  | "change_requests"
  | "work_reports"
  | "work_report_management"
  | "work_report_assignments"
  | "work_report_reviews"
  | "work_report_analytics"
  | "workforce_offboarding"
  | "leave"
  | "leave_admin"
  | "salary_advances";

/** Icon component type — accept cả LucideIcon và custom SVG component. */
export type NavIcon = LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;

/** Visibility rules cho desktop sidebar và mobile Sheet. */
export type NavVisibility = {
  desktop: boolean;
  mobile: boolean;
};

export type NavGroupId = "my-work" | "finance" | "management";

export const NAV_GROUP_LABELS: Readonly<Record<NavGroupId, string>> = {
  "my-work": "Công việc của tôi",
  "finance": "Tài chính",
  "management": "Quản trị",
};

/** Một entry trong navigation registry. */
export type NavEntry = {
  /** Stable id — dùng làm React key và test selector. */
  id: string;
  /** Nhãn hiển thị (tiếng Việt). */
  label: string;
  /** Path mặc định trong App Router (e.g. "/dashboard"). */
  path: string;
  /** Các path chỉ khớp chính xác (không khớp nhánh con bất kỳ). */
  exactPaths?: readonly string[];
  /** Các nhánh path sở hữu bởi entry này (khớp chính xác hoặc prefix + "/"). Mặc định [path]. */
  matchPaths?: readonly string[];
  /** Mô tả ngắn cho a11y / tooltip. */
  description: string;
  /** Icon component từ lucide-react. */
  icon: NavIcon;
  /** Vòng đời. 'planned' KHÔNG render ở App Shell. */
  status: NavStatus;
  /**
   * Capability metadata cho P3 (chưa filter thật).
   * - "any" → ai cũng có.
   * - token khác → P3 đối chiếu session đã resolve.
   */
  capability: NavCapability;
  /** Menu cha; entry vẫn được lọc quyền độc lập trước khi nhóm. */
  group?: NavGroupId;
  /** Visibility cho desktop + mobile. */
  visibility: NavVisibility;
};

export type NavMenuEntry = Pick<NavEntry, "id" | "label" | "path" | "group">;
export type NavMenuNode =
  | { type: "entry"; entry: NavMenuEntry }
  | { type: "group"; id: NavGroupId; label: string; entries: NavMenuEntry[] };

/** Nhóm sau khi filter capability/feature flag, nên nhóm rỗng tự biến mất. */
export function groupNavEntries(entries: readonly NavMenuEntry[]): NavMenuNode[] {
  const result: NavMenuNode[] = [];
  for (const entry of entries) {
    if (!entry.group) {
      result.push({ type: "entry", entry });
      continue;
    }
    const group = result.find((item): item is Extract<NavMenuNode, { type: "group" }> =>
      item.type === "group" && item.id === entry.group
    );
    if (group) group.entries.push(entry);
    else result.push({
      type: "group",
      id: entry.group,
      label: NAV_GROUP_LABELS[entry.group],
      entries: [entry],
    });
  }
  return result;
}

/**
 * Registry nguồn — chỉ một chỗ để thêm/bớt menu.
 * Renderer (App Shell) chỉ map và filter; không hardcode nhãn ở component.
 *
 * Quy tắc thêm entry:
 * 1. status = 'current' thì App Shell render.
 * 2. status = 'planned' thì App Shell KHÔNG render (chỉ tồn tại trong registry
 *    cho P1.6/P2/P3 sẽ chuyển sang 'current' khi sẵn sàng).
 * 3. visibility phải được set rõ ràng (không mặc định) để tránh render ở
 *    viewport không mong muốn.
 */
export const NAV_ENTRIES: ReadonlyArray<NavEntry> = [
  {
    id: "dashboard",
    label: "Tổng quan",
    path: "/dashboard",
    description: "Báo cáo tổng quan theo dự án, người tuyển, HRP/Vendor.",
    icon: LayoutDashboard,
    status: "current",
    capability: "any",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "direct-entry",
    label: "Nhập liệu",
    path: "/direct-entry",
    description:
      "Nhập liệu trực tiếp cho HRP: hồ sơ, thanh toán, tài liệu. " +
      "Metadata cho biết actor có một trong các quyền entry_own | entry_team | entry_admin; " +
      "P3 sẽ lọc theo session thật.",
    icon: ClipboardList,
    status: "current",
    capability: "entry_admin",
    group: "my-work",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "worker-operations",
    label: "Người lao động",
    path: "/direct-entry/workers",
    description:
      "P2.5-W06: tra cứu người lao động theo ba quan hệ — hồ sơ bạn đã nhập, người bạn " +
      "tuyển, và người thuộc dự án bạn đang quản lý. CTA đề xuất thay đổi do server " +
      "allowed_actions quyết định; created_by/recruiter_id không tạo quyền.",
    icon: Users,
    status: "current",
    capability: "worker_operations",
    group: "my-work",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "change-requests",
    label: "Yêu cầu thay đổi",
    path: "/direct-entry/change-requests",
    description:
      "R2.2: theo dõi yêu cầu thay đổi đã gửi, xử lý yêu cầu chờ duyệt theo thẩm quyền " +
      "hiện tại và tra cứu lịch sử xử lý bất biến.",
    icon: FileDiff,
    status: "current",
    capability: "change_requests",
    group: "my-work",
    visibility: { desktop: false, mobile: false },
  },
  {
    id: "work-reports",
    label: "Báo cáo của tôi",
    path: "/work-reports",
    exactPaths: ["/work-reports"],
    matchPaths: ["/work-reports/my-reports"],
    description:
      "Tạo, nộp và tra cứu báo cáo công việc được giao theo capability và resource scope do server xác nhận.",
    icon: NotebookPen,
    status: "current",
    capability: "work_reports",
    group: "my-work",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "leave",
    label: "Nghỉ phép của tôi",
    path: "/leave",
    description:
      "Theo dõi quỹ phép cá nhân, tạo đơn xin nghỉ cả ngày hoặc nửa ngày sáng/chiều, duyệt phép theo cấp quản lý và báo cáo chốt công phép tháng.",
    icon: CalendarDays,
    status: "current",
    capability: "leave",
    group: "my-work",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "recruitment-posts",
    label: "Tin tuyển dụng",
    path: "/recruitment-posts",
    description:
      "Tra cứu tin tuyển dụng đang hiệu lực theo dự án, khu công nghiệp và hình thức tuyển dụng.",
    icon: ClipboardList,
    status: "current",
    capability: "any",
    group: "my-work",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "finance",
    label: "Công nợ Vendor",
    path: "/finance",
    description:
      "Theo dõi công nợ, tạm ứng, sổ cái, đối soát và chứng từ tài chính Vendor theo quyền được máy chủ xác nhận.",
    icon: Receipt,
    status: "current",
    capability: "finance",
    group: "finance",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "salary-advances",
    label: "Ứng lương",
    path: "/salary-advances",
    description:
      "Tạo đề nghị ứng lương cho người lao động thuộc dự án, xử lý phê duyệt/từ chối và đối chiếu ảnh NLĐ nhận tiền mặt theo phân quyền máy chủ.",
    icon: Banknote,
    status: "current",
    capability: "salary_advances",
    group: "finance",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "project-operations",
    label: "Dự án",
    path: "/direct-entry/projects",
    description:
      "P2.5-W06A: quản lý dự án (tạo, đổi tên, ngừng/kích hoạt) và gán/thu hồi " +
      "quản lý dự án. Capability 'project_admin' ánh xạ projectAdminNavPredicate " +
      "(entry_admin ∧ effective all scope) đúng DB W02; chỉ là metadata hiển thị — " +
      "quyền thật do RPC admin enforce.",
    icon: Building2,
    status: "current",
    capability: "project_admin",
    group: "management",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "leave-admin",
    label: "Quản trị nghỉ phép",
    path: "/leave/admin",
    description:
      "Cấu hình chính sách, hồ sơ, số dư đầu kỳ và xem báo cáo nghỉ phép trong phạm vi được cấp quyền.",
    icon: CalendarDays,
    status: "current",
    capability: "leave_admin",
    group: "management",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "work-report-management",
    label: "Quản lý báo cáo",
    path: "/work-reports/assignments",
    matchPaths: [
      "/work-reports/assignments",
      "/work-reports/reviews",
      "/work-reports/analytics",
      "/work-reports/templates",
      "/work-reports/delegations",
    ],
    description:
      "Giao việc, duyệt, theo dõi, quản lý mẫu và ủy quyền báo cáo công việc theo quyền được cấp.",
    icon: ClipboardList,
    status: "current",
    capability: "work_report_management",
    group: "management",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "attendance-report",
    label: "Báo cáo chấm công",
    path: "/admin/attendance",
    description:
      "Tra cứu lịch sử check-in GPS, ảnh chụp, khoảng cách và ghi chú chấm công theo thẩm quyền Admin/BoD.",
    icon: CalendarDays,
    status: "current",
    capability: "attendance_report",
    group: "management",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "admin",
    label: "Quản trị hệ thống",
    path: "/admin",
    description: "Quản lý danh mục nhân sự và các thiết lập quản trị được cấp quyền.",
    icon: ShieldCheck,
    status: "current",
    capability: "admin_area",
    group: "management",
    visibility: { desktop: true, mobile: true },
  },
];

/**
 * P2.5-W06A: moi route thuoc khu vực Direct Entry (ke ca /direct-entry/projects)
 * deu bi gate boi cung flag DIRECT_ENTRY_UI_ENABLED.
 */
export function isDirectEntryRoute(entry: NavEntry): boolean {
  return entry.path === "/direct-entry" || entry.path.startsWith("/direct-entry/");
}

/** Chỉ các entry hiện hành (status = 'current'). */
export const CURRENT_NAV_ENTRIES: ReadonlyArray<NavEntry> = NAV_ENTRIES.filter(
  (e) => e.status === "current"
);

/** Lọc theo viewport và cờ hiển thị server-side của Direct Entry. */
export function entriesForViewport(
  viewport: "desktop" | "mobile",
  directEntryEnabled: boolean,
): ReadonlyArray<NavEntry> {
  return CURRENT_NAV_ENTRIES.filter((entry) =>
    entry.visibility[viewport] && (!isDirectEntryRoute(entry) || directEntryEnabled)
  );
}

/**
 * P3-W06A: filter cùng registry theo viewport + capability predicate từ session thật.
 *
 * - Nếu `actor === null`: chỉ `any` còn hiện (Dashboard). Direct Entry / AI / admin ẩn.
 * - Nếu `actor` đã resolve: predicate tương ứng với `entry.capability` quyết định.
 * - KHÔNG tạo registry thứ hai; tái sử dụng toàn bộ `NAV_ENTRIES` + `CURRENT_NAV_ENTRIES`.
 * - KHÔNG dùng role name / email / env làm quyền.
 *
 * P3-W06A R1:
 * - Viewport + visibility là trách nhiệm của `filterEntriesForActor` (filter
 *   `entry.visibility[viewport]`). Caller KHÔNG cần truyền `viewport` /
 *   `entryVisibleInViewport` vào predicate.
 * - Capability là trách nhiệm của `decide` (đóng gói `decideNavEntryVisibility`
 *   với `actor` đã biết + capability key).
 * - `decide` nhận `NavEntry` để có thể xét capability key + bất kỳ metadata
 *   nào trong entry (kể cả visibility) nếu cần.
 *
 * Hàm này sống cùng `entriesForViewport` cũ để test cũ vẫn xanh; AppShell sẽ
 * dùng phiên bản này từ P3-W06A trở đi.
 */
export function filterEntriesForActor(input: {
  viewport: "desktop" | "mobile";
  directEntryEnabled: boolean;
  actor: {
    capabilities: readonly string[];
    scopes: readonly { kind: "own" | "team" | "all" }[];
  } | null;
  decide: (entry: NavEntry) => boolean;
}): ReadonlyArray<NavEntry> {
  return CURRENT_NAV_ENTRIES.filter((entry) => {
    if (!entry.visibility[input.viewport]) return false;
    if (isDirectEntryRoute(entry) && !input.directEntryEnabled) return false;
    if (input.actor === null && entry.id !== "dashboard") return false;
    return input.decide(entry);
  });
}

/**
 * Chuyển danh sách NavEntry đã lọc thành payload serializable tối thiểu truyền xuống Client Nav,
 * đồng thời áp đích động W1 cho mục `work-report-management`.
 * Không bao giờ gửi grants, source IDs, capabilities, scopes hay PII xuống client.
 */
export function projectNavMenuEntries(
  entries: readonly NavEntry[],
  actor: NavActorProjection | null,
): NavMenuEntry[] {
  const workReportManagementPath = resolveWorkReportManagementPath(actor);
  return entries.map(({ id, label, path, group }) => ({
    id,
    label,
    path:
      id === "work-report-management" && workReportManagementPath
        ? workReportManagementPath
        : path,
    group,
  }));
}

function normalizeMatchPathname(rawPath: string): string {
  const withoutHash = rawPath.split("#")[0] ?? rawPath;
  const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

/**
 * Tìm entry sở hữu path theo quy tắc cụ thể nhất trên toàn registry (A1/A2 bước 1):
 * - Khớp chính xác (`exactPaths` hoặc `matchPaths` / `[path]`) thắng trước.
 * - Nếu không có khớp chính xác, chọn entry có prefix trong `matchPaths ?? [path]`
 *   dài nhất (khớp `prefix + "/"`).
 * - Entry có `exactPaths` chỉ khớp chính xác các path đó (vd. `/work-reports` chỉ khớp
 *   trang cá nhân, không bao trọn nhánh quản lý `/work-reports/templates` hay `/delegations`).
 */
export function findEntryByPath(rawPath: string): NavEntry | undefined {
  const path = normalizeMatchPathname(rawPath);
  for (const entry of CURRENT_NAV_ENTRIES) {
    if (entry.exactPaths?.includes(path)) return entry;
    const branchPaths = entry.matchPaths ?? (entry.exactPaths ? [] : [entry.path]);
    if (branchPaths.includes(path)) return entry;
  }
  let best: { entry: NavEntry; prefixLength: number } | undefined;
  for (const entry of CURRENT_NAV_ENTRIES) {
    const branchPaths = entry.matchPaths ?? (entry.exactPaths ? [] : [entry.path]);
    for (const prefix of branchPaths) {
      if (
        path.startsWith(prefix + "/") &&
        (!best || prefix.length > best.prefixLength)
      ) {
        best = { entry, prefixLength: prefix.length };
      }
    }
  }
  return best?.entry;
}

/**
 * Shared A1/A2 matcher dùng chung cho DesktopNav, MobileNav và ActivePageLabel:
 * 1) Xác định mục sở hữu thực sự của `pathname` theo nhánh cụ thể nhất trên registry.
 * 2) Chỉ trả về mục active nếu mục sở hữu đó nằm trong danh sách `visibleItems` đã lọc.
 * Khi mục sở hữu bị ẩn/không có quyền, trả về `undefined` — KHÔNG để prefix ngắn hơn
 * tô nhầm mục khác và KHÔNG lộ nhãn mục ẩn trong ActivePageLabel.
 */
export function findActiveNavEntry<T extends Pick<NavMenuEntry, "id">>(
  pathname: string | null | undefined,
  visibleItems: readonly T[],
): T | undefined {
  if (!pathname) return undefined;
  const owner = findEntryByPath(pathname);
  if (!owner) return undefined;
  return visibleItems.find((item) => item.id === owner.id);
}
