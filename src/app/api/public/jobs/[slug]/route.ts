import {getPublicJob} from "@/lib/portal/jobs-reader";
import {portalJson} from "@/lib/portal/response";
export const dynamic="force-dynamic";
export async function GET(_request:Request,ctx:RouteContext<"/api/public/jobs/[slug]">) {
  const {slug}=await ctx.params;
  try {
    const data=await getPublicJob(slug);
    return data?portalJson({schema_version:1,data}):portalJson({code:"NOT_FOUND"},404);
  } catch { return portalJson({code:"PUBLIC_JOBS_UNAVAILABLE"},503); }
}
