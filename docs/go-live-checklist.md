# FAPOMS go-live checklist

Companion to `acceptance-2026-09-10-production-readiness.md` and to the role-by-role certification
in `final-product-acceptance-2026-09-10.md`. The software is fit to run the business; most of what
follows is about the environment it will run in, which the acceptance campaigns could not reach.

Work top to bottom. Each item says who it belongs to and what "done" looks like.

## 0. Two features that must not be switched on yet

The role-by-role campaign found two supported, one-click features that do not work. Neither is a
risk to weigh; both are defects with an owner. Until they are fixed and re-certified, the product
is only safe in the configuration it ships in — national accounts, built-in roles.

| # | Do not | Why | Done when |
|---|---|---|---|
| 0.1 | **Do not set `regions` on any account.** | Region scoping refuses reads and largely does not refuse writes. A region-scoped operations account approved a ₹2,250 payout, minted an invoice, adjusted a client line, set a commercial rate and moved a branch out of its own region — in a territory it is refused so much as reading. 19 routes confirmed at runtime with the rows read back. Dormant today only because **no real account is region-scoped**. | The write surface asserts the ceiling its read sibling does, `PUT /branches/:id` checks the region it is *setting* and not only the one it is replacing, and `write-region-parity.spec.ts` derives its route set instead of listing it. |
| 0.2 | **Do not create a custom role in Admin → Roles.** | A custom role is offered ten navigation entries and nine of the backing APIs refuse it. On `/scheduling` the refusal is drawn as **"0 active schedules"** — a wrong answer, not a broken page. | Each of the 13 measured pages either honours the permission fallback on its backing route or stops offering itself, and a refused fetch renders as a refusal rather than an empty result. |

## 1. Before anything reaches production

| # | Action | Owner | Done when |
|---|---|---|---|
| 1.1 | **Create the DEVELOPER account.** A named platform owner, personal named account, MFA enrolled, credentials in a password manager outside source control. | Platform owner | An account holds the DEVELOPER role and can open `GET /admin/outbox/dead-letters`. Until then six controllers answer to nobody, including the one surface that would show a stalled cron. There is no workaround — those controllers are `@RoleOnly()`, and a custom role holding every platform SYSTEM grant is still refused. |
| 1.2 | **Brief that owner on what the role can do.** It reaches the destructive data-reset path, the outbox dead-letter queue, service logs, the OCR boundary, geo admin and notification admin. | Platform owner | The holder can name what the role reaches and what the two-person wipe rule requires. |
| 1.3 | **Decide the push.** The branch is many commits ahead of `origin/test` and green at every commit. Pushing runs CI and, if its timer is live, triggers the AWS box's auto-deploy. | Repository owner | Pushed deliberately, with the AWS box's state known first — see 1.4. |
| 1.4 | **Resolve the AWS box's 5 September data-loss incident** before letting a deploy land on it. | Whoever owns that box | The cause is understood and the auto-deploy timer's state is a decision rather than a leftover. |

## 2. The environment checklist this campaign could not run

None of this was performed — no route existed from the acceptance machine to either deployment.
It must be run by somebody with access.

| # | Check | Pass looks like |
|---|---|---|
| 2.1 | Environment configuration | Every REQUIRED key in `.env.production.example` present, including `FAPOMS_RUNTIME_PASSWORD`, `FAPOMS_MIGRATION_PASSWORD` and `DB_ADMIN_URL`; `DB_MIGRATIONS_RUN=false`; `PII_ENCRYPTION_KEY` set; `CLAMAV_HOST` and `FILE_SCAN_REQUIRED=true` set — a `.env.docker` predating the ClamAV work carries neither, and uploads then go unscanned with only a warning line to say so. |
| 2.2 | Both repair migrations applied | `ReconcileRolePermissions3` and `BackfillTenantOwnership2` appear in `migrations`. Until they do, four roles are missing nineteen grants there — including the only `SYSTEM:APPROVE:PLATFORM`, without which no destructive request can be approved by anyone. |
| 2.3 | Migrations from empty | `npm run verify:migrations` against a disposable database on that host. |
| 2.4 | Runtime database identity | `npm run verify:runtime-role`, or the StartupChecks block in the boot log reporting all ten assertions. The API must connect as `fapoms_runtime`, never `fapoms_migrator`, never a superuser. |
| 2.5 | Worker replica running | `backend` and `backend-worker` both healthy. An api-only deployment processes no background jobs at all — no outbox drain, no audit sealing, no retention. |
| 2.6 | Schedules registered | Seven `bull:*:repeat` keys present. The reconciler re-converges them every five minutes; a fresh boot should not need it. |
| 2.7 | Health endpoints | `/api/v1/health` and `/api/v1/health/ready` answer, the latter with database, redis and realtime all up. |
| 2.8 | Proxy and TLS | The edge serves the app over TLS with a valid certificate. Caddy needs `${APK_DIR}/apk-redirect.caddy` to exist as a file — absent, it crash-loops while every other container reports healthy. |
| 2.9 | Storage | Bucket reachable; the boot log's CORS and encryption lines present. On community MinIO server-side encryption cannot be provided — confirm the host volume is encrypted instead, and record the answer rather than assuming it. |
| 2.10 | Malware scanning | ClamAV reachable and `FILE_SCAN_REQUIRED=true`. Confirm with the EICAR test string on one upload path. Note the image publishes no arm64 build. |
| 2.11 | Backups | A backup exists, is off-box, and **has been restored at least once**. `deploy/restore.sh --drill` hardcodes podman and homeserver paths; adapt it or run the equivalent by hand. |
| 2.12 | Audit protections live | The immutability and TRUNCATE triggers exist on `audit_events` and `audit_chain`, and `UPDATE` is refused when attempted as the runtime role. |
| 2.13 | Smoke the business loop | Sign in as each role; confirm per-role landing; complete one assignment and watch its payable appear within a minute. `scripts/acceptance/` runs against any deployment given its URL and credentials. |
| 2.14 | **The log proxy is running** | `/admin/logs` is one of only two DEVELOPER-exclusive screens and the first place 4.2 below sends the platform owner. It reads containers through `dockerproxy`, which was declared in the compose file and started by nothing — so the screen answered *"Cannot reach the Docker log proxy at http://dockerproxy:2375."* `backend` now depends on it; confirm a `dockerproxy` container is up and that the screen shows lines. |
| 2.15 | **The deployment is serving the commit you think it is** | Nothing in the product reports the running build. On the acceptance stack the container was found to be two code commits behind the branch, which silently made several results statements about an older build. Before certifying anything against a deployment, check a known string from the newest commit inside the running image — `docker exec <api> grep -c '<marker>' /app/packages/backend/dist/...` — rather than trusting the deploy log. |

## 3. Still open, owned, and not blocking

| Item | Owner | Note |
|---|---|---|
| Mobile client never run | Mobile owner | Needs a current dev-client build and a device or emulator. The only prebuilt APK is older than 95 of the source files it would test. The API contract beneath it **is** proven. |
| CI `database` job never executed | Repository owner | Implemented but never run, because it needs a push. |
| Homeserver certification run | Whoever owns that box | Never produced; the machine was offline throughout. |
| AC-F10, AC-F11, AC-F13, AC-F19 | Engineering | Deferred with reasons in the acceptance report. None touches money, lifecycle, authorization or audit. |

## 4. Operational notes worth knowing on day one

- **Changing a role, a user's regions or `must_change_password` directly in the database does
  nothing until Redis is flushed.** The resulting 403 names the old state, not the cache, and has
  cost two separate sessions an afternoon. Make those changes through the product.
- **`/admin/outbox/health` is the first place to look** when completed work stops becoming
  payables. It is DEVELOPER-only — see 1.1 — and **it has no screen**. The API answers
  (`{pending, deadLettered, retrying, oldestPendingAgeSeconds, maxAttempts}`), but the web app
  contains no reference to it at all and `/admin/outbox` renders the not-found page. Reaching it
  today needs a bearer token and a command line. Until it has a screen, whoever holds DEVELOPER
  needs the curl written down somewhere they will find it at 2am.
- **An assayer cannot use the web app for anything.** They route correctly to two pages, and until
  `c1e62361` they could not even get past the forced password change there — the form posted to
  the staff endpoint, which 404s for a principal that is not a `users` row. Fixed for the password;
  "Save Profile" on that same page still posts `PUT /users/me` and there is no assayer counterpart
  to send it to. Field staff belong in the mobile app.
- **A completed audit closes its branch to further assignments**, twice over. This is a rule, not a
  fault, and it is the first thing that will confuse somebody re-running the acceptance probes.
- **The seed refuses to run against a populated database**, and on a hardened one it must run as
  `fapoms_migrator`. `DEPLOYMENT.md` says which identity.
