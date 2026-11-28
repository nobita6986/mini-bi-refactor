export const PUBLIC_JOB_HOST = "vieclammienbac.com.vn";
export const PUBLIC_JOB_ORIGIN = "https://" + PUBLIC_JOB_HOST;

export function normalizePortalHost(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  return normalized || null;
}

export function portalRoute(
  host: string | null | undefined,
  path: string,
  preview: string | undefined,
): "staff" | "rewrite" | "public" | "deny" {
  const hostname = normalizePortalHost(host);
  const previewHosts = (preview ?? "")
    .split(",")
    .map((entry) => normalizePortalHost(entry))
    .filter((entry): entry is string => entry !== null);
  const isPublic =
    hostname !== null && (hostname === PUBLIC_JOB_HOST || previewHosts.includes(hostname));
  const segment = "[a-zA-Z0-9-]{1,120}";
  const vanity = new RegExp("^/viec-lam(?:/" + segment + ")?/?$");
  const publicApi = new RegExp("^/api/public/jobs(?:/" + segment + ")?/?$");
  if (!isPublic) {
    return /^\/(?:portal|viec-lam|api\/public\/jobs)(?:\/|$)/.test(path) ? "deny" : "staff";
  }
  if (
    path === "/" ||
    vanity.test(path) ||
    /^\/(?:gioi-thieu|lien-he)\/?$/.test(path) ||
    path === "/robots.txt" ||
    path === "/sitemap.xml" ||
    /^\/sitemap\/\d+$/.test(path)
  ) {
    return "rewrite";
  }
  if (
    publicApi.test(path) ||
    path.startsWith("/_next/static/") ||
    path === "/brand/hrpartner-logo.png" ||
    path === "/favicon.ico"
  ) {
    return "public";
  }
  return "deny";
}

export type PortalProxyDecision =
  | { kind: "staff" }
  | { kind: "deny"; status: 404; headers: Record<string, string> }
  | { kind: "rewrite"; rewritePathname: string; headers: Record<string, string> }
  | { kind: "next"; headers: Record<string, string> };

export function resolvePortalProxyDecision(input: {
  host: string | null | undefined;
  path: string;
  method: string;
  preview: string | undefined;
}): PortalProxyDecision {
  const { host, path, method, preview } = input;
  const action = portalRoute(host, path, preview);
  if (action === "staff") return { kind: "staff" };
  if (action === "deny" || !["GET", "HEAD"].includes(method.toUpperCase())) {
    return { kind: "deny", status: 404, headers: { "Cache-Control": "no-store" } };
  }
  const headers: Record<string, string> = {};
  if (!path.startsWith("/_next/static/")) {
    headers["Cache-Control"] = "no-store";
  }
  if (normalizePortalHost(host) !== PUBLIC_JOB_HOST) {
    headers["X-Robots-Tag"] = "noindex, nofollow";
  }
  if (action === "rewrite") {
    return {
      kind: "rewrite",
      rewritePathname: "/portal" + (path === "/" ? "/viec-lam" : path),
      headers,
    };
  }
  return { kind: "next", headers };
}
