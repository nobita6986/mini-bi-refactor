-- WP3B: Person, Account Classification/Link, and Organization Department Foundation
-- Implements WP3A Rev 2.1 contract:
--   - direct_entry_app_users.account_type (NORMAL, SHARED, SERVICE)
--   - organization_departments: 5 system keys (RECRUITMENT, ACCOUNTING, MARKETING, IT, MANAGEMENT_BOD), custom depts, version
--   - teams.department_id -> RECRUITMENT backfill & default trigger
--   - FORCE RLS tables: organization_persons, organization_account_person_links,
--     organization_person_department_memberships, organization_department_heads
--   - Widened audit_events and operation+target bound idempotency ledger
--   - 18 new/updated org_department_* RPCs (0 overloads, post-lock v_now, PT409 conflicts)
--   - Bidirectional sync with legacy writers (recruiters, display_name, accounting memberships, leave profiles)

begin;

-- =============================================================================
-- 1. Drop superseded signatures cleanly (zero overload guarantee)
-- =============================================================================
drop function if exists public.org_department_list_departments_admin(uuid, uuid);
drop function if exists public.org_department_get_department_admin(uuid, uuid, uuid);
drop function if exists public.org_department__internal_department_projection(public.organization_departments, date);

-- =============================================================================
-- 2. Extend existing core tables
-- =============================================================================
alter table public.direct_entry_app_users
  add column if not exists account_type text not null default 'NORMAL';

alter table public.direct_entry_app_users
  drop constraint if exists direct_entry_app_users_account_type_chk;

alter table public.direct_entry_app_users
  add constraint direct_entry_app_users_account_type_chk
  check (account_type in ('NORMAL', 'SHARED', 'SERVICE'));

alter table public.organization_departments disable trigger organization_departments_guard_trg;

alter table public.organization_departments
  alter column system_key drop not null;

alter table public.organization_departments
  add column if not exists version integer not null default 1;

alter table public.organization_departments
  add column if not exists membership_mode text not null default 'MANAGED_MEMBERSHIP';

alter table public.organization_departments
  add column if not exists default_policy_code text not null default 'ORGANIZATIONAL_MEMBERSHIP_ONLY';

alter table public.organization_departments
  drop constraint if exists organization_departments_version_chk;

alter table public.organization_departments
  add constraint organization_departments_version_chk check (version >= 1);

alter table public.organization_departments
  drop constraint if exists organization_departments_system_key_chk;

alter table public.organization_departments
  add constraint organization_departments_system_key_chk
  check (
    system_key is null
    or system_key in ('RECRUITMENT', 'ACCOUNTING', 'MARKETING', 'IT', 'MANAGEMENT_BOD')
  );

do $$
declare
  v_con record;
begin
  for v_con in
    select conname
      from pg_catalog.pg_constraint
     where conrelid = 'public.organization_departments'::regclass
       and contype = 'c'
       and (
         pg_catalog.pg_get_constraintdef(oid) ilike '%membership_mode%'
         or pg_catalog.pg_get_constraintdef(oid) ilike '%default_policy_code%'
       )
  loop
    execute pg_catalog.format(
      'alter table public.organization_departments drop constraint if exists %I',
      v_con.conname
    );
  end loop;
end;
$$;

alter table public.organization_departments
  add constraint organization_departments_membership_mode_chk
  check (
    membership_mode in (
      'MANAGED_MEMBERSHIP_AND_TEAMS',
      'MANAGED_MEMBERSHIP'
    )
  );

alter table public.organization_departments
  add constraint organization_departments_default_policy_code_chk
  check (
    default_policy_code in (
      'EXISTING_TEAM_AUTHORITY_READ_ONLY',
      'VENDOR_FINANCE_VIEW_AND_RECORD',
      'ORGANIZATIONAL_MEMBERSHIP_ONLY'
    )
  );

create unique index if not exists organization_departments_lower_code_uidx
  on public.organization_departments (pg_catalog.lower(code));

update public.organization_departments
   set membership_mode = 'MANAGED_MEMBERSHIP_AND_TEAMS',
       default_policy_code = 'EXISTING_TEAM_AUTHORITY_READ_ONLY',
       version = greatest(version, 1),
       updated_at = pg_catalog.clock_timestamp()
 where system_key = 'RECRUITMENT';

update public.organization_departments
   set membership_mode = 'MANAGED_MEMBERSHIP',
       default_policy_code = 'VENDOR_FINANCE_VIEW_AND_RECORD',
       version = greatest(version, 1),
       updated_at = pg_catalog.clock_timestamp()
 where system_key = 'ACCOUNTING';

insert into public.organization_departments (
  system_key,
  code,
  name,
  is_active,
  membership_mode,
  default_policy_code,
  version
)
values
  ('MARKETING', 'MARKETING', 'Marketing', true, 'MANAGED_MEMBERSHIP', 'ORGANIZATIONAL_MEMBERSHIP_ONLY', 1),
  ('IT', 'IT', 'Công nghệ thông tin', true, 'MANAGED_MEMBERSHIP', 'ORGANIZATIONAL_MEMBERSHIP_ONLY', 1),
  ('MANAGEMENT_BOD', 'MANAGEMENT_BOD', 'Ban Giám đốc (BOD)', true, 'MANAGED_MEMBERSHIP', 'ORGANIZATIONAL_MEMBERSHIP_ONLY', 1)
on conflict (system_key) do nothing;

create or replace function public.org_department__internal_guard_department()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'DEPARTMENT_SYSTEM_RECORD_IMMUTABLE'
      using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    if new.system_key is null then
      if new.membership_mode is distinct from 'MANAGED_MEMBERSHIP'
         or new.default_policy_code is distinct from 'ORGANIZATIONAL_MEMBERSHIP_ONLY' then
        raise exception 'DEPARTMENT_SYSTEM_RECORD_IMMUTABLE'
          using errcode = '55000';
      end if;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.department_id is distinct from old.department_id
       or new.system_key is distinct from old.system_key
       or new.created_at is distinct from old.created_at then
      raise exception 'DEPARTMENT_SYSTEM_RECORD_IMMUTABLE'
        using errcode = '55000';
    end if;

    if old.system_key is not null then
      if new.code is distinct from old.code
         or new.membership_mode is distinct from old.membership_mode
         or new.default_policy_code is distinct from old.default_policy_code
         or new.is_active is distinct from true then
        raise exception 'DEPARTMENT_SYSTEM_RECORD_IMMUTABLE'
          using errcode = '55000';
      end if;
    else
      if new.membership_mode is distinct from old.membership_mode
         or new.default_policy_code is distinct from old.default_policy_code then
        raise exception 'DEPARTMENT_SYSTEM_RECORD_IMMUTABLE'
          using errcode = '55000';
      end if;
    end if;

    return new;
  end if;

  return new;
end;
$function$;

revoke all on function public.org_department__internal_guard_department()
  from public, anon, authenticated, service_role;

alter table public.organization_departments enable trigger organization_departments_guard_trg;

-- Extend teams with department_id -> RECRUITMENT
alter table public.teams
  add column if not exists department_id uuid null
  references public.organization_departments(department_id) on delete restrict;

create index if not exists teams_department_id_idx
  on public.teams (department_id);

update public.teams t
   set department_id = d.department_id
  from public.organization_departments d
 where d.system_key = 'RECRUITMENT'
   and t.code <> '__system_vendor__'
   and t.department_id is distinct from d.department_id;

update public.teams
   set department_id = null
 where code = '__system_vendor__'
   and department_id is not null;

alter table public.teams
  drop constraint if exists teams_department_vendor_invariant_chk;

alter table public.teams
  add constraint teams_department_vendor_invariant_chk
  check ((code = '__system_vendor__') = (department_id is null));

drop trigger if exists teams_default_department_trg on public.teams;
drop function if exists public.org_department__internal_team_default_dept();

create or replace function public.org_department__internal_guard_team_department()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_rec_dept_id uuid;
begin
  if tg_op = 'UPDATE' then
    if (old.code = '__system_vendor__') <> (new.code = '__system_vendor__') then
      raise exception 'TEAM_CODE_VENDOR_TRANSITION_FORBIDDEN'
        using errcode = '23514';
    end if;
  end if;

  if new.code = '__system_vendor__' then
    if new.department_id is not null then
      raise exception 'SYSTEM_VENDOR_TEAM_DEPARTMENT_FORBIDDEN'
        using errcode = '23514';
    end if;
    return new;
  end if;

  select d.department_id
    into v_rec_dept_id
    from public.organization_departments d
   where d.system_key = 'RECRUITMENT';

  if v_rec_dept_id is null then
    raise exception 'RECRUITMENT_DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if new.department_id is null then
    new.department_id := v_rec_dept_id;
  elsif new.department_id is distinct from v_rec_dept_id then
    raise exception 'TEAM_DEPARTMENT_MUST_BE_RECRUITMENT'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

revoke all on function public.org_department__internal_guard_team_department()
  from public, anon, authenticated, service_role;

drop trigger if exists teams_department_guard_trg on public.teams;
create trigger teams_department_guard_trg
  before insert or update on public.teams
  for each row execute function public.org_department__internal_guard_team_department();

-- =============================================================================
-- 3. Four new FORCE RLS domain tables
-- =============================================================================
create table if not exists public.organization_persons (
  person_id uuid primary key default gen_random_uuid(),
  employee_code text not null
    constraint organization_persons_employee_code_chk
    check (
      employee_code = pg_catalog.btrim(employee_code)
      and pg_catalog.length(employee_code) between 2 and 64
      and employee_code !~ '[\x00-\x1F\x7F]'
    ),
  full_name text not null
    constraint organization_persons_full_name_chk
    check (
      full_name = pg_catalog.btrim(full_name)
      and pg_catalog.length(full_name) between 1 and 160
      and full_name !~ '[\x00-\x1F\x7F]'
    ),
  joined_on date null,
  status text not null default 'ACTIVE'
    constraint organization_persons_status_chk
    check (status in ('ACTIVE', 'INACTIVE')),
  recruiter_id uuid null
    references public.recruiters(recruiter_id) on delete restrict,
  version integer not null default 1
    constraint organization_persons_version_chk check (version >= 1),
  deactivated_at timestamptz null,
  deactivated_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  deactivate_reason text null
    constraint organization_persons_deactivate_reason_chk
    check (
      deactivate_reason is null
      or (
        deactivate_reason = pg_catalog.btrim(deactivate_reason)
        and pg_catalog.length(deactivate_reason) between 1 and 4000
        and deactivate_reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  created_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  updated_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_persons_employee_code_uk unique (employee_code),
  constraint organization_persons_no_synthetic_hrp_chk
    check (employee_code !~* '^hrp-[0-9]{4}-[0-9]{6}$'),
  constraint organization_persons_deactivation_state_chk
    check (
      (status = 'ACTIVE' and deactivated_at is null and deactivated_by_user_id is null and deactivate_reason is null)
      or (status = 'INACTIVE' and deactivated_at is not null)
    )
);

create unique index if not exists organization_persons_lower_code_uidx
  on public.organization_persons (pg_catalog.lower(employee_code));

create unique index if not exists organization_persons_recruiter_uidx
  on public.organization_persons (recruiter_id)
  where recruiter_id is not null;

create index if not exists organization_persons_status_name_idx
  on public.organization_persons (status, pg_catalog.lower(full_name), person_id);

revoke all on table public.organization_persons from public, anon, authenticated, service_role;
alter table public.organization_persons enable row level security;
alter table public.organization_persons force row level security;

create or replace function public.org_department__internal_guard_person()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_has_hrp boolean := false;
begin
  if tg_op = 'DELETE' then
    raise exception 'ORG_PERSON_DELETE_FORBIDDEN'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if new.person_id is distinct from old.person_id
       or new.created_at is distinct from old.created_at then
      raise exception 'ORG_PERSON_IMMUTABLE_FIELD'
        using errcode = '55000';
    end if;
  end if;

  if new.recruiter_id is not null then
    select exists (
      select 1
        from public.recruiter_provider_memberships rm
       where rm.recruiter_id = new.recruiter_id
         and rm.provider_type = 'hrp'
         and rm.vendor_id is null
    ) into v_has_hrp;

    if not coalesce(v_has_hrp, false) then
      raise exception 'VENDOR_RECRUITER_NOT_INTERNAL_PERSON'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.org_department__internal_guard_person()
  from public, anon, authenticated, service_role;

drop trigger if exists organization_persons_guard_trg on public.organization_persons;
create trigger organization_persons_guard_trg
  before insert or update or delete on public.organization_persons
  for each row execute function public.org_department__internal_guard_person();

create table if not exists public.organization_account_person_links (
  link_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  person_id uuid not null
    references public.organization_persons(person_id) on delete restrict,
  started_at timestamptz not null,
  ended_at timestamptz null,
  source_kind text not null default 'ADMIN_MUTATION'
    constraint organization_account_person_links_source_kind_chk
    check (source_kind in ('ADMIN_MUTATION', 'BACKFILL_DATE_EVIDENCE', 'BACKFILL_CURRENT_STATE_ONLY')),
  evidence_date date null,
  version integer not null default 1
    constraint organization_account_person_links_version_chk check (version >= 1),
  reason text not null
    constraint organization_account_person_links_reason_chk
    check (
      reason = pg_catalog.btrim(reason)
      and pg_catalog.length(reason) between 1 and 4000
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  ended_reason text null
    constraint organization_account_person_links_ended_reason_chk
    check (
      ended_reason is null
      or (
        ended_reason = pg_catalog.btrim(ended_reason)
        and pg_catalog.length(ended_reason) between 1 and 4000
        and ended_reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  created_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  ended_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_account_person_links_interval_chk
    check (ended_at is null or ended_at >= started_at),
  constraint organization_account_person_links_state_chk
    check (
      (ended_at is null and ended_reason is null and ended_by_app_user_id is null)
      or (ended_at is not null)
    ),
  constraint organization_account_person_links_evidence_chk
    check ((source_kind = 'BACKFILL_DATE_EVIDENCE') = (evidence_date is not null))
);

create unique index if not exists organization_account_person_links_active_account_uidx
  on public.organization_account_person_links (app_user_id)
  where ended_at is null;

create unique index if not exists organization_account_person_links_active_person_uidx
  on public.organization_account_person_links (person_id)
  where ended_at is null;

create index if not exists organization_account_person_links_person_started_idx
  on public.organization_account_person_links (person_id, started_at desc, link_id desc);

create index if not exists organization_account_person_links_account_started_idx
  on public.organization_account_person_links (app_user_id, started_at desc, link_id desc);

revoke all on table public.organization_account_person_links from public, anon, authenticated, service_role;
alter table public.organization_account_person_links enable row level security;
alter table public.organization_account_person_links force row level security;

create table if not exists public.organization_person_department_memberships (
  membership_id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.organization_persons(person_id) on delete restrict,
  department_id uuid not null
    references public.organization_departments(department_id) on delete restrict,
  started_at timestamptz not null,
  ended_at timestamptz null,
  source_kind text not null default 'ADMIN_MUTATION'
    constraint organization_person_dept_memberships_source_kind_chk
    check (source_kind in ('ADMIN_MUTATION', 'BACKFILL_DATE_EVIDENCE', 'BACKFILL_CURRENT_STATE_ONLY')),
  evidence_date date null,
  version integer not null default 1
    constraint organization_person_dept_memberships_version_chk check (version >= 1),
  reason text not null
    constraint organization_person_dept_memberships_reason_chk
    check (
      reason = pg_catalog.btrim(reason)
      and pg_catalog.length(reason) between 1 and 4000
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  ended_reason text null
    constraint organization_person_dept_memberships_ended_reason_chk
    check (
      ended_reason is null
      or (
        ended_reason = pg_catalog.btrim(ended_reason)
        and pg_catalog.length(ended_reason) between 1 and 4000
        and ended_reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  created_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  ended_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_person_dept_memberships_interval_chk
    check (ended_at is null or ended_at >= started_at),
  constraint organization_person_dept_memberships_state_chk
    check (
      (ended_at is null and ended_reason is null and ended_by_app_user_id is null)
      or (ended_at is not null)
    ),
  constraint organization_person_dept_memberships_evidence_chk
    check ((source_kind = 'BACKFILL_DATE_EVIDENCE') = (evidence_date is not null))
);

create unique index if not exists organization_person_dept_memberships_active_person_uidx
  on public.organization_person_department_memberships (person_id)
  where ended_at is null;

create index if not exists organization_person_dept_memberships_dept_started_idx
  on public.organization_person_department_memberships (department_id, started_at desc, membership_id desc);

create index if not exists organization_person_dept_memberships_person_started_idx
  on public.organization_person_department_memberships (person_id, started_at desc, membership_id desc);

revoke all on table public.organization_person_department_memberships from public, anon, authenticated, service_role;
alter table public.organization_person_department_memberships enable row level security;
alter table public.organization_person_department_memberships force row level security;

create table if not exists public.organization_department_heads (
  head_assignment_id uuid primary key default gen_random_uuid(),
  department_id uuid not null
    references public.organization_departments(department_id) on delete restrict,
  person_id uuid not null
    references public.organization_persons(person_id) on delete restrict,
  started_at timestamptz not null,
  ended_at timestamptz null,
  source_kind text not null default 'ADMIN_MUTATION'
    constraint organization_department_heads_source_kind_chk
    check (source_kind in ('ADMIN_MUTATION', 'BACKFILL_DATE_EVIDENCE', 'BACKFILL_CURRENT_STATE_ONLY')),
  evidence_date date null,
  version integer not null default 1
    constraint organization_department_heads_version_chk check (version >= 1),
  reason text not null
    constraint organization_department_heads_reason_chk
    check (
      reason = pg_catalog.btrim(reason)
      and pg_catalog.length(reason) between 1 and 4000
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  ended_reason text null
    constraint organization_department_heads_ended_reason_chk
    check (
      ended_reason is null
      or (
        ended_reason = pg_catalog.btrim(ended_reason)
        and pg_catalog.length(ended_reason) between 1 and 4000
        and ended_reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  created_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  ended_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_department_heads_interval_chk
    check (ended_at is null or ended_at >= started_at),
  constraint organization_department_heads_state_chk
    check (
      (ended_at is null and ended_reason is null and ended_by_app_user_id is null)
      or (ended_at is not null)
    ),
  constraint organization_department_heads_evidence_chk
    check ((source_kind = 'BACKFILL_DATE_EVIDENCE') = (evidence_date is not null))
);

create unique index if not exists organization_department_heads_active_dept_uidx
  on public.organization_department_heads (department_id)
  where ended_at is null;

create index if not exists organization_department_heads_dept_started_idx
  on public.organization_department_heads (department_id, started_at desc, head_assignment_id desc);

create index if not exists organization_department_heads_person_started_idx
  on public.organization_department_heads (person_id, started_at desc, head_assignment_id desc);

revoke all on table public.organization_department_heads from public, anon, authenticated, service_role;
alter table public.organization_department_heads enable row level security;
alter table public.organization_department_heads force row level security;

create or replace function public.org_department__internal_temporal_history_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'ORG_HISTORY_DELETE_FORBIDDEN'
      using errcode = '55000';
  end if;

  if old.ended_at is not null then
    raise exception 'ORG_ENDED_RECORD_IMMUTABLE'
      using errcode = '55000';
  end if;

  if new.ended_at is null then
    raise exception 'ORG_ACTIVE_RECORD_CLOSE_ONLY'
      using errcode = '55000';
  end if;

  if new.started_at is distinct from old.started_at
     or new.source_kind is distinct from old.source_kind
     or new.evidence_date is distinct from old.evidence_date
     or new.reason is distinct from old.reason
     or new.created_by_app_user_id is distinct from old.created_by_app_user_id
     or new.created_at is distinct from old.created_at
     or new.version is distinct from (old.version + 1) then
    raise exception 'ORG_HISTORY_IMMUTABLE_FIELD'
      using errcode = '55000';
  end if;

  if tg_table_name = 'organization_account_person_links' then
    if pg_catalog.to_jsonb(new)->>'link_id' is distinct from pg_catalog.to_jsonb(old)->>'link_id'
       or pg_catalog.to_jsonb(new)->>'app_user_id' is distinct from pg_catalog.to_jsonb(old)->>'app_user_id'
       or pg_catalog.to_jsonb(new)->>'person_id' is distinct from pg_catalog.to_jsonb(old)->>'person_id' then
      raise exception 'ORG_HISTORY_IMMUTABLE_FIELD'
        using errcode = '55000';
    end if;
  elsif tg_table_name = 'organization_person_department_memberships' then
    if pg_catalog.to_jsonb(new)->>'membership_id' is distinct from pg_catalog.to_jsonb(old)->>'membership_id'
       or pg_catalog.to_jsonb(new)->>'person_id' is distinct from pg_catalog.to_jsonb(old)->>'person_id'
       or pg_catalog.to_jsonb(new)->>'department_id' is distinct from pg_catalog.to_jsonb(old)->>'department_id' then
      raise exception 'ORG_HISTORY_IMMUTABLE_FIELD'
        using errcode = '55000';
    end if;
  elsif tg_table_name = 'organization_department_heads' then
    if pg_catalog.to_jsonb(new)->>'head_assignment_id' is distinct from pg_catalog.to_jsonb(old)->>'head_assignment_id'
       or pg_catalog.to_jsonb(new)->>'department_id' is distinct from pg_catalog.to_jsonb(old)->>'department_id'
       or pg_catalog.to_jsonb(new)->>'person_id' is distinct from pg_catalog.to_jsonb(old)->>'person_id' then
      raise exception 'ORG_HISTORY_IMMUTABLE_FIELD'
        using errcode = '55000';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.org_department__internal_temporal_history_guard()
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_guard_temporal_invariants()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_account_type text;
  v_person_status text;
  v_dept_active boolean;
  v_has_member boolean := false;
  v_overlap boolean := false;
  v_new_range tstzrange := pg_catalog.tstzrange(new.started_at, coalesce(new.ended_at, 'infinity'::timestamptz), '[)');
begin
  if tg_table_name = 'organization_account_person_links' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_person_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'person_id'))
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_app_user_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'app_user_id'))
    );

    if new.ended_at is null then
      select u.account_type
        into v_account_type
        from public.direct_entry_app_users u
       where u.app_user_id = (pg_catalog.to_jsonb(new)->>'app_user_id')::uuid;
      if v_account_type is distinct from 'NORMAL' then
        raise exception 'ACCOUNT_TYPE_LINK_FORBIDDEN'
          using errcode = '23514';
      end if;
    end if;

    select exists (
      select 1
        from public.organization_account_person_links l
       where l.link_id <> (pg_catalog.to_jsonb(new)->>'link_id')::uuid
         and (
           l.app_user_id = (pg_catalog.to_jsonb(new)->>'app_user_id')::uuid
           or l.person_id = (pg_catalog.to_jsonb(new)->>'person_id')::uuid
         )
         and (l.ended_at is null or l.ended_at > l.started_at)
         and not pg_catalog.isempty(v_new_range)
         and pg_catalog.tstzrange(l.started_at, coalesce(l.ended_at, 'infinity'::timestamptz), '[)') && v_new_range
    ) into v_overlap;

    if v_overlap then
      raise exception 'ACCOUNT_PERSON_LINK_INTERVAL_OVERLAP'
        using errcode = '23P01';
    end if;
  elsif tg_table_name = 'organization_person_department_memberships' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_person_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'person_id'))
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_dept_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'department_id'))
    );

    if new.ended_at is null then
      select p.status into v_person_status
        from public.organization_persons p
       where p.person_id = (pg_catalog.to_jsonb(new)->>'person_id')::uuid;
      if v_person_status is distinct from 'ACTIVE' then
        raise exception 'PERSON_NOT_ACTIVE'
          using errcode = '23514';
      end if;

      select d.is_active into v_dept_active
        from public.organization_departments d
       where d.department_id = (pg_catalog.to_jsonb(new)->>'department_id')::uuid;
      if v_dept_active is distinct from true then
        raise exception 'DEPARTMENT_NOT_ACTIVE'
          using errcode = '23514';
      end if;
    end if;

    select exists (
      select 1
        from public.organization_person_department_memberships m
       where m.membership_id <> (pg_catalog.to_jsonb(new)->>'membership_id')::uuid
         and m.person_id = (pg_catalog.to_jsonb(new)->>'person_id')::uuid
         and (m.ended_at is null or m.ended_at > m.started_at)
         and not pg_catalog.isempty(v_new_range)
         and pg_catalog.tstzrange(m.started_at, coalesce(m.ended_at, 'infinity'::timestamptz), '[)') && v_new_range
    ) into v_overlap;

    if v_overlap then
      raise exception 'PERSON_DEPARTMENT_MEMBERSHIP_INTERVAL_OVERLAP'
        using errcode = '23P01';
    end if;
  elsif tg_table_name = 'organization_department_heads' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_person_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'person_id'))
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_dept_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'department_id'))
    );

    if new.ended_at is null then
      select d.is_active into v_dept_active
        from public.organization_departments d
       where d.department_id = (pg_catalog.to_jsonb(new)->>'department_id')::uuid;
      if v_dept_active is distinct from true then
        raise exception 'DEPARTMENT_NOT_ACTIVE'
          using errcode = '23514';
      end if;

      select p.status into v_person_status
        from public.organization_persons p
       where p.person_id = (pg_catalog.to_jsonb(new)->>'person_id')::uuid;
      if v_person_status is distinct from 'ACTIVE' then
        raise exception 'PERSON_NOT_ACTIVE'
          using errcode = '23514';
      end if;

      select exists (
        select 1
          from public.organization_person_department_memberships m
         where m.person_id = (pg_catalog.to_jsonb(new)->>'person_id')::uuid
           and m.department_id = (pg_catalog.to_jsonb(new)->>'department_id')::uuid
           and m.ended_at is null
      ) into v_has_member;
      if not coalesce(v_has_member, false) then
        raise exception 'PERSON_NOT_ACTIVE_MEMBER_OF_DEPARTMENT'
          using errcode = '23514';
      end if;
    end if;

    select exists (
      select 1
        from public.organization_department_heads h
       where h.head_assignment_id <> (pg_catalog.to_jsonb(new)->>'head_assignment_id')::uuid
         and h.department_id = (pg_catalog.to_jsonb(new)->>'department_id')::uuid
         and (h.ended_at is null or h.ended_at > h.started_at)
         and not pg_catalog.isempty(v_new_range)
         and pg_catalog.tstzrange(h.started_at, coalesce(h.ended_at, 'infinity'::timestamptz), '[)') && v_new_range
    ) into v_overlap;

    if v_overlap then
      raise exception 'DEPARTMENT_HEAD_INTERVAL_OVERLAP'
        using errcode = '23P01';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.org_department__internal_guard_temporal_invariants()
  from public, anon, authenticated, service_role;

drop trigger if exists organization_account_person_links_history_guard_trg on public.organization_account_person_links;
create trigger organization_account_person_links_history_guard_trg
  before update or delete on public.organization_account_person_links
  for each row execute function public.org_department__internal_temporal_history_guard();

drop trigger if exists organization_account_person_links_invariants_guard_trg on public.organization_account_person_links;
create trigger organization_account_person_links_invariants_guard_trg
  before insert or update on public.organization_account_person_links
  for each row execute function public.org_department__internal_guard_temporal_invariants();

drop trigger if exists organization_person_dept_memberships_history_guard_trg on public.organization_person_department_memberships;
create trigger organization_person_dept_memberships_history_guard_trg
  before update or delete on public.organization_person_department_memberships
  for each row execute function public.org_department__internal_temporal_history_guard();

drop trigger if exists organization_person_dept_memberships_invariants_guard_trg on public.organization_person_department_memberships;
create trigger organization_person_dept_memberships_invariants_guard_trg
  before insert or update on public.organization_person_department_memberships
  for each row execute function public.org_department__internal_guard_temporal_invariants();

drop trigger if exists organization_department_heads_history_guard_trg on public.organization_department_heads;
create trigger organization_department_heads_history_guard_trg
  before update or delete on public.organization_department_heads
  for each row execute function public.org_department__internal_temporal_history_guard();

drop trigger if exists organization_department_heads_invariants_guard_trg on public.organization_department_heads;
create trigger organization_department_heads_invariants_guard_trg
  before insert or update on public.organization_department_heads
  for each row execute function public.org_department__internal_guard_temporal_invariants();

-- =============================================================================
-- 4. Widen Audit & Idempotency Tables
-- =============================================================================
alter table public.organization_department_audit_events
  alter column department_id drop not null,
  alter column membership_id drop not null,
  alter column target_app_user_id drop not null,
  alter column idempotency_key drop not null;

alter table public.organization_department_audit_events
  add column if not exists target_person_id uuid null
    references public.organization_persons(person_id) on delete restrict,
  add column if not exists head_assignment_id uuid null
    references public.organization_department_heads(head_assignment_id) on delete restrict,
  add column if not exists link_id uuid null
    references public.organization_account_person_links(link_id) on delete restrict;

alter table public.organization_department_audit_events
  drop constraint if exists organization_department_audit_events_action_chk;

alter table public.organization_department_audit_events
  add constraint organization_department_audit_events_action_chk
  check (
    action in (
      'ACCOUNTING_MEMBER_ASSIGNED',
      'ACCOUNTING_MEMBER_ENDED',
      'DEPT_CREATED',
      'DEPT_UPDATED',
      'PERSON_CREATED',
      'PERSON_UPDATED',
      'PERSON_DEPT_ASSIGNED',
      'PERSON_DEPT_ENDED',
      'PERSON_DEPT_TRANSFERRED',
      'DEPT_HEAD_DESIGNATED',
      'DEPT_HEAD_ENDED',
      'ACCOUNT_TYPE_UPDATED',
      'ACCOUNT_PERSON_LINKED',
      'ACCOUNT_PERSON_UNLINKED',
      'BACKFILL_APPLIED'
    )
  );

create index if not exists organization_department_audit_events_person_created_idx
  on public.organization_department_audit_events (target_person_id, created_at desc);

alter table public.organization_department_idempotency
  add column if not exists target_ref text not null default '';

alter table public.organization_department_idempotency
  drop constraint if exists organization_department_idempotency_action_chk;

alter table public.organization_department_idempotency
  add constraint organization_department_idempotency_action_chk
  check (
    action in (
      'ACCOUNTING_MEMBER_ASSIGNED',
      'ACCOUNTING_MEMBER_ENDED',
      'DEPT_CREATED',
      'DEPT_UPDATED',
      'PERSON_CREATED',
      'PERSON_UPDATED',
      'PERSON_DEPT_ASSIGNED',
      'PERSON_DEPT_ENDED',
      'PERSON_DEPT_TRANSFERRED',
      'DEPT_HEAD_DESIGNATED',
      'DEPT_HEAD_ENDED',
      'ACCOUNT_TYPE_UPDATED',
      'ACCOUNT_PERSON_LINKED',
      'ACCOUNT_PERSON_UNLINKED',
      'BACKFILL_APPLIED'
    )
  );

-- =============================================================================
-- 5. Internal Validation, Sync, and Projection Primitives
-- =============================================================================
create or replace function public.org_department__internal_normalize_reason(
  p_reason text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_reason text;
begin
  if p_reason is null then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  v_reason := pg_catalog.btrim(p_reason);
  if pg_catalog.length(v_reason) < 1
     or pg_catalog.length(v_reason) > 500
     or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'REASON_INVALID' using errcode = '22023';
  end if;
  return v_reason;
end;
$function$;

revoke all on function public.org_department__internal_normalize_reason(text)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_assert_idempotency(
  p_actor_user_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_target_ref text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.organization_department_idempotency%rowtype;
begin
  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'IDEMPOTENCY_INPUT_INVALID' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_idem_v1'),
    pg_catalog.hashtext(p_actor_user_id::text)
  );

  select i.*
    into v_existing
    from public.organization_department_idempotency i
   where i.actor_user_id = p_actor_user_id
     and i.idempotency_key = p_idempotency_key
   for update;

  if not found then
    return null;
  end if;

  if v_existing.action is distinct from p_action
     or v_existing.target_ref is distinct from coalesce(p_target_ref, '')
     or v_existing.request_fingerprint is distinct from p_request_fingerprint then
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
  end if;

  return pg_catalog.jsonb_set(v_existing.result_payload, '{replayed}', 'true'::jsonb, true);
end;
$function$;

revoke all on function public.org_department__internal_assert_idempotency(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_iso_utc(
  p_ts timestamptz
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select case
    when p_ts is null then null
    else pg_catalog.to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  end;
$function$;

revoke all on function public.org_department__internal_iso_utc(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_department_head_at(
  p_department_id uuid,
  p_as_of timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.jsonb_build_object(
    'head_assignment_id', h.head_assignment_id,
    'person_id', p.person_id,
    'employee_code', p.employee_code,
    'full_name', p.full_name,
    'started_at', public.org_department__internal_iso_utc(h.started_at),
    'version', h.version
  )
    from public.organization_department_heads h
    join public.organization_persons p
      on p.person_id = h.person_id
   where h.department_id = p_department_id
     and h.started_at <= p_as_of
     and (h.ended_at is null or p_as_of < h.ended_at)
     and (h.ended_at is null or h.ended_at > h.started_at)
   order by h.started_at desc, h.head_assignment_id desc
   limit 1;
$function$;

revoke all on function public.org_department__internal_department_head_at(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_department_projection(
  p_dept public.organization_departments,
  p_as_of timestamp with time zone
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of_ts timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_as_of_date date := (v_as_of_ts at time zone 'Asia/Ho_Chi_Minh')::date;
  v_active_member_count integer := 0;
  v_team_count integer := null;
  v_active_team_count integer := null;
  v_active_head jsonb := null;
begin
  if p_dept.system_key = 'ACCOUNTING' then
    -- WP3A section 4.4: active persons union legacy unlinked enabled accounts at p_as_of.
    select (
      (
        select count(distinct m.person_id)::integer
          from public.organization_person_department_memberships m
          join public.organization_persons p
            on p.person_id = m.person_id
           and (p.status = 'ACTIVE' or (p.deactivated_at is not null and v_as_of_ts < p.deactivated_at))
         where m.department_id = p_dept.department_id
           and m.started_at <= v_as_of_ts
           and (m.ended_at is null or v_as_of_ts < m.ended_at)
           and (m.ended_at is null or m.ended_at > m.started_at)
      )
      +
      (
        select count(distinct lm.app_user_id)::integer
          from public.organization_department_memberships lm
          join public.direct_entry_app_users u
            on u.app_user_id = lm.app_user_id
           and u.enabled = true
         where lm.department_id = p_dept.department_id
           and lm.valid_from <= v_as_of_date
           and (lm.valid_to is null or v_as_of_date < lm.valid_to)
           and (lm.valid_to is null or lm.valid_to > lm.valid_from)
           and not exists (
             select 1
               from public.organization_account_person_links l
               join public.organization_person_department_memberships m2
                 on m2.person_id = l.person_id
                and m2.department_id = p_dept.department_id
                and m2.started_at <= v_as_of_ts
                and (m2.ended_at is null or v_as_of_ts < m2.ended_at)
                and (m2.ended_at is null or m2.ended_at > m2.started_at)
              where l.app_user_id = lm.app_user_id
                and l.started_at <= v_as_of_ts
                and (l.ended_at is null or v_as_of_ts < l.ended_at)
                and (l.ended_at is null or l.ended_at > l.started_at)
           )
      )
    )::integer
      into v_active_member_count;
  else
    select count(distinct m.person_id)::integer
      into v_active_member_count
      from public.organization_person_department_memberships m
      join public.organization_persons p
        on p.person_id = m.person_id
       and (p.status = 'ACTIVE' or (p.deactivated_at is not null and v_as_of_ts < p.deactivated_at))
     where m.department_id = p_dept.department_id
       and m.started_at <= v_as_of_ts
       and (m.ended_at is null or v_as_of_ts < m.ended_at)
       and (m.ended_at is null or m.ended_at > m.started_at);
  end if;

  if p_dept.system_key = 'RECRUITMENT' then
    select count(*)::integer,
           count(*) filter (where t.active)::integer
      into v_team_count, v_active_team_count
      from public.teams t
     where t.code <> '__system_vendor__'
       and (t.department_id = p_dept.department_id or t.department_id is null);
  else
    v_team_count := null;
    v_active_team_count := null;
  end if;

  v_active_head := public.org_department__internal_department_head_at(p_dept.department_id, v_as_of_ts);

  return pg_catalog.jsonb_build_object(
    'department_id', p_dept.department_id,
    'system_key', p_dept.system_key,
    'code', p_dept.code,
    'name', p_dept.name,
    'is_active', p_dept.is_active,
    'version', p_dept.version,
    'membership_mode', p_dept.membership_mode,
    'default_policy_code', p_dept.default_policy_code,
    'active_member_count', coalesce(v_active_member_count, 0),
    'team_count', v_team_count,
    'active_team_count', v_active_team_count,
    'active_head', v_active_head,
    'created_at', public.org_department__internal_iso_utc(p_dept.created_at),
    'updated_at', public.org_department__internal_iso_utc(p_dept.updated_at)
  );
end;
$function$;

revoke all on function public.org_department__internal_department_projection(public.organization_departments, timestamp with time zone)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_person_summary_projection(
  p_person public.organization_persons,
  p_as_of timestamp with time zone
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of_ts timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_account_link jsonb := null;
  v_dept jsonb := null;
begin
  select pg_catalog.jsonb_build_object(
           'link_id', l.link_id,
           'account_ref', u.app_user_id,
           'login_id', pg_catalog.lower(
             nullif(
               pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), '@', 1),
               ''
             )
           ),
           'display_name', u.display_name,
           'enabled', u.enabled,
           'account_version', u.version,
           'started_at', public.org_department__internal_iso_utc(l.started_at),
           'source_kind', l.source_kind,
           'evidence_date', case when l.evidence_date is null then null else l.evidence_date::text end,
           'version', l.version
         )
    into v_account_link
    from public.organization_account_person_links l
    join public.direct_entry_app_users u on u.app_user_id = l.app_user_id
    join auth.users au on au.id = u.auth_subject
   where l.person_id = p_person.person_id
     and l.started_at <= v_as_of_ts
     and (l.ended_at is null or v_as_of_ts < l.ended_at)
     and (l.ended_at is null or l.ended_at > l.started_at)
   order by l.started_at desc, l.link_id desc
   limit 1;

  select pg_catalog.jsonb_build_object(
           'membership_id', m.membership_id,
           'department_id', d.department_id,
           'system_key', d.system_key,
           'code', d.code,
           'name', d.name,
           'started_at', public.org_department__internal_iso_utc(m.started_at),
           'source_kind', m.source_kind,
           'evidence_date', case when m.evidence_date is null then null else m.evidence_date::text end,
           'version', m.version
         )
    into v_dept
    from public.organization_person_department_memberships m
    join public.organization_departments d on d.department_id = m.department_id
   where m.person_id = p_person.person_id
     and m.started_at <= v_as_of_ts
     and (m.ended_at is null or v_as_of_ts < m.ended_at)
     and (m.ended_at is null or m.ended_at > m.started_at)
   order by m.started_at desc, m.membership_id desc
   limit 1;

  return pg_catalog.jsonb_build_object(
    'person_id', p_person.person_id,
    'employee_code', p_person.employee_code,
    'full_name', p_person.full_name,
    'status', p_person.status,
    'joined_on', case when p_person.joined_on is null then null else p_person.joined_on::text end,
    'recruiter_id', p_person.recruiter_id,
    'version', p_person.version,
    'active_account_link', v_account_link,
    'active_department', v_dept
  );
end;
$function$;

revoke all on function public.org_department__internal_person_summary_projection(public.organization_persons, timestamp with time zone)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_person_detail_projection(
  p_person public.organization_persons,
  p_as_of timestamp with time zone
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of_ts timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_summary jsonb;
  v_dept_history jsonb := '[]'::jsonb;
  v_head_history jsonb := '[]'::jsonb;
begin
  v_summary := public.org_department__internal_person_summary_projection(p_person, v_as_of_ts);

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'membership_id', m.membership_id,
               'department_id', d.department_id,
               'system_key', d.system_key,
               'code', d.code,
               'name', d.name,
               'started_at', public.org_department__internal_iso_utc(m.started_at),
               'ended_at', public.org_department__internal_iso_utc(m.ended_at),
               'source_kind', m.source_kind,
               'evidence_date', case when m.evidence_date is null then null else m.evidence_date::text end,
               'version', m.version
             )
             order by m.started_at desc, m.membership_id desc
           ),
           '[]'::jsonb
         )
    into v_dept_history
    from public.organization_person_department_memberships m
    join public.organization_departments d on d.department_id = m.department_id
   where m.person_id = p_person.person_id;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'head_assignment_id', h.head_assignment_id,
               'department_id', d.department_id,
               'system_key', d.system_key,
               'code', d.code,
               'name', d.name,
               'started_at', public.org_department__internal_iso_utc(h.started_at),
               'ended_at', public.org_department__internal_iso_utc(h.ended_at),
               'source_kind', h.source_kind,
               'evidence_date', case when h.evidence_date is null then null else h.evidence_date::text end,
               'version', h.version
             )
             order by h.started_at desc, h.head_assignment_id desc
           ),
           '[]'::jsonb
         )
    into v_head_history
    from public.organization_department_heads h
    join public.organization_departments d on d.department_id = h.department_id
   where h.person_id = p_person.person_id;

  return v_summary || pg_catalog.jsonb_build_object(
    'department_history', coalesce(v_dept_history, '[]'::jsonb),
    'head_assignments', coalesce(v_head_history, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.org_department__internal_person_detail_projection(public.organization_persons, timestamp with time zone)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_head_projection(
  p_head public.organization_department_heads
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_person public.organization_persons%rowtype;
begin
  select p.* into v_person from public.organization_persons p where p.person_id = p_head.person_id;

  return pg_catalog.jsonb_build_object(
    'head_assignment_id', p_head.head_assignment_id,
    'department_id', p_head.department_id,
    'person_id', p_head.person_id,
    'employee_code', coalesce(v_person.employee_code, ''),
    'full_name', coalesce(v_person.full_name, ''),
    'started_at', public.org_department__internal_iso_utc(p_head.started_at),
    'ended_at', public.org_department__internal_iso_utc(p_head.ended_at),
    'source_kind', p_head.source_kind,
    'evidence_date', case when p_head.evidence_date is null then null else p_head.evidence_date::text end,
    'version', p_head.version
  );
end;
$function$;

revoke all on function public.org_department__internal_head_projection(public.organization_department_heads)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_person_membership_projection(
  p_m public.organization_person_department_memberships,
  p_as_of timestamp with time zone
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of_ts timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_person public.organization_persons%rowtype;
  v_account_ref uuid := null;
  v_is_head boolean := false;
begin
  select p.* into v_person from public.organization_persons p where p.person_id = p_m.person_id;

  select l.app_user_id
    into v_account_ref
    from public.organization_account_person_links l
   where l.person_id = p_m.person_id
     and l.started_at <= v_as_of_ts
     and (l.ended_at is null or v_as_of_ts < l.ended_at)
     and (l.ended_at is null or l.ended_at > l.started_at)
   order by l.started_at desc, l.link_id desc
   limit 1;

  select exists (
    select 1
      from public.organization_department_heads h
     where h.department_id = p_m.department_id
       and h.person_id = p_m.person_id
       and h.started_at <= v_as_of_ts
       and (h.ended_at is null or v_as_of_ts < h.ended_at)
       and (h.ended_at is null or h.ended_at > h.started_at)
  ) into v_is_head;

  return pg_catalog.jsonb_build_object(
    'membership_id', p_m.membership_id,
    'department_id', p_m.department_id,
    'person_id', p_m.person_id,
    'employee_code', coalesce(v_person.employee_code, ''),
    'full_name', coalesce(v_person.full_name, ''),
    'person_status', coalesce(v_person.status, 'ACTIVE'),
    'person_version', coalesce(v_person.version, 1),
    'active_account_ref', v_account_ref,
    'is_department_head', v_is_head,
    'started_at', public.org_department__internal_iso_utc(p_m.started_at),
    'ended_at', public.org_department__internal_iso_utc(p_m.ended_at),
    'source_kind', p_m.source_kind,
    'evidence_date', case when p_m.evidence_date is null then null else p_m.evidence_date::text end,
    'version', p_m.version
  );
end;
$function$;

revoke all on function public.org_department__internal_person_membership_projection(public.organization_person_department_memberships, timestamp with time zone)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_resolve_display_name(
  p_app_user_id uuid,
  p_as_of timestamp with time zone default pg_catalog.clock_timestamp(),
  p_fallback_display_name text default null
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_name text := null;
begin
  select p.full_name
    into v_name
    from public.organization_account_person_links l
    join public.organization_persons p
      on p.person_id = l.person_id
   where l.app_user_id = p_app_user_id
     and l.started_at <= v_as_of
     and (l.ended_at is null or v_as_of < l.ended_at)
     and (l.ended_at is null or l.ended_at > l.started_at)
   order by l.started_at desc, l.link_id desc
   limit 1;

  if v_name is not null then
    return v_name;
  end if;

  select r.display_name
    into v_name
    from public.direct_entry_app_user_recruiter_links rl
    join public.recruiters r
      on r.recruiter_id = rl.recruiter_id
   where rl.app_user_id = p_app_user_id
     and rl.verified = true
     and rl.is_current = true
   order by rl.valid_from desc, rl.link_id desc
   limit 1;

  if v_name is not null then
    return v_name;
  end if;

  select u.display_name
    into v_name
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  return coalesce(v_name, p_fallback_display_name);
end;
$function$;

revoke all on function public.org_department__internal_resolve_display_name(uuid, timestamp with time zone, text)
  from public, anon, authenticated, service_role;

-- Update direct_entry_app_user_projection to exact 7-key ExistingAccount contract
create or replace function public.direct_entry_app_user_projection(
  p_app_user public.direct_entry_app_users
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_login_id text := null;
  v_active_person_link jsonb := null;
  v_display_name text := null;
  v_today date := public.direct_entry_authorization_date();
begin
  select pg_catalog.lower(
           nullif(
             pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), '@', 1),
             ''
           )
         )
    into v_login_id
    from auth.users au
   where au.id = p_app_user.auth_subject;

  select pg_catalog.jsonb_build_object(
           'link_id', l.link_id,
           'person_id', p.person_id,
           'employee_code', p.employee_code,
           'full_name', p.full_name,
           'started_at', public.org_department__internal_iso_utc(l.started_at),
           'person_version', p.version
         ),
         p.full_name
    into v_active_person_link, v_display_name
    from public.organization_account_person_links l
    join public.organization_persons p
      on p.person_id = l.person_id
   where l.app_user_id = p_app_user.app_user_id
     and l.ended_at is null
   order by l.started_at desc, l.link_id desc
   limit 1;

  if v_active_person_link is null then
    select r.display_name
      into v_display_name
      from public.direct_entry_app_user_recruiter_links rl
      join public.recruiters r
        on r.recruiter_id = rl.recruiter_id
     where rl.app_user_id = p_app_user.app_user_id
       and rl.verified = true
       and rl.valid_from <= v_today
       and (rl.valid_to is null or v_today < rl.valid_to)
     order by rl.valid_from desc, rl.link_id desc
     limit 1;
  end if;

  return pg_catalog.jsonb_build_object(
    'account_ref', p_app_user.app_user_id,
    'login_id', v_login_id,
    'display_name', coalesce(v_display_name, nullif(p_app_user.display_name, v_login_id)),
    'enabled', p_app_user.enabled,
    'version', p_app_user.version,
    'account_type', p_app_user.account_type,
    'active_person_link', v_active_person_link
  );
end;
$function$;

revoke all on function public.direct_entry_app_user_projection(public.direct_entry_app_users)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_app_user_projection(public.direct_entry_app_users) is
  'WP3B internal 7-key account projection (account_ref, login_id, display_name, enabled, version, account_type, active_person_link). No auth subject or PII leak.';

-- =============================================================================
-- 6. Internal Bidirectional Sync & Leave Profile Guard
-- =============================================================================
create or replace function public.org_department__internal_lock_person(
  p_person_id uuid
)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_person_v1'),
    pg_catalog.hashtext(p_person_id::text)
  );
$function$;

revoke all on function public.org_department__internal_lock_person(uuid)
  from public, anon, authenticated, service_role;

drop function if exists public.org_department__internal_sync_leave_profile_from_org(uuid, uuid, timestamptz);

create or replace function public.org_department__internal_sync_leave_profile_from_org(
  p_app_user_id uuid,
  p_actor_user_id uuid,
  p_now timestamptz,
  p_reset_when_unlinked boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_is_shared boolean := false;
  v_unit_kind text := 'UNCLASSIFIED';
  v_joined_on date := null;
  v_has_person_link boolean := false;
  v_has_legacy_acct boolean := false;
  v_prof public.leave_employee_profiles%rowtype;
  v_prev_sync text := pg_catalog.current_setting('app.org_leave_profile_sync', true);
  v_eff_now timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  v_actor uuid := coalesce(p_actor_user_id, p_app_user_id);
begin
  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found then
    return;
  end if;

  if v_user.account_type in ('SHARED', 'SERVICE') then
    v_is_shared := true;
    v_unit_kind := 'UNCLASSIFIED';
  else
    v_is_shared := false;
    select true,
           p.joined_on,
           case
             when d.system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD') then d.system_key
             else 'UNCLASSIFIED'
           end
      into v_has_person_link, v_joined_on, v_unit_kind
      from public.organization_account_person_links l
      join public.organization_persons p
        on p.person_id = l.person_id
      left join public.organization_person_department_memberships m
        on m.person_id = p.person_id
       and m.ended_at is null
      left join public.organization_departments d
        on d.department_id = m.department_id
     where l.app_user_id = p_app_user_id
       and l.ended_at is null
     limit 1;

    if not coalesce(v_has_person_link, false) then
      select exists (
        select 1
          from public.organization_department_memberships lm
          join public.organization_departments d
            on d.department_id = lm.department_id
           and d.system_key = 'ACCOUNTING'
         where lm.app_user_id = p_app_user_id
           and lm.valid_to is null
      ) into v_has_legacy_acct;

      if coalesce(v_has_legacy_acct, false) then
        v_unit_kind := 'ACCOUNTING';
      end if;
    end if;
  end if;

  perform pg_catalog.set_config('app.org_leave_profile_sync', 'on', true);

  select lp.* into v_prof
    from public.leave_employee_profiles lp
   where lp.app_user_id = p_app_user_id
   for update;

  if v_user.account_type in ('SHARED', 'SERVICE') then
    if not found then
      insert into public.leave_employee_profiles (
        app_user_id,
        is_shared_non_employee,
        employment_status,
        unit_kind,
        work_start_date,
        row_version,
        created_at,
        updated_at,
        updated_by_app_user_id
      )
      values (
        p_app_user_id,
        true,
        'UNCONFIGURED',
        'UNCLASSIFIED',
        null,
        1,
        v_eff_now,
        v_eff_now,
        v_actor
      );
    elsif v_prof.is_shared_non_employee is distinct from true
       or v_prof.unit_kind is distinct from 'UNCLASSIFIED' then
      update public.leave_employee_profiles
         set is_shared_non_employee = true,
             unit_kind = 'UNCLASSIFIED',
             row_version = v_prof.row_version + 1,
             updated_at = v_eff_now,
             updated_by_app_user_id = v_actor
       where app_user_id = p_app_user_id;
    end if;
  elsif coalesce(v_has_person_link, false) or coalesce(v_has_legacy_acct, false) then
    if found and (
      v_prof.is_shared_non_employee is distinct from false
      or v_prof.unit_kind is distinct from coalesce(v_unit_kind, 'UNCLASSIFIED')
      or (v_has_person_link and v_joined_on is not null and v_prof.work_start_date is distinct from v_joined_on)
    ) then
      update public.leave_employee_profiles
         set is_shared_non_employee = false,
             unit_kind = coalesce(v_unit_kind, 'UNCLASSIFIED'),
             work_start_date = case
               when v_has_person_link then coalesce(v_joined_on, v_prof.work_start_date)
               else v_prof.work_start_date
             end,
             row_version = v_prof.row_version + 1,
             updated_at = v_eff_now,
             updated_by_app_user_id = v_actor
       where app_user_id = p_app_user_id;
    end if;
  elsif p_reset_when_unlinked then
    if found and (
      v_prof.is_shared_non_employee is distinct from false
      or v_prof.unit_kind is distinct from 'UNCLASSIFIED'
    ) then
      update public.leave_employee_profiles
         set is_shared_non_employee = false,
             unit_kind = 'UNCLASSIFIED',
             row_version = v_prof.row_version + 1,
             updated_at = v_eff_now,
             updated_by_app_user_id = v_actor
       where app_user_id = p_app_user_id;
    end if;
  elsif found and v_prof.is_shared_non_employee is distinct from false then
    update public.leave_employee_profiles
       set is_shared_non_employee = false,
           row_version = v_prof.row_version + 1,
           updated_at = v_eff_now,
           updated_by_app_user_id = v_actor
     where app_user_id = p_app_user_id;
  end if;

  perform pg_catalog.set_config('app.org_leave_profile_sync', coalesce(v_prev_sync, ''), true);
exception
  when others then
    perform pg_catalog.set_config('app.org_leave_profile_sync', coalesce(v_prev_sync, ''), true);
    raise;
end;
$function$;

revoke all on function public.org_department__internal_sync_leave_profile_from_org(uuid, uuid, timestamptz, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_sync_accounting_projection(
  p_app_user_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_acct_dept_id uuid;
  v_user public.direct_entry_app_users%rowtype;
  v_should_be_member boolean := false;
  v_open_legacy public.organization_department_memberships%rowtype;
  v_eff_now timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  v_today date := (v_eff_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_next_ver integer;
  v_end_date date;
  v_actor uuid := coalesce(p_actor_user_id, p_app_user_id);
  v_prev_cancel text := pg_catalog.current_setting('org_department.membership_cancel_marker', true);
begin
  if p_app_user_id is null then
    return;
  end if;

  select d.department_id
    into v_acct_dept_id
    from public.organization_departments d
   where d.system_key = 'ACCOUNTING';

  if v_acct_dept_id is null then
    return;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found then
    return;
  end if;

  if v_user.account_type = 'NORMAL' then
    select exists (
      select 1
        from public.organization_account_person_links l
        join public.organization_person_department_memberships m
          on m.person_id = l.person_id
         and m.department_id = v_acct_dept_id
         and m.ended_at is null
       where l.app_user_id = p_app_user_id
         and l.ended_at is null
    ) into v_should_be_member;
  end if;

  select lm.*
    into v_open_legacy
    from public.organization_department_memberships lm
   where lm.department_id = v_acct_dept_id
     and lm.app_user_id = p_app_user_id
     and lm.valid_to is null
   for update;

  if coalesce(v_should_be_member, false) and not found then
    select coalesce(max(lm2.version), 0) + 1
      into v_next_ver
      from public.organization_department_memberships lm2
     where lm2.department_id = v_acct_dept_id
       and lm2.app_user_id = p_app_user_id;

    insert into public.organization_department_memberships (
      department_id,
      app_user_id,
      valid_from,
      valid_to,
      version,
      granted_by_user_id,
      grant_reason,
      created_at,
      updated_at
    )
    values (
      v_acct_dept_id,
      p_app_user_id,
      v_today,
      null,
      v_next_ver,
      v_actor,
      coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'Synced from organization person ACCOUNTING membership'),
      v_eff_now,
      v_eff_now
    );
  elsif not coalesce(v_should_be_member, false) and found then
    if v_today <= v_open_legacy.valid_from then
      v_end_date := v_open_legacy.valid_from;
      perform pg_catalog.set_config('org_department.membership_cancel_marker', 'on', true);
    else
      v_end_date := v_today;
    end if;

    update public.organization_department_memberships
       set valid_to = v_end_date,
           version = v_open_legacy.version + 1,
           revoked_by_user_id = v_actor,
           revoke_reason = coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'Synced end from organization person ACCOUNTING membership'),
           revoked_at = v_eff_now,
           updated_at = v_eff_now
     where membership_id = v_open_legacy.membership_id;

    perform pg_catalog.set_config('org_department.membership_cancel_marker', coalesce(v_prev_cancel, ''), true);
  end if;
exception
  when others then
    perform pg_catalog.set_config('org_department.membership_cancel_marker', coalesce(v_prev_cancel, ''), true);
    raise;
end;
$function$;

revoke all on function public.org_department__internal_sync_accounting_projection(uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_guard_leave_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_has_person_link boolean := false;
  v_org_unit_kind text := null;
begin
  if pg_catalog.current_setting('app.org_leave_profile_sync', true) = 'on' then
    return new;
  end if;

  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = new.app_user_id;

  if not found then
    return new;
  end if;

  select true,
         case
           when d.system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD') then d.system_key
           else 'UNCLASSIFIED'
         end
    into v_has_person_link, v_org_unit_kind
    from public.organization_account_person_links l
    left join public.organization_person_department_memberships m
      on m.person_id = l.person_id
     and m.ended_at is null
    left join public.organization_departments d
      on d.department_id = m.department_id
   where l.app_user_id = new.app_user_id
     and l.ended_at is null
   limit 1;

  if v_user.account_type in ('SHARED', 'SERVICE') then
    if new.is_shared_non_employee is distinct from true
       or new.unit_kind is distinct from 'UNCLASSIFIED' then
      raise exception 'LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN'
        using errcode = '22023';
    end if;
  elsif coalesce(v_has_person_link, false) then
    if new.is_shared_non_employee is distinct from false
       or new.unit_kind is distinct from coalesce(v_org_unit_kind, 'UNCLASSIFIED') then
      raise exception 'LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.org_department__internal_guard_leave_profile()
  from public, anon, authenticated, service_role;

drop trigger if exists leave_employee_profiles_org_guard_trg on public.leave_employee_profiles;
create trigger leave_employee_profiles_org_guard_trg
  before insert or update on public.leave_employee_profiles
  for each row execute function public.org_department__internal_guard_leave_profile();

drop trigger if exists direct_entry_app_users_sync_person_trg on public.direct_entry_app_users;
drop function if exists public.org_department__internal_sync_from_app_user_display_name();

drop trigger if exists recruiters_sync_person_trg on public.recruiters;
drop function if exists public.org_department__internal_sync_from_recruiter_update();

drop trigger if exists recruiter_links_sync_person_trg on public.direct_entry_app_user_recruiter_links;
drop function if exists public.org_department__internal_sync_from_recruiter_link();

drop trigger if exists organization_department_memberships_sync_person_trg on public.organization_department_memberships;
drop function if exists public.org_department__internal_sync_from_legacy_accounting();

drop function if exists public.org_department__internal_sync_accounting_legacy(uuid, uuid, text, timestamptz, uuid);
drop function if exists public.org_department__internal_sync_leave_approver(uuid, uuid, text, timestamptz);

-- =============================================================================
-- 7. Department Read & Lifecycle RPCs (4 RPCs)
-- =============================================================================
create or replace function public.org_department_list_departments_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_include_inactive boolean default true,
  p_as_of timestamp with time zone default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_auth_date date;
  v_departments jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_include_inactive is null then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;

  v_auth_date := (v_as_of at time zone 'Asia/Ho_Chi_Minh')::date;

  select coalesce(
           pg_catalog.jsonb_agg(
             public.org_department__internal_department_projection(d, v_as_of)
             order by
               case d.system_key
                 when 'RECRUITMENT' then 1
                 when 'ACCOUNTING' then 2
                 when 'MARKETING' then 3
                 when 'IT' then 4
                 when 'MANAGEMENT_BOD' then 5
                 else 6
               end asc,
               pg_catalog.lower(d.name) asc,
               d.department_id asc
           ),
           '[]'::jsonb
         )
    into v_departments
    from public.organization_departments d
   where (p_include_inactive or d.is_active);

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth_date::text,
    'as_of', public.org_department__internal_iso_utc(v_as_of),
    'departments', v_departments
  );
end;
$function$;

revoke all on function public.org_department_list_departments_admin(uuid, uuid, boolean, timestamp with time zone)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_list_departments_admin(uuid, uuid, boolean, timestamp with time zone)
  to service_role;

create or replace function public.org_department_get_department_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid,
  p_as_of timestamp with time zone default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_auth_date date := (v_as_of at time zone 'Asia/Ho_Chi_Minh')::date;
  v_dept public.organization_departments%rowtype;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth_date::text,
    'as_of', public.org_department__internal_iso_utc(v_as_of),
    'department', public.org_department__internal_department_projection(v_dept, v_as_of)
  );
end;
$function$;

revoke all on function public.org_department_get_department_admin(uuid, uuid, uuid, timestamp with time zone)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_get_department_admin(uuid, uuid, uuid, timestamp with time zone)
  to service_role;

create or replace function public.org_department_create_department_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_code text,
  p_name text,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'DEPT_CREATED';
  v_code text;
  v_name text;
  v_reason text;
  v_replay jsonb;
  v_dept public.organization_departments%rowtype;
  v_now timestamptz;
  v_proj jsonb;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  v_code := pg_catalog.btrim(coalesce(p_code, ''));
  v_name := pg_catalog.btrim(coalesce(p_name, ''));
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,63}$' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if pg_catalog.length(v_name) < 1 or pg_catalog.length(v_name) > 256 or v_name ~ '[\x00-\x1F\x7F]' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:create:' || pg_catalog.lower(v_code),
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  if exists (
    select 1 from public.organization_departments d
     where pg_catalog.lower(d.code) = pg_catalog.lower(v_code)
  ) then
    raise exception 'DUPLICATE_CODE' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  insert into public.organization_departments (
    system_key,
    code,
    name,
    is_active,
    membership_mode,
    default_policy_code,
    version,
    created_at,
    updated_at
  )
  values (
    null,
    v_code,
    v_name,
    true,
    'MANAGED_MEMBERSHIP',
    'ORGANIZATIONAL_MEMBERSHIP_ONLY',
    1,
    v_now,
    v_now
  )
  returning * into v_dept;

  v_proj := public.org_department__internal_department_projection(v_dept, v_now);

  insert into public.organization_department_audit_events (
    department_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    v_dept.department_id,
    p_app_user_id,
    v_action,
    v_reason,
    null,
    v_proj,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'department', v_proj
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:create:' || pg_catalog.lower(v_code),
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_create_department_admin(uuid, uuid, text, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_create_department_admin(uuid, uuid, text, text, text, uuid, text)
  to service_role;

drop function if exists public.org_department_update_department_admin(uuid, uuid, uuid, integer, text, boolean, text, uuid, text);

create or replace function public.org_department_update_department_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid,
  p_expected_department_version integer,
  p_name text default null,
  p_is_active boolean default null,
  p_reason text default null,
  p_idempotency_key uuid default null,
  p_request_fingerprint text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'DEPT_UPDATED';
  v_name text := null;
  v_reason text;
  v_replay jsonb;
  v_dept public.organization_departments%rowtype;
  v_updated public.organization_departments%rowtype;
  v_now timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null or p_expected_department_version is null or p_expected_department_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;

  if p_name is not null then
    v_name := pg_catalog.btrim(p_name);
    if pg_catalog.length(v_name) < 1 or pg_catalog.length(v_name) > 256 or v_name ~ '[\x00-\x1F\x7F]' then
      raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
    end if;
  end if;

  if v_name is null and p_is_active is null then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;

  v_reason := public.org_department__internal_normalize_reason(p_reason);

  -- Check idempotency BEFORE OCC check
  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id
   for update;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_dept.version <> p_expected_department_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_dept.system_key is not null and p_is_active = false then
    raise exception 'DEPARTMENT_SYSTEM_RECORD_IMMUTABLE' using errcode = 'PT409';
  end if;

  if p_is_active = false and (
    exists (
      select 1 from public.organization_person_department_memberships m
       where m.department_id = p_department_id and m.ended_at is null
    )
    or exists (
      select 1 from public.organization_department_heads h
       where h.department_id = p_department_id and h.ended_at is null
    )
    or exists (
      select 1 from public.teams t
       where t.department_id = p_department_id and t.active = true
    )
  ) then
    raise exception 'DEPARTMENT_HAS_ACTIVE_ASSIGNMENTS' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_before := public.org_department__internal_department_projection(v_dept, v_now);

  update public.organization_departments
     set name = coalesce(v_name, v_dept.name),
         is_active = coalesce(p_is_active, v_dept.is_active),
         version = v_dept.version + 1,
         updated_at = v_now
   where department_id = p_department_id
   returning * into v_updated;

  v_after := public.org_department__internal_department_projection(v_updated, v_now);

  insert into public.organization_department_audit_events (
    department_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    v_updated.department_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'department', v_after
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_update_department_admin(uuid, uuid, uuid, integer, text, boolean, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_update_department_admin(uuid, uuid, uuid, integer, text, boolean, text, uuid, text)
  to service_role;

-- =============================================================================
-- 8. Department Person Memberships & Heads RPCs (6 RPCs)
-- =============================================================================
drop function if exists public.org_department_list_person_memberships_admin(uuid, uuid, uuid, text, text, timestamp with time zone, integer, integer);

create or replace function public.org_department_list_person_memberships_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid,
  p_status text default 'active',
  p_search text default null,
  p_as_of timestamp with time zone default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_auth_date date := (v_as_of at time zone 'Asia/Ho_Chi_Minh')::date;
  v_search text := null;
  v_dept public.organization_departments%rowtype;
  v_offset integer;
  v_total integer;
  v_memberships jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null
     or p_status is null or p_status not in ('active', 'ended', 'all')
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'DEPARTMENT_QUERY_INVALID' using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = '' or pg_catalog.length(v_search) > 120 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'DEPARTMENT_SEARCH_INVALID' using errcode = '22023';
    end if;
  end if;

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_offset := (p_page - 1) * p_page_size;

  with filtered as (
    select m as m_row,
           p.full_name,
           p.employee_code,
           (
             m.started_at <= v_as_of
             and (m.ended_at is null or v_as_of < m.ended_at)
             and (m.ended_at is null or m.ended_at > m.started_at)
           ) as is_active_at
      from public.organization_person_department_memberships m
      join public.organization_persons p on p.person_id = m.person_id
     where m.department_id = p_department_id
       and (
         v_search is null
         or p.full_name ilike '%' || v_search || '%'
         or p.employee_code ilike '%' || v_search || '%'
       )
  ),
  status_matched as (
    select *
      from filtered f
     where p_status = 'all'
        or (p_status = 'active' and f.is_active_at)
        or (
          p_status = 'ended'
          and not f.is_active_at
          and (f.m_row).ended_at is not null
          and (f.m_row).ended_at <= v_as_of
        )
  )
  select (select count(*)::integer from status_matched),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      public.org_department__internal_person_membership_projection(s.m_row, v_as_of)
                      order by s.is_active_at desc, pg_catalog.lower(s.full_name) asc, (s.m_row).started_at desc, (s.m_row).membership_id asc
                    )
               from (
                 select sm.*
                   from status_matched sm
                  order by sm.is_active_at desc, pg_catalog.lower(sm.full_name) asc, (sm.m_row).started_at desc, (sm.m_row).membership_id asc
                  limit p_page_size offset v_offset
               ) s
           ),
           '[]'::jsonb
         )
    into v_total, v_memberships;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth_date::text,
    'as_of', public.org_department__internal_iso_utc(v_as_of),
    'department_id', v_dept.department_id,
    'status', p_status,
    'search', v_search,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'memberships', coalesce(v_memberships, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.org_department_list_person_memberships_admin(uuid, uuid, uuid, text, text, timestamp with time zone, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_list_person_memberships_admin(uuid, uuid, uuid, text, text, timestamp with time zone, integer, integer)
  to service_role;

create or replace function public.org_department_assign_person_member_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid,
  p_person_id uuid,
  p_expected_person_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'PERSON_DEPT_ASSIGNED';
  v_reason text;
  v_replay jsonb;
  v_dept public.organization_departments%rowtype;
  v_person public.organization_persons%rowtype;
  v_existing public.organization_person_department_memberships%rowtype;
  v_inserted public.organization_person_department_memberships%rowtype;
  v_now timestamptz;
  v_next_ver integer;
  v_proj jsonb;
  v_result jsonb;
  v_linked_app_user_id uuid;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null or p_person_id is null or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':person:' || p_person_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  perform public.org_department__internal_lock_person(p_person_id);

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id
   for update;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id
   for update;

  if not found then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_person.status <> 'ACTIVE' then
    raise exception 'PERSON_INACTIVE' using errcode = 'PT409';
  end if;

  if not v_dept.is_active then
    raise exception 'DEPARTMENT_INACTIVE' using errcode = 'PT409';
  end if;

  select m.* into v_existing
    from public.organization_person_department_memberships m
   where m.person_id = p_person_id
     and m.ended_at is null
   for update;

  if found then
    raise exception 'PERSON_ALREADY_IN_DEPARTMENT' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  select coalesce(max(m2.version), 0) + 1
    into v_next_ver
    from public.organization_person_department_memberships m2
   where m2.person_id = p_person_id;

  insert into public.organization_person_department_memberships (
    person_id,
    department_id,
    started_at,
    ended_at,
    source_kind,
    version,
    reason,
    created_by_app_user_id,
    created_at,
    updated_at
  )
  values (
    p_person_id,
    p_department_id,
    v_now,
    null,
    'ADMIN_MUTATION',
    v_next_ver,
    v_reason,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_inserted;

  update public.organization_persons
     set version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = p_person_id;

  for v_linked_app_user_id in
    select l.app_user_id
      from public.organization_account_person_links l
     where l.person_id = p_person_id
       and l.ended_at is null
     order by l.app_user_id
  loop
    if v_dept.system_key = 'ACCOUNTING' then
      perform public.org_department__internal_sync_accounting_projection(
        v_linked_app_user_id,
        p_app_user_id,
        v_reason,
        v_now
      );
    end if;
    perform public.org_department__internal_sync_leave_profile_from_org(v_linked_app_user_id, p_app_user_id, v_now);
  end loop;

  v_proj := public.org_department__internal_person_membership_projection(v_inserted, v_now);

  insert into public.organization_department_audit_events (
    department_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_department_id,
    p_person_id,
    p_app_user_id,
    v_action,
    v_reason,
    null,
    v_proj,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'person_version', v_person.version + 1,
    'membership', v_proj
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':person:' || p_person_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_assign_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_assign_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  to service_role;

create or replace function public.org_department_end_person_member_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid,
  p_membership_id uuid,
  p_expected_person_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'PERSON_DEPT_ENDED';
  v_reason text;
  v_replay jsonb;
  v_m_person_id uuid;
  v_m public.organization_person_department_memberships%rowtype;
  v_person public.organization_persons%rowtype;
  v_dept public.organization_departments%rowtype;
  v_ended public.organization_person_department_memberships%rowtype;
  v_now timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_linked_app_user_id uuid;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null or p_membership_id is null or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':membership:' || p_membership_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select m.person_id into v_m_person_id
    from public.organization_person_department_memberships m
   where m.membership_id = p_membership_id
     and m.department_id = p_department_id;

  if not found then
    raise exception 'DEPARTMENT_MEMBERSHIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform public.org_department__internal_lock_person(v_m_person_id);

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id
   for update;

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = v_m_person_id
   for update;

  select m.* into v_m
    from public.organization_person_department_memberships m
   where m.membership_id = p_membership_id
     and m.department_id = p_department_id
   for update;

  if v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_m.ended_at is not null then
    raise exception 'DEPARTMENT_MEMBERSHIP_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from public.organization_department_heads h
     where h.department_id = p_department_id
       and h.person_id = v_person.person_id
       and h.ended_at is null
  ) then
    raise exception 'PERSON_IS_ACTIVE_DEPARTMENT_HEAD' using errcode = 'PT409';
  end if;

  v_now := greatest(pg_catalog.clock_timestamp(), v_m.started_at);
  v_before := public.org_department__internal_person_membership_projection(v_m, v_now);

  update public.organization_person_department_memberships
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_app_user_id,
         version = v_m.version + 1,
         updated_at = v_now
   where membership_id = v_m.membership_id
   returning * into v_ended;

  update public.organization_persons
     set version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = v_person.person_id;

  for v_linked_app_user_id in
    select l.app_user_id
      from public.organization_account_person_links l
     where l.person_id = v_person.person_id
       and l.ended_at is null
     order by l.app_user_id
  loop
    if v_dept.system_key = 'ACCOUNTING' then
      perform public.org_department__internal_sync_accounting_projection(
        v_linked_app_user_id,
        p_app_user_id,
        v_reason,
        v_now
      );
    end if;
    perform public.org_department__internal_sync_leave_profile_from_org(v_linked_app_user_id, p_app_user_id, v_now, true);
  end loop;

  v_after := public.org_department__internal_person_membership_projection(v_ended, v_now);

  insert into public.organization_department_audit_events (
    department_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_department_id,
    v_person.person_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'person_version', v_person.version + 1,
    'membership', v_after
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':membership:' || p_membership_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_end_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_end_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  to service_role;

create or replace function public.org_department_list_department_heads_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid,
  p_include_history boolean default false,
  p_as_of timestamp with time zone default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_auth_date date := (v_as_of at time zone 'Asia/Ho_Chi_Minh')::date;
  v_dept public.organization_departments%rowtype;
  v_offset integer;
  v_total integer;
  v_history jsonb;
  v_active_head jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null
     or p_include_history is null
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'DEPARTMENT_QUERY_INVALID' using errcode = '22023';
  end if;

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_offset := (p_page - 1) * p_page_size;
  v_active_head := public.org_department__internal_department_head_at(p_department_id, v_as_of);

  with matched as (
    select h as h_row,
           (h.started_at <= v_as_of and (h.ended_at is null or v_as_of < h.ended_at) and (h.ended_at is null or h.ended_at > h.started_at)) as is_curr
      from public.organization_department_heads h
     where h.department_id = p_department_id
       and (
         p_include_history
         or (
           h.started_at <= v_as_of
           and (h.ended_at is null or v_as_of < h.ended_at)
           and (h.ended_at is null or h.ended_at > h.started_at)
         )
       )
  )
  select (select count(*)::integer from matched),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      public.org_department__internal_head_projection(s.h_row)
                      order by s.is_curr desc, (s.h_row).started_at desc, (s.h_row).head_assignment_id asc
                    )
               from (
                 select m.*
                   from matched m
                  order by m.is_curr desc, (m.h_row).started_at desc, (m.h_row).head_assignment_id asc
                  limit p_page_size offset v_offset
               ) s
           ),
           '[]'::jsonb
         )
    into v_total, v_history;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth_date::text,
    'as_of', public.org_department__internal_iso_utc(v_as_of),
    'department_id', v_dept.department_id,
    'include_history', p_include_history,
    'active_head', v_active_head,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'history', coalesce(v_history, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.org_department_list_department_heads_admin(uuid, uuid, uuid, boolean, timestamp with time zone, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_list_department_heads_admin(uuid, uuid, uuid, boolean, timestamp with time zone, integer, integer)
  to service_role;

create or replace function public.org_department_designate_head_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid,
  p_person_id uuid,
  p_expected_department_version integer,
  p_expected_current_head_assignment_id uuid default null,
  p_reason text default null,
  p_idempotency_key uuid default null,
  p_request_fingerprint text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'DEPT_HEAD_DESIGNATED';
  v_reason text;
  v_replay jsonb;
  v_dept public.organization_departments%rowtype;
  v_person public.organization_persons%rowtype;
  v_curr_head public.organization_department_heads%rowtype;
  v_replaced_head public.organization_department_heads%rowtype;
  v_new_head public.organization_department_heads%rowtype;
  v_now timestamptz;
  v_before jsonb := null;
  v_after jsonb;
  v_next_ver integer := 1;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null or p_person_id is null or p_expected_department_version is null or p_expected_department_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':head:' || p_person_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  perform public.org_department__internal_lock_person(p_person_id);

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id
   for update;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id
   for update;

  if not found then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  select h.* into v_curr_head
    from public.organization_department_heads h
   where h.department_id = p_department_id
     and h.ended_at is null
   for update;

  if v_dept.version <> p_expected_department_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if not v_dept.is_active then
    raise exception 'DEPARTMENT_INACTIVE' using errcode = 'PT409';
  end if;

  if v_person.status <> 'ACTIVE' then
    raise exception 'PERSON_INACTIVE' using errcode = 'PT409';
  end if;

  if not exists (
    select 1
      from public.organization_person_department_memberships m
     where m.department_id = p_department_id
       and m.person_id = p_person_id
       and m.ended_at is null
  ) then
    raise exception 'PERSON_NOT_ACTIVE_MEMBER_OF_DEPARTMENT' using errcode = 'PT409';
  end if;

  if v_curr_head.head_assignment_id is not null then
    if p_expected_current_head_assignment_id is distinct from v_curr_head.head_assignment_id then
      raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
    end if;
  elsif p_expected_current_head_assignment_id is not null then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  v_now := case
    when v_curr_head.head_assignment_id is null then pg_catalog.clock_timestamp()
    else greatest(pg_catalog.clock_timestamp(), v_curr_head.started_at)
  end;

  if v_curr_head.head_assignment_id is not null then
    v_before := public.org_department__internal_head_projection(v_curr_head);
    update public.organization_department_heads
       set ended_at = v_now,
           ended_reason = v_reason,
           ended_by_app_user_id = p_app_user_id,
           version = v_curr_head.version + 1,
           updated_at = v_now
     where head_assignment_id = v_curr_head.head_assignment_id
     returning * into v_replaced_head;
  end if;

  select coalesce(max(h2.version), 0) + 1
    into v_next_ver
    from public.organization_department_heads h2
   where h2.department_id = p_department_id;

  insert into public.organization_department_heads (
    department_id,
    person_id,
    started_at,
    ended_at,
    source_kind,
    version,
    reason,
    created_by_app_user_id,
    created_at,
    updated_at
  )
  values (
    p_department_id,
    p_person_id,
    v_now,
    null,
    'ADMIN_MUTATION',
    v_next_ver,
    v_reason,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_new_head;

  update public.organization_departments
     set version = v_dept.version + 1,
         updated_at = v_now
   where department_id = p_department_id;

  v_after := public.org_department__internal_head_projection(v_new_head);

  insert into public.organization_department_audit_events (
    department_id,
    target_person_id,
    head_assignment_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_department_id,
    p_person_id,
    v_new_head.head_assignment_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'department_version', v_dept.version + 1,
    'replaced_head', case
      when v_replaced_head.head_assignment_id is null then null
      else pg_catalog.jsonb_build_object(
        'head_assignment_id', v_replaced_head.head_assignment_id,
        'person_id', v_replaced_head.person_id,
        'ended_at', public.org_department__internal_iso_utc(v_replaced_head.ended_at),
        'version', v_replaced_head.version
      )
    end,
    'active_head', v_after
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':head:' || p_person_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_designate_head_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_designate_head_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)
  to service_role;

create or replace function public.org_department_end_head_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid,
  p_expected_department_version integer,
  p_expected_current_head_assignment_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'DEPT_HEAD_ENDED';
  v_reason text;
  v_replay jsonb;
  v_dept public.organization_departments%rowtype;
  v_curr_head public.organization_department_heads%rowtype;
  v_ended public.organization_department_heads%rowtype;
  v_now timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null
     or p_expected_department_version is null or p_expected_department_version < 1
     or p_expected_current_head_assignment_id is null then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':head_end:' || p_expected_current_head_assignment_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id
   for update;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select h.* into v_curr_head
    from public.organization_department_heads h
   where h.department_id = p_department_id
     and h.ended_at is null
   for update;

  if v_dept.version <> p_expected_department_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_curr_head.head_assignment_id is null then
    raise exception 'HEAD_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  if p_expected_current_head_assignment_id is distinct from v_curr_head.head_assignment_id then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  v_now := greatest(pg_catalog.clock_timestamp(), v_curr_head.started_at);
  v_before := public.org_department__internal_head_projection(v_curr_head);

  update public.organization_department_heads
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_app_user_id,
         version = v_curr_head.version + 1,
         updated_at = v_now
   where head_assignment_id = v_curr_head.head_assignment_id
   returning * into v_ended;

  update public.organization_departments
     set version = v_dept.version + 1,
         updated_at = v_now
   where department_id = p_department_id;

  v_after := public.org_department__internal_head_projection(v_ended);

  insert into public.organization_department_audit_events (
    department_id,
    target_person_id,
    head_assignment_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_department_id,
    v_curr_head.person_id,
    v_curr_head.head_assignment_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'department_version', v_dept.version + 1,
    'ended_head', v_after
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':head_end:' || p_expected_current_head_assignment_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_end_head_admin(uuid, uuid, uuid, integer, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_end_head_admin(uuid, uuid, uuid, integer, uuid, text, uuid, text)
  to service_role;

-- =============================================================================
-- 9. Person Directory, Mutation & Department Transfer RPCs (5 RPCs)
-- =============================================================================
create or replace function public.org_department_list_persons_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_status text default 'active',
  p_department_id uuid default null,
  p_link_state text default 'all',
  p_as_of timestamp with time zone default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_auth_date date := (v_as_of at time zone 'Asia/Ho_Chi_Minh')::date;
  v_search text := null;
  v_offset integer;
  v_total integer;
  v_persons jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_status is null or p_status not in ('all', 'active', 'inactive')
     or p_link_state is null or p_link_state not in ('all', 'linked', 'unlinked')
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = '' or pg_catalog.length(v_search) > 100 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
    end if;
  end if;

  v_offset := (p_page - 1) * p_page_size;

  with matched as (
    select p as person_row,
           exists (
             select 1
               from public.organization_account_person_links l
              where l.person_id = p.person_id
                and l.started_at <= v_as_of
                and (l.ended_at is null or v_as_of < l.ended_at)
                and (l.ended_at is null or l.ended_at > l.started_at)
           ) as is_linked,
           (
             select m.department_id
               from public.organization_person_department_memberships m
              where m.person_id = p.person_id
                and m.started_at <= v_as_of
                and (m.ended_at is null or v_as_of < m.ended_at)
                and (m.ended_at is null or m.ended_at > m.started_at)
              order by m.started_at desc, m.membership_id desc
              limit 1
           ) as active_dept_id
      from public.organization_persons p
     where (
         p_status = 'all'
         or (p_status = 'active' and p.status = 'ACTIVE')
         or (p_status = 'inactive' and p.status = 'INACTIVE')
       )
       and (
         v_search is null
         or p.full_name ilike '%' || v_search || '%'
         or p.employee_code ilike '%' || v_search || '%'
         or exists (
           select 1
             from public.organization_account_person_links l2
             join public.direct_entry_app_users u2 on u2.app_user_id = l2.app_user_id
             join auth.users au2 on au2.id = u2.auth_subject
            where l2.person_id = p.person_id
              and l2.started_at <= v_as_of
              and (l2.ended_at is null or v_as_of < l2.ended_at)
              and pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au2)->>'email', ''), '@', 1) ilike '%' || v_search || '%'
         )
       )
  ),
  filtered as (
    select *
      from matched m
     where (p_department_id is null or m.active_dept_id = p_department_id)
       and (
         p_link_state = 'all'
         or (p_link_state = 'linked' and m.is_linked)
         or (p_link_state = 'unlinked' and not m.is_linked)
       )
  )
  select (select count(*)::integer from filtered),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      public.org_department__internal_person_summary_projection(s.person_row, v_as_of)
                      order by pg_catalog.lower((s.person_row).full_name) asc, (s.person_row).employee_code asc, (s.person_row).person_id asc
                    )
               from (
                 select f.*
                   from filtered f
                  order by pg_catalog.lower((f.person_row).full_name) asc, (f.person_row).employee_code asc, (f.person_row).person_id asc
                  limit p_page_size offset v_offset
               ) s
           ),
           '[]'::jsonb
         )
    into v_total, v_persons;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth_date::text,
    'as_of', public.org_department__internal_iso_utc(v_as_of),
    'search', v_search,
    'status', p_status,
    'department_id', p_department_id,
    'link_state', p_link_state,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'persons', coalesce(v_persons, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.org_department_list_persons_admin(uuid, uuid, text, text, uuid, text, timestamp with time zone, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_list_persons_admin(uuid, uuid, text, text, uuid, text, timestamp with time zone, integer, integer)
  to service_role;

create or replace function public.org_department_get_person_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_person_id uuid,
  p_as_of timestamp with time zone default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_auth_date date := (v_as_of at time zone 'Asia/Ho_Chi_Minh')::date;
  v_person public.organization_persons%rowtype;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_person_id is null then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id;

  if not found then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth_date::text,
    'as_of', public.org_department__internal_iso_utc(v_as_of),
    'person', public.org_department__internal_person_detail_projection(v_person, v_as_of)
  );
end;
$function$;

revoke all on function public.org_department_get_person_admin(uuid, uuid, uuid, timestamp with time zone)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_get_person_admin(uuid, uuid, uuid, timestamp with time zone)
  to service_role;

create or replace function public.org_department_create_person_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_employee_code text,
  p_full_name text,
  p_joined_on date default null,
  p_initial_department_id uuid default null,
  p_account_ref uuid default null,
  p_expected_account_version integer default null,
  p_recruiter_id uuid default null,
  p_reason text default null,
  p_idempotency_key uuid default null,
  p_request_fingerprint text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'PERSON_CREATED';
  v_code text;
  v_name text;
  v_reason text;
  v_replay jsonb;
  v_dept public.organization_departments%rowtype;
  v_account public.direct_entry_app_users%rowtype;
  v_recruiter public.recruiters%rowtype;
  v_acct_recruiter_id uuid := null;
  v_resolved_recruiter_id uuid := p_recruiter_id;
  v_person public.organization_persons%rowtype;
  v_now timestamptz;
  v_reason_id uuid;
  v_prev_display_name text;
  v_proj jsonb;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  v_code := pg_catalog.btrim(coalesce(p_employee_code, ''));
  v_name := pg_catalog.btrim(coalesce(p_full_name, ''));
  if pg_catalog.length(v_code) < 2 or pg_catalog.length(v_code) > 64 or v_code ~ '[\x00-\x1F\x7F]' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_code ~* '^hrp-[0-9]{4}-[0-9]{6}$' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if pg_catalog.length(v_name) < 1 or pg_catalog.length(v_name) > 160 or v_name ~ '[\x00-\x1F\x7F]' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  if p_account_ref is not null and (p_expected_account_version is null or p_expected_account_version < 1) then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:create:' || pg_catalog.lower(v_code),
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Lock order (§4.2): departments -> persons -> direct_entry_app_users -> recruiters
  if p_initial_department_id is not null then
    select d.* into v_dept
      from public.organization_departments d
     where d.department_id = p_initial_department_id
     for update;
    if not found then
      raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
    end if;
    if not v_dept.is_active then
      raise exception 'DEPARTMENT_INACTIVE' using errcode = 'PT409';
    end if;
  end if;

  if p_account_ref is not null then
    select u.* into v_account
      from public.direct_entry_app_users u
     where u.app_user_id = p_account_ref
     for update;
    if not found then
      raise exception 'TARGET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_account.version <> p_expected_account_version then
      raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
    end if;
    if v_account.account_type in ('SHARED', 'SERVICE') then
      raise exception 'ACCOUNT_TYPE_LINK_FORBIDDEN' using errcode = 'PT409';
    end if;
    if exists (
      select 1 from public.organization_account_person_links l
       where l.app_user_id = p_account_ref
         and l.ended_at is null
    ) then
      raise exception 'ACCOUNT_OR_PERSON_ALREADY_LINKED' using errcode = 'PT409';
    end if;

    select rl.recruiter_id
      into v_acct_recruiter_id
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = p_account_ref
       and rl.verified = true
       and rl.is_current = true
     order by rl.valid_from desc, rl.link_id desc
     limit 1;

    if v_acct_recruiter_id is not null and p_recruiter_id is not null and v_acct_recruiter_id <> p_recruiter_id then
      raise exception 'RECRUITER_LINK_MISMATCH' using errcode = 'PT409';
    end if;
    if v_resolved_recruiter_id is null and v_acct_recruiter_id is not null then
      v_resolved_recruiter_id := v_acct_recruiter_id;
    end if;
  end if;

  if v_resolved_recruiter_id is not null then
    select r.* into v_recruiter
      from public.recruiters r
     where r.recruiter_id = v_resolved_recruiter_id
     for update;
    if not found then
      raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
    end if;
    if exists (select 1 from public.organization_persons p where p.recruiter_id = v_resolved_recruiter_id) then
      raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
    end if;
    if exists (
      select 1
        from public.direct_entry_app_user_recruiter_links rl
       where rl.recruiter_id = v_resolved_recruiter_id
         and rl.verified = true
         and rl.is_current = true
         and (p_account_ref is null or rl.app_user_id <> p_account_ref)
    ) then
      raise exception 'RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT' using errcode = 'PT409';
    end if;
  end if;

  if exists (
    select 1 from public.organization_persons p
     where pg_catalog.lower(p.employee_code) = pg_catalog.lower(v_code)
  ) then
    raise exception 'DUPLICATE_CODE' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  insert into public.organization_persons (
    employee_code,
    full_name,
    joined_on,
    status,
    recruiter_id,
    version,
    created_by_app_user_id,
    updated_by_app_user_id,
    created_at,
    updated_at
  )
  values (
    v_code,
    v_name,
    p_joined_on,
    'ACTIVE',
    v_resolved_recruiter_id,
    1,
    p_app_user_id,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_person;

  if p_initial_department_id is not null then
    insert into public.organization_person_department_memberships (
      person_id,
      department_id,
      started_at,
      ended_at,
      source_kind,
      version,
      reason,
      created_by_app_user_id,
      created_at,
      updated_at
    )
    values (
      v_person.person_id,
      p_initial_department_id,
      v_now,
      null,
      'ADMIN_MUTATION',
      1,
      v_reason,
      p_app_user_id,
      v_now,
      v_now
    );
  end if;

  if v_resolved_recruiter_id is not null and v_recruiter.display_name is distinct from v_person.full_name then
    v_reason_id := coalesce(v_reason_id, public.direct_entry_reason(p_app_user_id, v_reason));
    update public.recruiters
       set display_name = v_person.full_name
     where recruiter_id = v_resolved_recruiter_id;

    perform public.direct_entry_bump_personnel_version(
      v_resolved_recruiter_id,
      p_app_user_id,
      v_reason_id,
      public.direct_entry_personnel_snapshot(v_recruiter),
      pg_catalog.jsonb_set(
        public.direct_entry_personnel_snapshot(v_recruiter),
        '{display_name}',
        pg_catalog.to_jsonb(v_person.full_name),
        true
      )
    );
  end if;

  if p_account_ref is not null then
    insert into public.organization_account_person_links (
      app_user_id,
      person_id,
      started_at,
      source_kind,
      version,
      reason,
      created_by_app_user_id,
      created_at,
      updated_at
    )
    values (
      p_account_ref,
      v_person.person_id,
      v_now,
      'ADMIN_MUTATION',
      1,
      v_reason,
      p_app_user_id,
      v_now,
      v_now
    );

    v_prev_display_name := v_account.display_name;
    v_reason_id := coalesce(v_reason_id, public.direct_entry_reason(p_app_user_id, v_reason));

    update public.direct_entry_app_users
       set display_name = v_person.full_name,
           version = v_account.version + 1,
           updated_at = v_now
     where app_user_id = p_account_ref
     returning * into v_account;

    if v_prev_display_name is distinct from v_person.full_name then
      insert into public.direct_entry_app_user_revisions (
        app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
      )
      values (
        p_account_ref,
        v_account.version,
        p_app_user_id,
        'display_name_update',
        pg_catalog.jsonb_build_object('display_name', v_prev_display_name),
        pg_catalog.jsonb_build_object('display_name', v_person.full_name),
        v_reason_id
      );
    else
      insert into public.direct_entry_app_user_revisions (
        app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
      )
      values (
        p_account_ref,
        v_account.version,
        p_app_user_id,
        'link_create',
        pg_catalog.jsonb_build_object('person_id', null),
        pg_catalog.jsonb_build_object('person_id', v_person.person_id),
        v_reason_id
      );
    end if;

    perform public.org_department__internal_sync_accounting_projection(
      p_account_ref,
      p_app_user_id,
      v_reason,
      v_now
    );

    perform public.org_department__internal_sync_leave_profile_from_org(
      p_account_ref,
      p_app_user_id,
      v_now,
      false
    );
  end if;

  v_proj := public.org_department__internal_person_detail_projection(v_person, v_now);

  insert into public.organization_department_audit_events (
    department_id,
    target_app_user_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_initial_department_id,
    p_account_ref,
    v_person.person_id,
    p_app_user_id,
    v_action,
    v_reason,
    null,
    v_proj,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'person', v_proj
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:create:' || pg_catalog.lower(v_code),
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_create_person_admin(uuid, uuid, text, text, date, uuid, uuid, integer, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_create_person_admin(uuid, uuid, text, text, date, uuid, uuid, integer, uuid, text, uuid, text)
  to service_role;

create or replace function public.org_department_update_person_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_person_id uuid,
  p_expected_person_version integer,
  p_employee_code text,
  p_full_name text,
  p_joined_on date,
  p_status text,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'PERSON_UPDATED';
  v_code text;
  v_name text;
  v_reason text;
  v_replay jsonb;
  v_person public.organization_persons%rowtype;
  v_updated public.organization_persons%rowtype;
  v_now timestamptz;
  v_reason_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_acc_row public.direct_entry_app_users%rowtype;
  v_rec_row public.recruiters%rowtype;
  v_prev_name text;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_person_id is null or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;

  v_code := pg_catalog.btrim(coalesce(p_employee_code, ''));
  v_name := pg_catalog.btrim(coalesce(p_full_name, ''));
  if pg_catalog.length(v_code) < 2 or pg_catalog.length(v_code) > 64 or v_code ~ '[\x00-\x1F\x7F]' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_code ~* '^hrp-[0-9]{4}-[0-9]{6}$' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if pg_catalog.length(v_name) < 1 or pg_catalog.length(v_name) > 160 or v_name ~ '[\x00-\x1F\x7F]' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('ACTIVE', 'INACTIVE') then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:' || p_person_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  perform public.org_department__internal_lock_person(p_person_id);

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id
   for update;

  if not found then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from public.organization_persons p2
     where pg_catalog.lower(p2.employee_code) = pg_catalog.lower(v_code)
       and p2.person_id <> p_person_id
  ) then
    raise exception 'DUPLICATE_CODE' using errcode = 'PT409';
  end if;

  if p_status = 'INACTIVE' and exists (
    select 1 from public.organization_department_heads h
     where h.person_id = p_person_id
       and h.ended_at is null
  ) then
    raise exception 'PERSON_IS_ACTIVE_DEPARTMENT_HEAD' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_before := public.org_department__internal_person_detail_projection(v_person, v_now);

  update public.organization_persons
     set employee_code = v_code,
         full_name = v_name,
         joined_on = p_joined_on,
         status = p_status,
         deactivated_at = case
           when p_status = 'INACTIVE' then coalesce(v_person.deactivated_at, v_now)
           else null
         end,
         deactivated_by_user_id = case
           when p_status = 'INACTIVE' then coalesce(v_person.deactivated_by_user_id, p_app_user_id)
           else null
         end,
         deactivate_reason = case
           when p_status = 'INACTIVE' then coalesce(v_person.deactivate_reason, v_reason)
           else null
         end,
         version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = p_person_id
   returning * into v_updated;

  -- Lock order (§4.2): persons -> direct_entry_app_users -> recruiters
  for v_acc_row in
    select u.*
      from public.direct_entry_app_users u
     where exists (
       select 1
         from public.organization_account_person_links l
        where l.person_id = p_person_id
          and l.app_user_id = u.app_user_id
          and l.ended_at is null
     )
     order by u.app_user_id
     for update
  loop
    if v_updated.full_name is distinct from v_acc_row.display_name then
      v_prev_name := v_acc_row.display_name;
      v_reason_id := coalesce(v_reason_id, public.direct_entry_reason(p_app_user_id, v_reason));

      update public.direct_entry_app_users
         set display_name = v_updated.full_name,
             version = v_acc_row.version + 1,
             updated_at = v_now
       where app_user_id = v_acc_row.app_user_id;

      insert into public.direct_entry_app_user_revisions (
        app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
      )
      values (
        v_acc_row.app_user_id,
        v_acc_row.version + 1,
        p_app_user_id,
        'display_name_update',
        pg_catalog.jsonb_build_object('display_name', v_prev_name),
        pg_catalog.jsonb_build_object('display_name', v_updated.full_name),
        v_reason_id
      );
    end if;

    perform public.org_department__internal_sync_leave_profile_from_org(
      v_acc_row.app_user_id,
      p_app_user_id,
      v_now,
      false
    );
  end loop;

  if v_updated.full_name is distinct from v_person.full_name then
    for v_rec_row in
      select r.*
        from public.recruiters r
       where (
         v_updated.recruiter_id = r.recruiter_id
         or exists (
           select 1
             from public.organization_account_person_links l
             join public.direct_entry_app_user_recruiter_links rl
               on rl.app_user_id = l.app_user_id
              and rl.verified = true
              and rl.is_current = true
            where l.person_id = p_person_id
              and l.ended_at is null
              and rl.recruiter_id = r.recruiter_id
         )
       )
       order by r.recruiter_id
       for update
    loop
      if v_rec_row.display_name is distinct from v_updated.full_name then
        v_reason_id := coalesce(v_reason_id, public.direct_entry_reason(p_app_user_id, v_reason));
        update public.recruiters
           set display_name = v_updated.full_name
         where recruiter_id = v_rec_row.recruiter_id;

        perform public.direct_entry_bump_personnel_version(
          v_rec_row.recruiter_id,
          p_app_user_id,
          v_reason_id,
          public.direct_entry_personnel_snapshot(v_rec_row),
          pg_catalog.jsonb_set(
            public.direct_entry_personnel_snapshot(v_rec_row),
            '{display_name}',
            pg_catalog.to_jsonb(v_updated.full_name),
            true
          )
        );
      end if;
    end loop;
  end if;

  v_after := public.org_department__internal_person_detail_projection(v_updated, v_now);

  insert into public.organization_department_audit_events (
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_person_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'person', v_after
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:' || p_person_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_update_person_admin(uuid, uuid, uuid, integer, text, text, date, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_update_person_admin(uuid, uuid, uuid, integer, text, text, date, text, text, uuid, text)
  to service_role;

create or replace function public.org_department_transfer_person_member_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_person_id uuid,
  p_target_department_id uuid,
  p_expected_person_version integer,
  p_expected_current_membership_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'PERSON_DEPT_TRANSFERRED';
  v_reason text;
  v_replay jsonb;
  v_curr_dept_id uuid;
  v_lock_dept public.organization_departments%rowtype;
  v_person public.organization_persons%rowtype;
  v_to_dept public.organization_departments%rowtype;
  v_from_dept public.organization_departments%rowtype;
  v_curr_m public.organization_person_department_memberships%rowtype;
  v_closed_m public.organization_person_department_memberships%rowtype;
  v_new_m public.organization_person_department_memberships%rowtype;
  v_now timestamptz;
  v_before jsonb;
  v_active_proj jsonb;
  v_next_ver integer;
  v_result jsonb;
  v_acc_row public.direct_entry_app_users%rowtype;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_person_id is null
     or p_target_department_id is null
     or p_expected_person_version is null or p_expected_person_version < 1
     or p_expected_current_membership_id is null then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:' || p_person_id::text || ':transfer:' || p_target_department_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Lock order (§4.2): advisory person lock -> departments (ORDER BY department_id) -> person -> membership -> accounts
  perform public.org_department__internal_lock_person(p_person_id);

  select m.department_id
    into v_curr_dept_id
    from public.organization_person_department_memberships m
   where m.person_id = p_person_id
     and m.ended_at is null
   limit 1;

  for v_lock_dept in
    select d.*
      from public.organization_departments d
     where d.department_id = p_target_department_id
        or (v_curr_dept_id is not null and d.department_id = v_curr_dept_id)
     order by d.department_id
     for update
  loop
    if v_lock_dept.department_id = p_target_department_id then
      v_to_dept := v_lock_dept;
    end if;
    if v_curr_dept_id is not null and v_lock_dept.department_id = v_curr_dept_id then
      v_from_dept := v_lock_dept;
    end if;
  end loop;

  if v_to_dept.department_id is null then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id
   for update;

  if not found then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  select m.* into v_curr_m
    from public.organization_person_department_memberships m
   where m.person_id = p_person_id
     and m.ended_at is null
   for update;

  if v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if not found or v_curr_m.membership_id is distinct from p_expected_current_membership_id then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_person.status <> 'ACTIVE' then
    raise exception 'PERSON_INACTIVE' using errcode = 'PT409';
  end if;

  if not v_to_dept.is_active then
    raise exception 'DEPARTMENT_INACTIVE' using errcode = 'PT409';
  end if;

  if v_curr_m.department_id = p_target_department_id then
    raise exception 'SAME_TARGET_DEPARTMENT' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from public.organization_department_heads h
     where h.department_id = v_curr_m.department_id
       and h.person_id = p_person_id
       and h.ended_at is null
  ) then
    raise exception 'PERSON_IS_ACTIVE_DEPARTMENT_HEAD' using errcode = 'PT409';
  end if;

  v_now := greatest(pg_catalog.clock_timestamp(), v_curr_m.started_at);
  v_before := public.org_department__internal_person_membership_projection(v_curr_m, v_now);

  update public.organization_person_department_memberships
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_app_user_id,
         version = v_curr_m.version + 1,
         updated_at = v_now
   where membership_id = v_curr_m.membership_id
   returning * into v_closed_m;

  select coalesce(max(m2.version), 0) + 1
    into v_next_ver
    from public.organization_person_department_memberships m2
   where m2.person_id = p_person_id;

  insert into public.organization_person_department_memberships (
    person_id,
    department_id,
    started_at,
    ended_at,
    source_kind,
    version,
    reason,
    created_by_app_user_id,
    created_at,
    updated_at
  )
  values (
    p_person_id,
    p_target_department_id,
    v_now,
    null,
    'ADMIN_MUTATION',
    v_next_ver,
    v_reason,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_new_m;

  update public.organization_persons
     set version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = p_person_id;

  for v_acc_row in
    select u.*
      from public.direct_entry_app_users u
     where exists (
       select 1
         from public.organization_account_person_links l
        where l.person_id = p_person_id
          and l.app_user_id = u.app_user_id
          and l.ended_at is null
     )
     order by u.app_user_id
     for update
  loop
    perform public.org_department__internal_sync_accounting_projection(
      v_acc_row.app_user_id,
      p_app_user_id,
      v_reason,
      v_now
    );

    perform public.org_department__internal_sync_leave_profile_from_org(
      v_acc_row.app_user_id,
      p_app_user_id,
      v_now,
      false
    );
  end loop;

  v_active_proj := pg_catalog.jsonb_build_object(
    'membership_id', v_new_m.membership_id,
    'department_id', v_to_dept.department_id,
    'system_key', v_to_dept.system_key,
    'code', v_to_dept.code,
    'name', v_to_dept.name,
    'started_at', public.org_department__internal_iso_utc(v_new_m.started_at),
    'ended_at', null,
    'source_kind', v_new_m.source_kind,
    'evidence_date', null,
    'version', v_new_m.version
  );

  insert into public.organization_department_audit_events (
    department_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_target_department_id,
    p_person_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_active_proj,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'person_version', v_person.version + 1,
    'closed_membership', pg_catalog.jsonb_build_object(
      'membership_id', v_closed_m.membership_id,
      'department_id', v_closed_m.department_id,
      'started_at', public.org_department__internal_iso_utc(v_closed_m.started_at),
      'ended_at', public.org_department__internal_iso_utc(v_closed_m.ended_at),
      'version', v_closed_m.version
    ),
    'active_membership', v_active_proj
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:' || p_person_id::text || ':transfer:' || p_target_department_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_transfer_person_member_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_transfer_person_member_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)
  to service_role;

-- =============================================================================
-- 10. Account Classification & Account-Person Link RPCs (3 RPCs)
-- =============================================================================
create or replace function public.org_department_set_account_type_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_account_type text,
  p_expected_account_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'ACCOUNT_TYPE_UPDATED';
  v_reason text;
  v_replay jsonb;
  v_account public.direct_entry_app_users%rowtype;
  v_updated public.direct_entry_app_users%rowtype;
  v_now timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_target_app_user_id is null
     or p_account_type is null or p_account_type not in ('NORMAL', 'SHARED', 'SERVICE')
     or p_expected_account_version is null or p_expected_account_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'account:' || p_target_app_user_id::text || ':classification',
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id
   for update;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_account.version <> p_expected_account_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  if p_account_type in ('SHARED', 'SERVICE') then
    if exists (
      select 1 from public.organization_account_person_links l
       where l.app_user_id = p_target_app_user_id
         and l.ended_at is null
    ) or exists (
      select 1 from public.organization_department_memberships lm
       where lm.app_user_id = p_target_app_user_id
         and lm.valid_to is null
    ) or exists (
      select 1 from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = p_target_app_user_id
         and rl.verified = true
         and rl.is_current = true
    ) or exists (
      select 1 from public.direct_entry_team_leader_assignments tla
       where tla.leader_app_user_id = p_target_app_user_id
         and tla.is_current = true
    ) or exists (
      select 1 from public.leave_department_approvers lda
       where lda.approver_app_user_id = p_target_app_user_id
         and lda.is_current = true
    ) or exists (
      select 1 from public.work_report_delegations wrd
       where (wrd.grantor_user_id = p_target_app_user_id or wrd.delegate_app_user_id = p_target_app_user_id)
         and wrd.is_current = true
         and wrd.state = 'ACTIVE'
         and wrd.effective_to > v_now
    ) then
      raise exception 'ACCOUNT_HAS_PERSON_OR_PERSONAL_ASSIGNMENTS' using errcode = 'PT409';
    end if;
  end if;

  v_before := public.direct_entry_app_user_projection(v_account);

  update public.direct_entry_app_users
     set account_type = p_account_type,
         version = v_account.version + 1,
         updated_at = v_now
   where app_user_id = p_target_app_user_id
   returning * into v_updated;

  perform public.org_department__internal_sync_leave_profile_from_org(
    p_target_app_user_id,
    p_app_user_id,
    v_now,
    true
  );

  v_after := public.direct_entry_app_user_projection(v_updated);

  insert into public.organization_department_audit_events (
    target_app_user_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_target_app_user_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'account', pg_catalog.jsonb_build_object(
      'account_ref', v_updated.app_user_id,
      'account_type', v_updated.account_type,
      'version', v_updated.version
    )
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'account:' || p_target_app_user_id::text || ':classification',
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_set_account_type_admin(uuid, uuid, uuid, text, integer, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_set_account_type_admin(uuid, uuid, uuid, text, integer, text, uuid, text)
  to service_role;

create or replace function public.org_department_link_account_person_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_person_id uuid,
  p_expected_account_version integer,
  p_expected_person_version integer,
  p_confirmed_recruiter_id uuid default null,
  p_reason text default null,
  p_idempotency_key uuid default null,
  p_request_fingerprint text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'ACCOUNT_PERSON_LINKED';
  v_reason text;
  v_replay jsonb;
  v_account public.direct_entry_app_users%rowtype;
  v_person public.organization_persons%rowtype;
  v_recruiter public.recruiters%rowtype;
  v_acct_recruiter_id uuid := null;
  v_effective_recruiter_id uuid := null;
  v_new_link public.organization_account_person_links%rowtype;
  v_updated_account public.direct_entry_app_users%rowtype;
  v_updated_person public.organization_persons%rowtype;
  v_now timestamptz;
  v_reason_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_next_ver integer := 1;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_target_app_user_id is null
     or p_person_id is null
     or p_expected_account_version is null or p_expected_account_version < 1
     or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'account:' || p_target_app_user_id::text || ':person_link:' || p_person_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Lock order (§4.2): advisory person lock -> person -> account -> recruiter
  perform public.org_department__internal_lock_person(p_person_id);

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id
   for update;

  if not found then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id
   for update;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_account.version <> p_expected_account_version
     or v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_account.account_type in ('SHARED', 'SERVICE') then
    raise exception 'ACCOUNT_TYPE_LINK_FORBIDDEN' using errcode = 'PT409';
  end if;

  if v_person.status <> 'ACTIVE' then
    raise exception 'PERSON_INACTIVE' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from public.organization_account_person_links l
     where (l.app_user_id = p_target_app_user_id or l.person_id = p_person_id)
       and l.ended_at is null
  ) then
    raise exception 'ACCOUNT_OR_PERSON_ALREADY_LINKED' using errcode = 'PT409';
  end if;

  select rl.recruiter_id
    into v_acct_recruiter_id
    from public.direct_entry_app_user_recruiter_links rl
   where rl.app_user_id = p_target_app_user_id
     and rl.verified = true
     and rl.is_current = true
   order by rl.valid_from desc, rl.link_id desc
   limit 1;

  -- R-INV-2 exact validation order
  if v_acct_recruiter_id is not null and v_person.recruiter_id is not null and v_acct_recruiter_id <> v_person.recruiter_id then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  if v_acct_recruiter_id is not null and v_person.recruiter_id is null then
    if exists (
      select 1 from public.organization_persons p2
       where p2.recruiter_id = v_acct_recruiter_id
         and p2.person_id <> p_person_id
    ) then
      raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
    end if;
    if p_confirmed_recruiter_id is distinct from v_acct_recruiter_id then
      raise exception 'RECRUITER_LINK_MISMATCH' using errcode = 'PT409';
    end if;
  end if;

  v_effective_recruiter_id := coalesce(v_person.recruiter_id, v_acct_recruiter_id);

  if p_confirmed_recruiter_id is not null and v_effective_recruiter_id is distinct from p_confirmed_recruiter_id then
    raise exception 'RECRUITER_LINK_MISMATCH' using errcode = 'PT409';
  end if;

  if v_effective_recruiter_id is not null then
    select r.* into v_recruiter
      from public.recruiters r
     where r.recruiter_id = v_effective_recruiter_id
     for update;

    if exists (
      select 1
        from public.direct_entry_app_user_recruiter_links rl2
       where rl2.recruiter_id = v_effective_recruiter_id
         and rl2.verified = true
         and rl2.is_current = true
         and rl2.app_user_id <> p_target_app_user_id
    ) then
      raise exception 'RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT' using errcode = 'PT409';
    end if;
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_before := pg_catalog.jsonb_build_object(
    'account', public.direct_entry_app_user_projection(v_account),
    'person', public.org_department__internal_person_summary_projection(v_person, v_now)
  );

  select coalesce(max(l2.version), 0) + 1
    into v_next_ver
    from public.organization_account_person_links l2
   where l2.person_id = p_person_id;

  insert into public.organization_account_person_links (
    app_user_id,
    person_id,
    started_at,
    ended_at,
    source_kind,
    version,
    reason,
    created_by_app_user_id,
    created_at,
    updated_at
  )
  values (
    p_target_app_user_id,
    p_person_id,
    v_now,
    null,
    'ADMIN_MUTATION',
    v_next_ver,
    v_reason,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_new_link;

  v_reason_id := public.direct_entry_reason(p_app_user_id, v_reason);

  update public.direct_entry_app_users
     set display_name = v_person.full_name,
         version = v_account.version + 1,
         updated_at = v_now
   where app_user_id = p_target_app_user_id
   returning * into v_updated_account;

  if v_account.display_name is distinct from v_person.full_name then
    insert into public.direct_entry_app_user_revisions (
      app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
    )
    values (
      p_target_app_user_id,
      v_updated_account.version,
      p_app_user_id,
      'display_name_update',
      pg_catalog.jsonb_build_object('display_name', v_account.display_name),
      pg_catalog.jsonb_build_object('display_name', v_person.full_name),
      v_reason_id
    );
  else
    insert into public.direct_entry_app_user_revisions (
      app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
    )
    values (
      p_target_app_user_id,
      v_updated_account.version,
      p_app_user_id,
      'link_create',
      pg_catalog.jsonb_build_object('person_id', null),
      pg_catalog.jsonb_build_object('person_id', p_person_id),
      v_reason_id
    );
  end if;

  update public.organization_persons
     set recruiter_id = v_effective_recruiter_id,
         version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = p_person_id
   returning * into v_updated_person;

  if v_effective_recruiter_id is not null and v_recruiter.display_name is distinct from v_person.full_name then
    update public.recruiters
       set display_name = v_person.full_name
     where recruiter_id = v_effective_recruiter_id;

    perform public.direct_entry_bump_personnel_version(
      v_effective_recruiter_id,
      p_app_user_id,
      v_reason_id,
      public.direct_entry_personnel_snapshot(v_recruiter),
      pg_catalog.jsonb_set(
        public.direct_entry_personnel_snapshot(v_recruiter),
        '{display_name}',
        pg_catalog.to_jsonb(v_person.full_name),
        true
      )
    );
  end if;

  perform public.org_department__internal_sync_accounting_projection(
    p_target_app_user_id,
    p_app_user_id,
    v_reason,
    v_now
  );
  perform public.org_department__internal_sync_leave_profile_from_org(
    p_target_app_user_id,
    p_app_user_id,
    v_now,
    false
  );

  v_after := pg_catalog.jsonb_build_object(
    'account', public.direct_entry_app_user_projection(v_updated_account),
    'person', public.org_department__internal_person_summary_projection(v_updated_person, v_now)
  );

  insert into public.organization_department_audit_events (
    target_app_user_id,
    target_person_id,
    link_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_target_app_user_id,
    p_person_id,
    v_new_link.link_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'account_version', v_updated_account.version,
    'person_version', v_updated_person.version,
    'link', pg_catalog.jsonb_build_object(
      'link_id', v_new_link.link_id,
      'account_ref', p_target_app_user_id,
      'person_id', p_person_id,
      'employee_code', v_updated_person.employee_code,
      'full_name', v_updated_person.full_name,
      'started_at', public.org_department__internal_iso_utc(v_new_link.started_at),
      'source_kind', v_new_link.source_kind,
      'evidence_date', null,
      'version', v_new_link.version
    )
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'account:' || p_target_app_user_id::text || ':person_link:' || p_person_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_link_account_person_admin(uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_link_account_person_admin(uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)
  to service_role;

create or replace function public.org_department_unlink_account_person_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_account_version integer,
  p_expected_person_version integer,
  p_expected_link_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'ACCOUNT_PERSON_UNLINKED';
  v_reason text;
  v_replay jsonb;
  v_link_person_id uuid;
  v_account public.direct_entry_app_users%rowtype;
  v_link public.organization_account_person_links%rowtype;
  v_ended_link public.organization_account_person_links%rowtype;
  v_person public.organization_persons%rowtype;
  v_updated_account public.direct_entry_app_users%rowtype;
  v_updated_person public.organization_persons%rowtype;
  v_now timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_target_app_user_id is null
     or p_expected_account_version is null or p_expected_account_version < 1
     or p_expected_person_version is null or p_expected_person_version < 1
     or p_expected_link_id is null then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'account:' || p_target_app_user_id::text || ':person_unlink',
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Lock order (§4.2): advisory person lock -> person -> account -> link
  select l.person_id
    into v_link_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_target_app_user_id
     and l.ended_at is null
   limit 1;

  if v_link_person_id is not null then
    perform public.org_department__internal_lock_person(v_link_person_id);

    select p.* into v_person
      from public.organization_persons p
     where p.person_id = v_link_person_id
     for update;
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id
   for update;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select l.* into v_link
    from public.organization_account_person_links l
   where l.app_user_id = p_target_app_user_id
     and l.ended_at is null
   for update;

  if not found then
    raise exception 'LINK_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  if v_person.person_id is null or v_person.person_id <> v_link.person_id then
    perform public.org_department__internal_lock_person(v_link.person_id);
    select p.* into v_person
      from public.organization_persons p
     where p.person_id = v_link.person_id
     for update;
  end if;

  if v_account.version <> p_expected_account_version
     or v_person.version <> p_expected_person_version
     or p_expected_link_id is distinct from v_link.link_id then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  v_now := greatest(pg_catalog.clock_timestamp(), v_link.started_at);
  v_before := pg_catalog.jsonb_build_object(
    'account', public.direct_entry_app_user_projection(v_account),
    'person', public.org_department__internal_person_summary_projection(v_person, v_now)
  );

  update public.organization_account_person_links
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_app_user_id,
         version = v_link.version + 1,
         updated_at = v_now
   where link_id = v_link.link_id
   returning * into v_ended_link;

  update public.direct_entry_app_users
     set version = v_account.version + 1,
         updated_at = v_now
   where app_user_id = p_target_app_user_id
   returning * into v_updated_account;

  update public.organization_persons
     set version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = v_person.person_id
   returning * into v_updated_person;

  perform public.org_department__internal_sync_accounting_projection(
    p_target_app_user_id,
    p_app_user_id,
    v_reason,
    v_now
  );
  perform public.org_department__internal_sync_leave_profile_from_org(
    p_target_app_user_id,
    p_app_user_id,
    v_now,
    true
  );

  v_after := pg_catalog.jsonb_build_object(
    'account', public.direct_entry_app_user_projection(v_updated_account),
    'person', public.org_department__internal_person_summary_projection(v_updated_person, v_now)
  );

  insert into public.organization_department_audit_events (
    target_app_user_id,
    target_person_id,
    link_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_target_app_user_id,
    v_person.person_id,
    v_link.link_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'account_version', v_updated_account.version,
    'person_version', v_updated_person.version,
    'ended_link', pg_catalog.jsonb_build_object(
      'link_id', v_ended_link.link_id,
      'account_ref', p_target_app_user_id,
      'person_id', v_person.person_id,
      'started_at', public.org_department__internal_iso_utc(v_ended_link.started_at),
      'ended_at', public.org_department__internal_iso_utc(v_ended_link.ended_at),
      'version', v_ended_link.version
    )
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'account:' || p_target_app_user_id::text || ':person_unlink',
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_unlink_account_person_admin(uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_unlink_account_person_admin(uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)
  to service_role;

-- =============================================================================
-- 10B. Legacy Writer Bidirectional Sync & Serialization (7 Functions)
-- =============================================================================

-- 10B.1 direct_entry_create_team: bind new non-vendor teams to RECRUITMENT department
create or replace function public.direct_entry_create_team(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_code text,
  p_display_name text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_code text;
  v_display text;
  v_reason_id uuid;
  v_rec_dept_id uuid;
  v_team public.teams;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_expected_version is distinct from 0 then
    raise exception 'create expected version must be zero' using errcode = '22023';
  end if;
  if p_code is null or btrim(p_code) = '' then
    raise exception 'team code required' using errcode = '22023';
  end if;
  v_code := btrim(p_code);
  if length(v_code) > 128 or v_code ~ '[[:space:][:cntrl:]]' then
    raise exception 'team code is not canonical' using errcode = '22023';
  end if;
  if v_code = '__system_vendor__' then
    raise exception 'team code is reserved' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'team display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'code', v_code,
      'display_name', v_display
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  select d.department_id
    into v_rec_dept_id
    from public.organization_departments d
   where d.system_key = 'RECRUITMENT';

  if v_rec_dept_id is null then
    raise exception 'RECRUITER_DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.teams t where t.code = v_code) then
    raise exception 'team code already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  insert into public.teams (code, display_name, department_id, active, version)
  values (v_code, v_display, v_rec_dept_id, true, 1)
  returning * into v_team;

  v_revision_id := public.direct_entry_write_team_revision(
    v_team.team_id, v_team.version, p_app_user_id, v_reason_id,
    null, public.direct_entry_team_snapshot(v_team)
  );

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, team_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_create', v_authority,
     v_team.team_id::text, 'all', 'APPLIED', v_reason_id,
     array['code', 'display_name', 'active'], v_revision_id);

  v_result := jsonb_build_object(
    'team_id', v_team.team_id,
    'code', v_team.code,
    'display_name', v_team.display_name,
    'active', v_team.active,
    'version', v_team.version,
    'revision_id', v_revision_id,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.direct_entry_create_team(uuid, uuid, integer, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_team(uuid, uuid, integer, text, text, text, text)
  to service_role;

-- 10B.2 org_department_assign_accounting_member: lock order + SHARED/SERVICE block + WP3 membership & leave sync
create or replace function public.org_department_assign_accounting_member(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_pair_version integer,
  p_effective_from date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_effective_from date;
  v_reason text;
  v_now timestamptz;
  v_dept public.organization_departments%rowtype;
  v_lock_dept public.organization_departments%rowtype;
  v_idem public.organization_department_idempotency%rowtype;
  v_target public.direct_entry_app_users%rowtype;
  v_linked_person_id uuid := null;
  v_person public.organization_persons%rowtype;
  v_curr_pm public.organization_person_department_memberships%rowtype;
  v_next_pm_ver integer;
  v_current_pair_version integer;
  v_inserted public.organization_department_memberships%rowtype;
  v_projection jsonb;
  v_base_payload jsonb;
  v_target_ref text;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_target_app_user_id is null
     or p_expected_pair_version is null
     or p_expected_pair_version < 0
     or p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case when p_reason is null then null else pg_catalog.btrim(p_reason) end;
  if v_reason is null
     or pg_catalog.length(v_reason) not between 1 and 4000
     or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'DEPARTMENT_MEMBERSHIP_REASON_INVALID'
      using errcode = '22023';
  end if;

  v_today := public.direct_entry_authorization_date();
  v_effective_from := coalesce(p_effective_from, v_today);
  v_target_ref := 'accounting:' || p_target_app_user_id::text;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_idem_v1'),
    pg_catalog.hashtext(p_app_user_id::text || ':' || p_idempotency_key::text)
  );

  select i.*
    into v_idem
    from public.organization_department_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_idem.action <> 'ACCOUNTING_MEMBER_ASSIGNED'
       or (v_idem.target_ref <> '' and v_idem.target_ref <> v_target_ref)
       or v_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_effective_from <> v_today then
    raise exception 'DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID'
      using errcode = '22023';
  end if;

  -- Lock order (§4.2): advisory person lock -> departments -> person -> membership key -> account -> legacy memberships
  select l.person_id
    into v_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_target_app_user_id
     and l.ended_at is null
   limit 1;

  if v_linked_person_id is not null then
    perform public.org_department__internal_lock_person(v_linked_person_id);
    select m.department_id
      into v_curr_pm.department_id
      from public.organization_person_department_memberships m
     where m.person_id = v_linked_person_id
       and m.ended_at is null
     limit 1;
  end if;

  for v_lock_dept in
    select d.*
      from public.organization_departments d
     where d.system_key = 'ACCOUNTING'
        or (v_curr_pm.department_id is not null and d.department_id = v_curr_pm.department_id)
     order by d.department_id
     for update
  loop
    if v_lock_dept.system_key = 'ACCOUNTING' then
      v_dept := v_lock_dept;
    end if;
  end loop;

  if v_dept.department_id is null then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if not v_dept.is_active then
    raise exception 'DEPARTMENT_INACTIVE'
      using errcode = '22023';
  end if;

  if v_linked_person_id is not null then
    select p.*
      into v_person
      from public.organization_persons p
     where p.person_id = v_linked_person_id
     for update;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_membership_v1'),
    pg_catalog.hashtext(v_dept.department_id::text || ':' || p_target_app_user_id::text)
  );

  select u.*
    into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id
   for update;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if not v_target.enabled then
    raise exception 'TARGET_ACCOUNT_DISABLED'
      using errcode = '23514';
  end if;

  if v_target.account_type in ('SHARED', 'SERVICE') then
    raise exception 'ACCOUNT_TYPE_LINK_FORBIDDEN'
      using errcode = 'PT409';
  end if;

  select coalesce(max(m.version), 0)::integer
    into v_current_pair_version
    from public.organization_department_memberships m
   where m.department_id = v_dept.department_id
     and m.app_user_id = p_target_app_user_id;

  if v_current_pair_version <> p_expected_pair_version then
    raise exception 'DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from public.organization_department_memberships m
     where m.department_id = v_dept.department_id
       and m.app_user_id = p_target_app_user_id
       and (
         m.valid_to is null
         or pg_catalog.daterange(m.valid_from, m.valid_to, '[)')
            && pg_catalog.daterange(v_effective_from, null, '[)')
       )
  ) then
    raise exception 'DEPARTMENT_MEMBERSHIP_OVERLAP'
      using errcode = '23P01';
  end if;

  v_now := pg_catalog.clock_timestamp();

  -- Sync WP3 person_department_memberships if account is linked to a person
  if v_person.person_id is not null then
    if v_person.status <> 'ACTIVE' then
      raise exception 'PERSON_INACTIVE'
        using errcode = 'PT409';
    end if;

    select m.*
      into v_curr_pm
      from public.organization_person_department_memberships m
     where m.person_id = v_person.person_id
       and m.ended_at is null
     for update;

    if found and v_curr_pm.department_id <> v_dept.department_id then
      raise exception 'PERSON_ALREADY_IN_OTHER_DEPARTMENT'
        using errcode = 'PT409';
    end if;

    if v_curr_pm.membership_id is null then
      select coalesce(max(m2.version), 0) + 1
        into v_next_pm_ver
        from public.organization_person_department_memberships m2
       where m2.person_id = v_person.person_id;

      insert into public.organization_person_department_memberships (
        person_id,
        department_id,
        started_at,
        ended_at,
        source_kind,
        version,
        reason,
        created_by_app_user_id,
        created_at,
        updated_at
      )
      values (
        v_person.person_id,
        v_dept.department_id,
        v_now,
        null,
        'ADMIN_MUTATION',
        v_next_pm_ver,
        pg_catalog.left(v_reason, 500),
        p_app_user_id,
        v_now,
        v_now
      )
      returning * into v_curr_pm;

      update public.organization_persons
         set version = v_person.version + 1,
             updated_at = v_now,
             updated_by_app_user_id = p_app_user_id
       where person_id = v_person.person_id;

      insert into public.organization_department_audit_events (
        department_id,
        membership_id,
        target_app_user_id,
        target_person_id,
        actor_user_id,
        action,
        reason,
        before_snapshot,
        after_snapshot,
        idempotency_key,
        created_at
      ) values (
        v_dept.department_id,
        null,
        p_target_app_user_id,
        v_person.person_id,
        p_app_user_id,
        'PERSON_DEPT_ASSIGNED',
        pg_catalog.left(v_reason, 500),
        null,
        public.org_department__internal_person_membership_projection(v_curr_pm, v_now),
        p_idempotency_key,
        v_now
      );
    end if;
  end if;

  insert into public.organization_department_memberships (
    department_id,
    app_user_id,
    valid_from,
    valid_to,
    version,
    granted_by_user_id,
    grant_reason
  ) values (
    v_dept.department_id,
    p_target_app_user_id,
    v_effective_from,
    null,
    v_current_pair_version + 1,
    p_app_user_id,
    v_reason
  )
  returning * into v_inserted;

  perform public.org_department__internal_sync_leave_profile_from_org(
    p_target_app_user_id,
    p_app_user_id,
    v_now,
    false
  );

  v_projection := public.org_department__internal_membership_projection(
    v_inserted,
    v_inserted.version,
    v_today
  );

  insert into public.organization_department_audit_events (
    department_id,
    membership_id,
    target_app_user_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key
  ) values (
    v_dept.department_id,
    v_inserted.membership_id,
    p_target_app_user_id,
    v_person.person_id,
    p_app_user_id,
    'ACCOUNTING_MEMBER_ASSIGNED',
    v_reason,
    null,
    v_projection,
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object('membership', v_projection);

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ACCOUNTING_MEMBER_ASSIGNED',
    v_target_ref,
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)
  to service_role;

-- 10B.3 org_department_end_accounting_member: lock order + WP3 membership end & leave sync
create or replace function public.org_department_end_accounting_member(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_membership_id uuid,
  p_expected_pair_version integer,
  p_effective_to date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_effective_to date;
  v_reason text;
  v_now timestamptz;
  v_dept public.organization_departments%rowtype;
  v_idem public.organization_department_idempotency%rowtype;
  v_target_user_id uuid;
  v_linked_person_id uuid := null;
  v_person public.organization_persons%rowtype;
  v_curr_pm public.organization_person_department_memberships%rowtype;
  v_target public.direct_entry_app_users%rowtype;
  v_membership public.organization_department_memberships%rowtype;
  v_updated public.organization_department_memberships%rowtype;
  v_current_pair_version integer;
  v_before jsonb;
  v_after jsonb;
  v_base_payload jsonb;
  v_target_ref text;
  v_prev_cancel text := pg_catalog.current_setting('org_department.membership_cancel_marker', true);
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_membership_id is null
     or p_expected_pair_version is null
     or p_expected_pair_version < 1
     or p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case when p_reason is null then null else pg_catalog.btrim(p_reason) end;
  if v_reason is null
     or pg_catalog.length(v_reason) not between 1 and 4000
     or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'DEPARTMENT_MEMBERSHIP_REASON_INVALID'
      using errcode = '22023';
  end if;

  v_today := public.direct_entry_authorization_date();
  v_target_ref := 'accounting_end:' || p_membership_id::text;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_idem_v1'),
    pg_catalog.hashtext(p_app_user_id::text || ':' || p_idempotency_key::text)
  );

  select i.*
    into v_idem
    from public.organization_department_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_idem.action <> 'ACCOUNTING_MEMBER_ENDED'
       or (v_idem.target_ref <> '' and v_idem.target_ref <> v_target_ref)
       or v_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select d.department_id
    into v_dept.department_id
    from public.organization_departments d
   where d.system_key = 'ACCOUNTING';

  if v_dept.department_id is null then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select m.app_user_id
    into v_target_user_id
    from public.organization_department_memberships m
   where m.membership_id = p_membership_id
     and m.department_id = v_dept.department_id;

  if not found then
    raise exception 'DEPARTMENT_MEMBERSHIP_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select l.person_id
    into v_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = v_target_user_id
     and l.ended_at is null
   limit 1;

  if v_linked_person_id is not null then
    perform public.org_department__internal_lock_person(v_linked_person_id);
  end if;

  select d.*
    into v_dept
    from public.organization_departments d
   where d.department_id = v_dept.department_id
   for update;

  if v_linked_person_id is not null then
    select p.*
      into v_person
      from public.organization_persons p
     where p.person_id = v_linked_person_id
     for update;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_membership_v1'),
    pg_catalog.hashtext(v_dept.department_id::text || ':' || v_target_user_id::text)
  );

  select u.*
    into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = v_target_user_id
   for update;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select m.*
    into v_membership
    from public.organization_department_memberships m
   where m.membership_id = p_membership_id
     and m.department_id = v_dept.department_id
   for update;

  if not found then
    raise exception 'DEPARTMENT_MEMBERSHIP_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select coalesce(max(m.version), 0)::integer
    into v_current_pair_version
    from public.organization_department_memberships m
   where m.department_id = v_dept.department_id
     and m.app_user_id = v_target_user_id;

  if v_current_pair_version <> p_expected_pair_version
     or v_membership.version <> p_expected_pair_version then
    raise exception 'DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_membership.valid_to is not null then
    raise exception 'DEPARTMENT_MEMBERSHIP_ALREADY_ENDED'
      using errcode = 'PT409';
  end if;

  if p_effective_to is not null and p_effective_to <> v_today then
    raise exception 'DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID'
      using errcode = '22023';
  end if;

  if p_effective_to is not null and p_effective_to < v_membership.valid_from then
    raise exception 'DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_effective_to := greatest(coalesce(p_effective_to, v_today), v_membership.valid_from);
  v_now := pg_catalog.clock_timestamp();

  if v_person.person_id is not null then
    select m.*
      into v_curr_pm
      from public.organization_person_department_memberships m
     where m.person_id = v_person.person_id
       and m.department_id = v_dept.department_id
       and m.ended_at is null
     for update;

    if found then
      if exists (
        select 1
          from public.organization_department_heads h
         where h.department_id = v_dept.department_id
           and h.person_id = v_person.person_id
           and h.ended_at is null
      ) then
        raise exception 'PERSON_IS_ACTIVE_DEPARTMENT_HEAD'
          using errcode = 'PT409';
      end if;

      v_now := greatest(v_now, v_curr_pm.started_at);

      update public.organization_person_department_memberships
         set ended_at = v_now,
             ended_reason = pg_catalog.left(v_reason, 500),
             ended_by_app_user_id = p_app_user_id,
             version = v_curr_pm.version + 1,
             updated_at = v_now
       where membership_id = v_curr_pm.membership_id;

      update public.organization_persons
         set version = v_person.version + 1,
             updated_at = v_now,
             updated_by_app_user_id = p_app_user_id
       where person_id = v_person.person_id;
    end if;
  end if;

  v_before := public.org_department__internal_membership_projection(
    v_membership,
    v_current_pair_version,
    v_today
  );

  if v_effective_to = v_membership.valid_from then
    perform pg_catalog.set_config('org_department.membership_cancel_marker', 'on', true);
  end if;

  update public.organization_department_memberships
     set valid_to = v_effective_to,
         revoked_by_user_id = p_app_user_id,
         revoke_reason = v_reason,
         revoked_at = v_now,
         version = v_current_pair_version + 1
   where membership_id = p_membership_id
  returning * into v_updated;

  perform pg_catalog.set_config('org_department.membership_cancel_marker', coalesce(v_prev_cancel, ''), true);

  perform public.org_department__internal_sync_leave_profile_from_org(
    v_target_user_id,
    p_app_user_id,
    v_now,
    true
  );

  v_after := public.org_department__internal_membership_projection(
    v_updated,
    v_updated.version,
    v_today
  );

  insert into public.organization_department_audit_events (
    department_id,
    membership_id,
    target_app_user_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key
  ) values (
    v_dept.department_id,
    v_updated.membership_id,
    v_target_user_id,
    v_person.person_id,
    p_app_user_id,
    'ACCOUNTING_MEMBER_ENDED',
    v_reason,
    v_before,
    v_after,
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object('membership', v_after);

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ACCOUNTING_MEMBER_ENDED',
    v_target_ref,
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
exception
  when others then
    perform pg_catalog.set_config('org_department.membership_cancel_marker', coalesce(v_prev_cancel, ''), true);
    raise;
end;
$function$;

revoke all on function public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)
  to service_role;

-- 10B.4 direct_entry_account_operation_update_display_name: sync linked person.full_name & recruiter.display_name under §4.2 locks
create or replace function public.direct_entry_account_operation_update_display_name(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_display_name text,
  p_expected_app_user_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'display_name_update';
  v_display_name text := btrim(p_display_name);
  v_locked_id uuid;
  v_target public.direct_entry_app_users;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_linked_person_id uuid := null;
  v_person public.organization_persons;
  v_person_before jsonb;
  v_person_after jsonb;
  v_linked_recruiter_id uuid;
  v_recruiter_before public.recruiters;
  v_recruiter_after public.recruiters;
  v_recruiter_version integer;
  v_recruiter_revision_id uuid;
  v_now timestamptz;
  v_result jsonb;
begin
  if p_display_name is null or length(v_display_name) not between 1 and 256 then
    raise exception 'display name invalid' using errcode = '22023';
  end if;
  if p_expected_app_user_version is null or p_expected_app_user_version < 1 then
    raise exception 'expected app user version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'target_app_user_id', p_target_app_user_id, 'display_name', v_display_name,
    'expected_app_user_version', p_expected_app_user_version, 'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Lock order (§4.2): advisory person lock -> person -> direct_entry_app_users -> recruiters
  select l.person_id
    into v_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_target_app_user_id
     and l.ended_at is null
   limit 1;

  if v_linked_person_id is not null then
    perform public.org_department__internal_lock_person(v_linked_person_id);
    select p.*
      into v_person
      from public.organization_persons p
     where p.person_id = v_linked_person_id
     for update;
  end if;

  for v_locked_id in
    select u.app_user_id from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id for update
  loop null; end loop;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  select l.recruiter_id into v_linked_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_target_app_user_id
     and l.verified
     and l.is_current
   order by l.valid_from desc, l.link_id desc
   limit 1;

  if v_linked_recruiter_id is null and v_person.recruiter_id is not null then
    v_linked_recruiter_id := v_person.recruiter_id;
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  v_before := jsonb_build_object('display_name', v_target.display_name);
  update public.direct_entry_app_users
     set display_name = v_display_name, version = version + 1, updated_at = v_now
   where app_user_id = p_target_app_user_id
  returning * into v_target;
  v_after := jsonb_build_object('display_name', v_target.display_name);

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_target_app_user_id, v_target.version, p_actor_app_user_id, v_action, v_before, v_after, v_reason_id
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
    p_target_app_user_id::text, 'all', 'APPLIED', v_reason_id,
    array['display_name'], v_revision_id
  );

  if v_person.person_id is not null and v_person.full_name is distinct from v_display_name then
    if length(v_display_name) > 160 then
      raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
    end if;
    v_person_before := public.org_department__internal_person_detail_projection(v_person, v_now);

    update public.organization_persons
       set full_name = v_display_name,
           version = v_person.version + 1,
           updated_at = v_now,
           updated_by_app_user_id = p_actor_app_user_id
     where person_id = v_person.person_id
     returning * into v_person;

    v_person_after := public.org_department__internal_person_detail_projection(v_person, v_now);

    insert into public.organization_department_audit_events (
      target_app_user_id,
      target_person_id,
      actor_user_id,
      action,
      reason,
      before_snapshot,
      after_snapshot,
      idempotency_key,
      created_at
    )
    values (
      p_target_app_user_id,
      v_person.person_id,
      p_actor_app_user_id,
      'PERSON_UPDATED',
      pg_catalog.left(btrim(p_reason), 500),
      v_person_before,
      v_person_after,
      null,
      v_now
    );
  end if;

  v_recruiter_version := null;
  v_recruiter_revision_id := null;
  if v_linked_recruiter_id is not null then
    select r.* into v_recruiter_before
      from public.recruiters r
     where r.recruiter_id = v_linked_recruiter_id
     for update;
    if found then
      update public.recruiters
         set display_name = v_display_name
       where recruiter_id = v_linked_recruiter_id
      returning * into v_recruiter_after;
      select b.personnel_version, b.revision_id
        into v_recruiter_version, v_recruiter_revision_id
        from public.direct_entry_bump_personnel_version(
          v_linked_recruiter_id, p_actor_app_user_id, v_reason_id,
          public.direct_entry_personnel_snapshot(v_recruiter_before),
          public.direct_entry_personnel_snapshot(v_recruiter_after)
        ) b;
    end if;
  end if;

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'recruiter_id', v_linked_recruiter_id,
    'recruiter_version', v_recruiter_version,
    'recruiter_revision_id', v_recruiter_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.direct_entry_account_operation_update_display_name(uuid, uuid, uuid, text, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_update_display_name(uuid, uuid, uuid, text, integer, text, text)
  to service_role;

-- 10B.5 direct_entry_update_personnel: sync linked person.full_name & account.display_name under §4.2 locks
create or replace function public.direct_entry_update_personnel(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid,
  p_expected_version integer,
  p_display_name text,
  p_personnel_code text,
  p_personnel_position text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_code text;
  v_display text;
  v_position text;
  v_reason_id uuid;
  v_before public.recruiters;
  v_after public.recruiters;
  v_changed text[];
  v_personnel_version integer;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_person_id uuid := null;
  v_person public.organization_persons;
  v_person_before jsonb;
  v_person_after jsonb;
  v_acc public.direct_entry_app_users;
  v_now timestamptz;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null then
    raise exception 'personnel required' using errcode = '22023';
  end if;
  if p_personnel_code is null or btrim(p_personnel_code) = '' then
    raise exception 'personnel code required' using errcode = '22023';
  end if;
  v_code := btrim(p_personnel_code);
  if length(v_code) > 64 or v_code ~ '[[:space:][:cntrl:]]' then
    raise exception 'personnel code is not canonical' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'personnel display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  if p_personnel_position is null or p_personnel_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '22023';
  end if;
  v_position := p_personnel_position;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'personnel_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'expected_version', p_expected_version,
      'personnel_code', v_code,
      'display_name', v_display,
      'personnel_position', v_position
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Lock order (§4.2): advisory person lock -> person -> accounts -> recruiter
  select p.person_id
    into v_person_id
    from public.organization_persons p
   where p.recruiter_id = p_recruiter_id
   limit 1;

  if v_person_id is null then
    select l.person_id
      into v_person_id
      from public.direct_entry_app_user_recruiter_links rl
      join public.organization_account_person_links l
        on l.app_user_id = rl.app_user_id
       and l.ended_at is null
     where rl.recruiter_id = p_recruiter_id
       and rl.verified = true
       and rl.is_current = true
     order by rl.valid_from desc, rl.link_id desc
     limit 1;
  end if;

  if v_person_id is not null then
    perform public.org_department__internal_lock_person(v_person_id);
    select p.*
      into v_person
      from public.organization_persons p
     where p.person_id = v_person_id
     for update;
  end if;

  for v_acc in
    select u.*
      from public.direct_entry_app_users u
     where (
       (v_person_id is not null and exists (
         select 1
           from public.organization_account_person_links l
          where l.person_id = v_person_id
            and l.app_user_id = u.app_user_id
            and l.ended_at is null
       ))
       or exists (
         select 1
           from public.direct_entry_app_user_recruiter_links rl
          where rl.recruiter_id = p_recruiter_id
            and rl.app_user_id = u.app_user_id
            and rl.verified = true
            and rl.is_current = true
       )
     )
     order by u.app_user_id
     for update
  loop
    null;
  end loop;

  v_before := public.direct_entry_lock_personnel(p_recruiter_id, p_expected_version);

  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and r.recruiter_id <> p_recruiter_id
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then
    raise exception 'personnel code already exists' using errcode = '23505';
  end if;

  if exists (
    select 1 from public.organization_persons p2
     where (v_person.person_id is null or p2.person_id <> v_person.person_id)
       and lower(btrim(p2.employee_code)) = lower(v_code)
  ) then
    raise exception 'personnel code already exists' using errcode = '23505';
  end if;

  v_changed := array_remove(array[
    case when v_before.display_name is distinct from v_display then 'display_name' end,
    case when v_before.personnel_code is distinct from v_code then 'personnel_code' end,
    case when v_before.personnel_position is distinct from v_position then 'personnel_position' end
  ], null);
  if cardinality(v_changed) = 0 then
    raise exception 'personnel update changes nothing' using errcode = '22023';
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  update public.recruiters
     set display_name = v_display,
         personnel_code = v_code,
         personnel_position = v_position
   where recruiter_id = p_recruiter_id
  returning * into v_after;

  select b.personnel_version, b.revision_id
    into v_personnel_version, v_revision_id
    from public.direct_entry_bump_personnel_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      public.direct_entry_personnel_snapshot(v_before),
      public.direct_entry_personnel_snapshot(v_after)
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, personnel_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'personnel_update', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id,
     v_changed, v_revision_id);

  if v_person.person_id is not null and v_person.full_name is distinct from v_after.display_name then
    if length(v_after.display_name) > 160 then
      raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
    end if;
    v_person_before := public.org_department__internal_person_detail_projection(v_person, v_now);

    update public.organization_persons
       set full_name = v_after.display_name,
           version = v_person.version + 1,
           updated_at = v_now,
           updated_by_app_user_id = p_app_user_id
     where person_id = v_person.person_id
     returning * into v_person;

    v_person_after := public.org_department__internal_person_detail_projection(v_person, v_now);

    insert into public.organization_department_audit_events (
      target_person_id,
      actor_user_id,
      action,
      reason,
      before_snapshot,
      after_snapshot,
      idempotency_key,
      created_at
    )
    values (
      v_person.person_id,
      p_app_user_id,
      'PERSON_UPDATED',
      pg_catalog.left(btrim(p_reason), 500),
      v_person_before,
      v_person_after,
      null,
      v_now
    );
  end if;

  if v_before.display_name is distinct from v_after.display_name then
    for v_acc in
      select u.*
        from public.direct_entry_app_users u
       where (
         (v_person_id is not null and exists (
           select 1
             from public.organization_account_person_links l
            where l.person_id = v_person_id
              and l.app_user_id = u.app_user_id
              and l.ended_at is null
         ))
         or exists (
           select 1
             from public.direct_entry_app_user_recruiter_links rl
            where rl.recruiter_id = p_recruiter_id
              and rl.app_user_id = u.app_user_id
              and rl.verified = true
              and rl.is_current = true
         )
       )
       order by u.app_user_id
    loop
      if v_acc.display_name is distinct from v_after.display_name then
        update public.direct_entry_app_users
           set display_name = v_after.display_name,
               version = v_acc.version + 1,
               updated_at = v_now
         where app_user_id = v_acc.app_user_id;

        insert into public.direct_entry_app_user_revisions (
          app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
        )
        values (
          v_acc.app_user_id,
          v_acc.version + 1,
          p_app_user_id,
          'display_name_update',
          jsonb_build_object('display_name', v_acc.display_name),
          jsonb_build_object('display_name', v_after.display_name),
          v_reason_id
        );
      end if;
    end loop;
  end if;

  v_result := jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'display_name', v_after.display_name,
    'personnel_code', v_after.personnel_code,
    'personnel_position', v_after.personnel_position,
    'active', v_after.active,
    'version', v_personnel_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'personnel_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.direct_entry_update_personnel(uuid, uuid, uuid, integer, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_personnel(uuid, uuid, uuid, integer, text, text, text, text, text)
  to service_role;

-- 10B.6 direct_entry_account_operation_create_personnel: guard SHARED/SERVICE + sync linked person.recruiter_id
create or replace function public.direct_entry_account_operation_create_personnel(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_account_ref uuid,
  p_expected_account_version integer,
  p_personnel_code text,
  p_personnel_position text,
  p_valid_from date,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'personnel_created';
  v_code text := lower(btrim(p_personnel_code));
  v_login_id text;
  v_position text := p_personnel_position;
  v_account public.direct_entry_app_users;
  v_linked_person_id uuid := null;
  v_person public.organization_persons;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_recruiter public.recruiters;
  v_membership_id uuid;
  v_link_id uuid;
  v_personnel_revision_id uuid;
  v_app_user_revision_id uuid;
  v_result jsonb;
  v_capability text;
  v_today date := public.direct_entry_authorization_date();
  v_valid_from date;
  v_now timestamptz;
  v_next_capability_start date;
  v_next_scope_start date;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_account_ref is null or p_expected_account_version is null or p_expected_account_version < 1 then
    raise exception 'account reference or version invalid' using errcode = '22023';
  end if;
  if v_code is null or not public.direct_entry_is_canonical_login_id(v_code) then
    raise exception 'personnel code must be the account login ID' using errcode = '22023';
  end if;
  if v_position is null or v_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'account_ref', p_account_ref, 'expected_account_version', p_expected_account_version,
    'personnel_code', v_code, 'personnel_position', v_position,
    'valid_from', p_valid_from, 'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then return v_prior; end if;

  v_valid_from := coalesce(p_valid_from, v_today);
  if v_valid_from <> v_today then
    raise exception 'provider valid from is invalid' using errcode = '22023';
  end if;

  -- Lock order (§4.2): advisory person lock -> person -> direct_entry_app_users
  select l.person_id
    into v_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
     and l.ended_at is null
   limit 1;

  if v_linked_person_id is not null then
    perform public.org_department__internal_lock_person(v_linked_person_id);
    select p.*
      into v_person
      from public.organization_persons p
     where p.person_id = v_linked_person_id
     for update;
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref
   for update;
  if not found then raise exception 'account not found' using errcode = 'P0002'; end if;
  if not v_account.enabled then raise exception 'account is not enabled' using errcode = '23514'; end if;
  if v_account.account_type in ('SHARED', 'SERVICE') then
    raise exception 'ACCOUNT_TYPE_LINK_FORBIDDEN' using errcode = 'PT409';
  end if;
  if v_person.person_id is not null and v_person.recruiter_id is not null then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  select lower(nullif(split_part(u.email, '@', 1), '')) into v_login_id
    from auth.users u where u.id = v_account.auth_subject;
  if v_login_id is null or not public.direct_entry_is_canonical_login_id(v_login_id)
     or v_code <> v_login_id then
    raise exception 'personnel code does not match account login ID' using errcode = '22023';
  end if;
  if lower(btrim(v_account.display_name)) = v_login_id then
    raise exception 'account real name must be updated before personnel creation' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_account_ref and l.verified
       and l.is_current
  ) then raise exception 'account already has an effective recruiter link' using errcode = '23514'; end if;
  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;
  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then raise exception 'personnel code already exists' using errcode = '23505'; end if;

  v_now := pg_catalog.clock_timestamp();
  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);
  insert into public.recruiters (display_name, personnel_code, personnel_position, active, version)
  values (v_account.display_name, v_code, v_position, true, 1)
  returning * into v_recruiter;
  insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, vendor_id, is_current)
  values (v_recruiter.recruiter_id, 'hrp', v_valid_from, null, true)
  returning membership_id into v_membership_id;
  insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
  values (p_account_ref, v_recruiter.recruiter_id, true, v_valid_from, true)
  returning link_id into v_link_id;

  foreach v_capability in array array[
    'entry_create', 'entry_own', 'submission_create', 'change_request_create',
    'employment_status.request', 'document_upload', 'document_view'
  ]::text[]
  loop
    if not exists (
      select 1 from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref and g.capability = v_capability
         and g.is_current
    ) then
      select min(g.valid_from) into v_next_capability_start
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref and g.capability = v_capability
         and g.valid_from > v_today;
      insert into public.direct_entry_capability_grants
        (app_user_id, capability, valid_from, valid_to, is_current)
      values (p_account_ref, v_capability, v_today, v_next_capability_start, true);
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  if not exists (
    select 1 from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref and g.scope_kind = 'own'
       and g.is_current
  ) then
    select min(g.valid_from) into v_next_scope_start
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref and g.scope_kind = 'own'
       and g.valid_from > v_today;
    insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current)
    values (p_account_ref, 'own', v_today, v_next_scope_start, true);
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'scope_default_grant', 'entry_own',
      p_account_ref::text, 'own', 'APPLIED', v_reason_id, array['scope_kind', 'valid_from', 'valid_to']
    );
  end if;

  update public.direct_entry_app_users set version = version + 1, updated_at = v_now
   where app_user_id = p_account_ref returning version into v_account.version;

  if v_person.person_id is not null and v_person.recruiter_id is null then
    update public.organization_persons
       set recruiter_id = v_recruiter.recruiter_id,
           version = v_person.version + 1,
           updated_at = v_now,
           updated_by_app_user_id = p_actor_app_user_id
     where person_id = v_person.person_id;
  end if;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_account_ref, v_account.version, p_actor_app_user_id, 'link_create',
    jsonb_build_object('recruiter_id', null), jsonb_build_object('recruiter_id', v_recruiter.recruiter_id), v_reason_id
  ) returning revision_id into v_app_user_revision_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, 'link_create', 'entry_admin', p_account_ref::text,
    'all', 'APPLIED', v_reason_id, array['recruiter_link'], v_app_user_revision_id
  );
  v_personnel_revision_id := public.direct_entry_write_personnel_revision(
    v_recruiter.recruiter_id, v_recruiter.version, p_actor_app_user_id, v_reason_id,
    null, public.direct_entry_personnel_snapshot(v_recruiter)
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, personnel_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin', v_recruiter.recruiter_id::text,
    'all', 'APPLIED', v_reason_id, array['display_name', 'personnel_code', 'personnel_position', 'active'],
    v_personnel_revision_id
  );
  v_result := jsonb_build_object(
    'recruiter_id', v_recruiter.recruiter_id, 'display_name', v_recruiter.display_name,
    'personnel_code', v_recruiter.personnel_code, 'personnel_position', v_recruiter.personnel_position,
    'version', v_recruiter.version, 'link_id', v_link_id, 'membership_id', v_membership_id,
    'app_user_version', v_account.version, 'app_user_revision_id', v_app_user_revision_id,
    'personnel_revision_id', v_personnel_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)
  to service_role;

-- 10B.7 direct_entry_account_operation_link_recruiter: lock order + R-INV-2 + SHARED/SERVICE block + sync person.recruiter_id
create or replace function public.direct_entry_account_operation_link_recruiter(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_recruiter_id uuid,
  p_expected_recruiter_version integer,
  p_account_ref uuid,
  p_expected_account_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'account_recruiter_link_create';
  v_today date := public.direct_entry_authorization_date();
  v_lock_key text;
  v_account public.direct_entry_app_users;
  v_recruiter public.recruiters;
  v_acct_person_id uuid := null;
  v_rec_person_id uuid := null;
  v_lock_person_id uuid;
  v_acct_person public.organization_persons;
  v_rec_person public.organization_persons;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_login_id text;
  v_code text;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_link_id uuid;
  v_capability text;
  v_next_capability_start date;
  v_next_scope_start date;
  v_app_user_revision_id uuid;
  v_now timestamptz;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_recruiter_id is null
     or p_expected_recruiter_version is null
     or p_expected_recruiter_version < 1 then
    raise exception 'personnel reference or version invalid' using errcode = '22023';
  end if;
  if p_account_ref is null
     or p_expected_account_version is null
     or p_expected_account_version < 1 then
    raise exception 'account reference or version invalid' using errcode = '22023';
  end if;
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'expected_recruiter_version', p_expected_recruiter_version,
    'account_ref', p_account_ref,
    'expected_account_version', p_expected_account_version,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Lock order (§4.2): advisory person lock -> persons (ORDER BY person_id) -> legacy advisory locks -> account -> recruiter
  select l.person_id
    into v_acct_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
     and l.ended_at is null
   limit 1;

  select p.person_id
    into v_rec_person_id
    from public.organization_persons p
   where p.recruiter_id = p_recruiter_id
   limit 1;

  for v_lock_person_id in
    select distinct pid
      from unnest(array[v_acct_person_id, v_rec_person_id]) as t(pid)
     where pid is not null
     order by pid
  loop
    perform public.org_department__internal_lock_person(v_lock_person_id);
  end loop;

  for v_lock_person_id in
    select p.person_id
      from public.organization_persons p
     where p.person_id in (v_acct_person_id, v_rec_person_id)
     order by p.person_id
     for update
  loop
    if v_lock_person_id = v_acct_person_id then
      select p.* into v_acct_person from public.organization_persons p where p.person_id = v_acct_person_id;
    end if;
    if v_lock_person_id = v_rec_person_id then
      select p.* into v_rec_person from public.organization_persons p where p.person_id = v_rec_person_id;
    end if;
  end loop;

  for v_lock_key in
    select k
      from unnest(array[
        'recruiter-link:' || p_account_ref::text,
        'recruiter-link-recruiter:' || p_recruiter_id::text
      ]) as t(k)
     order by k
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref
   for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  if v_account.account_type in ('SHARED', 'SERVICE') then
    raise exception 'ACCOUNT_TYPE_LINK_FORBIDDEN' using errcode = 'PT409';
  end if;

  select r.* into v_recruiter
    from public.recruiters r
   where r.recruiter_id = p_recruiter_id
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.vendor_id is null
          and (m.is_current or (not r.active and m.valid_to is null
            and (select count(*) from public.recruiter_provider_memberships x
                  where x.recruiter_id = r.recruiter_id and x.valid_to is null) = 1))
     )
   for update;
  if not found then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;

  perform m.membership_id
    from public.recruiter_provider_memberships m
   where m.recruiter_id = p_recruiter_id
   order by m.membership_id
   for update;

  if v_acct_person.person_id is not null and v_rec_person.person_id is not null
     and v_acct_person.person_id <> v_rec_person.person_id then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;
  if v_acct_person.person_id is not null and v_acct_person.recruiter_id is not null
     and v_acct_person.recruiter_id <> p_recruiter_id then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;
  if v_acct_person.person_id is null and v_rec_person.person_id is not null
     and exists (
       select 1
         from public.organization_account_person_links l
        where l.person_id = v_rec_person.person_id
          and l.ended_at is null
          and l.app_user_id <> p_account_ref
     ) then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  if not v_account.enabled then
    raise exception 'account is not enabled' using errcode = '23514';
  end if;
  if not v_recruiter.active then
    raise exception 'personnel is not active' using errcode = '23514';
  end if;

  select count(*)::int,
         count(*) filter (where m.provider_type = 'hrp' and m.vendor_id is null)::int
    into v_provider_count, v_hrp_provider_count
    from public.recruiter_provider_memberships m
   where m.recruiter_id = p_recruiter_id
     and m.is_current;
  if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
    raise exception 'personnel requires an active HRP provider membership' using errcode = '23514';
  end if;

  if v_recruiter.personnel_position is not null
     and v_recruiter.personnel_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '23514';
  end if;

  v_code := lower(nullif(btrim(coalesce(v_recruiter.personnel_code, '')), ''));
  if v_code is null or not public.direct_entry_is_canonical_login_id(v_code) then
    raise exception 'personnel code is missing or not canonical for account linking' using errcode = '22023';
  end if;

  select lower(nullif(btrim(split_part(au.email, '@', 1)), ''))
    into v_login_id
    from auth.users au
   where au.id = v_account.auth_subject;
  if v_login_id is null
     or not public.direct_entry_is_canonical_login_id(v_login_id)
     or v_login_id <> v_code then
    raise exception 'personnel code does not match account login ID' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_account_ref
       and l.verified
       and (l.is_current or l.valid_to is null or l.valid_to > v_today)
  ) then
    raise exception 'account already has an effective recruiter link' using errcode = '23P01';
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_recruiter_id
       and l.verified
       and (l.is_current or l.valid_to is null or l.valid_to > v_today)
  ) then
    raise exception 'personnel already has an effective account link' using errcode = '23P01';
  end if;

  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;
  if v_recruiter.version <> p_expected_recruiter_version then
    raise exception 'personnel version conflict' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_app_user_recruiter_links (
    app_user_id, recruiter_id, verified, valid_from, is_current
  ) values (
    p_account_ref, p_recruiter_id, true, v_today, true
  ) returning link_id into v_link_id;

  foreach v_capability in array array[
    'entry_create', 'entry_own', 'submission_create', 'change_request_create',
    'employment_status.request', 'document_upload', 'document_view'
  ]::text[]
  loop
    if not exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref
         and g.capability = v_capability
         and g.is_current
    ) then
      if exists (
        select 1
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_account_ref
           and g.capability = v_capability
           and g.valid_from <= v_today
           and (g.valid_to is null or v_today < g.valid_to)
      ) then
        update public.direct_entry_capability_grants g
           set is_current = true
         where g.app_user_id = p_account_ref
           and g.capability = v_capability
           and g.valid_from <= v_today
           and (g.valid_to is null or v_today < g.valid_to);
      else
        select min(g.valid_from)
          into v_next_capability_start
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_account_ref
           and g.capability = v_capability
           and g.valid_from > v_today;
        insert into public.direct_entry_capability_grants (
          app_user_id, capability, valid_from, valid_to, is_current
        ) values (
          p_account_ref, v_capability, v_today, v_next_capability_start, true
        );
      end if;
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  if not exists (
    select 1
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref
       and g.scope_kind = 'own'
       and g.is_current
  ) then
    if exists (
      select 1
        from public.direct_entry_scope_grants g
       where g.app_user_id = p_account_ref
         and g.scope_kind = 'own'
         and g.valid_from <= v_today
         and (g.valid_to is null or v_today < g.valid_to)
    ) then
      update public.direct_entry_scope_grants g
         set is_current = true
       where g.app_user_id = p_account_ref
         and g.scope_kind = 'own'
         and g.valid_from <= v_today
         and (g.valid_to is null or v_today < g.valid_to);
    else
      select min(g.valid_from)
        into v_next_scope_start
        from public.direct_entry_scope_grants g
       where g.app_user_id = p_account_ref
         and g.scope_kind = 'own'
         and g.valid_from > v_today;
      insert into public.direct_entry_scope_grants (
        app_user_id, scope_kind, valid_from, valid_to, is_current
      ) values (
        p_account_ref, 'own', v_today, v_next_scope_start, true
      );
    end if;
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'scope_default_grant', 'entry_own',
      p_account_ref::text, 'own', 'APPLIED', v_reason_id, array['scope_kind', 'valid_from', 'valid_to']
    );
  end if;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = v_now
   where app_user_id = p_account_ref
  returning version into v_account.version;

  if v_acct_person.person_id is not null and v_acct_person.recruiter_id is null then
    update public.organization_persons
       set recruiter_id = p_recruiter_id,
           version = v_acct_person.version + 1,
           updated_at = v_now,
           updated_by_app_user_id = p_actor_app_user_id
     where person_id = v_acct_person.person_id;
  end if;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_account_ref,
    v_account.version,
    p_actor_app_user_id,
    'link_create',
    jsonb_build_object('recruiter_id', null),
    jsonb_build_object('recruiter_id', v_recruiter.recruiter_id),
    v_reason_id
  ) returning revision_id into v_app_user_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject,
    p_actor_app_user_id,
    'link_create',
    'entry_admin',
    p_account_ref::text,
    'all',
    'APPLIED',
    v_reason_id,
    array['recruiter_link'],
    v_app_user_revision_id
  );

  v_result := jsonb_build_object(
    'link_id', v_link_id,
    'app_user_id', p_account_ref,
    'app_user_version', v_account.version,
    'app_user_revision_id', v_app_user_revision_id,
    'recruiter_id', v_recruiter.recruiter_id,
    'recruiter_version', v_recruiter.version,
    'personnel_code', v_recruiter.personnel_code,
    'valid_from', v_today
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)
  to service_role;

-- =============================================================================
-- 11. Guarded Owner Alignment & Self-Check
-- =============================================================================
do $align$
declare
  v_base_owner_oid oid;
  v_base_owner text;
  v_obj record;
begin
  select c.relowner
    into v_base_owner_oid
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'organization_departments'
   limit 1;

  if v_base_owner_oid is not null and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    v_base_owner := pg_catalog.pg_get_userbyid(v_base_owner_oid);

    for v_obj in
      select t.relname
        from pg_catalog.pg_class t
        join pg_catalog.pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'public'
         and t.relname in (
           'organization_persons',
           'organization_account_person_links',
           'organization_person_department_memberships',
           'organization_department_heads'
         )
         and t.relowner is distinct from v_base_owner_oid
    loop
      execute pg_catalog.format('alter table public.%I owner to %I', v_obj.relname, v_base_owner);
    end loop;

    for v_obj in
      select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as args
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (
           p.proname like 'org_department\_%' escape '\'
           or p.proname in (
             'direct_entry_app_user_projection',
             'direct_entry_create_team',
             'direct_entry_update_personnel',
             'direct_entry_account_operation_create_personnel',
             'direct_entry_account_operation_update_display_name',
             'direct_entry_account_operation_link_recruiter'
           )
         )
         and p.proowner is distinct from v_base_owner_oid
    loop
      execute pg_catalog.format(
        'alter function public.%I(%s) owner to %I',
        v_obj.proname,
        v_obj.args,
        v_base_owner
      );
    end loop;
  end if;
end;
$align$;

do $check_wp3b$
declare
  v_count integer;
  v_sig text;
  v_tbl text;
  v_role text;
  v_func record;
begin
  if to_regprocedure('public.org_department_list_departments_admin(uuid, uuid)') is not null
     or to_regprocedure('public.org_department_get_department_admin(uuid, uuid, uuid)') is not null
     or to_regprocedure('public.org_department__internal_department_projection(public.organization_departments, date)') is not null
     or to_regprocedure('public.org_department__internal_sync_leave_profile_from_org(uuid, uuid, timestamptz)') is not null
     or to_regprocedure('public.org_department__internal_sync_leave_approver(uuid, uuid)') is not null then
    raise exception 'WP3B overload check failed: obsolete signature remains' using errcode = '55000';
  end if;

  -- Zero overload guarantee across all org_department_* routines
  select count(*)::integer
    into v_count
    from (
      select p.proname
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname like 'org_department\_%' escape '\'
       group by p.proname
       having count(*) > 1
    ) dup;
  if v_count <> 0 then
    raise exception 'WP3B zero-overload check failed for org_department_*' using errcode = '55000';
  end if;

  select count(*)::integer
    into v_count
    from public.organization_departments
   where system_key in ('RECRUITMENT', 'ACCOUNTING', 'MARKETING', 'IT', 'MANAGEMENT_BOD');
  if v_count <> 5 then
    raise exception 'WP3B system department seed check failed: count=%', v_count using errcode = '55000';
  end if;

  -- Verify FORCE RLS and zero direct table grants on the 4 new WP3 tables
  for v_tbl in
    select unnest(array[
      'organization_persons',
      'organization_account_person_links',
      'organization_person_department_memberships',
      'organization_department_heads'
    ])
  loop
    select count(*)::integer
      into v_count
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = v_tbl
       and c.relrowsecurity
       and c.relforcerowsecurity;
    if v_count <> 1 then
      raise exception 'WP3B FORCE RLS check failed for %', v_tbl using errcode = '55000';
    end if;

    for v_role in select unnest(array['public', 'anon', 'authenticated', 'service_role'])
    loop
      if has_table_privilege(v_role, 'public.' || v_tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
        raise exception 'WP3B table grant check failed for % on %', v_role, v_tbl using errcode = '55000';
      end if;
    end loop;
  end loop;

  -- Verify internal helpers are revoked from service_role and public roles
  for v_func in
    select p.oid, p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'org_department\_\_internal\_%' escape '\'
  loop
    if has_function_privilege('public', v_func.oid, 'EXECUTE')
       or has_function_privilege('anon', v_func.oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_func.oid, 'EXECUTE')
       or has_function_privilege('service_role', v_func.oid, 'EXECUTE') then
      raise exception 'WP3B internal helper ACL check failed for %', v_func.proname using errcode = '55000';
    end if;
  end loop;

  for v_sig in
    select s
      from unnest(array[
        'public.org_department_list_departments_admin(uuid, uuid, boolean, timestamp with time zone)',
        'public.org_department_create_department_admin(uuid, uuid, text, text, text, uuid, text)',
        'public.org_department_get_department_admin(uuid, uuid, uuid, timestamp with time zone)',
        'public.org_department_update_department_admin(uuid, uuid, uuid, integer, text, boolean, text, uuid, text)',
        'public.org_department_list_person_memberships_admin(uuid, uuid, uuid, text, text, timestamp with time zone, integer, integer)',
        'public.org_department_assign_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)',
        'public.org_department_end_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)',
        'public.org_department_list_department_heads_admin(uuid, uuid, uuid, boolean, timestamp with time zone, integer, integer)',
        'public.org_department_designate_head_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)',
        'public.org_department_end_head_admin(uuid, uuid, uuid, integer, uuid, text, uuid, text)',
        'public.org_department_list_persons_admin(uuid, uuid, text, text, uuid, text, timestamp with time zone, integer, integer)',
        'public.org_department_get_person_admin(uuid, uuid, uuid, timestamp with time zone)',
        'public.org_department_create_person_admin(uuid, uuid, text, text, date, uuid, uuid, integer, uuid, text, uuid, text)',
        'public.org_department_update_person_admin(uuid, uuid, uuid, integer, text, text, date, text, text, uuid, text)',
        'public.org_department_transfer_person_member_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)',
        'public.org_department_set_account_type_admin(uuid, uuid, uuid, text, integer, text, uuid, text)',
        'public.org_department_link_account_person_admin(uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)',
        'public.org_department_unlink_account_person_admin(uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)',
        'public.org_department_list_accounting_memberships_admin(uuid, uuid, text, boolean, integer, integer)',
        'public.org_department_list_accounting_candidates_admin(uuid, uuid, text, integer, integer)',
        'public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
        'public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
        'public.org_department_list_recruitment_teams_admin(uuid, uuid, text, boolean, integer, integer)'
      ]) as s
  loop
    if to_regprocedure(v_sig) is null then
      raise exception 'WP3B missing RPC signature: %', v_sig using errcode = '55000';
    end if;
    if has_function_privilege('public', v_sig, 'EXECUTE')
       or has_function_privilege('anon', v_sig, 'EXECUTE')
       or has_function_privilege('authenticated', v_sig, 'EXECUTE')
       or not has_function_privilege('service_role', v_sig, 'EXECUTE') then
      raise exception 'WP3B invalid ACL for RPC: %', v_sig using errcode = '55000';
    end if;
  end loop;
end;
$check_wp3b$;

commit;
