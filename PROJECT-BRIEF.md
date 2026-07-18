# PROJECT-BRIEF.md

> **Canonical shared reference — single source of truth.** This file is copied verbatim into **both** repos (`fleet-taxi-dashboard-api` and `fleet-taxi-dashboard-web`). If backend and frontend disagree on anything below, fix this file first, then both repos. Do **not** fork or drift a per-repo copy.
>
> Last updated: 2026-07-04 · Owner: Tech Lead

---

## 1. Overview & Why

We are building a **new, modern fleet/deposit-reconciliation dashboard** for a taxi/fleet company (domain **fleet-taxi.id**). It **rebuilds a subset** of an existing legacy **Laravel 5.6 + CRUDBooster** application (`D:\WORKS\EVISTA\evista-backend`, MySQL).

Key facts everyone must internalize:

- **The legacy app keeps running.** This is a **parallel modern rebuild**, not a migration cutover. We are not touching the legacy DB.
- **Fresh PostgreSQL database, clean schema.** We **preserve the business logic** but **redesign the schema** — do **not** copy the legacy MySQL schema 1:1, do not carry over CRUDBooster's `cms_*` tables.
- **Only two areas are in scope** (see §2). Everything else in the legacy app (drivers, wallets, PPOB/Rajabiller, reimburses, hotel CMS, blog, etc.) is **out of scope** for this rebuild.
- The rebuild fixes two concrete legacy weaknesses: **synchronous PhpSpreadsheet imports** (timeout risk) → **async queued imports**; and a **hardcoded token whitelist** for the external partner API → **per-partner hashed API keys, versioned & documented**.

---

## 2. In-Scope Features

Exactly two areas. Anything not listed here is out of scope for R1.

### A) Admin Fleet Monitoring (driver deposit / "setoran" reconciliation)

Two screens only: **`/admin/fleet-monitoring` (Gojek)** and **`/admin/fleet-monitoring-grab` (Grab)**.

**This is NOT realtime GPS.** It is a monthly **deposit/earnings reconciliation grid**. An admin manually exports a CSV/XLSX from the Gojek or Grab partner portal, uploads it here; the backend parses & stores the rows; the dashboard renders a **per-vehicle 31-day pivot grid**.

**Common flow (both platforms):**
1. Admin uploads a CSV/XLSX for a chosen **period (month + year)** → a new **import batch** is created and rows parsed **asynchronously** (queued job) with progress feedback.
2. Dashboard renders a pivot: **rows = vehicles**, **columns = days 1..31 + summary columns**.
3. Cells are **color-coded by threshold** (target vs actual). **Click a cell → modal** showing that day's transaction breakdown.
4. **Multi-select filters**: rental partner, plate, month/year. Plus **top / bottom performers**.
5. Admin can **edit driver + target metadata**, mark **exceptions** (rental / maintenance / free-day), and **rollback an entire import batch**.
6. Scale: **~50–500 vehicles × 31 days**.

**Gojek core logic (must be preserved exactly — see legacy `AdminFleetMonitoringController::getIndex`):**
- Only rows whose `type` matches `deduction`, `due`, or `Manual Payment` participate.
- Plates are normalized: `preg_replace('/[^A-Z0-9]/', '', strtoupper(plate))`. **Unplated manual payments** get a synthetic key `manual_<detail_id>` and are shown separately.
- **`due`** rows establish the vehicle's activity date range and feed an **inferred daily target** (see below).
- **`deduction`** and **counted** manual payments accumulate into daily/monthly totals. Manual payments carry an `is_manual_payment_setoran` flag: when **0 = "Tidak Masuk Setoran" (uncounted)** — shown for display but excluded from counted totals and it directly reduces outstanding; when **1 = counted**.
- **Inferred daily target** per vehicle: use `fleet_target` from the targets table if set (>0); else `round(total_due / due_count)`; else fallback **488000** (IDR).
- **Monthly calculated target** = `daily_target × targetDays`, where `targetDays = daysInMonth − firstActiveDay + 1 − (free-day exceptions in range)`. Exceptions with `is_bebas_setoran = 1` reduce target days; **spreadsheet money wins** — a day with actual money in the sheet ignores any exception on that day.
- **All-time Outstanding** (the headline number):
  `outstanding = (daily_target × all_time_deduction_days) − all_time_deduction − all_time_manual_uncounted`
  where `all_time_deduction_days = COUNT(DISTINCT date)` of deduction rows across **all** imports for that plate. Both counted manual payments (add to deduction) and uncounted manual payments (`all_time_manual_uncounted`) **reduce** outstanding.

**Gojek data model (legacy tables to redesign):**
- `fleet_imports` — batch: filename, period_month, period_year, imported_by.
- `fleet_import_details` — transaction_date, driver_id, driver_name, vehicle_plate, amount, `type ∈ {deduction, due, manual}`, reference, `is_manual_payment_setoran` flag + note.
- `fleet_targets` — vehicle_plate (unique), fleet_target, rental_partner, delivery_batch, service_area, vehicle_type, region.
- `fleet_exceptions` — vehicle_plate, date, keterangan, `is_bebas_setoran`.

**Grab data model & logic (see legacy `AdminFleetMonitoringGrabController`):**
- Pivot key is a **composite** `plate|city|driver`. Daily cell value = `total_earning_collected` summed per day. Summary columns aggregate earning, incentive, driver_fare, rides, online_hours, bookings, cancellations, fulfillment rate.
- `grab_imports` — filename, period_month, period_year, **total_row**, imported_by, **import_time_seconds**.
- `grab_import_details` — date, plate_number, city, car_model, driver_name, tiering, partner_name, driver_phone_number, total_online_hours, total_bookings, total_rides, cancel_by_driver, fullfilment_rate, driver_cancellation_rate, driver_fare, toll_and_others, total_incentive, total_earning_collected, composite_key.
- `grab_targets` — plate_number (unique), rental_partner, vehicle_type, city.
- Grab supports **rollback** of a whole import batch (FK `ON DELETE CASCADE` in legacy).

### B) Partner — Portal + External API

Covers **`/partner/login` and everything under `/partner/`**, PLUS a **machine-to-machine external REST API**.

**B1. Partner Portal (human, role-based)** — legacy CRUDBooster **privilege id 12 ("Partner")**. Partners log in, view their **own** orders / dashboard / metrics, and **export PDF/Excel**. A partner sees **only its own data** (per-partner data scoping).

**B2. External Partner REST API (machine-to-machine)** — for third-party integrations: shuttle partners (**Bhisa / Bhineka**) and **hotel** partners. Legacy versioned endpoints (`app/Http/Controllers/Api/BhisaOrderController.php`, `HelperController::bhinekapricelist`):
- `GET /partner/v1/pricelist` — route/car pricelist.
- `GET /partner/v1/order/create` — create an order (pickup_code, destination_code, car_types_id, pickup_at). Legacy validates destination/pickup against a pool whitelist (`EVISTA_HALIM`, `BHISA_CAWANG`) and handles swap-trip logic.
- `GET /partner/v1/order/history` — the partner's order history.
- `GET /partner/v1/order/detail/{id}` — one order's detail.

Legacy auth is a **primitive hardcoded token whitelist** (`ApiPartnerAuth::handle` → `in_array($token, $whitelist)`). **The new build MUST replace this** with **per-partner hashed API keys**, versioned (`/partner/v1`), **OpenAPI-documented**, and **rate-limited**. In the rebuild these are **POST** endpoints with a JSON body and standard envelope (legacy used GET with query params — do not carry that over).

Partner touches these entities: **orders** (`trx_orders`), cars, drivers, pricelist, hotel routes, shuttle pools.

> ### ✅ OPEN QUESTION #1 — RESOLVED (2026-07-05, from `evista-backup-20260606.sql`)
> **Confirmed legacy partner (privilege 12 "Partner") screen inventory:**
> 1. `cms_menus_privileges` grants privilege 12 exactly **two menus**: #257 "All Dashboard" (folder) and #209 **"Dashboard" → `AdminDashboardController@getMaindashboard`**. That is the ONLY screen a legacy partner sees; the controller sets an `is_partner` flag (line ~609) and the dashboard view renders a partner-restricted variant.
> 2. The 103 `cms_privileges_roles` module grants for privilege 12 are a **blanket seed** (identical grants copied to all new privileges by `2026_04_02_000000_seed_privileges_roles_for_new_privileges.php`) — they do NOT represent intentional partner screens and must not be rebuilt.
> 3. External `/partner/v1` routes confirmed in `routes/api.php` lines 364–370 (GET pricelist / order/create / order/history / order/detail/{id}, middleware `auth.api.partner`). Business rules confirmed: pool whitelist `EVISTA_HALIM` + `BHISA_CAWANG`; valid combos price 65 000 (price_list_id 1: BHISA_CAWANG→EVISTA_HALIM… id 2: reverse); `is_swap_trip = 1` when destination is `EVISTA_HALIM`; orders created as `order_type='later'`.
>
> **Consequence for the rebuild:** the modern portal surface stays as §6.2 (login/me/dashboard/own-orders list+detail/export) — a cleaned-up superset of the single legacy dashboard screen. No additional legacy screens exist to port.

---

## 3. Confirmed Tech Stack

Decided by the user — do not re-litigate.

| Layer | Choice |
|---|---|
| **Frontend** | React 19 + Vite + TypeScript; Tailwind CSS + shadcn/ui; **TanStack Table v8 + TanStack Virtual** (the 31-day grid); TanStack Query; routing via TanStack Router or React Router; charts via **Recharts**. Consider **Refine.dev** to accelerate admin CRUD/RBAC screens. |
| **Backend** | **NestJS** (Node 22 LTS, TypeScript). Serves internal dashboard API + partner portal API + versioned external partner API (`/partner/v1`, `@nestjs/swagger`). |
| **Database** | **PostgreSQL 16/17** (fresh schema). **Drizzle ORM** for schema/migrations/CRUD; heavy aggregation as **hand-written window-function / CTE SQL** via Drizzle `` sql`` ``. **PostGIS available but dormant** (future GPS/map). |
| **Auth / RBAC** | **Cookie sessions** for humans (admin + partner portal); **per-partner hashed bearer API keys** for the external partner API; **CASL** for roles + per-partner data scoping. |
| **Jobs / queue** | **BullMQ + Redis** — async spreadsheet import, batch rollback (future: GPS ingestion). |
| **Realtime** | **Socket.IO** (`@nestjs/websockets`) + `@socket.io/redis-adapter`. Light usage in R1 (import progress); scaffolded for future GPS/live-map. |
| **Spreadsheet** | Import: **ExcelJS (streaming) + Papaparse**. Export: **ExcelJS**. |
| **PDF** | **@react-pdf/renderer** (Playwright if high fidelity needed). |
| **Future maps** | **MapLibre GL JS + react-map-gl + PostGIS** — **NOT built in R1**. |

---

## 4. Architecture

### Two separate repos (NOT a monorepo)

- **`fleet-taxi-dashboard-api`** — NestJS backend. Deployed to **`api.fleet-taxi.id`**.
- **`fleet-taxi-dashboard-web`** — React/Vite frontend. Deployed to **`fleet-taxi.id`** (root domain, Cloudflare Pages project `fleet-taxi-web`).

Built in **separate chats**. This PROJECT-BRIEF.md is the shared contract that keeps them aligned.

### How the two repos talk — REST + OpenAPI-generated typed client

- The backend is the **single source of API truth**. It exposes an **OpenAPI 3 schema** via `@nestjs/swagger` at **`/docs`** (JSON at **`/docs-json`**).
- The frontend **generates a typed client** from that schema using **`openapi-typescript`** (or **orval**) — end-to-end types **without a shared npm package**. Regenerate on backend contract changes.
- **Contract discipline:** any endpoint/DTO change lands in the backend first (with updated Swagger decorators); frontend regenerates the client and adapts. Breaking changes to `/partner/v1` require a new version, never a silent change.

### Auth model

- **Humans (admin + partner portal):** **HTTP-only, Secure, SameSite cookie session**. Session store in Redis. Login sets the cookie; all app→api calls send `credentials: 'include'`.
- **External partner API (`/partner/v1`):** **`Authorization: Bearer <api_key>`**. Keys are **hashed at rest** (argon2/bcrypt or SHA-256+pepper — decide in backend chat), scoped to one partner, **rate-limited**, revocable, and never logged. **No cookies** on this surface.
- **CORS:** `fleet-taxi.id` (frontend, root domain) ↔ `api.fleet-taxi.id` are different hosts → configure CORS with an explicit origin allowlist and **`credentials: true`**; cookies set with `Domain=.fleet-taxi.id` (or exact `api.` host) + `SameSite=None; Secure` so the browser sends them cross-host.
- **RBAC:** CASL abilities per role (super-admin, admin, partner, …). Partner ability is **row-scoped** to `partner_id` — a partner can never read another partner's orders, on either the portal API or the external API.

### Realtime event catalog (shared, small — R1)

Socket.IO namespace `/rt`. Clients join a per-user/per-import room. Events:

| Event | Direction | Payload | Meaning |
|---|---|---|---|
| `import:progress` | server→client | `{ importId, processed, total, percent }` | Async import row-processing progress. |
| `import:done` | server→client | `{ importId, rowsInserted, durationMs }` | Import finished successfully. |
| `import:failed` | server→client | `{ importId, error }` | Import failed; batch rolled back. |

Future (GPS) events are **reserved, not implemented in R1**.

---

## 5. Database Schema (fresh PostgreSQL)

Fresh, clean schema — **not** a 1:1 copy of legacy MySQL. Conventions: `snake_case` tables/columns, `id bigint generated always as identity` PKs, `created_at`/`updated_at timestamptz`, money as **`bigint` integer rupiah** (no decimals — see §7), all timestamps stored UTC.

> **PostGIS is reserved for the future** (GPS/live-map). Install the extension when convenient but add **no geometry/geography columns in R1**. A future `vehicle_positions(geography(Point,4326), recorded_at, …)` table is the anticipated home.

### Fleet — Gojek

```
fleet_imports
  id              bigint PK
  filename        text
  period_month    int not null            -- 1..12
  period_year     int not null
  imported_by     bigint -> users.id
  status          text not null default 'pending'   -- pending|processing|done|failed
  total_rows      int default 0
  created_at      timestamptz
  updated_at      timestamptz

fleet_import_details        -- PARTITIONED (see note)
  id                        bigint
  import_id                 bigint -> fleet_imports.id  (ON DELETE CASCADE)
  transaction_date          date not null
  period_year               int not null   -- denormalized for partition key
  period_month              int not null   -- denormalized for partition key
  driver_id                 text
  driver_name               text
  vehicle_plate             text
  vehicle_plate_norm        text           -- normalized [A-Z0-9], indexed
  amount                    bigint         -- integer rupiah
  type                      text           -- deduction | due | manual
  is_manual_payment_setoran smallint       -- 1=counted, 0=uncounted (NULL=n/a)
  manual_payment_note       text
  reference_id              text
  created_at                timestamptz
  PRIMARY KEY (id, period_year, period_month)
  INDEX (vehicle_plate_norm), INDEX (transaction_date)

fleet_targets
  id                   bigint PK
  vehicle_plate        text UNIQUE
  vehicle_plate_norm   text
  vehicle_type         text
  fleet_target         bigint          -- integer rupiah daily target
  rental_partner       text
  delivery_batch       text
  service_area         text
  region_id            bigint          -- FK to a regions/pickup-points table
  created_at/updated_at timestamptz

fleet_exceptions
  id                bigint PK
  vehicle_plate     text (indexed)
  exception_date    date (indexed)     -- legacy "tanggal"
  keterangan        text
  is_bebas_setoran  boolean default false
  created_at/updated_at timestamptz
```

### Fleet — Grab

```
grab_imports
  id                   bigint PK
  filename             text
  period_month/year    int not null
  total_row            int default 0
  import_time_seconds  numeric(10,2) default 0
  imported_by          bigint -> users.id
  status               text default 'pending'
  created_at/updated_at timestamptz

grab_import_details         -- PARTITIONED (see note)
  id                        bigint
  import_id                 bigint -> grab_imports.id (ON DELETE CASCADE)
  date                      date not null
  period_year / period_month int not null   -- partition key
  plate_number              text
  plate_number_norm         text (indexed)
  city                      text
  car_model                 text
  driver_name               text
  driver_phone_number       text
  tiering                   text
  partner_name              text
  total_online_hours        numeric(10,2)
  total_bookings            int
  total_rides               int
  cancel_by_driver          int
  fullfilment_rate          numeric(10,2)
  driver_cancellation_rate  numeric(10,2)
  driver_fare               bigint     -- integer rupiah
  toll_and_others           bigint
  total_incentive           bigint
  total_earning_collected   bigint
  composite_key             text (indexed)   -- plate|city|driver
  PRIMARY KEY (id, period_year, period_month)

grab_targets
  id             bigint PK
  plate_number   text UNIQUE
  rental_partner text
  vehicle_type   text
  city           text
  created_at/updated_at timestamptz
```

> **⚠ PARTITIONING (required):** `fleet_import_details` and `grab_import_details` are **PostgreSQL range/list partitioned by `(period_year, period_month)`**. Rationale: (1) month-scoped grid queries hit one partition; (2) **batch rollback** of an import can `DELETE` within a single partition cheaply (and a whole period can be `DROP PARTITION` fast). Keep `period_year`/`period_month` in the PK.

### Partner / Auth

```
users
  id            bigint PK
  email         text UNIQUE
  password_hash text
  full_name     text
  is_active     boolean default true
  partner_id    bigint NULL -> partners.id   -- set for partner-portal users
  created_at/updated_at timestamptz

roles
  id    bigint PK
  name  text UNIQUE          -- super_admin | admin | partner | finance | ...

user_roles (join)
  user_id bigint -> users.id
  role_id bigint -> roles.id
  PRIMARY KEY (user_id, role_id)

partners
  id          bigint PK
  code        text UNIQUE     -- e.g. BHISA, HOTEL_X
  name        text
  type        text            -- shuttle | hotel | ...
  is_active   boolean default true
  created_at/updated_at timestamptz

api_keys
  id           bigint PK
  partner_id   bigint -> partners.id
  key_hash     text not null   -- hashed; raw key shown once at creation
  key_prefix   text            -- short non-secret prefix for lookup/display
  label        text
  scopes       text[]          -- e.g. {pricelist, order:create, order:read}
  rate_limit   int
  last_used_at timestamptz
  revoked_at   timestamptz NULL
  created_at   timestamptz

sessions            -- if not using pure Redis-store sessions
  id          text PK          -- session id
  user_id     bigint -> users.id
  data        jsonb
  expires_at  timestamptz
  created_at  timestamptz
```

### Orders (what the partner reads / creates)

```
orders                          -- redesigned from legacy trx_orders
  id             bigint PK
  order_number   text UNIQUE
  partner_id     bigint -> partners.id   -- data-scoping key
  order_type     text                    -- e.g. "later"
  trip_status    text                    -- draft | submitted | ... (legacy trip_status)
  pickup_code    text
  destination_code text
  car_types_id   bigint
  pickup_at      timestamptz
  basic_price    bigint                  -- integer rupiah
  ref_hotel_id   bigint NULL
  passenger_details jsonb
  created_at/updated_at timestamptz
  INDEX (partner_id), INDEX (trip_status)
```

Supporting reference tables (`cars`, `drivers`, `car_types`, `pricelist`, `hotel_routes`, `pickup_points/regions`) are modeled minimally as the partner inventory (OPEN QUESTION #1) is confirmed.

---

## 6. REST API Contract

**Base:** `https://api.fleet-taxi.id`. **Versioning:** internal admin/portal endpoints are unversioned and may evolve with the OpenAPI contract; the **external partner API is versioned under `/partner/v1`** and changes only via a new version. **Auth per group** is noted below.

### Standard JSON envelope

**Success:**
```json
{ "success": true, "data": <payload>, "meta": { "page": 1, "pageSize": 50, "total": 320 } }
```
`meta` present only for paginated/list responses.

**Error:**
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Human readable", "details": [ { "field": "pickup_at", "message": "required" } ] } }
```
HTTP status reflects the error class (400/401/403/404/409/422/429/500). `error.code` is a stable machine string.

### 6.1 Internal Admin — Fleet (auth: **cookie session**, roles: admin/super_admin via CASL)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/fleet/gojek/grid` | Gojek 31-day pivot grid for `?month&year&rental_partner[]&plate`. |
| GET | `/admin/fleet/gojek/cell` | One vehicle+day breakdown (cell-click modal). |
| GET | `/admin/fleet/grab/grid` | Grab 31-day pivot grid (composite plate\|city\|driver). |
| GET | `/admin/fleet/grab/cell` | One Grab vehicle+day breakdown. |
| POST | `/admin/fleet/{platform}/imports` | Upload CSV/XLSX for a period → enqueue async parse; returns `importId`. |
| GET | `/admin/fleet/{platform}/imports` | List import batches (filename, period, status, counts). |
| DELETE | `/admin/fleet/{platform}/imports/:id` | **Rollback** a whole import batch (queued). |
| GET | `/admin/fleet/{platform}/imports/:id` | Import status/progress (also via Socket.IO). |
| GET/PUT | `/admin/fleet/{platform}/targets/:plate` | Read / edit driver + target metadata (daily target, rental partner, region, etc.). |
| GET | `/admin/fleet/gojek/exceptions` | List exceptions for `?month&year`. |
| POST | `/admin/fleet/gojek/exceptions` | Create/mark an exception (rental/maintenance/free-day). |
| DELETE | `/admin/fleet/gojek/exceptions/:id` | Delete an exception. |
| GET | `/admin/fleet/{platform}/performers` | Top/bottom performers for the period. |

`{platform}` ∈ `gojek | grab`.

### 6.2 Partner Portal — human, role-based (auth: **cookie session**, role: partner, **row-scoped to own `partner_id`**)

| Method | Path | Purpose |
|---|---|---|
| POST | `/partner/portal/login` | Partner portal login → sets session cookie. |
| POST | `/partner/portal/logout` | End session. |
| GET | `/partner/portal/me` | Current partner user + partner profile. |
| GET | `/partner/portal/dashboard` | Partner metrics/summary widgets. |
| GET | `/partner/portal/orders` | List **own** orders (paginated, filterable). |
| GET | `/partner/portal/orders/:id` | One own order detail. |
| GET | `/partner/portal/orders/export` | Export orders as PDF or Excel (`?format=pdf\|xlsx`). |

> Exact screen set is **pending OPEN QUESTION #1** — extend this table once the privilege-12 inventory is confirmed.

### 6.3 External Partner API — machine-to-machine (auth: **Bearer hashed API key**, **rate-limited**, `/partner/v1`, OpenAPI-documented)

| Method | Path | Purpose |
|---|---|---|
| GET | `/partner/v1/pricelist` | Route/car pricelist for the authenticated partner. |
| POST | `/partner/v1/orders` | Create an order (`pickup_code`, `destination_code`, `car_types_id`, `pickup_at`). |
| GET | `/partner/v1/orders` | Order history for the authenticated partner. |
| GET | `/partner/v1/orders/:id` | One order's detail (own orders only). |

Notes: replaces legacy `GET /partner/v1/order/create|history|detail`. All requests scoped to the partner owning the API key; cross-partner access returns `403`. Rate-limit exceed → `429` with the standard error envelope.

---

## 7. Conventions

- **Naming:** DB `snake_case`; TypeScript `camelCase`; REST paths kebab/lowercase; API JSON fields **`camelCase`** (map at the DTO/serialization boundary). Enums are lowercase strings.
- **Standard response/error shape:** exactly as §6 (envelope + error). All endpoints, no exceptions.
- **Date / timezone:** business timezone is **`Asia/Jakarta` (WIB, UTC+7)**. **Store all timestamps in UTC (`timestamptz`)**; convert to Asia/Jakarta only at display and when bucketing a transaction into a **day/period** (day-of-month and period_month/year derive from the Asia/Jakarta local date). Period selectors are `(month 1..12, year)`.
- **Money:** **integer rupiah as `bigint`** everywhere — DB, API, and calculations. **No floats, no decimals** for money. (Legacy used `decimal(15,2)`; we round to whole rupiah on import.) Ratios/rates (fulfillment, cancellation, online hours) may stay `numeric`.
- **Plate normalization:** canonical form is `UPPERCASE`, strip all non-`[A-Z0-9]`. Store both raw and `_norm`; match/join on `_norm`.

### Environment variables

**Backend (`fleet-taxi-dashboard-api`):**
```
NODE_ENV
PORT
DATABASE_URL                # postgres://...
REDIS_URL                   # BullMQ + Socket.IO adapter + session store
SESSION_SECRET
COOKIE_DOMAIN               # .fleet-taxi.id
CORS_ORIGINS                # https://fleet-taxi.id
API_KEY_PEPPER             # for hashing partner API keys
S3_BUCKET / S3_REGION       # ap-southeast-1
AWS_REGION                  # ap-southeast-1
SWAGGER_ENABLED
```

**Frontend (`fleet-taxi-dashboard-web`):**
```
VITE_API_BASE_URL           # https://api.fleet-taxi.id
VITE_WS_URL                 # wss://api.fleet-taxi.id/rt
VITE_APP_ENV
```

---

## 8. Infra & Hosting

- **Cloud:** **AWS** (company-mandated; fresh account being hardened). Region **`ap-southeast-1` (Singapore)**.
- **Backend:** **ECS Fargate or App Runner** — a **persistent server** (NOT pure Lambda) because of the Socket.IO gateway and BullMQ workers.
- **Database:** **PostgreSQL on RDS** (16/17), PostGIS-capable.
- **Cache/Queue:** **Redis on ElastiCache** (BullMQ, Socket.IO Redis adapter, sessions).
- **Frontend:** static Vite build on **Cloudflare Pages** (project `fleet-taxi-web`), served at the root domain **`fleet-taxi.id`**.
- **Object storage:** **S3** for uploaded import files (`import/fleet-monitoring/<YYYY-MM>/…`) and generated exports.
- **DNS/CDN:** **Cloudflare** (same as legacy). Domain **`fleet-taxi.id`** → root domain (frontend, Cloudflare Pages), **`api.fleet-taxi.id`** (backend).
- **Repos:** two separate git repos — **`fleet-taxi-dashboard-api`** (backend), **`fleet-taxi-dashboard-web`** (frontend).

---

## 9. Legacy References (evista-backend)

Consult these for exact business rules; **do not copy schema/framework code** — port the logic.

**Fleet — Gojek:**
- `app/Http/Controllers/AdminFleetMonitoringController.php` (~1139 lines) — grid pivot, inferred daily target, all-time outstanding, exceptions, edit driver/target, import, import list, delete import. Core methods: `getIndex` (pivot + outstanding), `postImport` (parse), `getManageException`/`postManageException`, `getImportList`, `getDeleteImport`, `getEditDriver`/`postEditDriver`.
- `app/Http/Controllers/AdminFleetSummaryController.php` — summary aggregations (context).
- Migrations: `2026_02_25_144832_create_trx_fleet_imports_table.php`, `2026_02_25_144833_create_trx_fleet_import_details_table.php`, `2026_02_27_235500_create_trx_fleet_targets_table.php`, `2026_03_08_091300_create_trx_fleet_exceptions_table.php`, plus alters `2026_03_18…vehicle_type`, `2026_03_28…manual_payment_setoran(+note)`, `2026_05_11…region_id`.
- Views: `resources/views/admin/fleet-monitoring/` (legacy grid uses CSS `position: sticky` for frozen header/columns).

**Fleet — Grab:**
- `app/Http/Controllers/AdminFleetMonitoringGrabController.php` (~517 lines) — composite-key pivot, import, `getImportList`, `getRollback`.
- Migrations: `2026_04_05_231000_create_trx_fleet_grab_tables_v2.php`, `2026_04_11_000001_create_trx_fleet_grab_targets_table.php`, menu `2026_04_05_224600_add_fleet_monitoring_grab_menu.php`.

**Partner:**
- `app/Http/Controllers/Api/BhisaOrderController.php` — external order create/history/detail; pool whitelist + swap-trip.
- `app/Http/Controllers/Api/HelperController.php::bhinekapricelist` (~line 440) — pricelist.
- `app/Http/Controllers/Apiv4/HotelController.php` — hotel config/routes.
- `app/Http/Middleware/ApiPartnerAuth.php` — legacy token whitelist (**replace with hashed API keys**).
- `routes/api.php` — external partner group (~lines 364–370), hotel group (~372–377).
- Privilege/menus: `database/migrations/2026_04_01_100000_add_new_privileges.php` & `2026_04_02_000000_seed_privileges_roles_for_new_privileges.php` (privilege "Partner"); **`cms_menus` + `cms_menus_privileges` for privilege id 12** (query the DB dump).
- Orders: `database/migrations/2023_06_04_224158_create_trx_orders_table.php` (+ `add_ref_hotel_id`, `add_passenger_details`).
- DB dump for inventory: `evista-backup-20260606.sql`; design notes: `db-design.txt`, `api-design.txt`.

---

## 10. Milestones

**R1 — the two features working end to end** (target release):
- **Admin Fleet Monitoring (Gojek + Grab):** async queued CSV/XLSX import + progress; 31-day virtualized pivot grid; color thresholds; cell-click day breakdown; multi-select filters; top/bottom performers; exception calendar (Gojek); edit driver/target metadata; import list + full-batch rollback. Outstanding/target math ported exactly from legacy.
- **Partner Portal:** login (cookie session), dashboard, own-orders list/detail, PDF/Excel export — screen set finalized after **OPEN QUESTION #1**.
- **External Partner API `/partner/v1`:** pricelist, order create, order history/detail, secured by **per-partner hashed API keys**, rate-limited, **OpenAPI-documented**; frontend consumes a **generated typed client**.
- **Realtime scaffolded:** Socket.IO gateway live with the `import:*` event catalog. **GPS/live-map deferred** (PostGIS dormant, MapLibre not built).
- **Infra:** both repos deploy to `app.` / `api.fleet-taxi.id` on AWS `ap-southeast-1` behind Cloudflare.

**R2+ (post-R1, not scheduled here):** GPS ingestion + live-map (PostGIS + MapLibre), expanded partner analytics, additional admin modules as prioritized.

---

*End of PROJECT-BRIEF.md — keep this file in sync in both repos.*
