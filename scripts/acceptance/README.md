# Acceptance probes

Scripts that drive a **running deployment** over HTTP and check the database directly after every
step. They exist because an HTTP 201 is not evidence that anything persisted, and a 403 is not
evidence that nothing did — the same argument `assayer-lifecycle-certification.db.spec.ts` makes for
itself, applied to the money and authorization paths.

They are scripts rather than `.db.spec.ts` suites for one reason: they need a live API, a live worker
and a live database at the same time, and they are meant to be run by hand against a deployment
somebody is deciding whether to trust.

---

## Read this before you point any of them at something

**Certification tooling is read-only by default.** It has to be safe to aim at a deployment
*before* you have read it. Until 2026-09-11 it was not: `_lib.mjs` `login()` rotated an account's
password away to a handover value and back whenever `mustChangePassword` was set, and announced
nothing. On a rig that is convenient. On a real deployment it is an unannounced write to a live
credential, and a failed rotate-back leg locks somebody out. It had already undone a password reset
made for the product owner, twice, with nobody able to see why.

Two gates, deliberately separate, because *insert a fixture branch* and *change a real account's
password* are not the same risk and must not share a switch:

| flag | permits |
|---|---|
| `AC_ALLOW_WRITES=1` (or `AC_ALLOW_MUTATIONS=1`) | fixture rows, business records, any writing SQL statement |
| `AC_ALLOW_PASSWORD_ROTATION=1` | changing **any** account's password. Implied by nothing. |

Both are off unless set. A mutating probe announces every category of write it performs **before the
first one happens**, and a run that was not authorised prints that list and stops. The gate is
enforced in `_lib.mjs` on `pool.query` itself — not by convention — so a probe cannot write through
the shared helper by accident, including through the multi-statement teardown several of them run
directly.

Scripts that do not go through `_lib.mjs`'s gates carry no gate. Their safety table row says so, and
each one also carries a `SAFETY CLASSIFICATION` block at the top of the file. Several of them import
**only** the job-polling helpers from `_lib.mjs` (see below). The polling itself is GETs only — the
POST it waits on is the probe's own write — and importing them does not put a script behind the gate.

---

## The safety table

Every script under `scripts/acceptance/` and every `scripts/verify-*.mjs`, and what each one does to
whatever it is pointed at. `gated` means it goes through `_lib.mjs` and therefore refuses to write
unless `AC_ALLOW_WRITES=1`.

| script | class | password | DB writes | deletes | destructive | gated |
|---|---|---|---|---|---|---|
| `_lib.mjs` | helper | rotates **only** with `AC_ALLOW_PASSWORD_ROTATION=1`, announced | gates every write through `pool.query` | — | — | n/a |
| `verify-deployment.mjs` | **read-only by default** | never — reports `mustChangePassword` as a finding | none | none | none | opt-in (`AC_EICAR`, `AC_ALLOW_WRITES`) |
| `bulk-lifecycle.mjs` | writes | none | INSERTs `ACBL-` assayers | its own `ACBL-` rows, both ends | walks real `lifecycle_status`, real audit rows | yes |
| `reopen-redo-money.mjs` | writes | none | fixture branch + assignment | its own fixture, incl. payables and billing entries | **books and voids real money** | yes |
| `money-workflow.mjs` | writes | none | fixture branches + assignments; fills bank/IFSC/PAN on ONE assayer, restored at the end; widens project dates, restored | its own fixture — payments, payables, entries, invoices, history, assignments, project_branches, branches | **books, approves and PAYS real money; raises and settles a client invoice** | yes |
| `custom-role-parity.mjs` | writes | none | none | none | **rewrites a role's permission set** (restored at the end) | yes |
| `region-parity.mjs` | **destructive** | none | `users.regions`, `is_active`, `must_change_password`; **moves a branch between regions** | branches, contacts, documents, remarks via API | **rewrites `user_roles`**; writes that succeed are the finding | yes |
| `assayer-child-region.mjs` | **destructive** | rotates an app login it minted (gated) | `users.regions`; clones assayer + child rows | assayer child rows via API | **rewrites `user_roles`**; writes that succeed are the finding | yes |
| `ten-business-days.mjs` | writes | mints assayer app logins and rotates them (gated) | assayers, branches, assignments, documents, panel standings | everything it made, by run tag | **books, approves and pays real money; mints an invoice** | yes |
| `search-export-performance.mjs` | writes (nearly read-only) | none | installs `pg_stat_statements` **only if absent**, removes it only if it installed it | none | **`pg_stat_statements_reset()` discards the server's accumulated query statistics** | yes |
| `authorization-and-audit.mjs` | writes | rotates each persona to `AC_PASSWORD` | none | attempts `DELETE /assayers/:id` expecting 403 | attempts TRUNCATE/DROP on audit tables — **always inside a rolled-back transaction** | no |
| `business-loop.mjs` | writes | rotates each persona | none | none — closes old runs through the product | **books real money**; consumes a project-branch permanently | no |
| `final-business-scenario.mjs` | writes | rotates personas and an app login | none | none | **books real money**; consumes project-branches | no |
| `lifecycle-bypass.mjs` | **destructive** | rotates each persona | none | **`DELETE /assayers/:id` archives a person and raw-cancels their work** | drives all four writers that reach `lifecycle_status` outside the map | no |
| `messy-reality.mjs` | **destructive** | rotates personas and an app login | clients, projects, branches, assayers, assignments | **schema-walking delete loop**: finds every table with a matching FK column and DELETEs, three passes | concurrent empanelment and pricing writes | no |
| `role-surface-matrix.mjs` | **destructive** | **rotates several accounts** between three values | none | **creates, grants, assigns and deletes a role**; probes DELETE on settings, notification catalog, rule-bypass | an aborted run leaves a real user holding the probe's role | no |
| `reliability.mjs` | **destructive — stops containers** | rotates personas and an app login | assignments tagged `ACC-REL` | none | **`docker stop`/`start` on the worker**; `redis-cli` inside Redis; **books real money** | no |
| `verify-guards-go-red.sh` | **mutates source files** | none | none | none | **edits files in the working tree**, runs jest, restores byte-for-byte; skips files with uncommitted changes | n/a |
| `verify-http-security.mjs` | writes | none | none | none | **`PUT /users/:id/roles` on a real user** (restored at the end) | no |
| `verify-migrations-from-empty.mjs` | **destructive** | none | in a scratch database only | — | **`CREATE DATABASE` / `DROP DATABASE … WITH (FORCE)`**; needs an admin credential | no |
| `verify-runtime-role.mjs` | **destructive** | none | in a scratch database only | — | **`CREATE DATABASE` / `DROP DATABASE`**; attempts TRUNCATE/DROP on audit tables inside it | no |
| `verify-list-limits.mjs` | **read-only** | none | none | none | none — every request is a GET | n/a |

Three things the table is trying to make impossible to miss:

- **`reliability.mjs` takes the deployment apart.** It stops the worker container to prove an
  api-only deployment drains no outbox. While it is stopped nothing is processed — no payables, no
  audit sealing, no retention. Do not run it against anything anybody is using.
- **`role-surface-matrix.mjs` rotates several real accounts' passwords** to get a session per role.
  That is the behaviour this campaign spent two afternoons on. It is not gated.
- **`messy-reality.mjs`'s teardown discovers tables at runtime and deletes from them.** It is scoped
  to ids the run created and skips a forbidden set, but it is a schema-walking delete loop.

---

## Running them

```bash
# Source the credentials file. Do not merely point at it: several probes read AC_PASSWORD
# straight from the process environment rather than through _lib.mjs, and a run that only
# sets AC_ENV_FILE makes six of them look like product failures. That is campaign defect T-02.
set -a; . /path/to/acc.env; set +a
export AC_ENV_FILE=/path/to/acc.env

node scripts/acceptance/verify-deployment.mjs          # read-only; start here
node scripts/acceptance/bulk-lifecycle.mjs             # needs AC_ALLOW_WRITES=1
```

`AC_PASSWORD` has no default and nothing works without it. `AC_API` defaults to
`http://127.0.0.1:8080/api/v1`. `PA_LIB` overrides where `ten-business-days.mjs` and
`search-export-performance.mjs` resolve their helpers from; both now default to `./_lib.mjs` in this
directory, where they used to default to an absolute path into a campaign scratchpad that is not in
the repository — so they ran a forked, older copy of the helpers and aborted outright on any other
machine.

## Routes that answer 202: wait for the job, then look

Since 2026-09-17 the slow bulk writes no longer do their work inside the request (the web client gave
up at 30 s while the server carried on). They answer **202 `{ jobId, deduplicated }`** and the body
they used to return is the finished job's `result`, read from a status route:

| POST | poll |
|---|---|
| `/assayers/app-access/bulk`, `/assayers/bulk/notify`, `/assayers/bulk/lifecycle` | `/assayers/bulk-jobs/:jobId` |
| `/billing-engine/payouts/approve`, `/payouts/pay`, `/assayer-invoices/invite-all` | `/billing-engine/bulk-jobs/:jobId` |
| `/planning/coverage-plans/:planId/execute`, `/planning/bulk-offers/jobs`, `/planning/unable-to-cover/jobs` | `/planning/write-jobs/:jobId` |
| `/documents/dispatch-batch` | `/documents/dispatch-batch/:jobId` |
| `/assayers/roster/import` (the `dryRun` rehearsal too) | `/assayers/roster/import-jobs/:jobId` |
| `/admin/data-reset/execute` | `/admin/data-reset/runs/:jobId` |

Probes do not write polling loops. `_lib.mjs` has one:

```js
import { postAndAwait, awaitJob, JOB_STATUS, describeJobOutcome } from './_lib.mjs';

const run = await postAndAwait('/billing-engine/payouts/approve', { payableIds: [id] },
  JOB_STATUS.billingBulk, { token });            // token may be () => currentToken
// run: { r, status, accepted: { jobId, deduplicated } | null, result, error, throttled }
check('...', run.result?.refused?.length === 1, describeJobOutcome(run));

const result = await awaitJob(JOB_STATUS.assayerBulk(jobId), { token, timeoutMs, pollMs });
```

`awaitJob` returns `result` when the state is `done` and throws a `JobError` (with the server's
`error`) when it is `failed`, when the budget runs out (`AC_JOB_TIMEOUT_MS`, default 120 s), or when
the status route refuses. `postAndAwait` never throws for an outcome: a request-level refusal comes
back as `accepted: null` with the response in `r`, and a failed run as `error`. Probes with their own
request plumbing pass `send: (path, body) => theirCall(...)` and `api: API`.

Four rules the scripts follow, each of which silently changes what a check measures if ignored:

- **Read the database after the run, never on the 202.** On the 202 the worker has not reached the
  row, so every "nothing moved" check passes whether or not anything was refused.
- **Know which refusals are still immediate.** Validation (bad target status, over-long reason,
  more than 500 ids, unknown fields), the role gate and the region ceiling are still 400/403/404 with
  nothing queued — assert on `status`. Per-row refusals (a duties conflict, a held payout, a
  reason-gated hop) are inside `result`, as they always were — the POST now says 202, not 201.
- **Poll as the account that started the job.** Anyone else gets 404, administrators included.
- **"Press it again" means after the first run finished.** An identical press by the same account
  while a run is queued or running joins it (`deduplicated: true`) and gets that run's result, so a
  repeat pressed too early measures the join, not the repeat. The ids are also de-duplicated when a
  batch is accepted, so `[a, a]` is reported once, not twice.

## Two things that will waste your afternoon otherwise

**Point `DB_*` at the same database the API is using.** `deploy/docker-compose.prod.yml` publishes
only caddy on 8080 — postgres has no host port — so a script connecting to `127.0.0.1:5432` reaches
whatever else happens to be there. Rows get written to one database while the API reads another, and
every assertion fails as a 404 that looks exactly like a tenancy bug. Publish the deployment's
postgres on a port you chose, and use it. On this rig that is **55432**.

**Raise the rate limit, or expect 429s.** `THROTTLE_LIMIT` defaults to 300 requests a minute per IP
and `POST /auth/login` is separately capped at 20/min. A 429 in a run is the brake working, not the
product failing — and `req()` honours `Retry-After`, so a busy run spends real time asleep. That
waiting is **never** reported as latency: `req()` returns `requestMs` and `waitedMs` separately and
the probes tally them on separate lines. A performance number that includes the measurer's own sleep
is worse than none, which is what produced the "60.4 second login" this campaign chased.

## `money-workflow.mjs` needs three accounts and an assayer in range

It walks both roads to an approved payout — the assayer's bill and the desk's recorded exception —
and every illegal transition on the way, checking the **database** after each refusal rather than
the HTTP status. Two things it needs that are easy to get wrong:

- **Three separate logins.** Segregation of duties has two rules, not one: whoever booked the work
  may not approve its payout, and whoever approved it may not pay it. Set `AC_BOOKER` (default
  `manager`), `AC_APPROVER` (default `admin`) and `AC_PAYER` (default `admin2`), with
  `AC_BOOKER_PASSWORD` / `AC_PAYER_PASSWORD` if they differ from `AC_PASSWORD`. Signed in once the
  script cannot reach a single approval; signed in twice it reaches approval but never a payment.
- **An assayer inside the client's coverage band.** The rule has BOTH ends — under 5km is refused
  as a conflict of interest, over 200km as out of range — and the seeded dataset's only
  payable-ready assayer is filed under "Pune City" carrying Bangalore's coordinates, 745km from
  the branch these probes clone. The script picks by distance and says so when nobody qualifies,
  rather than reporting "could not book an assignment" as though the money path were broken.
  `reopen-redo-money.mjs` picks the same way, for the same reason.

## The loop consumes branches

Each completed audit closes its branch to further assignments, which is a real business rule. So
`business-loop.mjs` uses up one project-branch per run, and on a rig it has run against ten times
there is nothing left to book — it stops and says so explicitly rather than looking like a failure.
Seed more branches, or use `freshBranch()`, which is why that helper exists.
