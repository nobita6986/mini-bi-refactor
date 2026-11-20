/**
 * Shared HTTP same-origin CSRF guard (pure, testable, NOT server-only).
 *
 * Retained after AI Reports retirement because 33 non-AI API modules across
 * admin, auth, direct-entry, recruitment-locations, and work-reports import
 * `checkSameOriginRequest` from this path. AI worker token and message
 * sanitization helpers were removed with the AI Reports module.
 */

/**
 * CSRF/origin guard: mutation from browser must have Origin matching Host and not cross-site.
 */
export function checkSameOriginRequest({ origin, host, secFetchSite }) {
  if (typeof secFetchSite === "string" && secFetchSite.toLowerCase() === "cross-site") {
    return { ok: false, code: "CSRF_REJECTED", message: "cross-site request bị chặn" };
  }
  if (typeof origin !== "string" || origin.trim() === "") {
    return { ok: false, code: "CSRF_REJECTED", message: "thiếu Origin" };
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, code: "CSRF_REJECTED", message: "Origin không hợp lệ" };
  }
  if (typeof host !== "string" || host.trim() === "") {
    return { ok: false, code: "CSRF_REJECTED", message: "thiếu Host" };
  }
  if (parsed.host !== host) {
    return { ok: false, code: "CSRF_REJECTED", message: "Origin không khớp host" };
  }
  return { ok: true };
}
