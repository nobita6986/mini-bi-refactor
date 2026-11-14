import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { endDepartmentHeadAdmin } from "@/lib/departments/department-api";
import { createServiceDepartmentRepository } from "@/lib/departments/department-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceDepartmentRepository(),
};

export async function POST(
  request: Request,
  context: { params: Promise<{ departmentId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  const { departmentId } = await context.params;
  return endDepartmentHeadAdmin(
    request,
    departmentId,
    process.env.DIRECT_ENTRY_API_ENABLED,
    dependencies,
  );
}
