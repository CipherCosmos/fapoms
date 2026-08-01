import { AssessmentStatus, BillingState, ClientBillingStatus, InvoiceStatus, PaymentState, AssayerPayableStatus, ProjectStatus, ScheduleStatus, ValidationStatus } from './enums';
export type TransitionMap<T extends string> = Partial<Record<T, T[]>>;
export declare const PROJECT_TRANSITIONS: TransitionMap<ProjectStatus>;
export declare const ASSESSMENT_TRANSITIONS: TransitionMap<AssessmentStatus>;
export declare const SCHEDULE_TRANSITIONS: TransitionMap<ScheduleStatus>;
export declare const VALIDATION_TRANSITIONS: TransitionMap<ValidationStatus>;
export declare const BILLING_TRANSITIONS: TransitionMap<ClientBillingStatus>;
export declare function isValidTransition<T extends string>(transitions: TransitionMap<T>, currentState: T, targetState: T): boolean;
/**
 * Multi-level billing state machine (spec §6).
 *
 * Forward spine:
 *   NOT_BILLABLE → PENDING_BILLING → READY_FOR_BILLING → DRAFT → SUBMITTED
 *     → UNDER_REVIEW → (REJECTED ⇄ DRAFT) → APPROVED → INVOICED
 *     → PARTIALLY_PAID → PAID
 * Cross-cutting hold/dispute/cancel/adjust, each with an escape hatch.
 */
export declare const BILLING_STATE_TRANSITIONS: TransitionMap<BillingState>;
export declare const INVOICE_TRANSITIONS: TransitionMap<InvoiceStatus>;
export declare const PAYMENT_STATE_TRANSITIONS: TransitionMap<PaymentState>;
export declare const PAYABLE_TRANSITIONS: TransitionMap<AssayerPayableStatus>;
//# sourceMappingURL=state-machines.d.ts.map