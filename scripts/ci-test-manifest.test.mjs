import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertZeroOrphanTests,
  discoverRepoTestFiles,
  NON_CI_CLASSIFIED_TESTS,
  TEST_MANIFEST_CATEGORIES,
} from "./ci-test-manifest.mjs";

function collectActiveCiTestFiles() {
  const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
  const rootCommands = pkg.scripts.test.split(/\s*&&\s*/).map((part) => {
    const match = /^pnpm (test:[a-zA-Z0-9._-]+)$/.exec(part.trim());
    assert.ok(match, `valid root test command: ${part}`);
    return match[1];
  });
  const files = new Set();
  for (const name of rootCommands) {
    const script = pkg.scripts[name];
    assert.equal(typeof script, "string", `missing script ${name}`);
    for (const part of script.split(/\s*&&\s*/)) {
      const tokens = part.trim().split(/\s+/);
      const idx = tokens.indexOf("--test");
      assert.ok(tokens[0] === "node" && idx >= 1 && idx < tokens.length - 1, `valid node --test in ${name}`);
      for (const f of tokens.slice(idx + 1)) {
        files.add(path.posix.normalize(f.replaceAll("\\", "/")));
      }
    }
  }
  return files;
}

test("R2.1 Zero-Orphan Test Manifest: every *.test.mjs file in src/ and scripts/ is either in active CI or explicitly classified", () => {
  const ciTestFiles = collectActiveCiTestFiles();
  const postgresTestFiles = new Set([
    "scripts/s0-t1-c-rpc-acl.test.mjs",
    "scripts/s0-a-schema-migrations-acl.test.mjs",
    "scripts/p3-1-w02a-concurrency.test.mjs",
    "scripts/pre-w2-hf-project-team-authority-concurrency.test.mjs",
    "scripts/w2-s1-stage-recovery-concurrency.test.mjs",
    "scripts/pre-w2-hf-draft-submission-delete-concurrency.test.mjs",
    "scripts/leave-management-wp1-concurrency.test.mjs",
    "scripts/w2s2-salary-advance-wp1-concurrency.test.mjs",
    "scripts/vfin-04-shared-advance-concurrency.test.mjs",
    "scripts/recruitment-location-catalog-concurrency.test.mjs",
    "scripts/recruitment-posts-concurrency.test.mjs",
    "scripts/wp1-s1-immediate-assignments-concurrency.test.mjs",
  ]);

  const summary = assertZeroOrphanTests({
    ciTestFiles,
    postgresTestFiles,
  });

  const allFiles = discoverRepoTestFiles();
  assert.equal(
    summary.activeCiTests + summary.nonCiClassifiedTests,
    allFiles.length,
    "active CI + classified non-CI must partition 100% of repository *.test.mjs files",
  );

  for (const [file, meta] of Object.entries(NON_CI_CLASSIFIED_TESTS)) {
    assert.ok(TEST_MANIFEST_CATEGORIES.includes(meta.category), `valid category for ${file}`);
    assert.ok(typeof meta.rationale === "string" && meta.rationale.length >= 15, `rationale for ${file}`);
  }

  // Verify fail-closed behavior when an unclassified test file is introduced:
  assert.throws(
    () =>
      assertZeroOrphanTests({
        ciTestFiles: new Set([...ciTestFiles].slice(1)),
        postgresTestFiles,
      }),
    /CI Zero-Orphan test manifest check failed/,
  );
});
