import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { handleBulletinArchiveList } from "@/lib/bulletins/api";
import { createServiceBulletinRepository } from "@/lib/bulletins/repository";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceBulletinRepository(),
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  return handleBulletinArchiveList(
    request,
    process.env.DIRECT_ENTRY_API_ENABLED,
    dependencies,
  );
}
