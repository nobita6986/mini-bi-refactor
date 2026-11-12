import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGrant,
  parseRevoke,
  projectBatchGrantResult,
} from "./project-team-scope-contract.ts";

const TEAM = "66666666-6666-4666-8666-666666666666";
const KEY = "55555555-5555-4555-8555-555555555555";
const MAPPING = "77777777-7777-4777-8777-777777777777";
const TODAY_VN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

test("grant request accepts one bounded batch and rejects all client OCC/date fields", () => {
  const request = {
    team_id: TEAM, project_ids: ["project-a", "project-b"],
    reason: "mapping batch", idempotency_key: KEY,
  };
  assert.deepEqual(parseGrant(request), { ok: true, value: request });
  for (const reason of [undefined, null, "", "  "]) {
    const body = { ...request };
    if (reason === undefined) delete body.reason;
    else body.reason = reason;
    assert.deepEqual(parseGrant(body), { ok: true, value: { ...request, reason: null } });
  }
  assert.equal(parseGrant({ ...request, reason: 123 }).ok, false);
  assert.equal(parseGrant({ ...request, reason: "x".repeat(4001) }).ok, false);
  for (const extra of [
    { expected_pair_version: 0 },
    { expected_version: 1 },
    { capability: "entry_admin" },
    { scope: "all" },
    { effective_from: "2020-01-01" },
  ]) {
    assert.deepEqual(parseGrant({ ...request, ...extra }),
      { ok: false, code: "PROJECT_TEAM_SCOPE_INVALID" });
  }
  assert.equal(parseGrant({ ...request, project_ids: [] }).ok, false);
  assert.equal(parseGrant({ ...request, project_ids: Array.from({ length: 101 }, (_, i) => `p${i}`) }).ok, false);
  assert.equal(parseGrant({ ...request, project_ids: ["project-a", "project-a"] }).ok, false);
});

test("revoke request has no client version and requires a real calendar date", () => {
  const request = {
    mapping_id: MAPPING, effective_to: TODAY_VN,
    reason: "close mapping", idempotency_key: KEY,
  };
  assert.deepEqual(parseRevoke(request), { ok: true, value: request });
  for (const reason of [undefined, null, "", "  "]) {
    const body = { ...request };
    if (reason === undefined) delete body.reason;
    else body.reason = reason;
    assert.deepEqual(parseRevoke(body), { ok: true, value: { ...request, reason: null } });
  }
  assert.equal(parseRevoke({ ...request, reason: 123 }).ok, false);
  assert.equal(parseRevoke({ ...request, reason: "x".repeat(4001) }).ok, false);
  assert.equal(parseRevoke({ ...request, expected_pair_version: 3 }).ok, false);
  assert.equal(parseRevoke({ ...request, effective_to: "2024-02-29" }).ok, false);
  assert.equal(parseRevoke({ ...request, effective_to: "2026-02-29" }).ok, false);
  assert.equal(parseRevoke({ ...request, effective_to: "2026-13-01" }).ok, false);
});

test("batch result projection is exact-key and rejects raw or malformed DB fields", () => {
  const result = {
    team_id: TEAM,
    effective_from: "2026-10-15",
    created: [{
      mapping_id: MAPPING, project_id: "project-a", team_id: TEAM,
      valid_from: "2026-10-15", valid_to: null, version: 1, created: true,
    }],
    skipped: [{
      project_id: "project-b", status: "ALREADY_EFFECTIVE",
      mapping_id: "88888888-8888-4888-8888-888888888888", version: 4,
    }],
  };
  assert.deepEqual(projectBatchGrantResult(result), result);
  assert.equal(projectBatchGrantResult({
    ...result, created: [{ ...result.created[0], raw_error: "secret" }],
  }), null);
  assert.equal(projectBatchGrantResult({
    ...result, skipped: [{ ...result.skipped[0], version: 0 }],
  }), null);
  assert.equal(projectBatchGrantResult({ ...result, internal_pair_version: 99 }), null);
});
