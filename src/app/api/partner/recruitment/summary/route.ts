import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { handleGetPartnerRecruitmentSummary } from "@/lib/partner/api";
import { createPartnerRepository } from "@/lib/partner/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleGetPartnerRecruitmentSummary(
    request,
    process.env.DIRECT_ENTRY_API_ENABLED,
    {
      resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
      repository: createPartnerRepository(),
    },
  );
}
