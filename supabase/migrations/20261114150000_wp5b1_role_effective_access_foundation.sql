-- =============================================================================
-- WP5B-1 (PR 1): Unified Role, Capability, Scope & Effective Access Foundation
--
-- Additive foundation aligned with WP5A Rev 3 (ADMIN = "BoD/Admin", exact 8
-- canonical roles, single canonical Owner ADMIN protection, D10 disable/enable
-- lifecycle, +07:00 Asia/Ho_Chi_Minh date calculations, FORCE RLS, zero
-- direct table grants, exact 5 public service_role RPCs & 5 __internal_* helpers).
--
-- PR 1 boundary (C1):
--   - public.authz_system_state.cutover_ready stays FALSE.
--   - public.direct_entry_app_users.authz_managed defaults to FALSE.
--   - Existing live accounts, luanpt orphan all-scope, and Web PR 0 behavior
--     remain completely intact until PR 2 cutover.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Helper: +07:00 ISO-8601 formatting (consistent with direct_entry_authorization_date)
-- -----------------------------------------------------------------------------
-- No separate helper function needed; formatted inline with pg_catalog.to_char
-- against timezone 'Asia/Ho_Chi_Minh' to keep exact internal routine inventory.

-- -----------------------------------------------------------------------------
-- 2. Canonical Role, Capability, Assignment, Exception, Audit, Idempotency & State Tables
-- -----------------------------------------------------------------------------
create table if not exists public.authz_system_state (
  singleton_id boolean primary key default true
    constraint authz_system_state_singleton_chk check (singleton_id),
  cutover_ready boolean not null default false,
  cutover_at timestamptz,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_by_app_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict
);

create table if not exists public.authz_role_definitions (
  role_code text primary key
    constraint authz_role_definitions_code_chk check (role_code in (
      'EMPLOYEE_BASE',
      'RECRUITER',
      'HR_OPERATOR',
      'ADMIN',
      'TEAM_LEADER',
      'DEPARTMENT_HEAD',
      'PROJECT_MANAGER',
      'PROJECT_ACCOUNTANT'
    )),
  display_name text not null
    constraint authz_role_definitions_display_name_chk
    check (length(pg_catalog.btrim(display_name)) between 1 and 128),
  description text not null
    constraint authz_role_definitions_description_chk
    check (length(pg_catalog.btrim(description)) between 1 and 500),
  assignment_mode text not null
    constraint authz_role_definitions_mode_chk
    check (assignment_mode in ('GLOBAL', 'CONTEXTUAL')),
  fixed_scope_kind text not null
    constraint authz_role_definitions_scope_chk
    check (fixed_scope_kind in ('none', 'own', 'team', 'department', 'project', 'all')),
  requires_active_person boolean not null default false,
  is_assignable_global boolean not null default false,
  sort_order integer not null
    constraint authz_role_definitions_sort_chk check (sort_order >= 1),
  constraint authz_role_definitions_mode_assignable_chk check (
    (assignment_mode = 'GLOBAL' and is_assignable_global = true)
    or (assignment_mode = 'CONTEXTUAL' and is_assignable_global = false)
  )
);

create table if not exists public.authz_role_capabilities (
  role_code text not null
    references public.authz_role_definitions(role_code) on delete restrict,
  capability text not null
    constraint authz_role_capabilities_cap_chk check (capability in (
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
  scope_template text not null
    constraint authz_role_capabilities_scope_chk check (scope_template in (
      'OWN',
      'ALL',
      'CONTEXT_TEAM',
      'CONTEXT_DEPARTMENT',
      'CONTEXT_PROJECT'
    )),
  retired_compat boolean not null default false,
  sort_order integer not null
    constraint authz_role_capabilities_sort_chk check (sort_order >= 1),
  primary key (role_code, capability)
);

create table if not exists public.authz_account_role_assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  role_code text not null
    references public.authz_role_definitions(role_code) on delete restrict,
  scope_kind text not null default 'GLOBAL'
    constraint authz_account_role_assignments_scope_kind_chk
    check (scope_kind = 'GLOBAL'),
  scope_ref text
    constraint authz_account_role_assignments_scope_ref_chk
    check (scope_ref is null),
  source_kind text not null
    constraint authz_account_role_assignments_source_chk
    check (source_kind in ('ADMIN_ASSIGNMENT', 'PERSONNEL_LINK_AUTO', 'BACKFILL_SNAPSHOT')),
  reason text not null
    constraint authz_account_role_assignments_reason_chk
    check (
      pg_catalog.btrim(reason) = reason
      and pg_catalog.length(reason) between 3 and 500
    ),
  started_at timestamptz not null default pg_catalog.clock_timestamp(),
  ended_at timestamptz
    constraint authz_account_role_assignments_interval_chk
    check (ended_at is null or ended_at >= started_at),
  ended_reason text
    constraint authz_account_role_assignments_ended_reason_chk
    check (
      ended_reason is null
      or (
        pg_catalog.btrim(ended_reason) = ended_reason
        and pg_catalog.length(ended_reason) between 3 and 500
      )
    ),
  assigned_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  ended_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  is_protected boolean not null default false,
  protected_reason text
    constraint authz_account_role_assignments_protected_reason_chk
    check (protected_reason is null or protected_reason = 'PROTECTED_OWNER_ADMIN'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint authz_account_role_assignments_global_only_chk
    check (role_code in ('EMPLOYEE_BASE', 'RECRUITER', 'HR_OPERATOR', 'ADMIN')),
  constraint authz_account_role_assignments_protected_invariant_chk check (
    (is_protected = false and protected_reason is null)
    or (is_protected = true and role_code = 'ADMIN' and protected_reason = 'PROTECTED_OWNER_ADMIN')
  ),
  constraint authz_account_role_assignments_end_invariant_chk check (
    (ended_at is null and ended_reason is null and ended_by_app_user_id is null)
    or (ended_at is not null and ended_reason is not null and ended_by_app_user_id is not null)
  )
);

create unique index if not exists authz_account_role_assignments_open_uidx
  on public.authz_account_role_assignments (app_user_id, role_code)
  where ended_at is null;

create unique index if not exists authz_account_role_assignments_single_protected_uidx
  on public.authz_account_role_assignments (is_protected)
  where is_protected = true and ended_at is null;

create index if not exists authz_account_role_assignments_user_idx
  on public.authz_account_role_assignments (app_user_id, started_at desc, assignment_id asc);

create table if not exists public.authz_direct_capability_grants (
  direct_grant_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  capability text not null
    constraint authz_direct_capability_grants_cap_chk check (capability in (
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
  scope_kind text not null
    constraint authz_direct_capability_grants_scope_kind_chk
    check (scope_kind in ('OWN', 'ALL', 'CONTEXT_TEAM', 'CONTEXT_DEPARTMENT', 'CONTEXT_PROJECT')),
  scope_id text,
  source_kind text not null
    constraint authz_direct_capability_grants_source_chk
    check (source_kind in ('EXCEPTION_GRANT', 'BACKFILL_EXCEPTION')),
  reason text not null
    constraint authz_direct_capability_grants_reason_chk
    check (
      pg_catalog.btrim(reason) = reason
      and pg_catalog.length(reason) between 3 and 500
    ),
  started_at timestamptz not null default pg_catalog.clock_timestamp(),
  ended_at timestamptz
    constraint authz_direct_capability_grants_interval_chk
    check (ended_at is null or ended_at >= started_at),
  ended_reason text
    constraint authz_direct_capability_grants_ended_reason_chk
    check (
      ended_reason is null
      or (
        pg_catalog.btrim(ended_reason) = ended_reason
        and pg_catalog.length(ended_reason) between 3 and 500
      )
    ),
  granted_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  ended_by_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint authz_direct_capability_grants_scope_pair_chk check (
    (scope_kind in ('OWN', 'ALL') and scope_id is null)
    or (
      scope_kind in ('CONTEXT_TEAM', 'CONTEXT_DEPARTMENT', 'CONTEXT_PROJECT')
      and scope_id is not null
      and scope_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'
    )
  ),
  constraint authz_direct_capability_grants_end_invariant_chk check (
    (ended_at is null and ended_reason is null and ended_by_app_user_id is null)
    or (ended_at is not null and ended_reason is not null and ended_by_app_user_id is not null)
  )
);

create unique index if not exists authz_direct_capability_grants_open_uidx
  on public.authz_direct_capability_grants (
    app_user_id, capability, scope_kind, coalesce(scope_id, '')
  )
  where ended_at is null;

create index if not exists authz_direct_capability_grants_user_idx
  on public.authz_direct_capability_grants (app_user_id, started_at desc, direct_grant_id asc);

create table if not exists public.authz_audit_events (
  audit_event_id uuid primary key default gen_random_uuid(),
  actor_auth_subject uuid not null,
  actor_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  target_app_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  operation_name text not null
    constraint authz_audit_events_operation_chk
    check (length(pg_catalog.btrim(operation_name)) between 1 and 96),
  assignment_id uuid
    references public.authz_account_role_assignments(assignment_id) on delete restrict,
  direct_grant_id uuid
    references public.authz_direct_capability_grants(direct_grant_id) on delete restrict,
  before_payload jsonb,
  after_payload jsonb,
  reason text,
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

create index if not exists authz_audit_events_target_idx
  on public.authz_audit_events (target_app_user_id, created_at desc, audit_event_id asc);

create table if not exists public.authz_idempotency (
  idempotency_record_id uuid primary key default gen_random_uuid(),
  actor_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  target_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  operation_name text not null
    constraint authz_idempotency_operation_chk
    check (length(pg_catalog.btrim(operation_name)) between 1 and 96),
  target_key text not null
    constraint authz_idempotency_target_key_chk
    check (length(pg_catalog.btrim(target_key)) between 1 and 128),
  idempotency_key text not null
    constraint authz_idempotency_key_chk
    check (length(pg_catalog.btrim(idempotency_key)) between 1 and 128),
  request_hash text not null
    constraint authz_idempotency_hash_chk check (request_hash ~ '^[a-f0-9]{64}$'),
  response_payload jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (actor_app_user_id, target_app_user_id, operation_name, target_key, idempotency_key)
);

-- FORCE RLS + 0 policies + zero table grants across all 7 tables
alter table public.authz_system_state enable row level security;
alter table public.authz_system_state force row level security;
revoke all on table public.authz_system_state from public, anon, authenticated, service_role;

alter table public.authz_role_definitions enable row level security;
alter table public.authz_role_definitions force row level security;
revoke all on table public.authz_role_definitions from public, anon, authenticated, service_role;

alter table public.authz_role_capabilities enable row level security;
alter table public.authz_role_capabilities force row level security;
revoke all on table public.authz_role_capabilities from public, anon, authenticated, service_role;

alter table public.authz_account_role_assignments enable row level security;
alter table public.authz_account_role_assignments force row level security;
revoke all on table public.authz_account_role_assignments from public, anon, authenticated, service_role;

alter table public.authz_direct_capability_grants enable row level security;
alter table public.authz_direct_capability_grants force row level security;
revoke all on table public.authz_direct_capability_grants from public, anon, authenticated, service_role;

alter table public.authz_audit_events enable row level security;
alter table public.authz_audit_events force row level security;
revoke all on table public.authz_audit_events from public, anon, authenticated, service_role;

alter table public.authz_idempotency enable row level security;
alter table public.authz_idempotency force row level security;
revoke all on table public.authz_idempotency from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Seed authz_system_state (cutover_ready = false) + Exact 8 Canonical Roles
-- -----------------------------------------------------------------------------
insert into public.authz_system_state (singleton_id, cutover_ready, cutover_at)
values (true, false, null)
on conflict (singleton_id) do nothing;

insert into public.authz_role_definitions (
  role_code, display_name, description, assignment_mode, fixed_scope_kind,
  requires_active_person, is_assignable_global, sort_order
) values
  ('EMPLOYEE_BASE', 'Nhân viên cơ sở', 'Vai trò nền toàn cục cho tài khoản nhân sự/kế toán, không tự cấp quyền Direct Entry.', 'GLOBAL', 'none', false, true, 1),
  ('RECRUITER', 'Tuyển dụng (Recruiter)', 'Quyền nhập liệu, nộp hồ sơ và tải/xem tài liệu trong phạm vi dữ liệu tự tạo (OWN).', 'GLOBAL', 'own', false, true, 2),
  ('HR_OPERATOR', 'Vận hành nhân sự (HR Operator)', 'Quản trị danh mục tuyển dụng, đội ngũ, nhân sự tuyển dụng, nhật ký kiểm toán và xem tài liệu.', 'GLOBAL', 'all', false, true, 3),
  ('ADMIN', 'BoD/Admin', 'Vai trò điều hành/quản trị hợp nhất với bộ 21 quyền chuẩn (tách riêng 8 quyền chuyên trách ngoài gói tự cấp).', 'GLOBAL', 'all', false, true, 4),
  ('TEAM_LEADER', 'Trưởng nhóm (Team Leader)', 'Vai trò ngữ cảnh gắn với phân công Trưởng nhóm của đội đang hoạt động.', 'CONTEXTUAL', 'team', false, false, 5),
  ('DEPARTMENT_HEAD', 'Trưởng phòng ban', 'Vai trò ngữ cảnh chỉ đọc từ bổ nhiệm Trưởng phòng ban (yêu cầu nhân sự ACTIVE).', 'CONTEXTUAL', 'department', true, false, 6),
  ('PROJECT_MANAGER', 'Quản lý dự án (PM)', 'Vai trò ngữ cảnh quản lý dự án đang mở (quyết định quyền tạo tin tuyển dụng theo dự án).', 'CONTEXTUAL', 'project', false, false, 7),
  ('PROJECT_ACCOUNTANT', 'Kế toán dự án', 'Vai trò ngữ cảnh kế toán theo từng dự án được phân công.', 'CONTEXTUAL', 'project', false, false, 8)
on conflict (role_code) do update
  set display_name = excluded.display_name,
      description = excluded.description,
      assignment_mode = excluded.assignment_mode,
      fixed_scope_kind = excluded.fixed_scope_kind,
      requires_active_person = excluded.requires_active_person,
      is_assignable_global = excluded.is_assignable_global,
      sort_order = excluded.sort_order;

delete from public.authz_role_capabilities;

insert into public.authz_role_capabilities (role_code, capability, scope_template, retired_compat, sort_order) values
  -- RECRUITER (7 caps at OWN)
  ('RECRUITER', 'entry_create', 'OWN', false, 1),
  ('RECRUITER', 'entry_own', 'OWN', false, 2),
  ('RECRUITER', 'submission_create', 'OWN', false, 3),
  ('RECRUITER', 'document_upload', 'OWN', false, 4),
  ('RECRUITER', 'document_view', 'OWN', false, 5),
  ('RECRUITER', 'change_request_create', 'OWN', true, 6),
  ('RECRUITER', 'employment_status.request', 'OWN', true, 7),
  -- HR_OPERATOR (5 caps at ALL)
  ('HR_OPERATOR', 'recruiter_master_manage', 'ALL', false, 1),
  ('HR_OPERATOR', 'team_master_manage', 'ALL', false, 2),
  ('HR_OPERATOR', 'catalog_master_manage', 'ALL', false, 3),
  ('HR_OPERATOR', 'audit_view', 'ALL', false, 4),
  ('HR_OPERATOR', 'document_view', 'ALL', false, 5),
  -- ADMIN ("BoD/Admin": exact 21 caps = entry_own at OWN + 20 at ALL; zero of 8 excluded tokens)
  ('ADMIN', 'entry_own', 'OWN', false, 1),
  ('ADMIN', 'entry_admin', 'ALL', false, 2),
  ('ADMIN', 'entry_team', 'ALL', false, 3),
  ('ADMIN', 'entry_create', 'ALL', false, 4),
  ('ADMIN', 'submission_create', 'ALL', false, 5),
  ('ADMIN', 'entry_privileged_edit', 'ALL', false, 6),
  ('ADMIN', 'entry_restore', 'ALL', false, 7),
  ('ADMIN', 'recruiter_master_manage', 'ALL', false, 8),
  ('ADMIN', 'team_master_manage', 'ALL', false, 9),
  ('ADMIN', 'audit_view', 'ALL', false, 10),
  ('ADMIN', 'worker_edit_history_view', 'ALL', false, 11),
  ('ADMIN', 'document_upload', 'ALL', false, 12),
  ('ADMIN', 'document_view', 'ALL', false, 13),
  ('ADMIN', 'employment_status.review', 'ALL', false, 14),
  ('ADMIN', 'employment_status.apply', 'ALL', false, 15),
  ('ADMIN', 'change_request_create', 'ALL', true, 16),
  ('ADMIN', 'change_review', 'ALL', true, 17),
  ('ADMIN', 'employment_status.request', 'ALL', true, 18),
  ('ADMIN', 'duplicate_cccd_withdraw', 'ALL', false, 19),
  ('ADMIN', 'report_view', 'ALL', false, 20),
  ('ADMIN', 'report_analytics_view', 'ALL', false, 21),
  -- TEAM_LEADER (5 caps at CONTEXT_TEAM)
  ('TEAM_LEADER', 'entry_team', 'CONTEXT_TEAM', false, 1),
  ('TEAM_LEADER', 'team_manager_assign', 'CONTEXT_TEAM', false, 2),
  ('TEAM_LEADER', 'report_view', 'CONTEXT_TEAM', false, 3),
  ('TEAM_LEADER', 'report_analytics_view', 'CONTEXT_TEAM', false, 4),
  ('TEAM_LEADER', 'report_assign', 'CONTEXT_TEAM', false, 5),
  -- PROJECT_ACCOUNTANT (1 cap at CONTEXT_PROJECT)
  ('PROJECT_ACCOUNTANT', 'vendor_finance_view', 'CONTEXT_PROJECT', false, 1);

-- -----------------------------------------------------------------------------
-- 4. Additive Columns on Existing Tables (PR 1 Safe Defaults)
-- -----------------------------------------------------------------------------
alter table public.direct_entry_app_users
  add column if not exists authz_managed boolean not null default false;

alter table public.direct_entry_app_user_recruiter_links
  add column if not exists suspended_by_account_disable boolean not null default false;

alter table public.direct_entry_team_leader_assignments
  add column if not exists suspended_by_account_disable boolean not null default false;

alter table public.direct_entry_capability_grants
  add column if not exists suspended_by_account_disable boolean not null default false;

alter table public.direct_entry_scope_grants
  add column if not exists suspended_by_account_disable boolean not null default false;

-- -----------------------------------------------------------------------------
-- 5. New Table Guard Triggers (3 direct_entry_authz__trg_* functions)
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_authz__trg_guard_system_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'AUTHZ_SYSTEM_STATE_IMMUTABLE' using errcode = '55000';
  end if;
  if tg_op = 'INSERT' and exists (select 1 from public.authz_system_state) then
    raise exception 'AUTHZ_SYSTEM_STATE_SINGLETON' using errcode = '55000';
  end if;
  return new;
end;
$function$;

revoke all on function public.direct_entry_authz__trg_guard_system_state()
  from public, anon, authenticated, service_role;

drop trigger if exists authz_system_state_guard_trg on public.authz_system_state;
create trigger authz_system_state_guard_trg
  before insert or delete on public.authz_system_state
  for each row execute function public.direct_entry_authz__trg_guard_system_state();

create or replace function public.direct_entry_authz__trg_guard_role_assignment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_def public.authz_role_definitions%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.is_protected then
      raise exception 'AUTHZ_PROTECTED_ASSIGNMENT' using errcode = 'PT409';
    end if;
    raise exception 'AUTHZ_ASSIGNMENT_HISTORY_IMMUTABLE' using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    select d.* into v_def
      from public.authz_role_definitions d
     where d.role_code = new.role_code;
    if not found or v_def.assignment_mode <> 'GLOBAL' or not v_def.is_assignable_global then
      raise exception 'CONTEXTUAL_ROLE_NOT_GLOBALLY_ASSIGNABLE' using errcode = '22023';
    end if;
    if new.started_at > pg_catalog.clock_timestamp() then
      raise exception 'AUTHZ_FUTURE_ASSIGNMENT_FORBIDDEN' using errcode = '22023';
    end if;
    return new;
  end if;

  -- UPDATE guard
  if old.is_protected then
    if new.ended_at is not null
       or new.is_protected is distinct from old.is_protected
       or new.protected_reason is distinct from old.protected_reason
       or new.app_user_id is distinct from old.app_user_id
       or new.role_code is distinct from old.role_code
       or new.scope_kind is distinct from old.scope_kind
       or new.scope_ref is distinct from old.scope_ref then
      raise exception 'AUTHZ_PROTECTED_ASSIGNMENT' using errcode = 'PT409';
    end if;
  end if;

  if new.assignment_id is distinct from old.assignment_id
     or new.app_user_id is distinct from old.app_user_id
     or new.role_code is distinct from old.role_code
     or new.scope_kind is distinct from old.scope_kind
     or new.scope_ref is distinct from old.scope_ref
     or new.source_kind is distinct from old.source_kind
     or new.reason is distinct from old.reason
     or new.started_at is distinct from old.started_at
     or new.assigned_by_app_user_id is distinct from old.assigned_by_app_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'AUTHZ_ASSIGNMENT_IMMUTABLE_COLUMNS' using errcode = '55000';
  end if;

  if old.ended_at is not null then
    raise exception 'ROLE_ASSIGNMENT_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  if new.ended_at is not null and new.ended_at > pg_catalog.clock_timestamp() then
    raise exception 'AUTHZ_FUTURE_ASSIGNMENT_FORBIDDEN' using errcode = '22023';
  end if;

  return new;
end;
$function$;

revoke all on function public.direct_entry_authz__trg_guard_role_assignment()
  from public, anon, authenticated, service_role;

drop trigger if exists authz_account_role_assignments_guard_trg on public.authz_account_role_assignments;
create trigger authz_account_role_assignments_guard_trg
  before insert or update or delete on public.authz_account_role_assignments
  for each row execute function public.direct_entry_authz__trg_guard_role_assignment();

create or replace function public.direct_entry_authz__trg_guard_direct_grant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'AUTHZ_DIRECT_GRANT_HISTORY_IMMUTABLE' using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    if new.started_at > pg_catalog.clock_timestamp() then
      raise exception 'AUTHZ_FUTURE_ASSIGNMENT_FORBIDDEN' using errcode = '22023';
    end if;
    return new;
  end if;

  if new.direct_grant_id is distinct from old.direct_grant_id
     or new.app_user_id is distinct from old.app_user_id
     or new.capability is distinct from old.capability
     or new.scope_kind is distinct from old.scope_kind
     or new.scope_id is distinct from old.scope_id
     or new.source_kind is distinct from old.source_kind
     or new.reason is distinct from old.reason
     or new.started_at is distinct from old.started_at
     or new.granted_by_app_user_id is distinct from old.granted_by_app_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'AUTHZ_DIRECT_GRANT_IMMUTABLE_COLUMNS' using errcode = '55000';
  end if;

  if old.ended_at is not null then
    raise exception 'AUTHZ_DIRECT_GRANT_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  return new;
end;
$function$;

revoke all on function public.direct_entry_authz__trg_guard_direct_grant()
  from public, anon, authenticated, service_role;

drop trigger if exists authz_direct_capability_grants_guard_trg on public.authz_direct_capability_grants;
create trigger authz_direct_capability_grants_guard_trg
  before insert or update or delete on public.authz_direct_capability_grants
  for each row execute function public.direct_entry_authz__trg_guard_direct_grant();

drop trigger if exists authz_audit_events_immutable_trg on public.authz_audit_events;
create trigger authz_audit_events_immutable_trg
  before update or delete on public.authz_audit_events
  for each row execute function public.direct_entry_reject_immutable_change();

drop trigger if exists authz_idempotency_immutable_trg on public.authz_idempotency;
create trigger authz_idempotency_immutable_trg
  before update or delete on public.authz_idempotency
  for each row execute function public.direct_entry_reject_immutable_change();

-- -----------------------------------------------------------------------------
-- 6. Internal Helpers (Exact 5 functions matching direct_entry_authz__internal_%)
-- -----------------------------------------------------------------------------

-- 6.1 direct_entry_authz__internal_resolve_effective_grants(uuid)
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
  legacy_bridge_candidates as (
    -- Only bridge legacy capability x scope grants when NOT authz_managed (PR 1 safety).
    -- ALL-scoped capabilities paired with an effective all scope grant:
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
           and sg.valid_from <= v_today
           and (sg.valid_to is null or (sg.valid_to > sg.valid_from and v_today < sg.valid_to))
      )
    union all
    -- OWN-scoped capabilities paired with an effective own scope grant:
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
           and sg.valid_from <= v_today
           and (sg.valid_to is null or (sg.valid_to > sg.valid_from and v_today < sg.valid_to))
      )
    union all
    -- Team-scoped legacy grants (e.g. team-scoped report_review bridged before cutover):
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
      and cg.capability in ('entry_team', 'team_manager_assign', 'report_view', 'report_analytics_view', 'report_assign', 'report_review')
      and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
      and public.direct_entry__internal_team_scope_grant_effective(sg.grant_id, v_today)
  ),
  canonical_items as (
    select * from role_bundle_grants
    union all
    select * from direct_grant_items
    union all
    select * from contextual_tl_grants
    union all
    select * from contextual_pa_grants
  ),
  all_grants as (
    select * from canonical_items
    union all
    select lb.*
      from legacy_bridge_candidates lb
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

-- 6.2 direct_entry_authz__internal_has_paired_capability(uuid, text, text, text)
create or replace function public.direct_entry_authz__internal_has_paired_capability(
  p_app_user_id uuid,
  p_capability text,
  p_scope_kind text,
  p_scope_id text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_norm_scope text;
begin
  if p_app_user_id is null or p_capability is null or p_scope_kind is null then
    return false;
  end if;

  if p_capability in ('pii_view', 'pii_export', 'payment_view', 'payment_edit') then
    return false;
  end if;

  v_norm_scope := case pg_catalog.upper(pg_catalog.btrim(p_scope_kind))
    when 'OWN' then 'OWN'
    when 'ALL' then 'ALL'
    when 'TEAM' then 'CONTEXT_TEAM'
    when 'CONTEXT_TEAM' then 'CONTEXT_TEAM'
    when 'DEPARTMENT' then 'CONTEXT_DEPARTMENT'
    when 'CONTEXT_DEPARTMENT' then 'CONTEXT_DEPARTMENT'
    when 'PROJECT' then 'CONTEXT_PROJECT'
    when 'CONTEXT_PROJECT' then 'CONTEXT_PROJECT'
    else null
  end;

  if v_norm_scope is null then
    return false;
  end if;

  if v_norm_scope in ('OWN', 'ALL') and p_scope_id is not null then
    return false;
  end if;
  if v_norm_scope in ('CONTEXT_TEAM', 'CONTEXT_DEPARTMENT', 'CONTEXT_PROJECT')
     and (p_scope_id is null or pg_catalog.btrim(p_scope_id) = '') then
    return false;
  end if;

  return exists (
    select 1
      from pg_catalog.jsonb_to_recordset(
        public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
      ) as g(
        capability text,
        scope_kind text,
        scope_id text,
        source_type text,
        source_id text,
        scope_label text
      )
     where g.capability = p_capability
       and g.scope_kind = v_norm_scope
       and (
         (v_norm_scope in ('OWN', 'ALL') and g.scope_id is null)
         or (v_norm_scope in ('CONTEXT_TEAM', 'CONTEXT_DEPARTMENT', 'CONTEXT_PROJECT') and g.scope_id = p_scope_id)
       )
  );
end;
$function$;

revoke all on function public.direct_entry_authz__internal_has_paired_capability(uuid, text, text, text)
  from public, anon, authenticated, service_role;

-- 6.3 direct_entry_authz__internal_assert_full_admin(uuid, uuid)
create or replace function public.direct_entry_authz__internal_assert_full_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor public.direct_entry_app_users%rowtype;
begin
  if p_auth_subject is null or p_actor_app_user_id is null then
    raise exception 'AUTHZ_FORBIDDEN' using errcode = '42501';
  end if;

  select u.* into v_actor
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled = true;

  if not found then
    raise exception 'AUTHZ_FORBIDDEN' using errcode = '42501';
  end if;

  -- Strictly paired triple at ALL scope (never unpaired legacy fallback)
  if not (
    public.direct_entry_authz__internal_has_paired_capability(p_actor_app_user_id, 'entry_admin', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_actor_app_user_id, 'recruiter_master_manage', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_actor_app_user_id, 'team_master_manage', 'ALL', null)
  ) then
    raise exception 'AUTHZ_FORBIDDEN' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function public.direct_entry_authz__internal_assert_full_admin(uuid, uuid)
  from public, anon, authenticated, service_role;

-- 6.4 direct_entry_authz__internal_assert_idempotency(uuid, uuid, text, text, text, text)
create or replace function public.direct_entry_authz__internal_assert_idempotency(
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_operation_name text,
  p_target_key text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.authz_idempotency%rowtype;
begin
  select i.* into v_existing
    from public.authz_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.target_app_user_id = p_target_app_user_id
     and i.operation_name = p_operation_name
     and i.target_key = p_target_key
     and i.idempotency_key = p_idempotency_key
   for update;

  if not found then
    return null;
  end if;

  if v_existing.request_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
  end if;

  return v_existing.response_payload || pg_catalog.jsonb_build_object('replayed', true);
end;
$function$;

revoke all on function public.direct_entry_authz__internal_assert_idempotency(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

-- 6.5 direct_entry_authz__internal_sync_legacy_grants(uuid)
-- One-way projection from authz_* + TEAM_LEADER -> legacy direct_entry_capability_grants & scope_grants
-- ONLY runs when u.authz_managed = true (never clobbers pre-cutover PR 1 accounts).
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

  -- Desired capabilities = UNION of active authz role bundles, active direct exceptions,
  -- and any open TL capabilities while user has an open TL assignment.
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
  desired_cap_set as (
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

  -- 1) Close capability grants no longer in desired set (never re-closing closed rows)
  update public.direct_entry_capability_grants g
     set valid_to = greatest(v_today, g.valid_from),
         is_current = false,
         suspended_by_account_disable = false
   where g.app_user_id = p_app_user_id
     and (g.is_current or g.valid_to is null or g.valid_to > v_today)
     and g.valid_from <= v_today
     and not (g.capability = any(v_desired_caps));

  -- 2) Close global scope grants ('own', 'all') no longer in desired set (leave 'team' untouched)
  update public.direct_entry_scope_grants s
     set valid_to = greatest(v_today, s.valid_from),
         is_current = false,
         suspended_by_account_disable = false
   where s.app_user_id = p_app_user_id
     and s.scope_kind in ('own', 'all')
     and (s.is_current or s.valid_to is null or s.valid_to > v_today)
     and s.valid_from <= v_today
     and not (s.scope_kind = any(v_desired_scopes));

  -- 3) When enabled = true, activate or insert desired capabilities and global scopes
  if v_user.enabled then
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

-- -----------------------------------------------------------------------------
-- 7. Exact 5 Public Service-Role RPCs (direct_entry_authz_*_admin)
-- -----------------------------------------------------------------------------

-- 7.1 direct_entry_authz_list_roles_admin(uuid, uuid)
create or replace function public.direct_entry_authz_list_roles_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_roles jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'role_code', rd.role_code,
        'display_name', rd.display_name,
        'description', rd.description,
        'assignment_mode', rd.assignment_mode,
        'fixed_scope_kind', rd.fixed_scope_kind,
        'requires_active_person', rd.requires_active_person,
        'is_assignable_global', rd.is_assignable_global,
        'sort_order', rd.sort_order,
        'capabilities', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'capability', rc.capability,
              'scope_template', rc.scope_template,
              'retired_compat', rc.retired_compat
            )
            order by rc.sort_order, rc.capability
          )
          from public.authz_role_capabilities rc
          where rc.role_code = rd.role_code
        ), '[]'::jsonb)
      )
      order by rd.sort_order, rd.role_code
    ),
    '[]'::jsonb
  )
    into v_roles
    from public.authz_role_definitions rd;

  return pg_catalog.jsonb_build_object(
    'as_of', pg_catalog.to_char(v_now at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00',
    'roles', coalesce(v_roles, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.direct_entry_authz_list_roles_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_list_roles_admin(uuid, uuid)
  to service_role;

-- 7.2 direct_entry_authz_list_accounts_summary_admin
create or replace function public.direct_entry_authz_list_accounts_summary_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_search text default null,
  p_enabled text default 'all',
  p_role_code text default null,
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
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_search text := nullif(pg_catalog.btrim(p_search), '');
  v_enabled text := coalesce(nullif(pg_catalog.btrim(p_enabled), ''), 'all');
  v_role_code text := nullif(pg_catalog.btrim(p_role_code), '');
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_total integer := 0;
  v_accounts jsonb := '[]'::jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  if v_search is not null and pg_catalog.length(v_search) > 256 then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_enabled not in ('all', 'true', 'false') then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_role_code is not null and not exists (
    select 1 from public.authz_role_definitions rd where rd.role_code = v_role_code
  ) then
    raise exception 'ROLE_CODE_INVALID' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;

  v_offset := (v_page - 1) * v_page_size;

  with base_accounts as (
    select
      u.app_user_id,
      coalesce(
        nullif(pg_catalog.btrim(split_part(au.email, pg_catalog.chr(64), 1)), ''),
        u.display_name
      ) as login_id,
      u.display_name,
      u.enabled,
      u.account_type,
      u.authz_managed,
      u.version,
      u.created_at,
      p.person_id,
      p.employee_code,
      p.full_name as person_full_name,
      p.status as person_status,
      d.department_id,
      d.name as department_name,
      coalesce(p.status = 'ACTIVE', false) as has_active_person
    from public.direct_entry_app_users u
    left join auth.users au
      on au.id = u.auth_subject
    left join public.organization_account_person_links apl
      on apl.app_user_id = u.app_user_id
     and apl.ended_at is null
    left join public.organization_persons p
      on p.person_id = apl.person_id
    left join public.organization_person_department_memberships pdm
      on pdm.person_id = p.person_id
     and pdm.ended_at is null
    left join public.organization_departments d
      on d.department_id = pdm.department_id
    where (
      v_enabled = 'all'
      or (v_enabled = 'true' and u.enabled = true)
      or (v_enabled = 'false' and u.enabled = false)
    )
    and (
      v_search is null
      or lower(u.display_name) like '%' || lower(v_search) || '%'
      or lower(coalesce(split_part(au.email, pg_catalog.chr(64), 1), '')) like '%' || lower(v_search) || '%'
      or lower(coalesce(p.employee_code, '')) like '%' || lower(v_search) || '%'
      or lower(coalesce(p.full_name, '')) like '%' || lower(v_search) || '%'
    )
    and (
      v_role_code is null
      or exists (
        select 1
          from public.authz_account_role_assignments ara
         where ara.app_user_id = u.app_user_id
           and ara.role_code = v_role_code
           and ara.ended_at is null
      )
      or (
        v_role_code = 'TEAM_LEADER'
        and exists (
          select 1
            from public.direct_entry_team_leader_assignments tla
           where tla.leader_app_user_id = u.app_user_id
             and (tla.valid_to is null or v_today < tla.valid_to)
             and (tla.valid_to is null or tla.valid_to > tla.valid_from)
             and (tla.is_current or tla.suspended_by_account_disable)
        )
      )
      or (
        v_role_code = 'DEPARTMENT_HEAD'
        and p.person_id is not null
        and exists (
          select 1
            from public.organization_department_heads dh
           where dh.person_id = p.person_id
             and dh.ended_at is null
        )
      )
      or (
        v_role_code = 'PROJECT_MANAGER'
        and exists (
          select 1
            from public.direct_entry_project_manager_assignments pma
            join public.direct_entry_app_user_recruiter_links rl
              on rl.recruiter_id = pma.manager_recruiter_id
             and rl.app_user_id = u.app_user_id
             and rl.verified = true
             and (rl.valid_to is null or v_today < rl.valid_to)
             and (rl.is_current or rl.suspended_by_account_disable)
        )
      )
      or (
        v_role_code = 'PROJECT_ACCOUNTANT'
        and exists (
          select 1
            from public.vendor_finance_project_accountants pa
           where pa.accountant_user_id = u.app_user_id
             and pa.ended_at is null
             and pa.valid_from <= v_today
             and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
        )
      )
    )
  ),
  counted as (
    select count(*)::integer as total_cnt from base_accounts
  ),
  paged as (
    select *
      from base_accounts
     order by lower(display_name), lower(login_id), app_user_id
     limit v_page_size offset v_offset
  )
  select
    (select total_cnt from counted),
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'account_ref', b.app_user_id,
          'login_id', b.login_id,
          'display_name', b.display_name,
          'enabled', b.enabled,
          'account_type', b.account_type,
          'authz_managed', b.authz_managed,
          'version', b.version,
          'person', case
            when b.person_id is null then null
            else pg_catalog.jsonb_build_object(
              'person_id', b.person_id,
              'employee_code', b.employee_code,
              'full_name', b.person_full_name,
              'status', b.person_status,
              'department_id', b.department_id,
              'department_name', b.department_name
            )
          end,
          'global_roles', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'assignment_id', ara.assignment_id,
                'role_code', ara.role_code,
                'display_name', rd.display_name,
                'is_effective', (
                  b.enabled
                  and ara.ended_at is null
                  and ara.started_at <= v_now
                  and (not rd.requires_active_person or b.has_active_person)
                ),
                'is_protected', ara.is_protected,
                'can_revoke', (ara.ended_at is null and not ara.is_protected),
                'cannot_revoke_reason', case
                  when ara.ended_at is null and ara.is_protected then 'PROTECTED_OWNER_ADMIN'
                  else null
                end
              )
              order by rd.sort_order, ara.started_at, ara.assignment_id
            )
            from public.authz_account_role_assignments ara
            join public.authz_role_definitions rd on rd.role_code = ara.role_code
            where ara.app_user_id = b.app_user_id
              and ara.ended_at is null
          ), '[]'::jsonb),
          'contextual_roles', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'role_code', cr.role_code,
                'display_name', cr.display_name,
                'target_kind', cr.target_kind,
                'target_ref', cr.target_ref,
                'target_label', cr.target_label,
                'is_effective', cr.is_effective
              )
              order by cr.sort_order, cr.target_label, cr.target_ref
            )
            from (
              select
                1 as sort_order,
                'TEAM_LEADER'::text as role_code,
                'Trưởng nhóm (Team Leader)'::text as display_name,
                'TEAM'::text as target_kind,
                t.team_id::text as target_ref,
                coalesce(t.display_name, t.code) as target_label,
                (b.enabled and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)) as is_effective
              from public.direct_entry_team_leader_assignments tla
              join public.teams t on t.team_id = tla.team_id and t.code <> '__system_vendor__'
              where tla.leader_app_user_id = b.app_user_id
                and (tla.valid_to is null or v_today < tla.valid_to)
                and (tla.valid_to is null or tla.valid_to > tla.valid_from)
                and (tla.is_current or tla.suspended_by_account_disable)
              union all
              select
                2 as sort_order,
                'DEPARTMENT_HEAD'::text as role_code,
                'Trưởng phòng ban'::text as display_name,
                'DEPARTMENT'::text as target_kind,
                d2.department_id::text as target_ref,
                d2.name as target_label,
                (
                  b.enabled
                  and d2.is_active
                  and b.has_active_person
                  and dh.ended_at is null
                  and dh.started_at <= v_now
                ) as is_effective
              from public.organization_department_heads dh
              join public.organization_departments d2 on d2.department_id = dh.department_id
              where b.person_id is not null
                and dh.person_id = b.person_id
                and dh.ended_at is null
                and dh.started_at <= v_now
              union all
              select
                3 as sort_order,
                'PROJECT_MANAGER'::text as role_code,
                'Quản lý dự án (PM)'::text as display_name,
                'PROJECT'::text as target_kind,
                pr.project_id as target_ref,
                coalesce(pr.display_name, pr.project_id) as target_label,
                (
                  b.enabled
                  and pr.active
                  and r.active
                  and rl.is_current
                ) as is_effective
              from public.direct_entry_project_manager_assignments pma
              join public.direct_entry_projects pr on pr.project_id = pma.project_id
              join public.recruiters r on r.recruiter_id = pma.manager_recruiter_id
              join public.direct_entry_app_user_recruiter_links rl
                on rl.recruiter_id = pma.manager_recruiter_id
               and rl.app_user_id = b.app_user_id
               and rl.verified = true
               and (rl.valid_to is null or v_today < rl.valid_to)
               and (rl.is_current or rl.suspended_by_account_disable)
              union all
              select
                4 as sort_order,
                'PROJECT_ACCOUNTANT'::text as role_code,
                'Kế toán dự án'::text as display_name,
                'PROJECT'::text as target_kind,
                pa.project_id as target_ref,
                coalesce(pr.display_name, pa.project_id) as target_label,
                (b.enabled and pr.active) as is_effective
              from public.vendor_finance_project_accountants pa
              join public.direct_entry_projects pr on pr.project_id = pa.project_id
              where pa.accountant_user_id = b.app_user_id
                and pa.ended_at is null
                and pa.valid_from <= v_today
                and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
            ) cr
          ), '[]'::jsonb),
          'direct_exception_count', (
            select count(*)::integer
              from public.authz_direct_capability_grants dcg
             where dcg.app_user_id = b.app_user_id
               and dcg.ended_at is null
          ),
          'effective_grant_count', case
            when not b.enabled then 0
            else pg_catalog.jsonb_array_length(
              public.direct_entry_authz__internal_resolve_effective_grants(b.app_user_id)
            )
          end,
          'blocking_reasons', case
            when not b.enabled then '["ACCOUNT_DISABLED"]'::jsonb
            else '[]'::jsonb
          end
        )
        order by lower(b.display_name), lower(b.login_id), b.app_user_id
      ),
      '[]'::jsonb
    )
    into v_total, v_accounts
    from paged b;

  return pg_catalog.jsonb_build_object(
    'as_of', pg_catalog.to_char(v_now at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00',
    'search', v_search,
    'enabled', v_enabled,
    'role_code', v_role_code,
    'page', v_page,
    'page_size', v_page_size,
    'total', coalesce(v_total, 0),
    'accounts', coalesce(v_accounts, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.direct_entry_authz_list_accounts_summary_admin(uuid, uuid, text, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_list_accounts_summary_admin(uuid, uuid, text, text, text, integer, integer)
  to service_role;

-- 7.3 direct_entry_authz_get_account_access_admin(uuid, uuid, uuid)
create or replace function public.direct_entry_authz_get_account_access_admin(
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
  v_user public.direct_entry_app_users%rowtype;
  v_login_id text;
  v_person_json jsonb := null;
  v_person_id uuid := null;
  v_has_active_person boolean := false;
  v_global_roles jsonb := '[]'::jsonb;
  v_direct_exceptions jsonb := '[]'::jsonb;
  v_contextual_assignments jsonb := '[]'::jsonb;
  v_module_authorities jsonb := '[]'::jsonb;
  v_effective_grants jsonb := '[]'::jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  if p_target_app_user_id is null then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;

  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(
    nullif(pg_catalog.btrim(split_part(au.email, pg_catalog.chr(64), 1)), ''),
    v_user.display_name
  )
    into v_login_id
    from auth.users au
   where au.id = v_user.auth_subject;

  v_login_id := coalesce(v_login_id, v_user.display_name);

  select
    p.person_id,
    coalesce(p.status = 'ACTIVE', false),
    pg_catalog.jsonb_build_object(
      'person_id', p.person_id,
      'employee_code', p.employee_code,
      'full_name', p.full_name,
      'status', p.status,
      'department_id', d.department_id,
      'department_name', d.name
    )
    into v_person_id, v_has_active_person, v_person_json
    from public.organization_account_person_links apl
    join public.organization_persons p
      on p.person_id = apl.person_id
    left join public.organization_person_department_memberships pdm
      on pdm.person_id = p.person_id
     and pdm.ended_at is null
    left join public.organization_departments d
      on d.department_id = pdm.department_id
   where apl.app_user_id = p_target_app_user_id
     and apl.ended_at is null
   order by apl.started_at desc, apl.link_id desc
   limit 1;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'assignment_id', ara.assignment_id,
        'role_code', ara.role_code,
        'display_name', rd.display_name,
        'source_kind', ara.source_kind,
        'reason', ara.reason,
        'started_at', pg_catalog.to_char(ara.started_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00',
        'ended_at', case
          when ara.ended_at is null then null
          else pg_catalog.to_char(ara.ended_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00'
        end,
        'ended_reason', ara.ended_reason,
        'assigned_by_display', aby.display_name,
        'is_effective', (
          ara.ended_at is null
          and v_user.enabled
          and ara.started_at <= v_now
          and (not rd.requires_active_person or coalesce(v_has_active_person, false))
        ),
        'inactive_reason', case
          when ara.ended_at is not null then 'REVOKED'
          when not v_user.enabled then 'ACCOUNT_DISABLED'
          when rd.requires_active_person and not coalesce(v_has_active_person, false) then 'PERSON_INACTIVE'
          else null
        end,
        'is_protected', ara.is_protected,
        'can_revoke', (ara.ended_at is null and not ara.is_protected),
        'cannot_revoke_reason', case
          when ara.ended_at is null and ara.is_protected then 'PROTECTED_OWNER_ADMIN'
          else null
        end
      )
      order by (ara.ended_at is null) desc, rd.sort_order, ara.started_at desc, ara.assignment_id
    ),
    '[]'::jsonb
  )
    into v_global_roles
    from public.authz_account_role_assignments ara
    join public.authz_role_definitions rd on rd.role_code = ara.role_code
    left join public.direct_entry_app_users aby on aby.app_user_id = ara.assigned_by_app_user_id
   where ara.app_user_id = p_target_app_user_id;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'direct_grant_id', g.direct_grant_id,
        'capability', g.capability,
        'scope_kind', g.scope_kind,
        'scope_id', g.scope_id,
        'scope_label', case
          when g.scope_kind in ('OWN', 'ALL') then g.scope_kind
          when g.scope_kind = 'CONTEXT_TEAM' then coalesce(tm.display_name, tm.code, g.scope_id)
          when g.scope_kind = 'CONTEXT_PROJECT' then coalesce(pr.display_name, g.scope_id)
          when g.scope_kind = 'CONTEXT_DEPARTMENT' then coalesce(dm.name, dm.code, g.scope_id)
          else g.scope_kind
        end,
        'source_kind', g.source_kind,
        'reason', g.reason,
        'started_at', pg_catalog.to_char(g.started_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00',
        'ended_at', case
          when g.ended_at is null then null
          else pg_catalog.to_char(g.ended_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00'
        end,
        'ended_reason', g.ended_reason,
        'granted_by_display', gby.display_name,
        'is_effective', (
          g.ended_at is null
          and v_user.enabled
          and g.started_at <= v_now
          and (
            g.scope_kind in ('OWN', 'ALL')
            or (g.scope_kind = 'CONTEXT_TEAM' and tm.team_id is not null and tm.active)
            or (g.scope_kind = 'CONTEXT_PROJECT' and pr.project_id is not null and pr.active)
            or (g.scope_kind = 'CONTEXT_DEPARTMENT' and dm.department_id is not null and dm.is_active)
          )
        ),
        'inactive_reason', case
          when g.ended_at is not null then 'REVOKED'
          when not v_user.enabled then 'ACCOUNT_DISABLED'
          when g.scope_kind = 'CONTEXT_TEAM' and (tm.team_id is null or not tm.active) then 'TEAM_INACTIVE'
          when g.scope_kind = 'CONTEXT_DEPARTMENT' and (dm.department_id is null or not dm.is_active) then 'DEPARTMENT_INACTIVE'
          else null
        end
      )
      order by (g.ended_at is null) desc, g.started_at desc, g.direct_grant_id
    ),
    '[]'::jsonb
  )
    into v_direct_exceptions
    from public.authz_direct_capability_grants g
    left join public.direct_entry_app_users gby on gby.app_user_id = g.granted_by_app_user_id
    left join public.teams tm on g.scope_kind = 'CONTEXT_TEAM' and tm.team_id::text = g.scope_id
    left join public.direct_entry_projects pr on g.scope_kind = 'CONTEXT_PROJECT' and pr.project_id = g.scope_id
    left join public.organization_departments dm on g.scope_kind = 'CONTEXT_DEPARTMENT' and dm.department_id::text = g.scope_id
   where g.app_user_id = p_target_app_user_id;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'role_code', c.role_code,
        'display_name', c.display_name,
        'target_kind', c.target_kind,
        'target_ref', c.target_ref,
        'target_label', c.target_label,
        'scope_kind', c.scope_kind,
        'scope_id', c.scope_id,
        'assignment_id', c.assignment_id,
        'started_at', c.started_at_iso,
        'is_effective', c.is_effective,
        'inactive_reason', c.inactive_reason,
        'derived_capabilities', c.derived_capabilities,
        'can_revoke', false,
        'cannot_revoke_reason', 'MANAGED_IN_SOURCE_MODULE'
      )
      order by c.sort_order, c.target_label, c.target_ref
    ),
    '[]'::jsonb
  )
    into v_contextual_assignments
    from (
      select
        1 as sort_order,
        'TEAM_LEADER'::text as role_code,
        'Trưởng nhóm (Team Leader)'::text as display_name,
        'TEAM'::text as target_kind,
        t.team_id::text as target_ref,
        coalesce(t.display_name, t.code) as target_label,
        'CONTEXT_TEAM'::text as scope_kind,
        t.team_id::text as scope_id,
        tla.assignment_id,
        pg_catalog.to_char((tla.valid_from::timestamp at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' as started_at_iso,
        (v_user.enabled and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)) as is_effective,
        case
          when tla.valid_to is not null and v_today >= tla.valid_to then 'REVOKED'
          when not v_user.enabled then 'ACCOUNT_DISABLED'
          when not t.active then 'TEAM_INACTIVE'
          when not r.active then 'PERSON_INACTIVE'
          else null
        end as inactive_reason,
        coalesce((
          select pg_catalog.jsonb_agg(rc.capability order by rc.sort_order, rc.capability)
            from public.authz_role_capabilities rc
           where rc.role_code = 'TEAM_LEADER'
        ), '[]'::jsonb) as derived_capabilities
      from public.direct_entry_team_leader_assignments tla
      join public.teams t on t.team_id = tla.team_id and t.code <> '__system_vendor__'
      join public.recruiters r on r.recruiter_id = tla.leader_recruiter_id
      where tla.leader_app_user_id = p_target_app_user_id
        and (tla.valid_to is null or v_today < tla.valid_to)
        and (tla.valid_to is null or tla.valid_to > tla.valid_from)
        and (tla.is_current or tla.suspended_by_account_disable)
      union all
      select
        2 as sort_order,
        'DEPARTMENT_HEAD'::text as role_code,
        'Trưởng phòng ban'::text as display_name,
        'DEPARTMENT'::text as target_kind,
        dm.department_id::text as target_ref,
        dm.name as target_label,
        'CONTEXT_DEPARTMENT'::text as scope_kind,
        dm.department_id::text as scope_id,
        dh.head_assignment_id as assignment_id,
        pg_catalog.to_char(dh.started_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' as started_at_iso,
        (v_user.enabled and dm.is_active and coalesce(v_has_active_person, false) and dh.ended_at is null and dh.started_at <= v_now) as is_effective,
        case
          when dh.ended_at is not null then 'REVOKED'
          when not v_user.enabled then 'ACCOUNT_DISABLED'
          when not dm.is_active then 'DEPARTMENT_INACTIVE'
          when not coalesce(v_has_active_person, false) then 'PERSON_INACTIVE'
          else null
        end as inactive_reason,
        '[]'::jsonb as derived_capabilities
      from public.organization_department_heads dh
      join public.organization_departments dm on dm.department_id = dh.department_id
      where v_person_id is not null
        and dh.person_id = v_person_id
        and dh.ended_at is null
        and dh.started_at <= v_now
      union all
      select
        3 as sort_order,
        'PROJECT_MANAGER'::text as role_code,
        'Quản lý dự án (PM)'::text as display_name,
        'PROJECT'::text as target_kind,
        pr.project_id as target_ref,
        coalesce(pr.display_name, pr.project_id) as target_label,
        'CONTEXT_PROJECT'::text as scope_kind,
        pr.project_id as scope_id,
        null::uuid as assignment_id,
        pg_catalog.to_char(pma.created_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' as started_at_iso,
        (v_user.enabled and pr.active and r.active and rl.is_current) as is_effective,
        case
          when not v_user.enabled then 'ACCOUNT_DISABLED'
          when not r.active then 'PERSON_INACTIVE'
          else null
        end as inactive_reason,
        '[]'::jsonb as derived_capabilities
      from public.direct_entry_project_manager_assignments pma
      join public.direct_entry_projects pr on pr.project_id = pma.project_id
      join public.recruiters r on r.recruiter_id = pma.manager_recruiter_id
      join public.direct_entry_app_user_recruiter_links rl
        on rl.recruiter_id = pma.manager_recruiter_id
       and rl.app_user_id = p_target_app_user_id
       and rl.verified = true
       and (rl.valid_to is null or v_today < rl.valid_to)
       and (rl.is_current or rl.suspended_by_account_disable)
      union all
      select
        4 as sort_order,
        'PROJECT_ACCOUNTANT'::text as role_code,
        'Kế toán dự án'::text as display_name,
        'PROJECT'::text as target_kind,
        pa.project_id as target_ref,
        coalesce(pr.display_name, pa.project_id) as target_label,
        'CONTEXT_PROJECT'::text as scope_kind,
        pa.project_id as scope_id,
        pa.assignment_id,
        pg_catalog.to_char((pa.valid_from::timestamp at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' as started_at_iso,
        (v_user.enabled and pr.active) as is_effective,
        case
          when pa.ended_at is not null or (pa.valid_to is not null and v_today >= pa.valid_to) then 'REVOKED'
          when not v_user.enabled then 'ACCOUNT_DISABLED'
          else null
        end as inactive_reason,
        '["vendor_finance_view"]'::jsonb as derived_capabilities
      from public.vendor_finance_project_accountants pa
      join public.direct_entry_projects pr on pr.project_id = pa.project_id
      where pa.accountant_user_id = p_target_app_user_id
        and pa.ended_at is null
        and pa.valid_from <= v_today
        and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
    ) c;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'module', ma.module_code,
        'authority_code', ma.authority_code,
        'display_name', ma.display_name,
        'scope_kind', ma.scope_kind,
        'scope_ref', ma.scope_ref,
        'scope_label', ma.scope_label,
        'is_effective', ma.is_effective,
        'inactive_reason', ma.inactive_reason
      )
      order by ma.module_code, ma.authority_code, ma.scope_kind, ma.scope_ref nulls first
    ),
    '[]'::jsonb
  )
    into v_module_authorities
    from (
      select
        'vendor_finance'::text as module_code,
        r.role_code as authority_code,
        ('Vendor Finance Global (' || r.role_code || ')')::text as display_name,
        'ALL'::text as scope_kind,
        null::text as scope_ref,
        'ALL'::text as scope_label,
        (v_user.enabled and r.ended_at is null and r.valid_from <= v_today and (r.valid_to is null or (r.valid_to > r.valid_from and v_today < r.valid_to))) as is_effective,
        case
          when r.ended_at is not null or (r.valid_to is not null and v_today >= r.valid_to) then 'REVOKED'
          when not v_user.enabled then 'ACCOUNT_DISABLED'
          else null
        end as inactive_reason
      from public.vendor_finance_global_roles r
      where r.app_user_id = p_target_app_user_id
        and r.ended_at is null
        and r.valid_from <= v_today
        and (r.valid_to is null or (r.valid_to > r.valid_from and v_today < r.valid_to))
      union all
      select
        'leave'::text as module_code,
        g.role_code as authority_code,
        ('Leave Module (' || g.role_code || ')')::text as display_name,
        'ALL'::text as scope_kind,
        null::text as scope_ref,
        'ALL'::text as scope_label,
        (v_user.enabled and g.is_current and g.valid_from <= v_today and (g.valid_to is null or (g.valid_to > g.valid_from and v_today < g.valid_to))) as is_effective,
        case
          when not g.is_current or (g.valid_to is not null and v_today >= g.valid_to) then 'REVOKED'
          when not v_user.enabled then 'ACCOUNT_DISABLED'
          else null
        end as inactive_reason
      from public.leave_module_grants g
      where g.app_user_id = p_target_app_user_id
        and g.is_current = true
        and g.valid_from <= v_today
        and (g.valid_to is null or (g.valid_to > g.valid_from and v_today < g.valid_to))
      union all
      select
        'leave'::text as module_code,
        'LEAVE_DEPT_APPROVER'::text as authority_code,
        ('Leave Approver (' || a.unit_kind || ')')::text as display_name,
        'CONTEXT_DEPARTMENT'::text as scope_kind,
        a.unit_kind as scope_ref,
        a.unit_kind as scope_label,
        (v_user.enabled and a.is_current and a.valid_from <= v_today and (a.valid_to is null or (a.valid_to > a.valid_from and v_today < a.valid_to))) as is_effective,
        case
          when not a.is_current or (a.valid_to is not null and v_today >= a.valid_to) then 'REVOKED'
          when not v_user.enabled then 'ACCOUNT_DISABLED'
          else null
        end as inactive_reason
      from public.leave_department_approvers a
      where a.approver_app_user_id = p_target_app_user_id
        and a.is_current = true
        and a.valid_from <= v_today
        and (a.valid_to is null or (a.valid_to > a.valid_from and v_today < a.valid_to))
      union all
      select
        'work_reports'::text as module_code,
        case when d.capability = 'report_review' then 'REPORT_REVIEWER' else 'REPORT_ASSIGN_DELEGATE' end as authority_code,
        case when d.capability = 'report_review' then 'Work Report Reviewer' else 'Work Report Assign Delegate' end as display_name,
        case when d.scope_kind = 'all' then 'ALL' else 'CONTEXT_TEAM' end as scope_kind,
        case when d.scope_kind = 'team' then d.scope_team_id::text else null end as scope_ref,
        case when d.scope_kind = 'all' then 'ALL' else coalesce(tm.display_name, tm.code, 'Team') end as scope_label,
        (v_user.enabled and public.work_report__internal_is_delegation_effective(d.delegation_id, v_now)) as is_effective,
        case
          when not d.is_current or d.state <> 'ACTIVE' or d.revoked_at is not null or (d.effective_to is not null and v_now > d.effective_to) then 'REVOKED'
          when not v_user.enabled then 'ACCOUNT_DISABLED'
          when tm.team_id is not null and not tm.active then 'TEAM_INACTIVE'
          else null
        end as inactive_reason
      from public.work_report_delegations d
      left join public.teams tm on tm.team_id = d.scope_team_id
      where d.delegate_app_user_id = p_target_app_user_id
        and d.state = 'ACTIVE'
        and d.is_current = true
        and d.revoked_at is null
        and (d.effective_to is null or v_now <= d.effective_to)
    ) ma;

  if v_user.enabled then
    v_effective_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_target_app_user_id);
  else
    v_effective_grants := '[]'::jsonb;
  end if;

  return pg_catalog.jsonb_build_object(
    'as_of', pg_catalog.to_char(v_now at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00',
    'account', pg_catalog.jsonb_build_object(
      'account_ref', v_user.app_user_id,
      'login_id', v_login_id,
      'display_name', v_user.display_name,
      'enabled', v_user.enabled,
      'account_type', v_user.account_type,
      'authz_managed', v_user.authz_managed,
      'version', v_user.version,
      'person', v_person_json
    ),
    'blocking_reasons', case
      when not v_user.enabled then '["ACCOUNT_DISABLED"]'::jsonb
      else '[]'::jsonb
    end,
    'assigned_global_roles', coalesce(v_global_roles, '[]'::jsonb),
    'direct_exceptions', coalesce(v_direct_exceptions, '[]'::jsonb),
    'contextual_assignments', coalesce(v_contextual_assignments, '[]'::jsonb),
    'module_authorities', coalesce(v_module_authorities, '[]'::jsonb),
    'effective_grants', coalesce(v_effective_grants, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.direct_entry_authz_get_account_access_admin(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_get_account_access_admin(uuid, uuid, uuid)
  to service_role;

-- 7.4 direct_entry_authz_assign_global_role_admin
create or replace function public.direct_entry_authz_assign_global_role_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_role_code text,
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
  v_op text := 'AUTHZ_GLOBAL_ROLE_ASSIGNED';
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_role_code text := nullif(pg_catalog.btrim(p_role_code), '');
  v_role_def public.authz_role_definitions%rowtype;
  v_locked_id uuid;
  v_actor public.direct_entry_app_users%rowtype;
  v_target public.direct_entry_app_users%rowtype;
  v_cutover_ready boolean := false;
  v_replay jsonb;
  v_now timestamptz;
  v_new_version integer;
  v_inserted public.authz_account_role_assignments%rowtype;
  v_assignment_json jsonb;
  v_result jsonb;
  v_has_active_person boolean := false;
begin
  if p_auth_subject is null or p_actor_app_user_id is null then
    raise exception 'AUTHZ_FORBIDDEN' using errcode = '42501';
  end if;
  if p_target_app_user_id is null
     or p_expected_account_version is null
     or p_expected_account_version < 1
     or p_idempotency_key is null
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;
  if v_role_code is null then
    raise exception 'ROLE_CODE_INVALID' using errcode = '22023';
  end if;

  select d.* into v_role_def
    from public.authz_role_definitions d
   where d.role_code = v_role_code;
  if not found then
    raise exception 'ROLE_CODE_INVALID' using errcode = '22023';
  end if;
  if v_role_def.assignment_mode <> 'GLOBAL' or not v_role_def.is_assignable_global then
    raise exception 'CONTEXTUAL_ROLE_NOT_GLOBALLY_ASSIGNABLE' using errcode = '22023';
  end if;

  -- Lock actor and target rows in deterministic ascending UUID order (LEAST/GREATEST)
  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id asc
     for update
  loop
    null;
  end loop;

  -- Re-assert Full Admin strictly under lock
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select s.cutover_ready into v_cutover_ready
    from public.authz_system_state s
   where s.singleton_id = true;
  if not coalesce(v_cutover_ready, false) then
    raise exception 'AUTHZ_CUTOVER_NOT_READY' using errcode = 'PT409';
  end if;

  select u.* into v_actor
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotency check BEFORE OCC so replays succeed even after version bumped
  v_replay := public.direct_entry_authz__internal_assert_idempotency(
    p_actor_app_user_id,
    p_target_app_user_id,
    v_op,
    v_role_code,
    p_idempotency_key::text,
    p_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  if v_target.version <> p_expected_account_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_version', v_target.version)::text;
  end if;

  if not v_target.enabled then
    raise exception 'ACCOUNT_DISABLED' using errcode = 'PT409';
  end if;
  if v_target.account_type in ('SHARED', 'SERVICE') then
    raise exception 'ACCOUNT_TYPE_ROLE_FORBIDDEN' using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from public.authz_account_role_assignments ara
     where ara.app_user_id = p_target_app_user_id
       and ara.role_code = v_role_code
       and ara.ended_at is null
  ) then
    raise exception 'ROLE_ALREADY_ASSIGNED' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  insert into public.authz_account_role_assignments (
    app_user_id,
    role_code,
    scope_kind,
    scope_ref,
    source_kind,
    reason,
    started_at,
    assigned_by_app_user_id,
    is_protected,
    protected_reason,
    created_at
  ) values (
    p_target_app_user_id,
    v_role_code,
    'GLOBAL',
    null,
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

  insert into public.authz_audit_events (
    actor_auth_subject,
    actor_app_user_id,
    target_app_user_id,
    operation_name,
    assignment_id,
    before_payload,
    after_payload,
    reason,
    created_at
  ) values (
    p_auth_subject,
    p_actor_app_user_id,
    p_target_app_user_id,
    v_op,
    v_inserted.assignment_id,
    null,
    pg_catalog.jsonb_build_object(
      'assignment_id', v_inserted.assignment_id,
      'role_code', v_inserted.role_code,
      'source_kind', v_inserted.source_kind,
      'is_protected', v_inserted.is_protected
    ),
    v_reason,
    v_now
  );

  perform public.direct_entry_authz__internal_sync_legacy_grants(p_target_app_user_id);

  select exists (
    select 1
      from public.organization_account_person_links l
      join public.organization_persons p on p.person_id = l.person_id and p.status = 'ACTIVE'
     where l.app_user_id = p_target_app_user_id and l.ended_at is null
  ) into v_has_active_person;

  v_assignment_json := pg_catalog.jsonb_build_object(
    'assignment_id', v_inserted.assignment_id,
    'role_code', v_inserted.role_code,
    'display_name', v_role_def.display_name,
    'source_kind', v_inserted.source_kind,
    'reason', v_inserted.reason,
    'started_at', pg_catalog.to_char(v_inserted.started_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00',
    'ended_at', null,
    'ended_reason', null,
    'assigned_by_display', v_actor.display_name,
    'is_effective', (not v_role_def.requires_active_person or coalesce(v_has_active_person, false)),
    'inactive_reason', case
      when v_role_def.requires_active_person and not coalesce(v_has_active_person, false) then 'PERSON_INACTIVE'
      else null
    end,
    'is_protected', false,
    'can_revoke', true,
    'cannot_revoke_reason', null
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'account_ref', p_target_app_user_id,
    'account_version', v_new_version,
    'assignment', v_assignment_json
  );

  insert into public.authz_idempotency (
    actor_app_user_id,
    target_app_user_id,
    operation_name,
    target_key,
    idempotency_key,
    request_hash,
    response_payload,
    created_at
  ) values (
    p_actor_app_user_id,
    p_target_app_user_id,
    v_op,
    v_role_code,
    p_idempotency_key::text,
    p_request_hash,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_authz_assign_global_role_admin(uuid, uuid, uuid, text, integer, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_assign_global_role_admin(uuid, uuid, uuid, text, integer, text, uuid, text)
  to service_role;

-- 7.5 direct_entry_authz_revoke_global_role_admin
create or replace function public.direct_entry_authz_revoke_global_role_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_assignment_id uuid,
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
  v_op text := 'AUTHZ_GLOBAL_ROLE_REVOKED';
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_locked_id uuid;
  v_target public.direct_entry_app_users%rowtype;
  v_cutover_ready boolean := false;
  v_replay jsonb;
  v_existing public.authz_account_role_assignments%rowtype;
  v_updated public.authz_account_role_assignments%rowtype;
  v_role_def public.authz_role_definitions%rowtype;
  v_assigned_by_display text;
  v_now timestamptz;
  v_new_version integer;
  v_assignment_json jsonb;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null then
    raise exception 'AUTHZ_FORBIDDEN' using errcode = '42501';
  end if;
  if p_target_app_user_id is null
     or p_assignment_id is null
     or p_expected_account_version is null
     or p_expected_account_version < 1
     or p_idempotency_key is null
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) not between 3 and 500 then
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

  select s.cutover_ready into v_cutover_ready
    from public.authz_system_state s
   where s.singleton_id = true;
  if not coalesce(v_cutover_ready, false) then
    raise exception 'AUTHZ_CUTOVER_NOT_READY' using errcode = 'PT409';
  end if;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotency BEFORE OCC
  v_replay := public.direct_entry_authz__internal_assert_idempotency(
    p_actor_app_user_id,
    p_target_app_user_id,
    v_op,
    p_assignment_id::text,
    p_idempotency_key::text,
    p_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  if v_target.version <> p_expected_account_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_version', v_target.version)::text;
  end if;

  -- Strict assignment-to-account binding
  select a.* into v_existing
    from public.authz_account_role_assignments a
   where a.assignment_id = p_assignment_id
     and a.app_user_id = p_target_app_user_id
   for update;
  if not found then
    raise exception 'ROLE_ASSIGNMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Fail closed BEFORE any UPDATE / version bump if protected (even on Owner self-revoke).
  -- Never check a "last admin count": unprotected ADMIN rows revoke freely.
  if v_existing.is_protected then
    raise exception 'AUTHZ_PROTECTED_ASSIGNMENT' using errcode = 'PT409';
  end if;

  if v_existing.ended_at is not null then
    raise exception 'ROLE_ASSIGNMENT_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  update public.authz_account_role_assignments a
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_actor_app_user_id
   where a.assignment_id = p_assignment_id
  returning * into v_updated;

  update public.direct_entry_app_users u
     set authz_managed = true,
         version = u.version + 1,
         updated_at = v_now
   where u.app_user_id = p_target_app_user_id
  returning u.version into v_new_version;

  insert into public.authz_audit_events (
    actor_auth_subject,
    actor_app_user_id,
    target_app_user_id,
    operation_name,
    assignment_id,
    before_payload,
    after_payload,
    reason,
    created_at
  ) values (
    p_auth_subject,
    p_actor_app_user_id,
    p_target_app_user_id,
    v_op,
    v_updated.assignment_id,
    pg_catalog.jsonb_build_object(
      'assignment_id', v_existing.assignment_id,
      'role_code', v_existing.role_code,
      'ended_at', null
    ),
    pg_catalog.jsonb_build_object(
      'assignment_id', v_updated.assignment_id,
      'role_code', v_updated.role_code,
      'ended_at', pg_catalog.to_char(v_updated.ended_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00'
    ),
    v_reason,
    v_now
  );

  perform public.direct_entry_authz__internal_sync_legacy_grants(p_target_app_user_id);

  select d.* into v_role_def
    from public.authz_role_definitions d
   where d.role_code = v_updated.role_code;

  select u.display_name into v_assigned_by_display
    from public.direct_entry_app_users u
   where u.app_user_id = v_updated.assigned_by_app_user_id;

  v_assignment_json := pg_catalog.jsonb_build_object(
    'assignment_id', v_updated.assignment_id,
    'role_code', v_updated.role_code,
    'display_name', v_role_def.display_name,
    'source_kind', v_updated.source_kind,
    'reason', v_updated.reason,
    'started_at', pg_catalog.to_char(v_updated.started_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00',
    'ended_at', pg_catalog.to_char(v_updated.ended_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00',
    'ended_reason', v_updated.ended_reason,
    'assigned_by_display', v_assigned_by_display,
    'is_effective', false,
    'inactive_reason', 'REVOKED',
    'is_protected', false,
    'can_revoke', false,
    'cannot_revoke_reason', null
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'account_ref', p_target_app_user_id,
    'account_version', v_new_version,
    'assignment', v_assignment_json
  );

  insert into public.authz_idempotency (
    actor_app_user_id,
    target_app_user_id,
    operation_name,
    target_key,
    idempotency_key,
    request_hash,
    response_payload,
    created_at
  ) values (
    p_actor_app_user_id,
    p_target_app_user_id,
    v_op,
    p_assignment_id::text,
    p_idempotency_key::text,
    p_request_hash,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_authz_revoke_global_role_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_revoke_global_role_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 8. D10 Lifecycle Fixes, Triggers, Effectiveness Helpers & Writers (C2)
-- -----------------------------------------------------------------------------

-- 8.1 Effectiveness helpers exclude suspended_by_account_disable
create or replace function public.direct_entry__internal_team_leader_assignment_effective(
  p_assignment_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_team_leader_assignments a
      join public.teams t
        on t.team_id = a.team_id
       and t.active
       and t.code <> '__system_vendor__'
      join public.direct_entry_app_users u
        on u.app_user_id = a.leader_app_user_id
       and u.enabled
      join public.recruiters r
        on r.recruiter_id = a.leader_recruiter_id
       and r.active
     where a.assignment_id = p_assignment_id
       and not a.suspended_by_account_disable
       and a.valid_from <= p_as_of
       and (a.valid_to is null or p_as_of < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and (
         a.is_current
         or p_as_of > public.direct_entry_authorization_date()
         or (
           not a.is_current
           and not a.suspended_by_account_disable
           and exists (
             select 1
               from public.direct_entry_scope_grants s
              where s.app_user_id = a.leader_app_user_id
                and s.scope_kind = 'team'
                and s.team_id = a.team_id
                and s.valid_from <= a.valid_from
                and s.valid_to is not distinct from a.valid_to
                and (s.valid_to is null or s.valid_to > s.valid_from)
                and not s.is_current
                and not s.suspended_by_account_disable
           )
           and exists (
             select 1
               from public.direct_entry_capability_grants g
              where g.app_user_id = a.leader_app_user_id
                and g.capability = 'team_manager_assign'
                and g.valid_from = a.valid_from
                and g.valid_to is not distinct from a.valid_to
                and (g.valid_to is null or g.valid_to > g.valid_from)
                and not g.is_current
                and not g.suspended_by_account_disable
           )
           and exists (
             select 1
               from public.direct_entry_team_leader_revisions rev
              where rev.team_id = a.team_id
                and rev.action in ('designate', 'replace')
                and rev.after_snapshot->>'leader_app_user_id' = a.leader_app_user_id::text
                and rev.after_snapshot->>'valid_from' = a.valid_from::text
           )
         )
       )
  )
$function$;

revoke all on function public.direct_entry__internal_team_leader_assignment_effective(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry__internal_team_scope_grant_effective(
  p_grant_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.direct_entry_app_users u
        on u.app_user_id = s.app_user_id
       and u.enabled
      join public.teams t
        on t.team_id = s.team_id
       and t.active
     where s.grant_id = p_grant_id
       and s.scope_kind = 'team'
       and not s.suspended_by_account_disable
       and not (
         s.valid_to is not null
         and s.valid_to > s.valid_from
         and s.valid_to <= p_as_of
         and exists (
           select 1
             from public.direct_entry_team_leader_assignments a
            where a.leader_app_user_id = s.app_user_id
              and a.team_id = s.team_id
              and a.valid_to = s.valid_to
              and a.valid_to > a.valid_from
         )
       )
       and (
         s.is_current
         or (
           not s.is_current
           and not s.suspended_by_account_disable
           and s.valid_from <= p_as_of
           and (s.valid_to is null or p_as_of < s.valid_to)
           and (s.valid_to is null or s.valid_to > s.valid_from)
           and exists (
             select 1
               from public.direct_entry_team_leader_assignments a
              where a.leader_app_user_id = s.app_user_id
                and a.team_id = s.team_id
                and s.valid_from <= a.valid_from
                and s.valid_to is not distinct from a.valid_to
                and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, p_as_of)
           )
         )
       )
  )
$function$;

revoke all on function public.direct_entry__internal_team_scope_grant_effective(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry__internal_capability_grant_effective(
  p_grant_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_capability_grants g
      join public.direct_entry_app_users u
        on u.app_user_id = g.app_user_id
       and u.enabled
     where g.grant_id = p_grant_id
       and not g.suspended_by_account_disable
       and g.capability not in ('pii_view', 'pii_export', 'payment_view', 'payment_edit')
       and not (
         g.capability in ('team_manager_assign', 'report_view', 'report_analytics_view', 'report_assign', 'report_review')
         and g.valid_to is not null
         and g.valid_to > g.valid_from
         and g.valid_to <= p_as_of
         and exists (
           select 1
             from public.direct_entry_team_leader_assignments a
            where a.leader_app_user_id = g.app_user_id
              and a.valid_to = g.valid_to
              and a.valid_to > a.valid_from
         )
       )
       and (
         g.is_current
         or (
           not g.is_current
           and not g.suspended_by_account_disable
           and g.capability = 'team_manager_assign'
           and g.valid_from <= p_as_of
           and (g.valid_to is null or p_as_of < g.valid_to)
           and (g.valid_to is null or g.valid_to > g.valid_from)
           and exists (
             select 1
               from public.direct_entry_team_leader_assignments a
              where a.leader_app_user_id = g.app_user_id
                and a.valid_from = g.valid_from
                and a.valid_to is not distinct from g.valid_to
                and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, p_as_of)
           )
         )
       )
  )
$function$;

revoke all on function public.direct_entry__internal_capability_grant_effective(uuid, date)
  from public, anon, authenticated, service_role;

-- 8.2 Trigger 1 (D10): direct_entry_clear_authority_on_disable()
-- Only changes direct_entry_app_users branch: sets is_current = false,
-- suspended_by_account_disable = true while keeping valid_to NULL and keeping
-- authz_* / is_protected completely untouched.
create or replace function public.direct_entry_clear_authority_on_disable()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'UPDATE' then
    if tg_table_name = 'direct_entry_app_users' then
      if old.enabled and not new.enabled then
        update public.direct_entry_capability_grants
           set is_current = false,
               suspended_by_account_disable = true
         where app_user_id = new.app_user_id
           and is_current = true;
        update public.direct_entry_scope_grants
           set is_current = false,
               suspended_by_account_disable = true
         where app_user_id = new.app_user_id
           and is_current = true;
        update public.direct_entry_app_user_recruiter_links
           set is_current = false,
               suspended_by_account_disable = true
         where app_user_id = new.app_user_id
           and is_current = true;
        update public.direct_entry_team_leader_assignments
           set is_current = false,
               suspended_by_account_disable = true
         where leader_app_user_id = new.app_user_id
           and is_current = true;
      end if;
    elsif tg_table_name = 'recruiters' then
      if old.active and not new.active then
        update public.recruiter_team_memberships set is_current = false where recruiter_id = new.recruiter_id;
        update public.recruiter_provider_memberships set is_current = false where recruiter_id = new.recruiter_id;
        update public.direct_entry_app_user_recruiter_links set is_current = false, suspended_by_account_disable = false where recruiter_id = new.recruiter_id;
        update public.direct_entry_project_manager_assignments set is_current = false where manager_recruiter_id = new.recruiter_id;
        update public.direct_entry_team_leader_assignments set is_current = false, suspended_by_account_disable = false where leader_recruiter_id = new.recruiter_id;
      elsif not old.active and new.active then
        update public.recruiter_provider_memberships set is_current = true
         where recruiter_id = new.recruiter_id and valid_to is null
           and (select count(*) from public.recruiter_provider_memberships m
                 where m.recruiter_id = new.recruiter_id and m.valid_to is null) = 1;
      end if;
    elsif tg_table_name = 'teams' then
      if old.active and not new.active then
        update public.direct_entry_scope_grants set is_current = false, suspended_by_account_disable = false where team_id = new.team_id;
        update public.recruiter_team_memberships set is_current = false where team_id = new.team_id;
        update public.direct_entry_project_team_scopes set is_current = false where team_id = new.team_id;
        update public.direct_entry_team_leader_assignments set is_current = false, suspended_by_account_disable = false where team_id = new.team_id;
      end if;
    elsif tg_table_name = 'direct_entry_projects' then
      if old.active and not new.active then
        update public.direct_entry_project_team_scopes set is_current = false where project_id = new.project_id;
      end if;
    elsif tg_table_name = 'vendors' then
      if old.active and not new.active then
        update public.recruiter_provider_memberships set is_current = false where vendor_id = new.vendor_id;
      end if;
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.direct_entry_clear_authority_on_disable()
  from public, anon, authenticated, service_role;

-- 8.3 Trigger 2 (D10): work_report_sync_team_leader_capabilities() + trigger recreation
create or replace function public.work_report_sync_team_leader_capabilities()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_capability text;
  v_grant_id uuid;
  v_grant_from date;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if new.is_current then
    if tg_op = 'UPDATE'
       and old.valid_to is null
       and new.valid_to is not null
       and new.valid_to > new.valid_from then
      update public.direct_entry_capability_grants g
         set valid_to = greatest(new.valid_to, g.valid_from)
        from public.work_report_team_leader_capability_grants x
       where x.leader_assignment_id = new.assignment_id
         and x.capability_grant_id = g.grant_id
         and g.valid_to is null
         and not exists (
           select 1
             from public.authz_account_role_assignments ara
             join public.authz_role_capabilities rc on rc.role_code = ara.role_code
            where ara.app_user_id = g.app_user_id
              and ara.ended_at is null
              and ara.started_at <= v_now
              and rc.capability = g.capability
         )
         and not exists (
           select 1
             from public.authz_direct_capability_grants dg
            where dg.app_user_id = g.app_user_id
              and dg.ended_at is null
              and dg.started_at <= v_now
              and dg.capability = g.capability
         );
    elsif tg_op = 'UPDATE'
       and old.valid_to is not null
       and old.valid_to > old.valid_from
       and new.valid_to is null then
      update public.direct_entry_capability_grants g
         set valid_to = null,
             is_current = true,
             suspended_by_account_disable = false
        from public.work_report_team_leader_capability_grants x
       where x.leader_assignment_id = new.assignment_id
         and x.capability_grant_id = g.grant_id
         and g.valid_to = old.valid_to
         and g.valid_to > g.valid_from
         and not exists (
           select 1
             from public.direct_entry_capability_grants other
            where other.app_user_id = g.app_user_id
              and other.capability = g.capability
              and other.grant_id <> g.grant_id
              and (
                other.is_current
                or (
                  (other.valid_to is null or other.valid_to > other.valid_from)
                  and daterange(other.valid_from, other.valid_to, '[)')
                      && daterange(g.valid_from, null, '[)')
                )
              )
         );
    end if;

    -- Restore any open linked grants that were previously suspended on account disable
    update public.direct_entry_capability_grants g
       set is_current = true,
           suspended_by_account_disable = false
      from public.work_report_team_leader_capability_grants x
     where x.leader_assignment_id = new.assignment_id
       and x.capability_grant_id = g.grant_id
       and not g.is_current
       and g.valid_to is null
       and g.valid_from <= public.direct_entry_authorization_date()
       and not exists (
         select 1
           from public.direct_entry_capability_grants other
          where other.app_user_id = g.app_user_id
            and other.capability = g.capability
            and other.grant_id <> g.grant_id
            and other.is_current
       );

    foreach v_capability in array array['report_view', 'report_analytics_view', 'report_assign', 'report_review'] loop
      if not exists (
        select 1 from public.direct_entry_capability_grants g
         where g.app_user_id = new.leader_app_user_id
           and g.capability = v_capability
           and g.is_current
      ) then
        if exists (
          select 1 from public.direct_entry_capability_grants g
           where g.app_user_id = new.leader_app_user_id
             and g.capability = v_capability
             and not g.is_current
             and g.valid_to is null
        ) then
          perform set_config('direct_entry.team_leader_marker', 'on', true);
          update public.direct_entry_capability_grants g
             set valid_to = greatest(new.valid_from, g.valid_from),
                 suspended_by_account_disable = false
           where g.app_user_id = new.leader_app_user_id
             and g.capability = v_capability
             and not g.is_current
             and g.valid_to is null;
        end if;

        select greatest(new.valid_from, coalesce(max(g.valid_to), new.valid_from))
          into v_grant_from
          from public.direct_entry_capability_grants g
         where g.app_user_id = new.leader_app_user_id
           and g.capability = v_capability
           and not g.is_current
           and g.valid_to is not null
           and g.valid_to > g.valid_from
           and daterange(g.valid_from, g.valid_to, '[)') && daterange(new.valid_from, null, '[)');

        insert into public.direct_entry_capability_grants
          (app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable)
        values (new.leader_app_user_id, v_capability, v_grant_from, null, true, false)
        returning grant_id into v_grant_id;

        insert into public.work_report_team_leader_capability_grants
          (leader_assignment_id, capability, capability_grant_id)
        values (new.assignment_id, v_capability, v_grant_id)
        on conflict (leader_assignment_id, capability) do update
          set capability_grant_id = excluded.capability_grant_id;
      end if;
    end loop;
  elsif tg_op = 'UPDATE' and old.is_current and not new.is_current and new.valid_to is null and new.suspended_by_account_disable then
    -- D10 temporary disable: set is_current = false + suspended_by_account_disable = true,
    -- NEVER closing valid_to so valid_to stays NULL until an explicit revoke/replace.
    update public.direct_entry_capability_grants g
       set is_current = false,
           suspended_by_account_disable = true
      from public.work_report_team_leader_capability_grants x
     where x.leader_assignment_id = old.assignment_id
       and x.capability_grant_id = g.grant_id
       and g.is_current = true
       and g.valid_to is null;
  elsif tg_op = 'UPDATE' and (
    (old.is_current and not new.is_current and not new.suspended_by_account_disable)
    or (new.valid_to is not null and old.valid_to is distinct from new.valid_to)
  ) then
    -- Real revoke / replace / team or recruiter deactivation (works even if old.is_current = false while disabled!)
    perform set_config('direct_entry.team_leader_marker', 'on', true);
    update public.direct_entry_capability_grants g
       set is_current = false,
           suspended_by_account_disable = false,
           valid_to = greatest(coalesce(new.valid_to, g.valid_from), g.valid_from)
      from public.work_report_team_leader_capability_grants x
     where x.leader_assignment_id = old.assignment_id
       and x.capability_grant_id = g.grant_id
       and (g.is_current or g.valid_to is null)
       and not exists (
         select 1
           from public.authz_account_role_assignments ara
           join public.authz_role_capabilities rc on rc.role_code = ara.role_code
          where ara.app_user_id = g.app_user_id
            and ara.ended_at is null
            and ara.started_at <= v_now
            and rc.capability = g.capability
       )
       and not exists (
         select 1
           from public.authz_direct_capability_grants dg
          where dg.app_user_id = g.app_user_id
            and dg.ended_at is null
            and dg.started_at <= v_now
            and dg.capability = g.capability
       );
  end if;
  return new;
end;
$function$;

revoke all on function public.work_report_sync_team_leader_capabilities()
  from public, anon, authenticated, service_role;

drop trigger if exists work_report_sync_team_leader_capabilities on public.direct_entry_team_leader_assignments;
create trigger work_report_sync_team_leader_capabilities
  after insert or update of is_current, valid_to on public.direct_entry_team_leader_assignments
  for each row execute function public.work_report_sync_team_leader_capabilities();

-- 8.4 direct_entry_mutate_app_user_status (D10 enable restoration without guessing 12 pre-WP5 disabled)
create or replace function public.direct_entry_mutate_app_user_status(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_app_user_version integer,
  p_reason text,
  p_idempotency_key text,
  p_enable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_locked_id uuid;
  v_actor public.direct_entry_app_users;
  v_target public.direct_entry_app_users;
  v_action text := case when p_enable then 'enable' else 'disable' end;
  v_payload_hash text;
  v_existing_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_today date := public.direct_entry_authorization_date();
  v_rl record;
  v_tla record;
  v_can_restore_tl boolean;
  v_prev_marker text := pg_catalog.current_setting('direct_entry.team_leader_marker', true);
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_auth_subject is null or p_actor_app_user_id is null or p_target_app_user_id is null then
    raise exception 'actor and target are required' using errcode = '22023';
  end if;
  if p_expected_app_user_version is null or p_expected_app_user_version < 1 then
    raise exception 'expected app user version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id
     for update
  loop
    null;
  end loop;

  select u.* into v_actor
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id;
  if not found then
    raise exception 'actor identity is not derived from the session' using errcode = '42501';
  end if;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'action', v_action,
    'target_app_user_id', p_target_app_user_id,
    'expected_app_user_version', p_expected_app_user_version,
    'reason', p_reason
  ));

  select i.request_hash, i.result
    into v_existing_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = 'app_user_' || v_action
     and i.idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
    return v_prior;
  end if;

  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_enable and v_target.enabled then
    raise exception 'target app user is already enabled' using errcode = '23514';
  end if;
  if not p_enable and not v_target.enabled then
    raise exception 'target app user is already disabled' using errcode = '23514';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, 'app_user_' || v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_app_user_snapshot(
    p_target_app_user_id, v_target.enabled, p_actor_app_user_id
  );

  update public.direct_entry_app_users
     set enabled = p_enable,
         version = version + 1,
         updated_at = pg_catalog.clock_timestamp()
   where app_user_id = p_target_app_user_id
   returning * into v_target;

  -- D10: On enable, restore ONLY suspended_by_account_disable rows whose invariants still hold.
  -- 12 pre-WP5 disabled accounts have suspended_by_account_disable = false and 0 authz_* rows.
  if p_enable then
    -- Step 1: Restore recruiter links before TL assignments (direct_entry_set_current_on_insert checks current link)
    for v_rl in
      select l.*, r.active as recruiter_active
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = p_target_app_user_id
         and l.suspended_by_account_disable = true
       order by l.link_id
       for update of l, r
    loop
      if (v_rl.valid_to is null or v_rl.valid_to > v_today)
         and v_rl.valid_from <= v_today
         and coalesce(v_rl.recruiter_active, false)
         and v_target.account_type = 'NORMAL'
         and not exists (
           select 1 from public.direct_entry_app_user_recruiter_links other
            where other.link_id <> v_rl.link_id
              and other.is_current = true
              and (
                other.app_user_id = p_target_app_user_id
                or (v_rl.verified and other.verified and other.recruiter_id = v_rl.recruiter_id)
              )
         ) then
        update public.direct_entry_app_user_recruiter_links
           set is_current = true,
               suspended_by_account_disable = false
         where link_id = v_rl.link_id;
      else
        update public.direct_entry_app_user_recruiter_links
           set suspended_by_account_disable = false
         where link_id = v_rl.link_id;
      end if;
    end loop;

    -- Step 2: Restore TL assignments whose team, recruiter, and slot were not deactivated/replaced while disabled
    for v_tla in
      select a.*, t.active as team_active, t.code as team_code, r.active as recruiter_active
        from public.direct_entry_team_leader_assignments a
        join public.teams t on t.team_id = a.team_id
        join public.recruiters r on r.recruiter_id = a.leader_recruiter_id
       where a.leader_app_user_id = p_target_app_user_id
         and a.suspended_by_account_disable = true
       order by a.assignment_id
       for update of a, t, r
    loop
      v_can_restore_tl := (
        v_tla.valid_to is null
        and v_tla.valid_from <= v_today
        and coalesce(v_tla.team_active, false)
        and v_tla.team_code <> '__system_vendor__'
        and coalesce(v_tla.recruiter_active, false)
        and exists (
          select 1 from public.direct_entry_app_user_recruiter_links l
           where l.app_user_id = p_target_app_user_id
             and l.recruiter_id = v_tla.leader_recruiter_id
             and l.verified = true
             and l.is_current = true
        )
        and (
          select count(*)::int from public.recruiter_provider_memberships m
           where m.recruiter_id = v_tla.leader_recruiter_id
             and m.provider_type = 'hrp'
             and m.vendor_id is null
             and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
        ) = 1
        and (
          select count(*)::int from public.recruiter_team_memberships m
           where m.recruiter_id = v_tla.leader_recruiter_id
             and m.team_id = v_tla.team_id
             and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
        ) = 1
        and not exists (
          select 1 from public.direct_entry_team_leader_assignments other
           where other.assignment_id <> v_tla.assignment_id
             and (other.team_id = v_tla.team_id or other.leader_app_user_id = p_target_app_user_id)
             and (
               other.is_current
               or (
                 (other.valid_to is null or other.valid_to > other.valid_from)
                 and daterange(other.valid_from, other.valid_to, '[)') && daterange(v_today, null, '[)')
               )
             )
        )
      );

      if v_can_restore_tl then
        update public.direct_entry_scope_grants s
           set is_current = true,
               suspended_by_account_disable = false
         where s.app_user_id = p_target_app_user_id
           and s.scope_kind = 'team'
           and s.team_id = v_tla.team_id
           and s.suspended_by_account_disable = true
           and s.valid_to is null;

        update public.direct_entry_capability_grants g
           set is_current = true,
               suspended_by_account_disable = false
         where g.app_user_id = p_target_app_user_id
           and g.capability = 'team_manager_assign'
           and g.suspended_by_account_disable = true
           and g.valid_from = v_tla.valid_from
           and g.valid_to is null;

        update public.direct_entry_team_leader_assignments a
           set is_current = true,
               suspended_by_account_disable = false
         where a.assignment_id = v_tla.assignment_id;
      else
        perform pg_catalog.set_config('direct_entry.team_leader_marker', 'on', true);

        update public.direct_entry_scope_grants s
           set is_current = false,
               suspended_by_account_disable = false,
               valid_to = coalesce(s.valid_to, greatest(v_today, s.valid_from))
         where s.app_user_id = p_target_app_user_id
           and s.scope_kind = 'team'
           and s.team_id = v_tla.team_id
           and s.suspended_by_account_disable = true
           and s.valid_from <= v_tla.valid_from;

        update public.direct_entry_capability_grants g
           set is_current = false,
               suspended_by_account_disable = false,
               valid_to = coalesce(g.valid_to, greatest(v_today, g.valid_from))
         where g.app_user_id = p_target_app_user_id
           and g.capability = 'team_manager_assign'
           and g.suspended_by_account_disable = true
           and g.valid_from = v_tla.valid_from;

        update public.direct_entry_team_leader_assignments a
           set is_current = false,
               suspended_by_account_disable = false,
               valid_to = coalesce(a.valid_to, greatest(v_today, a.valid_from))
         where a.assignment_id = v_tla.assignment_id;

        perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
      end if;
    end loop;

    -- Step 3: Restore suspended global scope grants and non-TL capability grants
    update public.direct_entry_scope_grants s
       set is_current = true,
           suspended_by_account_disable = false
     where s.app_user_id = p_target_app_user_id
       and s.suspended_by_account_disable = true
       and s.scope_kind in ('own', 'all')
       and s.valid_from <= v_today
       and (s.valid_to is null or (s.valid_to > s.valid_from and v_today < s.valid_to));

    update public.direct_entry_capability_grants g
       set is_current = true,
           suspended_by_account_disable = false
     where g.app_user_id = p_target_app_user_id
       and g.suspended_by_account_disable = true
       and g.capability <> 'team_manager_assign'
       and g.valid_from <= v_today
       and (g.valid_to is null or (g.valid_to > g.valid_from and v_today < g.valid_to))
       and (
         not exists (
           select 1 from public.work_report_team_leader_capability_grants x
            where x.capability_grant_id = g.grant_id
         )
         or exists (
           select 1
             from public.work_report_team_leader_capability_grants x
             join public.direct_entry_team_leader_assignments tla
               on tla.assignment_id = x.leader_assignment_id
            where x.capability_grant_id = g.grant_id
              and tla.is_current = true
         )
         or exists (
           select 1
             from public.authz_account_role_assignments ara
             join public.authz_role_capabilities rc on rc.role_code = ara.role_code
            where ara.app_user_id = p_target_app_user_id
              and ara.ended_at is null
              and rc.capability = g.capability
         )
         or exists (
           select 1
             from public.authz_direct_capability_grants dg
            where dg.app_user_id = p_target_app_user_id
              and dg.ended_at is null
              and dg.capability = g.capability
         )
       );

    -- Clear any stale suspended_by_account_disable flags on remaining rows
    update public.direct_entry_scope_grants
       set suspended_by_account_disable = false
     where app_user_id = p_target_app_user_id
       and suspended_by_account_disable = true;

    update public.direct_entry_capability_grants
       set suspended_by_account_disable = false
     where app_user_id = p_target_app_user_id
       and suspended_by_account_disable = true;

    -- One-way sync when authz_managed = true
    if v_target.authz_managed then
      perform public.direct_entry_authz__internal_sync_legacy_grants(p_target_app_user_id);
    end if;
  end if;

  v_after := public.direct_entry_app_user_snapshot(
    p_target_app_user_id, v_target.enabled, p_actor_app_user_id
  );

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_app_user_revisions
    (app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id)
  values
    (p_target_app_user_id, v_target.version, p_actor_app_user_id, v_action,
     v_before, v_after, v_reason_id)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, app_user_revision_id)
  values
    (p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
     p_target_app_user_id::text, 'all', 'APPLIED', v_reason_id,
     array['enabled'], v_revision_id);

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'change', v_action
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, 'app_user_' || v_action, p_idempotency_key, v_result
  );
  return v_result;
exception
  when others then
    perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
    raise;
end;
$function$;

revoke all on function public.direct_entry_mutate_app_user_status(uuid, uuid, uuid, integer, text, text, boolean)
  from public, anon, authenticated, service_role;

-- 8.5 direct_entry_apply_team_leader_mutation (never auto-unsuspend disabled TL, clear suspended flag on revoke/replace/restore)
create or replace function public.direct_entry_apply_team_leader_mutation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_target_leader_app_user_id uuid,
  p_effective_date date,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text,
  p_operation text,
  p_authority text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_team public.teams;
  v_old public.direct_entry_team_leader_assignments%rowtype;
  v_new public.direct_entry_team_leader_assignments%rowtype;
  v_old_count integer := 0;
  v_origin public.direct_entry_team_leader_revisions%rowtype;
  v_previous public.direct_entry_team_leader_assignments%rowtype;
  v_prev_scope_grant_id uuid;
  v_prev_scope_grant_count integer := 0;
  v_prev_capability_grant_id uuid;
  v_prev_capability_grant_count integer := 0;
  v_restore boolean := false;
  v_restore_recruiter_id uuid;
  v_candidate_user_enabled boolean;
  v_link_count integer;
  v_verified_link_count integer;
  v_recruiter_id uuid;
  v_recruiter_active boolean;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_scope_count integer;
  v_capability_count integer;
  v_scope_grant_id uuid;
  v_capability_grant_id uuid;
  v_idempotency_action text;
  v_prior_hash text;
  v_change text;
  v_prior jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_team_version integer;
  v_before jsonb;
  v_after jsonb;
  v_changed_fields text[] := array[
    'team_leader_assignment', 'team_scope', 'team_manager_assign'
  ];
  v_actor_ids uuid[];
  v_lock_key text;
  v_post_team_assignment_count integer;
  v_post_target_team_assignment_count integer;
  v_post_target_assignment_count integer;
  v_post_scope_count integer;
  v_post_target_team_scope_count integer;
  v_post_capability_count integer;
  v_post_coextensive_scope_count integer;
  v_post_coextensive_capability_count integer;
  v_post_outgoing_assignment_count integer;
  v_post_outgoing_scope_count integer;
  v_post_outgoing_capability_count integer;
  v_post_closed_assignment_count integer;
  v_post_closed_scope_count integer;
  v_post_closed_capability_count integer;
  v_post_restored_assignment_count integer;
  v_post_restored_scope_count integer;
  v_post_restored_capability_count integer;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_operation not in ('designate', 'revoke') then
    raise exception 'invalid team leader operation' using errcode = '22023';
  end if;
  if (p_operation = 'designate') <> (p_target_leader_app_user_id is not null) then
    raise exception 'target leader does not match operation' using errcode = '22023';
  end if;
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected team version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if v_team.code = '__system_vendor__' then
    raise exception 'reserved team cannot have a leader' using errcode = '23514';
  end if;

  v_idempotency_action := case p_operation
    when 'designate' then 'team_leader_designate'
    else 'team_leader_revoke'
  end;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'team_id', p_team_id,
    'target_leader_app_user_id', p_target_leader_app_user_id,
    'effective_date', p_effective_date,
    'expected_version', p_expected_version,
    'reason', p_reason
  ));
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_app_user_id
     and i.action = v_idempotency_action
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_request_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is null then
      raise exception 'completed idempotency result is missing' using errcode = '55000';
    end if;
    return v_prior;
  end if;

  p_effective_date := coalesce(p_effective_date, v_today);
  if p_effective_date > v_today then
    raise exception 'future team leader assignments require explicit activation'
      using errcode = '22023';
  end if;
  if p_effective_date < v_today then
    raise exception 'past team leader assignments are not allowed'
      using errcode = '22023';
  end if;

  if v_team.version <> p_expected_version then
    raise exception 'team version conflict' using errcode = 'PT409';
  end if;
  if p_operation = 'designate' and not v_team.active then
    raise exception 'target team is inactive' using errcode = '23514';
  end if;

  update public.direct_entry_team_leader_assignments a
     set is_current = false,
         suspended_by_account_disable = false
   where a.team_id = p_team_id
     and a.is_current
     and a.valid_to is not null
     and a.valid_to <= v_today;

  update public.direct_entry_scope_grants s
     set is_current = false,
         suspended_by_account_disable = false
   where s.scope_kind = 'team'
     and s.team_id = p_team_id
     and s.is_current
     and s.valid_to is not null
     and s.valid_to <= v_today;

  update public.direct_entry_capability_grants g
     set is_current = false,
         suspended_by_account_disable = false
   where g.capability = 'team_manager_assign'
     and g.is_current
     and g.valid_to is not null
     and g.valid_to <= v_today
     and exists (
       select 1
         from public.direct_entry_team_leader_assignments a
        where a.team_id = p_team_id
          and a.leader_app_user_id = g.app_user_id
          and a.valid_from = g.valid_from
          and a.valid_to = g.valid_to
     );

  -- D10: NEVER reactivate suspended_by_account_disable rows here
  update public.direct_entry_team_leader_assignments a
     set is_current = true
   where a.team_id = p_team_id
     and not a.is_current
     and not a.suspended_by_account_disable
     and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today);

  update public.direct_entry_scope_grants s
     set is_current = true
   where s.scope_kind = 'team'
     and s.team_id = p_team_id
     and not s.is_current
     and not s.suspended_by_account_disable
     and public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today);

  update public.direct_entry_capability_grants g
     set is_current = true
   where g.capability = 'team_manager_assign'
     and not g.is_current
     and not g.suspended_by_account_disable
     and public.direct_entry__internal_capability_grant_effective(g.grant_id, v_today)
     and exists (
       select 1
         from public.direct_entry_team_leader_assignments a
        where a.team_id = p_team_id
          and a.leader_app_user_id = g.app_user_id
          and g.valid_from = a.valid_from
          and g.valid_to is not distinct from a.valid_to
     );

  select count(*)::int into v_old_count
    from public.direct_entry_team_leader_assignments a
   where a.team_id = p_team_id
     and (a.valid_to is null or a.valid_to > a.valid_from)
     and daterange(a.valid_from, a.valid_to, '[)')
         && daterange(p_effective_date, null, '[)');
  if v_old_count > 1 then
    raise exception 'team leader assignment is ambiguous' using errcode = '42501';
  end if;
  if v_old_count = 1 then
    select a.* into v_old
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and daterange(a.valid_from, a.valid_to, '[)')
           && daterange(p_effective_date, null, '[)')
     order by a.valid_from, a.assignment_id
     limit 1;
    if v_old.valid_from > p_effective_date then
      raise exception 'future team leader must be cancelled at its start date'
        using errcode = '23514';
    end if;
  elsif p_operation = 'revoke' then
    raise exception 'no leader assignment to revoke' using errcode = '22023';
  end if;
  if p_operation = 'designate'
     and v_old_count = 1
     and v_old.leader_app_user_id = p_target_leader_app_user_id then
    raise exception 'leader is already assigned to this team' using errcode = '23514';
  end if;

  if p_operation = 'revoke'
     and v_old_count = 1
     and p_effective_date = v_old.valid_from then
    select r.* into v_origin
      from public.direct_entry_team_leader_revisions r
     where r.team_id = p_team_id
       and r.after_snapshot->>'leader_app_user_id' = v_old.leader_app_user_id::text
       and r.after_snapshot->>'valid_from' = v_old.valid_from::text
     order by r.version desc
     limit 1;
    if found and v_origin.action = 'replace' then
      select a.* into v_previous
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and a.valid_to = v_old.valid_from
         and a.valid_from < a.valid_to
         and exists (
           select 1
             from public.direct_entry_team_leader_revisions r
            where r.team_id = p_team_id
              and r.version <= v_origin.version
              and r.action = 'replace'
              and r.after_snapshot->>'valid_from' = v_old.valid_from::text
              and r.before_snapshot->>'leader_app_user_id' = a.leader_app_user_id::text
              and r.before_snapshot->>'leader_recruiter_id' = a.leader_recruiter_id::text
              and r.before_snapshot->>'valid_from' = a.valid_from::text
              and not exists (
                select 1
                  from public.direct_entry_team_leader_revisions r2
                 where r2.team_id = p_team_id
                   and r2.version > r.version
                   and (
                     r2.action <> 'replace'
                     or r2.after_snapshot->>'valid_from' <> v_old.valid_from::text
                   )
              )
         )
       order by a.valid_from desc, a.assignment_id desc
       limit 1;
    end if;
  end if;

  v_actor_ids := array_remove(array[
    case when v_old_count = 1 then v_old.leader_app_user_id end,
    p_target_leader_app_user_id,
    v_previous.leader_app_user_id
  ]::uuid[], null);

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_actor_ids)
   order by u.app_user_id
   for update;
  if p_operation = 'designate' then
    select u.enabled into v_candidate_user_enabled
      from public.direct_entry_app_users u
     where u.app_user_id = p_target_leader_app_user_id;
    if not found or not coalesce(v_candidate_user_enabled, false) then
      raise exception 'target leader account is not enabled' using errcode = '42501';
    end if;
  end if;
  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = any(v_actor_ids)
     and s.scope_kind = 'team'
   order by s.app_user_id, s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = any(v_actor_ids)
     and g.capability = 'team_manager_assign'
   order by g.app_user_id, g.grant_id
   for update;

  for v_lock_key in
    select distinct key
      from unnest(array[
        case when v_old_count = 1 then
          'capability:' || v_old.leader_app_user_id::text || ':team_manager_assign' end,
        case when v_old_count = 1 then
          'scope:' || v_old.leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when v_previous.assignment_id is not null then
          'capability:' || v_previous.leader_app_user_id::text || ':team_manager_assign' end,
        case when v_previous.assignment_id is not null then
          'scope:' || v_previous.leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when v_previous.assignment_id is not null then
          'recruiter-link:' || v_previous.leader_app_user_id::text end,
        case when p_operation = 'designate' then
          'capability:' || p_target_leader_app_user_id::text || ':team_manager_assign' end,
        case when p_operation = 'designate' then
          'scope:' || p_target_leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when p_operation = 'designate' then
          'recruiter-link:' || p_target_leader_app_user_id::text end
      ]) as keys(key)
     where key is not null
     order by key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  if p_operation = 'designate' then
    perform l.link_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_target_leader_app_user_id
     order by l.link_id
     for update;
    select count(*)::int,
           count(*) filter (where l.verified)::int,
           (array_agg(l.recruiter_id order by l.link_id))[1]
      into v_link_count, v_verified_link_count, v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_target_leader_app_user_id
       and (
         l.is_current
         or (
           p_effective_date > v_today
           and l.valid_from <= p_effective_date
           and (l.valid_to is null or p_effective_date < l.valid_to)
           and (l.valid_to is null or l.valid_to > l.valid_from)
         )
       );
    if v_link_count <> 1 or v_verified_link_count <> 1 or v_recruiter_id is null then
      raise exception 'target leader requires exactly one verified recruiter link'
        using errcode = '42501';
    end if;

    select r.active into v_recruiter_active
      from public.recruiters r
     where r.recruiter_id = v_recruiter_id
     for update;
    if not found or not coalesce(v_recruiter_active, false) then
      raise exception 'target recruiter is not active' using errcode = '42501';
    end if;

    for v_lock_key in
      select key
        from unnest(array[
          'provider:' || v_recruiter_id::text,
          'team-membership:' || v_recruiter_id::text
        ]) as keys(key)
       order by key
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    perform m.membership_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
     order by m.membership_id
     for update;
    select count(*)::int,
           count(*) filter (
             where m.provider_type = 'hrp' and m.vendor_id is null
           )::int
      into v_provider_count, v_hrp_provider_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date);
    if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
      raise exception 'target recruiter requires exactly one effective HRP provider'
        using errcode = '42501';
    end if;

    perform m.membership_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
     order by m.membership_id
     for update;
    select count(*)::int,
           count(*) filter (where m.team_id = p_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, p_effective_date);
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'target recruiter must have exactly one effective membership in the target team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_leader_app_user_id
         and a.team_id <> p_team_id
         and (
           a.is_current
           or (
             (a.valid_to is null or a.valid_to > a.valid_from)
             and daterange(a.valid_from, a.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
    ) then
      raise exception 'target leader is assigned or scheduled for another team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = p_target_leader_app_user_id
         and s.scope_kind = 'team'
         and (
           s.is_current
           or (
             (s.valid_to is null or s.valid_to > s.valid_from)
             and daterange(s.valid_from, s.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
    ) or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_target_leader_app_user_id
         and g.capability = 'team_manager_assign'
         and (
           g.is_current
           or (
             (g.valid_to is null or g.valid_to > g.valid_from)
             and daterange(g.valid_from, g.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
    ) then
      raise exception 'target leader has pre-existing leader authority intervals'
        using errcode = '42501';
    end if;
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_old_count = 1 then
    perform a.assignment_id
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_old.assignment_id
     for update;

    select count(*)::int, (array_agg(s.grant_id order by s.grant_id))[1]
      into v_scope_count, v_scope_grant_id
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_old.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = p_team_id
       and s.valid_from <= v_old.valid_from
       and s.valid_to is not distinct from v_old.valid_to
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int, (array_agg(g.grant_id order by g.grant_id))[1]
      into v_capability_count, v_capability_grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_old.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = v_old.valid_from
       and g.valid_to is not distinct from v_old.valid_to
       and (g.valid_to is null or g.valid_to > g.valid_from);
    if v_scope_count <> 1 or v_capability_count <> 1 then
      raise exception 'leader authority interval state conflict'
        using errcode = '23514';
    end if;
    if exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team'
         and (
           s.is_current
           or (
             (s.valid_to is null or s.valid_to > s.valid_from)
             and daterange(s.valid_from, s.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
         and s.grant_id <> v_scope_grant_id
    ) or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and (
           g.is_current
           or (
             (g.valid_to is null or g.valid_to > g.valid_from)
             and daterange(g.valid_from, g.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
         and g.grant_id <> v_capability_grant_id
    ) then
      raise exception 'outgoing leader has ambiguous future authority intervals'
        using errcode = '42501';
    end if;
  end if;

  if p_operation = 'revoke' and v_previous.assignment_id is not null then
    perform a.assignment_id
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_previous.assignment_id
     for update;

    select count(*)::int, (array_agg(s.grant_id order by s.grant_id))[1]
      into v_prev_scope_grant_count, v_prev_scope_grant_id
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_previous.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = p_team_id
       and s.valid_from <= v_previous.valid_from
       and s.valid_to = v_previous.valid_to
       and s.valid_to > s.valid_from;

    select count(*)::int, (array_agg(g.grant_id order by g.grant_id))[1]
      into v_prev_capability_grant_count, v_prev_capability_grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_previous.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = v_previous.valid_from
       and g.valid_to = v_previous.valid_to
       and g.valid_to > g.valid_from;

    select (array_agg(l.recruiter_id order by l.link_id) filter (where l.verified))[1]
      into v_restore_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = v_previous.leader_app_user_id
       and l.is_current;

    if v_team.active
       and v_prev_scope_grant_count = 1
       and v_prev_capability_grant_count = 1
       and v_restore_recruiter_id is not null
       and v_restore_recruiter_id = v_previous.leader_recruiter_id
       and exists (
         select 1
           from public.direct_entry_app_users u
           join public.recruiters r on r.recruiter_id = v_restore_recruiter_id
          where u.app_user_id = v_previous.leader_app_user_id
            and u.enabled
            and r.active
       )
       and (
         select count(*)::int
           from public.direct_entry_app_user_recruiter_links l
          where l.app_user_id = v_previous.leader_app_user_id
            and l.is_current
       ) = 1
       and (
         select count(*)::int
           from public.recruiter_provider_memberships m
          where m.recruiter_id = v_restore_recruiter_id
            and m.provider_type = 'hrp'
            and m.vendor_id is null
            and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
       ) = 1
       and (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = v_restore_recruiter_id
            and m.team_id = p_team_id
            and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
       ) = 1
       and not exists (
         select 1
           from public.direct_entry_team_leader_assignments a
          where a.assignment_id not in (v_old.assignment_id, v_previous.assignment_id)
            and (a.team_id = p_team_id or a.leader_app_user_id = v_previous.leader_app_user_id)
            and (
              a.is_current
              or (
                (a.valid_to is null or a.valid_to > a.valid_from)
                and daterange(a.valid_from, a.valid_to, '[)')
                    && daterange(v_previous.valid_from, null, '[)')
              )
            )
       )
       and not exists (
         select 1
           from public.direct_entry_scope_grants s
          where s.app_user_id = v_previous.leader_app_user_id
            and s.scope_kind = 'team'
            and s.grant_id not in (v_scope_grant_id, v_prev_scope_grant_id)
            and (
              s.is_current
              or (
                (s.valid_to is null or s.valid_to > s.valid_from)
                and daterange(s.valid_from, s.valid_to, '[)')
                    && daterange(v_previous.valid_from, null, '[)')
              )
            )
       )
       and not exists (
         select 1
           from public.direct_entry_capability_grants g
          where g.app_user_id = v_previous.leader_app_user_id
            and g.capability = 'team_manager_assign'
            and g.grant_id not in (v_capability_grant_id, v_prev_capability_grant_id)
            and (
              g.is_current
              or (
                (g.valid_to is null or g.valid_to > g.valid_from)
                and daterange(g.valid_from, g.valid_to, '[)')
                    && daterange(v_previous.valid_from, null, '[)')
              )
            )
       ) then
      v_restore := true;
    end if;
  end if;

  if v_old_count = 1 then
    if p_effective_date = v_old.valid_from then
      perform set_config('direct_entry.team_leader_marker', 'on', true);
    end if;
    -- Close outgoing TL cleanly and clear suspended_by_account_disable (even if target was disabled!)
    update public.direct_entry_team_leader_assignments
       set valid_to = p_effective_date,
           is_current = (p_effective_date > v_old.valid_from and v_old.valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
           suspended_by_account_disable = false
     where assignment_id = v_old.assignment_id;
    update public.direct_entry_scope_grants
       set valid_to = p_effective_date,
           is_current = (p_effective_date > valid_from and valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
           suspended_by_account_disable = false
     where grant_id = v_scope_grant_id;
    update public.direct_entry_capability_grants
       set valid_to = p_effective_date,
           is_current = (p_effective_date > valid_from and valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
           suspended_by_account_disable = false
     where grant_id = v_capability_grant_id;
  end if;

  if v_restore then
    update public.direct_entry_team_leader_assignments
       set valid_to = null,
           is_current = (v_previous.valid_from <= v_today),
           suspended_by_account_disable = false
     where assignment_id = v_previous.assignment_id;
    update public.direct_entry_scope_grants
       set valid_to = null,
           is_current = (valid_from <= v_today),
           suspended_by_account_disable = false
     where grant_id = v_prev_scope_grant_id;
    update public.direct_entry_capability_grants
       set valid_to = null,
           is_current = (valid_from <= v_today),
           suspended_by_account_disable = false
     where grant_id = v_prev_capability_grant_id;
  end if;

  if p_operation = 'designate' then
    insert into public.direct_entry_team_leader_assignments
      (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current, suspended_by_account_disable)
    values
      (p_team_id, p_target_leader_app_user_id, v_recruiter_id, p_effective_date, (p_effective_date <= v_today), false)
    returning * into v_new;
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, team_id, valid_from, is_current, suspended_by_account_disable)
    values
      (p_target_leader_app_user_id, 'team', p_team_id, p_effective_date, (p_effective_date <= v_today), false);
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from, is_current, suspended_by_account_disable)
    values
      (p_target_leader_app_user_id, 'team_manager_assign', p_effective_date, (p_effective_date <= v_today), false);
    v_change := case when v_old_count = 1 then 'replace' else 'designate' end;
  else
    v_new := v_old;
    v_change := 'revoke';
  end if;

  if p_operation = 'designate' then
    select count(*) filter (where a.team_id = p_team_id)::int,
           count(*) filter (
             where a.team_id = p_team_id
               and a.leader_app_user_id = p_target_leader_app_user_id
           )::int,
           count(*) filter (
             where a.leader_app_user_id = p_target_leader_app_user_id
           )::int
      into v_post_team_assignment_count, v_post_target_team_assignment_count,
           v_post_target_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);

    if v_post_team_assignment_count <> 1
       or v_post_target_team_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;
    if v_post_target_assignment_count <> 1
       or v_post_target_team_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    select count(*)::int,
           count(*) filter (where s.team_id = p_team_id)::int
      into v_post_scope_count, v_post_target_team_scope_count
      from public.direct_entry_scope_grants s
     where s.app_user_id = p_target_leader_app_user_id
       and s.scope_kind = 'team'
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_target_leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
    select count(*)::int into v_post_coextensive_scope_count
      from public.direct_entry_team_leader_assignments a
      join public.direct_entry_scope_grants s
        on s.app_user_id = a.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = a.team_id
       and s.valid_from = a.valid_from
       and s.valid_to is not distinct from a.valid_to
     where a.team_id = p_team_id
       and a.leader_app_user_id = p_target_leader_app_user_id
       and a.valid_from = p_effective_date
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_coextensive_capability_count
      from public.direct_entry_team_leader_assignments a
      join public.direct_entry_capability_grants g
        on g.app_user_id = a.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = a.valid_from
       and g.valid_to is not distinct from a.valid_to
     where a.team_id = p_team_id
       and a.leader_app_user_id = p_target_leader_app_user_id
       and a.valid_from = p_effective_date
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
    if v_post_scope_count <> 1 or v_post_target_team_scope_count <> 1
       or v_post_capability_count <> 1
       or v_post_coextensive_scope_count <> 1
       or v_post_coextensive_capability_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    if v_old_count = 1 then
      select count(*)::int into v_post_outgoing_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and a.leader_app_user_id = v_old.leader_app_user_id
         and a.valid_from <= p_effective_date
         and (a.valid_to is null or p_effective_date < a.valid_to)
         and (a.valid_to is null or a.valid_to > a.valid_from);
      select count(*)::int into v_post_outgoing_scope_count
        from public.direct_entry_scope_grants s
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team' and s.team_id = p_team_id
         and s.valid_from <= p_effective_date
         and (s.valid_to is null or p_effective_date < s.valid_to)
         and (s.valid_to is null or s.valid_to > s.valid_from);
      select count(*)::int into v_post_outgoing_capability_count
        from public.direct_entry_capability_grants g
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and g.valid_from <= p_effective_date
         and (g.valid_to is null or p_effective_date < g.valid_to)
         and (g.valid_to is null or g.valid_to > g.valid_from);
      select count(*)::int into v_post_closed_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_old.assignment_id
         and a.valid_to = p_effective_date;
      select count(*)::int into v_post_closed_scope_count
        from public.direct_entry_scope_grants s
       where s.grant_id = v_scope_grant_id and s.valid_to = p_effective_date;
      select count(*)::int into v_post_closed_capability_count
        from public.direct_entry_capability_grants g
       where g.grant_id = v_capability_grant_id and g.valid_to = p_effective_date;
      if v_post_outgoing_assignment_count <> 0
         or v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_assignment_count <> 1
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    end if;
  else
    select count(*)::int into v_post_team_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);
    select count(*)::int into v_post_outgoing_scope_count
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_old.leader_app_user_id
       and s.scope_kind = 'team' and s.team_id = p_team_id
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_outgoing_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_old.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
    select count(*)::int into v_post_closed_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_old.assignment_id
       and a.valid_to = p_effective_date;
    select count(*)::int into v_post_closed_scope_count
      from public.direct_entry_scope_grants s
     where s.grant_id = v_scope_grant_id and s.valid_to = p_effective_date;
    select count(*)::int into v_post_closed_capability_count
      from public.direct_entry_capability_grants g
     where g.grant_id = v_capability_grant_id and g.valid_to = p_effective_date;
    if v_restore then
      select count(*)::int into v_post_restored_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_previous.assignment_id
         and a.valid_to is null
         and a.is_current = (v_previous.valid_from <= v_today);
      select count(*)::int into v_post_restored_scope_count
        from public.direct_entry_scope_grants s
       where s.grant_id = v_prev_scope_grant_id
         and s.valid_to is null
         and s.is_current = (s.valid_from <= v_today);
      select count(*)::int into v_post_restored_capability_count
        from public.direct_entry_capability_grants g
       where g.grant_id = v_prev_capability_grant_id
         and g.valid_to is null
         and g.is_current = (g.valid_from <= v_today);
      if v_post_team_assignment_count <> 1
         or v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_assignment_count <> 1
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1
         or v_post_restored_assignment_count <> 1
         or v_post_restored_scope_count <> 1
         or v_post_restored_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    else
      if v_post_team_assignment_count <> 0
         or v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_assignment_count <> 1
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    end if;
  end if;

  update public.teams t
     set version = t.version + 1
   where t.team_id = p_team_id
  returning t.version into v_team_version;
  if v_team_version is null then
    raise exception 'team not found' using errcode = 'P0002';
  end if;

  if v_old_count = 1 then
    v_before := public.direct_entry_team_leader_snapshot(
      p_team_id, v_old.leader_app_user_id, v_old.leader_recruiter_id,
      v_old.valid_from, v_old.valid_to, null, v_team.version, v_change
    );
  end if;
  if p_operation = 'designate' then
    v_after := public.direct_entry_team_leader_snapshot(
      p_team_id, v_new.leader_app_user_id, v_new.leader_recruiter_id,
      v_new.valid_from, v_new.valid_to,
      case when v_old_count = 1 then v_old.leader_recruiter_id end,
      v_team_version, v_change
    );
  else
    v_after := public.direct_entry_team_leader_snapshot(
      p_team_id, v_old.leader_app_user_id, v_old.leader_recruiter_id,
      v_old.valid_from, p_effective_date,
      case when v_restore then v_previous.leader_recruiter_id else null end,
      v_team_version, v_change
    );
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_team_leader_revisions
    (team_id, version, actor_user_id, action, before_snapshot, after_snapshot)
  values
    (p_team_id, v_team_version, p_app_user_id, v_change, v_before, v_after)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, leader_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_leader_' || v_change, p_authority,
     p_team_id::text, 'all', 'APPLIED', v_reason_id, v_changed_fields, v_revision_id);

  v_result := jsonb_build_object(
    'team_id', p_team_id,
    'assignment_id', v_new.assignment_id,
    'leader_app_user_id', v_new.leader_app_user_id,
    'leader_recruiter_id', v_new.leader_recruiter_id,
    'valid_from', v_new.valid_from,
    'valid_to', case when p_operation = 'revoke' then p_effective_date else v_new.valid_to end,
    'version', v_team_version,
    'revision_id', v_revision_id,
    'change', v_change
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)
  from public, anon, authenticated, service_role;

-- 8.6 Dual-write EMPLOYEE_BASE + RECRUITER in create_personnel & link_recruiter (preserving ADMIN / is_protected)
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
  v_auto_reason text;
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

  select lower(nullif(split_part(u.email, pg_catalog.chr(64), 1), '')) into v_login_id
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

  -- Dual-write EMPLOYEE_BASE + RECRUITER into authz_account_role_assignments without
  -- touching any existing ADMIN / is_protected / other global assignments.
  v_auto_reason := left(coalesce(p_reason, 'Auto-granted upon personnel creation'), 500);
  if pg_catalog.length(pg_catalog.btrim(v_auto_reason)) < 3 then
    v_auto_reason := 'Auto-granted upon personnel creation';
  end if;

  insert into public.authz_account_role_assignments (
    app_user_id, role_code, scope_kind, scope_ref, source_kind, reason, started_at, assigned_by_app_user_id
  ) values
    (p_account_ref, 'EMPLOYEE_BASE', 'GLOBAL', null, 'PERSONNEL_LINK_AUTO', v_auto_reason, v_now, p_actor_app_user_id),
    (p_account_ref, 'RECRUITER', 'GLOBAL', null, 'PERSONNEL_LINK_AUTO', v_auto_reason, v_now, p_actor_app_user_id)
  on conflict do nothing;

  update public.direct_entry_app_users set version = version + 1, updated_at = v_now
   where app_user_id = p_account_ref returning version into v_account.version;

  if v_account.authz_managed then
    perform public.direct_entry_authz__internal_sync_legacy_grants(p_account_ref);
  end if;

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
  v_auto_reason text;
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

  select lower(nullif(btrim(split_part(au.email, pg_catalog.chr(64), 1)), ''))
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

  v_auto_reason := left(coalesce(p_reason, 'Auto-granted upon recruiter account link'), 500);
  if pg_catalog.length(pg_catalog.btrim(v_auto_reason)) < 3 then
    v_auto_reason := 'Auto-granted upon recruiter account link';
  end if;

  insert into public.authz_account_role_assignments (
    app_user_id, role_code, scope_kind, scope_ref, source_kind, reason, started_at, assigned_by_app_user_id
  ) values
    (p_account_ref, 'EMPLOYEE_BASE', 'GLOBAL', null, 'PERSONNEL_LINK_AUTO', v_auto_reason, v_now, p_actor_app_user_id),
    (p_account_ref, 'RECRUITER', 'GLOBAL', null, 'PERSONNEL_LINK_AUTO', v_auto_reason, v_now, p_actor_app_user_id)
  on conflict do nothing;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = v_now
   where app_user_id = p_account_ref
  returning version into v_account.version;

  if v_account.authz_managed then
    perform public.direct_entry_authz__internal_sync_legacy_grants(p_account_ref);
  end if;

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
    p_auth_subject, p_actor_app_user_id, 'link_create', 'entry_admin', p_account_ref::text,
    'all', 'APPLIED', v_reason_id, array['recruiter_link'], v_app_user_revision_id
  );

  v_result := jsonb_build_object(
    'recruiter_id', v_recruiter.recruiter_id,
    'display_name', v_recruiter.display_name,
    'personnel_code', v_recruiter.personnel_code,
    'personnel_position', v_recruiter.personnel_position,
    'app_user_id', p_account_ref,
    'link_id', v_link_id,
    'app_user_version', v_account.version,
    'recruiter_version', v_recruiter.version,
    'app_user_revision_id', v_app_user_revision_id
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

-- 8.7 Block SHARED/SERVICE conversion when active authz role or direct capability grant exists
create or replace function public.org_department__internal_has_personal_assignments(
  p_app_user_id uuid,
  p_as_of timestamptz default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_eff_now timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_today date := (v_eff_now at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  if p_app_user_id is null then
    return false;
  end if;

  return exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = p_app_user_id
       and l.ended_at is null
  ) or exists (
    select 1
      from public.organization_department_memberships lm
     where lm.app_user_id = p_app_user_id
       and (
         lm.valid_to is null
         or (lm.valid_from <= v_today and v_today < lm.valid_to and lm.valid_to > lm.valid_from)
       )
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = p_app_user_id
       and rl.verified = true
       and (
         rl.is_current = true
         or rl.suspended_by_account_disable = true
       )
       and (rl.valid_to is null or v_today < rl.valid_to)
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments tla
     where tla.leader_app_user_id = p_app_user_id
       and (
         tla.is_current = true
         or tla.suspended_by_account_disable = true
       )
       and (tla.valid_to is null or v_today < tla.valid_to)
  ) or exists (
    select 1
      from public.leave_department_approvers lda
     where lda.approver_app_user_id = p_app_user_id
       and lda.is_current = true
       and (lda.valid_to is null or v_today <= lda.valid_to)
  ) or exists (
    select 1
      from public.work_report_delegations wrd
     where (wrd.grantor_user_id = p_app_user_id or wrd.delegate_app_user_id = p_app_user_id)
       and (
         public.work_report__internal_is_delegation_effective(wrd.delegation_id, v_eff_now)
         or (
           wrd.is_current = true
           and wrd.state = 'ACTIVE'
           and wrd.revoked_at is null
           and wrd.effective_from <= v_eff_now
           and (wrd.effective_to is null or v_eff_now <= wrd.effective_to)
         )
       )
  ) or exists (
    select 1
      from public.authz_account_role_assignments ara
     where ara.app_user_id = p_app_user_id
       and ara.ended_at is null
       and ara.started_at <= v_eff_now
  ) or exists (
    select 1
      from public.authz_direct_capability_grants dg
     where dg.app_user_id = p_app_user_id
       and dg.ended_at is null
       and dg.started_at <= v_eff_now
  );
end;
$function$;

revoke all on function public.org_department__internal_has_personal_assignments(uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 9. Additive Extension to direct_entry_resolve_actor_context(uuid)
--    Preserves all legacy Web PR 0 payload keys + adds effective_grants & assigned_roles
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_resolve_actor_context(p_auth_subject uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_app_user_id uuid;
  v_enabled boolean;
  v_review_scopes jsonb;
  v_team_leader_team_id uuid := null;
  v_allowed_worker_tabs jsonb := '[]'::jsonb;
  v_effective_grants jsonb := '[]'::jsonb;
  v_assigned_roles jsonb := '[]'::jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_has_active_person boolean := false;
begin
  select u.app_user_id, u.enabled
    into v_app_user_id, v_enabled
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject;
  if not found then return null; end if;

  select case when not u.enabled then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind', s.kind,
      'team_id', s.team_id,
      'label', s.label
    ) order by case when s.kind = 'all' then 0 else 1 end, s.label, s.team_id)
      from (
        select distinct
          raw_scopes.kind,
          raw_scopes.team_id,
          raw_scopes.label
        from (
          select 'all'::text as kind, null::uuid as team_id, 'Toàn công ty'::text as label
           where public.direct_entry_has_capability(u.app_user_id, 'report_review')
             and public.direct_entry_has_scope(u.app_user_id, 'all')
          union all
          select 'team'::text as kind, t.team_id, coalesce(t.display_name, t.code) as label
            from public.direct_entry_scope_grants g
            join public.teams t on t.team_id = g.team_id and t.active
           where public.direct_entry_has_capability(u.app_user_id, 'report_review')
             and g.app_user_id = u.app_user_id
             and g.scope_kind = 'team'
             and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
          union all
          select d.scope_kind as kind,
                 case when d.scope_kind = 'team' then d.scope_team_id else null end as team_id,
                 case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end as label
            from public.work_report_delegations d
            left join public.teams tm on tm.team_id = d.scope_team_id
           where d.delegate_app_user_id = u.app_user_id
             and d.capability = 'report_review'
             and d.state = 'ACTIVE'
             and d.is_current
             and statement_timestamp() >= d.effective_from
             and (d.effective_to is null or statement_timestamp() <= d.effective_to)
             and public.work_report__internal_is_delegation_effective(d.delegation_id, statement_timestamp())
        ) raw_scopes
      ) s
  ), '[]'::jsonb) end
    into v_review_scopes
    from public.direct_entry_app_users u
   where u.app_user_id = v_app_user_id;

  if v_enabled and public.direct_entry_has_capability(v_app_user_id, 'team_manager_assign') then
    begin
      v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
        p_auth_subject, v_app_user_id, null
      );
    exception when insufficient_privilege then
      v_team_leader_team_id := null;
    end;
  end if;

  if v_enabled then
    select coalesce(
      jsonb_agg(t.tab_id order by t.ord),
      '[]'::jsonb
    )
    into v_allowed_worker_tabs
    from (
      select 'uploader'::text as tab_id, 1 as ord
       where (
         (
           select count(*)::integer
             from public.direct_entry_scope_grants g
            where g.app_user_id = v_app_user_id
              and g.scope_kind = 'own'
              and g.team_id is null
              and g.is_current
         ) = 1
         and public.direct_entry_has_capability(v_app_user_id, 'submission_create')
       )
       or public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'recruited'::text as tab_id, 2 as ord
       where (
         select count(*)::integer
           from public.direct_entry_app_user_recruiter_links l
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
       ) = 1
       and exists (
         select 1
           from public.direct_entry_app_user_recruiter_links l
           join public.recruiters r
             on r.recruiter_id = l.recruiter_id
            and r.active
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
       )
      union all
      select 'managed'::text as tab_id, 3 as ord
       where public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'team'::text as tab_id, 4 as ord
       where v_team_leader_team_id is not null
      union all
      select 'all'::text as tab_id, 5 as ord
       where public.direct_entry_has_scope(v_app_user_id, 'all')
         and (
           public.direct_entry_has_capability(v_app_user_id, 'entry_admin')
           or public.direct_entry_has_capability(v_app_user_id, 'change_review')
         )
    ) t;

    v_effective_grants := public.direct_entry_authz__internal_resolve_effective_grants(v_app_user_id);

    select exists (
      select 1
        from public.organization_account_person_links l
        join public.organization_persons p on p.person_id = l.person_id and p.status = 'ACTIVE'
       where l.app_user_id = v_app_user_id and l.ended_at is null
    ) into v_has_active_person;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'role_code', ar.role_code,
          'display_name', ar.display_name,
          'assignment_mode', ar.assignment_mode,
          'scope_kind', ar.scope_kind,
          'scope_id', ar.scope_id,
          'assignment_id', ar.assignment_id,
          'is_protected', ar.is_protected,
          'can_revoke', ar.can_revoke,
          'cannot_revoke_reason', ar.cannot_revoke_reason
        )
        order by ar.sort_order, ar.role_code, ar.scope_id nulls first
      ),
      '[]'::jsonb
    )
      into v_assigned_roles
      from (
        select
          rd.sort_order,
          ara.role_code,
          rd.display_name,
          'GLOBAL'::text as assignment_mode,
          null::text as scope_kind,
          null::text as scope_id,
          ara.assignment_id::text as assignment_id,
          ara.is_protected,
          (not ara.is_protected) as can_revoke,
          case when ara.is_protected then 'PROTECTED_OWNER_ADMIN' else null end as cannot_revoke_reason
        from public.authz_account_role_assignments ara
        join public.authz_role_definitions rd on rd.role_code = ara.role_code
        where ara.app_user_id = v_app_user_id
          and ara.ended_at is null
          and ara.started_at <= v_now
          and (not rd.requires_active_person or coalesce(v_has_active_person, false))
        union all
        select
          5 as sort_order,
          'TEAM_LEADER'::text as role_code,
          'Trưởng nhóm (Team Leader)'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_TEAM'::text as scope_kind,
          t.team_id::text as scope_id,
          tla.assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.direct_entry_team_leader_assignments tla
        join public.teams t on t.team_id = tla.team_id and t.active and t.code <> '__system_vendor__'
        where tla.leader_app_user_id = v_app_user_id
          and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
        union all
        select
          6 as sort_order,
          'DEPARTMENT_HEAD'::text as role_code,
          'Trưởng phòng ban'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_DEPARTMENT'::text as scope_kind,
          dh.department_id::text as scope_id,
          dh.head_assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.organization_account_person_links apl
        join public.organization_department_heads dh on dh.person_id = apl.person_id and dh.ended_at is null and dh.started_at <= v_now
        join public.organization_departments dm on dm.department_id = dh.department_id and dm.is_active
        where apl.app_user_id = v_app_user_id
          and apl.ended_at is null
          and coalesce(v_has_active_person, false)
        union all
        select
          7 as sort_order,
          'PROJECT_MANAGER'::text as role_code,
          'Quản lý dự án (PM)'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_PROJECT'::text as scope_kind,
          pma.project_id as scope_id,
          null::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.direct_entry_project_manager_assignments pma
        join public.direct_entry_projects pr on pr.project_id = pma.project_id and pr.active
        join public.recruiters r on r.recruiter_id = pma.manager_recruiter_id and r.active
        join public.direct_entry_app_user_recruiter_links rl
          on rl.recruiter_id = pma.manager_recruiter_id
         and rl.app_user_id = v_app_user_id
         and rl.verified = true
         and rl.is_current = true
         and (rl.valid_to is null or v_today < rl.valid_to)
        union all
        select
          8 as sort_order,
          'PROJECT_ACCOUNTANT'::text as role_code,
          'Kế toán dự án'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_PROJECT'::text as scope_kind,
          pa.project_id as scope_id,
          pa.assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.vendor_finance_project_accountants pa
        join public.direct_entry_projects pr on pr.project_id = pa.project_id and pr.active
        where pa.accountant_user_id = v_app_user_id
          and pa.ended_at is null
          and pa.valid_from <= v_today
          and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
      ) ar;
  end if;

  return (
    select jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'display_name', u.display_name,
      'enabled', u.enabled,
      'capabilities', coalesce((
        select jsonb_agg(distinct g.capability order by g.capability)
          from public.direct_entry_capability_grants g
         where g.app_user_id = u.app_user_id
           and public.direct_entry__internal_capability_grant_effective(g.grant_id)
      ), '[]'::jsonb),
      'recruiter_links', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', l.app_user_id, 'recruiter_id', l.recruiter_id, 'verified', l.verified,
          'valid_from', l.valid_from, 'valid_to', l.valid_to
        ) order by l.valid_from, l.recruiter_id)
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
         where l.app_user_id = u.app_user_id and l.verified and l.is_current and u.enabled
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', t.team_id, 'code', t.code,
          'display', t.display_name, 'active', t.active) order by t.team_id)
          from public.teams t
         where t.active and exists (
           select 1 from public.direct_entry_scope_grants g
            where g.app_user_id = u.app_user_id and g.scope_kind = 'team'
              and g.team_id = t.team_id
              and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
         )
      ), '[]'::jsonb),
      'team_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', g.team_id,
          'valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from, g.team_id)
          from public.direct_entry_scope_grants g
          join public.teams t on t.team_id = g.team_id and t.active
         where g.app_user_id = u.app_user_id
           and g.scope_kind = 'team'
           and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
      ), '[]'::jsonb),
      'all_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from)
          from public.direct_entry_scope_grants g
         where g.app_user_id = u.app_user_id and g.scope_kind = 'all' and g.is_current and u.enabled
      ), '[]'::jsonb),
      'allowed_worker_tabs', v_allowed_worker_tabs,
      'effective_grants', coalesce(v_effective_grants, '[]'::jsonb),
      'assigned_roles', coalesce(v_assigned_roles, '[]'::jsonb)
    ) || case
      when jsonb_array_length(v_review_scopes) > 0 then jsonb_build_object('effective_report_review_scopes', v_review_scopes)
      else '{}'::jsonb
    end
    from public.direct_entry_app_users u where u.app_user_id = v_app_user_id
  );
end;
$function$;

revoke all on function public.direct_entry_resolve_actor_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_actor_context(uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 10. Guarded Owner Alignment ($align_wp5b$) & Fail-Closed Security Check ($check_wp5b$)
-- -----------------------------------------------------------------------------
do $align_wp5b$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_tbl regclass;
  v_tbl_owner oid;
  v_fn regprocedure;
  v_proc_owner oid;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner is null then
    raise exception 'WP5B1_OWNER_RESOLUTION_FAILED' using errcode = '55000';
  end if;

  if not pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    return;
  end if;

  for v_tbl, v_tbl_owner in
    select c.oid::pg_catalog.regclass, c.relowner
      from pg_catalog.pg_class c
     where c.oid in (
       'public.authz_system_state'::pg_catalog.regclass,
       'public.authz_role_definitions'::pg_catalog.regclass,
       'public.authz_role_capabilities'::pg_catalog.regclass,
       'public.authz_account_role_assignments'::pg_catalog.regclass,
       'public.authz_direct_capability_grants'::pg_catalog.regclass,
       'public.authz_audit_events'::pg_catalog.regclass,
       'public.authz_idempotency'::pg_catalog.regclass
     )
  loop
    if v_tbl_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter table %s owner to %I', v_tbl, v_owner);
    end if;
  end loop;

  for v_fn, v_proc_owner in
    select p.oid::pg_catalog.regprocedure, p.proowner
      from pg_catalog.pg_proc p
     where p.oid in (
       'public.direct_entry_authz_list_roles_admin(uuid,uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_authz_list_accounts_summary_admin(uuid,uuid,text,text,text,integer,integer)'::pg_catalog.regprocedure,
       'public.direct_entry_authz_get_account_access_admin(uuid,uuid,uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_authz_assign_global_role_admin(uuid,uuid,uuid,text,integer,text,uuid,text)'::pg_catalog.regprocedure,
       'public.direct_entry_authz_revoke_global_role_admin(uuid,uuid,uuid,uuid,integer,text,uuid,text)'::pg_catalog.regprocedure,
       'public.direct_entry_authz__internal_resolve_effective_grants(uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_authz__internal_assert_full_admin(uuid,uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_authz__internal_assert_idempotency(uuid,uuid,text,text,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_authz__internal_sync_legacy_grants(uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_authz__trg_guard_system_state()'::pg_catalog.regprocedure,
       'public.direct_entry_authz__trg_guard_role_assignment()'::pg_catalog.regprocedure,
       'public.direct_entry_authz__trg_guard_direct_grant()'::pg_catalog.regprocedure,
       'public.direct_entry__internal_team_leader_assignment_effective(uuid,date)'::pg_catalog.regprocedure,
       'public.direct_entry__internal_team_scope_grant_effective(uuid,date)'::pg_catalog.regprocedure,
       'public.direct_entry__internal_capability_grant_effective(uuid,date)'::pg_catalog.regprocedure,
       'public.direct_entry_clear_authority_on_disable()'::pg_catalog.regprocedure,
       'public.work_report_sync_team_leader_capabilities()'::pg_catalog.regprocedure,
       'public.direct_entry_mutate_app_user_status(uuid,uuid,uuid,integer,text,text,boolean)'::pg_catalog.regprocedure,
       'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_account_operation_create_personnel(uuid,uuid,uuid,integer,text,text,date,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_account_operation_link_recruiter(uuid,uuid,uuid,integer,uuid,integer,text,text)'::pg_catalog.regprocedure,
       'public.org_department__internal_has_personal_assignments(uuid,timestamptz)'::pg_catalog.regprocedure,
       'public.direct_entry_resolve_actor_context(uuid)'::pg_catalog.regprocedure
     )
  loop
    if v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;
end
$align_wp5b$;

do $check_wp5b$
declare
  v_base_owner_oid oid;
  v_public_rpcs text[] := array[
    'public.direct_entry_authz_list_roles_admin(uuid,uuid)',
    'public.direct_entry_authz_list_accounts_summary_admin(uuid,uuid,text,text,text,integer,integer)',
    'public.direct_entry_authz_get_account_access_admin(uuid,uuid,uuid)',
    'public.direct_entry_authz_assign_global_role_admin(uuid,uuid,uuid,text,integer,text,uuid,text)',
    'public.direct_entry_authz_revoke_global_role_admin(uuid,uuid,uuid,uuid,integer,text,uuid,text)'
  ];
  v_internal_fns text[] := array[
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)',
    'public.direct_entry_authz__internal_assert_full_admin(uuid,uuid)',
    'public.direct_entry_authz__internal_assert_idempotency(uuid,uuid,text,text,text,text)',
    'public.direct_entry_authz__internal_sync_legacy_grants(uuid)',
    'public.direct_entry_authz__trg_guard_system_state()',
    'public.direct_entry_authz__trg_guard_role_assignment()',
    'public.direct_entry_authz__trg_guard_direct_grant()',
    'public.direct_entry__internal_team_leader_assignment_effective(uuid,date)',
    'public.direct_entry__internal_team_scope_grant_effective(uuid,date)',
    'public.direct_entry__internal_capability_grant_effective(uuid,date)',
    'public.direct_entry_clear_authority_on_disable()',
    'public.work_report_sync_team_leader_capabilities()',
    'public.direct_entry_mutate_app_user_status(uuid,uuid,uuid,integer,text,text,boolean)',
    'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)',
    'public.org_department__internal_has_personal_assignments(uuid,timestamptz)'
  ];
  v_updated_service_rpcs text[] := array[
    'public.direct_entry_account_operation_create_personnel(uuid,uuid,uuid,integer,text,text,date,text,text)',
    'public.direct_entry_account_operation_link_recruiter(uuid,uuid,uuid,integer,uuid,integer,text,text)',
    'public.direct_entry_resolve_actor_context(uuid)'
  ];
  v_tables text[] := array[
    'public.authz_system_state',
    'public.authz_role_definitions',
    'public.authz_role_capabilities',
    'public.authz_account_role_assignments',
    'public.authz_direct_capability_grants',
    'public.authz_audit_events',
    'public.authz_idempotency'
  ];
  v_sig text;
  v_tbl text;
  v_oid oid;
  v_rec record;
  v_count integer;
begin
  select c.relowner into v_base_owner_oid
    from pg_catalog.pg_class c
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  -- 1. Zero function overloads in direct_entry_authz*
  if exists (
    select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'direct_entry_authz%'
     group by p.proname
    having count(*) > 1
  ) then
    raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: overload detected'
      using errcode = '55000';
  end if;

  -- 2. All 7 tables: FORCE RLS, 0 policies, 0 privileges for public/anon/authenticated/service_role
  foreach v_tbl in array v_tables loop
    v_oid := pg_catalog.to_regclass(v_tbl);
    if v_oid is null then
      raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: missing table %', v_tbl
        using errcode = '55000';
    end if;

    select c.relrowsecurity, c.relforcerowsecurity, c.relowner
      into v_rec
      from pg_catalog.pg_class c
     where c.oid = v_oid;

    if not coalesce(v_rec.relrowsecurity, false)
       or not coalesce(v_rec.relforcerowsecurity, false) then
      raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: table % lacks FORCE RLS', v_tbl
        using errcode = '55000';
    end if;

    if exists (
      select 1
        from pg_catalog.pg_policy pol
       where pol.polrelid = v_oid
    ) then
      raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: table % has unexpected policy', v_tbl
        using errcode = '55000';
    end if;

    if pg_catalog.has_table_privilege('public', v_oid, 'SELECT, INSERT, UPDATE, DELETE')
       or pg_catalog.has_table_privilege('anon', v_oid, 'SELECT, INSERT, UPDATE, DELETE')
       or pg_catalog.has_table_privilege('authenticated', v_oid, 'SELECT, INSERT, UPDATE, DELETE')
       or pg_catalog.has_table_privilege('service_role', v_oid, 'SELECT, INSERT, UPDATE, DELETE') then
      raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: unexpected table grant on %', v_tbl
        using errcode = '55000';
    end if;
  end loop;

  -- 3. Public RPCs: prosecdef, search_path, bypassrls/super owner, service_role EXECUTE only
  foreach v_sig in array v_public_rpcs || v_updated_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: missing RPC %', v_sig
        using errcode = '55000';
    end if;

    select p.prosecdef, p.proconfig, p.proowner, p.proacl, r.rolsuper, r.rolbypassrls
      into v_rec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[])))
       or not (coalesce(v_rec.rolsuper, false) or coalesce(v_rec.rolbypassrls, false))
       or not pg_catalog.pg_has_role(v_rec.proowner, v_base_owner_oid, 'USAGE') then
      raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: owner/config invalid for %', v_sig
        using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(v_rec.proacl, '{}'::aclitem[])) a
          where a.grantee = 0
       ) then
      raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: ACL invalid for %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  -- 4. Internal/trigger functions: prosecdef, search_path, bypassrls/super owner, 0 execute privileges
  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: missing internal %', v_sig
        using errcode = '55000';
    end if;

    select p.prosecdef, p.proconfig, p.proowner, p.proacl, r.rolsuper, r.rolbypassrls
      into v_rec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[])))
       or not (coalesce(v_rec.rolsuper, false) or coalesce(v_rec.rolbypassrls, false)) then
      raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: internal owner/config invalid for %', v_sig
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(v_rec.proacl, '{}'::aclitem[])) a
          where a.grantee = 0
       ) then
      raise exception 'WP5B1 RPC security definer owner/RLS/ACL boundary drift: internal ACL invalid for %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  -- 5. Exact 8-role catalog & ADMIN capability partition + PR 1 cutover_ready = false
  select count(*)::integer into v_count from public.authz_role_definitions;
  if v_count <> 8 then
    raise exception 'WP5B1 role catalog drift: expected 8 roles, found %', v_count using errcode = '55000';
  end if;

  if exists (
    select 1
      from public.authz_role_capabilities
     where role_code = 'ADMIN'
       and capability in (
         'catalog_master_manage', 'team_manager_assign', 'report_form_manage',
         'report_assign', 'report_review', 'report_delegate',
         'vendor_finance_view', 'vendor_finance_record'
       )
  ) then
    raise exception 'WP5B1 role catalog drift: ADMIN granted forbidden capability' using errcode = '55000';
  end if;

  if (select count(*)::integer from public.authz_role_capabilities where role_code = 'ADMIN') <> 21
     or (select count(*)::integer from public.authz_role_capabilities where role_code = 'RECRUITER') <> 7
     or (select count(*)::integer from public.authz_role_capabilities where role_code = 'HR_OPERATOR') <> 5
     or (select count(*)::integer from public.authz_role_capabilities where role_code = 'EMPLOYEE_BASE') <> 0
     or (select count(*)::integer from public.authz_role_capabilities where role_code = 'TEAM_LEADER') <> 5
     or (select count(*)::integer from public.authz_role_capabilities where role_code = 'DEPARTMENT_HEAD') <> 0
     or (select count(*)::integer from public.authz_role_capabilities where role_code = 'PROJECT_MANAGER') <> 0
     or (select count(*)::integer from public.authz_role_capabilities where role_code = 'PROJECT_ACCOUNTANT') <> 1 then
    raise exception 'WP5B1 role catalog drift: capability counts mismatch' using errcode = '55000';
  end if;

  if exists (select 1 from public.authz_system_state where cutover_ready <> false) then
    raise exception 'WP5B1 cutover_ready must remain false in PR 1' using errcode = '55000';
  end if;
end
$check_wp5b$;

commit;
