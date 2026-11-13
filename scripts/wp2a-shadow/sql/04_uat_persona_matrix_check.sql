-- =============================================================================
-- WP2A Shadow Query 04: UAT Persona Matrix & Provisioning Check (Post-WP1)
-- Covers P01..P10 and UAT provisioning gaps without PII or hardcoded identities.
-- Execute strictly inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; ... ROLLBACK;`.
-- =============================================================================

with params as materialized (
  select
    coalesce(nullif(current_setting('wp2a.as_of_ts', true), '')::timestamptz, pg_catalog.transaction_timestamp()) as as_of_ts,
    (coalesce(nullif(current_setting('wp2a.as_of_ts', true), '')::timestamptz, pg_catalog.transaction_timestamp()) at time zone 'Asia/Ho_Chi_Minh')::date as as_of_date,
    (pg_catalog.transaction_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date as current_bkk_date
),
user_signals as (
  select
    p.as_of_date,
    p.current_bkk_date,
    left(u.app_user_id::text, 8) || '...' as account_id_mask,
    u.app_user_id,
    u.enabled,
    (u.created_at at time zone 'Asia/Ho_Chi_Minh')::date as user_created_date,
    coalesce(lep.is_shared_non_employee, false) as is_shared_non_employee,
    coalesce(lep.unit_kind, 'NO_LEAVE_PROFILE') as legacy_unit_kind,

    coalesce((
      select string_agg(od.code, ',' order by od.code)
      from public.organization_department_memberships odm
      join public.organization_departments od on od.department_id = odm.department_id and od.is_active = true
      where odm.app_user_id = u.app_user_id
        and odm.valid_from <= p.as_of_date
        and (odm.valid_to is null or (odm.valid_to > odm.valid_from and p.as_of_date < odm.valid_to))
        and (odm.revoked_at is null or p.as_of_ts < odm.revoked_at)
    ), '') as dept_memberships,

    coalesce((
      select string_agg(cg.capability, ',' order by cg.capability)
      from public.direct_entry_capability_grants cg
      where cg.app_user_id = u.app_user_id and cg.is_current = true
    ), '') as current_capabilities,

    coalesce((
      select string_agg(sg.scope_kind || ':' || coalesce(sg.team_id::text, '*'), ',' order by sg.scope_kind, sg.team_id::text)
      from public.direct_entry_scope_grants sg
      where sg.app_user_id = u.app_user_id and sg.is_current = true
    ), '') as current_scopes,

    exists (
      select 1
      from public.direct_entry_app_user_recruiter_links rl
      join public.recruiters r on r.recruiter_id = rl.recruiter_id and r.active = true
      where rl.app_user_id = u.app_user_id and rl.is_current = true and rl.verified = true
    ) as is_recruiter,

    exists (
      select 1
      from public.direct_entry_team_leader_assignments tla
      join public.teams t on t.team_id = tla.team_id and t.active = true
      where tla.leader_app_user_id = u.app_user_id
        and tla.is_current = true
        and tla.valid_from <= p.as_of_date
        and (tla.valid_to is null or (tla.valid_to > tla.valid_from and p.as_of_date < tla.valid_to))
    ) as is_team_leader,

    exists (
      select 1
      from public.leave_department_approvers lda
      where lda.approver_app_user_id = u.app_user_id
        and lda.is_current = true
        and lda.valid_from <= p.as_of_date
        and (lda.valid_to is null or (lda.valid_to > lda.valid_from and p.as_of_date < lda.valid_to))
    ) as is_dept_head,
    coalesce((
      select string_agg(lda.unit_kind, ',' order by lda.unit_kind)
      from public.leave_department_approvers lda
      where lda.approver_app_user_id = u.app_user_id
        and lda.is_current = true
        and lda.valid_from <= p.as_of_date
        and (lda.valid_to is null or (lda.valid_to > lda.valid_from and p.as_of_date < lda.valid_to))
    ), '') as legacy_leave_approver_units,

    exists (
      select 1
      from public.direct_entry_app_user_recruiter_links rl
      join public.recruiters r on r.recruiter_id = rl.recruiter_id and r.active = true
      join public.direct_entry_project_manager_assignments pma on pma.manager_recruiter_id = rl.recruiter_id
      join public.direct_entry_projects prj on prj.project_id = pma.project_id and prj.active = true
      where rl.app_user_id = u.app_user_id and rl.is_current = true and rl.verified = true
        and pma.is_current = true and pma.revoked_at is null
        and pma.valid_from <= p.as_of_date
        and (pma.valid_to is null or (pma.valid_to > pma.valid_from and p.as_of_date < pma.valid_to))
    ) as is_project_manager,

    exists (
      select 1
      from public.vendor_finance_project_accountants vfpa
      join public.direct_entry_projects prj on prj.project_id = vfpa.project_id and prj.active = true
      where vfpa.accountant_user_id = u.app_user_id
        and vfpa.ended_at is null
        and vfpa.valid_from <= p.as_of_date
        and (vfpa.valid_to is null or (vfpa.valid_to > vfpa.valid_from and p.as_of_date < vfpa.valid_to))
    ) as is_project_accountant,
    exists (
      select 1
      from public.organization_department_memberships odm
      join public.organization_departments od on od.department_id = odm.department_id and od.is_active = true
      where odm.app_user_id = u.app_user_id and od.code = 'ACCOUNTING'
        and odm.valid_from <= p.as_of_date
        and (odm.valid_to is null or (odm.valid_to > odm.valid_from and p.as_of_date < odm.valid_to))
        and (odm.revoked_at is null or p.as_of_ts < odm.revoked_at)
    ) as is_accounting_dept,
    coalesce((
      select string_agg(vfgr.role_code, ',' order by vfgr.role_code)
      from public.vendor_finance_global_roles vfgr
      where vfgr.app_user_id = u.app_user_id
        and vfgr.ended_at is null
        and vfgr.valid_from <= p.as_of_date
        and (vfgr.valid_to is null or (vfgr.valid_to > vfgr.valid_from and p.as_of_date < vfgr.valid_to))
    ), '') as vfin_global_roles,

    coalesce((
      select string_agg(lmg.role_code, ',' order by lmg.role_code)
      from public.leave_module_grants lmg
      where lmg.app_user_id = u.app_user_id and lmg.is_current = true
        and lmg.valid_from <= p.as_of_date
        and (lmg.valid_to is null or (lmg.valid_to > lmg.valid_from and p.as_of_date < lmg.valid_to))
    ), '') as leave_roles,
    (coalesce(lep.unit_kind, '') = 'MANAGEMENT_BOD') as is_bod_unit,
    (
      exists (select 1 from public.direct_entry_scope_grants sg where sg.app_user_id = u.app_user_id and sg.is_current = true and sg.scope_kind = 'all')
      and exists (select 1 from public.direct_entry_capability_grants cg where cg.app_user_id = u.app_user_id and cg.is_current = true and cg.capability = 'entry_admin')
      and exists (select 1 from public.direct_entry_capability_grants cg where cg.app_user_id = u.app_user_id and cg.is_current = true and cg.capability = 'recruiter_master_manage')
      and exists (select 1 from public.direct_entry_capability_grants cg where cg.app_user_id = u.app_user_id and cg.is_current = true and cg.capability = 'team_master_manage')
    ) as is_global_admin,
    (
      exists (select 1 from public.direct_entry_scope_grants sg where sg.app_user_id = u.app_user_id and sg.is_current = true and sg.scope_kind = 'all')
      and (
        exists (select 1 from public.direct_entry_capability_grants cg where cg.app_user_id = u.app_user_id and cg.is_current = true and cg.capability in ('entry_privileged_edit', 'report_view'))
      )
    ) as is_valid_bod_or_admin_all,
    (
      exists (select 1 from public.leave_module_grants lmg where lmg.app_user_id = u.app_user_id and lmg.is_current = true and lmg.role_code like 'HR_%')
      or (
        not (
          exists (select 1 from public.direct_entry_capability_grants cg where cg.app_user_id = u.app_user_id and cg.is_current = true and cg.capability = 'entry_admin')
          and exists (select 1 from public.direct_entry_capability_grants cg where cg.app_user_id = u.app_user_id and cg.is_current = true and cg.capability = 'recruiter_master_manage')
          and exists (select 1 from public.direct_entry_capability_grants cg where cg.app_user_id = u.app_user_id and cg.is_current = true and cg.capability = 'team_master_manage')
        )
        and exists (
          select 1 from public.direct_entry_capability_grants cg
          where cg.app_user_id = u.app_user_id and cg.is_current = true
            and cg.capability in ('catalog_master_manage', 'audit_view', 'worker_edit_history_view', 'change_review', 'employment_status.review', 'employment_status.apply', 'duplicate_cccd_withdraw', 'recruiter_master_manage', 'team_master_manage')
        )
      )
    ) as is_hr_or_catalog_operator,

    coalesce((
      select string_agg(wrd.capability || '(' || wrd.scope_kind || ')', ',' order by wrd.capability)
      from public.work_report_delegations wrd
      where wrd.delegate_app_user_id = u.app_user_id
        and wrd.is_current = true
        and wrd.state = 'ACTIVE'
        and wrd.revoked_at is null
        and wrd.effective_from <= p.as_of_ts
        and (wrd.effective_to is null or p.as_of_ts <= wrd.effective_to)
    ), '') as active_delegations

  from params p
  join public.direct_entry_app_users u on (u.created_at at time zone 'Asia/Ho_Chi_Minh')::date <= p.as_of_date
  left join public.leave_employee_profiles lep on lep.app_user_id = u.app_user_id
),
persona_classified as (
  select
    s.*,
    (
      (case when s.is_team_leader then 1 else 0 end) +
      (case when s.is_dept_head then 1 else 0 end) +
      (case when s.is_project_manager then 1 else 0 end) +
      (case when s.is_project_accountant or s.is_accounting_dept or s.vfin_global_roles <> '' then 1 else 0 end) +
      (case when s.is_hr_or_catalog_operator then 1 else 0 end) +
      (case when s.is_global_admin or s.is_valid_bod_or_admin_all or s.is_bod_unit then 1 else 0 end)
    ) as distinct_role_count,
    array_remove(array[
      case when not s.enabled then 'P09_DISABLED_OR_REENABLED' end,
      case when s.enabled and s.is_shared_non_employee then 'P08_SHARED_SERVICE' end,
      case when s.enabled and (s.is_global_admin or s.is_valid_bod_or_admin_all or s.is_bod_unit or s.leave_roles like '%LEAVE_ADMIN_BOD_APPROVER%' or s.leave_roles like '%CEO_FALLBACK_APPROVER%') then 'P07_BOD_ADMIN' end,
      case when s.enabled and s.is_hr_or_catalog_operator then 'P06_HR_OPERATOR' end,
      case when s.enabled and (s.is_project_accountant or s.is_accounting_dept or s.vfin_global_roles <> '') then 'P05_ACCOUNTANT' end,
      case when s.enabled and s.is_project_manager then 'P04_PROJECT_MANAGER' end,
      case when s.enabled and s.is_dept_head then 'P03_DEPARTMENT_HEAD' end,
      case when s.enabled and s.is_team_leader then 'P02_TEAM_LEADER' end,
      case when s.enabled and s.is_recruiter and not s.is_team_leader and not s.is_project_manager then 'P01_EMPLOYEE_RECRUITER' end
    ], null) as matched_personas
  from user_signals s
),
account_rows as (
  select
    'ACCOUNT_CANDIDATE'::text as row_kind,
    as_of_date,
    account_id_mask,
    app_user_id,
    enabled,
    user_created_date,
    case
      when not enabled then 'P09_DISABLED_OR_REENABLED'
      when is_shared_non_employee then 'P08_SHARED_SERVICE'
      when distinct_role_count >= 2 then 'P10_MULTI_ROLE'
      when coalesce(array_length(matched_personas, 1), 0) >= 1 then matched_personas[1]
      else 'P01_EMPLOYEE_RECRUITER'
    end as primary_persona,
    array_to_string(case when distinct_role_count >= 2 then array_append(matched_personas, 'P10_MULTI_ROLE') else matched_personas end, ', ') as all_matched_personas,
    case
      when not enabled then 'VERIFIED_DISABLED_ACCOUNT (enabled=false)'
      when is_dept_head and is_team_leader then 'INFERRED_FROM_LEGACY_LEAVE_APPROVER_MULTI_ROLE (leave_department_approvers=' || legacy_leave_approver_units || ' + Team Leader)'
      when is_dept_head then 'INFERRED_FROM_LEGACY_LEAVE_APPROVER (leave_department_approvers=' || legacy_leave_approver_units || ')'
      when is_bod_unit and current_scopes like '%all%' and current_capabilities = '' then 'LOCKED_DECISION_PENDING_BOD_ROLE_GRANT (Currently scope=all + 0 capabilities; requires explicit BoD role grants in WP5-WP6)'
      when is_hr_or_catalog_operator and leave_roles like '%HR_%' then 'VERIFIED_CANONICAL_HR_OPERATOR (leave_module_grants=' || leave_roles || ')'
      when is_hr_or_catalog_operator then 'VERIFIED_R1_CATALOG_OR_HR_CAPABILITY_ONLY'
      else 'VERIFIED_EXISTING_ACCOUNT'
    end as role_verification_status,
    case when as_of_date < current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled + is_current + leave_employee_profiles.unit_kind)' else 'POINT_IN_TIME_CURRENT' end as reconstructibility,
    dept_memberships, legacy_unit_kind, current_capabilities, current_scopes, vfin_global_roles, leave_roles, active_delegations,
    is_recruiter, is_team_leader, is_dept_head, is_project_manager, is_project_accountant
  from persona_classified
),
uat_gaps as (
  select
    'UAT_PROVISIONING_GAP'::text as row_kind, p.as_of_date, 'MISSING_P06'::text as account_id_mask, null::uuid as app_user_id, null::boolean as enabled, null::date as user_created_date,
    'P06_HR_OPERATOR'::text as primary_persona, 'P06_HR_OPERATOR'::text as all_matched_personas,
    'NEEDS_TEST_ACCOUNT_SEED: 0 HR_OPERATOR accounts match in current DB'::text as role_verification_status,
    'N/A'::text as reconstructibility, ''::text as dept_memberships, 'N/A'::text as legacy_unit_kind, ''::text as current_capabilities, ''::text as current_scopes, ''::text as vfin_global_roles, ''::text as leave_roles, ''::text as active_delegations,
    false as is_recruiter, false as is_team_leader, false as is_dept_head, false as is_project_manager, false as is_project_accountant
  from params p
  where not exists (select 1 from account_rows a where a.all_matched_personas like '%P06_HR_OPERATOR%')

  union all

  select
    'UAT_PROVISIONING_GAP'::text, p.as_of_date, 'MISSING_CATALOG_WITH_ALL_SCOPE'::text, null::uuid, null::boolean, null::date,
    'P06_HR_OPERATOR'::text, 'P06_HR_OPERATOR (CATALOG_MANAGE_WITH_ALL_SCOPE)'::text,
    'NEEDS_TEST_ACCOUNT_SEED: catalog_master_manage + scope=all without report_view'::text,
    'N/A'::text, ''::text, 'N/A'::text, 'REQUIRED: catalog_master_manage + scope=all'::text, 'all'::text, ''::text, ''::text, ''::text,
    false, false, false, false, false
  from params p
  where not exists (
    select 1 from account_rows a
    where a.current_scopes like '%all%' and a.current_capabilities like '%catalog_master_manage%'
      and a.current_capabilities not like '%report_view%' and a.current_capabilities not like '%entry_admin%'
  )

  union all

  select
    'UAT_PROVISIONING_GAP'::text, p.as_of_date, 'MISSING_CATALOG_WITHOUT_ALL_SCOPE'::text, null::uuid, null::boolean, null::date,
    'P06_HR_OPERATOR'::text, 'P06_HR_OPERATOR (CATALOG_MANAGE_WITHOUT_ALL_SCOPE)'::text,
    'NEEDS_TEST_ACCOUNT_SEED: catalog_master_manage without scope=all'::text,
    'N/A'::text, ''::text, 'N/A'::text, 'REQUIRED: catalog_master_manage + scope=own'::text, 'own'::text, ''::text, ''::text, ''::text,
    false, false, false, false, false
  from params p
  where not exists (
    select 1 from account_rows a
    where a.current_capabilities like '%catalog_master_manage%' and a.current_scopes not like '%all%'
  )

  union all

  select
    'UAT_PROVISIONING_GAP'::text, p.as_of_date, 'MISSING_WR_DELEGATE'::text, null::uuid, null::boolean, null::date,
    'P01_EMPLOYEE_RECRUITER'::text, 'WORK_REPORTS_DELEGATE_M4'::text,
    'NEEDS_TEST_ACCOUNT_SEED: 0 active work_report_delegations rows in DB'::text,
    'N/A'::text, ''::text, 'N/A'::text, 'REQUIRED: Active work_report_delegations'::text, ''::text, ''::text, ''::text, 'REQUIRED: report_assign, report_review'::text,
    false, false, false, false, false
  from params p
  where not exists (select 1 from account_rows a where a.active_delegations <> '')
)
select *
from (select * from account_rows union all select * from uat_gaps) combined
order by case when row_kind = 'UAT_PROVISIONING_GAP' then 0 else 1 end, primary_persona, account_id_mask;
