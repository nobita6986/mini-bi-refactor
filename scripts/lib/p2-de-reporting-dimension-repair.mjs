/**
 * P2 Direct Entry reporting dimension classification hotfix - shared repair plan.
 *
 * Root cause proven read-only against Production: the 17 imported facts carry a
 * canonical stored provider_type (6 hrp / 11 vendor) and a recruiter_id, but
 *   * recruiter_provider_memberships.valid_from = 2026-10-06 is AFTER their
 *     first_work_date (2026-10-02..2026-10-05), so
 *     direct_entry_reporting_recruiter_provider_key() finds no effective row;
 *   * recruiter_aliases has no row at all for those recruiters, so
 *     direct_entry_reporting_recruiter_alias_key() finds no reporting key.
 * Both helpers therefore return the '__unknown__' sentinel and the Dashboard
 * groups the rows under "Không xác định".
 *
 * The correction is derived from evidence that already exists in the database -
 * never from an assumption:
 *   * provider: the single membership row per recruiter must carry the same
 *     provider_type as every stored fact of that recruiter, and only its
 *     valid_from is re-dated;
 *   * recruiter key: HRP uses recruiters.personnel_code, Vendor uses
 *     recruiter_provider_memberships.vendor_id, written into the designed
 *     reporting vocabulary table recruiter_aliases.
 *
 * R1 (T0 review of d8d5caa) hardening:
 *   * the anchor date is the earliest first_work_date of the recruiter's facts
 *     INSIDE the reporting window (SUBMITTED, not deleted, >= cutoff) - Draft or
 *     out-of-window rows can never pull the timeline further back;
 *   * a derived reporting key that another recruiter already uses after the
 *     anchor date is refused instead of merging two people onto one key;
 *   * every audit row carries the operating actor (auth_subject + app_user_id),
 *     the capability actually held and a restricted reason_id;
 *   * the acceptance check compares the WHOLE window against the expected
 *     post-repair distribution, so a second run after a successful repair is a
 *     valid no-op instead of a failure.
 *
 * The module is pure except for SQL text: the CLI script and the DB regression
 * test execute the exact same statements.
 */

export const REPAIR_ACTION = "p2_de_reporting_dimension_repair";
export const REPAIR_CONFIRM_ENV = "P2_DE_DIM_REPAIR_CONFIRM";
export const REPAIR_CONFIRM_TOKEN = "P2_DE_DIM_REPAIR_APPLY";
// The audit capability is the one the operating account must actually hold.
export const REPAIR_CAPABILITIES = ["recruiter_master_manage", "entry_admin"];
export const MIN_REASON_LENGTH = 8;
export const MAX_REASON_LENGTH = 400;
export const UNKNOWN_KEY = "__unknown__";

// Business reporting codes are lowercase, dotted, no spaces. Anything else is
// refused instead of being copied into the vocabulary table.
export const REPORTING_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * One row per recruiter that owns at least one fact in the reporting window.
 * Every guard input is aggregated in SQL so the decision in deriveRepairPlan()
 * is made from one consistent snapshot; callers only ever print counts.
 */
export const REPAIR_PLAN_SQL = [
  "with facts as (" +
  "  select e.entry_id, e.recruiter_id, e.provider_type, e.first_work_date" +
  "    from public.direct_entries e" +
  "    join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
  "   where s.state = 'SUBMITTED' and e.deleted_at is null" +
  "     and e.first_work_date >= public.direct_entry_reporting_cutoff())," +
  " owners as (" +
  "  select f.recruiter_id," +
  "    count(*)::int as facts," +
  "    count(distinct f.provider_type)::int as stored_providers," +
  "    min(f.provider_type) as stored_provider," +
  "    min(f.first_work_date) as target_from," +
  "    max(f.first_work_date) as fact_to," +
  "    count(*) filter (where public.direct_entry_reporting_recruiter_provider_key(" +
  "      f.recruiter_id, f.first_work_date) = '__unknown__')::int as facts_unknown_provider," +
  "    count(*) filter (where public.direct_entry_reporting_recruiter_alias_key(" +
  "      f.recruiter_id, f.first_work_date) = '__unknown__')::int as facts_unknown_alias" +
  "    from facts f group by f.recruiter_id)," +
  " resolved as (" +
  "  select o.*," +
  "   (select count(*)::int from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id) as membership_rows," +
  "   (select m.membership_id::text from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id order by m.valid_from limit 1) as membership_id," +
  "   (select m.provider_type from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id order by m.valid_from limit 1) as membership_provider," +
  "   (select m.valid_from::text from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id order by m.valid_from limit 1) as membership_from," +
  "   (select m.valid_to::text from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id order by m.valid_from limit 1) as membership_to," +
  "   (select nullif(btrim(m.vendor_id), '') from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id order by m.valid_from limit 1) as membership_vendor_id," +
  "   (select count(*)::int from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id and m.provider_type <> o.stored_provider)" +
  "     as contradicting_memberships," +
  "   (select count(*)::int from public.recruiter_aliases al" +
  "     where al.recruiter_id = o.recruiter_id) as alias_rows," +
  "   (select nullif(btrim(r.personnel_code), '') from public.recruiters r" +
  "     where r.recruiter_id = o.recruiter_id) as personnel_code" +
  "    from owners o)," +
  " coded as (" +
  "  select r.*," +
  "   case when r.stored_provider = 'hrp' then r.personnel_code" +
  "        when r.stored_provider = 'vendor' then r.membership_vendor_id" +
  "        else null end as key_candidate" +
  "    from resolved r)" +
  " select c.recruiter_id::text as recruiter_id, c.facts, c.stored_providers," +
  "   c.stored_provider, c.target_from::text as target_from, c.fact_to::text as fact_to," +
  "   c.facts_unknown_provider, c.facts_unknown_alias, c.membership_rows, c.membership_id," +
  "   c.membership_provider, c.membership_from::text as membership_from," +
  "   c.membership_to::text as membership_to, c.membership_vendor_id," +
  "   c.contradicting_memberships, c.alias_rows, c.personnel_code, c.key_candidate," +
  "   (select count(*)::int from public.recruiter_aliases al" +
  "     where al.recruiter_id <> c.recruiter_id" +
  "       and al.reporting_key = c.key_candidate" +
  "       and (al.valid_to is null or c.target_from < al.valid_to)) as foreign_alias_conflicts" +
  "  from coded c" +
  " order by c.facts desc, c.recruiter_id",
].join("\n");

/**
 * Post-repair verification over the whole reporting window.
 */
export const REPAIR_VERIFY_SQL = [
  "select count(*)::int as facts_total," +
  "  count(*) filter (where public.direct_entry_reporting_recruiter_provider_key(" +
  "    e.recruiter_id, e.first_work_date) = '__unknown__')::int as provider_unknown," +
  "  count(*) filter (where public.direct_entry_reporting_recruiter_alias_key(" +
  "    e.recruiter_id, e.first_work_date) = '__unknown__')::int as recruiter_unknown" +
  "  from public.direct_entries e" +
  "  join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
  " where s.state = 'SUBMITTED' and e.deleted_at is null" +
  "   and e.first_work_date >= public.direct_entry_reporting_cutoff()",
].join("\n");

/**
 * Distribution over the whole reporting window, grouped exactly like the
 * projection does (key, not display).
 */
export const REPAIR_DISTRIBUTION_SQL = [
  "select public.direct_entry_reporting_recruiter_provider_key(" +
  "    e.recruiter_id, e.first_work_date) as provider_key," +
  "  public.direct_entry_reporting_recruiter_alias_key(" +
  "    e.recruiter_id, e.first_work_date) as recruiter_key," +
  "  count(*)::int as n" +
  "  from public.direct_entries e" +
  "  join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
  " where s.state = 'SUBMITTED' and e.deleted_at is null" +
  "   and e.first_work_date >= public.direct_entry_reporting_cutoff()" +
  " group by 1, 2 order by 1, 2",
].join("\n");

/**
 * Operator resolution: the account must exist, be enabled and actually hold one
 * of REPAIR_CAPABILITIES. Nothing is invented and nothing is escalated.
 */
export const REPAIR_ACTOR_SQL = [
  "select a.app_user_id::text as app_user_id, a.auth_subject::text as auth_subject," +
  "  (select g.capability" +
  "     from pg_catalog.jsonb_to_recordset(" +
  "       public.direct_entry_authz__internal_resolve_effective_grants(a.app_user_id)" +
  "     ) as g(capability text, scope_kind text, scope_id text)" +
  "    where g.capability in ('recruiter_master_manage', 'entry_admin')" +
  "    order by case g.capability when 'recruiter_master_manage' then 0 else 1 end" +
  "    limit 1) as capability" +
  "  from public.direct_entry_app_users a" +
  " where a.app_user_id = $1::uuid and a.enabled and coalesce(a.authz_managed, false)",
].join("\n");

/** Restricted reason for this operation, via the existing audited mechanism. */
export const REPAIR_REASON_SQL =
  "select public.direct_entry_reason($1::uuid, $2::text)::text as reason_id";

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function refusal(row, reason) {
  return { recruiter_id: row.recruiter_id, facts: Number(row.facts), reason };
}

/**
 * Pure decision function: returns the assignments to apply plus every refusal
 * with its reason, so a caller refuses loudly instead of guessing.
 */
export function deriveRepairPlan(rows) {
  const assignments = [];
  const refusals = [];
  const skipped = [];
  for (const row of rows) {
    const unknownProvider = Number(row.facts_unknown_provider);
    const unknownAlias = Number(row.facts_unknown_alias);
    if (unknownProvider === 0 && unknownAlias === 0) {
      skipped.push({ recruiter_id: row.recruiter_id, facts: Number(row.facts), reason: "already_resolved" });
      continue;
    }
    if (Number(row.stored_providers) !== 1) {
      refusals.push(refusal(row, "facts carry more than one stored provider_type"));
      continue;
    }
    if (Number(row.membership_rows) !== 1) {
      refusals.push(refusal(row, "recruiter must have exactly one provider membership row"));
      continue;
    }
    if (Number(row.contradicting_memberships) !== 0) {
      refusals.push(refusal(row, "membership provider contradicts the stored fact provider"));
      continue;
    }
    if (row.membership_provider !== row.stored_provider) {
      refusals.push(refusal(row, "membership provider does not match the stored fact provider"));
      continue;
    }
    if (isBlank(row.target_from)) {
      refusals.push(refusal(row, "no windowed fact to anchor the correction"));
      continue;
    }
    if (!isBlank(row.membership_to) && row.membership_to <= row.target_from) {
      refusals.push(refusal(row, "membership window ended before the facts"));
      continue;
    }
    // Only a recruiter with NO alias history may receive a derived reporting key:
    // an existing (even expired) alias history is deliberate vocabulary and must
    // never be extended by guessing what the code was at another date.
    if (Number(row.alias_rows) !== 0) {
      refusals.push(refusal(row, "recruiter already has a reporting alias history"));
      continue;
    }
    const reportingKey = isBlank(row.key_candidate) ? null : String(row.key_candidate).trim();
    if (reportingKey === null || !REPORTING_KEY_PATTERN.test(reportingKey)) {
      refusals.push(refusal(row, "no canonical reporting code available for this recruiter"));
      continue;
    }
    // The new alias is open-ended (valid_to = NULL), so any alias of ANOTHER
    // recruiter that still carries the same key after the anchor date would be
    // merged with this one. Refuse instead of picking a winner.
    if (Number(row.foreign_alias_conflicts) !== 0) {
      refusals.push(refusal(row, "reporting code is already used by another recruiter"));
      continue;
    }
    assignments.push({
      recruiter_id: row.recruiter_id,
      facts: Number(row.facts),
      facts_unknown_provider: unknownProvider,
      facts_unknown_alias: unknownAlias,
      stored_provider: row.stored_provider,
      membership_id: row.membership_id,
      membership_from: row.membership_from,
      membership_to: row.membership_to,
      target_from: row.target_from,
      reporting_key: reportingKey,
      reporting_key_source: row.stored_provider === "hrp"
        ? "recruiters.personnel_code"
        : "recruiter_provider_memberships.vendor_id",
      update_membership: row.membership_from > row.target_from,
      insert_alias: Number(row.alias_rows) === 0,
    });
  }
  // Two recruiters inside this batch must never be collapsed onto one code.
  const byKey = new Map();
  for (const assignment of assignments) {
    const list = byKey.get(assignment.reporting_key) ?? [];
    list.push(assignment);
    byKey.set(assignment.reporting_key, list);
  }
  const conflicting = new Set();
  for (const [key, list] of byKey) if (list.length > 1) conflicting.add(key);
  const accepted = [];
  for (const assignment of assignments) {
    if (conflicting.has(assignment.reporting_key)) {
      refusals.push({
        recruiter_id: assignment.recruiter_id,
        facts: assignment.facts,
        reason: "reporting code is claimed by more than one recruiter in this batch",
      });
      continue;
    }
    accepted.push(assignment);
  }
  return { assignments: accepted, refusals, skipped };
}

/** Counts-only view of a plan - safe to print (no UUID, no name, no PII). */
export function summariseRepairPlan(plan) {
  const byProvider = {};
  const byCode = {};
  let facts = 0;
  let membershipUpdates = 0;
  let aliasInserts = 0;
  for (const assignment of plan.assignments) {
    facts += assignment.facts;
    if (assignment.update_membership) membershipUpdates += 1;
    if (assignment.insert_alias) aliasInserts += 1;
    byProvider[assignment.stored_provider] =
      (byProvider[assignment.stored_provider] ?? 0) + assignment.facts;
    byCode[assignment.reporting_key] =
      (byCode[assignment.reporting_key] ?? 0) + assignment.facts;
  }
  const anchors = plan.assignments.map((a) => a.target_from).sort();
  return {
    recruiters_to_repair: plan.assignments.length,
    facts_covered: facts,
    anchor_from_min: anchors.length > 0 ? anchors[0] : null,
    anchor_from_max: anchors.length > 0 ? anchors[anchors.length - 1] : null,
    membership_valid_from_updates: membershipUpdates,
    alias_rows_inserted: aliasInserts,
    provider_split: byProvider,
    reporting_code_split: byCode,
    already_resolved_recruiters: plan.skipped.length,
    refused_recruiters: plan.refusals.length,
    refusal_reasons: [...new Set(plan.refusals.map((r) => r.reason))].sort(),
  };
}

/** Fold distribution rows into the comparable shape. */
export function foldDistribution(rows) {
  const providerSplit = {};
  const codeSplit = {};
  let facts = 0;
  for (const row of rows) {
    const n = Number(row.n);
    facts += n;
    providerSplit[row.provider_key] = (providerSplit[row.provider_key] ?? 0) + n;
    codeSplit[row.recruiter_key] = (codeSplit[row.recruiter_key] ?? 0) + n;
  }
  return { facts_total: facts, provider_split: providerSplit, reporting_code_split: codeSplit };
}

/** Stable comparison used by the in-transaction acceptance check. */
export function distributionMatches(expected, actual) {
  const same = (a, b) => {
    const left = Object.entries({ ...(a ?? {}) }).filter(([, n]) => Number(n) !== 0).sort();
    const right = Object.entries({ ...(b ?? {}) }).filter(([, n]) => Number(n) !== 0).sort();
    return JSON.stringify(left) === JSON.stringify(right);
  };
  return {
    ok: same(expected.provider_split, actual.provider_split) &&
      same(expected.reporting_code_split, actual.reporting_code_split),
    provider_split_ok: same(expected.provider_split, actual.provider_split),
    reporting_code_split_ok: same(expected.reporting_code_split, actual.reporting_code_split),
  };
}

/**
 * Expected whole-window distribution after the plan is applied: only the facts
 * that are currently unresolved move to their derived key, everything else stays.
 */
export function expectedDistribution(before, plan) {
  const provider = { ...before.distribution.provider_split };
  const code = { ...before.distribution.reporting_code_split };
  let providerResolved = 0;
  let aliasResolved = 0;
  for (const assignment of plan.assignments) {
    providerResolved += assignment.facts_unknown_provider;
    aliasResolved += assignment.facts_unknown_alias;
    provider[assignment.stored_provider] =
      (provider[assignment.stored_provider] ?? 0) + assignment.facts_unknown_provider;
    code[assignment.reporting_key] =
      (code[assignment.reporting_key] ?? 0) + assignment.facts_unknown_alias;
  }
  provider[UNKNOWN_KEY] = (provider[UNKNOWN_KEY] ?? 0) - providerResolved;
  code[UNKNOWN_KEY] = (code[UNKNOWN_KEY] ?? 0) - aliasResolved;
  return {
    facts_total: before.distribution.facts_total,
    provider_split: provider,
    reporting_code_split: code,
    provider_resolved: providerResolved,
    alias_resolved: aliasResolved,
  };
}

/**
 * Acceptance: the whole window must equal the expected distribution, the fact
 * count must not move and exactly the planned sentinels must be gone. With an
 * empty plan (a re-run after a successful repair) this is a valid no-op.
 */
export function acceptanceCheck(before, after, plan) {
  const expected = expectedDistribution(before, plan);
  const match = distributionMatches(expected, after.distribution);
  const factsUnchanged = after.window.facts_total === before.window.facts_total &&
    after.distribution.facts_total === before.distribution.facts_total;
  const providerOk = after.window.provider_unknown ===
    before.window.provider_unknown - expected.provider_resolved;
  const aliasOk = after.window.recruiter_unknown ===
    before.window.recruiter_unknown - expected.alias_resolved;
  return {
    facts_total_before: before.window.facts_total,
    facts_total_after: after.window.facts_total,
    facts_total_unchanged: factsUnchanged,
    provider_unknown_before: before.window.provider_unknown,
    provider_unknown_after: after.window.provider_unknown,
    recruiter_unknown_before: before.window.recruiter_unknown,
    recruiter_unknown_after: after.window.recruiter_unknown,
    resolved_by_this_run: {
      provider: expected.provider_resolved,
      recruiter: expected.alias_resolved,
    },
    provider_split_ok: match.provider_split_ok,
    reporting_code_split_ok: match.reporting_code_split_ok,
    provider_unknown_ok: providerOk,
    recruiter_unknown_ok: aliasOk,
    distribution: after.distribution,
    expected_distribution: expected,
    ok: match.ok && factsUnchanged && providerOk && aliasOk,
  };
}

/** Parameterised statements for one assignment (the caller supplies the executor). */
export function assignmentStatements(assignment) {
  const statements = [];
  if (assignment.update_membership) {
    statements.push({
      purpose: "membership_valid_from",
      sql: "update public.recruiter_provider_memberships set valid_from = $2::date" +
        " where membership_id = $1::uuid",
      params: [assignment.membership_id, assignment.target_from],
    });
  }
  if (assignment.insert_alias) {
    statements.push({
      purpose: "recruiter_alias",
      sql: "insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from)" +
        " values ($1::uuid, $2::text, $3::date)",
      params: [assignment.recruiter_id, assignment.reporting_key, assignment.target_from],
    });
  }
  return statements;
}

/**
 * Audit rows: one per repaired recruiter, carrying the operating actor, the
 * capability the actor actually holds and the restricted reason id. Values only;
 * no worker PII and no reporting code.
 */
export function auditStatements(assignment, actor) {
  return [{
    purpose: "audit_event",
    sql: "insert into public.direct_entry_audit_events" +
      " (auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields)" +
      " values ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, 'APPLIED', $6::uuid, $7::text[])",
    params: [
      actor.authSubject,
      actor.appUserId,
      REPAIR_ACTION,
      actor.capability,
      assignment.recruiter_id,
      actor.reasonId,
      [
        assignment.update_membership ? "provider_membership.valid_from" : "provider_membership.unchanged",
        assignment.insert_alias ? "recruiter_alias.reporting_key" : "recruiter_alias.unchanged",
      ],
    ],
  }];
}

/** Validate the operator input flags without touching the database. */
export function validateOperatorInput({ actor, reason }) {
  const problems = [];
  if (isBlank(actor) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(actor))) {
    problems.push("ACTOR_INVALID");
  }
  const trimmed = isBlank(reason) ? "" : String(reason).trim();
  if (trimmed.length < MIN_REASON_LENGTH || trimmed.length > MAX_REASON_LENGTH) {
    problems.push("REASON_INVALID");
  }
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(trimmed)) {
    problems.push("REASON_CONTAINS_IDENTIFIER");
  }
  return { ok: problems.length === 0, problems, reason: trimmed };
}
