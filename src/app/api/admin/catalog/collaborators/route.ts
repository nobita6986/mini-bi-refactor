import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  createCollaboratorCatalog,
  listCollaboratorsCatalog,
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

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return listCollaboratorsCatalog(request, "true", dependencies);
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return createCollaboratorCatalog(request, "true", dependencies);
}
