begin;

-- The AppShell only needs to know whether the actor can use an assignment template.
create function public.work_report_has_assignment_access(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    return false;
  end if;

  return pg_catalog.jsonb_array_length(
    public.work_report_list_assignment_options(p_auth_subject, p_app_user_id, null)->'templates'
  ) > 0;
end;
$function$;

revoke all on function public.work_report_has_assignment_access(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_has_assignment_access(uuid, uuid) to service_role;

commit;
