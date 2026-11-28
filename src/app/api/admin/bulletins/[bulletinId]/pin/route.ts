import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { handleAdminBulletinPin } from "@/lib/bulletins/api";
import { createServiceBulletinRepository } from "@/lib/bulletins/repository";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceBulletinRepository(),
};

export async function POST(
  request: Request,
  context: { params: Promise<{ bulletinId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  const { bulletinId } = await context.params;
  return handleAdminBulletinPin(
    request,
    bulletinId,
    process.env.DIRECT_ENTRY_API_ENABLED,
    dependencies,
  );
}
