import type { DraftCatalog } from "./write-repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProject(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.project_id === "string" && CATALOG_ID.test(value.project_id) &&
    typeof value.display_name === "string" && value.display_name.trim().length > 0;
}

function isBank(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.bank_id === "string" && CATALOG_ID.test(value.bank_id) &&
    typeof value.display_name === "string" && value.display_name.trim().length > 0;
}

function isRecruiter(value: unknown): boolean {
  if (!isRecord(value) || typeof value.recruiter_id !== "string" || !UUID.test(value.recruiter_id) ||
      typeof value.display_name !== "string" || value.display_name.trim().length === 0 ||
      typeof value.label !== "string" || value.label.trim().length === 0) return false;
  if (value.provider_type === "hrp") {
    return typeof value.personnel_code === "string" && value.personnel_code.trim().length > 0 &&
      value.vendor_id === null && typeof value.team_id === "string" && UUID.test(value.team_id) &&
      typeof value.team_display_name === "string" && value.team_display_name.trim().length > 0;
  }
  if (value.provider_type === "vendor") {
    return value.personnel_code === null && value.team_id === null &&
      value.team_display_name === null &&
      (value.vendor_id === null || (typeof value.vendor_id === "string" && CATALOG_ID.test(value.vendor_id)));
  }
  return false;
}

function isCollaborator(value: unknown): boolean {
  return isRecord(value) &&
    Object.keys(value).length === 3 &&
    typeof value.collaborator_id === "string" && CATALOG_ID.test(value.collaborator_id) &&
    typeof value.display_name === "string" && value.display_name.trim().length > 0 &&
    typeof value.active === "boolean";
}

/**
 * Validate the browser API envelope using the same HRP/Vendor discriminator
 * as the server projector. Vendor rows intentionally have no team.
 */
export function parseDirectEntryCatalogResponse(
  value: unknown,
  expectedDate: string,
): DraftCatalog | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.catalog) ||
      value.catalog.effective_date !== expectedDate ||
      !Array.isArray(value.catalog.projects) || !value.catalog.projects.every(isProject) ||
      !Array.isArray(value.catalog.recruiters) || !value.catalog.recruiters.every(isRecruiter) ||
      !Array.isArray(value.catalog.banks) || !value.catalog.banks.every(isBank)) return null;
  if (Object.hasOwn(value.catalog, "collaborators")) {
    if (!Array.isArray(value.catalog.collaborators) || !value.catalog.collaborators.every(isCollaborator)) {
      return null;
    }
    const ids = value.catalog.collaborators.map((item) => (item as { collaborator_id: string }).collaborator_id);
    if (new Set(ids).size !== ids.length) return null;
  }
  const catalog = value.catalog as DraftCatalog;
  return Object.hasOwn(catalog, "collaborators")
    ? catalog
    : { ...catalog, collaborators: [] };
}
