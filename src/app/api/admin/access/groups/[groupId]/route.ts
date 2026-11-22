import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";
import { updatePermissionGroupAdmin } from "@/lib/admin/permission-group-api";
import { createServicePermissionGroupRepository } from "@/lib/admin/permission-group-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServicePermissionGroupRepository(),
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  const { groupId } = await context.params;
  return updatePermissionGroupAdmin(request, groupId, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
