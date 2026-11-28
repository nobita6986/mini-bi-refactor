import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  handleGetPartnerProfile,
  handlePatchPartnerProfile,
} from "@/lib/partner/api";
import { createPartnerRepository } from "@/lib/partner/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deps = () => ({
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createPartnerRepository(),
});

export async function GET(request: Request): Promise<Response> {
  return handleGetPartnerProfile(request, process.env.DIRECT_ENTRY_API_ENABLED, deps());
}

export async function PATCH(request: Request): Promise<Response> {
  return handlePatchPartnerProfile(request, process.env.DIRECT_ENTRY_API_ENABLED, deps());
}
