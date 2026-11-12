import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const S0_T1_C_MIGRATION_NAME =
  "20261020180000_s0_t1_c_rpc_acl_allowlist.sql";
export const S0_T1_C_PRE_PR92_CHECKSUM =
  "7382013e39521601ae1c08de22e7579dc289a8e113ea8c362f8be6ba66e3417f";
export const S0_T1_C_CURRENT_CHECKSUM =
  "f4caf15770299af1b4527350b2f137ff805d35b01960a62a2442a24a87681126";
export const R1_2_MIGRATION_NAME =
  "20261021100000_r1_2_worker_management_uat_fixes.sql";
export const R1_2_SERVICE_RPC_SIGNATURE =
  "public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer, text)";
export const F1_WORK_REPORTS_MIGRATION_NAME =
  "20261021160000_f1_work_reports_foundation.sql";
export const F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_MIGRATION_NAME =
  "20261021180000_f1_work_reports_scoped_assignment_options.sql";
export const F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE =
  "public.work_report_list_assignment_options(uuid, uuid, uuid)";
export const F1_WORK_REPORTS_ASSIGNMENT_TRACKING_MIGRATION_NAME =
  "20261021200000_f1_work_reports_assignment_tracking.sql";
export const F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE =
  "public.work_report_list_assignments(uuid, uuid, uuid)";
export const F1_5_WORK_REPORTS_ANALYTICS_MIGRATION_NAME =
  "20261021210000_f1_5_work_reports_analytics.sql";
export const F1_5_WORK_REPORTS_ANALYTICS_RPC_SIGNATURES = Object.freeze([
  "public.work_report_analytics_overview(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text)",
  "public.work_report_analytics_breakdown(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer, integer)",
  "public.work_report_analytics_contributions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, text, uuid, uuid, text, text, integer)",
  "public.work_report_reconcile_metric_projection(uuid, uuid, uuid)",
]);
export const F2_WORK_REPORTS_REVIEW_AND_DELEGATION_MIGRATION_NAME =
  "20261022000000_f2_work_reports_review_and_delegation.sql";
export const F2_WORK_REPORTS_REVIEW_AND_DELEGATION_RPC_SIGNATURES = Object.freeze([
  "public.work_report_create_delegation(uuid, uuid, text, uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone, text)",
  "public.work_report_decide_review(uuid, uuid, uuid, text, text, integer, text)",
  "public.work_report_get_review_submission(uuid, uuid, uuid)",
  "public.work_report_list_delegations(uuid, uuid)",
  "public.work_report_list_pending_reviews(uuid, uuid, uuid, text, integer)",
  "public.work_report_revoke_delegation(uuid, uuid, uuid, integer, text)",
]);
export const WF01_WORKFORCE_SNAPSHOT_MIGRATION_NAME =
  "20261022090000_wf01_workforce_snapshot_and_transitions.sql";
export const WF01_WORKFORCE_SNAPSHOT_RPC_SIGNATURE =
  "public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)";
export const PROJECT_TEAM_SCOPE_SEARCH_MIGRATION_NAME =
  "20261023100000_hf_project_team_scope_fuzzy_search.sql";
export const PROJECT_TEAM_SCOPE_SEARCH_RPC_SIGNATURE =
  "public.direct_entry_list_project_team_scopes_admin(uuid, uuid, text, uuid, boolean, integer, integer, text)";
export const WF02_WORKFORCE_BALANCE_WAITING_MIGRATION_NAME =
  "20261022110000_wf02_workforce_balance_and_waiting_metrics.sql";
export const WF03_WORKFORCE_TENURE_RETENTION_MIGRATION_NAME =
  "20261022130000_wf03_workforce_tenure_presence_and_retention.sql";
export const DUPLICATE_CCCD_SELF_SERVICE_MIGRATION_NAME =
  "20261023110000_hf_duplicate_cccd_self_service_actions.sql";
export const DUPLICATE_CCCD_SELF_SERVICE_RPC_SIGNATURES = Object.freeze([
  "public.direct_entry_duplicate_cccd_report(uuid, uuid, integer, integer, boolean)",
  "public.direct_entry_self_withdraw_duplicate_cccd(uuid, uuid, uuid, integer, text, text)",
]);
export const WORK_REPORTS_READER_CONTRACT_MIGRATION_NAME =
  "20261023120000_work_reports_reader_contract.sql";
export const WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES = Object.freeze([
  "public.work_report_list_readable_submissions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer)",
]);
export const ATTENDANCE_WP1_MIGRATION_NAME =
  "20261023180000_attendance_wp1_checkin_sync.sql";
export const ATTENDANCE_WP1_RPC_SIGNATURES = Object.freeze([
  "public.attendance_lookup_checkin_idempotency(uuid, uuid, uuid, text)",
  "public.attendance_record_checkin(uuid, uuid, uuid, text, double precision, double precision, double precision, text, text, timestamp with time zone, text, timestamp with time zone, bigint, text, text, text, integer, text, timestamp with time zone)",
]);
export const OFFBOARDING_REPORT_MIGRATION_NAME =
  "20261024100000_offboarding_report.sql";
export const OFFBOARDING_REPORT_RPC_SIGNATURES = Object.freeze([
  "public.direct_entry_offboarding_report(uuid, uuid, integer, integer)",
  "public.direct_entry_offboarding_report_export(uuid, uuid)",
]);
export const ATTENDANCE_ADMIN_REPORT_MIGRATION_NAME =
  "20261023223000_attendance_admin_report_and_hq_location.sql";
export const ATTENDANCE_ADMIN_REPORT_RPC_SIGNATURES = Object.freeze([
  "public.attendance_admin_report(uuid, uuid, date, date, integer, integer, text)",
  "public.attendance_set_hq_location(uuid, uuid, double precision, double precision, integer, uuid, text)",
]);
export const ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_MIGRATION_NAME =
  "20261024120000_hf_async_documents_and_attendance_photo_viewer.sql";
export const ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_RPC_SIGNATURE =
  "public.attendance_admin_checkin_photo(uuid, uuid, uuid)";
export const HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_MIGRATION_NAME =
  "20261024140000_hf_offboarding_suppression_and_attendance_employee_filter.sql";
export const HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_RPC_SIGNATURES = Object.freeze([
  "public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text)",
  "public.attendance_admin_report(uuid, uuid, date, date, integer, integer, text, uuid)",
]);
export const HF_OFFBOARDING_REPORT_QUERY_PERFORMANCE_MIGRATION_NAME =
  "20261102090000_hf_offboarding_report_query_performance.sql";
export const ATTENDANCE_SELF_HISTORY_MIGRATION_NAME =
  "20261025130000_attendance_self_history.sql";
export const ATTENDANCE_SELF_HISTORY_RPC_SIGNATURES = Object.freeze([
  "public.attendance_self_history(uuid, uuid, date, date, integer, integer)",
  "public.attendance_self_checkin_photo(uuid, uuid, uuid)",
]);
export const ORG_SHELL_01_DEPARTMENTS_MIGRATION_NAME =
  "20261025090000_org_shell_01_departments.sql";
export const ORG_SHELL_01_DEPARTMENTS_RPC_SIGNATURES = Object.freeze([
  "public.org_department_list_departments_admin(uuid, uuid)",
  "public.org_department_get_department_admin(uuid, uuid, uuid)",
  "public.org_department_list_accounting_memberships_admin(uuid, uuid, text, boolean, integer, integer)",
  "public.org_department_list_accounting_candidates_admin(uuid, uuid, text, integer, integer)",
  "public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)",
  "public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)",
  "public.org_department_list_recruitment_teams_admin(uuid, uuid, text, boolean, integer, integer)",
]);
export const VFIN_01_BACKEND_MIGRATION_NAME =
  "20261025120000_vfin_01_vendor_finance_backend.sql";
export const VFIN_01_BACKEND_RPC_SIGNATURES = Object.freeze([
  "public.vendor_finance_get_actor_access(uuid, uuid)",
  "public.vendor_finance_list_vendors(uuid, uuid, text, text, text, integer, integer)",
  "public.vendor_finance_get_vendor(uuid, uuid, text)",
  "public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer)",
  "public.vendor_finance_get_entry(uuid, uuid, uuid)",
  "public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer)",
  "public.vendor_finance_record_entry(uuid, uuid, text, text, text, date, text, uuid, text)",
  "public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)",
  "public.vendor_finance_preview_opening_batch(uuid, uuid, date, jsonb)",
  "public.vendor_finance_apply_opening_batch(uuid, uuid, date, jsonb, text, uuid, text)",
  "public.vendor_finance_create_reconciliation(uuid, uuid, text, date, text, text, uuid, text)",
  "public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)",
  "public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)",
  "public.vendor_finance_get_evidence_download(uuid, uuid, uuid)",
  "public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)",
]);
export const HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_MIGRATION_NAME =
  "20261025150000_hf_work_reports_groups_and_analytics_options.sql";
export const HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_RPC_SIGNATURES = Object.freeze([
  "public.work_report_list_groups(uuid, uuid)",
  "public.work_report_create_group(uuid, uuid, text, text, uuid[], text)",
  "public.work_report_update_group(uuid, uuid, uuid, integer, text, text, uuid[], text)",
  "public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)",
  "public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)",
  "public.work_report_analytics_filter_options(uuid, uuid)",
]);
export const VFIN_02_PROJECT_LEDGERS_MIGRATION_NAME =
  "20261026090000_vfin_02_project_accountant_ledgers.sql";
export const HF_VFIN_02_IMPLICIT_VENDOR_PROJECT_MIGRATION_NAME =
  "20261026120000_hf_vfin_02_implicit_vendor_project_eligibility.sql";
export const VFIN_02_PROJECT_LEDGERS_RPC_SIGNATURES = Object.freeze([
  "public.vendor_finance_get_actor_access(uuid, uuid)",
  "public.vendor_finance_list_actor_context_options(uuid, uuid)",
  "public.vendor_finance_list_vendors(uuid, uuid, text, text, text, text, uuid, text, integer, integer)",
  "public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text)",
  "public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text)",
  "public.vendor_finance_get_entry(uuid, uuid, uuid)",
  "public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer, text, uuid, text)",
  "public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, date, text, uuid, text)",
  "public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)",
  "public.vendor_finance_preview_opening_batch(uuid, uuid, text, date, jsonb)",
  "public.vendor_finance_apply_opening_batch(uuid, uuid, text, date, jsonb, text, uuid, text)",
  "public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, date, text, text, uuid, text)",
  "public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text)",
  "public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)",
  "public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)",
  "public.vendor_finance_get_evidence_download(uuid, uuid, uuid)",
  "public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)",
  "public.vendor_finance_list_project_accountants_admin(uuid, uuid, text, boolean, integer, integer)",
  "public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text)",
  "public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text)",
  "public.vendor_finance_list_project_vendors_admin(uuid, uuid, text, text, boolean, integer, integer)",
  "public.vendor_finance_set_project_vendor_link_admin(uuid, uuid, text, text, boolean, integer, text, uuid, text)",
  "public.vendor_finance_list_global_roles_admin(uuid, uuid, text, boolean, integer, integer)",
  "public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text)",
  "public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text)",
]);
export const HF_VFIN_02_IMPLICIT_VENDOR_PROJECT_RPC_SIGNATURES = Object.freeze(
  VFIN_02_PROJECT_LEDGERS_RPC_SIGNATURES.filter((signature) =>
    !signature.startsWith("public.vendor_finance_list_project_vendors_admin(") &&
    !signature.startsWith("public.vendor_finance_set_project_vendor_link_admin("),
  ),
);
export const CCCD_QR_ASYNC_STAGE1_MIGRATION_NAME =
  "20261026150000_cccd_qr_async_stage1.sql";
export const CCCD_QR_ASYNC_STAGE1_RPC_SIGNATURES = Object.freeze([
  "public.direct_entry_prepare_cccd_qr_extraction(uuid, uuid, uuid, uuid, text)",
  "public.direct_entry_complete_cccd_qr_extraction(uuid, uuid, uuid, uuid, text, text, text, jsonb, boolean, integer, text)",
  "public.direct_entry_get_cccd_qr_extractions(uuid, uuid, uuid, uuid)",
]);
export const PRE_WAVE2_CCCD_REVIEW_MIGRATION_NAME =
  "20261026180000_pre_wave2_cccd_reconciliation_and_review.sql";
export const PRE_WAVE2_CCCD_REVIEW_RPC_SIGNATURES = Object.freeze([
  "public.direct_entry_list_cccd_review_queue(uuid, uuid, text, integer, integer)",
  "public.direct_entry_resolve_cccd_review(uuid, uuid, uuid, integer, text, jsonb, text)",
]);
export const CCCD_REVIEW_MANUAL_RESOLUTION_MIGRATION_NAME =
  "20261026220000_hf_cccd_review_manual_resolution.sql";
export const CCCD_REVIEW_MANUAL_RESOLUTION_RPC_SIGNATURE =
  "public.direct_entry_apply_cccd_manual_resolution(uuid, uuid, uuid, integer, jsonb, text)";
export const WORK_REPORTS_ANDROID_SYNC_AND_UX_MIGRATION_NAME =
  "20261026230000_work_reports_android_sync_and_ux.sql";
export const WORK_REPORTS_ANDROID_SYNC_AND_UX_RPC_SIGNATURE =
  "public.work_report_get_assignment_detail(uuid, uuid, uuid)";
export const ADMIN_LINK_EXISTING_PERSONNEL_ACCOUNT_MIGRATION_NAME =
  "20261026233000_admin_link_existing_personnel_account.sql";
export const ADMIN_LINK_EXISTING_PERSONNEL_ACCOUNT_RPC_SIGNATURES = Object.freeze([
  "public.direct_entry_account_operation_recruiter_link_status(uuid, uuid, uuid[])",
  "public.direct_entry_account_operation_recruiter_link_candidates(uuid, uuid, uuid)",
  "public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)",
]);
export const VFIN_03_CONTRACT_TYPE_LEDGERS_MIGRATION_NAME =
  "20261027090000_vfin_03_vendor_contract_type_ledgers.sql";
export const VFIN_03_CONTRACT_TYPE_LEDGERS_RPC_SIGNATURES = Object.freeze([
  "public.vendor_finance_get_actor_access(uuid, uuid)",
  "public.vendor_finance_list_actor_context_options(uuid, uuid)",
  "public.vendor_finance_list_vendors(uuid, uuid, text, text, text, text, uuid, text, text, integer, integer)",
  "public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text, text)",
  "public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text, text)",
  "public.vendor_finance_get_entry(uuid, uuid, uuid)",
  "public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer, text, uuid, text, text)",
  "public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)",
  "public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)",
  "public.vendor_finance_preview_opening_batch(uuid, uuid, text, text, date, jsonb)",
  "public.vendor_finance_apply_opening_batch(uuid, uuid, text, text, date, jsonb, text, uuid, text)",
  "public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, text, date, text, text, uuid, text)",
  "public.vendor_finance_classify_unclassified_subledger(uuid, uuid, text, text, uuid, text, text, uuid, text)",
  "public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text, text)",
  "public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)",
  "public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)",
  "public.vendor_finance_get_evidence_download(uuid, uuid, uuid)",
  "public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)",
  "public.vendor_finance_list_project_accountants_admin(uuid, uuid, text, boolean, integer, integer)",
  "public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text)",
  "public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text)",
  "public.vendor_finance_list_global_roles_admin(uuid, uuid, text, boolean, integer, integer)",
  "public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text)",
  "public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text)",
]);
export const LEAVE_MANAGEMENT_WP1_MIGRATION_NAME =
  "20261027120000_leave_management_wp1_foundation.sql";
export const LEAVE_MANAGEMENT_WP1_RPC_SIGNATURES = Object.freeze([
  "public.leave_management_get_my_summary(uuid, uuid, integer)",
  "public.leave_management_create_request(uuid, uuid, jsonb, text, text, text)",
  "public.leave_management_withdraw_request(uuid, uuid, uuid, integer, text, text, text)",
  "public.leave_management_list_approval_inbox(uuid, uuid, text, integer, integer)",
  "public.leave_management_decide_request(uuid, uuid, uuid, text, integer, text, text, text)",
  "public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer)",
  "public.leave_management_update_policy_admin(uuid, uuid, integer, integer, integer, text, text, text)",
  "public.leave_management_upsert_employee_profile_admin(uuid, uuid, uuid, boolean, text, text, date, date, date, integer, integer, text, text, text)",
  "public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text)",
  "public.leave_management_manage_module_grant_admin(uuid, uuid, text, uuid, text, integer, text, text, text)",
  "public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb)",
  "public.leave_management_apply_opening_batch(uuid, uuid, integer, jsonb, text, text, text)",
  "public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer)",
]);
export const LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_MIGRATION_NAME =
  "20261028130000_hf_leave_admin_account_status_filter.sql";
export const LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_RPC_SIGNATURE =
  "public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text)";
export const SALARY_ADVANCE_WP1_MIGRATION_NAME =
  "20261029120000_w2s2_salary_advance_wp1.sql";
export const SALARY_ADVANCE_WP1_RPC_SIGNATURES = Object.freeze([
  "public.salary_advance_get_actor_context(uuid, uuid)",
  "public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer)",
  "public.salary_advance_list_requests(uuid, uuid, text, text, text, text, text, text, integer)",
  "public.salary_advance_get_request_detail(uuid, uuid, uuid)",
  "public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text)",
  "public.salary_advance_post_message(uuid, uuid, uuid, integer, text, text, text)",
  "public.salary_advance_transition_request(uuid, uuid, uuid, text, integer, text, text, text)",
  "public.salary_advance_reserve_evidence(uuid, uuid, uuid, integer, text, integer, text, text, text, text)",
  "public.salary_advance_get_evidence_finalize_context(uuid, uuid, uuid, uuid, integer, text, text)",
  "public.salary_advance_finalize_evidence(uuid, uuid, uuid, uuid, integer, text, text)",
  "public.salary_advance_review_evidence(uuid, uuid, uuid, integer, integer, text, uuid, integer, text, text, text)",
  "public.salary_advance_get_evidence_preview_context(uuid, uuid, uuid, integer)",
  "public.salary_advance_get_worker_portrait_context(uuid, uuid, uuid, uuid)",
]);
export const HF_SALARY_ADVANCE_ACTOR_DISPLAY_NAME_MIGRATION_NAME =
  "20261029150000_hf_salary_advance_actor_display_name.sql";
export const HF_SALARY_ADVANCE_ACTOR_DISPLAY_NAME_RPC_SIGNATURE =
  "public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text, text)";
export const HF_SALARY_ADVANCE_VENDOR_EXCLUSION_AND_WORKER_HISTORY_MIGRATION_NAME =
  "20261030150000_hf_salary_advance_vendor_exclusion_and_worker_history.sql";
export const HF_SALARY_ADVANCE_VENDOR_EXCLUSION_AND_WORKER_HISTORY_RPC_SIGNATURE =
  "public.salary_advance_list_worker_history(uuid, uuid, uuid, text, text, text, text, text, integer)";
export const HF_SALARY_ADVANCE_PM_WORKER_HISTORY_MIGRATION_NAME =
  "20261030180000_hf_salary_advance_pm_worker_history.sql";
export const HF_SALARY_ADVANCE_PM_WORKER_HISTORY_RPC_SIGNATURE =
  "public.salary_advance_list_project_worker_history(uuid, uuid, text, uuid, text, text, text, text, text, integer)";
export const T1A_HOTFIX_WORKER_DETAIL_AND_SALARY_ADVANCE_ACCESS_MIGRATION_NAME =
  "20261108140000_t1a_hotfix_worker_detail_and_salary_advance_access.sql";
export const T1A_HOTFIX_SALARY_ADVANCE_ACTOR_ACCESS_RPC_SIGNATURE =
  "public.salary_advance_get_actor_access(uuid, uuid)";
export const HF_DUPLICATE_CCCD_RESIGNED_WITHDRAW_AND_WORKER_FILTERS_MIGRATION_NAME =
  "20261031100000_hf_duplicate_cccd_resigned_withdraw_and_worker_filters.sql";
export const HF_DUPLICATE_CCCD_RESIGNED_WITHDRAW_AND_WORKER_FILTERS_RPC_SIGNATURES = Object.freeze([
  "public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer, text, date, date, text)",
  "public.direct_entry_export_workers(uuid, uuid, text, text, uuid, text, text, text, date, date, text)",
]);
export const DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_MIGRATION_NAME =
  "20261031140000_dashboard_detailed_recruitment_matrix_catalog.sql";
export const DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_RPC_SIGNATURE =
  "public.direct_entry_reporting_detailed_matrix_catalog(uuid, uuid)";
export const WORKER_EDIT_HISTORY_ADMIN_MIGRATION_NAME =
  "20261031120000_worker_edit_history_admin.sql";
export const MISSING_DOCUMENT_WORKERS_REVIEW_RPC_SIGNATURE =
  "public.direct_entry_list_missing_document_workers(uuid, uuid, text, text, text, text, integer, integer)";
export const WORKER_EDIT_HISTORY_ADMIN_RPC_SIGNATURES = Object.freeze([
  "public.worker_edit_history_search(uuid, uuid, text, text, date, date, text, text, text, integer, text)",
  "public.worker_edit_history_get_revision(uuid, uuid, uuid, uuid)",
  MISSING_DOCUMENT_WORKERS_REVIEW_RPC_SIGNATURE,
]);
export const ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_MIGRATION_NAME =
  "20261102120000_attendance_monthly_matrix_branches_and_project_coords.sql";
export const ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_RPC_SIGNATURES = Object.freeze([
  "public.attendance_list_branches_admin(uuid, uuid, boolean)",
  "public.attendance_upsert_branch_admin(uuid, uuid, uuid, text, text, text, double precision, double precision, boolean, integer, uuid, text)",
  "public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)",
  "public.attendance_unassign_employee_branch_admin(uuid, uuid, uuid, date, integer, uuid, text)",
  "public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)",
  "public.direct_entry_update_project_location(uuid, uuid, text, integer, text, numeric, numeric, integer, boolean, text, text)",
  "public.hrp_sync_catalog(uuid, uuid, uuid)",
]);
export const ATTENDANCE_SLOT_POLICY_AND_FOUR_SLOT_MATRIX_MIGRATION_NAME =
  "20261103100000_attendance_slot_policy_and_four_slot_matrix.sql";
export const ATTENDANCE_SLOT_POLICY_AND_FOUR_SLOT_MATRIX_RPC_SIGNATURES = Object.freeze([
  "public.attendance_get_slot_policies_admin(uuid, uuid)",
  "public.attendance_create_slot_policy_admin(uuid, uuid, date, text, integer, integer, text, integer, integer, text, integer, integer, text, integer, integer, integer, uuid, text)",
]);
export const ATTENDANCE_FLEXIBLE_SLOT_POLICY_MIGRATION_NAME =
  "20261103120000_attendance_flexible_slot_policy.sql";
export const ATTENDANCE_FLEXIBLE_SLOT_POLICY_RPC_SIGNATURES = Object.freeze([
  "public.attendance_create_slot_policy_admin(uuid, uuid, date, jsonb, integer, uuid, text)",
]);
export const ATTENDANCE_EXPLANATIONS_WAVE2_MIGRATION_NAME =
  "20261103150000_attendance_explanations_wave2.sql";
export const ATTENDANCE_EXPLANATIONS_WAVE2_RPC_SIGNATURES = Object.freeze([
  "public.attendance_get_my_explanations_overview(uuid, uuid, date, integer, integer)",
  "public.attendance_submit_explanation(uuid, uuid, date, text, text, text, text)",
  "public.attendance_list_explanation_approval_inbox(uuid, uuid, text, integer, integer)",
  "public.attendance_decide_explanation(uuid, uuid, uuid, text, integer, text, text, text)",
]);
export const ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_MIGRATION_NAME =
  "20261104120000_attendance_multi_slot_policy_profiles.sql";
export const ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_RPC_SIGNATURES = Object.freeze([
  "public.attendance_upsert_slot_policy_profile_admin(uuid, uuid, uuid, text, text, text, boolean, date, jsonb, integer, integer, uuid, text)",
  "public.attendance_assign_employee_slot_policy_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)",
  "public.attendance_unassign_employee_slot_policy_admin(uuid, uuid, uuid, date, integer, uuid, text)",
]);
export const WORKER_DIRECTORY_LABOR_TYPE_FILTER_MIGRATION_NAME =
  "20261106230000_worker_directory_labor_type_filter.sql";
export const WORKER_DIRECTORY_LABOR_TYPE_FILTER_RPC_SIGNATURES = Object.freeze([
  "public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer, text, date, date, text, text)",
  "public.direct_entry_export_workers(uuid, uuid, text, text, uuid, text, text, text, date, date, text, text)",
]);
export const VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME =
  "20261107120000_vfin_04_shared_vendor_advance.sql";
export const VFIN_04_SHARED_VENDOR_ADVANCE_NEW_RPC_SIGNATURES = Object.freeze([
  "public.vendor_finance_export_vendors(uuid, uuid, text, text, text, text, uuid, text, text)",
  "public.vendor_finance_list_shared_advance_movements(uuid, uuid, text, bigint, text, integer)",
  "public.vendor_finance_fund_shared_advance(uuid, uuid, text, text, date, text, uuid, text)",
  "public.vendor_finance_record_vendor_refund(uuid, uuid, text, text, date, text, uuid, text)",
  "public.vendor_finance_apply_shared_advance_offset(uuid, uuid, text, text, text, text, date, text, uuid, text)",
  "public.vendor_finance_reverse_shared_advance_movement(uuid, uuid, uuid, date, text, uuid, text)",
]);
export const VFIN_04_SHARED_VENDOR_ADVANCE_RPC_SIGNATURES = Object.freeze([
  ...VFIN_03_CONTRACT_TYPE_LEDGERS_RPC_SIGNATURES,
  ...VFIN_04_SHARED_VENDOR_ADVANCE_NEW_RPC_SIGNATURES,
]);
export const VFIN_05_COMBINED_PAYMENT_OFFSET_MIGRATION_NAME =
  "20261108090000_vfin_05_combined_payment_and_offset.sql";
export const VFIN_05_COMBINED_PAYMENT_OFFSET_NEW_RPC_SIGNATURES = Object.freeze([
  "public.vendor_finance_record_payment_with_offset(uuid, uuid, text, text, text, text, text, date, text, uuid, text)",
]);
export const VFIN_05_COMBINED_PAYMENT_OFFSET_RPC_SIGNATURES = Object.freeze([
  ...VFIN_04_SHARED_VENDOR_ADVANCE_RPC_SIGNATURES,
  ...VFIN_05_COMBINED_PAYMENT_OFFSET_NEW_RPC_SIGNATURES,
]);
export const RECRUITMENT_LOCATION_CATALOG_MIGRATION_NAME =
  "20261109200000_recruitment_location_catalog_foundation.sql";
export const RECRUITMENT_LOCATION_CATALOG_RPC_SIGNATURES = Object.freeze([
  "public.administrative_province_list_admin(uuid, uuid, text, boolean, integer, integer)",
  "public.administrative_province_create_admin(uuid, uuid, integer, text, text, text, text)",
  "public.administrative_province_update_admin(uuid, uuid, uuid, integer, text, text, text)",
  "public.administrative_province_set_active_admin(uuid, uuid, uuid, boolean, integer, text, text)",
  "public.industrial_park_list_admin(uuid, uuid, uuid, text, boolean, integer, integer)",
  "public.industrial_park_create_admin(uuid, uuid, integer, text, uuid, text, text, text)",
  "public.industrial_park_update_admin(uuid, uuid, uuid, integer, uuid, text, text, text)",
  "public.industrial_park_set_active_admin(uuid, uuid, uuid, boolean, integer, text, text)",
]);
export const RECRUITMENT_POSTS_MIGRATION_NAME =
  "20261110120000_recruitment_posts_foundation.sql";
export const RECRUITMENT_POSTS_RPC_SIGNATURES = Object.freeze([
  "public.recruitment_post_get_context(uuid, uuid)",
  "public.recruitment_post_list(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)",
  "public.recruitment_post_get(uuid, uuid, uuid)",
  "public.recruitment_post_create(uuid, uuid, jsonb, text)",
  "public.recruitment_post_update(uuid, uuid, uuid, integer, jsonb, text)",
  "public.recruitment_post_withdraw(uuid, uuid, uuid, integer, text)",
]);
export const RECRUITMENT_POST_LIST_MINE_MIGRATION_NAME =
  "20261110150000_recruitment_post_list_mine.sql";
export const RECRUITMENT_POST_LIST_MINE_RPC_SIGNATURES = Object.freeze([
  "public.recruitment_post_list_mine(uuid, uuid, text, text, integer)",
]);
export const RECRUITMENT_POST_PUBLIC_FEED_V1_MIGRATION_NAME =
  "20261111190000_recruitment_post_public_feed_v1.sql";
export const RECRUITMENT_POST_PUBLIC_FEED_V1_RPC_SIGNATURES = Object.freeze([
  "public.recruitment_post_public_feed_v1()",
]);
export const RECRUITMENT_POST_LIST_WITH_FACETS_MIGRATION_NAME =
  "20261112150000_recruitment_post_list_with_facets.sql";
export const RECRUITMENT_POST_LIST_WITH_FACETS_RPC_SIGNATURES = Object.freeze([
  "public.recruitment_post_list_with_facets(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)",
]);
export const F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES = Object.freeze([
  "public.work_report_list_templates(uuid, uuid)",
  "public.work_report_get_template(uuid, uuid, uuid)",
  "public.work_report_create_template(uuid, uuid, text, text, text, text, jsonb, jsonb, text)",
  "public.work_report_update_template_draft(uuid, uuid, uuid, uuid, integer, text, text, text, jsonb, jsonb, text)",
  "public.work_report_clone_template_draft(uuid, uuid, uuid, integer, text)",
  "public.work_report_publish_template(uuid, uuid, uuid, uuid, integer, text)",
  "public.work_report_archive_template(uuid, uuid, uuid, integer, text)",
  "public.work_report_create_assignment(uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text)",
  "public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)",
  "public.work_report_ensure_obligations_for_window(uuid, uuid, date)",
  "public.work_report_change_obligation_status(uuid, uuid, uuid, integer, text, text, timestamp with time zone, text)",
  "public.work_report_list_my_obligations(uuid, uuid, text)",
  "public.work_report_get_submission(uuid, uuid, uuid)",
  "public.work_report_save_draft(uuid, uuid, uuid, jsonb, integer, text)",
  "public.work_report_submit(uuid, uuid, uuid, jsonb, integer, text)",
]);
export const S0_T1_C_TARGET_ROUTINE_PATTERN =
  "^(direct_entry_|worker_edit_history_|work_report_|attendance_|org_department_|vendor_finance_|leave_management_|salary_advance_|hrp_sync_|ai_report_|ai_provider_config_|recruitment_|administrative_province_|industrial_park_|(expand|replace|reject|upsert)_daily_recruitment|record_recruitment_source_failure_|set_updated_at$)";

export function migrationChecksum(text) {
  // Git may materialize SQL files as CRLF on Windows even though the same
  // committed migration was applied from an LF checkout. A migration's
  // identity must not change solely because of the checkout platform.
  const normalized = text.replace(/\r\n?/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function skipSqlTrivia(sql, offset) {
  while (offset < sql.length) {
    if (/\s/.test(sql[offset])) {
      offset += 1;
    } else if (sql.startsWith("--", offset)) {
      const newline = sql.indexOf("\n", offset + 2);
      offset = newline === -1 ? sql.length : newline + 1;
    } else if (sql.startsWith("/*", offset)) {
      let depth = 1;
      offset += 2;
      while (depth > 0 && offset < sql.length) {
        if (sql.startsWith("/*", offset)) {
          depth += 1;
          offset += 2;
        } else if (sql.startsWith("*/", offset)) {
          depth -= 1;
          offset += 2;
        } else {
          offset += 1;
        }
      }
      if (depth > 0) throw new Error("Unterminated SQL block comment");
    } else {
      break;
    }
  }
  return offset;
}

function sqlKeyword(statement, offset = 0) {
  const start = skipSqlTrivia(statement, offset);
  const match = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(statement.slice(start));
  return match ? { value: match[0].toUpperCase(), end: start + match[0].length } : null;
}

function isOnlySqlKeyword(statement, expected) {
  const first = sqlKeyword(statement);
  return first?.value === expected && skipSqlTrivia(statement, first.end) === statement.length;
}

function splitTopLevelSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let offset = 0;

  while (offset < sql.length) {
    if (sql.startsWith("--", offset)) {
      const newline = sql.indexOf("\n", offset + 2);
      offset = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      offset = skipSqlTrivia(sql, offset);
      continue;
    }
    if (sql[offset] === "'") {
      const prefix = sql.slice(0, offset);
      const escapeString = /[Ee]$/.test(prefix) && !/[A-Za-z_0-9$]$/.test(prefix.slice(0, -1));
      offset += 1;
      let closed = false;
      while (offset < sql.length) {
        if (escapeString && sql[offset] === "\\") {
          offset += 2;
        } else if (sql.startsWith("''", offset)) {
          offset += 2;
        } else if (sql[offset] === "'") {
          offset += 1;
          closed = true;
          break;
        } else {
          offset += 1;
        }
      }
      if (!closed) throw new Error("Unterminated SQL string literal");
      continue;
    }
    if (sql[offset] === '"') {
      offset += 1;
      let closed = false;
      while (offset < sql.length) {
        if (sql.startsWith('""', offset)) {
          offset += 2;
        } else if (sql[offset] === '"') {
          offset += 1;
          closed = true;
          break;
        } else {
          offset += 1;
        }
      }
      if (!closed) throw new Error("Unterminated SQL quoted identifier");
      continue;
    }
    if (sql[offset] === "$") {
      const delimiter = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(offset))?.[0];
      if (delimiter) {
        const close = sql.indexOf(delimiter, offset + delimiter.length);
        if (close === -1) throw new Error("Unterminated SQL dollar-quoted body");
        offset = close + delimiter.length;
        continue;
      }
    }
    if (sql[offset] === ";") {
      statements.push({ text: sql.slice(start, offset), start, end: offset, terminated: true });
      start = offset + 1;
    }
    offset += 1;
  }

  statements.push({ text: sql.slice(start), start, end: sql.length, terminated: false });
  return statements.filter(({ text }) => sqlKeyword(text) !== null);
}

function isTransactionControl(statement) {
  const first = sqlKeyword(statement);
  if (!first) return false;
  if (["BEGIN", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE"].includes(first.value)) {
    return true;
  }
  const second = sqlKeyword(statement, first.end)?.value;
  return (first.value === "START" && second === "TRANSACTION")
    || (first.value === "PREPARE" && second === "TRANSACTION");
}

export function migrationSqlForTransaction(sql) {
  const statements = splitTopLevelSqlStatements(sql);
  const first = statements[0];
  const last = statements.at(-1);
  const hasBegin = first && isTransactionControl(first.text);
  const hasCommit = last && isTransactionControl(last.text);
  const wrapperShape = first && last && statements.length > 2
    && isOnlySqlKeyword(first.text, "BEGIN")
    && isOnlySqlKeyword(last.text, "COMMIT")
    && first.terminated && last.terminated;
  const wrapped = wrapperShape
    && !statements.slice(1, -1).some(({ text }) => isTransactionControl(text));

  if (statements.some(({ text }) => isTransactionControl(text)) && !wrapped) {
    throw new Error(hasBegin || hasCommit
      ? "Migration transaction wrapper must be exactly BEGIN; ... COMMIT;"
      : "Unsupported transaction control in migration SQL");
  }
  return wrapped
    ? sql.slice(first.end + 1, last.start + skipSqlTrivia(last.text, 0))
    : sql;
}

export async function readMigrations(directory) {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.length === 0) {
    throw new Error(`No .sql migrations found in ${directory}`);
  }
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(directory, name), "utf8");
    if (sql.trim() === "") throw new Error(`Migration is empty: ${name}`);
    try {
      migrationSqlForTransaction(sql);
    } catch (error) {
      throw new Error(`Invalid transaction wrapper in ${name}: ${error.message}`, { cause: error });
    }
    return { name, sql, checksum: migrationChecksum(sql) };
  }));
}

export function extractS0T1CAllowlistSignatures(migrationSql) {
  return [...migrationSql.matchAll(/^\s+'(public\.[^']+)'[,]?$/gm)].map(
    (match) => match[1],
  );
}

/**
 * Read-only verification of S0-T1-C security postconditions when a database ledger
 * carries the verified pre-PR #92 checksum (`7382013e...`) for migration #124.
 *
 * Uses a single SELECT statement so it works identically in read-only `--dry-run`
 * and in the apply runner without mutating any table or ledger row.
 */
export async function verifyS0T1CHistoricalCompatibility(
  client,
  migrationSql,
  { r1_2Applied = false, f1WorkReportsApplied = false, f1AssignmentOptionsApplied = false,
    f1AssignmentTrackingApplied = false, f1_5AnalyticsApplied = false,
    f2ReviewAndDelegationApplied = false, wf01WorkforceSnapshotApplied = false,
    projectTeamScopeSearchApplied = false,
    duplicateCccdSelfServiceApplied = false,
    workReportsReaderContractApplied = false,
    attendanceWp1Applied = false,
    attendanceAdminReportApplied = false,
    offboardingReportApplied = false,
    asyncDocumentsAttendancePhotoApplied = false,
    hfOffboardingSuppressionAndAttendanceFilterApplied = false,
    attendanceSelfHistoryApplied = false,
    orgShell01DepartmentsApplied = false,
    vfin01BackendApplied = false,
    hfWorkReportsGroupsAndAnalyticsOptionsApplied = false,
    vfin02ProjectLedgersApplied = false,
    hfVfin02ImplicitVendorProjectApplied = false,
    vfin03ContractTypeLedgersApplied = false,
    cccdQrAsyncStage1Applied = false,
    preWave2CccdReviewApplied = false,
    cccdReviewManualResolutionApplied = false,
    workReportsAndroidSyncAndUxApplied = false,
    adminLinkExistingPersonnelAccountApplied = false,
    leaveManagementWp1Applied = false,
    leaveAdminAccountStatusFilterApplied = false,
    salaryAdvanceWp1Applied = false,
    hfSalaryAdvanceActorDisplayNameApplied = false,
    hfSalaryAdvanceVendorExclusionAndWorkerHistoryApplied = false,
    hfSalaryAdvancePmWorkerHistoryApplied = false,
    hfDuplicateCccdResignedWithdrawAndWorkerFiltersApplied = false,
    dashboardDetailedRecruitmentMatrixCatalogApplied = false,
    workerEditHistoryAdminApplied = false,
    attendanceMonthlyMatrixBranchesProjectCoordsApplied = false,
    attendanceSlotPolicyAndFourSlotMatrixApplied = false,
    attendanceFlexibleSlotPolicyApplied = false,
    attendanceExplanationsWave2Applied = false,
    attendanceMultiSlotPolicyProfilesApplied = false,
    workerDirectoryLaborTypeFilterApplied = false,
    vfin04SharedVendorAdvanceApplied = false,
    vfin05CombinedPaymentOffsetApplied = false,
    t1aHotfixWorkerDetailAndSalaryAdvanceAccessApplied = false,
    recruitmentLocationCatalogApplied = false,
    recruitmentPostsApplied = false,
    recruitmentPostListMineApplied = false,
    recruitmentPostPublicFeedV1Applied = false,
    recruitmentPostListWithFacetsApplied = false } = {},
) {
  const baseAllowlist = extractS0T1CAllowlistSignatures(migrationSql);
  if (baseAllowlist.length === 0) {
    return {
      ok: false,
      reason: "S0-T1-C source allowlist could not be parsed",
    };
  }
  const expectedAllowlist = [
    ...baseAllowlist,
    ...(r1_2Applied ? [R1_2_SERVICE_RPC_SIGNATURE] : []),
    ...(f1WorkReportsApplied ? F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES : []),
    ...(f1AssignmentOptionsApplied ? [F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE] : []),
    ...(f1AssignmentTrackingApplied ? [F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE] : []),
    ...(f1_5AnalyticsApplied ? F1_5_WORK_REPORTS_ANALYTICS_RPC_SIGNATURES : []),
    ...(f2ReviewAndDelegationApplied ? F2_WORK_REPORTS_REVIEW_AND_DELEGATION_RPC_SIGNATURES : []),
    ...(wf01WorkforceSnapshotApplied ? [WF01_WORKFORCE_SNAPSHOT_RPC_SIGNATURE] : []),
    ...(projectTeamScopeSearchApplied ? [PROJECT_TEAM_SCOPE_SEARCH_RPC_SIGNATURE] : []),
    ...(duplicateCccdSelfServiceApplied ? DUPLICATE_CCCD_SELF_SERVICE_RPC_SIGNATURES : []),
    ...(workReportsReaderContractApplied ? WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES : []),
    ...(attendanceWp1Applied ? ATTENDANCE_WP1_RPC_SIGNATURES : []),
    ...(attendanceAdminReportApplied ? ATTENDANCE_ADMIN_REPORT_RPC_SIGNATURES : []),
    ...(offboardingReportApplied ? OFFBOARDING_REPORT_RPC_SIGNATURES : []),
    ...(asyncDocumentsAttendancePhotoApplied
      ? [ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_RPC_SIGNATURE]
      : []),
    ...(hfOffboardingSuppressionAndAttendanceFilterApplied
      ? HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_RPC_SIGNATURES
      : []),
    ...(attendanceSelfHistoryApplied ? ATTENDANCE_SELF_HISTORY_RPC_SIGNATURES : []),
    ...(orgShell01DepartmentsApplied ? ORG_SHELL_01_DEPARTMENTS_RPC_SIGNATURES : []),
    ...(vfin05CombinedPaymentOffsetApplied
      ? VFIN_05_COMBINED_PAYMENT_OFFSET_RPC_SIGNATURES
      : vfin04SharedVendorAdvanceApplied
        ? VFIN_04_SHARED_VENDOR_ADVANCE_RPC_SIGNATURES
        : vfin03ContractTypeLedgersApplied
          ? VFIN_03_CONTRACT_TYPE_LEDGERS_RPC_SIGNATURES
          : hfVfin02ImplicitVendorProjectApplied
            ? HF_VFIN_02_IMPLICIT_VENDOR_PROJECT_RPC_SIGNATURES
            : vfin02ProjectLedgersApplied
              ? VFIN_02_PROJECT_LEDGERS_RPC_SIGNATURES
            : vfin01BackendApplied
              ? VFIN_01_BACKEND_RPC_SIGNATURES
              : []),
    ...(hfWorkReportsGroupsAndAnalyticsOptionsApplied
      ? HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_RPC_SIGNATURES
      : []),
    ...(cccdQrAsyncStage1Applied
      ? CCCD_QR_ASYNC_STAGE1_RPC_SIGNATURES
      : []),
    ...(preWave2CccdReviewApplied
      ? PRE_WAVE2_CCCD_REVIEW_RPC_SIGNATURES
      : []),
    ...(cccdReviewManualResolutionApplied
      ? [CCCD_REVIEW_MANUAL_RESOLUTION_RPC_SIGNATURE]
      : []),
    ...(workReportsAndroidSyncAndUxApplied
      ? [WORK_REPORTS_ANDROID_SYNC_AND_UX_RPC_SIGNATURE]
      : []),
    ...(adminLinkExistingPersonnelAccountApplied
      ? ADMIN_LINK_EXISTING_PERSONNEL_ACCOUNT_RPC_SIGNATURES
      : []),
    ...(leaveManagementWp1Applied
      ? LEAVE_MANAGEMENT_WP1_RPC_SIGNATURES
      : []),
    ...(leaveAdminAccountStatusFilterApplied
      ? [LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_RPC_SIGNATURE]
      : []),
    ...(salaryAdvanceWp1Applied
      ? SALARY_ADVANCE_WP1_RPC_SIGNATURES
      : []),
    ...(hfSalaryAdvanceActorDisplayNameApplied
      ? [HF_SALARY_ADVANCE_ACTOR_DISPLAY_NAME_RPC_SIGNATURE]
      : []),
    ...(hfSalaryAdvanceVendorExclusionAndWorkerHistoryApplied
      ? [HF_SALARY_ADVANCE_VENDOR_EXCLUSION_AND_WORKER_HISTORY_RPC_SIGNATURE]
      : []),
    ...(hfSalaryAdvancePmWorkerHistoryApplied
      ? [HF_SALARY_ADVANCE_PM_WORKER_HISTORY_RPC_SIGNATURE]
      : []),
    ...(t1aHotfixWorkerDetailAndSalaryAdvanceAccessApplied
      ? [T1A_HOTFIX_SALARY_ADVANCE_ACTOR_ACCESS_RPC_SIGNATURE]
      : []),
    ...(hfDuplicateCccdResignedWithdrawAndWorkerFiltersApplied
      ? HF_DUPLICATE_CCCD_RESIGNED_WITHDRAW_AND_WORKER_FILTERS_RPC_SIGNATURES
      : []),
    ...(dashboardDetailedRecruitmentMatrixCatalogApplied
      ? [DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_RPC_SIGNATURE]
      : []),
    ...(workerEditHistoryAdminApplied ? WORKER_EDIT_HISTORY_ADMIN_RPC_SIGNATURES : []),
    ...(attendanceMonthlyMatrixBranchesProjectCoordsApplied
      ? ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_RPC_SIGNATURES
      : []),
    ...(attendanceSlotPolicyAndFourSlotMatrixApplied
      ? ATTENDANCE_SLOT_POLICY_AND_FOUR_SLOT_MATRIX_RPC_SIGNATURES
      : []),
    ...(attendanceFlexibleSlotPolicyApplied
      ? ATTENDANCE_FLEXIBLE_SLOT_POLICY_RPC_SIGNATURES
      : []),
    ...(attendanceExplanationsWave2Applied
      ? ATTENDANCE_EXPLANATIONS_WAVE2_RPC_SIGNATURES
      : []),
    ...(attendanceMultiSlotPolicyProfilesApplied
      ? ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_RPC_SIGNATURES
      : []),
    ...(workerDirectoryLaborTypeFilterApplied
      ? WORKER_DIRECTORY_LABOR_TYPE_FILTER_RPC_SIGNATURES
      : []),
    ...(recruitmentLocationCatalogApplied
      ? RECRUITMENT_LOCATION_CATALOG_RPC_SIGNATURES
      : []),
    ...(recruitmentPostsApplied
      ? RECRUITMENT_POSTS_RPC_SIGNATURES
      : []),
    ...(recruitmentPostListMineApplied
      ? RECRUITMENT_POST_LIST_MINE_RPC_SIGNATURES
      : []),
    ...(recruitmentPostPublicFeedV1Applied
      ? RECRUITMENT_POST_PUBLIC_FEED_V1_RPC_SIGNATURES
      : []),
    ...(recruitmentPostListWithFacetsApplied
      ? RECRUITMENT_POST_LIST_WITH_FACETS_RPC_SIGNATURES
      : []),
  ];

  const { rows } = await client.query(
    `select
       (select count(*)::integer
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prokind in ('f', 'p')
           and p.proname ~ $1
           and (
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
             or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
             or exists (
               select 1
                 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE'
             )
           )
       ) as exposed_client_or_public_count,
       (select coalesce(
                 array_agg(p.oid::pg_catalog.regprocedure::text order by p.oid::pg_catalog.regprocedure::text),
                 array[]::text[]
               )
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prokind in ('f', 'p')
           and p.proname ~ $1
           and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
       ) as actual_service_signatures,
       (select coalesce(
                 array_agg(
                   pg_catalog.to_regprocedure(u.sig)::pg_catalog.regprocedure::text
                   order by pg_catalog.to_regprocedure(u.sig)::pg_catalog.regprocedure::text
                 ),
                 array[]::text[]
               )
          from unnest($2::text[]) as u(sig)
         where pg_catalog.to_regprocedure(u.sig) is not null
       ) as expected_service_signatures,
       (select count(*)::integer
          from unnest($2::text[]) as u(sig)
         where pg_catalog.to_regprocedure(u.sig) is null
       ) as missing_allowlist_count,
       (select count(*)::integer
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prokind in ('f', 'p')
           and p.proname ~ $1
           and not pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE')
       ) as missing_owner_exec_count,
       (select count(*)::integer
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prokind in ('f', 'p')
           and p.proname ~ '^(direct_entry_|worker_edit_history_|attendance_|org_department_|vendor_finance_|leave_management_|salary_advance_|recruitment_location_|recruitment_post_|administrative_province_|industrial_park_|hrp_sync_)'
           and p.prosecdef
           and not coalesce(
             'search_path=pg_catalog, public' = any(p.proconfig)
             or 'search_path=pg_catalog' = any(p.proconfig),
             false
           )
       ) as unsafe_secdef_search_path_count,
       (select coalesce(
                 bool_and(
                   r.rolname = 'direct_entry_catalog_bootstrap_executor'
                   and p.prosecdef
                   and coalesce('search_path=pg_catalog, public' = any(p.proconfig), false)
                   and pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor', p.oid, 'EXECUTE')
                 ),
                 false
               )
               and count(*) = 3
               and pg_catalog.has_function_privilege(
                 'service_role',
                 'public.direct_entry_catalog_bootstrap_plan(uuid, uuid)'::pg_catalog.regprocedure,
                 'EXECUTE'
               )
               and pg_catalog.has_function_privilege(
                 'service_role',
                 'public.direct_entry_apply_catalog_bootstrap(uuid, uuid, text, text, text)'::pg_catalog.regprocedure,
                 'EXECUTE'
               )
               and not pg_catalog.has_function_privilege(
                 'service_role',
                 'public.direct_entry_catalog_bootstrap_projection()'::pg_catalog.regprocedure,
                 'EXECUTE'
               )
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          join pg_catalog.pg_roles r on r.oid = p.proowner
         where n.nspname = 'public'
           and p.oid in (
             'public.direct_entry_catalog_bootstrap_plan(uuid, uuid)'::pg_catalog.regprocedure,
             'public.direct_entry_apply_catalog_bootstrap(uuid, uuid, text, text, text)'::pg_catalog.regprocedure,
             'public.direct_entry_catalog_bootstrap_projection()'::pg_catalog.regprocedure
           )
       ) as bootstrap_executor_intact`,
    [S0_T1_C_TARGET_ROUTINE_PATTERN, expectedAllowlist],
  );

  const row = rows[0];
  if (!row) {
    return { ok: false, reason: "S0-T1-C postcondition query returned no row" };
  }
  if (row.exposed_client_or_public_count !== 0) {
    return {
      ok: false,
      reason: `S0-T1-C postcondition failed: ${row.exposed_client_or_public_count} routine(s) exposed to anon/authenticated/PUBLIC`,
    };
  }
  if (row.missing_allowlist_count !== 0) {
    return {
      ok: false,
      reason: `S0-T1-C postcondition failed: ${row.missing_allowlist_count} allowlisted signature(s) missing`,
    };
  }
  const actualService = Array.isArray(row.actual_service_signatures)
    ? row.actual_service_signatures
    : [];
  const expectedService = Array.isArray(row.expected_service_signatures)
    ? row.expected_service_signatures
    : [];
  if (
    actualService.length !== expectedService.length ||
    actualService.some((sig, idx) => sig !== expectedService[idx])
  ) {
    return {
      ok: false,
      reason: "S0-T1-C postcondition failed: service_role EXECUTE set does not match allowlist",
    };
  }
  if (row.missing_owner_exec_count !== 0) {
    return {
      ok: false,
      reason: `S0-T1-C postcondition failed: ${row.missing_owner_exec_count} routine(s) missing owner EXECUTE`,
    };
  }
  if (row.unsafe_secdef_search_path_count !== 0) {
    return {
      ok: false,
      reason: `S0-T1-C postcondition failed: ${row.unsafe_secdef_search_path_count} SECURITY DEFINER routine(s) missing locked search_path`,
    };
  }
  if (row.bootstrap_executor_intact !== true) {
    return {
      ok: false,
      reason: "S0-T1-C postcondition failed: catalog bootstrap executor ownership/ACL/SECURITY DEFINER mismatch",
    };
  }
  return { ok: true };
}

/**
 * Shared checksum verification used identically by `--dry-run` validation and
 * the migration apply runner.
 *
 * Returns:
 *   - `{ status: "match" }` when `appliedChecksum === migration.checksum`
 *   - `{ status: "compatible_historical" }` ONLY when `migration.name` is `#124`
 *     (`20261020180000_s0_t1_c_rpc_acl_allowlist.sql`), `migration.checksum` is
 *     `S0_T1_C_CURRENT_CHECKSUM`, `appliedChecksum` is `S0_T1_C_PRE_PR92_CHECKSUM`,
 *     and all S0-T1-C security postconditions pass in the database
 *   - `{ status: "mismatch", reason }` for any other mismatch (fail-closed)
 */
export async function verifyAppliedMigrationChecksum(
  client,
  migration,
  appliedChecksum,
  appliedMap,
) {
  if (appliedChecksum === migration.checksum) {
    return { status: "match" };
  }
  if (
    migration.name === S0_T1_C_MIGRATION_NAME &&
    migration.checksum === S0_T1_C_CURRENT_CHECKSUM &&
    appliedChecksum === S0_T1_C_PRE_PR92_CHECKSUM
  ) {
    const postconditions = await verifyS0T1CHistoricalCompatibility(
      client,
      migration.sql,
      {
        r1_2Applied: appliedMap.has(R1_2_MIGRATION_NAME),
        f1WorkReportsApplied: appliedMap.has(F1_WORK_REPORTS_MIGRATION_NAME),
        f1AssignmentOptionsApplied: appliedMap.has(F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_MIGRATION_NAME),
        f1AssignmentTrackingApplied: appliedMap.has(F1_WORK_REPORTS_ASSIGNMENT_TRACKING_MIGRATION_NAME),
        f1_5AnalyticsApplied: appliedMap.has(F1_5_WORK_REPORTS_ANALYTICS_MIGRATION_NAME),
        f2ReviewAndDelegationApplied: appliedMap.has(F2_WORK_REPORTS_REVIEW_AND_DELEGATION_MIGRATION_NAME),
        wf01WorkforceSnapshotApplied:
          appliedMap.has(WF01_WORKFORCE_SNAPSHOT_MIGRATION_NAME) ||
          appliedMap.has(WF02_WORKFORCE_BALANCE_WAITING_MIGRATION_NAME) ||
          appliedMap.has(WF03_WORKFORCE_TENURE_RETENTION_MIGRATION_NAME),
        projectTeamScopeSearchApplied:
          appliedMap.has(PROJECT_TEAM_SCOPE_SEARCH_MIGRATION_NAME),
        duplicateCccdSelfServiceApplied:
          appliedMap.has(DUPLICATE_CCCD_SELF_SERVICE_MIGRATION_NAME),
        workReportsReaderContractApplied:
          appliedMap.has(WORK_REPORTS_READER_CONTRACT_MIGRATION_NAME),
        attendanceWp1Applied:
          appliedMap.has(ATTENDANCE_WP1_MIGRATION_NAME),
        attendanceAdminReportApplied:
          appliedMap.has(ATTENDANCE_ADMIN_REPORT_MIGRATION_NAME),
        offboardingReportApplied:
          appliedMap.has(OFFBOARDING_REPORT_MIGRATION_NAME),
        asyncDocumentsAttendancePhotoApplied:
          appliedMap.has(ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_MIGRATION_NAME),
        hfOffboardingSuppressionAndAttendanceFilterApplied:
          appliedMap.has(HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_MIGRATION_NAME),
        attendanceSelfHistoryApplied:
          appliedMap.has(ATTENDANCE_SELF_HISTORY_MIGRATION_NAME),
        orgShell01DepartmentsApplied:
          appliedMap.has(ORG_SHELL_01_DEPARTMENTS_MIGRATION_NAME),
        vfin01BackendApplied:
          appliedMap.has(VFIN_01_BACKEND_MIGRATION_NAME),
        hfWorkReportsGroupsAndAnalyticsOptionsApplied:
          appliedMap.has(HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_MIGRATION_NAME),
        vfin02ProjectLedgersApplied:
          appliedMap.has(VFIN_02_PROJECT_LEDGERS_MIGRATION_NAME),
        hfVfin02ImplicitVendorProjectApplied:
          appliedMap.has(HF_VFIN_02_IMPLICIT_VENDOR_PROJECT_MIGRATION_NAME),
        vfin03ContractTypeLedgersApplied:
          appliedMap.has(VFIN_03_CONTRACT_TYPE_LEDGERS_MIGRATION_NAME),
        cccdQrAsyncStage1Applied:
          appliedMap.has(CCCD_QR_ASYNC_STAGE1_MIGRATION_NAME),
        preWave2CccdReviewApplied:
          appliedMap.has(PRE_WAVE2_CCCD_REVIEW_MIGRATION_NAME),
        cccdReviewManualResolutionApplied:
          appliedMap.has(CCCD_REVIEW_MANUAL_RESOLUTION_MIGRATION_NAME),
        workReportsAndroidSyncAndUxApplied:
          appliedMap.has(WORK_REPORTS_ANDROID_SYNC_AND_UX_MIGRATION_NAME),
        adminLinkExistingPersonnelAccountApplied:
          appliedMap.has(ADMIN_LINK_EXISTING_PERSONNEL_ACCOUNT_MIGRATION_NAME),
        leaveManagementWp1Applied:
          appliedMap.has(LEAVE_MANAGEMENT_WP1_MIGRATION_NAME),
        leaveAdminAccountStatusFilterApplied:
          appliedMap.has(LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_MIGRATION_NAME),
        salaryAdvanceWp1Applied:
          appliedMap.has(SALARY_ADVANCE_WP1_MIGRATION_NAME),
        hfSalaryAdvanceActorDisplayNameApplied:
          appliedMap.has(HF_SALARY_ADVANCE_ACTOR_DISPLAY_NAME_MIGRATION_NAME),
        hfSalaryAdvanceVendorExclusionAndWorkerHistoryApplied:
          appliedMap.has(HF_SALARY_ADVANCE_VENDOR_EXCLUSION_AND_WORKER_HISTORY_MIGRATION_NAME),
        hfSalaryAdvancePmWorkerHistoryApplied:
          appliedMap.has(HF_SALARY_ADVANCE_PM_WORKER_HISTORY_MIGRATION_NAME),
        hfDuplicateCccdResignedWithdrawAndWorkerFiltersApplied:
          appliedMap.has(HF_DUPLICATE_CCCD_RESIGNED_WITHDRAW_AND_WORKER_FILTERS_MIGRATION_NAME),
        dashboardDetailedRecruitmentMatrixCatalogApplied:
          appliedMap.has(DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_MIGRATION_NAME),
        workerEditHistoryAdminApplied:
          appliedMap.has(WORKER_EDIT_HISTORY_ADMIN_MIGRATION_NAME),
        attendanceMonthlyMatrixBranchesProjectCoordsApplied:
          appliedMap.has(ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_MIGRATION_NAME),
        attendanceSlotPolicyAndFourSlotMatrixApplied:
          appliedMap.has(ATTENDANCE_SLOT_POLICY_AND_FOUR_SLOT_MATRIX_MIGRATION_NAME),
        attendanceFlexibleSlotPolicyApplied:
          appliedMap.has(ATTENDANCE_FLEXIBLE_SLOT_POLICY_MIGRATION_NAME),
        attendanceExplanationsWave2Applied:
          appliedMap.has(ATTENDANCE_EXPLANATIONS_WAVE2_MIGRATION_NAME),
        attendanceMultiSlotPolicyProfilesApplied:
          appliedMap.has(ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_MIGRATION_NAME),
        workerDirectoryLaborTypeFilterApplied:
          appliedMap.has(WORKER_DIRECTORY_LABOR_TYPE_FILTER_MIGRATION_NAME),
        vfin04SharedVendorAdvanceApplied:
          appliedMap.has(VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME),
        vfin05CombinedPaymentOffsetApplied:
          appliedMap.has(VFIN_05_COMBINED_PAYMENT_OFFSET_MIGRATION_NAME),
        t1aHotfixWorkerDetailAndSalaryAdvanceAccessApplied:
          appliedMap.has(T1A_HOTFIX_WORKER_DETAIL_AND_SALARY_ADVANCE_ACCESS_MIGRATION_NAME),
        recruitmentLocationCatalogApplied:
          appliedMap.has(RECRUITMENT_LOCATION_CATALOG_MIGRATION_NAME),
        recruitmentPostsApplied:
          appliedMap.has(RECRUITMENT_POSTS_MIGRATION_NAME),
        recruitmentPostListMineApplied:
          appliedMap.has(RECRUITMENT_POST_LIST_MINE_MIGRATION_NAME),
        recruitmentPostPublicFeedV1Applied:
          appliedMap.has(RECRUITMENT_POST_PUBLIC_FEED_V1_MIGRATION_NAME),
        recruitmentPostListWithFacetsApplied:
          appliedMap.has(RECRUITMENT_POST_LIST_WITH_FACETS_MIGRATION_NAME),
      },
    );
    if (postconditions.ok) {
      return { status: "compatible_historical" };
    }
    return {
      status: "mismatch",
      reason: postconditions.reason,
    };
  }
  return {
    status: "mismatch",
    reason: "unrecognized checksum mismatch",
  };
}

export async function runMigrationValidation({
  mode,
  directory,
  loadConfig,
  createClient,
  log = console.log,
}) {
  const migrations = await readMigrations(directory);
  if (mode === "offline") {
    log("OFFLINE VALIDATION (applied/pending status was not checked)");
    for (const migration of migrations) log(`VALID  ${migration.name}`);
    log(`\nOffline validation complete: ${migrations.length} migration(s); no database access.`);
    return { migrations, mismatches: [] };
  }

  if (mode !== "dry-run") throw new Error(`Unsupported validation mode: ${mode}`);

  const { databaseUrl } = await loadConfig();
  const client = createClient(databaseUrl);
  await client.connect();
  try {
    const { rows: tables } = await client.query(
      "select to_regclass('public.schema_migrations') is not null as exists"
    );

    let applied = new Map();
    if (tables[0]?.exists === true) {
      const { rows } = await client.query(
        "select version, checksum from public.schema_migrations"
      );
      applied = new Map(rows.map((row) => [row.version, row.checksum]));
    } else {
      log("schema_migrations table does not exist; no table was created.");
    }

    const mismatches = [];
    for (const migration of migrations) {
      const previous = applied.get(migration.name);
      if (previous === undefined) {
        log(`PENDING ${migration.name}`);
        continue;
      }
      const check = await verifyAppliedMigrationChecksum(
        client,
        migration,
        previous,
        applied,
      );
      if (check.status === "match") {
        log(`APPLIED ${migration.name} (checksum matches)`);
      } else if (check.status === "compatible_historical") {
        log(
          `APPLIED ${migration.name} (verified pre-PR #92 historical checksum compatibility)`,
        );
      } else {
        log(
          `CHECKSUM MISMATCH ${migration.name}${check.reason ? ` (${check.reason})` : ""}`,
        );
        mismatches.push(migration.name);
      }
    }
    log(`\nDB-aware dry-run: ${migrations.length} migration(s); read-only.`);
    return { migrations, mismatches };
  } finally {
    await client.end();
  }
}

export async function runMigrationApply({
  directory,
  loadConfig,
  createClient,
  log = console.log,
  errorLog = console.error,
}) {
  const migrations = await readMigrations(directory);
  const { databaseUrl, projectRef = "local", usesPooler = false } = await loadConfig();
  const client = createClient(databaseUrl);
  await client.connect();
  log(
    `Kết nối DB thành công (project ref: ${String(projectRef).slice(0, 4)}***, pooler: ${usesPooler ? "có" : "không"})`,
  );

  await client.query(`
    create table if not exists public.schema_migrations (
      version     text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);

  const { rows: applied } = await client.query(
    "select version, checksum from public.schema_migrations",
  );
  const appliedMap = new Map(applied.map((r) => [r.version, r.checksum]));

  let appliedCount = 0;
  let skippedCount = 0;

  for (const migration of migrations) {
    const previous = appliedMap.get(migration.name);

    if (previous !== undefined) {
      const check = await verifyAppliedMigrationChecksum(
        client,
        migration,
        previous,
        appliedMap,
      );
      if (check.status === "mismatch") {
        await client.end();
        throw new Error(
          `Migration ${migration.name} đã áp dụng nhưng nội dung đã thay đổi (checksum mismatch${check.reason ? `: ${check.reason}` : ""}). ` +
            "Không sửa file migration đã áp dụng — hãy tạo file migration mới.",
        );
      }
      if (check.status === "compatible_historical") {
        log(
          `SKIP    ${migration.name} (đã áp dụng — tương thích checksum lịch sử trước PR #92 đã xác minh postconditions)`,
        );
      } else {
        log(`SKIP    ${migration.name} (đã áp dụng)`);
      }
      skippedCount += 1;
      continue;
    }

    try {
      await client.query("begin");
      await client.query(migrationSqlForTransaction(migration.sql));
      await client.query(
        "insert into public.schema_migrations (version, checksum) values ($1, $2)",
        [migration.name, migration.checksum],
      );
      await client.query("commit");
      appliedMap.set(migration.name, migration.checksum);
      log(`APPLY   ${migration.name}`);
      appliedCount += 1;
    } catch (error) {
      try {
        await client.query("rollback");
      } finally {
        await client.end();
      }
      errorLog(`FAILED  ${migration.name}: ${error.message}`);
      throw error;
    }
  }

  log(
    `\nKết quả: ${appliedCount} áp dụng mới, ${skippedCount} bỏ qua, ${migrations.length} tổng.`,
  );

  const { rows: tables } = await client.query(`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('data_sources', 'sync_runs', 'daily_recruitment_breakdown', 'sync_errors')
     order by table_name
  `);
  log(
    "Bảng hiện có: " +
      (tables.map((r) => r.table_name).join(", ") || "(không có)"),
  );

  await client.end();
  return { appliedCount, skippedCount, totalCount: migrations.length };
}
