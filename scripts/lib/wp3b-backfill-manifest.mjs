import { createHash } from "node:crypto";

export const WP3B_BACKFILL_SCHEMA_VERSION = "wp3b-backfill-manifest-v1";

export const WP3B_BACKFILL_SOURCE_KINDS = [
  "BACKFILL_DATE_EVIDENCE",
  "BACKFILL_CURRENT_STATE_ONLY",
];

export const WP3B_ACCOUNT_TYPES = ["NORMAL", "SHARED", "SERVICE"];
export const WP3B_PERSON_STATUSES = ["ACTIVE", "INACTIVE"];
export const WP3B_QUARANTINE_KINDS = ["ACCOUNT", "RECRUITER"];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/i;
const DEPARTMENT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;
const PROJECT_WORKER_HRP_CODE_PATTERN = /^hrp-[0-9]{4}-[0-9]{6}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const REASON_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/**
 * Correlated scalar subquery Q1 audit query (Contract Rev 2.1 §3.4).
 * Computes active verified link count, worker entry count, PM counts, and active
 * team count per HRP recruiter independently without cross-join multiplication.
 */
export const Q1_HRP_RECRUITER_LINK_AUDIT_SQL = `
select
  r.recruiter_id,
  left(r.recruiter_id::text, 8) || '...' as recruiter_mask,
  r.personnel_code,
  r.active as recruiter_active,
  (
    select count(*)::integer
    from public.direct_entry_app_user_recruiter_links l
    where l.recruiter_id = r.recruiter_id
      and l.is_current = true
      and l.verified = true
  ) as active_verified_link_count,
  (
    select count(*)::integer
    from public.direct_entries de
    where de.recruiter_id = r.recruiter_id
  ) as worker_entries_count,
  (
    select count(*)::integer
    from public.direct_entry_project_manager_assignments pma
    where pma.manager_recruiter_id = r.recruiter_id
      and pma.valid_to is null
      and pma.revoked_at is null
  ) as active_pm_count,
  (
    select count(*)::integer
    from public.direct_entry_project_manager_assignments pma_all
    where pma_all.manager_recruiter_id = r.recruiter_id
  ) as total_pm_history_count,
  (
    select count(*)::integer
    from public.recruiter_team_memberships rtm
    where rtm.recruiter_id = r.recruiter_id
      and rtm.is_current = true
  ) as active_team_count
from public.recruiters r
where exists (
  select 1
  from public.recruiter_provider_memberships rpm
  where rpm.recruiter_id = r.recruiter_id
    and rpm.provider_type = 'hrp'
    and rpm.is_current = true
)
  and (
    select count(*)
    from public.direct_entry_app_user_recruiter_links l
    where l.recruiter_id = r.recruiter_id
      and l.is_current = true
      and l.verified = true
  ) <> 1
order by r.personnel_code nulls last, r.recruiter_id asc
`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUuid(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!UUID_PATTERN.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function isValidIsoCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function isIsoUtcTimestamp(value) {
  return (
    typeof value === "string" &&
    ISO_UTC_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function normalizeText(value, { min = 1, max = 500, allowNewlines = false } = {}) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  const pattern = allowNewlines ? REASON_CONTROL_CHAR_PATTERN : CONTROL_CHAR_PATTERN;
  if (pattern.test(trimmed)) return null;
  return trimmed;
}

function normalizeSourceAndEvidence(sourceKind, evidenceDate, label, errors) {
  if (!WP3B_BACKFILL_SOURCE_KINDS.includes(sourceKind)) {
    errors.push(`${label}: invalid source_kind ${JSON.stringify(sourceKind)}`);
    return null;
  }
  if (sourceKind === "BACKFILL_DATE_EVIDENCE") {
    if (!isValidIsoCalendarDate(evidenceDate)) {
      errors.push(`${label}: evidence_date must be a valid YYYY-MM-DD when source_kind = BACKFILL_DATE_EVIDENCE`);
      return null;
    }
    return { source_kind: sourceKind, evidence_date: evidenceDate };
  }
  if (evidenceDate !== null && evidenceDate !== undefined) {
    errors.push(`${label}: evidence_date must be null when source_kind = BACKFILL_CURRENT_STATE_ONLY`);
    return null;
  }
  return { source_kind: sourceKind, evidence_date: null };
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (isRecord(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortJsonValue(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Produces canonical key-sorted JSON excluding `manifest_fingerprint`.
 */
export function canonicalizeBackfillManifest(manifest) {
  if (!isRecord(manifest)) {
    throw new TypeError("Manifest must be a plain object");
  }
  const clone = {};
  for (const key of Object.keys(manifest).sort()) {
    if (key === "manifest_fingerprint") continue;
    clone[key] = sortJsonValue(manifest[key]);
  }
  return JSON.stringify(clone);
}

/**
 * Computes deterministic SHA-256 fingerprint over canonical manifest contents.
 */
export function computeBackfillManifestFingerprint(manifest) {
  const canonical = canonicalizeBackfillManifest(manifest);
  return createHash("sha256").update(canonical).digest("hex");
}

function checkAllowedKeys(record, allowedKeys, label, errors) {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${label}: unknown field ${key}`);
    }
  }
}

/**
 * Validates and normalizes a WP3B backfill manifest under OD-WP3-01..05 rules.
 */
export function validateBackfillManifest(rawManifest) {
  const errors = [];
  if (!isRecord(rawManifest)) {
    return { ok: false, errors: ["Manifest root must be a JSON object"] };
  }

  const allowedTopKeys = new Set([
    "schema_version",
    "approved_by",
    "approved_at",
    "actor_app_user_id",
    "reason",
    "account_classifications",
    "persons",
    "department_heads",
    "quarantined_exceptions",
    "manifest_fingerprint",
  ]);
  for (const key of Object.keys(rawManifest)) {
    if (!allowedTopKeys.has(key)) {
      errors.push(`Unknown manifest field: ${key}`);
    }
  }

  if (rawManifest.schema_version !== WP3B_BACKFILL_SCHEMA_VERSION) {
    errors.push(`schema_version must equal ${WP3B_BACKFILL_SCHEMA_VERSION}`);
  }
  const approvedBy = normalizeText(rawManifest.approved_by, { min: 1, max: 120 });
  if (!approvedBy) {
    errors.push("approved_by must be a non-empty string (1..120 chars)");
  }
  if (!isIsoUtcTimestamp(rawManifest.approved_at)) {
    errors.push("approved_at must be a valid ISO-8601 UTC timestamp");
  }
  const actorAppUserId = normalizeUuid(rawManifest.actor_app_user_id);
  if (!actorAppUserId) {
    errors.push("actor_app_user_id must be a valid UUID");
  }
  const reason = normalizeText(rawManifest.reason, { min: 1, max: 500, allowNewlines: true });
  if (!reason) {
    errors.push("reason must be a non-empty string (1..500 chars)");
  }

  if (
    !Array.isArray(rawManifest.account_classifications) ||
    !Array.isArray(rawManifest.persons) ||
    !Array.isArray(rawManifest.department_heads) ||
    !Array.isArray(rawManifest.quarantined_exceptions)
  ) {
    errors.push(
      "account_classifications, persons, department_heads, and quarantined_exceptions must all be arrays",
    );
    return { ok: false, errors };
  }

  const allowedQuarantineKeys = new Set(["kind", "ref", "conflict_code", "note"]);
  const allowedClassKeys = new Set(["account_ref", "account_type", "evidence_note"]);
  const allowedPersonKeys = new Set([
    "employee_code",
    "full_name",
    "status",
    "joined_on",
    "recruiter_id",
    "account_ref",
    "link_source_kind",
    "link_evidence_date",
    "department_membership",
  ]);
  const allowedDeptMembershipKeys = new Set([
    "department_code",
    "source_kind",
    "evidence_date",
  ]);
  const allowedHeadKeys = new Set([
    "department_code",
    "employee_code",
    "source_kind",
    "evidence_date",
  ]);

  const quarantinedAccounts = new Set();
  const quarantinedRecruiters = new Set();
  const normalizedQuarantine = [];
  rawManifest.quarantined_exceptions.forEach((entry, idx) => {
    const label = `quarantined_exceptions[${idx}]`;
    if (!isRecord(entry)) {
      errors.push(`${label}: must be an object`);
      return;
    }
    checkAllowedKeys(entry, allowedQuarantineKeys, label, errors);
    const ref = normalizeUuid(entry.ref);
    const conflictCode = normalizeText(entry.conflict_code, { min: 1, max: 120 });
    const note = normalizeText(entry.note, { min: 1, max: 500, allowNewlines: true });
    if (!WP3B_QUARANTINE_KINDS.includes(entry.kind) || !ref || !conflictCode || !note) {
      errors.push(`${label}: requires valid kind ('ACCOUNT'|'RECRUITER'), ref (uuid), conflict_code, and note`);
      return;
    }
    if (entry.kind === "ACCOUNT") {
      if (quarantinedAccounts.has(ref)) errors.push(`${label}: duplicate quarantined ACCOUNT ${ref}`);
      quarantinedAccounts.add(ref);
    } else {
      if (quarantinedRecruiters.has(ref)) errors.push(`${label}: duplicate quarantined RECRUITER ${ref}`);
      quarantinedRecruiters.add(ref);
    }
    normalizedQuarantine.push({
      kind: entry.kind,
      ref,
      conflict_code: conflictCode,
      note,
    });
  });

  const seenClassAccounts = new Map();
  const normalizedClassifications = [];
  rawManifest.account_classifications.forEach((entry, idx) => {
    const label = `account_classifications[${idx}]`;
    if (!isRecord(entry)) {
      errors.push(`${label}: must be an object`);
      return;
    }
    checkAllowedKeys(entry, allowedClassKeys, label, errors);
    const accountRef = normalizeUuid(entry.account_ref);
    const evidenceNote = normalizeText(entry.evidence_note, { min: 1, max: 500, allowNewlines: true });
    if (!accountRef || !WP3B_ACCOUNT_TYPES.includes(entry.account_type) || !evidenceNote) {
      errors.push(`${label}: requires valid account_ref, account_type, and evidence_note`);
      return;
    }
    if (quarantinedAccounts.has(accountRef)) {
      errors.push(`${label}: account_ref ${accountRef} is also listed in quarantined_exceptions`);
    }
    if (seenClassAccounts.has(accountRef)) {
      errors.push(`${label}: duplicate account_ref ${accountRef}`);
    }
    seenClassAccounts.set(accountRef, entry.account_type);
    normalizedClassifications.push({
      account_ref: accountRef,
      account_type: entry.account_type,
      evidence_note: evidenceNote,
    });
  });

  const seenEmpCodes = new Map();
  const seenRecruiters = new Set();
  const seenPersonAccounts = new Set();
  const normalizedPersons = [];
  rawManifest.persons.forEach((entry, idx) => {
    const label = `persons[${idx}]`;
    if (!isRecord(entry)) {
      errors.push(`${label}: must be an object`);
      return;
    }
    checkAllowedKeys(entry, allowedPersonKeys, label, errors);
    const empCode = normalizeText(entry.employee_code, { min: 2, max: 64 });
    if (!empCode) {
      errors.push(`${label}: employee_code must be 2..64 chars (OD-WP3-03)`);
    } else if (PROJECT_WORKER_HRP_CODE_PATTERN.test(empCode)) {
      errors.push(`${label}: employee_code must not match project worker format ^hrp-YYYY-XXXXXX$`);
    } else {
      const ciKey = empCode.toLowerCase();
      if (seenEmpCodes.has(ciKey)) {
        errors.push(`${label}: duplicate case-insensitive employee_code ${empCode}`);
      }
      seenEmpCodes.set(ciKey, idx);
    }

    const fullName = normalizeText(entry.full_name, { min: 1, max: 160 });
    if (!fullName || UUID_PATTERN.test(fullName)) {
      errors.push(`${label}: full_name must be a non-empty non-UUID display name`);
    }

    if (!WP3B_PERSON_STATUSES.includes(entry.status)) {
      errors.push(`${label}: status must be ACTIVE or INACTIVE`);
    }

    const joinedOn = entry.joined_on ?? null;
    if (joinedOn !== null && !isValidIsoCalendarDate(joinedOn)) {
      errors.push(`${label}: joined_on must be null or valid YYYY-MM-DD`);
    }

    let recruiterId = null;
    if (entry.recruiter_id !== null && entry.recruiter_id !== undefined) {
      recruiterId = normalizeUuid(entry.recruiter_id);
      if (!recruiterId) {
        errors.push(`${label}: recruiter_id must be null or valid UUID`);
      } else {
        if (quarantinedRecruiters.has(recruiterId)) {
          errors.push(`${label}: recruiter_id ${recruiterId} is listed in quarantined_exceptions`);
        }
        if (seenRecruiters.has(recruiterId)) {
          errors.push(`${label}: duplicate recruiter_id ${recruiterId}`);
        }
        seenRecruiters.add(recruiterId);
      }
    }

    let accountRef = null;
    let linkSource = null;
    if (entry.account_ref !== null && entry.account_ref !== undefined) {
      accountRef = normalizeUuid(entry.account_ref);
      if (!accountRef) {
        errors.push(`${label}: account_ref must be null or valid UUID`);
      } else {
        if (quarantinedAccounts.has(accountRef)) {
          errors.push(`${label}: account_ref ${accountRef} is listed in quarantined_exceptions`);
        }
        if (seenPersonAccounts.has(accountRef)) {
          errors.push(`${label}: duplicate account_ref ${accountRef}`);
        }
        seenPersonAccounts.add(accountRef);
        const clsType = seenClassAccounts.get(accountRef);
        if (clsType === "SHARED" || clsType === "SERVICE") {
          errors.push(`${label}: SHARED/SERVICE account ${accountRef} cannot be linked to a Person`);
        }
        linkSource = normalizeSourceAndEvidence(
          entry.link_source_kind,
          entry.link_evidence_date ?? null,
          `${label}.link`,
          errors,
        );
      }
    } else if (
      entry.link_source_kind !== null &&
      entry.link_source_kind !== undefined
    ) {
      errors.push(`${label}: link_source_kind must be null when account_ref is null`);
    } else if (
      entry.link_evidence_date !== null &&
      entry.link_evidence_date !== undefined
    ) {
      errors.push(`${label}: link_evidence_date must be null when account_ref is null`);
    }

    let deptMembership = null;
    if (entry.department_membership !== null && entry.department_membership !== undefined) {
      if (!isRecord(entry.department_membership)) {
        errors.push(`${label}.department_membership: must be an object or null`);
      } else {
        checkAllowedKeys(
          entry.department_membership,
          allowedDeptMembershipKeys,
          `${label}.department_membership`,
          errors,
        );
        const deptCode = typeof entry.department_membership.department_code === "string"
          ? entry.department_membership.department_code.trim()
          : "";
        if (!DEPARTMENT_CODE_PATTERN.test(deptCode)) {
          errors.push(`${label}.department_membership: invalid department_code`);
        }
        const src = normalizeSourceAndEvidence(
          entry.department_membership.source_kind,
          entry.department_membership.evidence_date ?? null,
          `${label}.department_membership`,
          errors,
        );
        if (src) {
          deptMembership = {
            department_code: deptCode,
            source_kind: src.source_kind,
            evidence_date: src.evidence_date,
          };
        }
      }
    }

    normalizedPersons.push({
      employee_code: empCode ?? "",
      full_name: fullName ?? "",
      status: entry.status,
      joined_on: joinedOn,
      recruiter_id: recruiterId,
      account_ref: accountRef,
      link_source_kind: linkSource?.source_kind ?? null,
      link_evidence_date: linkSource?.evidence_date ?? null,
      department_membership: deptMembership,
    });
  });

  const personByLowerCode = new Map(
    normalizedPersons.map((person) => [person.employee_code.toLowerCase(), person]),
  );
  const seenHeadDepts = new Set();
  const normalizedHeads = [];
  rawManifest.department_heads.forEach((entry, idx) => {
    const label = `department_heads[${idx}]`;
    if (!isRecord(entry)) {
      errors.push(`${label}: must be an object`);
      return;
    }
    checkAllowedKeys(entry, allowedHeadKeys, label, errors);
    const deptCode = typeof entry.department_code === "string" ? entry.department_code.trim() : "";
    const empCode = normalizeText(entry.employee_code, { min: 2, max: 64 });
    if (!DEPARTMENT_CODE_PATTERN.test(deptCode) || !empCode) {
      errors.push(`${label}: invalid department_code or employee_code`);
      return;
    }
    if (seenHeadDepts.has(deptCode)) {
      errors.push(`${label}: duplicate HEAD designation for department ${deptCode}`);
    }
    seenHeadDepts.add(deptCode);

    const src = normalizeSourceAndEvidence(
      entry.source_kind,
      entry.evidence_date ?? null,
      label,
      errors,
    );
    const targetPerson = personByLowerCode.get(empCode.toLowerCase());
    if (!targetPerson) {
      errors.push(`${label}: employee_code ${empCode} not found in persons[]`);
    } else {
      if (targetPerson.status !== "ACTIVE") {
        errors.push(`${label}: HEAD person ${empCode} must have status ACTIVE (OD-WP3-04)`);
      }
      if (targetPerson.department_membership?.department_code !== deptCode) {
        errors.push(
          `${label}: HEAD person ${empCode} must hold an active membership in ${deptCode} (OD-WP3-04)`,
        );
      }
    }

    normalizedHeads.push({
      department_code: deptCode,
      employee_code: targetPerson ? targetPerson.employee_code : empCode,
      source_kind: src?.source_kind ?? entry.source_kind,
      evidence_date: src?.evidence_date ?? null,
    });
  });

  const computedFingerprint = computeBackfillManifestFingerprint({
    schema_version: WP3B_BACKFILL_SCHEMA_VERSION,
    approved_by: rawManifest.approved_by,
    approved_at: rawManifest.approved_at,
    actor_app_user_id: rawManifest.actor_app_user_id,
    reason: rawManifest.reason,
    account_classifications: rawManifest.account_classifications,
    persons: rawManifest.persons,
    department_heads: rawManifest.department_heads,
    quarantined_exceptions: rawManifest.quarantined_exceptions,
  });

  if (
    rawManifest.manifest_fingerprint !== undefined &&
    rawManifest.manifest_fingerprint !== null
  ) {
    if (
      typeof rawManifest.manifest_fingerprint !== "string" ||
      !SHA256_HEX_PATTERN.test(rawManifest.manifest_fingerprint.trim().toLowerCase())
    ) {
      errors.push("manifest_fingerprint must be a 64-character lowercase SHA-256 hex digest");
    } else if (rawManifest.manifest_fingerprint.trim().toLowerCase() !== computedFingerprint) {
      errors.push(
        `manifest_fingerprint mismatch: expected ${computedFingerprint}, got ${rawManifest.manifest_fingerprint}`,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    manifest_fingerprint: computedFingerprint,
    manifest: {
      schema_version: WP3B_BACKFILL_SCHEMA_VERSION,
      approved_by: approvedBy,
      approved_at: rawManifest.approved_at,
      actor_app_user_id: actorAppUserId,
      reason,
      account_classifications: normalizedClassifications,
      persons: normalizedPersons,
      department_heads: normalizedHeads,
      quarantined_exceptions: normalizedQuarantine,
      manifest_fingerprint: computedFingerprint,
    },
  };
}
