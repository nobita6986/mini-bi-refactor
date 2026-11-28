import {parseJobsQuery} from "@/lib/portal/jobs-contract";
import {listPublicJobs} from "@/lib/portal/jobs-reader";
import {portalJson} from "@/lib/portal/response";

export const dynamic="force-dynamic";
export async function GET(request:Request) {
  const filters=parseJobsQuery(new URL(request.url).searchParams);
  if (!filters) return portalJson({code:"INVALID_QUERY"},400);
  try { return portalJson({schema_version:1,data:await listPublicJobs(filters)}); }
  catch { return portalJson({code:"PUBLIC_JOBS_UNAVAILABLE"},503); }
}
