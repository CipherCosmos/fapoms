# Codebase reorganization: the plan

Branch: `refactor/reorganization` · Started from `da66725c` (main = test = this commit, 2026-09-21)

This is the working plan and the progress tracker. It's updated at the end of every phase, so
the state of the reorganization can always be read here.

---

## Progress tracker

| Phase | Name | Status | Merged to `test` | Merged to `main` | Checkpoint tag |
|---|---|---|---|---|---|
| 0 | Safety net | not started | — | — | `reorg-p0` |
| 1 | Repo hygiene & documentation | not started | — | — | `reorg-p1` |
| 2 | Backend relocation | not started | — | — | `reorg-p2` |
| 3 | Frontend relocation | not started | — | — | `reorg-p3` |
| 4 | One source of truth (routes, types, mobile API) | not started | — | — | `reorg-p4` |
| 5 | Split the oversized files | not started | — | — | `reorg-p5` |
| 6 | Merges that change output (owner decides each) | not started | — | — | `reorg-p6` |

Status values: `not started` · `in progress` · `verifying` · `awaiting owner OK` · `done`.

---

## 1. Why, and what "done" means

The code is not badly written; it is badly placed. Most concerns already have a correct home, but
copies grew beside it, and the largest files slowly absorbed many features. The result: 20
backend files hold 36% of the backend, pages call the API directly, the route list is written in
6 places, and there are 84 separate status-label maps.

**Done means:**
- A new developer can find where any feature lives from the folder names alone.
- Each concern has one home.
- No source file is over ~800 lines, except generated files and migrations.
- Docs match what the two servers actually run.
- Every feature, workflow and permission behaves exactly as before, and each phase proves it.

## 2. Ground rules (every phase)

1. **Move first, rewrite later.** Phases 0–5 change where code lives, not what it does. Anything
   that changes what users see or what the API returns is Phase 6, and needs the owner's yes for
   each item.
2. **Isolation.** All work happens on `refactor/reorganization`, in a separate checkout at
   `/Users/deepstacker/WorkSpace/dupcq/gssAutomation-reorg` with its own `node_modules`. The main
   checkout and the running dev stack stay on `test`. Neither server deploys this branch.
3. **Land each phase, don't hoard it.** A long-lived branch full of file moves conflicts with
   every feature commit made meanwhile. So each phase follows the same cycle:
   `merge test in → do the phase → prove no change → owner OK → merge into test → AWS runs it →
   merge into main`. A phase is small enough to land within days.
4. **Never move:** `docker-compose.yml`, `deploy/docker-compose.prod.yml` (Docker derives the
   database volume names from their folder, so moving one starts the DB empty), `deploy/*.sh`
   and `deploy/aws/*.sh` (auto-deploy copies these by name), the Dockerfiles,
   `packages/backend/templates/`, `packages/frontend/nginx.conf`, `deploy/Caddyfile`,
   `.env.docker` and its two symlinks, and the `scripts/*.mjs` files CI calls.
5. **Other sessions stay paused** while a phase touches their area. Resume them after the phase
   is merged into `test`, and have them `git pull` first.
6. **Every phase ends with a checkpoint tag** (`reorg-pN`) so any phase can be reverted as a unit.

## 3. Proving "nothing changed" (the gate every phase must pass)

Phase 0 builds these checks. From then on, every phase runs them before and after, and the diff
must be empty unless the change is intended and written down.

| # | Check | What it proves | Tool (built in Phase 0) |
|---|---|---|---|
| G1 | Backend HTTP surface | No endpoint moved, disappeared, or lost a guard, role or permission | `scripts/reorg/snapshot-backend-routes.mjs` (static AST: controller prefix + method + path + guards + `@Roles` + `@RequirePermissions` + `@Public`) |
| G2 | Backend boots | Dependency injection still wires after moving providers | CI database job: boot compiled `dist/main.js` against CI Postgres + Redis, hit `/health`, dump the live route table and diff it with G1 |
| G3 | DB schema | Entity moves changed no table or column | CI database job: after migrating from empty, `typeorm migration:generate --check` must produce nothing |
| G4 | Web routes | Every route path, lazy page and permission verdict per role unchanged | `scripts/reorg/snapshot-web-routes.mjs` |
| G5 | Shared public API | `@fapoms/shared` exports the same names | `scripts/reorg/snapshot-shared-exports.mjs` |
| G6 | Full CI | Everything still compiles, lints and passes | build shared · tsc backend/frontend/mobile · lint · unit tests · `test:db` · build backend/frontend · compose parity |
| G7 | Runtime | Real workflows still work | Local stack: login, roster, assayer record, hiring, planning, billing, public registration, email templates; console and network clean |
| G8 | Staged deploy | Works on a real server before production | merge to `test` → AWS deploys → health + service logs clean → then `main` |

Snapshots are committed under `docs/reorganization/snapshots/`, so the diff shows up in review.

---

## Phase 0: Safety net (no user-visible change)

**Goal:** make the tree safe to move files in, and close the security exposure found in the audit.

### 0.1 Secrets (runs on the servers; not a code change)
The leaked values are identified only by fingerprint (first 12 hex characters of sha256):
- `DB_PASSWORD` → `22bcc2238367`
- `JWT_SECRET` → `c6a40d8a4128` or `1fa1658c4906`

1. Run the check command (in the handover notes) on each server. It prints fingerprints only.
2. If a server's value matches → rotate it:
   - **JWT_SECRET:** generate a new value (`openssl rand -hex 48`), set it in `.env.docker`, then
     `up -d backend backend-worker`. Everyone is logged out once.
   - **DB_PASSWORD:** `ALTER ROLE <owner role> PASSWORD '<new>'` inside Postgres, then set the same
     value in `.env.docker`, then `up -d` (not `restart`, which keeps the old environment).
     Do it in that order, so the app never holds a password the database refuses.
3. Confirm the EC2 security group does not expose 5432, 6379 or 9000–9001 to the internet.
4. (Optional, owner decision) Purge the two env files, the old `node_modules`, the bugreport zip
   and the RBL spreadsheet from git history. This needs a force-push and a re-clone on both servers.

### 0.2 Remove data that should not be public
- `git rm roster-geo-errors.csv` (assayer codes and locations).
- `git rm packages/backend/src/scripts/verify-real-invariants.mjs` (hard-codes `admin`/`admin123`;
  nothing references it).

### 0.3 Make the tests safe to move files under
About 50 specs find files by path, so moving a file breaks them or, worse, quietly makes them
check nothing.
- Add one helper, `packages/backend/src/test-support/repo-paths.ts`, with `backendSrc()` and
  `repoRoot()` that walk up to the nearest `package.json`. Replace every
  `join(__dirname, '..', '..')`-style root lookup (33 specs) with it.
- Same for the 17 frontend specs that read source files; add `frontendSrc()` in
  `packages/frontend/src/test-support/`.
- Guard against silent weakening: every scanning spec also asserts that it scanned **more than
  zero files** and that each path in its allow-list exists. A spec that silently matched nothing
  then fails instead.
- Replace the two literal NUL bytes (`mobile/src/screens/ProfileScreen.tsx:421`,
  `shared/src/email-layout.ts:174`) with `'\u0000'`, which is identical at runtime. Otherwise
  grep and codemods skip those files.

### 0.4 Build the gate
- Scripts G1, G4 and G5, plus the first committed snapshots.
- CI: add `refactor/**` to the workflow's `push` and `pull_request` branches, so this branch gets
  full CI. Add G2 (boot + live route diff) and G3 (`migration:generate --check`) to the database
  job, with a Redis service there.
- Root `package.json` scripts: `typecheck` (all four packages), `reorg:snapshot`, `reorg:verify`.

**Exit criteria**
- [ ] Both servers checked; rotated where the fingerprint matched; security group confirmed
- [ ] `roster-geo-errors.csv` and `verify-real-invariants.mjs` removed
- [ ] No spec locates `src` by counting `..`; every scanner asserts it scanned something
- [ ] G1–G5 exist, snapshots committed, and CI runs on this branch, green, with G2 and G3 included
- [ ] Tag `reorg-p0`, merged to `test`, AWS healthy, merged to `main`

---

## Phase 1: Repo hygiene & documentation (no runtime change)

`auto-deploy.sh` ignores `*.md` and `docs/`, so this whole phase cannot trigger a deploy except
where noted.

### 1.1 Documentation layout
```
docs/
  README.md                 ← index: what each doc is for, who reads it
  architecture/             ← SYSTEM_MAP, business-spec, module map (new), data model
  operations/               ← environments (new), deployment, backup/restore, runbooks
  reference/                ← env-vars, database-roles, security-controls, service-logs
  adr/                      ← 006, 007 (+ ADR-008: this reorganization)
  reports/2026-MM-DD-*.md   ← the ~10 dated audit/certification reports, archived as-is
  reorganization/           ← this plan and the snapshots
```
- New `docs/operations/environments.md`: one table of branch → host → compose file → mode →
  what migrates → how to deploy, check, back up and restore.
- Fix, with the audit's evidence: the DEPLOYMENT.md "Deploy" section (it starts the dev stack),
  README's CI and Deployment sections, and `deploy/aws/README.md` (describe the "mounted"
  layout the box actually runs).
- `CLAUDE.md`: keep the owner's AWS rules and add a project section (branches, layout, where
  things live, how to verify). Don't replace it.
- Remove orphaned images: `screenshots/` (2.6 MB, nothing references it) and
  `docs/discovery/screenshots/`.

### 1.2 Delete dead tracked files
- `packages/backend/src/infrastructure/database/osm-geocoding-cache.json.bak-*`, the committed
  cache JSONs in `src/`, and `packages/backend/var/geo-cache/osm-geocoding-cache.json` (and fix
  the `.gitignore` pattern that missed it).
- `schema-baseline.sql` (4,906 lines, unreferenced). Check first that no script reads it.
- `packages/frontend/public/logo-dark.png` (1 MB) and `logo-concepts-clean.html`, both unused.
  This one ships in the image, so it triggers one frontend rebuild.
- The dead `compilerOptions.paths` in `packages/backend/nest-cli.json` and the stale
  `.dockerignore` entries.
- `deploy/nginx/fapoms.conf` → move to `docs/operations/` as a reference file, since nothing
  deploys it.

### 1.3 Repo standards
- `.editorconfig`, `.nvmrc` (20, matching CI and the production images), `CONTRIBUTING.md`
  (branch rule, commit style, how to run the checks), `.github/pull_request_template.md`,
  `SECURITY.md` (how to report).
- Declare `jest` and `ts-jest` in the packages that use them (shared, frontend, mobile). This
  changes the lockfile, so both hosts rebuild once.
- **Not doing:** a repo-wide Prettier reformat. It would rewrite every file and bury the history.
  If wanted, add the config and apply it to new or changed files only.

### 1.4 Operations fixes found in the audit
- `backup.sh`/`restore.sh`: make them work with `docker` as well as `podman`, so EC2 can take
  backups. This is a new capability, and deploy scripts self-update by name, so the change lands
  automatically.
- One install path per host: `setup.sh` (homeserver) and `deploy/aws/install-auto-deploy.sh`
  (EC2). Mark `deploy/aws/bootstrap.sh` as the alternative "bootstrap" layout in the docs rather
  than deleting it.

**Exit criteria**
- [ ] `docs/README.md` indexes every doc; no dated report sits among the reference docs
- [ ] DEPLOYMENT/README/AWS README reviewed against the real servers
- [ ] Dead files gone; `git ls-files` shows no screenshots, caches, `.bak` files or csv exports
- [ ] G1–G8 green (G1, G3, G4 and G5 must show zero diff)
- [ ] Tag `reorg-p1` → `test` → `main`

---

## Phase 2: Backend relocation (pure moves; exported names unchanged)

Start by merging `test` into the branch. Other sessions stay paused in `packages/backend`.

### 2.1 DTOs out of controllers
- Move the 178 classes declared inline in 35 controllers to `modules/<m>/dto/<name>.dto.ts`,
  keeping the same exported names and decorators.
- Where a controller class `implements` a service interface with the same shape, keep both for
  now. Merging them is a later, optional clean-up.
- Resolve the name clashes by module path; the names themselves stay as they are.
  (`CreateContactRequestDto` exists in both branch and client, `CreateDocumentDto` in both
  branch and document.)
- Largest first: assayer (27), billing-engine (17), notification-admin (13), user (11),
  client (11).

### 2.2 `modules/assayer` into sub-folders
```
modules/assayer/
  assayer.module.ts                 (stays)
  recruitment/   registration-application.*, public-registration.controller, hr-applications.*, interviews
  roster/        roster-import.*, roster-records.*, roster query/vocabulary
  records/       KYC documents, id-card, dossier, references, empanelment standing
  workforce/     hr-workforce.*, workforce attributes, qualification-score
  location/      live location, trail
  lifecycle/     lifecycle rules, derived status, gates
  core/          assayer.entity, assayer.service, assayer.controller (split in Phase 5)
```
- Move specs together with their files. Update the path allow-lists in
  `persistence-boundary`, `response-envelope-boundary`, `authorization-before-early-return`,
  `security-controls` and `lifecycle-authority`, plus the two acceptance scripts that hard-code
  backend paths.
- Check that `__dirname`-relative runtime paths in moved files still resolve (the id-card logo
  loader, the email template loader).

### 2.3 `recommendation.engine.ts` → one class per file
- `planning/recommendation/filters/*.ts` (7), `scorers/*.ts` (16), `engine.ts`, and `index.ts`.
- Keep `planning/recommendation.engine.ts` as a re-export, so no import site has to change in
  this phase.

### 2.4 Dead code out
- The `'background-jobs'` queue: `infrastructure/queue/queue.module.ts`, `bull-queue-manager.ts`,
  `bull-processor.ts` and `modules/platform/background/queue-manager.interface.ts`. It has no
  producers. Update `runtime-metrics` and `worker-concurrency`, which list it. **Check the
  homeserver's Redis before merging**: an existing `bull:background-jobs:*` key set is harmless
  but should be noted.
- The ~19 unused constructor dependencies (and their positional spec mocks), and the orphan files
  (`legacy-exemption-policy.ts`, `orphan-objects.cli.ts` if confirmed unused).

### 2.5 Canonical constants (same output, one definition)
- `'Asia/Kolkata'` and hard-coded `+05:30` → `BUSINESS_TIME_ZONE` from shared (7 places,
  including one in SQL).
- One `logoUrl()` helper instead of ~26 template strings.
- One `roleNames()` helper instead of the 26 copies of the role-name idiom.
- `uploadMulterOptions()` used by the two assayer controllers that rebuild it by hand.

**Exit criteria**
- [ ] No controller declares a class other than itself
- [ ] `modules/assayer` root holds ≤ 6 files; everything else is in a named sub-folder
- [ ] `recommendation.engine.ts` is a re-export only
- [ ] Dead queue and unused injections removed
- [ ] G1, G3 and G5 show **zero diff**; G2 boots; G6–G8 green
- [ ] Tag `reorg-p2` → `test` → `main`

---

## Phase 3: Frontend relocation (pure moves)

Start by merging `test` into the branch. Other sessions stay paused in `packages/frontend`.

### 3.1 Target layout
```
src/
  app/          App.tsx, routes, providers, queryClient, shell (Layout, Header, Sidebar,
                ProtectedRoute, ErrorBoundary, SearchOverlay, NotificationDropdown)
  features/
    work/       inbox, planning, scheduling, assignments (they're tabs of one screen today)
    workforce/  the whole of pages/hr (roster, record, hiring, registration wizard, pay)
    billing/  clients/  branches/  projects/  documents/  data-entry/  users/  admin/
    registration/  (the public candidate flow + account setup)
    notifications/  feedback/  executive/  account/  dashboard/
  components/ui/  the shared kit only (Modal, DetailDrawer, DataTable, Select, StatusBadge, …)
  lib/          api client, errors, http, query keys, invalidation, formatters, socket, session
  config/       pure configuration only (no network I/O)
```
Each feature folder follows the same shape: `pages/`, `components/`, `hooks/`, `api.ts`,
`types.ts`.

### 3.2 Moves
- Move each flat parent page into its feature (Clients, Billing, PlanningWorkspace, Documents,
  Assignments/Inbox/Scheduling → `work/`, Users, ExecutiveMap, Settings → `account/`,
  PublicRegistration/AccountSetup → `registration/`, Rules/TransportCosts → `admin/`).
- Move page-local hooks into their feature. Move domain widgets out of `components/` into the
  feature that owns them (TravelEvidence, GeoPrecisionBadge, InteractivePlanningMap, …).
- Update the lazy-import paths in the routes, the 214 relative `jest.mock` paths, and the 17
  file-reading specs (already made safe to move in Phase 0).
- `config/registration-options.ts` does network I/O → move it to `features/registration/api.ts`.

### 3.3 API calls into service files (same requests, byte-for-byte)
- Create `features/<f>/api.ts` for the domains that call `api.request` from pages: workforce (88),
  admin (43), data-entry (28), users (19), projects, branches, documents, scheduling, zones,
  holidays.
- Each function wraps exactly the call it replaces: same path, method, body and options.
  Pages then call the function.
- Model: `services/billing.ts` + `hooks/useBilling.ts`.
- Specs that mock `services/api` keep working, because the new functions still call it.

### 3.4 Query keys
- Register the 74 inline keys in `lib/queryKeys.ts` with the **identical** arrays, so every cache
  entry and invalidation behaves the same. Wiring them into socket invalidation changes
  behaviour, so that is Phase 6.

### 3.5 Dead code
- `hooks/useExcelExport.ts` and `hooks/usePlatformLimits.ts` (no importers).

**Exit criteria**
- [ ] No page file at `src/pages/*.tsx`; every screen lives under `features/`
- [ ] No `api.request(` in any file under `features/*/pages` or `features/*/components`
- [ ] No inline query-key arrays outside `lib/queryKeys.ts`
- [ ] G4 and G5 show **zero diff**; G6–G8 green (G7: click every sidebar entry as each role)
- [ ] Tag `reorg-p3` → `test` → `main`

---

## Phase 4: One source of truth where the copies already agree

### 4.1 Route manifest
- One `app/routes.ts` entry per screen: path, lazy component, label, sidebar category, icon,
  permission, breadcrumb. App, Sidebar, Header breadcrumbs and `workTabs` read from it.
- `ROUTE_PERMISSIONS` stays a literal array in `config/route-permissions.ts`, because two backend
  specs and one acceptance script parse that file as text. A unit test asserts that it equals
  what the manifest derives.
- **Owner decision before merge:** the Sidebar and Header already disagree on the category of
  Platform Settings and Service Logs. Pick one.
- Remove the stale entries for redirect-only paths.

### 4.2 Web ↔ mobile shared types (type-only)
- Move into `packages/shared`:
  - the self-registration API types (`RegistrationPincodeLookup`, `RegistrationIfscLookup`,
    `RegistrationApplication`, the hydrate/OTP/draft types). Web's `consentWithdrawnAt` field
    becomes optional on the shared type, so neither side changes.
  - `RECORD_KEYS`, `NotificationPreference`, and the rejection-reason codes.
- Mobile rebuilds shared first. That already happens in `eas-build-post-install`.

### 4.3 Shared package tidy-up
- Sub-folders behind the same barrel (`domain/`, `validation/`, `labels/`, `time/`, `money/`,
  `registration/`, `api/`). No consumer imports past `index.ts`, so nothing else changes.
- `tsconfig`: exclude `*.spec.ts` from the build, and clean the stale `dist` files.

### 4.4 Mobile API client
- Split `mobile/src/services/api.service.ts` (2,406 lines) into `api/http.ts` (base URL,
  `fetchWithAuth`, timeout), `api/session.ts` (restore, refresh, revoke), and one file per
  domain.
- `MobileApiService` stays as a facade that delegates, so its 27 callers are untouched.
- `chunk-upload-contract.spec.ts` anchors on a text line; keep that line in whichever file ends
  up holding the upload code.

**Exit criteria**
- [ ] Adding a screen means editing one manifest entry (plus the literal permission line)
- [ ] No type is declared on both web and mobile
- [ ] `api.service.ts` ≤ 200 lines (the facade)
- [ ] G1–G8 green, zero diff
- [ ] Tag `reorg-p4` → `test` → `main`

---

## Phase 5: Split the oversized files (highest value, highest risk)

One file per pull request. Before each split, write **characterization tests** that pin the
file's current observable behaviour, then split behind an unchanged public surface.

### Backend (split behind a facade: the public class and method signatures stay the same)
| File | Lines | Split into |
|---|---|---|
| `assayer.service.ts` | 5,520 | lifecycle · credentials & app access · workforce attributes · commercial profile · live tracking · roster read · CRUD |
| `assignment.service.ts` | 4,834 | create · transitions · reassignment · attendance (check-in/out) · SLA sweeps · queries & dashboards · travel verification |
| `billing-engine.service.ts` | 3,843 | booking/repricing · payables · invoices · payments · statements & reports · overview |
| `assayer.controller.ts` | 3,286 | one controller per sub-resource (documents, workforce-attributes, commercial, references, qualification, roster, lifecycle, app-access, location) |
| `registration-application.service.ts` | 2,543 | invites & tokens · OTP · drafts · consent · documents · review/approve |
| `roster-records.service.ts`, `project.service.ts`, `document.service.ts` | ~2k each | by the method groups in the audit |

- The facade keeps the old class name and delegates, so controllers, other modules and the
  positional spec mocks keep working. Retire it only after all callers move to the new services.
- `persistence-boundary` and `lifecycle-authority` pin file paths; update them in the same PR.

### Layer fixes (backend)
- Out of `infrastructure/`, into feature modules: `scheduler/*` (SLA scanner, email digest),
  `scope/scope.controller.ts`, `data-reset/*`, `ocr/*` (with `src/workers/ocr.worker.ts`), and
  the two assayer redaction interceptors.
- Into `infrastructure/`: the geo HTTP clients, the Docker log client, the Excel and PDF writers,
  and upload validation.
- Add an ESLint import-boundary rule (`core` and `infrastructure` may not import `modules`,
  except through an explicit allow-list), so the layering stays fixed.

### Frontend and mobile
- `PlanningWorkspace` (3,582), `EmailTemplatesSection` (3,229), `PublicRegistration` (2,733),
  `AssayerVettingTab` (2,038), `AssayerRecord` (1,926), mobile `ProfileScreen` (1,790) and
  mobile `App.tsx` (1,412).
- Split into child components plus a state hook. The page keeps its route, props and rendered
  output. `self-editable-fields.spec.ts` slices `ProfileScreen.tsx` between two markers; keep
  those two exports together.

**Exit criteria**
- [ ] No non-generated, non-migration source file over ~800 lines
- [ ] Every split has characterization tests that passed before and after
- [ ] Import-boundary lint rule on, with zero violations
- [ ] G1–G8 green, zero diff
- [ ] Tag `reorg-p5` → `test` → `main`

---

## Phase 6: Merges that change output (owner decides each, one at a time)

These are real duplicates, but the copies **disagree**, so merging them changes what someone
sees or receives. Each item is its own PR with a before/after screenshot or payload diff:
- Status colours that conflict with `status-registry` (billing UNBILLED and CANCELLED, schedule,
  lifecycle, notification categories) and web vs mobile tones.
- Date formatting: server-local vs India time helpers; the `billing/shared.fmtDate` one-day shift.
- The four pincode resolvers and the six place-name normalisers (their suffix lists differ).
- The two push-notification paths; the two `normalisePhone` functions (different outputs).
- Socket invalidation for the 74 newly registered query keys, and removing the page-local socket
  listeners.
- Inline styles → the UI kit (possible visual regressions).
- Module merges: `validation-query` + `calls`, `assayer-remarks` into `assayer`, break up
  `platform/*`.

---

## Risks and how each is handled

| Risk | Handling |
|---|---|
| Moving a file quietly weakens a guard spec | Phase 0 makes scanners assert non-empty scans and existing allow-list paths |
| DI breaks at runtime though tsc passes | G2 boots the compiled backend in CI and diffs the live route table |
| An entity move changes the schema | G3 `migration:generate --check` must be empty |
| Merge conflicts with feature work on `test` | Short phases; merge `test` in at the start of each; sessions paused per area |
| Auto-deploy rebuilds unexpectedly | Lockfile, Dockerfile and compose changes are listed per phase; docs-only phases never deploy |
| Production data | Phases 0–5 add no migrations; G3 enforces it |
| A phase goes wrong after merging | Each phase is one tagged merge; revert that merge on `test`/`main` |

## Handover notes

Read the server's current values as fingerprints only, and compare them with the leaked ones
listed in 0.1:

```bash
# EC2 (Ubuntu)
cd /var/www/html/fapoms && for k in DB_PASSWORD JWT_SECRET; do v=$(sudo grep -E "^${k}=" .env.docker | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//" | tr -d '\r\n'); printf '%s %s\n' "$k" "$(printf '%s' "$v" | sha256sum | cut -c1-12)"; done
```
```bash
# Homeserver (AlmaLinux)
cd ~/apps/fapoms && for k in DB_PASSWORD JWT_SECRET; do v=$(grep -E "^${k}=" .env.docker | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//" | tr -d '\r\n'); printf '%s %s\n' "$k" "$(printf '%s' "$v" | sha256sum | cut -c1-12)"; done
```

## Log

- 2026-09-21: Audit completed (backend, web/mobile/shared, repo/ops). `main` and `test` synced
  to `da66725c`: CI had been red on `test` since the billing overhaul because
  `billing-overview-region-scope.db.spec.ts` predated the new unbilled/in-claim-review fields.
  Fixed in `da66725c`. Branch `refactor/reorganization` created from it.
- 2026-09-25: Merged `test` (= `main`, `349634d5`, 19 commits) into the branch before starting
  Phase 0. No conflicts. The file counts and line numbers quoted above are from the 2026-09-21
  audit; each phase re-measures its own area before moving anything.
- 2026-09-25: Phase 1 documentation pass. Moved the 10 flat `docs/*.md` files into
  `architecture/`, `operations/` and `reference/` by content, dated the incident report into
  `reports/2026-09-09-incident-audit-truncate.md`, and moved `deploy/nginx/fapoms.conf` (nothing
  deploys it) to `docs/operations/reference-nginx-fapoms.conf`. No `docs/adr/` was created: no ADR
  files exist anywhere in the repo yet, despite this plan describing one. Added
  `docs/README.md` (full index) and `docs/operations/environments.md` (branch → host → compose →
  migrations → deploy/backup/restore, each fact cited to the file it was verified against).
  Rewrote DEPLOYMENT.md's "Deploy" section, which pointed at the root dev compose file and printed
  `admin`/`admin123`, to match `setup.sh` + `deploy/docker-compose.prod.yml` without printing a
  password. Updated README.md's CI/Deployment/Documentation sections (CI's real trigger list and
  `database` job, both deployments, links to the new index) and `deploy/aws/README.md` (documented
  the "mounted" layout the EC2 box actually runs, alongside the "bootstrap" layout the rest of that
  doc describes). Appended a "This project" section to CLAUDE.md, keeping the existing AWS/Secret
  Safety content verbatim, and added CONTRIBUTING.md and SECURITY.md. Confirmed
  `screenshots/` and `docs/discovery/screenshots/` are referenced nowhere but this plan and
  removed both (`git rm -r`). Updated every non-doc file that referenced a moved path by string
  (CODEOWNERS, `.env.production.example`, `deploy/docker-compose.prod.yml`, backend `seed.ts` /
  `main.ts` / `security-controls.spec.ts`, `setup.sh`, four `scripts/acceptance/*.mjs` files,
  `packages/shared/src/coverage.ts`) and re-grepped every old path repo-wide to confirm zero
  stale references remain outside this plan's own historical text.
