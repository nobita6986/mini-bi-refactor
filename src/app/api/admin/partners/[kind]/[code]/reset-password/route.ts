import "server-only";

import {
  createAuthAccount,
  findAuthUserByLoginId,
  readAuthUserProvenance,
  resetAuthPassword,
} from "@/lib/admin/account-operation-auth";
import { createAccountOperationRepository } from "@/lib/admin/account-operation-repository";
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { handleAdminResetPartnerPassword } from "@/lib/partner/api";
import { createPartnerRepository } from "@/lib/partner/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ kind: string; code: string }> },
): Promise<Response> {
  const { kind, code } = await context.params;
  return handleAdminResetPartnerPassword(
    request,
    kind,
    code,
    process.env.DIRECT_ENTRY_API_ENABLED,
    {
      resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
      repository: createPartnerRepository(),
      accountOperations: {
        repository: createAccountOperationRepository(),
        auth: {
          createAuthAccount,
          resetAuthPassword,
          readAuthUserProvenance,
          findAuthUserByLoginId,
        },
      },
    },
  );
}
