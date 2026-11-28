/**
 * HR Bulletins Foundation (`20261127060000_wp_hr_bulletins_foundation.sql`)
 * PGlite Database Acceptance & Security Test Suite.
 *
 * Covers:
 *   1. Migration hygiene, atomic rollback zero drift, S0-T1-C RPC ACL (+12 RPCs, 9 revoked helpers),
 *      and RLS + FORCE RLS fail-closed checks on all 4 `hr_bulletin*` tables.
 *   2. Schema CHECK / FK / UNIQUE constraints on `hr_bulletins`, `hr_bulletin_attachments`,
 *      `hr_bulletin_reads`, and `hr_bulletin_idempotency`.
 *   3. `bulletin_manage` capability resolution (`ADMIN` / `SYSTEM_ADMIN`, `HR_OPERATOR` /
 *      `HR_CATALOG_OPERATOR`, custom department group, team-group rejection
 *      `GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP`, and fail-closed denial for `RECRUITER`,
 *      `EMPLOYEE_BASE`, disabled, and non-`authz_managed` accounts).
 *   4. Mobile Feed (`hr_bulletin_list_mobile_feed`): 30-day window + pinned, `< 5` anti-empty
 *      fallback, hard cap 20, keyset cursor pagination, red-dot cutoff
 *      `GREATEST(NOW() - 7d, user.created_at)`, `hr_bulletin_mark_read`, `hr_bulletin_mark_all_read`.
 *   5. Detail (`hr_bulletin_get_detail`), Attachment Meta (`hr_bulletin_get_attachment_content_meta`),
 *      and Permanent Web Archive (`hr_bulletin_list_archive`) filters & RBAC.
 *   6. Admin CMS lifecycle RPCs (`create`, `update`, `set_status` DRAFT->PUBLISHED->ARCHIVED->PUBLISHED,
 *      `set_pinned`, `attach_file`, `delete_attachment`), `VERSION_CONFLICT` (`PT409`),
 *      and idempotency replay / `IDEMPOTENCY_CONFLICT` (`PT409`).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  HR_BULLETINS_MIGRATION_NAME,
  HR_BULLETINS_RPC_SIGNATURES,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const BULLETIN_TABLES = [
  "hr_bulletins",
  "hr_bulletin_attachments",
  "hr_bulletin_reads",
  "hr_bulletin_idempotency",
];

const INTERNAL_HELPERS = [
  "public.hr_bulletin__internal_assert_active_actor(uuid,uuid)",
  "public.hr_bulletin__internal_has_manage_authority(uuid)",
  "public.hr_bulletin__internal_count_unread(uuid,timestamptz)",
  "public.hr_bulletin__internal_normalize_text(text,integer,integer,boolean,text)",
  "public.hr_bulletin__internal_validate_sections(jsonb,boolean)",
  "public.hr_bulletin__internal_format_item(uuid,uuid,timestamptz,boolean)",
  "public.hr_bulletin__internal_idempotency_begin(uuid,text,text,text,text)",
  "public.hr_bulletin__internal_idempotency_finish(uuid,text,text,text,text,jsonb)",
  "public.hr_bulletin__internal_lock_for_manage(uuid,uuid,uuid,integer)",
];

const AUTH_PROLOGUE = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
`;

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `88000000-0000-4000-8000-${hex}`;
}

function nextKey(prefix = "idem") {
  return `${prefix}-${seq++}`;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stripOuterTransaction(sql) {
  return sql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
}

async function listMigrations() {
  return (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
}

async function createHeadDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = await listMigrations();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return { db, names };
}

async function seedActor(
  db,
  {
    displayName = "Test Actor",
    email = null,
    enabled = true,
    authzManaged = true,
    createdAt = null,
    groupCode = null,
  } = {},
) {
  const authSubject = nextUuid();
  const appUserId = nextUuid();
  const effectiveEmail = email ?? `${appUserId}@hrpartner.local`;
  await db.query(
    `insert into auth.users (id, email) values ($1::uuid, $2)`,
    [authSubject, effectiveEmail],
  );
  await db.query(
    `insert into public.direct_entry_app_users
       (app_user_id, auth_subject, display_name, enabled, authz_managed, created_at)
     values
       ($1::uuid, $2::uuid, $3, $4, $5, coalesce($6::timestamptz, now()))`,
    [appUserId, authSubject, displayName, enabled, authzManaged, createdAt],
  );
  if (groupCode) {
    const { rows } = await db.query(
      `select group_id from public.authz_user_groups where code = $1`,
      [groupCode],
    );
    assert.equal(rows.length, 1, `seed group ${groupCode} must exist`);
    await db.query(
      `insert into public.authz_user_group_members (group_id, app_user_id, reason)
       values ($1::uuid, $2::uuid, 'test seed membership')`,
      [rows[0].group_id, appUserId],
    );
  }
  return { authSubject, appUserId, displayName, email: effectiveEmail };
}

async function callRpc(db, fnName, args) {
  const cols = args.map((a, idx) => `$${idx + 1}::${a.type}`).join(", ");
  const values = args.map((a) =>
    a.type === "jsonb" && a.value !== null && typeof a.value !== "string"
      ? JSON.stringify(a.value)
      : a.value,
  );
  const { rows } = await db.query(`select public.${fnName}(${cols}) as res`, values);
  return rows[0]?.res ?? null;
}

async function expectSqlError(promise, expectedCode, expectedMessageFragment) {
  await assert.rejects(promise, (err) => {
    if (expectedCode) {
      assert.equal(
        err?.code,
        expectedCode,
        `expected SQLSTATE ${expectedCode}, got ${err?.code} (${err?.message})`,
      );
    }
    if (expectedMessageFragment) {
      assert.ok(
        String(err?.message ?? "").includes(expectedMessageFragment),
        `expected error message to include "${expectedMessageFragment}", got "${err?.message}"`,
      );
    }
    return true;
  });
}

async function createAndPublishBulletin(
  db,
  actor,
  {
    title,
    category = "HR_NEWS",
    badgeText = null,
    summary = "Tóm tắt bản tin",
    contentSections = ["Nội dung chi tiết bản tin."],
    authorDisplay = "Phòng Hành chính - Nhân sự HRPartner",
    isPinned = false,
    publishedAt = null,
  },
) {
  const createKey = nextKey("create");
  const created = await callRpc(db, "hr_bulletin_create_admin", [
    { type: "uuid", value: actor.authSubject },
    { type: "uuid", value: actor.appUserId },
    { type: "text", value: title },
    { type: "text", value: category },
    { type: "text", value: badgeText },
    { type: "text", value: summary },
    { type: "jsonb", value: contentSections },
    { type: "text", value: authorDisplay },
    { type: "boolean", value: isPinned },
    { type: "text", value: createKey },
    { type: "text", value: sha256(`create:${createKey}:${title}`) },
  ]);
  const bulletinId = created.item.bulletin_id;

  const pubKey = nextKey("pub");
  const published = await callRpc(db, "hr_bulletin_set_status_admin", [
    { type: "uuid", value: actor.authSubject },
    { type: "uuid", value: actor.appUserId },
    { type: "uuid", value: bulletinId },
    { type: "text", value: "PUBLISHED" },
    { type: "integer", value: 1 },
    { type: "text", value: pubKey },
    { type: "text", value: sha256(`pub:${pubKey}:${bulletinId}`) },
  ]);

  if (publishedAt) {
    await db.query(
      `update public.hr_bulletins set published_at = $2::timestamptz where bulletin_id = $1::uuid`,
      [bulletinId, publishedAt],
    );
  }
  return published.item;
}

test("1. Migration hygiene, atomic rollback, S0-T1-C RPC ACL (+12 RPCs), and RLS + FORCE RLS fail-closed", async () => {
  const sql = await readFile(path.join(MIGRATION_DIR, HR_BULLETINS_MIGRATION_NAME), "utf8");
  assert.equal(sql.includes("\r\n"), false, "migration must use LF line endings");
  assert.equal(sql.includes("@"), false, "migration must contain zero @ literals");
  assert.equal(/\bsavepoint\b/i.test(sql), false, "migration must contain zero SAVEPOINT");
  assert.equal(/'40001'/.test(sql), false, "migration must contain zero '40001'");
  assert.equal(/alter default privileges/i.test(sql), false, "migration must contain zero ALTER DEFAULT PRIVILEGES");

  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    const names = await listMigrations();
    const targetIdx = names.indexOf(HR_BULLETINS_MIGRATION_NAME);
    assert.ok(targetIdx >= 0, `${HR_BULLETINS_MIGRATION_NAME} must exist`);

    const preNames = names.slice(0, targetIdx);
    for (const name of preNames) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
    const preFlags = new Map(preNames.map((n) => [n, true]));
    const preCheck = await verifyS0T1CSecurityPostconditions(db, s0Sql, preFlags);
    assert.equal(preCheck.ok, true, `pre-check failed: ${preCheck.reason}`);

    // Atomic rollback leaves zero drift
    await db.exec("begin;");
    await db.exec(stripOuterTransaction(sql));
    await db.exec("rollback;");
    const { rows: afterRb } = await db.query(`select to_regclass('public.hr_bulletins') as tbl`);
    assert.equal(afterRb[0].tbl, null, "atomic rollback must leave zero hr_bulletins table");

    // Apply migration cleanly
    await db.exec(sql);
    const postFlags = new Map([...preFlags, [HR_BULLETINS_MIGRATION_NAME, true]]);
    const postCheck = await verifyS0T1CSecurityPostconditions(db, s0Sql, postFlags);
    assert.equal(postCheck.ok, true, `post-check failed: ${postCheck.reason}`);
    assert.equal(
      postCheck.details.actualServiceCount - preCheck.details.actualServiceCount,
      HR_BULLETINS_RPC_SIGNATURES.length,
      "exact +12 net service_role RPCs",
    );
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0, "zero client/PUBLIC EXECUTE grants");

    // Verify RLS + FORCE RLS + zero policies + zero runtime table grants
    const { rows: rlsRows } = await db.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = any($1::text[])
        order by c.relname`,
      [BULLETIN_TABLES],
    );
    assert.equal(rlsRows.length, 4);
    for (const r of rlsRows) {
      assert.equal(r.relrowsecurity, true, `${r.relname} must have RLS enabled`);
      assert.equal(r.relforcerowsecurity, true, `${r.relname} must have FORCE RLS`);
    }

    const { rows: polRows } = await db.query(
      `select pol.polname
         from pg_catalog.pg_policy pol
         join pg_catalog.pg_class c on c.oid = pol.polrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1::text[])`,
      [BULLETIN_TABLES],
    );
    assert.equal(polRows.length, 0, "zero client RLS policies on hr_bulletin tables");

    const { rows: grantRows } = await db.query(
      `select table_name, grantee, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = any($1::text[])
          and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')`,
      [BULLETIN_TABLES],
    );
    assert.equal(grantRows.length, 0, "zero runtime table grants on hr_bulletin tables");

    // Verify internal helpers have SECURITY DEFINER + search_path and REVOKE ALL (incl service_role)
    for (const sig of INTERNAL_HELPERS) {
      const { rows: fnRows } = await db.query(
        `select p.prosecdef,
                coalesce(p.proconfig, '{}'::text[]) as proconfig,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
                pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
           from pg_catalog.pg_proc p
          where p.oid = pg_catalog.to_regprocedure($1)`,
        [sig],
      );
      assert.equal(fnRows.length, 1, `missing helper ${sig}`);
      assert.equal(fnRows[0].prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.ok(fnRows[0].proconfig.includes("search_path=pg_catalog, public"), `${sig} search_path`);
      assert.equal(fnRows[0].pub_exec, false, `${sig} public EXECUTE revoked`);
      assert.equal(fnRows[0].anon_exec, false, `${sig} anon EXECUTE revoked`);
      assert.equal(fnRows[0].auth_exec, false, `${sig} authenticated EXECUTE revoked`);
      assert.equal(fnRows[0].svc_exec, false, `${sig} service_role EXECUTE revoked`);
    }

    // Verify anon, authenticated, and service_role direct SELECT/INSERT are denied (42501)
    const admin = await seedActor(db, { displayName: "ACL Probe Admin", groupCode: "SYSTEM_ADMIN" });
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const tbl of BULLETIN_TABLES) {
        await db.exec("begin;");
        await db.exec(`set local role ${role};`);
        await expectSqlError(db.query(`select count(*) from public.${tbl}`), "42501");
        await db.exec("rollback;");
      }

      await db.exec("begin;");
      await db.exec(`set local role ${role};`);
      await expectSqlError(
        db.query(
          `insert into public.hr_bulletins (title, category, created_by, updated_by)
           values ('Direct Insert', 'GENERAL', $1::uuid, $1::uuid)`,
          [admin.appUserId],
        ),
        "42501",
      );
      await db.exec("rollback;");
    }

    // Verify anon & authenticated cannot execute public RPCs, service_role cannot execute internal helpers,
    // and service_role CAN execute public RPCs
    for (const role of ["anon", "authenticated"]) {
      await db.exec("begin;");
      await db.exec(`set local role ${role};`);
      await expectSqlError(
        callRpc(db, "hr_bulletin_list_mobile_feed", [
          { type: "uuid", value: admin.authSubject },
          { type: "uuid", value: admin.appUserId },
          { type: "text", value: null },
          { type: "integer", value: 10 },
          { type: "boolean", value: null },
          { type: "timestamptz", value: null },
          { type: "uuid", value: null },
          { type: "integer", value: 0 },
        ]),
        "42501",
      );
      await db.exec("rollback;");
    }

    await db.exec("begin;");
    await db.exec("set local role service_role;");
    await expectSqlError(
      db.query(`select public.hr_bulletin__internal_has_manage_authority($1::uuid)`, [admin.appUserId]),
      "42501",
    );
    await db.exec("rollback;");

    await db.exec("begin;");
    await db.exec("set local role service_role;");
    const feedRes = await callRpc(db, "hr_bulletin_list_mobile_feed", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "text", value: null },
      { type: "integer", value: 10 },
      { type: "boolean", value: null },
      { type: "timestamptz", value: null },
      { type: "uuid", value: null },
      { type: "integer", value: 0 },
    ]);
    assert.deepEqual(feedRes.items, []);
    assert.equal(feedRes.unread_count, 0);
    await db.exec("rollback;");
  } finally {
    await db.close();
  }
});

test("2. Schema constraints on hr_bulletins, hr_bulletin_attachments, hr_bulletin_reads, and hr_bulletin_idempotency", async () => {
  const { db } = await createHeadDatabase();
  try {
    const admin = await seedActor(db, { displayName: "Schema Admin", groupCode: "SYSTEM_ADMIN" });
    const validSha = "a".repeat(64);
    const validSections = JSON.stringify(["Đoạn 1"]);

    // Control characters & trimming & length on title / badge_text / author_display / summary / category
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, created_by, updated_by)
         values ($1, 'GENERAL', $2::uuid, $2::uuid)`,
        ["Bad\x07Title", admin.appUserId],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, created_by, updated_by)
         values ($1, 'GENERAL', $2::uuid, $2::uuid)`,
        ["Line\nBreak", admin.appUserId],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, created_by, updated_by)
         values ('  Untrimmed', 'GENERAL', $1::uuid, $1::uuid)`,
        [admin.appUserId],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, created_by, updated_by)
         values ('Valid Title', 'INVALID_CAT', $1::uuid, $1::uuid)`,
        [admin.appUserId],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, badge_text, created_by, updated_by)
         values ('Valid Title', 'GENERAL', $1, $2::uuid, $2::uuid)`,
        ["Badge\x1f", admin.appUserId],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, author_display, created_by, updated_by)
         values ('Valid Title', 'GENERAL', $1, $2::uuid, $2::uuid)`,
        ["Author\x7f", admin.appUserId],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, summary, created_by, updated_by)
         values ('Valid Title', 'GENERAL', $1, $2::uuid, $2::uuid)`,
        ["Summary\x01Bad", admin.appUserId],
      ),
      "23514",
    );

    // content_sections type & PUBLISHED requirements
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, content_sections, created_by, updated_by)
         values ('Bad JSON Type', 'GENERAL', '{}'::jsonb, $1::uuid, $1::uuid)`,
        [admin.appUserId],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, status, published_at, content_sections, created_by, updated_by)
         values ('Empty Pub', 'GENERAL', 'PUBLISHED', now(), '[]'::jsonb, $1::uuid, $1::uuid)`,
        [admin.appUserId],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, status, published_at, content_sections, created_by, updated_by)
         values ('Missing PubAt', 'GENERAL', 'PUBLISHED', null, $2::jsonb, $1::uuid, $1::uuid)`,
        [admin.appUserId, validSections],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletins (title, category, status, archived_at, created_by, updated_by)
         values ('Missing ArchAt', 'GENERAL', 'ARCHIVED', null, $1::uuid, $1::uuid)`,
        [admin.appUserId],
      ),
      "23514",
    );

    // Valid bulletin with multiline summary
    const { rows: bRows } = await db.query(
      `insert into public.hr_bulletins
         (title, category, summary, content_sections, status, published_at, created_by, updated_by)
       values
         ('Bản tin hợp lệ', 'INTERNAL_POLICY', $2, $3::jsonb, 'PUBLISHED', now(), $1::uuid, $1::uuid)
       returning bulletin_id`,
      [admin.appUserId, "Dòng 1\nDòng 2\tTab", validSections],
    );
    const bulletinId = bRows[0].bulletin_id;

    // hr_bulletin_attachments constraints: file_size_bytes <= 15MB, sha256 hex, kind/mime pairing, control chars
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletin_attachments
           (bulletin_id, kind, file_name, title, mime_type, file_size_bytes, storage_key, sha256)
         values ($1::uuid, 'PDF', 'doc.pdf', 'Doc', 'application/pdf', 15728641, 'k/oversize.pdf', $2)`,
        [bulletinId, validSha],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletin_attachments
           (bulletin_id, kind, file_name, title, mime_type, file_size_bytes, storage_key, sha256)
         values ($1::uuid, 'PDF', 'doc.pdf', 'Doc', 'application/pdf', 0, 'k/zero.pdf', $2)`,
        [bulletinId, validSha],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletin_attachments
           (bulletin_id, kind, file_name, title, mime_type, file_size_bytes, storage_key, sha256)
         values ($1::uuid, 'PDF', 'doc.pdf', 'Doc', 'application/pdf', 1024, 'k/badsha.pdf', $2)`,
        [bulletinId, "A".repeat(64)],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletin_attachments
           (bulletin_id, kind, file_name, title, mime_type, file_size_bytes, storage_key, sha256)
         values ($1::uuid, 'PDF', 'doc.pdf', 'Doc', 'image/png', 1024, 'k/mismatch1.pdf', $2)`,
        [bulletinId, validSha],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletin_attachments
           (bulletin_id, kind, file_name, title, mime_type, file_size_bytes, storage_key, sha256)
         values ($1::uuid, 'IMAGE', 'img.png', 'Img', 'application/pdf', 1024, 'k/mismatch2.png', $2)`,
        [bulletinId, validSha],
      ),
      "23514",
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletin_attachments
           (bulletin_id, kind, file_name, title, mime_type, file_size_bytes, storage_key, sha256)
         values ($1::uuid, 'IMAGE', $2, 'Img', 'image/png', 1024, 'k/badname.png', $3)`,
        [bulletinId, "bad\x08.png", validSha],
      ),
      "23514",
    );

    // Exact 15MB (15728640 bytes) succeeds
    await db.query(
      `insert into public.hr_bulletin_attachments
         (bulletin_id, kind, file_name, title, mime_type, file_size_bytes, storage_key, page_count, sha256)
       values ($1::uuid, 'PDF', 'exact15mb.pdf', 'Exact 15MB', 'application/pdf', 15728640, 'k/exact15mb.pdf', 12, $2)`,
      [bulletinId, validSha],
    );

    // hr_bulletin_reads PK constraint
    await db.query(
      `insert into public.hr_bulletin_reads (bulletin_id, app_user_id) values ($1::uuid, $2::uuid)`,
      [bulletinId, admin.appUserId],
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletin_reads (bulletin_id, app_user_id) values ($1::uuid, $2::uuid)`,
        [bulletinId, admin.appUserId],
      ),
      "23505",
    );

    // hr_bulletin_idempotency constraints
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletin_idempotency
           (actor_app_user_id, operation_name, target_key, idempotency_key, request_hash, response_payload)
         values ($1::uuid, 'op', 'target', 'k1', 'BADHASH', '{}'::jsonb)`,
        [admin.appUserId],
      ),
      "23514",
    );
    await db.query(
      `insert into public.hr_bulletin_idempotency
         (actor_app_user_id, operation_name, target_key, idempotency_key, request_hash, response_payload)
       values ($1::uuid, 'op', 'target', 'k1', $2, '{}'::jsonb)`,
      [admin.appUserId, validSha],
    );
    await expectSqlError(
      db.query(
        `insert into public.hr_bulletin_idempotency
           (actor_app_user_id, operation_name, target_key, idempotency_key, request_hash, response_payload)
         values ($1::uuid, 'op', 'target', 'k1', $2, '{}'::jsonb)`,
        [admin.appUserId, validSha],
      ),
      "23505",
    );
  } finally {
    await db.close();
  }
});

test("3. bulletin_manage capability resolution, custom dept group, team-group rejection, and fail-closed RBAC", async () => {
  const { db } = await createHeadDatabase();
  try {
    // Role & group seed verification
    const { rows: roleCapRows } = await db.query(
      `select role_code, capability, scope_template
         from public.authz_role_capabilities
        where capability = 'bulletin_manage'
        order by role_code`,
    );
    assert.deepEqual(roleCapRows, [
      { role_code: "ADMIN", capability: "bulletin_manage", scope_template: "ALL" },
      { role_code: "HR_OPERATOR", capability: "bulletin_manage", scope_template: "ALL" },
    ]);

    const { rows: groupCapRows } = await db.query(
      `select g.code
         from public.authz_user_group_capabilities gc
         join public.authz_user_groups g on g.group_id = gc.group_id
        where gc.capability = 'bulletin_manage'
          and gc.ended_at is null
        order by g.code`,
    );
    assert.deepEqual(
      groupCapRows.map((r) => r.code),
      ["HR_CATALOG_OPERATOR", "SYSTEM_ADMIN"],
    );

    const adminUser = await seedActor(db, { displayName: "Admin User", groupCode: "SYSTEM_ADMIN" });
    const hrUser = await seedActor(db, { displayName: "HR Operator", groupCode: "HR_CATALOG_OPERATOR" });
    const recruiterUser = await seedActor(db, { displayName: "Recruiter User", groupCode: "RECRUITER_OPERATIONS" });
    const employeeBase = await seedActor(db, { displayName: "Employee Base" });
    const deptMember = await seedActor(db, { displayName: "Custom Dept Bulletin Manager" });
    const disabledAdmin = await seedActor(db, {
      displayName: "Disabled Admin",
      enabled: false,
      groupCode: "SYSTEM_ADMIN",
    });
    const unmanagedUser = await seedActor(db, {
      displayName: "Unmanaged User",
      authzManaged: false,
    });

    const resolveCtx = async (authSubject) => {
      const { rows } = await db.query(
        `select public.direct_entry_resolve_actor_context($1::uuid) as ctx`,
        [authSubject],
      );
      return rows[0]?.ctx ?? null;
    };

    const adminCtx = await resolveCtx(adminUser.authSubject);
    const hrCtx = await resolveCtx(hrUser.authSubject);
    const recCtx = await resolveCtx(recruiterUser.authSubject);
    const empCtx = await resolveCtx(employeeBase.authSubject);
    const disCtx = await resolveCtx(disabledAdmin.authSubject);

    assert.ok(adminCtx.capabilities.includes("bulletin_manage"), "ADMIN has bulletin_manage");
    assert.ok(hrCtx.capabilities.includes("bulletin_manage"), "HR_OPERATOR has bulletin_manage");
    assert.equal(recCtx.capabilities.includes("bulletin_manage"), false, "RECRUITER denied bulletin_manage");
    assert.equal(empCtx.capabilities.includes("bulletin_manage"), false, "EMPLOYEE_BASE denied bulletin_manage");
    assert.equal(disCtx.enabled, false);
    assert.deepEqual(disCtx.capabilities, [], "disabled account has zero capabilities");
    await expectSqlError(resolveCtx(unmanagedUser.authSubject), "42501");

    // Look up departments & create a recruitment team
    const { rows: deptRows } = await db.query(
      `select department_id, system_key from public.organization_departments`,
    );
    const deptByKey = new Map(deptRows.map((d) => [d.system_key, d.department_id]));
    const teamId = nextUuid();
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'TEAM_BUL_TEST', 'Đội Kiểm Thử Bulletin', true)`,
      [teamId],
    );

    // Reject bulletin_manage on team group
    const badGroupKey = nextUuid();
    await expectSqlError(
      callRpc(db, "direct_entry_authz_create_group_admin", [
        { type: "uuid", value: adminUser.authSubject },
        { type: "uuid", value: adminUser.appUserId },
        { type: "text", value: "TEAM_BUL_FORBIDDEN" },
        { type: "text", value: "Team Group Bad Bulletin" },
        { type: "text", value: "Should reject bulletin_manage" },
        { type: "uuid", value: deptByKey.get("RECRUITMENT") },
        { type: "uuid", value: teamId },
        { type: "text[]", value: ["bulletin_manage"] },
        { type: "jsonb", value: [] },
        { type: "text", value: "Test team rejection" },
        { type: "uuid", value: badGroupKey },
        { type: "text", value: sha256(badGroupKey) },
      ]),
      "22023",
      "GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP",
    );

    // Allow bulletin_manage on custom department group
    const deptGroupKey = nextUuid();
    const createdGroup = await callRpc(db, "direct_entry_authz_create_group_admin", [
      { type: "uuid", value: adminUser.authSubject },
      { type: "uuid", value: adminUser.appUserId },
      { type: "text", value: "HR_BULLETIN_EDITORS" },
      { type: "text", value: "Biên tập Bản tin Nội bộ" },
      { type: "text", value: "Custom department group with bulletin_manage" },
      { type: "uuid", value: deptByKey.get("MANAGEMENT_BOD") },
      { type: "uuid", value: null },
      { type: "text[]", value: ["bulletin_manage"] },
      { type: "jsonb", value: [] },
      { type: "text", value: "Create custom bulletin dept group" },
      { type: "uuid", value: deptGroupKey },
      { type: "text", value: sha256(deptGroupKey) },
    ]);
    const customGroupId = createdGroup.group_id;

    const assignKey = nextUuid();
    await callRpc(db, "direct_entry_authz_assign_group_member_admin", [
      { type: "uuid", value: adminUser.authSubject },
      { type: "uuid", value: adminUser.appUserId },
      { type: "uuid", value: deptMember.appUserId },
      { type: "uuid", value: customGroupId },
      { type: "integer", value: 1 },
      { type: "text", value: "Assign custom bulletin group" },
      { type: "uuid", value: assignKey },
      { type: "text", value: sha256(assignKey) },
    ]);

    const customCtx = await resolveCtx(deptMember.authSubject);
    assert.ok(customCtx.capabilities.includes("bulletin_manage"), "custom dept group grants bulletin_manage");

    // Custom dept manager can create bulletin
    const customCreateKey = nextKey("custom");
    const customCreated = await callRpc(db, "hr_bulletin_create_admin", [
      { type: "uuid", value: deptMember.authSubject },
      { type: "uuid", value: deptMember.appUserId },
      { type: "text", value: "Bản tin từ nhóm phòng ban" },
      { type: "text", value: "GENERAL" },
      { type: "text", value: null },
      { type: "text", value: "Tóm tắt" },
      { type: "jsonb", value: ["Đoạn 1"] },
      { type: "text", value: null },
      { type: "boolean", value: false },
      { type: "text", value: customCreateKey },
      { type: "text", value: sha256(customCreateKey) },
    ]);
    assert.equal(customCreated.item.status, "DRAFT");
    const targetBulletinId = customCreated.item.bulletin_id;

    // Non-managers (RECRUITER, EMPLOYEE_BASE) fail-closed with 42501 on all admin write RPCs
    for (const nonMgr of [recruiterUser, employeeBase]) {
      const k = nextKey("deny");
      await expectSqlError(
        callRpc(db, "hr_bulletin_create_admin", [
          { type: "uuid", value: nonMgr.authSubject },
          { type: "uuid", value: nonMgr.appUserId },
          { type: "text", value: "Denied" },
          { type: "text", value: "GENERAL" },
          { type: "text", value: null },
          { type: "text", value: "" },
          { type: "jsonb", value: ["A"] },
          { type: "text", value: null },
          { type: "boolean", value: false },
          { type: "text", value: k },
          { type: "text", value: sha256(k) },
        ]),
        "42501",
        "BULLETIN_FORBIDDEN",
      );
      await expectSqlError(
        callRpc(db, "hr_bulletin_set_status_admin", [
          { type: "uuid", value: nonMgr.authSubject },
          { type: "uuid", value: nonMgr.appUserId },
          { type: "uuid", value: targetBulletinId },
          { type: "text", value: "PUBLISHED" },
          { type: "integer", value: 1 },
          { type: "text", value: k },
          { type: "text", value: sha256(k) },
        ]),
        "42501",
        "BULLETIN_FORBIDDEN",
      );
      await expectSqlError(
        callRpc(db, "hr_bulletin_set_pinned_admin", [
          { type: "uuid", value: nonMgr.authSubject },
          { type: "uuid", value: nonMgr.appUserId },
          { type: "uuid", value: targetBulletinId },
          { type: "boolean", value: true },
          { type: "integer", value: 1 },
          { type: "text", value: k },
          { type: "text", value: sha256(k) },
        ]),
        "42501",
        "BULLETIN_FORBIDDEN",
      );
    }

    // Disabled and unmanaged accounts fail-closed 42501 on both read and write RPCs
    for (const badActor of [disabledAdmin, unmanagedUser]) {
      const k = nextKey("badactor");
      await expectSqlError(
        callRpc(db, "hr_bulletin_list_mobile_feed", [
          { type: "uuid", value: badActor.authSubject },
          { type: "uuid", value: badActor.appUserId },
          { type: "text", value: null },
          { type: "integer", value: 10 },
          { type: "boolean", value: null },
          { type: "timestamptz", value: null },
          { type: "uuid", value: null },
          { type: "integer", value: 0 },
        ]),
        "42501",
        "BULLETIN_ACTOR_FORBIDDEN",
      );
      await expectSqlError(
        callRpc(db, "hr_bulletin_create_admin", [
          { type: "uuid", value: badActor.authSubject },
          { type: "uuid", value: badActor.appUserId },
          { type: "text", value: "Blocked" },
          { type: "text", value: "GENERAL" },
          { type: "text", value: null },
          { type: "text", value: "" },
          { type: "jsonb", value: ["A"] },
          { type: "text", value: null },
          { type: "boolean", value: false },
          { type: "text", value: k },
          { type: "text", value: sha256(k) },
        ]),
        "42501",
        "BULLETIN_ACTOR_FORBIDDEN",
      );
    }
  } finally {
    await db.close();
  }
});

test("4. Mobile Feed: 30d window + pinned, <5 anti-empty fallback, 20-item hard cap, keyset pagination, and 7d/signup red-dot cutoff", async () => {
  const { db } = await createHeadDatabase();
  try {
    const hr = await seedActor(db, { displayName: "HR Feed Author", groupCode: "HR_CATALOG_OPERATOR" });
    const { rows: nowRows } = await db.query(`select now() as ts`);
    const baseMs = new Date(nowRows[0].ts).getTime();
    const isoOffset = (daysOffset, minutesOffset = 0) =>
      new Date(baseMs + daysOffset * 86400_000 + minutesOffset * 60_000).toISOString();

    const oldUser = await seedActor(db, {
      displayName: "Existing Employee (30d old)",
      createdAt: isoOffset(-30),
    });

    // Part A: 7 old PUBLISHED bulletins (>30d, unpinned) -> <5 fallback returns 5 latest
    const oldIds = [];
    for (let i = 1; i <= 7; i++) {
      const item = await createAndPublishBulletin(db, hr, {
        title: `Old Bulletin ${i}`,
        category: i % 2 === 0 ? "HOLIDAY_SCHEDULE" : "HR_NEWS",
        publishedAt: isoOffset(-50 + i),
      });
      oldIds.push(item.bulletin_id);
    }

    const feedFallbackOnlyOld = await callRpc(db, "hr_bulletin_list_mobile_feed", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
      { type: "text", value: null },
      { type: "integer", value: 10 },
      { type: "boolean", value: null },
      { type: "timestamptz", value: null },
      { type: "uuid", value: null },
      { type: "integer", value: 0 },
    ]);
    assert.equal(feedFallbackOnlyOld.items.length, 5, "<5 fallback returns 5 latest old PUBLISHED items");
    assert.equal(feedFallbackOnlyOld.has_more, false);
    assert.equal(feedFallbackOnlyOld.next_cursor_tuple, null);
    assert.deepEqual(
      feedFallbackOnlyOld.items.map((x) => x.title),
      ["Old Bulletin 7", "Old Bulletin 6", "Old Bulletin 5", "Old Bulletin 4", "Old Bulletin 3"],
    );

    // Add 2 recent bulletins (-10d, -9d): windowed_count=2 < 5 -> fallback still yields 5 latest (2 recent + 3 old)
    await createAndPublishBulletin(db, hr, {
      title: "Recent 10d",
      category: "HR_NEWS",
      publishedAt: isoOffset(-10),
    });
    await createAndPublishBulletin(db, hr, {
      title: "Recent 9d",
      category: "HR_NEWS",
      publishedAt: isoOffset(-9),
    });
    const feedPartialFallback = await callRpc(db, "hr_bulletin_list_mobile_feed", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
      { type: "text", value: null },
      { type: "integer", value: 10 },
      { type: "boolean", value: null },
      { type: "timestamptz", value: null },
      { type: "uuid", value: null },
      { type: "integer", value: 0 },
    ]);
    assert.equal(feedPartialFallback.items.length, 5);
    assert.deepEqual(
      feedPartialFallback.items.map((x) => x.title),
      ["Recent 9d", "Recent 10d", "Old Bulletin 7", "Old Bulletin 6", "Old Bulletin 5"],
    );

    // Red-dot cutoff check BEFORE adding <=7d items: Recent 9d & 10d are >= oldUser.created_at (-30d)
    // but < NOW() - 7d, so unread_count MUST be 0 and is_read MUST be true!
    assert.equal(feedPartialFallback.unread_count, 0, "posts older than 7d must not count as unread");
    for (const item of feedPartialFallback.items) {
      assert.equal(item.is_read, true, `${item.title} (< NOW() - 7d) must report is_read=true`);
    }

    // Add 3 more recent posts within 7d (-6d, -3d, -1d) + 1 pinned >30d post (-60d, is_pinned=true)
    // Now windowed_count = 6 >= 5 -> old unpinned items are excluded; old pinned IS included!
    await createAndPublishBulletin(db, hr, {
      title: "Pinned Old 60d",
      category: "INTERNAL_POLICY",
      isPinned: true,
      publishedAt: isoOffset(-60),
    });
    const recent6d = await createAndPublishBulletin(db, hr, {
      title: "Recent 6d",
      category: "HR_NEWS",
      publishedAt: isoOffset(-6),
    });
    const recent3d = await createAndPublishBulletin(db, hr, {
      title: "Recent 3d",
      category: "HOLIDAY_SCHEDULE",
      publishedAt: isoOffset(-3),
    });
    const recent1d = await createAndPublishBulletin(db, hr, {
      title: "Recent 1d",
      category: "GENERAL",
      publishedAt: isoOffset(-1),
    });

    const feedWindowed = await callRpc(db, "hr_bulletin_list_mobile_feed", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
      { type: "text", value: null },
      { type: "integer", value: 20 },
      { type: "boolean", value: null },
      { type: "timestamptz", value: null },
      { type: "uuid", value: null },
      { type: "integer", value: 0 },
    ]);
    assert.equal(feedWindowed.items.length, 6, "5 recent + 1 pinned old (unpinned >30d excluded)");
    assert.equal(feedWindowed.items[0].title, "Pinned Old 60d");
    assert.equal(feedWindowed.items[0].is_read, true, "pinned >7d still reports is_read=true");
    assert.equal(feedWindowed.unread_count, 3, "only the 3 posts within 7d are unread");

    // Brand-new user signed up NOW (after all those posts) -> unread_count = 0 for pre-signup posts
    const brandNewUser = await seedActor(db, {
      displayName: "Brand New Signup",
      createdAt: isoOffset(0, 1),
    });
    const newSignupFeed = await callRpc(db, "hr_bulletin_list_mobile_feed", [
      { type: "uuid", value: brandNewUser.authSubject },
      { type: "uuid", value: brandNewUser.appUserId },
      { type: "text", value: null },
      { type: "integer", value: 20 },
      { type: "boolean", value: null },
      { type: "timestamptz", value: null },
      { type: "uuid", value: null },
      { type: "integer", value: 0 },
    ]);
    assert.equal(newSignupFeed.unread_count, 0, "brand-new user has 0 unread for pre-signup posts");
    assert.ok(newSignupFeed.items.every((i) => i.is_read === true));

    // Mark single read + idempotency + mark_all_read + idempotency for oldUser
    const markOne1 = await callRpc(db, "hr_bulletin_mark_read", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
      { type: "uuid", value: recent6d.bulletin_id },
    ]);
    assert.deepEqual(markOne1, {
      bulletin_id: recent6d.bulletin_id,
      is_read: true,
      unread_count: 2,
    });
    const markOneReplay = await callRpc(db, "hr_bulletin_mark_read", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
      { type: "uuid", value: recent6d.bulletin_id },
    ]);
    assert.equal(markOneReplay.unread_count, 2, "hr_bulletin_mark_read is idempotent");

    const markAll1 = await callRpc(db, "hr_bulletin_mark_all_read", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
    ]);
    assert.deepEqual(markAll1, { unread_count: 0 });
    const markAllReplay = await callRpc(db, "hr_bulletin_mark_all_read", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
    ]);
    assert.deepEqual(markAllReplay, { unread_count: 0 });

    // Confirm recent3d and recent1d now show is_read=true
    const afterMarkAllFeed = await callRpc(db, "hr_bulletin_list_mobile_feed", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
      { type: "text", value: null },
      { type: "integer", value: 20 },
      { type: "boolean", value: null },
      { type: "timestamptz", value: null },
      { type: "uuid", value: null },
      { type: "integer", value: 0 },
    ]);
    assert.equal(afterMarkAllFeed.unread_count, 0);
    assert.equal(
      afterMarkAllFeed.items.find((x) => x.bulletin_id === recent3d.bulletin_id)?.is_read,
      true,
    );
    assert.equal(
      afterMarkAllFeed.items.find((x) => x.bulletin_id === recent1d.bulletin_id)?.is_read,
      true,
    );

    // Part B: Hard cap 20 + keyset cursor pagination (including published_at tie-break)
    // Currently we have 6 windowed items. Add 19 more recent items (total 25 windowed items;
    // two share exact publishedAt to test UUID tie-breaker).
    const tieTs = isoOffset(-2);
    for (let i = 1; i <= 19; i++) {
      await createAndPublishBulletin(db, hr, {
        title: `Cap Item ${String(i).padStart(2, "0")}`,
        category: i % 3 === 0 ? "HOLIDAY_SCHEDULE" : "GENERAL",
        isPinned: i === 19,
        publishedAt: i <= 2 ? tieTs : isoOffset(-2, i),
      });
    }

    const p1 = await callRpc(db, "hr_bulletin_list_mobile_feed", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
      { type: "text", value: "ALL" },
      { type: "integer", value: 8 },
      { type: "boolean", value: null },
      { type: "timestamptz", value: null },
      { type: "uuid", value: null },
      { type: "integer", value: 0 },
    ]);
    assert.equal(p1.items.length, 8);
    assert.equal(p1.has_more, true);
    assert.equal(p1.next_cursor_tuple.offset_count, 8);

    const p2 = await callRpc(db, "hr_bulletin_list_mobile_feed", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
      { type: "text", value: "ALL" },
      { type: "integer", value: 8 },
      { type: "boolean", value: p1.next_cursor_tuple.is_pinned },
      { type: "timestamptz", value: p1.next_cursor_tuple.published_at },
      { type: "uuid", value: p1.next_cursor_tuple.bulletin_id },
      { type: "integer", value: p1.next_cursor_tuple.offset_count },
    ]);
    assert.equal(p2.items.length, 8);
    assert.equal(p2.has_more, true);
    assert.equal(p2.next_cursor_tuple.offset_count, 16);

    const p3 = await callRpc(db, "hr_bulletin_list_mobile_feed", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
      { type: "text", value: "ALL" },
      { type: "integer", value: 8 },
      { type: "boolean", value: p2.next_cursor_tuple.is_pinned },
      { type: "timestamptz", value: p2.next_cursor_tuple.published_at },
      { type: "uuid", value: p2.next_cursor_tuple.bulletin_id },
      { type: "integer", value: p2.next_cursor_tuple.offset_count },
    ]);
    assert.equal(p3.items.length, 4, "page 3 stops cleanly at hard cap 20");
    assert.equal(p3.has_more, false, "has_more must be false at item #20");
    assert.equal(p3.next_cursor_tuple, null, "next_cursor_tuple must be null at item #20");

    const allReturnedIds = [...p1.items, ...p2.items, ...p3.items].map((i) => i.bulletin_id);
    assert.equal(new Set(allReturnedIds).size, 20, "zero duplicates or skips across pages");
    // Top 2 items must be the 2 pinned ones (newest pinned first)
    assert.equal(p1.items[0].is_pinned, true);
    assert.equal(p1.items[1].is_pinned, true);
    assert.equal(p1.items[2].is_pinned, false);

    // Category filter check
    const holidayFeed = await callRpc(db, "hr_bulletin_list_mobile_feed", [
      { type: "uuid", value: oldUser.authSubject },
      { type: "uuid", value: oldUser.appUserId },
      { type: "text", value: "HOLIDAY_SCHEDULE" },
      { type: "integer", value: 20 },
      { type: "boolean", value: null },
      { type: "timestamptz", value: null },
      { type: "uuid", value: null },
      { type: "integer", value: 0 },
    ]);
    assert.ok(holidayFeed.items.length >= 1);
    assert.ok(holidayFeed.items.every((i) => i.category === "HOLIDAY_SCHEDULE"));
  } finally {
    await db.close();
  }
});

test("5. Detail (no 30d cap, DRAFT/ARCHIVED guard), Attachment Meta, and Permanent Web Archive filters", async () => {
  const { db } = await createHeadDatabase();
  try {
    const admin = await seedActor(db, { displayName: "Admin Author", groupCode: "SYSTEM_ADMIN" });
    const hr = await seedActor(db, { displayName: "Nguyễn Thị Lan", groupCode: "HR_CATALOG_OPERATOR" });
    const employee = await seedActor(db, { displayName: "Nhân viên Thường" });

    // Create 25 old PUBLISHED articles (>30d) + 1 DRAFT + 1 ARCHIVED + 1 boundary UTC/HCM date article
    for (let i = 1; i <= 25; i++) {
      await createAndPublishBulletin(db, admin, {
        title: `Archive Old ${String(i).padStart(2, "0")}`,
        category: "GENERAL",
        authorDisplay: "Ban Giám đốc",
        publishedAt: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T04:00:00Z`,
      });
    }

    // 2026-10-01T18:00:00Z == 2026-10-02 01:00:00 Asia/Ho_Chi_Minh (+07:00)
    const hcmTarget = await createAndPublishBulletin(db, hr, {
      title: "Lịch nghỉ lễ Quốc khánh",
      category: "HOLIDAY_SCHEDULE",
      summary: "Thông báo chi tiết ca trực và phụ cấp.",
      contentSections: ["Nghỉ từ ngày 02/09.", "Từ khóa ẩn: PHU_CAP_DAC_BIET_2026."],
      authorDisplay: "Phòng Nhân sự Miền Bắc",
      publishedAt: "2026-10-01T18:00:00Z",
    });

    // Attach a PDF to hcmTarget
    const attId = nextUuid();
    const attachKey = nextKey("att");
    const attSha = sha256("pdf-bytes");
    await callRpc(db, "hr_bulletin_attach_file_admin", [
      { type: "uuid", value: hr.authSubject },
      { type: "uuid", value: hr.appUserId },
      { type: "uuid", value: hcmTarget.bulletin_id },
      { type: "integer", value: hcmTarget.row_version },
      { type: "uuid", value: attId },
      { type: "text", value: "PDF" },
      { type: "text", value: "lich-nghi.pdf" },
      { type: "text", value: "Lịch nghỉ lễ chính thức" },
      { type: "text", value: "application/pdf" },
      { type: "bigint", value: 204800 },
      { type: "text", value: `bulletins/${hcmTarget.bulletin_id}/lich-nghi.pdf` },
      { type: "integer", value: null },
      { type: "integer", value: null },
      { type: "integer", value: 3 },
      { type: "text", value: attSha },
      { type: "text", value: attachKey },
      { type: "text", value: sha256(attachKey) },
    ]);

    // Draft + Archived with attachment on Draft
    const draftKey = nextKey("draft");
    const draftCreated = await callRpc(db, "hr_bulletin_create_admin", [
      { type: "uuid", value: hr.authSubject },
      { type: "uuid", value: hr.appUserId },
      { type: "text", value: "Bản nháp nội bộ" },
      { type: "text", value: "INTERNAL_POLICY" },
      { type: "text", value: "NHÁP" },
      { type: "text", value: "Chưa công bố" },
      { type: "jsonb", value: ["Nội dung nháp"] },
      { type: "text", value: "Phòng Pháp chế" },
      { type: "boolean", value: false },
      { type: "text", value: draftKey },
      { type: "text", value: sha256(draftKey) },
    ]);
    const draftId = draftCreated.item.bulletin_id;
    const draftAttId = nextUuid();
    const draftAttKey = nextKey("datt");
    await callRpc(db, "hr_bulletin_attach_file_admin", [
      { type: "uuid", value: hr.authSubject },
      { type: "uuid", value: hr.appUserId },
      { type: "uuid", value: draftId },
      { type: "integer", value: 1 },
      { type: "uuid", value: draftAttId },
      { type: "text", value: "IMAGE" },
      { type: "text", value: "draft.png" },
      { type: "text", value: "Ảnh nháp" },
      { type: "text", value: "image/png" },
      { type: "bigint", value: 4096 },
      { type: "text", value: `bulletins/${draftId}/draft.png` },
      { type: "integer", value: 800 },
      { type: "integer", value: 600 },
      { type: "integer", value: null },
      { type: "text", value: sha256("img") },
      { type: "text", value: draftAttKey },
      { type: "text", value: sha256(draftAttKey) },
    ]);

    const archivedItem = await createAndPublishBulletin(db, admin, {
      title: "Bản tin đã lưu trữ",
      category: "HR_NEWS",
      publishedAt: "2026-07-01T00:00:00Z",
    });
    const archKey = nextKey("arch");
    await callRpc(db, "hr_bulletin_set_status_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: archivedItem.bulletin_id },
      { type: "text", value: "ARCHIVED" },
      { type: "integer", value: archivedItem.row_version },
      { type: "text", value: archKey },
      { type: "text", value: sha256(archKey) },
    ]);

    // hr_bulletin_get_detail: regular user reads old (>30d, outside 20 cap) PUBLISHED article
    const detailPub = await callRpc(db, "hr_bulletin_get_detail", [
      { type: "uuid", value: employee.authSubject },
      { type: "uuid", value: employee.appUserId },
      { type: "uuid", value: hcmTarget.bulletin_id },
      { type: "boolean", value: false },
    ]);
    assert.equal(detailPub.item.bulletin_id, hcmTarget.bulletin_id);
    assert.equal(detailPub.item.published_date_display, "02-10-2026");
    assert.equal(detailPub.item.pdf_count, 1);
    assert.equal(detailPub.item.status, undefined, "non-admin detail omits admin metadata");

    // Regular user on DRAFT / ARCHIVED -> P0002 BULLETIN_NOT_FOUND
    await expectSqlError(
      callRpc(db, "hr_bulletin_get_detail", [
        { type: "uuid", value: employee.authSubject },
        { type: "uuid", value: employee.appUserId },
        { type: "uuid", value: draftId },
        { type: "boolean", value: false },
      ]),
      "P0002",
      "BULLETIN_NOT_FOUND",
    );
    await expectSqlError(
      callRpc(db, "hr_bulletin_get_detail", [
        { type: "uuid", value: employee.authSubject },
        { type: "uuid", value: employee.appUserId },
        { type: "uuid", value: archivedItem.bulletin_id },
        { type: "boolean", value: false },
      ]),
      "P0002",
      "BULLETIN_NOT_FOUND",
    );

    // Regular user with p_allow_non_published=true -> 42501 BULLETIN_FORBIDDEN
    await expectSqlError(
      callRpc(db, "hr_bulletin_get_detail", [
        { type: "uuid", value: employee.authSubject },
        { type: "uuid", value: employee.appUserId },
        { type: "uuid", value: draftId },
        { type: "boolean", value: true },
      ]),
      "42501",
      "BULLETIN_FORBIDDEN",
    );

    // Manager with p_allow_non_published=true reads DRAFT & ARCHIVED with admin meta
    const detailDraftMgr = await callRpc(db, "hr_bulletin_get_detail", [
      { type: "uuid", value: hr.authSubject },
      { type: "uuid", value: hr.appUserId },
      { type: "uuid", value: draftId },
      { type: "boolean", value: true },
    ]);
    assert.equal(detailDraftMgr.item.status, "DRAFT");
    assert.equal(detailDraftMgr.item.row_version, 2);

    // Attachment content meta checks
    const pubAttMeta = await callRpc(db, "hr_bulletin_get_attachment_content_meta", [
      { type: "uuid", value: employee.authSubject },
      { type: "uuid", value: employee.appUserId },
      { type: "uuid", value: hcmTarget.bulletin_id },
      { type: "uuid", value: attId },
    ]);
    assert.equal(pubAttMeta.storage_key, `bulletins/${hcmTarget.bulletin_id}/lich-nghi.pdf`);
    assert.equal(pubAttMeta.sha256, attSha);

    await expectSqlError(
      callRpc(db, "hr_bulletin_get_attachment_content_meta", [
        { type: "uuid", value: employee.authSubject },
        { type: "uuid", value: employee.appUserId },
        { type: "uuid", value: draftId },
        { type: "uuid", value: draftAttId },
      ]),
      "P0002",
      "BULLETIN_NOT_FOUND",
    );
    await expectSqlError(
      callRpc(db, "hr_bulletin_get_attachment_content_meta", [
        { type: "uuid", value: employee.authSubject },
        { type: "uuid", value: employee.appUserId },
        { type: "uuid", value: hcmTarget.bulletin_id },
        { type: "uuid", value: nextUuid() },
      ]),
      "P0002",
      "BULLETIN_ATTACHMENT_NOT_FOUND",
    );
    const mgrDraftAttMeta = await callRpc(db, "hr_bulletin_get_attachment_content_meta", [
      { type: "uuid", value: hr.authSubject },
      { type: "uuid", value: hr.appUserId },
      { type: "uuid", value: draftId },
      { type: "uuid", value: draftAttId },
    ]);
    assert.equal(mgrDraftAttMeta.attachment_id, draftAttId);

    // Permanent Web Archive: returns >30d and >20 items (26 PUBLISHED items total)
    const archPage1 = await callRpc(db, "hr_bulletin_list_archive", [
      { type: "uuid", value: employee.authSubject },
      { type: "uuid", value: employee.appUserId },
      { type: "date", value: null },
      { type: "date", value: null },
      { type: "text", value: null },
      { type: "text", value: null },
      { type: "text", value: null },
      { type: "uuid", value: null },
      { type: "text", value: null },
      { type: "integer", value: 1 },
      { type: "integer", value: 20 },
    ]);
    assert.equal(archPage1.total_count, 26);
    assert.equal(archPage1.items.length, 20);
    assert.equal(archPage1.can_manage, false);

    const archPage2 = await callRpc(db, "hr_bulletin_list_archive", [
      { type: "uuid", value: employee.authSubject },
      { type: "uuid", value: employee.appUserId },
      { type: "date", value: null },
      { type: "date", value: null },
      { type: "text", value: null },
      { type: "text", value: null },
      { type: "text", value: null },
      { type: "uuid", value: null },
      { type: "text", value: null },
      { type: "integer", value: 2 },
      { type: "integer", value: 20 },
    ]);
    assert.equal(archPage2.items.length, 6);

    // Asia/Ho_Chi_Minh date boundary filter: 2026-10-01T18:00:00Z is 2026-10-02 in +07:00
    const byHcmDateMatch = await callRpc(db, "hr_bulletin_list_archive", [
      { type: "uuid", value: employee.authSubject },
      { type: "uuid", value: employee.appUserId },
      { type: "date", value: "2026-10-02" },
      { type: "date", value: "2026-10-02" },
      { type: "text", value: "HOLIDAY_SCHEDULE" },
      { type: "text", value: null },
      { type: "text", value: null },
      { type: "uuid", value: null },
      { type: "text", value: null },
      { type: "integer", value: 1 },
      { type: "integer", value: 20 },
    ]);
    assert.equal(byHcmDateMatch.total_count, 1);
    assert.equal(byHcmDateMatch.items[0].bulletin_id, hcmTarget.bulletin_id);

    const byUtcDateMiss = await callRpc(db, "hr_bulletin_list_archive", [
      { type: "uuid", value: employee.authSubject },
      { type: "uuid", value: employee.appUserId },
      { type: "date", value: "2026-10-01" },
      { type: "date", value: "2026-10-01" },
      { type: "text", value: null },
      { type: "text", value: null },
      { type: "text", value: null },
      { type: "uuid", value: null },
      { type: "text", value: null },
      { type: "integer", value: 1 },
      { type: "integer", value: 20 },
    ]);
    assert.equal(byUtcDateMiss.total_count, 0, "UTC Oct 1 18:00 must fall on Oct 2 in Asia/Ho_Chi_Minh");

    // Author filter matches creator display_name or author_display; created_by filter; keyword q in title/summary/content_sections/author_display
    const byCreatorName = await callRpc(db, "hr_bulletin_list_archive", [
      { type: "uuid", value: employee.authSubject },
      { type: "uuid", value: employee.appUserId },
      { type: "date", value: null },
      { type: "date", value: null },
      { type: "text", value: null },
      { type: "text", value: null },
      { type: "text", value: "Nguyễn Thị Lan" },
      { type: "uuid", value: hr.appUserId },
      { type: "text", value: null },
      { type: "integer", value: 1 },
      { type: "integer", value: 20 },
    ]);
    assert.equal(byCreatorName.total_count, 1);

    for (const kw of ["Quốc khánh", "ca trực", "PHU_CAP_DAC_BIET_2026", "Miền Bắc"]) {
      const byQ = await callRpc(db, "hr_bulletin_list_archive", [
        { type: "uuid", value: employee.authSubject },
        { type: "uuid", value: employee.appUserId },
        { type: "date", value: null },
        { type: "date", value: null },
        { type: "text", value: null },
        { type: "text", value: null },
        { type: "text", value: null },
        { type: "uuid", value: null },
        { type: "text", value: kw },
        { type: "integer", value: 1 },
        { type: "integer", value: 20 },
      ]);
      assert.equal(byQ.total_count, 1, `keyword q="${kw}" must match hcmTarget`);
      assert.equal(byQ.items[0].bulletin_id, hcmTarget.bulletin_id);
    }

    // Status filter forbidden for non-manager, allowed for manager
    for (const forbiddenStatus of ["DRAFT", "ARCHIVED", "ALL"]) {
      await expectSqlError(
        callRpc(db, "hr_bulletin_list_archive", [
          { type: "uuid", value: employee.authSubject },
          { type: "uuid", value: employee.appUserId },
          { type: "date", value: null },
          { type: "date", value: null },
          { type: "text", value: null },
          { type: "text", value: forbiddenStatus },
          { type: "text", value: null },
          { type: "uuid", value: null },
          { type: "text", value: null },
          { type: "integer", value: 1 },
          { type: "integer", value: 20 },
        ]),
        "42501",
        "BULLETIN_FORBIDDEN",
      );
    }

    const mgrDrafts = await callRpc(db, "hr_bulletin_list_archive", [
      { type: "uuid", value: hr.authSubject },
      { type: "uuid", value: hr.appUserId },
      { type: "date", value: null },
      { type: "date", value: null },
      { type: "text", value: null },
      { type: "text", value: "DRAFT" },
      { type: "text", value: null },
      { type: "uuid", value: null },
      { type: "text", value: null },
      { type: "integer", value: 1 },
      { type: "integer", value: 20 },
    ]);
    assert.equal(mgrDrafts.total_count, 1);
    assert.equal(mgrDrafts.items[0].bulletin_id, draftId);

    const mgrAll = await callRpc(db, "hr_bulletin_list_archive", [
      { type: "uuid", value: hr.authSubject },
      { type: "uuid", value: hr.appUserId },
      { type: "date", value: null },
      { type: "date", value: null },
      { type: "text", value: null },
      { type: "text", value: "ALL" },
      { type: "text", value: null },
      { type: "uuid", value: null },
      { type: "text", value: null },
      { type: "integer", value: 1 },
      { type: "integer", value: 50 },
    ]);
    assert.equal(mgrAll.total_count, 28, "26 PUBLISHED + 1 DRAFT + 1 ARCHIVED");
    assert.equal(mgrAll.can_manage, true);
  } finally {
    await db.close();
  }
});

test("6. Admin CMS lifecycle RPCs, VERSION_CONFLICT (PT409), idempotency replay & IDEMPOTENCY_CONFLICT (PT409)", async () => {
  const { db } = await createHeadDatabase();
  try {
    const admin = await seedActor(db, { displayName: "CMS Admin", groupCode: "SYSTEM_ADMIN" });

    // Create (empty sections allowed in DRAFT) + idempotency replay + IDEMPOTENCY_CONFLICT
    const createKey = nextKey("cms-create");
    const createHash = sha256("create-v1");
    const c1 = await callRpc(db, "hr_bulletin_create_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "text", value: "Bản tin vòng đời" },
      { type: "text", value: "HR_NEWS" },
      { type: "text", value: "MỚI" },
      { type: "text", value: "Tóm tắt ban đầu" },
      { type: "jsonb", value: [] },
      { type: "text", value: "HRPartner Ops" },
      { type: "boolean", value: false },
      { type: "text", value: createKey },
      { type: "text", value: createHash },
    ]);
    assert.equal(c1.replayed, false);
    assert.equal(c1.item.status, "DRAFT");
    assert.equal(c1.item.row_version, 1);
    const bid = c1.item.bulletin_id;

    const cReplay = await callRpc(db, "hr_bulletin_create_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "text", value: "Bản tin vòng đời" },
      { type: "text", value: "HR_NEWS" },
      { type: "text", value: "MỚI" },
      { type: "text", value: "Tóm tắt ban đầu" },
      { type: "jsonb", value: [] },
      { type: "text", value: "HRPartner Ops" },
      { type: "boolean", value: false },
      { type: "text", value: createKey },
      { type: "text", value: createHash },
    ]);
    assert.equal(cReplay.replayed, true);
    assert.equal(cReplay.item.bulletin_id, bid);

    await expectSqlError(
      callRpc(db, "hr_bulletin_create_admin", [
        { type: "uuid", value: admin.authSubject },
        { type: "uuid", value: admin.appUserId },
        { type: "text", value: "Khác payload" },
        { type: "text", value: "HR_NEWS" },
        { type: "text", value: "MỚI" },
        { type: "text", value: "Tóm tắt" },
        { type: "jsonb", value: [] },
        { type: "text", value: "HRPartner Ops" },
        { type: "boolean", value: false },
        { type: "text", value: createKey },
        { type: "text", value: sha256("different-hash") },
      ]),
      "PT409",
      "IDEMPOTENCY_CONFLICT",
    );

    // Cannot publish DRAFT with empty content_sections
    const badPubKey = nextKey("bad-pub");
    await expectSqlError(
      callRpc(db, "hr_bulletin_set_status_admin", [
        { type: "uuid", value: admin.authSubject },
        { type: "uuid", value: admin.appUserId },
        { type: "uuid", value: bid },
        { type: "text", value: "PUBLISHED" },
        { type: "integer", value: 1 },
        { type: "text", value: badPubKey },
        { type: "text", value: sha256(badPubKey) },
      ]),
      "22023",
      "BULLETIN_PUBLISH_CONTENT_REQUIRED",
    );

    // Update DRAFT with content_sections -> row_version 2
    const updKey = nextKey("cms-upd");
    const updHash = sha256("upd-v1");
    const u1 = await callRpc(db, "hr_bulletin_update_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: bid },
      { type: "integer", value: 1 },
      { type: "text", value: "Bản tin vòng đời (Đã sửa)" },
      { type: "text", value: "INTERNAL_POLICY" },
      { type: "text", value: "QUAN TRỌNG" },
      { type: "text", value: "Tóm tắt mới" },
      { type: "jsonb", value: ["Mục 1: Quy định mới.", "Mục 2: Áp dụng ngay."] },
      { type: "text", value: "Phòng Nhân sự" },
      { type: "boolean", value: false },
      { type: "text", value: updKey },
      { type: "text", value: updHash },
    ]);
    assert.equal(u1.replayed, false);
    assert.equal(u1.item.row_version, 2);
    assert.equal(u1.item.category_display, "Vận hành");

    // Replay update with original version 1 + same key/hash succeeds cleanly
    const uReplay = await callRpc(db, "hr_bulletin_update_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: bid },
      { type: "integer", value: 1 },
      { type: "text", value: "Bản tin vòng đời (Đã sửa)" },
      { type: "text", value: "INTERNAL_POLICY" },
      { type: "text", value: "QUAN TRỌNG" },
      { type: "text", value: "Tóm tắt mới" },
      { type: "jsonb", value: ["Mục 1: Quy định mới.", "Mục 2: Áp dụng ngay."] },
      { type: "text", value: "Phòng Nhân sự" },
      { type: "boolean", value: false },
      { type: "text", value: updKey },
      { type: "text", value: updHash },
    ]);
    assert.equal(uReplay.replayed, true);
    assert.equal(uReplay.item.row_version, 2);

    // Stale expected_row_version with fresh key -> PT409 VERSION_CONFLICT
    const staleKey = nextKey("stale-upd");
    await expectSqlError(
      callRpc(db, "hr_bulletin_update_admin", [
        { type: "uuid", value: admin.authSubject },
        { type: "uuid", value: admin.appUserId },
        { type: "uuid", value: bid },
        { type: "integer", value: 1 },
        { type: "text", value: "Stale" },
        { type: "text", value: "GENERAL" },
        { type: "text", value: null },
        { type: "text", value: "" },
        { type: "jsonb", value: ["A"] },
        { type: "text", value: null },
        { type: "boolean", value: false },
        { type: "text", value: staleKey },
        { type: "text", value: sha256(staleKey) },
      ]),
      "PT409",
      "VERSION_CONFLICT",
    );

    // Status transitions: DRAFT -> PUBLISHED -> ARCHIVED -> PUBLISHED
    const pubKey = nextKey("pub");
    const published = await callRpc(db, "hr_bulletin_set_status_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: bid },
      { type: "text", value: "PUBLISHED" },
      { type: "integer", value: 2 },
      { type: "text", value: pubKey },
      { type: "text", value: sha256(pubKey) },
    ]);
    assert.equal(published.item.status, "PUBLISHED");
    assert.equal(published.item.row_version, 3);
    assert.ok(published.item.published_at);
    assert.equal(published.item.archived_at, null);
    const originalPublishedAt = published.item.published_at;

    const archKey = nextKey("arch");
    const archived = await callRpc(db, "hr_bulletin_set_status_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: bid },
      { type: "text", value: "ARCHIVED" },
      { type: "integer", value: 3 },
      { type: "text", value: archKey },
      { type: "text", value: sha256(archKey) },
    ]);
    assert.equal(archived.item.status, "ARCHIVED");
    assert.equal(archived.item.row_version, 4);
    assert.ok(archived.item.archived_at);
    assert.equal(archived.item.published_at, originalPublishedAt);

    const repubKey = nextKey("repub");
    const republished = await callRpc(db, "hr_bulletin_set_status_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: bid },
      { type: "text", value: "PUBLISHED" },
      { type: "integer", value: 4 },
      { type: "text", value: repubKey },
      { type: "text", value: sha256(repubKey) },
    ]);
    assert.equal(republished.item.status, "PUBLISHED");
    assert.equal(republished.item.row_version, 5);
    assert.equal(republished.item.archived_at, null);
    assert.equal(republished.item.published_at, originalPublishedAt);

    // Pin / Unpin
    const pinKey = nextKey("pin");
    const pinned = await callRpc(db, "hr_bulletin_set_pinned_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: bid },
      { type: "boolean", value: true },
      { type: "integer", value: 5 },
      { type: "text", value: pinKey },
      { type: "text", value: sha256(pinKey) },
    ]);
    assert.equal(pinned.item.is_pinned, true);
    assert.equal(pinned.item.row_version, 6);

    // Attach IMAGE + Attach PDF + Delete IMAGE
    const imgId = nextUuid();
    const att1Key = nextKey("att-img");
    const att1 = await callRpc(db, "hr_bulletin_attach_file_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: bid },
      { type: "integer", value: 6 },
      { type: "uuid", value: imgId },
      { type: "text", value: "IMAGE" },
      { type: "text", value: "banner.webp" },
      { type: "text", value: "Banner thông báo" },
      { type: "text", value: "image/webp" },
      { type: "bigint", value: 123456 },
      { type: "text", value: `bulletins/${bid}/banner.webp` },
      { type: "integer", value: 1200 },
      { type: "integer", value: 630 },
      { type: "integer", value: null },
      { type: "text", value: sha256("banner") },
      { type: "text", value: att1Key },
      { type: "text", value: sha256(att1Key) },
    ]);
    assert.equal(att1.attachment_id, imgId);
    assert.equal(att1.item.row_version, 7);
    assert.equal(att1.item.image_count, 1);
    assert.equal(att1.item.pdf_count, 0);
    assert.equal(
      att1.item.attachments[0].url,
      `/api/bulletins/${bid}/attachments/${imgId}/content`,
    );

    const pdfId = nextUuid();
    const att2Key = nextKey("att-pdf");
    const att2 = await callRpc(db, "hr_bulletin_attach_file_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: bid },
      { type: "integer", value: 7 },
      { type: "uuid", value: pdfId },
      { type: "text", value: "PDF" },
      { type: "text", value: "huong-dan.pdf" },
      { type: "text", value: "Tài liệu hướng dẫn" },
      { type: "text", value: "application/pdf" },
      { type: "bigint", value: 654321 },
      { type: "text", value: `bulletins/${bid}/huong-dan.pdf` },
      { type: "integer", value: null },
      { type: "integer", value: null },
      { type: "integer", value: 5 },
      { type: "text", value: sha256("guide") },
      { type: "text", value: att2Key },
      { type: "text", value: sha256(att2Key) },
    ]);
    assert.equal(att2.item.row_version, 8);
    assert.equal(att2.item.image_count, 1);
    assert.equal(att2.item.pdf_count, 1);

    // Delete IMAGE attachment + replay + missing on fresh key
    const delKey = nextKey("del-att");
    const delHash = sha256("del-img");
    const deleted = await callRpc(db, "hr_bulletin_delete_attachment_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: bid },
      { type: "uuid", value: imgId },
      { type: "integer", value: 8 },
      { type: "text", value: delKey },
      { type: "text", value: delHash },
    ]);
    assert.equal(deleted.replayed, false);
    assert.equal(deleted.deleted_attachment_id, imgId);
    assert.equal(deleted.deleted_storage_key, `bulletins/${bid}/banner.webp`);
    assert.equal(deleted.item.row_version, 9);
    assert.equal(deleted.item.image_count, 0);
    assert.equal(deleted.item.pdf_count, 1);

    const delReplay = await callRpc(db, "hr_bulletin_delete_attachment_admin", [
      { type: "uuid", value: admin.authSubject },
      { type: "uuid", value: admin.appUserId },
      { type: "uuid", value: bid },
      { type: "uuid", value: imgId },
      { type: "integer", value: 8 },
      { type: "text", value: delKey },
      { type: "text", value: delHash },
    ]);
    assert.equal(delReplay.replayed, true);
    assert.equal(delReplay.item.row_version, 9);

    const delAgainKey = nextKey("del-missing");
    await expectSqlError(
      callRpc(db, "hr_bulletin_delete_attachment_admin", [
        { type: "uuid", value: admin.authSubject },
        { type: "uuid", value: admin.appUserId },
        { type: "uuid", value: bid },
        { type: "uuid", value: imgId },
        { type: "integer", value: 9 },
        { type: "text", value: delAgainKey },
        { type: "text", value: sha256(delAgainKey) },
      ]),
      "P0002",
      "BULLETIN_ATTACHMENT_NOT_FOUND",
    );
  } finally {
    await db.close();
  }
});
