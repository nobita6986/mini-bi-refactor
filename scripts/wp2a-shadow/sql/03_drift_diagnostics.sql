-- =============================================================================
-- WP2A Shadow Query 03: Drift & Historical Integrity Diagnostics (Post-WP1)
-- Checks CAT1..CAT6 plus MISSING_VALID_TO_ON_NON_CURRENT_ROW using half-open [valid_from, valid_to).
-- Execute strictly inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; ... ROLLBACK;`.
-- =============================================================================

with params as materialized (
  select
    coalesce(nullif(current_setting('wp2a.as_of_ts', true), '')::timestamptz, pg_catalog.transaction_timestamp()) as as_of_ts,
    (coalesce(nullif(current_setting('wp2a.as_of_ts', true), '')::timestamptz, pg_catalog.transaction_timestamp()) at time zone 'Asia/Ho_Chi_Minh')::date as as_of_date
),
cat1_future_or_overlapping as (
  select
    'CAT1_FUTURE_OR_OVERLAPPING'::text as drift_category,
    case when cg.is_current then 'FUTURE_DATED_WITH_IS_CURRENT_TRUE' else 'FUTURE_DATED_SCHEDULED' end as drift_code,
    'HIGH'::text as severity,
    'direct_entry_capability_grants'::text as source_table,
    left(cg.app_user_id::text, 8) || '...' as account_id_mask,
    cg.app_user_id,
    cg.capability::text as subject_ref,
    cg.valid_from::text as valid_from,
    coalesce(cg.valid_to::text, 'infinity') as valid_to,
    cg.is_current::text as is_current_state,
    'HISTORICAL_RECONSTRUCTIBLE'::text as temporal_verifiability,
    'Pre-existing future-dated capability grant'::text as t0_decision_note
  from params p
  join public.direct_entry_capability_grants cg on cg.valid_from > p.as_of_date

  union all

  select
    'CAT1_FUTURE_OR_OVERLAPPING',
    case when sg.is_current then 'FUTURE_DATED_WITH_IS_CURRENT_TRUE' else 'FUTURE_DATED_SCHEDULED' end,
    'HIGH',
    'direct_entry_scope_grants',
    left(sg.app_user_id::text, 8) || '...',
    sg.app_user_id,
    sg.scope_kind || ':' || coalesce(sg.team_id::text, '*'),
    sg.valid_from::text,
    coalesce(sg.valid_to::text, 'infinity'),
    sg.is_current::text,
    'HISTORICAL_RECONSTRUCTIBLE',
    'Pre-existing future-dated scope grant'
  from params p
  join public.direct_entry_scope_grants sg on sg.valid_from > p.as_of_date

  union all

  select
    'CAT1_FUTURE_OR_OVERLAPPING',
    case when tla.is_current then 'FUTURE_DATED_WITH_IS_CURRENT_TRUE' else 'FUTURE_DATED_SCHEDULED' end,
    'HIGH',
    'direct_entry_team_leader_assignments',
    left(tla.leader_app_user_id::text, 8) || '...',
    tla.leader_app_user_id,
    'team:' || tla.team_id::text,
    tla.valid_from::text,
    coalesce(tla.valid_to::text, 'infinity'),
    tla.is_current::text,
    'HISTORICAL_RECONSTRUCTIBLE',
    'Pre-existing future-dated team leader assignment'
  from params p
  join public.direct_entry_team_leader_assignments tla on tla.valid_from > p.as_of_date

  union all

  select
    'CAT1_FUTURE_OR_OVERLAPPING',
    case when pma.is_current then 'FUTURE_DATED_WITH_IS_CURRENT_TRUE' else 'FUTURE_DATED_SCHEDULED' end,
    'MEDIUM',
    'direct_entry_project_manager_assignments',
    coalesce(left(rl.app_user_id::text, 8) || '...', 'rec:' || left(pma.manager_recruiter_id::text, 8)),
    rl.app_user_id,
    'project:' || pma.project_id,
    pma.valid_from::text,
    coalesce(pma.valid_to::text, 'infinity'),
    pma.is_current::text,
    'HISTORICAL_RECONSTRUCTIBLE',
    'Pre-existing future-dated PM assignment'
  from params p
  join public.direct_entry_project_manager_assignments pma on pma.valid_from > p.as_of_date and pma.revoked_at is null
  left join public.direct_entry_app_user_recruiter_links rl on rl.recruiter_id = pma.manager_recruiter_id and rl.verified = true and rl.is_current = true

  union all

  select
    'CAT1_FUTURE_OR_OVERLAPPING',
    'FUTURE_DATED_SCHEDULED',
    'MEDIUM',
    'organization_department_memberships',
    left(odm.app_user_id::text, 8) || '...',
    odm.app_user_id,
    'dept:' || odm.department_id::text,
    odm.valid_from::text,
    coalesce(odm.valid_to::text, 'infinity'),
    (odm.revoked_at is null)::text,
    'HISTORICAL_RECONSTRUCTIBLE',
    'Pre-existing future-dated department membership'
  from params p
  join public.organization_department_memberships odm on odm.valid_from > p.as_of_date and odm.revoked_at is null

  union all

  select
    'CAT1_FUTURE_OR_OVERLAPPING',
    case when wrd.effective_from > p.as_of_ts then 'FUTURE_DATED_SCHEDULED' else 'LEGACY_SCHEDULED_EXPIRY_WINDOW' end,
    'MEDIUM',
    'work_report_delegations',
    left(wrd.delegate_app_user_id::text, 8) || '...',
    wrd.delegate_app_user_id,
    wrd.capability || ':' || wrd.template_id::text,
    wrd.effective_from::text,
    coalesce(wrd.effective_to::text, 'infinity'),
    wrd.is_current::text || ':' || wrd.state,
    'HISTORICAL_RECONSTRUCTIBLE',
    'Legacy work_report_delegations row with scheduled future effective_from or non-null effective_to expiration'
  from params p
  join public.work_report_delegations wrd on (wrd.effective_from > p.as_of_ts or wrd.effective_to is not null) and wrd.state <> 'REVOKED'

  union all

  select
    'CAT1_FUTURE_OR_OVERLAPPING',
    'OVERLAPPING_CAPABILITY_WINDOWS',
    'HIGH',
    'direct_entry_capability_grants',
    left(a.app_user_id::text, 8) || '...',
    a.app_user_id,
    a.capability,
    a.valid_from::text || ' vs ' || b.valid_from::text,
    coalesce(a.valid_to::text, 'infinity') || ' vs ' || coalesce(b.valid_to::text, 'infinity'),
    a.is_current::text || '/' || b.is_current::text,
    'HISTORICAL_RECONSTRUCTIBLE',
    'Overlapping half-open [valid_from, valid_to) windows for same user and capability'
  from public.direct_entry_capability_grants a
  join public.direct_entry_capability_grants b
    on a.app_user_id = b.app_user_id
   and a.capability = b.capability
   and a.grant_id < b.grant_id
   and daterange(a.valid_from, coalesce(a.valid_to, 'infinity'::date), '[)')
    && daterange(b.valid_from, coalesce(b.valid_to, 'infinity'::date), '[)')
),
cat2_is_current_drift as (
  select
    'CAT2_IS_CURRENT_DRIFT'::text as drift_category,
    case when cg.valid_from > p.as_of_date then 'IS_CURRENT_TRUE_BEFORE_VALID_FROM' else 'IS_CURRENT_TRUE_AFTER_VALID_TO' end as drift_code,
    'CRITICAL'::text as severity,
    'direct_entry_capability_grants'::text as source_table,
    left(cg.app_user_id::text, 8) || '...' as account_id_mask,
    cg.app_user_id,
    cg.capability as subject_ref,
    cg.valid_from::text as valid_from,
    coalesce(cg.valid_to::text, 'infinity') as valid_to,
    'true'::text as is_current_state,
    'HISTORICAL_RECONSTRUCTIBLE'::text as temporal_verifiability,
    'R1 direct_entry_has_capability only checks is_current=true; expired/future grant remains active'::text as t0_decision_note
  from params p
  join public.direct_entry_capability_grants cg
    on cg.is_current = true
   and not (cg.valid_from <= p.as_of_date and (cg.valid_to is null or (cg.valid_to > cg.valid_from and p.as_of_date < cg.valid_to)))

  union all

  select
    'CAT2_IS_CURRENT_DRIFT',
    case when sg.valid_from > p.as_of_date then 'IS_CURRENT_TRUE_BEFORE_VALID_FROM' else 'IS_CURRENT_TRUE_AFTER_VALID_TO' end,
    'CRITICAL',
    'direct_entry_scope_grants',
    left(sg.app_user_id::text, 8) || '...',
    sg.app_user_id,
    sg.scope_kind || ':' || coalesce(sg.team_id::text, '*'),
    sg.valid_from::text,
    coalesce(sg.valid_to::text, 'infinity'),
    'true',
    'HISTORICAL_RECONSTRUCTIBLE',
    'Scope grant has is_current=true outside half-open [valid_from, valid_to)'
  from params p
  join public.direct_entry_scope_grants sg
    on sg.is_current = true
   and not (sg.valid_from <= p.as_of_date and (sg.valid_to is null or (sg.valid_to > sg.valid_from and p.as_of_date < sg.valid_to)))

  union all

  select
    'CAT2_IS_CURRENT_DRIFT',
    case when rl.valid_from > p.as_of_date then 'IS_CURRENT_TRUE_BEFORE_VALID_FROM' else 'IS_CURRENT_TRUE_AFTER_VALID_TO' end,
    'HIGH',
    'direct_entry_app_user_recruiter_links',
    left(rl.app_user_id::text, 8) || '...',
    rl.app_user_id,
    rl.recruiter_id::text,
    rl.valid_from::text,
    coalesce(rl.valid_to::text, 'infinity'),
    'true',
    'HISTORICAL_RECONSTRUCTIBLE',
    'Recruiter link has is_current=true outside half-open [valid_from, valid_to)'
  from params p
  join public.direct_entry_app_user_recruiter_links rl
    on rl.is_current = true
   and not (rl.valid_from <= p.as_of_date and (rl.valid_to is null or (rl.valid_to > rl.valid_from and p.as_of_date < rl.valid_to)))

  union all

  select
    'CAT2_IS_CURRENT_DRIFT',
    'IS_CURRENT_FALSE_WITHIN_ACTIVE_WINDOW',
    'HIGH',
    'direct_entry_team_leader_assignments',
    left(tla.leader_app_user_id::text, 8) || '...',
    tla.leader_app_user_id,
    'team:' || tla.team_id::text,
    tla.valid_from::text,
    coalesce(tla.valid_to::text, 'infinity'),
    'false',
    'HISTORICAL_RECONSTRUCTIBLE',
    'Row covers as_of_date under half-open [valid_from, valid_to) on enabled user but is_current=false'
  from params p
  join public.direct_entry_team_leader_assignments tla
    on tla.is_current = false
   and tla.valid_from <= p.as_of_date
   and (tla.valid_to is null or (tla.valid_to > tla.valid_from and p.as_of_date < tla.valid_to))
  join public.direct_entry_app_users u on u.app_user_id = tla.leader_app_user_id and u.enabled = true

  union all

  select
    'CAT2_IS_CURRENT_DRIFT',
    'IS_CURRENT_FALSE_WITHIN_ACTIVE_WINDOW',
    'HIGH',
    'leave_department_approvers',
    left(lda.approver_app_user_id::text, 8) || '...',
    lda.approver_app_user_id,
    'unit_kind:' || lda.unit_kind,
    lda.valid_from::text,
    coalesce(lda.valid_to::text, 'infinity'),
    'false',
    'HISTORICAL_RECONSTRUCTIBLE',
    'Department approver row covers as_of_date under half-open [valid_from, valid_to) on enabled user but is_current=false'
  from params p
  join public.leave_department_approvers lda
    on lda.is_current = false
   and lda.valid_from <= p.as_of_date
   and (lda.valid_to is null or (lda.valid_to > lda.valid_from and p.as_of_date < lda.valid_to))
  join public.direct_entry_app_users u on u.app_user_id = lda.approver_app_user_id and u.enabled = true

  union all

  select
    'CAT2_IS_CURRENT_DRIFT',
    'MISSING_VALID_TO_ON_NON_CURRENT_ROW',
    'INFO',
    tbl.source_table,
    tbl.account_id_mask,
    tbl.app_user_id,
    tbl.subject_ref,
    tbl.valid_from,
    'NULL',
    'false',
    'CURRENT_STATE_ONLY (non_current_without_valid_to_cannot_reconstruct_end_date)',
    'Row has is_current=false and valid_to IS NULL (legacy wipe/disable without closing valid_to; candidate does not resurrect it)'
  from (
    select
      'direct_entry_capability_grants'::text as source_table,
      left(cg.app_user_id::text, 8) || '...' as account_id_mask,
      cg.app_user_id,
      cg.capability as subject_ref,
      cg.valid_from::text as valid_from
    from public.direct_entry_capability_grants cg
    where cg.is_current = false and cg.valid_to is null
    union all
    select
      'direct_entry_scope_grants'::text,
      left(sg.app_user_id::text, 8) || '...',
      sg.app_user_id,
      sg.scope_kind || ':' || coalesce(sg.team_id::text, '*'),
      sg.valid_from::text
    from public.direct_entry_scope_grants sg
    where sg.is_current = false and sg.valid_to is null
  ) tbl
),
cat3_orphan_all_scope as (
  select
    'CAT3_ORPHAN_ALL_SCOPE'::text as drift_category,
    case
      when not exists (select 1 from public.direct_entry_capability_grants cg where cg.app_user_id = sg.app_user_id and cg.is_current = true)
      then 'ALL_SCOPE_WITH_ZERO_CAPABILITIES'
      when not exists (
        select 1 from public.direct_entry_capability_grants cg
        where cg.app_user_id = sg.app_user_id and cg.is_current = true
          and cg.capability in (
            'entry_admin', 'entry_privileged_edit', 'report_view', 'report_analytics_view', 'report_review',
            'vendor_finance_view', 'vendor_finance_record', 'vendor_finance_reconcile', 'vendor_finance_admin',
            'worker_edit_history_view', 'change_review', 'employment_status.review', 'employment_status.apply',
            'entry_restore', 'audit_view', 'catalog_master_manage', 'duplicate_cccd_withdraw'
          )
      ) then 'ALL_SCOPE_WITH_NON_SCOPED_CAPABILITY_ONLY'
      else 'ALL_SCOPE_WITHOUT_DASHBOARD_REPORT_CAPABILITY'
    end as drift_code,
    'HIGH'::text as severity,
    'direct_entry_scope_grants'::text as source_table,
    left(sg.app_user_id::text, 8) || '...' as account_id_mask,
    sg.app_user_id,
    'scope:all (caps=' || coalesce((
      select string_agg(cg.capability, ',' order by cg.capability)
      from public.direct_entry_capability_grants cg
      where cg.app_user_id = sg.app_user_id and cg.is_current = true and cg.capability not in ('pii_view', 'pii_export', 'payment_view', 'payment_edit')
    ), 'NONE') || ')' as subject_ref,
    sg.valid_from::text as valid_from,
    coalesce(sg.valid_to::text, 'infinity') as valid_to,
    sg.is_current::text as is_current_state,
    'CURRENT_STATE_ONLY (is_current)'::text as temporal_verifiability,
    'scope=all requires module-specific capability; current Dashboard resolver grants all-company access to any scope=all user'::text as t0_decision_note
  from public.direct_entry_scope_grants sg
  where sg.scope_kind = 'all'
    and sg.is_current = true
    and not exists (
      select 1 from public.direct_entry_capability_grants cg
      where cg.app_user_id = sg.app_user_id and cg.is_current = true
        and cg.capability in ('entry_admin', 'entry_privileged_edit', 'report_view', 'report_analytics_view')
    )

  union all

  select
    'CAT3_ORPHAN_ALL_SCOPE',
    'ALL_SCOPED_CAPABILITY_MISSING_ALL_SCOPE',
    'HIGH',
    'direct_entry_capability_grants',
    left(cg.app_user_id::text, 8) || '...',
    cg.app_user_id,
    'cap:' || cg.capability || ' (missing scope=all; current_scopes=' || coalesce((
      select string_agg(sg.scope_kind, ',' order by sg.scope_kind)
      from public.direct_entry_scope_grants sg
      where sg.app_user_id = cg.app_user_id and sg.is_current = true
    ), 'NONE') || ')',
    cg.valid_from::text,
    coalesce(cg.valid_to::text, 'infinity'),
    cg.is_current::text,
    'CURRENT_STATE_ONLY (is_current)',
    'All-scoped capability without active scope=all is denied by page guard and RPC'
  from public.direct_entry_capability_grants cg
  where cg.is_current = true
    and cg.capability in ('catalog_master_manage', 'audit_view', 'duplicate_cccd_withdraw')
    and not exists (select 1 from public.direct_entry_scope_grants sg where sg.app_user_id = cg.app_user_id and sg.is_current = true and sg.scope_kind = 'all')
),
cat4_disabled_account_authority as (
  select
    'CAT4_DISABLED_ACCOUNT_AUTHORITY'::text as drift_category,
    'DISABLED_USER_ACTIVE_ORG_DEPT_MEMBERSHIP'::text as drift_code,
    'HIGH'::text as severity,
    'organization_department_memberships'::text as source_table,
    left(u.app_user_id::text, 8) || '...' as account_id_mask,
    u.app_user_id,
    'dept:' || odm.department_id::text as subject_ref,
    odm.valid_from::text as valid_from,
    coalesce(odm.valid_to::text, 'infinity') as valid_to,
    'revoked_at is null'::text as is_current_state,
    'CURRENT_STATE_ONLY (direct_entry_app_users.enabled has no valid_from/valid_to history)'::text as temporal_verifiability,
    'Trigger direct_entry_clear_authority_on_disable does NOT revoke organization_department_memberships'::text as t0_decision_note
  from public.direct_entry_app_users u
  join public.organization_department_memberships odm on odm.app_user_id = u.app_user_id and odm.revoked_at is null
  where u.enabled = false

  union all

  select
    'CAT4_DISABLED_ACCOUNT_AUTHORITY',
    'DISABLED_USER_ACTIVE_PM_ASSIGNMENT_VIA_RECRUITER',
    'HIGH',
    'direct_entry_project_manager_assignments',
    left(u.app_user_id::text, 8) || '...',
    u.app_user_id,
    'project:' || pma.project_id || ' (recruiter:' || left(pma.manager_recruiter_id::text, 8) || ')',
    pma.valid_from::text,
    coalesce(pma.valid_to::text, 'infinity'),
    pma.is_current::text,
    'CURRENT_STATE_ONLY',
    'Disabling user clears recruiter_links.is_current=false while leaving project_manager_assignments.is_current=true on recruiter_id'
  from public.direct_entry_app_users u
  join public.direct_entry_app_user_recruiter_links rl on rl.app_user_id = u.app_user_id and rl.verified = true
  join public.direct_entry_project_manager_assignments pma on pma.manager_recruiter_id = rl.recruiter_id and pma.is_current = true and pma.revoked_at is null
  where u.enabled = false

  union all

  select
    'CAT4_DISABLED_ACCOUNT_AUTHORITY',
    'DISABLED_USER_ACTIVE_LEAVE_GRANT',
    'MEDIUM',
    'leave_module_grants',
    left(u.app_user_id::text, 8) || '...',
    u.app_user_id,
    lmg.role_code,
    lmg.valid_from::text,
    coalesce(lmg.valid_to::text, 'infinity'),
    lmg.is_current::text,
    'CURRENT_STATE_ONLY',
    'Trigger direct_entry_clear_authority_on_disable does NOT clear leave_module_grants.is_current'
  from public.direct_entry_app_users u
  join public.leave_module_grants lmg on lmg.app_user_id = u.app_user_id and lmg.is_current = true
  where u.enabled = false

  union all

  select
    'CAT4_DISABLED_ACCOUNT_AUTHORITY',
    'DISABLED_USER_ACTIVE_VFIN_ROLE_OR_ACCOUNTANT',
    'HIGH',
    'vendor_finance_global_roles / project_accountants',
    left(u.app_user_id::text, 8) || '...',
    u.app_user_id,
    v.role_desc,
    v.valid_from::text,
    coalesce(v.valid_to::text, 'infinity'),
    'ended_at is null',
    'CURRENT_STATE_ONLY',
    'Trigger direct_entry_clear_authority_on_disable does NOT end vendor_finance assignments/roles'
  from public.direct_entry_app_users u
  join (
    select app_user_id, 'global:' || role_code as role_desc, valid_from, valid_to from public.vendor_finance_global_roles where ended_at is null
    union all
    select accountant_user_id as app_user_id, 'project_accountant:' || project_id as role_desc, valid_from, valid_to from public.vendor_finance_project_accountants where ended_at is null
  ) v on v.app_user_id = u.app_user_id
  where u.enabled = false

  union all

  select
    'CAT4_DISABLED_ACCOUNT_AUTHORITY',
    'DISABLED_USER_ACTIVE_WORK_REPORT_DELEGATION',
    'MEDIUM',
    'work_report_delegations',
    left(u.app_user_id::text, 8) || '...',
    u.app_user_id,
    wrd.capability || ':' || wrd.template_id::text,
    wrd.effective_from::text,
    coalesce(wrd.effective_to::text, 'infinity'),
    wrd.is_current::text,
    'CURRENT_STATE_ONLY',
    'Trigger direct_entry_clear_authority_on_disable does NOT revoke work_report_delegations'
  from public.direct_entry_app_users u
  join public.work_report_delegations wrd on (wrd.delegate_app_user_id = u.app_user_id or wrd.grantor_user_id = u.app_user_id) and wrd.is_current = true and wrd.state = 'ACTIVE'
  where u.enabled = false

  union all

  select
    'CAT4_DISABLED_ACCOUNT_AUTHORITY',
    'REENABLED_USER_WIPED_R1_GRANTS',
    'HIGH',
    'direct_entry_capability_grants',
    left(u.app_user_id::text, 8) || '...',
    u.app_user_id,
    'wiped_caps=' || string_agg(distinct cg.capability, ',' order by cg.capability),
    min(cg.valid_from)::text,
    'infinity',
    'false',
    'CURRENT_STATE_ONLY',
    'User is enabled=true with open-ended capability grants (valid_to is null, is_current=false) and zero current capabilities'
  from params p
  join public.direct_entry_app_users u on u.enabled = true
  join public.direct_entry_capability_grants cg on cg.app_user_id = u.app_user_id and cg.is_current = false and cg.valid_from <= p.as_of_date and cg.valid_to is null
  where not exists (select 1 from public.direct_entry_capability_grants cg_active where cg_active.app_user_id = u.app_user_id and cg_active.is_current = true)
  group by u.app_user_id
),
cat5_person_account_org_link_gaps as (
  select
    'CAT5_PERSON_ACCOUNT_ORG_LINK_CONFLICT'::text as drift_category,
    'UNCLASSIFIED_OR_MISSING_EMPLOYEE_UNIT_KIND'::text as drift_code,
    'MEDIUM'::text as severity,
    'leave_employee_profiles'::text as source_table,
    left(u.app_user_id::text, 8) || '...' as account_id_mask,
    u.app_user_id,
    'unit_kind=' || coalesce(lep.unit_kind, 'NO_LEAVE_PROFILE') as subject_ref,
    'N/A'::text as valid_from,
    'N/A'::text as valid_to,
    'missing_or_unclassified'::text as is_current_state,
    'CURRENT_STATE_ONLY (leave_employee_profiles.unit_kind has no valid_from/valid_to history)'::text as temporal_verifiability,
    'Enabled employee account has no classified unit_kind; routes to ADMIN_BOD_FALLBACK'::text as t0_decision_note
  from public.direct_entry_app_users u
  left join public.leave_employee_profiles lep on lep.app_user_id = u.app_user_id
  where u.enabled = true and coalesce(lep.is_shared_non_employee, false) = false and coalesce(lep.unit_kind, 'UNCLASSIFIED') = 'UNCLASSIFIED'

  union all

  select
    'CAT5_PERSON_ACCOUNT_ORG_LINK_CONFLICT',
    'ACCOUNTING_DEPT_VS_LEAVE_UNIT_KIND_CONFLICT',
    'HIGH',
    'organization_department_memberships vs leave_employee_profiles',
    left(u.app_user_id::text, 8) || '...',
    u.app_user_id,
    'dept_code=' || od.code || ' vs unit_kind=' || coalesce(lep.unit_kind, 'NULL'),
    odm.valid_from::text,
    coalesce(odm.valid_to::text, 'infinity'),
    'true',
    'CURRENT_STATE_ONLY (leave_employee_profiles.unit_kind is non-temporal)',
    'Account has active ACCOUNTING department membership but leave_employee_profiles.unit_kind <> ACCOUNTING'
  from params p
  join public.direct_entry_app_users u on u.enabled = true
  join public.organization_department_memberships odm
    on odm.app_user_id = u.app_user_id and odm.revoked_at is null
   and odm.valid_from <= p.as_of_date
   and (odm.valid_to is null or (odm.valid_to > odm.valid_from and p.as_of_date < odm.valid_to))
  join public.organization_departments od on od.department_id = odm.department_id and od.is_active = true
  left join public.leave_employee_profiles lep on lep.app_user_id = u.app_user_id
  where od.code = 'ACCOUNTING' and coalesce(lep.unit_kind, 'UNCLASSIFIED') <> 'ACCOUNTING'

  union all

  select
    'CAT5_PERSON_ACCOUNT_ORG_LINK_CONFLICT',
    'RECRUITER_LINK_VS_LEAVE_UNIT_KIND_CONFLICT',
    'HIGH',
    'direct_entry_app_user_recruiter_links vs leave_employee_profiles',
    left(u.app_user_id::text, 8) || '...',
    u.app_user_id,
    'recruiter=' || rl.recruiter_id::text || ' vs unit_kind=' || lep.unit_kind,
    rl.valid_from::text,
    coalesce(rl.valid_to::text, 'infinity'),
    'true',
    'CURRENT_STATE_ONLY',
    'Account has active verified Recruiter link but leave_employee_profiles.unit_kind is neither RECRUITMENT nor MANAGEMENT_BOD'
  from public.direct_entry_app_users u
  join public.direct_entry_app_user_recruiter_links rl on rl.app_user_id = u.app_user_id and rl.is_current = true and rl.verified = true
  join public.leave_employee_profiles lep on lep.app_user_id = u.app_user_id
  where u.enabled = true and lep.unit_kind not in ('RECRUITMENT', 'MANAGEMENT_BOD')

  union all

  select
    'CAT5_PERSON_ACCOUNT_ORG_LINK_CONFLICT',
    'RECRUITER_WITHOUT_TEAM_MEMBERSHIP',
    'MEDIUM',
    'direct_entry_app_user_recruiter_links',
    left(rl.app_user_id::text, 8) || '...',
    rl.app_user_id,
    'recruiter:' || rl.recruiter_id::text,
    rl.valid_from::text,
    coalesce(rl.valid_to::text, 'infinity'),
    rl.is_current::text,
    'HISTORICAL_RECONSTRUCTIBLE',
    'Recruiter has verified link but no team scope grant or team leader assignment'
  from public.direct_entry_app_user_recruiter_links rl
  join public.direct_entry_app_users u on u.app_user_id = rl.app_user_id and u.enabled = true
  where rl.is_current = true and rl.verified = true
    and not exists (select 1 from public.direct_entry_scope_grants sg where sg.app_user_id = rl.app_user_id and sg.scope_kind = 'team' and sg.is_current = true)
    and not exists (select 1 from public.direct_entry_team_leader_assignments tla where tla.leader_app_user_id = rl.app_user_id and tla.is_current = true)
),
cat6_shared_service_account_obligations as (
  select
    'CAT6_SHARED_SERVICE_ACCOUNT_OBLIGATION'::text as drift_category,
    'SHARED_ACCOUNT_HAS_WORK_REPORT_OBLIGATION'::text as drift_code,
    'HIGH'::text as severity,
    'work_report_obligations'::text as source_table,
    left(lep.app_user_id::text, 8) || '...' as account_id_mask,
    lep.app_user_id,
    'obligations_count=' || count(wro.obligation_id)::text as subject_ref,
    min(wro.period_start_date)::text as valid_from,
    max(wro.period_end_date)::text as valid_to,
    'is_shared_non_employee=true'::text as is_current_state,
    'CURRENT_STATE_ONLY (is_shared_non_employee is non-temporal)'::text as temporal_verifiability,
    'Shared/service account has active work_report_obligations'::text as t0_decision_note
  from public.leave_employee_profiles lep
  join public.work_report_obligations wro on wro.assignee_app_user_id = lep.app_user_id and wro.obligation_status = 'ACTIVE'
  where lep.is_shared_non_employee = true
  group by lep.app_user_id

  union all

  select
    'CAT6_SHARED_SERVICE_ACCOUNT_OBLIGATION',
    'SHARED_ACCOUNT_HAS_ATTENDANCE_POLICY_OR_CHECKIN',
    'MEDIUM',
    'attendance_slot_policy_assignments / attendance_checkins',
    left(lep.app_user_id::text, 8) || '...',
    lep.app_user_id,
    'policy_rows=' || (select count(*)::text from public.attendance_slot_policy_assignments a where a.app_user_id = lep.app_user_id and a.revoked_at is null)
      || ',checkins=' || (select count(*)::text from public.attendance_checkins c where c.app_user_id = lep.app_user_id),
    'N/A',
    'N/A',
    'is_shared_non_employee=true',
    'CURRENT_STATE_ONLY',
    'Shared/service account has attendance policy or check-ins'
  from public.leave_employee_profiles lep
  where lep.is_shared_non_employee = true
    and (
      exists (select 1 from public.attendance_slot_policy_assignments a where a.app_user_id = lep.app_user_id and a.revoked_at is null)
      or exists (select 1 from public.attendance_checkins c where c.app_user_id = lep.app_user_id)
    )

  union all

  select
    'CAT6_SHARED_SERVICE_ACCOUNT_OBLIGATION',
    'SHARED_ACCOUNT_HAS_LEAVE_REQUESTS_OR_LOTS',
    'HIGH',
    'leave_requests / leave_lots',
    left(lep.app_user_id::text, 8) || '...',
    lep.app_user_id,
    'leave_requests=' || (select count(*)::text from public.leave_requests lr where lr.app_user_id = lep.app_user_id)
      || ',leave_lots=' || (select count(*)::text from public.leave_lots ll where ll.app_user_id = lep.app_user_id),
    'N/A',
    'N/A',
    'is_shared_non_employee=true',
    'CURRENT_STATE_ONLY',
    'Shared/service account has personal leave requests or leave accrual lots'
  from public.leave_employee_profiles lep
  where lep.is_shared_non_employee = true
    and (
      exists (select 1 from public.leave_requests lr where lr.app_user_id = lep.app_user_id)
      or exists (select 1 from public.leave_lots ll where ll.app_user_id = lep.app_user_id)
    )
),
all_drift_rows as (
  select * from cat1_future_or_overlapping
  union all select * from cat2_is_current_drift
  union all select * from cat3_orphan_all_scope
  union all select * from cat4_disabled_account_authority
  union all select * from cat5_person_account_org_link_gaps
  union all select * from cat6_shared_service_account_obligations
)
select
  drift_category,
  drift_code,
  severity,
  source_table,
  account_id_mask,
  app_user_id,
  subject_ref,
  valid_from,
  valid_to,
  is_current_state,
  temporal_verifiability,
  t0_decision_note
from all_drift_rows
order by
  case severity when 'CRITICAL' then 1 when 'HIGH' then 2 when 'MEDIUM' then 3 else 4 end,
  drift_category,
  drift_code,
  source_table,
  account_id_mask;
