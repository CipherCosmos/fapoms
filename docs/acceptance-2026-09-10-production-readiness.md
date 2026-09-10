# Production acceptance — 10 September 2026

## Executive conclusion

**NOT READY — by a short, well-understood list that is nowhere near the business logic.**

Take the good news first, because it is the larger part. The complete operational loop — hire a
person, deploy them to work, execute it, complete it, pay for it — runs correctly end to end,
refuses the illegal version of every step it was asked to refuse, survives concurrent operators,
and reconciles to the rupee under independent recomputation. Segregation of duties holds in both
directions and says so by name. The audit trail is now tamper-proof against the application's own
database credential, which closes the most serious control gap this project has carried. Not one
defect was found in how this system decides anything about money, work or people.

What stops it shipping is the front door, and one thing behind it: **the seeded role grants do not
match what the routes require.** Operations can create, edit and delete an assayer but cannot open
one (AC-F26); a desk operator's own landing page never loads because its route wants a permission
the seeded role does not hold (AC-F16). Those are the same defect wearing two faces, and between
them two of the four staff roles cannot do their jobs on a fresh install.

The rest of what stops it is literally the front door. Signing in from the site root — the normal way anyone
opens the app — leaves a blank screen with no error and no spinner (AC-F14). Signing out hands the
next person the previous user's page (AC-F15). And a DESK_OPERATOR's own landing page never
finishes loading: three of its four tiles sit on an ellipsis for ever because the route wants a
permission that role does not hold (AC-F16). A desk operator cannot use the system today. That is
not a risk to accept, it is a morning's work to fix, and calling it accepted because the campaign
ran out of days would be the wrong kind of report.

Two more belong on that list, in the product rather than the interface. A client's rejection of an
assayer can be reversed in a single unguarded call, with no reason and no second approver (AC-F09);
the assignment-time hard block still refuses the work, so nothing unsafe reaches the field, but the
standing should not be one PUT away from ACTIVE. And the one that would worry me most in
production: **every scheduled job can stop for ever and nothing reports it** (AC-F20). It happened
on this deployment — nine minutes with no cron at all, while health said `ok`, the worker stayed
healthy, ordinary jobs kept succeeding and nothing was logged. The outbox is what turns completed
work into payables, so the failure mode is money quietly not being booked. A restart fixes it; the
problem is that nobody would know to restart. AC-F21 compounds it: the only screen that would show
the backlog is DEVELOPER-only, and this deployment has no DEVELOPER accounts.

Six further defects in deployment mechanics were found, reported, fixed by the session that owns
those files, and **re-verified here from destroyed volumes** — torn down, rebuilt, and the whole
path run again from nothing, first attempt, no manual steps. Those are closed.

Fix AC-F14, AC-F15, AC-F16 and AC-F26 (the last two being one grant problem), AC-F09 and AC-F20 — the last of which may be no more than
re-converging the schedules periodically instead of once at boot, plus an alert on a non-empty
delayed queue — then re-run the four probe scripts and the browser pass. That is what stands
between this and READY. Nothing else on the list needs to block it.

What this rests on: a purpose-built production-shaped stack (caddy, ClamAV, Postgres, Redis,
MinIO, and a separate API and worker) brought up from empty volumes on this machine, migrated,
hardened and seeded, then driven over HTTP as five real user accounts with the database inspected
after every mutation. No deployed system was touched. Nothing here is a statement about live
production data.

---

## Core business evidence

| Business capability | Result | Evidence |
|---|---|---|
| HR / lifecycle | **PASS with findings** | `assayer-lifecycle-certification.db.spec.ts` 150/150 against the running system: all 98 illegal transitions refused with no mutation and no audit event; reason enforcement; departure effects; rehire routes RESIGNED and TERMINATED back to INVITED. Plus 32/32 on the paths that suite does not cover — the bulk walker refuses to launder a rehire (`RESIGNED → ACTIVE` is skipped, "No valid path"), the reason gate is genuinely per-hop, `reset-onboarding-stage` rewinds only, and `DELETE /assayers/:id` needs ADMIN and a reason. AC-F10 and AC-F11 came out of this |
| Operations / deployment | **PASS with a finding** | Eligibility, distance ceiling, project window and double-booking each refused a real attempt with an actionable message; override requires a stated reason and records it against the actor. The **conflict-of-interest rule is correctly unwaivable** — an appraiser 1.6 km from a branch is refused with `RULE_NOT_OVERRIDABLE` and told, in the message, that it is not an operator's to waive. A REJECTED empanelment is a hard block that ADMIN cannot lift even with a written reason. But AC-F09: that same REJECTED standing can be flipped to ACTIVE in one unguarded call first |
| Assignment | **PASS** | E2E-01…E2E-14; state machine, ownership, versioning; completed work cannot be cancelled; a second completion is not a second business event |
| Field execution | **PASS** (API path) | Accept, check-in with GPS, and completion; `checked_in_at` stamped; an assayer cannot complete their own job (403) or price it (`fee: 99999` ignored). Mobile app itself not exercised — see *not tested* |
| Financial | **PASS** | Money recomputed independently and matching: 2500 − TDS 250 = 2250; client GST 2500 × 18% = 450; client TDS on the base, never the GST; line total 2700. Segregation of duties refuses booker-approves and approver-pays, by name. Duplicate payment reference yields one payment |
| Audit / history | **PASS** | Every mutation carries an actor; refusals recorded as `SEGREGATION_OF_DUTIES_REFUSED` with `outcome: DENIED`, never success-shaped. **The audit trail is now tamper-proof against the application's own credential** — 7 destructive vectors refused as `fapoms_runtime` (including `DISABLE TRIGGER`, which fails with *"must be owner"*) while append still works, and `verify:runtime-role` refuses 87/87 including escalation, `DROP TRIGGER`, replacing the trigger function, and abusing the SECURITY DEFINER partition helper. This closes the open finding in `docs/incident-2026-09-09-audit-truncate.md` |
| Authorization | **PASS** | DESK_OPERATOR refused on six privileged writes over direct HTTP with a before/after database comparison showing nothing changed; assayer horizontal isolation on work, acceptance and bank details |
| UI / usability | **PASS with findings** | Driven in a real browser as three roles. Per-role landing correct, every core screen renders real data cross-checked against SQL, refresh discipline holds (transition → navigate away → hard reload → return → server truth), authorization redirects are honest, and 375px is clean — no horizontal body scroll, wide content scrolls inside its own containers, sidebar goes off-canvas with a bottom nav. **No mismatched numbers anywhere**: 8 assayers, ₹5,400 unbilled and 10 branches each agree across three screens and the database. Four defects found — AC-F14 to AC-F17 |
| Management figures | **PASS** | Every headline number on the finance overview recomputed from base tables with independent SQL and matching to the rupee |
| Reliability | **PASS with a serious finding** | 25/25: a duplicated booking event is absorbed and still yields one payable and one client line; stopping the worker proves it is what drains the outbox (not dispatched for 135 s, dispatched 24 s after restart); a refused approval unwinds completely — even the banking snapshot a pessimistic lock had begun — leaving one `DENIED` row and no `SUCCESS`; six simultaneous completions produce one audit row, one version bump, one payable. But AC-F20: every cron schedule can stop for ever, silently |

---

## Findings

Full detail, with reproductions, in the campaign findings ledger. Severity per §20.

All six deployment findings were reported to the session that owns those files, fixed by it during
this campaign, and then **re-verified here from destroyed volumes** — the rig was torn down with
`down -v`, rebuilt, and the documented path run again from nothing.

| ID | Severity | Business impact | Status |
|---|---|---|---|
| AC-F01 | **BLOCKER** | A fresh deployment could not migrate: `permission denied for schema public`. The compose's postgres pre-creates the database owned by the superuser, so provisioning took its "already exists" branch and left the migrator without CREATE. The grant that would have fixed it ran one step too late, in `harden` | **FIXED AND VERIFIED** — provisioning now reports *"Database fapoms exists, owned by fapoms; ownership moved to fapoms_migrator"* |
| AC-F02 | **BLOCKER** | Behind AC-F01: bootstrap installed three extensions but the migrations need `pg_trgm` and `btree_gist` too | **FIXED AND VERIFIED** — `REQUIRED_EXTENSIONS` now lists all four and the log confirms them |
| AC-F03 | **HIGH** | Behind AC-F02: hardening aborted on `tiger`/`tiger_data`/`topology`, whose tables the postgis image leaves owned by the superuser — a half-finished deploy, schema current and grants missing | **FIXED AND VERIFIED** — hardening completes and all ten runtime assertions pass |
| AC-F04 | MEDIUM | `setup.sh` never generated the three credentials the deploy path requires, still wrote `DB_MIGRATIONS_RUN=true`, and never repaired an existing `.env.docker` | **FIXED** — it now mints all three, adds them to an existing env file, sets `DB_MIGRATIONS_RUN=false` and warns if it finds `true` |
| AC-F05 | LOW | `clamav/clamav:1.4` publishes no arm64 image at any tag; `compose up` dies at image pull on an arm64 host | **ACCEPTED, DOCUMENTED** — the compose now carries a note naming the constraint. Unaffected on x86; on arm64 it runs under emulation |
| AC-F06 | HIGH | caddy crash-looped on a fresh host over a bind-mounted file nothing created — seven healthy containers and an app answering nothing | **FIXED AND VERIFIED** — caddy comes up and serves; the installer creates the snippet |
| AC-F07 | HIGH | The documented seed could not run on a hardened deployment: `seed.js --if-empty` issued an unconditional `TRUNCATE`, which the runtime role correctly refuses | **FIXED AND VERIFIED** — the documented command now completes as the runtime user |
| AC-F08 | LOW | The distance-ceiling override accepts a 9-character justification where the eligibility override demands 10. The decision is still audited and attributable | Open |
| AC-F09 | **HIGH** | **A client's rejection can be reversed in one unguarded call.** `PUT /assayers/:id/empanelment/:clientId` is a free-form upsert with no state machine: `REJECTED → ACTIVE` in a single request returns 200 and the standing is ACTIVE. No reason is required, no second approver, and any holder of `assayer:edit:organization` can do it. Mitigated only after the fact by the `EMPANELMENT_SET` audit row, which does record the previous value and the actor | Open |
| AC-F10 | MEDIUM | **A bulk lifecycle move can half-succeed and report only the failure.** `INVITED → INACTIVE` routes through DOCUMENT_VERIFICATION; the first hop needs no reason and commits, the second is refused for want of one. The person ends at DOCUMENT_VERIFICATION when INACTIVE was asked for, one audit row is written, and the response lists the id under `failed` only — it never mentions the hop that landed. A roster batch can silently advance people the operator believes were refused | Open |
| AC-F11 | MEDIUM | **The assayer-delete cascade cancels assignments with no per-assignment trail.** Archiving a person raw-`UPDATE`s their open assignments to CANCELLED and bumps `entity_version`, but writes **zero** audit rows against those assignments; only the aggregate `ASSAYER_DELETED` row on the assayer exists, and it names neither the assignments nor how many. "Why was my job cancelled?" is answerable only by already knowing to look at the assayer's deletion | Open |
| AC-F12 | LOW | `STRICTLY_NON_OVERRIDABLE_STANDINGS` names `EXPIRED` and `SUSPENDED`, which are not members of `EmpanelmentStatus` and are forbidden by `chk_empanelment_status` — two of the four "strictly non-overridable" standings are unreachable strings. No protection is lost (the reachable ones are covered) but the list overstates what it guards | Open |
| AC-F13 | LOW (test quality, not product) | `billing-overview-region-scope.db.spec.ts` asserts absolute amounts for a region it declares empty (`EMPTY = Region.SOUTH`) and fails the moment anything else books money there. This campaign's own run did exactly that — one paid payable on a SOUTH branch, `paid: 2250` where the suite expects `0`. The weakness is already recorded at `14a11e53`; this is it happening. The suite preflights its two owned regions (CENTRAL, NORTH_EAST) but not the one it calls empty | Open — suite should claim SOUTH too, or assert deltas |
| AC-F14 | **HIGH** | **Signing in from the site root leaves a blank app.** Open `http://<host>/` signed out — the normal way anyone opens it — and after login the URL stays at `/` with header and sidebar rendered and the content area empty: no spinner, no error, no retry. Deterministic. Arriving unauthenticated at `/` stores `fapoms_return_to = "/"`, and `PostLoginRedirect` then renders `<Navigate to="/">`, a no-op that never reaches `defaultRouteFor` | Open |
| AC-F15 | **HIGH** | **Sign-out hands the next person the previous user's page.** Signing out writes the current path into `fapoms_return_to` (measured: `null` while signed in, `"/dashboard"` immediately after clicking Sign Out), so the next sign-in lands there instead of that role's home. Observed: `executive` landed on the validator's `/dashboard`. Clearing `sessionStorage` restores correct behaviour, so `defaultRouteFor` is right and the stale return-to is the defect. Same mechanism as AC-F14 | Open |
| AC-F16 | **HIGH** | **The desk operator's own home page never loads.** `/data-entry` is DESK_OPERATOR's landing route, and three of its four tiles show a literal "…" that never resolves — no error, no retry, a silent permanent loader. `GET /documents/data-entry/mine` returns 403 every time: the route requires both the role and `document:view:organization`, and the seeded DESK_OPERATOR role holds only `DOCUMENT:DOWNLOAD:PLATFORM`. The role passes the role check and fails the permission check | Open |
| AC-F17 | MEDIUM | **The navigation offers a page the API refuses.** `/documents` is listed for DESK_OPERATOR in `route-permissions.ts`, so the sidebar renders the link, but `GET /documents/operations/overview` answers 403 and the page shows a permission error with a Retry button that will fail identically forever. The message is honest; the link should not be there | Open |
| AC-F18 | MEDIUM | **A role-scoped dashboard states a global fact that is false.** As DESK_OPERATOR the dashboard reads *"Nothing blocked. No audits at risk, no paperwork waiting, nothing unbilled."* while ₹5,400 was unbilled and the admin dashboard said so. The scoped view is defensible; the sentence is not | Open |
| AC-F19 | LOW | Every Google Fonts file violates the `font-src 'self' data:` CSP. The policy is report-only so fonts load today, but switching CSP to enforce breaks the app's webfonts | Open |
| AC-F20 | **HIGH** | **FIXED AND VERIFIED.** A reconciler now re-converges the schedules on a plain `setInterval` (`SCHEDULE_RECONCILE_MS`, default 300 s), deliberately not a Bull repeatable. Proven on a real queue at the shipped default, nothing mocked: repeat key deleted → the seeded row stayed undispatched for 120 s across two full one-minute ticks (so the schedule was genuinely dead, not merely keyless) → key restored at 07:41:50 → **the row actually dispatched at 07:42:00**. Recovery is real end to end, not just re-registration. Originally: **every scheduled job could stop for ever, and nothing noticed.** Observed on this healthy deployment: all seven cron schedules registered at 06:42, audit-seal fired once, then **nothing for nine minutes** — while the worker stayed `healthy`, `/health` said `ok`, ordinary Bull jobs kept succeeding, and no error was logged. Measured consequences: a due outbox row undispatched for 181 s across three tick boundaries, and 134 audit events left unsealed (`audit_events` 154 vs `audit_chain` 20). Redis held zero `bull:*:repeat` keys for all seven queues. Proven in isolation on a throwaway queue: delete the repeat key and the schedule fires 0 more times, keys are never recreated, 0 errors emitted. `repeatable-schedules.ts` converges once at `onModuleInit` and never re-verifies; Bull only schedules the next firing if the repeat ZSET member still exists, and a miss returns silently. Only a process restart recovers it — which restored all seven and let the seal catch up to 155/155. **Because the outbox books payables, completed work can silently stop turning into money** | Open |
| AC-F21 | MEDIUM | **Nobody on this deployment can see the backlog.** `GET /admin/outbox/health` and the dead-letter queue are `@Roles(DEVELOPER)`, and the deployment has **zero active DEVELOPER accounts**. The Prometheus gauge `queue_depth{queue="outbox",state="delayed"}` is exported, but a dead cron is indistinguishable from an idle queue without an alert on "delayed ≥ 1", and no such alert exists. AC-F20 was therefore invisible from every surface an operator has | Open |
| AC-F22 | MEDIUM | **FIXED AND VERIFIED.** Originally an event nobody handled was stamped `dispatched_at` — a renamed subscriber discarded events silently for ever. A first fix was **inert** (the handler count included the realtime gateway's catch-all, so zero was unreachable) and this campaign caught that live. The landed fix scopes the rule: `publishAsync` returns `{named, global}`, and delivery is refused only for the eight events in `EVENTS_REQUIRING_A_NAMED_SUBSCRIBER` where a missing handler means a business effect silently not happening. Verified three ways here — **the guard fires** (a required event with no named subscriber was refused, retried, `attempts` 1→6, `last_error: no subscriber is registered for …`, proven by temporarily adding a name to the set and restoring the file byte-for-byte against its sha256); **it does not false-positive** (all eight required names probed live in the worker, every one delivered, so each has a named subscriber there); and **the money path is untouched** (completion still books exactly one payable). The nineteen broadcast-only names — `billing:booked` among them — are correctly left alone, which the obvious "count named listeners" fix would have dead-lettered on every tick | Closed |
| AC-F23 | LOW | Dead-lettering could not be exercised from outside the process: no reachable subscriber throws on a malformed payload, so `attempts` climbing to `failed_at` remains unverified on a live deployment (it is covered by unit tests and by the previous record's replay evidence) | Open |
| AC-F24 | LOW | Provisioning **asserts** rather than verifies the role passwords — `ALTER ROLE … PASSWORD <supplied>` runs every time — so a mistyped `FAPOMS_MIGRATION_PASSWORD` succeeds and silently rotates the deploy credential. Verified: after passing a deliberately wrong value, `fapoms_migrator` accepted it and refused the real one. Documented as intentional in `role-model.ts`; worth a warning when the role already exists | Open (by design) |
| AC-F25 | LOW | **FIXED AND VERIFIED.** The identity assertions now run on their own connection before `NestFactory.create`, so they are the first thing to touch the database. Re-verified against a freshly built `bootstrap migrate`-only database: *"FATAL: the database this application is connecting to has not been hardened … Run `npm run db:harden` against it"*, and not one word about `geo_states`. Originally the boot failed closed but blamed a geo table, because `GeoSeedService.onModuleInit` ran before `StartupChecksService.onApplicationBootstrap` | Closed |
| AC-F26 | **HIGH** | **Operations can create, edit and delete an assayer but cannot open one.** `GET /assayers/:id` declares `@Roles(ADMIN, OPERATIONS, AUDITOR, DESK, DESK_OPERATOR)` and `@RequirePermissions('assayer:view:organization')`. On a **freshly seeded** database the materialised grants are: ADMIN → CREATE/DELETE/EDIT/VIEW, AUDITOR → VIEW, **OPERATIONS → CREATE/DELETE/EDIT and no VIEW**, **DESK_OPERATOR → nothing at all**. `ROLE_PERMISSIONS:144` declares `ASSAYER:VIEW:ORGANIZATION` for OPERATIONS and the permission row exists, so the declaration is not reaching `role_permissions`. Live proof: `manager` and `executive` (both OPERATIONS) receive `403 Insufficient permissions` on their own organisation's assayer, and their JWTs carry `ASSAYER:CREATE/DELETE/EDIT` with no `ASSAYER:VIEW`. This is precisely the inversion `role-permissions.ts:23` warns about — "delete an assayer without holding ASSAYER:VIEW" — and Operations is the role that deploys people to work. **Mechanism:** the seed resolves each declared key with `rd.permissionKeys.map(key => permissionMap.get(key)).filter(Boolean)`, and `permissionMap` is populated only while walking the seed's own `defaultPermissions` list — which defines no ASSAYER permissions at all. Any declared key the seed cannot resolve is dropped without a word. Two lists that must agree, and a silent filter hiding every disagreement — the same shape the extension list had, which was fixed by deriving one from the other and failing the build on drift | Open |
| AC-F27 | MEDIUM | **A fresh seed leaves rows with no organisation.** On this rig, immediately after seeding: 10 branches and 1 project have `organization_id IS NULL` (assayers, clients and users are attributed). The `BackfillTenantOwnership` migration runs before the seed creates the organisation, so it attributes nothing, and the seed sets `organizationId` for users, clients and assayers but not for branches or projects. Harmless while the deployment is single-organisation — but the product's own certification suite asserts "no assayer, client, project, branch or user is unowned", and that invariant is violated on day one | Open |

### The clean-install run

From destroyed volumes, with no manual intervention at any point:

```
══ roles, database, extensions ══
Database fapoms exists, owned by fapoms; ownership moved to fapoms_migrator.
Extensions checked: uuid-ossp, postgis, pg_trgm, btree_gist.
══ migrations, as the deploy role ══
Applied 79 migration(s).
══ hardening, verified from the runtime side ══
✓ fapoms_runtime is least-privileged and cannot reach the audit structures.
```

then the documented seed, then **27/27** on the business loop and **20/20** on authorization and
the audit defences. That is the evidence the verdict rests on.

**Carried forward, unchanged, from the previous record** (not re-opened by this campaign):
audit rows have no idempotency key or schema version; outbox retries are fixed-interval with a
~15-minute window to dead-letter; empanelment has value guards but no transition state machine;
`DELETE /assayers/:id` reaches ARCHIVED from any state by design; logout revokes the refresh token
while access tokens live to expiry; no EXIF stripping; no off-site backups; `restore.sh` hardcodes
podman and homeserver paths; the orphaned-endpoint list in `integration-audit-handoff.md` §4.

---

## Evidence summary

| Suite / probe | Result |
|---|---|
| Backend unit | 306 suites, **4341 tests**, all pass |
| Shared | 10 suites, **413 tests**, all pass |
| Frontend | 82 suites, **1012 tests**, all pass |
| Lint | backend and frontend both 0 errors |
| Backend `.db.spec.ts`, self-contained | 6 suites, **92 tests**, all pass against the rig. On a later re-run 241/242 — the one failure is AC-F13, this campaign's own fixture money landing in the region that suite calls empty |
| `assayer-lifecycle-certification.db.spec.ts` | **150/150** — first time run in this working copy |
| Core business loop (E2E + SoD + money) | **25/25** |
| Authorization, isolation, audit defences | **20/20** |
| Lifecycle bypass, bulk and empanelment probes | **32/32** (`scripts/acceptance/lifecycle-bypass.mjs`) |
| `npm run verify:migrations` | 79 migrations, 94 tables, second run a no-op, all named constraints present |
| Runtime-role assertions at boot | 10/10 |
| `npm run verify:runtime-role`, disposable database | **87/87** across two provisioning shapes |
| Typecheck | backend, frontend, mobile — all clean |
| Adversarial guard checks | 3/3 — each control removed in source, its test observed going red, the file restored and checksum-verified |
| Browser pass | 3 roles, 8 screens, refresh discipline, 375px responsive — 4 defects found |
| Reliability, outbox and worker probes | **25/25** (`scripts/acceptance/reliability.mjs`) |
| Malware scanning | EICAR refused (400, `Rejected infected upload: Eicar-Test-Signature`); a clean PDF accepted (201) |
| Deployment path, from empty volumes | Exercised; failed three times before succeeding (AC-F01/02/03) |

The last two are checked in as `scripts/acceptance/business-loop.mjs` and
`scripts/acceptance/authorization-and-audit.mjs`, with a README covering how to run them and the
two environment traps that will otherwise waste an afternoon. Both are idempotent — the business
loop cancels its own leftovers through the product rather than deleting them, and every
destructive audit probe runs inside a transaction that is always rolled back.

---

## The deployment's own refusals, observed

Everything proven about the role split until now was the success path. These are the controls that
catch somebody skipping a step, watched doing their job — or not.

**The provisioning gate holds.** With `DB_ADMIN_URL` empty, `docker compose up -d backend` runs
`db-migrate` first, it exits 1 saying *"DB_ADMIN_URL is not set. This step writes real credentials
and schema; it will not guess one"*, and compose stops there: `service "db-migrate" didn't complete
successfully: exit 1`. The API is never started, **the already-running container is not replaced
(same container id before and after), and it keeps answering `/health` throughout**. Absent
`FAPOMS_MIGRATION_PASSWORD` behaves identically.

**A "wrong" migration password is not a state that can exist.** Passing a deliberately wrong one
succeeds, exit 0 — and afterwards `fapoms_migrator` accepts the wrong password and refuses the
real one. `role-model.ts:105` runs `ALTER ROLE fapoms_migrator … PASSWORD <supplied>` on every
run: the variable *declares* what the password should be rather than proving what it is, and the
file's own comment says rotation is meant to happen exactly this way. That is a defensible design,
but it means a mistyped value silently rotates the deploy credential with no signal, and anything
else holding the old one breaks later, far from the cause (AC-F24).

**Both `main.ts` production refusals fire, and explain themselves.**

| configuration | result |
|---|---|
| `DB_USERNAME=fapoms_runtime` with `DB_MIGRATIONS_RUN=true` | exit 1 — *"DB_MIGRATIONS_RUN must be \"false\" when the API connects as fapoms_runtime … a runtime identity with schema privileges can remove the audit triggers"* |
| `DB_USERNAME=fapoms_migrator` | exit 1 — *"The API must not connect as fapoms_migrator. That credential exists for migrations and for `npm run db:harden` … set DB_USERNAME to fapoms_runtime"* |

**Strict startup checks against an unhardened database: fails closed, but never speaks.** A
database provisioned with `bootstrap migrate` and no `harden` refuses the boot with
`STARTUP_CHECKS_STRICT=true` — exit 1, nothing serves. But the message is
`permission denied for table geo_states`, not anything about hardening. `GeoSeedService`'s
`onModuleInit` queries that table, and NestJS runs every `onModuleInit` **before**
`onApplicationBootstrap`, where `StartupChecksService` lives — so the check written to catch a
skipped hardening step is pre-empted by an ordinary query failing on the grants that step would
have made. The safety property holds; the diagnosis does not (AC-F25).

## The transition onto an existing deployment

The role split's adoption path was exercised on a **populated pre-split database built
independently** — created owned by the old `fapoms` superuser, migrated the old way through
`npm run migration:run` rather than through provisioning, seeded, and given an audit row written
before the transition so there was a witness to lose.

| | before | after |
|---|---|---|
| users / branches / assayers | 5 / 10 / 8 | 5 / 10 / 8 |
| audit rows | 1 | 1, and the witness still reads *"written as the old superuser, before the role split"* |
| database owner | `fapoms` | `fapoms_migrator` |
| `audit_events` owner | `fapoms` | `fapoms_audit_owner` (cannot log in) |
| `users` owner | `fapoms` | `fapoms_migrator` |

Afterwards, as `fapoms_runtime` on that same transitioned database: `UPDATE audit_events` and
`DELETE FROM audit_events` refused for want of privilege, `ALTER TABLE … DISABLE TRIGGER` refused
with *"must be owner"*, ordinary reads working, and append still allowed. No row was touched by
the transition.

## An unplanned crash, which answered the question better than a probe would have

The rig's PostgreSQL crashed under concurrent load near the end of the campaign — not a probe, an
accident. The container never restarted; the postmaster did:

```
LOG: database system was not properly shut down; automatic recovery in progress
LOG: redo starts at 0/7099960 … redo done
LOG: database system is ready to accept connections
```

`/health/ready` went `degraded / database down` and came back `ok` on its own. Afterwards every
business count was intact — 5 users, 8 assayers, 5 assignments, 5 payables, 48 outbox rows — and
the hash chain had caught up completely: **348 audit events, 348 chain rows, no gap**. All seven
Bull repeat keys survived, and had they not, the reconciler proven above would have restored them.
Nobody planned this and it is the strongest single piece of evidence in the report that the system
degrades predictably rather than corrupting anything.

## The management figures reconcile

Every headline number on `GET /billing-engine/overview` was recomputed from the base tables with
independent SQL and compared. They agree to the rupee:

| figure | independent SQL | the API |
|---|---|---|
| unbilled | 5,400.00 | 5,400 |
| revenue, ex-GST | 5,000.00 | 5,000 |
| GST collected | 900.00 | 900 |
| TDS withheld by clients | 500.00 | 500 |
| paid out | 2,250.00 | 2,250 |
| payables booked | 4,500.00 | 2,250 approved + 2,250 paid |

The overview also volunteers what it is unsure about rather than presenting a clean total: both
payables appear under `attention` as `UNSETTLED_FEE` — *"Booked from the proposed fee — no fee was
ever agreed."* That is exactly right for how these were created, and it is the difference between
a dashboard that reports and one that explains.

## Where this work sits

Everything is committed on `test` and **deliberately not pushed**. `origin/test` is 17 commits
behind, and those commits include another session's deployment overhaul as well as this
campaign's evidence. Pushing that branch triggers CI and the AWS box's auto-deploy, and that box
has an unresolved data-loss incident from 5 September; sequencing a deployment-path change onto it
is a decision for whoever owns that box, not a side effect of finishing an acceptance run. The
tree is green at every commit, so pushing is a decision and not a repair.

## What was not tested, and why

- **The browser pass covered three roles and one mutation, not all of either.** ADMIN, OPERATIONS
  and DESK_OPERATOR were driven across eight screens; AUDITOR and DEVELOPER were not. The mutation
  exercised under refresh discipline was a lifecycle transition — the money screens were read and
  reconciled, but no payout was approved from the browser. The mobile drawer was confirmed
  off-canvas from its computed CSS rather than watched sliding open. Tablet width (768px) was not
  checked.
- **The mobile app.** Assayer accept and check-in were exercised over the API, which is the same
  path the app calls, but no Expo build was run. Field execution is proven at the contract, not
  in the client.
- **Tenant isolation** (`assayer-tenant-isolation.db.spec.ts`). Deliberately skipped: FAPOMS is a
  single-organisation product and the brief explicitly excludes tenant-versus-tenant testing.
  Standing up a second organisation to satisfy it would have been building an artificial
  requirement. The suite remains available for anyone who wants it.
- **Dead-lettering could not be driven from outside the process.** No reachable subscriber throws
  on a malformed payload, so `attempts` climbing to `failed_at` was not observed live (AC-F23); it
  remains covered by unit tests and by the previous record's replay evidence. Worker kill-and-
  recover, duplicate redelivery and concurrent completion *were* exercised here and passed.
- **Deployed environments.** The homeserver was not reachable and the AWS box was deliberately
  left alone; both are excluded by the evidence-environment decision. Real TLS, real S3
  server-side encryption, FCM delivery and off-site backups are all outside this rig.
- **My own authorization sweep asserted refusals without asserting their reason**, which is how it
  passed a system where OPERATIONS and DESK_OPERATOR cannot read an assayer at all. Every
  `AZ-01..AZ-06` case expected 403 for a DESK_OPERATOR and got it — but for the wrong reason, and
  the sweep could not tell. AC-F26 was found later, by a suite that expected a **200**. The lesson
  is the one this campaign applied to SOD-01 and not here: a refusal is only evidence when the
  refusal names the rule under test.
- **Rate limiting was raised** on the acceptance rig so the certification suites could run. The
  default (300 requests/minute per IP) was observed working — it refused the suite with 429 before
  it was raised — but the production value was not otherwise exercised.

## What is intentionally deferred

The eight findings above are the campaign's own; the carried-forward list is unchanged from the
previous record and none of it was re-litigated. AC-F01 through AC-F03 must close before a new
installation is attempted. AC-F04, AC-F06 and AC-F07 should close in the same pass, because each
of them independently stops a fresh install from reaching a usable state. AC-F05 and AC-F08 are
genuinely low-risk and can wait.

The single most valuable thing the next session can do is close AC-F14, AC-F15 and AC-F16. None
of them corrupts anything, and all three are the first thing a real user meets: a blank screen on
the way in, the wrong landing page after a shift change, and a desk operator whose own home page
never finishes loading.
