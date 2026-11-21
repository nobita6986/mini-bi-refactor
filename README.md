# mini-bi — Sales Performance & Reporting System V1

Hệ thống báo cáo kết quả kinh doanh và quản trị KPI cho BoD / Leader / Staff.

Luồng dữ liệu: **Google Sheets → n8n → Supabase/PostgreSQL → Next.js → người dùng**.
"Kết quả kinh doanh" trong dự án này là **số người được tuyển theo ngày**, không phải tiền.

> Trạng thái hiện tại: **P1 (Dashboard MVP)**. Đã có dashboard BoD tại `/dashboard` (được
> bảo vệ bằng access gate pilot), data contract và ingestion boundary trên Supabase DEV.
> **Chưa có** auth đầy đủ (P3), KPI (P4), và chưa có workflow n8n trong repo này.

## Tài liệu baseline

| Tài liệu | Nội dung |
|---|---|
| `docs/master-plan.md` | Mục tiêu, kiến trúc, phạm vi, roadmap P0–P4 |
| `docs/P0.md` … `docs/P4.md` | Kế hoạch thực thi từng phase |
| `docs/contracts/daily-recruitment-breakdown-v0.2.md` | **Data contract v0.2** — nguồn tham chiếu cho T2/n8n |
| `docs/contracts/daily-recruitment-count-v0.1.md` | Contract v0.1 — **đã retire**, chỉ còn giá trị lịch sử |
| `docs/handoffs/p0-t1-g1.md` | Handoff kỹ thuật của task P0-T1-G1 (không chứa secret) |
| `docs/acceptance/p0-t1-g1-fixtures.md` | Kết quả kiểm thử contract |

## Stack

| Thành phần | Phiên bản |
|---|---|
| Next.js (App Router) | 16.3.8 — Turbopack mặc định |
| React | 19.2.8 |
| TypeScript | 5.9.x (`strict`) |
| Tailwind CSS | 4.3.x (qua `@tailwindcss/postcss`) |
| Supabase JS | 2.117.x |
| Zod | 4.6.x |
| Package manager | pnpm 10.34.5 (một lockfile duy nhất: `pnpm-lock.yaml`) |

## Bắt đầu

Yêu cầu: Node.js ≥ 20.9 (đã kiểm tra trên v24.9.0) và pnpm.

```bash
pnpm install
cp .env.example .env.local   # rồi điền giá trị (xem dưới)
pnpm dev                     # http://localhost:3000
```

### Biến môi trường

`.env.example` chỉ chứa **tên biến và placeholder**. Giá trị thật lấy từ cấu hình môi
trường do chủ dự án cấp và **không** được commit (xem `.gitignore`).

| Biến | Phạm vi | Bắt buộc | Ghi chú |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | có | URL project Supabase |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public | có | Key công khai; bị RLS/RPC grants từ chối mọi truy cập dữ liệu |
| `SUPABASE_SECRET_KEY` | server-only | khi cần đọc/ghi server | **Key đặc quyền, bypass RLS.** Không đặt tiền tố `NEXT_PUBLIC_` |
| `PIPELINE_CHECK_ENABLED` | server-only | không (chỉ production) | Guard cho `/pipeline-check`. Xem mục “Trang vận hành” |
| `SUPABASE_DB_URL` | server-only | cho script ngoài Next.js | Không nạp vào web runtime |
| `SUPABASE_POOLER_HOST` / `SUPABASE_POOLER_PORT` | server-only | khi host `db.<ref>` chỉ có IPv6 | Xem mục Migration |
| `SUPABASE_CONFIG_FILE` | server-only | không | Đường dẫn file cấu hình ngoài repo cho script |

Thiếu biến bắt buộc ⇒ ứng dụng báo lỗi cấu hình rõ ràng. **Không có giá trị mặc định và
không có fallback im lặng.**

## Script

| Lệnh | Việc |
|---|---|
| `pnpm dev` | Chạy dev server |
| `pnpm build` | Build production |
| `pnpm start` | Chạy bản đã build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm db:migrate` | Áp dụng migration lên Supabase (thêm `-- --dry-run` để xem trước) |
| `pnpm fixtures:check` | Chạy bộ ca nghiệm thu contract trên DEV |
| `pnpm secrets:check` | Quét secret trong client bundle và source |
| `pnpm test` | Unit test read-model + guard |
| `pnpm docs:check` | Validate mọi ví dụ JSON trong contract/handoff bằng TypeScript validator |

## Migration

Migrations nằm ở `supabase/migrations/`, đặt tên `<timestamp>_<mô tả>.sql`, áp dụng theo
thứ tự tên file. Mỗi file chạy trong **một transaction** và được ghi nhận vào
`public.schema_migrations` kèm checksum.

- **Không sửa file migration đã áp dụng.** Runner sẽ dừng nếu checksum lệch — hãy tạo file mới.
- Chỉ T1 (owner database) được tạo/sửa migration.
- Không chạy migration trực tiếp trên PROD ngoài quy trình đã duyệt.

### Kết nối DB từ máy dev

Host `db.<project-ref>.supabase.co` của project DEV **chỉ có bản ghi AAAA (IPv6)**. Nếu máy
không có IPv6 ra Internet, đặt `SUPABASE_POOLER_HOST` trong `.env.local` để đi qua Supavisor
pooler (session mode, cổng 5432); script sẽ tự ghép user `postgres.<project-ref>`.

Pooler dùng PKI riêng của Supabase, không có trong CA store của Node. Repo **pin sẵn root CA**
ở `supabase/certs/supabase-pooler-root-2021-ca.pem` để vẫn xác minh chứng chỉ server.
Khi Supabase xoay CA, cập nhật file này. Chỉ dùng `SUPABASE_DB_TLS_INSECURE=1` để xử lý sự cố
cục bộ — script sẽ in cảnh báo rõ ràng.

## Ingestion boundary

```sql
public.replace_daily_recruitment_breakdown_snapshot_v02(p_payload jsonb) returns jsonb  -- snapshot
public.record_recruitment_source_failure_v01(p_payload jsonb)             returns jsonb  -- lỗi đọc nguồn
```

- Chỉ `service_role` được thực thi; `PUBLIC`/`anon`/`authenticated` đã bị thu hồi quyền.
- Grain: `(source, business_date, project, recruiter, provider_type, employment_type) = recruited_count`.
- Bốn chiều phân loại: **Dự án · Người tuyển · HRP/Vendor · Loại hình làm việc** (Thời vụ/Chính thức).
- Payload là **tổng hợp**; **không** chứa họ tên/ngày sinh/CCCD/địa chỉ/SĐT/ghi chú ứng viên hay raw row.
- Thay thế toàn bộ aggregate của đúng một source trong một transaction.
- Payload sai hoặc lỗi ghi ⇒ **giữ nguyên snapshot thành công gần nhất**.
- Cùng payload gửi lại ⇒ `outcome = unchanged`, không tạo duplicate.
- **Nguồn chuẩn:** tab `Sheet1` — B = Dự án · C = Ngày vào · J = HRP/Vendor · K = Người tuyển · L = Loại hình lao động.
- J chỉ nhận `HRP`/`Vendor`; L chỉ nhận `Thời vụ`/`Chính thức`. Giá trị ngoài danh mục vào nhóm **Không hợp lệ** kèm warning, hàng vẫn được tính.
- Envelope có `rows_warned`, `warning_issues`, `row_issues` (chỉ 3 field: `source_row_number`, `issue_level`, `error_code`); `sync_run_id` phải là UUID v4.
- `succeeded` và `partial` đều thay aggregate; `failed` thì không. `last_successful_sync_at` chỉ cập nhật khi `succeeded`.
- Không đọc được nguồn ⇒ gọi `record_recruitment_source_failure_v01` (giữ nguyên aggregate, không cập nhật last success).

Chi tiết đầy đủ: `docs/contracts/daily-recruitment-breakdown-v0.2.md`.

## Trang vận hành `/pipeline-check`

Server-rendered, chỉ đọc 4 bảng vận hành (không đọc/hiển thị PII), hiển thị: nguồn đã phát
hiện, run gần nhất (succeeded/partial/failed), counters, snapshot và lỗi/cảnh báo.

**Deployment safety guard:**

- `pnpm dev` — route luôn được phép.
- Production (`pnpm build` + `pnpm start`) — route trả `notFound()` trừ khi `PIPELINE_CHECK_ENABLED=true`.
  Operator muốn mở ở local phải chủ động đặt `PIPELINE_CHECK_ENABLED=true` trong `.env.local`.

Guard chạy **trước** mọi DB query.

## Authentication boundary (P1.7-H04)

Pilot HTTP Basic Auth đã bị **loại bỏ hoàn toàn** (`src/proxy.ts` và `src/lib/auth/pilot-access.ts`).
Preview/Production đi thẳng tới Supabase login/session; không còn `WWW-Authenticate: Basic`,
realm `Mini BI Pilot`, body `Pilot access unavailable` hay HTTP 503 vì thiếu credential pilot.

Các route từng nằm sau Basic Auth giờ tự bảo vệ:

| Route | Guard hiện tại |
| --- | --- |
| `/login` | Public |
| `/api/auth/login\|logout\|session` | Contract auth hiện có (same-origin/CSRF) |
| `/dashboard` | `getDirectEntryActor` → chưa đăng nhập thì `redirect("/login?next=/dashboard")`; actor lỗi dùng UX sanitized |
| `/direct-entry` | `direct-entry-page-access` (flag + actor + capability) |
| `/pipeline-check` | Chuyển hướng server-side về `/dashboard`; không fetch dữ liệu |
| `/api/direct-entry/*` | Actor/capability/CSRF guard hiện hành |
| `/api/ai/*`, `/api/ai/worker/run` | Đã gỡ bỏ hoàn toàn (trả `404` theo Next.js App Router) |

`/api/reporting/*` không tồn tại trong repo này; dữ liệu reporting được đọc server-side trong
`/dashboard` và giờ nằm sau guard session ở trên.

Không có biến `PILOT_ACCESS_*` nào còn được đọc. Biến còn sót trong Vercel env (nếu có) không có
tác dụng và có thể xóa sau khi deploy.

## Dashboard BoD (`/dashboard`)

Server-rendered (`force-dynamic`), đọc qua `fetchReporting` + `fetchReportingOptions` (service-role,
server-only). Hiển thị: tổng người tuyển, xu hướng theo ngày (zero-fill), breakdown theo dự án /
người tuyển / HRP-Vendor / loại hình, coverage/freshness per-source — **không** hiển thị PII.

- Filter URL bằng `nuqs` (`from/to/project/recruiter/provider/employment/source`), server parser là nguồn chân lý.
- Chart bằng `recharts@3`; option catalog từ view `reporting_dimension_options_v01` (service-role-only).
- Route được access gate P1-W03 bảo vệ trước khi query.

## Cấu trúc repo

```text
src/app/                    layout, trang nền
src/components/ui/          UI primitives (Card, Alert)
src/lib/contracts/          schema/type + hàm chuẩn hóa của data contract v0.2
src/lib/supabase/           Supabase server client
src/lib/env.ts              validation biến môi trường
supabase/migrations/        DDL + RPC có version
supabase/certs/             root CA pin cho pooler (chứng chỉ công khai)
scripts/                    migration runner, fixture check, secret check
docs/contracts/             contract v0.2 (+ v0.1 đã retire) và fixture
docs/acceptance/            bằng chứng kiểm thử
docs/handoffs/              handoff kỹ thuật
automation/n8n/             (dành cho T2) workflow export, mapping, runbook
```

## Quy tắc bảo mật

- Không đưa secret vào source, frontend, Git, log hoặc tài liệu bàn giao.
- `SUPABASE_SECRET_KEY` là key đặc quyền: chỉ dùng server-side.
- Bảng dữ liệu bật RLS và **không có policy** cho `anon`/`authenticated` ⇒ truy cập ẩn danh bị chặn.
- Không lưu hồ sơ ứng viên, raw Sheet row hoặc PII vào database/Git.
- Chạy `pnpm secrets:check` trước khi commit và sau khi build.

## Giới hạn đã biết (P0)

- Chưa có Auth người dùng và chưa có phân quyền BoD/Leader/Staff (P3) — access gate P1-W03 là shared pilot gate tạm thời, không phải Auth/RBAC.
- Access gate pilot (Basic Auth) đã triển khai ở **P1-W03** cho `/dashboard`, `/pipeline-check`, `/api/reporting`; guard `PIPELINE_CHECK_ENABLED` ở `/pipeline-check` là lớp chống vô tình public route độc lập.
- Chưa có run-start marker/lease chống chạy đồng thời; xem `docs/handoffs/p0-t1-g1.md`.
- Chưa có lịch sử snapshot (chỉ giữ bản hiện hành).
- Chưa có UI vận hành nguồn dữ liệu (P2); dashboard BoD đã có ở P1-W04 (`/dashboard`).
