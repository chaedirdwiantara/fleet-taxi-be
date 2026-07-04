# backend-kickoff.md

> **Paste the block below into a fresh chat to start building the backend repo `fleet-taxi-dashboard-api`.** This document is self-contained. It assumes no prior conversation memory. A companion `PROJECT-BRIEF.md` is (or will be) in the repo root — that file is the canonical single source of truth. If anything here ever contradicts `PROJECT-BRIEF.md`, `PROJECT-BRIEF.md` wins; fix it there first, then reconcile this file.

---

## 0. Paste this to start (mission statement)

You are a **senior NestJS backend architect**. Build **`fleet-taxi-dashboard-api`** — the **backend half of a two-repo project** (the other repo is `fleet-taxi-dashboard-web`, a React 19 + Vite frontend built in a separate chat). This backend is deployed to **`api.fleet-taxi.id`**; the frontend to **`app.fleet-taxi.id`**.

**Stack (already decided — do not re-litigate):** **NestJS** on **Node 22 LTS + TypeScript**, **pnpm**. **PostgreSQL 16/17** via **Drizzle ORM** (schema + migrations + CRUD), with **hand-written window-function / CTE SQL** for the heavy pivot aggregations. **BullMQ + Redis** for async spreadsheet imports and batch rollback. **Socket.IO** (`@nestjs/websockets` + `@socket.io/redis-adapter`) for import progress. **Cookie sessions** (Redis-backed) for humans + **CASL** RBAC; **per-partner hashed API keys** (argon2) for the external partner API. **@nestjs/swagger** exposes an OpenAPI 3 schema at `/docs` (JSON at `/docs-json`) — the frontend generates a typed client from it.

**What you're building (R1 — exactly two feature areas, nothing else):**
1. **Admin Fleet Monitoring** — a monthly deposit/earnings **reconciliation grid** (NOT realtime GPS) for **Gojek** and **Grab**. Admin uploads a CSV/XLSX per period → async queued parse with progress → a per-vehicle **31-day pivot grid** with color thresholds, cell-click day breakdowns, multi-select filters, top/bottom performers, exception calendar (Gojek), editable driver/target metadata, and full-batch **rollback**.
2. **Partner — Portal + External API** — a cookie-session **partner portal** (row-scoped to the partner's own data) and a versioned, OpenAPI-documented, rate-limited **external REST API** at **`/partner/v1`** authenticated by per-partner hashed API keys.

Everything else in the legacy app (drivers, wallets, PPOB, reimburses, hotel CMS, blog) is **out of scope**. The legacy Laravel app keeps running in parallel — this is a **fresh PostgreSQL rebuild that preserves business logic**, not a migration cutover. Do **not** copy the legacy MySQL schema or any `cms_*` tables.

**Two legacy weaknesses this rebuild must fix:**
- Legacy imports are **synchronous PhpSpreadsheet** (timeout risk) → make them **async + queued** with progress.
- Legacy external partner auth is a **hardcoded token whitelist** → replace with **per-partner hashed API keys**, versioned, documented, rate-limited.

---

## 1. First actions for this chat (do these before writing any code)

**Action 1 — Read `PROJECT-BRIEF.md` in the repo root, in full.** It is the canonical contract (schema, API surface, conventions, milestones). Everything below is a build plan that implements it; the brief is the authority.

**Action 2 — Explore the legacy Laravel app for the exact business rules.** The legacy repo lives at **`D:\WORKS\EVISTA\evista-backend`** (Laravel 5.6 + CRUDBooster, MySQL). **Do not copy schema or framework code — port the logic.** Read these specific files (all confirmed to exist):

*Fleet — Gojek (the deposit/outstanding math lives here):*
- `D:\WORKS\EVISTA\evista-backend\app\Http\Controllers\AdminFleetMonitoringController.php` (~1139 lines, 50 KB) — **the most important file.** Study `getIndex` (grid pivot + inferred daily target + all-time outstanding), `postImport` (parse), `getManageException` / `postManageException`, `getImportList`, `getDeleteImport`, `getEditDriver` / `postEditDriver`.
- `D:\WORKS\EVISTA\evista-backend\app\Http\Controllers\AdminFleetSummaryController.php` — summary aggregations (context for performers/summary columns).
- `D:\WORKS\EVISTA\evista-backend\app\Http\Controllers\AdminTrxFleetTargetsController.php` — target metadata CRUD.
- Legacy migrations (for column semantics, **not** to copy): `database/migrations/2026_02_25_144832_create_trx_fleet_imports_table.php`, `2026_02_25_144833_create_trx_fleet_import_details_table.php`, `2026_02_27_235500_create_trx_fleet_targets_table.php`, `2026_03_08_091300_create_trx_fleet_exceptions_table.php`, plus alters `2026_03_18…vehicle_type`, `2026_03_28…manual_payment_setoran(+note)`, `2026_05_11…region_id`.
- Legacy views (grid UX reference only): `resources/views/admin/fleet-monitoring/`.

*Fleet — Grab (composite-key pivot):*
- `D:\WORKS\EVISTA\evista-backend\app\Http\Controllers\AdminFleetMonitoringGrabController.php` (~517 lines, 23 KB) — study the composite-key (`plate|city|driver`) pivot, `postImport`, `getImportList`, `getRollback`.
- Migrations: `2026_04_05_231000_create_trx_fleet_grab_tables_v2.php`, `2026_04_11_000001_create_trx_fleet_grab_targets_table.php`.

*Partner — external API + portal:*
- `D:\WORKS\EVISTA\evista-backend\app\Http\Controllers\Api\BhisaOrderController.php` — external order create / history / detail; **pool whitelist** (`EVISTA_HALIM`, `BHISA_CAWANG`) + **swap-trip** logic.
- `D:\WORKS\EVISTA\evista-backend\app\Http\Controllers\Api\HelperController.php` — method `bhinekapricelist` (~line 440), the pricelist endpoint.
- `D:\WORKS\EVISTA\evista-backend\app\Http\Middleware\ApiPartnerAuth.php` — the legacy `in_array($token, $whitelist)` auth you must **replace** with hashed API keys.
- `D:\WORKS\EVISTA\evista-backend\routes\api.php` — external partner group (~lines 364–370), hotel group (~372–377). Confirm the exact `/partner/v1` route list here.
- Orders table semantics: `database/migrations/2023_06_04_224158_create_trx_orders_table.php` (+ `add_ref_hotel_id`, `add_passenger_details` alters).

**Action 3 — Resolve OPEN QUESTION #1 (partner screen/endpoint inventory) FIRST.** The full set of `/partner/` portal screens is **CRUDBooster/DB-driven** — defined in `cms_menus` + `cms_menus_privileges`, **not** in route files. You cannot read them from `routes/web.php`. Resolve by inspecting the DB dump:
- Dump file: **`D:\WORKS\EVISTA\evista-backend\evista-backup-20260606.sql`**. Grep it for `cms_menus`, `cms_menus_privileges`, and privilege **`id 12`** ("Partner"). Join `cms_menus_privileges` (where `id_cms_privileges = 12`) to `cms_menus` to get the menu list, paths, and target controllers.
- Cross-check the partner controllers those menus point to.
- Confirm the external `/partner/v1` routes in `routes/api.php`.
- **Record the confirmed portal screen inventory back into `PROJECT-BRIEF.md` §2 B before building portal screens.** Design notes to skim for context: `D:\WORKS\EVISTA\evista-backend\db-design.txt`, `D:\WORKS\EVISTA\evista-backend\api-design.txt`.

> Note on the legacy files: some entries have `._`-prefixed macOS resource-fork twins (e.g. `._AdminFleetMonitoringController.php`) — ignore those; read only the real `.php` file.

---

## 2. NestJS project setup

**Runtime & tooling:** Node **22 LTS**, **pnpm** (`packageManager` pinned in `package.json`), TypeScript **strict**.

Scaffold with the Nest CLI, then install exact dependency groups:

```bash
pnpm dlx @nestjs/cli new fleet-taxi-dashboard-api --package-manager pnpm --strict
cd fleet-taxi-dashboard-api
```

**Runtime dependencies:**
```bash
pnpm add @nestjs/common @nestjs/core @nestjs/platform-express \
  @nestjs/config @nestjs/swagger \
  @nestjs/websockets @nestjs/platform-socket.io socket.io @socket.io/redis-adapter \
  @nestjs/bullmq bullmq ioredis \
  drizzle-orm postgres \
  @nestjs/throttler \
  @casl/ability \
  argon2 \
  exceljs papaparse \
  class-validator class-transformer zod \
  express-session connect-redis cookie-parser \
  @aws-sdk/client-s3 @aws-sdk/s3-request-presigner \
  nanoid
```

**Dev dependencies:**
```bash
pnpm add -D drizzle-kit \
  typescript ts-node tsx @types/node \
  vitest @vitest/coverage-v8 unplugin-swc @swc/core \
  eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin \
  prettier eslint-config-prettier eslint-plugin-prettier \
  @types/express @types/express-session @types/papaparse @types/cookie-parser
```

**Notes on choices:**
- **`postgres` (postgres.js)** is the Drizzle driver here (works cleanly with raw `sql`` `` window-function queries and `.unsafe()` for partition DDL). `pg` is an acceptable alternative if the team prefers node-postgres — pick one and stay consistent. This doc assumes **postgres.js**.
- **Validation:** default to **class-validator + class-transformer** DTOs (best `@nestjs/swagger` integration for auto-generated OpenAPI). Use **zod** for import-row shape validation and env parsing where a schema-first approach is cleaner. Don't mix the two on the same DTO.
- **Testing: Vitest** (via `unplugin-swc` for decorator support). If the team prefers the Nest default, Jest is fine — but standardize on **one**. This doc assumes Vitest.
- **Package manager: pnpm only.** Commit `pnpm-lock.yaml`; no `npm install`.

**`tsconfig.json`** — strict, ES2023, decorators on:
```jsonc
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2023",
    "lib": ["ES2023"],
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"], "@db/*": ["src/db/*"] }
  }
}
```

**ESLint + Prettier:** `@typescript-eslint` recommended + `eslint-config-prettier`; Prettier with `printWidth: 100`, `singleQuote: true`, `trailingComma: "all"`. Run both in CI.

**Global app bootstrap (`main.ts`) must wire, in order:**
1. `cookie-parser` + `express-session` (Redis store via `connect-redis`) — see §7.
2. Global `ValidationPipe` (`whitelist: true`, `transform: true`, `forbidNonWhitelisted: true`).
3. Global **response-envelope interceptor** + global **exception filter** (§4 common).
4. CORS with the origin allowlist and `credentials: true` (§7).
5. `@nestjs/throttler` guard registered globally (tuned per-route for `/partner/v1`).
6. Swagger document built and served at `/docs` when `SWAGGER_ENABLED=true`; write the JSON to `/docs-json`.
7. Socket.IO adapter swapped for the Redis adapter (§8).

---

## 3. Folder & module structure

```
fleet-taxi-dashboard-api/
├─ PROJECT-BRIEF.md                 # canonical contract (read first)
├─ backend-kickoff.md               # this file
├─ docker-compose.yml               # postgres + redis for local dev
├─ drizzle.config.ts
├─ vitest.config.ts
├─ .env.example
├─ src/
│  ├─ main.ts
│  ├─ app.module.ts
│  ├─ config/                       # @nestjs/config + zod-validated env schema
│  │  └─ env.ts
│  ├─ common/                       # cross-cutting; NO business logic
│  │  ├─ interceptors/response-envelope.interceptor.ts
│  │  ├─ filters/all-exceptions.filter.ts
│  │  ├─ dto/paginated.dto.ts       # meta { page, pageSize, total }
│  │  ├─ pipes/                     # e.g. ParsePeriodPipe (month/year)
│  │  ├─ decorators/                # @CurrentUser, @Public, @RequirePartnerKey
│  │  ├─ guards/                    # SessionGuard, ApiKeyGuard, PoliciesGuard
│  │  └─ util/plate.ts              # normalizePlate(), money helpers
│  ├─ db/
│  │  ├─ schema/                    # Drizzle table defs (one file per domain)
│  │  │  ├─ users.ts  roles.ts  partners.ts  api-keys.ts  sessions.ts
│  │  │  ├─ fleet-gojek.ts  fleet-grab.ts  orders.ts  reference.ts
│  │  │  └─ index.ts
│  │  ├─ migrations/                # drizzle-kit output + hand-written partition SQL
│  │  ├─ drizzle.module.ts          # provides the DB client (DI token)
│  │  └─ client.ts
│  ├─ auth/                         # login/logout, session issue, password hash
│  ├─ users/                        # users + roles + CASL ability factory (RBAC)
│  │  └─ casl/ability.factory.ts
│  ├─ fleet/                        # Gojek: grid, cell, targets, exceptions, performers
│  │  ├─ fleet.module.ts
│  │  ├─ gojek-grid.service.ts      # raw pivot SQL + outstanding math
│  │  ├─ gojek-grid.controller.ts
│  │  ├─ exceptions.service.ts
│  │  └─ targets.service.ts
│  ├─ grab/                         # Grab: composite-key grid, cell, targets, performers
│  ├─ import/                       # upload + queue + parse + progress + rollback
│  │  ├─ import.controller.ts       # POST upload, list, GET status, DELETE rollback
│  │  ├─ import.service.ts          # store file, create parent row, enqueue
│  │  ├─ parse.processor.ts         # BullMQ worker: streaming parse + bulk insert
│  │  └─ rollback.processor.ts      # BullMQ worker: delete by import_id / drop partition
│  ├─ partner-portal/               # human, cookie session, row-scoped
│  ├─ partner-api/                  # external /partner/v1 (versioned, API-key auth)
│  │  ├─ partner-api.module.ts
│  │  ├─ v1/pricelist.controller.ts
│  │  └─ v1/orders.controller.ts
│  ├─ realtime/                     # Socket.IO gateway + redis adapter
│  │  ├─ realtime.gateway.ts
│  │  └─ redis-io.adapter.ts
│  └─ storage/                      # S3 / local file abstraction for imports & exports
└─ test/                            # e2e + integration
```

**Module rules:** each domain module owns its controllers/services/DTOs. `common` and `db` hold zero business logic. `import` is platform-agnostic (Gojek/Grab parsers are strategies keyed by `{platform}`). `partner-api` (external) and `partner-portal` (human) are **separate modules with separate auth guards** — never share a guard between them.

---

## 4. Common layer (envelope, errors, guards)

**Response envelope interceptor** — wraps every successful controller return into the §6 shape from the brief:
```json
{ "success": true, "data": <payload>, "meta": { "page": 1, "pageSize": 50, "total": 320 } }
```
Convention: if a controller returns `{ data, meta }` it's passed through; a bare value becomes `data` with no `meta`. `meta` appears **only** on paginated lists.

**Global exception filter** — maps thrown errors to:
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [ { "field": "pickupAt", "message": "required" } ] } }
```
`error.code` is a **stable machine string** (`VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL`). HTTP status reflects the class (400/401/403/404/409/422/429/500). Never leak stack traces or raw SQL. Never log API keys or session secrets.

**Guards (three, do not conflate):**
- `SessionGuard` — validates the Redis-backed cookie session; attaches `req.user`. Used by all `/admin/*` and `/partner/portal/*`.
- `PoliciesGuard` (+ `@CheckPolicies`) — evaluates CASL abilities; enforces row-scoping for partners.
- `ApiKeyGuard` — used **only** by `/partner/v1/*`; validates `Authorization: Bearer <key>` against hashed keys (§7); attaches `req.partner`. No cookies here.

**JSON casing:** DB is `snake_case`, API JSON is **`camelCase`**. Map at the DTO/serialization boundary — do not leak snake_case column names into responses. Money is **integer rupiah as string-safe `bigint`**; serialize as a JSON number only if within safe-integer range, otherwise as a numeric string (decide once, document in Swagger).

---

## 5. Data layer (Drizzle schema, migrations, aggregation)

Implement the fresh PostgreSQL schema from **`PROJECT-BRIEF.md` §5** verbatim. Conventions: `snake_case`; PKs `bigint generated always as identity`; `created_at`/`updated_at timestamptz`; **money as `bigint` integer rupiah** (no floats/decimals — round to whole rupiah on import); all timestamps stored **UTC**; store both raw plate and `vehicle_plate_norm` (`UPPERCASE`, strip non-`[A-Z0-9]`), match/join on `_norm`. **PostGIS reserved but dormant — no geometry columns in R1.**

**Drizzle usage split:**
- **Drizzle schema + drizzle-kit** for all tables, columns, indexes, FKs, and CRUD.
- **Hand-written raw `sql`` `` (window functions / CTEs)** for the heavy aggregations: the 31-day pivot, all-time outstanding, and top/bottom performers. Drizzle's query builder cannot express these cleanly; write them as raw SQL and type the result rows manually.

**Partitioning (required — drizzle-kit won't generate it, hand-write the DDL migration):** `fleet_import_details` and `grab_import_details` are **range/list partitioned by `(period_year, period_month)`**, with those columns in the PK. Rationale: month-scoped grid queries hit one partition; batch rollback deletes within a single partition cheaply; a whole period can be `DROP PARTITION`. Create the parent as `PARTITIONED BY LIST (period_year, period_month)` (or a composite expression) and add a helper that **auto-creates the child partition** for a `(year, month)` on first import of that period (idempotent `CREATE TABLE IF NOT EXISTS … PARTITION OF …`).

### 5.1 Gojek business rules to port (from `AdminFleetMonitoringController::getIndex`)

Implement exactly (this is the load-bearing math):
- Only rows with `type ∈ {deduction, due, manual (Manual Payment)}` participate.
- Plate normalization as above. **Unplated manual payments** get synthetic key `manual_<detail_id>` and render separately.
- `due` rows establish the vehicle's active date range and feed the **inferred daily target**.
- `deduction` + counted manual payments accumulate into daily/monthly totals. Manual payments carry `is_manual_payment_setoran`: **0 = "Tidak Masuk Setoran" (uncounted)** — shown for display, excluded from counted totals, and it directly **reduces outstanding**; **1 = counted**.
- **Inferred daily target** per vehicle: `fleet_target` from targets table if set (`> 0`); else `round(total_due / due_count)`; else fallback **`488000`** IDR.
- **Monthly calculated target** = `dailyTarget × targetDays`, where `targetDays = daysInMonth − firstActiveDay + 1 − (free-day exceptions in range)`. Exceptions with `is_bebas_setoran = 1` reduce target days, **but spreadsheet money wins** — a day with actual money ignores any exception on that day.
- **All-time Outstanding** (headline number):
  `outstanding = (dailyTarget × allTimeDeductionDays) − allTimeDeduction − allTimeManualUncounted`
  where `allTimeDeductionDays = COUNT(DISTINCT transaction_date)` of deduction rows across **all** imports for that plate. Counted manual payments add to deduction; uncounted manual payments reduce outstanding.

**Day/period bucketing:** `day-of-month` and `period_month/year` derive from the **Asia/Jakarta (UTC+7)** local date of the transaction, even though the timestamp is stored UTC. Convert at bucketing time (`AT TIME ZONE 'Asia/Jakarta'`).

### 5.2 Grab business rules (from `AdminFleetMonitoringGrabController`)

Pivot key is composite **`plate|city|driver`** (`composite_key`). Daily cell = `SUM(total_earning_collected)` per day. Summary columns aggregate earning, incentive, driver_fare, rides, online_hours, bookings, cancellations, and fulfillment rate. Full-batch rollback supported (`ON DELETE CASCADE` on `import_id` in legacy — same intent here).

### 5.3 Pivot SQL sketch (concrete idea)

The grid is **rows = vehicles, columns = day 1..31 + summary**. Prefer computing the 31 day-buckets with a `FILTER` aggregate (or `crosstab`), keyed on the Jakarta-local day-of-month, over a single partition. Gojek daily totals sketch:

```sql
WITH src AS (
  SELECT
    d.vehicle_plate_norm,
    EXTRACT(DAY FROM (d.transaction_date))::int AS dom,     -- date already bucketed to Jakarta on import
    d.type,
    d.is_manual_payment_setoran,
    d.amount
  FROM fleet_import_details d
  WHERE d.period_year = $1 AND d.period_month = $2           -- hits ONE partition
    AND d.type IN ('deduction','due','manual')
),
daily AS (
  SELECT
    vehicle_plate_norm,
    -- counted money per day: deductions + counted manual payments
    SUM(amount) FILTER (WHERE dom = 1  AND (type = 'deduction' OR (type='manual' AND is_manual_payment_setoran = 1))) AS d01,
    SUM(amount) FILTER (WHERE dom = 2  AND (type = 'deduction' OR (type='manual' AND is_manual_payment_setoran = 1))) AS d02,
    -- … d03 … d31 …
    SUM(amount) FILTER (WHERE type = 'deduction'
        OR (type='manual' AND is_manual_payment_setoran = 1))                                  AS month_counted,
    COUNT(DISTINCT transaction_date) FILTER (WHERE type = 'due')                                AS due_days,
    SUM(amount) FILTER (WHERE type = 'due')                                                     AS total_due,
    SUM(amount) FILTER (WHERE type='manual' AND is_manual_payment_setoran = 0)                  AS manual_uncounted
  FROM src
  GROUP BY vehicle_plate_norm
)
SELECT
  daily.*,
  COALESCE(NULLIF(t.fleet_target, 0),
           ROUND(daily.total_due::numeric / NULLIF(daily.due_days,0)),
           488000)::bigint                                                                       AS daily_target
FROM daily
LEFT JOIN fleet_targets t ON t.vehicle_plate_norm = daily.vehicle_plate_norm;
```

The **all-time outstanding** is a **second query** (unfiltered by period, across all partitions) computing `dailyTarget × COUNT(DISTINCT transaction_date of deductions) − SUM(deductions + counted manual) − SUM(uncounted manual)` per `vehicle_plate_norm`, then joined into the response. **Top/bottom performers** = `ORDER BY <metric> DESC/ASC LIMIT n` over the daily CTE. Generating the 31 `FILTER` columns by hand is verbose but explicit and fast — generate the column list programmatically in the query-builder helper, but emit **raw SQL** (not Drizzle query-builder). Type the returned rows with an explicit interface.

---

## 6. Import pipeline (the headline reliability fix)

**Flow:** `POST /admin/fleet/{platform}/imports` (multipart) → validate `{platform, month, year}` and file type → **store the file** (S3 in prod at `import/fleet-monitoring/<YYYY-MM>/…`, local disk in dev) → create a **parent import row** (`fleet_imports` / `grab_imports`) with `status='pending'` → **enqueue a BullMQ job** carrying `{ importId, platform, fileKey, period }` → return `202` with `{ importId }` immediately (no synchronous parse — this is the whole point).

**Worker (`parse.processor.ts`):**
1. Set parent `status='processing'`; ensure the `(year, month)` **partition exists** (create-if-missing).
2. **Stream-parse** the file: **ExcelJS streaming reader** for XLSX, **Papaparse** (stream mode) for CSV. Never load the whole file into memory (~50–500 vehicles × 31 days, but files can be large).
3. Per chunk: normalize plates, round money to integer rupiah, bucket dates to Jakarta-local `period`, map to detail rows, **bulk insert** (batched, e.g. 1–5k rows) tagged with `import_id` + denormalized `period_year/period_month`.
4. Emit **`import:progress`** over Socket.IO every N rows: `{ importId, processed, total, percent }`.
5. On success: set `status='done'`, `total_rows`, (`import_time_seconds` for Grab), emit **`import:done`** `{ importId, rowsInserted, durationMs }`.
6. On failure: **roll back** all rows for that `import_id` (they're isolated by `import_id` + partition), set `status='failed'`, emit **`import:failed`** `{ importId, error }`.

**Rollback:** `DELETE /admin/fleet/{platform}/imports/:id` enqueues a **rollback job** (`rollback.processor.ts`) that deletes detail rows **by `import_id`** (cheap — confined to one partition) then deletes the parent row. If the deleted import is the **only** occupant of a period partition, prefer `DROP PARTITION` / `TRUNCATE` of the child for a fast path. Rollback is queued (not inline) so the response returns immediately and progress can be reported.

`GET /admin/fleet/{platform}/imports/:id` returns current `status` + counts (same data the socket streams, for clients that miss events or reconnect). `GET /admin/fleet/{platform}/imports` lists batches (filename, period, status, counts).

**Concurrency:** run BullMQ workers **in the same persistent process** (or a sibling process) — this is why deployment is **ECS Fargate / App Runner, not Lambda** (see brief §8). Configure sensible worker concurrency and per-job attempts=1 (imports are not idempotent to retry blindly — a failed import is rolled back, not retried).

---

## 7. Auth / RBAC

**Humans (admin + partner portal):** HTTP-only, `Secure`, `SameSite=None` cookie session via `express-session` + `connect-redis` store. Login (`/auth/login`, `/partner/portal/login`) verifies the password (argon2) and issues the session; logout destroys it. Cookie is set with `Domain=.fleet-taxi.id` (from `COOKIE_DOMAIN`) so it's sent across `app.` ↔ `api.` subdomains.

**CORS:** explicit origin allowlist from `CORS_ORIGINS` (e.g. `https://app.fleet-taxi.id`) with **`credentials: true`**. Never `origin: '*'` with credentials.

**External partner API (`/partner/v1`):** `Authorization: Bearer <api_key>`. Keys are **hashed at rest with argon2** (+ `API_KEY_PEPPER`); the raw key is shown **once** at creation. Store `key_prefix` (short, non-secret) for O(1) lookup, then argon2-verify the candidate against that partner's `key_hash`. Keys are scoped to one partner, carry `scopes[]` + `rate_limit`, are revocable (`revoked_at`), and are **never logged**. No cookies on this surface.

**CASL abilities (`ability.factory.ts`):**
- `super_admin` / `admin` — full access to `/admin/*` fleet features.
- `partner` (human, portal) — abilities **row-scoped to `partner_id`**: `can('read', 'Order', { partnerId: user.partnerId })`. A partner can **never** read another partner's data — enforced by `PoliciesGuard` on every portal endpoint.
- External API — `ApiKeyGuard` attaches `req.partner`; every `/partner/v1` query is filtered by `req.partner.id`; cross-partner access → `403`. Scope checks (`order:create`, `order:read`, `pricelist`) gate individual routes.

**Rate limiting (`@nestjs/throttler`):** global default limit, tightened on `/partner/v1/*` (per-API-key). Exceeding the limit → `429` with the standard error envelope (`code: RATE_LIMITED`).

---

## 8. Realtime (Socket.IO gateway)

Namespace **`/rt`**. Clients authenticate with the same cookie session and **join a per-user / per-import room** (`import:<importId>`). Swap the default Nest IO adapter for a **Redis-adapter** implementation (`redis-io.adapter.ts` using `@socket.io/redis-adapter` + two `ioredis` clients) so events fan out correctly across multiple server instances.

**Event catalog (R1 — server→client only):**

| Event | Payload | Meaning |
|---|---|---|
| `import:progress` | `{ importId, processed, total, percent }` | Row-processing progress. |
| `import:done` | `{ importId, rowsInserted, durationMs }` | Import finished OK. |
| `import:failed` | `{ importId, error }` | Import failed; batch rolled back. |

Future GPS/live-map events are **reserved, not implemented in R1**. The BullMQ worker emits these by publishing to the gateway (which broadcasts to the import's room). Frontend WS URL is `wss://api.fleet-taxi.id/rt`.

---

## 9. Env, local dev, scripts, testing, OpenAPI export

**Env vars (`.env.example`)** — from brief §7:
```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://fleet:fleet@localhost:5432/fleet
REDIS_URL=redis://localhost:6379
SESSION_SECRET=change-me
COOKIE_DOMAIN=.fleet-taxi.id            # localhost in dev
CORS_ORIGINS=https://app.fleet-taxi.id  # http://localhost:5173 in dev
API_KEY_PEPPER=change-me
S3_BUCKET=fleet-taxi-imports
S3_REGION=ap-southeast-1
AWS_REGION=ap-southeast-1
SWAGGER_ENABLED=true
```
Validate env at boot with a **zod schema** in `src/config/env.ts`; fail fast on missing/invalid vars.

**Local dev — `docker-compose.yml` (Windows-friendly; only Postgres + Redis, app runs on host):**
```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: fleet
      POSTGRES_PASSWORD: fleet
      POSTGRES_DB: fleet
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
volumes:
  pgdata:
```
Run `docker compose up -d`, then the app on the host via pnpm. (S3 is mocked by the local-disk storage adapter in dev; no LocalStack required for R1.)

**Scripts (`package.json`):**
```jsonc
{
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "nest build",
    "start": "node dist/main.js",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "openapi:export": "tsx scripts/export-openapi.ts",   // writes openapi.json for the frontend
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint \"src/**/*.ts\" --max-warnings 0",
    "format": "prettier --write \"src/**/*.ts\""
  }
}
```

**Testing strategy:**
- **Unit** — the outstanding/target math and plate normalization are the highest-value tests. Build a fixtures set from a small real Gojek sheet and assert `dailyTarget`, `targetDays`, and `outstanding` match legacy output exactly. Do the same for the Grab composite-key aggregation.
- **Integration** — spin Postgres + Redis (docker or Testcontainers), run migrations, exercise the import pipeline end-to-end (upload → job → rows inserted → progress events → rollback removes exactly the batch).
- **Contract** — snapshot the OpenAPI JSON; a failing snapshot flags a breaking API change (which must land in the backend first).
- **Guards** — assert a partner cannot read another partner's orders (portal + external API) and that a revoked/rate-limited key gets `403`/`429`.

**OpenAPI export for the frontend:** the backend is the single source of API truth. `pnpm openapi:export` builds the Swagger document (same builder as `/docs`) and writes `openapi.json`. The frontend (`fleet-taxi-dashboard-web`) generates a typed client from it via `openapi-typescript`/`orval`. **Contract discipline:** any endpoint/DTO change lands here first (with updated `@nestjs/swagger` decorators); breaking changes to `/partner/v1` require a **new version**, never a silent change.

---

## 10. Milestone roadmap (M0–M5)

**M0 — Foundation & contracts.** Nest scaffold; pnpm/tsconfig/eslint/prettier/vitest wired; `docker-compose` up; `@nestjs/config` + zod env validation; global response-envelope interceptor + exception filter; Swagger serving at `/docs` + `openapi:export`; health check. **Deliverable:** app boots, `/docs` renders, envelope + error shape verified by a test.

**M1 — DB & auth.** Drizzle schema for all §5 tables; drizzle-kit migrations; hand-written **partition DDL** for the two `*_import_details` tables + partition-ensure helper; users/roles/partners/api_keys/sessions seeded; cookie sessions (Redis store) + CORS; CASL ability factory + `SessionGuard`/`PoliciesGuard`/`ApiKeyGuard`; argon2 password + API-key hashing. **Deliverable:** admin can log in; a partner cannot see another partner's data (test); an API key authenticates `/partner/v1`.

**M2 — Import pipeline.** BullMQ queue + worker; S3/local storage adapter; `POST imports` (upload → enqueue → `202 {importId}`); streaming ExcelJS/Papaparse parse; bulk insert tagged by `import_id` + period; Socket.IO gateway with Redis adapter emitting `import:progress|done|failed`; import list + status; **rollback** by `import_id` (with drop-partition fast path). **Deliverable:** upload a real Gojek sheet → rows land in the right partition → progress streams → rollback removes exactly that batch.

**M3 — Fleet grids (Gojek then Grab).** Raw-SQL 31-day pivot; inferred daily target; monthly calculated target with exceptions; **all-time outstanding** (ported exactly, unit-tested vs legacy); cell-click day breakdown; multi-select filters; top/bottom performers; exception CRUD (Gojek); editable driver/target metadata; then the Grab composite-key grid + summary columns. **Deliverable:** both grids return correct numbers matching legacy fixtures; all §6.1 endpoints live and documented.

**M4 — Partner portal + external API.** Resolve OPEN QUESTION #1 first and record the screen inventory in `PROJECT-BRIEF.md`. Portal: login/logout/me/dashboard/own-orders list+detail/export (PDF+Excel), all row-scoped. External `/partner/v1`: pricelist, order create, order history/detail — hashed-key auth, per-key throttling, CASL partner scoping, full Swagger docs; port the legacy pool-whitelist + swap-trip rules (POST + JSON body + standard envelope, **not** the legacy GET-with-query style). **Deliverable:** a partner sees only their own data on both surfaces; `/partner/v1` documented and rate-limited.

**M5 — Hardening & handoff.** Integration + contract tests green in CI; rate-limit + auth edge cases; structured logging with secrets redacted; final `openapi.json` published for the frontend; env/runbook for AWS `ap-southeast-1` (RDS Postgres, ElastiCache Redis, ECS Fargate/App Runner, S3, behind Cloudflare). **Deliverable:** backend deployable to `api.fleet-taxi.id`; frontend can generate its typed client from the exported schema.

---

*Build against `PROJECT-BRIEF.md` as the contract. When in doubt about a business rule, re-read the named legacy controller — don't guess. Keep `PROJECT-BRIEF.md` in sync across both repos.*
