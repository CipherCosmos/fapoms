# Deploying FAPOMS on a new machine

Every step below was executed against a genuinely empty stack — new containers, new volumes,
`DB_SYNCHRONIZE=false` — and the results are what that run produced, not what it ought to produce.

---

## What you need

- Docker and Docker Compose
- Postgres **with PostGIS** — the compose file uses `postgis/postgis:16-3.4`. A stock `postgres`
  image will not do: three columns are `geometry(Point,4326)` and the planning and coverage
  engines are built on `ST_*` distance queries.

## Deploy

```bash
cp .env.docker.example .env.docker   # then edit — see "Before production" below
docker compose up -d
```

That is the whole thing. On first boot the backend:

1. Creates the Postgres extensions it needs (`uuid-ossp`, `postgis`, `pg_trgm`)
2. Applies every pending migration — the baseline builds all 80 tables
3. Starts serving

Then seed the first administrator and the reference data:

```bash
docker compose exec backend sh -c 'cd /app/packages/backend && npm run seed:prod'
```

`seed:prod` runs the compiled seed. `npm run seed` is the development one and invokes `ts-node`
against `src/`, neither of which exists in the production image — it fails with
`command failed: sh -c ts-node ...`, which reads like a broken script rather than the wrong one.

Sign in as `admin` / `admin123` and **change that password immediately**.

### Verify it worked

```bash
curl localhost:3000/api/v1/health
```

Expect `{"status":"ok","database":"up"}`. The `database: up` half is the part that matters — it
means migrations ran and the connection is live.

---

## How the schema is managed

**Migrations are the authority. `DB_SYNCHRONIZE` must stay `false`.**

`packages/backend/src/infrastructure/database/migrations/1784000000000-BaselineSchema.ts` is the
whole schema as one migration. The 65 files in `migrations/_historical/` are the superseded chain,
kept for reference; the loader globs a single level and does not execute them.

That chain had been broken for a long time and nobody could have known: with `synchronize` on,
TypeORM rebuilt the schema from the entities on every boot, so the migrations were never needed
and never run. Tested from empty, they created **2 of the 83 tables** before aborting. The
baseline replaced them and is verified to build the system from nothing.

If `DB_SYNCHRONIZE` is turned back on, the schema starts drifting from the migrations again with
no error and no diff — and you find out at the next deploy to a fresh database.

### Adding a schema change

```bash
docker compose exec backend sh -c 'cd /app/packages/backend && \
  npx typeorm-ts-node-commonjs migration:generate src/infrastructure/database/migrations/YourChange \
  -d src/infrastructure/database/data-source.ts'
```

It applies on the next boot. Never edit the baseline.

### An existing database adopting the baseline

A database that already has this schema must record the baseline rather than run it:

```sql
INSERT INTO migrations (timestamp, name)
VALUES (1784000000000, 'BaselineSchema1784000000000');
```

Do this **before** setting `DB_SYNCHRONIZE=false`, or the next boot will try to create 80 tables
that already exist.

### Running more than one backend replica

Set `DB_MIGRATIONS_RUN=false` and apply migrations as a separate step before rollout. TypeORM
takes no cross-instance lock, so parallel starts can race on the same migration.

---

## Before production

`.env.docker.example` ships development defaults. These must change:

| Variable | Why |
|---|---|
| `JWT_SECRET` | Signs every session. A known value means anyone can mint an admin token. |
| `PII_ENCRYPTION_KEY` | Encrypts PAN and bank details at rest. **Without it those fields are stored in plaintext**, and setting it later does not retro-encrypt what is already stored. |
| `DB_PASSWORD` | — |
| `MINIO_ROOT_PASSWORD` / `AWS_SECRET_ACCESS_KEY` | Document storage credentials. |
| `LIVEKIT_API_SECRET` | In-app calling. |
| `APP_PUBLIC_URL` | Every link in every email and push notification is built from it. Wrong value = links that go nowhere. |

Email is off until configured — set it at **Admin → Platform Settings**, no redeploy needed.

---

## Services

| Service | Port | Required to boot? |
|---|---|---|
| postgres | 5432 | **Yes** |
| minio | 9000 / 9001 | **Yes** — the API refuses to start if object storage is unreachable, and creates its own bucket on first connect |
| redis | 6379 | Yes — background jobs and notification delivery |
| backend | 3000 | — |
| frontend | 80 | — |
| livekit | 7880+ | Only for in-app calling |

The MinIO dependency is deliberate: documents are the audit evidence, and an API that starts
without anywhere to put them fails later and less clearly.

---

## Verified on a clean stack

```
docker compose up            → extensions created, 4 migrations applied, 79 tables
npm run seed                 → "Seeding completed successfully!"
/api/v1/health               → {"status":"ok","database":"up"}
login as admin               → 200, token issued
17 endpoints exercised       → all 200
```

The 79 is not a typo for 80: one migration drops the superseded `communications` table, and it
only drops it when empty.

---

## If something goes wrong

**App starts, every query fails.** Migrations did not run. Check `DB_MIGRATIONS_RUN` is not
`false`, then `docker compose logs backend | grep -i migration`.

**`relation "..." does not exist`.** The database predates the baseline and has not adopted it —
see *An existing database adopting the baseline*.

**`type "geometry" does not exist`.** Postgres is not PostGIS, or the application role lacks
permission to `CREATE EXTENSION`. On managed Postgres (RDS, Cloud SQL) an operator must create
`uuid-ossp`, `postgis` and `pg_trgm` once by hand before the first deploy.

**`Object storage is unreachable`.** MinIO is not up, or `S3_ENDPOINT` is wrong. The API will not
start without it.

**Frontend 404s on refresh.** The nginx config did not make it into the image — check
`packages/frontend/nginx.conf` is copied to `/etc/nginx/conf.d/default.conf`.

---

## Automatic deployment

A systemd user timer on the host checks `origin/main` every two minutes and redeploys what moved.
Files live in `deploy/`: `auto-deploy.sh`, `fapoms-deploy.service`, `fapoms-deploy.timer`.

```bash
systemctl --user status fapoms-deploy.timer     # is it running
tail -f ~/apps/fapoms-ops/auto-deploy.log       # what it has done
systemctl --user start fapoms-deploy.service    # deploy now, do not wait
```

**It is not development hot reload**, and deliberately so. Bind-mounting source and running
`nest start --watch` with a vite dev server would discard the production build, the nginx SPA
fallback and the single-origin routing this deployment relies on — on a URL real assayers are
testing against. What is automated is getting pushed commits onto the server, not turning the
server into a development machine.

Three properties worth knowing:

- **Only what changed is rebuilt.** A backend-only commit does not spend two minutes rebuilding
  the web bundle. A docs- or mobile-only commit rebuilds nothing.
- **It refuses to run over local commits.** If the clone on the server has anything unpushed it
  logs and stops rather than `reset --hard`-ing the work away. That is not hypothetical: an
  unpushed commit was found on this host once, and it was real work that existed nowhere else.
- **It verifies health afterwards**, polling `/api/v1/health` for two minutes, and logs a warning
  if the service does not come back — so a failed deploy is visible in the log rather than only
  when someone opens the app.

**Mobile is not covered by this.** JavaScript changes reach handsets through `eas update`; native
changes need a new APK. See `packages/mobile/BUILD-APK.md`.
