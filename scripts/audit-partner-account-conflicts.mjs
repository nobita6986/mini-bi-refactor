#!/usr/bin/env node
/**
 * Read-only Conflict Audit for Partner Account Provisioning & Cross-Catalog Uniqueness.
 *
 * Inspects `public.vendors` (excluding `__system_vendor__`), `public.collaborators`,
 * `public.partner_code_registry` / `public.partner_accounts` (if migrated), and
 * `auth.users` `@hrpartner.vn` login email collisions inside a single
 * `BEGIN TRANSACTION READ ONLY ... ROLLBACK`.
 *
 * Never prints connection URIs, secrets, activation hashes, or worker PII.
 *
 * Usage:
 *   node scripts/audit-partner-account-conflicts.mjs [--db-url <uri>] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";

import { buildSslOptions } from "./lib/supabase-tls.mjs";

const { Client } = pg;

export const DEFAULT_REQ_CONFIG_FILE =
  "C:/importal/db-test-req/DB-staging-for-VPS-req.txt";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const CANONICAL_LOGIN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseCliArgs(argv) {
  let dbUrl = null;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--json") {
      if (json) throw new Error("Duplicate flag --json");
      json = true;
      continue;
    }
    const eqIdx = arg.indexOf("=");
    const flag = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inline = eqIdx === -1 ? null : arg.slice(eqIdx + 1);
    if (flag === "--db-url") {
      if (dbUrl !== null) throw new Error("Duplicate flag --db-url");
      if (inline !== null) {
        if (!inline.trim()) throw new Error("Missing value for --db-url");
        dbUrl = inline.trim();
      } else {
        const next = argv[i + 1];
        if (!next || !next.trim() || next.startsWith("--")) {
          throw new Error("Missing value for --db-url");
        }
        dbUrl = next.trim();
        i += 1;
      }
      continue;
    }
    throw new Error(`Unknown CLI argument: ${arg}`);
  }

  return { dbUrl, json, help };
}

export function printUsage() {
  console.log(
    "Usage: node scripts/audit-partner-account-conflicts.mjs [--db-url <uri>] [--json]",
  );
  console.log(
    "Read-only audit of intra-catalog, cross-catalog, unregistered, and @hrpartner.vn email conflicts.",
  );
}

function resolveDbUrl(cliDbUrl) {
  if (cliDbUrl) return cliDbUrl;
  if (process.env.SUPABASE_DB_URL?.trim()) return process.env.SUPABASE_DB_URL.trim();
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();

  if (fs.existsSync(DEFAULT_REQ_CONFIG_FILE)) {
    const raw = fs.readFileSync(DEFAULT_REQ_CONFIG_FILE, "utf8");
    const match = raw.match(/^\s*(?:SUPABASE_DB_URL|DATABASE_URL)\s*=\s*(.+)\s*$/m);
    if (match?.[1]?.trim()) {
      return match[1].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return null;
}

function buildClientConfig(dbUrl) {
  const parsed = new URL(dbUrl);
  const ssl = LOOPBACK_HOSTS.has(parsed.hostname) ? false : buildSslOptions();
  return { connectionString: dbUrl, ssl };
}

export async function auditPartnerAccountConflicts(client, options = {}) {
  const manageTransaction = options.manageTransaction !== false;
  if (manageTransaction) {
    await client.query("begin transaction read only");
  }

  try {
    const { rows: [catalogMeta] } = await client.query(`
      select
        pg_catalog.to_regclass('public.vendors') is not null as has_vendors,
        pg_catalog.to_regclass('public.collaborators') is not null as has_collaborators,
        pg_catalog.to_regclass('public.partner_code_registry') is not null as has_registry,
        pg_catalog.to_regclass('public.partner_accounts') is not null as has_partner_accounts,
        exists (
          select 1
            from pg_catalog.pg_attribute a
           where a.attrelid = pg_catalog.to_regclass('auth.users')
             and a.attname = 'email'
             and not a.attisdropped
        ) as has_auth_email
    `);

    if (!catalogMeta.has_vendors) {
      throw new Error("public.vendors table does not exist in target database");
    }

    const { rows: catalogRows } = await client.query(`
      select
        'VENDOR'::text as partner_kind,
        v.vendor_id as partner_id,
        pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) as canonical_code,
        v.display_name,
        v.active
      from public.vendors v
      where v.vendor_id <> '__system_vendor__'
      ${catalogMeta.has_collaborators ? `
      union all
      select
        'COLLABORATOR'::text as partner_kind,
        c.collaborator_id as partner_id,
        pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) as canonical_code,
        c.display_name,
        c.active
      from public.collaborators c
      where c.collaborator_id <> '__system_vendor__'
      ` : ""}
      order by canonical_code asc, partner_kind asc, partner_id asc
    `);

    const byKindAndCanonical = new Map();
    const byCanonical = new Map();
    const invalidUsernameFormats = [];

    for (const row of catalogRows) {
      const kKey = `${row.partner_kind}:${row.canonical_code}`;
      if (!byKindAndCanonical.has(kKey)) byKindAndCanonical.set(kKey, []);
      byKindAndCanonical.get(kKey).push(row);

      if (!byCanonical.has(row.canonical_code)) byCanonical.set(row.canonical_code, []);
      byCanonical.get(row.canonical_code).push(row);

      if (!CANONICAL_LOGIN_RE.test(row.canonical_code)) {
        invalidUsernameFormats.push({
          partner_kind: row.partner_kind,
          partner_id: row.partner_id,
          canonical_code: row.canonical_code,
          active: Boolean(row.active),
        });
      }
    }

    const intraCatalogDuplicates = [];
    for (const [key, list] of byKindAndCanonical.entries()) {
      if (list.length > 1) {
        const [partner_kind, canonical_code] = key.split(":");
        intraCatalogDuplicates.push({
          partner_kind,
          canonical_code,
          row_count: list.length,
          rows: list.map((r) => ({
            partner_id: r.partner_id,
            display_name: r.display_name,
            active: Boolean(r.active),
          })),
        });
      }
    }

    const crossCatalogDuplicates = [];
    for (const [canonical_code, list] of byCanonical.entries()) {
      const kinds = new Set(list.map((r) => r.partner_kind));
      if (kinds.size > 1) {
        crossCatalogDuplicates.push({
          canonical_code,
          rows: list.map((r) => ({
            partner_kind: r.partner_kind,
            partner_id: r.partner_id,
            display_name: r.display_name,
            active: Boolean(r.active),
          })),
        });
      }
    }

    let unregisteredCatalogRows = [];
    if (catalogMeta.has_registry) {
      const { rows: unregRows } = await client.query(`
        with ce as (
          select
            'VENDOR'::text as partner_kind,
            v.vendor_id as partner_id,
            pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) as canonical_code,
            v.display_name,
            v.active
          from public.vendors v
          where v.vendor_id <> '__system_vendor__'
          union all
          select
            'COLLABORATOR'::text as partner_kind,
            c.collaborator_id as partner_id,
            pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) as canonical_code,
            c.display_name,
            c.active
          from public.collaborators c
          where c.collaborator_id <> '__system_vendor__'
        )
        select ce.partner_kind, ce.partner_id, ce.canonical_code, ce.display_name, ce.active
          from ce
         where not exists (
           select 1
             from public.partner_code_registry r
            where r.canonical_code = ce.canonical_code
              and (
                (ce.partner_kind = 'VENDOR' and r.vendor_id = ce.partner_id)
                or
                (ce.partner_kind = 'COLLABORATOR' and r.collaborator_id = ce.partner_id)
              )
         )
         order by ce.canonical_code asc, ce.partner_kind asc, ce.partner_id asc
      `);
      unregisteredCatalogRows = unregRows;
    }

    let authEmailCollisions = [];
    if (catalogMeta.has_auth_email) {
      const { rows: collisionRows } = await client.query(`
        with catalog_codes as (
          select distinct pg_catalog.lower(pg_catalog.btrim(v.vendor_id)) as canonical_code
            from public.vendors v
           where v.vendor_id <> '__system_vendor__'
          ${catalogMeta.has_collaborators ? `
          union
          select distinct pg_catalog.lower(pg_catalog.btrim(c.collaborator_id)) as canonical_code
            from public.collaborators c
           where c.collaborator_id <> '__system_vendor__'
          ` : ""}
        )
        select
          pg_catalog.lower(pg_catalog.btrim(au.email)) as email,
          au.id as auth_subject,
          pg_catalog.split_part(pg_catalog.lower(pg_catalog.btrim(au.email)), '@', 1) as canonical_code
        from auth.users au
        join catalog_codes cc
          on pg_catalog.lower(pg_catalog.btrim(coalesce(au.email, ''))) = cc.canonical_code || '@hrpartner.vn'
        ${catalogMeta.has_partner_accounts ? `
        where not exists (
          select 1
            from public.partner_accounts pa
            join public.direct_entry_app_users u on u.app_user_id = pa.app_user_id
           where u.auth_subject = au.id
        )
        ` : ""}
        order by email asc, au.id asc
      `);
      authEmailCollisions = collisionRows;
    }

    const conflictCount =
      intraCatalogDuplicates.length +
      crossCatalogDuplicates.length +
      unregisteredCatalogRows.length +
      authEmailCollisions.length;

    return {
      schema_ready: Boolean(catalogMeta.has_registry && catalogMeta.has_partner_accounts),
      total_catalog_rows: catalogRows.length,
      has_conflicts: conflictCount > 0,
      conflict_count: conflictCount,
      intra_catalog_duplicates: intraCatalogDuplicates,
      cross_catalog_duplicates: crossCatalogDuplicates,
      unregistered_catalog_rows: unregisteredCatalogRows,
      auth_email_collisions: authEmailCollisions,
      non_provisionable_code_formats: invalidUsernameFormats,
    };
  } finally {
    if (manageTransaction) {
      await client.query("rollback").catch(() => {});
    }
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const dbUrl = resolveDbUrl(args.dbUrl);
  if (!dbUrl) {
    throw new Error(
      "Missing database URL. Pass --db-url <uri> or set SUPABASE_DB_URL / DATABASE_URL.",
    );
  }

  const client = new Client(buildClientConfig(dbUrl));
  await client.connect();
  try {
    const report = await auditPartnerAccountConflicts(client, {
      manageTransaction: true,
    });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Schema ready: ${report.schema_ready}`);
      console.log(`Total catalog rows scanned: ${report.total_catalog_rows}`);
      console.log(`Blocking conflicts: ${report.conflict_count}`);
      console.log(`  - Intra-catalog case-insensitive duplicates: ${report.intra_catalog_duplicates.length}`);
      console.log(`  - Cross-catalog Vendor vs Collaborator duplicates: ${report.cross_catalog_duplicates.length}`);
      console.log(`  - Unregistered catalog rows: ${report.unregistered_catalog_rows.length}`);
      console.log(`  - Auth @hrpartner.vn email collisions: ${report.auth_email_collisions.length}`);
      console.log(`  - Non-provisionable login format codes (info): ${report.non_provisionable_code_formats.length}`);
    }
    if (report.has_conflicts) {
      process.exitCode = 2;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exitCode = 1;
  });
}
