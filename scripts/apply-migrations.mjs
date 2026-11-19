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
 *   SUPABASE_CONFIG_FILE=<path> node scripts/apply-migrations.mjs
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import {
  migrationChecksum,
  migrationSqlForTransaction,
  runMigrationValidation,
  verifyAppliedMigrationChecksum,
} from "./lib/migration-validation.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const dryRun = process.argv.includes("--dry-run");
const offline = process.argv.includes("--offline");

async function main() {
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

  const entries = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (entries.length === 0) {
    throw new Error(`Không tìm thấy file .sql trong ${MIGRATIONS_DIR}`);
  }

  const { databaseUrl, projectRef, usesPooler } = await loadSupabaseConfig();
  const client = new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() });
  await client.connect();
  console.log(`Kết nối DB thành công (project ref: ${projectRef.slice(0, 4)}***, pooler: ${usesPooler ? "có" : "không"})`);

  await client.query(`
    create table if not exists public.schema_migrations (
      version     text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);

  const { rows: applied } = await client.query("select version, checksum from public.schema_migrations");
  const appliedMap = new Map(applied.map((r) => [r.version, r.checksum]));

  let appliedCount = 0;
  let skippedCount = 0;

  for (const name of entries) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    const sum = migrationChecksum(sql);
    const previous = appliedMap.get(name);

    if (previous !== undefined) {
      const check = await verifyAppliedMigrationChecksum(
        client,
        { name, sql, checksum: sum },
        previous,
        appliedMap,
      );
      if (check.status === "postcondition_failed") {
        await client.end();
        throw new Error(
          `Migration ${name} khớp checksum trong ledger nhưng kiểm tra hậu điều kiện bảo mật thất bại (postcondition failed: ${check.reason}). ` +
            "Chạy công cụ căn chỉnh ACL môi trường (scripts/align-routine-acl.mjs) trước khi áp dụng migration mới.",
        );
      }
      if (check.status === "mismatch") {
        await client.end();
        throw new Error(
          `Migration ${name} đã áp dụng nhưng nội dung đã thay đổi (checksum mismatch${check.reason ? `: ${check.reason}` : ""}). ` +
            "Không sửa file migration đã áp dụng — hãy tạo file migration mới."
        );
      }
      if (check.status === "compatible_historical") {
        console.log(
          `SKIP    ${name} (đã áp dụng — tương thích checksum lịch sử trước PR #92 đã xác minh postconditions)`,
        );
      } else if (check.postconditionsChecked) {
        console.log(`SKIP    ${name} (đã áp dụng — khớp checksum và đạt postconditions bảo mật)`);
      } else {
        console.log(`SKIP    ${name} (đã áp dụng)`);
      }
      skippedCount += 1;
      continue;
    }

    try {
      await client.query("begin");
      await client.query(migrationSqlForTransaction(sql));
      await client.query(
        "insert into public.schema_migrations (version, checksum) values ($1, $2)",
        [name, sum]
      );
      await client.query("commit");
      appliedMap.set(name, sum);
      console.log(`APPLY   ${name}`);
      appliedCount += 1;
    } catch (error) {
      try {
        await client.query("rollback");
      } finally {
        await client.end();
      }
      console.error(`FAILED  ${name}: ${error.message}`);
      throw error;
    }
  }

  console.log(`\nKết quả: ${appliedCount} áp dụng mới, ${skippedCount} bỏ qua, ${entries.length} tổng.`);

  const { rows: tables } = await client.query(`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('data_sources', 'sync_runs', 'daily_recruitment_breakdown', 'sync_errors')
     order by table_name
  `);
  console.log("Bảng hiện có:", tables.map((r) => r.table_name).join(", ") || "(không có)");

  await client.end();
}

main().catch((error) => {
  console.error("\nMIGRATION THẤT BẠI:", error.message);
  process.exitCode = 1;
});
