/**
 * P2 Direct Entry reporting dimension hotfix - data-plane safety test (offline).
 *
 * Nothing here touches a database: the confirmation token and the operator flags
 * must refuse BEFORE any connection is opened, and check/dry-run must stay
 * non-committing by construction. The script is only executed WITHOUT a valid
 * confirmation token.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.resolve("scripts/p2-de-reporting-dimension-hotfix-repair.mjs");
const MODULE = path.resolve("scripts/lib/p2-de-reporting-dimension-repair.mjs");
const TOKEN = "P2_DE_DIM_REPAIR_APPLY";
const ACTOR = "00000000-0000-4000-8000-000000000041";
const REASON = "P2 DE reporting dimension metadata repair (safety test)";

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, P2_DE_DIM_REPAIR_CONFIRM: "", ...env },
  });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

test("P2-DE-dim repair: apply refuses without the confirmation token", () => {
  const result = run(["--apply", "--actor", ACTOR, "--reason", REASON]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr.includes("P2_DE_DIM_REPAIR_FAILED"), false,
    "a refusal must happen before any Production connection is attempted");
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: "apply", applied: false, reason: "CONFIRMATION_REQUIRED",
  });
});

test("P2-DE-dim repair: apply refuses a wrong or empty token", () => {
  for (const token of ["", "yes", "P2_DE_DIM_REPAIR", TOKEN.toLowerCase()]) {
    const result = run(["--apply", "--actor", ACTOR, "--reason", REASON], {
      P2_DE_DIM_REPAIR_CONFIRM: token,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr.includes("P2_DE_DIM_REPAIR_FAILED"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.applied, false);
    assert.equal(payload.reason, "CONFIRMATION_REQUIRED");
  }
});

test("P2-DE-dim repair: apply and dry-run require a valid actor and reason", () => {
  const cases = [
    { args: ["--apply", "--reason", REASON], problems: ["ACTOR_INVALID"] },
    { args: ["--apply", "--actor", ACTOR], problems: ["REASON_INVALID"] },
    { args: ["--apply", "--actor", "not-a-uuid", "--reason", REASON], problems: ["ACTOR_INVALID"] },
    { args: ["--apply", "--actor", ACTOR, "--reason", "  short  "], problems: ["REASON_INVALID"] },
    {
      args: ["--dry-run", "--actor", ACTOR, "--reason", "repair entry " + ACTOR],
      problems: ["REASON_CONTAINS_IDENTIFIER"],
    },
  ];
  for (const item of cases) {
    const result = run(item.args);
    assert.equal(result.status, 1, "must fail closed: " + item.args.join(" "));
    assert.equal(result.stderr.includes("P2_DE_DIM_REPAIR_FAILED"), false,
      "operator validation happens before any connection");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.applied, false);
    assert.equal(payload.reason, "OPERATOR_INVALID");
    for (const problem of item.problems) {
      assert.ok(payload.problems.includes(problem), "expected " + problem);
    }
  }
});

test("P2-DE-dim repair: exactly one mode flag is accepted", () => {
  const cases = [
    [],
    ["--check", "--dry-run"],
    ["--check", "--actor", ACTOR],
    ["--watch"],
    ["--apply", "extra"],
    ["--actor", ACTOR, "--reason", REASON],
  ];
  for (const args of cases) {
    const result = run(args);
    assert.equal(result.status, 1, "invalid arguments must fail: " + args.join(" "));
    assert.equal(result.stderr.includes("P2_DE_DIM_REPAIR_FAILED ARGUMENTS_INVALID"), true);
    assert.equal(result.stdout.trim(), "");
  }
});

test("P2-DE-dim repair: check and dry-run never commit", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.equal(source.includes("await client.query(\"begin read only\")"), true);
  assert.equal(source.includes("DRY_RUN_ROLLED_BACK"), true);
  assert.equal(source.includes("REFUSED_ROWS_PRESENT"), true,
    "a single refused row must block the whole apply");
  // A commit may only be reached after the acceptance gate.
  const commitAt = source.indexOf("await client.query(\"commit\")");
  const acceptanceAt = source.indexOf("if (!acceptance.ok)");
  assert.ok(acceptanceAt > 0 && commitAt > acceptanceAt,
    "commit must be guarded by the in-transaction acceptance check");
  const gateAt = source.indexOf("process.env[REPAIR_CONFIRM_ENV] !== REPAIR_CONFIRM_TOKEN");
  const connectAt = source.indexOf("await client.connect()");
  assert.ok(gateAt > 0 && gateAt < connectAt, "the token gate must run before connecting");
  const operatorAt = source.indexOf("if (operator && !operator.ok)");
  assert.ok(operatorAt > 0 && operatorAt < connectAt, "operator validation must run before connecting");
});

test("P2-DE-dim repair: audit carries the actor, capability and a real reason", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.equal(source.includes("REPAIR_ACTOR_SQL"), true);
  assert.equal(source.includes("REPAIR_REASON_SQL"), true);
  assert.equal(source.includes("ACTOR_NOT_AUTHORIZED"), true);
  const moduleSource = await readFile(MODULE, "utf8");
  assert.equal(moduleSource.includes("direct_entry_reason($1::uuid, $2::text)"), true,
    "the reason must come from the existing restricted-reason mechanism");
  assert.equal(moduleSource.includes("(auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields)"), true);
  assert.equal(moduleSource.includes("a.enabled"), true, "the actor must be an enabled account");
  assert.equal(moduleSource.includes("a.authz_managed"), true, "the actor must be authz_managed");
  assert.equal(moduleSource.includes("direct_entry_authz__internal_resolve_effective_grants(a.app_user_id)"), true,
    "actor capability resolution must use canonical effective grants");
  assert.equal(moduleSource.includes("direct_entry_capability_grants"), false,
    "actor resolution must not query legacy capability grants");
  assert.equal(moduleSource.includes("direct_entry_scope_grants"), false,
    "actor resolution must not query legacy scope grants");
  assert.equal(moduleSource.includes("REPAIR_CAPABILITIES"), true);
});

test("P2-DE-dim repair: the plan is evidence-only and never guesses a code", async () => {
  const moduleSource = await readFile(MODULE, "utf8");
  assert.equal(moduleSource.includes("recruiters.personnel_code") ||
    moduleSource.includes("r.personnel_code"), true);
  assert.equal(moduleSource.includes("m.vendor_id"), true);
  assert.equal(moduleSource.includes("REPORTING_KEY_PATTERN"), true);
  // The anchor is derived from the reporting window only.
  assert.equal(moduleSource.includes("and e.first_work_date >= public.direct_entry_reporting_cutoff()),\" +"), true,
    "the plan facts CTE must stay cutoff bounded");
  assert.equal(moduleSource.includes("min(f.first_work_date) as target_from"), true);
  assert.equal(moduleSource.includes("from public.direct_entries e where e.deleted_at is null"), false,
    "the anchor must not be taken from every non-deleted entry");
  // No literal business code may be baked into the executable logic (comments may
  // illustrate the shape of a code).
  const logic = moduleSource
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join("\n");
  for (const code of ["tu.vd", "thinhvuong.vd", "anhhn.td", "dhr.vd", "hainq.td", "nhieunt.td", "hao.vd"]) {
    assert.equal(logic.includes(code), false, "the module must not hardcode " + code);
  }
});
