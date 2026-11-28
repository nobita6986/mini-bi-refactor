import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import {
  handleAdminBulletinDetail,
  handleAdminBulletinUpdate,
} from "@/lib/bulletins/api";
import { createServiceBulletinRepository } from "@/lib/bulletins/repository";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceBulletinRepository(),
};

export async function GET(
  request: Request,
  context: { params: Promise<{ bulletinId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  const { bulletinId } = await context.params;
  return handleAdminBulletinDetail(
    request,
    bulletinId,
    process.env.DIRECT_ENTRY_API_ENABLED,
    dependencies,
  );
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ bulletinId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  const { bulletinId } = await context.params;
  return handleAdminBulletinUpdate(
    request,
    bulletinId,
    process.env.DIRECT_ENTRY_API_ENABLED,
    dependencies,
  );
}
