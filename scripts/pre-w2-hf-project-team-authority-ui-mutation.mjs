/**
 * PRE-W2-HF Project↔Team Authority — API/UI mutation probes.
 * Every mutation runs the focused lane, is restored immediately, and is checked
 * byte-for-byte. Database authority mutations remain covered by the T1B script.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const API = "src/lib/admin/project-team-scope-api.ts";
const OPERATIONS = "src/components/direct-entry/project-operations.tsx";
const MAPPING_PAGE = "src/app/admin/catalog/project-team-scopes/page.tsx";
const MAPPING_NAV = "src/lib/admin/admin-navigation.ts";
const PAGE_ACCESS = "src/lib/auth/direct-entry-page-access.ts";

const API_LANE = ["--conditions=react-server", "--test", "src/lib/admin/project-team-scope-api.test.mjs"];
const UI_LANE = ["--test", "src/components/direct-entry/project-operations.test.mjs", "src/components/admin/project-team-scope-manager.test.mjs"];
const PAGE_NAV_LANE = ["--test", "src/lib/auth/direct-entry-page-access.test.mjs", "src/lib/navigation/registry-capability.test.mjs", "src/lib/admin/admin-navigation.test.mjs"];

function replace(source, from, to) {
  if (!source.includes(from)) throw new Error(`mutation anchor missing: ${from}`);
  return source.replace(from, to);
}
function replaceAll(source, from, to) {
  if (!source.includes(from)) throw new Error(`mutation anchor missing: ${from}`);
  return source.split(from).join(to);
}
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

const probes = [
  {
    label: "drop mapping API session guard",
    file: API,
    mutate: (s) => replace(s, "if (!session.actor.ok) {", "if (false && !session.actor.ok) {"),
    args: API_LANE,
  },
  {
    label: "drop mapping mutation CSRF guard",
    file: API,
    mutate: (s) => replace(s, 'if (!origin.ok) return fail("CSRF_REJECTED", 403);', 'if (false && !origin.ok) return fail("CSRF_REJECTED", 403);'),
    args: API_LANE,
  },
  {
    label: "trust authority fields from client",
    file: API,
    mutate: (s) => replace(s, 'if (!validateClientBusinessPayload(authorityCheck).ok)', 'if (false && !validateClientBusinessPayload(authorityCheck).ok)'),
    args: API_LANE,
  },
  {
    label: "show project-master controls without DB flag",
    file: OPERATIONS,
    mutate: (s) => replaceAll(replace(s,
      'const canManageProjectMaster = projects.length > 0\n    ? projects[0]?.can_manage_project_master === true\n    : state === "empty" && canManageProjectMasterForEmptyList;',
      "const canManageProjectMaster = true;"), "project.can_manage_project_master ? (", "true ? ("),
    args: UI_LANE,
  },
  {
    label: "show PM assignment controls without DB flag",
    file: OPERATIONS,
    mutate: (s) => replaceAll(s, "detail.can_assign_managers", "true"),
    args: UI_LANE,
  },
  {
    label: "admit catalog operator to mapping page",
    file: MAPPING_PAGE,
    mutate: (s) => replace(s, "decideAccountAccessPageAccess({ actor })", "decideAdminAreaAccess({ actor })"),
    args: PAGE_NAV_LANE,
  },
  {
    label: "admit catalog operator to mapping navigation",
    file: MAPPING_NAV,
    mutate: (s) => replace(s, 'id: "project-team-scopes", label: "Phân công Dự án ↔ Tổ đội", href: "/admin/catalog/project-team-scopes", visible: adminSecurityNavPredicate',
      'id: "project-team-scopes", label: "Phân công Dự án ↔ Tổ đội", href: "/admin/catalog/project-team-scopes", visible: adminAreaNavPredicate'),
    args: PAGE_NAV_LANE,
  },
  {
    label: "grant project-master fallback to Team Leader on empty list",
    file: PAGE_ACCESS,
    mutate: (s) => replace(s,
      'if (actor?.ok !== true) return false;\n  const all = actor.actor.scopes.some((scope) => scope.kind === "all");\n  return all && (actor.actor.capabilities.includes("catalog_master_manage") ||\n    actor.actor.capabilities.includes("entry_admin"));',
      "return true;"),
    args: PAGE_NAV_LANE,
  },
];

const originals = new Map();
for (const probe of probes) {
  if (!originals.has(probe.file)) originals.set(probe.file, await readFile(path.join(ROOT, probe.file)));
}
const initialHashes = new Map([...originals].map(([file, bytes]) => [file, hash(bytes)]));
const results = [];

async function laneIsRed(args) {
  try {
    await run(process.execPath, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    return false;
  } catch (error) {
    return error.code !== 0;
  }
}

try {
  for (const probe of probes) {
    const original = originals.get(probe.file).toString("utf8");
    try {
      await writeFile(path.join(ROOT, probe.file), probe.mutate(original), "utf8");
      const red = await laneIsRed(probe.args);
      results.push({ label: probe.label, red });
      console.log(`${red ? "RED   " : "GREEN "}${probe.label}`);
    } finally {
      await writeFile(path.join(ROOT, probe.file), originals.get(probe.file));
    }
  }
} finally {
  for (const [file, bytes] of originals) await writeFile(path.join(ROOT, file), bytes);
}

const restored = [...originals].every(([file]) => hash(readFileSync(path.join(ROOT, file))) === initialHashes.get(file));
const missed = results.filter((result) => !result.red);
console.log(`\nmutation probes red: ${results.length - missed.length}/${results.length}`);
console.log(`sources restored byte-for-byte: ${restored}`);
if (missed.length || !restored) process.exitCode = 1;
