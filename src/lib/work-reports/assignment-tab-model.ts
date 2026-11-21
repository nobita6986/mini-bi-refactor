/**
 * WP13 Q1 — Pure query/tab contract for `/work-reports/assignments`.
 * Keeps WorkReportsModuleNav, AssignmentManager, and server page `searchParams`
 * synchronized on deep links, top-menu navigation, and browser Back/Forward.
 */

export type WorkReportAssignmentSubTab = "assignments" | "groups";

export function parseWorkReportAssignmentTab(
  value: string | string[] | null | undefined,
): WorkReportAssignmentSubTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "groups" ? "groups" : "assignments";
}

export function buildWorkReportAssignmentTabHref(
  tab: WorkReportAssignmentSubTab,
): string {
  return tab === "groups"
    ? "/work-reports/assignments?tab=groups"
    : "/work-reports/assignments";
}
