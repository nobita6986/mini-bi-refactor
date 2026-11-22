import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";
import { listUserDirectoryAdmin } from "@/lib/organization/user-directory-api";
import { createServiceUserDirectoryRepository } from "@/lib/organization/user-directory-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceUserDirectoryRepository(),
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  return listUserDirectoryAdmin(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
