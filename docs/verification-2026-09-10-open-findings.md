# Open-findings remediation — verification record, 10 September 2026

What was checked, how, and what the check actually showed. The eight workstreams in the
`4b4cfa14` checkpoint were committed mid-edit and unproven; this is the record of proving them,
and of the three defects that proving them uncovered.

Everything below ran on a throwaway PostgreSQL 16 (postgis/postgis:16-3.4) created for the
purpose and destroyed afterwards. No deployed system was touched: the homeserver that runs the
`main` deployment was offline for the whole session, so nothing here is a statement about live
production data.

## The checkpoint compiles

`4b4cfa14` had never had a completed typecheck — the last one was killed by the load that ended
the previous session. All three packages are clean:

| package | result |
|---|---|
| shared | 0 errors |
| backend | 0 errors |
| frontend | 0 errors |

`packages/shared/dist` had to be rebuilt first. It was stale — `coverage.ts` was not in it — so
any typecheck of the backend or frontend before that rebuild was checking against a shared package
that did not include the checkpoint's own work.

## What the checkpoint got wrong

Three defects, none of which a passing suite would have shown.

### 1. The payout-evidence CHECK accepted the row it was written to refuse

`PayoutDestinationEvidence1797300000000` added this to `assayer_payables` and `billing_payments`:

```sql
CHECK (
  (destination_verified_at IS NULL AND destination_verified_source IS NULL
     AND payout_evidence_version_id IS NULL)
  OR
  (destination_verified_at IS NOT NULL
     AND destination_verified_source IN ('BANK_PASSBOOK', 'IDENTITY_DOCUMENT'))
)
```

It accepts `destination_verified_at = now(), destination_verified_source = NULL`, which is exactly
what the `?? new Date()` fallback used to write and the only row the constraint existed to make
impossible. `IN` over a NULL left-hand side is NULL, `FALSE OR NULL` is NULL, and a CHECK refuses
a row only when its expression is FALSE.

```
SELECT (NULL IN ('BANK_PASSBOOK','IDENTITY_DOCUMENT')) IS NULL;  -- t
SELECT (false OR (true AND NULL)) IS NULL;                       -- t
```

The four other bad shapes it was meant to refuse — an unknown source, an empty source, a source
with no timestamp, a pointer with no timestamp — were all genuinely refused, because each of those
makes a comparison FALSE rather than NULL. Only the NULL source slipped, and the NULL source is
the defect. Nothing about reading the constraint showed this. Inserting the row did.

`PayoutDestinationEvidenceNullFix1797600000000` adds `destination_verified_source IS NOT NULL` to
the second branch and forbids an identity-backed claim that also points at a document version.
`payout-destination-evidence.db.spec.ts` inserts every shape into both real tables — 22
assertions — and pins that what `resolvePayoutDestination` returns is storable and what the old
expression returned is not.

Two test fixtures were writing the fabricated shape and are now refused by it:
`assayer-postgres-concurrency.db.spec.ts` Race B wrote a destination snapshot by hand with no
source, and Race D used `'hash-v2-sha256'` where the schema requires a 64-hex digest. Both fixed;
all eight races pass.

### 2. The seed stored regions as display labels

`seed.ts` wrote ten branches as `'West'`, `'South'`, `'Central'`. `users.regions`,
`RegionGuardService`, the scope selector and the `region = ANY($1::text[])` predicates in billing
all compare against the enum codes: `WEST`, `SOUTH`, `CENTRAL`. Both columns are free-text
varchar, so nothing refused the write.

On a freshly seeded deployment a region-scoped operator therefore matched nothing — no branches,
no assignments, no documents, and no money. Not an error and not an empty state anybody would
query: precisely the answer a correct filter gives a region that genuinely has no work.

The real write path was never wrong. `BranchService` passes every value through `resolveRegion`,
which takes a label, a state name or a code and returns the code. The seed was the one place that
assigned the column directly. `region-values-are-codes.spec.ts` now refuses any region literal in
backend source that is not an enum code.

### 3. The outbox replay audited the count it had just reset

`OUTBOX_EVENT_REPLAYED` records `previousAttempts`, and the controller read it off the row the
service returns — which has had `attempts` set to 0 by the replay itself. Every replay was
recorded as "returned after failing 0 times". The service now carries the count it undid.

## Finance overview region scoping

The highest-priority finding: `GET /billing-engine/overview` returned organisation-wide totals to
a region-scoped caller while every other billing read narrowed correctly.

The instruction on this one was not to add a predicate to eight queries and call it done — a wrong
join in an aggregate produces incorrect financial figures, which is worse than the leak. So:

- **Documented.** `billing-region-scope.ts` now carries a per-statement table: all fifteen
  statements the eight slots are made of, each with what it selects from, which fragment narrows
  it, where its region walk starts, what makes a row countable, and the row filter the predicate
  is added to. Plus the ownership relationship each `EXISTS` depends on, and the two things
  deliberately not narrowed.
- **Reconciled.** `billing-overview-region-scope.db.spec.ts` re-implements the rule in TypeScript,
  sums the money with independent `SUM(...) WHERE id = ANY($1)` statements over the base tables,
  and compares. 37 assertions on a fixture with two populated regions, a null-region branch, an
  assignment with no branch, an invoice spanning both regions, an invoice with no lines and a
  payment settling nothing. Two of the 37 were wrong and were fixed: the attention-list cases
  expected kinds the type does not have, and the fixture gave its two unattributable assignments
  no reason to be flagged, so "region A names nothing unattributable" was asserting the absence of
  rows that were never there.
- **Proven to catch the leak.** Reverting the fix — `billingRegionFilters(enforced)` to `(null)` —
  fails 30 of the 37, across all eight slots.

### Live HTTP result

A real server on a seeded, migrated-from-empty database, with a two-region fixture: WEST 100,000
taxable across two assignments, CENTRAL 40,000 across one.

| caller | unbilled | revenue | GST | TDS |
|---|---|---|---|---|
| ADMIN, national | 165,200 | 140,000 | 25,200 | 14,000 |
| OPERATIONS, WEST only | 118,000 | 100,000 | 18,000 | 10,000 |

The 47,200 difference is exactly the CENTRAL row, and the WEST figures are exactly the WEST
fixture. `?region=CENTRAL` from that same account answers 403.

Setting `security.regionScope.mode` to `off` reproduces the original defect against the running
server: the same account and the same token receive the national figures. `enforce` narrows them
back. That is the defect and the fix, observed live, one after the other.

## The rest of the closure gate

**Payout verification cannot claim absent evidence.** `resolvePayoutDestination` is the one
definition, both writers use it, and the database now refuses the fabricated shape (above).

**Segregation of duties.** Ships as `enforce`, pinned by `security-defaults.spec.ts`, both call
sites wired, refusals written to the audit trail whether or not they are enforced. One stale
comment still calling `off` the default was corrected.

**Outbox exhaustion visible and replayable without duplicate effects.** The critical test exists
and passes: an event delivered normally, a second copy dead-lettered by fifteen failures, replayed
by an operator, delivered by the ordinary relay tick — and exactly one entry and one payable, the
same payable id as the first delivery. Verified live as well: DEVELOPER 200, ADMIN 403,
OPERATIONS 403, anonymous 401; a dead letter listed with its subject, replayed once, refused 409
on the second press, audit row reading `previousAttempts: 15`.

**One canonical coverage definition.** `packages/shared/src/coverage.ts`, consumed by the planning
endpoint, the client workbook and the planning header. `coverage-agreement.spec.ts` drives both
real backend implementations from one fixture across seven status combinations and compares every
bucket, not just the headline. `coverage-planning.engine.ts` has a fourth thing called
`coveragePercentage` — the plan's coverage, not the project's — which now says so.

**One canonical "unbilled" definition.** `billing-metrics.ts`, with a repo-wide sweep in
`unbilled-consistency.spec.ts` for any hand-written unbilled SUM, and a check that the ex-GST
figure is never labelled "Unbilled" on a screen.

**Status constants centralised.** `assignment-status-sets.spec.ts` parses the predicates out of
the entity's `@Index` decorators and the migrations rather than transcribing them. Confirmed
against the live migrated schema:

```
idx_assignments_single_active_assayer_day  WHERE is_active AND scheduled_date IS NOT NULL
  AND status = ANY (ARRAY['PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS'])
idx_assignments_single_active_branch       WHERE is_active AND project_branch_id IS NOT NULL
  AND status = ANY (ARRAY['PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS'])
```

**The two frontend fixes.** `/login` for a signed-in person redirects home through the same
element `/` renders; the record screen tells "no such person" apart from "not arrived yet" across
six cases including a slow response and a 500. `RETURN_TO_KEY` exists twice on purpose and
`session.spec.ts` now asserts the two halves still name the same entry — nothing would have failed
if they drifted, people would simply have stopped landing where they were headed.

**Authorization after early return.** Swept the whole backend. 31 methods can return before they
authorize; each is now listed in `authorization-before-early-return.spec.ts` with the reason its
shortcut discloses nothing, and a new one fails the build. No live instance of the check-in defect
remains.

Writing that scan is what found the thing worth finding. Its first version took the first `{`
after the parameter list as the method body — which for `Promise<{ success: boolean … }>` is the
return type. Every method with an inline object return type was invisible, `recordCheckIn` and
`recordCheckOut` among them. The scan came back clean because it could not see the two routes it
was named for. Reintroducing the half-fix in `recordCheckIn` now turns two of its five tests red,
naming the method and the line.

**Migrations from empty.** `npm run verify:migrations` creates a database from `template0`, runs
the migrations into it, runs them again to prove the run is idempotent, checks that the controls a
fresh provision depends on actually came up, and drops the database whatever happened. Result: 78
migrations, 94 tables, second run a no-op, all five named constraints and indexes present.

## Suites

| suite | result |
|---|---|
| backend unit | 303 suites, 4288 tests, all pass |
| frontend | 82 suites, 1011 tests, all pass |
| shared | 10 suites, 413 tests, all pass |
| backend `.db.spec.ts` | 6 of 8 suites pass; 2 need a live deployment (below) |

Typecheck clean on all three packages. Lint clean on backend and frontend; the shared package has
no lint script and is skipped by `--if-present`. All three build. No `--forceExit`, no
`retryTimes`, and no raised timeouts outside the `.db.spec.ts` files, which talk to a real database
and need more than the 5-second default.

## What could not be verified here, and why

- **`assayer-lifecycle-certification.db.spec.ts` and `assayer-tenant-isolation.db.spec.ts`.** Both
  drive a live HTTP deployment and sign in as long-lived accounts on it (`lc-ops@…`,
  `lc-admin@…`), with the password supplied at run time and deliberately not in the repository.
  The homeserver was offline throughout and the credential is not available here. They are
  deployment-certification suites, not local integration tests.
- **A CI job for any of this.** CI has no database, which is why the `.db.spec.ts` files are held
  out of it. `npm run verify:migrations` and the six self-contained `.db.spec.ts` suites are ready
  for a `services: postgres` block; that change is not in this work because it cannot be run and
  proven from here, and an unverified CI change on a branch that triggers a deploy is not worth
  the convenience.
- **The two findings recorded but not fixed** in the checkpoint stand unchanged: the application
  connects to Postgres as a superuser, so the append-only audit triggers can be disabled by
  anything holding its credentials — a deployment change, not a code one; and the certification
  database's audit count is not an uninterrupted history. See
  `docs/incident-2026-09-09-audit-truncate.md`.

## One thing worth knowing before the next live check

Changing `users.regions`, roles or `must_change_password` directly in the database has no effect
until the Redis cache is flushed. Two rounds of "the fix does not work" during the live
verification above were the RBAC cache serving the pre-change user, with a 403 that names the old
state and nothing that points at the cache.
