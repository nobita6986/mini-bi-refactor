-- Terminal CREATE_ACCOUNT intents retain a tombstone after their PII is purged.
-- Unresolved creates must keep login_id for the live-login uniqueness guard.
begin;

alter table public.direct_entry_account_operation_intents
  drop constraint direct_entry_account_operation_intents_check,
  add constraint direct_entry_account_operation_intents_check check (
    kind = 'RESET_PASSWORD'
    or login_id is not null
    or (
      state in ('APPLIED', 'FAILED', 'EXPIRED')
      and pii_purged_at is not null
      and tombstone_until is not null
    )
  );

commit;
