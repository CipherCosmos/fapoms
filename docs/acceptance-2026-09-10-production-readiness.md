# Production acceptance — 10 September 2026

## Executive conclusion

**READY WITH ACCEPTED RISKS.**

The business logic is sound and, where it matters most, provably so. The complete operational
loop — hire a person, deploy them to work, execute it, complete it, pay for it — runs correctly
end to end, refuses the illegal versions of every step it was asked to refuse, survives
concurrent operators, and reconciles to the rupee under independent recomputation. The audit
trail is now tamper-proof against the application's own database credential, which closes the
most serious control gap this project has carried.

This campaign found six defects in **deployment mechanics** — not one of them in the product's
business logic. Provisioning a fresh installation failed three times before it succeeded, the
one-command installer had drifted out of step with the compose file it drives, caddy crash-looped
over a missing file, and the documented seed could not run against the hardened database it had
just created. All six were reported to the session that owns those files, fixed by it during this
campaign, and then re-verified here **from destroyed volumes**: the rig was torn down, rebuilt,
and the whole path run again from nothing, first attempt, no manual steps. It now comes up clean.

The residual risk is what was **not examined**: no browser workflow was driven, so the user
interface is unassessed rather than passed. That, and a short list of low-severity items carried
forward from the previous record, are the whole of the accepted risk.

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
| Reliability | **PARTIAL** | Concurrency proven (races, duplicate submits, stale versions, idempotent money). Worker failure injection and outbox replay were probed separately — see the reliability track |

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
| Malware scanning | EICAR refused (400, `Rejected infected upload: Eicar-Test-Signature`); a clean PDF accepted (201) |
| Deployment path, from empty volumes | Exercised; failed three times before succeeding (AC-F01/02/03) |

The last two are checked in as `scripts/acceptance/business-loop.mjs` and
`scripts/acceptance/authorization-and-audit.mjs`, with a README covering how to run them and the
two environment traps that will otherwise waste an afternoon. Both are idempotent — the business
loop cancels its own leftovers through the product rather than deleting them, and every
destructive audit probe runs inside a transaction that is always rolled back.

---

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

- **The browser.** No UI workflow was driven. The two days' budget went into standing the
  deployment up and into the API/database layers underneath it; the deployment defects consumed
  the window the browser pass would have used. The UI is therefore **unassessed**, not passed —
  no claim is made about loaders, stale views, empty states or navigation. This is the largest
  single gap in this report.
- **The mobile app.** Assayer accept and check-in were exercised over the API, which is the same
  path the app calls, but no Expo build was run. Field execution is proven at the contract, not
  in the client.
- **Tenant isolation** (`assayer-tenant-isolation.db.spec.ts`). Deliberately skipped: FAPOMS is a
  single-organisation product and the brief explicitly excludes tenant-versus-tenant testing.
  Standing up a second organisation to satisfy it would have been building an artificial
  requirement. The suite remains available for anyone who wants it.
- **Worker failure injection and outbox replay.** Already proven in the previous record and not
  re-run; the worker was live throughout and delivered every payable within a minute, which is
  the behaviour those probes protect, but kill-and-recover was not re-exercised here.
- **Deployed environments.** The homeserver was not reachable and the AWS box was deliberately
  left alone; both are excluded by the evidence-environment decision. Real TLS, real S3
  server-side encryption, FCM delivery and off-site backups are all outside this rig.
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
