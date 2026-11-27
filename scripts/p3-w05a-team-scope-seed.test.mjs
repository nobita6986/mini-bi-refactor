import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const SEED_MIGRATION = "20261008080000_p3_w05a_actor_scoped_reporting.sql";
const RETIRE_SEED_MIGRATION = "20261127050000_wp10_7_3d_drop_direct_entry_legacy_grants.sql";
const SEED_CALL = /^\s*select\s+public\.direct_entry_seed_team_scope_grants\s*\(/im;

test("W05A team-scope seed remains migration-only and is superseded by W01D", async () => {
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    const names = (await readdir(MIGRATION_DIR))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
      "migration inventory includes the #122 baseline");
    assert.equal(names.indexOf("20261009070000_p3_1_w01d_team_leader_lifecycle.sql"), 70, "migration chronology remains append-only");

    const sources = await Promise.all(names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })));
    const seedSource = sources.find((entry) => entry.name === SEED_MIGRATION);
    assert.ok(seedSource);
    assert.equal((seedSource.sql.match(new RegExp(SEED_CALL.source, "gim")) ?? []).length, 1);
    assert.equal(sources.slice(sources.indexOf(seedSource) + 1)
      .some((entry) => SEED_CALL.test(entry.sql)), false);

    const retireIndex = sources.findIndex(({ name }) => name === RETIRE_SEED_MIGRATION);
    assert.ok(retireIndex > 0, "3D migration must be present");
    for (const { sql } of sources.slice(0, retireIndex)) await db.exec(sql);

    const seedAcl = (await db.query(`
      select to_regprocedure('public.direct_entry_seed_team_scope_grants()') is not null as present,
             has_function_privilege('public',
               'public.direct_entry_seed_team_scope_grants()'::regprocedure, 'EXECUTE') as public_exec,
             has_function_privilege('anon',
               'public.direct_entry_seed_team_scope_grants()'::regprocedure, 'EXECUTE') as anon_exec,
             has_function_privilege('authenticated',
               'public.direct_entry_seed_team_scope_grants()'::regprocedure, 'EXECUTE') as authenticated_exec,
             has_function_privilege('service_role',
               'public.direct_entry_seed_team_scope_grants()'::regprocedure, 'EXECUTE') as service_exec
    `)).rows[0];
    assert.deepEqual(seedAcl, {
      present: true,
      public_exec: false,
      anon_exec: false,
      authenticated_exec: false,
      service_exec: false,
    });
    await db.exec(sources[retireIndex].sql);
    const { rows: [after] } = await db.query(
      "select to_regprocedure('public.direct_entry_seed_team_scope_grants()') is null as retired",
    );
    assert.equal(after.retired, true);
  } finally {
    await db.close();
  }
});
