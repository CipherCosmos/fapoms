"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAYABLE_TRANSITIONS = exports.PAYMENT_STATE_TRANSITIONS = exports.INVOICE_TRANSITIONS = exports.BILLING_STATE_TRANSITIONS = exports.BILLING_TRANSITIONS = exports.VALIDATION_TRANSITIONS = exports.SCHEDULE_TRANSITIONS = exports.ASSESSMENT_TRANSITIONS = exports.PROJECT_TRANSITIONS = void 0;
exports.isValidTransition = isValidTransition;
const enums_1 = require("./enums");
exports.PROJECT_TRANSITIONS = {
    [enums_1.ProjectStatus.DRAFT]: [enums_1.ProjectStatus.PLANNING],
    [enums_1.ProjectStatus.PLANNING]: [enums_1.ProjectStatus.SCHEDULING, enums_1.ProjectStatus.CANCELLED],
    [enums_1.ProjectStatus.SCHEDULING]: [enums_1.ProjectStatus.EXECUTION, enums_1.ProjectStatus.ON_HOLD],
    [enums_1.ProjectStatus.EXECUTION]: [enums_1.ProjectStatus.VALIDATION, enums_1.ProjectStatus.ON_HOLD],
    [enums_1.ProjectStatus.VALIDATION]: [enums_1.ProjectStatus.COMPLETED],
    [enums_1.ProjectStatus.COMPLETED]: [enums_1.ProjectStatus.ARCHIVED],
    [enums_1.ProjectStatus.ON_HOLD]: [enums_1.ProjectStatus.SCHEDULING, enums_1.ProjectStatus.EXECUTION],
};
exports.ASSESSMENT_TRANSITIONS = {
    [enums_1.AssessmentStatus.PENDING_PLANNING]: [enums_1.AssessmentStatus.ASSESSOR_RECOMMENDED],
    [enums_1.AssessmentStatus.ASSESSOR_RECOMMENDED]: [
        enums_1.AssessmentStatus.IN_NEGOTIATION,
        enums_1.AssessmentStatus.UNASSIGNED,
    ],
    [enums_1.AssessmentStatus.IN_NEGOTIATION]: [
        enums_1.AssessmentStatus.ASSIGNED_AND_SCHEDULED,
        enums_1.AssessmentStatus.ASSESSOR_RECOMMENDED,
    ],
    [enums_1.AssessmentStatus.ASSIGNED_AND_SCHEDULED]: [
        enums_1.AssessmentStatus.AWAITING_CLIENT_DATA,
        enums_1.AssessmentStatus.UNASSIGNED,
    ],
    [enums_1.AssessmentStatus.AWAITING_CLIENT_DATA]: [enums_1.AssessmentStatus.CLIENT_DATA_RECEIVED],
    [enums_1.AssessmentStatus.CLIENT_DATA_RECEIVED]: [enums_1.AssessmentStatus.PDF_GENERATED],
    [enums_1.AssessmentStatus.PDF_GENERATED]: [enums_1.AssessmentStatus.READY_FOR_DISPATCH],
    [enums_1.AssessmentStatus.READY_FOR_DISPATCH]: [enums_1.AssessmentStatus.DISPATCHED_TO_ASSESSOR],
    [enums_1.AssessmentStatus.DISPATCHED_TO_ASSESSOR]: [enums_1.AssessmentStatus.AUDITED_PDF_RECEIVED],
    [enums_1.AssessmentStatus.AUDITED_PDF_RECEIVED]: [enums_1.AssessmentStatus.SENT_TO_DATA_ENTRY],
    [enums_1.AssessmentStatus.SENT_TO_DATA_ENTRY]: [enums_1.AssessmentStatus.DATA_ENTRY_IN_PROGRESS],
    [enums_1.AssessmentStatus.DATA_ENTRY_IN_PROGRESS]: [
        enums_1.AssessmentStatus.CLARIFICATION_NEEDED,
        enums_1.AssessmentStatus.REPORT_FINALIZED,
    ],
    [enums_1.AssessmentStatus.CLARIFICATION_NEEDED]: [enums_1.AssessmentStatus.DATA_ENTRY_IN_PROGRESS],
    [enums_1.AssessmentStatus.REPORT_FINALIZED]: [enums_1.AssessmentStatus.PENDING_HEAD_APPROVAL],
    [enums_1.AssessmentStatus.PENDING_HEAD_APPROVAL]: [
        enums_1.AssessmentStatus.DELIVERED_TO_CLIENT,
        enums_1.AssessmentStatus.DATA_ENTRY_IN_PROGRESS,
    ],
    [enums_1.AssessmentStatus.DELIVERED_TO_CLIENT]: [enums_1.AssessmentStatus.COMPLETED],
};
exports.SCHEDULE_TRANSITIONS = {
    [enums_1.ScheduleStatus.TENTATIVE]: [enums_1.ScheduleStatus.CONFIRMED],
    [enums_1.ScheduleStatus.CONFIRMED]: [
        enums_1.ScheduleStatus.RESCHEDULED,
        enums_1.ScheduleStatus.COMPLETED,
    ],
    [enums_1.ScheduleStatus.RESCHEDULED]: [enums_1.ScheduleStatus.RESCHEDULED, enums_1.ScheduleStatus.CONFIRMED, enums_1.ScheduleStatus.COMPLETED],
};
exports.VALIDATION_TRANSITIONS = {
    [enums_1.ValidationStatus.PENDING]: [enums_1.ValidationStatus.ASSIGNED],
    [enums_1.ValidationStatus.ASSIGNED]: [enums_1.ValidationStatus.OCR_PROCESSING],
    [enums_1.ValidationStatus.OCR_PROCESSING]: [enums_1.ValidationStatus.HUMAN_REVIEW],
    [enums_1.ValidationStatus.HUMAN_REVIEW]: [
        enums_1.ValidationStatus.APPROVED,
        enums_1.ValidationStatus.CORRECTION_REQUIRED,
    ],
    [enums_1.ValidationStatus.CORRECTION_REQUIRED]: [enums_1.ValidationStatus.HUMAN_REVIEW],
    [enums_1.ValidationStatus.APPROVED]: [enums_1.ValidationStatus.SUBMITTED],
};
exports.BILLING_TRANSITIONS = {
    [enums_1.ClientBillingStatus.DRAFT]: [enums_1.ClientBillingStatus.ACTIVE, enums_1.ClientBillingStatus.INACTIVE],
    [enums_1.ClientBillingStatus.ACTIVE]: [enums_1.ClientBillingStatus.SUSPENDED, enums_1.ClientBillingStatus.INACTIVE],
    [enums_1.ClientBillingStatus.SUSPENDED]: [enums_1.ClientBillingStatus.ACTIVE, enums_1.ClientBillingStatus.INACTIVE],
    [enums_1.ClientBillingStatus.INACTIVE]: [enums_1.ClientBillingStatus.ACTIVE],
};
function isValidTransition(transitions, currentState, targetState) {
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
exports.BILLING_STATE_TRANSITIONS = {
    [enums_1.BillingState.NOT_BILLABLE]: [enums_1.BillingState.PENDING_BILLING],
    [enums_1.BillingState.PENDING_BILLING]: [enums_1.BillingState.READY_FOR_BILLING, enums_1.BillingState.NOT_BILLABLE, enums_1.BillingState.CANCELLED],
    [enums_1.BillingState.READY_FOR_BILLING]: [enums_1.BillingState.DRAFT, enums_1.BillingState.ON_HOLD, enums_1.BillingState.CANCELLED],
    [enums_1.BillingState.DRAFT]: [
        enums_1.BillingState.SUBMITTED,
        enums_1.BillingState.READY_FOR_BILLING,
        enums_1.BillingState.ON_HOLD,
        enums_1.BillingState.CANCELLED,
    ],
    [enums_1.BillingState.SUBMITTED]: [enums_1.BillingState.UNDER_REVIEW, enums_1.BillingState.DRAFT, enums_1.BillingState.ON_HOLD, enums_1.BillingState.CANCELLED],
    [enums_1.BillingState.UNDER_REVIEW]: [
        enums_1.BillingState.APPROVED,
        enums_1.BillingState.REJECTED,
        enums_1.BillingState.ON_HOLD,
        enums_1.BillingState.DISPUTED,
    ],
    [enums_1.BillingState.REJECTED]: [enums_1.BillingState.DRAFT, enums_1.BillingState.CANCELLED],
    [enums_1.BillingState.APPROVED]: [
        enums_1.BillingState.INVOICED,
        enums_1.BillingState.ON_HOLD,
        enums_1.BillingState.DISPUTED,
        enums_1.BillingState.CANCELLED,
        enums_1.BillingState.ADJUSTED,
    ],
    [enums_1.BillingState.INVOICED]: [
        enums_1.BillingState.PARTIALLY_PAID,
        enums_1.BillingState.PAID,
        enums_1.BillingState.ON_HOLD,
        enums_1.BillingState.DISPUTED,
        enums_1.BillingState.ADJUSTED,
    ],
    [enums_1.BillingState.PARTIALLY_PAID]: [enums_1.BillingState.PAID, enums_1.BillingState.DISPUTED, enums_1.BillingState.ON_HOLD, enums_1.BillingState.ADJUSTED],
    [enums_1.BillingState.PAID]: [enums_1.BillingState.ADJUSTED, enums_1.BillingState.DISPUTED],
    [enums_1.BillingState.ON_HOLD]: [
        enums_1.BillingState.READY_FOR_BILLING,
        enums_1.BillingState.DRAFT,
        enums_1.BillingState.UNDER_REVIEW,
        enums_1.BillingState.CANCELLED,
    ],
    [enums_1.BillingState.DISPUTED]: [enums_1.BillingState.UNDER_REVIEW, enums_1.BillingState.APPROVED, enums_1.BillingState.ON_HOLD, enums_1.BillingState.CANCELLED],
    [enums_1.BillingState.CANCELLED]: [],
    [enums_1.BillingState.ADJUSTED]: [enums_1.BillingState.APPROVED, enums_1.BillingState.ON_HOLD],
};
exports.INVOICE_TRANSITIONS = {
    [enums_1.InvoiceStatus.DRAFT]: [enums_1.InvoiceStatus.ISSUED, enums_1.InvoiceStatus.CANCELLED, enums_1.InvoiceStatus.VOID],
    [enums_1.InvoiceStatus.ISSUED]: [
        enums_1.InvoiceStatus.PARTIALLY_PAID,
        enums_1.InvoiceStatus.PAID,
        enums_1.InvoiceStatus.DISPUTED,
        enums_1.InvoiceStatus.CANCELLED,
    ],
    [enums_1.InvoiceStatus.PARTIALLY_PAID]: [enums_1.InvoiceStatus.PAID, enums_1.InvoiceStatus.DISPUTED, enums_1.InvoiceStatus.CANCELLED],
    [enums_1.InvoiceStatus.PAID]: [enums_1.InvoiceStatus.DISPUTED],
    [enums_1.InvoiceStatus.DISPUTED]: [enums_1.InvoiceStatus.ISSUED, enums_1.InvoiceStatus.CANCELLED],
    [enums_1.InvoiceStatus.CANCELLED]: [],
    [enums_1.InvoiceStatus.VOID]: [],
};
exports.PAYMENT_STATE_TRANSITIONS = {
    [enums_1.PaymentState.UNPAID]: [enums_1.PaymentState.PARTIALLY_PAID, enums_1.PaymentState.PAID],
    [enums_1.PaymentState.PARTIALLY_PAID]: [enums_1.PaymentState.PAID, enums_1.PaymentState.UNPAID],
    [enums_1.PaymentState.PAID]: [enums_1.PaymentState.PARTIALLY_PAID],
    [enums_1.PaymentState.REVERSED]: [enums_1.PaymentState.UNPAID],
};
exports.PAYABLE_TRANSITIONS = {
    [enums_1.AssayerPayableStatus.PENDING]: [enums_1.AssayerPayableStatus.APPROVED, enums_1.AssayerPayableStatus.ON_HOLD, enums_1.AssayerPayableStatus.DISPUTED],
    [enums_1.AssayerPayableStatus.APPROVED]: [enums_1.AssayerPayableStatus.PAID, enums_1.AssayerPayableStatus.ON_HOLD, enums_1.AssayerPayableStatus.DISPUTED],
    [enums_1.AssayerPayableStatus.PAID]: [enums_1.AssayerPayableStatus.DISPUTED],
    [enums_1.AssayerPayableStatus.DISPUTED]: [enums_1.AssayerPayableStatus.PENDING, enums_1.AssayerPayableStatus.APPROVED, enums_1.AssayerPayableStatus.ON_HOLD],
    [enums_1.AssayerPayableStatus.ON_HOLD]: [enums_1.AssayerPayableStatus.PENDING, enums_1.AssayerPayableStatus.APPROVED, enums_1.AssayerPayableStatus.DISPUTED],
};
//# sourceMappingURL=state-machines.js.map