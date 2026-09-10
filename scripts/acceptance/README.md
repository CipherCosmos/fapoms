# Acceptance probes

Two scripts that drive a **running deployment** over HTTP and check the database directly after
every step. They exist because an HTTP 201 is not evidence that anything persisted, and a 403 is
not evidence that nothing did — the same argument `assayer-lifecycle-certification.db.spec.ts`
makes for itself, applied to the money and authorization paths.

They are scripts rather than `.db.spec.ts` suites for one reason: they need a live API, a live
worker and a live database at the same time, and they are meant to be run by hand against a
deployment somebody is deciding whether to trust.

| script | what it certifies |
|---|---|
| `business-loop.mjs` | Create → Accept → Check-in → Complete → Payable → Approve → Pay. Ownership, versioning, idempotent completion and payment, the money recomputed independently, and segregation of duties refused in both directions. 25 checks. |
| `authorization-and-audit.mjs` | Whether a DESK_OPERATOR can reach privileged writes by calling the API directly, whether one assayer can reach another's work or bank details, and whether the application's own database credential can take the audit trail apart. 20 checks. |

## Running them

```bash
export AC_API=http://127.0.0.1:8080/api/v1
export AC_PASSWORD='<the password every acceptance persona rotates to>'
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USERNAME=fapoms DB_PASSWORD=... DB_DATABASE=fapoms
export FAPOMS_RUNTIME_PASSWORD=...     # authorization-and-audit.mjs only

node scripts/acceptance/business-loop.mjs
node scripts/acceptance/authorization-and-audit.mjs
```

`AC_PASSWORD` has no default and nothing works without it. Seeded accounts ship with a known
password and `must_change_password = true`, so each persona signs in, rotates to `AC_PASSWORD`,
and signs in again — the rotated password is tried first, which is what makes a second run a
no-op rather than a failure.

`AC_REPO` overrides where `pg` is resolved from; it defaults to this checkout.

## Two things that will waste your afternoon otherwise

**Point `DB_*` at the same database the API is using.** `deploy/docker-compose.prod.yml`
publishes only caddy on 8080 — postgres has no host port — so a script connecting to
`127.0.0.1:5432` reaches whatever else happens to be there. Rows get written to one database
while the API reads another, and every assertion fails as a 404 that looks exactly like a
tenancy bug. Publish the deployment's postgres on a port you chose, and use it.

**Raise the rate limit, or expect 429s.** These scripts are modest, but the certification suites
alongside them are not; `THROTTLE_LIMIT` defaults to 300 requests a minute per IP and refuses the
rest. A 429 in a run is the brake working, not the product failing.

## What they leave behind

`business-loop.mjs` creates assignments tagged `ACC-` and cancels any still open from an earlier
run — through the product, never by deleting, so the history of every previous run stays intact.
It also widens the seeded project's end date once, because the seed ships a window that has
closed. `authorization-and-audit.mjs` writes nothing: every destructive probe runs inside a
transaction that is always rolled back, which is the lesson of
`docs/incident-2026-09-09-audit-truncate.md` — a probe that proves a control by destroying
evidence has cost more than it found.
