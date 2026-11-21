-- Retire AI Reports and AI Provider Config subsystem (append-only).
-- Approved by Owner on 2026-11-21: remove all AI report jobs, revisions, usage,
-- provider configs, AI-only audit events, triggers, and RPCs/functions.
--
-- Rollout order (Web-before-SQL):
--   1. Deploy web build without AI routes/UI/inline-worker/callers.
--   2. Verify no external AI worker scheduler still calls /api/ai/worker/run.
--   3. Apply this migration.
--
-- Safety invariants:
--   - Strict RESTRICT drops in explicit dependency order (NO DROP ... CASCADE).
--   - Preserves all non-AI tables, views, routines, ACLs, default privileges,
--     and bootstrap executor role/membership.

begin;

-- 1. Revoke all EXECUTE privileges on the 25 verified AI functions before drop.
revoke all on function public.ai_provider_config_activate(text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_provider_config_active() from public, anon, authenticated, service_role;
revoke all on function public.ai_provider_config_current(text) from public, anon, authenticated, service_role;
revoke all on function public.ai_provider_config_disable(text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_provider_config_rejected(text, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_provider_config_test_result(text, integer, boolean, text, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_provider_config_version(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_provider_config_public_json(public.ai_provider_configs) from public, anon, authenticated, service_role;
revoke all on function public.ai_provider_config_audit_immutable() from public, anon, authenticated, service_role;

revoke all on function public.ai_report_approve_revision(uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_claim(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_complete(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_fail(uuid, uuid, text, text, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_history(text, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_mark_stage(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_policy_context(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_record_usage(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_recover_stale(integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_regenerate(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_reject_revision(uuid, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_review_capability() from public, anon, authenticated, service_role;
revoke all on function public.ai_report_status(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_report_audit_immutable() from public, anon, authenticated, service_role;

-- 2. Drop the 2 AI-only append-only audit triggers before dropping their functions.
drop trigger ai_report_audit_no_mutation on public.ai_report_audit_events restrict;
drop trigger ai_provider_config_audit_no_mutation on public.ai_provider_config_audit_events restrict;

-- 3. Drop all 25 verified AI functions with RESTRICT (helper taking composite
--    row type ai_provider_configs must drop before table ai_provider_configs).
drop function public.ai_provider_config_activate(text, integer, text) restrict;
drop function public.ai_provider_config_active() restrict;
drop function public.ai_provider_config_current(text) restrict;
drop function public.ai_provider_config_disable(text, integer, text) restrict;
drop function public.ai_provider_config_rejected(text, integer, text, text) restrict;
drop function public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text) restrict;
drop function public.ai_provider_config_test_result(text, integer, boolean, text, text) restrict;
drop function public.ai_provider_config_version(text, integer) restrict;
drop function public.ai_provider_config_public_json(public.ai_provider_configs) restrict;
drop function public.ai_provider_config_audit_immutable() restrict;

drop function public.ai_report_approve_revision(uuid, integer, text) restrict;
drop function public.ai_report_claim(text, integer, integer) restrict;
drop function public.ai_report_complete(uuid, uuid, jsonb, jsonb) restrict;
drop function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer, text, integer) restrict;
drop function public.ai_report_fail(uuid, uuid, text, text, timestamptz, text) restrict;
drop function public.ai_report_history(text, text, integer) restrict;
drop function public.ai_report_mark_stage(uuid, uuid, text) restrict;
drop function public.ai_report_policy_context(text, integer) restrict;
drop function public.ai_report_record_usage(jsonb) restrict;
drop function public.ai_report_recover_stale(integer) restrict;
drop function public.ai_report_regenerate(uuid, text, text) restrict;
drop function public.ai_report_reject_revision(uuid, integer, text, text) restrict;
drop function public.ai_report_review_capability() restrict;
drop function public.ai_report_status(uuid) restrict;
drop function public.ai_report_audit_immutable() restrict;

-- 4. Revoke table and owned-sequence privileges, then drop the 6 AI tables with
--    RESTRICT in child-before-parent foreign-key order (deleting all legacy AI
--    jobs, revisions, usage, provider configs, and AI-only audit rows).
revoke all on table public.ai_report_revisions from public, anon, authenticated, service_role;
revoke all on table public.ai_report_usage from public, anon, authenticated, service_role;
revoke all on table public.ai_report_audit_events from public, anon, authenticated, service_role;
revoke all on sequence public.ai_report_audit_events_event_id_seq from public, anon, authenticated, service_role;
revoke all on table public.ai_report_jobs from public, anon, authenticated, service_role;
revoke all on table public.ai_provider_config_audit_events from public, anon, authenticated, service_role;
revoke all on sequence public.ai_provider_config_audit_events_event_id_seq from public, anon, authenticated, service_role;
revoke all on table public.ai_provider_configs from public, anon, authenticated, service_role;

drop table public.ai_report_revisions restrict;
drop table public.ai_report_usage restrict;
drop table public.ai_report_audit_events restrict;
drop table public.ai_report_jobs restrict;
drop table public.ai_provider_config_audit_events restrict;
drop table public.ai_provider_configs restrict;

-- 5. Fail-closed verification: zero AI objects remain, non-AI core tables intact.
do $verify_ai_retirement$
declare
  v_remaining_rels text[];
  v_remaining_procs text[];
  v_remaining_types text[];
  v_remaining_triggers text[];
  v_required_core_table text;
  v_required_core_tables constant text[] := array[
    'public.daily_recruitment_breakdown',
    'public.data_sources',
    'public.direct_entry_app_users',
    'public.direct_entry_audit_events',
    'public.direct_entry_account_operation_intents',
    'public.work_report_templates',
    'public.vendor_finance_entries',
    'public.vendor_finance_audit_events'
  ];
begin
  select coalesce(array_agg(c.relname order by c.relname), array[]::text[])
    into v_remaining_rels
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname ~ '^(ai_report_|ai_provider_config)';

  if array_length(v_remaining_rels, 1) is not null then
    raise exception 'AI retirement incomplete: remaining relations %', v_remaining_rels;
  end if;

  select coalesce(array_agg(p.oid::pg_catalog.regprocedure::text order by 1), array[]::text[])
    into v_remaining_procs
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname ~ '^(ai_report_|ai_provider_config)';

  if array_length(v_remaining_procs, 1) is not null then
    raise exception 'AI retirement incomplete: remaining routines %', v_remaining_procs;
  end if;

  select coalesce(array_agg(t.typname order by t.typname), array[]::text[])
    into v_remaining_types
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public'
     and t.typname ~ '^_?(ai_report_|ai_provider_config)';

  if array_length(v_remaining_types, 1) is not null then
    raise exception 'AI retirement incomplete: remaining types %', v_remaining_types;
  end if;

  select coalesce(array_agg(tg.tgname order by tg.tgname), array[]::text[])
    into v_remaining_triggers
    from pg_catalog.pg_trigger tg
    join pg_catalog.pg_class c on c.oid = tg.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where not tg.tgisinternal
     and n.nspname = 'public'
     and (tg.tgname ~ '^(ai_report_|ai_provider_config)' or c.relname ~ '^(ai_report_|ai_provider_config)');

  if array_length(v_remaining_triggers, 1) is not null then
    raise exception 'AI retirement incomplete: remaining triggers %', v_remaining_triggers;
  end if;

  foreach v_required_core_table in array v_required_core_tables loop
    if pg_catalog.to_regclass(v_required_core_table) is null then
      raise exception 'AI retirement safety check failed: missing core table %', v_required_core_table;
    end if;
  end loop;
end;
$verify_ai_retirement$;

commit;
