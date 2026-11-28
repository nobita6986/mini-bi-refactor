-- =============================================================================
-- Partner Accounts (Vendor & Collaborator Portal Identity) & Vendor Portal Data
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. Nullable `address` & `phone` columns + constraints on `public.vendors`
--      and `public.collaborators`.
--   2. `public.partner_code_registry` & `public.partner_accounts` (ENABLE+FORCE
--      RLS, REVOKE ALL from public, anon, authenticated, service_role), plus
--      concurrency-safe immutability & cross-catalog uniqueness triggers.
--   3. Safe backfill for all non-conflicting vendors (excluding
--      `__system_vendor__`) and collaborators (`count(*) = 1` across both).
--   4. Isolation trigger on `public.authz_user_group_members`, hardening on
--      `direct_entry_mutate_app_user_status`, `direct_entry_assert_actor_mapping`,
--      `direct_entry_authz__internal_resolve_effective_grants`,
--      `hr_bulletin__internal_assert_active_actor`, and
--      `direct_entry_resolve_actor_context(uuid)`.
--   5. Updated Vendor & Collaborator catalog RPCs with trailing `p_address` /
--      `p_phone`, `display_name` sync, and atomic deactivate/reactivate sync.
--   6. 10 `service_role`-only `partner_*` RPCs (provisioning preflight/begin/
--      finalize/rotate, activation, password-change completion, profile read/
--      update, and strictly-scoped aggregate/worker Vendor Portal reads).
--   7. Owner alignment & fail-closed `$postcheck$`.
-- =============================================================================

begin;

-- =============================================================================
-- SECTION 1: Address & Phone Normalization Helpers + Catalog Table Columns
-- =============================================================================

create or replace function public.partner__internal_normalize_address(
  p_address text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_trimmed text;
begin
  if p_address is null then
    return null;
  end if;
  v_trimmed := nullif(pg_catalog.btrim(p_address), '');
  if v_trimmed is null then
    return null;
  end if;
  if pg_catalog.length(v_trimmed) < 1
     or pg_catalog.length(v_trimmed) > 500
     or v_trimmed ~ '[\x00-\x1f\x7f]' then
    raise exception 'PARTNER_ADDRESS_INVALID' using errcode = '22023';
  end if;
  return v_trimmed;
end;
$function$;
revoke all on function public.partner__internal_normalize_address(text)
  from public, anon, authenticated, service_role;

create or replace function public.partner__internal_normalize_phone(
  p_phone text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_trimmed text;
begin
  if p_phone is null then
    return null;
  end if;
  v_trimmed := nullif(pg_catalog.btrim(p_phone), '');
  if v_trimmed is null then
    return null;
  end if;
  if pg_catalog.length(v_trimmed) < 6
     or pg_catalog.length(v_trimmed) > 32
     or v_trimmed !~ '^[0-9 +().-]+$' then
    raise exception 'PARTNER_PHONE_INVALID' using errcode = '22023';
  end if;
  return v_trimmed;
end;
$function$;
revoke all on function public.partner__internal_normalize_phone(text)
  from public, anon, authenticated, service_role;

alter table public.vendors
  add column if not exists address text,
  add column if not exists phone text;

alter table public.vendors
  drop constraint if exists vendors_address_check,
  add constraint vendors_address_check check (
    address is null
    or (
      address = pg_catalog.btrim(address)
      and pg_catalog.length(address) between 1 and 500
      and address !~ '[\x00-\x1f\x7f]'
    )
  ),
  drop constraint if exists vendors_phone_check,
  add constraint vendors_phone_check check (
    phone is null
    or (
      phone = pg_catalog.btrim(phone)
      and pg_catalog.length(phone) between 6 and 32
      and phone ~ '^[0-9 +().-]+$'
    )
  );

alter table public.collaborators
  add column if not exists address text,
  add column if not exists phone text;

alter table public.collaborators
  drop constraint if exists collaborators_address_check,
  add constraint collaborators_address_check check (
    address is null
    or (
      address = pg_catalog.btrim(address)
      and pg_catalog.length(address) between 1 and 500
      and address !~ '[\x00-\x1f\x7f]'
    )
  ),
  drop constraint if exists collaborators_phone_check,
  add constraint collaborators_phone_check check (
    phone is null
    or (
      phone = pg_catalog.btrim(phone)
      and pg_catalog.length(phone) between 6 and 32
      and phone ~ '^[0-9 +().-]+$'
    )
  );

-- =============================================================================
-- SECTION 2: Partner Code Registry & Partner Accounts Tables (Deny-by-Default)
-- =============================================================================

create table public.partner_code_registry (
  canonical_code text primary key
    check (
      canonical_code = pg_catalog.lower(pg_catalog.btrim(canonical_code))
      and pg_catalog.length(canonical_code) between 1 and 128
      and canonical_code ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      and canonical_code <> '__system_vendor__'
    ),
  partner_kind text not null
    check (partner_kind in ('VENDOR', 'COLLABORATOR')),
  vendor_id text unique
    references public.vendors(vendor_id) on delete restrict,
  collaborator_id text unique
    references public.collaborators(collaborator_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint partner_code_registry_xor_chk check (
    (partner_kind = 'VENDOR' and vendor_id is not null and collaborator_id is null)
    or
    (partner_kind = 'COLLABORATOR' and collaborator_id is not null and vendor_id is null)
  ),
  constraint partner_code_registry_code_match_chk check (
    (partner_kind = 'VENDOR' and canonical_code = pg_catalog.lower(pg_catalog.btrim(vendor_id)))
    or
    (partner_kind = 'COLLABORATOR' and canonical_code = pg_catalog.lower(pg_catalog.btrim(collaborator_id)))
  )
);

alter table public.partner_code_registry enable row level security;
alter table public.partner_code_registry force row level security;
revoke all on table public.partner_code_registry
  from public, anon, authenticated, service_role;

comment on table public.partner_code_registry is
  'Case-folded unique registry enforcing cross-catalog partner code uniqueness across public.vendors and public.collaborators. Service RPC internal only.';

create table public.partner_accounts (
  partner_account_id uuid primary key default gen_random_uuid(),
  partner_kind text not null
    check (partner_kind in ('VENDOR', 'COLLABORATOR')),
  vendor_id text unique
    references public.vendors(vendor_id) on delete restrict,
  collaborator_id text unique
    references public.collaborators(collaborator_id) on delete restrict,
  canonical_code text not null unique
    references public.partner_code_registry(canonical_code) on delete restrict,
  app_user_id uuid unique
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  username text unique
    check (username is null or public.direct_entry_is_canonical_login_id(username)),
  account_state text not null default 'UNPROVISIONED'
    check (account_state in (
      'UNPROVISIONED',
      'PENDING_ACTIVATION',
      'ACTIVE_MUST_CHANGE_PASSWORD',
      'ACTIVE',
      'SUSPENDED'
    )),
  activation_code_hash text
    check (activation_code_hash is null or activation_code_hash ~ '^[a-f0-9]{64}$'),
  activation_expires_at timestamptz,
  activation_attempts integer not null default 0
    check (activation_attempts >= 0),
  activated_at timestamptz,
  must_change_password boolean not null default false,
  password_changed_at timestamptz,
  provision_intent_id uuid
    references public.direct_entry_account_operation_intents(intent_id) on delete restrict,
  version integer not null default 1
    check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partner_accounts_xor_chk check (
    (partner_kind = 'VENDOR' and vendor_id is not null and collaborator_id is null)
    or
    (partner_kind = 'COLLABORATOR' and collaborator_id is not null and vendor_id is null)
  ),
  constraint partner_accounts_state_invariants_chk check (
    (
      account_state = 'UNPROVISIONED'
      and app_user_id is null
      and username is null
      and activated_at is null
      and must_change_password = false
      and activation_code_hash is null
    )
    or (
      account_state = 'PENDING_ACTIVATION'
      and app_user_id is not null
      and username is not null
      and activated_at is null
      and must_change_password = true
    )
    or (
      account_state = 'ACTIVE_MUST_CHANGE_PASSWORD'
      and app_user_id is not null
      and username is not null
      and activated_at is not null
      and must_change_password = true
    )
    or (
      account_state = 'ACTIVE'
      and app_user_id is not null
      and username is not null
      and activated_at is not null
      and must_change_password = false
    )
    or (
      account_state = 'SUSPENDED'
      and app_user_id is not null
      and username is not null
      and activated_at is not null
    )
  )
);

create index partner_accounts_provision_intent_idx
  on public.partner_accounts (provision_intent_id)
  where provision_intent_id is not null;

create trigger partner_accounts_set_updated_at
  before update on public.partner_accounts
  for each row execute function public.set_updated_at();

alter table public.partner_accounts enable row level security;
alter table public.partner_accounts force row level security;
revoke all on table public.partner_accounts
  from public, anon, authenticated, service_role;

comment on table public.partner_accounts is
  'Partner portal identity and activation lifecycle bound 1:1 to either a Vendor or a Collaborator. Never stores plaintext passwords or plaintext activation codes.';

-- =============================================================================
-- SECTION 3: Safe Backfill of Non-Conflicting Vendors & Collaborators
-- =============================================================================

with all_partner_codes as (
  select pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) as canonical_code
    from public.vendors v
   where v.vendor_id <> '__system_vendor__'
  union all
  select pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) as canonical_code
    from public.collaborators c
   where c.collaborator_id <> '__system_vendor__'
),
unique_codes as (
  select apc.canonical_code
    from all_partner_codes apc
   group by apc.canonical_code
  having count(*) = 1
),
inserted_registry as (
  insert into public.partner_code_registry (
    canonical_code, partner_kind, vendor_id, collaborator_id
  )
  select u.canonical_code, 'VENDOR'::text, v.vendor_id, null::text
    from unique_codes u
    join public.vendors v
      on pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) = u.canonical_code
     and v.vendor_id <> '__system_vendor__'
  union all
  select u.canonical_code, 'COLLABORATOR'::text, null::text, c.collaborator_id
    from unique_codes u
    join public.collaborators c
      on pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) = u.canonical_code
     and c.collaborator_id <> '__system_vendor__'
  on conflict do nothing
  returning canonical_code, partner_kind, vendor_id, collaborator_id
)
insert into public.partner_accounts (
  partner_kind, vendor_id, collaborator_id, canonical_code, account_state
)
select
  r.partner_kind,
  r.vendor_id,
  r.collaborator_id,
  r.canonical_code,
  'UNPROVISIONED'
from inserted_registry r
on conflict do nothing;

-- =============================================================================
-- SECTION 4: Internal Account Helpers & Catalog Code / Group Isolation Triggers
-- =============================================================================

create or replace function public.partner__internal_is_partner_app_user(
  p_app_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null
     and exists (
       select 1
         from public.partner_accounts pa
        where pa.app_user_id = p_app_user_id
     )
$function$;
revoke all on function public.partner__internal_is_partner_app_user(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.partner__internal_account_summary_by_partner(
  p_partner_kind text,
  p_partner_id text
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select
    case
      when pa.partner_account_id is null then null
      else pg_catalog.jsonb_build_object(
        'partner_account_id', pa.partner_account_id,
        'partner_kind', pa.partner_kind,
        'vendor_id', pa.vendor_id,
        'collaborator_id', pa.collaborator_id,
        'partner_id', coalesce(pa.vendor_id, pa.collaborator_id),
        'canonical_code', pa.canonical_code,
        'account_state', pa.account_state,
        'app_user_id', pa.app_user_id,
        'username', pa.username,
        'activated_at', pa.activated_at,
        'must_change_password', pa.must_change_password,
        'password_changed_at', pa.password_changed_at,
        'activation_expires_at', pa.activation_expires_at,
        'activation_attempts', pa.activation_attempts,
        'version', pa.version
      )
    end
    from public.partner_accounts pa
   where pa.partner_kind = p_partner_kind
     and (
       (p_partner_kind = 'VENDOR' and pa.vendor_id = p_partner_id)
       or
       (p_partner_kind = 'COLLABORATOR' and pa.collaborator_id = p_partner_id)
     )
   limit 1
$function$;
revoke all on function public.partner__internal_account_summary_by_partner(text, text)
  from public, anon, authenticated, service_role;

create or replace function public.partner__internal_guard_catalog_code()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_code text;
  v_old_code text;
  v_canonical text;
begin
  if tg_table_name = 'vendors' then
    v_code := new.vendor_id;
    v_old_code := case when tg_op = 'UPDATE' then old.vendor_id else null end;
  elsif tg_table_name = 'collaborators' then
    v_code := new.collaborator_id;
    v_old_code := case when tg_op = 'UPDATE' then old.collaborator_id else null end;
  else
    raise exception 'unexpected table % in partner__internal_guard_catalog_code', tg_table_name
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if v_code is distinct from v_old_code then
      raise exception 'PARTNER_CODE_IMMUTABLE' using errcode = '22023';
    end if;
    return new;
  end if;

  if v_code = '__system_vendor__' then
    return new;
  end if;

  v_canonical := pg_catalog.lower(pg_catalog.btrim(v_code));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('partner_code:' || v_canonical, 0)
  );

  if exists (
       select 1
         from public.partner_code_registry r
        where r.canonical_code = v_canonical
     )
     or exists (
       select 1
         from public.vendors v
        where v.vendor_id <> '__system_vendor__'
          and pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) = v_canonical
     )
     or exists (
       select 1
         from public.collaborators c
        where c.collaborator_id <> '__system_vendor__'
          and pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) = v_canonical
     ) then
    raise exception 'PARTNER_CODE_CONFLICT' using errcode = 'PT409';
  end if;

  return new;
end;
$function$;
revoke all on function public.partner__internal_guard_catalog_code()
  from public, anon, authenticated, service_role;

create or replace function public.partner__internal_register_catalog_code()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_kind text;
  v_code text;
  v_vendor_id text := null;
  v_collaborator_id text := null;
  v_canonical text;
begin
  if tg_table_name = 'vendors' then
    v_kind := 'VENDOR';
    v_code := new.vendor_id;
    v_vendor_id := new.vendor_id;
  elsif tg_table_name = 'collaborators' then
    v_kind := 'COLLABORATOR';
    v_code := new.collaborator_id;
    v_collaborator_id := new.collaborator_id;
  else
    raise exception 'unexpected table % in partner__internal_register_catalog_code', tg_table_name
      using errcode = '55000';
  end if;

  if v_code = '__system_vendor__' then
    return new;
  end if;

  v_canonical := pg_catalog.lower(pg_catalog.btrim(v_code));

  insert into public.partner_code_registry (
    canonical_code, partner_kind, vendor_id, collaborator_id
  ) values (
    v_canonical, v_kind, v_vendor_id, v_collaborator_id
  );

  insert into public.partner_accounts (
    partner_kind, vendor_id, collaborator_id, canonical_code, account_state
  ) values (
    v_kind, v_vendor_id, v_collaborator_id, v_canonical, 'UNPROVISIONED'
  );

  return new;
end;
$function$;
revoke all on function public.partner__internal_register_catalog_code()
  from public, anon, authenticated, service_role;

drop trigger if exists vendors_partner_code_before_guard on public.vendors;
create trigger vendors_partner_code_before_guard
  before insert or update of vendor_id on public.vendors
  for each row execute function public.partner__internal_guard_catalog_code();

drop trigger if exists vendors_partner_code_after_insert on public.vendors;
create trigger vendors_partner_code_after_insert
  after insert on public.vendors
  for each row execute function public.partner__internal_register_catalog_code();

drop trigger if exists collaborators_partner_code_before_guard on public.collaborators;
create trigger collaborators_partner_code_before_guard
  before insert or update of collaborator_id on public.collaborators
  for each row execute function public.partner__internal_guard_catalog_code();

drop trigger if exists collaborators_partner_code_after_insert on public.collaborators;
create trigger collaborators_partner_code_after_insert
  after insert on public.collaborators
  for each row execute function public.partner__internal_register_catalog_code();

-- Internal permission-group vs partner isolation triggers (bidirectional).
create or replace function public.partner__internal_guard_group_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.app_user_id is not null
     and exists (
       select 1
         from public.partner_accounts pa
        where pa.app_user_id = new.app_user_id
     ) then
    raise exception 'PARTNER_INTERNAL_GROUP_FORBIDDEN' using errcode = 'PT409';
  end if;
  return new;
end;
$function$;
revoke all on function public.partner__internal_guard_group_membership()
  from public, anon, authenticated, service_role;

drop trigger if exists authz_user_group_members_forbid_partner_account on public.authz_user_group_members;
create trigger authz_user_group_members_forbid_partner_account
  before insert or update of app_user_id, ended_at on public.authz_user_group_members
  for each row execute function public.partner__internal_guard_group_membership();

create or replace function public.partner__internal_guard_partner_account_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.app_user_id is not null
     and exists (
       select 1
         from public.authz_user_group_members m
        where m.app_user_id = new.app_user_id
          and m.ended_at is null
     ) then
    raise exception 'PARTNER_INTERNAL_GROUP_FORBIDDEN' using errcode = 'PT409';
  end if;
  return new;
end;
$function$;
revoke all on function public.partner__internal_guard_partner_account_user()
  from public, anon, authenticated, service_role;

drop trigger if exists partner_accounts_forbid_internal_group_user on public.partner_accounts;
create trigger partner_accounts_forbid_internal_group_user
  before insert or update of app_user_id on public.partner_accounts
  for each row execute function public.partner__internal_guard_partner_account_user();

-- Helper: check auth.users email collision safely even when test harnesses omit auth.users.email.
create or replace function public.partner__internal_auth_email_exists(
  p_email text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_has_email boolean := false;
  v_found boolean := false;
  v_norm text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
begin
  if v_norm = '' then
    return false;
  end if;

  select exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = pg_catalog.to_regclass('auth.users')
       and a.attname = 'email'
       and not a.attisdropped
  ) into v_has_email;

  if not coalesce(v_has_email, false) then
    return false;
  end if;

  execute 'select exists (select 1 from auth.users au where pg_catalog.lower(pg_catalog.btrim(coalesce(au.email, ''''))) = $1)'
     into v_found
    using v_norm;

  return coalesce(v_found, false);
end;
$function$;
revoke all on function public.partner__internal_auth_email_exists(text)
  from public, anon, authenticated, service_role;

create or replace function public.partner__internal_list_auth_email_collisions()
returns table (
  email text,
  auth_subject uuid,
  canonical_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_has_email boolean := false;
begin
  select exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = pg_catalog.to_regclass('auth.users')
       and a.attname = 'email'
       and not a.attisdropped
  ) into v_has_email;

  if not coalesce(v_has_email, false) then
    return;
  end if;

  return query execute $q$
    with catalog_codes as (
      select distinct pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) as canonical_code
        from public.vendors v
       where v.vendor_id <> '__system_vendor__'
      union
      select distinct pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) as canonical_code
        from public.collaborators c
       where c.collaborator_id <> '__system_vendor__'
    )
    select
      pg_catalog.lower(pg_catalog.btrim(au.email)) as email,
      au.id as auth_subject,
      pg_catalog.split_part(pg_catalog.lower(pg_catalog.btrim(au.email)), '@', 1) as canonical_code
    from auth.users au
    join catalog_codes cc
      on pg_catalog.lower(pg_catalog.btrim(coalesce(au.email, ''))) = cc.canonical_code || '@hrpartner.vn'
    where not exists (
      select 1
        from public.partner_accounts pa
        join public.direct_entry_app_users u on u.app_user_id = pa.app_user_id
       where u.auth_subject = au.id
    )
    order by email asc, au.id asc
  $q$;
end;
$function$;
revoke all on function public.partner__internal_list_auth_email_collisions()
  from public, anon, authenticated, service_role;

-- =============================================================================
-- SECTION 5: Harden Internal Actor Guards & Actor Context Resolution
-- =============================================================================

-- 5a. direct_entry_assert_actor_mapping rejects any partner_accounts.app_user_id.
create or replace function public.direct_entry_assert_actor_mapping(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;
  if public.partner__internal_is_partner_app_user(p_app_user_id) then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;
  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;
end;
$function$;
revoke all on function public.direct_entry_assert_actor_mapping(uuid, uuid)
  from public, anon, authenticated, service_role;

-- 5b. hr_bulletin__internal_assert_active_actor rejects partner accounts.
create or replace function public.hr_bulletin__internal_assert_active_actor(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_created_at timestamptz;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'BULLETIN_ACTOR_FORBIDDEN' using errcode = '42501';
  end if;

  if public.partner__internal_is_partner_app_user(p_app_user_id) then
    raise exception 'BULLETIN_ACTOR_FORBIDDEN' using errcode = '42501';
  end if;

  select u.created_at
    into v_created_at
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject
     and u.app_user_id = p_app_user_id
     and u.enabled = true
     and coalesce(u.authz_managed, false) = true;

  if not found then
    raise exception 'BULLETIN_ACTOR_FORBIDDEN' using errcode = '42501';
  end if;

  return greatest(pg_catalog.clock_timestamp() - interval '7 days', v_created_at);
end;
$function$;
revoke all on function public.hr_bulletin__internal_assert_active_actor(uuid, uuid)
  from public, anon, authenticated, service_role;

-- 5b2. attendance__internal_is_non_employee_account treats partner accounts as non-employees,
--      and work_report_assert_actor rejects partner accounts with 42501.
create or replace function public.attendance__internal_is_non_employee_account(
  p_app_user_id uuid,
  p_as_of timestamp with time zone default null::timestamp with time zone
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  return public.partner__internal_is_partner_app_user(p_app_user_id);
end;
$function$;
revoke all on function public.attendance__internal_is_non_employee_account(uuid, timestamp with time zone)
  from public, anon, authenticated, service_role;

create or replace function public.work_report_assert_actor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text default null::text
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'WORK_REPORT_ACTOR_DENIED' using errcode = '42501';
  end if;

  if public.partner__internal_is_partner_app_user(p_app_user_id) then
    raise exception 'WORK_REPORT_ACTOR_DENIED' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
       and not public.attendance__internal_is_non_employee_account(p_app_user_id, pg_catalog.clock_timestamp())
  ) then
    raise exception 'WORK_REPORT_ACTOR_DENIED' using errcode = '42501';
  end if;

  if p_capability is not null
     and not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
end;
$function$;
revoke all on function public.work_report_assert_actor(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- 5c. direct_entry_authz__internal_resolve_effective_grants returns [] for partner accounts.
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
  v_result jsonb := '[]'::jsonb;
begin
  if p_app_user_id is null then
    return '[]'::jsonb;
  end if;

  if public.partner__internal_is_partner_app_user(p_app_user_id) then
    return '[]'::jsonb;
  end if;

  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled or not coalesce(v_user.authz_managed, false) then
    return '[]'::jsonb;
  end if;

  with
  group_bundle_grants as (
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
  all_grants as (
    select * from group_bundle_grants
    union all
    select * from contextual_tl_grants
    union all
    select * from contextual_tl_wr_review_grants
    union all
    select * from contextual_pa_grants
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

-- 5d. direct_entry_resolve_actor_context(uuid) isolates partner sessions and attaches `partner_account`.
create or replace function public.direct_entry_resolve_actor_context(
  p_auth_subject uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_app_user_id uuid;
  v_enabled boolean;
  v_authz_managed boolean := false;
  v_capabilities jsonb := '[]'::jsonb;
  v_recruiter_links jsonb := '[]'::jsonb;
  v_teams jsonb := '[]'::jsonb;
  v_team_scope_grants jsonb := '[]'::jsonb;
  v_all_scope_grants jsonb := '[]'::jsonb;
  v_review_scopes jsonb := '[]'::jsonb;
  v_team_leader_team_id uuid := null;
  v_allowed_worker_tabs jsonb := '[]'::jsonb;
  v_effective_grants jsonb := '[]'::jsonb;
  v_assigned_roles jsonb := '[]'::jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_has_active_person boolean := false;
  v_is_non_employee boolean := false;
  v_has_tl_effective_grant boolean := false;
  v_partner public.partner_accounts%rowtype;
  v_partner_active boolean := false;
  v_partner_display_name text := null;
  v_partner_enabled boolean := false;
  v_partner_context jsonb := null;
begin
  select u.app_user_id, u.enabled, coalesce(u.authz_managed, false)
    into v_app_user_id, v_enabled, v_authz_managed
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject;
  if not found then return null; end if;

  if not v_authz_managed then
    raise exception 'actor account is not authz managed' using errcode = '42501';
  end if;

  select pa.*
    into v_partner
    from public.partner_accounts pa
   where pa.app_user_id = v_app_user_id;

  if found then
    if v_partner.partner_kind = 'VENDOR' then
      select v.active, v.display_name
        into v_partner_active, v_partner_display_name
        from public.vendors v
       where v.vendor_id = v_partner.vendor_id;
    else
      select c.active, c.display_name
        into v_partner_active, v_partner_display_name
        from public.collaborators c
       where c.collaborator_id = v_partner.collaborator_id;
    end if;

    v_partner_enabled := coalesce(v_enabled, false)
      and coalesce(v_partner_active, false)
      and v_partner.activated_at is not null
      and v_partner.account_state in ('ACTIVE_MUST_CHANGE_PASSWORD', 'ACTIVE');

    v_partner_context := pg_catalog.jsonb_build_object(
      'partner_account_id', v_partner.partner_account_id,
      'partner_kind', v_partner.partner_kind,
      'vendor_id', v_partner.vendor_id,
      'collaborator_id', v_partner.collaborator_id,
      'partner_id', coalesce(v_partner.vendor_id, v_partner.collaborator_id),
      'partner_display_name', v_partner_display_name,
      'partner_active', coalesce(v_partner_active, false),
      'canonical_code', v_partner.canonical_code,
      'username', v_partner.username,
      'account_state', v_partner.account_state,
      'activated_at', v_partner.activated_at,
      'must_change_password', v_partner.must_change_password,
      'password_changed_at', v_partner.password_changed_at
    );

    return (
      select pg_catalog.jsonb_build_object(
        'auth_subject', u.auth_subject,
        'app_user_id', u.app_user_id,
        'display_name', u.display_name,
        'enabled', v_partner_enabled,
        'capabilities', '[]'::jsonb,
        'recruiter_links', '[]'::jsonb,
        'teams', '[]'::jsonb,
        'team_scope_grants', '[]'::jsonb,
        'all_scope_grants', '[]'::jsonb,
        'allowed_worker_tabs', '[]'::jsonb,
        'effective_grants', '[]'::jsonb,
        'assigned_roles', '[]'::jsonb,
        'partner_account', v_partner_context
      )
      from public.direct_entry_app_users u
      where u.app_user_id = v_app_user_id
    );
  end if;

  if v_enabled then
    v_effective_grants := public.direct_entry_authz__internal_resolve_effective_grants(v_app_user_id);

    with valid_paired_grants as (
      select
        g.capability,
        g.scope_kind,
        g.scope_id
      from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(
        capability text,
        scope_kind text,
        scope_id text
      )
      where (
        (
          g.capability in ('entry_create', 'submission_create', 'employment_status.request')
          and g.scope_kind in ('OWN', 'ALL')
          and g.scope_id is null
        )
        or (
          g.capability = 'entry_own'
          and g.scope_kind = 'OWN'
          and g.scope_id is null
        )
        or (
          g.capability in (
            'entry_team',
            'change_review',
            'report_assign',
            'report_view',
            'report_analytics_view',
            'report_review',
            'report_delegate'
          )
          and (
            (g.scope_kind = 'ALL' and g.scope_id is null)
            or (
              g.scope_kind = 'CONTEXT_TEAM'
              and g.scope_id is not null
              and pg_catalog.btrim(g.scope_id) <> ''
            )
          )
        )
        or (
          g.capability in (
            'entry_admin',
            'employment_status.review',
            'recruiter_master_manage',
            'team_master_manage',
            'audit_view',
            'entry_restore',
            'catalog_master_manage',
            'report_form_manage',
            'vendor_finance_view',
            'vendor_finance_record',
            'duplicate_cccd_withdraw',
            'worker_edit_history_view',
            'bulletin_manage',
            'vendor_referrer_manage'
          )
          and g.scope_kind = 'ALL'
          and g.scope_id is null
        )
        or (
          g.capability in ('change_request_create', 'document_upload', 'document_view')
          and (
            (g.scope_kind in ('OWN', 'ALL') and g.scope_id is null)
            or (
              g.scope_kind in ('CONTEXT_TEAM', 'CONTEXT_PROJECT')
              and g.scope_id is not null
              and pg_catalog.btrim(g.scope_id) <> ''
            )
          )
        )
        or (
          g.capability in ('entry_privileged_edit', 'employment_status.apply')
          and (
            (g.scope_kind in ('OWN', 'ALL') and g.scope_id is null)
            or (
              g.scope_kind = 'CONTEXT_TEAM'
              and g.scope_id is not null
              and pg_catalog.btrim(g.scope_id) <> ''
            )
          )
        )
        or (
          g.capability = 'team_manager_assign'
          and g.scope_kind = 'CONTEXT_TEAM'
          and g.scope_id is not null
          and pg_catalog.btrim(g.scope_id) <> ''
        )
      )
    ),
    valid_active_teams as (
      select distinct
        t.team_id,
        t.code,
        t.display_name,
        t.active
      from valid_paired_grants pg
      join public.teams t
        on t.team_id::text = pg.scope_id
       and t.active
       and t.code <> '__system_vendor__'
      where pg.scope_kind = 'CONTEXT_TEAM'
    )
    select
      coalesce((
        select pg_catalog.jsonb_agg(distinct pg.capability order by pg.capability)
          from valid_paired_grants pg
      ), '[]'::jsonb),
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'team_id', vt.team_id,
            'code', vt.code,
            'display', vt.display_name,
            'active', vt.active
          )
          order by vt.team_id
        )
          from valid_active_teams vt
      ), '[]'::jsonb),
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'team_id', vt.team_id,
            'valid_from', v_today::text,
            'valid_to', null
          )
          order by vt.team_id
        )
          from valid_active_teams vt
      ), '[]'::jsonb),
      case
        when exists (
          select 1
            from valid_paired_grants pg
           where pg.scope_kind = 'ALL'
             and pg.scope_id is null
        )
        then pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'valid_from', v_today::text,
            'valid_to', null
          )
        )
        else '[]'::jsonb
      end
    into v_capabilities, v_teams, v_team_scope_grants, v_all_scope_grants;

    select coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'app_user_id', l.app_user_id,
          'recruiter_id', l.recruiter_id,
          'verified', l.verified,
          'valid_from', l.valid_from,
          'valid_to', l.valid_to
        )
        order by l.valid_from, l.recruiter_id
      )
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r
          on r.recruiter_id = l.recruiter_id
         and r.active
       where l.app_user_id = v_app_user_id
         and l.verified
         and l.is_current
    ), '[]'::jsonb)
      into v_recruiter_links;

    select coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
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
             where exists (
               select 1
                 from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(capability text, scope_kind text, scope_id text)
                where g.capability = 'report_review'
                  and g.scope_kind = 'ALL'
                  and g.scope_id is null
             )
            union all
            select 'team'::text as kind, t.team_id, coalesce(t.display_name, t.code) as label
              from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(capability text, scope_kind text, scope_id text)
              join public.teams t
                on t.team_id::text = g.scope_id
               and t.active
               and t.code <> '__system_vendor__'
             where g.capability = 'report_review'
               and g.scope_kind = 'CONTEXT_TEAM'
               and g.scope_id is not null
               and pg_catalog.btrim(g.scope_id) <> ''
            union all
            select d.scope_kind as kind,
                   case when d.scope_kind = 'team' then d.scope_team_id else null end as team_id,
                   case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end as label
              from public.work_report_delegations d
              left join public.teams tm on tm.team_id = d.scope_team_id
             where d.delegate_app_user_id = v_app_user_id
               and d.capability = 'report_review'
               and d.state = 'ACTIVE'
               and d.is_current
               and statement_timestamp() >= d.effective_from
               and (d.effective_to is null or statement_timestamp() <= d.effective_to)
               and public.work_report__internal_is_delegation_effective(d.delegation_id, statement_timestamp())
          ) raw_scopes
        ) s
    ), '[]'::jsonb)
      into v_review_scopes;

    select exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(capability text, scope_kind text, scope_id text)
       where g.capability = 'team_manager_assign'
         and g.scope_kind = 'CONTEXT_TEAM'
         and g.scope_id is not null
         and pg_catalog.btrim(g.scope_id) <> ''
    ) into v_has_tl_effective_grant;

    if coalesce(v_has_tl_effective_grant, false) then
      begin
        v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
          p_auth_subject, v_app_user_id, null
        );
      exception when insufficient_privilege then
        v_team_leader_team_id := null;
      end;
    end if;

    select coalesce(
      jsonb_agg(t.tab_id order by t.ord),
      '[]'::jsonb
    )
    into v_allowed_worker_tabs
    from (
      select 'uploader'::text as tab_id, 1 as ord
       where public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'submission_create', 'OWN', null)
          or public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'submission_create', 'ALL', null)
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
           join public.direct_entry_app_users u
             on u.app_user_id = l.app_user_id
            and u.enabled
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
            and not l.suspended_by_account_disable
            and l.valid_from <= v_today
            and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to))
       )
      union all
      select 'managed'::text as tab_id, 3 as ord
       where public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'team'::text as tab_id, 4 as ord
       where v_team_leader_team_id is not null
      union all
      select 'all'::text as tab_id, 5 as ord
       where public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'entry_admin', 'ALL', null)
          or public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'change_review', 'ALL', null)
    ) t;

    v_is_non_employee := public.attendance__internal_is_non_employee_account(v_app_user_id, v_now);

    select exists (
      select 1
        from public.organization_account_person_links l
        join public.organization_persons p on p.person_id = l.person_id and p.status = 'ACTIVE'
       where l.app_user_id = v_app_user_id
         and l.ended_at is null
         and l.started_at <= v_now
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
          case
            when g.is_system_admin then 4
            when g.code = 'HR_CATALOG_OPERATOR' then 3
            when g.code = 'RECRUITER_OPERATIONS' then 2
            else 1
          end as sort_order,
          case
            when g.is_system_admin then 'ADMIN'::text
            when g.code = 'HR_CATALOG_OPERATOR' then 'HR_OPERATOR'::text
            when g.code = 'RECRUITER_OPERATIONS' then 'RECRUITER'::text
          end as role_code,
          g.name as display_name,
          case when g.team_id is not null then 'CONTEXTUAL'::text else 'GLOBAL'::text end as assignment_mode,
          case when g.team_id is not null then 'CONTEXT_TEAM'::text else null::text end as scope_kind,
          g.team_id::text as scope_id,
          m.membership_id::text as assignment_id,
          m.is_protected,
          (not m.is_protected) as can_revoke,
          case when m.is_protected then 'PROTECTED_OWNER_ADMIN' else null end as cannot_revoke_reason
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
        where m.app_user_id = v_app_user_id
          and m.ended_at is null
          and m.started_at <= v_now
          and (g.team_id is null or t.team_id is not null)
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
        join public.organization_department_heads dh
          on dh.person_id = apl.person_id
         and dh.ended_at is null
         and dh.started_at <= v_now
        join public.organization_departments dm
          on dm.department_id = dh.department_id
         and dm.is_active
        join public.organization_person_department_memberships pm
          on pm.person_id = apl.person_id
         and pm.department_id = dh.department_id
         and pm.ended_at is null
         and pm.started_at <= v_now
        where apl.app_user_id = v_app_user_id
          and apl.ended_at is null
          and apl.started_at <= v_now
          and coalesce(v_has_active_person, false)
          and not v_is_non_employee
        union all
        select
          7 as sort_order,
          'PROJECT_MANAGER'::text as role_code,
          'Quản lý dự án (PM)'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_PROJECT'::text as scope_kind,
          pma.project_id as scope_id,
          pma.assignment_id::text as assignment_id,
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
         and not rl.suspended_by_account_disable
         and (rl.valid_to is null or v_today < rl.valid_to)
        where pma.is_current = true
          and pma.revoked_at is null
          and (pma.valid_to is null or (pma.valid_to > pma.valid_from and v_today < pma.valid_to))
          and pma.valid_from <= v_today
          and rl.valid_from <= v_today
          and (rl.valid_to > rl.valid_from or rl.valid_to is null)
          and public.direct_entry_actor_is_assigned_project_manager(v_app_user_id, pr.project_id)
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
      ) ar
      where ar.role_code is not null;
  end if;

  return (
    select pg_catalog.jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'display_name', u.display_name,
      'enabled', u.enabled,
      'capabilities', coalesce(v_capabilities, '[]'::jsonb),
      'recruiter_links', coalesce(v_recruiter_links, '[]'::jsonb),
      'teams', coalesce(v_teams, '[]'::jsonb),
      'team_scope_grants', coalesce(v_team_scope_grants, '[]'::jsonb),
      'all_scope_grants', coalesce(v_all_scope_grants, '[]'::jsonb),
      'allowed_worker_tabs', coalesce(v_allowed_worker_tabs, '[]'::jsonb),
      'effective_grants', coalesce(v_effective_grants, '[]'::jsonb),
      'assigned_roles', coalesce(v_assigned_roles, '[]'::jsonb)
    ) || case
      when pg_catalog.jsonb_array_length(v_review_scopes) > 0
        then pg_catalog.jsonb_build_object('effective_report_review_scopes', v_review_scopes)
      else '{}'::jsonb
    end
    from public.direct_entry_app_users u
    where u.app_user_id = v_app_user_id
  );
end;
$function$;
revoke all on function public.direct_entry_resolve_actor_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_actor_context(uuid)
  to service_role;

-- 5e. direct_entry_mutate_app_user_status blocks enabling partner account if unactivated or parent inactive,
--     and keeps partner_accounts.account_state synchronized.
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
volatile
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
  v_locked_person_ids uuid[];
  v_locked_dept_ids uuid[];
  v_recruiter_ids uuid[];
  v_team_ids uuid[];
  v_lock_key text;
  v_partner public.partner_accounts%rowtype;
  v_partner_parent_active boolean := false;
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

  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_recruiter_ids
    from (
      select l.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = p_target_app_user_id
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_app_user_id
    ) rids
   where rid is not null;

  select coalesce(array_agg(distinct pid order by pid), array[]::uuid[])
    into v_locked_person_ids
    from (
      select l.person_id as pid
        from public.organization_account_person_links l
       where l.app_user_id = p_target_app_user_id
         and l.ended_at is null
      union
      select p.person_id as pid
        from public.organization_persons p
       where p.recruiter_id = any(v_recruiter_ids)
    ) pids
   where pid is not null;

  foreach v_locked_id in array v_locked_person_ids loop
    perform public.org_department__internal_lock_person(v_locked_id);
  end loop;

  if cardinality(v_locked_person_ids) > 0 then
    perform p.person_id
      from public.organization_persons p
     where p.person_id = any(v_locked_person_ids)
     order by p.person_id asc
     for update;

    select coalesce(array_agg(distinct m.department_id order by m.department_id), array[]::uuid[])
      into v_locked_dept_ids
      from public.organization_person_department_memberships m
     where m.person_id = any(v_locked_person_ids)
       and m.ended_at is null;

    foreach v_locked_id in array v_locked_dept_ids loop
      perform public.org_department__internal_lock_department(v_locked_id);
    end loop;

    if cardinality(v_locked_dept_ids) > 0 then
      perform d.department_id
        from public.organization_departments d
       where d.department_id = any(v_locked_dept_ids)
       order by d.department_id asc
       for update;

      perform m.membership_id
        from public.organization_person_department_memberships m
       where m.person_id = any(v_locked_person_ids)
         and m.ended_at is null
       order by m.membership_id asc
       for update;
    end if;
  end if;

  perform public.org_department__internal_lock_app_user(p_target_app_user_id);

  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id asc
  loop
    if v_locked_id = p_target_app_user_id then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_locked_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_locked_id
       for share;
    end if;
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

  select pa.*
    into v_partner
    from public.partner_accounts pa
   where pa.app_user_id = p_target_app_user_id
   for update;

  if found then
    if v_partner.partner_kind = 'VENDOR' then
      select v.active into v_partner_parent_active
        from public.vendors v
       where v.vendor_id = v_partner.vendor_id
       for share;
    else
      select c.active into v_partner_parent_active
        from public.collaborators c
       where c.collaborator_id = v_partner.collaborator_id
       for share;
    end if;

    if p_enable and (
         v_partner.activated_at is null
         or v_partner.account_state = 'PENDING_ACTIVATION'
         or not coalesce(v_partner_parent_active, false)
       ) then
      raise exception 'PARTNER_ENABLE_REQUIRES_ACTIVATED_ACTIVE_PARTNER' using errcode = 'PT409';
    end if;
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, 'app_user_' || v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_recruiter_ids
    from (
      select l.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = p_target_app_user_id
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_app_user_id
      union
      select p.recruiter_id as rid
        from public.organization_persons p
       where p.person_id = any(v_locked_person_ids)
         and p.recruiter_id is not null
    ) rids
   where rid is not null;

  select coalesce(array_agg(distinct a.team_id order by a.team_id), array[]::uuid[])
    into v_team_ids
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_target_app_user_id
     and a.team_id is not null;

  if cardinality(v_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  if cardinality(v_team_ids) > 0 then
    perform t.team_id
      from public.teams t
     where t.team_id = any(v_team_ids)
     order by t.team_id asc
     for update;
  end if;

  if exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = p_target_app_user_id
       and l.ended_at is null
       and not (l.person_id = any(v_locked_person_ids))
  ) or exists (
    select 1
      from public.organization_persons p
     where p.recruiter_id = any(v_recruiter_ids)
       and not (p.person_id = any(v_locked_person_ids))
  ) then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  if cardinality(v_recruiter_ids) > 0 then
    perform m.membership_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = any(v_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'provider:' || rid::text as k
        from unnest(v_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    perform m.membership_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = any(v_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'team-membership:' || rid::text as k
        from unnest(v_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;
  end if;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_target_app_user_id
      or (cardinality(v_recruiter_ids) > 0 and l.recruiter_id = any(v_recruiter_ids))
   order by l.link_id asc
   for update;

  perform pg_advisory_xact_lock(hashtextextended('recruiter-link:' || p_target_app_user_id::text, 0));
  for v_lock_key in
    select 'recruiter-link-recruiter:' || rid::text as k
      from unnest(coalesce(v_recruiter_ids, array[]::uuid[])) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform a.assignment_id
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_target_app_user_id
      or (cardinality(v_team_ids) > 0 and a.team_id = any(v_team_ids))
   order by a.assignment_id asc
   for update;

  v_before := public.direct_entry_app_user_snapshot(
    p_target_app_user_id, v_target.enabled, p_actor_app_user_id
  );

  update public.direct_entry_app_users
     set enabled = p_enable,
         version = version + 1,
         updated_at = pg_catalog.clock_timestamp()
   where app_user_id = p_target_app_user_id
   returning * into v_target;

  if v_partner.partner_account_id is not null then
    if p_enable then
      update public.partner_accounts
         set account_state = case
               when must_change_password then 'ACTIVE_MUST_CHANGE_PASSWORD'
               else 'ACTIVE'
             end,
             version = version + 1
       where partner_account_id = v_partner.partner_account_id;
    elsif v_partner.activated_at is not null then
      update public.partner_accounts
         set account_state = 'SUSPENDED',
             version = version + 1
       where partner_account_id = v_partner.partner_account_id;
    end if;
  end if;

  if p_enable then
    for v_rl in
      select l.*, r.active as recruiter_active
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = p_target_app_user_id
         and l.suspended_by_account_disable = true
       order by l.link_id
    loop
      if (v_rl.valid_to is null or v_rl.valid_to > v_today)
         and v_rl.valid_from <= v_today
         and coalesce(v_rl.recruiter_active, false)
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

    for v_tla in
      select a.*, t.active as team_active, t.code as team_code, r.active as recruiter_active
        from public.direct_entry_team_leader_assignments a
        join public.teams t on t.team_id = a.team_id
        join public.recruiters r on r.recruiter_id = a.leader_recruiter_id
       where a.leader_app_user_id = p_target_app_user_id
         and a.suspended_by_account_disable = true
       order by a.assignment_id
    loop
      v_can_restore_tl := (
        v_tla.valid_to is null
        and v_tla.valid_from <= v_today
        and coalesce(v_tla.team_active, false)
        and v_tla.team_code <> '__system_vendor__'
        and coalesce(v_tla.recruiter_active, false)
        and public.org_department__internal_recruiter_org_allows_recruitment_team(
          v_tla.leader_recruiter_id,
          p_target_app_user_id,
          pg_catalog.clock_timestamp()
        )
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
        update public.direct_entry_team_leader_assignments a
           set is_current = true,
               suspended_by_account_disable = false
         where a.assignment_id = v_tla.assignment_id;
      else
        perform pg_catalog.set_config('direct_entry.team_leader_marker', 'on', true);

        update public.direct_entry_team_leader_assignments a
           set is_current = false,
               suspended_by_account_disable = false,
               valid_to = coalesce(a.valid_to, greatest(v_today, a.valid_from))
         where a.assignment_id = v_tla.assignment_id;

        perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
      end if;
    end loop;
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

-- =============================================================================
-- SECTION 6: Updated Vendor & Collaborator Snapshots, Projections & Admin RPCs
-- =============================================================================

-- 6a. Vendor snapshot & admin projection.
create or replace function public.direct_entry_vendor_snapshot(
  p_vendor public.vendors
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.jsonb_build_object(
    'vendor_id', p_vendor.vendor_id,
    'display_name', p_vendor.display_name,
    'address', p_vendor.address,
    'phone', p_vendor.phone,
    'active', p_vendor.active,
    'version', p_vendor.version
  )
$function$;
revoke all on function public.direct_entry_vendor_snapshot(public.vendors)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_vendor_admin_projection(
  p_vendor public.vendors,
  p_revision_count integer,
  p_recruiter_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.jsonb_build_object(
    'vendor_id', p_vendor.vendor_id,
    'display_name', p_vendor.display_name,
    'address', p_vendor.address,
    'phone', p_vendor.phone,
    'active', p_vendor.active,
    'version', p_vendor.version,
    'revision_count', coalesce(p_revision_count, 0),
    'recruiter_id', p_recruiter_id,
    'partner_account', public.partner__internal_account_summary_by_partner('VENDOR', p_vendor.vendor_id)
  )
$function$;
revoke all on function public.direct_entry_vendor_admin_projection(public.vendors, integer, uuid)
  from public, anon, authenticated, service_role;

-- Drop legacy 8-arg create and 7-arg update vendor overloads before creating extended versions.
drop function if exists public.direct_entry_create_vendor(uuid, uuid, integer, text, text, date, text, text);
drop function if exists public.direct_entry_update_vendor(uuid, uuid, text, integer, text, text, text);

create or replace function public.direct_entry_create_vendor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_vendor_id text,
  p_display_name text,
  p_valid_from date,
  p_reason text,
  p_idempotency_key text,
  p_address text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_vendor_id text;
  v_display text;
  v_address text;
  v_phone text;
  v_canonical text;
  v_reason_id uuid;
  v_vendor public.vendors;
  v_recruiter_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_expected_version is distinct from 0 then
    raise exception 'create expected version must be zero' using errcode = '22023';
  end if;
  if p_vendor_id is null or btrim(p_vendor_id) = '' then
    raise exception 'vendor required' using errcode = '22023';
  end if;
  v_vendor_id := btrim(p_vendor_id);
  if v_vendor_id = '__system_vendor__' then
    raise exception 'vendor id is reserved' using errcode = '22023';
  end if;
  if length(v_vendor_id) > 128
     or v_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'vendor id is not canonical' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'vendor display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  v_address := public.partner__internal_normalize_address(p_address);
  v_phone := public.partner__internal_normalize_phone(p_phone);
  if p_valid_from is null then
    raise exception 'vendor valid from required' using errcode = '22023';
  end if;
  if p_valid_from > public.direct_entry_authorization_date() then
    raise exception 'future vendor memberships require explicit activation' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'vendor_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'vendor_id', v_vendor_id,
      'display_name', v_display,
      'address', v_address,
      'phone', v_phone,
      'valid_from', p_valid_from
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_canonical := lower(v_vendor_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('partner_code:' || v_canonical, 0)
  );

  if exists (select 1 from public.vendors v where v.vendor_id = v_vendor_id) then
    raise exception 'vendor already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  insert into public.vendors (vendor_id, display_name, address, phone, active, version)
  values (v_vendor_id, v_display, v_address, v_phone, true, 1)
  returning * into v_vendor;

  insert into public.recruiters (display_name, active, version)
  values (v_display, true, 1)
  returning recruiter_id into v_recruiter_id;

  insert into public.recruiter_provider_memberships
    (recruiter_id, provider_type, vendor_id, valid_from, is_current)
  values
    (v_recruiter_id, 'vendor', v_vendor.vendor_id, p_valid_from, true);

  v_revision_id := public.direct_entry_write_vendor_revision(
    v_vendor.vendor_id, v_vendor.version, p_app_user_id, v_reason_id,
    null, public.direct_entry_vendor_snapshot(v_vendor)
  );

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, vendor_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'vendor_create', v_authority,
     v_vendor.vendor_id, 'all', 'APPLIED', v_reason_id,
     array['vendor_id', 'display_name', 'address', 'phone', 'active'], v_revision_id);

  v_result := jsonb_build_object(
    'vendor_id', v_vendor.vendor_id,
    'display_name', v_vendor.display_name,
    'address', v_vendor.address,
    'phone', v_vendor.phone,
    'active', v_vendor.active,
    'version', v_vendor.version,
    'revision_id', v_revision_id,
    'recruiter_id', v_recruiter_id,
    'partner_account', public.partner__internal_account_summary_by_partner('VENDOR', v_vendor.vendor_id),
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'vendor_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;
revoke all on function public.direct_entry_create_vendor(uuid, uuid, integer, text, text, date, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_vendor(uuid, uuid, integer, text, text, date, text, text, text, text)
  to service_role;

create or replace function public.direct_entry_update_vendor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_expected_version integer,
  p_display_name text,
  p_reason text,
  p_idempotency_key text,
  p_address text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_display text;
  v_address text;
  v_phone text;
  v_reason_id uuid;
  v_before public.vendors;
  v_after public.vendors;
  v_vendor_version integer;
  v_revision_id uuid;
  v_changed text[] := array[]::text[];
  v_partner_app_user_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_vendor_id is null or btrim(p_vendor_id) = '' then
    raise exception 'vendor required' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'vendor display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  v_address := public.partner__internal_normalize_address(p_address);
  v_phone := public.partner__internal_normalize_phone(p_phone);
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'vendor_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'vendor_id', btrim(p_vendor_id),
      'expected_version', p_expected_version,
      'display_name', v_display,
      'address', v_address,
      'phone', v_phone
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_vendor(btrim(p_vendor_id), p_expected_version);
  if v_before.display_name = v_display
     and v_before.address is not distinct from v_address
     and v_before.phone is not distinct from v_phone then
    raise exception 'vendor display name is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  update public.vendors
     set display_name = v_display,
         address = v_address,
         phone = v_phone
   where vendor_id = v_before.vendor_id
  returning * into v_after;

  if v_after.display_name is distinct from v_before.display_name then
    v_changed := array_append(v_changed, 'display_name');
    select pa.app_user_id
      into v_partner_app_user_id
      from public.partner_accounts pa
     where pa.partner_kind = 'VENDOR'
       and pa.vendor_id = v_after.vendor_id
       and pa.app_user_id is not null
     for share;
    if v_partner_app_user_id is not null then
      update public.direct_entry_app_users
         set display_name = v_after.display_name,
             updated_at = pg_catalog.clock_timestamp()
       where app_user_id = v_partner_app_user_id;
    end if;
  end if;
  if v_after.address is distinct from v_before.address then
    v_changed := array_append(v_changed, 'address');
  end if;
  if v_after.phone is distinct from v_before.phone then
    v_changed := array_append(v_changed, 'phone');
  end if;

  select b.vendor_version, b.revision_id
    into v_vendor_version, v_revision_id
    from public.direct_entry_bump_vendor_version(
      v_after.vendor_id, p_app_user_id, v_reason_id,
      public.direct_entry_vendor_snapshot(v_before)
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, vendor_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'vendor_update', v_authority,
     v_after.vendor_id, 'all', 'APPLIED', v_reason_id,
     v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'vendor_id', v_after.vendor_id,
    'display_name', v_after.display_name,
    'address', v_after.address,
    'phone', v_after.phone,
    'active', v_after.active,
    'version', v_vendor_version,
    'revision_id', v_revision_id,
    'recruiter_id', public.direct_entry_vendor_representation_recruiter(v_after.vendor_id),
    'partner_account', public.partner__internal_account_summary_by_partner('VENDOR', v_after.vendor_id)
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'vendor_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;
revoke all on function public.direct_entry_update_vendor(uuid, uuid, text, integer, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_vendor(uuid, uuid, text, integer, text, text, text, text, text)
  to service_role;

create or replace function public.direct_entry_set_vendor_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_active boolean,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_reason_id uuid;
  v_before public.vendors;
  v_after public.vendors;
  v_vendor_version integer;
  v_revision_id uuid;
  v_recruiters integer := 0;
  v_changed text[];
  v_partner public.partner_accounts%rowtype;
  v_app_user public.direct_entry_app_users%rowtype;
  v_app_user_rev_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_vendor_id is null or btrim(p_vendor_id) = '' then
    raise exception 'vendor required' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'vendor active flag required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'vendor_set_active', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'vendor_id', btrim(p_vendor_id),
      'active', p_active,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_vendor(btrim(p_vendor_id), p_expected_version);
  if v_before.active = p_active then
    raise exception 'vendor active state is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  update public.vendors
     set active = p_active
   where vendor_id = v_before.vendor_id
  returning * into v_after;

  update public.recruiters r
     set active = p_active,
         version = r.version + 1
   where r.active <> p_active
     and r.recruiter_id in (
       select m.recruiter_id
         from public.recruiter_provider_memberships m
        where m.provider_type = 'vendor'
          and m.vendor_id = v_before.vendor_id
          and (
            select count(*)
              from public.recruiter_provider_memberships x
             where x.recruiter_id = m.recruiter_id
          ) = 1
     );
  get diagnostics v_recruiters = row_count;

  -- Synchronize linked partner account and direct_entry_app_users without bypassing activation.
  select pa.*
    into v_partner
    from public.partner_accounts pa
   where pa.partner_kind = 'VENDOR'
     and pa.vendor_id = v_after.vendor_id
   for update;

  if found and v_partner.app_user_id is not null then
    select u.*
      into v_app_user
      from public.direct_entry_app_users u
     where u.app_user_id = v_partner.app_user_id
     for update;

    if not p_active then
      if v_app_user.enabled then
        update public.direct_entry_app_users
           set enabled = false,
               version = version + 1,
               updated_at = pg_catalog.clock_timestamp()
         where app_user_id = v_app_user.app_user_id
         returning * into v_app_user;

        insert into public.direct_entry_app_user_revisions (
          app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
        ) values (
          v_app_user.app_user_id, v_app_user.version, p_app_user_id, 'disable',
          public.direct_entry_app_user_snapshot(v_app_user.app_user_id, true, p_app_user_id),
          public.direct_entry_app_user_snapshot(v_app_user.app_user_id, false, p_app_user_id),
          v_reason_id
        ) returning revision_id into v_app_user_rev_id;
      end if;

      update public.partner_accounts
         set account_state = case
               when activated_at is not null then 'SUSPENDED'
               else 'PENDING_ACTIVATION'
             end,
             version = version + 1
       where partner_account_id = v_partner.partner_account_id;
    else
      if v_partner.activated_at is not null then
        if not v_app_user.enabled then
          update public.direct_entry_app_users
             set enabled = true,
                 version = version + 1,
                 updated_at = pg_catalog.clock_timestamp()
           where app_user_id = v_app_user.app_user_id
           returning * into v_app_user;

          insert into public.direct_entry_app_user_revisions (
            app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
          ) values (
            v_app_user.app_user_id, v_app_user.version, p_app_user_id, 'enable',
            public.direct_entry_app_user_snapshot(v_app_user.app_user_id, false, p_app_user_id),
            public.direct_entry_app_user_snapshot(v_app_user.app_user_id, true, p_app_user_id),
            v_reason_id
          ) returning revision_id into v_app_user_rev_id;
        end if;

        update public.partner_accounts
           set account_state = case
                 when must_change_password then 'ACTIVE_MUST_CHANGE_PASSWORD'
                 else 'ACTIVE'
               end,
               version = version + 1
         where partner_account_id = v_partner.partner_account_id;
      else
        if v_app_user.enabled then
          update public.direct_entry_app_users
             set enabled = false,
                 version = version + 1,
                 updated_at = pg_catalog.clock_timestamp()
           where app_user_id = v_app_user.app_user_id;
        end if;

        update public.partner_accounts
           set account_state = 'PENDING_ACTIVATION',
               version = version + 1
         where partner_account_id = v_partner.partner_account_id;
      end if;
    end if;
  end if;

  select b.vendor_version, b.revision_id
    into v_vendor_version, v_revision_id
    from public.direct_entry_bump_vendor_version(
      v_after.vendor_id, p_app_user_id, v_reason_id,
      public.direct_entry_vendor_snapshot(v_before)
    ) b;

  v_changed := case
    when v_recruiters > 0 then array['active', 'representation_recruiter_active']
    else array['active']
  end;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, vendor_revision_id, app_user_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'vendor_set_active', v_authority,
     v_after.vendor_id, 'all', 'APPLIED', v_reason_id,
     v_changed, v_revision_id, v_app_user_rev_id);

  v_result := jsonb_build_object(
    'vendor_id', v_after.vendor_id,
    'display_name', v_after.display_name,
    'address', v_after.address,
    'phone', v_after.phone,
    'active', v_after.active,
    'version', v_vendor_version,
    'revision_id', v_revision_id,
    'recruiter_id', public.direct_entry_vendor_representation_recruiter(v_after.vendor_id),
    'partner_account', public.partner__internal_account_summary_by_partner('VENDOR', v_after.vendor_id)
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'vendor_set_active', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;
revoke all on function public.direct_entry_set_vendor_active(uuid, uuid, text, boolean, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_set_vendor_active(uuid, uuid, text, boolean, integer, text, text)
  to service_role;

-- 6b. Collaborator snapshot, admin projection & admin RPCs.
create or replace function public.direct_entry_collaborator_snapshot(
  p_collaborator public.collaborators
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.jsonb_build_object(
    'collaborator_id', p_collaborator.collaborator_id,
    'display_name', p_collaborator.display_name,
    'address', p_collaborator.address,
    'phone', p_collaborator.phone,
    'active', p_collaborator.active,
    'version', p_collaborator.version
  )
$function$;
revoke all on function public.direct_entry_collaborator_snapshot(public.collaborators)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_collaborator_admin_projection(
  p_collaborator public.collaborators
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.jsonb_build_object(
    'collaborator_id', p_collaborator.collaborator_id,
    'display_name', p_collaborator.display_name,
    'address', p_collaborator.address,
    'phone', p_collaborator.phone,
    'active', p_collaborator.active,
    'version', p_collaborator.version,
    'created_at', p_collaborator.created_at,
    'updated_at', p_collaborator.updated_at,
    'partner_account', public.partner__internal_account_summary_by_partner('COLLABORATOR', p_collaborator.collaborator_id)
  )
$function$;
revoke all on function public.direct_entry_collaborator_admin_projection(public.collaborators)
  from public, anon, authenticated, service_role;

drop function if exists public.direct_entry_create_collaborator(uuid, uuid, integer, text, text, text, text);
drop function if exists public.direct_entry_update_collaborator(uuid, uuid, text, integer, text, text, text);

create or replace function public.direct_entry_create_collaborator(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_collaborator_id text,
  p_display_name text,
  p_reason text,
  p_idempotency_key text,
  p_address text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_collaborator_id text;
  v_display text;
  v_address text;
  v_phone text;
  v_canonical text;
  v_reason text;
  v_reason_id uuid;
  v_collaborator public.collaborators;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_expected_version is distinct from 0 then
    raise exception 'create expected version must be zero' using errcode = '22023';
  end if;
  if p_collaborator_id is null or btrim(p_collaborator_id) = '' then
    raise exception 'collaborator required' using errcode = '22023';
  end if;
  v_collaborator_id := btrim(p_collaborator_id);
  if v_collaborator_id = '__system_vendor__' then
    raise exception 'collaborator id is reserved' using errcode = '22023';
  end if;
  if length(v_collaborator_id) > 128
     or v_collaborator_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'collaborator id is not canonical' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'collaborator display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  v_address := public.partner__internal_normalize_address(p_address);
  v_phone := public.partner__internal_normalize_phone(p_phone);
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  v_reason := nullif(btrim(p_reason), '');
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 or length(p_idempotency_key) > 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'collaborator_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'collaborator_id', v_collaborator_id,
      'display_name', v_display,
      'address', v_address,
      'phone', v_phone
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_canonical := lower(v_collaborator_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('partner_code:' || v_canonical, 0)
  );

  if exists (select 1 from public.collaborators c where c.collaborator_id = v_collaborator_id) then
    raise exception 'collaborator already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, v_reason);

  insert into public.collaborators (collaborator_id, display_name, address, phone, active, version)
  values (v_collaborator_id, v_display, v_address, v_phone, true, 1)
  returning * into v_collaborator;

  insert into public.direct_entry_collaborator_revisions (
    collaborator_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    v_collaborator.collaborator_id,
    v_collaborator.version,
    p_app_user_id,
    v_reason_id,
    null,
    public.direct_entry_collaborator_snapshot(v_collaborator)
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    outcome, reason_id, changed_fields, collaborator_revision_id
  ) values (
    p_auth_subject, p_app_user_id, 'collaborator_create', v_authority,
    v_collaborator.collaborator_id, 'all', 'APPLIED', v_reason_id,
    array['collaborator_id', 'display_name', 'address', 'phone', 'active'], v_revision_id
  );

  v_result := public.direct_entry_collaborator_admin_projection(v_collaborator);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'collaborator_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;
revoke all on function public.direct_entry_create_collaborator(uuid, uuid, integer, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_collaborator(uuid, uuid, integer, text, text, text, text, text, text)
  to service_role;

create or replace function public.direct_entry_update_collaborator(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_collaborator_id text,
  p_expected_version integer,
  p_display_name text,
  p_reason text,
  p_idempotency_key text,
  p_address text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_display text;
  v_address text;
  v_phone text;
  v_reason text;
  v_reason_id uuid;
  v_before public.collaborators;
  v_after public.collaborators;
  v_revision_id uuid;
  v_changed text[] := array[]::text[];
  v_partner_app_user_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_collaborator_id is null or btrim(p_collaborator_id) = '' then
    raise exception 'collaborator required' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'collaborator display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  v_address := public.partner__internal_normalize_address(p_address);
  v_phone := public.partner__internal_normalize_phone(p_phone);
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  v_reason := nullif(btrim(p_reason), '');
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 or length(p_idempotency_key) > 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'collaborator_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'collaborator_id', btrim(p_collaborator_id),
      'expected_version', p_expected_version,
      'display_name', v_display,
      'address', v_address,
      'phone', v_phone
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_collaborator(btrim(p_collaborator_id), p_expected_version);
  if v_before.display_name = v_display
     and v_before.address is not distinct from v_address
     and v_before.phone is not distinct from v_phone then
    raise exception 'collaborator display name is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, v_reason);

  update public.collaborators
     set display_name = v_display,
         address = v_address,
         phone = v_phone,
         version = version + 1
   where collaborator_id = v_before.collaborator_id
  returning * into v_after;

  if v_after.display_name is distinct from v_before.display_name then
    v_changed := array_append(v_changed, 'display_name');
    select pa.app_user_id
      into v_partner_app_user_id
      from public.partner_accounts pa
     where pa.partner_kind = 'COLLABORATOR'
       and pa.collaborator_id = v_after.collaborator_id
       and pa.app_user_id is not null
     for share;
    if v_partner_app_user_id is not null then
      update public.direct_entry_app_users
         set display_name = v_after.display_name,
             updated_at = pg_catalog.clock_timestamp()
       where app_user_id = v_partner_app_user_id;
    end if;
  end if;
  if v_after.address is distinct from v_before.address then
    v_changed := array_append(v_changed, 'address');
  end if;
  if v_after.phone is distinct from v_before.phone then
    v_changed := array_append(v_changed, 'phone');
  end if;

  insert into public.direct_entry_collaborator_revisions (
    collaborator_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    v_after.collaborator_id,
    v_after.version,
    p_app_user_id,
    v_reason_id,
    public.direct_entry_collaborator_snapshot(v_before),
    public.direct_entry_collaborator_snapshot(v_after)
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    outcome, reason_id, changed_fields, collaborator_revision_id
  ) values (
    p_auth_subject, p_app_user_id, 'collaborator_update', v_authority,
    v_after.collaborator_id, 'all', 'APPLIED', v_reason_id,
    v_changed, v_revision_id
  );

  v_result := public.direct_entry_collaborator_admin_projection(v_after);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'collaborator_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;
revoke all on function public.direct_entry_update_collaborator(uuid, uuid, text, integer, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_collaborator(uuid, uuid, text, integer, text, text, text, text, text)
  to service_role;

create or replace function public.direct_entry_set_collaborator_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_collaborator_id text,
  p_active boolean,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_reason text;
  v_reason_id uuid;
  v_before public.collaborators;
  v_after public.collaborators;
  v_revision_id uuid;
  v_partner public.partner_accounts%rowtype;
  v_app_user public.direct_entry_app_users%rowtype;
  v_app_user_rev_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_collaborator_id is null or btrim(p_collaborator_id) = '' then
    raise exception 'collaborator required' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'collaborator active flag required' using errcode = '22023';
  end if;
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  v_reason := nullif(btrim(p_reason), '');
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 or length(p_idempotency_key) > 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'collaborator_set_active', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'collaborator_id', btrim(p_collaborator_id),
      'active', p_active,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_collaborator(btrim(p_collaborator_id), p_expected_version);
  if v_before.active = p_active then
    raise exception 'collaborator active state is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, v_reason);

  update public.collaborators
     set active = p_active,
         version = version + 1
   where collaborator_id = v_before.collaborator_id
  returning * into v_after;

  select pa.*
    into v_partner
    from public.partner_accounts pa
   where pa.partner_kind = 'COLLABORATOR'
     and pa.collaborator_id = v_after.collaborator_id
   for update;

  if found and v_partner.app_user_id is not null then
    select u.*
      into v_app_user
      from public.direct_entry_app_users u
     where u.app_user_id = v_partner.app_user_id
     for update;

    if not p_active then
      if v_app_user.enabled then
        update public.direct_entry_app_users
           set enabled = false,
               version = version + 1,
               updated_at = pg_catalog.clock_timestamp()
         where app_user_id = v_app_user.app_user_id
         returning * into v_app_user;

        insert into public.direct_entry_app_user_revisions (
          app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
        ) values (
          v_app_user.app_user_id, v_app_user.version, p_app_user_id, 'disable',
          public.direct_entry_app_user_snapshot(v_app_user.app_user_id, true, p_app_user_id),
          public.direct_entry_app_user_snapshot(v_app_user.app_user_id, false, p_app_user_id),
          v_reason_id
        ) returning revision_id into v_app_user_rev_id;
      end if;

      update public.partner_accounts
         set account_state = case
               when activated_at is not null then 'SUSPENDED'
               else 'PENDING_ACTIVATION'
             end,
             version = version + 1
       where partner_account_id = v_partner.partner_account_id;
    else
      if v_partner.activated_at is not null then
        if not v_app_user.enabled then
          update public.direct_entry_app_users
             set enabled = true,
                 version = version + 1,
                 updated_at = pg_catalog.clock_timestamp()
           where app_user_id = v_app_user.app_user_id
           returning * into v_app_user;

          insert into public.direct_entry_app_user_revisions (
            app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
          ) values (
            v_app_user.app_user_id, v_app_user.version, p_app_user_id, 'enable',
            public.direct_entry_app_user_snapshot(v_app_user.app_user_id, false, p_app_user_id),
            public.direct_entry_app_user_snapshot(v_app_user.app_user_id, true, p_app_user_id),
            v_reason_id
          ) returning revision_id into v_app_user_rev_id;
        end if;

        update public.partner_accounts
           set account_state = case
                 when must_change_password then 'ACTIVE_MUST_CHANGE_PASSWORD'
                 else 'ACTIVE'
               end,
               version = version + 1
         where partner_account_id = v_partner.partner_account_id;
      else
        if v_app_user.enabled then
          update public.direct_entry_app_users
             set enabled = false,
                 version = version + 1,
                 updated_at = pg_catalog.clock_timestamp()
           where app_user_id = v_app_user.app_user_id;
        end if;

        update public.partner_accounts
           set account_state = 'PENDING_ACTIVATION',
               version = version + 1
         where partner_account_id = v_partner.partner_account_id;
      end if;
    end if;
  end if;

  insert into public.direct_entry_collaborator_revisions (
    collaborator_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    v_after.collaborator_id,
    v_after.version,
    p_app_user_id,
    v_reason_id,
    public.direct_entry_collaborator_snapshot(v_before),
    public.direct_entry_collaborator_snapshot(v_after)
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    outcome, reason_id, changed_fields, collaborator_revision_id, app_user_revision_id
  ) values (
    p_auth_subject, p_app_user_id, 'collaborator_set_active', v_authority,
    v_after.collaborator_id, 'all', 'APPLIED', v_reason_id,
    array['active'], v_revision_id, v_app_user_rev_id
  );

  v_result := public.direct_entry_collaborator_admin_projection(v_after);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'collaborator_set_active', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;
revoke all on function public.direct_entry_set_collaborator_active(uuid, uuid, text, boolean, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_set_collaborator_active(uuid, uuid, text, boolean, integer, text, text)
  to service_role;

-- =============================================================================
-- SECTION 7: Partner Provisioning, Activation & Portal RPCs (service_role only)
-- =============================================================================

-- 7a. Internal partner portal session guard (active parent + enabled + activated + not suspended).
create or replace function public.partner__internal_assert_partner_session(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_require_password_changed boolean default false,
  p_require_kind text default null
)
returns public.partner_accounts
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_pa public.partner_accounts%rowtype;
  v_parent_active boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'PARTNER_PORTAL_FORBIDDEN' using errcode = '42501';
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject;
  if not found or not coalesce(v_user.enabled, false) or not coalesce(v_user.authz_managed, false) then
    raise exception 'PARTNER_PORTAL_FORBIDDEN' using errcode = '42501';
  end if;

  select pa.*
    into v_pa
    from public.partner_accounts pa
   where pa.app_user_id = p_app_user_id;
  if not found then
    raise exception 'PARTNER_PORTAL_FORBIDDEN' using errcode = '42501';
  end if;

  if v_pa.partner_kind = 'VENDOR' then
    select v.active into v_parent_active
      from public.vendors v
     where v.vendor_id = v_pa.vendor_id;
  else
    select c.active into v_parent_active
      from public.collaborators c
     where c.collaborator_id = v_pa.collaborator_id;
  end if;

  if not coalesce(v_parent_active, false)
     or v_pa.activated_at is null
     or v_pa.account_state not in ('ACTIVE_MUST_CHANGE_PASSWORD', 'ACTIVE') then
    raise exception 'PARTNER_PORTAL_FORBIDDEN' using errcode = '42501';
  end if;

  if p_require_kind is not null and v_pa.partner_kind <> p_require_kind then
    raise exception 'PARTNER_PORTAL_FORBIDDEN' using errcode = '42501';
  end if;

  if coalesce(p_require_password_changed, false)
     and (v_pa.must_change_password or v_pa.account_state <> 'ACTIVE') then
    raise exception 'PARTNER_PASSWORD_CHANGE_REQUIRED' using errcode = '42501';
  end if;

  return v_pa;
end;
$function$;
revoke all on function public.partner__internal_assert_partner_session(uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role;

-- 7b. Preflight conflicts report (catalog operator + all scope).
create or replace function public.partner_account_preflight_conflicts_admin(
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
  v_intra jsonb := '[]'::jsonb;
  v_cross jsonb := '[]'::jsonb;
  v_unregistered jsonb := '[]'::jsonb;
  v_email_collisions jsonb := '[]'::jsonb;
  v_total_conflicts integer := 0;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  with catalog_entries as (
    select
      'VENDOR'::text as partner_kind,
      v.vendor_id as partner_id,
      pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) as canonical_code,
      v.display_name,
      v.active
    from public.vendors v
    where v.vendor_id <> '__system_vendor__'
    union all
    select
      'COLLABORATOR'::text as partner_kind,
      c.collaborator_id as partner_id,
      pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) as canonical_code,
      c.display_name,
      c.active
    from public.collaborators c
    where c.collaborator_id <> '__system_vendor__'
  ),
  intra_groups as (
    select
      ce.partner_kind,
      ce.canonical_code,
      count(*)::integer as row_count,
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'partner_id', ce.partner_id,
          'display_name', ce.display_name,
          'active', ce.active
        )
        order by ce.partner_id asc
      ) as rows
    from catalog_entries ce
    group by ce.partner_kind, ce.canonical_code
    having count(*) > 1
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'partner_kind', ig.partner_kind,
        'canonical_code', ig.canonical_code,
        'row_count', ig.row_count,
        'rows', ig.rows
      )
      order by ig.partner_kind asc, ig.canonical_code asc
    ),
    '[]'::jsonb
  )
    into v_intra
    from intra_groups ig;

  with catalog_entries as (
    select
      'VENDOR'::text as partner_kind,
      v.vendor_id as partner_id,
      pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) as canonical_code,
      v.display_name,
      v.active
    from public.vendors v
    where v.vendor_id <> '__system_vendor__'
    union all
    select
      'COLLABORATOR'::text as partner_kind,
      c.collaborator_id as partner_id,
      pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) as canonical_code,
      c.display_name,
      c.active
    from public.collaborators c
    where c.collaborator_id <> '__system_vendor__'
  ),
  cross_groups as (
    select
      ce.canonical_code,
      count(distinct ce.partner_kind)::integer as kind_count,
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'partner_kind', ce.partner_kind,
          'partner_id', ce.partner_id,
          'display_name', ce.display_name,
          'active', ce.active
        )
        order by ce.partner_kind asc, ce.partner_id asc
      ) as rows
    from catalog_entries ce
    group by ce.canonical_code
    having count(distinct ce.partner_kind) > 1
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'canonical_code', cg.canonical_code,
        'rows', cg.rows
      )
      order by cg.canonical_code asc
    ),
    '[]'::jsonb
  )
    into v_cross
    from cross_groups cg;

  with catalog_entries as (
    select
      'VENDOR'::text as partner_kind,
      v.vendor_id as partner_id,
      pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) as canonical_code,
      v.display_name,
      v.active
    from public.vendors v
    where v.vendor_id <> '__system_vendor__'
    union all
    select
      'COLLABORATOR'::text as partner_kind,
      c.collaborator_id as partner_id,
      pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) as canonical_code,
      c.display_name,
      c.active
    from public.collaborators c
    where c.collaborator_id <> '__system_vendor__'
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'partner_kind', ce.partner_kind,
        'partner_id', ce.partner_id,
        'canonical_code', ce.canonical_code,
        'display_name', ce.display_name,
        'active', ce.active
      )
      order by ce.canonical_code asc, ce.partner_kind asc, ce.partner_id asc
    ),
    '[]'::jsonb
  )
    into v_unregistered
    from catalog_entries ce
   where not exists (
     select 1
       from public.partner_code_registry r
      where r.canonical_code = ce.canonical_code
        and (
          (ce.partner_kind = 'VENDOR' and r.vendor_id = ce.partner_id)
          or
          (ce.partner_kind = 'COLLABORATOR' and r.collaborator_id = ce.partner_id)
        )
   );

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'email', c.email,
        'canonical_code', c.canonical_code,
        'auth_subject', c.auth_subject
      )
      order by c.email asc, c.auth_subject asc
    ),
    '[]'::jsonb
  )
    into v_email_collisions
    from public.partner__internal_list_auth_email_collisions() c;

  v_total_conflicts := pg_catalog.jsonb_array_length(v_intra)
    + pg_catalog.jsonb_array_length(v_cross)
    + pg_catalog.jsonb_array_length(v_unregistered)
    + pg_catalog.jsonb_array_length(v_email_collisions);

  return pg_catalog.jsonb_build_object(
    'checked_at', pg_catalog.clock_timestamp(),
    'has_conflicts', v_total_conflicts > 0,
    'conflict_count', v_total_conflicts,
    'intra_catalog_duplicates', v_intra,
    'cross_catalog_duplicates', v_cross,
    'unregistered_catalog_rows', v_unregistered,
    'auth_email_collisions', v_email_collisions
  );
end;
$function$;
revoke all on function public.partner_account_preflight_conflicts_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_account_preflight_conflicts_admin(uuid, uuid)
  to service_role;

-- 7c. Begin partner account provisioning (Full Admin only; supports safe resume).
create or replace function public.partner_account_provision_begin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_partner_kind text,
  p_partner_id text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_partner_kind text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_partner_kind, '')));
  v_partner_id text := pg_catalog.btrim(coalesce(p_partner_id, ''));
  v_canonical_code text;
  v_parent_display_name text;
  v_parent_active boolean := false;
  v_reason text;
  v_reason_id uuid;
  v_pa public.partner_accounts%rowtype;
  v_intent public.direct_entry_account_operation_intents%rowtype;
  v_conflict_count integer := 0;
  v_prior jsonb;
  v_result jsonb;
  v_auth_email text;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if v_partner_kind not in ('VENDOR', 'COLLABORATOR') then
    raise exception 'PARTNER_KIND_INVALID' using errcode = '22023';
  end if;
  if v_partner_id = '' or v_partner_id = '__system_vendor__' then
    raise exception 'PARTNER_ID_INVALID' using errcode = '22023';
  end if;
  v_canonical_code := pg_catalog.lower(v_partner_id);
  if not public.direct_entry_is_canonical_login_id(v_canonical_code) then
    raise exception 'PARTNER_USERNAME_FORMAT_INVALID' using errcode = '22023';
  end if;
  if p_reason is not null and pg_catalog.length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  v_reason := nullif(pg_catalog.btrim(p_reason), '');
  if p_idempotency_key is null or pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
     or pg_catalog.length(p_idempotency_key) > 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id,
    'partner_account_provision_begin',
    p_idempotency_key,
    public.direct_entry_payload_hash(pg_catalog.jsonb_build_object(
      'partner_kind', v_partner_kind,
      'partner_id', v_partner_id,
      'reason', v_reason
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('partner_code:' || v_canonical_code, 0)
  );

  if v_partner_kind = 'VENDOR' then
    select v.display_name, v.active
      into v_parent_display_name, v_parent_active
      from public.vendors v
     where v.vendor_id = v_partner_id
       and v.vendor_id <> '__system_vendor__'
     for update;
  else
    select c.display_name, c.active
      into v_parent_display_name, v_parent_active
      from public.collaborators c
     where c.collaborator_id = v_partner_id
       and c.collaborator_id <> '__system_vendor__'
     for update;
  end if;

  if not found then
    raise exception 'PARTNER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not coalesce(v_parent_active, false) then
    raise exception 'PARTNER_PARENT_INACTIVE' using errcode = 'PT409';
  end if;

  select count(*)::integer
    into v_conflict_count
    from (
      select 1
        from public.vendors v
       where v.vendor_id <> '__system_vendor__'
         and pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) = v_canonical_code
      union all
      select 1
        from public.collaborators c
       where c.collaborator_id <> '__system_vendor__'
         and pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) = v_canonical_code
    ) x;

  if v_conflict_count <> 1
     or not exists (
       select 1
         from public.partner_code_registry r
        where r.canonical_code = v_canonical_code
          and r.partner_kind = v_partner_kind
          and (
            (v_partner_kind = 'VENDOR' and r.vendor_id = v_partner_id)
            or
            (v_partner_kind = 'COLLABORATOR' and r.collaborator_id = v_partner_id)
          )
     ) then
    raise exception 'PARTNER_CODE_CONFLICT' using errcode = 'PT409';
  end if;

  select pa.*
    into v_pa
    from public.partner_accounts pa
   where pa.canonical_code = v_canonical_code
   for update;

  if not found then
    insert into public.partner_accounts (
      partner_kind,
      vendor_id,
      collaborator_id,
      canonical_code,
      account_state
    ) values (
      v_partner_kind,
      case when v_partner_kind = 'VENDOR' then v_partner_id else null end,
      case when v_partner_kind = 'COLLABORATOR' then v_partner_id else null end,
      v_canonical_code,
      'UNPROVISIONED'
    )
    returning * into v_pa;
  end if;

  if v_pa.account_state <> 'UNPROVISIONED' or v_pa.app_user_id is not null then
    raise exception 'PARTNER_ACCOUNT_ALREADY_PROVISIONED' using errcode = 'PT409';
  end if;

  v_auth_email := v_canonical_code || '@hrpartner.vn';

  -- Safe resume when an unresolved provisioning intent already belongs to this partner_account.
  if v_pa.provision_intent_id is not null then
    select i.*
      into v_intent
      from public.direct_entry_account_operation_intents i
     where i.intent_id = v_pa.provision_intent_id
     for update;

    if found and v_intent.kind = 'CREATE_ACCOUNT' and v_intent.login_id = v_canonical_code then
      if v_intent.state in ('BLOCKED', 'CONFLICT') then
        raise exception 'PARTNER_PROVISION_INTENT_BLOCKED' using errcode = 'PT409';
      end if;
      if v_intent.state in ('PENDING', 'IN_FLIGHT', 'INDETERMINATE') then
        update public.direct_entry_account_operation_intents
           set state = case when state = 'PENDING' then 'IN_FLIGHT' else state end,
               claimed_at = coalesce(claimed_at, pg_catalog.clock_timestamp()),
               updated_at = pg_catalog.clock_timestamp()
         where intent_id = v_intent.intent_id
         returning * into v_intent;

        v_result := pg_catalog.jsonb_build_object(
          'intent_id', v_intent.intent_id,
          'intent_token', v_intent.intent_token,
          'state', v_intent.state,
          'resumed', true,
          'partner_account_id', v_pa.partner_account_id,
          'partner_kind', v_pa.partner_kind,
          'partner_id', v_partner_id,
          'canonical_code', v_canonical_code,
          'username', v_canonical_code,
          'auth_email', v_auth_email,
          'display_name', pg_catalog.btrim(v_parent_display_name)
        );
        perform public.direct_entry_idempotency_finish(
          p_actor_app_user_id, 'partner_account_provision_begin', p_idempotency_key, v_result
        );
        return v_result;
      end if;
    end if;
  end if;

  -- Block collision with any unrelated live BI CREATE_ACCOUNT intent or existing Auth user email.
  if exists (
    select 1
      from public.direct_entry_account_operation_intents i
     where i.kind = 'CREATE_ACCOUNT'
       and i.login_id = v_canonical_code
       and i.state in ('PENDING', 'IN_FLIGHT', 'INDETERMINATE', 'BLOCKED', 'CONFLICT')
  ) then
    raise exception 'PARTNER_LOGIN_CONFLICT' using errcode = 'PT409';
  end if;

  if public.partner__internal_auth_email_exists(v_auth_email) then
    raise exception 'PARTNER_AUTH_EMAIL_CONFLICT' using errcode = 'PT409';
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, v_reason);

  insert into public.direct_entry_account_operation_intents (
    kind,
    state,
    login_id,
    display_name,
    account_ref,
    auth_subject,
    idempotency_key,
    reason_id,
    claimed_at
  ) values (
    'CREATE_ACCOUNT',
    'IN_FLIGHT',
    v_canonical_code,
    pg_catalog.btrim(v_parent_display_name),
    null,
    null,
    p_idempotency_key,
    v_reason_id,
    pg_catalog.clock_timestamp()
  ) returning * into v_intent;

  update public.partner_accounts
     set provision_intent_id = v_intent.intent_id,
         version = version + 1
   where partner_account_id = v_pa.partner_account_id
   returning * into v_pa;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    outcome, reason_id, changed_fields
  ) values (
    p_auth_subject, p_actor_app_user_id, 'partner_account_provision_begin', 'entry_admin',
    v_canonical_code, 'all', 'APPLIED', v_reason_id,
    array['provision_intent_id']
  );

  v_result := pg_catalog.jsonb_build_object(
    'intent_id', v_intent.intent_id,
    'intent_token', v_intent.intent_token,
    'state', v_intent.state,
    'resumed', false,
    'partner_account_id', v_pa.partner_account_id,
    'partner_kind', v_pa.partner_kind,
    'partner_id', v_partner_id,
    'canonical_code', v_canonical_code,
    'username', v_canonical_code,
    'auth_email', v_auth_email,
    'display_name', pg_catalog.btrim(v_parent_display_name)
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, 'partner_account_provision_begin', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;
revoke all on function public.partner_account_provision_begin(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_account_provision_begin(uuid, uuid, text, text, text, text)
  to service_role;

-- 7d. Finalize partner account provisioning (links disabled app_user + PENDING_ACTIVATION).
create or replace function public.partner_account_provision_finalize(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_partner_kind text,
  p_partner_id text,
  p_intent_id uuid,
  p_intent_token uuid,
  p_created_auth_subject uuid,
  p_activation_code_hash text,
  p_activation_expires_at timestamp with time zone,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_partner_kind text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_partner_kind, '')));
  v_partner_id text := pg_catalog.btrim(coalesce(p_partner_id, ''));
  v_canonical_code text;
  v_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_activation_code_hash, '')));
  v_intent public.direct_entry_account_operation_intents%rowtype;
  v_pa public.partner_accounts%rowtype;
  v_parent_display_name text;
  v_app_user public.direct_entry_app_users%rowtype;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if v_partner_kind not in ('VENDOR', 'COLLABORATOR') or v_partner_id = '' then
    raise exception 'PARTNER_TARGET_INVALID' using errcode = '22023';
  end if;
  if p_intent_id is null or p_intent_token is null or p_created_auth_subject is null then
    raise exception 'PARTNER_PROVISION_PARAMS_REQUIRED' using errcode = '22023';
  end if;
  if v_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'PARTNER_ACTIVATION_HASH_INVALID' using errcode = '22023';
  end if;
  if p_activation_expires_at is null or p_activation_expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'PARTNER_ACTIVATION_EXPIRY_INVALID' using errcode = '22023';
  end if;
  if p_idempotency_key is null or pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
     or pg_catalog.length(p_idempotency_key) > 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_canonical_code := pg_catalog.lower(v_partner_id);

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id,
    'partner_account_provision_finalize',
    p_idempotency_key,
    public.direct_entry_payload_hash(pg_catalog.jsonb_build_object(
      'partner_kind', v_partner_kind,
      'partner_id', v_partner_id,
      'intent_id', p_intent_id,
      'intent_token', p_intent_token,
      'created_auth_subject', p_created_auth_subject,
      'activation_code_hash', v_hash,
      'activation_expires_at', p_activation_expires_at
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('partner_code:' || v_canonical_code, 0)
  );

  v_intent := public.direct_entry_lock_account_operation(p_intent_id);
  if v_intent.kind <> 'CREATE_ACCOUNT' or v_intent.login_id <> v_canonical_code then
    raise exception 'PARTNER_PROVISION_INTENT_MISMATCH' using errcode = '22023';
  end if;

  select pa.*
    into v_pa
    from public.partner_accounts pa
   where pa.canonical_code = v_canonical_code
     and pa.partner_kind = v_partner_kind
     and (
       (v_partner_kind = 'VENDOR' and pa.vendor_id = v_partner_id)
       or
       (v_partner_kind = 'COLLABORATOR' and pa.collaborator_id = v_partner_id)
     )
   for update;

  if not found then
    raise exception 'PARTNER_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_pa.provision_intent_id is distinct from p_intent_id then
    raise exception 'PARTNER_PROVISION_INTENT_MISMATCH' using errcode = 'PT409';
  end if;

  if v_pa.account_state <> 'UNPROVISIONED' or v_pa.app_user_id is not null then
    raise exception 'PARTNER_ACCOUNT_ALREADY_PROVISIONED' using errcode = 'PT409';
  end if;

  if v_intent.state not in ('PENDING', 'IN_FLIGHT', 'INDETERMINATE') then
    raise exception 'PARTNER_PROVISION_INTENT_NOT_CLAIMABLE' using errcode = 'PT409';
  end if;

  if v_intent.intent_token <> p_intent_token then
    update public.direct_entry_account_operation_intents
       set state = 'BLOCKED',
           resolved_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where intent_id = p_intent_id;
    raise exception 'PARTNER_PROVISION_PROVENANCE_MISMATCH' using errcode = 'PT409';
  end if;

  if v_partner_kind = 'VENDOR' then
    select v.display_name into v_parent_display_name
      from public.vendors v
     where v.vendor_id = v_partner_id
     for share;
  else
    select c.display_name into v_parent_display_name
      from public.collaborators c
     where c.collaborator_id = v_partner_id
     for share;
  end if;

  if exists (
    select 1
      from public.direct_entry_app_users u
     where u.auth_subject = p_created_auth_subject
  ) then
    raise exception 'PARTNER_AUTH_SUBJECT_ALREADY_LINKED' using errcode = 'PT409';
  end if;

  -- Strictly enabled=false and zero internal permission groups/capabilities/links.
  insert into public.direct_entry_app_users (
    auth_subject, enabled, display_name, authz_managed
  ) values (
    p_created_auth_subject, false, pg_catalog.btrim(v_parent_display_name), true
  ) returning * into v_app_user;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    v_app_user.app_user_id,
    v_app_user.version,
    p_actor_app_user_id,
    'account_created',
    null,
    jsonb_build_object('display_name', v_app_user.display_name, 'enabled', false),
    v_intent.reason_id
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    outcome, reason_id, changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, 'partner_account_provision_finalize', 'entry_admin',
    v_canonical_code, 'all', 'APPLIED', v_intent.reason_id,
    array['app_user_id', 'username', 'account_state'], v_revision_id
  );

  update public.direct_entry_account_operation_intents
     set state = 'APPLIED',
         resolved_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp(),
         auth_subject = p_created_auth_subject,
         account_ref = v_app_user.app_user_id
   where intent_id = p_intent_id;

  update public.partner_accounts
     set app_user_id = v_app_user.app_user_id,
         username = v_canonical_code,
         account_state = 'PENDING_ACTIVATION',
         activation_code_hash = v_hash,
         activation_expires_at = p_activation_expires_at,
         activation_attempts = 0,
         activated_at = null,
         must_change_password = true,
         version = version + 1
   where partner_account_id = v_pa.partner_account_id
   returning * into v_pa;

  v_result := pg_catalog.jsonb_build_object(
    'partner_account_id', v_pa.partner_account_id,
    'partner_kind', v_pa.partner_kind,
    'partner_id', v_partner_id,
    'canonical_code', v_pa.canonical_code,
    'username', v_pa.username,
    'app_user_id', v_app_user.app_user_id,
    'auth_subject', p_created_auth_subject,
    'account_state', v_pa.account_state,
    'activation_expires_at', v_pa.activation_expires_at,
    'must_change_password', v_pa.must_change_password,
    'version', v_pa.version,
    'revision_id', v_revision_id,
    'intent_id', p_intent_id
  );

  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, 'partner_account_provision_finalize', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;
revoke all on function public.partner_account_provision_finalize(uuid, uuid, text, text, uuid, uuid, uuid, text, timestamp with time zone, text)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_account_provision_finalize(uuid, uuid, text, text, uuid, uuid, uuid, text, timestamp with time zone, text)
  to service_role;

-- 7e. Rotate activation code (Full Admin only, while still unactivated PENDING_ACTIVATION).
create or replace function public.partner_account_rotate_activation_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_partner_kind text,
  p_partner_id text,
  p_activation_code_hash text,
  p_activation_expires_at timestamp with time zone,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_partner_kind text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_partner_kind, '')));
  v_partner_id text := pg_catalog.btrim(coalesce(p_partner_id, ''));
  v_canonical_code text;
  v_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_activation_code_hash, '')));
  v_reason text;
  v_reason_id uuid;
  v_parent_active boolean := false;
  v_pa public.partner_accounts%rowtype;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if v_partner_kind not in ('VENDOR', 'COLLABORATOR') or v_partner_id = '' then
    raise exception 'PARTNER_TARGET_INVALID' using errcode = '22023';
  end if;
  if v_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'PARTNER_ACTIVATION_HASH_INVALID' using errcode = '22023';
  end if;
  if p_activation_expires_at is null or p_activation_expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'PARTNER_ACTIVATION_EXPIRY_INVALID' using errcode = '22023';
  end if;
  if p_reason is not null and pg_catalog.length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  v_reason := nullif(pg_catalog.btrim(p_reason), '');
  if p_idempotency_key is null or pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
     or pg_catalog.length(p_idempotency_key) > 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_canonical_code := pg_catalog.lower(v_partner_id);

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id,
    'partner_account_rotate_activation_admin',
    p_idempotency_key,
    public.direct_entry_payload_hash(pg_catalog.jsonb_build_object(
      'partner_kind', v_partner_kind,
      'partner_id', v_partner_id,
      'activation_code_hash', v_hash,
      'activation_expires_at', p_activation_expires_at,
      'reason', v_reason
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_partner_kind = 'VENDOR' then
    select v.active into v_parent_active
      from public.vendors v
     where v.vendor_id = v_partner_id
     for share;
  else
    select c.active into v_parent_active
      from public.collaborators c
     where c.collaborator_id = v_partner_id
     for share;
  end if;

  if not found then
    raise exception 'PARTNER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not coalesce(v_parent_active, false) then
    raise exception 'PARTNER_PARENT_INACTIVE' using errcode = 'PT409';
  end if;

  select pa.*
    into v_pa
    from public.partner_accounts pa
   where pa.canonical_code = v_canonical_code
     and pa.partner_kind = v_partner_kind
     and (
       (v_partner_kind = 'VENDOR' and pa.vendor_id = v_partner_id)
       or
       (v_partner_kind = 'COLLABORATOR' and pa.collaborator_id = v_partner_id)
     )
   for update;

  if not found or v_pa.app_user_id is null then
    raise exception 'PARTNER_ACCOUNT_NOT_PROVISIONED' using errcode = 'PT409';
  end if;

  if v_pa.activated_at is not null or v_pa.account_state <> 'PENDING_ACTIVATION' then
    raise exception 'PARTNER_ACCOUNT_ALREADY_ACTIVATED' using errcode = 'PT409';
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, v_reason);

  update public.partner_accounts
     set activation_code_hash = v_hash,
         activation_expires_at = p_activation_expires_at,
         activation_attempts = 0,
         version = version + 1
   where partner_account_id = v_pa.partner_account_id
   returning * into v_pa;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    outcome, reason_id, changed_fields
  ) values (
    p_auth_subject, p_actor_app_user_id, 'partner_account_rotate_activation', 'entry_admin',
    v_canonical_code, 'all', 'APPLIED', v_reason_id,
    array['activation_code_hash', 'activation_expires_at', 'activation_attempts']
  );

  v_result := public.partner__internal_account_summary_by_partner(v_partner_kind, v_partner_id);
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, 'partner_account_rotate_activation_admin', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;
revoke all on function public.partner_account_rotate_activation_admin(uuid, uuid, text, text, text, timestamp with time zone, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_account_rotate_activation_admin(uuid, uuid, text, text, text, timestamp with time zone, text, text)
  to service_role;

-- 7f. Activate partner account (normalizes username, verifies hash & persists attempt counter).
-- Returns uniform { ok: false, error_code: 'PARTNER_ACTIVATION_INVALID' } on any failure so
-- activation_attempts increments durably without rolling back the transaction.
create or replace function public.partner_account_activate(
  p_username text,
  p_activation_code_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_username text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_username, '')));
  v_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_activation_code_hash, '')));
  v_pa public.partner_accounts%rowtype;
  v_parent_active boolean := false;
  v_app_user public.direct_entry_app_users%rowtype;
  v_revision_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if v_username = '' or v_hash !~ '^[a-f0-9]{64}$' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error_code', 'PARTNER_ACTIVATION_INVALID'
    );
  end if;

  select pa.*
    into v_pa
    from public.partner_accounts pa
   where pa.username = v_username
   for update;

  if not found or v_pa.app_user_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error_code', 'PARTNER_ACTIVATION_INVALID'
    );
  end if;

  if v_pa.partner_kind = 'VENDOR' then
    select v.active into v_parent_active
      from public.vendors v
     where v.vendor_id = v_pa.vendor_id
     for share;
  else
    select c.active into v_parent_active
      from public.collaborators c
     where c.collaborator_id = v_pa.collaborator_id
     for share;
  end if;

  if not coalesce(v_parent_active, false)
     or v_pa.account_state <> 'PENDING_ACTIVATION'
     or v_pa.activated_at is not null
     or v_pa.activation_code_hash is null
     or v_pa.activation_expires_at is null
     or v_pa.activation_expires_at <= v_now
     or v_pa.activation_attempts >= 5 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error_code', 'PARTNER_ACTIVATION_INVALID'
    );
  end if;

  if v_pa.activation_code_hash <> v_hash then
    update public.partner_accounts
       set activation_attempts = activation_attempts + 1,
           version = version + 1
     where partner_account_id = v_pa.partner_account_id;

    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
      outcome, denial_code, changed_fields
    ) values (
      null, v_pa.app_user_id, 'partner_account_activate', null,
      v_pa.canonical_code, 'own', 'REJECTED', 'PARTNER_ACTIVATION_INVALID',
      array['activation_attempts']
    );

    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error_code', 'PARTNER_ACTIVATION_INVALID'
    );
  end if;

  select u.*
    into v_app_user
    from public.direct_entry_app_users u
   where u.app_user_id = v_pa.app_user_id
   for update;

  if not v_app_user.enabled then
    update public.direct_entry_app_users
       set enabled = true,
           version = version + 1,
           updated_at = v_now
     where app_user_id = v_app_user.app_user_id
     returning * into v_app_user;

    insert into public.direct_entry_app_user_revisions (
      app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
    ) values (
      v_app_user.app_user_id, v_app_user.version, v_app_user.app_user_id, 'enable',
      public.direct_entry_app_user_snapshot(v_app_user.app_user_id, false, v_app_user.app_user_id),
      public.direct_entry_app_user_snapshot(v_app_user.app_user_id, true, v_app_user.app_user_id),
      null
    ) returning revision_id into v_revision_id;
  end if;

  update public.partner_accounts
     set account_state = 'ACTIVE_MUST_CHANGE_PASSWORD',
         activated_at = v_now,
         must_change_password = true,
         activation_code_hash = null,
         activation_expires_at = null,
         version = version + 1
   where partner_account_id = v_pa.partner_account_id
   returning * into v_pa;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    outcome, changed_fields, app_user_revision_id
  ) values (
    v_app_user.auth_subject, v_app_user.app_user_id, 'partner_account_activate', null,
    v_pa.canonical_code, 'own', 'APPLIED',
    array['account_state', 'activated_at', 'enabled'], v_revision_id
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'partner_account_id', v_pa.partner_account_id,
    'partner_kind', v_pa.partner_kind,
    'vendor_id', v_pa.vendor_id,
    'collaborator_id', v_pa.collaborator_id,
    'partner_id', coalesce(v_pa.vendor_id, v_pa.collaborator_id),
    'canonical_code', v_pa.canonical_code,
    'username', v_pa.username,
    'app_user_id', v_pa.app_user_id,
    'auth_subject', v_app_user.auth_subject,
    'account_state', v_pa.account_state,
    'must_change_password', v_pa.must_change_password,
    'activated_at', v_pa.activated_at
  );
end;
$function$;
revoke all on function public.partner_account_activate(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_account_activate(text, text)
  to service_role;

-- 7g. Mark initial password changed (transitions ACTIVE_MUST_CHANGE_PASSWORD -> ACTIVE).
create or replace function public.partner_account_mark_password_changed(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_pa public.partner_accounts%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  v_pa := public.partner__internal_assert_partner_session(p_auth_subject, p_app_user_id, false, null);

  select pa.*
    into v_pa
    from public.partner_accounts pa
   where pa.partner_account_id = v_pa.partner_account_id
   for update;

  if v_pa.account_state = 'ACTIVE_MUST_CHANGE_PASSWORD' or v_pa.must_change_password then
    update public.partner_accounts
       set account_state = 'ACTIVE',
           must_change_password = false,
           password_changed_at = coalesce(password_changed_at, v_now),
           version = version + 1
     where partner_account_id = v_pa.partner_account_id
     returning * into v_pa;

    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
      outcome, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'partner_account_password_changed', null,
      v_pa.canonical_code, 'own', 'APPLIED',
      array['account_state', 'must_change_password', 'password_changed_at']
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'partner_account_id', v_pa.partner_account_id,
    'partner_kind', v_pa.partner_kind,
    'vendor_id', v_pa.vendor_id,
    'collaborator_id', v_pa.collaborator_id,
    'partner_id', coalesce(v_pa.vendor_id, v_pa.collaborator_id),
    'canonical_code', v_pa.canonical_code,
    'username', v_pa.username,
    'account_state', v_pa.account_state,
    'must_change_password', v_pa.must_change_password,
    'password_changed_at', v_pa.password_changed_at
  );
end;
$function$;
revoke all on function public.partner_account_mark_password_changed(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_account_mark_password_changed(uuid, uuid)
  to service_role;

-- 7h. Partner portal profile read (scoped strictly to session app_user_id).
create or replace function public.partner_portal_get_profile(
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
  v_pa public.partner_accounts%rowtype;
  v_vendor public.vendors%rowtype;
  v_collaborator public.collaborators%rowtype;
begin
  v_pa := public.partner__internal_assert_partner_session(p_auth_subject, p_app_user_id, false, null);

  if v_pa.partner_kind = 'VENDOR' then
    select v.* into v_vendor
      from public.vendors v
     where v.vendor_id = v_pa.vendor_id;

    return pg_catalog.jsonb_build_object(
      'partner_account_id', v_pa.partner_account_id,
      'partner_kind', 'VENDOR',
      'partner_id', v_vendor.vendor_id,
      'code', v_vendor.vendor_id,
      'canonical_code', v_pa.canonical_code,
      'username', v_pa.username,
      'display_name', v_vendor.display_name,
      'address', v_vendor.address,
      'phone', v_vendor.phone,
      'active', v_vendor.active,
      'version', v_vendor.version,
      'account_state', v_pa.account_state,
      'must_change_password', v_pa.must_change_password,
      'activated_at', v_pa.activated_at,
      'password_changed_at', v_pa.password_changed_at
    );
  end if;

  select c.* into v_collaborator
    from public.collaborators c
   where c.collaborator_id = v_pa.collaborator_id;

  return pg_catalog.jsonb_build_object(
    'partner_account_id', v_pa.partner_account_id,
    'partner_kind', 'COLLABORATOR',
    'partner_id', v_collaborator.collaborator_id,
    'code', v_collaborator.collaborator_id,
    'canonical_code', v_pa.canonical_code,
    'username', v_pa.username,
    'display_name', v_collaborator.display_name,
    'address', v_collaborator.address,
    'phone', v_collaborator.phone,
    'active', v_collaborator.active,
    'version', v_collaborator.version,
    'account_state', v_pa.account_state,
    'must_change_password', v_pa.must_change_password,
    'activated_at', v_pa.activated_at,
    'password_changed_at', v_pa.password_changed_at
  );
end;
$function$;
revoke all on function public.partner_portal_get_profile(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_portal_get_profile(uuid, uuid)
  to service_role;

-- 7i. Partner portal profile update (session-derived partner, OCC, code immutable).
create or replace function public.partner_portal_update_profile(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_display_name text,
  p_address text,
  p_phone text,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_pa public.partner_accounts%rowtype;
  v_display text;
  v_address text;
  v_phone text;
  v_prior jsonb;
  v_vendor_before public.vendors%rowtype;
  v_vendor_after public.vendors%rowtype;
  v_vendor_version integer;
  v_collab_before public.collaborators%rowtype;
  v_collab_after public.collaborators%rowtype;
  v_revision_id uuid;
  v_changed text[] := array[]::text[];
  v_result jsonb;
begin
  v_pa := public.partner__internal_assert_partner_session(p_auth_subject, p_app_user_id, true, null);

  if p_display_name is null or pg_catalog.length(pg_catalog.btrim(p_display_name)) not between 1 and 256 then
    raise exception 'PARTNER_DISPLAY_NAME_INVALID' using errcode = '22023';
  end if;
  v_display := pg_catalog.btrim(p_display_name);
  v_address := public.partner__internal_normalize_address(p_address);
  v_phone := public.partner__internal_normalize_phone(p_phone);

  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
     or pg_catalog.length(p_idempotency_key) > 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'partner_portal_update_profile',
    p_idempotency_key,
    public.direct_entry_payload_hash(pg_catalog.jsonb_build_object(
      'partner_kind', v_pa.partner_kind,
      'partner_id', coalesce(v_pa.vendor_id, v_pa.collaborator_id),
      'display_name', v_display,
      'address', v_address,
      'phone', v_phone,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_pa.partner_kind = 'VENDOR' then
    v_vendor_before := public.direct_entry_lock_vendor(v_pa.vendor_id, p_expected_version);

    update public.vendors
       set display_name = v_display,
           address = v_address,
           phone = v_phone
     where vendor_id = v_vendor_before.vendor_id
     returning * into v_vendor_after;

    if v_vendor_after.display_name is distinct from v_vendor_before.display_name then
      v_changed := array_append(v_changed, 'display_name');
      update public.direct_entry_app_users
         set display_name = v_vendor_after.display_name,
             updated_at = pg_catalog.clock_timestamp()
       where app_user_id = p_app_user_id;
    end if;
    if v_vendor_after.address is distinct from v_vendor_before.address then
      v_changed := array_append(v_changed, 'address');
    end if;
    if v_vendor_after.phone is distinct from v_vendor_before.phone then
      v_changed := array_append(v_changed, 'phone');
    end if;

    select b.vendor_version, b.revision_id
      into v_vendor_version, v_revision_id
      from public.direct_entry_bump_vendor_version(
        v_vendor_after.vendor_id, p_app_user_id, null,
        public.direct_entry_vendor_snapshot(v_vendor_before)
      ) b;

    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
      outcome, changed_fields, vendor_revision_id
    ) values (
      p_auth_subject, p_app_user_id, 'partner_portal_profile_update', null,
      v_vendor_after.vendor_id, 'own', 'APPLIED',
      v_changed, v_revision_id
    );

    v_result := pg_catalog.jsonb_build_object(
      'partner_account_id', v_pa.partner_account_id,
      'partner_kind', 'VENDOR',
      'partner_id', v_vendor_after.vendor_id,
      'code', v_vendor_after.vendor_id,
      'canonical_code', v_pa.canonical_code,
      'username', v_pa.username,
      'display_name', v_vendor_after.display_name,
      'address', v_vendor_after.address,
      'phone', v_vendor_after.phone,
      'active', v_vendor_after.active,
      'version', v_vendor_version,
      'account_state', v_pa.account_state,
      'must_change_password', v_pa.must_change_password,
      'activated_at', v_pa.activated_at,
      'password_changed_at', v_pa.password_changed_at
    );
  else
    v_collab_before := public.direct_entry_lock_collaborator(v_pa.collaborator_id, p_expected_version);

    update public.collaborators
       set display_name = v_display,
           address = v_address,
           phone = v_phone,
           version = version + 1
     where collaborator_id = v_collab_before.collaborator_id
     returning * into v_collab_after;

    if v_collab_after.display_name is distinct from v_collab_before.display_name then
      v_changed := array_append(v_changed, 'display_name');
      update public.direct_entry_app_users
         set display_name = v_collab_after.display_name,
             updated_at = pg_catalog.clock_timestamp()
       where app_user_id = p_app_user_id;
    end if;
    if v_collab_after.address is distinct from v_collab_before.address then
      v_changed := array_append(v_changed, 'address');
    end if;
    if v_collab_after.phone is distinct from v_collab_before.phone then
      v_changed := array_append(v_changed, 'phone');
    end if;

    insert into public.direct_entry_collaborator_revisions (
      collaborator_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
    ) values (
      v_collab_after.collaborator_id,
      v_collab_after.version,
      p_app_user_id,
      null,
      public.direct_entry_collaborator_snapshot(v_collab_before),
      public.direct_entry_collaborator_snapshot(v_collab_after)
    ) returning revision_id into v_revision_id;

    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
      outcome, changed_fields, collaborator_revision_id
    ) values (
      p_auth_subject, p_app_user_id, 'partner_portal_profile_update', null,
      v_collab_after.collaborator_id, 'own', 'APPLIED',
      v_changed, v_revision_id
    );

    v_result := pg_catalog.jsonb_build_object(
      'partner_account_id', v_pa.partner_account_id,
      'partner_kind', 'COLLABORATOR',
      'partner_id', v_collab_after.collaborator_id,
      'code', v_collab_after.collaborator_id,
      'canonical_code', v_pa.canonical_code,
      'username', v_pa.username,
      'display_name', v_collab_after.display_name,
      'address', v_collab_after.address,
      'phone', v_collab_after.phone,
      'active', v_collab_after.active,
      'version', v_collab_after.version,
      'account_state', v_pa.account_state,
      'must_change_password', v_pa.must_change_password,
      'activated_at', v_pa.activated_at,
      'password_changed_at', v_pa.password_changed_at
    );
  end if;

  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'partner_portal_update_profile', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;
revoke all on function public.partner_portal_update_profile(uuid, uuid, text, text, text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_portal_update_profile(uuid, uuid, text, text, text, integer, text)
  to service_role;

-- 7j. Vendor-only aggregate recruitment summary (strict vendor attribution & zero PII).
create or replace function public.partner_vendor_recruitment_summary(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_date_from date default null,
  p_date_to date default null,
  p_project_id text default null,
  p_group_by text default 'month'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_pa public.partner_accounts%rowtype;
  v_vendor_id text;
  v_vendor_name text;
  v_project_id text := nullif(pg_catalog.btrim(coalesce(p_project_id, '')), '');
  v_group_by text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_group_by, 'month')));
  v_total integer := 0;
  v_on integer := 0;
  v_off integer := 0;
  v_unconfirmed integer := 0;
  v_by_project jsonb := '[]'::jsonb;
  v_by_period jsonb := '[]'::jsonb;
  v_available_projects jsonb := '[]'::jsonb;
begin
  v_pa := public.partner__internal_assert_partner_session(p_auth_subject, p_app_user_id, true, 'VENDOR');
  v_vendor_id := v_pa.vendor_id;

  if v_group_by not in ('day', 'month') then
    raise exception 'PARTNER_GROUP_BY_INVALID' using errcode = '22023';
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'PARTNER_DATE_RANGE_INVALID' using errcode = '22023';
  end if;

  select v.display_name
    into v_vendor_name
    from public.vendors v
   where v.vendor_id = v_vendor_id;

  with vendor_scope_all as (
    select
      e.entry_id,
      e.project_id,
      coalesce(pr.display_name, e.project_id) as project_name,
      e.first_work_date,
      coalesce(st.status, 'UNCONFIRMED') as employment_status
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
    left join public.direct_entry_projects pr
      on pr.project_id = e.project_id
    left join lateral (
      select ev.status
        from public.direct_entry_employment_status_events ev
       where ev.entry_id = e.entry_id
       order by ev.version desc
       limit 1
    ) st on true
    where e.provider_type = 'vendor'
      and e.vendor_id = v_vendor_id
      and e.vendor_id is not null
      and e.vendor_id <> '__system_vendor__'
      and s.state = 'SUBMITTED'
      and e.deleted_at is null
      and e.voided_at is null
  ),
  filtered_entries as (
    select
      vs.*,
      case
        when v_group_by = 'day' then pg_catalog.to_char(vs.first_work_date, 'YYYY-MM-DD')
        else pg_catalog.to_char(pg_catalog.date_trunc('month', vs.first_work_date)::date, 'YYYY-MM')
      end as period_key
    from vendor_scope_all vs
    where (p_date_from is null or vs.first_work_date >= p_date_from)
      and (p_date_to is null or vs.first_work_date <= p_date_to)
      and (v_project_id is null or vs.project_id = v_project_id)
  )
  select
    count(*)::integer,
    count(*) filter (where fe.employment_status = 'ON')::integer,
    count(*) filter (where fe.employment_status = 'OFF')::integer,
    count(*) filter (where fe.employment_status = 'UNCONFIRMED')::integer,
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'project_id', bp.project_id,
          'project_name', bp.project_name,
          'total_workers', bp.total_workers,
          'on_count', bp.on_count,
          'off_count', bp.off_count,
          'unconfirmed_count', bp.unconfirmed_count
        )
        order by bp.total_workers desc, bp.project_name asc, bp.project_id asc
      )
      from (
        select
          fe2.project_id,
          fe2.project_name,
          count(*)::integer as total_workers,
          count(*) filter (where fe2.employment_status = 'ON')::integer as on_count,
          count(*) filter (where fe2.employment_status = 'OFF')::integer as off_count,
          count(*) filter (where fe2.employment_status = 'UNCONFIRMED')::integer as unconfirmed_count
        from filtered_entries fe2
        group by fe2.project_id, fe2.project_name
      ) bp
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'period_key', per.period_key,
          'total_workers', per.total_workers,
          'on_count', per.on_count,
          'off_count', per.off_count,
          'unconfirmed_count', per.unconfirmed_count
        )
        order by per.period_key asc
      )
      from (
        select
          fe3.period_key,
          count(*)::integer as total_workers,
          count(*) filter (where fe3.employment_status = 'ON')::integer as on_count,
          count(*) filter (where fe3.employment_status = 'OFF')::integer as off_count,
          count(*) filter (where fe3.employment_status = 'UNCONFIRMED')::integer as unconfirmed_count
        from filtered_entries fe3
        group by fe3.period_key
      ) per
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'project_id', ap.project_id,
          'project_name', ap.project_name,
          'worker_count', ap.worker_count
        )
        order by ap.project_name asc, ap.project_id asc
      )
      from (
        select
          vs2.project_id,
          vs2.project_name,
          count(*)::integer as worker_count
        from vendor_scope_all vs2
        group by vs2.project_id, vs2.project_name
      ) ap
    ), '[]'::jsonb)
  into
    v_total,
    v_on,
    v_off,
    v_unconfirmed,
    v_by_project,
    v_by_period,
    v_available_projects
  from filtered_entries fe;

  return pg_catalog.jsonb_build_object(
    'vendor_id', v_vendor_id,
    'vendor_name', v_vendor_name,
    'date_from', case when p_date_from is null then null else p_date_from::text end,
    'date_to', case when p_date_to is null then null else p_date_to::text end,
    'project_id', v_project_id,
    'group_by', v_group_by,
    'total_workers', coalesce(v_total, 0),
    'on_count', coalesce(v_on, 0),
    'off_count', coalesce(v_off, 0),
    'unconfirmed_count', coalesce(v_unconfirmed, 0),
    'by_project', v_by_project,
    'by_period', v_by_period,
    'available_projects', v_available_projects
  );
end;
$function$;
revoke all on function public.partner_vendor_recruitment_summary(uuid, uuid, date, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_vendor_recruitment_summary(uuid, uuid, date, date, text, text)
  to service_role;

-- 7k. Vendor-only minimal recruited-workers list (strictly 7 safe columns, zero sensitive PII).
create or replace function public.partner_vendor_list_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_project_id text default null,
  p_date_from date default null,
  p_date_to date default null,
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
  v_pa public.partner_accounts%rowtype;
  v_vendor_id text;
  v_search text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  v_project_id text := nullif(pg_catalog.btrim(coalesce(p_project_id, '')), '');
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_available_projects jsonb := '[]'::jsonb;
begin
  v_pa := public.partner__internal_assert_partner_session(p_auth_subject, p_app_user_id, true, 'VENDOR');
  v_vendor_id := v_pa.vendor_id;

  if v_search is not null and pg_catalog.length(v_search) > 256 then
    raise exception 'PARTNER_SEARCH_TOO_LONG' using errcode = '22023';
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'PARTNER_DATE_RANGE_INVALID' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  with vendor_scope_all as (
    select
      e.entry_id,
      nullif(pg_catalog.btrim(e.worker_details->>'display_name'), '') as full_name,
      e.employee_code,
      e.project_id,
      coalesce(pr.display_name, e.project_id) as project_name,
      e.first_work_date,
      coalesce(st.status, 'UNCONFIRMED') as employment_status
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
    left join public.direct_entry_projects pr
      on pr.project_id = e.project_id
    left join lateral (
      select ev.status
        from public.direct_entry_employment_status_events ev
       where ev.entry_id = e.entry_id
       order by ev.version desc
       limit 1
    ) st on true
    where e.provider_type = 'vendor'
      and e.vendor_id = v_vendor_id
      and e.vendor_id is not null
      and e.vendor_id <> '__system_vendor__'
      and s.state = 'SUBMITTED'
      and e.deleted_at is null
      and e.voided_at is null
  ),
  filtered_workers as (
    select vs.*
      from vendor_scope_all vs
     where (v_project_id is null or vs.project_id = v_project_id)
       and (p_date_from is null or vs.first_work_date >= p_date_from)
       and (p_date_to is null or vs.first_work_date <= p_date_to)
       and (
         v_search is null
         or coalesce(vs.full_name, '') ilike '%' || v_search || '%'
         or vs.employee_code ilike '%' || v_search || '%'
       )
  )
  select
    (select count(*)::integer from filtered_workers),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'entry_id', pg_row.entry_id,
          'full_name', pg_row.full_name,
          'employee_code', pg_row.employee_code,
          'project_id', pg_row.project_id,
          'project_name', pg_row.project_name,
          'first_work_date', pg_row.first_work_date::text,
          'employment_status', pg_row.employment_status
        )
        order by pg_row.first_work_date desc, pg_row.employee_code asc, pg_row.entry_id asc
      )
      from (
        select fw.*
          from filtered_workers fw
         order by fw.first_work_date desc, fw.employee_code asc, fw.entry_id asc
         limit v_page_size offset (v_page - 1) * v_page_size
      ) pg_row
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'project_id', ap.project_id,
          'project_name', ap.project_name,
          'worker_count', ap.worker_count
        )
        order by ap.project_name asc, ap.project_id asc
      )
      from (
        select
          vs2.project_id,
          vs2.project_name,
          count(*)::integer as worker_count
        from vendor_scope_all vs2
        group by vs2.project_id, vs2.project_name
      ) ap
    ), '[]'::jsonb)
  into v_total, v_items, v_available_projects;

  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'total', coalesce(v_total, 0),
    'page', v_page,
    'page_size', v_page_size,
    'available_projects', v_available_projects
  );
end;
$function$;
revoke all on function public.partner_vendor_list_workers(uuid, uuid, text, text, date, date, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_vendor_list_workers(uuid, uuid, text, text, date, date, integer, integer)
  to service_role;

-- =============================================================================
-- SECTION 8: Owner Alignment & Fail-Closed Postcheck
-- =============================================================================

do $postcheck$
declare
  v_service_rpcs text[] := array[
    'public.direct_entry_create_vendor(uuid, uuid, integer, text, text, date, text, text, text, text)',
    'public.direct_entry_update_vendor(uuid, uuid, text, integer, text, text, text, text, text)',
    'public.direct_entry_set_vendor_active(uuid, uuid, text, boolean, integer, text, text)',
    'public.direct_entry_create_collaborator(uuid, uuid, integer, text, text, text, text, text, text)',
    'public.direct_entry_update_collaborator(uuid, uuid, text, integer, text, text, text, text, text)',
    'public.direct_entry_set_collaborator_active(uuid, uuid, text, boolean, integer, text, text)',
    'public.direct_entry_resolve_actor_context(uuid)',
    'public.partner_account_preflight_conflicts_admin(uuid, uuid)',
    'public.partner_account_provision_begin(uuid, uuid, text, text, text, text)',
    'public.partner_account_provision_finalize(uuid, uuid, text, text, uuid, uuid, uuid, text, timestamp with time zone, text)',
    'public.partner_account_rotate_activation_admin(uuid, uuid, text, text, text, timestamp with time zone, text, text)',
    'public.partner_account_activate(text, text)',
    'public.partner_account_mark_password_changed(uuid, uuid)',
    'public.partner_portal_get_profile(uuid, uuid)',
    'public.partner_portal_update_profile(uuid, uuid, text, text, text, integer, text)',
    'public.partner_vendor_recruitment_summary(uuid, uuid, date, date, text, text)',
    'public.partner_vendor_list_workers(uuid, uuid, text, text, date, date, integer, integer)'
  ];
  v_internal_fns text[] := array[
    'public.partner__internal_normalize_address(text)',
    'public.partner__internal_normalize_phone(text)',
    'public.partner__internal_is_partner_app_user(uuid)',
    'public.partner__internal_account_summary_by_partner(text, text)',
    'public.partner__internal_guard_catalog_code()',
    'public.partner__internal_register_catalog_code()',
    'public.partner__internal_guard_group_membership()',
    'public.partner__internal_guard_partner_account_user()',
    'public.partner__internal_auth_email_exists(text)',
    'public.partner__internal_list_auth_email_collisions()',
    'public.partner__internal_assert_partner_session(uuid, uuid, boolean, text)',
    'public.direct_entry_vendor_snapshot(public.vendors)',
    'public.direct_entry_vendor_admin_projection(public.vendors, integer, uuid)',
    'public.direct_entry_collaborator_snapshot(public.collaborators)',
    'public.direct_entry_collaborator_admin_projection(public.collaborators)',
    'public.direct_entry_mutate_app_user_status(uuid, uuid, uuid, integer, text, text, boolean)',
    'public.direct_entry_assert_actor_mapping(uuid, uuid)',
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.hr_bulletin__internal_assert_active_actor(uuid, uuid)',
    'public.attendance__internal_is_non_employee_account(uuid, timestamp with time zone)',
    'public.work_report_assert_actor(uuid, uuid, text)'
  ];
  v_retired_sigs text[] := array[
    'public.direct_entry_create_vendor(uuid, uuid, integer, text, text, date, text, text)',
    'public.direct_entry_update_vendor(uuid, uuid, text, integer, text, text, text)',
    'public.direct_entry_create_collaborator(uuid, uuid, integer, text, text, text, text)',
    'public.direct_entry_update_collaborator(uuid, uuid, text, integer, text, text, text)'
  ];
  v_tables text[] := array[
    'public.partner_code_registry',
    'public.partner_accounts'
  ];
  v_sig text;
  v_oid oid;
  v_proc_owner oid;
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean := false;
  v_rec record;
  v_tbl text;
  v_tbl_oid oid;
  v_relrowsecurity boolean;
  v_relforcerowsecurity boolean;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  if v_base_owner is null or v_base_owner_oid is null then
    raise exception 'Partner portal postcheck failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_retired_sigs loop
    if pg_catalog.to_regprocedure(v_sig) is not null then
      raise exception 'Partner portal postcheck failed: retired overload % still exists', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Partner portal postcheck failed: missing RPC %', v_sig using errcode = '55000';
    end if;
    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);
    execute pg_catalog.format('grant execute on function %s to service_role', v_sig);

    select p.prosecdef, p.proconfig
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'Partner portal postcheck failed: definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'Partner portal postcheck failed: ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Partner portal postcheck failed: missing internal fn %', v_sig using errcode = '55000';
    end if;
    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);

    select p.prosecdef, p.proconfig
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'Partner portal postcheck failed: internal definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'Partner portal postcheck failed: internal ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_tbl in array v_tables loop
    v_tbl_oid := pg_catalog.to_regclass(v_tbl);
    if v_tbl_oid is null then
      raise exception 'Partner portal postcheck failed: missing table %', v_tbl using errcode = '55000';
    end if;

    select c.relrowsecurity, c.relforcerowsecurity
      into v_relrowsecurity, v_relforcerowsecurity
      from pg_catalog.pg_class c
     where c.oid = v_tbl_oid;

    if not coalesce(v_relrowsecurity, false) or not coalesce(v_relforcerowsecurity, false) then
      raise exception 'Partner portal postcheck failed: RLS/FORCE RLS disabled on %', v_tbl using errcode = '55000';
    end if;

    if pg_catalog.has_table_privilege('public', v_tbl_oid, 'SELECT')
       or pg_catalog.has_table_privilege('anon', v_tbl_oid, 'SELECT')
       or pg_catalog.has_table_privilege('authenticated', v_tbl_oid, 'SELECT')
       or pg_catalog.has_table_privilege('service_role', v_tbl_oid, 'SELECT')
       or pg_catalog.has_table_privilege('service_role', v_tbl_oid, 'INSERT')
       or pg_catalog.has_table_privilege('service_role', v_tbl_oid, 'UPDATE')
       or pg_catalog.has_table_privilege('service_role', v_tbl_oid, 'DELETE') then
      raise exception 'Partner portal postcheck failed: table privileges leaked on %', v_tbl using errcode = '55000';
    end if;
  end loop;
end
$postcheck$;

commit;
