import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { derivePriorPeriodWindow } from "./p1-period-comparison.ts";
import { countActiveFilterCriteria } from "./p1-date-presets.ts";

test("CTV migration 20261128160000 obeys SQL hygiene, ACLs, and single-pass GROUPING SETS", () => {
  const migPath = path.resolve(
    process.cwd(),
    "supabase/migrations/20261128160000_reporting_collaborator_channel.sql",
  );
  const raw = readFileSync(migPath, "utf8");
  assert.equal(raw.includes("\r"), false, "migration must use LF only");
  assert.equal(raw.includes("@"), false, "migration must not contain @");
  assert.equal(/\bSAVEPOINT\b/i.test(raw), false);
  assert.equal(/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(raw), false);
  assert.equal(/\bbtree_gist\b/i.test(raw), false);
  assert.equal((raw.match(/^begin;/gm) ?? []).length, 1);
  assert.equal((raw.match(/^commit;/gm) ?? []).length, 1);

  // Drops stale internal overloads and keeps service_role grants locked to scoped_options + scoped_facts only
  assert.match(
    raw,
    /drop function if exists public\.direct_entry_reporting__internal_de_option_buckets\(jsonb\);/,
  );
  assert.match(
    raw,
    /drop function if exists public\.direct_entry_reporting__internal_scoped_facts_entries\(jsonb, date, date, text\);/,
  );
  assert.match(raw, /grouping sets\s*\([\s\S]*\(e\.collaborator_id\)/);
  assert.match(raw, /left join public\.collaborators c/);
  assert.match(raw, /'collaborator_id',\s*e\.collaborator_id/);
  assert.match(raw, /'collaborator_display',\s*c\.display_name/);
  assert.match(raw, /'recruitment_channel'/);
  assert.match(raw, /hrp_direct/);
  assert.match(raw, /hrp_ctv/);

  const serviceGrants = raw.match(/grant execute on function [^;]+to service_role;/g) ?? [];
  assert.equal(serviceGrants.length, 2);
  assert.ok(serviceGrants.some((g) => g.includes("direct_entry_reporting_scoped_options(uuid, uuid)")));
  assert.ok(serviceGrants.some((g) => g.includes("direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)")));

  // Vendor referrer report & Vendor Finance RPCs untouched
  assert.equal(raw.includes("direct_entry_vendor_referrer_monthly_report"), false);
  assert.equal(raw.includes("vendor_finance_"), false);
});

test("Collaborator filter propagates through active criteria counter and prior-period comparison", () => {
  assert.equal(
    countActiveFilterCriteria({
      from: "2026-10-01",
      to: "2026-10-15",
      provider: "hrp_ctv",
      collaborator: "CTV-01",
    }),
    3,
  );

  const window = derivePriorPeriodWindow({
    from: "2026-10-08",
    to: "2026-10-14",
    provider: "hrp_ctv",
    collaborator: "CTV-01",
  });
  assert.equal(window.applicable, true);
  if (window.applicable) {
    assert.equal(window.previousFilters.provider, "hrp_ctv");
    assert.equal(window.previousFilters.collaborator, "CTV-01");
  }
});
