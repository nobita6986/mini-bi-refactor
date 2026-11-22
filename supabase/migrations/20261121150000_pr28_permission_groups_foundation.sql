-- =============================================================================
-- PR #28 (Rev 4): Permission Groups Foundation & D4 Module Roles (Additive)
--
-- Implements D1-D4 group-based authorization foundation strictly within ceiling:
--   - department_id NOT NULL + at most one nullable team_id (0 scope enum,
--     0 GLOBAL/CONTEXTUAL, 0 scope_template, 0 project_id, 0 NULL -> ALL).
--   - Exact 29 verbatim CAPABILITIES preserved; SYSTEM_ADMIN ("BoD/Admin")
--     bound to MANAGEMENT_BOD with exact 21 ADMIN capabilities and 4-layer DB
--     Owner protection (is_protected -> AUTHZ_PROTECTED_ASSIGNMENT / PT409).
--   - D4 group-managed module roles (authz_user_group_module_roles) locked to
--     the exact 7 existing vendor_finance (4) and leave (3) domain roles at
--     read time (0 capability #30, 0 generic rule engine, 0 side-effects on
--     independent direct grants or per-resource assignments).
--   - 100% additive & backward-compatible with existing Web until cutover/cleanup.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Core Permission Group Tables (FORCE RLS, 0 policies, 0 table grants)
-- -----------------------------------------------------------------------------
create table if not exists public.authz_user_groups (
  group_id uuid primary key default gen_random_uuid(),
  code text not null unique
    constraint authz_user_groups_code_chk check (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  name text not null
    constraint authz_user_groups_name_chk
    check (
      pg_catalog.btrim(name) = name
      and pg_catalog.length(name) between 2 and 128
    ),
  description text not null default ''
    constraint authz_user_groups_description_chk
    check (
      pg_catalog.btrim(description) = description
      and pg_catalog.length(description) <= 500
    ),
  department_id uuid not null
    references public.organization_departments(department_id) on delete restrict,
  team_id uuid
    references public.teams(team_id) on delete restrict,
  is_system_admin boolean not null default false,
  active boolean not null default true,
  version integer not null default 1
    constraint authz_user_groups_version_chk check (version >= 1),
  created_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  updated_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint authz_user_groups_system_admin_invariants_chk check (
    not is_system_admin
    or (code = 'SYSTEM_ADMIN' and team_id is null and active = true)
  )
);

create unique index if not exists authz_user_groups_single_system_admin_uidx
  on public.authz_user_groups (is_system_admin)
  where is_system_admin = true;

create index if not exists authz_user_groups_dept_team_idx
  on public.authz_user_groups (department_id, team_id, active, group_id);

create table if not exists public.authz_user_group_capabilities (
  group_capability_id uuid primary key default gen_random_uuid(),
  group_id uuid not null
    references public.authz_user_groups(group_id) on delete restrict,
  capability text not null
    constraint authz_user_group_capabilities_cap_chk check (capability in (
      'entry_create',
      'entry_own',
      'entry_team',
      'entry_admin',
      'entry_restore',
      'submission_create',
      'change_request_create',
      'change_review',
      'entry_privileged_edit',
      'employment_status.request',
      'employment_status.review',
      'employment_status.apply',
      'document_upload',
      'document_view',
      'recruiter_master_manage',
      'team_master_manage',
      'audit_view',
      'catalog_master_manage',
      'team_manager_assign',
      'report_form_manage',
      'report_assign',
      'report_view',
      'report_analytics_view',
      'report_review',
      'report_delegate',
      'vendor_finance_view',
      'vendor_finance_record',
      'duplicate_cccd_withdraw',
      'worker_edit_history_view'
    )),
  started_at timestamptz not null default pg_catalog.clock_timestamp(),
  ended_at timestamptz
    constraint authz_user_group_capabilities_interval_chk
    check (ended_at is null or ended_at >= started_at),
  granted_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  ended_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason text
    constraint authz_user_group_capabilities_reason_chk
    check (
      reason is null
      or (pg_catalog.btrim(reason) = reason and pg_catalog.length(reason) between 3 and 500)
    ),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

create unique index if not exists authz_user_group_capabilities_open_uidx
  on public.authz_user_group_capabilities (group_id, capability)
  where ended_at is null;

create index if not exists authz_user_group_capabilities_lookup_idx
  on public.authz_user_group_capabilities (group_id, started_at desc, group_capability_id asc);

create table if not exists public.authz_user_group_module_roles (
  group_module_role_id uuid primary key default gen_random_uuid(),
  group_id uuid not null
    references public.authz_user_groups(group_id) on delete restrict,
  module_code text not null,
  role_code text not null,
  started_at timestamptz not null default pg_catalog.clock_timestamp(),
  ended_at timestamptz
    constraint authz_user_group_module_roles_interval_chk
    check (ended_at is null or ended_at >= started_at),
  granted_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  ended_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason text
    constraint authz_user_group_module_roles_reason_chk
    check (
      reason is null
      or (pg_catalog.btrim(reason) = reason and pg_catalog.length(reason) between 3 and 500)
    ),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint authz_user_group_module_roles_domain_chk check (
    (
      module_code = 'vendor_finance'
      and role_code in (
        'GLOBAL_VIEWER',
        'GLOBAL_RECONCILER',
        'CASH_HOLDER',
        'CASH_HOLDER_RECORD_BEHALF'
      )
    )
    or (
      module_code = 'leave'
      and role_code in (
        'HR_REPORT_VIEWER',
        'HR_LEAVE_OPERATOR',
        'LEAVE_ADMIN_BOD_APPROVER'
      )
    )
  )
);

create unique index if not exists authz_user_group_module_roles_open_uidx
  on public.authz_user_group_module_roles (group_id, module_code, role_code)
  where ended_at is null;

create index if not exists authz_user_group_module_roles_lookup_idx
  on public.authz_user_group_module_roles (group_id, module_code, role_code)
  where ended_at is null;

create table if not exists public.authz_user_group_members (
  membership_id uuid primary key default gen_random_uuid(),
  group_id uuid not null
    references public.authz_user_groups(group_id) on delete restrict,
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  source_kind text not null default 'ADMIN_ASSIGNMENT'
    constraint authz_user_group_members_source_chk
    check (source_kind in ('ADMIN_ASSIGNMENT', 'BACKFILL_MIGRATION')),
  migrated_from_source text
    constraint authz_user_group_members_migrated_source_chk
    check (
      migrated_from_source is null
      or migrated_from_source in (
        'authz_account_role_assignments',
        'authz_direct_capability_grants',
        'vendor_finance_global_roles',
        'leave_module_grants'
      )
    ),
  migrated_from_id uuid,
  reason text
    constraint authz_user_group_members_reason_chk
    check (
      reason is null
      or (pg_catalog.btrim(reason) = reason and pg_catalog.length(reason) between 3 and 500)
    ),
  started_at timestamptz not null default pg_catalog.clock_timestamp(),
  ended_at timestamptz
    constraint authz_user_group_members_interval_chk
    check (ended_at is null or ended_at >= started_at),
  ended_reason text
    constraint authz_user_group_members_ended_reason_chk
    check (
      ended_reason is null
      or (pg_catalog.btrim(ended_reason) = ended_reason and pg_catalog.length(ended_reason) between 3 and 500)
    ),
  assigned_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  ended_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  is_protected boolean not null default false,
  protected_reason text
    constraint authz_user_group_members_protected_reason_chk
    check (protected_reason is null or protected_reason = 'PROTECTED_OWNER_ADMIN'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint authz_user_group_members_protected_invariant_chk check (
    (is_protected = false and protected_reason is null)
    or (is_protected = true and protected_reason = 'PROTECTED_OWNER_ADMIN')
  ),
  constraint authz_user_group_members_end_invariant_chk check (
    (ended_at is null and ended_reason is null and ended_by_app_user_id is null)
    or (ended_at is not null and ended_by_app_user_id is not null)
  ),
  constraint authz_user_group_members_provenance_chk check (
    (source_kind = 'ADMIN_ASSIGNMENT' and migrated_from_source is null and migrated_from_id is null)
    or (source_kind = 'BACKFILL_MIGRATION' and migrated_from_source is not null and migrated_from_id is not null)
  )
);

create index if not exists authz_user_group_members_provenance_idx
  on public.authz_user_group_members (migrated_from_source, migrated_from_id)
  where migrated_from_source is not null and migrated_from_id is not null;

create unique index if not exists authz_user_group_members_open_uidx
  on public.authz_user_group_members (group_id, app_user_id)
  where ended_at is null;

create unique index if not exists authz_user_group_members_single_protected_uidx
  on public.authz_user_group_members (is_protected)
  where is_protected = true and ended_at is null;

create index if not exists authz_user_group_members_user_idx
  on public.authz_user_group_members (app_user_id, started_at desc, membership_id asc);

create table if not exists public.authz_group_audit_events (
  audit_event_id uuid primary key default gen_random_uuid(),
  actor_auth_subject uuid not null,
  actor_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  group_id uuid
    references public.authz_user_groups(group_id) on delete restrict,
  target_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  membership_id uuid
    references public.authz_user_group_members(membership_id) on delete restrict,
  operation_name text not null
    constraint authz_group_audit_events_op_chk
    check (pg_catalog.length(pg_catalog.btrim(operation_name)) between 1 and 96),
  before_payload jsonb,
  after_payload jsonb,
  reason text,
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

create index if not exists authz_group_audit_events_group_idx
  on public.authz_group_audit_events (group_id, created_at desc, audit_event_id asc);

create index if not exists authz_group_audit_events_target_idx
  on public.authz_group_audit_events (target_app_user_id, created_at desc, audit_event_id asc);

create table if not exists public.authz_group_idempotency (
  idempotency_record_id uuid primary key default gen_random_uuid(),
  actor_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  operation_name text not null
    constraint authz_group_idempotency_op_chk
    check (pg_catalog.length(pg_catalog.btrim(operation_name)) between 1 and 96),
  target_key text not null
    constraint authz_group_idempotency_target_chk
    check (pg_catalog.length(pg_catalog.btrim(target_key)) between 1 and 160),
  idempotency_key text not null
    constraint authz_group_idempotency_key_chk
    check (pg_catalog.length(pg_catalog.btrim(idempotency_key)) between 1 and 128),
  request_hash text not null
    constraint authz_group_idempotency_hash_chk check (request_hash ~ '^[a-f0-9]{64}$'),
  response_payload jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (actor_app_user_id, operation_name, target_key, idempotency_key)
);

create table if not exists public.authz_legacy_direct_grant_migrations (
  direct_grant_id uuid primary key
    references public.authz_direct_capability_grants(direct_grant_id) on delete restrict,
  resolution_kind text not null
    constraint authz_legacy_direct_grant_migrations_kind_chk
    check (resolution_kind in ('COVERED_BY_GROUP', 'MIGRATED_TO_GROUP')),
  group_id uuid
    references public.authz_user_groups(group_id) on delete restrict,
  recorded_at timestamptz not null default pg_catalog.clock_timestamp()
);

-- FORCE RLS + zero table grants on all 7 new tables
alter table public.authz_user_groups enable row level security;
alter table public.authz_user_groups force row level security;
revoke all on table public.authz_user_groups from public, anon, authenticated, service_role;

alter table public.authz_user_group_capabilities enable row level security;
alter table public.authz_user_group_capabilities force row level security;
revoke all on table public.authz_user_group_capabilities from public, anon, authenticated, service_role;

alter table public.authz_user_group_module_roles enable row level security;
alter table public.authz_user_group_module_roles force row level security;
revoke all on table public.authz_user_group_module_roles from public, anon, authenticated, service_role;

alter table public.authz_user_group_members enable row level security;
alter table public.authz_user_group_members force row level security;
revoke all on table public.authz_user_group_members from public, anon, authenticated, service_role;

alter table public.authz_group_audit_events enable row level security;
alter table public.authz_group_audit_events force row level security;
revoke all on table public.authz_group_audit_events from public, anon, authenticated, service_role;

alter table public.authz_group_idempotency enable row level security;
alter table public.authz_group_idempotency force row level security;
revoke all on table public.authz_group_idempotency from public, anon, authenticated, service_role;

alter table public.authz_legacy_direct_grant_migrations enable row level security;
alter table public.authz_legacy_direct_grant_migrations force row level security;
revoke all on table public.authz_legacy_direct_grant_migrations from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Table Guard Triggers (4 guard triggers + 2 immutable audit/idempotency)
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_authz__trg_guard_user_group()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_dept public.organization_departments%rowtype;
  v_team public.teams%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'AUTHZ_USER_GROUP_DELETE_FORBIDDEN' using errcode = '55000';
  end if;

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = new.department_id;
  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = '22023';
  end if;

  if new.is_system_admin then
    if coalesce(v_dept.system_key, '') <> 'MANAGEMENT_BOD' then
      raise exception 'GROUP_SYSTEM_ADMIN_DEPARTMENT_INVALID' using errcode = '22023';
    end if;
    if new.team_id is not null or not new.active then
      raise exception 'GROUP_SYSTEM_ADMIN_IMMUTABLE' using errcode = 'PT409';
    end if;
  end if;

  if new.team_id is not null then
    select t.* into v_team
      from public.teams t
     where t.team_id = new.team_id;
    if not found or v_team.code = '__system_vendor__' then
      raise exception 'TEAM_NOT_FOUND' using errcode = '22023';
    end if;
    if coalesce(v_dept.system_key, '') <> 'RECRUITMENT' then
      raise exception 'GROUP_TEAM_REQUIRES_RECRUITMENT_DEPARTMENT' using errcode = '22023';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.code <> new.code or old.is_system_admin <> new.is_system_admin then
      raise exception 'AUTHZ_USER_GROUP_IDENTITY_IMMUTABLE' using errcode = '55000';
    end if;
    if old.is_system_admin and (
      old.department_id <> new.department_id
      or new.team_id is not null
      or not new.active
    ) then
      raise exception 'GROUP_SYSTEM_ADMIN_IMMUTABLE' using errcode = 'PT409';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.direct_entry_authz__trg_guard_user_group()
  from public, anon, authenticated, service_role;

drop trigger if exists authz_user_groups_guard_trg on public.authz_user_groups;
create trigger authz_user_groups_guard_trg
  before insert or update or delete on public.authz_user_groups
  for each row execute function public.direct_entry_authz__trg_guard_user_group();

create or replace function public.direct_entry_authz__trg_guard_user_group_capability()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_group public.authz_user_groups%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'AUTHZ_GROUP_CAPABILITY_DELETE_FORBIDDEN' using errcode = '55000';
  end if;

  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = new.group_id;
  if not found then
    raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  if tg_op = 'UPDATE' then
    if old.ended_at is not null then
      raise exception 'AUTHZ_GROUP_CAPABILITY_HISTORY_IMMUTABLE' using errcode = '55000';
    end if;
    if old.group_id <> new.group_id
       or old.capability <> new.capability
       or old.started_at <> new.started_at then
      raise exception 'AUTHZ_GROUP_CAPABILITY_HISTORY_IMMUTABLE' using errcode = '55000';
    end if;
    if v_group.is_system_admin and new.ended_at is not null then
      raise exception 'GROUP_SYSTEM_ADMIN_IMMUTABLE' using errcode = 'PT409';
    end if;
    return new;
  end if;

  -- Enforce strict group capability ceilings on INSERT
  if v_group.is_system_admin then
    -- Exact 21 ADMIN capabilities only (never auto-add the 8 non-admin tokens)
    if new.capability in (
      'catalog_master_manage',
      'team_manager_assign',
      'report_form_manage',
      'report_assign',
      'report_review',
      'report_delegate',
      'vendor_finance_view',
      'vendor_finance_record'
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_SYSTEM_ADMIN' using errcode = '22023';
    end if;
  elsif v_group.team_id is not null then
    -- Team-scoped group: strictly team + personal operational capabilities
    if new.capability not in (
      'entry_team',
      'team_manager_assign',
      'change_review',
      'report_view',
      'report_analytics_view',
      'report_assign',
      'report_review',
      'report_delegate',
      'worker_edit_history_view',
      'entry_create',
      'entry_own',
      'submission_create',
      'document_upload',
      'document_view',
      'change_request_create',
      'employment_status.request'
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP' using errcode = '22023';
    end if;
  else
    -- Regular non-admin department group: NEVER allow admin-only, team-only,
    -- BoD-executive (report_view / report_analytics_view on ALL scope), or global-treasurer
    -- (vendor_finance_record on ALL scope; use D4 vendor_finance module roles instead) escalations.
    if new.capability in (
      'entry_admin',
      'entry_team',
      'entry_restore',
      'entry_privileged_edit',
      'change_review',
      'employment_status.review',
      'employment_status.apply',
      'team_manager_assign',
      'report_view',
      'report_analytics_view',
      'vendor_finance_record'
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.direct_entry_authz__trg_guard_user_group_capability()
  from public, anon, authenticated, service_role;

drop trigger if exists authz_user_group_capabilities_guard_trg on public.authz_user_group_capabilities;
create trigger authz_user_group_capabilities_guard_trg
  before insert or update or delete on public.authz_user_group_capabilities
  for each row execute function public.direct_entry_authz__trg_guard_user_group_capability();

create or replace function public.direct_entry_authz__trg_guard_user_group_module_role()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_group public.authz_user_groups%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'AUTHZ_GROUP_MODULE_ROLE_DELETE_FORBIDDEN' using errcode = '55000';
  end if;

  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = new.group_id;
  if not found then
    raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  if tg_op = 'INSERT' then
    if v_group.is_system_admin then
      raise exception 'GROUP_MODULE_ROLE_FORBIDDEN_FOR_SYSTEM_ADMIN' using errcode = '22023';
    end if;
    if v_group.team_id is not null then
      raise exception 'GROUP_MODULE_ROLE_FORBIDDEN_FOR_TEAM_GROUP' using errcode = '22023';
    end if;
    return new;
  end if;

  if old.ended_at is not null then
    raise exception 'AUTHZ_GROUP_MODULE_ROLE_HISTORY_IMMUTABLE' using errcode = '55000';
  end if;
  if old.group_id <> new.group_id
     or old.module_code <> new.module_code
     or old.role_code <> new.role_code
     or old.started_at <> new.started_at then
    raise exception 'AUTHZ_GROUP_MODULE_ROLE_HISTORY_IMMUTABLE' using errcode = '55000';
  end if;

  return new;
end;
$function$;

revoke all on function public.direct_entry_authz__trg_guard_user_group_module_role()
  from public, anon, authenticated, service_role;

drop trigger if exists authz_user_group_module_roles_guard_trg on public.authz_user_group_module_roles;
create trigger authz_user_group_module_roles_guard_trg
  before insert or update or delete on public.authz_user_group_module_roles
  for each row execute function public.direct_entry_authz__trg_guard_user_group_module_role();

create or replace function public.direct_entry_authz__trg_guard_user_group_member()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_group public.authz_user_groups%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.is_protected then
      raise exception 'AUTHZ_PROTECTED_ASSIGNMENT' using errcode = 'PT409';
    end if;
    raise exception 'AUTHZ_GROUP_MEMBER_DELETE_FORBIDDEN' using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    select g.* into v_group
      from public.authz_user_groups g
     where g.group_id = new.group_id;
    if not found then
      raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002';
    end if;
    if new.is_protected and not v_group.is_system_admin then
      raise exception 'AUTHZ_PROTECTED_REQUIRES_SYSTEM_ADMIN_GROUP' using errcode = '22023';
    end if;
    return new;
  end if;

  -- UPDATE guards
  if old.is_protected then
    if new.ended_at is not null
       or not new.is_protected
       or new.protected_reason is distinct from old.protected_reason
       or new.group_id <> old.group_id
       or new.app_user_id <> old.app_user_id then
      raise exception 'AUTHZ_PROTECTED_ASSIGNMENT' using errcode = 'PT409';
    end if;
  end if;

  if old.ended_at is not null then
    raise exception 'AUTHZ_GROUP_MEMBER_HISTORY_IMMUTABLE' using errcode = '55000';
  end if;

  if old.group_id <> new.group_id
     or old.app_user_id <> new.app_user_id
     or old.started_at <> new.started_at
     or old.source_kind <> new.source_kind
     or old.migrated_from_source is distinct from new.migrated_from_source
     or old.migrated_from_id is distinct from new.migrated_from_id
     or old.is_protected <> new.is_protected then
    raise exception 'AUTHZ_GROUP_MEMBER_HISTORY_IMMUTABLE' using errcode = '55000';
  end if;

  return new;
end;
$function$;

revoke all on function public.direct_entry_authz__trg_guard_user_group_member()
  from public, anon, authenticated, service_role;

drop trigger if exists authz_user_group_members_guard_trg on public.authz_user_group_members;
create trigger authz_user_group_members_guard_trg
  before insert or update or delete on public.authz_user_group_members
  for each row execute function public.direct_entry_authz__trg_guard_user_group_member();

drop trigger if exists authz_group_audit_events_immutable_trg on public.authz_group_audit_events;
create trigger authz_group_audit_events_immutable_trg
  before update or delete on public.authz_group_audit_events
  for each row execute function public.direct_entry_reject_immutable_change();

drop trigger if exists authz_group_idempotency_immutable_trg on public.authz_group_idempotency;
create trigger authz_group_idempotency_immutable_trg
  before update or delete on public.authz_group_idempotency
  for each row execute function public.direct_entry_reject_immutable_change();

-- -----------------------------------------------------------------------------
-- 3. Seed 11 Canonical 1:1 Permission Groups & Idempotent Backfill Helper
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_authz__internal_backfill_legacy_to_groups()
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_dept_bod uuid;
  v_dept_rec uuid;
  v_dept_acc uuid;
  v_grp_admin uuid;
  v_grp_hr uuid;
  v_grp_rec uuid;
  v_grp_acc uuid;
  v_grp_vfin_viewer uuid;
  v_grp_vfin_reconciler uuid;
  v_grp_vfin_cash uuid;
  v_grp_vfin_behalf uuid;
  v_grp_leave_hr uuid;
  v_grp_leave_viewer uuid;
  v_grp_leave_bod uuid;
  v_dg record;
  v_team record;
  v_target_group_id uuid;
  v_code text;
  v_name text;
  v_cap_sanitized text;
  v_covering_group_id uuid;
begin
  select department_id into v_dept_bod
    from public.organization_departments
   where system_key = 'MANAGEMENT_BOD'
   limit 1;
  select department_id into v_dept_rec
    from public.organization_departments
   where system_key = 'RECRUITMENT'
   limit 1;
  select department_id into v_dept_acc
    from public.organization_departments
   where system_key = 'ACCOUNTING'
   limit 1;

  if v_dept_bod is null or v_dept_rec is null or v_dept_acc is null then
    raise exception 'PR28_SEED_MISSING_CANONICAL_DEPARTMENTS';
  end if;

  select group_id into v_grp_admin from public.authz_user_groups where code = 'SYSTEM_ADMIN';
  select group_id into v_grp_hr from public.authz_user_groups where code = 'HR_CATALOG_OPERATOR';
  select group_id into v_grp_rec from public.authz_user_groups where code = 'RECRUITER_OPERATIONS';
  select group_id into v_grp_acc from public.authz_user_groups where code = 'ACCOUNTING_OPERATIONS';
  select group_id into v_grp_vfin_viewer from public.authz_user_groups where code = 'VFIN_GLOBAL_VIEWER';
  select group_id into v_grp_vfin_reconciler from public.authz_user_groups where code = 'VFIN_GLOBAL_RECONCILER';
  select group_id into v_grp_vfin_cash from public.authz_user_groups where code = 'VFIN_CASH_HOLDER';
  select group_id into v_grp_vfin_behalf from public.authz_user_groups where code = 'VFIN_CASH_HOLDER_RECORD_BEHALF';
  select group_id into v_grp_leave_hr from public.authz_user_groups where code = 'LEAVE_HR_OPERATIONS';
  select group_id into v_grp_leave_viewer from public.authz_user_groups where code = 'LEAVE_REPORT_VIEWER';
  select group_id into v_grp_leave_bod from public.authz_user_groups where code = 'LEAVE_BOD_APPROVER';

  -- 3.1 Backfill active global role assignments (ADMIN, HR_OPERATOR, RECRUITER)
  -- Each assignment_id is migrated AT MOST ONCE (removing a group membership later never resurrects it).
  -- Preserves exact Owner is_protected flag on SYSTEM_ADMIN; never auto-upgrades report-only grants!
  insert into public.authz_user_group_members (
    group_id,
    app_user_id,
    source_kind,
    migrated_from_source,
    migrated_from_id,
    reason,
    started_at,
    assigned_by_app_user_id,
    is_protected,
    protected_reason
  )
  select
    case ara.role_code
      when 'ADMIN' then v_grp_admin
      when 'HR_OPERATOR' then v_grp_hr
      when 'RECRUITER' then v_grp_rec
    end as group_id,
    ara.app_user_id,
    'BACKFILL_MIGRATION',
    'authz_account_role_assignments',
    ara.assignment_id,
    'Chuyển tiếp tự động từ vai trò toàn cục hiện hữu sang nhóm quyền',
    least(ara.started_at, v_now),
    ara.assigned_by_app_user_id,
    case when ara.role_code = 'ADMIN' then ara.is_protected else false end,
    case when ara.role_code = 'ADMIN' then ara.protected_reason else null end
  from public.authz_account_role_assignments ara
  where ara.ended_at is null
    and ara.started_at <= v_now
    and ara.role_code in ('ADMIN', 'HR_OPERATOR', 'RECRUITER')
    and not exists (
      select 1
        from public.authz_user_group_members m_prev
       where m_prev.migrated_from_source = 'authz_account_role_assignments'
         and m_prev.migrated_from_id = ara.assignment_id
    )
  on conflict (group_id, app_user_id) where ended_at is null do nothing;

  -- 3.2 Backfill active Vendor Finance global module roles (exact 1:1 D4 mapping)
  insert into public.authz_user_group_members (
    group_id,
    app_user_id,
    source_kind,
    migrated_from_source,
    migrated_from_id,
    reason,
    started_at,
    assigned_by_app_user_id,
    is_protected,
    protected_reason
  )
  select
    case gr.role_code
      when 'GLOBAL_VIEWER' then v_grp_vfin_viewer
      when 'GLOBAL_RECONCILER' then v_grp_vfin_reconciler
      when 'CASH_HOLDER' then v_grp_vfin_cash
      when 'CASH_HOLDER_RECORD_BEHALF' then v_grp_vfin_behalf
    end as group_id,
    gr.app_user_id,
    'BACKFILL_MIGRATION',
    'vendor_finance_global_roles',
    gr.role_grant_id,
    'Chuyển tiếp tự động vai trò Tài chính NCC toàn công ty sang nhóm quyền',
    least(coalesce(gr.created_at, v_now), v_now),
    gr.granted_by_user_id,
    false,
    null
  from public.vendor_finance_global_roles gr
  where gr.valid_from <= v_today
    and (gr.valid_to is null or (gr.valid_to > gr.valid_from and gr.valid_to > v_today))
    and gr.role_code in ('GLOBAL_VIEWER', 'GLOBAL_RECONCILER', 'CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF')
    and not exists (
      select 1
        from public.authz_user_group_members m_prev
       where m_prev.migrated_from_source = 'vendor_finance_global_roles'
         and m_prev.migrated_from_id = gr.role_grant_id
    )
  on conflict (group_id, app_user_id) where ended_at is null do nothing;

  -- 3.3 Backfill active Leave module grants (exact 1:1 D4 mapping, zero escalation)
  insert into public.authz_user_group_members (
    group_id,
    app_user_id,
    source_kind,
    migrated_from_source,
    migrated_from_id,
    reason,
    started_at,
    assigned_by_app_user_id,
    is_protected,
    protected_reason
  )
  select
    case lmg.role_code
      when 'HR_LEAVE_OPERATOR' then v_grp_leave_hr
      when 'HR_REPORT_VIEWER' then v_grp_leave_viewer
      when 'LEAVE_ADMIN_BOD_APPROVER' then v_grp_leave_bod
    end as group_id,
    lmg.app_user_id,
    'BACKFILL_MIGRATION',
    'leave_module_grants',
    lmg.grant_id,
    'Chuyển tiếp tự động vai trò Nghỉ phép sang nhóm quyền',
    least(coalesce(lmg.created_at, v_now), v_now),
    lmg.updated_by_app_user_id,
    false,
    null
  from public.leave_module_grants lmg
  where lmg.is_current = true
    and lmg.valid_from <= v_today
    and (lmg.valid_to is null or (lmg.valid_to > lmg.valid_from and lmg.valid_to > v_today))
    and lmg.role_code in ('HR_LEAVE_OPERATOR', 'HR_REPORT_VIEWER', 'LEAVE_ADMIN_BOD_APPROVER')
    and not exists (
      select 1
        from public.authz_user_group_members m_prev
       where m_prev.migrated_from_source = 'leave_module_grants'
         and m_prev.migrated_from_id = lmg.grant_id
    )
  on conflict (group_id, app_user_id) where ended_at is null do nothing;

  -- 3.4 Backfill D1-mappable active direct capability grants (never auto-upgrades unmappable exceptions!)
  for v_dg in
    select dg.*
      from public.authz_direct_capability_grants dg
     where dg.ended_at is null
       and dg.started_at <= v_now
       and not exists (
         select 1
           from public.authz_legacy_direct_grant_migrations dm
          where dm.direct_grant_id = dg.direct_grant_id
       )
       and not exists (
         select 1
           from public.authz_user_group_members m_prev
          where m_prev.migrated_from_source = 'authz_direct_capability_grants'
            and m_prev.migrated_from_id = dg.direct_grant_id
       )
     order by dg.created_at asc, dg.direct_grant_id asc
  loop
    -- Skip if already satisfied by an active group membership of this user, recording permanent provenance
    v_covering_group_id := null;
    select g.group_id
      into v_covering_group_id
      from public.authz_user_group_members m
      join public.authz_user_groups g
        on g.group_id = m.group_id
       and g.active = true
      join public.organization_departments d
        on d.department_id = g.department_id
       and d.is_active = true
      left join public.teams t
        on t.team_id = g.team_id
       and t.active = true
       and t.code <> '__system_vendor__'
      join public.authz_user_group_capabilities gc
        on gc.group_id = g.group_id
       and gc.ended_at is null
       and gc.started_at <= v_now
       and gc.capability = v_dg.capability
     where m.app_user_id = v_dg.app_user_id
       and m.ended_at is null
       and m.started_at <= v_now
       and (g.team_id is null or t.team_id is not null)
       and (
         (v_dg.scope_kind = 'ALL' and v_dg.scope_id is null and g.team_id is null and (
           g.is_system_admin
           or (
             gc.capability not in (
               'entry_create', 'entry_own', 'submission_create', 'document_upload',
               'document_view', 'change_request_create', 'employment_status.request'
             )
           )
           or (
             gc.capability = 'document_view'
             and exists (
               select 1
                 from public.authz_user_group_capabilities gc2
                where gc2.group_id = g.group_id
                  and gc2.ended_at is null
                  and gc2.capability in ('recruiter_master_manage', 'team_master_manage', 'catalog_master_manage', 'audit_view')
             )
           )
         ))
         or (v_dg.scope_kind = 'OWN' and v_dg.scope_id is null and gc.capability in (
           'entry_create', 'entry_own', 'submission_create', 'document_upload',
           'document_view', 'change_request_create', 'employment_status.request'
         ))
         or (v_dg.scope_kind = 'CONTEXT_TEAM' and g.team_id is not null and g.team_id::text = v_dg.scope_id)
       )
     order by g.is_system_admin desc, g.group_id asc
     limit 1;

    if v_covering_group_id is not null then
      insert into public.authz_legacy_direct_grant_migrations (
        direct_grant_id, resolution_kind, group_id, recorded_at
      ) values (
        v_dg.direct_grant_id, 'COVERED_BY_GROUP', v_covering_group_id, v_now
      )
      on conflict (direct_grant_id) do nothing;
      continue;
    end if;

    v_target_group_id := null;
    v_cap_sanitized := pg_catalog.replace(pg_catalog.upper(v_dg.capability), '.', '_');

    if v_dg.capability = 'vendor_finance_view' and v_dg.scope_kind = 'ALL' and v_dg.scope_id is null then
      v_target_group_id := v_grp_acc;
    elsif v_dg.scope_kind = 'CONTEXT_TEAM'
          and v_dg.scope_id ~ '^[0-9a-fA-F-]{36}$'
          and v_dg.capability in (
            'entry_team', 'team_manager_assign', 'change_review',
            'report_view', 'report_analytics_view', 'report_assign',
            'report_review', 'report_delegate', 'worker_edit_history_view'
          ) then
      select t.* into v_team
        from public.teams t
       where t.team_id = v_dg.scope_id::uuid
         and t.active = true
         and t.code <> '__system_vendor__';
      if found then
        v_code := 'MIGRATED_TEAM_' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(v_team.team_id::text, '-', ''), 1, 8)) || '_' || v_cap_sanitized;
        v_name := pg_catalog.btrim(pg_catalog.left('Nhóm chuyển đổi ' || coalesce(v_team.display_name, v_team.code) || ' (' || v_dg.capability || ')', 128));
        insert into public.authz_user_groups (
          code, name, description, department_id, team_id, is_system_admin, active
        ) values (
          v_code, v_name, 'Nhóm quyền theo đội được chuyển đổi tự động từ quyền trực tiếp hiện hữu.',
          v_dept_rec, v_team.team_id, false, true
        )
        on conflict (code) do nothing;
        select group_id into v_target_group_id from public.authz_user_groups where code = v_code;
        insert into public.authz_user_group_capabilities (group_id, capability, reason)
        values (v_target_group_id, v_dg.capability, 'Chuyển đổi từ quyền trực tiếp theo đội')
        on conflict (group_id, capability) where ended_at is null do nothing;
      end if;
    elsif v_dg.scope_kind = 'OWN'
          and v_dg.scope_id is null
          and v_dg.capability in (
            'entry_create', 'entry_own', 'submission_create', 'document_upload',
            'document_view', 'change_request_create', 'employment_status.request'
          ) then
      v_code := 'MIGRATED_OWN_' || v_cap_sanitized;
      v_name := pg_catalog.left('Nhóm chuyển đổi cá nhân (' || v_dg.capability || ')', 128);
      insert into public.authz_user_groups (
        code, name, description, department_id, team_id, is_system_admin, active
      ) values (
        v_code, v_name, 'Nhóm quyền cá nhân được chuyển đổi tự động từ quyền trực tiếp hiện hữu.',
        v_dept_rec, null, false, true
      )
      on conflict (code) do nothing;
      select group_id into v_target_group_id from public.authz_user_groups where code = v_code;
      insert into public.authz_user_group_capabilities (group_id, capability, reason)
      values (v_target_group_id, v_dg.capability, 'Chuyển đổi từ quyền trực tiếp cá nhân')
      on conflict (group_id, capability) where ended_at is null do nothing;
    elsif v_dg.scope_kind = 'ALL'
          and v_dg.scope_id is null
          and v_dg.capability in (
            'recruiter_master_manage', 'team_master_manage', 'audit_view',
            'catalog_master_manage', 'report_form_manage', 'report_assign',
            'report_review', 'report_delegate', 'duplicate_cccd_withdraw',
            'worker_edit_history_view'
          ) then
      v_code := 'MIGRATED_DEPT_' || v_cap_sanitized;
      v_name := pg_catalog.left('Nhóm chuyển đổi phòng ban (' || v_dg.capability || ')', 128);
      insert into public.authz_user_groups (
        code, name, description, department_id, team_id, is_system_admin, active
      ) values (
        v_code, v_name, 'Nhóm quyền phòng ban được chuyển đổi tự động từ quyền trực tiếp hiện hữu.',
        v_dept_rec, null, false, true
      )
      on conflict (code) do nothing;
      select group_id into v_target_group_id from public.authz_user_groups where code = v_code;
      insert into public.authz_user_group_capabilities (group_id, capability, reason)
      values (v_target_group_id, v_dg.capability, 'Chuyển đổi từ quyền trực tiếp phòng ban')
      on conflict (group_id, capability) where ended_at is null do nothing;
    end if;

    if v_target_group_id is not null then
      insert into public.authz_user_group_members (
        group_id,
        app_user_id,
        source_kind,
        migrated_from_source,
        migrated_from_id,
        reason,
        started_at,
        assigned_by_app_user_id,
        is_protected,
        protected_reason
      ) values (
        v_target_group_id,
        v_dg.app_user_id,
        'BACKFILL_MIGRATION',
        'authz_direct_capability_grants',
        v_dg.direct_grant_id,
        'Chuyển tiếp tự động quyền trực tiếp hợp lệ sang nhóm quyền',
        least(v_dg.started_at, v_now),
        v_dg.granted_by_app_user_id,
        false,
        null
      )
      on conflict (group_id, app_user_id) where ended_at is null do nothing;

      insert into public.authz_legacy_direct_grant_migrations (
        direct_grant_id, resolution_kind, group_id, recorded_at
      ) values (
        v_dg.direct_grant_id, 'MIGRATED_TO_GROUP', v_target_group_id, v_now
      )
      on conflict (direct_grant_id) do nothing;
    end if;
  end loop;
end;
$function$;

revoke all on function public.direct_entry_authz__internal_backfill_legacy_to_groups()
  from public, anon, authenticated, service_role;

do $seed$
declare
  v_dept_bod uuid;
  v_dept_rec uuid;
  v_dept_acc uuid;
  v_grp_admin uuid;
  v_grp_hr uuid;
  v_grp_rec uuid;
  v_grp_acc uuid;
  v_grp_vfin_viewer uuid;
  v_grp_vfin_reconciler uuid;
  v_grp_vfin_cash uuid;
  v_grp_vfin_behalf uuid;
  v_grp_leave_hr uuid;
  v_grp_leave_viewer uuid;
  v_grp_leave_bod uuid;
begin
  select department_id into v_dept_bod
    from public.organization_departments
   where system_key = 'MANAGEMENT_BOD'
   limit 1;
  select department_id into v_dept_rec
    from public.organization_departments
   where system_key = 'RECRUITMENT'
   limit 1;
  select department_id into v_dept_acc
    from public.organization_departments
   where system_key = 'ACCOUNTING'
   limit 1;

  if v_dept_bod is null or v_dept_rec is null or v_dept_acc is null then
    raise exception 'PR28_SEED_MISSING_CANONICAL_DEPARTMENTS';
  end if;

  -- 1) SYSTEM_ADMIN ("BoD/Admin") bound to MANAGEMENT_BOD, exact 21 ADMIN caps
  insert into public.authz_user_groups (
    code, name, description, department_id, team_id, is_system_admin, active
  ) values (
    'SYSTEM_ADMIN',
    'BoD/Admin',
    'Nhóm quản trị hệ thống và điều hành hợp nhất (21 quyền quản trị chuẩn, bảo vệ tài khoản chủ hệ thống).',
    v_dept_bod,
    null,
    true,
    true
  )
  on conflict (code) do nothing;

  select group_id into v_grp_admin from public.authz_user_groups where code = 'SYSTEM_ADMIN';

  insert into public.authz_user_group_capabilities (group_id, capability, reason)
  select v_grp_admin, rc.capability, 'Khởi tạo 21 quyền chuẩn cho nhóm BoD/Admin'
    from public.authz_role_capabilities rc
   where rc.role_code = 'ADMIN'
  on conflict (group_id, capability) where ended_at is null do nothing;

  -- 2) HR_CATALOG_OPERATOR ("Vận hành Nhân sự & Danh mục") bound to RECRUITMENT, exact 5 HR_OPERATOR caps
  insert into public.authz_user_groups (
    code, name, description, department_id, team_id, is_system_admin, active
  ) values (
    'HR_CATALOG_OPERATOR',
    'Vận hành Nhân sự & Danh mục',
    'Quản trị danh mục tuyển dụng, tổ đội, nhân sự tuyển dụng, nhật ký kiểm toán và xem chứng từ.',
    v_dept_rec,
    null,
    false,
    true
  )
  on conflict (code) do nothing;

  select group_id into v_grp_hr from public.authz_user_groups where code = 'HR_CATALOG_OPERATOR';

  insert into public.authz_user_group_capabilities (group_id, capability, reason)
  select v_grp_hr, rc.capability, 'Khởi tạo quyền vận hành danh mục và nhân sự'
    from public.authz_role_capabilities rc
   where rc.role_code = 'HR_OPERATOR'
  on conflict (group_id, capability) where ended_at is null do nothing;

  -- 3) RECRUITER_OPERATIONS ("Nhân viên Tuyển dụng") bound to RECRUITMENT, exact 7 RECRUITER caps
  insert into public.authz_user_groups (
    code, name, description, department_id, team_id, is_system_admin, active
  ) values (
    'RECRUITER_OPERATIONS',
    'Nhân viên Tuyển dụng',
    'Nhập liệu hồ sơ tuyển dụng, nộp đợt nhập liệu và tải/xem chứng từ hồ sơ do mình phụ trách.',
    v_dept_rec,
    null,
    false,
    true
  )
  on conflict (code) do nothing;

  select group_id into v_grp_rec from public.authz_user_groups where code = 'RECRUITER_OPERATIONS';

  insert into public.authz_user_group_capabilities (group_id, capability, reason)
  select v_grp_rec, rc.capability, 'Khởi tạo quyền nghiệp vụ tuyển dụng cá nhân'
    from public.authz_role_capabilities rc
   where rc.role_code = 'RECRUITER'
  on conflict (group_id, capability) where ended_at is null do nothing;

  -- 4) ACCOUNTING_OPERATIONS ("Kế toán & Tài chính NCC") bound to ACCOUNTING, 1 cap (vendor_finance_view)
  insert into public.authz_user_groups (
    code, name, description, department_id, team_id, is_system_admin, active
  ) values (
    'ACCOUNTING_OPERATIONS',
    'Kế toán & Tài chính NCC',
    'Xem sổ công nợ và báo cáo tài chính nhà cung cấp.',
    v_dept_acc,
    null,
    false,
    true
  )
  on conflict (code) do nothing;

  select group_id into v_grp_acc from public.authz_user_groups where code = 'ACCOUNTING_OPERATIONS';

  insert into public.authz_user_group_capabilities (group_id, capability, reason)
  values
    (v_grp_acc, 'vendor_finance_view', 'Khởi tạo quyền xem Tài chính NCC')
  on conflict (group_id, capability) where ended_at is null do nothing;

  -- 5..8) Exact 1:1 D4 Vendor Finance Global Module Role groups (bound to ACCOUNTING)
  insert into public.authz_user_groups (
    code, name, description, department_id, team_id, is_system_admin, active
  ) values
    ('VFIN_GLOBAL_VIEWER', 'Xem Tài chính NCC toàn công ty', 'Xem công nợ, tạm ứng và báo cáo Tài chính NCC của toàn bộ dự án.', v_dept_acc, null, false, true),
    ('VFIN_GLOBAL_RECONCILER', 'Đối soát Tài chính NCC toàn công ty', 'Xem và đối soát công nợ, tạm ứng nhà cung cấp toàn công ty.', v_dept_acc, null, false, true),
    ('VFIN_CASH_HOLDER', 'Thủ quỹ Tài chính NCC', 'Xem, đối soát, cấp vốn tạm ứng và ghi nhận hoàn ứng Tài chính NCC toàn công ty.', v_dept_acc, null, false, true),
    ('VFIN_CASH_HOLDER_RECORD_BEHALF', 'Thủ quỹ & Ghi sổ thay Tài chính NCC', 'Thủ quỹ toàn công ty kèm quyền ghi sổ thanh toán thay kế toán dự án.', v_dept_acc, null, false, true)
  on conflict (code) do nothing;

  select group_id into v_grp_vfin_viewer from public.authz_user_groups where code = 'VFIN_GLOBAL_VIEWER';
  select group_id into v_grp_vfin_reconciler from public.authz_user_groups where code = 'VFIN_GLOBAL_RECONCILER';
  select group_id into v_grp_vfin_cash from public.authz_user_groups where code = 'VFIN_CASH_HOLDER';
  select group_id into v_grp_vfin_behalf from public.authz_user_groups where code = 'VFIN_CASH_HOLDER_RECORD_BEHALF';

  insert into public.authz_user_group_module_roles (group_id, module_code, role_code, reason)
  values
    (v_grp_vfin_viewer, 'vendor_finance', 'GLOBAL_VIEWER', 'Khởi tạo nhóm xem Tài chính NCC toàn công ty'),
    (v_grp_vfin_reconciler, 'vendor_finance', 'GLOBAL_RECONCILER', 'Khởi tạo nhóm đối soát Tài chính NCC toàn công ty'),
    (v_grp_vfin_cash, 'vendor_finance', 'CASH_HOLDER', 'Khởi tạo nhóm Thủ quỹ Tài chính NCC'),
    (v_grp_vfin_behalf, 'vendor_finance', 'CASH_HOLDER_RECORD_BEHALF', 'Khởi tạo nhóm Thủ quỹ ghi sổ thay Tài chính NCC')
  on conflict (group_id, module_code, role_code) where ended_at is null do nothing;

  -- 9..11) Exact 1:1 D4 Leave Module Role groups (zero escalation between viewer & operator!)
  insert into public.authz_user_groups (
    code, name, description, department_id, team_id, is_system_admin, active
  ) values
    ('LEAVE_HR_OPERATIONS', 'Quản trị Nghỉ phép HR', 'Cấu hình phép năm, quản trị số dư nghỉ phép và xem báo cáo nghỉ phép toàn công ty.', v_dept_rec, null, false, true),
    ('LEAVE_REPORT_VIEWER', 'Xem báo cáo Nghỉ phép HR', 'Chỉ xem báo cáo tổng hợp nghỉ phép hàng tháng toàn công ty.', v_dept_rec, null, false, true),
    ('LEAVE_BOD_APPROVER', 'Duyệt Nghỉ phép cấp Ban Giám đốc', 'Duyệt đơn nghỉ phép và giải trình chấm công cấp Ban Giám đốc.', v_dept_bod, null, false, true)
  on conflict (code) do nothing;

  select group_id into v_grp_leave_hr from public.authz_user_groups where code = 'LEAVE_HR_OPERATIONS';
  select group_id into v_grp_leave_viewer from public.authz_user_groups where code = 'LEAVE_REPORT_VIEWER';
  select group_id into v_grp_leave_bod from public.authz_user_groups where code = 'LEAVE_BOD_APPROVER';

  insert into public.authz_user_group_module_roles (group_id, module_code, role_code, reason)
  values
    (v_grp_leave_hr, 'leave', 'HR_LEAVE_OPERATOR', 'Khởi tạo quyền vận hành phép năm qua nhóm'),
    (v_grp_leave_viewer, 'leave', 'HR_REPORT_VIEWER', 'Khởi tạo quyền chỉ xem báo cáo nghỉ phép qua nhóm'),
    (v_grp_leave_bod, 'leave', 'LEAVE_ADMIN_BOD_APPROVER', 'Khởi tạo quyền duyệt nghỉ phép cấp Ban Giám đốc qua nhóm')
  on conflict (group_id, module_code, role_code) where ended_at is null do nothing;

  -- Run idempotent backfill for all pre-existing roles, module grants, and D1-mappable direct grants
  perform public.direct_entry_authz__internal_backfill_legacy_to_groups();
end;
$seed$;

-- -----------------------------------------------------------------------------
-- 4. Direct Group Authz SQL Primitives (Anti-Cartesian Per-Group Evaluation)
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_authz__internal_group_is_system_admin(
  p_app_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_app_users u
      join public.authz_user_group_members m
        on m.app_user_id = u.app_user_id
       and m.ended_at is null
       and m.started_at <= pg_catalog.clock_timestamp()
      join public.authz_user_groups g
        on g.group_id = m.group_id
       and g.active = true
       and g.is_system_admin = true
       and g.team_id is null
      join public.organization_departments d
        on d.department_id = g.department_id
       and d.is_active = true
       and d.system_key = 'MANAGEMENT_BOD'
     where u.app_user_id = p_app_user_id
       and u.enabled = true
       and exists (
         select 1
           from public.authz_user_group_capabilities c1
          where c1.group_id = g.group_id
            and c1.ended_at is null
            and c1.capability = 'entry_admin'
       )
       and exists (
         select 1
           from public.authz_user_group_capabilities c2
          where c2.group_id = g.group_id
            and c2.ended_at is null
            and c2.capability = 'recruiter_master_manage'
       )
       and exists (
         select 1
           from public.authz_user_group_capabilities c3
          where c3.group_id = g.group_id
            and c3.ended_at is null
            and c3.capability = 'team_master_manage'
       )
  );
$function$;

revoke all on function public.direct_entry_authz__internal_group_is_system_admin(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_authz__internal_group_has_capability(
  p_app_user_id uuid,
  p_capability text,
  p_department_id uuid default null,
  p_team_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_app_users u
      join public.authz_user_group_members m
        on m.app_user_id = u.app_user_id
       and m.ended_at is null
       and m.started_at <= pg_catalog.clock_timestamp()
      join public.authz_user_groups g
        on g.group_id = m.group_id
       and g.active = true
      join public.organization_departments d
        on d.department_id = g.department_id
       and d.is_active = true
      left join public.teams t
        on t.team_id = g.team_id
       and t.active = true
       and t.code <> '__system_vendor__'
      join public.authz_user_group_capabilities gc
        on gc.group_id = g.group_id
       and gc.ended_at is null
       and gc.started_at <= pg_catalog.clock_timestamp()
       and gc.capability = p_capability
     where u.app_user_id = p_app_user_id
       and u.enabled = true
       and (g.team_id is null or t.team_id is not null)
       and (
         (
           p_team_id is not null
           and (
             g.team_id = p_team_id
             or (g.is_system_admin = true and g.team_id is null)
           )
         )
         or (
           p_team_id is null
           and p_department_id is not null
           and (
             (g.department_id = p_department_id and g.team_id is null)
             or (g.is_system_admin = true and g.team_id is null)
           )
         )
         or (
           p_team_id is null
           and p_department_id is null
           and (
             g.team_id is null
             or gc.capability in (
               'entry_create',
               'entry_own',
               'submission_create',
               'document_upload',
               'document_view',
               'change_request_create',
               'employment_status.request'
             )
           )
         )
       )
  );
$function$;

revoke all on function public.direct_entry_authz__internal_group_has_capability(uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_authz__internal_group_team_ids(
  p_app_user_id uuid,
  p_capability text
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(
    array(
      select distinct g.team_id
        from public.direct_entry_app_users u
        join public.authz_user_group_members m
          on m.app_user_id = u.app_user_id
         and m.ended_at is null
         and m.started_at <= pg_catalog.clock_timestamp()
        join public.authz_user_groups g
          on g.group_id = m.group_id
         and g.active = true
         and g.team_id is not null
        join public.organization_departments d
          on d.department_id = g.department_id
         and d.is_active = true
        join public.teams t
          on t.team_id = g.team_id
         and t.active = true
         and t.code <> '__system_vendor__'
        join public.authz_user_group_capabilities gc
          on gc.group_id = g.group_id
         and gc.ended_at is null
         and gc.started_at <= pg_catalog.clock_timestamp()
         and gc.capability = p_capability
       where u.app_user_id = p_app_user_id
         and u.enabled = true
       order by g.team_id asc
    ),
    array[]::uuid[]
  );
$function$;

revoke all on function public.direct_entry_authz__internal_group_team_ids(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_authz__internal_group_has_module_role(
  p_app_user_id uuid,
  p_module_code text,
  p_role_code text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_app_users u
      join public.authz_user_group_members m
        on m.app_user_id = u.app_user_id
       and m.ended_at is null
       and m.started_at <= pg_catalog.clock_timestamp()
      join public.authz_user_groups g
        on g.group_id = m.group_id
       and g.active = true
       and g.team_id is null
       and g.is_system_admin = false
      join public.organization_departments d
        on d.department_id = g.department_id
       and d.is_active = true
      join public.authz_user_group_module_roles mr
        on mr.group_id = g.group_id
       and mr.ended_at is null
       and mr.started_at <= pg_catalog.clock_timestamp()
       and mr.module_code = p_module_code
       and mr.role_code = p_role_code
     where u.app_user_id = p_app_user_id
       and u.enabled = true
  );
$function$;

revoke all on function public.direct_entry_authz__internal_group_has_module_role(uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_authz__internal_group_vfin_global_role(
  p_app_user_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select mr.role_code
    from public.direct_entry_app_users u
    join public.authz_user_group_members m
      on m.app_user_id = u.app_user_id
     and m.ended_at is null
     and m.started_at <= pg_catalog.clock_timestamp()
    join public.authz_user_groups g
      on g.group_id = m.group_id
     and g.active = true
     and g.team_id is null
     and g.is_system_admin = false
    join public.organization_departments d
      on d.department_id = g.department_id
     and d.is_active = true
    join public.authz_user_group_module_roles mr
      on mr.group_id = g.group_id
     and mr.ended_at is null
     and mr.started_at <= pg_catalog.clock_timestamp()
     and mr.module_code = 'vendor_finance'
   where u.app_user_id = p_app_user_id
     and u.enabled = true
   order by case mr.role_code
     when 'CASH_HOLDER_RECORD_BEHALF' then 4
     when 'CASH_HOLDER' then 3
     when 'GLOBAL_RECONCILER' then 2
     when 'GLOBAL_VIEWER' then 1
     else 0
   end desc
   limit 1;
$function$;

revoke all on function public.direct_entry_authz__internal_group_vfin_global_role(uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Update Compatibility Projection, Legacy Mirror Sync & D4 Authority Readers
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_authz__internal_resolve_effective_grants(
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_has_active_person boolean := false;
  v_result jsonb := '[]'::jsonb;
begin
  if p_app_user_id is null then
    return '[]'::jsonb;
  end if;

  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  -- D10: disabled account ALWAYS resolves 0 effective grants, even if protected.
  if not found or not v_user.enabled then
    return '[]'::jsonb;
  end if;

  select exists (
    select 1
      from public.organization_account_person_links l
      join public.organization_persons p
        on p.person_id = l.person_id
       and p.status = 'ACTIVE'
     where l.app_user_id = p_app_user_id
       and l.ended_at is null
  ) into v_has_active_person;

  with
  group_bundle_grants as (
    -- Compatibility projection derived strictly per-group from authz_user_groups*.
    -- Anti-Cartesian: each capability stays bound to its own group's (is_system_admin, team_id).
    select
      gc.capability,
      case
        when g.is_system_admin then
          case when gc.capability = 'entry_own' then 'OWN'::text else 'ALL'::text end
        when g.team_id is not null then
          case
            when gc.capability in (
              'entry_create',
              'entry_own',
              'submission_create',
              'document_upload',
              'document_view',
              'change_request_create',
              'employment_status.request'
            ) then 'OWN'::text
            else 'CONTEXT_TEAM'::text
          end
        else
          case
            when gc.capability in (
              'entry_create',
              'entry_own',
              'submission_create',
              'document_upload',
              'change_request_create',
              'employment_status.request'
            ) then 'OWN'::text
            when gc.capability = 'document_view' then
              case
                when exists (
                  select 1
                    from public.authz_user_group_capabilities gc2
                   where gc2.group_id = g.group_id
                     and gc2.ended_at is null
                     and gc2.started_at <= v_now
                     and gc2.capability in (
                       'recruiter_master_manage',
                       'team_master_manage',
                       'catalog_master_manage',
                       'audit_view'
                     )
                ) then 'ALL'::text
                else 'OWN'::text
              end
            else 'ALL'::text
          end
      end as scope_kind,
      case
        when g.team_id is not null
             and gc.capability not in (
               'entry_create',
               'entry_own',
               'submission_create',
               'document_upload',
               'document_view',
               'change_request_create',
               'employment_status.request'
             ) then g.team_id::text
        else null::text
      end as scope_id,
      case
        when g.team_id is not null
             and gc.capability not in (
               'entry_create',
               'entry_own',
               'submission_create',
               'document_upload',
               'document_view',
               'change_request_create',
               'employment_status.request'
             ) then 'CONTEXTUAL_ASSIGNMENT'::text
        else 'ROLE_BUNDLE'::text
      end as source_type,
      m.membership_id::text as source_id,
      case
        when g.team_id is not null
             and gc.capability not in (
               'entry_create',
               'entry_own',
               'submission_create',
               'document_upload',
               'document_view',
               'change_request_create',
               'employment_status.request'
             ) then coalesce(t.display_name, t.code)
        when g.is_system_admin then
          case when gc.capability = 'entry_own' then 'OWN'::text else 'ALL'::text end
        when gc.capability in (
          'entry_create',
          'entry_own',
          'submission_create',
          'document_upload',
          'change_request_create',
          'employment_status.request'
        ) then 'OWN'::text
        when gc.capability = 'document_view' then
          case
            when exists (
              select 1
                from public.authz_user_group_capabilities gc2
               where gc2.group_id = g.group_id
                 and gc2.ended_at is null
                 and gc2.started_at <= v_now
                 and gc2.capability in (
                   'recruiter_master_manage',
                   'team_master_manage',
                   'catalog_master_manage',
                   'audit_view'
                 )
            ) then 'ALL'::text
            else 'OWN'::text
          end
        else 'ALL'::text
      end as scope_label
    from public.authz_user_group_members m
    join public.authz_user_groups g
      on g.group_id = m.group_id
     and g.active = true
    join public.organization_departments d
      on d.department_id = g.department_id
     and d.is_active = true
    left join public.teams t
      on t.team_id = g.team_id
     and t.active = true
     and t.code <> '__system_vendor__'
    join public.authz_user_group_capabilities gc
      on gc.group_id = g.group_id
     and gc.ended_at is null
     and gc.started_at <= v_now
    where m.app_user_id = p_app_user_id
      and m.ended_at is null
      and m.started_at <= v_now
      and (g.team_id is null or t.team_id is not null)
  ),
  role_bundle_grants as (
    select
      rc.capability,
      rc.scope_template as scope_kind,
      null::text as scope_id,
      'ROLE_BUNDLE'::text as source_type,
      ara.assignment_id::text as source_id,
      rc.scope_template as scope_label
    from public.authz_account_role_assignments ara
    join public.authz_role_definitions rd
      on rd.role_code = ara.role_code
    join public.authz_role_capabilities rc
      on rc.role_code = ara.role_code
    where ara.app_user_id = p_app_user_id
      and ara.ended_at is null
      and ara.started_at <= v_now
      and (not rd.requires_active_person or coalesce(v_has_active_person, false))
      -- Deduplicate against group_bundle_grants when same capability+scope already comes from a group
      and not exists (
        select 1
          from group_bundle_grants gg
         where gg.capability = rc.capability
           and gg.scope_kind = rc.scope_template
           and gg.scope_id is null
      )
  ),
  direct_grant_items as (
    select
      g.capability,
      g.scope_kind,
      g.scope_id,
      'DIRECT_GRANT'::text as source_type,
      g.direct_grant_id::text as source_id,
      case
        when g.scope_kind in ('OWN', 'ALL') then g.scope_kind
        when g.scope_kind = 'CONTEXT_TEAM' then coalesce(tm.display_name, tm.code, g.scope_id)
        when g.scope_kind = 'CONTEXT_PROJECT' then coalesce(pr.display_name, g.scope_id)
        when g.scope_kind = 'CONTEXT_DEPARTMENT' then coalesce(dm.name, dm.code, g.scope_id)
        else g.scope_kind
      end as scope_label
    from public.authz_direct_capability_grants g
    left join public.teams tm
      on g.scope_kind = 'CONTEXT_TEAM'
     and tm.team_id::text = g.scope_id
    left join public.direct_entry_projects pr
      on g.scope_kind = 'CONTEXT_PROJECT'
     and pr.project_id = g.scope_id
    left join public.organization_departments dm
      on g.scope_kind = 'CONTEXT_DEPARTMENT'
     and dm.department_id::text = g.scope_id
    where g.app_user_id = p_app_user_id
      and g.ended_at is null
      and g.started_at <= v_now
      and (
        g.scope_kind in ('OWN', 'ALL')
        or (g.scope_kind = 'CONTEXT_TEAM' and tm.team_id is not null and tm.active)
        or (g.scope_kind = 'CONTEXT_PROJECT' and pr.project_id is not null and pr.active)
        or (g.scope_kind = 'CONTEXT_DEPARTMENT' and dm.department_id is not null and dm.is_active)
      )
  ),
  contextual_tl_grants as (
    select
      rc.capability,
      'CONTEXT_TEAM'::text as scope_kind,
      t.team_id::text as scope_id,
      'CONTEXTUAL_ASSIGNMENT'::text as source_type,
      tla.assignment_id::text as source_id,
      coalesce(t.display_name, t.code) as scope_label
    from public.direct_entry_team_leader_assignments tla
    join public.teams t
      on t.team_id = tla.team_id
     and t.active
     and t.code <> '__system_vendor__'
    join public.authz_role_capabilities rc
      on rc.role_code = 'TEAM_LEADER'
    where tla.leader_app_user_id = p_app_user_id
      and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
  ),
  contextual_tl_wr_review_grants as (
    select
      'report_review'::text as capability,
      'CONTEXT_TEAM'::text as scope_kind,
      t.team_id::text as scope_id,
      'CONTEXTUAL_ASSIGNMENT'::text as source_type,
      tla.assignment_id::text as source_id,
      coalesce(t.display_name, t.code) as scope_label
    from public.direct_entry_team_leader_assignments tla
    join public.teams t
      on t.team_id = tla.team_id
     and t.active
     and t.code <> '__system_vendor__'
    where v_user.authz_managed
      and v_user.account_type = 'NORMAL'
      and tla.leader_app_user_id = p_app_user_id
      and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
  ),
  contextual_pa_grants as (
    select
      rc.capability,
      'CONTEXT_PROJECT'::text as scope_kind,
      pa.project_id as scope_id,
      'CONTEXTUAL_ASSIGNMENT'::text as source_type,
      pa.assignment_id::text as source_id,
      coalesce(pr.display_name, pa.project_id) as scope_label
    from public.vendor_finance_project_accountants pa
    join public.direct_entry_projects pr
      on pr.project_id = pa.project_id
     and pr.active
    join public.authz_role_capabilities rc
      on rc.role_code = 'PROJECT_ACCOUNTANT'
    where pa.accountant_user_id = p_app_user_id
      and pa.ended_at is null
      and pa.valid_from <= v_today
      and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
  ),
  tl_wr_compat_bridge as (
    select
      'report_review'::text as capability,
      'CONTEXT_TEAM'::text as scope_kind,
      t.team_id::text as scope_id,
      'LEGACY_BRIDGE'::text as source_type,
      cg.grant_id::text as source_id,
      coalesce(t.display_name, t.code) as scope_label
    from public.work_report_team_leader_capability_grants x
    join public.direct_entry_team_leader_assignments tla
      on tla.assignment_id = x.leader_assignment_id
    join public.teams t
      on t.team_id = tla.team_id
     and t.active
     and t.code <> '__system_vendor__'
    join public.direct_entry_capability_grants cg
      on cg.grant_id = x.capability_grant_id
   where not v_user.authz_managed
     and tla.leader_app_user_id = p_app_user_id
     and x.capability = 'report_review'
     and cg.app_user_id = p_app_user_id
     and cg.capability = 'report_review'
     and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
     and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
  ),
  legacy_bridge_candidates as (
    select
      cg.capability,
      'ALL'::text as scope_kind,
      null::text as scope_id,
      'LEGACY_BRIDGE'::text as source_type,
      cg.grant_id::text as source_id,
      'ALL'::text as scope_label
    from public.direct_entry_capability_grants cg
    where not v_user.authz_managed
      and cg.app_user_id = p_app_user_id
      and cg.capability <> 'entry_own'
      and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
      and exists (
        select 1
          from public.direct_entry_scope_grants sg
         where sg.app_user_id = p_app_user_id
           and sg.scope_kind = 'all'
           and sg.is_current
           and not sg.suspended_by_account_disable
      )
    union all
    select
      cg.capability,
      'OWN'::text as scope_kind,
      null::text as scope_id,
      'LEGACY_BRIDGE'::text as source_type,
      cg.grant_id::text as source_id,
      'OWN'::text as scope_label
    from public.direct_entry_capability_grants cg
    where not v_user.authz_managed
      and cg.app_user_id = p_app_user_id
      and cg.capability in (
        'entry_own', 'entry_create', 'submission_create', 'document_upload',
        'document_view', 'change_request_create', 'employment_status.request'
      )
      and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
      and exists (
        select 1
          from public.direct_entry_scope_grants sg
         where sg.app_user_id = p_app_user_id
           and sg.scope_kind = 'own'
           and sg.is_current
           and not sg.suspended_by_account_disable
      )
    union all
    select
      cg.capability,
      'CONTEXT_TEAM'::text as scope_kind,
      t.team_id::text as scope_id,
      'LEGACY_BRIDGE'::text as source_type,
      cg.grant_id::text as source_id,
      coalesce(t.display_name, t.code) as scope_label
    from public.direct_entry_capability_grants cg
    join public.direct_entry_scope_grants sg
      on sg.app_user_id = cg.app_user_id
     and sg.scope_kind = 'team'
    join public.teams t
      on t.team_id = sg.team_id
     and t.active
     and t.code <> '__system_vendor__'
    where not v_user.authz_managed
      and cg.app_user_id = p_app_user_id
      and cg.capability in (
        'entry_team', 'team_manager_assign', 'change_review',
        'report_view', 'report_analytics_view', 'report_assign', 'report_review', 'report_delegate'
      )
      and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
      and public.direct_entry__internal_team_scope_grant_effective(sg.grant_id, v_today)
  ),
  canonical_items as (
    select * from group_bundle_grants
    union all
    select * from role_bundle_grants
    union all
    select * from direct_grant_items
    union all
    select * from contextual_tl_grants
    union all
    select * from contextual_tl_wr_review_grants
    union all
    select * from contextual_pa_grants
  ),
  combined_legacy_and_compat as (
    select lb.* from legacy_bridge_candidates lb
    union all
    select tw.*
      from tl_wr_compat_bridge tw
     where not exists (
       select 1
         from legacy_bridge_candidates lb2
        where lb2.capability = tw.capability
          and lb2.scope_kind = tw.scope_kind
          and lb2.scope_id is not distinct from tw.scope_id
     )
  ),
  all_grants as (
    select * from canonical_items
    union all
    select lb.*
      from combined_legacy_and_compat lb
     where not exists (
       select 1
         from canonical_items ci
        where ci.capability = lb.capability
          and ci.scope_kind = lb.scope_kind
          and ci.scope_id is not distinct from lb.scope_id
     )
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'capability', g.capability,
        'scope_kind', g.scope_kind,
        'scope_id', g.scope_id,
        'source_type', g.source_type,
        'source_id', g.source_id,
        'scope_label', g.scope_label
      )
      order by g.capability, g.scope_kind, g.scope_id nulls first, g.source_type, g.source_id
    ),
    '[]'::jsonb
  )
    into v_result
    from all_grants g;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

revoke all on function public.direct_entry_authz__internal_resolve_effective_grants(uuid)
  from public, anon, authenticated, service_role;

-- Update legacy mirror sync so group memberships project accurately to legacy mirrors
-- without ever leaking team-group capabilities into legacy 'all' scope.
create or replace function public.direct_entry_authz__internal_sync_legacy_grants(
  p_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_has_active_person boolean := false;
  v_desired_caps text[];
  v_desired_scopes text[];
  v_cap text;
  v_scope text;
  v_next_start date;
  v_lock_key text;
  v_prev_marker text := pg_catalog.current_setting('direct_entry.team_leader_marker', true);
begin
  if p_app_user_id is null then
    return;
  end if;

  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for update;

  if not found or not v_user.authz_managed then
    return;
  end if;

  select exists (
    select 1
      from public.organization_account_person_links l
      join public.organization_persons p
        on p.person_id = l.person_id
       and p.status = 'ACTIVE'
     where l.app_user_id = p_app_user_id
       and l.ended_at is null
  ) into v_has_active_person;

  with tl_open_caps as (
    select g.capability
      from public.work_report_team_leader_capability_grants x
      join public.direct_entry_team_leader_assignments tla
        on tla.assignment_id = x.leader_assignment_id
       and tla.leader_app_user_id = p_app_user_id
       and (tla.valid_to is null or tla.valid_to > v_today)
      join public.direct_entry_capability_grants g
        on g.grant_id = x.capability_grant_id
    union
    select 'team_manager_assign'::text as capability
     where exists (
       select 1
         from public.direct_entry_team_leader_assignments tla
        where tla.leader_app_user_id = p_app_user_id
          and (tla.valid_to is null or tla.valid_to > v_today)
          and (tla.is_current or tla.suspended_by_account_disable)
     )
    union
    select rc.capability
      from public.direct_entry_team_leader_assignments tla
      join public.authz_role_capabilities rc
        on rc.role_code = 'TEAM_LEADER'
     where tla.leader_app_user_id = p_app_user_id
       and (tla.valid_to is null or tla.valid_to > v_today)
       and (tla.is_current or tla.suspended_by_account_disable)
  ),
  group_active_caps as (
    select
      gc.capability,
      g.is_system_admin,
      g.team_id,
      g.group_id
    from public.authz_user_group_members m
    join public.authz_user_groups g
      on g.group_id = m.group_id
     and g.active = true
    join public.organization_departments d
      on d.department_id = g.department_id
     and d.is_active = true
    left join public.teams t
      on t.team_id = g.team_id
     and t.active = true
     and t.code <> '__system_vendor__'
    join public.authz_user_group_capabilities gc
      on gc.group_id = g.group_id
     and gc.ended_at is null
     and gc.started_at <= v_now
    where m.app_user_id = p_app_user_id
      and m.ended_at is null
      and m.started_at <= v_now
      and (g.team_id is null or t.team_id is not null)
  ),
  desired_cap_set as (
    select gac.capability from group_active_caps gac
    union
    select rc.capability
      from public.authz_account_role_assignments ara
      join public.authz_role_definitions rd
        on rd.role_code = ara.role_code
      join public.authz_role_capabilities rc
        on rc.role_code = ara.role_code
     where ara.app_user_id = p_app_user_id
       and ara.ended_at is null
       and ara.started_at <= v_now
       and (not rd.requires_active_person or coalesce(v_has_active_person, false))
    union
    select dg.capability
      from public.authz_direct_capability_grants dg
     where dg.app_user_id = p_app_user_id
       and dg.ended_at is null
       and dg.started_at <= v_now
    union
    select tc.capability from tl_open_caps tc
  ),
  desired_scope_set as (
    select case
      when gac.is_system_admin then
        case when gac.capability = 'entry_own' then 'own' else 'all' end
      when gac.team_id is not null then
        case
          when gac.capability in (
            'entry_create',
            'entry_own',
            'submission_create',
            'document_upload',
            'document_view',
            'change_request_create',
            'employment_status.request'
          ) then 'own'
          else null
        end
      else
        case
          when gac.capability in (
            'entry_create',
            'entry_own',
            'submission_create',
            'document_upload',
            'change_request_create',
            'employment_status.request'
          ) then 'own'
          when gac.capability = 'document_view' then
            case
              when exists (
                select 1
                  from public.authz_user_group_capabilities gc2
                 where gc2.group_id = gac.group_id
                   and gc2.ended_at is null
                   and gc2.started_at <= v_now
                   and gc2.capability in (
                     'recruiter_master_manage',
                     'team_master_manage',
                     'catalog_master_manage',
                     'audit_view'
                   )
              ) then 'all'
              else 'own'
            end
          else 'all'
        end
    end as scope_kind
    from group_active_caps gac
    union
    select case
      when rc.scope_template = 'ALL' then 'all'
      when rc.scope_template = 'OWN' then 'own'
    end as scope_kind
      from public.authz_account_role_assignments ara
      join public.authz_role_definitions rd
        on rd.role_code = ara.role_code
      join public.authz_role_capabilities rc
        on rc.role_code = ara.role_code
     where ara.app_user_id = p_app_user_id
       and ara.ended_at is null
       and ara.started_at <= v_now
       and (not rd.requires_active_person or coalesce(v_has_active_person, false))
       and rc.scope_template in ('OWN', 'ALL')
    union
    select case
      when dg.scope_kind = 'ALL' then 'all'
      when dg.scope_kind = 'OWN' then 'own'
    end as scope_kind
      from public.authz_direct_capability_grants dg
     where dg.app_user_id = p_app_user_id
       and dg.ended_at is null
       and dg.started_at <= v_now
       and dg.scope_kind in ('OWN', 'ALL')
  )
  select
    coalesce(array(select capability from desired_cap_set where capability is not null order by 1), array[]::text[]),
    coalesce(array(select scope_kind from desired_scope_set where scope_kind is not null order by 1), array[]::text[])
    into v_desired_caps, v_desired_scopes;

  perform pg_catalog.set_config('direct_entry.team_leader_marker', 'on', true);

  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_app_user_id
     and s.scope_kind in ('own', 'all')
   order by s.grant_id asc
   for update;

  for v_lock_key in
    select distinct k
      from unnest(array[
        'scope:' || p_app_user_id::text || ':all:' || p_app_user_id::text,
        'scope:' || p_app_user_id::text || ':own:' || p_app_user_id::text
      ]) as t(k)
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_app_user_id
   order by g.grant_id asc
   for update;

  for v_lock_key in
    select distinct 'capability:' || p_app_user_id::text || ':' || cap as k
      from (
        select unnest(coalesce(v_desired_caps, array[]::text[])) as cap
        union
        select g.capability as cap
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_app_user_id
      ) caps
     where cap is not null
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  update public.direct_entry_scope_grants s
     set valid_to = greatest(v_today, s.valid_from),
         is_current = false,
         suspended_by_account_disable = false
   where s.app_user_id = p_app_user_id
     and s.scope_kind in ('own', 'all')
     and (s.is_current or s.valid_to is null or s.valid_to > v_today)
     and s.valid_from <= v_today
     and not (s.scope_kind = any(v_desired_scopes));

  update public.direct_entry_capability_grants g
     set valid_to = greatest(v_today, g.valid_from),
         is_current = false,
         suspended_by_account_disable = false
   where g.app_user_id = p_app_user_id
     and (g.is_current or g.valid_to is null or g.valid_to > v_today)
     and g.valid_from <= v_today
     and not (g.capability = any(v_desired_caps));

  if v_user.enabled then
    foreach v_scope in array v_desired_scopes loop
      if not exists (
        select 1 from public.direct_entry_scope_grants s
         where s.app_user_id = p_app_user_id
           and s.scope_kind = v_scope
           and s.is_current
      ) then
        update public.direct_entry_scope_grants s
           set is_current = true,
               suspended_by_account_disable = false
         where s.grant_id = (
           select s2.grant_id
             from public.direct_entry_scope_grants s2
            where s2.app_user_id = p_app_user_id
              and s2.scope_kind = v_scope
              and s2.valid_from <= v_today
              and (s2.valid_to is null or (s2.valid_to > s2.valid_from and v_today < s2.valid_to))
            order by s2.valid_from desc, s2.grant_id desc
            limit 1
         );

        if not found then
          select min(s.valid_from)
            into v_next_start
            from public.direct_entry_scope_grants s
           where s.app_user_id = p_app_user_id
             and s.scope_kind = v_scope
             and s.valid_from > v_today
             and (s.valid_to is null or s.valid_to > s.valid_from);

          insert into public.direct_entry_scope_grants (
            app_user_id, scope_kind, team_id, valid_from, valid_to, is_current, suspended_by_account_disable
          ) values (
            p_app_user_id, v_scope, null, v_today, v_next_start, true, false
          )
          on conflict do nothing;
        end if;
      end if;
    end loop;

    foreach v_cap in array v_desired_caps loop
      if not exists (
        select 1 from public.direct_entry_capability_grants g
         where g.app_user_id = p_app_user_id
           and g.capability = v_cap
           and g.is_current
      ) then
        update public.direct_entry_capability_grants g
           set is_current = true,
               suspended_by_account_disable = false
         where g.grant_id = (
           select g2.grant_id
             from public.direct_entry_capability_grants g2
            where g2.app_user_id = p_app_user_id
              and g2.capability = v_cap
              and g2.valid_from <= v_today
              and (g2.valid_to is null or (g2.valid_to > g2.valid_from and v_today < g2.valid_to))
            order by g2.valid_from desc, g2.grant_id desc
            limit 1
         );

        if not found then
          select min(g.valid_from)
            into v_next_start
            from public.direct_entry_capability_grants g
           where g.app_user_id = p_app_user_id
             and g.capability = v_cap
             and g.valid_from > v_today
             and (g.valid_to is null or g.valid_to > g.valid_from);

          insert into public.direct_entry_capability_grants (
            app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable
          ) values (
            p_app_user_id, v_cap, v_today, v_next_start, true, false
          )
          on conflict do nothing;
        end if;
      end if;
    end loop;
  end if;

  perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
exception
  when others then
    perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
    raise;
end;
$function$;

revoke all on function public.direct_entry_authz__internal_sync_legacy_grants(uuid)
  from public, anon, authenticated, service_role;

-- D4 Read-Time Union in Vendor Finance Authority (direct role lattice UNION group module roles)
create or replace function public.vendor_finance__internal_resolve_authority(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_account_type text := 'NORMAL';
  v_full_admin boolean := false;
  v_direct_record boolean := false;
  v_direct_view boolean := false;
  v_accounting_member boolean := false;
  v_direct_global_role text := null;
  v_group_global_role text := null;
  v_global_role text := null;
  v_visibility_scope text := 'NONE';
  v_record_scope text := 'NONE';
  v_reconcile_scope text := 'NONE';
  v_authority_source text := 'none';
  v_assigned_project_count integer := 0;
  v_can_view_shared_advance boolean := false;
  v_can_fund_vendor_advance boolean := false;
  v_can_record_vendor_refund boolean := false;
  v_can_apply_vendor_advance boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  select coalesce(u.account_type, 'NORMAL')
    into v_account_type
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if v_account_type <> 'SHARED' then
    v_full_admin := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);

    v_direct_record := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'vendor_finance_record', 'ALL', null);
    v_direct_view := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'vendor_finance_view', 'ALL', null);
  end if;

  if v_account_type = 'NORMAL' then
    v_accounting_member := public.org_department__internal_has_active_membership(
      p_app_user_id,
      'ACCOUNTING',
      v_today
    );

    select gr.role_code
      into v_direct_global_role
      from public.vendor_finance_global_roles gr
     where gr.app_user_id = p_app_user_id
       and gr.valid_from <= v_today
       and (gr.valid_to is null or gr.valid_to > v_today)
       and (gr.valid_to is null or gr.valid_to > gr.valid_from)
     order by gr.valid_from desc, gr.version desc
     limit 1;

    -- D4: read-time union with group-managed vendor_finance module roles (exact lattice order)
    v_group_global_role := public.direct_entry_authz__internal_group_vfin_global_role(p_app_user_id);

    select role_code
      into v_global_role
      from (
        values (v_direct_global_role), (v_group_global_role)
      ) as cand(role_code)
     where role_code is not null
     order by case role_code
       when 'CASH_HOLDER_RECORD_BEHALF' then 4
       when 'CASH_HOLDER' then 3
       when 'GLOBAL_RECONCILER' then 2
       when 'GLOBAL_VIEWER' then 1
       else 0
     end desc
     limit 1;
  end if;

  if v_accounting_member then
    select count(*)::integer
      into v_assigned_project_count
      from public.vendor_finance_project_accountants pa
      join public.direct_entry_projects p
        on p.project_id = pa.project_id
       and p.active = true
     where pa.accountant_user_id = p_app_user_id
       and pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from);
  end if;

  if v_full_admin or v_direct_record or v_direct_view or v_global_role is not null then
    v_visibility_scope := 'ALL';
  elsif v_accounting_member then
    v_visibility_scope := 'PROJECT_SCOPED';
  else
    v_visibility_scope := 'NONE';
  end if;

  if v_full_admin or v_direct_record or v_global_role = 'CASH_HOLDER_RECORD_BEHALF' then
    v_record_scope := 'ALL';
  elsif v_accounting_member then
    v_record_scope := 'ASSIGNED_PROJECTS';
  else
    v_record_scope := 'NONE';
  end if;

  if v_full_admin
     or v_direct_record
     or v_global_role in ('CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF', 'GLOBAL_RECONCILER') then
    v_reconcile_scope := 'ALL';
  elsif v_accounting_member then
    v_reconcile_scope := 'ASSIGNED_PROJECTS';
  else
    v_reconcile_scope := 'NONE';
  end if;

  if v_full_admin then
    v_authority_source := 'full_admin';
  elsif v_global_role = 'CASH_HOLDER_RECORD_BEHALF' then
    v_authority_source := 'cash_holder_record_behalf';
  elsif v_direct_record then
    v_authority_source := 'direct_grant_record';
  elsif v_global_role = 'CASH_HOLDER' then
    v_authority_source := 'cash_holder';
  elsif v_global_role = 'GLOBAL_RECONCILER' then
    v_authority_source := 'global_reconciler';
  elsif v_global_role = 'GLOBAL_VIEWER' or v_direct_view then
    v_authority_source := 'direct_grant_view';
  elsif v_accounting_member then
    v_authority_source := 'accounting_department';
  else
    v_authority_source := 'none';
  end if;

  v_can_view_shared_advance := coalesce(
    v_visibility_scope = 'ALL'
    or (v_visibility_scope = 'PROJECT_SCOPED' and v_assigned_project_count > 0),
    false
  );

  v_can_fund_vendor_advance := coalesce(
    v_full_admin
    or v_direct_record
    or v_global_role in ('CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF'),
    false
  );
  v_can_record_vendor_refund := v_can_fund_vendor_advance;

  v_can_apply_vendor_advance := coalesce(
    v_record_scope = 'ALL'
    or (v_record_scope = 'ASSIGNED_PROJECTS' and v_assigned_project_count > 0),
    false
  );

  return pg_catalog.jsonb_build_object(
    'allowed', (v_visibility_scope <> 'NONE'),
    'authority_source', v_authority_source,
    'visibility_scope', v_visibility_scope,
    'record_scope', v_record_scope,
    'reconcile_scope', v_reconcile_scope,
    'global_role_code', v_global_role,
    'can_view', (v_visibility_scope <> 'NONE'),
    'can_record', (v_record_scope <> 'NONE'),
    'can_reconcile', (v_reconcile_scope <> 'NONE'),
    'can_manage_project_assignments', v_full_admin,
    'can_view_shared_advance', v_can_view_shared_advance,
    'can_fund_vendor_advance', v_can_fund_vendor_advance,
    'can_record_vendor_refund', v_can_record_vendor_refund,
    'can_apply_vendor_advance', v_can_apply_vendor_advance,
    'active_assigned_project_count', v_assigned_project_count,
    'authorization_date', v_today::text
  );
end;
$function$;

revoke all on function public.vendor_finance__internal_resolve_authority(uuid, uuid)
  from public, anon, authenticated, service_role;

-- D4 Read-Time Union in Leave Management Authority (direct grants OR group module roles)
create or replace function public.leave_management__internal_resolve_authority(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.leave_management__internal_business_date();
  v_is_shared boolean := false;
  v_is_full_admin boolean := false;
  v_is_bod boolean := false;
  v_is_admin_bod_grant boolean := false;
  v_is_hr_operator boolean := false;
  v_is_hr_report_viewer boolean := false;
  v_is_team_leader boolean := false;
  v_is_dept_head boolean := false;
  v_is_compat_dept_approver boolean := false;
  v_is_dept_approver boolean := false;
  v_has_pending_snapshot_approval boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'Direct entry actor mapping is not active'
      using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_is_shared := public.attendance__internal_is_non_employee_account(p_app_user_id, v_now);

  if not v_is_shared then
    v_is_full_admin := (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null)
    );

    v_is_bod := (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
      or (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_analytics_view', 'ALL', null)
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_view', 'ALL', null)
      )
    );

    select (
             exists (
               select 1
                 from public.leave_module_grants g
                where g.app_user_id = p_app_user_id
                  and g.role_code = 'LEAVE_ADMIN_BOD_APPROVER'
                  and g.is_current = true
                  and g.valid_from <= v_today
                  and (g.valid_to is null or v_today < g.valid_to)
             )
             or public.direct_entry_authz__internal_group_has_module_role(
               p_app_user_id, 'leave', 'LEAVE_ADMIN_BOD_APPROVER'
             )
           ),
           (
             exists (
               select 1
                 from public.leave_module_grants g
                where g.app_user_id = p_app_user_id
                  and g.role_code = 'HR_LEAVE_OPERATOR'
                  and g.is_current = true
                  and g.valid_from <= v_today
                  and (g.valid_to is null or v_today < g.valid_to)
             )
             or public.direct_entry_authz__internal_group_has_module_role(
               p_app_user_id, 'leave', 'HR_LEAVE_OPERATOR'
             )
           ),
           (
             exists (
               select 1
                 from public.leave_module_grants g
                where g.app_user_id = p_app_user_id
                  and g.role_code = 'HR_REPORT_VIEWER'
                  and g.is_current = true
                  and g.valid_from <= v_today
                  and (g.valid_to is null or v_today < g.valid_to)
             )
             or public.direct_entry_authz__internal_group_has_module_role(
               p_app_user_id, 'leave', 'HR_REPORT_VIEWER'
             )
           )
      into v_is_admin_bod_grant, v_is_hr_operator, v_is_hr_report_viewer;

    select exists (
             select 1
               from public.direct_entry_team_leader_assignments tla
              where tla.leader_app_user_id = p_app_user_id
                and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
           )
      into v_is_team_leader;

    select exists (
             select 1
               from public.organization_department_heads dh
               join public.organization_departments d
                 on d.department_id = dh.department_id
                and d.is_active = true
              where dh.started_at <= v_now
                and (dh.ended_at is null or (dh.ended_at > dh.started_at and v_now < dh.ended_at))
                and public.leave_management__internal_resolve_department_head_user(dh.department_id, v_now) = p_app_user_id
           )
      into v_is_dept_head;

    select exists (
             select 1
               from public.leave_department_approvers da
              where da.approver_app_user_id = p_app_user_id
                and da.valid_from <= v_today
                and (da.valid_to is null or v_today < da.valid_to)
                and (da.valid_to is null or da.valid_to > da.valid_from)
                and not exists (
                  select 1
                    from public.organization_departments d
                   where d.system_key = da.unit_kind
                     and d.is_active = true
                     and public.leave_management__internal_has_open_department_head(d.department_id, v_now)
                )
           )
      into v_is_compat_dept_approver;

    v_is_dept_approver := (v_is_dept_head or v_is_compat_dept_approver);

    select (
             exists (
               select 1
                 from public.leave_requests lr
                where lr.status = 'PENDING'
                  and lr.primary_approver_app_user_id = p_app_user_id
                  and lr.app_user_id <> p_app_user_id
             )
             or exists (
               select 1
                 from public.attendance_explanations ae
                where ae.status = 'PENDING'
                  and ae.primary_approver_app_user_id = p_app_user_id
                  and ae.app_user_id <> p_app_user_id
             )
           )
      into v_has_pending_snapshot_approval;
  end if;

  return pg_catalog.jsonb_build_object(
    'app_user_id', p_app_user_id,
    'is_shared_non_employee', v_is_shared,
    'is_full_admin', v_is_full_admin,
    'is_bod', (v_is_bod or v_is_admin_bod_grant),
    'is_hr_operator', v_is_hr_operator,
    'is_hr_report_viewer', v_is_hr_report_viewer,
    'is_team_leader', v_is_team_leader,
    'is_department_approver', v_is_dept_approver,
    'can_submit_request', (not v_is_shared),
    'can_approve_requests', (
      not v_is_shared
      and (
        v_is_full_admin
        or v_is_bod
        or v_is_admin_bod_grant
        or v_is_team_leader
        or v_is_dept_approver
        or v_has_pending_snapshot_approval
      )
    ),
    'can_view_monthly_report', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_hr_operator or v_is_hr_report_viewer)),
    'can_manage_config', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_hr_operator))
  );
end;
$function$;

revoke all on function public.leave_management__internal_resolve_authority(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.leave_management__internal_resolve_authority(uuid, uuid)
  to direct_entry_catalog_bootstrap_executor;

-- -----------------------------------------------------------------------------
-- 6. Exact 6 Public Admin RPCs for Permission Group Management (service_role only)
-- -----------------------------------------------------------------------------

-- 6.1 direct_entry_authz_list_groups_admin
create or replace function public.direct_entry_authz_list_groups_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_department_id uuid default null,
  p_include_inactive boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_groups jsonb := '[]'::jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'group_id', g.group_id,
        'code', g.code,
        'name', g.name,
        'description', g.description,
        'department_id', g.department_id,
        'department_code', d.code,
        'department_name', d.name,
        'department_system_key', d.system_key,
        'team_id', g.team_id,
        'team_code', t.code,
        'team_name', coalesce(t.display_name, t.code),
        'is_system_admin', g.is_system_admin,
        'active', g.active,
        'version', g.version,
        'capabilities', coalesce((
          select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
            from public.authz_user_group_capabilities gc
           where gc.group_id = g.group_id
             and gc.ended_at is null
             and gc.started_at <= v_now
        ), '[]'::jsonb),
        'module_roles', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'module_code', mr.module_code,
              'role_code', mr.role_code
            )
            order by mr.module_code asc, mr.role_code asc
          )
            from public.authz_user_group_module_roles mr
           where mr.group_id = g.group_id
             and mr.ended_at is null
             and mr.started_at <= v_now
        ), '[]'::jsonb),
        'member_count', (
          select pg_catalog.count(*)::integer
            from public.authz_user_group_members m
           where m.group_id = g.group_id
             and m.ended_at is null
             and m.started_at <= v_now
        ),
        'member_account_refs', coalesce((
          select pg_catalog.jsonb_agg(m.app_user_id order by m.app_user_id asc)
            from public.authz_user_group_members m
           where m.group_id = g.group_id
             and m.ended_at is null
             and m.started_at <= v_now
        ), '[]'::jsonb),
        'updated_at', public.org_department__internal_iso_utc(g.updated_at)
      )
      order by g.is_system_admin desc, lower(d.name) asc, lower(g.name) asc, g.group_id asc
    ),
    '[]'::jsonb
  )
    into v_groups
    from public.authz_user_groups g
    join public.organization_departments d
      on d.department_id = g.department_id
    left join public.teams t
      on t.team_id = g.team_id
   where (coalesce(p_include_inactive, false) or g.active = true)
     and (p_department_id is null or g.department_id = p_department_id);

  return pg_catalog.jsonb_build_object(
    'as_of', public.org_department__internal_iso_utc(v_now),
    'groups', v_groups
  );
end;
$function$;

revoke all on function public.direct_entry_authz_list_groups_admin(uuid, uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_list_groups_admin(uuid, uuid, uuid, boolean)
  to service_role;

-- 6.2 direct_entry_authz_create_group_admin
create or replace function public.direct_entry_authz_create_group_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_code text,
  p_name text,
  p_description text,
  p_department_id uuid,
  p_team_id uuid,
  p_capabilities text[],
  p_module_roles jsonb,
  p_reason text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_op text := 'AUTHZ_GROUP_CREATED';
  v_code text := upper(nullif(pg_catalog.btrim(p_code), ''));
  v_name text := nullif(pg_catalog.btrim(p_name), '');
  v_desc text := coalesce(pg_catalog.btrim(p_description), '');
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_dept public.organization_departments%rowtype;
  v_team public.teams%rowtype;
  v_existing_idem public.authz_group_idempotency%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_group public.authz_user_groups%rowtype;
  v_cap text;
  v_mr jsonb;
  v_mr_module text;
  v_mr_role text;
  v_result jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  if v_code is null or v_code !~ '^[A-Z][A-Z0-9_]{1,63}$' or v_code = 'SYSTEM_ADMIN' then
    raise exception 'GROUP_CODE_INVALID' using errcode = '22023';
  end if;
  if v_name is null or pg_catalog.length(v_name) not between 2 and 128 then
    raise exception 'GROUP_NAME_INVALID' using errcode = '22023';
  end if;
  if pg_catalog.length(v_desc) > 500 then
    raise exception 'GROUP_DESCRIPTION_INVALID' using errcode = '22023';
  end if;
  if p_department_id is null then
    raise exception 'GROUP_DEPARTMENT_REQUIRED' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;
  if p_module_roles is not null and pg_catalog.jsonb_typeof(p_module_roles) <> 'array' then
    raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
  end if;

  -- Lock actor + idempotency slot
  perform 1
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id
   for update;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select i.* into v_existing_idem
    from public.authz_group_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = v_op
     and i.target_key = 'group_code:' || v_code
     and i.idempotency_key = p_idempotency_key::text
   for update;

  if found then
    if v_existing_idem.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id
     and d.is_active = true;
  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = '22023';
  end if;

  if p_team_id is not null then
    select t.* into v_team
      from public.teams t
     where t.team_id = p_team_id
       and t.active = true
       and t.code <> '__system_vendor__';
    if not found then
      raise exception 'TEAM_NOT_FOUND' using errcode = '22023';
    end if;
  end if;

  if exists (select 1 from public.authz_user_groups g where g.code = v_code) then
    raise exception 'GROUP_CODE_CONFLICT' using errcode = 'PT409';
  end if;

  insert into public.authz_user_groups (
    code, name, description, department_id, team_id, is_system_admin, active,
    version, created_by_app_user_id, updated_by_app_user_id, created_at, updated_at
  ) values (
    v_code, v_name, v_desc, p_department_id, p_team_id, false, true,
    1, p_actor_app_user_id, p_actor_app_user_id, v_now, v_now
  ) returning * into v_group;

  if p_capabilities is not null then
    for v_cap in
      select distinct nullif(pg_catalog.btrim(x), '')
        from unnest(p_capabilities) as x
       where nullif(pg_catalog.btrim(x), '') is not null
       order by 1 asc
    loop
      insert into public.authz_user_group_capabilities (
        group_id, capability, started_at, granted_by_app_user_id, reason, created_at
      ) values (
        v_group.group_id, v_cap, v_now, p_actor_app_user_id, v_reason, v_now
      );
    end loop;
  end if;

  if p_module_roles is not null then
    for v_mr in
      select value from pg_catalog.jsonb_array_elements(p_module_roles)
    loop
      if pg_catalog.jsonb_typeof(v_mr) <> 'object' then
        raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
      end if;
      v_mr_module := nullif(pg_catalog.btrim(v_mr->>'module_code'), '');
      v_mr_role := nullif(pg_catalog.btrim(v_mr->>'role_code'), '');
      if v_mr_module is null or v_mr_role is null then
        raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
      end if;
      insert into public.authz_user_group_module_roles (
        group_id, module_code, role_code, started_at, granted_by_app_user_id, reason, created_at
      ) values (
        v_group.group_id, v_mr_module, v_mr_role, v_now, p_actor_app_user_id, v_reason, v_now
      )
      on conflict (group_id, module_code, role_code) where ended_at is null do nothing;
    end loop;
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'group_id', v_group.group_id,
    'code', v_group.code,
    'name', v_group.name,
    'description', v_group.description,
    'department_id', v_group.department_id,
    'team_id', v_group.team_id,
    'is_system_admin', v_group.is_system_admin,
    'active', v_group.active,
    'version', v_group.version,
    'capabilities', coalesce((
      select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
        from public.authz_user_group_capabilities gc
       where gc.group_id = v_group.group_id and gc.ended_at is null
    ), '[]'::jsonb),
    'module_roles', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('module_code', mr.module_code, 'role_code', mr.role_code)
        order by mr.module_code asc, mr.role_code asc
      )
        from public.authz_user_group_module_roles mr
       where mr.group_id = v_group.group_id and mr.ended_at is null
    ), '[]'::jsonb),
    'replayed', false
  );

  insert into public.authz_group_audit_events (
    actor_auth_subject, actor_app_user_id, group_id, operation_name,
    before_payload, after_payload, reason, created_at
  ) values (
    p_auth_subject, p_actor_app_user_id, v_group.group_id, v_op,
    null, v_result, v_reason, v_now
  );

  insert into public.authz_group_idempotency (
    actor_app_user_id, operation_name, target_key, idempotency_key,
    request_hash, response_payload, created_at
  ) values (
    p_actor_app_user_id, v_op, 'group_code:' || v_code, p_idempotency_key::text,
    p_request_hash, v_result, v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_authz_create_group_admin(uuid, uuid, text, text, text, uuid, uuid, text[], jsonb, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_create_group_admin(uuid, uuid, text, text, text, uuid, uuid, text[], jsonb, text, uuid, text)
  to service_role;

-- 6.3 direct_entry_authz_update_group_admin
create or replace function public.direct_entry_authz_update_group_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_group_id uuid,
  p_expected_version integer,
  p_name text,
  p_description text,
  p_department_id uuid,
  p_team_id uuid,
  p_active boolean,
  p_capabilities text[],
  p_module_roles jsonb,
  p_reason text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_op text := 'AUTHZ_GROUP_UPDATED';
  v_name text := nullif(pg_catalog.btrim(p_name), '');
  v_desc text := coalesce(pg_catalog.btrim(p_description), '');
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_existing_idem public.authz_group_idempotency%rowtype;
  v_group public.authz_user_groups%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_before jsonb;
  v_new_caps text[];
  v_cap text;
  v_mr jsonb;
  v_mr_module text;
  v_mr_role text;
  v_mr_pairs text[] := array[]::text[];
  v_member_id uuid;
  v_result jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  if p_group_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or p_department_id is null
     or p_active is null
     or p_idempotency_key is null
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_name is null or pg_catalog.length(v_name) not between 2 and 128 then
    raise exception 'GROUP_NAME_INVALID' using errcode = '22023';
  end if;
  if pg_catalog.length(v_desc) > 500 then
    raise exception 'GROUP_DESCRIPTION_INVALID' using errcode = '22023';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;
  if p_module_roles is not null and pg_catalog.jsonb_typeof(p_module_roles) <> 'array' then
    raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
  end if;

  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = p_group_id
   for update;

  if not found then
    raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Lock actor and all active group members in deterministic ascending UUID order
  for v_member_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id = p_actor_app_user_id
        or u.app_user_id in (
          select m.app_user_id
            from public.authz_user_group_members m
           where m.group_id = p_group_id
             and m.ended_at is null
        )
     order by u.app_user_id asc
     for update
  loop
    null;
  end loop;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select i.* into v_existing_idem
    from public.authz_group_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = v_op
     and i.target_key = 'group:' || p_group_id::text
     and i.idempotency_key = p_idempotency_key::text
   for update;

  if found then
    if v_existing_idem.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_group.version <> p_expected_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_version', v_group.version)::text;
  end if;

  if v_group.is_system_admin then
    raise exception 'GROUP_SYSTEM_ADMIN_IMMUTABLE' using errcode = 'PT409';
  end if;

  if not exists (
    select 1 from public.organization_departments d
     where d.department_id = p_department_id and d.is_active = true
  ) then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = '22023';
  end if;

  if p_team_id is not null and not exists (
    select 1 from public.teams t
     where t.team_id = p_team_id and t.active = true and t.code <> '__system_vendor__'
  ) then
    raise exception 'TEAM_NOT_FOUND' using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'group_id', v_group.group_id,
    'name', v_group.name,
    'description', v_group.description,
    'department_id', v_group.department_id,
    'team_id', v_group.team_id,
    'active', v_group.active,
    'version', v_group.version,
    'capabilities', coalesce((
      select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id and gc.ended_at is null
    ), '[]'::jsonb),
    'module_roles', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('module_code', mr.module_code, 'role_code', mr.role_code)
        order by mr.module_code asc, mr.role_code asc
      )
        from public.authz_user_group_module_roles mr
       where mr.group_id = p_group_id and mr.ended_at is null
    ), '[]'::jsonb)
  );

  update public.authz_user_groups g
     set name = v_name,
         description = v_desc,
         department_id = p_department_id,
         team_id = p_team_id,
         active = p_active,
         version = g.version + 1,
         updated_by_app_user_id = p_actor_app_user_id,
         updated_at = v_now
   where g.group_id = p_group_id
  returning * into v_group;

  v_new_caps := coalesce(
    array(
      select distinct nullif(pg_catalog.btrim(x), '')
        from unnest(coalesce(p_capabilities, array[]::text[])) as x
       where nullif(pg_catalog.btrim(x), '') is not null
       order by 1 asc
    ),
    array[]::text[]
  );

  -- Close removed capabilities
  update public.authz_user_group_capabilities gc
     set ended_at = v_now,
         ended_by_app_user_id = p_actor_app_user_id
   where gc.group_id = p_group_id
     and gc.ended_at is null
     and not (gc.capability = any(v_new_caps));

  -- Insert added capabilities (guard trigger enforces exact capability ceiling!)
  foreach v_cap in array v_new_caps loop
    insert into public.authz_user_group_capabilities (
      group_id, capability, started_at, granted_by_app_user_id, reason, created_at
    ) values (
      p_group_id, v_cap, v_now, p_actor_app_user_id, v_reason, v_now
    )
    on conflict (group_id, capability) where ended_at is null do nothing;
  end loop;

  -- Revalidate any pre-existing open capabilities if team_id changed between NULL and non-NULL
  if p_team_id is not null then
    if exists (
      select 1
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id
         and gc.ended_at is null
         and gc.capability not in (
           'entry_team', 'team_manager_assign', 'change_review',
           'report_view', 'report_analytics_view', 'report_assign',
           'report_review', 'report_delegate', 'worker_edit_history_view',
           'entry_create', 'entry_own', 'submission_create',
           'document_upload', 'document_view', 'change_request_create',
           'employment_status.request'
         )
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP' using errcode = '22023';
    end if;
  else
    if exists (
      select 1
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id
         and gc.ended_at is null
         and gc.capability in (
           'entry_admin', 'entry_team', 'entry_restore', 'entry_privileged_edit',
           'change_review', 'employment_status.review', 'employment_status.apply',
           'team_manager_assign', 'report_view', 'report_analytics_view', 'vendor_finance_record'
         )
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP' using errcode = '22023';
    end if;
  end if;

  -- Sync module_roles
  if p_module_roles is not null then
    for v_mr in
      select value from pg_catalog.jsonb_array_elements(p_module_roles)
    loop
      if pg_catalog.jsonb_typeof(v_mr) <> 'object' then
        raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
      end if;
      v_mr_module := nullif(pg_catalog.btrim(v_mr->>'module_code'), '');
      v_mr_role := nullif(pg_catalog.btrim(v_mr->>'role_code'), '');
      if v_mr_module is null or v_mr_role is null then
        raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
      end if;
      v_mr_pairs := array_append(v_mr_pairs, v_mr_module || ':' || v_mr_role);
    end loop;
  end if;

  update public.authz_user_group_module_roles mr
     set ended_at = v_now,
         ended_by_app_user_id = p_actor_app_user_id
   where mr.group_id = p_group_id
     and mr.ended_at is null
     and not ((mr.module_code || ':' || mr.role_code) = any(v_mr_pairs));

  if p_module_roles is not null then
    for v_mr in
      select value from pg_catalog.jsonb_array_elements(p_module_roles)
    loop
      v_mr_module := nullif(pg_catalog.btrim(v_mr->>'module_code'), '');
      v_mr_role := nullif(pg_catalog.btrim(v_mr->>'role_code'), '');
      insert into public.authz_user_group_module_roles (
        group_id, module_code, role_code, started_at, granted_by_app_user_id, reason, created_at
      ) values (
        p_group_id, v_mr_module, v_mr_role, v_now, p_actor_app_user_id, v_reason, v_now
      )
      on conflict (group_id, module_code, role_code) where ended_at is null do nothing;
    end loop;
  end if;

  if p_team_id is not null and exists (
    select 1
      from public.authz_user_group_module_roles mr
     where mr.group_id = p_group_id and mr.ended_at is null
  ) then
    raise exception 'GROUP_MODULE_ROLE_FORBIDDEN_FOR_TEAM_GROUP' using errcode = '22023';
  end if;

  -- Sync legacy mirrors for all active members of this group
  for v_member_id in
    select m.app_user_id
      from public.authz_user_group_members m
     where m.group_id = p_group_id
       and m.ended_at is null
     order by m.app_user_id asc
  loop
    perform public.direct_entry_authz__internal_sync_legacy_grants(v_member_id);
  end loop;

  v_result := pg_catalog.jsonb_build_object(
    'group_id', v_group.group_id,
    'code', v_group.code,
    'name', v_group.name,
    'description', v_group.description,
    'department_id', v_group.department_id,
    'team_id', v_group.team_id,
    'is_system_admin', v_group.is_system_admin,
    'active', v_group.active,
    'version', v_group.version,
    'capabilities', coalesce((
      select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id and gc.ended_at is null
    ), '[]'::jsonb),
    'module_roles', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('module_code', mr.module_code, 'role_code', mr.role_code)
        order by mr.module_code asc, mr.role_code asc
      )
        from public.authz_user_group_module_roles mr
       where mr.group_id = p_group_id and mr.ended_at is null
    ), '[]'::jsonb),
    'replayed', false
  );

  insert into public.authz_group_audit_events (
    actor_auth_subject, actor_app_user_id, group_id, operation_name,
    before_payload, after_payload, reason, created_at
  ) values (
    p_auth_subject, p_actor_app_user_id, p_group_id, v_op,
    v_before, v_result, v_reason, v_now
  );

  insert into public.authz_group_idempotency (
    actor_app_user_id, operation_name, target_key, idempotency_key,
    request_hash, response_payload, created_at
  ) values (
    p_actor_app_user_id, v_op, 'group:' || p_group_id::text, p_idempotency_key::text,
    p_request_hash, v_result, v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_authz_update_group_admin(uuid, uuid, uuid, integer, text, text, uuid, uuid, boolean, text[], jsonb, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_update_group_admin(uuid, uuid, uuid, integer, text, text, uuid, uuid, boolean, text[], jsonb, text, uuid, text)
  to service_role;

-- 6.4 direct_entry_authz_assign_group_member_admin
create or replace function public.direct_entry_authz_assign_group_member_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_group_id uuid,
  p_expected_account_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_op text := 'AUTHZ_GROUP_MEMBER_ASSIGNED';
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_locked_id uuid;
  v_group public.authz_user_groups%rowtype;
  v_target public.direct_entry_app_users%rowtype;
  v_existing_idem public.authz_group_idempotency%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_inserted public.authz_user_group_members%rowtype;
  v_new_version integer;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null then
    raise exception 'AUTHZ_FORBIDDEN' using errcode = '42501';
  end if;
  if p_target_app_user_id is null
     or p_group_id is null
     or p_expected_account_version is null
     or p_expected_account_version < 1
     or p_idempotency_key is null
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;

  -- Authorize Full Admin BEFORE locking or reading target group/account (prevents existence/lock oracle)
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  -- Lock group then actor/target in deterministic ascending UUID order
  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = p_group_id
   for share;

  if not found then
    raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not v_group.active then
    raise exception 'GROUP_INACTIVE' using errcode = 'PT409';
  end if;

  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id asc
     for update
  loop
    null;
  end loop;

  -- Re-verify Full Admin under row lock
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotency check BEFORE OCC so retries succeed after version bump
  select i.* into v_existing_idem
    from public.authz_group_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = v_op
     and i.target_key = p_target_app_user_id::text || ':' || p_group_id::text
     and i.idempotency_key = p_idempotency_key::text
   for update;

  if found then
    if v_existing_idem.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_target.version <> p_expected_account_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_version', v_target.version)::text;
  end if;

  if not v_target.enabled then
    raise exception 'ACCOUNT_DISABLED' using errcode = 'PT409';
  end if;

  -- Guard uncutover legacy accounts: never silently wipe unmigrated direct_entry_capability_grants
  if not coalesce(v_target.authz_managed, false)
     and exists (
       select 1
         from public.direct_entry_capability_grants g
        where g.app_user_id = p_target_app_user_id
          and g.is_current = true
     ) then
    raise exception 'AUTHZ_CUTOVER_NOT_READY' using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from public.authz_user_group_members m
     where m.group_id = p_group_id
       and m.app_user_id = p_target_app_user_id
       and m.ended_at is null
  ) then
    raise exception 'GROUP_MEMBER_ALREADY_ASSIGNED' using errcode = 'PT409';
  end if;

  insert into public.authz_user_group_members (
    group_id,
    app_user_id,
    source_kind,
    reason,
    started_at,
    assigned_by_app_user_id,
    is_protected,
    protected_reason,
    created_at
  ) values (
    p_group_id,
    p_target_app_user_id,
    'ADMIN_ASSIGNMENT',
    v_reason,
    v_now,
    p_actor_app_user_id,
    false,
    null,
    v_now
  ) returning * into v_inserted;

  update public.direct_entry_app_users u
     set authz_managed = true,
         version = u.version + 1,
         updated_at = v_now
   where u.app_user_id = p_target_app_user_id
  returning u.version into v_new_version;

  perform public.direct_entry_authz__internal_sync_legacy_grants(p_target_app_user_id);

  v_result := pg_catalog.jsonb_build_object(
    'membership_id', v_inserted.membership_id,
    'group_id', v_group.group_id,
    'group_code', v_group.code,
    'group_name', v_group.name,
    'account_ref', p_target_app_user_id,
    'account_version', v_new_version,
    'is_protected', v_inserted.is_protected,
    'started_at', public.org_department__internal_iso_utc(v_inserted.started_at),
    'replayed', false
  );

  insert into public.authz_group_audit_events (
    actor_auth_subject, actor_app_user_id, group_id, target_app_user_id,
    membership_id, operation_name, before_payload, after_payload, reason, created_at
  ) values (
    p_auth_subject, p_actor_app_user_id, p_group_id, p_target_app_user_id,
    v_inserted.membership_id, v_op,
    pg_catalog.jsonb_build_object('account_version', v_target.version),
    v_result, v_reason, v_now
  );

  insert into public.authz_group_idempotency (
    actor_app_user_id, operation_name, target_key, idempotency_key,
    request_hash, response_payload, created_at
  ) values (
    p_actor_app_user_id, v_op,
    p_target_app_user_id::text || ':' || p_group_id::text,
    p_idempotency_key::text, p_request_hash, v_result, v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_authz_assign_group_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_assign_group_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  to service_role;

-- 6.5 direct_entry_authz_remove_group_member_admin
create or replace function public.direct_entry_authz_remove_group_member_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_membership_id uuid,
  p_expected_account_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_op text := 'AUTHZ_GROUP_MEMBER_REMOVED';
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_locked_id uuid;
  v_target public.direct_entry_app_users%rowtype;
  v_membership public.authz_user_group_members%rowtype;
  v_group public.authz_user_groups%rowtype;
  v_existing_idem public.authz_group_idempotency%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_new_version integer;
  v_mapped_legacy_role text := null;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null then
    raise exception 'AUTHZ_FORBIDDEN' using errcode = '42501';
  end if;
  if p_target_app_user_id is null
     or p_membership_id is null
     or p_expected_account_version is null
     or p_expected_account_version < 1
     or p_idempotency_key is null
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;

  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id asc
     for update
  loop
    null;
  end loop;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select i.* into v_existing_idem
    from public.authz_group_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = v_op
     and i.target_key = p_target_app_user_id::text || ':' || p_membership_id::text
     and i.idempotency_key = p_idempotency_key::text
   for update;

  if found then
    if v_existing_idem.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select m.* into v_membership
    from public.authz_user_group_members m
   where m.membership_id = p_membership_id
     and m.app_user_id = p_target_app_user_id
   for update;

  if not found then
    raise exception 'GROUP_MEMBERSHIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Owner DB protection checked BEFORE version bump or any write (matches Owner 14/11 decision)
  if v_membership.is_protected then
    raise exception 'AUTHZ_PROTECTED_ASSIGNMENT' using errcode = 'PT409';
  end if;

  if v_membership.ended_at is not null then
    raise exception 'GROUP_MEMBERSHIP_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  if v_target.version <> p_expected_account_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_version', v_target.version)::text;
  end if;

  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = v_membership.group_id;

  update public.authz_user_group_members m
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_actor_app_user_id
   where m.membership_id = p_membership_id;

  -- If this group maps to a backfilled legacy role assignment, also close the matching
  -- non-protected open legacy role assignment so revocation takes immediate effect,
  -- while NEVER touching protected Owner rows or independent resource assignments!
  v_mapped_legacy_role := case v_group.code
    when 'SYSTEM_ADMIN' then 'ADMIN'
    when 'HR_CATALOG_OPERATOR' then 'HR_OPERATOR'
    when 'RECRUITER_OPERATIONS' then 'RECRUITER'
    else null
  end;

  if v_mapped_legacy_role is not null then
    if exists (
      select 1
        from public.authz_account_role_assignments ara
       where ara.app_user_id = p_target_app_user_id
         and ara.role_code = v_mapped_legacy_role
         and ara.ended_at is null
         and ara.is_protected = true
    ) then
      raise exception 'AUTHZ_PROTECTED_ASSIGNMENT' using errcode = 'PT409';
    end if;

    update public.authz_account_role_assignments ara
       set ended_at = v_now,
           ended_reason = coalesce(v_reason, 'Gỡ thành viên khỏi nhóm quyền tương ứng'),
           ended_by_app_user_id = p_actor_app_user_id
     where ara.app_user_id = p_target_app_user_id
       and ara.role_code = v_mapped_legacy_role
       and ara.ended_at is null
       and ara.is_protected = false;
  end if;

  update public.direct_entry_app_users u
     set authz_managed = true,
         version = u.version + 1,
         updated_at = v_now
   where u.app_user_id = p_target_app_user_id
  returning u.version into v_new_version;

  perform public.direct_entry_authz__internal_sync_legacy_grants(p_target_app_user_id);

  v_result := pg_catalog.jsonb_build_object(
    'membership_id', p_membership_id,
    'group_id', v_group.group_id,
    'group_code', v_group.code,
    'group_name', v_group.name,
    'account_ref', p_target_app_user_id,
    'account_version', v_new_version,
    'ended_at', public.org_department__internal_iso_utc(v_now),
    'replayed', false
  );

  insert into public.authz_group_audit_events (
    actor_auth_subject, actor_app_user_id, group_id, target_app_user_id,
    membership_id, operation_name, before_payload, after_payload, reason, created_at
  ) values (
    p_auth_subject, p_actor_app_user_id, v_group.group_id, p_target_app_user_id,
    p_membership_id, v_op,
    pg_catalog.jsonb_build_object(
      'account_version', v_target.version,
      'group_id', v_group.group_id,
      'group_code', v_group.code
    ),
    v_result, v_reason, v_now
  );

  insert into public.authz_group_idempotency (
    actor_app_user_id, operation_name, target_key, idempotency_key,
    request_hash, response_payload, created_at
  ) values (
    p_actor_app_user_id, v_op,
    p_target_app_user_id::text || ':' || p_membership_id::text,
    p_idempotency_key::text, p_request_hash, v_result, v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_authz_remove_group_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_remove_group_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  to service_role;

-- 6.6 direct_entry_authz_get_account_groups_admin
create or replace function public.direct_entry_authz_get_account_groups_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_target public.direct_entry_app_users%rowtype;
  v_memberships jsonb := '[]'::jsonb;
  v_resource_assignments jsonb := '[]'::jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  if p_target_app_user_id is null then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;

  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'membership_id', m.membership_id,
        'group_id', g.group_id,
        'group_code', g.code,
        'group_name', g.name,
        'group_description', g.description,
        'department_id', g.department_id,
        'department_name', d.name,
        'team_id', g.team_id,
        'team_name', coalesce(t.display_name, t.code),
        'is_system_admin', g.is_system_admin,
        'group_active', g.active,
        'is_protected', m.is_protected,
        'can_remove', (not m.is_protected),
        'cannot_remove_reason', m.protected_reason,
        'started_at', public.org_department__internal_iso_utc(m.started_at),
        'capabilities', coalesce((
          select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
            from public.authz_user_group_capabilities gc
           where gc.group_id = g.group_id and gc.ended_at is null and gc.started_at <= v_now
        ), '[]'::jsonb),
        'module_roles', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object('module_code', mr.module_code, 'role_code', mr.role_code)
            order by mr.module_code asc, mr.role_code asc
          )
            from public.authz_user_group_module_roles mr
           where mr.group_id = g.group_id and mr.ended_at is null and mr.started_at <= v_now
        ), '[]'::jsonb)
      )
      order by g.is_system_admin desc, lower(d.name) asc, lower(g.name) asc, m.membership_id asc
    ),
    '[]'::jsonb
  )
    into v_memberships
    from public.authz_user_group_members m
    join public.authz_user_groups g
      on g.group_id = m.group_id
    join public.organization_departments d
      on d.department_id = g.department_id
    left join public.teams t
      on t.team_id = g.team_id
   where m.app_user_id = p_target_app_user_id
     and m.ended_at is null;

  -- Business resource assignments (shown for clarity on user detail, managed on their resources)
  with raw_resources as (
    select
      'TEAM_LEADER'::text as assignment_kind,
      t.team_id::text as resource_ref,
      coalesce(t.display_name, t.code) as resource_label
    from public.direct_entry_team_leader_assignments tla
    join public.teams t
      on t.team_id = tla.team_id
     and t.active = true
     and t.code <> '__system_vendor__'
    where tla.leader_app_user_id = p_target_app_user_id
      and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
    union all
    select
      'PROJECT_MANAGER'::text as assignment_kind,
      p.project_id as resource_ref,
      coalesce(p.display_name, p.project_id) as resource_label
    from public.direct_entry_project_manager_assignments pma
    join public.direct_entry_projects p
      on p.project_id = pma.project_id
     and p.active = true
    join public.recruiters r
      on r.recruiter_id = pma.manager_recruiter_id
     and r.active = true
    join public.direct_entry_app_user_recruiter_links rl
      on rl.recruiter_id = pma.manager_recruiter_id
     and rl.app_user_id = p_target_app_user_id
     and rl.verified = true
     and rl.valid_from <= v_today
     and (rl.valid_to is null or (rl.valid_to > rl.valid_from and v_today < rl.valid_to))
     and (rl.is_current = true or rl.suspended_by_account_disable = true)
    where pma.revoked_at is null
      and pma.valid_from <= v_today
      and (pma.valid_to is null or (pma.valid_to > pma.valid_from and v_today < pma.valid_to))
    union all
    select
      'PROJECT_ACCOUNTANT'::text as assignment_kind,
      p.project_id as resource_ref,
      coalesce(p.display_name, p.project_id) as resource_label
    from public.vendor_finance_project_accountants pa
    join public.direct_entry_projects p
      on p.project_id = pa.project_id
     and p.active = true
    where pa.accountant_user_id = p_target_app_user_id
      and pa.ended_at is null
      and pa.valid_from <= v_today
      and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
    union all
    select
      'DEPARTMENT_HEAD'::text as assignment_kind,
      d.department_id::text as resource_ref,
      d.name as resource_label
    from public.organization_department_heads dh
    join public.organization_departments d
      on d.department_id = dh.department_id
     and d.is_active = true
    join public.organization_account_person_links l
      on l.person_id = dh.person_id
     and l.app_user_id = p_target_app_user_id
     and l.ended_at is null
    where dh.started_at <= v_now
      and (dh.ended_at is null or (dh.ended_at > dh.started_at and v_now < dh.ended_at))
    union all
    select
      'LEAVE_DEPARTMENT_APPROVER'::text as assignment_kind,
      da.unit_kind as resource_ref,
      case da.unit_kind
        when 'MARKETING' then 'Marketing'
        when 'IT' then 'IT'
        when 'ACCOUNTING' then 'Kế toán'
        else da.unit_kind
      end as resource_label
    from public.leave_department_approvers da
    where da.approver_app_user_id = p_target_app_user_id
      and da.valid_from <= v_today
      and (da.valid_to is null or (da.valid_to > da.valid_from and v_today < da.valid_to))
      and not exists (
        select 1
          from public.organization_departments d
         where d.system_key = da.unit_kind
           and d.is_active = true
           and public.leave_management__internal_has_open_department_head(d.department_id, v_now)
      )
    union all
    select
      'WORK_REPORT_DELEGATE'::text as assignment_kind,
      wd.delegation_id::text as resource_ref,
      coalesce(wt.display_name, wt.template_code) || ' (' ||
        case when wd.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Đội') end
        || ')' as resource_label
    from public.work_report_delegations wd
    join public.work_report_templates wt
      on wt.template_id = wd.template_id
    left join public.teams tm
      on tm.team_id = wd.scope_team_id
    where wd.delegate_app_user_id = p_target_app_user_id
      and public.work_report__internal_is_delegation_effective(wd.delegation_id, v_now)
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'assignment_kind', r.assignment_kind,
        'resource_ref', r.resource_ref,
        'resource_label', r.resource_label
      )
      order by r.assignment_kind asc, lower(r.resource_label) asc, r.resource_ref asc
    ),
    '[]'::jsonb
  )
    into v_resource_assignments
    from raw_resources r;

  return pg_catalog.jsonb_build_object(
    'as_of', public.org_department__internal_iso_utc(v_now),
    'account_ref', v_target.app_user_id,
    'account_version', v_target.version,
    'enabled', v_target.enabled,
    'memberships', v_memberships,
    'resource_assignments', v_resource_assignments
  );
end;
$function$;

revoke all on function public.direct_entry_authz_get_account_groups_admin(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_get_account_groups_admin(uuid, uuid, uuid)
  to service_role;

commit;
