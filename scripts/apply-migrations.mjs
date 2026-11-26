#!/usr/bin/env node
/**
 * Áp dụng migration lên Supabase theo thứ tự tên file.
 *
 * - Đọc connection string từ file cấu hình ngoài repo (không commit).
 * - Mỗi file chạy trong MỘT transaction, kèm ghi nhận vào public.schema_migrations.
 * - Idempotent: file đã áp dụng sẽ bị bỏ qua; checksum lệch => dừng và báo lỗi
 *   (trừ trường hợp duy nhất được kiểm soát cho migration #124 khi mang checksum
 *   lịch sử trước PR #92 và vượt qua toàn bộ kiểm tra security postconditions).
 *
 * Dùng:
 *   node scripts/apply-migrations.mjs [--dry-run | --offline]
 *   node scripts/apply-migrations.mjs \
 *     --verify-wp10-7-2b-archive <csvPath> \
 *     --wp10-7-2b-expected-count <n> \
 *     --wp10-7-2b-expected-sha256 <hex>
 *   SUPABASE_CONFIG_FILE=<path> node scripts/apply-migrations.mjs
 */
import path from "node:path";
import process from "node:process";
import pg from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import {
  createWp1072bArchiveGuard,
  loadLeaveProfileUnitKindArchiveCsv,
  runMigrationApply,
  runMigrationValidation,
} from "./lib/migration-validation.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const NON_NEG_INT_RE = /^(0|[1-9]\d*)$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

function parseCliArgs(argv) {
  let dryRun = false;
  let offline = false;
  let archiveCsvPath = null;
  let expectedCountRaw = null;
  let expectedSha256Raw = null;

  const takeValue = (args, index, flagName, inlineValue) => {
    if (inlineValue !== null) {
      if (inlineValue === "") {
        throw new Error(`Thiếu giá trị cho tham số ${flagName}`);
      }
      return { value: inlineValue, nextIndex: index };
    }
    const next = args[index + 1];
    if (next === undefined || next === "" || next.startsWith("--")) {
      throw new Error(`Thiếu giá trị cho tham số ${flagName}`);
    }
    return { value: next, nextIndex: index + 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--dry-run") {
      if (dryRun) throw new Error("Tham số --dry-run bị lặp lại");
      dryRun = true;
      continue;
    }
    if (arg === "--offline") {
      if (offline) throw new Error("Tham số --offline bị lặp lại");
      offline = true;
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inline = eqIdx === -1 ? null : arg.slice(eqIdx + 1);

    if (flag === "--verify-wp10-7-2b-archive") {
      if (archiveCsvPath !== null) {
        throw new Error(`Tham số ${flag} bị lặp lại`);
      }
      const parsed = takeValue(argv, i, flag, inline);
      archiveCsvPath = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (flag === "--wp10-7-2b-expected-count") {
      if (expectedCountRaw !== null) {
        throw new Error(`Tham số ${flag} bị lặp lại`);
      }
      const parsed = takeValue(argv, i, flag, inline);
      expectedCountRaw = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (flag === "--wp10-7-2b-expected-sha256") {
      if (expectedSha256Raw !== null) {
        throw new Error(`Tham số ${flag} bị lặp lại`);
      }
      const parsed = takeValue(argv, i, flag, inline);
      expectedSha256Raw = parsed.value;
      i = parsed.nextIndex;
      continue;
    }

    throw new Error(`Tham số không hợp lệ: ${arg}`);
  }

  if (dryRun && offline) {
    throw new Error("Không thể dùng đồng thời --dry-run và --offline");
  }

  const archiveFlagsPresent = [
    archiveCsvPath !== null,
    expectedCountRaw !== null,
    expectedSha256Raw !== null,
  ];
  const anyArchiveFlag = archiveFlagsPresent.some(Boolean);
  const allArchiveFlags = archiveFlagsPresent.every(Boolean);

  if (anyArchiveFlag && (offline || dryRun)) {
    throw new Error(
      "Không thể dùng --verify-wp10-7-2b-archive / --wp10-7-2b-expected-* cùng với --offline hoặc --dry-run",
    );
  }
  if (anyArchiveFlag && !allArchiveFlags) {
    throw new Error(
      "Khi kiểm tra archive WP10-7-2B phải truyền đủ bộ 3 tham số: --verify-wp10-7-2b-archive, --wp10-7-2b-expected-count, --wp10-7-2b-expected-sha256",
    );
  }

  if (!anyArchiveFlag) {
    return { dryRun, offline, wp1072bArchive: null };
  }

  if (!NON_NEG_INT_RE.test(expectedCountRaw)) {
    throw new Error(
      `Giá trị --wp10-7-2b-expected-count không hợp lệ: ${expectedCountRaw}`,
    );
  }
  const expectedRowCount = Number(expectedCountRaw);
  if (!Number.isSafeInteger(expectedRowCount) || expectedRowCount < 0) {
    throw new Error(
      `Giá trị --wp10-7-2b-expected-count vượt giới hạn: ${expectedCountRaw}`,
    );
  }
  if (!SHA256_HEX_RE.test(expectedSha256Raw)) {
    throw new Error(
      `Giá trị --wp10-7-2b-expected-sha256 không hợp lệ (cần 64 ký tự hex): ${expectedSha256Raw}`,
    );
  }

  return {
    dryRun,
    offline,
    wp1072bArchive: {
      csvPath: archiveCsvPath,
      expectedRowCount,
      expectedCanonicalSha256: expectedSha256Raw.toLowerCase(),
    },
  };
}

async function main() {
  const { dryRun, offline, wp1072bArchive } = parseCliArgs(process.argv.slice(2));

  if (offline || dryRun) {
    const result = await runMigrationValidation({
      mode: offline ? "offline" : "dry-run",
      directory: MIGRATIONS_DIR,
      loadConfig: loadSupabaseConfig,
      createClient: (databaseUrl) =>
        new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() }),
    });
    if (result.mismatches.length > 0) {
      if (result.postconditionFailures?.length > 0) {
        const details = result.postconditionFailures
          .map((item) => `${item.migration}: ${item.reason}`)
          .join("; ");
        throw new Error(`Migration security postcondition failed: ${details}`);
      }
      throw new Error(`Migration checksum mismatch: ${result.mismatches.join(", ")}`);
    }
    return;
  }

  let beforeApplyMigration = null;
  if (wp1072bArchive) {
    const parsedArchive = await loadLeaveProfileUnitKindArchiveCsv(
      wp1072bArchive.csvPath,
    );
    if (
      parsedArchive.rowCount !== wp1072bArchive.expectedRowCount ||
      parsedArchive.canonicalSha256 !== wp1072bArchive.expectedCanonicalSha256
    ) {
      throw new Error(
        `WP10-7-2B archive CSV không khớp tham số kỳ vọng: ` +
          `csv=(row_count=${parsedArchive.rowCount}, canonical_sha256=${parsedArchive.canonicalSha256}), ` +
          `expected=(row_count=${wp1072bArchive.expectedRowCount}, canonical_sha256=${wp1072bArchive.expectedCanonicalSha256})`,
      );
    }
    beforeApplyMigration = createWp1072bArchiveGuard({
      expectedRowCount: wp1072bArchive.expectedRowCount,
      expectedCanonicalSha256: wp1072bArchive.expectedCanonicalSha256,
    });
  }

  await runMigrationApply({
    directory: MIGRATIONS_DIR,
    loadConfig: loadSupabaseConfig,
    createClient: (databaseUrl) =>
      new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() }),
    beforeApplyMigration,
    runInTransaction: async (client, runMigrationBody) => {
      await client.query("begin");
      try {
        await runMigrationBody();
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    },
  });
}

main().catch((error) => {
  console.error("\nMIGRATION THẤT BẠI:", error.message);
  process.exitCode = 1;
});
