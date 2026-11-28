import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { listVendorReferrerCandidates } from "@/lib/vendor-referrals/vendor-referrer-api";
import { createVendorReferrerRepository } from "@/lib/vendor-referrals/vendor-referrer-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE = () =>
  Response.json(
    { ok: false, code: "NOT_FOUND" },
    { status: 404, headers: { "Cache-Control": "private, no-store" } },
  );

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createVendorReferrerRepository(),
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return listVendorReferrerCandidates(request, "true", dependencies);
}
