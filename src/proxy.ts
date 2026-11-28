import { NextRequest, NextResponse } from "next/server";
import { resolvePortalProxyDecision } from "./lib/portal/host";

export function proxy(request: NextRequest) {
  const decision = resolvePortalProxyDecision({
    host: request.headers.get("host"),
    path: request.nextUrl.pathname,
    method: request.method,
    preview: process.env.PUBLIC_JOBS_PREVIEW_HOST,
  });
  if (decision.kind === "staff") return NextResponse.next();
  if (decision.kind === "deny") {
    return new NextResponse(null, { status: decision.status, headers: decision.headers });
  }
  let response: NextResponse;
  if (decision.kind === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = decision.rewritePathname;
    response = NextResponse.rewrite(url);
  } else {
    response = NextResponse.next();
  }
  for (const [key, value] of Object.entries(decision.headers)) {
    response.headers.set(key, value);
  }
  return response;
}
