# Integration audit — handoff items (not fixed in the audit pass)

These are the confirmed defects from the full-stack integration audit that were **deliberately not
changed** because they either live in the concurrent effort's uncommitted files (mobile auth) or need a
runtime environment to change safely (timezone). Each entry is precise enough to action directly.

> **Triaged 2026-09-01.** Every item in §1 was re-checked against current source. What was fixed has
> been struck from the list so that what remains is real work. Three items are still open.

## 1. Mobile auth lifecycle (HIGH) — owner: mobile effort

All in `packages/mobile` (`AuthContext.tsx`, `App.tsx`, `services/api.service.ts`) + one backend change.

**Still open:**

- **Biometric login still omits `mustChangePassword` server-side.** The client half is done —
  `AuthContext.tsx:145,159` now carries the flag through session-restore — but
  `auth.controller.ts` `biometricLogin` returns a user of
  `{id, username, name, email, phone, status}` with no `mustChangePassword`, while password-login
  includes it. So the flag survives a restore and is lost on a biometric unlock.
  **Fix:** add `mustChangePassword: result.user.mustChangePassword` to the biometric-login payload.
- **Logout never revokes the server refresh token.** `AuthContext.logout` only wipes local state;
  there is still no `POST /auth/logout` call anywhere in mobile. **Fix:** add
  `MobileApiService.logout()` → `POST /auth/logout` (best-effort, before clearing local state), await
  it from `AuthContext.logout`. Matters on shared handsets / "sign in as someone else".
- **Two dead controls remain.** `ProfileScreen.tsx:1168` edits `preferredRadius`, which is **not** in
  the backend `SELF_EDITABLE_FIELDS` (`assayer.controller.ts:98`) — the save is rejected, so the field
  looks editable and silently is not. `uploadGovernmentDocument` (`api.service.ts:1443`) still has no
  caller. Either wire them or make them read-only / remove.

**Fixed since the audit** (verified 2026-09-01, no action needed):

- ~~`mustChangePassword` dropped on session-restore~~ — carried in `AuthContext.tsx:145,159`.
- ~~Check-in shows "Bad Request" instead of the actionable message~~ — `api.service.ts:1362` now reads
  `resData.message || resData.error`.
- ~~Hardcoded fabricated values (`15` customers, `₹1800` negotiate seed)~~ — both removed;
  `App.tsx:1037` documents why the `|| 1800` fallback had to go.
- ~~`verifyAssayerIdentity` wired but never called~~ — now called from `AuthContext.tsx:330`.

## 2. Date-only convention off-by-one (HIGH) — WEB + BACKEND FIXED; mobile remains

Added to `@fapoms/shared`: `formatDateOnly` (renders a `YYYY-MM-DD` at local midnight, no UTC-parse
shift) and `businessDateKey`/`businessTodayDateKey` (`Asia/Kolkata`, independent of server TZ).

- **Fixed (web):** `Scheduling.tsx` and `PlanningWorkspace.tsx` date-only renders now use `formatDateOnly`
  (timestamptz fields like `completedAt`/`completionDate` deliberately left on `toLocaleDateString`);
  `AssayerForms.tsx:239` default `joiningDate` now uses `todayDateKey()`.
- **Fixed (backend):** `operations-planning.service.ts:163` default `scheduledDate` and
  `document-dispatch.worker.ts:40,63` now use `businessTodayDateKey()`/`businessDateKey()` — no longer a
  day early for IST early-morning.
- **Fixed (mobile):** `ScheduleScreen.tsx:27`, `EarningsScreen.tsx:244`, `HomeScreen.tsx:277,331`,
  `AvailabilityModal.tsx:31` now use `formatDateOnly` (mobile `tsc --noEmit` clean). The mobile query
  `status` union (`types/mobile-app.ts`) is now sourced from the shared `ValidationQueryStatus` enum via a
  template-literal type, closing that drift too.
- Assumption baked in: business timezone = `Asia/Kolkata` (see `BUSINESS_TIME_ZONE`); confirm before
  relying on it for a multi-region deployment, and smoke-test with a machine clock set behind UTC. The
  timestamptz renders (paid dates, sync times, `completedAt`) were intentionally left on
  `toLocaleString`/`toLocaleDateString` — they carry a real time-of-day and are already correct.

## 3. Pagination envelope drift (MEDIUM) — canonical type FIXED; runtime shapes left as-is

`PaginatedResponse<T>` (`shared/api-contracts.ts`) previously declared a flat `meta` that **no** controller
returns; it had zero importers. **Fixed:** redefined to `meta: { pagination: PaginationMeta }` to match the
dominant real shape, so future code using the type is correct. The five live runtime shapes were **not**
changed (each is internally consistent with its one consumer; unifying them is a behavioral change that
needs per-endpoint runtime verification). One to watch: `validation-query.controller.ts:299` returns a
top-level `pagination` (sibling of `data`) — no current web consumer reads it, but a future copy of the
common `meta.pagination` pattern would read `undefined`.

## 4. Orphaned backend surface (INFO) — product decision before removing

No client caller found (web or mobile) for: `OrganizationController` (CRUD `/organizations`);
`CommunicationController`; a large slice of `planning.controller.ts` (`optimize`, `scenarios/simulate`,
`coverage-plan/*`, `control-center/*`, `execution/packages/*`, `field/*`); `documents/queue/data-entry`
and `documents/stats/summary`. These are the most compute-heavy planning endpoints — likely
future/mobile WIP. **Decide surface-vs-remove; do not delete blind.**

_Resolved 2026-09-01:_ the `getPricingQuote` client wrapper was **removed** — it had no caller and its
`branchId` field is not on the backend's `QuoteRequestDto`, so `forbidNonWhitelisted` would have
rejected the call had anyone made it. The `/pricing/quote` endpoint itself is untouched.

---

Everything else the audit found **was fixed** on the branch (see the session summary / commits): the
assayer password-reset data loss, the assignment-transition access-control hole, staff-directory
truncation, the Field-Issues false all-clear, disburse gating, docs-overview 403, scheduling route order,
project actor-id, bulk-toast garble, clarification-attachment signing, Command-Center role drift, the
`/assayers/:id` gate, per-role write-button gating on Assignments/Scheduling, the global-search→Clients
deep-link, and the `Expense*`/`negotiationCount`/`COUNTER_OFFER` contract cleanups.
