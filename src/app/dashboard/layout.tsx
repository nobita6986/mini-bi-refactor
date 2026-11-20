import type { ReactNode } from "react";
import { connection } from "next/server";

import { AppShell } from "@/components/app-shell/app-shell";
import { resolveNavActorForAppShell } from "@/lib/navigation/resolve-nav-actor";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

/**
 * Dashboard layout wrapper around AppShell.
 *
 * AI Reports and AI Settings panels/routes were permanently retired (2026-11-21).
 * `resolveNavActorForAppShell` is wrapped by React `cache()` (request-scoped),
 * sharing `ActorResolution` with `DashboardPage` below without duplicate auth/RPC
 * calls. Admin nav needs actor projection even when Direct Entry UI flag is off.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await connection();
  const directEntryEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const actor = await resolveNavActorForAppShell({
    directEntryEnabled,
    adminNavigationEnabled: true,
  });
  return <AppShell actor={actor}>{children}</AppShell>;
}