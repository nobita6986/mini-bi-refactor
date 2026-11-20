import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareStable,
  formatOpaqueRef,
  isIsoDate,
  isNonEmptyId,
  isNonNegativeInteger,
  isRealCalendarDate,
  isValidInterval,
  isWithinInterval,
  normalizeReportingKey,
} from "./identity-shared.mjs";

test("identity-shared: isIsoDate and isRealCalendarDate reject bogus calendar dates", () => {
  assert.equal(isIsoDate("2026-11-21"), true);
  assert.equal(isIsoDate("21/11/2026"), false);
  assert.equal(isRealCalendarDate("2026-02-28"), true);
  assert.equal(isRealCalendarDate("2024-02-29"), true);
  assert.equal(isRealCalendarDate("2026-02-29"), false);
  assert.equal(isRealCalendarDate("2026-02-30"), false);
  assert.equal(isRealCalendarDate("2026-13-01"), false);
});

test("identity-shared: half-open interval [valid_from, valid_to) boundaries", () => {
  assert.equal(isValidInterval("2026-01-01", null), true);
  assert.equal(isValidInterval("2026-01-01", "2026-09-01"), true);
  assert.equal(isValidInterval("2026-09-01", "2026-09-01"), false);
  assert.equal(isValidInterval("2026-09-01", "2026-01-01"), false);
  assert.equal(isValidInterval("2026-02-30", null), false);

  assert.equal(isWithinInterval("2026-08-31", "2026-01-01", "2026-09-01"), true);
  assert.equal(isWithinInterval("2026-09-01", "2026-01-01", "2026-09-01"), false);
  assert.equal(isWithinInterval("2026-09-01", "2026-09-01", null), true);
  assert.equal(isWithinInterval("2026-08-31", "2026-09-01", null), false);
  assert.equal(isWithinInterval("bad-date", "2026-01-01", null), false);
});

test("identity-shared: normalizeReportingKey mirrors DB NFC + collapse whitespace + lowercase", () => {
  assert.equal(normalizeReportingKey("  Rec-Alpha  "), "rec-alpha");
  assert.equal(normalizeReportingKey("REC   ALPHA"), "rec alpha");
  assert.equal(normalizeReportingKey("   "), null);
  assert.equal(normalizeReportingKey(null), null);
});

test("identity-shared: id, count, stable sort, and opaque ref helpers", () => {
  assert.equal(isNonEmptyId("rcr_01"), true);
  assert.equal(isNonEmptyId("   "), false);
  assert.equal(isNonNegativeInteger(0), true);
  assert.equal(isNonNegativeInteger(7), true);
  assert.equal(isNonNegativeInteger(-1), false);
  assert.equal(isNonNegativeInteger(1.5), false);
  assert.equal(compareStable("a", "b"), -1);
  assert.equal(compareStable("a", "a"), 0);
  assert.equal(compareStable("b", "a"), 1);
  assert.equal(formatOpaqueRef("team", 1), "team_01");
});
