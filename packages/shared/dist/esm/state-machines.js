import { AssessmentStatus, BillingState, ClientBillingStatus, InvoiceStatus, PaymentState, AssayerPayableStatus, ProjectStatus, ScheduleStatus, ValidationStatus, } from './enums';
export const PROJECT_TRANSITIONS = {
    [ProjectStatus.DRAFT]: [ProjectStatus.PLANNING],
    [ProjectStatus.PLANNING]: [ProjectStatus.SCHEDULING, ProjectStatus.CANCELLED],
    [ProjectStatus.SCHEDULING]: [ProjectStatus.EXECUTION, ProjectStatus.ON_HOLD],
    [ProjectStatus.EXECUTION]: [ProjectStatus.VALIDATION, ProjectStatus.ON_HOLD],
    [ProjectStatus.VALIDATION]: [ProjectStatus.COMPLETED],
    [ProjectStatus.COMPLETED]: [ProjectStatus.ARCHIVED],
    [ProjectStatus.ON_HOLD]: [ProjectStatus.SCHEDULING, ProjectStatus.EXECUTION],
};
export const ASSESSMENT_TRANSITIONS = {
    [AssessmentStatus.PENDING_PLANNING]: [AssessmentStatus.ASSESSOR_RECOMMENDED],
    [AssessmentStatus.ASSESSOR_RECOMMENDED]: [
        AssessmentStatus.IN_NEGOTIATION,
        AssessmentStatus.UNASSIGNED,
    ],
    [AssessmentStatus.IN_NEGOTIATION]: [
        AssessmentStatus.ASSIGNED_AND_SCHEDULED,
        AssessmentStatus.ASSESSOR_RECOMMENDED,
    ],
    [AssessmentStatus.ASSIGNED_AND_SCHEDULED]: [
        AssessmentStatus.AWAITING_CLIENT_DATA,
        AssessmentStatus.UNASSIGNED,
    ],
    [AssessmentStatus.AWAITING_CLIENT_DATA]: [AssessmentStatus.CLIENT_DATA_RECEIVED],
    [AssessmentStatus.CLIENT_DATA_RECEIVED]: [AssessmentStatus.PDF_GENERATED],
    [AssessmentStatus.PDF_GENERATED]: [AssessmentStatus.READY_FOR_DISPATCH],
    [AssessmentStatus.READY_FOR_DISPATCH]: [AssessmentStatus.DISPATCHED_TO_ASSESSOR],
    [AssessmentStatus.DISPATCHED_TO_ASSESSOR]: [AssessmentStatus.AUDITED_PDF_RECEIVED],
    [AssessmentStatus.AUDITED_PDF_RECEIVED]: [AssessmentStatus.SENT_TO_DATA_ENTRY],
    [AssessmentStatus.SENT_TO_DATA_ENTRY]: [AssessmentStatus.DATA_ENTRY_IN_PROGRESS],
    [AssessmentStatus.DATA_ENTRY_IN_PROGRESS]: [
        AssessmentStatus.CLARIFICATION_NEEDED,
        AssessmentStatus.REPORT_FINALIZED,
    ],
    [AssessmentStatus.CLARIFICATION_NEEDED]: [AssessmentStatus.DATA_ENTRY_IN_PROGRESS],
    [AssessmentStatus.REPORT_FINALIZED]: [AssessmentStatus.PENDING_HEAD_APPROVAL],
    [AssessmentStatus.PENDING_HEAD_APPROVAL]: [
        AssessmentStatus.DELIVERED_TO_CLIENT,
        AssessmentStatus.DATA_ENTRY_IN_PROGRESS,
    ],
    [AssessmentStatus.DELIVERED_TO_CLIENT]: [AssessmentStatus.COMPLETED],
};
export const SCHEDULE_TRANSITIONS = {
    [ScheduleStatus.TENTATIVE]: [ScheduleStatus.CONFIRMED],
    [ScheduleStatus.CONFIRMED]: [
        ScheduleStatus.RESCHEDULED,
        ScheduleStatus.COMPLETED,
    ],
    [ScheduleStatus.RESCHEDULED]: [ScheduleStatus.RESCHEDULED, ScheduleStatus.CONFIRMED, ScheduleStatus.COMPLETED],
};
export const VALIDATION_TRANSITIONS = {
    [ValidationStatus.PENDING]: [ValidationStatus.ASSIGNED],
    [ValidationStatus.ASSIGNED]: [ValidationStatus.OCR_PROCESSING],
    [ValidationStatus.OCR_PROCESSING]: [ValidationStatus.HUMAN_REVIEW],
    [ValidationStatus.HUMAN_REVIEW]: [
        ValidationStatus.APPROVED,
        ValidationStatus.CORRECTION_REQUIRED,
    ],
    [ValidationStatus.CORRECTION_REQUIRED]: [ValidationStatus.HUMAN_REVIEW],
    [ValidationStatus.APPROVED]: [ValidationStatus.SUBMITTED],
};
export const BILLING_TRANSITIONS = {
    [ClientBillingStatus.DRAFT]: [ClientBillingStatus.ACTIVE, ClientBillingStatus.INACTIVE],
    [ClientBillingStatus.ACTIVE]: [ClientBillingStatus.SUSPENDED, ClientBillingStatus.INACTIVE],
    [ClientBillingStatus.SUSPENDED]: [ClientBillingStatus.ACTIVE, ClientBillingStatus.INACTIVE],
    [ClientBillingStatus.INACTIVE]: [ClientBillingStatus.ACTIVE],
};
export function isValidTransition(transitions, currentState, targetState) {
    const allowedTargets = transitions[currentState];
    if (!allowedTargets)
        return false;
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
export const BILLING_STATE_TRANSITIONS = {
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
export const INVOICE_TRANSITIONS = {
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
export const PAYMENT_STATE_TRANSITIONS = {
    [PaymentState.UNPAID]: [PaymentState.PARTIALLY_PAID, PaymentState.PAID],
    [PaymentState.PARTIALLY_PAID]: [PaymentState.PAID, PaymentState.UNPAID],
    [PaymentState.PAID]: [PaymentState.PARTIALLY_PAID],
    [PaymentState.REVERSED]: [PaymentState.UNPAID],
};
export const PAYABLE_TRANSITIONS = {
    [AssayerPayableStatus.PENDING]: [AssayerPayableStatus.APPROVED, AssayerPayableStatus.ON_HOLD, AssayerPayableStatus.DISPUTED],
    [AssayerPayableStatus.APPROVED]: [AssayerPayableStatus.PAID, AssayerPayableStatus.ON_HOLD, AssayerPayableStatus.DISPUTED],
    [AssayerPayableStatus.PAID]: [AssayerPayableStatus.DISPUTED],
    [AssayerPayableStatus.DISPUTED]: [AssayerPayableStatus.PENDING, AssayerPayableStatus.APPROVED, AssayerPayableStatus.ON_HOLD],
    [AssayerPayableStatus.ON_HOLD]: [AssayerPayableStatus.PENDING, AssayerPayableStatus.APPROVED, AssayerPayableStatus.DISPUTED],
};
//# sourceMappingURL=state-machines.js.map