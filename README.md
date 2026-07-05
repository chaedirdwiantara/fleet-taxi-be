# fleet-taxi-dashboard-api

NestJS backend for the fleet/deposit-reconciliation dashboard (`api.fleet-taxi.id`).
The React frontend lives in the sibling repo `fleet-taxi-dashboard-web` (`app.fleet-taxi.id`).

**Read [PROJECT-BRIEF.md](./PROJECT-BRIEF.md) first** — it is the canonical contract
(scope, schema, API surface, conventions). [backend-kickoff.md](./backend-kickoff.md) is the
build plan implementing it.

## Stack

NestJS 11 · Node 22 LTS · pnpm · PostgreSQL 17 (Drizzle ORM + raw CTE SQL) ·
BullMQ + Redis · Socket.IO · cookie sessions + CASL · argon2 API keys ·
ExcelJS/Papaparse · pino logging · Vitest.

## Local development

```bash
docker compose up -d       # Postgres 17 + Redis 7
cp .env.example .env       # then set localhost values (see comments)
pnpm install
pnpm db:migrate            # apply schema + partition DDL
pnpm db:seed               # admin + demo partner + one API key (printed once)
pnpm dev                   # http://localhost:3000, Swagger at /docs
```

Deploying to AWS? See [docs/RUNBOOK.md](./docs/RUNBOOK.md).

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | Watch-mode dev server (`nest start --watch`) |
| `pnpm build` / `pnpm start` | Compile to `dist/` and run (`node dist/main.js`) |
| `pnpm typecheck` | `tsc --noEmit` (no build output) |
| `pnpm test` / `pnpm test:watch` | Vitest |
| `pnpm lint` / `pnpm format` | ESLint (zero warnings) / Prettier |
| `pnpm openapi:export` | Write `openapi.json` for the frontend's typed client |
| `pnpm db:generate` / `db:migrate` / `db:studio` | drizzle-kit (dev) |
| `pnpm db:migrate:prod` | Runtime migrator (`node dist/db/migrate.js`) — used in prod/CI |
| `pnpm db:seed` | Seed roles + admin + demo partner |

## Operations

- **Health:** `GET /health` (liveness, dependency-free) · `GET /health/ready`
  (readiness — pings Postgres + Redis, `503` if down).
- **Logs:** line-delimited JSON (pino) with per-request `x-request-id`; secrets
  redacted. `LOG_LEVEL` controls verbosity.
- **Container:** multi-stage [Dockerfile](./Dockerfile), non-root, `node dist/main.js`.
- **CI:** [.github/workflows/ci.yml](./.github/workflows/ci.yml) — lint, typecheck,
  build, migrate, test against Postgres 17 + Redis 7.

## API conventions (enforced globally)

- Every success response: `{ "success": true, "data": …, "meta"?: … }`
  (`meta` only on paginated lists — return `{ data, meta }` from the controller).
- Every error: `{ "success": false, "error": { "code", "message", "details"? } }`
  with stable machine codes (`VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`,
  `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL`).
- Money is **integer rupiah**, serialized as JSON numbers. API JSON is `camelCase`;
  DB is `snake_case`. Timestamps stored UTC; business timezone is Asia/Jakarta.

## Milestones

M0 foundation ✅ → M1 DB & auth → M2 import pipeline → M3 fleet grids →
M4 partner portal + external API → M5 hardening. Details in backend-kickoff.md §10.
