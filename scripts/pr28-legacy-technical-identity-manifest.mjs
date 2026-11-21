#!/usr/bin/env node
/**
 * PR #28 Rev 4.1 / D5(2) — Read-Only Preflight Manifest CLI for Legacy Technical Identities.
 *
 * Strictly READ ONLY (executes inside `BEGIN TRANSACTION READ ONLY`).
 * NEVER modifies, deletes, cascades, or disables any account or live credential.
 *
 * Usage (ONLY when authorized by T0/Owner for live preflight):
 *   DATABASE_URL="postgres://..." node scripts/pr28-legacy-technical-identity-manifest.mjs \
 *     [--n8n-auth-subject <uuid>] [--n8n-app-user-id <uuid>] [--hrp-auth-subject <uuid>]
 */
import { Client } from "pg";
import { buildLegacyTechnicalIdentityManifest } from "./lib/pr28-legacy-identity-manifest.mjs";

function argVal(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("ERROR: DATABASE_URL is required (read-only preflight).");
    process.exit(2);
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("begin transaction read only");
    const manifest = await buildLegacyTechnicalIdentityManifest(client, {
      n8nAuthSubject: argVal("--n8n-auth-subject") ?? process.env.N8N_BOD_READONLY_AUTH_SUBJECT ?? null,
      n8nAppUserId: argVal("--n8n-app-user-id") ?? process.env.N8N_BOD_READONLY_APP_USER_ID ?? null,
      hrpAuthSubject: argVal("--hrp-auth-subject") ?? process.env.HRP_SYNC_AUTH_SUBJECT ?? null,
    });
    await client.query("rollback");
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Manifest preflight failed:", err?.message ?? err);
  process.exit(1);
});
