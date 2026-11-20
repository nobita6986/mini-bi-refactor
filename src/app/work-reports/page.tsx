import { notFound } from "next/navigation";
import { MyObligations } from "@/components/work-reports/renderer/my-obligations";
import { WorkReportsShell } from "@/components/work-reports/work-reports-shell";
import { resolveWorkReportShellActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function WorkReportsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const actor = await resolveWorkReportShellActorForRequest().catch(() => null);
  return (
    <WorkReportsShell
      actor={actor}
      active="my"
      title="Cần làm"
      description="Các báo cáo được giao cho bạn trong kỳ hiện hành; lưu nháp hoặc nộp trước hạn."
    >
      <MyObligations />
    </WorkReportsShell>
  );
}
