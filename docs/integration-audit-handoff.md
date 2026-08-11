# Integration audit — handoff items (not fixed in the audit pass)

These are the confirmed defects from the full-stack integration audit that were **deliberately not
changed** because they either live in the concurrent effort's uncommitted files (mobile auth) or need a
runtime environment to change safely (timezone). Each entry is precise enough to action directly.

## 1. Mobile auth lifecycle (HIGH) — owner: mobile effort (files are mid-flight)

All in `packages/mobile` (`AuthContext.tsx`, `App.tsx`, `services/api.service.ts`) + one backend change.

- **`mustChangePassword` gate bypassed on session-restore and biometric login.**
  `AuthContext.tsx:96-99` (restore) and `:218-225` (biometric) build the user with only `{id,name}` — no
  `mustChangePassword` — so the `App.tsx:671` gate never fires. Backend compounds it: biometric-login
  (`auth.controller.ts:155-163`) omits the flag while password-login (`:129-133`) includes it.
  **Fix:** (a) add `mustChangePassword` to the biometric-login user payload server-side; (b) set it in
  `biometricLogin` from `res.user.mustChangePassword`; (c) in `initSession`, carry it from the
  `/assayers/:id/profile` body `validateSession` already fetches. Otherwise an assayer on a seeded/HR-reset
  shared password does GPS check-ins and uploads audit packets under that shared credential.
- **Logout never revokes the server refresh token.** `AuthContext.logout` (`:258-267`) only wipes local
  state; there is no `POST /auth/logout` call anywhere in mobile. **Fix:** add `MobileApiService.logout()`
  → `POST /auth/logout` (best-effort, before clearing local state), await it from `AuthContext.logout`.
  Matters on shared handsets / "sign in as someone else".
- **Check-in shows "Bad Request" instead of the actionable message.** `api.service.ts:1073-1077` returns
  `resData.error` ("Bad Request"); the useful "Turn on location…" text is in `resData.message`.
  **Fix:** read `resData.message ?? resData.error` (the array-join pattern already used in
  `changeOwnPassword`).
- **Hardcoded fabricated values.** `api.service.ts:998` falls back to `15` customers; `App.tsx:1103`
  seeds the negotiate modal at `₹1800`. Both look like real data on a fee-decision screen. **Fix:** carry
  `null` when unknown and label "count pending" / drive the modal from real `proposedFee`.
- **Dead controls:** `ProfileScreen.tsx:432` `preferredRadius` is editable but never saved (not in the
  backend `SELF_EDITABLE_FIELDS`); `verifyAssayerIdentity`/`onVerifyIdentity` is wired but never called;
  `uploadGovernmentDocument` has no caller. Either wire or make read-only/remove.

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
and `documents/stats/summary`; and the `getPricingQuote` wrapper (whose `branchId` field the backend
`QuoteRequestDto` would reject under `forbidNonWhitelisted`). These are the most compute-heavy planning
endpoints — likely future/mobile WIP. **Decide surface-vs-remove; do not delete blind.**

---

Everything else the audit found **was fixed** on the branch (see the session summary / commits): the
assayer password-reset data loss, the assignment-transition access-control hole, staff-directory
truncation, the Field-Issues false all-clear, disburse gating, docs-overview 403, scheduling route order,
project actor-id, bulk-toast garble, clarification-attachment signing, Command-Center role drift, the
`/assayers/:id` gate, per-role write-button gating on Assignments/Scheduling, the global-search→Clients
deep-link, and the `Expense*`/`negotiationCount`/`COUNTER_OFFER` contract cleanups.
