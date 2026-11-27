import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { assignVendorReferrer } from "@/lib/vendor-referrals/vendor-referrer-api";
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

export async function POST(
  request: Request,
  context: { params: Promise<{ vendorId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { vendorId } = await context.params;
  return assignVendorReferrer(request, vendorId, "true", dependencies);
}
