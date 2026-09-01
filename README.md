# FAPOMS — Field Audit Planning & Operations Management System

Software for a company that performs **physical audits of bank branches** on behalf of client
banks. A bank issues a contract covering a set of branches; FAPOMS plans the work, picks and
negotiates with field appraisers ("assayers"), tracks them to the branch and back, moves the
paperwork through data entry and validation, and bills for it.

Field appraisers work from an Android app. Everyone else — planning, HR, the data-entry desk,
finance, client users — works from a web app. Both talk to one API.

---

## Repository layout

Four npm workspaces, one shared vocabulary between them.

| Package | What it is | Dev port |
|---|---|---|
| `packages/shared` | **Start here.** Enums, interfaces, state machines, display labels, Indian geography (states → regions, pincodes). The single source of truth both other packages import. | — |
| `packages/backend` | NestJS + TypeORM + Postgres/PostGIS. 28 domain modules, Redis for cache/queues/sockets, S3-compatible object storage for documents. | 3000 |
| `packages/frontend` | React + Vite + Leaflet. The operations desk. | 5173 |
| `packages/mobile` | Expo / React Native. The appraiser's field app ("Karat"). Ships through EAS, not through Docker. | 8081 |

Supporting directories: `deploy/` (production compose, the auto-deploy unit, backup/restore),
`docs/` (see below), `scripts/load-test/` (k6), `infrastructure/livekit/` (self-hosted SFU config).

> ### One rule that will bite you
> `packages/shared` is consumed from its **compiled** `dist/`. After editing anything in
> `packages/shared/src`, run `npm run build:shared` or the backend and frontend keep seeing the
> old types — and the error you get names a missing export, not a stale build.

---

## Running it locally

Everything comes up in Docker. You need Docker with Compose; nothing else is installed on the host.

```bash
cp .env.production.example .env.docker   # then fill in — see "Configuration" below
docker compose --env-file .env.docker up -d
```

Postgres must be **PostGIS** — the compose file pins `postgis/postgis:16-3.4`. Three columns are
`geometry(Point,4326)` and the planning and coverage engines are built on `ST_*` distance queries;
a stock `postgres` image will not start the app.

On first boot the backend creates its extensions, applies every pending migration (the baseline
builds all 80 tables), and starts serving. Then seed the first administrator and the reference data:

```bash
docker compose exec backend sh -c 'cd /app/packages/backend && npm run seed:prod'
```

Sign in as `admin` / `admin123` and **change that password immediately**.

Check it worked:

```bash
curl localhost:3000/api/v1/health
```

`{"status":"ok","database":"up"}` — the `database: up` half is the part that matters, because it
means migrations ran.

**Port already taken?** `docker-compose.localports.yml` moves or withdraws FAPOMS' own host
bindings without disturbing whatever else is on your machine:

```bash
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.localports.yml up -d
```

### Working outside Docker

```bash
npm install
npm run build:shared
npm run dev:backend     # http://localhost:3000  (Swagger at /api/docs)
npm run dev:frontend    # http://localhost:5173
npm run dev:mobile      # Expo
```

You still need Postgres+PostGIS and Redis reachable; bring just those up with
`docker compose --env-file .env.docker up -d postgres redis minio`. The backend reads the same
`.env.docker` on the host as it does in the container, so set `DB_HOST=localhost` there (inside
Docker it is the service name `postgres`) — that is the one value the two paths cannot share.

---

## Configuration

**One file: `.env.docker`, at the repository root.** Not one per package, not a `.env.local`
beside it, not a `.env` next to the compose file. Everything reads that single file:

| Reader | How |
|---|---|
| Backend in Docker (dev + prod) | `env_file: .env.docker` on the service |
| Backend run on the host | `app.module.ts` loads it **by absolute path**, so a host run and a container run cannot disagree |
| Compose itself (`${VAR}` for the Postgres / MinIO / LiveKit credentials) | `--env-file .env.docker` |
| The LiveKit container | compose builds `LIVEKIT_KEYS` from the same two keys |
| Mobile packager host | same `LAN_HOST_IP` |

`.env.production.example` is the template — every key documented, required ones marked.

> **Run compose with the file:** `docker compose --env-file .env.docker up -d`. Compose resolves
> `${VAR}` from the shell or `--env-file`, *not* from a service's own `env_file:` entry — this is
> what `deploy/auto-deploy.sh` already does in production. Every `${VAR}` keeps its previous
> hardcoded value as a default, so plain `docker compose up` still works; passing the file is what
> makes `.env.docker` authoritative for the credentials too.

**If a second env file appears, it is not being read** — fold its values in and delete it. The one
that shows up on its own is `.env.local`: `neon env pull` (and `neon link` / `checkout` / `deploy`)
writes there by default. Use `neon env pull --file .env.docker` instead.

The API **refuses to start** in production if `JWT_SECRET`, `DB_PASSWORD` or `CORS_ORIGINS` is
missing or left at a development default, or if `DB_SYNCHRONIZE` is true — see
`assertProductionSafeConfig` in `packages/backend/src/main.ts`.

Both the database and the object store are switchable by env alone (local Postgres ↔ Neon,
MinIO ↔ AWS S3). Neither provider is hardcoded.

> **Back up `PII_ENCRYPTION_KEY` somewhere durable before go-live.** It encrypts appraiser PAN,
> Aadhaar and bank details at rest. Lose it and that data is unrecoverable; set it late and it does
> not retro-encrypt what is already stored.

---

## Schema

**Migrations are the authority. `DB_SYNCHRONIZE` stays `false`.**

`migrations/1784000000000-BaselineSchema.ts` is the whole schema as one migration. The 65 files in
`migrations/_historical/` are the superseded chain, kept for reference — the loader globs a single
level and does not execute them.

Migrations run **on boot** (`DB_MIGRATIONS_RUN=true`). That has one consequence worth internalising:
**a destructive migration and the code that stops using the dropped structure must ship in the same
commit**, because the migration runs the moment the new container starts.

```bash
npm run migration:generate --workspace=packages/backend -- src/.../migrations/Name
npm run migration:run     --workspace=packages/backend
```

Set `DB_MIGRATIONS_RUN=false` when running more than one replica and apply migrations as a
separate step.

---

## Tests and CI

```bash
npm test                                    # every workspace
npx tsc --noEmit -p packages/backend/tsconfig.json
```

`.github/workflows/ci.yml` runs on every push and PR to `main`: install, build shared, typecheck all
three apps (mobile is typechecked **here and nowhere else** — it has no build step in CI), run the
tests, build backend and frontend.

CI is not a status badge. `deploy/auto-deploy.sh` **refuses to deploy a commit CI has not marked
green**, so a red build cannot reach the field.

---

## Deployment

Read **[DEPLOYMENT.md](DEPLOYMENT.md)** — it is the current, verified guide and covers the
production compose stack, backups, and what to change before going live.

The running deployment polls `main` and redeploys what changed, rebuilding only the image whose
package moved. `deploy/aws/` holds an alternative AWS path.

The mobile app does **not** deploy this way. It ships through EAS
(`npm run build:apk --workspace=packages/mobile`); see
[packages/mobile/BUILD-APK.md](packages/mobile/BUILD-APK.md). A change to shared types that mobile
reads needs a new build to reach field devices.

---

## Documentation

| Document | Read it when |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Putting the system on a machine. **Current.** |
| [docs/business-spec.md](docs/business-spec.md) | Learning the domain: the audit process end to end, entity by entity. |
| [docs/staging-verification-runbook.md](docs/staging-verification-runbook.md) | Verifying a release against a live stack (the things unit tests cannot reach). |
| [docs/load-test-and-scale.md](docs/load-test-and-scale.md) | Proving the capacity ceiling; scaling past one instance. |
| [docs/adr-006](docs/adr-006-audit-lifecycle-retire.md), [adr-007](docs/adr-007-unify-assessment-into-project-branch.md) | Understanding why a piece of the model looks the way it does. ADR-007 is superseded and marked so. |
| [docs/architecture-assessment.md](docs/architecture-assessment.md) | Historical audit (Aug 2026). Carries a banner: its headline blockers are fixed. Check any specific claim against source. |
| [docs/integration-audit-handoff.md](docs/integration-audit-handoff.md) | Open defects, triaged. Three items remain. |
| [CLAUDE.md](CLAUDE.md) | Conventions for AI coding agents working in this repo. |

---

## Conventions worth knowing before your first PR

- **A branch is identified by its SOL ID.** Not a code, not a name — SOL ID, everywhere, and it is
  required on create. There used to be a second identifier and it produced duplicate branches.
- **One implementation per cross-cutting concern.** Distance, "the rate in force", the API envelope,
  date keys, region resolution — each has one canonical home. If you find yourself writing a second
  one, import the first instead.
- **Money and compliance errors are thrown, never swallowed.** A failed pricing read must not
  quietly book at the platform default.
- **Business dates are `Asia/Kolkata`**, independent of server timezone — use `businessDateKey` /
  `formatDateOnly` from shared, never `toISOString().split('T')[0]`.
- **Settings live in the registry**, not in constants. If a number is a policy, it belongs in
  `/admin/settings`.
