#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { assertZeroOrphanTests } from "./ci-test-manifest.mjs";

const SHARD_COUNT = 6;
const POSTGRES_TARGET = "postgres";
const POSTGRES_TEST_FILES = new Set([
  "scripts/s0-t1-c-rpc-acl.test.mjs",
  "scripts/s0-a-schema-migrations-acl.test.mjs",
  "scripts/p3-1-w02a-concurrency.test.mjs",
  "scripts/pre-w2-hf-project-team-authority-concurrency.test.mjs",
  "scripts/w2-s1-stage-recovery-concurrency.test.mjs",
  "scripts/pre-w2-hf-draft-submission-delete-concurrency.test.mjs",
  "scripts/attendance-wp1-concurrency.test.mjs",
  "scripts/org-shell-01-departments-concurrency.test.mjs",
  "scripts/vfin-01-concurrency.test.mjs",
  "scripts/vfin-02-project-ledgers-concurrency.test.mjs",
  "scripts/vfin-04-shared-advance-concurrency.test.mjs",
  "scripts/leave-management-wp1-concurrency.test.mjs",
  "scripts/w2s2-salary-advance-wp1-concurrency.test.mjs",
  "scripts/offboarding-report-performance-pg.test.mjs",
  "scripts/recruitment-location-catalog-concurrency.test.mjs",
  "scripts/recruitment-posts-concurrency.test.mjs",
  "scripts/wp1-s1-immediate-assignments-concurrency.test.mjs",
  "scripts/wp3-person-account-org-concurrency.test.mjs",
]);
// shortcut: weights come from the latest successful main CI run; refresh when shard times drift.
const TEST_WEIGHTS = {
  "test:p3-w05a": 72.5,
  "test:p2.5-w02": 60.4,
  "test:p3-1-hf-r1-duplicate-cccd-submit-confirmation": 50.6,
  "test:pre-w2-hf-d3-a-account-personnel-db": 45.3,
  "test:p1.6-i04c2b": 34.5,
  "test:p2-de-dim-hotfix": 34.3,
  "test:p1.6-i04c3-s01": 32.9,
  "test:p1.6-w03": 28.7,
  "test:pre-w2-p1-worker-export-backend": 24.2,
  "test:p3-1-hf-duplicate-cccd-report": 23.3,
  "test:p1.6-w04-s04c-s03b3-r1": 22.7,
  "test:pre-w2-hf-project-team-authority-db": 22.4,
  "test:pre-w2-hf-d2-active-duplicate-cccd-semantics": 21.3,
  "test:p2.5-hf-create-rehire": 20.1,
  "test:p2.5-hf-r5": 19.8,
  "test:p2.5-w03": 19.4,
  "test:p2.5-w05": 17.8,
  "test:p2.5-hf-r2": 16.6,
  "test:main": 16.4,
  "test:p3-1-w02c-labor-type-catalog": 15.8,
  "test:p3-1-w01d-a2-leader-server": 15.3,
  "test:p1.6-w04-s04c-s02b": 13.3,
  "test:p1.6-w04-s04c-s02c": 13.3,
  "test:p3-1-w01c-a-team-catalog": 13.2,
  "test:p3-1-w02c-r2-labor-type-display": 13.2,
  "test:p3-1-w01b-personnel": 13.2,
  "test:p3-1-w01c-b-team-membership": 12.3,
  "test:p3-w07a-r2-contract-hotfix": 12.3,
  "test:p3-1-w02c-r3-own-draft-display": 12.1,
  "test:p3-1-w02b-vendor-catalog": 12.1,
  "test:p3-1-w03a-r2-account-read": 12,
  "test:p3-w05b-a-team-reporting": 12,
  "test:p3-1-w01d-a1a-leader-schema": 12,
  "test:t0-import": 11.8,
  "test:p3-1-w03a-app-user-lifecycle": 9.7,
  "test:p2.5-hf-r3": 9.4,
  "test:p2.5-w06a": 9.3,
  "test:pre-w2-hf-c-global-duplicate-cccd-read-access": 9.2,
  "test:p3-1-w01d-a1b2-leader-write": 8.8,
  "test:p3-w07b-project-scope": 8.7,
  "test:p3-1-hf-recruiter-alias": 8.3,
  "test:p3-1-w01a-capability-contract": 7.3,
  "test:p2.5-reviewer-hotfix": 7.1,
  "test:p1.6-w04-s03a": 6.9,
  "test:p2.5-hf-r1": 6.1,
  "test:p2.5-status-default": 5.3,
  "test:p3-1-w01d-a1b1-leader-read": 5.1,
  "test:p3-1-w02a-team-leader-project-manager": 5,
  "test:p3-w07a-r4": 4.7,
  "test:p3-w07a-r3-vendor-doc-upload": 4.6,
  "test:p1.6-i04c3-r3a": 4.3,
  "test:p3-1-w02c-ui-dynamic-catalog": 4,
  "test:r2-1": 8.5,
  "test:r2-2": 2.5,
  "test:f1-work-reports": 6.0,
  "test:f1-5-work-reports-wp1": 6.0,
  "test:f2-work-reports-wp3": 8.0,
  "test:work-reports-reader-contract": 7.0,
  "test:attendance-wp1": 9.0,
  "test:attendance-admin-report": 9.0,
  "test:offboarding-report": 9.0,
  "test:org-shell-01": 8.0,
  "test:org-shell-01-ui": 2.0,
  "test:vfin-01": 12.0,
  "test:vfin-01-ui": 2.5,
  "test:vfin-02": 14.0,
  "test:pre-wave2-cccd-review": 8.0,
  "test:leave-management-wp1": 10.0,
  "test:leave-management-wp2-ui": 2.0,
  "test:salary-advance-wp1": 11.0,
  "test:salary-advance-wp2-ui": 2.0,
  "test:attendance-monthly-matrix": 12.0,
  "test:recruitment-location-catalog": 9.0,
  "test:recruitment-posts": 14.0,
  "test:wp1-s1-immediate-assignments": 10.0,
  "test:wp2a-effective-access-shadow": 8.0,
  "test:wp3-person-account-org": 12.0,
  "test:wp4-org-person-admin-ui": 2.5,
};

const target = process.argv[2];
const shard = Number(target);
const listOnly = process.argv.includes("--list");

if (target !== POSTGRES_TARGET &&
    (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT)) {
  throw new Error(`Target must be an integer from 1 to ${SHARD_COUNT}, or postgres.`);
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const rootCommands = packageJson.scripts.test.split(/\s*&&\s*/).map((part) => {
  const match = /^pnpm (test:[a-zA-Z0-9._-]+)$/.exec(part.trim());
  if (match === null) {
    throw new Error(`Unsupported command in package.json scripts.test: ${part}`);
  }
  return match[1];
});

const seenTestInvocations = new Set();
let originalTestCount = 0;
let duplicateTestCount = 0;

const plannedCommands = rootCommands.map((name, index) => {
  const script = packageJson.scripts[name];
  if (typeof script !== "string") {
    throw new Error(`Test command is missing from package.json scripts: ${name}`);
  }

  const commands = script.split(/\s*&&\s*/).flatMap((part) => {
    const tokens = part.trim().split(/\s+/);
    const testFlagIndex = tokens.indexOf("--test");
    if (tokens[0] !== "node" || testFlagIndex < 1 || testFlagIndex === tokens.length - 1) {
      throw new Error(`Unsupported test command in package.json scripts.${name}: ${part}`);
    }

    const nodeArgs = tokens.slice(1, testFlagIndex);
    const testFiles = tokens.slice(testFlagIndex + 1).filter((testFile) => {
      originalTestCount += 1;
      const normalizedPath = path.posix.normalize(testFile.replaceAll("\\", "/"));
      const invocationKey = JSON.stringify([nodeArgs, normalizedPath]);
      if (seenTestInvocations.has(invocationKey)) {
        duplicateTestCount += 1;
        return false;
      }
      seenTestInvocations.add(invocationKey);
      return true;
    });

    return testFiles.length === 0
      ? []
      : [{ nodeArgs, testFiles }];
  });

  return { name, index, commands };
});

const uniqueTestCount = plannedCommands.reduce(
  (total, plan) => total + plan.commands.reduce(
    (commandTotal, command) => commandTotal + command.testFiles.length,
    0,
  ),
  0,
);

if (uniqueTestCount !== seenTestInvocations.size) {
  throw new Error("CI test de-duplication produced an inconsistent test plan.");
}

const normalizeTestPath = (testFile) => path.posix.normalize(testFile.replaceAll("\\", "/"));
const selectPlans = (predicate) => plannedCommands.flatMap((plan) => {
  const commands = plan.commands.flatMap((command) => {
    const testFiles = command.testFiles.filter(predicate);
    return testFiles.length === 0 ? [] : [{ ...command, testFiles }];
  });
  return commands.length === 0 ? [] : [{ ...plan, commands }];
});
const postgresPlans = selectPlans((testFile) => POSTGRES_TEST_FILES.has(normalizeTestPath(testFile)));
const pglitePlans = selectPlans((testFile) => !POSTGRES_TEST_FILES.has(normalizeTestPath(testFile)));
const countTests = (plans) => plans.reduce(
  (total, plan) => total + plan.commands.reduce(
    (commandTotal, command) => commandTotal + command.testFiles.length,
    0,
  ),
  0,
);
const postgresTestCount = countTests(postgresPlans);
const pgliteTestCount = countTests(pglitePlans);

if (postgresTestCount !== POSTGRES_TEST_FILES.size ||
    pgliteTestCount + postgresTestCount !== uniqueTestCount) {
  throw new Error("CI test split must cover every unique test exactly once.");
}

const allScheduledFiles = new Set(
  plannedCommands.flatMap((plan) =>
    plan.commands.flatMap((command) => command.testFiles.map(normalizeTestPath)),
  ),
);
assertZeroOrphanTests({
  ciTestFiles: allScheduledFiles,
  postgresTestFiles: POSTGRES_TEST_FILES,
});

const pgliteShards = Array.from({ length: SHARD_COUNT }, () => ({ plans: [], weight: 0 }));
for (const plan of [...pglitePlans].sort((left, right) =>
  (TEST_WEIGHTS[right.name] ?? 1) - (TEST_WEIGHTS[left.name] ?? 1) || left.index - right.index)) {
  const destination = pgliteShards.reduce((lightest, candidate) =>
    candidate.weight < lightest.weight ? candidate : lightest);
  destination.plans.push(plan);
  destination.weight += TEST_WEIGHTS[plan.name] ?? 1;
}

if (pgliteShards.reduce((total, item) => total + countTests(item.plans), 0) !== pgliteTestCount) {
  throw new Error("CI PGlite sharding produced an inconsistent test plan.");
}

const selected = target === POSTGRES_TARGET ? postgresPlans : pgliteShards[shard - 1].plans;

if (selected.length === 0) {
  throw new Error(`CI test shard ${shard} is empty.`);
}

const selectedCommandCount = selected.reduce(
  (total, plan) => total + plan.commands.length,
  0,
);
const selectedTestCount = selected.reduce(
  (total, plan) => total + plan.commands.reduce(
    (commandTotal, command) => commandTotal + command.testFiles.length,
    0,
  ),
  0,
);

console.log(
  `CI test plan: ${pgliteTestCount} PGlite and ${postgresTestCount} real PostgreSQL `
    + `file invocations; `
    + `${duplicateTestCount} exact duplicates removed from ${originalTestCount}`,
);
const targetLabel = target === POSTGRES_TARGET
  ? "Real PostgreSQL concurrency"
  : `PGlite shard ${shard}/${SHARD_COUNT}`;
console.log(`${targetLabel}: ${selected.length} package scripts, `
  + `${selectedCommandCount} node commands, ${selectedTestCount} file invocations`
  + (target === POSTGRES_TARGET ? "" : `, ${pgliteShards[shard - 1].weight.toFixed(1)}s estimated`));
if (listOnly) {
  for (const plan of selected) {
    for (const command of plan.commands) {
      console.log(`${plan.name}: node ${[...command.nodeArgs, "--test", ...command.testFiles].join(" ")}`);
    }
  }
  process.exit(0);
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  appendFileSync(summaryPath,
    `### ${targetLabel}\n\n| Test suite | Actual | Estimated | Result |\n`
      + "|---|---:|---:|---|\n", "utf8");
}

for (const plan of selected) {
  const startedAt = Date.now();
  const finishPlan = (result) => {
    if (!summaryPath) return;
    const actual = ((Date.now() - startedAt) / 1000).toFixed(1);
    const estimated = (TEST_WEIGHTS[plan.name] ?? 1).toFixed(1);
    appendFileSync(summaryPath,
      `| ${plan.name} | ${actual}s | ${estimated}s | ${result} |\n`, "utf8");
  };
  for (const command of plan.commands) {
    const args = [...command.nodeArgs, "--test", ...command.testFiles];
    console.log(
      `\n[CI ${targetLabel}] ${plan.name}: node ${args.join(" ")}`,
    );
    const result = spawnSync(process.execPath, args, { stdio: "inherit" });
    if (result.error) {
      finishPlan("error");
      throw result.error;
    }
    if (result.status !== 0) {
      finishPlan("failed");
      process.exit(result.status ?? 1);
    }
  }
  finishPlan("passed");
}
