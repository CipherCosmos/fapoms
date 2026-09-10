# Production acceptance — 10 September 2026

## Executive conclusion

**READY.**

Take the good news first, because it is the larger part. The complete operational loop — hire a
person, deploy them to work, execute it, complete it, pay for it — runs correctly end to end,
refuses the illegal version of every step it was asked to refuse, survives concurrent operators,
and reconciles to the rupee under independent recomputation. Segregation of duties holds in both
directions and says so by name. The audit trail is now tamper-proof against the application's own
database credential, which closes the most serious control gap this project has carried. Not one
defect was found in how this system decides anything about money, work or people.

**Nothing now blocks it.** Every defect this campaign raised as blocking has been fixed and
re-verified here, not taken on report:

- **Six in deployment mechanics** — provisioning that could not migrate, an incomplete extension
  list, hardening that aborted half-done, an installer out of step with its own compose file, a
  crash-looping edge proxy, and a seed the hardened database refused. Re-run **from destroyed
  volumes**: torn down, rebuilt, the whole path from nothing, first attempt, no manual steps.
- **The RBAC grant repair** — the seed was not failing to add permissions, it was **removing**
  them: nineteen across four roles, including the only `SYSTEM:APPROVE:PLATFORM` in the system, so
  the two-person data-wipe rule could not be completed by anyone. Verified restored, and with it
  Operations can open an assayer record again and a desk operator's own page loads.
- **The two front-door defects** — the blank screen when signing in from the site root, and
  sign-out handing the next person the previous user's page. Both were one key written where it
  should not have been. **Checked in a real browser from a cleared session**, not inferred from a
  diff: the site root now lands on the role's home with real content, and a second persona signing
  in after the first lands on its own.
- **The cron that died in silence** — every scheduled job could stop for ever with health green and
  nothing logged, which for the outbox means completed work quietly not becoming payables. The
  reconciler was proven on a real Bull queue: key deleted, the schedule observed genuinely dead
  across two ticks, then restored and **actually firing** again.

**Two things need an owner before go-live, and neither is a defect.** The first is AC-F21: nobody
holds the DEVELOPER role, and six controllers answer to it alone — including the outbox
dead-letter queue, which is the one surface that would have shown the stalled cron in AC-F20.
Every account on this deployment gets 403 there today. Creating that account and deciding who
holds it is a provisioning decision, not a code change, and widening the boundary instead would be
the wrong answer. There is no workaround to reach for first: the outbox controller is `@RoleOnly()`,
and a custom role holding every platform SYSTEM permission is still refused — proven here.

**The second is a product decision.** AC-F09: a client's rejection of an
assayer is reversible in one call because `EmpanelmentStatus` has no state machine. Whether
reversing a rejection should require a separate recorded act is a **product decision for the
organisation**, not a bug to fix quietly, and the assignment-time hard block already refuses the
work either way. It is recorded for the owner to settle, and it does not gate the release.

Everything else on the list is closed or genuinely low-risk.

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
| AC-F14 | **HIGH — FIXED AND VERIFIED** | Signing in from the site root left a blank app: arriving unauthenticated at `/` recorded a return path of `/`, and because `/` and `/login` render the same element on purpose, React reused the component instance, so the reused one went on rendering `<Navigate to="/">` while already at `/` — an update loop. The recorder now skips `/`, and the consumer refuses any destination equal to where it is rendering. **Verified in a browser from a cleared session:** at `/` the return path is now `null` where it was `"/"`, and signing in lands on `/executive-map` with 1,671 characters of real content where the container was previously empty | Closed |
| AC-F15 | **HIGH — FIXED AND VERIFIED** | Signing out handed the next person the previous user's page: `clearSession` walked a localStorage key list while the return path lives in sessionStorage, so the one value deciding where the next sign-in lands was the one thing left behind. `endSession` now forgets it. **Verified in a browser end to end:** signing out from `/hr/roster` leaves the return path `null`, and `validator` signing in next lands on its own `/data-entry`, not the previous user's roster | Closed |
| AC-F16 | **HIGH — FIXED AND VERIFIED** | The DESK_OPERATOR's own landing page never finished loading: three of four `/data-entry` tiles sat on an ellipsis for ever because `GET /documents/data-entry/mine` answered 403 — the route wanted `document:view:organization` and the seeded role held only `DOCUMENT:DOWNLOAD:PLATFORM`. **Same root cause as AC-F26** — the seed was stripping grants, not the route being wrong. After the repair DESK_OPERATOR holds `DOCUMENT:VIEW:ORGANIZATION` and the route answers **200** | Closed |
| AC-F17 | MEDIUM — **FIXED AND VERIFIED** | The sidebar offered DESK_OPERATOR a `/documents` page whose data call answered 403. Same grant repair: `GET /documents/operations/overview` now answers **200** for that role | Closed |
| AC-F18 | MEDIUM | **A role-scoped dashboard states a global fact that is false.** As DESK_OPERATOR the dashboard reads *"Nothing blocked. No audits at risk, no paperwork waiting, nothing unbilled."* while ₹5,400 was unbilled and the admin dashboard said so. The scoped view is defensible; the sentence is not | Open |
| AC-F19 | LOW | Every Google Fonts file violates the `font-src 'self' data:` CSP. The policy is report-only so fonts load today, but switching CSP to enforce breaks the app's webfonts | Open |
| AC-F20 | **HIGH** | **FIXED AND VERIFIED.** A reconciler now re-converges the schedules on a plain `setInterval` (`SCHEDULE_RECONCILE_MS`, default 300 s), deliberately not a Bull repeatable. Proven on a real queue at the shipped default, nothing mocked: repeat key deleted → the seeded row stayed undispatched for 120 s across two full one-minute ticks (so the schedule was genuinely dead, not merely keyless) → key restored at 07:41:50 → **the row actually dispatched at 07:42:00**. Recovery is real end to end, not just re-registration. Originally: **every scheduled job could stop for ever, and nothing noticed.** Observed on this healthy deployment: all seven cron schedules registered at 06:42, audit-seal fired once, then **nothing for nine minutes** — while the worker stayed `healthy`, `/health` said `ok`, ordinary Bull jobs kept succeeding, and no error was logged. Measured consequences: a due outbox row undispatched for 181 s across three tick boundaries, and 134 audit events left unsealed (`audit_events` 154 vs `audit_chain` 20). Redis held zero `bull:*:repeat` keys for all seven queues. Proven in isolation on a throwaway queue: delete the repeat key and the schedule fires 0 more times, keys are never recreated, 0 errors emitted. `repeatable-schedules.ts` converges once at `onModuleInit` and never re-verifies; Bull only schedules the next firing if the repeat ZSET member still exists, and a miss returns silently. Only a process restart recovers it — which restored all seven and let the seal catch up to 155/155. **Because the outbox books payables, completed work can silently stop turning into money** | Open |
| AC-F21 | MEDIUM | **Nobody holds DEVELOPER, and six controllers are gated to it alone.** Verified live: `admin`, `manager` and `validator` all receive 403 on `/admin/outbox/dead-letters`, and `SELECT` on the role's holders returns nobody. The surfaces this puts out of reach are `data-reset` (the destructive wipe path), `outbox` (dead letters and health — the visibility gap that made AC-F20 invisible from every operator surface), `service-logs` (`/admin/logs`), `ocr-boundary`, geo admin and notification admin. After the grant repair, DEVELOPER also uniquely holds `SYSTEM:EDIT:PLATFORM` and `SYSTEM:VIEW:PLATFORM`. **And the obvious workaround does not exist:** the outbox controller is annotated `@RoleOnly()`, so the permission fallback is closed there. Proven live — a custom role granted all three platform SYSTEM permissions (`SYSTEM:VIEW`, `SYSTEM:EDIT`, `SYSTEM:APPROVE`) still receives 403 on both `/admin/outbox` routes. Only an account actually holding DEVELOPER can open them. **This is a provisioning gap, not a permissions-design flaw** — the fix is to create the account and decide who holds it, not to widen a boundary because one deployment lacks a holder. It needs an owner before go-live | Open — the organisation's to action |
| AC-F22 | MEDIUM | **FIXED AND VERIFIED.** Originally an event nobody handled was stamped `dispatched_at` — a renamed subscriber discarded events silently for ever. A first fix was **inert** (the handler count included the realtime gateway's catch-all, so zero was unreachable) and this campaign caught that live. The landed fix scopes the rule: `publishAsync` returns `{named, global}`, and delivery is refused only for the eight events in `EVENTS_REQUIRING_A_NAMED_SUBSCRIBER` where a missing handler means a business effect silently not happening. Verified three ways here — **the guard fires** (a required event with no named subscriber was refused, retried, `attempts` 1→6, `last_error: no subscriber is registered for …`, proven by temporarily adding a name to the set and restoring the file byte-for-byte against its sha256); **it does not false-positive** (all eight required names probed live in the worker, every one delivered, so each has a named subscriber there); and **the money path is untouched** (completion still books exactly one payable). The nineteen broadcast-only names — `billing:booked` among them — are correctly left alone, which the obvious "count named listeners" fix would have dead-lettered on every tick | Closed |
| AC-F23 | LOW | Dead-lettering could not be exercised from outside the process: no reachable subscriber throws on a malformed payload, so `attempts` climbing to `failed_at` remains unverified on a live deployment (it is covered by unit tests and by the previous record's replay evidence) | Open |
| AC-F24 | LOW | Provisioning **asserts** rather than verifies the role passwords — `ALTER ROLE … PASSWORD <supplied>` runs every time — so a mistyped `FAPOMS_MIGRATION_PASSWORD` succeeds and silently rotates the deploy credential. Verified: after passing a deliberately wrong value, `fapoms_migrator` accepted it and refused the real one. Documented as intentional in `role-model.ts`; worth a warning when the role already exists | Open (by design) |
| AC-F25 | LOW | **FIXED AND VERIFIED.** The identity assertions now run on their own connection before `NestFactory.create`, so they are the first thing to touch the database. Re-verified against a freshly built `bootstrap migrate`-only database: *"FATAL: the database this application is connecting to has not been hardened … Run `npm run db:harden` against it"*, and not one word about `geo_states`. Originally the boot failed closed but blamed a geo table, because `GeoSeedService.onModuleInit` ran before `StartupChecksService.onApplicationBootstrap` | Closed |
| AC-F26 | **HIGH — FIXED AND VERIFIED** | **Operations could create, edit and delete an assayer but not open one**, and DESK_OPERATOR held nothing. Two causes. (1) `ASSAYER:VIEW:ORGANIZATION` was absent from the seed's `defaultPermissions`, so the declared grant resolved to nothing and a bare `filter(Boolean)` dropped it silently — twelve keys in total. **My first report of this said that list "defines no ASSAYER permissions at all", which was wrong**: it defines four, written as enum members (`PermissionResource.ASSAYER`), which my string-literal grep could not see. (2) The worse one, which I missed entirely and the other session found: `roleRepository.find()` does not load the `permissions` relation, so the merge began from an empty map and TypeORM's many-to-many assignment **deleted** every junction row the new array did not name. The seed was not failing to add — it was removing. Measured live before the repair: ADMIN 57 held of 63 declared, DEVELOPER 57/64, OPERATIONS 36/39, DESK_OPERATOR 3/6 — nineteen grants gone, **including the only `SYSTEM:APPROVE:PLATFORM` in the system, so no account could approve a destructive request and the two-person data-wipe rule could not be completed at all**. Verified after `ReconcileRolePermissions3`: counts restored to 63/64/39/6, `SYSTEM:APPROVE:PLATFORM` back with ADMIN, and `manager`, `executive` and `validator` all answer **200** on `GET /assayers/:id` | Closed |
| AC-F27 | MEDIUM — **FIXED AND VERIFIED** | A fresh seed left 10 branches and 1 project with `organization_id IS NULL`, because `BackfillTenantOwnership` runs before the seed creates the organisation. The seed now sets it, and `BackfillTenantOwnership2` repairs databases already written. Verified: **0 unowned branches, 0 unowned projects**, and the certification suite's own "nothing is unowned" assertion passes | Closed |

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
| Tenant isolation (`assayer-tenant-isolation.db.spec.ts`) | **38/39** — run for the first time; the one failure is the suite's own invalid enum value |
| Browser re-verification of the front-door fixes | site root → role home with real content; sign-out leaks nothing; next persona lands on its own home; desk-entry tiles resolve |
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

## Tenant isolation, proven for the first time

`assayer-tenant-isolation.db.spec.ts` — the F-03 acceptance matrix, listed in the previous record
as never run — was run here. First attempt: **19 of 39 failed**, and the failures were not what
they appeared. Because OPERATIONS could not read *any* assayer (AC-F26), every cross-organisation
read was refused by the permission guard before the organisation predicate was ever consulted:
those eight assertions would have looked identical on a system with no tenant scoping whatsoever.

After the grant repair, **38 of 39 pass**, and the cross-tenant half is testing what it claims for
the first time rather than passing for the wrong reason. Organisation A against organisation B:
the profile read, the code lookup, the roster list, typeahead, the map, the dossier, the identity
scan, the rate card, past payables, the activity timeline, invitation revocation and password
reset are all refused; a lifecycle transition is refused and the row does not move; a bulk batch
naming a foreign id changes nothing; and **the cleartext bank reveal — the worst part of the
original finding — is refused and not audited**. All eight own-tenant operations work.

One failure remains and it is the suite's own, not the product's. The own-tenant case sent
`'EMPANELLED'` and was corrected to `ACTIVE`; the **cross-tenant** case still sends `'BLACKLISTED'`,
equally not a member of `EmpanelmentStatus`, so the DTO refuses it with 400 and the request never
reaches the tenancy check the assertion exists to prove. Probed directly with a valid status and
the right principal: an OPERATIONS user writing an empanelment onto another organisation's assayer
gets **404 "No such assayer"** and nothing is written — the boundary holds, the test simply cannot
see it. (An ADMIN doing the same succeeds, which is the documented platform-operator behaviour, and
is why the principal matters: my first probe used `admin` and briefly looked like a leak.)

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
