import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";
import { setAccountTypeAdmin } from "@/lib/organization/person-api";
import { createServiceOrganizationRepository } from "@/lib/organization/person-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceOrganizationRepository(),
};

export async function POST(
  request: Request,
  context: { params: Promise<{ accountRef: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  const { accountRef } = await context.params;
  return setAccountTypeAdmin(
    request,
    accountRef,
    process.env.DIRECT_ENTRY_API_ENABLED,
    dependencies,
  );
}
