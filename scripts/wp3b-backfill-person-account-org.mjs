#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseExternalNwcConfig } from "./run-wp2a-effective-access-shadow.mjs";

import {
  Q1_HRP_RECRUITER_LINK_AUDIT_SQL,
  validateBackfillManifest,
} from "./lib/wp3b-backfill-manifest.mjs";

const FORBIDDEN_NWC_PROJECT_REF = "nwcvmigrhzdywaumkrjp";
const FORBIDDEN_HOST_MARKERS = [
  FORBIDDEN_NWC_PROJECT_REF,
  "db-test-nwc",
  "pooler.supabase.com",
  ".supabase.co",
  ".supabase.in",
];

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function deterministicUuidFromHex(hex) {
  const clean = createHash("sha256").update(String(hex)).digest("hex");
  const versionNibble = "4";
  const variantNibble = ((parseInt(clean[16], 16) & 0x3) | 0x8).toString(16);
  return [
    clean.slice(0, 8),
    clean.slice(8, 12),
    versionNibble + clean.slice(13, 16),
    variantNibble + clean.slice(17, 20),
    clean.slice(20, 32),
  ].join("-");
}

function normalizeIsoDateString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

export function assertSafeBackfillConnectionTarget(connectionString, options = {}) {
  if (typeof connectionString !== "string" || connectionString.trim() === "") {
    throw new Error("BACKFILL_DB_URL_REQUIRED");
  }
  const lower = connectionString.toLowerCase();
  if (options.nwcStaging) {
    const target = new URL(connectionString);
    const user = decodeURIComponent(target.username);
    const isDirectNwc = target.hostname === `db.${FORBIDDEN_NWC_PROJECT_REF}.supabase.co`;
    const isPoolerNwc = target.hostname.endsWith(".pooler.supabase.com") &&
      user === `postgres.${FORBIDDEN_NWC_PROJECT_REF}`;
    if (!isDirectNwc && !isPoolerNwc) {
      throw new Error("BACKFILL_NWC_TARGET_MISMATCH");
    }
    return connectionString;
  }
  if (lower.includes(FORBIDDEN_NWC_PROJECT_REF) || lower.includes("db-test-nwc")) {
    throw new Error("BACKFILL_FORBIDDEN_NWC_TARGET: WP3B must never write to NWC");
  }
  if (!options.allowRemoteTarget) {
    for (const marker of FORBIDDEN_HOST_MARKERS) {
      if (lower.includes(marker)) {
        throw new Error(
          `BACKFILL_FORBIDDEN_REMOTE_TARGET: remote host marker ${marker} requires explicit --allow-remote-target confirmation`,
        );
      }
    }
  }
  return connectionString;
}

export async function runQ1HrpRecruiterAudit(client, options = {}) {
  const manageTransaction = options.manageTransaction !== false;
  if (manageTransaction) {
    await client.query("begin transaction isolation level repeatable read read only");
  }
  try {
    const res = await client.query(Q1_HRP_RECRUITER_LINK_AUDIT_SQL);
    if (manageTransaction) {
      await client.query("rollback");
    }
    return res.rows;
  } catch (err) {
    if (manageTransaction) {
      try {
        await client.query("rollback");
      } catch {
        // ignore rollback error
      }
    }
    throw err;
  }
}

// All backfilled rows record v_backfill_recorded_at (vNow) as started_at; BACKFILL_DATE_EVIDENCE
// preserves evidence_date metadata separately without synthesizing pre-backfill history timestamps.
function resolveIntervalStartSql(_client, _sourceKind, _evidenceDate, nowIso) {
  return nowIso;
}

export async function runBackfillSelfChecks(client, quarantinedAccountIds = []) {
  const checks = {};

  // Check 1: zero active links or personal assignments on unquarantined SHARED/SERVICE accounts
  const c1 = await client.query(
    `
    select count(*)::integer as cnt
      from public.direct_entry_app_users u
     where u.account_type <> 'NORMAL'
       and (
         exists (
           select 1
             from public.organization_account_person_links l
            where l.app_user_id = u.app_user_id
              and l.ended_at is null
         )
         or (
           not (u.app_user_id = any($1::uuid[]))
           and public.org_department__internal_has_personal_assignments(u.app_user_id, pg_catalog.clock_timestamp())
         )
       )
    `,
    [quarantinedAccountIds],
  );
  checks.check1_shared_service_links = c1.rows[0].cnt;

  // Check 2: zero multi-account / multi-person active links
  const c2 = await client.query(`
    select
      (select count(*)::integer from (
        select app_user_id from public.organization_account_person_links where ended_at is null group by app_user_id having count(*) > 1
      ) a) +
      (select count(*)::integer from (
        select person_id from public.organization_account_person_links where ended_at is null group by person_id having count(*) > 1
      ) b) as cnt
  `);
  checks.check2_multi_links = c2.rows[0].cnt;

  // Check 3: zero multi-department active person memberships
  const c3 = await client.query(`
    select count(*)::integer as cnt from (
      select person_id
        from public.organization_person_department_memberships
       where ended_at is null
       group by person_id
      having count(*) > 1
    ) d
  `);
  checks.check3_multi_dept_memberships = c3.rows[0].cnt;

  // Check 4: zero invalid active HEAD rows (INACTIVE person or no active membership in same department)
  const c4 = await client.query(`
    select count(*)::integer as cnt
      from public.organization_department_heads h
      join public.organization_persons p
        on p.person_id = h.person_id
      left join public.organization_person_department_memberships m
        on m.person_id = h.person_id
       and m.department_id = h.department_id
       and m.ended_at is null
     where h.ended_at is null
       and (p.status <> 'ACTIVE' or m.membership_id is null)
  `);
  checks.check4_invalid_heads = c4.rows[0].cnt;

  // Check 5: zero synthetic hrp codes or non-HRP/vendor recruiters in organization_persons
  const c5 = await client.query(`
    select count(*)::integer as cnt
      from public.organization_persons p
     where p.employee_code ~* '^hrp-[0-9]{4}-[0-9]{6}$'
        or (
          p.recruiter_id is not null
          and not exists (
            select 1
              from public.recruiter_provider_memberships rm
             where rm.recruiter_id = p.recruiter_id
               and rm.provider_type = 'hrp'
               and rm.vendor_id is null
          )
        )
  `);
  checks.check5_synthetic_or_vendor_persons = c5.rows[0].cnt;

  // Check 6: ACCOUNTING legacy projection parity for unquarantined NORMAL accounts
  const c6 = await client.query(
    `
    with legacy_acct as (
      select lm.app_user_id
        from public.organization_department_memberships lm
        join public.organization_departments d
          on d.department_id = lm.department_id
         and d.system_key = 'ACCOUNTING'
        join public.direct_entry_app_users u
          on u.app_user_id = lm.app_user_id
       where lm.valid_to is null
         and u.account_type = 'NORMAL'
         and not (lm.app_user_id = any($1::uuid[]))
    ),
    org_acct as (
      select l.app_user_id
        from public.organization_account_person_links l
        join public.organization_persons p
          on p.person_id = l.person_id
         and p.status = 'ACTIVE'
        join public.organization_person_department_memberships m
          on m.person_id = p.person_id
         and m.ended_at is null
        join public.organization_departments d
          on d.department_id = m.department_id
         and d.system_key = 'ACCOUNTING'
         and d.is_active = true
        join public.direct_entry_app_users u
          on u.app_user_id = l.app_user_id
       where l.ended_at is null
         and u.account_type = 'NORMAL'
    )
    select count(*)::integer as cnt
      from legacy_acct la
      full outer join org_acct oa
        on oa.app_user_id = la.app_user_id
     where la.app_user_id is null
        or oa.app_user_id is null
    `,
    [quarantinedAccountIds],
  );
  checks.check6_accounting_projection_diff = c6.rows[0].cnt;

  // Check 7: zero rows violating source_kind/evidence_date invariant
  const c7 = await client.query(`
    select
      (select count(*)::integer from public.organization_account_person_links
        where (source_kind = 'BACKFILL_DATE_EVIDENCE') <> (evidence_date is not null)) +
      (select count(*)::integer from public.organization_person_department_memberships
        where (source_kind = 'BACKFILL_DATE_EVIDENCE') <> (evidence_date is not null)) +
      (select count(*)::integer from public.organization_department_heads
        where (source_kind = 'BACKFILL_DATE_EVIDENCE') <> (evidence_date is not null)) as cnt
  `);
  checks.check7_evidence_invariant_violations = c7.rows[0].cnt;

  const failed = Object.entries(checks).filter(([, count]) => count !== 0);
  return {
    ok: failed.length === 0,
    checks,
    failed,
  };
}

export async function runWp3bBackfill(client, options = {}) {
  const {
    manifest: rawManifest,
    dryRun = true,
    expectedFingerprint = null,
    manageTransaction = true,
  } = options;

  const validated = validateBackfillManifest(rawManifest);
  if (!validated.ok) {
    const err = new Error(`BACKFILL_MANIFEST_INVALID: ${validated.errors.join("; ")}`);
    err.code = "BACKFILL_MANIFEST_INVALID";
    err.errors = validated.errors;
    throw err;
  }

  if (!dryRun) {
    if (
      typeof expectedFingerprint !== "string" ||
      expectedFingerprint.trim().toLowerCase() !== validated.manifest_fingerprint
    ) {
      throw new Error(
        `BACKFILL_FINGERPRINT_CONFIRMATION_MISMATCH: expected ${validated.manifest_fingerprint}`,
      );
    }
  }

  const manifest = validated.manifest;
  const quarantinedAccountIds = manifest.quarantined_exceptions
    .filter((q) => q.kind === "ACCOUNT")
    .map((q) => q.ref);
  const quarantinedAccountSet = new Set(quarantinedAccountIds);
  const manifestClassificationByAccount = new Map(
    manifest.account_classifications.map((c) => [c.account_ref, c.account_type]),
  );
  const manifestPersonByAccountRef = new Map();
  for (const person of manifest.persons) {
    if (person.account_ref) {
      manifestPersonByAccountRef.set(person.account_ref, person);
    }
  }

  if (manageTransaction) {
    await client.query("begin");
  }

  try {
    const nowRes = await client.query("select pg_catalog.clock_timestamp() as now_ts");
    const vNow = nowRes.rows[0].now_ts;
    const actorUserId = manifest.actor_app_user_id;

    // Verify actor user exists
    const actorRes = await client.query(
      "select app_user_id from public.direct_entry_app_users where app_user_id = $1",
      [actorUserId],
    );
    if (actorRes.rows.length === 0) {
      throw new Error(`BACKFILL_ACTOR_NOT_FOUND: ${actorUserId}`);
    }

    // Pre-check 1: Verify all target accounts & recruiters & departments exist
    const referencedAccountIds = new Set([
      ...manifest.account_classifications.map((c) => c.account_ref),
      ...manifest.persons.filter((p) => p.account_ref).map((p) => p.account_ref),
    ]);
    for (const accId of referencedAccountIds) {
      const accRes = await client.query(
        "select app_user_id, account_type from public.direct_entry_app_users where app_user_id = $1",
        [accId],
      );
      if (accRes.rows.length === 0) {
        throw new Error(`BACKFILL_ACCOUNT_NOT_FOUND: ${accId}`);
      }
    }

    for (const person of manifest.persons) {
      if (person.recruiter_id) {
        const recRes = await client.query(
          `
          select r.recruiter_id,
                 exists (
                   select 1
                     from public.recruiter_provider_memberships rm
                    where rm.recruiter_id = r.recruiter_id
                      and rm.provider_type = 'hrp'
                      and rm.vendor_id is null
                 ) as is_hrp_internal
            from public.recruiters r
           where r.recruiter_id = $1
          `,
          [person.recruiter_id],
        );
        if (recRes.rows.length === 0) {
          throw new Error(`BACKFILL_RECRUITER_NOT_FOUND: ${person.recruiter_id}`);
        }
        if (!recRes.rows[0].is_hrp_internal) {
          throw new Error(`BACKFILL_VENDOR_RECRUITER_FORBIDDEN: ${person.recruiter_id}`);
        }
      }

      if (person.account_ref) {
        const accRef = person.account_ref;
        const dbAcc = await client.query(
          "select account_type from public.direct_entry_app_users where app_user_id = $1",
          [accRef],
        );
        const effType = manifestClassificationByAccount.get(accRef) ?? dbAcc.rows[0].account_type;
        if (effType !== "NORMAL") {
          throw new Error(`BACKFILL_ACCOUNT_TYPE_LINK_FORBIDDEN: ${accRef} has type ${effType}`);
        }

        // Check existing verified recruiter link on account matches manifest recruiter_id
        const existingRecLinks = await client.query(
          `
          select recruiter_id
            from public.direct_entry_app_user_recruiter_links
           where app_user_id = $1
             and is_current = true
             and verified = true
          `,
          [accRef],
        );
        if (existingRecLinks.rows.length > 0) {
          const boundRecId = existingRecLinks.rows[0].recruiter_id.toLowerCase();
          if (!person.recruiter_id || person.recruiter_id !== boundRecId) {
            throw new Error(
              `BACKFILL_RECRUITER_LINK_MISMATCH: account ${accRef} is currently linked to recruiter ${boundRecId}, manifest specifies ${person.recruiter_id}`,
            );
          }
        }
      }
    }

    const deptRes = await client.query(
      "select department_id, code, system_key, is_active from public.organization_departments",
    );
    const deptByCode = new Map(deptRes.rows.map((row) => [row.code, row]));

    for (const person of manifest.persons) {
      if (person.department_membership) {
        const dept = deptByCode.get(person.department_membership.department_code);
        if (!dept) {
          throw new Error(
            `BACKFILL_DEPARTMENT_NOT_FOUND: ${person.department_membership.department_code}`,
          );
        }
        if (!dept.is_active) {
          throw new Error(
            `BACKFILL_DEPARTMENT_INACTIVE: ${person.department_membership.department_code}`,
          );
        }
      }
    }

    // Pre-check 2: Cross-source conflicts & unmapped active legacy ACCOUNTING memberships
    const legacyAccountingRes = await client.query(`
      select lm.app_user_id,
             u.account_type,
             exists (
               select 1
                 from public.direct_entry_app_user_recruiter_links rl
                 join public.recruiter_provider_memberships rm
                   on rm.recruiter_id = rl.recruiter_id
                  and rm.provider_type = 'hrp'
                  and rm.vendor_id is null
                where rl.app_user_id = lm.app_user_id
                  and rl.is_current = true
                  and rl.verified = true
             ) as has_hrp_recruiter_link,
             exists (
               select 1
                 from public.direct_entry_app_user_recruiter_links rl
                 join public.recruiter_team_memberships rtm
                   on rtm.recruiter_id = rl.recruiter_id
                  and rtm.is_current = true
                where rl.app_user_id = lm.app_user_id
                  and rl.is_current = true
                  and rl.verified = true
             ) as has_active_team_membership,
             exists (
               select 1
                 from public.direct_entry_app_user_recruiter_links rl
                 join public.direct_entry_team_leader_assignments tlm
                   on tlm.leader_recruiter_id = rl.recruiter_id
                  and tlm.is_current = true
                where rl.app_user_id = lm.app_user_id
                  and rl.is_current = true
                  and rl.verified = true
             ) as has_active_leader_membership
        from public.organization_department_memberships lm
        join public.organization_departments d
          on d.department_id = lm.department_id
         and d.system_key = 'ACCOUNTING'
        join public.direct_entry_app_users u
          on u.app_user_id = lm.app_user_id
       where lm.valid_to is null
    `);

    for (const row of legacyAccountingRes.rows) {
      const appUserId = row.app_user_id.toLowerCase();
      const hasRecruitmentSignal =
        row.has_hrp_recruiter_link ||
        row.has_active_team_membership ||
        row.has_active_leader_membership;

      if (hasRecruitmentSignal && !quarantinedAccountSet.has(appUserId)) {
        const mapped = manifestPersonByAccountRef.get(appUserId);
        if (!mapped) {
          throw new Error(
            `UNQUARANTINED_CROSS_SOURCE_CONFLICT: account ${appUserId} has active ACCOUNTING membership and Recruitment signals without quarantine or explicit manifest resolution`,
          );
        }
      }

      const effType = manifestClassificationByAccount.get(appUserId) ?? row.account_type;
      if (effType === "NORMAL" && !quarantinedAccountSet.has(appUserId)) {
        const mapped = manifestPersonByAccountRef.get(appUserId);
        if (!mapped || mapped.department_membership?.department_code !== "ACCOUNTING") {
          throw new Error(
            `BACKFILL_UNMAPPED_LEGACY_ACCOUNTING_MEMBER: account ${appUserId} holds active ACCOUNTING membership but is neither mapped to ACCOUNTING nor quarantined`,
          );
        }
      }
    }

    const stats = {
      classifications_updated: 0,
      persons_created: 0,
      persons_verified_existing: 0,
      memberships_created: 0,
      memberships_verified_existing: 0,
      links_created: 0,
      links_verified_existing: 0,
      heads_created: 0,
      heads_verified_existing: 0,
    };

    // Step 1: Account classifications
    for (const cls of manifest.account_classifications) {
      const accRes = await client.query(
        "select * from public.direct_entry_app_users where app_user_id = $1 for update",
        [cls.account_ref],
      );
      const acc = accRes.rows[0];
      if (acc.account_type !== cls.account_type) {
        if (cls.account_type !== "NORMAL") {
          const hasPersonalRes = await client.query(
            "select public.org_department__internal_has_personal_assignments($1::uuid, $2::timestamptz) as has_personal",
            [cls.account_ref, vNow],
          );
          if (hasPersonalRes.rows[0]?.has_personal) {
            throw new Error(
              `BACKFILL_ACCOUNT_HAS_PERSONAL_ASSIGNMENTS: cannot classify ${cls.account_ref} as ${cls.account_type}`,
            );
          }
        }
        await client.query(
          `
          update public.direct_entry_app_users
             set account_type = $2,
                 version = version + 1,
                 updated_at = $3
           where app_user_id = $1
          `,
          [cls.account_ref, cls.account_type, vNow],
        );
        await client.query(
          "select public.org_department__internal_sync_accounting_projection($1, $2, $3, $4)",
          [cls.account_ref, actorUserId, manifest.reason, vNow],
        );
        await client.query(
          "select public.org_department__internal_sync_leave_profile_from_org($1, $2, $3, false)",
          [cls.account_ref, actorUserId, vNow],
        );
        stats.classifications_updated += 1;
      }
    }

    // Step 2: Persons, Memberships, Account Links
    const personIdByLowerCode = new Map();
    const membershipStartByLowerCode = new Map();

    for (const person of manifest.persons) {
      if (person.recruiter_id) {
        const recBound = await client.query(
          "select person_id, employee_code from public.organization_persons where recruiter_id = $1 for update",
          [person.recruiter_id],
        );
        if (
          recBound.rows.length > 0 &&
          recBound.rows[0].employee_code.toLowerCase() !== person.employee_code.toLowerCase()
        ) {
          throw new Error(
            `BACKFILL_RECRUITER_IDENTITY_CONFLICT: recruiter ${person.recruiter_id} is already bound to ${recBound.rows[0].employee_code}`,
          );
        }
      }

      const existingPersonRes = await client.query(
        `
        select *
          from public.organization_persons
         where pg_catalog.lower(employee_code) = pg_catalog.lower($1)
         for update
        `,
        [person.employee_code],
      );

      let personRow;
      if (existingPersonRes.rows.length === 0) {
        const deactivatedAt = person.status === "INACTIVE" ? vNow : null;
        const deactivatedBy = person.status === "INACTIVE" ? actorUserId : null;
        const deactivateReason = person.status === "INACTIVE" ? manifest.reason : null;

        const inserted = await client.query(
          `
          insert into public.organization_persons (
            employee_code,
            full_name,
            joined_on,
            status,
            recruiter_id,
            version,
            deactivated_at,
            deactivated_by_user_id,
            deactivate_reason,
            created_by_app_user_id,
            updated_by_app_user_id,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $9, $10, $10)
          returning *
          `,
          [
            person.employee_code,
            person.full_name,
            person.joined_on,
            person.status,
            person.recruiter_id,
            deactivatedAt,
            deactivatedBy,
            deactivateReason,
            actorUserId,
            vNow,
          ],
        );
        personRow = inserted.rows[0];
        stats.persons_created += 1;
      } else {
        personRow = existingPersonRes.rows[0];
        const existingRecId = personRow.recruiter_id ? personRow.recruiter_id.toLowerCase() : null;
        const existingJoinedOn = normalizeIsoDateString(personRow.joined_on);
        if (
          personRow.employee_code !== person.employee_code ||
          personRow.full_name !== person.full_name ||
          existingJoinedOn !== person.joined_on ||
          personRow.status !== person.status ||
          existingRecId !== person.recruiter_id
        ) {
          throw new Error(
            `BACKFILL_PERSON_MISMATCH: existing person ${person.employee_code} does not match manifest`,
          );
        }
        stats.persons_verified_existing += 1;
      }

      personIdByLowerCode.set(person.employee_code.toLowerCase(), personRow.person_id);

      // Department membership
      const existingMemRes = await client.query(
        `
        select m.*, d.code as dept_code
          from public.organization_person_department_memberships m
          join public.organization_departments d
            on d.department_id = m.department_id
         where m.person_id = $1
           and m.ended_at is null
         for update of m
        `,
        [personRow.person_id],
      );

      if (person.department_membership) {
        const targetDept = deptByCode.get(person.department_membership.department_code);
        if (existingMemRes.rows.length === 0) {
          const startedAt = await resolveIntervalStartSql(
            client,
            person.department_membership.source_kind,
            person.department_membership.evidence_date,
            vNow,
          );
          const insertedMem = await client.query(
            `
            insert into public.organization_person_department_memberships (
              person_id,
              department_id,
              started_at,
              ended_at,
              source_kind,
              evidence_date,
              version,
              reason,
              created_by_app_user_id,
              created_at,
              updated_at
            )
            values ($1, $2, $3, null, $4, $5, 1, $6, $7, $8, $8)
            returning *
            `,
            [
              personRow.person_id,
              targetDept.department_id,
              startedAt,
              person.department_membership.source_kind,
              person.department_membership.evidence_date,
              manifest.reason,
              actorUserId,
              vNow,
            ],
          );
          membershipStartByLowerCode.set(
            person.employee_code.toLowerCase(),
            insertedMem.rows[0].started_at,
          );
          stats.memberships_created += 1;
        } else {
          const existingMem = existingMemRes.rows[0];
          const existingEvDate = normalizeIsoDateString(existingMem.evidence_date);
          if (
            existingMem.dept_code !== person.department_membership.department_code ||
            existingMem.source_kind !== person.department_membership.source_kind ||
            existingEvDate !== person.department_membership.evidence_date
          ) {
            throw new Error(
              `BACKFILL_MEMBERSHIP_MISMATCH: active membership for ${person.employee_code} does not match manifest`,
            );
          }
          membershipStartByLowerCode.set(
            person.employee_code.toLowerCase(),
            existingMem.started_at,
          );
          stats.memberships_verified_existing += 1;
        }
      } else if (existingMemRes.rows.length > 0) {
        throw new Error(
          `BACKFILL_MEMBERSHIP_MISMATCH: ${person.employee_code} has active membership in DB but null in manifest`,
        );
      }

      // Account link
      const existingPersonLinks = await client.query(
        "select * from public.organization_account_person_links where person_id = $1 and ended_at is null for update",
        [personRow.person_id],
      );

      if (person.account_ref) {
        const accRef = person.account_ref;
        const accRowRes = await client.query(
          "select * from public.direct_entry_app_users where app_user_id = $1 for update",
          [accRef],
        );
        const accRow = accRowRes.rows[0];
        if (accRow.account_type !== "NORMAL") {
          throw new Error(
            `BACKFILL_ACCOUNT_TYPE_LINK_FORBIDDEN: account ${accRef} has type ${accRow.account_type}`,
          );
        }

        const existingAccLinks = await client.query(
          "select * from public.organization_account_person_links where app_user_id = $1 and ended_at is null for update",
          [accRef],
        );

        if (existingAccLinks.rows.length > 0 && existingAccLinks.rows[0].person_id !== personRow.person_id) {
          throw new Error(
            `BACKFILL_ACCOUNT_LINK_MISMATCH: account ${accRef} already linked to a different person`,
          );
        }
        if (
          existingPersonLinks.rows.length > 0 &&
          existingPersonLinks.rows[0].app_user_id.toLowerCase() !== accRef
        ) {
          throw new Error(
            `BACKFILL_ACCOUNT_LINK_MISMATCH: person ${person.employee_code} already linked to a different account`,
          );
        }

        if (existingPersonLinks.rows.length === 0) {
          const startedAt = await resolveIntervalStartSql(
            client,
            person.link_source_kind,
            person.link_evidence_date,
            vNow,
          );
          await client.query(
            `
            insert into public.organization_account_person_links (
              app_user_id,
              person_id,
              started_at,
              ended_at,
              source_kind,
              evidence_date,
              version,
              reason,
              created_by_app_user_id,
              created_at,
              updated_at
            )
            values ($1, $2, $3, null, $4, $5, 1, $6, $7, $8, $8)
            `,
            [
              accRef,
              personRow.person_id,
              startedAt,
              person.link_source_kind,
              person.link_evidence_date,
              manifest.reason,
              actorUserId,
              vNow,
            ],
          );
          stats.links_created += 1;
        } else {
          const existingLink = existingPersonLinks.rows[0];
          const existingEvDate = normalizeIsoDateString(existingLink.evidence_date);
          if (
            existingLink.source_kind !== person.link_source_kind ||
            existingEvDate !== person.link_evidence_date
          ) {
            throw new Error(
              `BACKFILL_ACCOUNT_LINK_MISMATCH: link metadata for ${person.employee_code} does not match manifest`,
            );
          }
          stats.links_verified_existing += 1;
        }

        if (accRow.display_name !== person.full_name) {
          await client.query(
            `
            update public.direct_entry_app_users
               set display_name = $2,
                   version = version + 1,
                   updated_at = $3
             where app_user_id = $1
            `,
            [accRef, person.full_name, vNow],
          );
        }

        await client.query(
          "select public.org_department__internal_sync_accounting_projection($1, $2, $3, $4)",
          [accRef, actorUserId, manifest.reason, vNow],
        );
        await client.query(
          "select public.org_department__internal_sync_leave_profile_from_org($1, $2, $3, false)",
          [accRef, actorUserId, vNow],
        );
      } else if (existingPersonLinks.rows.length > 0) {
        throw new Error(
          `BACKFILL_ACCOUNT_LINK_MISMATCH: person ${person.employee_code} has active link in DB but null in manifest`,
        );
      }

      // Sync recruiter display name when linked to a recruiter
      if (person.recruiter_id) {
        const recBeforeRes = await client.query(
          "select r.*, public.direct_entry_personnel_snapshot(r) as snap from public.recruiters r where r.recruiter_id = $1 for update",
          [person.recruiter_id],
        );
        const recBefore = recBeforeRes.rows[0];
        if (recBefore && recBefore.display_name !== person.full_name) {
          const reasonRes = await client.query(
            "select public.direct_entry_reason($1, $2) as reason_id",
            [actorUserId, manifest.reason],
          );
          const recAfterRes = await client.query(
            "update public.recruiters r set display_name = $2 where r.recruiter_id = $1 returning r.*, public.direct_entry_personnel_snapshot(r) as snap",
            [person.recruiter_id, person.full_name],
          );
          await client.query(
            `
            select public.direct_entry_bump_personnel_version(
              $1,
              $2,
              $3,
              $4::jsonb,
              $5::jsonb
            )
            `,
            [
              person.recruiter_id,
              actorUserId,
              reasonRes.rows[0].reason_id,
              recBefore.snap,
              recAfterRes.rows[0].snap,
            ],
          );
        }
      }
    }

    // Step 3: Department HEAD designations
    for (const head of manifest.department_heads) {
      const dept = deptByCode.get(head.department_code);
      if (!dept || !dept.is_active) {
        throw new Error(`BACKFILL_HEAD_DEPARTMENT_INVALID: ${head.department_code}`);
      }
      const personId = personIdByLowerCode.get(head.employee_code.toLowerCase());
      if (!personId) {
        throw new Error(`BACKFILL_HEAD_PERSON_NOT_FOUND: ${head.employee_code}`);
      }

      const existingHeadRes = await client.query(
        `
        select *
          from public.organization_department_heads
         where department_id = $1
           and ended_at is null
         for update
        `,
        [dept.department_id],
      );

      if (existingHeadRes.rows.length === 0) {
        const startedAt =
          membershipStartByLowerCode.get(head.employee_code.toLowerCase()) ?? vNow;
        await client.query(
          `
          insert into public.organization_department_heads (
            department_id,
            person_id,
            started_at,
            ended_at,
            source_kind,
            evidence_date,
            version,
            reason,
            created_by_app_user_id,
            created_at,
            updated_at
          )
          values ($1, $2, $3, null, $4, $5, 1, $6, $7, $8, $8)
          `,
          [
            dept.department_id,
            personId,
            startedAt,
            head.source_kind,
            head.evidence_date,
            manifest.reason,
            actorUserId,
            vNow,
          ],
        );
        await client.query(
          "update public.organization_departments set version = version + 1, updated_at = $2 where department_id = $1",
          [dept.department_id, vNow],
        );
        stats.heads_created += 1;
      } else {
        const existingHead = existingHeadRes.rows[0];
        const existingEvDate = normalizeIsoDateString(existingHead.evidence_date);
        if (
          existingHead.person_id !== personId ||
          existingHead.source_kind !== head.source_kind ||
          existingEvDate !== head.evidence_date
        ) {
          throw new Error(
            `BACKFILL_HEAD_MISMATCH: active HEAD for ${head.department_code} does not match manifest`,
          );
        }
        stats.heads_verified_existing += 1;
      }
    }

    // Step 4: Self-checks 1..7 inside the transaction before audit/commit
    const selfCheck = await runBackfillSelfChecks(client, quarantinedAccountIds);
    if (!selfCheck.ok) {
      const err = new Error(`BACKFILL_SELF_CHECK_FAILED: ${JSON.stringify(selfCheck.failed)}`);
      err.code = "BACKFILL_SELF_CHECK_FAILED";
      err.selfCheck = selfCheck;
      throw err;
    }

    // Step 5: Audit event (idempotent by manifest_fingerprint)
    const auditCheckRes = await client.query(
      `
      select audit_event_id
        from public.organization_department_audit_events
       where action = 'BACKFILL_APPLIED'
         and after_snapshot->>'manifest_fingerprint' = $1
       limit 1
      `,
      [validated.manifest_fingerprint],
    );

    const replayed = auditCheckRes.rows.length > 0;
    if (!replayed) {
      await client.query(
        `
        insert into public.organization_department_audit_events (
          department_id,
          membership_id,
          target_app_user_id,
          actor_user_id,
          action,
          reason,
          before_snapshot,
          after_snapshot,
          idempotency_key,
          created_at
        )
        values (null, null, null, $1, 'BACKFILL_APPLIED', $2, null, $3::jsonb, $4::uuid, $5)
        `,
        [
          actorUserId,
          manifest.reason,
          JSON.stringify({
            schema_version: manifest.schema_version,
            manifest_fingerprint: validated.manifest_fingerprint,
            approved_by: manifest.approved_by,
            approved_at: manifest.approved_at,
            stats,
            quarantined_exceptions_count: manifest.quarantined_exceptions.length,
            self_check: selfCheck.checks,
          }),
          deterministicUuidFromHex(validated.manifest_fingerprint),
          vNow,
        ],
      );
    }

    if (dryRun) {
      if (manageTransaction) {
        await client.query("rollback");
      }
    } else if (manageTransaction) {
      await client.query("commit");
    }

    return {
      ok: true,
      dry_run: dryRun,
      replayed,
      manifest_fingerprint: validated.manifest_fingerprint,
      stats,
      self_check: selfCheck,
    };
  } catch (err) {
    if (manageTransaction) {
      try {
        await client.query("rollback");
      } catch {
        // ignore rollback error
      }
    }
    throw err;
  }
}

function parseCliArgs(argv) {
  const args = {
    manifestPath: null,
    validateManifestOnly: false,
    auditQ1: false,
    dryRun: false,
    apply: false,
    confirmApply: false,
    expectedFingerprint: null,
    allowRemoteTarget: false,
    nwcStaging: false,
    configPath: null,
    connectionString: process.env.WP3B_BACKFILL_DB_URL ?? process.env.DATABASE_URL ?? null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--manifest") {
      args.manifestPath = argv[++i] ?? null;
    } else if (token === "--validate-manifest") {
      args.validateManifestOnly = true;
    } else if (token === "--audit-q1") {
      args.auditQ1 = true;
    } else if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--apply") {
      args.apply = true;
    } else if (token === "--confirm-apply") {
      args.confirmApply = true;
    } else if (token === "--expected-fingerprint") {
      args.expectedFingerprint = argv[++i] ?? null;
    } else if (token === "--allow-remote-target") {
      args.allowRemoteTarget = true;
    } else if (token === "--nwc-staging") {
      args.nwcStaging = true;
    } else if (token === "--config") {
      args.configPath = argv[++i] ?? null;
    } else if (token === "--db-url") {
      args.connectionString = argv[++i] ?? null;
    } else {
      throw new Error(`UNKNOWN_CLI_FLAG: ${token}`);
    }
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.validateManifestOnly) {
    if (!args.manifestPath) {
      throw new Error("--manifest <path> is required with --validate-manifest");
    }
    const raw = JSON.parse(readFileSync(path.resolve(args.manifestPath), "utf8"));
    const validated = validateBackfillManifest(raw);
    if (!validated.ok) {
      console.error(JSON.stringify({ ok: false, errors: validated.errors }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          manifest_fingerprint: validated.manifest_fingerprint,
          counts: {
            account_classifications: validated.manifest.account_classifications.length,
            persons: validated.manifest.persons.length,
            department_heads: validated.manifest.department_heads.length,
            quarantined_exceptions: validated.manifest.quarantined_exceptions.length,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!args.auditQ1 && !args.dryRun && !args.apply) {
    throw new Error("Specify one mode: --validate-manifest | --audit-q1 | --dry-run | --apply");
  }
  if (args.dryRun && args.apply) {
    throw new Error("--dry-run and --apply are mutually exclusive");
  }
  if (args.apply && (!args.confirmApply || !args.expectedFingerprint)) {
    throw new Error("--apply requires --confirm-apply and --expected-fingerprint <sha256>");
  }

  if (args.nwcStaging && !args.configPath) {
    throw new Error("BACKFILL_NWC_CONFIG_REQUIRED: --nwc-staging requires --config <path>");
  }
  const nwcConfig = args.nwcStaging ? parseExternalNwcConfig(args.configPath) : null;
  const dbUrl = assertSafeBackfillConnectionTarget(nwcConfig?.connectionString ?? args.connectionString, {
    allowRemoteTarget: args.allowRemoteTarget,
    nwcStaging: args.nwcStaging,
  });

  const { Client } = await import("pg");
  const client = new Client({ connectionString: dbUrl, ...(nwcConfig ? { ssl: nwcConfig.ssl } : {}) });
  await client.connect();

  try {
    if (args.auditQ1) {
      const rows = await runQ1HrpRecruiterAudit(client, { manageTransaction: true });
      console.log(JSON.stringify({ ok: true, count: rows.length, rows }, null, 2));
      return;
    }

    if (!args.manifestPath) {
      throw new Error("--manifest <path> is required for --dry-run or --apply");
    }
    const raw = JSON.parse(readFileSync(path.resolve(args.manifestPath), "utf8"));
    const result = await runWp3bBackfill(client, {
      manifest: raw,
      dryRun: !args.apply,
      expectedFingerprint: args.expectedFingerprint,
      manageTransaction: true,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end();
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  normalizeText(process.argv[1]) !== "" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
