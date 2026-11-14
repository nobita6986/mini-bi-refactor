-- Repair legacy helper ACL drift before the WP3B invariant checks run.
do $repair_org_internal_acl$
declare
  v_function record;
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
end;
$repair_org_internal_acl$;
