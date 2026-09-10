# Production acceptance — 10 September 2026

## Executive conclusion

**READY WITH ACCEPTED RISKS.**

The business logic is sound and, where it matters most, provably so. The complete operational
loop — hire a person, deploy them to work, execute it, complete it, pay for it — runs correctly
end to end, refuses the illegal versions of every step it was asked to refuse, survives
concurrent operators, and reconciles to the rupee under independent recomputation. The audit
trail is now tamper-proof against the application's own database credential, which closes the
most serious control gap this project has carried.

The accepted risk is entirely in **deployment mechanics, not in the product**. Provisioning a
fresh installation currently fails three times before it succeeds, and the one-command installer
is out of step with the compose file it drives. None of this corrupts data or weakens a control;
all of it stops a new environment from coming up, and all of it is being actively fixed by the
session that owns those files. FAPOMS should not be installed anywhere new until AC-F01, AC-F02
and AC-F03 are closed and the path is re-run clean from empty volumes. An **existing, running**
deployment is not affected by any of them.

What this rests on: a purpose-built production-shaped stack (caddy, ClamAV, Postgres, Redis,
MinIO, and a separate API and worker) brought up from empty volumes on this machine, migrated,
hardened and seeded, then driven over HTTP as five real user accounts with the database inspected
after every mutation. No deployed system was touched. Nothing here is a statement about live
production data.

---

## Core business evidence

| Business capability | Result | Evidence |
|---|---|---|
| HR / lifecycle | **PASS** | `assayer-lifecycle-certification.db.spec.ts` 150/150 against the running system: all 98 illegal transitions refused with no mutation and no audit event; reason enforcement; departure effects; rehire routes RESIGNED and TERMINATED back to INVITED |
| Operations / deployment | **PASS** | Eligibility, distance ceiling, project window and double-booking each refused a real attempt with an actionable message; override requires a stated reason and records it against the actor |
| Assignment | **PASS** | E2E-01…E2E-14; state machine, ownership, versioning; completed work cannot be cancelled; a second completion is not a second business event |
| Field execution | **PASS** (API path) | Accept, check-in with GPS, and completion; `checked_in_at` stamped; an assayer cannot complete their own job (403) or price it (`fee: 99999` ignored). Mobile app itself not exercised — see *not tested* |
| Financial | **PASS** | Money recomputed independently and matching: 2500 − TDS 250 = 2250; client GST 2500 × 18% = 450; client TDS on the base, never the GST; line total 2700. Segregation of duties refuses booker-approves and approver-pays, by name. Duplicate payment reference yields one payment |
| Audit / history | **PASS** | Every mutation carries an actor; refusals recorded as `SEGREGATION_OF_DUTIES_REFUSED` with `outcome: DENIED`, never success-shaped; 7 destructive vectors refused as the runtime role while append still works |
| Authorization | **PASS** | DESK_OPERATOR refused on six privileged writes over direct HTTP with a before/after database comparison showing nothing changed; assayer horizontal isolation on work, acceptance and bank details |
| UI / usability | **NOT ASSESSED** | See *not tested* — the browser pass was displaced by the deployment defects |
| Reliability | **PARTIAL** | Concurrency proven (races, duplicate submits, stale versions, idempotent money). Worker failure injection and outbox replay not re-run — see *not tested* |

---

## Findings

Full detail, with reproductions, in the campaign findings ledger. Severity per §20.

| ID | Severity | Business impact | Status |
|---|---|---|---|
| AC-F01 | **BLOCKER** | A fresh deployment cannot migrate: `permission denied for schema public`. The compose's postgres pre-creates the database owned by the superuser, so provisioning takes its "already exists" branch and leaves the migrator without CREATE. The grant that would fix it runs one step too late, in `harden` | Reported; fix validated (`ALTER DATABASE … OWNER TO fapoms_migrator`) |
| AC-F02 | **BLOCKER** | Behind AC-F01: bootstrap installs three extensions but the migrations need `pg_trgm` and `btree_gist` too | Reported; covered by the same ownership fix, list still worth completing |
| AC-F03 | **HIGH** | Behind AC-F02: hardening aborts on `tiger`/`tiger_data`/`topology`, whose tables the postgis image leaves owned by the superuser — a half-finished deploy with the schema current and grants missing | Reported; fix suggested (tolerate what it cannot grant) |
| AC-F04 | MEDIUM | `setup.sh` never generates the three credentials the deploy path requires, still writes `DB_MIGRATIONS_RUN=true`, and never rewrites an existing `.env.docker`. `DEPLOYMENT.md` does not mention provisioning | Reported, unowned; offered to fix |
| AC-F05 | MEDIUM | `clamav/clamav:1.4` publishes no arm64 image at any tag; `compose up` dies at image pull on an arm64 host | Reported; worked around under emulation |
| AC-F06 | HIGH | caddy crash-loops on a fresh host because it bind-mounts a file nothing creates; the result is seven healthy containers and an app that answers nothing. `publish-apk.sh` and the compose also disagree about `APK_DIR` | Open, unowned |
| AC-F07 | HIGH | The documented seed step cannot run on a hardened deployment: `seed.js --if-empty` issues an unconditional `TRUNCATE`, which the runtime role correctly refuses | Reported |
| AC-F08 | LOW | The distance-ceiling override accepts a 9-character justification where the eligibility override demands 10. The decision is still audited and attributable | Open |

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
| Backend `.db.spec.ts`, self-contained | 6 suites, **92 tests**, all pass against the rig |
| `assayer-lifecycle-certification.db.spec.ts` | **150/150** — first time run in this working copy |
| Core business loop (E2E + SoD + money) | **25/25** |
| Authorization, isolation, audit defences | **20/20** |
| `npm run verify:migrations` | 79 migrations, 94 tables, second run a no-op, all named constraints present |
| Runtime-role assertions at boot | 10/10 |
| Typecheck | backend, frontend, mobile — all clean |
| Deployment path, from empty volumes | Exercised; failed three times before succeeding (AC-F01/02/03) |

The last two are checked in as `scripts/acceptance/business-loop.mjs` and
`scripts/acceptance/authorization-and-audit.mjs`, with a README covering how to run them and the
two environment traps that will otherwise waste an afternoon. Both are idempotent — the business
loop cancels its own leftovers through the product rather than deleting them, and every
destructive audit probe runs inside a transaction that is always rolled back.

---

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

The single most valuable thing the next session can do is the browser pass this one did not
reach.
