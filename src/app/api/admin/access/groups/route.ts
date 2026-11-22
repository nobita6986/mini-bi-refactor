import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";
import {
  createPermissionGroupAdmin,
  listPermissionGroupsAdmin,
} from "@/lib/admin/permission-group-api";
import { createServicePermissionGroupRepository } from "@/lib/admin/permission-group-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServicePermissionGroupRepository(),
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  return listPermissionGroupsAdmin(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  return createPermissionGroupAdmin(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
