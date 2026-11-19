import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createAccountAccessRepository } from "@/lib/direct-entry/app-user-access-repository";
import { reconcileIntent } from "@/lib/admin/account-operation-api";
import { createAccountOperationRepository } from "@/lib/admin/account-operation-repository";
import {
  createAuthAccount,
  resetAuthPassword,
  readAuthUserProvenance,
  findAuthUserByLoginId,
} from "@/lib/admin/account-operation-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createAccountOperationRepository(),
  accountAccess: createAccountAccessRepository(),
  auth: { createAuthAccount, resetAuthPassword, readAuthUserProvenance, findAuthUserByLoginId },
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ intentRef: string }> },
): Promise<Response> {
  const { intentRef } = await params;
  return reconcileIntent(request, intentRef, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
