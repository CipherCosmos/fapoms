import {
  AssignmentStatus,
  ClientLifecycleStatus,
  DocumentStatus,
  ProjectStatus,
  ScheduleStatus,
  ValidationStatus,
} from './enums';

export type TransitionMap<T extends string> = Partial<Record<T, T[]>>;

/**
 * How an assignment may move — THE table. `AssignmentStateMachine` (backend) reads it, and the
 * capability evaluators that tell the field app what it may do next read it too, so the app is
 * never offered a move the server's own machine would refuse.
 *
 * It lived as a private `VALID_PATHS` inside the backend's `AssignmentStateMachine` until the field
 * app was rebuilt around server-issued capabilities (2026-09-24). Moved here, not copied: the
 * backend class now points at this object, so there is one table. The notes on individual edges
 * are the ones that sat beside them in the backend.
 */
export const ASSIGNMENT_TRANSITIONS: Record<AssignmentStatus, AssignmentStatus[]> = {
  [AssignmentStatus.PENDING]: [AssignmentStatus.ACCEPTED, AssignmentStatus.REJECTED, AssignmentStatus.CANCELLED],
  // COMPLETED is reachable from ACCEPTED, but only through `completeAudit`, which refuses it
  // without a stated reason — see there. The desk cannot check in for somebody (the check-in
  // is geofenced and lives in the field app), so without this a job whose assayer never
  // opened the app could not be closed at all.
  [AssignmentStatus.ACCEPTED]: [
    AssignmentStatus.ACCEPTED,
    AssignmentStatus.CHECKED_IN,
    AssignmentStatus.COMPLETED,
    AssignmentStatus.CANCELLED,
  ],
  [AssignmentStatus.CHECKED_IN]: [AssignmentStatus.CHECKED_IN, AssignmentStatus.ACCEPTED, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED],
  // CHECKED_IN is reachable from IN_PROGRESS because a field check-in is retried: a flaky
  // mobile connection, a GPS refresh, or a second attempt at the geofence all re-issue it
  // after work has already started. Refusing that would fail a legitimate retry, so it is
  // allowed here rather than being a backwards move nobody intended.
  [AssignmentStatus.IN_PROGRESS]: [AssignmentStatus.IN_PROGRESS, AssignmentStatus.CHECKED_IN, AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED],
  // COMPLETED is a terminal workflow state that cannot be exited through generic transition endpoints.
  // Reopening is strictly a privileged back-office operational command via AssignmentStateMachine.reopen().
  [AssignmentStatus.COMPLETED]: [],
  // A declined offer goes back on the market: reassigning it to somebody else is the whole
  // point, and it re-enters as a PENDING offer to that person.
  [AssignmentStatus.REJECTED]: [AssignmentStatus.PENDING],
  /**
   * Terminal. A cancellation is a decision that this work is not happening.
   *
   * This used to list PENDING, so the table declared that cancelled work could quietly become
   * a live offer again. Nothing in the API could reach that edge — `POST :id/transition` has no
   * PENDING branch at all — but `reassignAssignment` set the status directly, bypassing this
   * table entirely, and so DID revive cancelled assignments: new owner, `cancel_reason` wiped,
   * under an audit event that said only "reassigned". That path now refuses CANCELLED, and the
   * table is corrected to match, so the declared machine and the enforced one agree.
   *
   * Reviving cancelled work needs its own command with its own permission, reason and audit —
   * see `AssignmentStateMachine.reopen()` for the shape that takes. It is not an edge on this table.
   */
  [AssignmentStatus.CANCELLED]: [],
};

/** Whether an assignment may move from one status to the other, per `ASSIGNMENT_TRANSITIONS`. */
export function canTransitionAssignment(from: AssignmentStatus, to: AssignmentStatus): boolean {
  return ASSIGNMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * The target statuses a field assayer may REQUEST on their own assignment through
 * `POST /assignments/:id/transition` — a permission, not a predicate over rows. Whether the move is
 * then legal from where the assignment stands is `ASSIGNMENT_TRANSITIONS`' question.
 *
 * `IN_PROGRESS` is included because the assayer is the only person who knows when the audit
 * actually started. Cancelling and completing remain the desk's. `COUNTER_OFFER`/`NEGOTIATION`/
 * `PENDING` were in this list while in-app negotiation existed; they left with it.
 */
export const ASSAYER_REQUESTABLE_ASSIGNMENT_TRANSITIONS: readonly AssignmentStatus[] = [
  AssignmentStatus.ACCEPTED,
  AssignmentStatus.REJECTED,
  AssignmentStatus.CHECKED_IN,
  AssignmentStatus.IN_PROGRESS,
];

/**
 * How a project may move. `registerWorkflow('project')` is built from this.
 *
 * This table was previously dead — nothing in any package imported it — and it had gone stale
 * while nobody was reading it: every `-> CANCELLED` edge except PLANNING's was missing, so a
 * project in DRAFT, SCHEDULING, EXECUTION, VALIDATION or ON_HOLD could not be abandoned
 * according to this file, while the running system cancelled them all quite happily. A dead
 * definition is worse than no definition; the next person to wire it up would have broken
 * cancellation from five states and had every reason to think this file was authoritative.
 */
export const PROJECT_TRANSITIONS: TransitionMap<ProjectStatus> = {
  [ProjectStatus.DRAFT]: [ProjectStatus.PLANNING, ProjectStatus.CANCELLED],
  [ProjectStatus.PLANNING]: [ProjectStatus.SCHEDULING, ProjectStatus.CANCELLED],
  [ProjectStatus.SCHEDULING]: [ProjectStatus.EXECUTION, ProjectStatus.ON_HOLD, ProjectStatus.CANCELLED],
  [ProjectStatus.EXECUTION]: [ProjectStatus.VALIDATION, ProjectStatus.ON_HOLD, ProjectStatus.CANCELLED],
  [ProjectStatus.VALIDATION]: [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED],
  [ProjectStatus.COMPLETED]: [ProjectStatus.ARCHIVED],
  [ProjectStatus.ON_HOLD]: [ProjectStatus.SCHEDULING, ProjectStatus.EXECUTION, ProjectStatus.CANCELLED],
};

/**
 * How a client moves through its lifecycle. Three hand-maintained copies of this existed —
 * `client.service.ts`, its `registerWorkflow` registration, and the web app's `Clients.tsx`
 * path-finder — identical by luck rather than by construction, in two different packages.
 * All three now read this.
 */
export const CLIENT_LIFECYCLE_TRANSITIONS: TransitionMap<ClientLifecycleStatus> = {
  [ClientLifecycleStatus.PROSPECT]: [ClientLifecycleStatus.ONBOARDING, ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.ONBOARDING]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.INACTIVE],
  [ClientLifecycleStatus.ACTIVE]: [ClientLifecycleStatus.SUSPENDED, ClientLifecycleStatus.UNDER_REVIEW, ClientLifecycleStatus.INACTIVE],
  [ClientLifecycleStatus.SUSPENDED]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.UNDER_REVIEW, ClientLifecycleStatus.TERMINATED],
  [ClientLifecycleStatus.UNDER_REVIEW]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.SUSPENDED, ClientLifecycleStatus.TERMINATED],
  [ClientLifecycleStatus.INACTIVE]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.TERMINATED]: [ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.ARCHIVED]: [],
};

/**
 * Flattens a transition map into the `{from, to}` list the backend's WorkflowEngine registers.
 *
 * The engine's registrations used to be typed out by hand alongside the map they mirror, which
 * made the engine a second opinion on every transition rather than an executor of the first one.
 * They agreed for assayer and client and disagreed for validation — and since the engine gates
 * `executeCommand` BEFORE the state machine runs, whenever they disagreed the engine's copy won
 * silently. Deriving removes the possibility.
 */
export function toWorkflowTransitions<T extends string>(
  map: TransitionMap<T>,
): { from: string[]; to: string }[] {
  const byTarget = new Map<string, string[]>();
  for (const [from, targets] of Object.entries(map) as [string, T[]][]) {
    for (const to of targets ?? []) {
      const list = byTarget.get(to) ?? [];
      list.push(from);
      byTarget.set(to, list);
    }
  }
  return [...byTarget.entries()].map(([to, from]) => ({ from, to }));
}

export const SCHEDULE_TRANSITIONS: TransitionMap<ScheduleStatus> = {
  [ScheduleStatus.TENTATIVE]: [ScheduleStatus.CONFIRMED],
  [ScheduleStatus.CONFIRMED]: [
    ScheduleStatus.RESCHEDULED,
    ScheduleStatus.COMPLETED,
  ],
  [ScheduleStatus.RESCHEDULED]: [ScheduleStatus.RESCHEDULED, ScheduleStatus.CONFIRMED, ScheduleStatus.COMPLETED],
};

/**
 * The only table describing how a validation case may move. `ValidationStateMachine` reads it.
 *
 * There were two of these, and they disagreed. This one modelled a strict pipeline
 * (PENDING -> ASSIGNED -> OCR_PROCESSING -> HUMAN_REVIEW -> ...) while the backend machine kept
 * a private copy with three extra edges, and the two were consulted from different places:
 * `validation.service.ts` checked this table when assigning a reviewer, the machine checked its
 * own everywhere else. Whichever you read, the other one was also in force somewhere.
 *
 * Reconciled deliberately rather than by picking a side:
 *
 *  - `PENDING -> HUMAN_REVIEW` is kept. It is a real path — the data entry desk hands a packet
 *    back and the case goes straight to review (`getOrAdvanceForHandBack`). This table used to
 *    forbid it while the machine allowed it, so the documented pipeline and the running system
 *    disagreed about the most common route through validation.
 *  - `ASSIGNED -> HUMAN_REVIEW` is kept. OCR is not always possible or relevant, and a reviewer
 *    must be able to start on a case that has nothing to scan.
 *  - `ASSIGNED -> APPROVED` is REMOVED. It let a case be approved having never been reviewed by
 *    anyone — no OCR, no human, straight from "a reviewer was named" to "approved" — and
 *    validation approval is what releases work downstream. No caller relied on it: there is no
 *    auto-approve path, so the only way to reach it was a human approving unreviewed work.
 */
export const VALIDATION_TRANSITIONS: TransitionMap<ValidationStatus> = {
  [ValidationStatus.PENDING]: [ValidationStatus.ASSIGNED, ValidationStatus.HUMAN_REVIEW],
  [ValidationStatus.ASSIGNED]: [ValidationStatus.OCR_PROCESSING, ValidationStatus.HUMAN_REVIEW],
  [ValidationStatus.OCR_PROCESSING]: [ValidationStatus.HUMAN_REVIEW],
  [ValidationStatus.HUMAN_REVIEW]: [
    ValidationStatus.APPROVED,
    ValidationStatus.CORRECTION_REQUIRED,
  ],
  [ValidationStatus.CORRECTION_REQUIRED]: [ValidationStatus.HUMAN_REVIEW],
  [ValidationStatus.APPROVED]: [ValidationStatus.SUBMITTED],
};

/**
 * A packet's journey, and the only way it is allowed to go.
 *
 * Documents were the one lifecycle in this system with no transition map. Every other status
 * column — assignment, project, invoice, payable, assayer — is guarded by one; a document's
 * was written straight from the request body, so `PATCH /documents/:id/status` could set any
 * of the nine states from any other. A packet that had come back from the field, been typed
 * up and delivered could be sent to UPLOADED, at which point it reappeared in the
 * awaiting-dispatch queue and in the "blocked, paperwork never sent" banner, and staff would
 * re-send paperwork that was already finished.
 *
 * Two artifacts share this pipeline and enter it at different points. A PRE_FIELD_AUDIT_PDF
 * is uploaded and goes out: UPLOADED → DISPATCHED → RECEIVED. An AUDITED_RETURN_PDF is
 * uploaded *by* the assayer and is received in the same act: UPLOADED → RECEIVED. A
 * GENERATED_EXCEL is neither — it is produced at the end, so UPLOADED → COMPLETED. Hence
 * UPLOADED has three exits rather than one.
 *
 * The rule the map encodes is that a packet only ever moves forward. Nothing here goes back:
 * a hand-back from data entry stamps `data_entry_completed_at` and leaves the status where it
 * is, precisely because the packet has not moved anywhere. ARCHIVED is reachable from every
 * state and is terminal — it is how a packet leaves the pipeline without pretending it
 * finished it.
 */
export const DOCUMENT_TRANSITIONS: TransitionMap<DocumentStatus> = {
  [DocumentStatus.UPLOADED]: [
    DocumentStatus.DISPATCHED,
    DocumentStatus.RECEIVED,
    DocumentStatus.COMPLETED,
    DocumentStatus.ARCHIVED,
  ],
  [DocumentStatus.DISPATCHED]: [DocumentStatus.RECEIVED, DocumentStatus.ARCHIVED],
  [DocumentStatus.RECEIVED]: [
    DocumentStatus.SENT_TO_DATA_ENTRY,
    DocumentStatus.SENT_TO_EXTERNAL_OCR,
    DocumentStatus.ARCHIVED,
  ],
  [DocumentStatus.SENT_TO_DATA_ENTRY]: [
    DocumentStatus.SENT_TO_EXTERNAL_OCR,
    DocumentStatus.EXCEL_GENERATED,
    DocumentStatus.ARCHIVED,
  ],
  [DocumentStatus.SENT_TO_EXTERNAL_OCR]: [DocumentStatus.EXCEL_GENERATED, DocumentStatus.ARCHIVED],
  [DocumentStatus.EXCEL_GENERATED]: [DocumentStatus.PROCESSED, DocumentStatus.ARCHIVED],
  [DocumentStatus.PROCESSED]: [DocumentStatus.COMPLETED, DocumentStatus.ARCHIVED],
  [DocumentStatus.COMPLETED]: [DocumentStatus.ARCHIVED],
  [DocumentStatus.ARCHIVED]: [],
};

/** Whether a packet may move from one state to the other. Re-stating the same state is not a move. */
export function canTransitionDocument(from: DocumentStatus, to: DocumentStatus): boolean {
  return isValidTransition(DOCUMENT_TRANSITIONS, from, to);
}

export function isValidTransition<T extends string>(
  transitions: TransitionMap<T>,
  currentState: T,
  targetState: T,
): boolean {
  const allowedTargets = transitions[currentState];
  if (!allowedTargets) return false;
  return allowedTargets.includes(targetState);
}

/**
 * Money has no transition table here, and that is the decision rather than the omission.
 *
 * `BILLING_STATE_TRANSITIONS`, `INVOICE_TRANSITIONS` and `PAYABLE_TRANSITIONS` used to sit at the
 * bottom of this file with **no consumers in any package**, and they had drifted four ways while
 * nobody was reading them: `PAYABLE_TRANSITIONS` had no `VOIDED` at all — the single most common
 * end for a payable on the live rig, and the one the reopen path depends on — and all three
 * called their `PAID` state terminal, which reversing a payment has never respected. Anyone
 * reading them to learn how money moves learned a lifecycle that does not exist. The docblock on
 * `PROJECT_TRANSITIONS` above says why that is worse than nothing.
 *
 * They were deleted rather than wired, because a table cannot be the authority here:
 *
 *  - **The target is an amount, not a state.** Whether a disbursement leaves a payable APPROVED
 *    or moves it to PAID is decided by what is still owed, not by where it came from; the same is
 *    true of every client line an invoice collects against. A table could only re-assert the
 *    answer afterwards, never produce it.
 *  - **The refusals carry reasons a table cannot hold.** "already paid — it cannot be voided, only
 *    reversed by finance", "on hold: <reason>", "awaiting assayer invoice <n> — approve the
 *    invoice instead", segregation of duties, a missing PAN or IFSC, an amount above what is
 *    owed. Routing those through a from/to lookup would answer the caller with less than the code
 *    already knows.
 *  - **The writes are not all in one module.** Reopening an assignment cancels its client line
 *    from `assignment.service.ts`. A table obeyed by the billing engine and not by that path
 *    would be a third opinion with an import, which is the thing it was supposed to remove.
 *
 * So each question about money has exactly one home, and none of them is here:
 *
 *  - **which states exist** — the enums in `./enums`, pinned by `CK_assayer_payables_status`,
 *    `CK_billing_entries_state` and `CK_billing_invoices_status` (migrations `1791500000000`,
 *    `1796300000000`). `billing-engine/money-state-authority.db.spec.ts` holds the two together, reading the
 *    constraints out of the live catalogue rather than the migration — the migration is what was
 *    intended, the catalogue is what is true, and those parted company once already.
 *  - **which states are dead** — `./billing-liveness`, in the shape TypeScript needs and the shape
 *    the partial unique indexes of migration `1798000000000` need.
 *  - **which moves are allowed, and why one was refused** — the guards in
 *    `billing-engine.service.ts`, which are also the message the caller gets.
 */
