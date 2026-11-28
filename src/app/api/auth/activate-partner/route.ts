import "server-only";

import { handleActivatePartner } from "@/lib/partner/api";
import { createPartnerRepository } from "@/lib/partner/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleActivatePartner(request, process.env.DIRECT_ENTRY_API_ENABLED, {
    repository: createPartnerRepository(),
  });
}
