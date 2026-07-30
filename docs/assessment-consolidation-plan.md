# Assessment Consolidation — Staged Plan

**Status:** proposal, awaiting approval. No code written against it yet.
**Verified against:** running dev stack + live DB, 2026-07-31. Every claim below was checked
in source or by querying `fapoms-postgres` — not taken from any existing document.

---

## 1. The finding

`AssessmentEntity` already exists and matches the customer spec almost exactly — `packet_size`,
`assigned_assessor_id`, `audit_date`, `agreed_fee`, `coverage_flag`, and an `AssessmentStatus`
enum whose 18 values line up with the spec's lifecycle. `CallLogEntity` likewise matches the
spec's proposed fields.

It is dormant:

| Measure | Value |
| --- | --- |
| `assessments` rows | 3 — **all still `PENDING_PLANNING`**, none ever advanced |
| `assignments` with `assessment_id` set | **0 of 5** |
| `project_branches` with any assessment | **3 of 10** |
| `call_logs` rows | **0** |

The workflow actually runs on `ProjectBranch.status` (13 values) + `Assignment.status` (7) +
`Schedule.status` (4). So there are two overlapping lifecycles, one inert and one live.

This is the structural cause of the cross-view status inconsistencies fixed piecemeal over the
last few sessions (drifted branch/schedule rows, contradictory labels, disagreeing counts).
Those were leaks; this is the burst pipe.

## 2. Why consolidating is worth doing (not just cleanup)

Semantically, `ProjectBranchStatus` covers the planning half of the workflow — its
`PLANNING` / `NEGOTIATION` / `SCHEDULED` map onto Assessment's `PENDING_PLANNING` /
`IN_NEGOTIATION` / `ASSIGNED_AND_SCHEDULED`. That overlap is pure duplication.

But the entire document and data-entry pipeline has **no representation at all** in
`ProjectBranchStatus`. These twelve states exist only on `AssessmentStatus`:

`AWAITING_CLIENT_DATA`, `CLIENT_DATA_RECEIVED`, `PDF_GENERATED`, `READY_FOR_DISPATCH`,
`DISPATCHED_TO_ASSESSOR`, `AUDITED_PDF_RECEIVED`, `SENT_TO_DATA_ENTRY`,
`DATA_ENTRY_IN_PROGRESS`, `CLARIFICATION_NEEDED`, `REPORT_FINALIZED`,
`PENDING_HEAD_APPROVAL`, `DELIVERED_TO_CLIENT`

`ProjectBranchStatus` collapses all twelve into three (`AUDIT_COMPLETED` →
`VALIDATION_COMPLETED` → `CLOSED`). So today the system genuinely cannot answer *"where is
branch X's paperwork right now?"* — it can only say "the audit finished."

Consolidating therefore isn't housekeeping. It's the prerequisite for the Document Management
module, which is the customer's stated first priority.

## 3. Target shape

Three records, three distinct jobs — no overlap:

- **Assessment** — *"this branch's audit, in this project."* Owns the **lifecycle status**
  (all 18 states), documents, and coverage. This is what every screen and report reads.
- **Assignment** — *"an offer to one specific assayer."* Owns fee negotiation, accept/reject,
  SLA timeout, counter-offer. **One Assessment has many Assignments over time.**
- **ProjectBranch** — the project↔branch join and import record. Keeps `packetCount` etc.
  **Stops owning lifecycle status.**

### Why Assignment must survive

`Assessment` has a single `assigned_assessor_id` + `agreed_fee`. That cannot express
*"three assayers rejected, the fourth accepted"* — but that re-offer chain is real, built,
covered by tests, and carries the SLA auto-decline behaviour. Folding Assignment into
Assessment would delete working functionality. The one-to-many relationship is the correct
model and already matches the FK direction (`assignments.assessment_id`).

## 4. Stages

Ordered so each is independently shippable and reversible. Nothing after Stage 0 changes
user-visible behaviour until Stage 3.

### Stage 0 — Close the creation gap *(additive, no behaviour change)*

Every `ProjectBranch` must get an `Assessment` at import; today only 3 of 10 do. Both creation
sites (`project.service.ts` ~line 351 and ~line 534) are already correct and idempotent — the
7 missing rows came from branches added through paths that skip them (seed / alternate import).

- Make Assessment creation unconditional for every project-branch, at every entry point.
- **Exit check:** `project_branches` with no assessment = 0.
- **Risk:** low, additive. **Rollback:** delete the created rows.

### Stage 1 — Backfill the links *(data-only, reversible)*

- Link the 3 assignments whose assessment already matches on `(project_id, branch_id)`.
- Create + link assessments for the 2 that have none.
- Ship as an idempotent migration, same pattern as `ReconcileAssignmentStatusDrift`.
- **Exit check:** `assignments.assessment_id IS NULL` = 0.
- **Note:** `assignment.create()` already resolves and sets `assessmentId` when one exists, so
  no new rows will drift once Stage 0 lands. This is purely historical repair.
- **Risk:** low. **Rollback:** null the column back out.

### Stage 2 — Make Assessment track reality *(behaviour, still not user-visible)*

`syncAssessmentStatus()` and `ASSESSMENT_STATUS_MAP` already exist in `assignment.service.ts`
and silently no-op today because `assignment.assessment` is always null. After Stage 1 they
start working on their own — but they only mirror `ProjectBranchStatus`, so Assessment would
still be a shadow rather than the source of truth.

The real work here is driving the **twelve document-pipeline states** from the events that
already fire but currently update nothing:

| Event (already exists) | Should advance Assessment to |
| --- | --- |
| Pre-field PDF uploaded | `READY_FOR_DISPATCH` |
| Auto/manual dispatch | `DISPATCHED_TO_ASSESSOR` |
| Assayer returns audited PDF | `AUDITED_PDF_RECEIVED` |
| Routed to data-entry queue | `SENT_TO_DATA_ENTRY` |
| Validation query raised / resolved | `CLARIFICATION_NEEDED` ↔ `DATA_ENTRY_IN_PROGRESS` |
| Report approved / delivered | `PENDING_HEAD_APPROVAL` → `DELIVERED_TO_CLIENT` |

- Route **all** of these through one owner method, the way assignment completion was
  consolidated into `completeAssignment()`. Hand-rolled status writes are what caused the
  original drift and must not be reintroduced.
- **Exit check:** assessments observably advance past `PENDING_PLANNING` in a full
  end-to-end run.
- **Risk:** medium — new writes on a live table. **Rollback:** stop writing; the column is
  additive and nothing reads it yet.

### Stage 3 — Flip the reads *(user-visible)*

- Screens show `Assessment.status` as the headline state; extend `utils/statusLabels.ts`
  (already the single label vocabulary) with `assessmentStatusLabel` — already added.
- Document Management / data-entry views become possible for the first time.
- **Risk:** medium, but visual and quickly reversible per screen.

### Stage 4 — Retire `ProjectBranchStatus` as a lifecycle field

Only once nothing reads it: make it derived, then drop it. This is the step that makes the
inconsistency class *structurally impossible* rather than merely fixed.

## 5. Deliberately deferred

These are real gaps, but each is cheaper and safer to build once Assessment is authoritative,
because all of them hang off it:

- **Coverage report** — no entity/module/endpoint exists at all. Reads `coverage_flag` per
  Assessment; spec wants download-only, no email automation.
- **Call logging** — `CallLogEntity` exists with 0 rows and no writer. Belongs to Assessment.
- **Auto-dispatch producer** — `@Processor('document-dispatch')` exists but nothing ever
  enqueues to it, so auto-dispatch has never run. Spec: 1 day before audit date, plus manual
  override.
- **Data Entry Head queue + role** — no `DATA_ENTRY_HEAD` in `SystemRole`; the queue endpoint
  is currently unauthenticated and not head-scoped. Spec: PDFs land with the Head, who
  distributes manually.
- **Regional Operator + region scoping** — role does not exist; no region scoping anywhere.
- **SOL ID branch matching** — `solId` exists on Branch but import matches on branch code
  only; no fuzzy name/state fallback, no duplicate detection.

## 6. Open questions for the customer

1. **Assessment ↔ Assignment cardinality.** Confirm one Assessment may have many Assignments
   over time (the re-offer chain). The spec's data model implies one assessor per Assessment,
   which cannot represent rejection-then-reassignment.
2. **`UNASSIGNED` as an end state.** Spec lists it as terminal feeding the coverage report,
   but a branch nobody accepted is usually retried next cycle. Terminal, or re-openable?
3. **Terminology.** Spec says *Assessor*; the codebase says *Assayer* throughout (entity,
   role, mobile app, API routes). Renaming is broad and mechanical — worth doing once, or
   leave as-is and treat them as synonyms?
