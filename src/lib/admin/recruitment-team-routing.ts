import { decideAccountAccessPageAccess } from "../auth/direct-entry-page-access.ts";
import type { ActorResolution } from "../auth/direct-entry-v2.ts";
import type { DepartmentRepository } from "../departments/department-repository.ts";

export type RecruitmentDepartmentLookupInput = {
  actor: ActorResolution | null;
  apiEnabled: boolean;
  departmentRepository: Pick<DepartmentRepository, "listDepartments">;
};

export async function resolveRecruitmentTeamsRedirectHref({
  actor,
  apiEnabled,
  departmentRepository,
}: RecruitmentDepartmentLookupInput): Promise<string | null> {
  if (!actor?.ok || decideAccountAccessPageAccess({ actor }) !== "ALLOW" || !apiEnabled) {
    return null;
  }
  const result = await departmentRepository
    .listDepartments({
      auth_subject: actor.actor.auth_subject,
      app_user_id: actor.actor.app_user_id,
      include_inactive: true,
    })
    .catch(() => null);
  if (!result?.ok) {
    return null;
  }
  const recruitment = result.data.departments.find(
    (department) => department.system_key === "RECRUITMENT",
  );
  return recruitment
    ? `/admin/departments/${encodeURIComponent(recruitment.department_id)}?view=teams`
    : null;
}

export async function resolveTeamReturnHref(
  input: RecruitmentDepartmentLookupInput,
): Promise<string> {
  if (!input.actor?.ok || decideAccountAccessPageAccess({ actor: input.actor }) !== "ALLOW") {
    return "/admin/catalog/teams";
  }
  return (await resolveRecruitmentTeamsRedirectHref(input)) ?? "/admin/catalog/teams";
}
