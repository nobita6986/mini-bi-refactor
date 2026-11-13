# WP2A — Read-Only Candidate Effective Access Resolver & Shadow Comparator

**Branch:** `codex/wp2-effective-access-shadow`  
**Base SHA:** `97f62df7888ea7410067323b770b9cb2b2780557`  
**Scope:** Non-invasive shadow evaluation only. No runtime authorization readers, UI pages, API routes, or NWC database state were modified.

---

## 1. Non-Invasive Shadow Guarantee

- **Runtime Untouched:** `bi2` continues to evaluate permissions solely through the existing production-parity readers.
- **NWC Database Untouched:** Migration `supabase/migrations/20261113120000_wp2a_effective_access_candidate_shadow.sql` was **not** applied to NWC (`nwcvmigrhzdywaumkrjp`). Live NWC verification executed only read-only `SELECT` scripts inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;` followed by `ROLLBACK`, over pinned TLS root CA (`supabase-pooler-root-2021-ca.pem`).
- **Strict ACL:** All shadow SQL RPCs in `supabase/migrations/20261113120000_wp2a_effective_access_candidate_shadow.sql` revoke `PUBLIC`/`anon`/`authenticated` access and grant `EXECUTE` strictly to `service_role`.

---

## 2. Architecture & Artifacts

| Artifact | Purpose |
| :--- | :--- |
| `supabase/migrations/20261113120000_wp2a_effective_access_candidate_shadow.sql` | Shadow RPCs: `direct_entry_authz_resolve_candidate_access`, `direct_entry_authz_resolve_current_snapshot`, `direct_entry_authz_compare_shadow_access` |
| `scripts/wp2a-shadow/sql/01_current_effective_snapshot.sql` | Standalone read-only snapshot matching current `is_current` reader semantics |
| `scripts/wp2a-shadow/sql/02_candidate_and_diff.sql` | Standalone read-only candidate resolver + classified diff vs current snapshot |
| `scripts/wp2a-shadow/sql/03_drift_diagnostics.sql` | Standalone data/authority drift diagnostics (`HIGH`, `MEDIUM`, `INFO`) |
| `scripts/wp2a-shadow/sql/04_uat_persona_matrix_check.sql` | UAT persona matrix classification & provisioning gap detector |
| `scripts/run-wp2a-effective-access-shadow.mjs` | CLI runner supporting `--pglite` (seeded RPC-vs-SQL parity) and `--nwc --config <path>` (`--as-of <iso>`, `--explain`) |
| `scripts/wp2a-effective-access-shadow-db.test.mjs` | PGlite regression suite (`WP2A-1` through `WP2A-10`) registered in CI manifest as `test:wp2a-effective-access-shadow` |

---

## 3. Nine Authority Sources & Candidate Semantics

The candidate resolver reconstructs effective access at a given `as_of` timestamp across all 9 underlying authority sources while enforcing temporal intervals (`[valid_from, valid_to)` and `[effective_from, effective_to)`), account status, shared non-employee exclusion, and ambiguity guards:

| # | Authority Source Table(s) | Candidate `action_code` / `op:*` Tokens | Enforced Invariants / Expected Diffs |
| :-: | :--- | :--- | :--- |
| 1 | `direct_entry_capability_grants` | `cap:<capability>` (all 33 canonical capability tokens) | Temporal `[valid_from, valid_to)` check; avoids resurrecting wiped `is_current = false, valid_to IS NULL` rows; eliminates same-day revoke traps |
| 2 | `direct_entry_scope_grants` | `scope:all`, `scope:team`, `scope:own` | Orphan `scope:all` without Full Admin bundle (`entry_admin`, `recruiter_master_manage`, `team_master_manage`) is narrowed/flagged (`EXPECTED_FIX_ORPHAN_ALL_SCOPE`) unless user has explicit fallback/BoD rights |
| 3 | `direct_entry_app_user_recruiter_links` | `recruiter_link:verified` | Requires unambiguous 1:1 active verified link (`EXPECTED_FIX_AMBIGUOUS_RECRUITER_LINK` on conflict) |
| 4 | `direct_entry_team_leader_assignments` | `assignment:team_leader` | Point-in-time interval reconstruction supports clean historical handover attribution |
| 5 | `direct_entry_project_manager_assignments` | `assignment:project_manager` | Derived via verified 1:1 recruiter link at `as_of` |
| 6 | `organization_department_memberships` | `dept_member:ACCOUNTING` | Active accounting department membership (enforced prerequisite for project accountant operations) |
| 7 | `leave_module_grants`, `leave_department_approvers` | `leave_role:<role_code>`, `department_approver:<unit_kind>`, `op:leave:approve_department` | Shared non-employee profiles (`is_shared_non_employee = true`) are excluded (`EXPECTED_FIX_SHARED_ACCOUNT_EXCLUSION`) |
| 8 | `vendor_finance_global_roles`, `vendor_finance_project_accountants` | `vfin_role:<role_code>`, `vfin_project_accountant`, `op:vendor_finance:project_ledger_operate` | Project accountant operation requires active `ACCOUNTING` membership (`EXPECTED_FIX_PROJECT_ACCOUNTANT_REQUIRES_ACCOUNTING_DEPT`) |
| 9 | `work_report_delegations` | `delegation:<capability>`, `op:work_reports:assign`, `op:work_reports:review` (`<template_id>:<team_id\|*>`) | Open-ended (`effective_to IS NULL`) or active range, `state = 'ACTIVE'`, valid grantor, valid published template, and eligible delegate (`EXPECTED_FIX_DELEGATION_GRANTOR_INVALID` when grantor expired/invalid) |

---

## 4. Observed Live NWC Shadow Run (`2026-11-13 10:37:01+07`)

Executed via:
```powershell
node scripts/run-wp2a-effective-access-shadow.mjs --nwc --explain --config <path-to-nwc-config>
```

### Verification & Diff Summary

- **Target Ref Guard:** Verified `nwcvmigrhzdywaumkrjp` (`tlsCaVerified: supabase-pooler-root-2021-ca.pem`, `readOnlyTransactionVerified: true`).
- **Live Snapshot & Diff:**
  - `snapshotRowCount`: **1,766**
  - `diffRowCount`: **4** — all 4 classified as `EXPECTED_FIX_ORPHAN_ALL_SCOPE` on masked user `097d29a5...`
  - `unexpectedDiffCount`: **0**
- **Historical Check (`--as-of 2026-11-12T17:00:00+07:00`):**
  - `snapshotRowCount`: **1,759**, `diffRowCount`: **33**
  - Captured a real `2026-11-13` Team Leader handover (`541fb2a2... -> 83044abf...`), demonstrating that `01_current_effective_snapshot.sql` only sees `is_current = true` while the candidate resolver accurately reconstructs historical `[valid_from, valid_to)` ownership.

### Drift Diagnostics (`189` rows)

| Severity & Code | Count |
| :--- | :---: |
| `HIGH:ALL_SCOPE_WITH_ZERO_CAPABILITIES` | 1 |
| `HIGH:ACCOUNTING_DEPT_VS_LEAVE_UNIT_KIND_CONFLICT` | 2 |
| `HIGH:RECRUITER_LINK_VS_LEAVE_UNIT_KIND_CONFLICT` | 6 |
| `HIGH:SHARED_ACCOUNT_HAS_WORK_REPORT_OBLIGATION` | 1 |
| `MEDIUM:RECRUITER_WITHOUT_TEAM_MEMBERSHIP` | 46 |
| `MEDIUM:UNCLASSIFIED_OR_MISSING_EMPLOYEE_UNIT_KIND` | 7 |
| `INFO:MISSING_VALID_TO_ON_NON_CURRENT_ROW` | 126 |

### UAT Persona Matrix (`81` rows)

- **Observed Personas:** `P01_EMPLOYEE_RECRUITER` (11), `P02_TEAM_LEADER` (2), `P03_DEPARTMENT_HEAD` (1), `P04_PROJECT_MANAGER` (34), `P05_ACCOUNTANT` (5), `P07_BOD_ADMIN` (3), `P08_SHARED_SERVICE` (2), `P09_DISABLED_OR_REENABLED` (12), `P10_MULTI_ROLE` (8).
- **Provisioning Gaps Reported:** `MISSING_CATALOG_WITH_ALL_SCOPE`, `MISSING_CATALOG_WITHOUT_ALL_SCOPE`, `MISSING_P06`.

### NWC `EXPLAIN (ANALYZE, BUFFERS)` Performance

| Query | Planning (ms) | Execution (ms) | Rows | Shared Hit Blocks | Shared Read / Temp Written |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `currentSnapshot` | 7.647 | 27.862 | 1,766 | 6,591 | 0 / 0 |
| `candidateDiff` | 20.278 | 72.985 | 4 | 78,915 | 0 / 0 |
| `driftDiagnostics` | 7.728 | 4.347 | 189 | 1,644 | 0 / 0 |
| `uatPersonaMatrix` | 19.689 | 45.129 | 81 | 71,352 | 0 / 0 |

---

## 5. WP2B Shadow Monitoring Runbook (Pre-Cutover Gate)

1. Execute `node scripts/run-wp2a-effective-access-shadow.mjs --nwc --explain --config <nwc-config>` regularly across **>= 1 full workweek** and **>= 1 real role/assignment handover** prior to WP2B/WP3 cutover.
2. Verify `unexpectedDiffCount === 0` on every live capture, and confirm `tempWrittenBlocks === 0` across all 4 shadow queries.
3. Triage and remediate open NWC `HIGH` drift items and provision missing UAT personas (`P06`, `MISSING_CATALOG_*`) before advancing to WP3 cutover.
