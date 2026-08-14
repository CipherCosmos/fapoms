import {
  BillingState,
  ClientBillingStatus,
  ClientLifecycleStatus,
  InvoiceStatus,
  PaymentState,
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

export const BILLING_TRANSITIONS: TransitionMap<ClientBillingStatus> = {
  [ClientBillingStatus.DRAFT]: [ClientBillingStatus.ACTIVE, ClientBillingStatus.INACTIVE],
  [ClientBillingStatus.ACTIVE]: [ClientBillingStatus.SUSPENDED, ClientBillingStatus.INACTIVE],
  [ClientBillingStatus.SUSPENDED]: [ClientBillingStatus.ACTIVE, ClientBillingStatus.INACTIVE],
  [ClientBillingStatus.INACTIVE]: [ClientBillingStatus.ACTIVE],
};

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
 * Multi-level billing state machine (spec §6).
 *
 * Forward spine:
 *   NOT_BILLABLE → PENDING_BILLING → READY_FOR_BILLING → DRAFT → SUBMITTED
 *     → UNDER_REVIEW → (REJECTED ⇄ DRAFT) → APPROVED → INVOICED
 *     → PARTIALLY_PAID → PAID
 * Cross-cutting hold/dispute/cancel/adjust, each with an escape hatch.
 */
export const BILLING_STATE_TRANSITIONS: TransitionMap<BillingState> = {
  [BillingState.NOT_BILLABLE]: [BillingState.PENDING_BILLING],
  [BillingState.PENDING_BILLING]: [BillingState.READY_FOR_BILLING, BillingState.NOT_BILLABLE, BillingState.CANCELLED],
  [BillingState.READY_FOR_BILLING]: [BillingState.DRAFT, BillingState.ON_HOLD, BillingState.CANCELLED],
  [BillingState.DRAFT]: [
    BillingState.SUBMITTED,
    BillingState.READY_FOR_BILLING,
    BillingState.ON_HOLD,
    BillingState.CANCELLED,
  ],
  [BillingState.SUBMITTED]: [BillingState.UNDER_REVIEW, BillingState.DRAFT, BillingState.ON_HOLD, BillingState.CANCELLED],
  [BillingState.UNDER_REVIEW]: [
    BillingState.APPROVED,
    BillingState.REJECTED,
    BillingState.ON_HOLD,
    BillingState.DISPUTED,
  ],
  [BillingState.REJECTED]: [BillingState.DRAFT, BillingState.CANCELLED],
  [BillingState.APPROVED]: [
    BillingState.INVOICED,
    BillingState.ON_HOLD,
    BillingState.DISPUTED,
    BillingState.CANCELLED,
    BillingState.ADJUSTED,
  ],
  [BillingState.INVOICED]: [
    BillingState.PARTIALLY_PAID,
    BillingState.PAID,
    BillingState.ON_HOLD,
    BillingState.DISPUTED,
    BillingState.ADJUSTED,
  ],
  [BillingState.PARTIALLY_PAID]: [BillingState.PAID, BillingState.DISPUTED, BillingState.ON_HOLD, BillingState.ADJUSTED],
  [BillingState.PAID]: [BillingState.ADJUSTED, BillingState.DISPUTED],
  [BillingState.ON_HOLD]: [
    BillingState.READY_FOR_BILLING,
    BillingState.DRAFT,
    BillingState.UNDER_REVIEW,
    BillingState.CANCELLED,
  ],
  [BillingState.DISPUTED]: [BillingState.UNDER_REVIEW, BillingState.APPROVED, BillingState.ON_HOLD, BillingState.CANCELLED],
  [BillingState.CANCELLED]: [],
  [BillingState.ADJUSTED]: [BillingState.APPROVED, BillingState.ON_HOLD],
};

export const INVOICE_TRANSITIONS: TransitionMap<InvoiceStatus> = {
  [InvoiceStatus.DRAFT]: [InvoiceStatus.ISSUED, InvoiceStatus.CANCELLED, InvoiceStatus.VOID],
  [InvoiceStatus.ISSUED]: [
    InvoiceStatus.PARTIALLY_PAID,
    InvoiceStatus.PAID,
    InvoiceStatus.DISPUTED,
    InvoiceStatus.CANCELLED,
  ],
  [InvoiceStatus.PARTIALLY_PAID]: [InvoiceStatus.PAID, InvoiceStatus.DISPUTED, InvoiceStatus.CANCELLED],
  [InvoiceStatus.PAID]: [InvoiceStatus.DISPUTED],
  [InvoiceStatus.DISPUTED]: [InvoiceStatus.ISSUED, InvoiceStatus.CANCELLED],
  [InvoiceStatus.CANCELLED]: [],
  [InvoiceStatus.VOID]: [],
};

export const PAYMENT_STATE_TRANSITIONS: TransitionMap<PaymentState> = {
  [PaymentState.UNPAID]: [PaymentState.PARTIALLY_PAID, PaymentState.PAID],
  [PaymentState.PARTIALLY_PAID]: [PaymentState.PAID, PaymentState.UNPAID],
  [PaymentState.PAID]: [PaymentState.PARTIALLY_PAID],
  [PaymentState.REVERSED]: [PaymentState.UNPAID],
};

export const PAYABLE_TRANSITIONS: TransitionMap<AssayerPayableStatus> = {
  [AssayerPayableStatus.PENDING]: [AssayerPayableStatus.APPROVED, AssayerPayableStatus.ON_HOLD, AssayerPayableStatus.DISPUTED],
  [AssayerPayableStatus.APPROVED]: [AssayerPayableStatus.PAID, AssayerPayableStatus.ON_HOLD, AssayerPayableStatus.DISPUTED],
  [AssayerPayableStatus.PAID]: [AssayerPayableStatus.DISPUTED],
  [AssayerPayableStatus.DISPUTED]: [AssayerPayableStatus.PENDING, AssayerPayableStatus.APPROVED, AssayerPayableStatus.ON_HOLD],
  [AssayerPayableStatus.ON_HOLD]: [AssayerPayableStatus.PENDING, AssayerPayableStatus.APPROVED, AssayerPayableStatus.DISPUTED],
};
