/**
 * PR #28 — Safe, auth-gated resolution for retired technical admin URLs
 * (`/admin/access/accounts` and `/admin/access/effective`).
 *
 * Guarantees (Rev 4 / N1):
 * - Runs ONLY after server-side Full Admin authorization succeeds.
 * - Never renders a second legacy admin screen.
 * - Never blindly redirects `?account=<uuid>` to `/persons/<account_ref>`:
 *   resolves via `org_department_get_user_directory_entry_admin`:
 *     - Cleanly linked person -> `/admin/organization/persons/<person_id>`
 *     - Unlinked legacy account or link conflict -> `/admin/organization/persons/account/<account_ref>`
 *     - Missing / not found -> fallback (`/admin/organization/persons` or `/admin/access/groups`)
 */
import type { UserDirectoryEntryDetail } from "../organization/user-directory-contract.ts";
import { resolveUserDirectoryDetailHref } from "./user-directory-ui-model.ts";

export function resolveLegacyAccountsRedirectTarget(input: {
  tab?: string | null;
  view?: string | null;
  accountEntry?: UserDirectoryEntryDetail | null;
}): string {
  if (input.accountEntry) {
    return resolveUserDirectoryDetailHref(input.accountEntry);
  }
  if (input.tab === "global-roles") {
    return "/admin/access/groups";
  }
  if (input.view === "unlinked") {
    return "/admin/organization/persons?record_kind=unlinked_account";
  }
  return "/admin/organization/persons";
}

export function resolveLegacyEffectiveRedirectTarget(input: {
  accountEntry?: UserDirectoryEntryDetail | null;
}): string {
  if (input.accountEntry) {
    return resolveUserDirectoryDetailHref(input.accountEntry);
  }
  return "/admin/access/groups";
}
