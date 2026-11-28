import { redirect } from "next/navigation";

export default function VendorReferralsReportPage() {
  redirect("/admin/catalog/vendors?tab=referral-report");
}
