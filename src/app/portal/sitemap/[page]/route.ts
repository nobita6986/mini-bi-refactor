import {jobSitemap} from "@/lib/portal/sitemap";
export const dynamic="force-dynamic";
export async function GET(_req:Request,ctx:RouteContext<"/portal/sitemap/[page]">){
  const {page}=await ctx.params;return /^[1-9]\d{0,8}$/.test(page)?jobSitemap(Number(page)):new Response(null,{status:404});
}
