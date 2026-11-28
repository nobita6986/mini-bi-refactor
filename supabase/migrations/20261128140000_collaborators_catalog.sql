-- =============================================================================
-- Collaborators (CTV) Master Catalog & Input Catalog Integration
--
-- Scope:
--   1. Independent `public.collaborators` catalog table + append-only
--      `public.direct_entry_collaborator_revisions` history (ENABLE + FORCE RLS,
--      REVOKE ALL from public, anon, authenticated, service_role).
--   2. Nullable `collaborator_revision_id` FK on `public.direct_entry_audit_events`.
--   3. 5 `service_role`-only administration RPCs authorized via
--      `public.direct_entry_assert_catalog_operator` with OCC, idempotency,
--      optional restricted reason, immutable revision, and audit event.
--   4. Update `public.direct_entry_input_catalog_unscoped_v42` to expose active
--      collaborators under the `'collaborators'` key while keeping every
--      existing key, signature, and ACL posture intact.
--
-- Strictly independent from `public.vendors`, `public.recruiters`,
-- `vendor_referrer_links`, and Vendor Finance.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Collaborators master table & append-only revision history.
-- -----------------------------------------------------------------------------
create table public.collaborators (
  collaborator_id text primary key
    check (
      collaborator_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'
      and collaborator_id <> '__system_vendor__'
    ),
  display_name text not null
    check (length(btrim(display_name)) > 0 and length(display_name) <= 256),
  active boolean not null default true,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index collaborators_active_display_idx
  on public.collaborators (active, display_name, collaborator_id);

create trigger collaborators_set_updated_at
  before update on public.collaborators
  for each row execute function public.set_updated_at();

alter table public.collaborators enable row level security;
alter table public.collaborators force row level security;
revoke all on table public.collaborators
  from public, anon, authenticated, service_role;

comment on table public.collaborators is
  'Master catalog of recruitment collaborators (CTV). Independent from public.vendors and public.recruiters; soft-deactivated via active = false.';

create table public.direct_entry_collaborator_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  collaborator_id text not null
    references public.collaborators(collaborator_id) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid
    references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (collaborator_id, version)
);

create index direct_entry_collaborator_revisions_collaborator_idx
  on public.direct_entry_collaborator_revisions (collaborator_id, version desc);

create trigger direct_entry_collaborator_revisions_immutable
  before update or delete on public.direct_entry_collaborator_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

alter table public.direct_entry_collaborator_revisions enable row level security;
alter table public.direct_entry_collaborator_revisions force row level security;
revoke all on table public.direct_entry_collaborator_revisions
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_collaborator_revisions is
  'Append-only collaborator revision history written only inside service_role collaborator admin RPCs. Never updated or deleted.';

alter table public.direct_entry_audit_events
  add column collaborator_revision_id uuid
    references public.direct_entry_collaborator_revisions(revision_id) on delete restrict;

-- -----------------------------------------------------------------------------
-- 2. Internal helpers (revoked from all roles).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_collaborator_snapshot(
  p_collaborator public.collaborators
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'collaborator_id', p_collaborator.collaborator_id,
    'display_name', p_collaborator.display_name,
    'active', p_collaborator.active,
    'version', p_collaborator.version
  )
$$;
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
as $$
  select jsonb_build_object(
    'collaborator_id', p_collaborator.collaborator_id,
    'display_name', p_collaborator.display_name,
    'active', p_collaborator.active,
    'version', p_collaborator.version,
    'created_at', p_collaborator.created_at,
    'updated_at', p_collaborator.updated_at
  )
$$;
revoke all on function public.direct_entry_collaborator_admin_projection(public.collaborators)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_lock_collaborator(
  p_collaborator_id text,
  p_expected_version integer
)
returns public.collaborators
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_collaborator public.collaborators;
begin
  if p_collaborator_id is null or btrim(p_collaborator_id) = '' then
    raise exception 'collaborator required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected collaborator version required' using errcode = '22023';
  end if;

  select c.* into v_collaborator
    from public.collaborators c
   where c.collaborator_id = btrim(p_collaborator_id)
     and c.collaborator_id <> '__system_vendor__'
   for update;
  if not found then
    raise exception 'collaborator not found' using errcode = 'P0002';
  end if;
  if v_collaborator.version <> p_expected_version then
    raise exception 'collaborator version conflict' using errcode = '40001';
  end if;
  return v_collaborator;
end;
$$;
revoke all on function public.direct_entry_lock_collaborator(text, integer)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Administration RPCs (service_role only).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_list_collaborators_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_include_inactive boolean default false,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_search text;
  v_include_inactive boolean := coalesce(p_include_inactive, false);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_items jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid collaborator search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.collaborators c
   where c.collaborator_id <> '__system_vendor__'
     and (v_include_inactive or c.active)
     and (
       v_search is null
       or c.display_name ilike '%' || v_search || '%'
       or c.collaborator_id ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(t.projection order by t.display_name, t.collaborator_id), '[]'::jsonb)
    into v_items
    from (
      select public.direct_entry_collaborator_admin_projection(c) as projection,
             c.display_name,
             c.collaborator_id
        from public.collaborators c
       where c.collaborator_id <> '__system_vendor__'
         and (v_include_inactive or c.active)
         and (
           v_search is null
           or c.display_name ilike '%' || v_search || '%'
           or c.collaborator_id ilike '%' || v_search || '%'
         )
       order by c.display_name, c.collaborator_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) t;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size
  );
end;
$$;
revoke all on function public.direct_entry_list_collaborators_admin(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_collaborators_admin(uuid, uuid, text, boolean, integer, integer)
  to service_role;
comment on function public.direct_entry_list_collaborators_admin(uuid, uuid, text, boolean, integer, integer) is
  'Admin read: bounded, deterministically ordered collaborator catalog (search, active filter, page 1..1000, page_size 1..100, total). service_role only; catalog operator with all scope required.';

create or replace function public.direct_entry_get_collaborator_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_collaborator_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_collaborator_id is null or btrim(p_collaborator_id) = '' then
    raise exception 'collaborator required' using errcode = '22023';
  end if;

  select public.direct_entry_collaborator_admin_projection(c)
    into v_item
    from public.collaborators c
   where c.collaborator_id = btrim(p_collaborator_id)
     and c.collaborator_id <> '__system_vendor__';

  if v_item is null then
    raise exception 'collaborator not found' using errcode = 'P0002';
  end if;
  return v_item;
end;
$$;
revoke all on function public.direct_entry_get_collaborator_admin(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_collaborator_admin(uuid, uuid, text)
  to service_role;
comment on function public.direct_entry_get_collaborator_admin(uuid, uuid, text) is
  'Admin read: one collaborator detail projection. service_role only; catalog operator with all scope required.';

create or replace function public.direct_entry_create_collaborator(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_collaborator_id text,
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
  v_collaborator_id text;
  v_display text;
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
      'display_name', v_display
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if exists (select 1 from public.collaborators c where c.collaborator_id = v_collaborator_id) then
    raise exception 'collaborator already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, v_reason);

  insert into public.collaborators (collaborator_id, display_name, active, version)
  values (v_collaborator_id, v_display, true, 1)
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
    array['collaborator_id', 'display_name', 'active'], v_revision_id
  );

  v_result := public.direct_entry_collaborator_snapshot(v_collaborator);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'collaborator_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_create_collaborator(uuid, uuid, integer, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_collaborator(uuid, uuid, integer, text, text, text, text)
  to service_role;
comment on function public.direct_entry_create_collaborator(uuid, uuid, integer, text, text, text, text) is
  'Admin write: atomic collaborator create (collaborators row, v1 revision, audit event). Never creates recruiters or touches vendors. expected_version must be 0. service_role only.';

create or replace function public.direct_entry_update_collaborator(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_collaborator_id text,
  p_expected_version integer,
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
  v_display text;
  v_reason text;
  v_reason_id uuid;
  v_before public.collaborators;
  v_after public.collaborators;
  v_revision_id uuid;
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
      'display_name', v_display
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_collaborator(btrim(p_collaborator_id), p_expected_version);
  if v_before.display_name = v_display then
    raise exception 'collaborator display name is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, v_reason);

  update public.collaborators
     set display_name = v_display,
         version = version + 1
   where collaborator_id = v_before.collaborator_id
  returning * into v_after;

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
    array['display_name'], v_revision_id
  );

  v_result := public.direct_entry_collaborator_snapshot(v_after);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'collaborator_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_update_collaborator(uuid, uuid, text, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_collaborator(uuid, uuid, text, integer, text, text, text)
  to service_role;
comment on function public.direct_entry_update_collaborator(uuid, uuid, text, integer, text, text, text) is
  'Admin write: display_name only collaborator update under OCC. service_role only; catalog operator with all scope required.';

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
as $$
declare
  v_authority text;
  v_reason text;
  v_reason_id uuid;
  v_before public.collaborators;
  v_after public.collaborators;
  v_revision_id uuid;
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
    p_auth_subject, p_app_user_id, 'collaborator_set_active', v_authority,
    v_after.collaborator_id, 'all', 'APPLIED', v_reason_id,
    array['active'], v_revision_id
  );

  v_result := public.direct_entry_collaborator_snapshot(v_after);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'collaborator_set_active', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_set_collaborator_active(uuid, uuid, text, boolean, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_set_collaborator_active(uuid, uuid, text, boolean, integer, text, text)
  to service_role;
comment on function public.direct_entry_set_collaborator_active(uuid, uuid, text, boolean, integer, text, text) is
  'Admin write: soft-toggle collaborator active flag under OCC. Never touches vendors or recruiters. service_role only.';

-- -----------------------------------------------------------------------------
-- 4. Update direct_entry_input_catalog_unscoped_v42 to include active collaborators.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_input_catalog_unscoped_v42(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_effective_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_can_read_catalog boolean := false;
  v_result jsonb;
begin
  if p_effective_date is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found or not coalesce(v_authz_managed, false) then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  -- Authorization uses CURRENT actor state only; p_effective_date applies strictly to catalog lookups below.
  select exists (
    select 1
      from pg_catalog.jsonb_to_recordset(
        public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
      ) as g(capability text, scope_kind text, scope_id text)
     where (
       g.capability = 'entry_create'
       and g.scope_kind in ('OWN', 'ALL')
       and nullif(pg_catalog.btrim(coalesce(g.scope_id, '')), '') is null
     )
        or (
       g.capability = 'entry_own'
       and g.scope_kind = 'OWN'
       and nullif(pg_catalog.btrim(coalesce(g.scope_id, '')), '') is null
     )
        or (
       g.capability = 'entry_privileged_edit'
       and (
         (
           g.scope_kind in ('ALL', 'OWN')
           and nullif(pg_catalog.btrim(coalesce(g.scope_id, '')), '') is null
         )
         or (
           g.scope_kind = 'CONTEXT_TEAM'
           and nullif(pg_catalog.btrim(coalesce(g.scope_id, '')), '') is not null
           and exists (
             select 1
               from public.teams t
              where t.team_id::text = g.scope_id
                and t.active
                and t.code <> '__system_vendor__'
           )
         )
       )
     )
  )
    into v_can_read_catalog;

  if not coalesce(v_can_read_catalog, false) then
    begin
      perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
      v_can_read_catalog := true;
    exception
      when insufficient_privilege then
        v_can_read_catalog := false;
    end;
  end if;

  if not coalesce(v_can_read_catalog, false) then
    begin
      v_can_read_catalog :=
        public.direct_entry_assert_team_leader_current_team(p_auth_subject, p_app_user_id, null) is not null;
    exception
      when insufficient_privilege then
        v_can_read_catalog := false;
    end;
  end if;

  if not coalesce(v_can_read_catalog, false) then
    v_can_read_catalog := coalesce(public.direct_entry_actor_has_project_assignment(p_app_user_id), false);
  end if;

  if not coalesce(v_can_read_catalog, false) then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  with hrp_memberships as (
    select m.recruiter_id, count(*) as membership_count
      from public.recruiter_provider_memberships m
     where m.provider_type = 'hrp'
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date)
     group by m.recruiter_id
  ), vendor_memberships as (
    select m.recruiter_id, m.vendor_id
      from public.recruiter_provider_memberships m
     where m.provider_type = 'vendor'
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date)
  ), hrp_teams as (
    select m.recruiter_id, count(*) as membership_count,
           min(m.team_id::text)::uuid as team_id
      from public.recruiter_team_memberships m
     where public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, p_effective_date)
     group by m.recruiter_id
  ), hrp_recruiters as (
    select r.recruiter_id, r.display_name, r.personnel_code, tt.team_id,
           team.display_name as team_display_name
      from public.recruiters r
      join hrp_memberships p on p.recruiter_id = r.recruiter_id
                            and p.membership_count = 1
      join hrp_teams tt on tt.recruiter_id = r.recruiter_id
                        and tt.membership_count = 1
      join public.teams team on team.team_id = tt.team_id and team.active
     where r.active
  ), vendor_recruiters as (
    select r.recruiter_id, r.display_name, vm.vendor_id,
           v.display_name as vendor_display_name
      from public.recruiters r
      join vendor_memberships vm on vm.recruiter_id = r.recruiter_id
      left join public.vendors v on v.vendor_id = vm.vendor_id and v.active
     where r.active
       and (vm.vendor_id is null or v.vendor_id is not null)
  )
  select jsonb_build_object(
    'effective_date', p_effective_date,
    'labor_types', public.direct_entry_labor_type_options(),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'project_id', p.project_id, 'display_name', p.display_name
      ) order by p.display_name, p.project_id)
        from public.direct_entry_projects p
       where p.active
    ), '[]'::jsonb),
    'recruiters', coalesce((
      select coalesce(jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', r.display_name,
        'personnel_code', r.personnel_code,
        'provider_type', 'hrp',
        'vendor_id', null,
        'team_id', r.team_id,
        'team_display_name', r.team_display_name,
        'label', (
          r.display_name
          || ' · ' || coalesce(r.personnel_code, '—')
          || ' · ' || r.team_display_name
        )
      ) order by r.display_name, r.team_display_name, r.recruiter_id), '[]'::jsonb)
        from hrp_recruiters r
    ) || coalesce((
      select jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', coalesce(r.vendor_display_name, r.display_name),
        'personnel_code', null,
        'provider_type', 'vendor',
        'vendor_id', r.vendor_id,
        'team_id', null,
        'team_display_name', null,
        'label', coalesce(r.vendor_display_name, r.display_name)
      ) order by coalesce(r.vendor_display_name, r.display_name), r.recruiter_id)
        from vendor_recruiters r
    ), '[]'::jsonb), '[]'::jsonb),
    'banks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bank_id', b.bank_id, 'display_name', b.display_name
      ) order by b.display_name, b.bank_id)
        from public.direct_entry_banks b
       where b.active
    ), '[]'::jsonb),
    'collaborators', coalesce((
      select jsonb_agg(jsonb_build_object(
        'collaborator_id', c.collaborator_id,
        'display_name', c.display_name,
        'active', true
      ) order by c.display_name, c.collaborator_id)
        from public.collaborators c
       where c.active = true
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_input_catalog_unscoped_v42(uuid, uuid, date)
  from public, anon, authenticated, service_role;

commit;
