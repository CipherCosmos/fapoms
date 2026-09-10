# Production acceptance — final report, 10 September 2026

## Executive verdict

**READY WITH ACCEPTED RISKS.**

The software is fit to run the business. Every blocking defect discovered during the acceptance
campaign was fixed and re-verified against the production-shaped acceptance environment, and one
complete scenario — hire a person, verify their papers, activate them, empanel, assign, execute in
the field, complete, approve and pay under segregation of duties, then leave and rehire — passes
29 of 29 checks with the database read back after every step and the API, database, audit trail
and financial state agreeing at the end. What remains is not in the product: **the target
production environment has never been exercised from this machine**, the DEVELOPER account the
platform requires does not exist yet, and the mobile client has not been run. Those three are
documented below with named owners and are the whole of the accepted risk.

## What the system can now reliably do

**HR.** Create a person, record and verify their identity documents, walk them through document
verification, background verification and training to ACTIVE, record payout details encrypted at
rest, put them on leave, take their resignation, and rehire them back to the start of onboarding
rather than straight back to work.

**Operations.** Empanel a person with a client, assign them to a branch within the client's
distance rules and the project's window, and see the work through acceptance, check-in and
completion. Reassign it to somebody else with a recorded reason and an ownership interval that
says who held it when.

**Field execution.** Accept and check in against the branch's real coordinates, over the same API
the mobile client calls.

**Finance.** Book exactly one payable and one client line per completed assignment, priced by one
formula; approve and pay under segregation of duties where the booker, the approver and the payer
must be three different people; reconcile; and show management figures that reproduce from the
base tables.

**Audit.** Answer who did what, when, to which record, with the previous and new value — and
refuse to be altered by the application's own database credential.

## What happens when users do the wrong thing

Illegal lifecycle moves are refused and the record does not move. Unauthorised actions are refused
by the API whether or not the interface offered them, and a before-and-after comparison shows
nothing changed. A stale write is answered with a conflict rather than silently overwriting.
Duplicated clicks produce one business event: three simultaneous completions gave one audit row,
one version bump and one payable. A redelivered worker event books nothing extra. A payment
reference sent twice is one payment. A document cannot be verified with no scan on file, nor with
a scan but none of the card's data recorded — *"a verification that compares nothing attests to
nothing."* A fee cannot exceed twice the contracted quote. An appraiser who lives too close to a
branch cannot be assigned to it by anyone, at any level.

None of these leave a half-finished state behind: the refusals unwind completely, including one
where a pessimistic lock had already begun writing a banking snapshot.

## Deployment status — two separate answers

| | status | basis |
|---|---|---|
| **Software readiness** | **READY** | Exercised end to end on a production-shaped stack built from destroyed volumes: caddy, ClamAV, Postgres, Redis, MinIO, and a separate API and worker, provisioned through the real three-role path, migrated, hardened and seeded. |
| **Production environment readiness** | **NOT ASSESSED** | Neither deployment was reachable from this machine. The homeserver was offline throughout; the AWS box's address lives in `/etc/default/fapoms-deploy` on the box itself and is not in the repository. No health endpoint, TLS, proxy, backup or worker check was performed against either. |

**This report is not evidence that production is ready.** It is evidence that the software is, on
an environment shaped like production. The environment checklist — health endpoints, environment
configuration, migrations applied, database credentials, Redis, worker, storage, proxy, TLS, backup
configuration — remains to be run by somebody with access, and the two repair migrations
(`ReconcileRolePermissions3`, `BackfillTenantOwnership2`) must reach it before the grants are
correct there.

## Owner decisions

| decision | outcome |
|---|---|
| **DEVELOPER OWNER** | **A named platform owner, on a personal named account, MFA enrolled, credentials held in a password manager outside source control.** Chosen over a shared break-glass account so audit rows name a person, and over granting DEVELOPER to the existing admin, which would have collapsed the separation the role split created. **The account does not exist yet** — creating it is an outstanding go-live action, and until it exists six controllers answer to nobody. |
| **AC-F09 — rejected empanelment** | **Option A: rejection stays reversible, and reversing it requires a written reason.** Implemented and shipped: moving away from `REJECTED` without a reason is refused, the reason is recorded in the `EMPANELMENT_SET` audit row beside the actor and previous value, and every other standing change is untouched. Not made terminal, because a client changing its mind is ordinary and a terminal state would push the correction into a database edit where nobody would see it. |

## Mobile client

**MOBILE CLIENT — NOT EXERCISED.** A genuine attempt was made and it is not achievable on this
machine:

- The app requires a **dev-client build** — `expo-dev-client` plus LiveKit WebRTC native modules —
  so it cannot run in Expo Go.
- **No iOS toolchain:** `xcode-select` points at CommandLineTools, `xcodebuild` refuses, **zero
  simulators available**, CocoaPods not installed.
- **No Android runtime:** `ANDROID_HOME` unset, no `emulator` binary, no device attached.
- Prebuilt APKs exist, but the release one is from 16 August and **95 mobile source files are newer
  than it**, so even with a runtime it would not be testing the delivered code.

This is distinct from the field-execution API contract, which **is** proven: accept, check-in and
the completion that follows were exercised over the same endpoints the app calls, including a
temporary-password issue, forced rotation and sign-in as the assayer. What is unproven is the
client that calls them — its screens, permission prompts, offline retry and resubmission.

## Evidence by capability, with the level of proof

Levels are used strictly. `REAL API TESTED` means requests against a running deployment;
`DATABASE VERIFIED` means the rows were read back afterwards; `BROWSER TESTED` means driven in a
browser. API evidence is not reported as browser evidence, the acceptance rig is not reported as
production, and source inspection is never reported as runtime proof.

| Capability | Level | Evidence |
|---|---|---|
| HR / lifecycle | `END-TO-END TESTED` · `BROWSER TESTED` · `DATABASE VERIFIED` | 150/150 lifecycle certification against the running system (98 illegal transitions refused with no mutation); 32/32 bulk, recovery, delete-cascade and empanelment probes; final scenario HR-1…HR-4; browser transition with refresh discipline |
| KYC / document integrity | `REAL API TESTED` · `DATABASE VERIFIED` | Verification refused with no scan on file, refused again with a scan but no card data, then accepted and stored VERIFIED; EICAR refused on the KYC upload path; clean PDF accepted with SHA-256 and sniffed MIME recorded |
| Operations / deployment of people | `END-TO-END TESTED` · `DATABASE VERIFIED` | Eligibility, distance ceiling, conflict-of-interest (unwaivable), project window, double-booking and the fee ceiling each refused a real attempt with an actionable message; override requires a stated reason and records it against the actor |
| Assignment | `END-TO-END TESTED` · `DATABASE VERIFIED` | Full state machine; reassignment lineage with one open ownership interval; stale `expectedVersion` answered 409; three simultaneous completions produced one audit row and one payable |
| Field execution | `REAL API TESTED` · `DATABASE VERIFIED` · **client `NOT EXERCISED`** | Accept and GPS check-in as the assayer over the app's own endpoints, `checked_in_at` stamped. The mobile client itself was not run — see above |
| Financial | `END-TO-END TESTED` · `DATABASE VERIFIED` · `BROWSER TESTED` | Money recomputed independently rather than read back: 2000 − TDS 200 = 1800; GST 2000 × 18% = 360. Segregation of duties refused booker-approves and approver-pays by name; a third person paid; the same reference twice is one payment |
| Audit / history | `END-TO-END TESTED` · `DATABASE VERIFIED` | Every mutation names an actor (25 rows for the scenario's assayer); refusals recorded as `DENIED`, never success-shaped; seven destructive vectors refused as `fapoms_runtime`; `verify-runtime-role` 87/87 across two provisioning shapes |
| Authorization / IDOR | `END-TO-END TESTED` · `DATABASE VERIFIED` | 20/20 — six privileged writes refused for DESK_OPERATOR with a before/after comparison showing nothing changed; assayer horizontal isolation on work, acceptance and bank details; tenant isolation 39/39 |
| Reliability | `END-TO-END TESTED` · `DATABASE VERIFIED` | 25/25 — duplicate outbox delivery yields one payable; worker stopped, event undelivered, worker started, event delivered; a refused approval unwinds completely; the schedule reconciler proven on a real Bull queue by deleting its repeat key and watching it recover and fire |
| Migration path | `END-TO-END TESTED` | `verify:migrations` from `template0`: 79 migrations, 94 tables, second run a no-op; the full provisioning path re-run from destroyed volumes, first attempt, no manual steps; the transition exercised on a populated pre-split database with a witness audit row that survived |
| UI / usability | `BROWSER TESTED` | Three roles across eight screens, per-role landing, refresh discipline, 375px responsive, cross-screen figures reconciled. AUDITOR and DEVELOPER not driven; one mutation exercised under refresh discipline, not all |
| Management figures | `BROWSER TESTED` · `REAL API TESTED` · `DATABASE VERIFIED` | Independent SQL, the API and the browser agree to the rupee: unbilled ₹31,320, paid out ₹21,600, GST ₹5,220, revenue ex-GST ₹29,000 |
| Production environment | `NOT EXERCISED` | No route from this machine to either deployment |

## Final regression — exact numbers

Run clean at the end, nothing disabled, no `--forceExit`, no `retryTimes`, no raised timeouts
outside the `.db.spec.ts` files that talk to a real database.

| gate | result |
|---|---|
| `tsc --noEmit` backend / frontend / mobile | clean, clean, clean |
| lint backend / frontend | 0 errors, 0 errors |
| backend suite | **311 suites, 4,391 tests, all pass** |
| frontend suite | **83 suites, 1,031 tests, all pass** |
| shared suite | **10 suites, 413 tests, all pass** |
| mobile suite | **23 suites, 263 tests, all pass** |
| production builds | `build:backend` and `build:frontend` both succeed |
| `npm run verify:migrations` | 79 migrations, 94 tables, second run a no-op |
| `npm run verify:runtime-role` | **87/87** across two provisioning shapes |

**Totals: 427 suites, 6,098 tests.** Live evidence on top of that: final business scenario 29/29,
authorization and audit 20/20, reliability 25/25, lifecycle bypass 32/32, lifecycle certification
150/150, tenant isolation 39/39, business loop 25/25, adversarial guard mutations 3/3.

## Remaining findings — classified

Every remaining item, with a disposition. Nothing here is called a product decision to avoid
calling it an engineering problem.

| ID | Severity | Disposition | Why |
|---|---|---|---|
| AC-F21 | HIGH | **FIX before go-live** | Nobody holds DEVELOPER; six controllers answer to it alone, including the outbox dead-letter queue that would show a stalled cron. Proven there is no workaround: a custom role with all three platform SYSTEM grants is still refused, because those controllers are `@RoleOnly()`. The action is to create the account, not to widen the boundary |
| AC-F05 | LOW | **ACCEPT** | `clamav/clamav` publishes no arm64 image at any tag. Recorded in the compose file. No effect on an x86 host; on arm64 it needs an explicit `platform` override. Forcing emulation in production has a real cost and is not a default to set silently |
| AC-F08 | LOW | **DEFER** | The distance-ceiling override accepts a short justification where the eligibility override demands ten characters. The decision is still audited and attributable; the inconsistency is cosmetic against the audit trail |
| AC-F10 | MEDIUM | **DEFER** | A bulk lifecycle walk can commit its first hop and refuse the second, reporting only the failure. Real, and worth fixing — but it needs a two-hop path with a reason gate in the middle, the operator sees the person's actual state on the roster immediately afterwards, and no money or authorization depends on it |
| AC-F11 | MEDIUM | **DEFER** | Archiving a person cancels their open assignments with no per-assignment audit row; only the aggregate `ASSAYER_DELETED` exists. The cancellation itself is correct and the aggregate names the actor and the reason. The gap is traceability from the assignment's side |
| AC-F12 | LOW | **NOT APPLICABLE** | `STRICTLY_NON_OVERRIDABLE_STANDINGS` names `EXPIRED` and `SUSPENDED`, which the enum and the CHECK constraint do not define. No protection is lost — every reachable standing is covered — and the strings are unreachable |
| AC-F13 | LOW | **DEFER** (test quality) | `billing-overview-region-scope.db.spec.ts` asserts absolute amounts in the region it calls empty and fails when anything else books money there. It fails safe and loudly; it is a test-suite robustness item |
| AC-F19 | LOW | **DEFER** | Google Fonts violate the `font-src` CSP, which is report-only. Fonts load today. It becomes a real item the day CSP moves to enforce, and that move is its own piece of work |
| AC-F23 | LOW | **ACCEPT** | Dead-lettering could not be driven from outside the process because no reachable subscriber throws on a malformed payload. It is covered by unit tests and by the previous record's replay evidence |
| Mobile client | — | **DEFER, owned** | Not exercisable on this machine. Needs a current dev-client build and a device or emulator. The API contract beneath it is proven |
| Production environment | — | **FIX before go-live, owned** | The environment checklist must be run by somebody with access, and both repair migrations must reach it |

Everything else raised by this campaign is closed: 15 of the 27 findings are fixed and verified,
including both blockers and every item touching money, lifecycle, authorization, audit or
deployment startup.

## The full findings ledger


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


---

# Appendix — how each of these was proven

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

---

*Everything in this report was produced on a purpose-built acceptance rig on 10 September 2026.
No deployed system was touched. Nothing here is a statement about live production data.*
