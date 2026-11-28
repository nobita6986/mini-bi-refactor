begin;

-- One unique namespace arbitrates both canonical and imported historical URLs at commit.
-- A side table avoids updating any versioned recruitment brief during backfill.
create table public.recruitment_project_brief_slug_aliases (
  alias_slug text primary key check (length(alias_slug) between 1 and 120 and alias_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  brief_id uuid not null references public.recruitment_project_briefs(brief_id) on delete cascade,
  is_canonical boolean not null default false,
  created_at timestamptz not null default now(),
  check (not is_canonical or right(alias_slug,37) = '-' || brief_id::text),
  check (alias_slug !~ '^(bi-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
);
create unique index recruitment_project_brief_canonical_uq
  on public.recruitment_project_brief_slug_aliases(brief_id) where is_canonical;
alter table public.recruitment_project_brief_slug_aliases enable row level security;
alter table public.recruitment_project_brief_slug_aliases force row level security;
revoke all on public.recruitment_project_brief_slug_aliases from public, anon, authenticated, service_role;

create function public.recruitment_post_build_public_slug(customer text, park text, id uuid)
returns text language sql immutable set search_path = pg_catalog as $$
  with parts as (
    select ord, nullif(trim(both '-' from regexp_replace(lower(translate(normalize(t,NFD), 'đĐ' ||
       (select string_agg(chr(n),'') from generate_series(768,879) n), 'dD')), '[^a-z0-9]+','-','g')), '') val
    from unnest(array[customer,park]) with ordinality as u(t,ord)
  )
  select rtrim(left(string_agg(coalesce(val,case ord when 1 then 'doanh-nghiep-doi-tac' else 'khu-cong-nghiep' end),'-' order by ord),83),'-') || '-' || id::text from parts
$$;

-- Only an operator imports verified legacy aliases. Replays succeed for their original owner.
create function public.recruitment_post_register_slug(p_slug text, p_brief uuid, p_canonical boolean default false)
returns void language plpgsql set search_path = pg_catalog, public as $$
declare existing public.recruitment_project_brief_slug_aliases;
begin
  insert into public.recruitment_project_brief_slug_aliases(alias_slug,brief_id,is_canonical)
    values (lower(btrim(p_slug)), p_brief, p_canonical) on conflict (alias_slug) do nothing;
  if found then return; end if;
  select * into strict existing from public.recruitment_project_brief_slug_aliases where alias_slug=lower(btrim(p_slug));
  if existing.brief_id <> p_brief or (p_canonical and not existing.is_canonical) then
    raise exception using errcode='23505', message=case when existing.is_canonical or p_canonical then 'SLUG_ALIAS_CONFLICTS_WITH_CANONICAL' else 'SLUG_ALIAS_ALREADY_ASSIGNED' end;
  end if;
end $$;
create function public.recruitment_post_register_canonical() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.recruitment_post_register_slug(public.recruitment_post_build_public_slug(new.customer_name,
    (select display_name from public.industrial_parks where industrial_park_id=new.industrial_park_id),new.brief_id),new.brief_id,true);
  return new;
end $$;
create trigger recruitment_post_register_canonical after insert on public.recruitment_project_briefs
  for each row execute function public.recruitment_post_register_canonical();
insert into public.recruitment_project_brief_slug_aliases(alias_slug,brief_id,is_canonical)
  select public.recruitment_post_build_public_slug(b.customer_name,ip.display_name,b.brief_id),b.brief_id,true
  from public.recruitment_project_briefs b join public.industrial_parks ip using(industrial_park_id);

-- Explicit jobs.v1 allowlist, plus the canonical URL. Only invoked for the requested page/detail.
create function public.recruitment_post_portal_item(p_brief_id uuid) returns jsonb language sql stable set search_path=pg_catalog,public as $$
  select pg_catalog.jsonb_build_object(
          'id', b.brief_id,
          'brief_id', b.brief_id,
          'version', b.version,
          'published_at', pg_catalog.to_char(b.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updated_at', pg_catalog.to_char(b.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'location', pg_catalog.jsonb_build_object(
            'province_code', prov.province_code,
            'province_name', prov.display_name,
            'industrial_park_code', ip.industrial_park_code,
            'industrial_park_name', ip.display_name
          ),
          'general', pg_catalog.jsonb_build_object(
            'customer_name', b.customer_name,
            'investment_origin', b.investment_origin,
            'manufacturing_industry', b.manufacturing_industry,
            'job_description', b.job_description,
            'environment_types', pg_catalog.to_jsonb(b.environment_types),
            'work_postures', pg_catalog.to_jsonb(b.work_postures),
            'shift_pattern', b.shift_pattern,
            'shift_details', b.shift_details,
            'labor_types', coalesce(lt_agg.labor_types, '[]'::jsonb),
            'supply_schedule_text', b.supply_schedule_text,
            'expected_headcount', b.expected_headcount
          ),
          'candidate', pg_catalog.jsonb_build_object(
            'age_min', b.age_min,
            'age_max', b.age_max,
            'gender_requirement', b.gender_requirement,
            'gender_label', case b.gender_requirement
              when 'ANY' then 'Nam/Nữ'
              when 'MALE' then 'Nam'
              when 'FEMALE' then 'Nữ'
            end,
            'education_requirement', b.education_requirement,
            'experience_required', b.experience_required,
            'experience_details', b.experience_details,
            'accept_former_customer_workers', b.accept_former_customer_workers,
            'entry_assessment_text', b.entry_assessment_text,
            'other_requirements_text', b.other_requirements_text
          ),
          'compensation', pg_catalog.jsonb_build_object(
            'base_salary_vnd', b.base_salary_vnd::text,
            'base_salary_conditions', b.base_salary_conditions,
            'attendance_bonus_vnd', b.attendance_bonus_vnd::text,
            'attendance_bonus_conditions', b.attendance_bonus_conditions,
            'living_allowance_vnd', b.living_allowance_vnd::text,
            'living_allowance_conditions', b.living_allowance_conditions,
            'seniority_allowance_vnd', b.seniority_allowance_vnd::text,
            'seniority_allowance_conditions', b.seniority_allowance_conditions,
            'eyesight_allowance_vnd', b.eyesight_allowance_vnd::text,
            'eyesight_allowance_conditions', b.eyesight_allowance_conditions,
            'other_allowance_text', b.other_allowance_text,
            'average_income_min_vnd', b.average_income_min_vnd::text,
            'average_income_max_vnd', b.average_income_max_vnd::text,
            'salary_payment_schedule', b.salary_payment_schedule,
            'salary_advance_available', b.salary_advance_available,
            'salary_advance_amount_vnd', b.salary_advance_amount_vnd::text,
            'salary_advance_schedule', b.salary_advance_schedule,
            'weekly_salary_available', b.weekly_salary_available,
            'weekly_salary_payment_schedule', b.weekly_salary_payment_schedule,
            'day_shift_8h_vnd', b.day_shift_8h_vnd::text,
            'day_shift_11h_vnd', b.day_shift_11h_vnd::text,
            'night_shift_8h_vnd', b.night_shift_8h_vnd::text,
            'night_shift_11h_vnd', b.night_shift_11h_vnd::text,
            'sunday_day_11h_vnd', b.sunday_day_11h_vnd::text,
            'sunday_night_11h_vnd', b.sunday_night_11h_vnd::text,
            'holiday_day_11h_vnd', b.holiday_day_11h_vnd::text,
            'holiday_night_11h_vnd', b.holiday_night_11h_vnd::text,
            'ppe_provided', b.ppe_provided,
            'ppe_details', b.ppe_details,
            'other_benefits', b.other_benefits
          ),
          'documents', pg_catalog.jsonb_build_object(
            'require_original_cccd_and_copy', b.require_original_cccd_and_copy,
            'require_certified_resume', b.require_certified_resume,
            'require_health_certificate_within_6_months', b.require_health_certificate_within_6_months,
            'require_photo_3x4', b.require_photo_3x4,
            'require_degree_or_certificate', b.require_degree_or_certificate,
            'require_social_insurance_book', b.require_social_insurance_book,
            'require_other_documents', b.require_other_documents,
            'other_documents_text', b.other_documents_text
          )
        ) || jsonb_build_object('public_slug', s.alias_slug)
  from public.recruitment_project_briefs b
  join public.industrial_parks ip
    on ip.industrial_park_id = b.industrial_park_id
  join public.administrative_provinces prov
    on prov.province_id = ip.province_id
  left join lateral (
    select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'labor_type_key', lt.labor_type_key,
               'display_name', lt.display_name
             )
             order by lt.sort_order asc, lt.labor_type_key asc
           ) as labor_types
      from public.recruitment_project_brief_labor_types blt
      join public.direct_entry_labor_types lt
        on lt.labor_type_key = blt.labor_type_key
     where blt.brief_id = b.brief_id
  ) lt_agg on true
  join public.recruitment_project_brief_slug_aliases s on s.brief_id=b.brief_id and s.is_canonical
  where b.status='PUBLISHED' and b.brief_id=p_brief_id
$$;

create function public.recruitment_post_public_portal_list_v1(p_filters jsonb)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  with settings as (
    select (p_filters->>'page')::integer as page, (p_filters->>'page_size')::integer as size
  ), published as materialized (
    select b.brief_id,b.updated_at,b.published_at,b.customer_name,b.job_description,b.shift_pattern,b.gender_requirement,b.salary_advance_available,
      ip.industrial_park_code,ip.display_name as park,pr.province_code,pr.display_name as province
    from public.recruitment_project_briefs b join public.industrial_parks ip using(industrial_park_id)
    join public.administrative_provinces pr on pr.province_id=ip.province_id where b.status='PUBLISHED'
  ), filtered as materialized (
    select * from published p
    where (p_filters->>'q' is null or exists(select 1 from unnest(array[p.customer_name,p.job_description,p.park,p.province]) t where strpos(lower(t),lower(p_filters->>'q'))>0))
      and (p_filters->>'province_code' is null or p.province_code=p_filters->>'province_code')
      and (p_filters->>'industrial_park_code' is null or p.industrial_park_code=p_filters->>'industrial_park_code')
      and (p_filters->>'labor_type_key' is null or exists(select 1 from public.recruitment_project_brief_labor_types lt where lt.brief_id=p.brief_id and lt.labor_type_key=p_filters->>'labor_type_key'))
      and (p_filters->>'shift_pattern' is null or p.shift_pattern=p_filters->>'shift_pattern')
      and (p_filters->>'gender_requirement' is null or p.gender_requirement=p_filters->>'gender_requirement')
      and (p_filters->>'salary_advance_available' is null or p.salary_advance_available)
  ), page_items as (
    select brief_id,case when p_filters->>'sort'='published_desc' then published_at else updated_at end as stamp from filtered
    order by stamp desc,brief_id desc limit (select least(greatest(size,1),50) from settings) offset (select (page::bigint-1)*size from settings)
  ), counts as (select count(*) as total from filtered),
  provinces as (select province_code,province as display_name,count(*) as job_count from published group by 1,2),
  parks as (select industrial_park_code,park as display_name,province_code,count(*) as job_count from published group by 1,2,3),
  labor as (select l.labor_type_key,l.display_name,count(*) as job_count from published p join public.recruitment_project_brief_labor_types x using(brief_id) join public.direct_entry_labor_types l using(labor_type_key) group by 1,2)
  select jsonb_build_object('items',coalesce((select jsonb_agg(public.recruitment_post_portal_item(brief_id) order by stamp desc,brief_id desc) from page_items),'[]'),
    'pagination',jsonb_build_object('page',page,'page_size',size,'total_count',total,'total_pages',(total+size-1)/size),
    'facets',jsonb_build_object('total_published_count',(select count(*) from published),
      'provinces',coalesce((select jsonb_agg(to_jsonb(provinces)) from provinces),'[]'),
      'industrial_parks',coalesce((select jsonb_agg(to_jsonb(parks)) from parks),'[]'),
      'labor_types',coalesce((select jsonb_agg(to_jsonb(labor)) from labor),'[]'))) from settings,counts
$$;

create function public.recruitment_post_public_portal_get_v1(p_slug_or_code text)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  with input as (select lower(trim(p_slug_or_code)) k), target as (
    select b.brief_id,b.industrial_park_id,s.alias_slug as canonical from input i
    join public.recruitment_project_briefs b on b.brief_id=coalesce(
      (select brief_id from public.recruitment_project_brief_slug_aliases where alias_slug=i.k),
      case when i.k ~ '^(bi-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then regexp_replace(i.k,'^bi-','')::uuid end)
    join public.recruitment_project_brief_slug_aliases s on s.brief_id=b.brief_id and s.is_canonical
    where b.status='PUBLISHED'
  ) select jsonb_build_object('match_status',case when t.canonical=(select k from input) then 'FOUND_CANONICAL' else 'FOUND_ALIAS' end,
    'canonical_slug',t.canonical,'item',public.recruitment_post_portal_item(t.brief_id),
    'related_items',coalesce((select jsonb_agg(public.recruitment_post_portal_item(r.brief_id) order by r.updated_at desc,r.brief_id desc)
      from (select brief_id,updated_at from public.recruitment_project_briefs b where b.status='PUBLISHED'
        and b.brief_id<>t.brief_id and b.industrial_park_id=t.industrial_park_id order by updated_at desc,brief_id desc limit 3) r),'[]'))
    from target t
$$;

do $owner_align$
declare fn regprocedure; target_owner name;
begin
  select pg_get_userbyid(relowner) into strict target_owner from pg_class where oid='public.direct_entries'::regclass;
  foreach fn in array array['public.recruitment_post_build_public_slug(text,text,uuid)'::regprocedure,
    'public.recruitment_post_register_slug(text,uuid,boolean)'::regprocedure,'public.recruitment_post_register_canonical()'::regprocedure,
    'public.recruitment_post_portal_item(uuid)'::regprocedure,'public.recruitment_post_public_portal_list_v1(jsonb)'::regprocedure,
    'public.recruitment_post_public_portal_get_v1(text)'::regprocedure] loop
    execute format('alter function %s owner to %I', fn, target_owner);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn);
  end loop;
  execute format('alter table public.recruitment_project_brief_slug_aliases owner to %I',target_owner);
end $owner_align$;
grant execute on function public.recruitment_post_public_portal_list_v1(jsonb),public.recruitment_post_public_portal_get_v1(text) to service_role;
commit;
