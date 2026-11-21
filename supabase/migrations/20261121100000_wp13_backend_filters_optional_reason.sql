-- WP13 PR-0 Backend:
-- 1. GAP-BE-03: Server-side account_type + link_state filtering before pagination
--    via new 8-arg RPC direct_entry_list_app_users_filtered_admin; keep 6-arg
--    direct_entry_list_app_users_admin with identical signature/defaults as thin wrapper.
-- 2. GAP-BE-06: Server-side team_id filtering on personnel catalog before pagination
--    via new 7-arg RPC direct_entry_list_personnel_filtered_admin; keep 6-arg
--    direct_entry_list_personnel_admin with identical signature/defaults as thin wrapper.
-- 3. GAP-BE-04 (Part 1): Restore R1.1 optional p_reason contract on exactly 3 RPCs
--    (direct_entry_create_team, direct_entry_update_personnel,
--     direct_entry_account_operation_update_display_name) while preserving WP3B locks,
--    idempotency, OCC, Person/Account/Recruiter sync, and mandatory-reason RPCs elsewhere.
begin;

-- =============================================================================
-- 1. GAP-BE-03: Accounts list filtered before pagination (8 args, no defaults)
-- =============================================================================
create or replace function public.direct_entry_list_app_users_filtered_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text,
  p_enabled text,
  p_page integer,
  p_page_size integer,
  p_account_type text,
  p_link_state text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_search text;
  v_total integer;
  v_accounts jsonb;
  v_offset integer;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if (p_search is not null and (btrim(p_search) = '' or length(p_search) > 256))
     or p_enabled is null or p_enabled not in ('all', 'true', 'false')
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100
     or p_account_type is null or p_account_type not in ('all', 'NORMAL', 'SHARED', 'SERVICE', 'SPECIAL')
     or p_link_state is null or p_link_state not in ('all', 'linked', 'unlinked') then
    raise exception 'account list query is invalid' using errcode = '22023';
  end if;

  v_search := nullif(btrim(p_search), '');
  v_offset := (p_page - 1) * p_page_size;

  select count(*)::integer
    into v_total
    from public.direct_entry_app_users u
    join auth.users au on au.id = u.auth_subject
    left join lateral (
      select op.person_id,
             op.full_name
        from public.organization_account_person_links pl
        join public.organization_persons op on op.person_id = pl.person_id
       where pl.app_user_id = u.app_user_id
         and pl.ended_at is null
       order by pl.started_at desc, pl.link_id desc
       limit 1
    ) active_person on true
    left join lateral (
      select r.display_name
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified
         and l.is_current
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where (v_search is null
       or coalesce(active_person.full_name, linked.display_name, u.display_name) ilike '%' || v_search || '%'
       or pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1) ilike '%' || v_search || '%')
     and (p_enabled = 'all'
       or (p_enabled = 'true' and u.enabled)
       or (p_enabled = 'false' and not u.enabled))
     and (p_account_type = 'all'
       or (p_account_type = 'SPECIAL' and u.account_type in ('SHARED', 'SERVICE'))
       or (p_account_type in ('NORMAL', 'SHARED', 'SERVICE') and u.account_type = p_account_type))
     and (p_link_state = 'all'
       or (p_link_state = 'linked' and active_person.person_id is not null)
       or (p_link_state = 'unlinked' and active_person.person_id is null));

  select coalesce(
           jsonb_agg(
             public.direct_entry_app_user_projection(account_row.app_user)
             order by account_row.resolved_name, account_row.resolved_login, account_row.app_user_id
           ),
           '[]'::jsonb
         )
    into v_accounts
    from (
      select u as app_user,
             u.app_user_id,
             coalesce(active_person.full_name, linked.display_name, u.display_name) as resolved_name,
             pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1) as resolved_login
        from public.direct_entry_app_users u
        join auth.users au on au.id = u.auth_subject
        left join lateral (
          select op.person_id,
                 op.full_name
            from public.organization_account_person_links pl
            join public.organization_persons op on op.person_id = pl.person_id
           where pl.app_user_id = u.app_user_id
             and pl.ended_at is null
           order by pl.started_at desc, pl.link_id desc
           limit 1
        ) active_person on true
        left join lateral (
          select r.display_name
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = u.app_user_id
             and l.verified
             and l.is_current
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) linked on true
       where (v_search is null
           or coalesce(active_person.full_name, linked.display_name, u.display_name) ilike '%' || v_search || '%'
           or pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1) ilike '%' || v_search || '%')
         and (p_enabled = 'all'
           or (p_enabled = 'true' and u.enabled)
           or (p_enabled = 'false' and not u.enabled))
         and (p_account_type = 'all'
           or (p_account_type = 'SPECIAL' and u.account_type in ('SHARED', 'SERVICE'))
           or (p_account_type in ('NORMAL', 'SHARED', 'SERVICE') and u.account_type = p_account_type))
         and (p_link_state = 'all'
           or (p_link_state = 'linked' and active_person.person_id is not null)
           or (p_link_state = 'unlinked' and active_person.person_id is null))
       order by coalesce(active_person.full_name, linked.display_name, u.display_name),
                pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1),
                u.app_user_id
       limit p_page_size offset v_offset
    ) account_row;

  return jsonb_build_object(
    'search', v_search,
    'enabled', p_enabled,
    'page', p_page,
    'page_size', p_page_size,
    'total', v_total,
    'accounts', v_accounts
  );
end;
$function$;

create or replace function public.direct_entry_list_app_users_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null::text,
  p_enabled text default 'all'::text,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  return public.direct_entry_list_app_users_filtered_admin(
    p_auth_subject,
    p_app_user_id,
    p_search,
    p_enabled,
    p_page,
    p_page_size,
    'all',
    'all'
  );
end;
$function$;

-- =============================================================================
-- 2. GAP-BE-06: Personnel list filtered by team before pagination (7 args, no defaults)
-- =============================================================================
create or replace function public.direct_entry_list_personnel_filtered_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text,
  p_include_inactive boolean,
  p_page integer,
  p_page_size integer,
  p_team_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_search text;
  v_include_inactive boolean := coalesce(p_include_inactive, true);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_personnel jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid personnel search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  if p_team_id is not null then
    if not exists (
      select 1
        from public.teams t
       where t.team_id = p_team_id
         and t.code <> '__system_vendor__'
    ) then
      raise exception 'team not found' using errcode = 'P0002';
    end if;
  end if;

  -- HRP boundary + optional current team filter applied before COUNT and LIMIT/OFFSET.
  select count(*)::int
    into v_total
    from public.recruiters r
   where (v_include_inactive or r.active)
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.vendor_id is null
          and m.is_current
     )
     and (
       p_team_id is null
       or exists (
         select 1
           from public.recruiter_team_memberships tm
          where tm.recruiter_id = r.recruiter_id
            and tm.team_id = p_team_id
            and tm.is_current
       )
     )
     and (
       v_search is null
       or r.display_name ilike '%' || v_search || '%'
       or coalesce(r.personnel_code, '') ilike '%' || v_search || '%'
     );

  select coalesce(
           jsonb_agg(t.personnel order by t.display_name, t.recruiter_id),
           '[]'::jsonb
         )
    into v_personnel
    from (
      select public.direct_entry_personnel_admin_projection(
               r, hrp.valid_from, rev.revision_count
             ) as personnel,
             r.display_name,
             r.recruiter_id
        from public.recruiters r
        left join lateral (
          select m.valid_from
            from public.recruiter_provider_memberships m
           where m.recruiter_id = r.recruiter_id
             and m.provider_type = 'hrp'
             and m.vendor_id is null
             and m.is_current
           order by m.valid_from desc
           limit 1
        ) hrp on true
        left join lateral (
          select count(*)::int as revision_count
            from public.direct_entry_personnel_revisions v
           where v.recruiter_id = r.recruiter_id
        ) rev on true
       where (v_include_inactive or r.active)
         and exists (
           select 1
             from public.recruiter_provider_memberships m
            where m.recruiter_id = r.recruiter_id
              and m.provider_type = 'hrp'
              and m.vendor_id is null
              and m.is_current
         )
         and (
           p_team_id is null
           or exists (
             select 1
               from public.recruiter_team_memberships tm
              where tm.recruiter_id = r.recruiter_id
                and tm.team_id = p_team_id
                and tm.is_current
           )
         )
         and (
           v_search is null
           or r.display_name ilike '%' || v_search || '%'
           or coalesce(r.personnel_code, '') ilike '%' || v_search || '%'
         )
       order by r.display_name, r.recruiter_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) t;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', v_include_inactive,
    'search', v_search,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'personnel', v_personnel
  );
end;
$function$;

create or replace function public.direct_entry_list_personnel_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null::text,
  p_include_inactive boolean default true,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  return public.direct_entry_list_personnel_filtered_admin(
    p_auth_subject,
    p_app_user_id,
    p_search,
    p_include_inactive,
    p_page,
    p_page_size,
    null::uuid
  );
end;
$function$;

-- =============================================================================
-- 3. GAP-BE-04 (Part 1): Restore optional p_reason on exact 3 RPCs
-- =============================================================================

-- 3.1 direct_entry_create_team
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
as $function$
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
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(pg_catalog.regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
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
$function$;

-- 3.2 direct_entry_account_operation_update_display_name
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
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(pg_catalog.regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
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
      coalesce(
        nullif(
          pg_catalog.btrim(
            pg_catalog.regexp_replace(
              pg_catalog.left(coalesce(p_reason, ''), 500),
              '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]',
              ' ',
              'g'
            )
          ),
          ''
        ),
        'Synced from account display_name_update'
      ),
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

-- 3.3 direct_entry_update_personnel
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
as $function$
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
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(pg_catalog.regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
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
      coalesce(
        nullif(
          pg_catalog.btrim(
            pg_catalog.regexp_replace(
              pg_catalog.left(coalesce(p_reason, ''), 500),
              '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]',
              ' ',
              'g'
            )
          ),
          ''
        ),
        'Synced from personnel_update'
      ),
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
$function$;

-- =============================================================================
-- 4. Explicit EXECUTE ACL (service_role only; 0 PUBLIC / anon / authenticated)
-- =============================================================================
revoke all on function public.direct_entry_list_app_users_filtered_admin(uuid, uuid, text, text, integer, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_app_users_filtered_admin(uuid, uuid, text, text, integer, integer, text, text)
  to service_role;

revoke all on function public.direct_entry_list_app_users_admin(uuid, uuid, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_app_users_admin(uuid, uuid, text, text, integer, integer)
  to service_role;

revoke all on function public.direct_entry_list_personnel_filtered_admin(uuid, uuid, text, boolean, integer, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_personnel_filtered_admin(uuid, uuid, text, boolean, integer, integer, uuid)
  to service_role;

revoke all on function public.direct_entry_list_personnel_admin(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_personnel_admin(uuid, uuid, text, boolean, integer, integer)
  to service_role;

revoke all on function public.direct_entry_create_team(uuid, uuid, integer, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_team(uuid, uuid, integer, text, text, text, text)
  to service_role;

revoke all on function public.direct_entry_update_personnel(uuid, uuid, uuid, integer, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_personnel(uuid, uuid, uuid, integer, text, text, text, text, text)
  to service_role;

revoke all on function public.direct_entry_account_operation_update_display_name(uuid, uuid, uuid, text, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_update_display_name(uuid, uuid, uuid, text, integer, text, text)
  to service_role;

-- =============================================================================
-- 5. Owner alignment + install-time security and signature postcondition guard
-- =============================================================================
do $align_wp13_pr0$
declare
  v_owner_oid oid;
  v_owner name;
  v_sig text;
  v_proc_owner_oid oid;
begin
  select c.relowner, pg_catalog.pg_get_userbyid(c.relowner)
    into v_owner_oid, v_owner
    from pg_catalog.pg_class c
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner_oid is null then
    raise exception 'WP13_PR0_MISSING_BASE_TABLE' using errcode = '55000';
  end if;

  foreach v_sig in array array[
    'public.direct_entry_list_app_users_filtered_admin(uuid, uuid, text, text, integer, integer, text, text)',
    'public.direct_entry_list_app_users_admin(uuid, uuid, text, text, integer, integer)',
    'public.direct_entry_list_personnel_filtered_admin(uuid, uuid, text, boolean, integer, integer, uuid)',
    'public.direct_entry_list_personnel_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.direct_entry_create_team(uuid, uuid, integer, text, text, text, text)',
    'public.direct_entry_update_personnel(uuid, uuid, uuid, integer, text, text, text, text, text)',
    'public.direct_entry_account_operation_update_display_name(uuid, uuid, uuid, text, integer, text, text)'
  ]
  loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_sig);

    if v_proc_owner_oid is distinct from v_owner_oid
       and pg_catalog.pg_has_role(current_user, v_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_owner);
    end if;
  end loop;
end
$align_wp13_pr0$;

do $check_wp13_pr0$
declare
  v_owner_oid oid;
  v_name text;
  v_overload_cnt integer;
  v_sig text;
  v_oid oid;
  v_proc record;
begin
  select c.relowner
    into v_owner_oid
    from pg_catalog.pg_class c
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner_oid is null then
    raise exception 'WP13_PR0_MISSING_BASE_TABLE' using errcode = '55000';
  end if;

  foreach v_name in array array[
    'direct_entry_list_app_users_filtered_admin',
    'direct_entry_list_app_users_admin',
    'direct_entry_list_personnel_filtered_admin',
    'direct_entry_list_personnel_admin',
    'direct_entry_create_team',
    'direct_entry_update_personnel',
    'direct_entry_account_operation_update_display_name'
  ]
  loop
    select count(*)::integer
      into v_overload_cnt
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_name;

    if v_overload_cnt <> 1 then
      raise exception 'WP13_PR0_OVERLOAD_COUNT_FAILED: % (count=%)', v_name, v_overload_cnt
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array array[
    'public.direct_entry_list_app_users_filtered_admin(uuid, uuid, text, text, integer, integer, text, text)',
    'public.direct_entry_list_app_users_admin(uuid, uuid, text, text, integer, integer)',
    'public.direct_entry_list_personnel_filtered_admin(uuid, uuid, text, boolean, integer, integer, uuid)',
    'public.direct_entry_list_personnel_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.direct_entry_create_team(uuid, uuid, integer, text, text, text, text)',
    'public.direct_entry_update_personnel(uuid, uuid, uuid, integer, text, text, text, text, text)',
    'public.direct_entry_account_operation_update_display_name(uuid, uuid, uuid, text, integer, text, text)'
  ]
  loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP13_PR0_MISSING_SIGNATURE: %', v_sig using errcode = '55000';
    end if;

    select p.proowner,
           p.prosecdef,
           p.proconfig,
           p.proacl,
           (r.rolsuper or r.rolbypassrls) as owner_bypasses_rls,
           pg_catalog.pg_has_role(p.proowner, v_owner_oid, 'USAGE') as owner_has_table_owner_privs,
           pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE') as owner_exec
      into v_proc
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not found
       or not coalesce(v_proc.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proc.proconfig, array[]::text[])))
       or not coalesce(v_proc.owner_bypasses_rls, false)
       or not coalesce(v_proc.owner_has_table_owner_privs, false)
       or not coalesce(v_proc.owner_exec, false) then
      raise exception 'WP13_PR0_SECDEF_CHECK_FAILED: %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(v_proc.proacl, pg_catalog.acldefault('f', v_proc.proowner))) a
          where a.grantee = 0
            and a.privilege_type = 'EXECUTE'
       ) then
      raise exception 'WP13_PR0_ACL_CHECK_FAILED: %', v_sig using errcode = '55000';
    end if;
  end loop;
end
$check_wp13_pr0$;

commit;
