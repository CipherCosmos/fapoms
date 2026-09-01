# ADR-006 — Retire the standalone audit lifecycle (`modules/audit` + `modules/audit-history`)

- **Status:** Accepted & executed 2026-08-09 on branch `feat/real-time-sync` (backend build green;
  reversible via git — review before merge; heads-up to the billing/Track-B owner still advised)
- **Date:** 2026-08-09
- **Supersedes context:** corrects Part A of the surface-consolidation assessment
  (`docs/surface-consolidation-assessment.md`, deleted 2026-09-01 — this ADR is what survived of it)

## Context

The surface-consolidation assessment originally listed `modules/audit` and
`modules/audit-history` as **dead code to delete**. A pre-deletion verification pass (the reason
this ADR exists) found that framing was wrong in *both* directions, and the truth is more useful
than either:

- The modules are **not broken/dead** — `AuditService.startAudit/closeAudit` contain real,
  working logic, are registered in `app.module.ts`, and their `audit:started/closed` events are
  consumed by `modules/realtime/events.gateway.ts:393`.
- But they are **not something to integrate**, either. They are a **redundant parallel model** of
  a flow the system already runs, end to end, through a more robust path.

### The live path already does everything the audit lifecycle does

When an assignment transitions to `COMPLETED` (`modules/assignment/assignment.service.ts:618–663`):

| Concern | Live assignment path | `modules/audit` `closeAudit` |
|---|---|---|
| Completion record | `AssignmentStatus.COMPLETED` + schedule row COMPLETED, **in one DB transaction** | a separate `audits` row (`status='CLOSED'`) |
| Branch progression | `ProjectBranchStateMachine.completeAudit` → `AUDIT_COMPLETED` | none |
| Assayer payable | `assignment:status-changed` emitted via the **transactional outbox** → billing auto-bill listener → `syncPayableForAssignment` (idempotent, Redis-locked, crash-safe) | direct `billingEngine.syncPayableForAssignment` call (same idempotent op, but no outbox guarantee) |
| Audit-log trail | `auditService.recordEventSafe(...)` | none |

Both call the **same idempotent** `syncPayableForAssignment` (`billing-engine.service.ts:615`), so
the audit path books no money the assignment path doesn't already book. The `audits` table is a
second, weaker copy of completion state that can **drift** from `AssignmentStatus`.

The `AuditController` routes (`POST /audits/start`, `/audits/:id/close`) have **no** frontend or
mobile caller (grep across `packages/frontend`, `packages/mobile`) — the parallel model was never
wired to a UI, because the assignment flow made it unnecessary. This is consistent with the intent
recorded in migration `1786300000000-UnifyBillingEngine.ts`.

## Decision

**Retire** `modules/audit` and `modules/audit-history`. Do **not** integrate them (integration would
institutionalize a drifting second source of truth for audit completion and payables).

## Consequences / execution checklist — all done on `feat/real-time-sync`

1. **Confirmed no external poster** to `/audits/*` — grep across `packages/frontend` + `packages/mobile`
   is clean; the routes had no UI caller. ✅
2. **Removed** `AuditPlatformModule` + `AuditHistoryModule` imports and array entries from
   `app.module.ts`, then deleted `modules/audit/*` and `modules/audit-history/*`. ✅
3. **Realtime gateway** (`events.gateway.ts`): dropped the now-unreachable `audit:started` /
   `audit:closed` cases — no emitter remains. Assignment/branch events already drive the UI. ✅
4. **Tables:** migration `1787800000000-DropRetiredAuditLifecycle.ts` drops `audits`,
   `audit_history`, `audit_evidence` with `IF EXISTS` (they were only ever created by dev-time
   `synchronize`, never by a migration). The live `core/audit` log is untouched. ✅
5. **Billing-engine:** unchanged — still driven by `assignment:status-changed`. The audit module was
   its only *other* caller (`billing-engine.service.ts:266/538` are internal sync loops;
   `audit.service.ts:88` was the removed path). ✅
6. **Tests:** `audit.service.spec.ts` was deleted with its module dir; a full backend suite run
   (`--forceExit` per the known open-handle teardown quirk) is the remaining verification step.
7. **Backend `nest build` is green** after all of the above. ✅

**Post-merge note:** verify a full `jest --forceExit` run before merge, and give the billing/Track-B
owner a heads-up since the change lives in backend files they also touch.

## Why this is the industry-standard outcome

The value delivered here was **not** a deletion — it was catching that an item labelled "dead, delete"
was actually a redundant parallel model whose *removal* is right but whose *blind removal* (or, worse,
*integration*) would have been wrong. The disposition is now evidence-backed and reversible on review,
and no money-touching code was changed on assumption.
