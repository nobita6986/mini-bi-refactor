import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";
import { createPersonAdmin, listPersonsAdmin } from "@/lib/organization/person-api";
import { createServiceOrganizationRepository } from "@/lib/organization/person-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceOrganizationRepository(),
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  return listPersonsAdmin(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  return createPersonAdmin(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
