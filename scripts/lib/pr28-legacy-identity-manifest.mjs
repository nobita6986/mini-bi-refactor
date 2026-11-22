import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normUuid(v) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim().toLowerCase();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function quoteIdent(ident) {
  return `"${String(ident).replaceAll('"', '""')}"`;
}

/**
 * Strictly read-only preflight manifest builder for PR #28 Rev 4.1 / D5(2).
 *
 * Identifies legacy technical / non-employee identity candidates ONLY from verified
 * bindings (N8N_BOD_READONLY_AUTH_SUBJECT, N8N_BOD_READONLY_APP_USER_ID,
 * HRP_SYNC_AUTH_SUBJECT) and explicit legacy DB flags (account_type IN ('SHARED','SERVICE')
 * or leave_employee_profiles.is_shared_non_employee = true). NEVER guesses from name/login/email.
 *
 * Dynamically scans ALL FK constraints referencing direct_entry_app_users(app_user_id) and
 * auth.users(id), explicitly separates ON DELETE CASCADE hazards, checks both non-FK audit
 * columns (direct_entry_audit_events.auth_subject, authz_audit_events.actor_auth_subject),
 * and classifies every candidate with deterministic SHA-256 fingerprint.
 */
export async function buildLegacyTechnicalIdentityManifest(client, bindings = {}) {
  const n8nAuthSubject = normUuid(bindings.n8nAuthSubject ?? null);
  const n8nAppUserId = normUuid(bindings.n8nAppUserId ?? null);
  const hrpAuthSubject = normUuid(bindings.hrpAuthSubject ?? null);

  const bindingAuthSubjects = [...new Set([n8nAuthSubject, hrpAuthSubject].filter(Boolean))].sort();
  const bindingAppUserIds = [...new Set([n8nAppUserId].filter(Boolean))].sort();

  const { rows: colChecks } = await client.query(`
    select
      exists (
        select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'direct_entry_app_users'
           and column_name = 'account_type'
      ) as has_account_type,
      exists (
        select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'leave_employee_profiles'
           and column_name = 'is_shared_non_employee'
      ) as has_is_shared_flag,
      exists (
        select 1 from information_schema.tables
         where table_schema = 'public'
           and table_name = 'authz_user_group_members'
      ) as has_group_members
  `);

  const hasAccountType = Boolean(colChecks[0]?.has_account_type);
  const hasIsSharedFlag = Boolean(colChecks[0]?.has_is_shared_flag);
  const hasGroupMembers = Boolean(colChecks[0]?.has_group_members);

  // Discover all active FK columns pointing to public.direct_entry_app_users or auth.users
  const { rows: fkRows } = await client.query(`
    select
      ns.nspname as table_schema,
      cls.relname as table_name,
      att.attname as column_name,
      ref_ns.nspname || '.' || ref_cls.relname as target_table,
      con.confdeltype::text as delete_action
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class cls on cls.oid = con.conrelid
    join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
    join pg_catalog.pg_class ref_cls on ref_cls.oid = con.confrelid
    join pg_catalog.pg_namespace ref_ns on ref_ns.oid = ref_cls.relnamespace
    join unnest(con.conkey) with ordinality as ck(attnum, ord) on true
    join pg_catalog.pg_attribute att on att.attrelid = cls.oid and att.attnum = ck.attnum
    where con.contype = 'f'
      and ns.nspname = 'public'
      and (
        (ref_ns.nspname = 'public' and ref_cls.relname = 'direct_entry_app_users')
        or (ref_ns.nspname = 'auth' and ref_cls.relname = 'users')
      )
    order by ns.nspname, cls.relname, att.attname
  `);

  // Collect candidate app_users from bindings + explicit DB columns
  const accountTypeExpr = hasAccountType ? "u.account_type" : "'NORMAL'::text";
  const sharedFlagExpr = hasIsSharedFlag ? "coalesce(lp.is_shared_non_employee, false)" : "false";
  const whereClauses = [];
  const params = [];
  if (hasAccountType) whereClauses.push("u.account_type in ('SHARED', 'SERVICE')");
  if (hasIsSharedFlag) whereClauses.push("coalesce(lp.is_shared_non_employee, false) = true");
  if (bindingAuthSubjects.length > 0) {
    params.push(bindingAuthSubjects);
    whereClauses.push(`u.auth_subject = any($${params.length}::uuid[])`);
  }
  if (bindingAppUserIds.length > 0) {
    params.push(bindingAppUserIds);
    whereClauses.push(`u.app_user_id = any($${params.length}::uuid[])`);
  }

  let candidateUsers = [];
  if (whereClauses.length > 0) {
    const { rows } = await client.query(
      `select
         u.app_user_id,
         u.auth_subject,
         u.display_name,
         u.enabled,
         u.authz_managed,
         u.version,
         ${accountTypeExpr} as account_type,
         ${sharedFlagExpr} as is_shared_non_employee,
         (au.id is not null) as auth_user_exists
       from public.direct_entry_app_users u
       left join public.leave_employee_profiles lp on lp.app_user_id = u.app_user_id
       left join auth.users au on au.id = u.auth_subject
       where ${whereClauses.join(" or ")}
       order by u.app_user_id asc`,
      params,
    );
    candidateUsers = rows;
  }

  // Also detect orphan auth.users matching bindings with no direct_entry_app_users row
  const orphanAuthBindings = [];
  for (const sub of bindingAuthSubjects) {
    const matched = candidateUsers.some((u) => u.auth_subject?.toLowerCase() === sub);
    if (!matched) {
      const { rows } = await client.query(`select id from auth.users where id = $1::uuid`, [sub]);
      if (rows.length > 0) {
        orphanAuthBindings.push({
          auth_subject: sub,
          source: sub === n8nAuthSubject ? "N8N_BOD_READONLY_AUTH_SUBJECT" : "HRP_SYNC_AUTH_SUBJECT",
        });
      }
    }
  }

  const candidates = [];
  let unresolvedLegacyAccountTypeCount = 0;
  let unresolvedLegacySharedProfileCount = 0;

  for (const u of candidateUsers) {
    const appUserId = u.app_user_id.toLowerCase();
    const authSubject = u.auth_subject ? u.auth_subject.toLowerCase() : null;
    const sources = [];
    if (u.account_type === "SERVICE") sources.push("DB_ACCOUNT_TYPE_SERVICE");
    if (u.account_type === "SHARED") sources.push("DB_ACCOUNT_TYPE_SHARED");
    if (u.is_shared_non_employee) sources.push("DB_LEAVE_PROFILE_SHARED_FLAG");
    if (authSubject && authSubject === n8nAuthSubject) sources.push("BINDING_N8N_AUTH_SUBJECT");
    if (appUserId === n8nAppUserId) sources.push("BINDING_N8N_APP_USER_ID");
    if (authSubject && authSubject === hrpAuthSubject) sources.push("BINDING_HRP_AUTH_SUBJECT");

    if (u.account_type === "SERVICE" || u.account_type === "SHARED") unresolvedLegacyAccountTypeCount += 1;
    if (u.is_shared_non_employee) unresolvedLegacySharedProfileCount += 1;

    // Check human contamination, protected Owner status, unresolved intents, and grants
    const { rows: flagsRows } = await client.query(
      `select
         exists (
           select 1 from public.authz_account_role_assignments
            where app_user_id = $1::uuid and is_protected = true and ended_at is null
         ) as protected_role_owner,
         ${hasGroupMembers ? `exists (
           select 1 from public.authz_user_group_members
            where app_user_id = $1::uuid and is_protected = true and ended_at is null
         )` : "false"} as protected_group_owner,
         (select count(*)::int from public.organization_account_person_links where app_user_id = $1::uuid) as person_link_total,
         (select count(*)::int from public.organization_account_person_links where app_user_id = $1::uuid and ended_at is null) as person_link_open,
         (select count(*)::int from public.direct_entry_app_user_recruiter_links where app_user_id = $1::uuid) as recruiter_link_total,
         (select count(*)::int from public.direct_entry_team_leader_assignments where leader_app_user_id = $1::uuid) as team_leader_total,
         (select count(*)::int from public.vendor_finance_project_accountants where accountant_user_id = $1::uuid) as project_accountant_total,
         (select count(*)::int from public.leave_department_approvers where approver_app_user_id = $1::uuid) as leave_approver_total,
         (select count(*)::int from public.organization_department_memberships where app_user_id = $1::uuid) as dept_membership_total,
         (select count(*)::int from public.authz_account_role_assignments where app_user_id = $1::uuid and ended_at is null) as open_role_assignments,
         (select count(*)::int from public.authz_direct_capability_grants where app_user_id = $1::uuid and ended_at is null) as open_direct_grants,
         (select count(*)::int from public.direct_entry_account_operation_intents
           where (account_ref = $1::uuid or ($2::uuid is not null and auth_subject = $2::uuid))
             and state in ('PENDING', 'IN_FLIGHT', 'INDETERMINATE', 'BLOCKED', 'CONFLICT')
         ) as unresolved_intent_count,
         (select count(*)::int from public.direct_entry_audit_events where $2::uuid is not null and auth_subject = $2::uuid) as non_fk_direct_entry_audit_refs,
         (select count(*)::int from public.authz_audit_events where $2::uuid is not null and actor_auth_subject = $2::uuid) as non_fk_authz_audit_refs`,
      [appUserId, authSubject],
    );
    const f = flagsRows[0];

    // Scan ALL active FK referencing tables dynamically
    const restrictOrNoActionRefs = {};
    const cascadeHazardRefs = {};
    let totalRestrictRefs = 0;
    let totalCascadeRefs = 0;

    for (const fk of fkRows) {
      if (fk.table_schema === "public" && fk.table_name === "direct_entry_app_users") continue;
      const key = `${fk.table_schema}.${fk.table_name}.${fk.column_name}`;
      const lookupId = fk.target_table === "auth.users" ? authSubject : appUserId;
      if (!lookupId) continue;
      const { rows: cntRows } = await client.query(
        `select count(*)::int as cnt from ${quoteIdent(fk.table_schema)}.${quoteIdent(fk.table_name)} where ${quoteIdent(fk.column_name)} = $1::uuid`,
        [lookupId],
      );
      const cnt = cntRows[0]?.cnt ?? 0;
      if (cnt > 0) {
        if (fk.delete_action === "c") {
          cascadeHazardRefs[key] = cnt;
          totalCascadeRefs += cnt;
        } else {
          restrictOrNoActionRefs[key] = cnt;
          totalRestrictRefs += cnt;
        }
      }
    }

    const totalNonFkAuditRefs = (f.non_fk_direct_entry_audit_refs ?? 0) + (f.non_fk_authz_audit_refs ?? 0);
    const hasProtectedOwner = Boolean(f.protected_role_owner || f.protected_group_owner);
    const hasHumanContamination =
      f.person_link_total > 0 ||
      f.recruiter_link_total > 0 ||
      f.team_leader_total > 0 ||
      f.project_accountant_total > 0 ||
      f.leave_approver_total > 0 ||
      f.dept_membership_total > 0 ||
      f.unresolved_intent_count > 0;

    let classification;
    if (hasProtectedOwner || hasHumanContamination) {
      classification = "BLOCKED_HUMAN_OR_OWNER_CONFLICT";
    } else if (totalRestrictRefs > 0 || totalCascadeRefs > 0 || totalNonFkAuditRefs > 0) {
      classification = "HISTORICAL_REF_PRESERVE_REQUIRED";
    } else {
      classification = "ZERO_REF_CANDIDATE";
    }

    candidates.push({
      app_user_id: appUserId,
      auth_subject: authSubject,
      display_name: u.display_name,
      enabled: u.enabled,
      authz_managed: u.authz_managed,
      version: u.version,
      account_type: u.account_type,
      is_shared_non_employee: u.is_shared_non_employee,
      auth_user_exists: u.auth_user_exists,
      discovery_sources: sources.sort(),
      classification,
      hard_delete_forbidden: classification !== "ZERO_REF_CANDIDATE",
      protected_owner: hasProtectedOwner,
      human_contamination: {
        person_link_total: f.person_link_total,
        person_link_open: f.person_link_open,
        recruiter_link_total: f.recruiter_link_total,
        team_leader_total: f.team_leader_total,
        project_accountant_total: f.project_accountant_total,
        leave_approver_total: f.leave_approver_total,
        dept_membership_total: f.dept_membership_total,
        unresolved_intent_count: f.unresolved_intent_count,
      },
      open_grants: {
        open_role_assignments: f.open_role_assignments,
        open_direct_grants: f.open_direct_grants,
      },
      references: {
        total_restrict_or_no_action_refs: totalRestrictRefs,
        total_cascade_hazard_refs: totalCascadeRefs,
        total_non_fk_audit_refs: totalNonFkAuditRefs,
        restrict_or_no_action_by_column: restrictOrNoActionRefs,
        cascade_hazard_by_column: cascadeHazardRefs,
        non_fk_audit_by_column: {
          "public.direct_entry_audit_events.auth_subject": f.non_fk_direct_entry_audit_refs,
          "public.authz_audit_events.actor_auth_subject": f.non_fk_authz_audit_refs,
        },
      },
    });
  }

  // Authorization cutover manifest (PR28-T0-R1 / PR28-T0-R2):
  // Mirrors #237 Gate 3 (unmappable active authz_direct_capability_grants) and Gate 4
  // (enabled authz_managed = false with active direct_entry_capability_grants), plus counts
  // of legacy role/module rows awaiting or completed in group backfill.
  const { rows: legacyRoleCounts } = await client.query(`
    select
      (select count(*)::int from public.authz_account_role_assignments
        where ended_at is null and started_at <= pg_catalog.clock_timestamp()
          and role_code in ('ADMIN', 'HR_OPERATOR', 'RECRUITER')) as active_global_roles,
      (select count(*)::int from public.vendor_finance_global_roles gr
        where gr.valid_from <= public.direct_entry_authorization_date()
          and (gr.valid_to is null or (gr.valid_to > gr.valid_from and gr.valid_to > public.direct_entry_authorization_date()))
          and gr.role_code in ('GLOBAL_VIEWER', 'GLOBAL_RECONCILER', 'CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF')) as active_vfin_global_roles,
      (select count(*)::int from public.leave_module_grants lmg
        where lmg.is_current = true
          and lmg.valid_from <= public.direct_entry_authorization_date()
          and (lmg.valid_to is null or (lmg.valid_to > lmg.valid_from and lmg.valid_to > public.direct_entry_authorization_date()))
          and lmg.role_code in ('HR_LEAVE_OPERATOR', 'HR_REPORT_VIEWER', 'LEAVE_ADMIN_BOD_APPROVER')) as active_leave_module_grants
  `);

  const groupCoverageSql = hasGroupMembers
    ? `exists (
         select 1
           from public.authz_user_group_members m
           join public.authz_user_groups g on g.group_id = m.group_id and g.active = true
           join public.organization_departments d on d.department_id = g.department_id and d.is_active = true
           left join public.teams t on t.team_id = g.team_id and t.active = true and t.code <> '__system_vendor__'
           join public.authz_user_group_capabilities gc
             on gc.group_id = g.group_id
            and gc.ended_at is null
            and gc.started_at <= pg_catalog.clock_timestamp()
            and gc.capability = dg.capability
          where m.app_user_id = dg.app_user_id
            and m.ended_at is null
            and m.started_at <= pg_catalog.clock_timestamp()
            and (g.team_id is null or t.team_id is not null)
            and (
              (dg.scope_kind = 'ALL' and dg.scope_id is null and g.team_id is null and (
                g.is_system_admin
                or gc.capability not in (
                  'entry_create', 'entry_own', 'submission_create', 'document_upload',
                  'document_view', 'change_request_create', 'employment_status.request'
                )
                or (
                  gc.capability = 'document_view'
                  and exists (
                    select 1 from public.authz_user_group_capabilities gc2
                     where gc2.group_id = g.group_id
                       and gc2.ended_at is null
                       and gc2.capability in ('recruiter_master_manage', 'team_master_manage', 'catalog_master_manage', 'audit_view')
                  )
                )
              ))
              or (dg.scope_kind = 'OWN' and dg.scope_id is null and gc.capability in (
                'entry_create', 'entry_own', 'submission_create', 'document_upload',
                'document_view', 'change_request_create', 'employment_status.request'
              ))
              or (dg.scope_kind = 'CONTEXT_TEAM' and g.team_id is not null and g.team_id::text = dg.scope_id)
            )
       )`
    : "false";

  const { rows: directGrantRows } = await client.query(`
    select
      dg.direct_grant_id,
      dg.app_user_id,
      u.display_name,
      u.enabled,
      dg.capability,
      dg.scope_kind,
      dg.scope_id,
      ${groupCoverageSql} as covered_by_group,
      exists (
        select 1
          from public.authz_account_role_assignments ara
          join public.authz_role_capabilities rc on rc.role_code = ara.role_code
         where ara.app_user_id = dg.app_user_id
           and ara.ended_at is null
           and ara.started_at <= pg_catalog.clock_timestamp()
           and ara.role_code in ('ADMIN', 'HR_OPERATOR', 'RECRUITER')
           and rc.capability = dg.capability
           and rc.scope_template = dg.scope_kind
           and dg.scope_id is null
      ) as covered_by_mappable_role,
      (
        (dg.capability = 'vendor_finance_view' and dg.scope_kind = 'ALL' and dg.scope_id is null)
        or (
          dg.scope_kind = 'CONTEXT_TEAM'
          and dg.scope_id ~ '^[0-9a-fA-F-]{36}$'
          and dg.capability in (
            'entry_team', 'team_manager_assign', 'change_review',
            'report_view', 'report_analytics_view', 'report_assign',
            'report_review', 'report_delegate', 'worker_edit_history_view'
          )
          and exists (
            select 1 from public.teams t
             where t.team_id = dg.scope_id::uuid
               and t.active = true
               and t.code <> '__system_vendor__'
          )
        )
        or (
          dg.scope_kind = 'OWN'
          and dg.scope_id is null
          and dg.capability in (
            'entry_create', 'entry_own', 'submission_create', 'document_upload',
            'document_view', 'change_request_create', 'employment_status.request'
          )
        )
        or (
          dg.scope_kind = 'ALL'
          and dg.scope_id is null
          and dg.capability in (
            'recruiter_master_manage', 'team_master_manage', 'audit_view',
            'catalog_master_manage', 'report_form_manage', 'report_assign',
            'report_review', 'report_delegate', 'duplicate_cccd_withdraw',
            'worker_edit_history_view'
          )
        )
      ) as d1_mappable
    from public.authz_direct_capability_grants dg
    join public.direct_entry_app_users u on u.app_user_id = dg.app_user_id
    where dg.ended_at is null
      and dg.started_at <= pg_catalog.clock_timestamp()
    order by dg.app_user_id asc, dg.capability asc, dg.scope_kind asc, dg.direct_grant_id asc
  `);

  const activeDirectGrants = directGrantRows.map((r) => {
    const classification = r.covered_by_group
      ? "COVERED_BY_GROUP"
      : r.covered_by_mappable_role || r.d1_mappable
        ? "MAPPABLE_TO_GROUP"
        : "UNMAPPABLE_REQUIRES_T0_DECISION";
    return {
      direct_grant_id: r.direct_grant_id.toLowerCase(),
      app_user_id: r.app_user_id.toLowerCase(),
      display_name: r.display_name,
      enabled: Boolean(r.enabled),
      capability: r.capability,
      scope_kind: r.scope_kind,
      scope_id: r.scope_id,
      classification,
    };
  });

  const unmappableDirectGrantCount = activeDirectGrants.filter(
    (g) => g.classification === "UNMAPPABLE_REQUIRES_T0_DECISION",
  ).length;

  const { rows: uncutoverRows } = await client.query(`
    select
      u.app_user_id,
      u.display_name,
      array_agg(distinct cg.capability order by cg.capability) as capabilities
    from public.direct_entry_app_users u
    join public.direct_entry_capability_grants cg
      on cg.app_user_id = u.app_user_id
     and cg.is_current = true
    where u.enabled = true
      and u.authz_managed = false
    group by u.app_user_id, u.display_name
    order by u.app_user_id asc
  `);

  const uncutoverLegacyGrantUsers = uncutoverRows.map((r) => ({
    app_user_id: r.app_user_id.toLowerCase(),
    display_name: r.display_name,
    capabilities: r.capabilities ?? [],
  }));

  const authorizationCutoverManifest = {
    active_legacy_global_role_count: legacyRoleCounts[0]?.active_global_roles ?? 0,
    active_legacy_vfin_global_role_count: legacyRoleCounts[0]?.active_vfin_global_roles ?? 0,
    active_legacy_leave_module_grant_count: legacyRoleCounts[0]?.active_leave_module_grants ?? 0,
    active_direct_grant_count: activeDirectGrants.length,
    unmappable_direct_grant_count: unmappableDirectGrantCount,
    uncutover_legacy_grant_user_count: uncutoverLegacyGrantUsers.length,
    active_direct_grants: activeDirectGrants,
    uncutover_legacy_grant_users: uncutoverLegacyGrantUsers,
  };

  const overallStatus =
    candidates.length === 0 && orphanAuthBindings.length === 0
      ? "NO_CANDIDATES"
      : candidates.some((c) => c.classification === "BLOCKED_HUMAN_OR_OWNER_CONFLICT")
        ? "BLOCKED_HUMAN_OR_OWNER_CONFLICT"
        : candidates.some((c) => c.classification === "HISTORICAL_REF_PRESERVE_REQUIRED")
          ? "HISTORICAL_REF_PRESERVE_REQUIRED"
          : "ZERO_REF_CANDIDATES_ONLY";

  const cleanupMigrationSafe =
    unresolvedLegacyAccountTypeCount === 0 &&
    unresolvedLegacySharedProfileCount === 0 &&
    orphanAuthBindings.length === 0 &&
    unmappableDirectGrantCount === 0 &&
    uncutoverLegacyGrantUsers.length === 0;

  const body = {
    schema_state: {
      has_account_type_column: hasAccountType,
      has_is_shared_non_employee_column: hasIsSharedFlag,
      scanned_fk_column_count: fkRows.length,
    },
    bindings: {
      n8n_auth_subject: n8nAuthSubject,
      n8n_app_user_id: n8nAppUserId,
      hrp_auth_subject: hrpAuthSubject,
    },
    overall_status: overallStatus,
    cleanup_migration_safe: cleanupMigrationSafe,
    unresolved_legacy_account_type_count: unresolvedLegacyAccountTypeCount,
    unresolved_legacy_shared_profile_count: unresolvedLegacySharedProfileCount,
    orphan_auth_bindings: orphanAuthBindings,
    candidates,
    authorization_cutover_manifest: authorizationCutoverManifest,
  };

  const manifest_fingerprint = createHash("sha256").update(stableJson(body), "utf8").digest("hex");
  return { ...body, manifest_fingerprint };
}
