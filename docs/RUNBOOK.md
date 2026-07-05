# Deployment Runbook — `fleet-taxi-dashboard-api`

Backend for the fleet/deposit-reconciliation dashboard. Deployed to
**`api.fleet-taxi.id`**; the React frontend (`fleet-taxi-dashboard-web`) to
**`app.fleet-taxi.id`**. Cloud: **AWS `ap-southeast-1` (Singapore)** behind
**Cloudflare**. Read [PROJECT-BRIEF.md](../PROJECT-BRIEF.md) §8 for the target
architecture; this runbook is the operational how-to.

---

## 1. Why a persistent server (not Lambda)

The app hosts a **Socket.IO gateway** (`/rt` import progress) and **BullMQ
workers** (async spreadsheet import + rollback) in the same process. Both need
a long-lived runtime, so deploy on **ECS Fargate** (or App Runner), **not** pure
Lambda. One service runs HTTP + WebSocket + workers; scale horizontally — the
Socket.IO Redis adapter and Redis-backed sessions make instances stateless.

---

## 2. Managed dependencies

| Concern | AWS service | Notes |
|---|---|---|
| Database | **RDS PostgreSQL 16/17** | PostGIS-capable (dormant in R1). Private subnet. |
| Cache / queue / sessions | **ElastiCache Redis 7** | BullMQ, Socket.IO adapter, `express-session` store. Same VPC. |
| Object storage | **S3** | Uploaded imports at `import/fleet-monitoring[-grab]/<YYYY-MM>/…` and exports. |
| Compute | **ECS Fargate** | 1 service, ≥2 tasks for HA. ALB in front (HTTP + WS upgrade). |
| Images | **ECR** | `fleet-taxi-dashboard-api` repository. |
| DNS / CDN / TLS | **Cloudflare** | `api.fleet-taxi.id` → ALB. Enable WebSocket support. |

---

## 3. Environment variables

Set on the ECS task definition (secrets via **AWS Secrets Manager** → container
`secrets`, non-secrets via `environment`). Schema is validated at boot
(`src/config/env.ts`) — the app **refuses to start** on a missing/invalid var,
and in `production` rejects weak/placeholder `SESSION_SECRET` / `API_KEY_PEPPER`
(<32 chars).

| Var | Example (prod) | Secret? |
|---|---|---|
| `NODE_ENV` | `production` | no |
| `PORT` | `3000` | no |
| `DATABASE_URL` | `postgres://user:pass@<rds-endpoint>:5432/fleet` | **yes** |
| `REDIS_URL` | `redis://<elasticache-endpoint>:6379` | yes |
| `SESSION_SECRET` | 32+ char random | **yes** |
| `COOKIE_DOMAIN` | `.fleet-taxi.id` | no |
| `CORS_ORIGINS` | `https://app.fleet-taxi.id` | no |
| `API_KEY_PEPPER` | 32+ char random | **yes** |
| `S3_BUCKET` | `fleet-taxi-imports` | no |
| `S3_REGION` / `AWS_REGION` | `ap-southeast-1` | no |
| `SWAGGER_ENABLED` | `false` in prod (`true` in staging) | no |
| `LOG_LEVEL` | `info` | no |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

S3 access: attach an **IAM task role** with `s3:PutObject`/`GetObject`/`DeleteObject`
on the bucket — do **not** use static AWS keys.

---

## 4. Cross-subdomain auth (critical)

`app.` and `api.` are different subdomains, so the session cookie must cross them:

- Cookie is set `HttpOnly; Secure; SameSite=None; Domain=.fleet-taxi.id` (prod).
  `SameSite=None` **requires** `Secure`, which requires HTTPS end-to-end.
- `CORS_ORIGINS` lists the exact frontend origin with `credentials: true`
  (never `*`). Frontend calls use `fetch(..., { credentials: 'include' })`.
- The app calls `trust proxy` in production so `Secure` cookies and per-API-key
  rate-limit IPs resolve correctly behind Cloudflare + ALB.
- External `/partner/v1` uses **`Authorization: Bearer <api_key>`** only — no
  cookies on that surface.

---

## 5. Build & push the image

```bash
# from repo root
aws ecr get-login-password --region ap-southeast-1 \
  | docker login --username AWS --password-stdin <acct>.dkr.ecr.ap-southeast-1.amazonaws.com

docker build -t fleet-taxi-dashboard-api:$(git rev-parse --short HEAD) .
docker tag fleet-taxi-dashboard-api:$(git rev-parse --short HEAD) \
  <acct>.dkr.ecr.ap-southeast-1.amazonaws.com/fleet-taxi-dashboard-api:latest
docker push <acct>.dkr.ecr.ap-southeast-1.amazonaws.com/fleet-taxi-dashboard-api:latest
```

The image is multi-stage (Node 22, glibc for native `argon2`), runs as the
non-root `node` user, and starts `node dist/main.js`.

---

## 6. Migrations

Migrations are **not** run by the app on boot (avoids race conditions across
tasks). Run them as a **one-off ECS task** (or CI deploy step) before rolling
out new app tasks, using the same image:

```bash
# override the container command on a one-off task
node dist/db/migrate.js      # === pnpm db:migrate:prod
```

This applies the journal in `src/db/migrations` (including the hand-written
partition DDL) via drizzle-orm's migrator — no dev tooling required. It only
needs `DATABASE_URL`. Child period partitions for `*_import_details` are created
lazily on first import of a period (`ensureDetailPartition`), so no per-month
migration is needed.

**Rollout order:** push image → run migration task → update ECS service.
Migrations are written to be backward-compatible with the previous app version
so the two can overlap during a rolling deploy.

---

## 7. Health checks

- **Liveness** `GET /health` — dependency-free; ALB/ECS uses this to decide if a
  task is alive. A DB/Redis blip must not kill a healthy process.
- **Readiness** `GET /health/ready` — pings Postgres + Redis; returns `503` when
  a dependency is down. Use for target-group registration / deployment gating.

Configure the ALB target group health check to `GET /health` (200). The
container also declares a Docker `HEALTHCHECK` against `/health`.

---

## 8. Observability

- Logs are **line-delimited JSON** (pino) on stdout → CloudWatch Logs. Each line
  carries `req.id` (also returned as the `x-request-id` response header) for
  correlation. **Secrets are redacted** (Authorization, cookies, passwords, API
  key hashes) at the serializer level.
- Set CloudWatch metric filters/alarms on `level>=50` (error) and on
  `import:failed` events.

---

## 9. Frontend contract handoff

The backend is the single source of API truth. On every contract change:

```bash
pnpm openapi:export            # writes openapi.json
```

Hand `openapi.json` to `fleet-taxi-dashboard-web`, which regenerates its typed
client (`openapi-typescript`/`orval`). The `test/contract.spec.ts` suite locks
the operation set — a breaking change fails CI and must land in the backend
first. `/partner/v1` changes require a **new version**, never a silent edit.

---

## 10. First-deploy checklist

- [ ] RDS Postgres + ElastiCache Redis provisioned in the app VPC/subnets; SGs
      allow the ECS task SG on 5432 / 6379.
- [ ] S3 bucket created; task role granted object R/W.
- [ ] Secrets in Secrets Manager; task definition wires env (§3).
- [ ] ECR repo created; image built & pushed (§5).
- [ ] Migration task run once (§6).
- [ ] ECS service (≥2 tasks) behind ALB; target group health check `GET /health`.
- [ ] ALB listener 443 with ACM cert; Cloudflare `api.fleet-taxi.id` → ALB,
      WebSockets enabled.
- [ ] `SWAGGER_ENABLED=false` in prod.
- [ ] Smoke: `GET /health` 200, `GET /health/ready` 200, admin login sets the
      `sid` cookie, `/partner/v1/pricelist` authenticates with a seeded key.

---

## 11. Local development

```bash
docker compose up -d          # Postgres 17 + Redis 7
cp .env.example .env          # set localhost values (see file comments)
pnpm install
pnpm db:migrate               # drizzle-kit (dev) — or pnpm build && pnpm db:migrate:prod
pnpm db:seed                  # admin + demo partner + one API key (printed once)
pnpm dev                      # http://localhost:3000, Swagger at /docs
```
