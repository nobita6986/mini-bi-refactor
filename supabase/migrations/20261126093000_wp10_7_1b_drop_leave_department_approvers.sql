-- =============================================================================
-- WP10-7 Slice 1B: Drop legacy public.leave_department_approvers table
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. Fail-closed pre-drop gate verifying:
--      (a) 0 public functions/procedures in pg_proc reference
--          leave_department_approvers in prosrc.
--      (b) 0 external foreign keys in pg_constraint reference
--          public.leave_department_approvers.
--      (c) 0 views, materialized views, or rules in pg_depend depend on
--          public.leave_department_approvers.
--   2. Drop public.leave_department_approvers with RESTRICT (never CASCADE).
--   3. Fail-closed post-drop self-check verifying:
--      (a) public.leave_department_approvers is absent.
--      (b) public.leave_management_set_department_approver_admin(uuid, uuid,
--          text, uuid, date, integer, text, text, text) stub remains intact
--          (single overload, SECURITY DEFINER, search_path = pg_catalog, public,
--          service_role-only EXECUTE ACL, PT409 error stub; +0 net RPCs).
--      (c) Snapshot columns, audit tables, leave_employee_profiles.unit_kind,
--          grant tables, and Work Reports tables remain intact.
-- =============================================================================

begin;

do $wp10_7_1b_precheck$
declare
  v_tbl oid;
  v_proc_count integer := 0;
  v_procs text;
  v_fk_count integer := 0;
  v_fks text;
  v_dep_count integer := 0;
  v_deps text;
begin
  v_tbl := pg_catalog.to_regclass('public.leave_department_approvers');
  if v_tbl is null then
    raise exception 'WP10-7-1B precheck failed: public.leave_department_approvers does not exist'
      using errcode = '55000';
  end if;

  select count(*)::integer,
         pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ' order by p.proname)
    into v_proc_count, v_procs
    from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::pg_catalog.regnamespace
     and p.prokind in ('f', 'p')
     and p.prosrc ~* 'leave_department_approvers';

  if v_proc_count > 0 then
    raise exception 'WP10-7-1B precheck failed: % public routine(s) still reference leave_department_approvers: %',
      v_proc_count, coalesce(v_procs, '<unknown>')
      using errcode = '55000';
  end if;

  select count(*)::integer,
         pg_catalog.string_agg(
           c.conrelid::pg_catalog.regclass::text || '.' || c.conname,
           ', '
           order by c.conrelid::pg_catalog.regclass::text, c.conname
         )
    into v_fk_count, v_fks
    from pg_catalog.pg_constraint c
   where c.contype = 'f'
     and c.confrelid = v_tbl
     and c.conrelid <> v_tbl;

  if v_fk_count > 0 then
    raise exception 'WP10-7-1B precheck failed: % external foreign key(s) still reference public.leave_department_approvers: %',
      v_fk_count, coalesce(v_fks, '<unknown>')
      using errcode = '55000';
  end if;

  select count(*)::integer,
         pg_catalog.string_agg(
           distinct coalesce(
             vn.nspname || '.' || vc.relname || ' (' || vc.relkind::text || ')',
             d.classid::pg_catalog.regclass::text || ':' || d.objid::text
           ),
           ', '
         )
    into v_dep_count, v_deps
    from pg_catalog.pg_depend d
    left join pg_catalog.pg_rewrite rw
      on d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
     and rw.oid = d.objid
    left join pg_catalog.pg_class vc
      on vc.oid = coalesce(rw.ev_class, d.objid)
    left join pg_catalog.pg_namespace vn
      on vn.oid = vc.relnamespace
   where d.refobjid = v_tbl
     and (
       d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
       or (
         d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
         and vc.relkind in ('v', 'm')
       )
     )
     and coalesce(vc.oid, 0::oid) <> v_tbl;

  if v_dep_count > 0 then
    raise exception 'WP10-7-1B precheck failed: % view/matview/rule object(s) depend on public.leave_department_approvers: %',
      v_dep_count, coalesce(v_deps, '<unknown>')
      using errcode = '55000';
  end if;
end
$wp10_7_1b_precheck$;

drop table public.leave_department_approvers restrict;

do $wp10_7_1b_postcheck$
declare
  v_stub_sig constant text := 'public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text)';
  v_stub_overloads integer := 0;
  v_stub_oid oid;
  v_stub_rec record;
  v_preserved_tables text[] := array[
    'public.leave_requests',
    'public.attendance_explanations',
    'public.leave_employee_profiles',
    'public.organization_department_heads',
    'public.leave_audit_events',
    'public.attendance_explanation_audit_events',
    'public.authz_audit_events',
    'public.authz_group_audit_events',
    'public.direct_entry_audit_events',
    'public.organization_department_audit_events',
    'public.vendor_finance_audit_events',
    'public.work_report_audit_events',
    'public.leave_module_grants',
    'public.direct_entry_capability_grants',
    'public.direct_entry_scope_grants',
    'public.authz_direct_capability_grants',
    'public.work_report_team_leader_capability_grants',
    'public.work_report_templates',
    'public.work_report_template_versions',
    'public.work_report_groups',
    'public.work_report_group_members',
    'public.work_report_assignments',
    'public.work_report_assignment_targets',
    'public.work_report_obligations',
    'public.work_report_submissions',
    'public.work_report_submission_revisions',
    'public.work_report_metric_values',
    'public.work_report_review_events',
    'public.work_report_delegations'
  ];
  v_preserved_cols text[][] := array[
    array['public.leave_requests', 'unit_kind_snapshot'],
    array['public.attendance_explanations', 'unit_kind_snapshot'],
    array['public.leave_employee_profiles', 'unit_kind'],
    array['public.work_report_metric_values', 'is_current_revision']
  ];
  v_tbl_name text;
  v_idx integer;
begin
  if pg_catalog.to_regclass('public.leave_department_approvers') is not null then
    raise exception 'WP10-7-1B postcheck failed: public.leave_department_approvers still exists'
      using errcode = '55000';
  end if;

  if pg_catalog.to_regclass('public.leave_department_approvers_current_uidx') is not null then
    raise exception 'WP10-7-1B postcheck failed: leave_department_approvers_current_uidx still exists'
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_stub_overloads
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'leave_management_set_department_approver_admin';

  if v_stub_overloads <> 1 then
    raise exception 'WP10-7-1B postcheck failed: expected single 9-arg leave_management_set_department_approver_admin stub, found %',
      v_stub_overloads
      using errcode = '55000';
  end if;

  v_stub_oid := pg_catalog.to_regprocedure(v_stub_sig);
  if v_stub_oid is null then
    raise exception 'WP10-7-1B postcheck failed: missing stub %', v_stub_sig
      using errcode = '55000';
  end if;

  select p.proowner, p.prosecdef, p.proconfig, p.prosrc
    into v_stub_rec
    from pg_catalog.pg_proc p
   where p.oid = v_stub_oid;

  if not coalesce(v_stub_rec.prosecdef, false)
     or not ('search_path=pg_catalog, public' = any(coalesce(v_stub_rec.proconfig, array[]::text[])))
     or not (v_stub_rec.prosrc ~* 'PT409') then
    raise exception 'WP10-7-1B postcheck failed: stub metadata/body invalid on %', v_stub_sig
      using errcode = '55000';
  end if;

  if not pg_catalog.has_function_privilege('service_role', v_stub_oid, 'EXECUTE')
     or not pg_catalog.has_function_privilege(v_stub_rec.proowner, v_stub_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('public', v_stub_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_stub_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_stub_oid, 'EXECUTE') then
    raise exception 'WP10-7-1B postcheck failed: stub EXECUTE ACL invalid on %', v_stub_sig
      using errcode = '55000';
  end if;

  foreach v_tbl_name in array v_preserved_tables loop
    if pg_catalog.to_regclass(v_tbl_name) is null then
      raise exception 'WP10-7-1B postcheck failed: preserved table % missing', v_tbl_name
        using errcode = '55000';
    end if;
  end loop;

  for v_idx in 1 .. pg_catalog.array_length(v_preserved_cols, 1) loop
    if not exists (
      select 1
        from pg_catalog.pg_attribute a
       where a.attrelid = pg_catalog.to_regclass(v_preserved_cols[v_idx][1])
         and a.attname = v_preserved_cols[v_idx][2]
         and a.attnum > 0
         and not a.attisdropped
    ) then
      raise exception 'WP10-7-1B postcheck failed: preserved column %.% missing',
        v_preserved_cols[v_idx][1], v_preserved_cols[v_idx][2]
        using errcode = '55000';
    end if;
  end loop;
end
$wp10_7_1b_postcheck$;

commit;
