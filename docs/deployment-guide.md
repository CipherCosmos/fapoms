# FAPOMS / Karat — Deployment Guide

_How to put this system on a server or in the cloud: what it needs, how big, what it costs, and the
shortest safe path. Numbers here are **measured from the running stack**, not estimated._

For scaling *beyond* the first deployment (load testing, replicas, PgBouncer, read replicas) see
[load-test-and-scale.md](./load-test-and-scale.md) — this document gets you to production once.

---

## 1. Read this first — the one true blocker

**You cannot bootstrap a fresh production database from migrations today.** I proved this by running
them against an empty database rather than inferring it:

| What I ran | Result |
|---|---|
| `migration:run` on empty DB (before fix) | Failed instantly — `Duplicate migrations: …` (all 46) |
| After fixing the data-source glob | 14 of 46 applied, then failed |
| Failure | `relation "assayer_billing_records" does not exist` |

**Root cause.** Development has been running with `synchronize` doing the schema work, so a number of
tables — the billing tables among them — were never given a `CREATE TABLE` migration. The migration
chain therefore cannot replay onto an empty database: it references tables nothing ever created.
Production forbids `synchronize` (correctly — it drops columns it doesn't recognise), so there is no
path from "empty Postgres" to "working schema" through migrations.

### Two fixes already applied in this pass

1. **`data-source.ts` loaded every migration twice.** It globbed `dist/**/*.js` *and* `src/**/*.ts`
   together. After a build — which every production deploy does — both matched the same 46 files and
   TypeORM aborted before executing a single one. So `migration:run` was **guaranteed to fail on any
   real deployment** while looking fine in a fresh dev checkout with no `dist/`. Now it picks one set
   based on whether it is running compiled or under ts-node.
2. **`AddProjectOperationalFields`** re-added a column an earlier migration already created. Guarded
   with `ADD COLUMN IF NOT EXISTS`. This took the chain from 9 to 14 migrations.

### The recommended way out: baseline the schema (proven)

Do **not** hand-write create-migrations for ~37 missing tables and then chase every downstream
`ALTER` conflict. Squash to a baseline instead. I verified this works end to end:

```
pg_dump --schema-only  →  apply to empty DB  →  78 tables, 0 errors
```

A snapshot is committed at
[`packages/backend/src/infrastructure/database/baseline/schema-baseline.sql`](../packages/backend/src/infrastructure/database/baseline/schema-baseline.sql)
(75 `CREATE TABLE`, 141 KB).

**Bootstrapping a new production database:**

```bash
# 1. Create the DB and extensions
psql -h $DB_HOST -U $DB_USERNAME -d postgres -c "CREATE DATABASE fapoms;"
psql -h $DB_HOST -U $DB_USERNAME -d fapoms \
  -c 'CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'

# 2. Apply the baseline schema
psql -h $DB_HOST -U $DB_USERNAME -d fapoms -f schema-baseline.sql

# 3. Mark every existing migration as already applied, so future `migration:run`
#    only executes NEW migrations and never replays the broken history.
#    (Insert one row per file in migrations/ into the "migrations" table.)

# 4. Seed roles/permissions and the first admin user
npm run seed --workspace=packages/backend
```

**From then on the workflow is normal:** new schema changes are new migration files, and
`migration:run` applies only those. Regenerate the baseline whenever you want a fresh starting point:

```bash
docker compose exec -T postgres pg_dump -U fapoms -d fapoms \
  --schema-only --no-owner --no-privileges > schema-baseline.sql
```

> **Before going live**, regenerate the baseline from a database you trust (ideally a clean run of the
> above + seeds), and review it. The committed snapshot came from the working dev database, so it may
> carry dev-era artifacts.

### The other prerequisite: there is no production image

Only `Dockerfile.dev` files exist (hot-reload, `nest start --watch`, source bind-mounted). Those must
not run in production. You need a multi-stage build per §5.

---

## 2. What the system is made of

Nine moving parts. Only the first seven are servers; the last two are distribution concerns.

| # | Component | Purpose | Notes |
|---|---|---|---|
| 1 | **PostgreSQL 16 + PostGIS** | All relational data | PostGIS required — distance/coverage queries use it |
| 2 | **Redis 7** | Queues, cache, rate limiting, **cross-replica realtime** | On the hot path; not optional at >1 replica |
| 3 | **Object storage** (MinIO or S3) | Audit PDFs, KYC files, attachments | Must be S3 in prod — the boot guard enforces it |
| 4 | **Backend API** (`PROCESS_ROLE=api`) | HTTP + WebSocket | Stateless; scale horizontally |
| 5 | **Backend worker** (`PROCESS_ROLE=worker`) | Bull jobs, crons, notifications, dispatch | **At least one required**, or queued work never runs |
| 6 | **Frontend** | Static React build | 5.9 MB of files — nginx or any CDN |
| 7 | **LiveKit SFU** | Assayer ↔ data-entry voice calls | **Needs a public IP + UDP.** See §6 |
| 8 | **ClamAV** (recommended) | Scans every upload | ~1–2 GB RAM for signatures — size for it |
| 9 | **APK distribution** | Getting Karat onto handsets | Not a server. See §7 |

---

## 3. Measured resource usage

Live `docker stats` from the running stack, plus what each becomes in production:

| Service | Measured (dev) | Production estimate | Why different |
|---|---:|---:|---|
| Backend | 648 MB | **300–450 MB** per replica | Dev runs ts-node + watch; prod runs compiled `dist` |
| PostgreSQL | 64 MB | **1–2 GB** | Needs real `shared_buffers`/work_mem under load |
| Redis | 6.7 MB | **256–512 MB** | Grows with socket count + cache working set |
| MinIO | 94 MB | **200–300 MB** | Or £0 if you use managed S3 |
| LiveKit | 55 MB | **100–200 MB** | Plus media bandwidth during calls |
| Frontend | 130 MB | **~20 MB** | Dev Vite server vs. nginx serving static files |
| ClamAV | not running | **1–2 GB** | Signature database is memory-resident |
| Mobile (Metro) | 511 MB | **0** | Dev-only bundler — never deployed |

**Minimum realistic production footprint: ~4 GB RAM.** With ClamAV and headroom, **8 GB** is the
sensible starting point.

### Data growth — measured

Current database: **29 MB** holding 72 assignments, 72 branches, 28 assayers, 2,638 audit events
(`pgdata` volume 124 MB including WAL/indexes).

The important asymmetry:

- **The database stays small.** Even at 100× the current row counts you are in low single-digit GB.
  Audit events are the fastest-growing table, and they are small rows.
- **Object storage is what grows.** Each returned audit packet is a scanned multi-page PDF. At
  ~5 MB per audit and 1,000 audits/month that is **~5 GB/month, ~60 GB/year** — and it only ever
  accumulates, because it is bank audit evidence with a retention obligation.

Budget storage on the PDFs, not the database.

---

## 4. Sizing and cost

Three honest tiers. Rupee figures are approximate at ₹85/USD and **must be re-checked** — cloud
pricing moves.

### Tier A — Pilot / single client (fits today's data: 28 assayers, 72 branches)

One VM running everything via Docker Compose.

- **4 vCPU, 8 GB RAM, 100 GB SSD**, plus object storage
- Everything on one box; daily `pg_dump` + storage sync off-box

| Option | Spec | ≈ Monthly |
|---|---|---:|
| Hetzner (EU) / equivalent | CPX41 8 GB | **₹1,500–2,500** |
| DigitalOcean / Linode | 8 GB droplet | **₹4,000–5,000** |
| AWS Lightsail (Mumbai) | 8 GB | **₹4,500–6,000** |
| Indian provider (E2E, CtrlS, Yotta) | 8 GB | **₹4,000–8,000** |
| **Your own hardware** | any 8 GB server | hardware + power + a static IP |

**Realistic all-in: ₹2,000–8,000/month.** This genuinely runs the current workload.

### Tier B — Production, multi-client (hundreds of staff, thousands of assayers)

Split the tiers so the database and app scale independently.

| Piece | Spec | ≈ Monthly (Mumbai) |
|---|---|---:|
| App servers ×2 (API + worker) | 4 vCPU / 8 GB | ₹8,000–12,000 |
| Managed PostgreSQL + PostGIS | 4 vCPU / 16 GB, 200 GB, multi-AZ | ₹15,000–25,000 |
| Managed Redis | 2 GB, with failover | ₹3,000–6,000 |
| Object storage (S3) | 500 GB + egress | ₹1,500–3,000 |
| LiveKit VM | 2 vCPU / 4 GB + bandwidth | ₹2,000–4,000 |
| Load balancer + TLS | | ₹1,500–2,500 |
| Backups + snapshots | | ₹1,000–2,000 |

**≈ ₹32,000–55,000/month** (~$380–650). Managed Postgres is the single biggest line — and worth it,
because it buys you automated backups, PITR and failover you would otherwise build yourself.

### Tier C — Scale-out

Only when load testing says so: PgBouncer (transaction mode), read replicas for dashboards,
API autoscaling on p95, worker autoscaling on queue depth, CDN in front of the frontend and
documents. All supported by the code already — see [load-test-and-scale.md](./load-test-and-scale.md).

### ⚠️ Data residency — not optional

This system holds **bank collateral audit evidence and personal data** (PAN, bank accounts,
government IDs — the env template already references the DPDP Act and encrypts these at rest via
`PII_ENCRYPTION_KEY`). For an Indian bank client, host **in India**:

- AWS `ap-south-1` (Mumbai) / `ap-south-2` (Hyderabad)
- Azure Central India · GCP `asia-south1`
- Or an Indian provider (E2E Networks, CtrlS, Yotta, Netmagic)

Confirm the client's contract and RBI expectations before choosing a region. Cheap EU hosting
(Tier A's Hetzner line) is fine for *staging* but likely disqualified for production data.

---

## 5. The easiest path that is still safe

### Option 1 — Single VM + Docker Compose ⭐ recommended to start

The shortest route, and it matches how the stack already runs locally.

**Effort: 1–2 days** (after the §1 blocker is cleared).

1. Provision one 8 GB VM in an India region; open only 80/443 (plus LiveKit's ports, §6).
2. Write `docker-compose.prod.yml` — same services, but:
   - production Dockerfiles (below), no bind mounts, no `--watch`
   - `restart: always`, resource limits, no published DB/Redis ports
3. Put **Caddy** in front (automatic Let's Encrypt TLS, ~10 lines) or nginx + certbot.
4. Fill `.env` from `.env.production.example`. The boot guard refuses to start on a weak
   `JWT_SECRET`, a default `DB_PASSWORD`, `DB_SYNCHRONIZE=true`, missing `CORS_ORIGINS`, or
   `STORAGE_DRIVER != s3` — so a misconfigured box fails loudly instead of quietly.
5. Bootstrap the schema (§1), seed, create the first admin.
6. `cron`: nightly `pg_dump` + `mc mirror` of the bucket to off-box storage.

**Production Dockerfile shape** (backend) — none exists yet:

```dockerfile
# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN npm ci
COPY packages/shared packages/shared
COPY packages/backend packages/backend
RUN npm run build:shared && npm run build:backend

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache curl                      # for HEALTHCHECK
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN npm ci --omit=dev
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/backend/dist packages/backend/dist
WORKDIR /app/packages/backend
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD curl -fsS http://localhost:3000/api/v1/health || exit 1
CMD ["node", "dist/main.js"]
```

The frontend is simpler — build, then serve `dist/` with nginx:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci
COPY packages/shared packages/shared
COPY packages/frontend packages/frontend
RUN npm run build:shared && npm run build:frontend

FROM nginx:alpine
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
# SPA routing: unknown paths must fall through to index.html
RUN printf 'server{listen 80;root /usr/share/nginx/html;location /{try_files $uri /index.html;}}' \
    > /etc/nginx/conf.d/default.conf
```

Run **two** backend containers off the same image: one `PROCESS_ROLE=api`, one
`PROCESS_ROLE=worker`. Same image, different env — that is all the split needs.

### Option 2 — Cloud VM + managed data services

Same app containers, but Postgres/Redis/S3 become managed (RDS + ElastiCache + S3, or the Azure/GCP
equivalents). You give up some control and pay more; you gain automated backups, PITR, failover and
patching. **Effort: 3–5 days.** This is the right Tier B target.

### Option 3 — PaaS (Railway / Render / Fly.io)

Tempting — `git push` and it deploys, with managed Postgres and Redis built in. Two caveats:

- **LiveKit will not work** on most PaaS: it needs a public IP with a UDP range (50100–50200) and
  TURN on 3478. Plan to run LiveKit on a separate VM, or drop voice calling.
- Data residency: confirm the platform can pin you to an India region.

Good for staging. For production, Option 1 or 2.

### What I would actually do

1. **Clear the schema blocker** (§1) — nothing ships until a fresh DB can be built.
2. **Stand up staging** on one cheap VM via Option 1; run
   [staging-verification-runbook.md](./staging-verification-runbook.md) against it.
3. **Load test** with `scripts/load-test/fapoms-load.js` at your real expected concurrency.
4. **Go live on Tier A** (single VM, India region) for the first client. It genuinely fits.
5. **Move to Tier B** when load testing — not guesswork — says the database is the ceiling.

---

## 6. LiveKit: the one component with awkward networking

Voice calling is a real SFU and cannot hide behind an ordinary HTTP proxy.

- **Signalling** (7880) is proxied by the backend at `/livekit` — already handled, keep it closed.
- **Media is WebRTC/SRTP and must go direct.** Open on the host:
  - `UDP 50100–50200` — media
  - `TCP 7881` — ICE/TCP fallback for restrictive networks
  - `UDP 3478` — embedded TURN relay
- Needs a **public IP** and `use_external_ip` enabled in `livekit.yaml` (currently off — LAN only).
- **Rotate the dev keypair.** `devkey: secret` in the compose file must not survive to production —
  change both it and `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`.

Bandwidth: a voice call is ~50 kbps per participant, so this is cheap — but it is *sustained* traffic
on metered egress.

---

## 7. Getting the app onto handsets

The APK is **56 MB** and currently sideloaded. Options:

| Route | Effort | Notes |
|---|---|---|
| **Play Store — internal/closed testing** | Medium | Proper updates; needs a Play account and review. `versionCode` is still `1` — must auto-increment per release |
| **Firebase App Distribution** | Low | Made for exactly this: invite testers, push builds, no store review |
| **MDM** (Intune, Scalefusion) | Medium | Right answer if the bank issues the handsets |
| **Direct APK download** | Lowest | What happens today; no update mechanism, users must allow unknown sources |

Whichever you choose, the app talks to a configurable server address, so a build points at production
by setting `EXPO_PUBLIC_API_URL` at build time (with the in-app override as a fallback).

---

## 8. Pre-launch checklist

**Blocking**

- [ ] Fresh database bootstraps (§1 baseline + seeds) — **verify on a throwaway DB first**
- [ ] Production Dockerfiles for backend + frontend (§5)
- [ ] TLS on a real domain; `CORS_ORIGINS` set to it exactly
- [ ] Every secret rotated: `JWT_SECRET`, `DB_PASSWORD`, `PII_ENCRYPTION_KEY`, `DOCUMENT_TOKEN_SECRET`, LiveKit keypair, MinIO/S3 keys, Google Maps key
- [ ] **Secrets in git history purged/rotated** — `.env.docker` was committed; treat every value in it as public
- [ ] `STORAGE_DRIVER=s3` with a real bucket (the boot guard enforces this)
- [ ] Backups running **and a restore actually tested** — untested backups are not backups
- [ ] At least one `PROCESS_ROLE=worker` replica
- [ ] Seeded demo passwords (`admin123`, `assayer123`) changed; `mustChangePassword` set on seeded accounts

**Strongly recommended**

- [ ] ClamAV sidecar with `FILE_SCAN_REQUIRED=true`
- [ ] `METRICS_TOKEN` set, Prometheus scraping `/api/v1/metrics`
- [ ] `BULL_BOARD_USER`/`PASSWORD` set (otherwise the dashboard is not mounted — which is the safe default)
- [ ] Error tracking (Sentry) on backend, web and mobile — currently none anywhere
- [ ] Uptime check on `/api/v1/health/ready`
- [ ] Log aggregation off-box

---

## 9. Summary

**Can we deploy today?** Not yet — a fresh database cannot be built. That is the only true blocker,
it is well understood, and §1 gives a proven path through it (I rebuilt all 78 tables from the
baseline with zero errors). Two of the bugs in the way are already fixed in this pass.

**What does it need?** Postgres+PostGIS, Redis, object storage, the API and a worker, a static
frontend, and LiveKit if you want voice calls. Roughly **8 GB RAM** to start.

**What will it cost?** **₹2,000–8,000/month** for a pilot on one VM; **₹32,000–55,000/month** for a
resilient multi-client production setup with managed data services in Mumbai.

**Easiest route?** One VM + Docker Compose + Caddy for TLS. It mirrors how the stack already runs,
and it is honestly sufficient for the first client — measured, not assumed.
