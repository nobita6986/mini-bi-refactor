-- Repair legacy helper ACL drift before the WP3B invariant checks run.
do $repair_org_internal_acl$
declare
  v_function record;
  v_signature text;
begin
  for v_function in
    select p.oid, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as args
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'org_department\_\_internal\_%' escape '\'
  loop
    execute pg_catalog.format(
      'revoke all on function public.%I(%s) from public, anon, authenticated, service_role',
      v_function.proname, v_function.args
    );
    if has_function_privilege('public', v_function.oid, 'EXECUTE')
       or has_function_privilege('anon', v_function.oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_function.oid, 'EXECUTE')
       or has_function_privilege('service_role', v_function.oid, 'EXECUTE') then
      raise exception 'Internal organization helper ACL remains open: %', v_function.proname
        using errcode = '55000';
    end if;
  end loop;
  for v_signature in select unnest(array[
    'public.org_department_list_departments_admin(uuid, uuid)',
    'public.org_department_get_department_admin(uuid, uuid, uuid)',
    'public.org_department_list_accounting_memberships_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.org_department_list_accounting_candidates_admin(uuid, uuid, text, integer, integer)',
    'public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.org_department_list_recruitment_teams_admin(uuid, uuid, text, boolean, integer, integer)'
  ]) loop
    -- Some signatures are replaced by WP3B; a replay after that upgrade is safe.
    if pg_catalog.to_regprocedure(v_signature) is null then continue; end if;
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
    if has_function_privilege('public', v_signature, 'EXECUTE')
       or has_function_privilege('anon', v_signature, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'Organization RPC ACL repair failed: %', v_signature using errcode = '55000';
    end if;
  end loop;
end;
$repair_org_internal_acl$;
