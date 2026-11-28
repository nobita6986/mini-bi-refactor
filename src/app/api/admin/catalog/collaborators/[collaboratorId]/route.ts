import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  getCollaboratorCatalog,
  updateCollaboratorCatalog,
} from "@/lib/direct-entry/collaborator-catalog-api";
import { createCollaboratorCatalogRepository } from "@/lib/direct-entry/collaborator-catalog-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE = () =>
  Response.json(
    { ok: false, code: "NOT_FOUND" },
    { status: 404, headers: { "Cache-Control": "private, no-store" } },
  );

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createCollaboratorCatalogRepository(),
};

export async function GET(
  request: Request,
  context: { params: Promise<{ collaboratorId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { collaboratorId } = await context.params;
  return getCollaboratorCatalog(request, collaboratorId, "true", dependencies);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ collaboratorId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { collaboratorId } = await context.params;
  return updateCollaboratorCatalog(request, collaboratorId, "true", dependencies);
}
