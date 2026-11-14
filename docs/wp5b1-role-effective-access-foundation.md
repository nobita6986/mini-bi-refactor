# WP5B-1 — Unified Role, Capability, Scope & Effective Access Foundation

**Branch:** `codex/wp5-role-access-foundation`  
**Base SHA:** `10b4032ef1560ef8f600881795d25e974a131d69`  
**Contract:** `WP5A` Rev 3 (`2026-11-14`) — Unified `ADMIN` (`BoD/Admin`), Single Canonical Owner Protection, and T0 Fixes `C1`–`C4`.  
**Scope & Safety Guarantee:** Additive foundation (`PR 1`) plus a pure dry-run cutover manifest helper ([wp5-cutover-manifest.mjs](../scripts/lib/wp5-cutover-manifest.mjs)). Contains **zero secrets, zero database credentials, zero environment connection strings, and zero live NWC/Production mutations**. Live `direct_entry_app_users.authz_managed` stays `false`, `authz_system_state.cutover_ready` stays `false`, and existing runtime behavior for Web PR 0 (`10b4032e`) remains preserved until reviewed `PR 2` cutover.

---

## 1. PR 1 vs PR 2 Cutover Boundary (`C1`) & Compatibility

WP5 is deliberately split into two pull requests so foundation schema, security boundaries, and shared contracts land cleanly without prematurely shifting live privileges or breaking Web PR 0 (`10b4032ef`):

| Layer | PR 1 (`WP5B-1` — Additive Foundation) | PR 2 (`WP5B-2 + WP6` — Cutover + Admin UI) |
|---|---|---|
| **Global Cutover Gate** | `public.authz_system_state.cutover_ready = false`; `direct_entry_app_users.authz_managed` defaults to `false`. | Pre-cutover reconciliation (`$reconcile_pre_cutover$`) executes manifest plan, sets `authz_managed = true`, and flips `cutover_ready = true`. |
| **Role Mutations API** | Gated by `AUTHZ_ROLE_MUTATIONS_ENABLED=true` (`404 NOT_FOUND` when env flag absent/false) and DB `cutover_ready = false` (**`409 AUTHZ_CUTOVER_NOT_READY`**). | `cutover_ready = true` enables live `POST` assign and `DELETE` revoke through the `5` hardened RPCs/routes. |
| **Live Accounts & `luanpt`** | **Untouched** in PR 1: no `ADMIN` backfill on `luanpt`/`lienvu`/`ngattt`/`nobita6986@gmail.com`, `luanpt`'s existing `all` scope grant is NOT closed, and `worker_edit_history_is_allowlisted_admin` remains active. | Executes [wp5-cutover-manifest.mjs](../scripts/lib/wp5-cutover-manifest.mjs) plan: closes `luanpt` orphan `all` scope, assigns unified `ADMIN` (`BoD/Admin`) to `luanpt`, `lienvu`, `ngattt`, and canonical Owner (`is_protected = true` on Owner only), removes email allowlist. |
| **Runtime Consumers** | `direct_entry_resolve_actor_context` preserves all legacy payload fields required by Web PR 0 and adds additive `effective_grants` + `assigned_roles`. `hasPairedCapability` fails closed when called on paired consumers. | Switches Group A (`ENFORCED_PAIRED`) SQL/TS readers (reporting `all`/`team`/`own`, `n8n` `isVerifiedAllScopeActor`, `worker_edit_history`, missing docs, TL catalog split, `/api/ai/settings/**`) to paired authorization. |
| **Dokploy Gate (`bi2`)** | Standard fork CI checks on PR 1 (`autoDeploy = true` deployment safety preserved by additive PR 1 semantics; do not apply to NWC without explicit approval). | **Mandatory manual gate:** pause/hold `autoDeploy` on Dokploy `bi-refactor-uat-jcgxho` (`bi2`) **before** merging PR 2 -> run dry-run manifest verification -> merge PR 2 -> apply migration PR 2 -> verify intentional action diff -> deploy Web PR 2. |

---

## 2. Canonical `8`-Role Catalog (`ADMIN` = `"BoD/Admin"`, No `BOD` / `BOD_ADMIN`)

Exactly **`8` canonical roles** exist in `public.authz_role_definitions` (`4` `GLOBAL` + `4` `CONTEXTUAL`). There is **no** separate `BOD` or `BOD_ADMIN` role, no equivalent alias role, and no per-member exception split for `duplicate_cccd_withdraw`:

| # | `role_code` | `display_name` | `assignment_mode` | `fixed_scope_kind` | `is_assignable_global` | Exact Canonical Capabilities (`authz_role_capabilities`) |
| :-: | :--- | :--- | :--- | :--- | :---: | :--- |
| 1 | `EMPLOYEE_BASE` | `Nhân viên cơ sở` | `GLOBAL` | `none` | `true` | **`0` capabilities** |
| 2 | `RECRUITER` | `Tuyển dụng (Recruiter)` | `GLOBAL` | `own` | `true` | **`7` @ `OWN`**: `entry_create`, `entry_own`, `submission_create`, `document_upload`, `document_view`, `change_request_create` (`retired_compat = true`), `employment_status.request` (`retired_compat = true`) |
| 3 | `HR_OPERATOR` | `Vận hành nhân sự (HR Operator)` | `GLOBAL` | `all` | `true` | **`5` @ `ALL`**: `recruiter_master_manage`, `team_master_manage`, `catalog_master_manage`, `audit_view`, `document_view` |
| 4 | `ADMIN` | **`BoD/Admin`** | `GLOBAL` | `all` | `true` | **`21` total (`1` @ `OWN` + `20` @ `ALL`)**:<br>- `@ OWN`: `entry_own`<br>- `@ ALL`: `entry_admin`, `entry_team`, `entry_create`, `submission_create`, `entry_privileged_edit`, `entry_restore`, `recruiter_master_manage`, `team_master_manage`, `audit_view`, `worker_edit_history_view`, `document_upload`, `document_view`, `employment_status.review`, `employment_status.apply`, `change_request_create` (`retired_compat = true`), `change_review` (`retired_compat = true`), `employment_status.request` (`retired_compat = true`), `duplicate_cccd_withdraw`, `report_view`, `report_analytics_view` |
| 5 | `TEAM_LEADER` | `Trưởng nhóm (Team Leader)` | `CONTEXTUAL` | `team` | `false` | **`5` @ `CONTEXT_TEAM`**: `entry_team`, `team_manager_assign`, `report_view`, `report_analytics_view`, `report_assign` |
| 6 | `DEPARTMENT_HEAD` | `Trưởng phòng ban` | `CONTEXTUAL` | `department` | `false` | **`0` capabilities in WP5** (`requires_active_person = true`; typed read-only contextual projection only) |
| 7 | `PROJECT_MANAGER` | `Quản lý dự án (PM)` | `CONTEXTUAL` | `project` | `false` | **`0` capabilities in WP5** (typed contextual projection; governs `recruitment_post_create` per project) |
| 8 | `PROJECT_ACCOUNTANT` | `Kế toán dự án` | `CONTEXTUAL` | `project` | `false` | **`1` @ `CONTEXT_PROJECT`**: `vendor_finance_view` |

### Critical Domain & Bundle Invariants

1. **Strict `ADMIN` Non-Auto-Grant Partition (`21 + 8 = 29`):**
   `ADMIN` (`BoD/Admin`) MUST **NEVER** auto-grant the remaining `8` tokens of `CAPABILITIES`:
   `catalog_master_manage`, `team_manager_assign`, `report_form_manage`, `report_assign`, `report_review`, `report_delegate`, `vendor_finance_view`, `vendor_finance_record`.
2. **Contextual Roles Forbidden in Global Assignment Table:**
   `TEAM_LEADER`, `DEPARTMENT_HEAD`, `PROJECT_MANAGER`, and `PROJECT_ACCOUNTANT` have `is_assignable_global = false` and are rejected by constraint/trigger on `public.authz_account_role_assignments`.
3. **Recruitment Post Create Invariant (`C4`):**
   `public.recruitment_post_create` ([20261110120000_recruitment_posts_foundation.sql#L2180-L2203](../supabase/migrations/20261110120000_recruitment_posts_foundation.sql#L2180-L2203)) checks `public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_project_id)` both before and under the project lock. Creating recruitment posts **MUST remain restricted to active Project Managers of the target project, even for `ADMIN` (`BoD/Admin`)**. Public jobs feed `GET /feeds/jobs.v1.json` remains public, and the retired Change Request flow (`retired_compat = true`) is NOT revived.
4. **Intentional PR 2 Action Diff Disclosure:**
   When PR 2 activates the unified `ADMIN` bundle across the `4` initial accounts (`luanpt`, `lienvu`, `ngattt`, `nobita6986@gmail.com`), `luanpt` intentionally transitions from orphan `all:*` (`0` caps) to full `ADMIN` (`21` caps, except `recruitment_post_create`), `lienvu` intentionally gains `duplicate_cccd_withdraw`, `report_view`, `report_analytics_view`, and `ngattt` / `nobita6986@gmail.com` intentionally gain `report_view`, `report_analytics_view`.

---

## 3. Single Canonical Owner Protection & Member Mutability

- **Unrestricted Member Add/Revoke (No Last-Admin Count Lock):**
  `luanpt`, `lienvu`, `ngattt`, and any future accounts assigned `ADMIN` receive standard unprotected rows (`is_protected = false`, `protected_reason = null`, `can_revoke = true`, `cannot_revoke_reason = null`) and can be revoked freely at any time. **DO NOT implement any "last Admin" count check or global admin-count lock**, and do NOT hardcode an allowlist of initial members in runtime resolvers.
- **Single Protected Assignment (`PROTECTED_OWNER_ADMIN`):**
  Only the canonical Owner's `ADMIN` assignment carries `is_protected = true` and `protected_reason = 'PROTECTED_OWNER_ADMIN'` in `public.authz_account_role_assignments` (guarded by `CHECK` constraint and partial unique index `WHERE is_protected = true AND ended_at IS NULL`).
- **Trigger & RPC Enforcement (`ROLE_REVOKE_ONLY`):**
  - A `BEFORE UPDATE OR DELETE` trigger on `public.authz_account_role_assignments` raises `AUTHZ_PROTECTED_ASSIGNMENT` (`PT409`) if `OLD.is_protected = true` and any operation attempts `DELETE`, sets `ended_at`, clears/modifies `is_protected` or `protected_reason`, or mutates `app_user_id`/`role_code`/`scope_kind`/`scope_ref`.
  - `direct_entry_authz_revoke_global_role_admin` independently checks `is_protected` (including Owner self-revoke and direct RPC/API calls) and rejects with **`409 AUTHZ_PROTECTED_ASSIGNMENT`**, **`0` `direct_entry_app_users.version` bump**, and **`0` partial writes**.
  - Protection does **NOT** apply to account `disable`, `enable`, or `reset-password`. When the canonical Owner account has `enabled = false`, it resolves **`0` effective permissions** (`effective_grants = []`, `blocking_reasons: ["ACCOUNT_DISABLED"]`) while still exposing the protected role assignment with `is_effective: false, inactive_reason: "ACCOUNT_DISABLED", is_protected: true, can_revoke: false, cannot_revoke_reason: "PROTECTED_OWNER_ADMIN"`.
- **Canonical Email Matching Rule (Manifest & Bootstrap Only):**
  - Exact rule: `lower(btrim(email)) = 'nobita6986@gmail.com'`, requiring **exactly `1` match**.
  - **Fail closed** on `0` or `> 1` exact matches.
  - **NEVER** match by local-part (`nobita6986`) on any other domain (e.g., `nobita6986@hrpartner.vn` is rejected as a non-match).
  - **NEVER** auto-create a missing Owner account, and **NEVER** hardcode email literals or environment UUIDs in runtime authz checks, triggers, RPCs, or UI components.
- **Client Input Guard & Read Metadata:**
  - Mutating routes reject any client-supplied `is_protected` or `protected_reason` (at any nesting depth) with **`400 AUTHORITY_FIELD_FORBIDDEN`**.
  - Read payloads expose `is_protected`, `can_revoke`, and `cannot_revoke_reason: "PROTECTED_OWNER_ADMIN" | null`.

---

## 4. SQL Schema, Security Boundary, D10 Lifecycle & `+07:00` Discipline (`C2`, `C3`)

### 4.1 Tables, ACL, Owner Alignment & `$check_wp5b$`

- **Tables Created in PR 1:**
  1. `public.authz_role_definitions`
  2. `public.authz_role_capabilities`
  3. `public.authz_account_role_assignments` (includes `is_protected`, `protected_reason`, `BEFORE INSERT OR UPDATE` contextual-role/future-timestamp blocker, `BEFORE UPDATE OR DELETE` `AUTHZ_PROTECTED_ASSIGNMENT` protection trigger)
  4. `public.authz_direct_capability_grants`
  5. `public.authz_audit_events`
  6. `public.authz_idempotency`
  7. `public.authz_system_state` (singleton `cutover_ready boolean NOT NULL DEFAULT false`)
  - Plus additive column `public.direct_entry_app_users.authz_managed boolean NOT NULL DEFAULT false` and `suspended_by_account_disable boolean NOT NULL DEFAULT false` on `direct_entry_capability_grants`, `direct_entry_scope_grants`, `direct_entry_app_user_recruiter_links` & `direct_entry_team_leader_assignments`.
- **Zero Direct Table Access & `FORCE RLS`:**
  Every new `authz_*` table and `authz_system_state` gets `ENABLE` + `FORCE ROW LEVEL SECURITY` (`0` policies) and `REVOKE ALL ON TABLE ... FROM PUBLIC, anon, authenticated, service_role`. Zero `ALTER DEFAULT PRIVILEGES` statements are permitted.
- **Exact `5` Public RPCs (`GRANT EXECUTE TO service_role` only; `REVOKE ALL FROM PUBLIC, anon, authenticated`):**
  1. `public.direct_entry_authz_list_roles_admin(uuid, uuid)`
  2. `public.direct_entry_authz_list_accounts_summary_admin(uuid, uuid, text, text, text, integer, integer)`
  3. `public.direct_entry_authz_get_account_access_admin(uuid, uuid, uuid)`
  4. `public.direct_entry_authz_assign_global_role_admin(uuid, uuid, uuid, text, integer, text, uuid, text)`
  5. `public.direct_entry_authz_revoke_global_role_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)`
- **Exact `5` Internal Helpers (`REVOKE ALL FROM PUBLIC, anon, authenticated, service_role` — NO `service_role` execute):**
  1. `public.direct_entry_authz__internal_resolve_effective_grants(uuid)`
  2. `public.direct_entry_authz__internal_has_paired_capability(uuid, text, text, text)`
  3. `public.direct_entry_authz__internal_assert_full_admin(uuid, uuid)`
  4. `public.direct_entry_authz__internal_assert_idempotency(uuid, uuid, text, text, text, text)`
  5. `public.direct_entry_authz__internal_sync_legacy_grants(uuid)`
- **Guarded Owner Alignment (`$align_owner$`) & Fail-Closed Self-Check (`$check_wp5b$`, `errcode = '55000'`):**
  Matches the repository pattern established in WP1/WP3B ([s0-t1-c-rpc-acl.test.mjs#L1930-L1975](../scripts/s0-t1-c-rpc-acl.test.mjs#L1930-L1975)): verifies **both** the `5` public RPCs AND all `5` internal helpers + new/updated trigger functions (`prosecdef = true`, `search_path=pg_catalog, public`, `(rolsuper OR rolbypassrls)`, `FORCE RLS` + `0` policies + zero `service_role` table privilege, zero overloads, zero `grantee = 0` ACL entries). Fails closed with **`55000`** when applied by a `NOBYPASSRLS` migration runner without `SET` role alignment.
- **T1B Contract Fixtures:** See [role-access-fixtures.json](./contracts/fixtures/wp5b1-role-access/role-access-fixtures.json) for request, response (`roles`, `accounts-summary`, `account access`, `assign`/`revoke` mutations), and canonical error payloads (`AUTHZ_*`, `AUTHORITY_FIELD_FORBIDDEN`, `IDEMPOTENCY_*`).

### 4.2 D10 Disable/Enable Lifecycle & `+07:00` Timezone Alignment (`C2`, `C3`)

- **Trigger 1 — `public.direct_entry_clear_authority_on_disable()`** ([20261020200000#L304-L359](../supabase/migrations/20261020200000_r1_current_state_authorization.sql#L304-L359)):
  Only the `tg_table_name = 'direct_entry_app_users'` branch changes: disabling marks active open links/TL rows `is_current = false, suspended_by_account_disable = true` while **preserving `valid_to IS NULL`** and keeping `authz_account_role_assignments` / `authz_direct_capability_grants` untouched.
- **Trigger 2 — `public.work_report_sync_team_leader_capabilities()`** ([20261021160000#L749-L751](../supabase/migrations/20261021160000_f1_work_reports_foundation.sql#L749-L751) & [20261103180000#L285-L393](../supabase/migrations/20261103180000_hf_hrp_membership_effective_interval_alignment.sql#L285-L393)):
  1. Trigger definition MUST be replaced with `AFTER INSERT OR UPDATE OF is_current, valid_to ON public.direct_entry_team_leader_assignments` so closing `valid_to` on an already-suspended (`is_current = false`) TL row still fires the sync trigger.
  2. When `old.is_current AND NOT new.is_current AND new.valid_to IS NULL` (suspension via disable), keep `g.valid_to IS NULL` rather than stamping `valid_to = g.valid_from`. Close `g.valid_to = greatest(new.valid_to, g.valid_from)` **only** when `new.valid_to IS NOT NULL`.
- **TL Mutation & Revoke-While-Disabled (`direct_entry_apply_team_leader_mutation`):**
  - Materialization steps ([20261112120000#L670-L714](../supabase/migrations/20261112120000_wp1_s1_block_future_org_authz_assignments.sql#L670-L714)) and effectiveness helpers MUST require `NOT suspended_by_account_disable` and `u.enabled = true`, using **`Asia/Ho_Chi_Minh` (`+07:00`)** calendar dates (`timezone('Asia/Ho_Chi_Minh', now())::date`), never raw UTC date.
  - Revoking or replacing a TL while the target user is disabled closes `v_old` immediately (`valid_to = p_effective_date, is_current = false, suspended_by_account_disable = false`) and writes audit history immediately.
- **Re-Enable Restoration & `12` Pre-WP5 Disabled Guard:**
  - Re-enabling restores only `suspended_by_account_disable = true AND valid_to IS NULL` rows whose invariants still hold (`team.active`, `recruiter.active`, no replacement TL took over the team while disabled), then re-syncs one-way (`authz_*` -> `direct_entry_*`) without touching `12` pre-WP5 disabled accounts (`suspended_by_account_disable = false`, `0` `authz_*` rows).

---

## 5. Paired Actor Contract & Exact `5` Next.js HTTP Endpoints (`C3`)

### 5.1 Fail-Closed Paired Evaluator (`src/lib/auth/direct-entry-v2.ts`)

Verified against [direct-entry-v2.ts#L75-L141](../src/lib/auth/direct-entry-v2.ts#L75-L141) and [#L576-L830](../src/lib/auth/direct-entry-v2.ts#L576-L830):

- `PairedEffectiveGrant`: `{ capability: Capability, scope_kind: "OWN" | "ALL" | "CONTEXT_TEAM" | "CONTEXT_DEPARTMENT" | "CONTEXT_PROJECT", scope_id: string | null, source_type: "ROLE_BUNDLE" | "CONTEXTUAL_ASSIGNMENT" | "DIRECT_GRANT" | "LEGACY_BRIDGE", source_id: string | null }` (`OWN`/`ALL` require `scope_id === null`; `CONTEXT_*` require a safe ref `scope_id`).
- `AssignedRoleSummary`: `{ role_code: 8 canonical codes, display_name, assignment_mode: "GLOBAL" | "CONTEXTUAL", scope_kind: AuthzScopeKind | null, scope_id: string | null, assignment_id: string | null, is_protected: boolean, can_revoke: boolean, cannot_revoke_reason: "PROTECTED_OWNER_ADMIN" | null }`.
- `isValidAuthorizationRecord` rejects any malformed `effective_grants` or `assigned_roles` payload (`ACTOR_REPOSITORY_INVALID`) instead of stripping bad entries.
- `hasPairedCapability(actor, capability, targetScope)` checks **only** `actor.effective_grants` on the exact same grant entry and **never** falls back to unpaired `actor.capabilities` or `actor.scopes`. Cross-capability pairing (e.g., `report_view @ CONTEXT_TEAM` + `report_review @ ALL`) returns `false` for `("report_view", { kind: "all" })`.

### 5.2 Exact `5` Next.js Routes & Behavioral Rules

Shared browser-safe contract lives in `src/lib/auth/role-access-contract.ts` (zero `node:crypto` or `server-only` imports); server hashing/CSRF/validation lives in `src/lib/direct-entry/role-access-api.ts`; RPC bridge lives in `src/lib/direct-entry/role-access-repository.ts`:

1. `GET /api/admin/access/roles` — empty query; returns the `8` canonical roles (`ADMIN` with `display_name: "BoD/Admin"`, `21` caps) and capability templates.
2. `GET /api/admin/access/accounts-summary` — paginated summary (`search`, `enabled: "all" | "true" | "false"`, `role_code`, `page: 1..1000`, `page_size: 1..100` default `25`). Exposes per-role `is_protected`, `can_revoke`, `cannot_revoke_reason`.
3. `GET /api/admin/access/accounts/[accountRef]/access` — UUID `accountRef`, empty query; returns `account` (`authz_managed`, `version`, `enabled`), `blocking_reasons` (`["ACCOUNT_DISABLED"]` when disabled), `assigned_global_roles` (with `is_protected`, `can_revoke`, `cannot_revoke_reason: "PROTECTED_OWNER_ADMIN" | null`, `is_effective`, `inactive_reason`), `direct_exceptions`, `contextual_assignments` (`DEPARTMENT_HEAD` and `PROJECT_MANAGER` return `derived_capabilities: []`), `module_authorities`, and `effective_grants` (`[]` when disabled).
4. `POST /api/admin/access/accounts/[accountRef]/roles` — JSON (`MAX_JSON_BYTES = 8_192`), same-origin CSRF, canonical `Idempotency-Key` header matching `body.idempotency_key`, strict schema (`{ role_code, expected_version, reason, idempotency_key }`), rejects `is_protected` / `protected_reason` with `400 AUTHORITY_FIELD_FORBIDDEN`, respects `AUTHZ_ROLE_MUTATIONS_ENABLED=true` & `cutover_ready` (`409 AUTHZ_CUTOVER_NOT_READY`). Locks `LEAST/GREATEST(actor, target)`, re-asserts Full Admin under lock (`403 AUTHZ_FORBIDDEN`), checks idempotency before OCC (`201` / `200 replayed`).
5. `DELETE /api/admin/access/accounts/[accountRef]/roles/[assignmentId]` — JSON (`MAX_JSON_BYTES = 8_192`), same-origin CSRF, canonical `Idempotency-Key` header matching `body.idempotency_key`, strict schema (`{ expected_version, reason, idempotency_key }`), rejects `is_protected` / `protected_reason` with `400 AUTHORITY_FIELD_FORBIDDEN`, enforces `assignment.app_user_id = accountRef` (`404 ROLE_ASSIGNMENT_NOT_FOUND`), fails closed with `409 AUTHZ_PROTECTED_ASSIGNMENT` (`0` version bump, `0` partial writes) if protected, allows revoking unprotected roles on disabled accounts (`D10`), and checks idempotency before OCC.

---

## 6. PR 2 Cutover Manifest (`scripts/lib/wp5-cutover-manifest.mjs`) & Required Verification

- [wp5-cutover-manifest.mjs](../scripts/lib/wp5-cutover-manifest.mjs) exports pure, deterministic, zero-IO cutover helpers (`CANONICAL_OWNER_EMAIL`, `INITIAL_ADMIN_LOGIN_IDS`, `ADMIN_NON_AUTO_GRANT_TOKENS`, `WP5_ROLE_CATALOG`, `normalizeCanonicalEmail`, `isCanonicalOwnerEmail`, `resolveCanonicalOwnerAccount`, `buildWp5CutoverPlan`).
- Required PostgreSQL + unit verification before PR 1/PR 2 approval:
  1. All `4` initial `ADMIN` accounts (`luanpt`, `lienvu`, `ngattt`, `nobita6986@gmail.com`) and any newly assigned `ADMIN` share the identical `21`-cap bundle; `8` excluded tokens are never granted.
  2. Revoking `ADMIN` from `luanpt`, `lienvu`, `ngattt`, or new members succeeds immediately with no "last Admin" count check while preserving independent `RECRUITER`/`TEAM_LEADER`/`PROJECT_MANAGER`/`DEPARTMENT_HEAD`/`PROJECT_ACCOUNTANT` grants and preventing legacy auto-regrant.
  3. Revoking canonical Owner `ADMIN` (via UI/API/RPC or self-revoke) returns `409 AUTHZ_PROTECTED_ASSIGNMENT` with `0` version bump and `0` partial writes; client `is_protected` / `protected_reason` yields `400 AUTHORITY_FIELD_FORBIDDEN`.
  4. Local-part collision `nobita6986@hrpartner.vn` never matches canonical Owner; `0` or `> 1` `nobita6986@gmail.com` matches fail closed; missing Owner never auto-creates an account.
  5. Owner protection does not block `disable`/`enable`/`reset-password` and disabled Owner resolves `0` effective permissions; D10 preserves role assignments across disable/enable and honors revoke/replace while disabled; `12` pre-WP5 disabled accounts do not restore guessed grants.
  6. Named SQL parameters end-to-end, idempotency replay before OCC, `DELETE` assignment binding, `NOBYPASSRLS` migration fail-closed (`55000`), `+07:00` date boundary tests, Web PR 0 baseline passing against PR 1 DB, `409 AUTHZ_CUTOVER_NOT_READY` in PR 1, and `recruitment_post_create` strictly PM-only even for `ADMIN` (`BoD/Admin`).
