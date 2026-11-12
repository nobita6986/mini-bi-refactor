-- =============================================================================
-- Recruitment Posts - Faceted Feed Read RPC (`public.recruitment_post_list_with_facets`)
-- =============================================================================
-- Scope:
--   1. Add read-only SECURITY DEFINER RPC `public.recruitment_post_list_with_facets`
--      for `GET /api/recruitment-posts?include_facets=true`.
--   2. Delegate actor verification, filter validation, and snapshot/keyset
--      pagination to `public.recruitment_post_list` so existing Web clients and
--      mobile clients share identical pagination and access semantics in a
--      single RPC round-trip.
--   3. Compute global `PUBLISHED` facets (`total_count`, `industrial_parks`,
--      `labor_types`) independent of active filter, cursor, and page_size:
--        - `total_count`: integer count of all `PUBLISHED` posts.
--        - `industrial_parks`: `{ industrial_park_id, industrial_park_code, display_name, active: true, job_count }`
--          for every industrial park with at least 1 `PUBLISHED` post (including
--          parks later deactivated in catalog that still hold `PUBLISHED` posts),
--          sorted by Vietnamese display_name ascending then `industrial_park_code` ascending.
--        - `labor_types`: `{ labor_type_key, display_name, job_count }` for every
--          labor type present on at least 1 `PUBLISHED` post (a post with multiple
--          labor types counts once per labor type and once in `total_count`).
--   4. Align RPC owner to `public.direct_entries` owner, revoke all privileges
--      from `public, anon, authenticated, service_role`, grant `EXECUTE` only
--      to `service_role`, and verify invariants fail-closed.
-- =============================================================================

begin;

create or replace function public.recruitment_post_list_with_facets(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text default null,
  p_province_id uuid default null,
  p_industrial_park_id uuid default null,
  p_labor_type_key text default null,
  p_updated_from date default null,
  p_updated_to date default null,
  p_cursor text default null,
  p_snapshot_token text default null,
  p_page_size integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_base jsonb;
  v_total_count integer := 0;
  v_industrial_parks jsonb := '[]'::jsonb;
  v_labor_types jsonb := '[]'::jsonb;
begin
  v_base := public.recruitment_post_list(
    p_auth_subject,
    p_app_user_id,
    p_project_id,
    p_province_id,
    p_industrial_park_id,
    p_labor_type_key,
    p_updated_from,
    p_updated_to,
    p_cursor,
    p_snapshot_token,
    p_page_size
  );

  select count(*)::integer
    into v_total_count
    from public.recruitment_project_briefs b
   where b.status = 'PUBLISHED';

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'industrial_park_id', ip_facets.industrial_park_id,
               'industrial_park_code', ip_facets.industrial_park_code,
               'display_name', ip_facets.display_name,
               'active', true,
               'job_count', ip_facets.job_count
             )
             order by
               ip_facets.industrial_park_code asc,
               ip_facets.industrial_park_id asc
           ),
           '[]'::jsonb
         )
    into v_industrial_parks
    from (
      select ip.industrial_park_id,
             ip.industrial_park_code,
             ip.display_name,
             count(*)::integer as job_count
        from public.recruitment_project_briefs b
        join public.industrial_parks ip
          on ip.industrial_park_id = b.industrial_park_id
       where b.status = 'PUBLISHED'
       group by ip.industrial_park_id, ip.industrial_park_code, ip.display_name
    ) ip_facets;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'labor_type_key', lt_facets.labor_type_key,
               'display_name', lt_facets.display_name,
               'job_count', lt_facets.job_count
             )
             order by lt_facets.sort_order asc, lt_facets.labor_type_key asc
           ),
           '[]'::jsonb
         )
    into v_labor_types
    from (
      select lt.labor_type_key,
             lt.display_name,
             lt.sort_order,
             count(*)::integer as job_count
        from public.recruitment_project_briefs b
        join public.recruitment_project_brief_labor_types blt
          on blt.brief_id = b.brief_id
        join public.direct_entry_labor_types lt
          on lt.labor_type_key = blt.labor_type_key
       where b.status = 'PUBLISHED'
       group by lt.labor_type_key, lt.display_name, lt.sort_order
    ) lt_facets;

  return v_base || pg_catalog.jsonb_build_object(
    'total_count', coalesce(v_total_count, 0),
    'industrial_parks', v_industrial_parks,
    'labor_types', v_labor_types
  );
end;
$function$;

do $owner_align$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(c.relowner)
    into v_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'direct_entries';

  if v_owner is null then
    raise exception 'public.direct_entries owner not found'
      using errcode = '55000';
  end if;

  if v_owner <> current_user
     and pg_catalog.pg_has_role(current_user, v_owner, 'SET') then
    execute pg_catalog.format(
      'alter function public.recruitment_post_list_with_facets(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer) owner to %I',
      v_owner
    );
  end if;
end;
$owner_align$;

revoke all on function
  public.recruitment_post_list_with_facets(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.recruitment_post_list_with_facets(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)
to service_role;

do $self_check$
declare
  v_sig constant text :=
    'public.recruitment_post_list_with_facets(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)';
  v_oid oid;
  v_secdef boolean;
  v_config text[];
  v_owner oid;
  v_owner_super boolean;
  v_owner_bypassrls boolean;
begin
  v_oid := pg_catalog.to_regprocedure(v_sig);
  if v_oid is null then
    raise exception 'Recruitment post facets RPC missing: %', v_sig
      using errcode = '55000';
  end if;

  select p.prosecdef, p.proconfig, p.proowner, r.rolsuper, r.rolbypassrls
    into v_secdef, v_config, v_owner, v_owner_super, v_owner_bypassrls
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = v_oid;

  if not coalesce(v_secdef, false) then
    raise exception 'Recruitment post facets RPC is not SECURITY DEFINER: %', v_sig
      using errcode = '55000';
  end if;

  if not coalesce('search_path=pg_catalog, public' = any(v_config), false) then
    raise exception 'Recruitment post facets RPC missing locked search_path: %', v_sig
      using errcode = '55000';
  end if;

  if not (coalesce(v_owner_super, false) or coalesce(v_owner_bypassrls, false)) then
    raise exception 'Recruitment post facets RPC owner lacks BYPASSRLS/superuser: %', v_sig
      using errcode = '55000';
  end if;

  if not pg_catalog.has_function_privilege(v_owner, v_oid, 'EXECUTE') then
    raise exception 'Recruitment post facets RPC owner missing EXECUTE: %', v_sig
      using errcode = '55000';
  end if;

  if pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
     or exists (
       select 1
         from pg_catalog.aclexplode(coalesce(
                (select proacl from pg_catalog.pg_proc where oid = v_oid),
                pg_catalog.acldefault('f', v_owner)
              )) a
        where a.grantee = 0
          and a.privilege_type = 'EXECUTE'
     ) then
    raise exception 'Recruitment post facets RPC exposed to anon/authenticated/PUBLIC: %', v_sig
      using errcode = '55000';
  end if;

  if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception 'Recruitment post facets RPC not granted to service_role: %', v_sig
      using errcode = '55000';
  end if;
end;
$self_check$;

commit;
