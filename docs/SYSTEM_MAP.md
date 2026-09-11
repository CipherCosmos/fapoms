# FAPOMS system map

Ground truth for the final certification, assembled from the code on `41f60beb`. Where a document
and the source disagreed, the source won and the disagreement is recorded in the last section.

Nothing here is invented. Every claim names the file that backs it.

---

## 1. Roles and authorization

**Nine roles**, `packages/shared/src/enums.ts:166`:
`DEVELOPER, ADMIN, OPERATIONS, DESK, DESK_OPERATOR, AUDITOR, PRODUCT_SUPPORT, ASSAYER, CLIENT_USER`.
A legacy 13-role mapping survives as `LEGACY_ROLE_ALIASES` (:247).

**One implication only**, `packages/shared/src/role-hierarchy.ts`: `DEVELOPER ⇒ {ADMIN,
PRODUCT_SUPPORT}`, one-way. The two-person rule is encoded in the grant asymmetry rather than in a
check: `ADMIN` holds `SYSTEM:APPROVE:PLATFORM`, `DEVELOPER` holds `SYSTEM:VIEW/EDIT:PLATFORM`, and
**no role holds both halves**.

**Vocabulary**: `PermissionAction` (:264), `PermissionResource` (:291), `AuthorizationScope` (:344).
**Canonical grants**: `packages/backend/src/modules/auth/role-permissions.ts`. `ASSAYER` and
`PRODUCT_SUPPORT` deliberately hold **zero** grants.

**Guards**, all in `packages/backend/src/modules/auth/guards.ts`:

| decorator | meaning |
|---|---|
| `@Roles(...)` | deny-by-default when absent |
| `@AnyAuthenticated()` | explicitly open to any signed-in principal |
| `@RequirePermissions(...)` | re-checked unconditionally by `PermissionsGuard`, not only as a fallback |
| `@RoleOnly()` | kills the custom-role fallback — **29 routes across 9 controllers** |
| `@RolesFallbackPermissions(...)` | fallback perms for routes whose `@Roles` includes `ASSAYER` |
| `@AllowPermissionFallback()` | opts a `@Roles` route into fallback using its own permissions |

`@GlobalScopeFilter` (`infrastructure/scope/global-scope.ts`) is a **param decorator, not a guard**.
Project, client, zone and state are conveniences; **only `region` is enforced** against
`users.regions`, and an unrecognisable assignment throws rather than widening to unrestricted.

---

## 2. Screens

**59 declared route patterns** in `packages/frontend/src/App.tsx`; `config/route-permissions.ts`
declares 32 entries and the rest inherit by longest-prefix match.

Pages offered per role, and it is very uneven:

| role | pages |
|---|---|
| DEVELOPER | all — the only role that can open `/admin/logs` |
| ADMIN | all except `/feedback` and `/admin/logs` |
| OPERATIONS | 25 |
| AUDITOR | 15 |
| DESK | 11 |
| DESK_OPERATOR | 10 |
| PRODUCT_SUPPORT | 3 |
| CLIENT_USER | 3 |
| **ASSAYER** | **2, and the sidebar is empty** — field staff belong in the mobile app |

**Not reachable by clicking the sidebar**, so any nav-driven walk misses them: `/settings` and
`/notifications` (header only), the feedback composer (present on every screen), the `/hr` and
`/data-entry` tab children, 3 of the 4 Audit Work tabs, `/data-entry/case/:branchId`,
`/billing/statement`, `/hr/register`, `/view-mark`, the five redirect shims, the ten `/hr` legacy
paths the backend worklist hands out as links, and every `?section=` / `?tab=` / `?group=` surface.

**There is no form library.** No react-hook-form, no zod, no yup, no formik. Every check is
hand-written `useState`. The shared rulebook (`packages/shared/src/identity-validation.ts`,
`upload-limits.ts`) is the same code the API's decorators run, but on screen most PAN, IFSC and
Aadhaar checks are **advisory hints that never block submit**. Only
`pages/hr/registration/steps.ts` maps a server 400 back to a field.

---

## 3. State machines

**Assayer lifecycle** — `packages/shared/src/assayer-lifecycle.ts:21`:

```
INVITED                 → DOCUMENT_VERIFICATION, ARCHIVED
DOCUMENT_VERIFICATION   → BACKGROUND_VERIFICATION, INACTIVE, ARCHIVED
BACKGROUND_VERIFICATION → TRAINING, INACTIVE
TRAINING                → ACTIVE, INACTIVE
ACTIVE                  → ON_LEAVE, SUSPENDED, INACTIVE, RESIGNED
ON_LEAVE                → ACTIVE, INACTIVE
SUSPENDED               → ACTIVE, TERMINATED      (ACTIVE→TERMINATED is illegal by design)
INACTIVE                → ACTIVE, ARCHIVED
RESIGNED                → INVITED, ARCHIVED       (rehire restarts onboarding)
TERMINATED              → INVITED, ARCHIVED
ARCHIVED                → terminal
```

Four writers reach `lifecycle_status` **without** going through this map: the bulk walk,
`DELETE /assayers/:id` (reaches ARCHIVED from any state), the recovery reset-onboarding-stage, and
the empanelment upsert. `scripts/acceptance/lifecycle-bypass.mjs` exists to watch all four.

**Assignment** — `packages/backend/src/modules/assignment/assignment.state-machine.ts:6`:

```
PENDING     → ACCEPTED, REJECTED, CANCELLED
ACCEPTED    → ACCEPTED, CHECKED_IN, COMPLETED, CANCELLED
CHECKED_IN  → CHECKED_IN, ACCEPTED, IN_PROGRESS, COMPLETED, CANCELLED
IN_PROGRESS → IN_PROGRESS, CHECKED_IN, COMPLETED, CANCELLED
COMPLETED   → terminal; only reopen() leaves it, → ACCEPTED
REJECTED    → PENDING
CANCELLED   → terminal
```

Completing without a check-in demands a stated reason. Three status **sets** carry the real
distinctions (`assignment-workload.ts`): `COMMITTED` (capacity, no PENDING), `IN_FLIGHT` (+PENDING,
backs the day-exclusivity index), `ENGAGED` (+COMPLETED, "branch busy").

**Empanelment has no state machine.** Eight values, a CHECK constraint, and exactly one behavioural
guard: reversing a REJECTED empanelment requires a written reason. `PUT` is otherwise a free-form
upsert. This is a recorded, accepted product decision, not an oversight.

**Money** is enforced imperatively in `billing-engine.service.ts`, not from a table. The dead-state
vocabulary lives in `packages/shared/src/billing-liveness.ts` — `VOIDED` payables and `CANCELLED`
billing entries are dead, written as "not dead" so a new status is live by default.

---

## 4. Invariants the code actually enforces

| invariant | where |
|---|---|
| Segregation of duties — booker ≠ approver ≠ payer, refusals audited, never fails open | `billing-engine.service.ts:3604` |
| One open assignment per project-branch | unique index, migration `1796200000000` |
| One assignment per assayer per day | unique index, migration `1796300000000` |
| One current owner per assignment | partial unique index on open ownership |
| One **live** payable and one **live** client line per assignment | partial unique indexes, migration `1798000000000` |
| Payout destination frozen at approval, and a verification claim must have evidence behind it | `payout-destination.ts` + CHECK constraints, migrations `1797300000000`/`1797600000000` |
| Audit append-only | row trigger, migration `1794000000000` — no table ownership defeats it |
| Audit hash chain in a separate append-only table | migration `1795100000000`, `core/audit/hash-chain.ts` |
| Idempotency by `clientRequestId`; replay with a different body is a 409 | `assignment.service.ts:416` |
| Optimistic concurrency — `expectedVersion` mismatch is a 409 either direction | `assignment.service.ts:1252` |

---

## 5. Background processing

The outbox carries "this audit is finished" to the ledger: 15 attempts roughly a minute apart, then
a dead letter that only `DEVELOPER` can list or replay. 13 Bull queues; 10 repeatable schedules
across 7 of them. Two different things are called "the reconciler": the **schedule** reconciler is a
plain interval that re-converges repeat keys, the **billing** reconciler books legs that were never
booked.

**What dies with the worker**: the outbox drain, and therefore
`assignment:status-changed → bookAssignment → the payable and the client line`. Also audit sealing,
retention, the SLA scan and digest, document auto-dispatch, geo backfill, notification sweep,
reports and imports. An api-only deployment processes none of it.

---

## 6. Cross-workflow edges

These are the consequences the certification has to follow, traced in code:

- **SUSPENDED cascades nothing**, deliberately. Only `RESIGNED` and `TERMINATED` count as departure.
  Exclusion is by read-side predicates, not by cascade — "not right now", not "not any more".
- **RESIGNED / TERMINATED** sets exit dates if absent without overwriting HR's, closes ACTIVE and
  RECOMMENDED empanelments, and raw-cancels in-flight assignments while bumping `entity_version`.
  Counts land in one aggregate audit row. **No per-assignment audit row is written** — open finding.
- **ARCHIVED** additionally sets `is_active = false`, which hides the row from the ordinary reader.
- **Assignment COMPLETED** publishes an event that becomes the payable and the client line via the
  worker, and closes the branch to further assignments.
- **Assignment REOPENED** voids the payable and cancels the client line; because the indexes and
  reads are liveness-filtered, re-completion books fresh rows.
- **Bank or IFSC changed** invalidates the passbook evidence and clears `identity_verified_at`, so
  the next payout records a null verification claim rather than a false one. Already-frozen rows are
  untouched — that is the point of freezing.
- **Document replaced** supersedes the prior version, resets verification to pending, and cannot
  release the stored object of a version that is still VERIFIED.

---

## 7. Where the documents disagree with the code

Recorded because reports cite these numbers, and several are cited wrongly.

| claim in docs | what the source says |
|---|---|
| 22 `@RoleOnly()` routes | **29**, across 9 controllers |
| CI runs "the six self-contained" db specs | the regex names **seven** |
| a 150-cell lifecycle matrix | **121** ordered pairs (11 × 11) |
| go-live item 1.0 verifies via `scratchpad/pa/tds-pan.mjs` | that file **is not in the repo**, so the item cannot be executed as written |
| `scripts/acceptance/README.md` | documents **2 of 15** scripts, with a `DB_PORT` default that disagrees with every script |
| AC-F20 listed Open | its own cell says fixed, and the code has it |
| go-live §0 and §1 say do not go live | **all four blockers were closed after those docs were written** |

Two live definitions that are not what they appear to be:

- `packages/shared/src/state-machines.ts:185-204` — `BILLING_STATE_TRANSITIONS`,
  `INVOICE_TRANSITIONS` and `PAYABLE_TRANSITIONS` have **zero consumers**, and `PAYABLE_TRANSITIONS`
  omits `VOIDED` entirely while the enum, the CHECK constraint and `voidPayable()` all have it.
  The same file's own docblock warns that a dead definition is worse than no definition.
- `packages/shared/src/assayer-lifecycle.ts:214-236` documents, in its own comment, that **ACTIVE is
  still a bulk waypoint**, so a bulk `INVITED → SUSPENDED` walks through an unearned activation and
  writes all four hops. It appears in **no findings ledger**.
