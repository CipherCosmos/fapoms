# Final certification — findings ledger

Campaign started 2026-09-11 on `41f60beb`. One row per finding. Evidence levels are kept separate
and never merged into "tested": `BROWSER`, `API`, `DB`, `JOB`, `MOBILE`, `DEPLOYMENT`, `SOURCE`.

Every failure is classified **product defect / test defect / environment defect / wrong business
assumption** before anything is edited (§26). A refusal counts as verified only when the response
reason **and** the database state were both checked.

---

## Baseline — the starting line, measured not recalled

Probes re-run against the local production-shaped rig on 2026-09-11, after confirming the running
backend and frontend both contain markers from today's commits rather than trusting the deploy log.

| probe | result | evidence |
|---|---|---|
| ten business days | 85/85 | API · DB |
| region parity (write ceiling) | 43/43 | API · DB |
| custom role parity | 37/37 | API · DB |
| assayer child-row region | 30/30 | API · DB |
| reopen → redo → rebill | 19/19 | API · DB |
| bulk lifecycle contract | 17/17 | API · DB |

Ten business days improved from 80/85 at the last campaign to 85/85, with no change to the probe.

---

## Findings

### C-12 · HIGH · concurrency · **FIXED** (empanelment) — verified independently
The reproduction `200, 200, 200` is now **`200, 409, 409`**: one decision commits, the others are
refused deterministically, and the persisted standing equals the body the 200 returned. One version
bump, one `EMPANELMENT_SET` row whose `new_state` matches the row. The create race is `409, 409, 200`
with no 5xx, closing the 500 that the first attempt at this lane had found.

The table already carried a `version` column, incrementing since the schema was written and read by
nobody — the same shape as `client_billing`. The `client/pricing-version.ts` mechanism was applied
rather than a second one invented, with the lock taken **before** the read.

**A second defect surfaced while fixing the first.** The REJECTED-reversal guard — the rule that
reversing a rejection requires a written reason — was decided from an **unlocked** read. Under
concurrency a rejection could therefore be reversed with no reason at all. It is now answered from
the locked status.

Mutation-tested by moving the read back in front of the lock: the case named for it went red, file
restored byte-identical.

**Contract change callers must know**: editing an existing standing without `expectedVersion` is now
`400 MISSING_EXPECTED_VERSION`. Creating a first standing is unchanged.

### C-05 · MEDIUM · correctness · **FIXED** `403e6a08`
`ACTIVE` now sits in `NEVER_A_WAYPOINT`. Fixed at the transition graph rather than in the response,
because a truthful account of a fabricated activation is still a fabricated activation.

**It withdrew moves, and that is the deliberate half.** `INVITED → SUSPENDED`, `INVITED → RESIGNED`,
`DOCUMENT_VERIFICATION → SUSPENDED`, `ON_LEAVE → SUSPENDED`, `ON_LEAVE → RESIGNED` and
`SUSPENDED → ARCHIVED` now have no bulk path and report `skipped` with nothing written. Each is a
move the single-record route already refuses, so this is parity with the one-person screen, not a
new restriction. Verified: `INVITED → SUSPENDED` writes **zero** audit and activity rows and no
`ACTIVE` anywhere, while `INVITED → ACTIVE` still walks all four stages and leaves its earned rows.

### C-07 · MEDIUM · audit truth · **FIXED** `74a82b4a`, `4d31563d`
Each assignment cancelled by a departure now carries its own `ASSIGNMENT_CANCELLED` row in the same
transaction: previous and new status, reason, actor, branch, scheduled date, both entity versions,
the previous assayer, and a `departureEventId` linking it to the lifecycle row. Recorded with
`recordEvent`, not the forgiving variant — a cancellation that cannot be recorded does not commit.
The `DELETE /assayers/:id` door is closed too, which is what the probe's DEL-07 finding literally
names. That probe now reports **DEL-07 PASS, zero findings**.

**The second commit is the interesting one.** The first version was wrong in a way twelve green
tests could not see: TypeORM returns `[rows, affectedCount]` for `UPDATE … RETURNING`, and the code
treated the tuple as the row list. Every audit row was written with an **undefined entity id** — the
right number of rows, the assignments still bare, and a 201 on the way out. The unit fixture served
rows directly, a shape production never produces. Found by reading the database after a live run.

### C-25 · MEDIUM · open · found and not fixed
Four things the assayer lane surfaced and correctly left alone:

- **`roster-import.service.ts:1607/1643` writes empanelments directly** through `manager.save`,
  bypassing the guarded path. It serialises correctly against the new lock, but it is a fourth
  writer with no version discipline of its own.
- **`AssayerVettingTab.tsx` `HARD_BLOCKED_STANDINGS`** treats REJECTED, TERMINATED, EXPIRED and
  SUSPENDED as final on the client, contradicting the backend's deliberate reversible-with-a-reason
  rule. **The screen cannot reach a decision the API allows.**
- **`soft-delete-cascade.spec.ts` scans raw source including comments**, so a backtick-quoted SQL
  phrase inside a comment matches as if it were a statement. The project's own rule is that
  source-scanning guards strip comments.
- **`lifecycle-bypass.mjs` EMP-04, EMP-05 and ELG-03 contradict themselves.** All three set a
  standing to ACTIVE with no reason, which the reversal guard already refused at baseline, leaving
  the row REJECTED — then EMP-04 asserts the row is ACTIVE while EMP-02 asserts it was refused.
  These are the three "failures" investigated earlier and classified as fixture state; this is the
  actual mechanism.


### C-20 · HIGH · audit truth · **FIXED** `59b83607`
**The endpoint whose whole purpose is "what happened to this" answered that nothing had.**
`GET /audit-log/trail?limit=-5` returned **200 OK with 0 entries** on a record carrying 240 audit
rows. The inline clamp was `Math.min(limit, 500)` — bounded above and not below — and `-5` reached
four raw `LIMIT $n` interpolations, each wrapped in `.catch(() => [])`, so the failure surfaced as
an empty trail rather than an error.

A spec had recorded the decision to keep that inline clamp because the endpoint was "already
bounded". It was bounded in one direction. Verified on the wire after the fix: `limit=-5` and
`limit=abc` both return the default 200 entries, and the 5xx responses are gone.
- **Evidence**: API · DB

### C-21 · HIGH · test validity · **FIXED** `0dd3029c`
**Two probes were not running the code anyone reads.** `ten-business-days.mjs` and
`search-export-performance.mjs` defaulted their helper path to an absolute location inside a
campaign scratchpad — a **forked, older copy of `_lib.mjs` that is not in the repository**.

So no fix to the shared helper ever reached them, and on any machine but this one they aborted on
their first line. The 85/85 result those runs reported was measured against a library nobody can
read or review. The same expression would have written live bearer tokens into `scripts/`.
- **Evidence**: SOURCE
- **Class**: any default that points outside the repository. A test that resolves its subject from
  a path the repository does not contain is not testing the repository.

### C-22 · MEDIUM · destructive tooling · **FIXED** `0dd3029c`
**A read-only performance probe uninstalled the operators' monitoring.**
`search-export-performance.mjs` created `pg_stat_statements` with `IF NOT EXISTS` and then dropped
it **unconditionally**. On any deployment where it was already installed — which is every
deployment that monitors query performance — running the probe removed it. It now drops only what
it installed.
- **Evidence**: SOURCE

### C-23 · MEDIUM · certification honesty · **FIXED** `8af201fd`
**The first malware fix had a second false pass inside it.** Correcting the EICAR probe to use a
clean control file was right, but a deployment with **no scanner at all** also accepts the control
when `FILE_SCAN_REQUIRED` is unset. The probe now establishes that condition first and reports
UNKNOWN when it cannot.

Stated plainly by the lane that fixed it: on this rig, the old code said PASS on evidence the new
code correctly calls UNKNOWN. Live: control `201`, EICAR `400`, and clamd answering `PONG` from
inside the API container.
- **Evidence**: API · DEPLOYMENT

### C-24 · MEDIUM · test validity · **FIXED** `c5d81ae5`
**A probe that measured nothing read as a probe that found a defect.** In
`authorization-and-audit`, the sign-in helper could not tell a 429 from a bad credential, and one
case picked its second assayer with an unordered `LIMIT 1` over a table other probes fill with
password-less throwaways. That case failed, and the two horizontal-isolation cases after it never
ran at all — so a run that established **nothing** about whether one assayer can read another's
record presented as one that had found a problem with it.
- **Evidence**: SOURCE · API


### C-03 · **CLOSED — not a product defect** (measurement artifact)
**The 60-second login does not reproduce, and the mechanism is fully explained.**

Twelve controlled sequential logins against the rig: **0.199 s – 0.323 s**, every one a 200, no
outlier. That is ordinary bcrypt-comparison latency.

The 60.4 s came from the probe measuring its own deliberate backoff. `POST /auth/login` is
`@Throttle({ limit: 20, ttl: 60_000 })` — twenty per minute per IP — and
`scripts/acceptance/_lib.mjs` `req()` honours `Retry-After` on a 429, waiting up to 30 s a time
within a 90 s budget before retrying. A run that exceeds twenty logins in a minute therefore
records **wait + request** as one elapsed time and ends on a 200. "60.4s -> 200" is exactly that
shape.

**The real finding underneath is smaller and belongs to the tooling**: a performance probe that
folds its own rate-limit wait into a latency number will mislead whoever reads it. It should report
the request time and the waiting separately, or exclude throttled attempts from the sample.
- **Evidence**: API, 12 controlled trials · SOURCE
- **Handed to**: the lane that owns `scripts/acceptance/**`

### C-01 · MEDIUM · performance · **FIXED** `b75ed1b7`
**Resolved, and it was three tables rather than one.** `assignments` already carried
`idx_assignments_recent_page` for this exact shape; the roster, the document list and the
validation queue order by the same kind of key and had nothing covering it.

The acceptance rig holds 51 assayers, where the difference is invisible — the first measurement
showed a 2.9 ms sequential scan and would have justified doing nothing. Measured instead on a
200,000-row copy of the real `assayers` definition, carrying its twenty real indexes, built and
dropped for the purpose:

| | without index | with index |
|---|---|---|
| first page | 30.6 ms · 6,878 buffers | 0.027 ms · 4 buffers |
| deep keyset page, 50,000 in | 38.7 ms · 6,818 buffers | 0.500 ms · 4 buffers |

The second row is the one that decides it. Keyset pagination exists so that page 5,000 costs what
page 1 costs; with no covering index it degrades to a full scan on every page and the cursor buys
nothing. With the index the cost is four buffers at any depth.

Each index is partial on `is_active`, and each is declared on its entity as well as in the
migration — a `synchronize: true` environment rewrites the schema from the entity classes and would
silently drop a migration-only index, restoring the full scan without changing a line of SQL. That
is the same trap that would have undone the live-money unique indexes.

### C-01-OLD · superseded
**The roster list has no index for the column it sorts and pages on.** `assayers` is ordered by
`created_at DESC, id DESC` for both the list and its keyset cursor, and no index covers
`created_at`. The plan is a sequential scan plus a sort at both data volumes measured.

This is the screen most likely to be exhausted: its limit ceiling is 1,000 where every other list
caps at 200, and the keyset cursor is literally `created_at_id`. `assignments` already carries
`idx_assignments_recent_page` for exactly this shape.

- **Repro**: `SELECT indexdef FROM pg_indexes WHERE tablename='assayers'`, then
  `EXPLAIN (ANALYZE, BUFFERS) SELECT a.id FROM assayers a WHERE a.is_active ORDER BY a.created_at DESC, a.id DESC LIMIT 20`
- **Evidence**: DB
- **Dependent workflows**: roster list, roster export, HR overview counts, anything paging assayers
- **Class to sweep**: every keyset cursor in the product — does an index cover its order-by?

### C-02 · LOW · performance · OPEN
**About twenty list endpoints read `limit` straight off the query string** without the
`ParseLimitPipe` that exists for exactly this, so an unbounded list request is accepted. Named in
the probe output with the pipe's own comment explaining why it was written.
- **Evidence**: SOURCE · API

### C-03 · INVESTIGATE · performance · OPEN
**One login took 60.4 seconds** during the ten-business-day run, against a 2.4 s threshold for
everything else in that run. Every other call was inside budget. Cause not yet established —
candidates are bcrypt cost under contention, rate-limit backoff, or a cold connection pool. A
minute to sign in is a usability defect in its own right if it reproduces.
- **Evidence**: API

### C-04 · MEDIUM · correctness · OPEN
**Three money transition tables have no consumers, and one of them is wrong.**
`packages/shared/src/state-machines.ts:185-204` declares `BILLING_STATE_TRANSITIONS`,
`INVOICE_TRANSITIONS` and `PAYABLE_TRANSITIONS`; nothing imports any of them. `PAYABLE_TRANSITIONS`
omits `VOIDED` entirely, while the enum, the `CK_assayer_payables_status` constraint and
`voidPayable()` all have it. The same file's docblock warns that a dead definition is worse than no
definition. Anyone reading it to learn the payable lifecycle learns a lifecycle that does not exist.
- **Evidence**: SOURCE
- **Fix shape**: delete them, or wire them to the imperative implementation — not leave them as a
  third opinion.

### C-05 · MEDIUM · correctness · OPEN
**A bulk lifecycle move still walks through an unearned activation.**
`packages/shared/src/assayer-lifecycle.ts:214-236` records in its own comment that `ACTIVE` remains
a waypoint, so a bulk `INVITED → SUSPENDED` routes through
`DOCUMENT_VERIFICATION → INACTIVE → ACTIVE → SUSPENDED` and writes all four hops — skipping
background verification and training, and leaving an `ACTIVE` audit row for someone who was never
activated. It is visible in the response's `via`, and it appears in **no findings ledger**.
- **Evidence**: SOURCE
- **Dependent workflows**: assignment eligibility, deployment readiness, audit truth

### C-17 · HIGH · mobile · **FIXED** `4da826a8`
**Changing a password stranded the assayer on a dead session.** The change returns 201 and revokes
every token the session holds — the access token then answers `401 "User not found or inactive"`
and the refresh token `401 "Invalid or expired refresh token"`, with no replacement pair issued.
The app read the 201 as success and carried on, rendering as signed in while every request 401'd.

The screen this happened on is the forced-rotation gate, whose entire job is to stop an assayer
being stranded. It handed them **"Nothing scheduled" with their real job invisible**, and only a
force-quit cleared it.

The same run exposed the general case: an HR password reset revokes the session too, so the 401
arrives **before** the server can answer `403 PASSWORD_CHANGE_REQUIRED`. The gate that
`password-rotation-gate.spec.ts` covers therefore can never fire in practice.

Now silently re-authenticates with the new password, or signs out cleanly. Session-expiry is raised
only on a rejected credential, so a 5xx or a missing signal no longer destroys a good session.
Ten new specs; the identical sequence re-run on the device afterwards produced no 401 at all.

### C-18 · HIGH · product decision needed · OPEN — **do not guess this one**
**Nothing records when an assayer left the site, and the natural path guarantees it never will.**

Uploading the audited return takes `CHECKED_IN → COMPLETED` directly and never stamps
`checked_out_at`. On the mobile screen, "Scan audited return" is the **primary** button and
"Check out" is secondary, so the ordinary way to finish a job is the way that loses the record.

Census of this database, verified independently:

| | |
|---|---|
| assignments COMPLETED | 32 |
| with an arrival recorded | 17 |
| with a departure recorded | **1** — the one the mobile lane performed deliberately |
| completed, arrived, never departed | 15 |

`checked_out_at` is written in exactly one place, the check-out route, and `completeAudit` never
touches it. The state machine permits `CHECKED_IN → COMPLETED`, and `completeAudit` demands a
stated reason only when there was no check-**in**. So the repository's position is that departure is
optional — while `operational-integrity.service.ts:135` calls check-in and check-out
"attendance evidence", and the **web app never displays check-out at all**.

**This is not a bug to fix on my own judgement.** The repository does not establish whether a
departure record is required, and inventing the rule would either block a legitimate workflow or
manufacture evidence. The owner needs to answer one question: for a bank collateral audit, is visit
duration attendance evidence that must exist? If yes, completion should require a check-out or stamp
one, the web app should show it, and the 15 existing rows are a known gap. If no, the field should
be dropped from the integrity check that calls it evidence.

- **Evidence**: MOBILE · API · DB
- **Dependent workflows**: travel-claim verification, attendance evidence, audit defensibility

#### Owner's ruling, and what was built — `80a533e1`

**Ruled: departure IS required attendance evidence for a bank collateral audit.** Completion now
asks for the check-out and, failing that, for a stated reason — the same bargain the check-in rule
already strikes — recorded in `completed_without_check_out_reason` and written into the completion's
own audit row alongside the arrival, the departure and the minutes on site.

**Completion does not stamp `checked_out_at`.** That column means "the assayer left the branch at
this moment", and filling it from a completion would write a departure nobody observed into the
field a travel claim and an audit defence are later read out of. A manufactured observation is worse
than a missing one: the gap is visible, the fiction is not. The refusal exists so that nothing has
to be invented, and a spec asserts `checkedOutAt` is still null after an explained completion.

The web app now shows arrival, departure and time on site, and says in words when the departure is
missing and what reason was given — `checkedOutAt` previously appeared nowhere in the frontend.

A stated reason does **not** discharge the integrity finding. The new rule
`COMPLETED_ASSIGNMENT_WITHOUT_CHECK_OUT` (P1) reports a completed audit with an arrival and no
departure whether or not somebody explained it; the reason rides in `details` so the report
distinguishes explained from unexplained without hiding either.

Live, three evidence levels per case, 21/21 (`scratchpad/attend-probe.mjs`):

| case | API | DB | AUDIT |
|---|---|---|---|
| complete WITH a check-out | 201 | `COMPLETED`, departure untouched | `minutesOnSite: 135` |
| no check-out, no reason | 400, names the missing departure | status and `entity_version` unmoved | no `ASSIGNMENT_COMPLETED` row |
| no check-out, with a reason | 201 | reason persisted, `checked_out_at` still null | reason + "never checked out", `minutesOnSite: null` |
| no check-**in** (unchanged) | 400 "books the payout…" | unmoved | — |
| reopen → re-complete | 201 | both reason columns cleared, asks again | `minutesOnSite: 90` on the clean close |
| integrity scan | `scannedRules: 10`, `failedRules: 0` | scanner set == DB set | — |

Mutation-tested twice, restored byte-identical (sha256 checked) both times. The second mutation is
the one that matters: **`AND false` on the new rule's WHERE clause left all fifteen
`operational-integrity.service.spec.ts` tests green**, because that spec mocks `dataSource.query`
and never executes a rule's SQL. That is the scanner's documented failure mode reproduced on
demand. Closed with `attendance-integrity.db.spec.ts`, which runs the scanner against real Postgres
and asserts set equality with the table; it goes red on the same mutation, and is registered in the
CI db-spec regex.

**Recommended historical repair policy — recommended, not executed.**

The 15 rows have no recoverable departure time. Nothing in the product, the audit trail or the
location trail records when those assayers left; the trail holds a `CHECK_OUT` ping only where a
check-out actually happened, which for these rows it did not.

1. **Do not backfill `checked_out_at`.** Any value would be invented. Deriving one from the
   completion timestamp, the next day's first ping or an average visit length produces a number
   indistinguishable, on screen and in an export, from a geofenced observation — and these rows are
   precisely the ones a dispute would reach for. The column stays null.
2. **Do not backfill `completed_without_check_out_reason` either.** A reason is a statement by a
   named person at a moment. A bulk `UPDATE … SET reason = 'predates the requirement'` would read
   as fifteen people having explained themselves. The web app says it plainly instead: *"This audit
   was completed before a departure was required, so no reason was recorded."*
3. **Leave them reported.** They are P1 findings on every scan, by design. The count is the measure
   of the gap; suppressing it by date or by an `is_legacy` flag would remove the only number that
   shows the gap closing.
4. **Watch the count, and expect it to stop growing rather than to fall.** New completions cannot
   join the set unexplained. The right check at go-live is that no row *created after* `80a533e1`
   appears in the rule unexplained:
   `SELECT count(*) FROM assignments WHERE status='COMPLETED' AND checked_in_at IS NOT NULL AND checked_out_at IS NULL AND is_active AND completed_without_check_out_reason IS NULL AND created_at > '<deploy timestamp>'` — expected 0.
5. **If a client challenges one of the 15**, answer from the arrival, the geofence distance and the
   audited return, and say the departure was not recorded. That is defensible. A fabricated
   timestamp discovered in cross-examination is not.

- **Census after the change** (this rig): **15 historical, unexplained** — the same 15, unmoved and
  unbackfilled. The rest of the rule's findings are the probe's own rows, each carrying a stated
  reason, and that split is the number to read: the unexplained count is the gap, and it has stopped
  growing. `SELECT completed_without_check_out_reason IS NULL, count(*) … GROUP BY 1` separates them.
  The probe was run three consecutive times, 21/21 each time, after being made deterministic — its
  first version picked a random empanelled assayer and was refused by the client's 200 km service
  radius, which is a fixture defect, not a product one.
- **Still open at the seam** (see the lane report): two callers satisfy the requirement with a
  machine-written string rather than a person's answer — `document.controller.ts:846`
  (`Audited return PDF uploaded (<file>)`, and it swallows the refusal into a `console.error`) and
  `scheduling.service.ts:270` (`Completed via schedule dispatch`, which does rethrow). Both predate
  this change and affect the check-**in** rule identically. Named, not fixed: they are outside this
  lane and need the mobile lane's departure prompt to land with them. The integrity rule is the
  backstop — a boilerplate reason still leaves the row reported.

### C-19 · LOW · mobile · OPEN
Three smaller ones from the same run. Profile → Connection reports the server as offline but is
read-only, so a signed-in assayer must sign out to repoint a moved backend. Google Password Manager
captures the **backend URL** as the saved username, because the server-address field does not
disable autofill. And an Accept made while offline is silently dropped — check-in and check-out are
durably queued, accept is not.

### C-13 · HIGH · UI truth · **FIXED** `9b804157`, `99c76d19`, `e3063f62`, `4f3a0fe8`, `529ec193`, `6fdafec7`
**47 screens drew a refusal as a confident answer.** The sweep is done, money first, then people,
then work, then the desk, then outward. Representative of what was being said:

- the workforce roster announced "Workforce roster is empty" over 1,155 people
- the payouts tab said "No payouts yet. They appear here the moment an assignment completes."
- a person's audit trail said "Nothing recorded for this person yet"
- the user directory said "No users yet" beside an Add User button
- the assayer record's dossier load had a `catch` whose entire body was the comment
  `/* not entitled to dossier */`, and then showed nothing

Gate after: frontend **93 suites / 1183 tests**, tsc clean. Seven new spec files. Every behavioural
test asserts **both** halves — the refusal appears *and* the screen's own empty sentence is gone —
and every screen also keeps a "genuine empty state still works" case, so the fix cannot degrade into
blanket suppression.

The guard over all 46 screens was mutation-tested twice, restored byte-identical both times. The
second mutation is the one that matters: the code was removed from a screen while leaving the
comments that mention `loadFailed` intact, so a naive text scan would have passed. The
comment-stripped scan went red.

### C-14 · MEDIUM · test validity · OPEN — class worth sweeping
**A test and the bug it was supposed to catch agreed with each other.**
`AssignmentTable` branched on `error.statusCode === 403`. `api.request` throws an `AppError`, whose
field is `status`. The forbidden branch could never fire, so every refusal on a region-scoped queue
read as an outage with a Retry that could only ever fail again.

It survived because **the existing test constructed its error object by hand, with the same
invented shape**. Both sides agreed on a field the product does not produce. The call site now
builds its error through `fromResponse`, the real factory.

- **Evidence**: SOURCE, fixed in `6fdafec7`
- **Class to sweep**: every test that hand-builds an error, a response, or a DTO instead of running
  it through the real constructor. Those tests can only confirm their author's belief.

### C-15 · MEDIUM · UI truth · **FIXED** `98e87606`
**Whether a failure was worth retrying depended on whether the server sent prose.**
`fromResponse` seeded the category from the status, then consulted the status table — where 429,
502, 503 and 504 are retryable — only when nothing else had produced a sentence. A readable server
message filled that first, so the lookup was skipped and the seeded `system-failure` survived.

Measured: a 502, 503 and 504 each reported **not** retryable with a message and **retryable**
without one. The status now decides the category and the message only decides the wording; a domain
code still wins both. A 500 stays deliberately non-retryable, pinned so the fix cannot widen.

- **Evidence**: verified by spec, red before and green after

### C-16 · LOW · UI truth · **FIXED** `6fdafec7`
**A failed check reported itself as a passed check.** `AssayerDetailModal` printed a green ticked
"No open flags on this record." whenever the snapshot request failed — while the panel beside it,
fed by the *same* request, honestly said it could not load. Of everything in this sweep, a green
tick over an unanswered question is the one most likely to be acted on.

### C-12 · HIGH · concurrency · OPEN
**Two desks recording different empanelment decisions at the same time: both are told it saved,
and one is silently discarded.**

Three concurrent `PUT /assayers/:id/empanelment/:clientId` with three different standings all
answered **200**. The row holds one of them. The other two decisions were acknowledged to their
authors and lost, with nothing anywhere recording that a decision was overwritten.

Reproduced twice: once by `messy-reality.mjs` (B7-CONC-ii), then independently, from a clean
`ACTIVE` standing, restored afterwards.

```
standing before     : ACTIVE
PUT RECOMMENDED       -> 200
PUT NOT_RECOMMENDED   -> 200
PUT DOCUMENTS_PENDING -> 200
standing after      : NOT_RECOMMENDED
```

**Why this matters more than a normal lost update.** Empanelment standing is what gates assignment
eligibility. A desk recording `REJECTED` or `NOT_RECOMMENDED` for a client can have that refusal
silently replaced by a concurrent `RECOMMENDED`, and the person becomes deployable to a client who
declined them. The desk that refused them has a 200 and no reason to look again.

The route is a free-form upsert with no state machine behind it and no `expectedVersion`, while
assignments already refuse a stale write with a 409 either direction. So the product has the
mechanism and does not apply it here.

- **Evidence**: API · DB, reproduced independently
- **Dependent workflows**: assignment eligibility, planning recommendations, deployment readiness
- **Class to sweep**: every mutation that accepts no version. Which writes can silently lose a
  concurrent decision, and which return a conflict?

#### The class, swept

Only **assignment** and **assayer** carry `expectedVersion` and refuse a stale write. Every other
mutable entity accepts last-write-wins with no conflict signal. Two were tested live on
decision-bearing data and both lose writes silently:

| what | concurrent result |
|---|---|
| empanelment standing — gates who may be deployed | 3 × 200, two decisions discarded |
| client GST rate — prices every audit for that client | 3 × 200, two decisions discarded |

The second one is the more instructive. `client_billing` **has a `version` column and bumps it on
every write** — it went 1 → 4 across the three concurrent calls — so the mechanism is present and
simply never consulted. The rows carry the evidence of the collision and nothing reads it.

Untested but structurally identical, in rough order of what a lost decision costs: client
configuration (rate card, service radius), document verification verdicts, branch and project
edits, holiday and zone definitions, role permission matrices.

### C-08 · HIGH · deployment · OPEN — owner action
**The homeserver is not running the code anyone has been certifying.** It is serving a build from
**2026-09-09**, roughly 94 commits behind `HEAD` and 10 behind `origin/main`. It has not pulled the
remote tip either.

Absent from the running build: the TDS report PAN mask, the voided-payable money fix, region-scoped
writes, and the log-proxy wiring. **Every prior statement of the form "verified on the homeserver"
about anything dated 09-10 or later describes a build that box has never run.**

Established two independent ways, since no container shell was available. The SPA is public and
content-hashed, so its bytes are the build: all 96 chunks fetched and grepped for string literals
unique to known commits. Separately, by route existence — the outbox routes added later answer 404
while contemporaneous routes answer 401. Both agree.
- **Evidence**: DEPLOYMENT
- **Owner**: whoever owns that box. This is a deploy, not a code fix.

### C-09 · MEDIUM · observability · OPEN
**A status endpoint reports the database as connected without asking it.**
`/api/v1/auth/status` returns `{"status":"online","database":"connected"}` where `database` is a
**hardcoded literal**, not a probe. It will report "connected" with the database on fire. `/health`
is the honest one and does probe. Anyone wiring a monitor to the wrong one gets a green light that
cannot go red.
- **Evidence**: DEPLOYMENT · SOURCE

### C-10 · MEDIUM · test design · OPEN
**The EICAR test cannot certify the malware scanner, and the go-live checklist says it can.**
`FileScanService` catches the EICAR signature **in-process, before it ever looks at `CLAMAV_HOST`**.
So a rejected EICAR upload proves the guard fired and proves nothing whatever about whether clamd is
reachable. Checklist item 3.10 as written would return a false pass on a deployment with no scanner.

The discriminating probe is a **clean control file** alongside it: 503 means no reachable scanner,
2xx means the bytes actually reached clamd. Read together, the pair is conclusive; either alone is
not.
- **Evidence**: SOURCE
- **Fix shape**: correct the checklist item, and keep both probes together.

### C-11 · MEDIUM · tooling safety · OPEN
**The shared probe helper silently changes passwords on whatever it is pointed at.**
`scripts/acceptance/_lib.mjs` `login()` rotates an account's password whenever
`mustChangePassword` is set — away to a handover value and back. Against the local rig that is
convenient and re-runnable. Against a real deployment it is an unannounced write to a live
credential, and a failed rotate-back locks somebody out.

This is also the full explanation of campaign defect T-03: a manual password reset cannot hold,
because the next probe run rotates it.
- **Evidence**: SOURCE
- **Fix shape**: a non-mutating sign-in for read-only certification, with rotation opt-in.

### C-07 · MEDIUM · audit truth · OPEN — confirmed live, assigned
**Archiving a person cancels their open assignments with no trail on the assignments.** The delete
cascade closes them with a raw `UPDATE` and bumps `entity_version`, but writes **no audit row
against any assignment it closed**. The only record is one `ASSAYER_DELETED` row on the assayer,
whose remarks name neither the assignments nor how many. "Why was my job cancelled?" is answerable
only by already knowing to look at the assayer's deletion.

This is the long-standing AC-F11, now reproduced by probe rather than inferred from code.
- **Evidence**: API · DB (`lifecycle-bypass.mjs`, finding DEL-07)
- **Dependent workflows**: assignment history, dispute handling, the audit trail's completeness claim

### C-06 · LOW · documentation · OPEN
**Reports cite numbers the source contradicts.** `@RoleOnly()` is 29 routes not 22; CI runs seven
db-specs not "six"; the lifecycle matrix is 121 ordered pairs not 150; go-live item 1.0 verifies via
`scratchpad/pa/tds-pan.mjs`, which is not in the repo, so the item cannot be executed as written;
`scripts/acceptance/README.md` documents 2 of 15 scripts with a `DB_PORT` that disagrees with every
script. Full list in [SYSTEM_MAP.md](SYSTEM_MAP.md) §7.
- **Evidence**: SOURCE

---

## Campaign defects (mine, not the product's)

Recorded because §26 requires the distinction, and because a test defect reported as a product
defect is worse than silence.

| # | what | class |
|---|---|---|
| T-01 | The baseline runner used `timeout`, which macOS does not ship. All 14 probes reported "command not found" and nothing ran. | test defect |
| T-02 | The runner set the path to the credentials file but never sourced it, so probes reading `AC_PASSWORD` directly aborted while probes reading the file passed. Six probes wrongly appeared to fail. | test defect |
| T-03 | Resetting `admin` to a memorable password desynchronised it from the other fifteen accounts, which remain on the harness password. The probes rotate passwords themselves, so a manual change does not hold. **Open — needs a decision.** | environment defect |
| T-04 | Three `lifecycle-bypass` checks failed (EMP-04, EMP-05, ELG-03) because the shared empanelment fixture was left at `REJECTED` by an earlier aborted run, where the checks expect `ACTIVE`. **Verified not a product defect**: setting an invented standing `BLACKLISTED` is refused `400` naming the seven legal values, and the row is unchanged. Recorded because calling this a product defect would have been the easy and wrong answer. | test defect |
| T-06 | **The git index is shared across every lane in this checkout.** `git add <paths>` followed by `git commit` commits the WHOLE index, including whatever another lane staged in between. Two commits carry the wrong attribution because of it — eleven files of one lane's work rode into another lane's commit, and two files went the other way. Nothing was lost and the history is intact. **`git commit -- <paths>` is the only safe form here**, and it is now what every lane is told to use. | campaign defect |
| T-05 | `business-loop` aborts with `409 Cannot assign` — every branch its assayer may work is already engaged, because a completed audit closes its branch to further assignments. That is a product **rule**, not a fault; the probe needs fresh branches per run. | test defect |
