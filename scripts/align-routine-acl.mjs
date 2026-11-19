#!/usr/bin/env node
/**
 * Safe routine ACL preflight, rollback rehearsal, and controlled remediation CLI.
 *
 * Modes (mutually exclusive; default `--preflight`):
 *   --preflight                                         Read-only REPEATABLE READ inventory + plan fingerprint
 *   --dry-run                                           Transactional rehearsal with mandatory ROLLBACK
 *   --apply --confirm-apply --expected-fingerprint <h>  Controlled transactional apply + fresh read-only verify
 *
 * Targets (choose one):
 *   --nwc-staging --config <path>                       NWC staging config (pinned ref + verified TLS CA)
 *   --db-url <postgres-url> [--allow-remote-target]     Explicit local/test PostgreSQL URL
 *
 * Optional:
 *   --out <json-path>                                   Write sanitized JSON report
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  executeRoutineAclAlignmentInTransaction,
  inspectRoutineAclDrift,
} from "./lib/routine-acl-alignment.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { parseExternalNwcConfig } from "./run-wp2a-effective-access-shadow.mjs";

const { Client } = pg;

export function parseCliArgs(argv) {
  const args = {
    mode: "preflight",
    modeExplicit: false,
    nwcStaging: false,
    configPath: null,
    dbUrl: null,
    allowRemoteTarget: false,
    confirmApply: false,
    expectedFingerprint: null,
    outPath: null,
    migrationsDir: path.resolve("supabase/migrations"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--preflight") {
      if (args.modeExplicit) throw new Error("CLI_MODE_CONFLICT: specify only one of --preflight, --dry-run, --apply.");
      args.mode = "preflight";
      args.modeExplicit = true;
    } else if (token === "--dry-run") {
      if (args.modeExplicit) throw new Error("CLI_MODE_CONFLICT: specify only one of --preflight, --dry-run, --apply.");
      args.mode = "dry-run";
      args.modeExplicit = true;
    } else if (token === "--apply") {
      if (args.modeExplicit) throw new Error("CLI_MODE_CONFLICT: specify only one of --preflight, --dry-run, --apply.");
      args.mode = "apply";
      args.modeExplicit = true;
    } else if (token === "--nwc-staging") {
      args.nwcStaging = true;
    } else if (token === "--config") {
      args.configPath = argv[++i] ?? null;
    } else if (token === "--db-url") {
      args.dbUrl = argv[++i] ?? null;
    } else if (token === "--allow-remote-target") {
      args.allowRemoteTarget = true;
    } else if (token === "--confirm-apply") {
      args.confirmApply = true;
    } else if (token === "--expected-fingerprint") {
      args.expectedFingerprint = argv[++i] ?? null;
    } else if (token === "--out") {
      args.outPath = argv[++i] ?? null;
    } else if (token === "--migrations-dir") {
      args.migrationsDir = path.resolve(argv[++i] ?? "supabase/migrations");
    } else {
      throw new Error(`UNKNOWN_ARGUMENT: ${token}`);
    }
  }

  if (args.mode === "apply") {
    if (!args.confirmApply) {
      throw new Error("APPLY_REQUIRES_CONFIRM: --apply requires --confirm-apply.");
    }
    if (!args.expectedFingerprint || !/^[0-9a-f]{64}$/i.test(args.expectedFingerprint)) {
      throw new Error(
        "APPLY_REQUIRES_FINGERPRINT: --apply requires --expected-fingerprint <64-hex-sha256> from --preflight.",
      );
    }
  }

  if (args.nwcStaging && args.dbUrl) {
    throw new Error("TARGET_CONFLICT: specify either --nwc-staging --config or --db-url, not both.");
  }
  if (args.nwcStaging && !args.configPath) {
    throw new Error("NWC_CONFIG_REQUIRED: --nwc-staging requires --config <path>.");
  }
  if (!args.nwcStaging && !args.dbUrl) {
    throw new Error("TARGET_REQUIRED: specify --nwc-staging --config <path> or --db-url <url>.");
  }

  return args;
}

export function resolveSafeConnectionTarget(args) {
  if (args.nwcStaging) {
    const cfg = parseExternalNwcConfig(args.configPath);
    return {
      targetLabel: `nwc-staging:${cfg.projectRef}`,
      connectionString: cfg.connectionString,
      ssl: cfg.ssl,
    };
  }

  const parsed = new URL(args.dbUrl);
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback && !args.allowRemoteTarget) {
    throw new Error(
      `REMOTE_TARGET_BLOCKED: refusing non-loopback host (${host}) without --allow-remote-target (or use --nwc-staging --config).`,
    );
  }
  return {
    targetLabel: isLoopback ? `local:${host}:${parsed.port || 5432}` : `remote:${host}`,
    connectionString: args.dbUrl,
    ssl: isLoopback ? false : buildSslOptions(),
  };
}

export async function runRoutineAclAlignmentCli(argv, { log = console.log } = {}) {
  const args = parseCliArgs(argv);
  const target = resolveSafeConnectionTarget(args);

  const client = new Client({
    connectionString: target.connectionString,
    ssl: target.ssl,
    connectionTimeoutMillis: 15000,
    application_name: `mini-bi-acl-align-${args.mode}`,
  });

  await client.connect();
  let report;
  try {
    if (args.mode === "preflight") {
      await client.query("begin transaction isolation level repeatable read read only");
      try {
        await client.query("set local statement_timeout = '30s'; set local lock_timeout = '5s';");
        const inspection = await inspectRoutineAclDrift(client, {
          migrationsDir: args.migrationsDir,
        });
        report = {
          mode: "preflight",
          target: target.targetLabel,
          transaction: "REPEATABLE READ READ ONLY ... ROLLBACK",
          checkedAt: new Date().toISOString(),
          planFingerprint: inspection.planFingerprint,
          summary: inspection.summary,
          bootstrapContext: inspection.bootstrapContext,
          missingCanonicalSignatures: inspection.missingCanonicalSignatures,
          unexpectedLiveSignatures: inspection.unexpectedLiveSignatures,
          ownerMismatches: inspection.ownerMismatches,
          nonOwnerGrantorMismatches: inspection.nonOwnerGrantorMismatches,
          unownedByCurrentUser: inspection.unownedByCurrentUser,
          preservationHashes: {
            schemaMigrationsHash: inspection.preservation.schemaMigrationsHash,
            routineBodiesHash: inspection.preservation.routineBodiesHash,
            defaultPrivilegesHash: inspection.preservation.defaultPrivilegesHash,
            unrelatedPublicRoutinesAclHash: inspection.preservation.unrelatedPublicRoutinesAclHash,
            bootstrapHelperGrantsHash: inspection.preservation.bootstrapHelperGrantsHash,
            bootstrapMembershipsHash: inspection.preservation.bootstrapMembershipsHash,
          },
          bootstrapMismatches: inspection.bootstrapMismatches,
          mismatchesSample: inspection.mismatches.slice(0, 50),
        };
      } finally {
        await client.query("rollback");
      }
    } else if (args.mode === "dry-run") {
      await client.query("begin");
      try {
        await client.query("set local statement_timeout = '60s'; set local lock_timeout = '5s';");
        const rehearsal = await executeRoutineAclAlignmentInTransaction(client, {
          migrationsDir: args.migrationsDir,
          expectedFingerprint: args.expectedFingerprint,
        });
        report = {
          mode: "dry-run",
          target: target.targetLabel,
          transaction: "BEGIN ... ROLLBACK (rehearsal only, zero persisted changes)",
          checkedAt: new Date().toISOString(),
          ...rehearsal,
        };
      } finally {
        await client.query("rollback");
      }
    } else {
      await client.query("begin");
      let applied;
      try {
        await client.query("set local statement_timeout = '60s'; set local lock_timeout = '5s';");
        applied = await executeRoutineAclAlignmentInTransaction(client, {
          migrationsDir: args.migrationsDir,
          expectedFingerprint: args.expectedFingerprint,
        });
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }

      // Independent post-commit read-only verification
      await client.query("begin transaction isolation level repeatable read read only");
      let postCommit;
      try {
        await client.query("set local statement_timeout = '30s'; set local lock_timeout = '5s';");
        postCommit = await inspectRoutineAclDrift(client, {
          migrationsDir: args.migrationsDir,
        });
      } finally {
        await client.query("rollback");
      }

      if (!postCommit.postconditions.ok || postCommit.summary.mismatchCount !== 0) {
        throw new Error(
          `POST_COMMIT_VERIFY_FAILED: postconditionsOk=${postCommit.postconditions.ok}, mismatches=${postCommit.summary.mismatchCount}`,
        );
      }

      report = {
        mode: "apply",
        target: target.targetLabel,
        transaction: "BEGIN ... COMMIT + fresh READ ONLY verification",
        checkedAt: new Date().toISOString(),
        ...applied,
        postCommitSummary: postCommit.summary,
        postCommitBootstrapMemberships: postCommit.bootstrapContext.memberships,
      };
    }
  } finally {
    await client.end();
  }

  if (args.outPath) {
    await writeFile(args.outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  log(JSON.stringify(report, null, 2));
  return report;
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  runRoutineAclAlignmentCli(process.argv.slice(2)).catch((error) => {
    console.error("ACL ALIGNMENT FAILED:", error.message);
    process.exitCode = 1;
  });
}
