import {
  BillingState,
  ClientLifecycleStatus,
  DocumentStatus,
  InvoiceStatus,
  AssayerPayableStatus,
  ProjectStatus,
  ScheduleStatus,
  ValidationStatus,
} from './enums';

export type TransitionMap<T extends string> = Partial<Record<T, T[]>>;

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
 * The client-side line. Invoicing moves UNBILLED → INVOICED; recording the last rupee moves
 * INVOICED → PAID; cancelling the invoice moves INVOICED → UNBILLED (the work is still billable).
 * CANCELLED is terminal — a line that will never be billed.
 */
export const BILLING_STATE_TRANSITIONS: TransitionMap<BillingState> = {
  [BillingState.UNBILLED]: [BillingState.INVOICED, BillingState.CANCELLED],
  [BillingState.INVOICED]: [BillingState.PAID, BillingState.UNBILLED],
  [BillingState.PAID]: [],
  [BillingState.CANCELLED]: [],
};

export const INVOICE_TRANSITIONS: TransitionMap<InvoiceStatus> = {
  [InvoiceStatus.DRAFT]: [InvoiceStatus.ISSUED, InvoiceStatus.CANCELLED],
  [InvoiceStatus.ISSUED]: [InvoiceStatus.PAID, InvoiceStatus.CANCELLED],
  [InvoiceStatus.PAID]: [],
  [InvoiceStatus.CANCELLED]: [],
};

/** One approval, then payment. PAID is only ever reached by recording a disbursement. */
export const PAYABLE_TRANSITIONS: TransitionMap<AssayerPayableStatus> = {
  [AssayerPayableStatus.PENDING]: [AssayerPayableStatus.APPROVED],
  [AssayerPayableStatus.APPROVED]: [AssayerPayableStatus.PAID],
  [AssayerPayableStatus.PAID]: [],
};
