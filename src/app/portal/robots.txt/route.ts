import { normalizePortalHost, PUBLIC_JOB_HOST, PUBLIC_JOB_ORIGIN } from "@/lib/portal/host";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const host = normalizePortalHost(request.headers.get("host"));
  const body =
    host && host !== PUBLIC_JOB_HOST
      ? "User-agent: *\nDisallow: /\n"
      : "User-agent: *\nAllow: /viec-lam\nDisallow: /api/\nSitemap: " +
        PUBLIC_JOB_ORIGIN +
        "/sitemap.xml\n";
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
  });
}
