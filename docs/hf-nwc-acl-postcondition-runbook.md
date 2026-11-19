# Runbook: Routine ACL Postcondition Verification & Safe NWC Alignment

## 1. Mục đích & Phạm vi

Tài liệu này mô tả quy trình xác minh hậu điều kiện ACL routine (`S0-T1-C`) và đồng bộ ACL an toàn trên môi trường mục tiêu (như NWC Staging) **không tạo migration mới** và **không sửa đổi mã nguồn hàm/ledger/default privileges**.

### Thay đổi bảo vệ cốt lõi

1. **Migration validator luôn fail-closed theo hậu điều kiện ACL sống**:
   - `scripts/apply-migrations.mjs` (`--dry-run` và chế độ apply) không chỉ so khớp SHA-256 của `20261020180000_s0_t1_c_rpc_acl_allowlist.sql` mà **luôn** chạy `verifyS0T1CSecurityPostconditions()` kiểm tra trực tiếp `pg_proc` trên DB mục tiêu ngay cả khi checksum file `#124` khớp tuyệt đối.
   - Bất kỳ sai lệch nào (`anon`/`authenticated`/`PUBLIC` có `EXECUTE`, routine nằm ngoài allowlist có `service_role`, routine trong allowlist thiếu `service_role`, chủ sở hữu mất `EXECUTE`, `search_path` không an toàn, hoặc role `direct_entry_catalog_bootstrap_executor` mất bất biến) đều báo `POSTCONDITION FAILED` và dừng apply.
2. **Công cụ đồng bộ ACL có kiểm soát (`pnpm db:align-routine-acl` / `scripts/align-routine-acl.mjs`)**:
   - Tự suy diễn tập ACL chuẩn **từ đúng danh sách migration đã ghi nhận trong `public.schema_migrations` của DB mục tiêu** (qua replay PGlite sạch đối chiếu với `buildExpectedS0T1CAllowlist`), bỏ qua hoàn toàn các migration mới hơn chưa apply ở local và **không hardcode số lượng routine** (như `335` hay `558`).
   - Bao phủ **cả 3 hàm thuộc sở hữu `direct_entry_catalog_bootstrap_executor`** dưới tài khoản không phải superuser (`rolsuper=false`, `MEMBER=true`, `SET=false`), hỗ trợ cả 2 cấu hình `pg_auth_members` nhiều grantor:
     - **Topology A** (chưa có dòng `grantor = current_user`): tạm cấp `GRANT direct_entry_catalog_bootstrap_executor TO <session_user> WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`, chạy `SET LOCAL ROLE direct_entry_catalog_bootstrap_executor`, cập nhật ACL, `RESET ROLE`, và thu hồi đúng dòng `GRANTED BY <current_user>`.
     - **Topology B** (đã có sẵn dòng `grantor = current_user` với `set_option = false`): tạm bật `GRANT direct_entry_catalog_bootstrap_executor TO <session_user> WITH SET TRUE`, cập nhật ACL qua `SET LOCAL ROLE`, `RESET ROLE`, và tắt đúng tùy chọn `REVOKE SET OPTION FOR direct_entry_catalog_bootstrap_executor FROM <session_user> GRANTED BY <current_user>`.
     - **Topology C** (`ADMIN OPTION = false`, `SET = false`): fail-closed ngay (`BOOTSTRAP_EXECUTOR_PRECONDITION_FAILED`), tuyệt đối **không** âm thầm bỏ qua 3 hàm bootstrap.
   - Kiểm tra khôi phục byte-for-byte bảng `pg_auth_members` và 6 mã băm bảo toàn (`schema_migrations`, nội dung/owner/`proconfig` toàn bộ routine `public`, `pg_default_acl`, ACL các routine ngoài tập mục tiêu, 4 hàm helper cho `direct_entry_catalog_bootstrap_executor`, và `pg_auth_members`) trước khi `COMMIT`. Nếu có bất kỳ lỗi hoặc sai lệch nào, toàn bộ transaction tự `ROLLBACK`.

---

## 2. Điều kiện tiên quyết của tài khoản vận hành (Operator Preconditions)

- Tài khoản kết nối DB mục tiêu phải là chủ sở hữu các routine `public` thuộc phạm vi (trừ 3 hàm bootstrap) **hoặc** là superuser.
- Với 3 hàm thuộc `direct_entry_catalog_bootstrap_executor`, tài khoản phải thỏa một trong các điều kiện:
  - Đã có `pg_has_role(session_user, 'direct_entry_catalog_bootstrap_executor', 'SET') = true`, **hoặc**
  - Có ít nhất 1 dòng `pg_auth_members` với `admin_option = true` trên `direct_entry_catalog_bootstrap_executor` (khớp trạng thái NWC đã khảo sát: `postgres` có `MEMBER=true, SET=false`, kèm dòng `ADMIN=true`).
- Nếu không có `SET` lẫn `ADMIN OPTION`, operator cần cấp tạm `ADMIN OPTION` từ tài khoản quản trị nền tảng (ví dụ `supabase_admin`) trước bước `--dry-run`/`--apply` và thu hồi lại sau đó.
- Với target NWC ngoài localhost, sử dụng `--nwc-staging --config <path-to-config>` (qua `parseExternalNwcConfig`, chỉ nhận HTTPS/Postgres từ file cấu hình ngoài repo, không commit secret).

---

## 3. Quy trình thực thi 5 bước có kiểm soát

> **Cổng phê duyệt**: Chỉ chạy bước `--apply` sau khi T0/Owner phê duyệt PR và đã hoàn tất backup + rehearsal rollback.

### Bước 1 — Backup DB mục tiêu
Chụp snapshot/backup NWC Staging trước khi thực thi bất kỳ thay đổi quyền nào.

### Bước 2 — Preflight Read-Only (chụp fingerprint & phân loại drift)
Chạy trong transaction `REPEATABLE READ READ ONLY` và kết thúc bằng `ROLLBACK` (0 ghi):

```bash
pnpm db:align-routine-acl -- --preflight --nwc-staging --config <external-config-path> --out <preflight-report.json>
```

Kiểm tra báo cáo JSON đầu ra:
- `summary.appliedMigrationCount`: khớp đúng số migration đang có trên DB mục tiêu.
- `summary.missingCanonicalSignatureCount === 0` và `summary.unexpectedLiveSignatureCount === 0`.
- `summary.ownerMismatchCount === 0` và `summary.unownedByCurrentUserCount === 0`.
- `bootstrapContext.canExecuteBootstrapAlignment === true` và ghi nhận rõ `bootstrapContext.elevationStrategy`, danh sách `memberships` (đủ `grantor_name`, `admin_option`, `inherit_option`, `set_option`), cùng `nonOwnerGrantorMismatches` (nếu có).
- Lưu lại giá trị **`planFingerprint`** (SHA-256).

### Bước 3 — Rehearsal Rollback (`--dry-run`)
Chạy toàn bộ các lệnh `REVOKE`/`GRANT` (bao gồm 3 hàm bootstrap và bước khôi phục `pg_auth_members`) trong 1 transaction, kiểm chứng hậu điều kiện và 6 hash bảo toàn, sau đó **bắt buộc `ROLLBACK`**:

```bash
pnpm db:align-routine-acl -- --dry-run --nwc-staging --config <external-config-path> --out <dryrun-report.json>
```

Điều kiện qua cổng:
- `rolledBack === true` (tool chỉ gán `rolledBack: true` và xuất báo cáo sau khi lệnh `ROLLBACK` hoàn tất thành công; nếu `ROLLBACK` lỗi, CLI thoát lỗi `DRY_RUN_ROLLBACK_FAILED` và không xuất báo cáo thành công).
- `afterSummary.mismatchCount === 0`
- `afterSummary.exposedClientOrPublicCount === 0`
- `afterSummary.extraServiceRoleCount === 0`
- `afterSummary.missingServiceRoleCount === 0`
- `afterSummary.postconditionsOk === true`
- `actions.bootstrapMembershipsRestoredExact === true` và `bootstrapAfter.memberships` khớp nguyên trạng `bootstrapBefore.memberships` (`bootstrapAfter.actor.can_set` giữ nguyên giá trị ban đầu, không mở rộng `SET`/`INHERIT`/`ADMIN`).

### Bước 4 — Apply có kiểm soát (`--apply`)
Chỉ chạy khi Bước 2 và Bước 3 đạt 100%, truyền đúng `--confirm-apply` và `--expected-fingerprint <planFingerprint>`:

```bash
pnpm db:align-routine-acl -- --apply --confirm-apply --expected-fingerprint <planFingerprint> --nwc-staging --config <external-config-path> --out <apply-report.json>
```

Nếu trạng thái DB thay đổi giữa Bước 2 và Bước 4, tool dừng ngay với `PLAN_FINGERPRINT_MISMATCH` trước khi ghi.
Sau khi `COMMIT`, tool mở một phiên đọc mới (`REPEATABLE READ READ ONLY ... ROLLBACK`) và tự động đối chiếu đủ toàn bộ bất biến hậu COMMIT. Điều kiện qua cổng trên `<apply-report.json>`:
- `postCommitVerification.passed === true` và `postCommitVerification.committed === true`
- `postCommitVerification.aclPostconditionsOk === true` và `postCommitVerification.mismatchCount === 0` (`postCommitSummary.exposedClientOrPublicCount === 0`, `extraServiceRoleCount === 0`, `missingServiceRoleCount === 0`)
- `postCommitVerification.preservationHashesUnchanged === true` (`postCommitPreservationHashes` khớp cả 6 mã băm `preservationHashes` đã xác minh trước `COMMIT`)
- `postCommitVerification.bootstrapMembershipsRestoredExact === true` và `postCommitVerification.bootstrapRoleStateUnchanged === true` (`postCommitBootstrapMemberships` khớp byte-for-byte `bootstrapBefore.memberships`; `postCommitBootstrapActor.can_set`/`usage`/`member` không đổi)

> **Xử lý khi hậu `COMMIT` thất bại (`POST_COMMIT_VERIFY_FAILED`)**: Nếu bất kỳ bất biến nào (ACL, 6 mã băm bảo toàn, `pg_auth_members` hoặc cờ `SET`/`INHERIT`/`ADMIN`) lệch trong lượt đọc sau `COMMIT`, CLI thoát lỗi rõ ràng với thông điệp **`TRANSACTION ALREADY COMMITTED — NOT ROLLED BACK`** và **không** xuất báo cáo thành công. Giao dịch đồng bộ ACL **đã commit**; operator tuyệt đối không giả định đã rollback và **không** khôi phục lại ACL mở rộng lỗi cho `anon`/`authenticated`/`PUBLIC` — tiến hành điều tra sai lệch và áp dụng **forward-fix** có kiểm soát.

### Bước 5 — Xác minh hậu apply (Migration Gate & API Smoke)
1. Chạy lại `pnpm db:migrate -- --dry-run` (hoặc tương đương đối chiếu NWC): xác nhận `20261020180000_s0_t1_c_rpc_acl_allowlist.sql` không còn báo `POSTCONDITION FAILED`.
2. Thực hiện smoke kiểm tra các endpoint đọc/ghi chính qua `service_role` và xác minh truy cập trực tiếp bằng `anon`/`authenticated` tới RPC bị chặn.
3. Chỉ sau khi Bước 5 đạt mới mở cổng apply các migration nghiệp vụ tiếp theo (như WP7A).

---

## 4. Giới hạn bằng chứng & Điểm cần lưu ý

- Bộ test tự động (`scripts/hf-nwc-acl-postcondition-repair.test.mjs`) chạy trên **PostgreSQL 18 cục bộ + CI runner**, mô phỏng tài khoản không phải superuser có `CREATEROLE + BYPASSRLS`, `MEMBER=true, SET=false` trên cả Topology A (2 grantor ngoài), Topology B (1 grantor ngoài + 1 dòng `grantor = current_user`), Topology C (thiếu `ADMIN OPTION`), inject lỗi giữa chừng, và migration local chưa apply.
- Quá trình phát triển PR này **không** kết nối ghi hay apply trực tiếp lên NWC/Production. Mọi số liệu trực tiếp trên NWC phải được xác nhận lại bằng Bước 2 (`--preflight`) và Bước 3 (`--dry-run`) tại thời điểm rollout thực tế.
