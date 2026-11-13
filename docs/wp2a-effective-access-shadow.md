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
| `scripts/wp2a-effective-access-shadow-db.test.mjs` | PGlite regression suite (`WP2A-1` through `WP2A-12`) registered in CI manifest as `test:wp2a-effective-access-shadow` |

---

## 3. Nine Authority Sources & Tightened Candidate Semantics

The candidate resolver reconstructs effective access at a given `as_of_ts` across all 9 underlying authority sources while enforcing per-source temporal rules, strict capability + scope pairing, 1:1 verified recruiter links, account status, shared non-employee exclusion, and strict fallback precedence:

### Module & Reporting Rules
- **Dashboard (`op:dashboard:view_general`, `view_workforce_deep`, `view_detailed_matrix`):**
  - `@ all` requires `FullAdmin` or `cap:entry_privileged_edit` or `cap:report_view` (`view_workforce_deep` & `view_detailed_matrix` additionally require `cap:report_analytics_view` when authorized via `report_view`).
  - `@ team` requires `cand_r1_scopes` with active non-vendor team + (`cap:entry_team` | `cap:report_view` | `cap:entry_privileged_edit` | `FullAdmin`), and falls back past an unauthorized `scope:all` grant.
  - `@ recruited` requires a **strict 1:1** verified active recruiter link (`cand_unambiguous_recruiter_links`) + (`cap:entry_own` | `cap:report_view` | `cap:entry_privileged_edit` | `FullAdmin`), and falls back past invalid `all` and unauthorized `team` scopes.
- **Workforce Offboarding & Direct Entry Workers All Tab:**
  - `op:workforce:offboarding_view @ all` requires `FullAdmin` or `cap:entry_privileged_edit`; `@ team` requires active TL assignment (`cand_team_leader_assignments`) + active `team` scope + `cap:team_manager_assign` + no `@ all` entitlement.
  - `op:direct_entry:workers_all_tab @ all` requires active `scope:all` + (`cap:entry_admin` | `cap:change_review`).
- **Attendance (`op:attendance:report_view @ team`):** requires canonical TL + active `team` scope + `cap:team_manager_assign` + `cap:report_view` + `cap:report_analytics_view`.

| # | Authority Source Table(s) | Temporal Reconstruction & Honest Limitation Contract | Enforced Invariants / Expected Diffs |
| :-: | :--- | :--- | :--- |
| 1 | `direct_entry_capability_grants` | `[valid_from, valid_to)` + intra-day `created_at` guard; **date-only close** (`LIMITATION_DATE_GRANULARITY_ONLY` on past `as_of_ts`) | Avoids resurrecting wiped `is_current = false, valid_to IS NULL` rows; eliminates same-day future/expired drift |
| 2 | `direct_entry_scope_grants` | `[valid_from, valid_to)` + intra-day `created_at` guard; **date-only close** (`LIMITATION_DATE_GRANULARITY_ONLY` on past `as_of_ts`) | Rejects `__system_vendor__`; pairs `scope:all` with module capabilities (`EXPECTED_FIX_ORPHAN_ALL_SCOPE`, `EXPECTED_FIX_ALL_SCOPE_WRONG_MODULE_CAPABILITY`) |
| 3 | `direct_entry_app_user_recruiter_links` | `[valid_from, valid_to)` + intra-day `created_at` guard; **date-only close** (`LIMITATION_DATE_GRANULARITY_ONLY`) | Derived ops enforce strict 1:1 `app_user_id <-> recruiter_id` multiplicity (`EXPECTED_FIX_AMBIGUOUS_RECRUITER_LINK` for both `1:2` and `2:1`) |
| 4 | `direct_entry_team_leader_assignments` (+ `direct_entry_team_leader_revisions`) | Exact intra-day closing via `tl_close` in `direct_entry_team_leader_revisions` when present (`INTRADAY_TS_RECONSTRUCTIBLE_VIA_TL_REVISIONS`); ignores cancelled future replacements; falls back to `LIMITATION_DATE_GRANULARITY_ONLY` if revision ts absent | Supports same-day handover and cancellation reconstruction |
| 5 | `direct_entry_project_manager_assignments` | Exact `[created_at, revoked_at)` bounds including `valid_to = valid_from` (`INTRADAY_TS_RECONSTRUCTIBLE_VIA_REVOKED_AT`); link leg discloses `link_date_granularity` | Derived via unambiguous 1:1 verified recruiter link at `as_of_ts` |
| 6 | `organization_department_memberships` | Exact `[created_at, revoked_at)` bounds including `valid_to = valid_from` (`INTRADAY_TS_RECONSTRUCTIBLE_VIA_REVOKED_AT`) | Active `ACCOUNTING` membership prerequisite for project accountant module ops |
| 7 | `leave_module_grants`, `leave_department_approvers` | `leave_module_grants` reconstructs exact close from `leave_audit_events` (`MODULE_GRANT_REVOKE`, `payload->>'grant_id'`) with fallback to bounded `updated_at`; `leave_department_approvers` uses matching same-day `updated_at` close or falls back to `LIMITATION_DATE_GRANULARITY_ONLY` | Shared non-employee profiles (`is_shared_non_employee = true`) excluded (`EXPECTED_FIX_SHARED_ACCOUNT_EXCLUSION`) |
| 8 | `vendor_finance_global_roles`, `vendor_finance_project_accountants` | Exact `[created_at, ended_at)` bounds including `valid_to = valid_from` (`INTRADAY_TS_RECONSTRUCTIBLE_VIA_ENDED_AT`) | Project accountant module ops require active `ACCOUNTING` membership (`EXPECTED_FIX_PROJECT_ACCOUNTANT_REQUIRES_ACCOUNTING_DEPT`) |
| 9 | `work_report_delegations` | Exact `[effective_from, least(effective_to, revoked_at))` (`INTRADAY_TS_RECONSTRUCTIBLE`) | Open-ended (`effective_to IS NULL`) or active range, `state = 'ACTIVE'`, valid grantor, valid published template, and eligible delegate (`EXPECTED_FIX_DELEGATION_GRANTOR_INVALID`) |

> **Fail-Closed Diff Classifier:** `direct_entry_authz_compare_shadow_access` classifies `LOST_IN_CANDIDATE` / `GAINED_IN_CANDIDATE` rows strictly via independent `ev_*` base-table evidence CTEs (never inspecting `candidate_rows`). Unjustified drops or widenings fail closed to `UNEXPECTED_REGRESSION_CHECK_REQUIRED` or `UNEXPECTED_WIDENING_CHECK_REQUIRED`.

---

## 4. Observed Live NWC Shadow Runs (`2026-11-13`)

Executed via:
```powershell
node scripts/run-wp2a-effective-access-shadow.mjs --nwc --explain --config <path-to-nwc-config>
node scripts/run-wp2a-effective-access-shadow.mjs --nwc --as-of 2026-11-13T09:00:00+07:00 --config <path-to-nwc-config>
```

### Verification & Diff Summary

- **Target Ref Guard:** Verified `nwcvmigrhzdywaumkrjp` (`tlsCaVerified: supabase-pooler-root-2021-ca.pem`, `readOnlyTransactionVerified: true`).
- **Live Snapshot & Diff (`2026-11-13 12:18:56+07`):**
  - `snapshotRowCount`: **1,775**
  - `diffRowCount`: **4** — all 4 classified as `EXPECTED_FIX_ORPHAN_ALL_SCOPE` on masked user `097d29a5...`
  - `unexpectedDiffCount`: **0**
- **Intra-Day Historical Check (`--as-of 2026-11-13T09:00:00+07:00`):**
  - `snapshotRowCount`: **1,775**, `diffRowCount`: **28**, `unexpectedDiffCount`: **0**
  - `EXPECTED_FIX_HISTORICAL_INTRADAY_RECONSTRUCTED`: **8** (reconstructed `541fb2a2...` TL & `MARKETING` Dept Approver and `93968d2c...` PM on `Coasia` prior to intra-day handovers)
  - `EXPECTED_FIX_HISTORICAL_INTRADAY_CREATED_AFTER_ASOF`: **15** (correctly excluded `83044abf...` and `bde8db2f...` grants created after `09:00+07`)
  - `EXPECTED_FIX_DASHBOARD_FALLBACK_AFTER_INVALID_ALL_SCOPE`: **1** (`83044abf...` fell back to capability-backed `@ recruited`, disclosing `LIMITATION_DATE_GRANULARITY_ONLY`)
  - `EXPECTED_FIX_ORPHAN_ALL_SCOPE`: **4** (`097d29a5...`)

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

### NWC `EXPLAIN (ANALYZE, BUFFERS)` Performance (`2026-11-13 12:18:56+07`)

| Query | Planning (ms) | Execution (ms) | Rows | Shared Hit Blocks | Shared Read / Temp Written |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `currentSnapshot` | 8.679 | 28.601 | 1,775 | 6,591 | 0 / 0 |
| `candidateDiff` | 63.150 | 100.263 | 4 | 88,610 | 0 / 0 |
| `driftDiagnostics` | 10.468 | 6.111 | 189 | 1,644 | 0 / 0 |
| `uatPersonaMatrix` | 25.694 | 42.262 | 81 | 73,100 | 0 / 0 |

---

## 5. WP2B Shadow Monitoring Runbook (Pre-Cutover Gate)

1. Execute `node scripts/run-wp2a-effective-access-shadow.mjs --nwc --explain --config <nwc-config>` regularly across **>= 1 full workweek** and **>= 1 real role/assignment handover** prior to WP2B/WP3 cutover.
2. Verify `unexpectedDiffCount === 0` on every live capture, and confirm `tempWrittenBlocks === 0` across all 4 shadow queries.
3. Triage and remediate open NWC `HIGH` drift items and provision missing UAT personas (`P06`, `MISSING_CATALOG_*`) before advancing to WP3 cutover.
