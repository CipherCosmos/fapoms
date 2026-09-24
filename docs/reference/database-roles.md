# Database roles: who FAPOMS is when it talks to PostgreSQL

## The problem this closes

FAPOMS connected as a superuser. `audit_events` and `audit_chain` are append-only by trigger, and
a trigger fires for every row-level write no matter who is connected. But a superuser, or the
table's owner, removes the trigger first:

```sql
ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
DELETE FROM audit_events;
```

Both succeed. So the append-only guarantee held against the application's code and against an
accidental query, and did not hold against anything holding the application's credential. For a
system whose product is audit evidence for banks, that is the wrong place for the boundary.

`AuditEventsImmutable1794000000000` said so when it was written: splitting migration-time and
runtime credentials would close it the ordinary way, and that was a deployment-architecture change
no migration could decide alone.

## The three roles

| role | logs in | owns | may |
|---|---|---|---|
| `fapoms_migrator` | yes, at deploy time only | the ordinary schema | all DDL. It is the deploy identity. |
| `fapoms_audit_owner` | **no** | the audit tables, their triggers and trigger functions | nothing on its own. It exists to be an owner nobody can log in as. |
| `fapoms_runtime` | yes, the API and the worker | **nothing** | SELECT/INSERT/UPDATE/DELETE on ordinary tables, SELECT/INSERT on the audit tables |

The control is **ownership**, not permission. `fapoms_runtime` owns nothing, so `ALTER TABLE`,
`DROP TABLE`, `DROP TRIGGER`, `ALTER FUNCTION` and `ALTER TABLE … DISABLE TRIGGER` are refused by
PostgreSQL's ownership check before a grant is consulted, and no grant can confer ownership. It is
a member of no role, so `SET ROLE` reaches nothing. It is not a superuser, so `CREATE EXTENSION`,
`CREATE ROLE` and `ALTER ROLE … SUPERUSER` are refused outright.

`fapoms_migrator` **can** defeat the audit triggers. That is the stated boundary, not an
oversight: it is a deploy-time credential a running process never holds, so compromising the
application does not yield it, and a future migration that alters an audit table has to work. It
is a member of `fapoms_audit_owner` for exactly that reason. Nothing else is.

The definition lives in `packages/backend/src/infrastructure/database/roles/role-model.ts`.

## The one piece of DDL the runtime still needs

`assayer_location_pings` is partitioned by month, and `RetentionService` creates next month's
partition and drops expired ones on a schedule — real DDL, in the API process. A missing partition
is not a slow query, it is an INSERT failing at the moment an assayer records a fix, so the
maintenance cannot simply stop.

Granting `CREATE` on the schema would hand back the privilege being removed. So it goes through
`fapoms_manage_location_ping_partition`: `SECURITY DEFINER`, owned by the migrator, `search_path`
pinned to `pg_catalog, pg_temp`, and it accepts only a name matching
`assayer_location_pings_yYYYYmMM`, attaching it only to that one parent. The runtime borrows one
month of location pings and nothing wider. Migration `1797700000000`.

## Provisioning: one command, no hand-written SQL

```bash
DB_ADMIN_URL=postgres://postgres:…@host:5432/postgres \
DB_HOST=host DB_PORT=5432 DB_DATABASE=fapoms \
FAPOMS_MIGRATION_PASSWORD=… FAPOMS_RUNTIME_PASSWORD=… \
npm run db:provision
```

In production this is the `db-migrate` service in `deploy/docker-compose.prod.yml`, which runs the
**compiled** module from the same image the API runs:

```
node packages/backend/dist/infrastructure/database/roles/provision.js
```

The image carries `dist` and nothing else — no `src`, no ts-node, no `scripts/` — so a deploy step
that shelled out to npm would work on a checkout and fail in the container, mid-deploy, with the
old containers already stopping.

The steps, in order:

1. **bootstrap** — as `DB_ADMIN_URL`. Creates the three roles, makes the migrator the owner of the
   database (creating it if it is not there), reassigns any objects an earlier deployment left
   behind, and installs the extensions (`uuid-ossp`, `pgcrypto`, `postgis`, `pg_trgm`). Skipped
   with `SKIP_BOOTSTRAP=true` on a managed cluster whose identities somebody else owns.
2. **migrate** — as `fapoms_migrator`.
3. **harden** — as `fapoms_migrator`: reassigns the audit objects to `fapoms_audit_owner`, grants
   the runtime its minimum, revokes the rest. Then re-connects **as `fapoms_runtime`** and checks
   ten properties of that identity, failing the deploy if any is wrong. Applying a grant and
   confirming a boundary are different claims.

Every step is idempotent, so the same command serves a first provision and every subsequent
deploy. **Harden must run after every migration**: a new table arrives with no grant for the
runtime, and a recreated audit trigger function arrives owned by the migrator again.

`backend` and `backend-worker` both wait on
`db-migrate: {condition: service_completed_successfully}`, so a failed migration stops the deploy
with the previous containers still serving rather than starting an API against a half-migrated
schema.

## Environment and secrets

| variable | who needs it | notes |
|---|---|---|
| `DB_ADMIN_URL` | `db-migrate` only | An administrative login: CREATE ROLE, CREATE DATABASE, CREATE EXTENSION. Never in the API's environment. |
| `FAPOMS_MIGRATION_PASSWORD` | `db-migrate` only | The deploy credential. It can alter the audit structures, so it must not reach a running process. |
| `FAPOMS_RUNTIME_PASSWORD` | `db-migrate` and the API/worker | The application credential. |
| `FAPOMS_RUNTIME_USER` | the API/worker | Defaults to `fapoms_runtime`. |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE` | everything | |
| `DB_MIGRATIONS_RUN` | the API/worker | **Must be `false`.** `main.ts` refuses to boot in production otherwise. |
| `SKIP_BOOTSTRAP` | `db-migrate` | `true` where roles are managed outside this deployment. |
| `STARTUP_CHECKS_STRICT` | the API/worker | `true` in production: the database-identity checks are critical, so an unhardened database refuses the boot instead of degrading quietly. |

`DB_USERNAME` and `DB_PASSWORD` remain for local development, where one role does everything.

Two guards stop the identities being put back together: `main.ts` refuses to start in production if
the API is set to migrate, or if `DB_USERNAME` is the migration role; and `StartupChecksService`
asks the database itself the ten questions in `RUNTIME_ASSERTIONS` at every boot — the same list
`harden` and the specs use, so the three cannot drift.

## Transitioning an existing deployment

The existing database was created by, and is owned by, whatever `DB_USERNAME` was — typically
`fapoms`, a superuser. Nothing below drops or recreates it, and no row is touched. Ownership of
the database and of the objects in it does change; that is what makes the rest work, and it is
detailed below.

**Before you start**, take a backup (`deploy/backup.sh`). The step changes ownership of the
database and of every object in `public`; a restore is the escape hatch if the deployment cannot
start afterwards.

The script prints what it did and finishes by naming the dump it wrote, which lands in
`~/backups/fapoms/daily/` on the host — not in the `deploy_backupsdata` podman volume, which holds
the data-reset danger zone's on-demand snapshots and is a different feature entirely. It exits
non-zero and says why on any failure, and it exits zero only after reading the dump back and
checking it carries data for at least as many tables as the live database had when the dump
started. So the dump named on the last line is one that has already been verified; to go further
and prove it restores, `deploy/restore.sh --drill` restores it into a scratch database and drops
it again.

1. **Add the secrets** to the deploy environment: `DB_ADMIN_URL` (the existing superuser is fine —
   it is used only at deploy time from here on), `FAPOMS_MIGRATION_PASSWORD` and
   `FAPOMS_RUNTIME_PASSWORD`, both freshly generated.
2. **Deploy the new compose file.** `db-migrate` runs first: it creates the three roles, takes
   ownership of the existing database and its objects, applies any pending migrations as
   `fapoms_migrator`, and hardens. The API then starts as `fapoms_runtime`.
3. **Read the boot log.** Ten `Database identity: …` lines, all `ok`. With
   `STARTUP_CHECKS_STRICT=true` a failure refuses the boot, so a wrong answer is a failed deploy
   rather than a silently unprotected one.

What the bootstrap step does to an existing database:

- **It takes ownership of the database.** `ALTER DATABASE <db> OWNER TO fapoms_migrator`. Since
  PostgreSQL 15, `CREATE` on `public` belongs to `pg_database_owner`, so a migrator that does not
  own the database cannot create anything and the first migration fails. Nothing is dropped and
  nothing is recreated; the old owner keeps every other privilege it had, and a superuser stays a
  superuser.
- **It reassigns the objects the old role created** — tables, partitions, sequences, views and
  functions in `public` — to `fapoms_migrator`, so that hardening can then move the audit tables to
  `fapoms_audit_owner`. Extension-owned objects (`spatial_ref_sys`, the `pg_stat_statements` views)
  and sequences behind identity columns are left alone; they belong to the extension or follow
  their table. If anything is left that neither role owns, provisioning stops and names the count
  rather than failing later in hardening with a less useful message.
- **The audit tables move to `fapoms_audit_owner`.** Anything outside FAPOMS that wrote to them
  directly — a reporting job, a maintenance script — stops working, deliberately.

None of this touches row data. Verified on a populated pre-split database: schema migrated and
seeded as the old superuser, an audit row written before the transition, and after it users,
branches and that audit row were all still there with the audit tables owned by a role that cannot
log in.

Verified again, independently, by the parallel acceptance session on a fixture built differently
on purpose — the database migrated through the ordinary `migration:run` path as the old superuser
rather than through provisioning. Same result: 5 users, 10 branches and 8 assayers before and
after, the pre-transition audit row still readable, the database owner moved to
`fapoms_migrator`, `audit_events` to `fapoms_audit_owner`, and the runtime role then refused
`UPDATE`, `DELETE` and `DISABLE TRIGGER` on the audit tables while ordinary reads and appends kept
working. A migration path proven only on the fixture its own author chose is the weakest kind of
evidence; this is not that.

**Rolling back** is `git revert` of the compose change plus setting `DB_USERNAME`/`DB_PASSWORD`
back to the old role and `DB_MIGRATIONS_RUN=true`. The roles and grants can be left in place; they
harm nothing while unused. The audit tables stay owned by `fapoms_audit_owner`, which the old
superuser can still administer, and the database stays owned by `fapoms_migrator` — hand it back
with `ALTER DATABASE <db> OWNER TO <old role>` if you want the previous state exactly.

## Verifying it

```bash
# Provisions its own disposable database, attacks it as the runtime role, drops it.
DB_ADMIN_URL=postgres://…/postgres npm run verify:runtime-role

# Migrations from template0, twice, plus the constraints a fresh provision must come up with.
DB_ADMIN_URL=postgres://…/postgres npm run verify:migrations
```

`verify:runtime-role` runs the full battery against **both** ways a database comes into existence
— provisioning creating it, and it already existing because the postgres image's entrypoint made
it from `POSTGRES_DB` — because those two took different code paths and only one of them worked.
Per shape: every audit-bypass attack in the brief (UPDATE, DELETE,
TRUNCATE, TRUNCATE CASCADE, multi-table RESTART IDENTITY, ALTER TABLE, DROP TRIGGER, DISABLE
TRIGGER, DISABLE TRIGGER ALL, ALTER/CREATE OR REPLACE/DROP of the trigger function, DROP TABLE,
reassigning ownership to itself), every escalation attempt (SET ROLE, ALTER ROLE SUPERUSER, CREATE
ROLE, CREATE EXTENSION, CREATE TABLE, granting itself TRUNCATE, pointing the partition function at
`audit_events`), and — in the other direction — that appending an audit event, reading it back,
ordinary CRUD, an advisory lock, a temp table, a PostGIS call, the outbox and both halves of
partition maintenance all still work.

Both run in CI's `database` job, which has a `postgis/postgis:16-3.4` service.

## One trap worth knowing

`nest build` only ever ADDS. A file deleted or moved in `src` keeps its compiled copy in `dist`
for ever, and 63 migrations that had moved into `migrations/_historical/` were still sitting at the
top level of `dist/…/migrations/`, where the runtime glob — single-level on purpose, to exclude
`_historical` — matched them. Provisioning a fresh database from a checkout that had ever been
built ran `InitialMigration1784653336579` and died on `relation "clients" already exists`.

`deleteOutDir: true` is now set, and `tsBuildInfoFile` moved **into** `dist` so the incremental
state is wiped with it. The two are only correct together: with the build info outside `dist`, the
next build finds every input unchanged and emits nothing into the directory it has just emptied.
