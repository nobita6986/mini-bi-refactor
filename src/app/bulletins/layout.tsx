import type { ReactNode } from "react";
import { connection } from "next/server";

import { AppShell } from "@/components/app-shell/app-shell";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";
import { resolveNavActorForAppShell } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function BulletinsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await connection();
  const directEntryEnabled = isDirectEntryUiEnabled(
    process.env.DIRECT_ENTRY_UI_ENABLED,
  );
  const actor = await resolveNavActorForAppShell({
    directEntryEnabled,
    adminNavigationEnabled: true,
  });
  return <AppShell actor={actor}>{children}</AppShell>;
}
