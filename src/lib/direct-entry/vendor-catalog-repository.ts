/**
 * P3.1-W02-B + Partner Portal - Repository boundary cho vendor master catalog admin.
 *
 * - Chi goi 5 RPC canonical cua migration #75 / 20261128190000; KHONG doc/ghi table truc tiep.
 * - auth_subject/app_user_id do server context truyen vao, khong bao gio tu client.
 * - DB guard (direct_entry_assert_catalog_operator tu #68) van la authority cuoi.
 * - Response duoc project chat; malformed => unavailable (khong bao gio success).
 */
import "server-only";

import {
  classifyPartnerCatalogError,
  vendorCatalogCreateResult,
  vendorCatalogItem,
  vendorCatalogList,
  vendorCatalogMutation,
} from "./vendor-catalog-contract.ts";
import type {
  AdminVendor,
  AdminVendorCreateResult,
  AdminVendorList,
  AdminVendorMutation,
  PartnerCatalogErrorKind,
} from "./vendor-catalog-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type AdminActorRef = { auth_subject: string; app_user_id: string };

export type VendorCatalogErrorKind = PartnerCatalogErrorKind;

export type VendorCatalogOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: VendorCatalogErrorKind };

export type VendorCatalogRepository = {
  listVendors(input: AdminActorRef & {
    search: string | null; include_inactive: boolean; page: number; page_size: number;
  }): Promise<VendorCatalogOutcome<AdminVendorList>>;
  getVendor(input: AdminActorRef & { vendor_id: string }): Promise<VendorCatalogOutcome<AdminVendor>>;
  createVendor(input: AdminActorRef & {
    expected_version: 0; vendor_id: string; display_name: string; valid_from: string;
    address?: string | null; phone?: string | null;
    reason: string | null; idempotency_key: string;
  }): Promise<VendorCatalogOutcome<AdminVendorCreateResult>>;
  updateVendor(input: AdminActorRef & {
    vendor_id: string; expected_version: number; display_name: string;
    address?: string | null; phone?: string | null;
    reason: string | null; idempotency_key: string;
  }): Promise<VendorCatalogOutcome<AdminVendorMutation>>;
  setVendorActive(input: AdminActorRef & {
    vendor_id: string; active: boolean; expected_version: number;
    reason: string | null; idempotency_key: string;
  }): Promise<VendorCatalogOutcome<AdminVendorMutation>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind. Chi nhan cac ma RPC #75 / 20261128190000 thuc su dung:
 *   PT409 PARTNER_CODE_CONFLICT / 23505 -> code-conflict
 *   PT409 OCC / 40001 / 22023 reuse -> conflict
 *   42501 -> denied, P0002 -> not-found, 23514 / 22023 -> invalid
 * Moi ma khac => unavailable (fail-closed).
 */
export function classifyVendorCatalogError(
  error: { code?: string; message?: string },
): VendorCatalogErrorKind {
  return classifyPartnerCatalogError(error);
}

function unavailable(): never {
  console.error("[vendor-catalog] RPC failed");
  throw new Error("vendor catalog RPC failed");
}

export function createVendorCatalogRepository(rpc?: Rpc): VendorCatalogRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<VendorCatalogOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) return { ok: false, kind: classifyVendorCatalogError(error) };
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      unavailable();
    }
  }

  return {
    listVendors(input) {
      return call("direct_entry_list_vendors_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_search: input.search,
        p_include_inactive: input.include_inactive,
        p_page: input.page,
        p_page_size: input.page_size,
      }, vendorCatalogList);
    },
    getVendor(input) {
      return call("direct_entry_get_vendor_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_vendor_id: input.vendor_id,
      }, vendorCatalogItem);
    },
    createVendor(input) {
      return call("direct_entry_create_vendor", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_expected_version: input.expected_version,
        p_vendor_id: input.vendor_id,
        p_display_name: input.display_name,
        p_valid_from: input.valid_from,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
        p_address: input.address ?? null,
        p_phone: input.phone ?? null,
      }, vendorCatalogCreateResult);
    },
    updateVendor(input) {
      return call("direct_entry_update_vendor", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_vendor_id: input.vendor_id,
        p_expected_version: input.expected_version,
        p_display_name: input.display_name,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
        p_address: input.address ?? null,
        p_phone: input.phone ?? null,
      }, vendorCatalogMutation);
    },
    setVendorActive(input) {
      return call("direct_entry_set_vendor_active", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_vendor_id: input.vendor_id,
        p_active: input.active,
        p_expected_version: input.expected_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, vendorCatalogMutation);
    },
  };
}
