# ADR-007 — Fold `assessments` into `project_branches` under one status machine

- **Status:** **Superseded — not executed.** Kept for the reasoning, not as pending work.
- **Date:** 2026-08-09 · **Superseded:** 2026-09-01
- **Superseded by:** migration `1793900000000`-era work, specifically
  `1791900000000-AssessmentIsALink`, which solved the same problem a different way.

> **What actually happened.** This ADR proposed grafting `AssessmentStatus`'s document tail onto
> `ProjectBranchStatus` and dropping the `assessments` table. The shipped answer was narrower and
> cheaper: `AssessmentIsALink` established that the eighteen-state `status` column — along with
> `audit_date`, `assigned_assessor_id`, `agreed_fee`, `packet_size`, `coverage_flag`, `priority`,
> `zone_id` and `remarks` — was **write-only**. Nothing read any of it. So those columns were
> dropped and `assessments` was reduced to what it is actually for: a link a document can hang off
> for one project and one branch. No status machine had to absorb anything, and the facts that
> looked like they needed a new home already had one (`project_branches` for the audit date and
> packet count, `assignments` for the assayer and agreed fee, `documents.status` for the paperwork).
>
> Nothing below needs doing. Read it for the analysis of the dual-write, which was correct.

## Problem

There are two rows per real-world audit — one in `project_branches`, one in `assessments` — keyed on the
same `(project, branch)` and **dual-written in lock-step** (`project.service.ts:381-404`, `:608-633`),
with `syncAssessmentStatus` copying `auditDate`/`assignedAssessorId`/`agreedFee`/`coverageFlag` from the
assignment. `assessments` is ~85% redundant. It cannot be dropped losslessly **only** because
`AssessmentStatus` carries the **post-audit document-pipeline tail** that `ProjectBranchStatus` collapses
into three coarse states.

## Target: one unified status machine on `project_branches`

Keep `ProjectBranchStatus`'s operational head; graft `AssessmentStatus`'s document tail after
`AUDIT_COMPLETED`. `AssignmentStatus` and `ScheduleStatus` are unaffected here.

```
IMPORTED → PLANNING → CANDIDATE_SEARCH → CONTACT_INITIATED → NEGOTIATION
  → ASSIGNMENT_CONFIRMED → SCHEDULED → AUDIT_COMPLETED
  ── document pipeline (grafted from AssessmentStatus) ──
  → AUDITED_PDF_RECEIVED → SENT_TO_DATA_ENTRY → DATA_ENTRY_IN_PROGRESS
  → (CLARIFICATION_NEEDED ⇄) REPORT_FINALIZED → PENDING_HEAD_APPROVAL
  → DELIVERED_TO_CLIENT → CLOSED
  ── off-ramps (unchanged) ──  UNABLE_TO_COVER · ON_HOLD · CANCELLED
```

**Known crosswalk** (already encoded in `assignment.service.ts:48-50`, the migration's source of truth):

| ProjectBranchStatus | AssessmentStatus |
|---|---|
| `AUDIT_COMPLETED` | `AUDITED_PDF_RECEIVED` |
| `VALIDATION_COMPLETED` | `SENT_TO_DATA_ENTRY` |
| `CLOSED` | `COMPLETED` |

Assessment pre-audit states (`PENDING_PLANNING`, `ASSESSOR_RECOMMENDED`, `IN_NEGOTIATION`,
`ASSIGNED_AND_SCHEDULED`, `UNASSIGNED`, `AWAITING_CLIENT_DATA`, `CLIENT_DATA_RECEIVED`,
`PDF_GENERATED`, `READY_FOR_DISPATCH`, `DISPATCHED_TO_ASSESSOR`) map onto the existing
project-branch head (PLANNING…SCHEDULED); the document tail states are the only *new* enum members
`project_branches` gains.

## Execution plan (one reviewed PR, feature-flag the read path)

1. **Enum:** extend `ProjectBranchStatus` with the document-tail members. Add a `PROJECT_BRANCH_STATE`
   machine (allowed transitions) covering the grafted tail. Keep `AssessmentStatus` exported but
   `@deprecated` until step 6.
2. **Column:** migration adds any assessment-only columns still needed on `project_branches`
   (`agreedFee`, `assignedAssessorId`, `coverageFlag` already derivable — confirm each is not
   read independently before copying).
3. **Backfill migration:** for every `assessments` row, set `project_branches.status` to the tail
   state via the crosswalk (reverse of the table above) where the assessment is ahead of the branch;
   otherwise keep the branch status. Idempotent, `IF EXISTS`, dry-run count logged first.
4. **Writers:** delete the dual-write (`project.service.ts:381-404`, `:608-633`) and
   `syncAssessmentStatus`/`ASSESSMENT_STATUS_MAP`; all writes go to `project_branches.status`.
5. **Readers:** repoint every `assessments`/`AssessmentStatus` consumer (backend services + frontend
   status badges/labels) to the unified field. Grep inventory required before merge — this is the bulk
   of the work and the main risk surface.
6. **Drop:** once no reader remains, a final migration drops `assessments` (and the dead
   `assayer_audit_history` already retired in ADR-006). Remove the deprecated enum.

## Risk & why this is sign-off-gated

- **Irreversible data move.** The backfill rewrites core domain status; a wrong crosswalk mislabels
  live audits. Mitigation: dry-run counts, keep `assessments` read-only for one release before the
  step-6 drop (expand/contract).
- **Billing depends on these states** (`AUDIT_COMPLETED` drives payable booking). Any transition-map
  error can mis-trigger or suppress a payable. Mitigation: assignment→payable path is unchanged by this
  ADR; verify with the billing-engine suite before and after each step.
- **Concurrent backend edits** (another effort is in `validation.*` today). Coordinate the writer/reader
  changes to avoid clobbering.

## Findings from the pre-execution inventory (2026-08-09)

A full consumer sweep was run before touching code. It shows the cutover is **deeper than a status
repoint** — it is a re-architecture — and it establishes hard preconditions:

- **Blast radius:** `AssessmentStatus` appears **112 times across 11 files**; `AssessmentEntity` /
  `assessments` is referenced in **~20 files**.
- **Four FK owners must be re-homed** from `assessments` to `project_branches`, not just re-read:
  `assignment.entity` (`assessment` relation), `document.entity`, `validation-case.entity`,
  `call-log.entity`. Each has a migration + a service that reads through it.
- **The document pipeline owns states `project_branches` does not have.** `document.service`,
  `document-dispatch.worker`, and `document.controller` advance the post-audit tail
  (`PDF_GENERATED → READY_FOR_DISPATCH → DISPATCHED_TO_ASSESSOR → … → DELIVERED_TO_CLIENT`). Folding
  means these must drive `project_branches.status` on the extended enum — a behavioral re-home, the
  real work and the real risk.
- **Net-new `ProjectBranchStatus` members** to add (the granularity PB lacks): `PDF_GENERATED`,
  `READY_FOR_DISPATCH`, `DISPATCHED_TO_ASSESSOR`, `DATA_ENTRY_IN_PROGRESS`, `CLARIFICATION_NEEDED`,
  `REPORT_FINALIZED`, `PENDING_HEAD_APPROVAL`, `DELIVERED_TO_CLIENT`. `AUDITED_PDF_RECEIVED`,
  `SENT_TO_DATA_ENTRY`, `COMPLETED` have PB near-equivalents per the crosswalk.
- **Exhaustive-map ripple:** adding those members breaks every `Record<ProjectBranchStatus, …>` at
  compile time — `ASSESSMENT_STATUS_MAP` (`assignment.service.ts:40`, billing-adjacent), the
  `state-machines.ts` transition table, and `labels.ts`. Mechanical but touches the billing path.
- **Backfill is not behavior-neutral.** Setting `project_branches.status` to a tail state changes how
  *existing* PB-status readers (e.g. the `terminalBranchStatuses` guard) interpret the row. So the
  backfill belongs in the **contract** phase (behind the reader cutover), **not** the additive expand
  phase — correcting this ADR's earlier optimism.

## Preconditions (all required before executing — not met in the current session)

1. A **runtime/integration test** environment. This change lands on `AUDIT_COMPLETED` (payable trigger)
   and the document dispatch flow; compile-checking alone is insufficient. None is available here.
2. A **clean backend working tree.** `validation.service.ts` — a required reader — currently has another
   effort's **uncommitted** changes; repointing it now would clobber that work. Coordinate first.
3. **Scope-owner + billing-owner sign-off**, given the payable path is in scope.

## Recommendation

Staged **expand/contract**, executed only when the three preconditions hold:

- **Expand (additive, reversible):** extend the enum + transition table + labels + FK columns; keep the
  dual-write authoritative. Verify green build **and** a runtime pass.
- **Contract (cutover):** backfill (dry-run counts first) → move the four FKs → re-home the document
  pipeline onto `project_branches.status` → delete the dual-write / `ASSESSMENT_STATUS_MAP` →
  drop `assessments`. One reviewed PR per FK owner where practical; billing-engine suite before/after.

**Status of execution:** deliberately **not started in this session** — the preconditions above are
unmet (no runtime tests; Track B's tree is dirty in `validation.service.ts`). Doing a 20-file,
billing-adjacent, unverifiable schema cutover under those conditions would be reckless regardless of
authorization. This ADR is complete and ready to execute the moment the preconditions are satisfied.
