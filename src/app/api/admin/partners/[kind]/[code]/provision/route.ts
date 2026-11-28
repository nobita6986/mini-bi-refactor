import "server-only";

import {
  createAuthAccount,
  findAuthUserByLoginId,
  readAuthUserProvenance,
} from "@/lib/admin/account-operation-auth";
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { handleAdminProvisionPartner } from "@/lib/partner/api";
import { createPartnerRepository } from "@/lib/partner/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ kind: string; code: string }> },
): Promise<Response> {
  const { kind, code } = await context.params;
  return handleAdminProvisionPartner(
    request,
    kind,
    code,
    process.env.DIRECT_ENTRY_API_ENABLED,
    {
      resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
      repository: createPartnerRepository(),
      auth: { createAuthAccount, findAuthUserByLoginId, readAuthUserProvenance },
    },
  );
}
