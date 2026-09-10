# FAPOMS pre-deployment certification — 10 September 2026

**Final status: BLOCKED.**

Not on an open defect. Every application and infrastructure finding raised in this cycle is closed
and proven, the last of them an authorization defect that had reached the live database: the seed
removed nineteen grants from four roles, including the only `SYSTEM:APPROVE:PLATFORM` in the
system. It is fixed, the repair is a migration, and the deployed database still carries the
shortfall until that migration runs. Beyond that it is blocked on the one thing that cannot be
manufactured from this machine: the live certification run. The homeserver that hosts the deployment was offline for the whole session, and
the two certification suites need it plus a credential that is deliberately not in this repository.
The release gate requires that run, so the honest answer is BLOCKED pending it, not CLOSED with a
caveat.

Everything below states what was actually executed and what the execution showed.

---

## Architecture

Single-organisation FAPOMS. Nothing here builds or tests multi-tenancy. The one real organisation,
`FAPOMS Private Limited` (`382c3718-89e5-41a2-ac29-ab5ec7900562`), was not touched at any point:
every database in this report was created for a test and destroyed after it, on ports 55432 and
55433, never 5432.

The change of substance this cycle is that the application is no longer a superuser to its own
database.

| role | logs in | owns | may |
|---|---|---|---|
| `fapoms_migrator` | deploy time only | the ordinary schema | all DDL |
| `fapoms_audit_owner` | no | the audit tables, triggers and trigger functions | nothing on its own |
| `fapoms_runtime` | the API and the worker | nothing | row reads and writes; append and read on audit |

The control is ownership, not permission. `fapoms_runtime` owns nothing, so `ALTER`, `DROP`,
`DISABLE TRIGGER` and `TRUNCATE` are refused before a grant is consulted, and no grant can confer
ownership. Full model, environment variables and transition procedure in `docs/database-roles.md`.

---

## Security

### Database runtime privileges and audit protection

`npm run verify:runtime-role` provisions a database from nothing, applies the role split, and then
attacks it. **43 of 43 checks passed.** Refused, as the runtime role:

| attack | refused by |
|---|---|
| `UPDATE`, `DELETE` on `audit_events` and `audit_chain` | no privilege |
| `TRUNCATE`, `TRUNCATE … CASCADE`, multi-table `TRUNCATE … RESTART IDENTITY` | no privilege |
| `ALTER TABLE audit_events` | not the owner |
| `ALTER TABLE … DISABLE TRIGGER`, and `DISABLE TRIGGER ALL` | not the owner |
| `DROP TRIGGER` on either table | not the owner |
| `ALTER`, `CREATE OR REPLACE`, `DROP` of the trigger function | not the owner |
| `DROP TABLE audit_events` | not the owner |
| `ALTER TABLE audit_events OWNER TO fapoms_runtime` | not the owner |
| `SET ROLE` to either other role | member of nothing |
| `ALTER ROLE … SUPERUSER`, `CREATE ROLE`, `CREATE EXTENSION` | not a superuser |
| `CREATE TABLE` in `public` | no CREATE on the schema |
| granting itself TRUNCATE/UPDATE/DELETE on `audit_events` | no grant option, so the GRANT is a no-op |
| the partition function pointed at `audit_events` or at an arbitrary table | the function's own name check |

And in the other direction, because a boundary that stops the product working is one somebody
switches off: appending an audit event, reading it back, insert/update/delete on ordinary tables, a
transaction advisory lock, a temporary table, a PostGIS call, the outbox, and both halves of
location-ping partition maintenance all still succeed.

One probe was wrong in the first run and was corrected rather than kept: PostgreSQL accepts a GRANT
from a role with no grant option, warns that nothing was granted, and returns success. The check now
reads the resulting privilege instead of the statement's exit status.

The deploy role can still alter an audit table. That is asserted explicitly, as the documented
boundary rather than an omission.

**Independently confirmed.** The parallel acceptance session probed the same statements against a
running rig as `fapoms_runtime`, each inside a transaction it rolled back, and reports the same
answers — including the distinction that matters: `ALTER TABLE audit_events DISABLE TRIGGER USER`
comes back **"must be owner of table audit_events"**, not "permission denied". The old failure was
ownership, and no REVOKE could have closed it. Their result is theirs and is cited here as
corroboration, not as this document's evidence.

### RBAC, IDOR and sensitive fields

`node scripts/verify-http-security.mjs` against a live API on a hardened database. **31 of 31
probes passed.**

- **Authentication.** No token, junk token and a well-formed token with a bad signature all 401. A
  real token 200.
- **Role authorization.** DESK_OPERATOR refused assignment creation; OPERATIONS refused the outbox
  admin surface; ADMIN refused it too, because it is DEVELOPER-only and role-only.
- **Region scope.** A WEST-only operator saw 8 branches of 10, was refused `?region=CENTRAL` with
  403, and saw 118,000 unbilled against the national 165,200 — the difference being exactly the
  CENTRAL row.
- **Hostile ids.** `not-a-uuid`, a traversal string, a SQL fragment and the nil UUID all refused
  cleanly, 400 or 404. A well-formed id naming nothing is 404, not 500.
- **IDOR and early-return authorization.** Check-in on somebody else's assignment returns no record
  and discloses no assignee detail. This is the route where the ownership question used to be asked
  after three idempotent shortcuts had already answered with the whole record.
- **Escalation.** Self-granting a role refused; editing another user refused.
- **Bulk and exports.** Bulk status change refused to a non-admin; the billing export refused to
  DESK_OPERATOR, which is the export that used to admit a role every screen refused.

Two of those probes passed vacuously on the first run and were fixed rather than left: the money
comparison accepted zero-versus-zero on a database with no billing rows, and the audit probe named
a route that does not exist and accepted its 404 as an answer.

### Authorization ordering

`authorization-before-early-return.spec.ts` sweeps every method in the backend for a `return` that
happens before the method authorizes. 31 are listed with the reason their shortcut discloses
nothing; a new one fails the build. Reintroducing the check-in half-fix turns two of its five tests
red, naming the method and the line.

### The seed removed nineteen grants from four roles

Found by the parallel acceptance session as "operations can delete an assayer and cannot open one",
and larger than that when traced. Fixed, and proven on a live database in both directions.

**What was wrong.** A fresh install is migrate, then seed. The migrations end with
`ReconcileRolePermissions`, which leaves every role matching `ROLE_PERMISSIONS` exactly. The seed
then took grants away, for two independent reasons that had to meet:

1. `roleRepository.find()` does not load the `permissions` relation, so `role.permissions` was
   `undefined`. The merge the code's own comment calls "merge, never replace" started from an
   empty map, and assigning a many-to-many in TypeORM deletes every junction row the new array
   does not name.
2. The hand-written permission list the seed writes had fallen twelve keys behind the grant table,
   and a key with no row was dropped by `.filter(Boolean)` rather than reported.

**What it cost, measured on the live deployment before the fix:**

| role | declared | held | what was missing |
|---|---|---|---|
| ADMIN | 63 | 57 | `SYSTEM:APPROVE:PLATFORM`, all three `ORGANIZATION` grants, both `OCR` grants |
| DEVELOPER | 64 | 57 | `SYSTEM:VIEW`, `SYSTEM:EDIT`, the same `ORGANIZATION` and `OCR` grants |
| OPERATIONS | 39 | 36 | `ASSAYER:VIEW`, `DOCUMENT:VIEW`, `REFERENCE_DATA:VIEW` |
| DESK_OPERATOR | 6 | 3 | `ASSAYER:VIEW`, `DOCUMENT:VIEW`, `VALIDATION:VIEW` |

None of the four holds a PLATFORM-scoped grant that would have covered its loss through the
guard's scope widening, so every one of the nineteen was a real refusal. `SYSTEM:APPROVE:PLATFORM`
is held by ADMIN alone, so no principal could approve a destructive request and the two-person
data-wipe rule could not be completed by anybody. OPERATIONS could create, edit and delete an
assayer and not open one. DESK_OPERATOR could reach none of the screens it lands on.

**The API had been saying so at every boot.** `warnOnRoleGrantDrift` named all four roles and all
nineteen grants in the deployment's log, and then told the reader to run the seed to fix it — the
one action that caused it. That advice is corrected.

**Evidence.**

- *Reproduced*: a database built from `template0`, migrated, then seeded, on a disposable
  PostgreSQL instance. After migrations: 63 / 64 / 39 / 6. After the seed: 57 / 57 / 36 / 3.
- *Same state live*: the deployed database held the identical nineteen-grant shortfall.
- *Fixed*: same path with the fix — 63 / 64 / 39 / 6, and a second `--force` seed leaves them there.
- *Repaired in place*: `ReconcileRolePermissions3` applied to a stripped database restores all
  nineteen, and is the only migration that runs.

**How it cannot come back.** `seed-grants.ts` holds the three decisions the seed makes about
grants: the catalogue is derived from `ROLE_PERMISSIONS` rather than remembered, an unresolvable
key throws instead of being filtered out, and merging a relation that was never loaded is refused
rather than treated as empty. 13 cases in `seed-grants.spec.ts`.
`verify-migrations-from-empty.mjs` now runs the real seed against the real schema and compares
every role's rows to what it declares; without the fix it exits 1 and names all nineteen.

---

## Data integrity

- **Payout evidence.** A verification timestamp cannot exist without a named source. The CHECK
  added by `1797300000000` accepted the exact row it was written to refuse — `NULL IN (…)` is NULL,
  `FALSE OR NULL` is NULL, and a CHECK treats NULL as satisfied. `1797600000000` corrects it.
  `payout-destination-evidence.db.spec.ts` inserts every shape into both real tables, 22 assertions.
- **Finance region scoping.** All 15 statements documented per query and reconciled against an
  independently written calculation on a two-region fixture, 37 assertions. Reverting the fix fails
  30 of them. Confirmed live: 165,200 national against 118,000 for a WEST-only caller, and turning
  the rollout off reproduces the original leak against the running server.
- **Segregation of duties.** Ships as `enforce`, pinned by `security-defaults.spec.ts`, both call
  sites wired, every refusal written to the audit trail.
- **Coverage and unbilled.** One definition each, with the planning endpoint and the client workbook
  driven from one fixture and compared bucket by bucket, and a repository-wide sweep for any
  hand-written unbilled SUM.
- **Status sets.** Parsed out of the entity's `@Index` decorators and the migrations rather than
  transcribed, and confirmed against the live migrated schema.
- **Region values.** The seed wrote display labels (`West`) where every consumer compares enum codes
  (`WEST`), so a freshly seeded deployment gave every region-scoped account an empty application and
  nothing said so. Fixed and guarded.

---

## Operational reliability

- **Outbox.** Exhaustion is a state on the row, not the absence of a match. Dead letters are listed
  with their subject, replayable once, and a second press is refused 409 rather than silently
  ignored. Replaying an exhausted `assignment:status-changed` produces exactly one entry and one
  payable — the same payable id as the first delivery. Verified live: DEVELOPER 200, ADMIN 403,
  OPERATIONS 403, anonymous 401, and the audit row reads `previousAttempts: 15` rather than the 0 it
  recorded before.
- **An event nobody handles is no longer recorded as delivered.** `publishAsync` resolved over an
  empty listener array and the relay stamped `dispatched_at`, so a renamed subscriber discarded
  every event of that name for ever. It now returns named handlers and catch-alls separately, and
  the relay refuses delivery only for the eight events where a missing handler means a business
  effect silently not happening.

  Two corrections went into getting there, both worth recording because both were mine. The first
  guard counted named handlers and catch-alls together and was dead code from the moment it
  shipped — the realtime gateway registers a catch-all for the life of the process, so the total is
  never zero — and its unit tests passed only because they mocked the publisher to return a value
  the real one cannot produce. The obvious correction, counting named handlers alone, would have
  been worse than the bug: nineteen event names including `billing:booked` and
  `billing:payout-changed` have no named subscriber by design, and that rule would have
  dead-lettered all of them on every tick, in the money path.

  The acceptance session verified both directions on a live rig. The guard fires: an event added
  to the required set with no handler was refused with the intended message and climbed the retry
  path across six attempts toward the dead-letter threshold. And it does not false-positive: all
  eight required names were seeded into the outbox live and every one was delivered, which
  establishes that each has a named subscriber **in the worker process** rather than merely
  somewhere in the source tree. That second half is what rules out the risk this fix created —
  dead-lettering a real business event — and it is not something the source scan can answer.
- **Concurrency.** Eight PostgreSQL race suites pass against a real database, including the payout
  destination snapshot against a concurrent bank-detail change.
- **Cache.** With one token held constant and no flush anywhere: `POST /assignments` 400, then 403
  the instant OPERATIONS was swapped for AUDITOR, then 400 again the instant it was restored. A
  region change narrowed the same token's branch list from 10 to 8 on the very next request.
  `authorization-cache-invalidation.spec.ts` pins that the delete is awaited, after the save and
  before the return; changing it to `void` turns it red. It also sweeps for a second cache of roles,
  permissions or regions, because the way this rots is a new cache nobody remembers to invalidate.

  Editing `users` or `user_roles` directly in the database invalidates nothing and cannot. That is
  what "cached" means, and it is why a direct UPDATE is never the production mechanism.

---

## End to end

**Not run here.** The two certification suites need the deployed server, long-lived certification
accounts and a runtime credential that is not in this repository. The homeserver was offline for
the entire session and remains so. The suites were not weakened to make them locally executable.

The parallel acceptance session has since run one of the two on a rig of its own — see "Not
exercised" below for what it reports and why that is recorded as theirs.

What was exercised live instead, on a disposable stack (PostgreSQL on 55433, Redis on 56380, MinIO
on 59001, API on 4099), is stated above and is not a substitute for it: real HTTP, real Redis, real
persistence, real authentication, a real hardened database, and a real API booting as the
least-privileged role with `STARTUP_CHECKS_STRICT=true` and ten green database-identity lines in
its boot log. It answered 200 on health, signed in, created a client (HTTP 201) and wrote the
`CLIENT_CREATED` row to the audit trail as that restricted role.

---

## Regression

| suite | suites | tests | result |
|---|---|---|---|
| backend unit | 305 | 4,337 | all pass |
| frontend | 82 | 1,012 | all pass |
| shared | 10 | 413 | all pass |
| mobile | 23 | 263 | all pass |
| backend `.db.spec.ts`, self-contained | 6 | 92 | all pass |
| backend `.db.spec.ts`, deployment certification | 2 | — | not run, see above |

Typecheck clean on shared, backend and frontend. Lint clean on backend and frontend, zero warnings
and zero errors; the shared package has no lint script and is skipped by `--if-present`. All three
packages build. No `--forceExit`, no `retryTimes`, and no raised timeouts outside the `.db.spec.ts`
files, which talk to a real database.

A correction to the brief: backend lint had **one** warning, not five — a `DocumentVerification`
import left behind by the payout-destination extraction. It was removed on `9e0ce1ef`, before this
cycle began, and lint has been at zero since.

---

## Infrastructure

- **Migrations from zero.** `npm run verify:migrations` creates a database from `template0`,
  migrates, migrates again to prove idempotency, checks that the controls a fresh provision depends
  on actually came up, and drops the database on every exit path. 79 migrations, 94 tables, second
  run a no-op, all five named constraints and indexes present. Raising the table floor to an
  impossible number makes it exit 1 and still leave nothing behind.
- **Provisioning.** One command, no hand-written SQL, run twice against the same database to
  confirm idempotency. In production it is the `db-migrate` service running the compiled module
  from the same image the API runs; `backend` and `backend-worker` wait on it completing
  successfully, so a failed migration stops the deploy with the previous containers still serving.
- **Two build traps, found by running the container's exact command rather than assuming it.**
  `provision.ts` first resolved migrations relative to `process.cwd()` — correct for the CLI,
  wrong for the container — and reported "No migrations to apply" against an empty database.
  And `nest build` only ever adds: 63 migrations that had moved into `migrations/_historical/`
  still had compiled copies at the top level of `dist`, where the runtime glob matched them, so
  provisioning from any checkout that had ever been built ran a 2026-era initial migration and died
  on `relation "clients" already exists`. `deleteOutDir` is now on with the incremental build state
  moved inside `dist`, because the two are only correct together.

---

## CI

**IMPLEMENTED — NOT EXECUTED.**

A `database` job is added to `.github/workflows/ci.yml` with a `postgis/postgis:16-3.4` service. It
runs `verify:migrations`, `verify:runtime-role` and the six self-contained `.db.spec.ts` suites.
The two deployment-certification suites are deliberately excluded and must stay excluded: they
drive a live server and hold a credential this repository does not contain.

Every command in that job was executed locally against the same PostGIS image with the same
admin-URL shape, and all pass. What is unproven is the GitHub Actions runner itself: the service
container, the port mapping and the standard checkout/node/npm-ci steps. It must not be marked PASS
until an actual run is green.

---

## The audit incident, unchanged

Stated exactly as `docs/incident-2026-09-09-audit-truncate.md` records it. Nothing was synthesised,
re-dated or reconstructed.

| | |
|---|---|
| Original certification rows | 5,621 |
| Rows destroyed by the TRUNCATE probe | 5,621 |
| Rows recovered from the 02:31 nightly dump | 2,301 |
| **Unrecoverable certification rows** | **~3,320** |
| Real-organisation records affected | **zero** |

The current `audit_events` count is not an uninterrupted history. Any analysis spanning
9 September 2026 must account for the gap between 02:31 and roughly 14:15 UTC.

The incident record's own "limit of that protection" section — the superuser gap — is now closed
for the runtime identity, and that closure is appended there. The destroyed rows stay destroyed.
Closing the cause does not restore the evidence.

---

## Known accepted risks

1. **The migration credential can alter the audit structures.** Deliberate: a future migration
   altering an audit table has to work, and `fapoms_migrator` is a deploy-time credential a running
   process never holds. Compromising the application does not yield it.
2. **Row-level security is not used.** It would be the next layer and is a much larger change:
   every query would run under a policy, and a wrong policy fails closed in production rather than
   in a test. The ownership split closes the gap that was actually demonstrated.
3. **Local development still runs one role with migrations on boot.** `docker-compose.yml` creates
   a single `fapoms` superuser and holds no evidence. Production is different and `main.ts` refuses
   to boot there with the runtime role set to migrate.

---

## Not exercised

Only items for which no evidence could be obtained here.

1. **`assayer-tenant-isolation.db.spec.ts`** — needs the deployed server, the long-lived
   certification accounts and a password supplied at run time. The homeserver was offline
   throughout this session.

   Its sibling `assayer-lifecycle-certification.db.spec.ts` **has since been run** — not here. The
   parallel acceptance session stood up a prod-shaped rig and reports 150/150: 98 illegal
   transitions refused with no mutation, rehire routing RESIGNED and TERMINATED to INVITED, every
   concurrency race admitting exactly one winner. That is their evidence, attributed, and it
   belongs in their report rather than being restated here as mine. Nothing in this document was
   verified by watching somebody else's terminal.
2. **The CI `database` job as a GitHub Actions run.** Implemented and locally command-verified; the
   runner is unexecuted.
3. **The production compose change as an actual deploy.** The `db-migrate` service, the
   `depends_on` gate and the new environment variables are written and the command they run was
   executed locally exactly as the container will run it, from the image root, against a fresh
   database. Bringing the real stack up was not attempted here.

   The parallel acceptance session has since done it and reports the gate holding: with
   `DB_ADMIN_URL` empty, `db-migrate` exits 1, the API is never started, the container already
   serving is not replaced and answers `/health` throughout. They also confirm both `main.ts`
   refusals fire under `NODE_ENV=production`, and that the database-identity check refuses an
   unhardened database naming `db:harden` rather than dying on an unreadable geo table. Theirs,
   cited, not adopted — and the three controls that catch somebody skipping a deployment step have
   now been observed doing their job, which they had not been when this document was written.
4. **Browser workflows.** No end-to-end browser run was performed; the frontend evidence is its
   1,012 unit and component tests.

---

## What has to happen before this ships

1. Bring the homeserver up and run the two certification suites against it, with `TI_PASSWORD` and
   `TI_ADMIN_PASSWORD` supplied at run time.
2. Push and let CI run the new `database` job; confirm it is green.
3. Follow the transition procedure in `docs/database-roles.md` on the existing deployment, take the
   backup it asks for first, and read the ten `Database identity` lines in the boot log.
4. Confirm the grant repair landed: after the deploy, the boot log should carry no
   `behind ROLE_PERMISSIONS` warning. It carries one today naming all nineteen.
5. Then, and only then, the status becomes CLOSED.
