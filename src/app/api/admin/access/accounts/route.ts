import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createAccountAccessRepository } from "@/lib/direct-entry/app-user-access-repository";
import { listAccounts } from "@/lib/direct-entry/app-user-access-api";
import { createAccount } from "@/lib/admin/account-operation-api";
import { createAccountOperationRepository } from "@/lib/admin/account-operation-repository";
import {
  createAuthAccount,
  resetAuthPassword,
  readAuthUserProvenance,
  findAuthUserByLoginId,
} from "@/lib/admin/account-operation-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listDependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createAccountAccessRepository(),
};

const createDependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createAccountOperationRepository(),
  accountAccess: createAccountAccessRepository(),
  auth: { createAuthAccount, resetAuthPassword, readAuthUserProvenance, findAuthUserByLoginId },
};

export async function GET(request: Request): Promise<Response> {
  return listAccounts(request, process.env.DIRECT_ENTRY_API_ENABLED, listDependencies);
}

export async function POST(request: Request): Promise<Response> {
  return createAccount(request, process.env.DIRECT_ENTRY_API_ENABLED, createDependencies);
}
