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
  extractPreservationHashes,
  inspectRoutineAclDrift,
  verifyPostCommitAlignmentInvariants,
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

export async function runRoutineAclAlignmentCli(
  argv,
  {
    log = console.log,
    createClient = (options) => new Client(options),
    afterCommitHook = null,
  } = {},
) {
  const args = parseCliArgs(argv);
  const target = resolveSafeConnectionTarget(args);

  const client = createClient({
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
          preservationHashes: extractPreservationHashes(inspection.preservation),
          bootstrapMismatches: inspection.bootstrapMismatches,
          mismatchesSample: inspection.mismatches.slice(0, 50),
        };
      } finally {
        await client.query("rollback");
      }
    } else if (args.mode === "dry-run") {
      await client.query("begin");
      let rehearsal;
      try {
        await client.query("set local statement_timeout = '60s'; set local lock_timeout = '5s';");
        rehearsal = await executeRoutineAclAlignmentInTransaction(client, {
          migrationsDir: args.migrationsDir,
          expectedFingerprint: args.expectedFingerprint,
        });
      } catch (err) {
        try {
          await client.query("rollback");
        } catch {
          // Preserve original rehearsal error; outer finally closes the connection.
        }
        throw err;
      }

      let rolledBack = false;
      try {
        await client.query("rollback");
        rolledBack = true;
      } catch (rollbackErr) {
        throw new Error(
          `DRY_RUN_ROLLBACK_FAILED: rehearsal ROLLBACK failed (${rollbackErr.message}); refusing to emit success report.`,
          { cause: rollbackErr },
        );
      }

      report = {
        mode: "dry-run",
        target: target.targetLabel,
        transaction: "BEGIN ... ROLLBACK (rehearsal only, zero persisted changes)",
        rolledBack,
        checkedAt: new Date().toISOString(),
        ...rehearsal,
      };
    } else {
      await client.query("begin");
      let applied;
      let committed = false;
      try {
        await client.query("set local statement_timeout = '60s'; set local lock_timeout = '5s';");
        applied = await executeRoutineAclAlignmentInTransaction(client, {
          migrationsDir: args.migrationsDir,
          expectedFingerprint: args.expectedFingerprint,
        });
        await client.query("commit");
        committed = true;
      } catch (err) {
        if (!committed) {
          try {
            await client.query("rollback");
          } catch {
            // Preserve original apply error; outer finally closes connection.
          }
        }
        throw err;
      }

      if (typeof afterCommitHook === "function") {
        await afterCommitHook({ target, applied });
      }

      // Independent post-commit read-only verification.
      // At this point the alignment transaction has ALREADY COMMITTED; never pretend to rollback
      // and never revert routine ACLs back to exposed state if verification fails.
      let postCommit;
      try {
        await client.query("begin transaction isolation level repeatable read read only");
        try {
          await client.query("set local statement_timeout = '30s'; set local lock_timeout = '5s';");
          postCommit = await inspectRoutineAclDrift(client, {
            migrationsDir: args.migrationsDir,
          });
        } finally {
          try {
            await client.query("rollback");
          } catch {
            // Ignore cleanup rollback error on read-only transaction if connection broke.
          }
        }
      } catch (verifyErr) {
        throw new Error(
          "POST_COMMIT_VERIFY_FAILED (TRANSACTION ALREADY COMMITTED — NOT ROLLED BACK; " +
            `post-commit read-only verification error; investigate and forward-fix, do not re-expose routine ACLs): ${verifyErr.message}`,
          { cause: verifyErr },
        );
      }

      const postCommitVerification = verifyPostCommitAlignmentInvariants(applied, postCommit);

      report = {
        mode: "apply",
        target: target.targetLabel,
        transaction: "BEGIN ... COMMIT + fresh READ ONLY verification",
        checkedAt: new Date().toISOString(),
        ...applied,
        postCommitSummary: postCommit.summary,
        postCommitBootstrapMemberships: postCommit.bootstrapContext.memberships,
        postCommitBootstrapActor: postCommit.bootstrapContext.actor,
        postCommitPreservationHashes: extractPreservationHashes(postCommit.preservation),
        postCommitVerification,
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
