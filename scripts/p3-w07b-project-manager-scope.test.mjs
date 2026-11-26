import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

test("HRP account bootstrap omits retired PII and payment capabilities", async () => {
  const source = await readFile(path.resolve("scripts/p3-w07b-access-bootstrap.mjs"), "utf8");
  const block = source.match(/const HRP_CAPABILITIES = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(block, "bootstrap capability set is present");
  for (const capability of ["pii_view", "pii_export", "payment_view", "payment_edit"]) {
    assert.doesNotMatch(block, new RegExp('"' + capability.replaceAll(".", "\\.") + '"'));
  }
  assert.match(source, /direct_entry_capability_grants\(app_user_id, capability, valid_from, is_current\)/);
  assert.match(source, /direct_entry_scope_grants\(app_user_id, scope_kind, team_id, valid_from, is_current\)/);
  assert.match(source, /direct_entry_app_user_recruiter_links\s*\(app_user_id, recruiter_id, verified, valid_from, is_current\)/);
  assert.match(source, /project_id, manager_recruiter_id, is_current/);
  assert.match(source, /do update set is_current = true, updated_at=now\(\)/);
});

const IDS = {
  managerAuth: "a1000000-0000-4000-8000-000000000001",
  managerUser: "a2000000-0000-4000-8000-000000000001",
  adminAuth: "a1000000-0000-4000-8000-000000000002",
  adminUser: "a2000000-0000-4000-8000-000000000002",
  managerRecruiter: "a3000000-0000-4000-8000-000000000001",
  otherRecruiter: "a3000000-0000-4000-8000-000000000002",
  team: "a4000000-0000-4000-8000-000000000001",
};

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(path.resolve("supabase/migrations")))
    .filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")
    .sort();
  // P2-W04B adds migration #44 (cutoff rebaseline 2026-10-06) on top of
  // the W07B #43. P2-W04B is #44, W07C-R2 is #45, W07C-R3 is #46, P2-W04C is
  // #47, W05A #48, W07C-R7 #49, W07E #50, P2.5-W02 #51 and P2.5-W03 #52.
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  for (const name of names) {
    await db.exec(await readFile(path.resolve("supabase/migrations", name), "utf8"));
  }
  await db.exec(`
    insert into auth.users(id) values ('${IDS.managerAuth}'), ('${IDS.adminAuth}');
    insert into public.direct_entry_app_users(app_user_id, auth_subject, enabled, display_name) values
      ('${IDS.managerUser}', '${IDS.managerAuth}', true, 'Synthetic Manager'),
      ('${IDS.adminUser}', '${IDS.adminAuth}', true, 'Synthetic Admin');
    insert into public.teams(team_id, code, display_name) values
      ('${IDS.team}', 'W07B', 'W07B Team');
    insert into public.recruiters(recruiter_id, display_name, personnel_code) values
      ('${IDS.managerRecruiter}', 'Manager A', 'manager.a'),
      ('${IDS.otherRecruiter}', 'Manager B', 'manager.b');
    insert into public.recruiter_provider_memberships(recruiter_id, provider_type, valid_from, is_current) values
      ('${IDS.managerRecruiter}', 'hrp', '2020-01-01', true),
      ('${IDS.otherRecruiter}', 'hrp', '2020-01-01', true);
    insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from, is_current) values
      ('${IDS.managerRecruiter}', '${IDS.team}', '2020-01-01', true),
      ('${IDS.otherRecruiter}', '${IDS.team}', '2020-01-01', true);
    insert into public.direct_entry_projects(project_id, display_name) values
      ('project_a', 'Project A'), ('project_b', 'Project B'), ('project_unassigned', 'Project Unassigned');
    insert into public.direct_entry_app_user_recruiter_links
      (app_user_id, recruiter_id, verified, valid_from, is_current) values
      ('${IDS.managerUser}', '${IDS.managerRecruiter}', true, '2020-01-01', true);
    insert into public.direct_entry_project_manager_assignments(project_id, manager_recruiter_id, is_current) values
      ('project_a', '${IDS.managerRecruiter}', true),
      ('project_b', '${IDS.otherRecruiter}', true);
    insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, is_current) values
      ('${IDS.managerUser}', 'entry_create', '2020-01-01', true),
      ('${IDS.managerUser}', 'submission_create', '2020-01-01', true),
      ('${IDS.managerUser}', 'entry_own', '2020-01-01', true),
      ('${IDS.adminUser}', 'entry_create', '2020-01-01', true),
      ('${IDS.adminUser}', 'entry_admin', '2020-01-01', true);
    insert into public.direct_entry_scope_grants(app_user_id, scope_kind, valid_from, is_current) values
      ('${IDS.managerUser}', 'own', '2020-01-01', true),
      ('${IDS.adminUser}', 'all', '2020-01-01', true);
  `);
  return db;
}

async function catalog(db, auth, user) {
  const result = await db.query(
    "select public.direct_entry_input_catalog($1::uuid,$2::uuid,'2026-10-06') as value",
    [auth, user],
  );
  return result.rows[0].value;
}

function fullProfileRow(projectId) {
  return {
    project_id: projectId,
    first_work_date: "2026-10-06",
    provider_type: "hrp",
    recruiter_id: IDS.managerRecruiter,
    labor_type: "TEMPORARY",
    display_name: "Scoped Worker",
    worker_details: {
      gender: { state: "provided", value: "OTHER" },
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    general_note: { state: "omitted" },
    payment: null,
    employment: null,
  };
}

test("W07B catalog and write RPCs enforce manager project scope while admin+all bypasses", async () => {
  const db = await database();
  try {
    const managerCatalog = await catalog(db, IDS.managerAuth, IDS.managerUser);
    assert.deepEqual(managerCatalog.projects.map((item) => item.project_id), ["project_a"]);

    const adminCatalog = await catalog(db, IDS.adminAuth, IDS.adminUser);
    assert.deepEqual(
      adminCatalog.projects.map((item) => item.project_id).sort(),
      ["project_a", "project_b", "project_unassigned"],
    );

    const access = await db.query(
      "select public.direct_entry_actor_can_access_project($1::uuid,$2::text) as allowed",
      [IDS.managerUser, "project_b"],
    );
    assert.equal(access.rows[0].allowed, false);

    await assert.rejects(
      db.query(
        "select public.direct_entry_create_full_profile_batch_v2($1::uuid,$2::uuid,'worker-profile/1.1',$3::jsonb,$4::text)",
        [IDS.managerAuth, IDS.managerUser, JSON.stringify([fullProfileRow("project_b")]),
          "a5000000-0000-4000-8000-000000000001"],
      ),
      (error) => error.code === "42501" && error.message === "PROJECT_SCOPE_DENIED",
    );

    const allowed = await db.query(
      "select public.direct_entry_create_full_profile_batch_v2($1::uuid,$2::uuid,'worker-profile/1.1',$3::jsonb,$4::text) as value",
      [IDS.managerAuth, IDS.managerUser, JSON.stringify([fullProfileRow("project_a")]),
        "a5000000-0000-4000-8000-000000000002"],
    );
    assert.equal(allowed.rows[0].value.entry_ids.length, 1);

    const acl = await db.query(
      "select c.relrowsecurity, c.relforcerowsecurity," +
      " has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') as service_dml" +
      " from pg_class c where c.oid='public.direct_entry_project_manager_assignments'::regclass",
    );
    assert.deepEqual(acl.rows[0], {
      relrowsecurity: true,
      relforcerowsecurity: true,
      service_dml: false,
    });
  } finally {
    await db.close();
  }
});
