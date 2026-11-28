/**
 * P2.5-HF-R5 - header identity control regression (source contract).
 *
 * The header shows exactly one account trigger (display_name + chevron). The
 * password-change and logout actions are inside the Radix DropdownMenu only.
 * The name comes from GET /api/auth/session; nothing is read from localStorage,
 * cookies, client role or a browser payload, and email/auth_subject are never
 * rendered.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = process.cwd();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link") return nextResolve("next/link.js", context);
    if (specifier === "next/navigation") return nextResolve("next/navigation.js", context);
    if (specifier.startsWith("@/")) {
      const target = path.join(ROOT, "src", specifier.slice(2));
      for (const ext of ["", ".ts", ".tsx", ".js"]) {
        try {
          return nextResolve(pathToFileURL(target + ext).href, context);
        } catch {
          // continue searching extensions
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx") || url.endsWith(".ts")) {
      const fileSource = readFileSync(new URL(url), "utf8");
      const { outputText } = ts.transpileModule(fileSource, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
        },
        fileName: url,
      });
      return { format: "module", shortCircuit: true, source: outputText };
    }
    return nextLoad(url, context);
  },
});

const { executeSessionLogout } = await import("./user-session-control.tsx");

const source = readFileSync(
  new URL("./user-session-control.tsx", import.meta.url),
  "utf8",
);
const shell = readFileSync(new URL("./app-shell.tsx", import.meta.url), "utf8");

/** Strip comments so prose can never satisfy or break a token assertion. */
function stripComments(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const code = stripComments(source);

test("HF-R5: header renders one account trigger backed by Radix DropdownMenu", () => {
  assert.match(source, /import \{ DropdownMenu \} from "radix-ui"/);
  assert.match(source, /<DropdownMenu\.Root>/);
  assert.match(source, /<DropdownMenu\.Trigger/);
  assert.match(source, /<DropdownMenu\.Content/);
});

test("HF-R5: password and logout are submenu items, never top-level header items", () => {
  const triggerIndex = source.indexOf("<DropdownMenu.Trigger");
  const contentIndex = source.indexOf("<DropdownMenu.Content");
  const passwordIndex = source.indexOf("/dashboard/account/password");
  const logoutCallIndex = source.indexOf("void logout()");
  assert.ok(triggerIndex > -1 && contentIndex > triggerIndex, "content follows the trigger");
  assert.ok(passwordIndex > contentIndex, "password link lives inside the menu content");
  assert.ok(logoutCallIndex > contentIndex, "logout is triggered from inside the menu content");
  assert.match(source, /Đổi mật khẩu/);
  assert.match(source, /Đăng xuất/);
  assert.equal(source.includes('href="/dashboard/account/password"'), true);
});

test("HF-R5: exactly one session request and no second profile endpoint", () => {
  const sessionCalls = code.match(/fetch\("\/api\/auth\/session"/g) ?? [];
  assert.equal(sessionCalls.length, 1, "one GET /api/auth/session request");
  assert.equal(code.includes("/api/auth/session/"), false);
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(code), false);
  assert.equal(/email|auth_subject|app_user_id/.test(code), false);
});

test("HF-R5: display_name is validated strictly and fails closed", () => {
  assert.match(source, /function readDisplayName/);
  assert.match(source, /typeof name !== "string"/);
  assert.match(source, /name !== name\.trim\(\)/);
  assert.match(source, /name\.length < 1 \|\| name\.length > 256/);
  // a non-200 or malformed payload clears any previous name
  assert.match(source, /setDisplayName\(null\)/);
  assert.match(source, /setState\("unavailable"\)/);
  assert.match(source, /setState\(res\.status === 401 \? "anon" : "unavailable"\)/);
});

test("HF-R5: trigger is accessible and mobile safe", () => {
  assert.match(source, /aria-label=\{"Tài khoản: " \+ displayName\}/);
  assert.match(source, /title=\{displayName\}/);
  assert.match(source, /h-11/);
  assert.match(source, /truncate/);
  assert.match(source, /aria-hidden/);
});

test("HF-R5: logout keeps the busy lock, delegates to executeSessionLogout, navigates on 204 and never leaks the error", async () => {
  assert.match(source, /if \(busy\) return;/);
  assert.match(source, /method: "POST", credentials: "same-origin"/);
  assert.match(source, /res\.status === 204/);
  const clearIdx = source.indexOf("notify.clear()");
  const replaceIdx = source.indexOf('router.replace("/login")');
  assert.ok(clearIdx > -1 && clearIdx < replaceIdx, "notify.clear() must run before router.replace('/login') on 204");
  assert.match(source, /router\.replace\("\/login"\)/);
  assert.match(source, /router\.refresh\(\)/);
  assert.match(source, /executeSessionLogout\(\{\s*notify,\s*router\s*\}\)/);
  assert.match(source, /role="alert"/);
  assert.match(source, /Không thể đăng xuất lúc này\. Vui lòng thử lại\./);
  const rawErrors = source.match(/res\.(text|json)\(\)/g) ?? [];
  assert.equal(rawErrors.length, 1, "only the session payload is parsed");

  const calls = [];
  const ok204 = await executeSessionLogout({
    fetchImpl: async (url, init) => {
      calls.push(`fetch:${url}:${init?.method}:${init?.credentials}`);
      return new Response(null, { status: 204 });
    },
    notify: { clear: () => calls.push("notify.clear") },
    router: {
      replace: (href) => calls.push(`router.replace:${href}`),
      refresh: () => calls.push("router.refresh"),
    },
  });
  assert.equal(ok204, true);
  assert.deepEqual(calls, [
    "fetch:/api/auth/logout:POST:same-origin",
    "notify.clear",
    "router.replace:/login",
    "router.refresh",
  ]);
});

test("HF-R5: the AppShell keeps rendering the control without a second request", () => {
  assert.match(shell, /UserSessionControl/);
  const calls = shell.match(/\/api\/auth\/session/g) ?? [];
  assert.equal(calls.length, 0, "AppShell must not fetch the session itself");
});

test("Partner Portal: user-session-control adapts menu links for partner_account safely", () => {
  assert.match(source, /function readPartnerAccount/);
  assert.match(source, /href="\/partner\/profile"/);
  assert.match(source, /href="\/partner\/change-password"/);
  assert.match(source, /Hồ sơ của tôi/);
  assert.match(source, /!partnerAccount\.must_change_password/);
});
