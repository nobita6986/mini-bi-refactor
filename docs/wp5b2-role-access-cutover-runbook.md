# WP5B-2 — Cutover Role/Effective Access & Group A Rollout Runbook

**Migration:** [20261118160000_wp5b2_role_access_cutover.sql](../supabase/migrations/20261118160000_wp5b2_role_access_cutover.sql)  
**Cutover Manifest & Diff:** [wp5-cutover-manifest.mjs](../scripts/lib/wp5-cutover-manifest.mjs)  
**Cutover CLI / Library:** [wp5-cutover-role-access.mjs](../scripts/wp5-cutover-role-access.mjs)  
**Foundation Spec:** [wp5b1-role-effective-access-foundation.md](./wp5b1-role-effective-access-foundation.md)

---

## 0. Hard Invariants Before Execution

1. Applying migration `20261118160000_wp5b2_role_access_cutover.sql` **does NOT** run backfill and **does NOT** flip `public.authz_system_state.cutover_ready = true` or `public.direct_entry_app_users.authz_managed = true`. Cutover execution is exclusively controlled by [wp5-cutover-role-access.mjs](../scripts/wp5-cutover-role-access.mjs) behind explicit `--apply --confirm-apply --expected-fingerprint <sha256>`.
2. `AUTHZ_ROLE_MUTATIONS_ENABLED` on `bi2` / Production remains `false` until WP6 UI & T0/Owner UAT explicitly authorize enabling live `/api/admin/access/**` role mutations.
3. Never commit NWC/Production dumps, connection strings, or read-only plan artifacts into the Git repository; store all dry-run JSON outputs outside the repo.

---

## Phase 1 — Hold Auto-Deploy on Dokploy (`bi2`) Before Merge

1. Inspect the Dokploy application settings for `bi2` (`bi-refactor-uat-jcgxho`) before merging the WP5B-2 PR.
2. Disable automatic branch deployments (`autoDeploy = false`) so merging into `main` does **NOT** build or deploy the Group A paired runtime readers while the target database is still pre-migration / pre-cutover.
3. Confirm `AUTHZ_ROLE_MUTATIONS_ENABLED=false` remains set in runtime environment variables.

---

## Phase 2 — Backup & Baseline Verification

1. Take a fresh logical/physical backup of the target database (NWC staging first; Production only when explicitly approved by Owner/T0) immediately prior to maintenance execution.
2. Read-only baseline checks (must run inside a `READ ONLY` transaction):
   - `public.authz_system_state.cutover_ready = false`
   - `SELECT count(*) FROM public.direct_entry_app_users WHERE authz_managed = true;` equals `0`
   - `supabase_migrations.schema_migrations` count matches expected baseline (`220` before `20261118160000_wp5b2_role_access_cutover.sql` on NWC)

---

## Phase 3 — Read-Only Plan & Fingerprint Lock

Run the deterministic read-only plan (`REPEATABLE READ READ ONLY` + `ROLLBACK`) against the target database and save the redacted JSON artifact **outside the repository**:

```bash
node scripts/wp5-cutover-role-access.mjs \
  --read-only-plan \
  --nwc-staging \
  --config C:/importal/db-test-nwc/DB-staging-for-VPS-nwc.txt \
  --out C:/CodeApp/bi-refactor-wp5/wp5b2-dryrun/wp5b2-readonly-cutover-plan.json
```

Verify from the generated report before proceeding:

- `system_state.cutover_ready === false`
- `action_diff_summary.unexpected_diff_count === 0`
- `canonical_owner.rejected_local_part_collision_count === 0` (unless an explicit expected collision exists and is verified non-ADMIN)
- Review every `INTENTIONAL_POLICY_CHANGE` transition (`ADMIN` 21-cap unification, `luanpt` orphan `all` scope closure, `UNPAIRED_ALL_REPORTING_TIGHTENED`, `WORKER_EDIT_HISTORY_ALLOWLIST_TO_CAPABILITY`, `AI_SETTINGS_LOCKED_TO_FULL_ADMIN`).
- Record and lock a **fresh** 64-hex `manifest_fingerprint` string at deployment time for Phase 5 (never reuse an older day's fingerprint). Notice `manifest_fingerprint` covers account `enabled`, `account_type`, `version`, suspended D10 state, and assignment/delegation sources (`source_snapshot`). Any change to those rows between `--read-only-plan` and `--apply` invalidates the fingerprint (`CUTOVER_FINGERPRINT_MISMATCH`).

If `unexpected_diff_count > 0`, **STOP** immediately and resolve the unexpected capability/scope drift before merging or migrating.

---

## Phase 4 — Merge While Deploy Remains Held

1. Ensure all required GitHub Actions CI checks on the PR are green (`gh pr checks`).
2. Confirm `bi2` still has `autoDeploy = false`.
3. Only after Owner/T0 explicitly approves merge, merge the PR into `main`. Verify `bi2` does not start an unintended deploy.

---

## Phase 5 — Apply Migration `20261118160000` & Execute Guarded Cutover

1. Apply database migration `supabase/migrations/20261118160000_wp5b2_role_access_cutover.sql` to the target environment and confirm the migration ledger increments cleanly (e.g. `220 -> 221`) with `$check_wp5b2$` passing.
2. Execute the full-transaction dry-run (`BEGIN ... ROLLBACK`) to validate lock acquisition, fingerprint match, and post-cutover SQL invariants without committing:

   ```bash
   node scripts/wp5-cutover-role-access.mjs \
     --dry-run \
     --nwc-staging \
     --config C:/importal/db-test-nwc/DB-staging-for-VPS-nwc.txt \
     --expected-fingerprint <LOCKED_64_HEX_FINGERPRINT>
   ```

   Confirm `status === "DRY_RUN_VERIFIED"` and `postconditions` pass. Inside both `--dry-run` and `--apply`, `runWp5Cutover` acquires `authz_system_state FOR UPDATE` (serializing concurrent `direct_entry_account_operation_finalize_create` calls via `FOR SHARE`) and `direct_entry_app_users ORDER BY app_user_id ASC FOR UPDATE` **before** calling `readCutoverInventory()`, building the manifest, or checking `--expected-fingerprint`. If `enabled`, `account_type`, `version`, or assignment/delegation sources changed concurrently after `--read-only-plan`, `--apply` aborts cleanly (`CUTOVER_FINGERPRINT_MISMATCH` / `CUTOVER_SOURCE_STATE_DRIFT`) with full `ROLLBACK` and without overwriting anything; regenerate and re-review a fresh `--read-only-plan` before retrying.

3. Execute the single transactional cutover (`--apply`) with both explicit safety guards:

   ```bash
   node scripts/wp5-cutover-role-access.mjs \
     --apply \
     --confirm-apply \
     --expected-fingerprint <LOCKED_64_HEX_FINGERPRINT> \
     --nwc-staging \
     --config C:/importal/db-test-nwc/DB-staging-for-VPS-nwc.txt \
     --out C:/CodeApp/bi-refactor-wp5/wp5b2-dryrun/wp5b2-applied-cutover-report.json
   ```

4. Verify post-cutover SQL state:
   - `status === "APPLIED"`
   - `public.authz_system_state.cutover_ready = true`
   - `0` accounts with `direct_entry_app_users.authz_managed = false`
   - Pre-commit postconditions verified zero drift on per-account `enabled`, `account_type`, `version`, open `global_roles`, effective grants, and non-grant contextual/delegation digest (`computeNonGrantInventoryDigest`).
   - Strictly `1` open protected assignment (`role_code = 'ADMIN'`, `is_protected = true`, `protected_reason = 'PROTECTED_OWNER_ADMIN'`) on canonical Owner
   - Accounts D10-suspended via WP5B-1 (`suspended_by_account_disable = true`) retain their dormant roles in `authz_account_role_assignments` (`0` effective grants while disabled; restored automatically upon `direct_entry_enable_app_user`), whereas historical pre-WP5 disabled accounts have `authz_managed = true`, `0` open roles, `0` effective grants, and never resurrect.
   - Re-running `--apply` returns `ALREADY_APPLIED_NOOP` idempotently (including after creating standalone accounts or linking personnel post-cutover).

---

## Phase 6 — Deploy Exact SHA to `bi2` & UAT Verification

1. Keep `AUTHZ_ROLE_MUTATIONS_ENABLED=false` (unless explicitly instructed otherwise for WP6 UAT).
2. Trigger deployment on Dokploy `bi2` pinned to the exact merged commit SHA (and restore `autoDeploy` per operational policy once healthy).
3. Run UAT verification across Group A consumers:
   - **Initial `ADMIN` (`BoD/Admin`) accounts:** All `4` initial admins share the `21`-capability bundle (`worker_edit_history_*`, missing documents `@ ALL`, reporting `@ ALL`, `/api/ai/settings/**`, TL management); `recruitment_post_create` remains PM-only (`42501` if non-PM).
   - **`HR_OPERATOR`:** Can view `/admin/catalog/teams` and call Team Leader designate/revoke (`team_master_manage @ ALL`), denied `/api/ai/settings/**` (`403 AI_FORBIDDEN`) and `entry_admin`.
   - **`RECRUITER` / `EMPLOYEE_BASE`-only:** Accounts without `entry_admin` or `report_analytics_view @ ALL` resolve strictly to their `own` / `team` audience; accounts with zero recruiter links resolve to safe empty `own`.
   - **Post-cutover account creation & reconcile (`CREATE_ACCOUNT` -> `direct_entry_account_operation_finalize_create`):** Newly finalized accounts enter the new model immediately (`authz_managed = true`, open `EMPLOYEE_BASE` role, `0` entry grants until `create_personnel` / `link_recruiter`), and subsequent `--apply` / verification re-runs remain `ALREADY_APPLIED_NOOP`.
   - **Work Reports `R3` Delegation:** Template-scoped delegates (`haidx.td` on approved template `T1`) retain review access on `T1`, are denied on unrelated `T2`, and have `0` blanket `report_review`/`report_assign` rows in `effective_grants` or `direct_entry_capability_grants`.
   - **AI Settings (`OD-WP5-04`):** `PILOT_ACTOR_REF` is absent; non-Full-Admin / non-UUID callers fail closed with `403 AI_FORBIDDEN`; Full Admin writes store the caller's UUID `app_user_id`.

---

## Phase 7 — Forward-Fix / Incident Recovery (Never Blindly Roll Back)

- **Do NOT** execute a blind snapshot restore or mass `TRUNCATE` of `authz_account_role_assignments` / `direct_entry_capability_grants` after live traffic or post-cutover mutations have occurred, and **DO NOT** flip `cutover_ready` back to `false` on a database with live WP5 role/personnel mutations (which would resurrect stale legacy scopes or break `create_personnel` / `link_recruiter` parity).
- If an account exhibits unexpected access post-cutover:
  1. Inspect `public.authz_audit_events` (`WP5B2_CUTOVER_APPLY`, `AUTHZ_GLOBAL_ROLE_*`, `AUTHZ_DIRECT_*`) and `public.direct_entry_resolve_actor_context(auth_subject)`.
  2. Apply a surgical **forward-fix**:
     - If an exception capability or role needs adjustment, insert/close the targeted row in `public.authz_account_role_assignments` or `public.authz_direct_capability_grants` (recording `authz_audit_events` reason/reference) or call the canonical admin RPC, then run `SELECT public.direct_entry_authz__internal_sync_legacy_grants(p_app_user_id);`.
     - If a legacy SQL RPC or TypeScript Group A gate misbehaves on an edge case, ship a forward-fix SQL migration (`CREATE OR REPLACE FUNCTION ...`) / hotfix commit while keeping `cutover_ready = true` and `authz_managed = true` intact.
  3. Only if an unrecoverable infrastructure failure occurs **before** any post-cutover traffic/mutations during the initial maintenance window may the DBA restore the Phase 2 pre-migration backup while keeping `bi2` deployed at the pre-WP5B-2 SHA.
