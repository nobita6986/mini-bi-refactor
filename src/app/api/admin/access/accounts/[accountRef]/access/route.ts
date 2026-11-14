import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  createRoleAccessApiHandlers,
  roleAccessNotFoundResponse,
} from "@/lib/direct-entry/role-access-api";
import { createRoleAccessRepository } from "@/lib/direct-entry/role-access-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createRoleAccessApiHandlers({
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createRoleAccessRepository(),
  env: () => process.env,
});

export async function GET(
  request: Request,
  context: { params: Promise<{ accountRef: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return roleAccessNotFoundResponse();
  }
  const { accountRef } = await context.params;
  return handlers.getAccountAccess(request, { accountRef });
}
