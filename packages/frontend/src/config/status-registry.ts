import {
  AssayerLifecycleStatus,
  AssayerStatus,
  ProjectBranchStatus,
  ProjectStatus,
  AssignmentStatus,
  EmpanelmentStatus,
  CustomerMasterStatus,
  DocumentVerification,
  DocumentStatus,
  ValidationStatus,
  BillingState,
  InvoiceStatus,
  AssayerPayableStatus,
  AssayerInvoiceStatus,
  ExpenseStatus,
  ScheduleStatus,
  FeedbackStatus,
  UserStatus,
  ApplicationStatus,
  InterviewOutcome,
} from '@fapoms/shared';

/**
 * Unified canonical semantic vocabulary.
 * Avoids duplicate taxonomies:
 *   ACTIVE -> positive
 *   INACTIVE -> neutral
 *   ARCHIVED -> archived
 */
export type SemanticCategory =
  | 'positive'
  | 'pending'
  | 'warning'
  | 'danger'
  | 'neutral'
  | 'info'
  | 'archived';

export type StatusIconKey =
  | 'check-circle'
  | 'mail'
  | 'file-check'
  | 'shield-check'
  | 'book-open'
  | 'calendar-off'
  | 'pause-circle'
  | 'shield-alert'
  | 'user-x'
  | 'x-circle'
  | 'archive'
  | 'check'
  | 'minus-circle'
  | 'inbox'
  | 'map'
  | 'users'
  | 'phone'
  | 'check-check'
  | 'calendar'
  | 'file-text'
  | 'lock'
  | 'alert-circle'
  | 'ban'
  | 'clock'
  | 'map-pin'
  | 'play-circle'
  | 'alert-triangle'
  | 'shield-off'
  | 'key-round'
  | 'history'
  | 'file-edit';

export interface StatusDescriptor {
  label: string;
  semantic: SemanticCategory;
  icon?: StatusIconKey;
  description?: string;
  // Compatibility getters/properties
  category?: SemanticCategory;
  fgToken?: string;
  bgToken?: string;
  borderToken?: string;
}

export type DocumentVerificationStatus = DocumentVerification | 'SUPERSEDED';

export type StatusDomain =
  | 'assayerLifecycle'
  | 'assayerOperational'
  | 'branch'
  | 'project'
  | 'assignment'
  | 'empanelment'
  | 'customerMaster'
  | 'documentVerification'
  | 'billingState'
  | 'invoice'
  | 'assayerPayable'
  | 'assayerInvoice'
  | 'billing' // unified billing resolver
  | 'expense'
  | 'document'
  | 'validation'
  | 'schedule'
  | 'feedback'
  | 'user'
  | 'attention'
  | 'rosterAttention'
  | 'applicationStatus'
  | 'interviewOutcome';

// ── 1. Assayer Lifecycle Statuses (11 Canonical States) ──────────────────────
export const ASSAYER_LIFECYCLE_STATUS_MAP: Record<AssayerLifecycleStatus, StatusDescriptor> = {
  [AssayerLifecycleStatus.ACTIVE]: {
    label: 'Active',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Fully onboarded, verified, and active for dispatch',
  },
  [AssayerLifecycleStatus.INVITED]: {
    label: 'Invited',
    semantic: 'info',
    icon: 'mail',
    description: 'Invitation issued; awaiting onboarding registration',
  },
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: {
    label: 'Document Check',
    semantic: 'info',
    icon: 'file-check',
    description: 'Identity & qualifications submitted; awaiting document review',
  },
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: {
    label: 'Background Check',
    semantic: 'info',
    icon: 'shield-check',
    description: 'Undergoing third-party background screening',
  },
  [AssayerLifecycleStatus.TRAINING]: {
    label: 'In Training',
    semantic: 'warning',
    icon: 'book-open',
    description: 'Completing required orientation and audit protocol training',
  },
  [AssayerLifecycleStatus.ON_LEAVE]: {
    label: 'On Leave',
    semantic: 'warning',
    icon: 'calendar-off',
    description: 'Temporarily unavailable due to approved leave',
  },
  [AssayerLifecycleStatus.INACTIVE]: {
    label: 'Inactive',
    semantic: 'neutral',
    icon: 'pause-circle',
    description: 'Temporarily deactivated or paused by operations',
  },
  [AssayerLifecycleStatus.SUSPENDED]: {
    label: 'Suspended',
    semantic: 'danger',
    icon: 'shield-alert',
    description: 'Access suspended due to compliance, audit, or integrity issues',
  },
  [AssayerLifecycleStatus.RESIGNED]: {
    label: 'Resigned',
    semantic: 'archived',
    icon: 'user-x',
    description: 'Voluntarily resigned and off-boarded',
  },
  [AssayerLifecycleStatus.TERMINATED]: {
    label: 'Terminated',
    semantic: 'danger',
    icon: 'x-circle',
    description: 'Engagement formally terminated',
  },
  [AssayerLifecycleStatus.ARCHIVED]: {
    label: 'Archived',
    semantic: 'archived',
    icon: 'archive',
    description: 'Record permanently closed and archived',
  },
};

// ── 2. Assayer Operational Statuses (Database status projection) ─────────────
export const ASSAYER_OPERATIONAL_STATUS_MAP: Record<AssayerStatus, StatusDescriptor> = {
  [AssayerStatus.ACTIVE]: {
    label: 'Operational',
    semantic: 'positive',
    icon: 'check',
  },
  [AssayerStatus.INACTIVE]: {
    label: 'Non-Operational',
    semantic: 'neutral',
    icon: 'minus-circle',
  },
  [AssayerStatus.SUSPENDED]: {
    label: 'Suspended',
    semantic: 'danger',
    icon: 'shield-alert',
  },
};

// ── 3. Branch Lifecycle Statuses (13 Canonical States) ───────────────────────
export const BRANCH_STATUS_MAP: Record<ProjectBranchStatus, StatusDescriptor> = {
  [ProjectBranchStatus.IMPORTED]: {
    label: 'Imported',
    semantic: 'neutral',
    icon: 'inbox',
  },
  [ProjectBranchStatus.PLANNING]: {
    label: 'Planning',
    semantic: 'neutral',
    icon: 'map',
  },
  [ProjectBranchStatus.CANDIDATE_SEARCH]: {
    label: 'Seeking Assayer',
    semantic: 'pending',
    icon: 'users',
  },
  [ProjectBranchStatus.CONTACT_INITIATED]: {
    label: 'Contacted',
    semantic: 'pending',
    icon: 'phone',
  },
  [ProjectBranchStatus.NEGOTIATION]: {
    label: 'Contacted (Legacy)',
    semantic: 'pending',
    icon: 'phone',
  },
  [ProjectBranchStatus.ASSIGNMENT_CONFIRMED]: {
    label: 'Confirmed',
    semantic: 'positive',
    icon: 'check-check',
  },
  [ProjectBranchStatus.SCHEDULED]: {
    label: 'Scheduled',
    semantic: 'info',
    icon: 'calendar',
  },
  [ProjectBranchStatus.AUDIT_COMPLETED]: {
    label: 'Audit Completed',
    semantic: 'positive',
    icon: 'file-text',
  },
  [ProjectBranchStatus.VALIDATION_COMPLETED]: {
    label: 'Validation Done',
    semantic: 'positive',
    icon: 'check-circle',
  },
  [ProjectBranchStatus.CLOSED]: {
    label: 'Closed',
    semantic: 'archived',
    icon: 'lock',
  },
  [ProjectBranchStatus.UNABLE_TO_COVER]: {
    label: 'Unable to Cover',
    semantic: 'danger',
    icon: 'alert-circle',
  },
  [ProjectBranchStatus.ON_HOLD]: {
    label: 'On Hold',
    semantic: 'warning',
    icon: 'pause-circle',
  },
  [ProjectBranchStatus.CANCELLED]: {
    label: 'Cancelled',
    semantic: 'danger',
    icon: 'x-circle',
  },
};

// ── 4. Project Statuses (9 Canonical States) ─────────────────────────────────
export const PROJECT_STATUS_MAP: Record<ProjectStatus, StatusDescriptor> = {
  [ProjectStatus.DRAFT]: {
    label: 'Draft',
    semantic: 'neutral',
    icon: 'file-edit',
  },
  [ProjectStatus.PLANNING]: {
    label: 'Planning',
    semantic: 'neutral',
    icon: 'map',
  },
  [ProjectStatus.SCHEDULING]: {
    label: 'Scheduling',
    semantic: 'info',
    icon: 'calendar',
  },
  [ProjectStatus.EXECUTION]: {
    label: 'In Execution',
    semantic: 'positive',
    icon: 'play-circle',
  },
  [ProjectStatus.VALIDATION]: {
    label: 'Validation',
    semantic: 'info',
    icon: 'file-check',
  },
  [ProjectStatus.COMPLETED]: {
    label: 'Completed',
    semantic: 'positive',
    icon: 'check-check',
  },
  [ProjectStatus.ARCHIVED]: {
    label: 'Archived',
    semantic: 'archived',
    icon: 'archive',
  },
  [ProjectStatus.CANCELLED]: {
    label: 'Cancelled',
    semantic: 'danger',
    icon: 'x-circle',
  },
  [ProjectStatus.ON_HOLD]: {
    label: 'On Hold',
    semantic: 'warning',
    icon: 'pause-circle',
  },
};

// ── 5. Assignment Execution Statuses (7 Canonical States) ───────────────────
export const ASSIGNMENT_STATUS_MAP: Record<AssignmentStatus, StatusDescriptor> = {
  [AssignmentStatus.PENDING]: {
    label: 'Pending Response',
    semantic: 'pending',
    icon: 'clock',
  },
  [AssignmentStatus.ACCEPTED]: {
    label: 'Accepted',
    semantic: 'info',
    icon: 'check',
  },
  [AssignmentStatus.CHECKED_IN]: {
    label: 'Checked In on Site',
    semantic: 'positive',
    icon: 'map-pin',
  },
  [AssignmentStatus.IN_PROGRESS]: {
    label: 'In Progress',
    semantic: 'positive',
    icon: 'play-circle',
  },
  [AssignmentStatus.COMPLETED]: {
    label: 'Completed',
    semantic: 'positive',
    icon: 'check-circle',
  },
  [AssignmentStatus.REJECTED]: {
    label: 'Declined',
    semantic: 'danger',
    icon: 'x-circle',
  },
  [AssignmentStatus.CANCELLED]: {
    label: 'Cancelled',
    semantic: 'danger',
    icon: 'ban',
  },
};

// ── 6. Client Empanelment Standing (8 Canonical States) ─────────────────────
export const EMPANELMENT_STATUS_MAP: Record<EmpanelmentStatus, StatusDescriptor> = {
  [EmpanelmentStatus.ACTIVE]: {
    label: 'Empanelled',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Empanelment confirmed and verified with client bank',
  },
  [EmpanelmentStatus.RECOMMENDED]: {
    label: 'Recommended',
    semantic: 'positive',
    icon: 'check',
    description: 'Recommended for assignment pending formal bank empanelment',
  },
  [EmpanelmentStatus.DOCUMENTS_PENDING]: {
    label: 'Docs Pending',
    semantic: 'pending',
    icon: 'clock',
    description: 'Bank-specific empanelment papers pending upload/submission',
  },
  [EmpanelmentStatus.NOT_RECOMMENDED]: {
    label: 'Not Recommended',
    semantic: 'warning',
    icon: 'alert-triangle',
    description: 'Client does not recommend this assayer for field work',
  },
  [EmpanelmentStatus.INACTIVE]: {
    label: 'Empanelment Inactive',
    semantic: 'neutral',
    icon: 'pause-circle',
    description: 'Empanelment temporarily paused',
  },
  [EmpanelmentStatus.RESIGNED]: {
    label: 'Empanelment Resigned',
    semantic: 'archived',
    icon: 'user-x',
  },
  [EmpanelmentStatus.TERMINATED]: {
    label: 'Empanelment Terminated',
    semantic: 'danger',
    icon: 'shield-off',
    description: 'Empanelment revoked by client bank; bypass strictly prohibited',
  },
  [EmpanelmentStatus.REJECTED]: {
    label: 'Empanelment Rejected',
    semantic: 'danger',
    icon: 'x-circle',
    description: 'Empanelment rejected by client bank; bypass strictly prohibited',
  },
};

// Auxiliary override empanelment descriptor for UI overrides:
export const EMPANELMENT_OVERRIDE_DESCRIPTOR: StatusDescriptor = {
  label: 'Override Active',
  semantic: 'warning',
  icon: 'key-round',
  description: 'Assignment approved via authorized managerial override',
};

// ── 7. Customer Master Reconciliation Status (5 States) ─────────────────────
export const CUSTOMER_MASTER_STATUS_MAP: Record<CustomerMasterStatus, StatusDescriptor> = {
  [CustomerMasterStatus.DRAFT]: {
    label: 'Draft',
    semantic: 'neutral',
    icon: 'file-edit',
  },
  [CustomerMasterStatus.RECONCILED]: {
    label: 'Reconciled',
    semantic: 'info',
    icon: 'check',
  },
  [CustomerMasterStatus.APPROVED]: {
    label: 'Approved',
    semantic: 'positive',
    icon: 'check-circle',
  },
  [CustomerMasterStatus.SUPERSEDED]: {
    label: 'Superseded',
    semantic: 'archived',
    icon: 'history',
  },
  [CustomerMasterStatus.REJECTED]: {
    label: 'Rejected',
    semantic: 'danger',
    icon: 'x-circle',
  },
};

// ── 8. Document Verification Status (4 States) ──────────────────────────────
export const DOCUMENT_VERIFICATION_STATUS_MAP: Record<DocumentVerificationStatus, StatusDescriptor> = {
  [DocumentVerification.PENDING]: {
    label: 'Verification Pending',
    semantic: 'pending',
    icon: 'clock',
    description: 'Document uploaded; awaiting compliance verification',
  },
  [DocumentVerification.VERIFIED]: {
    label: 'Verified',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Evidence content hash and details verified',
  },
  [DocumentVerification.REJECTED]: {
    label: 'Verification Rejected',
    semantic: 'danger',
    icon: 'x-circle',
    description: 'Document rejected due to illegibility, expiry, or mismatch',
  },
  SUPERSEDED: {
    label: 'Superseded',
    semantic: 'archived',
    icon: 'history',
    description: 'A newer version has replaced this document',
  },
};

// ── 9. Billing State (4 States) ─────────────────────────────────────────────
export const BILLING_STATE_MAP: Record<BillingState, StatusDescriptor> = {
  [BillingState.UNBILLED]: {
    label: 'Unbilled',
    semantic: 'neutral',
    icon: 'clock',
    description: 'Assignment completed; ready for client invoice generation',
  },
  [BillingState.INVOICED]: {
    label: 'Invoiced',
    semantic: 'info',
    icon: 'file-text',
    description: 'Client invoice generated and dispatched',
  },
  [BillingState.PAID]: {
    label: 'Paid',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Client payment fully received and reconciled',
  },
  [BillingState.CANCELLED]: {
    label: 'Cancelled',
    semantic: 'danger',
    icon: 'x-circle',
    description: 'Billing line cancelled and excluded from client billing',
  },
};

// ── 10. Invoice Status (4 States) ───────────────────────────────────────────
export const INVOICE_STATUS_MAP: Record<InvoiceStatus, StatusDescriptor> = {
  [InvoiceStatus.DRAFT]: {
    label: 'Draft',
    semantic: 'neutral',
    icon: 'file-edit',
    description: 'Invoice created; pending final ops review and issue',
  },
  [InvoiceStatus.ISSUED]: {
    label: 'Issued (Sent)',
    semantic: 'info',
    icon: 'mail',
    description: 'Invoice dispatched to client bank; awaiting payment',
  },
  [InvoiceStatus.PAID]: {
    label: 'Paid',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Invoice fully settled by client',
  },
  [InvoiceStatus.CANCELLED]: {
    label: 'Cancelled',
    semantic: 'danger',
    icon: 'x-circle',
    description: 'Invoice voided or replaced',
  },
};

// ── 11. Assayer Payable Status (4 States) ───────────────────────────────────
export const ASSAYER_PAYABLE_STATUS_MAP: Record<AssayerPayableStatus, StatusDescriptor> = {
  [AssayerPayableStatus.PENDING]: {
    label: 'Pending Approval',
    semantic: 'pending',
    icon: 'clock',
    description: 'Audit completed; payable pending operations/finance approval',
  },
  [AssayerPayableStatus.APPROVED]: {
    label: 'Approved (Frozen)',
    semantic: 'info',
    icon: 'lock',
    description: 'Approved by finance; payment destination locked and frozen',
  },
  [AssayerPayableStatus.PAID]: {
    label: 'Paid',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Payout transaction confirmed and settled',
  },
  [AssayerPayableStatus.VOIDED]: {
    label: 'Voided',
    semantic: 'danger',
    icon: 'ban',
    description: 'Payable voided due to audit invalidation or error',
  },
};

// ── 12. Assayer Invoice Status (4 States) ───────────────────────────────────
export const ASSAYER_INVOICE_STATUS_MAP: Record<AssayerInvoiceStatus, StatusDescriptor> = {
  [AssayerInvoiceStatus.INVITED]: {
    label: 'Invited',
    semantic: 'pending',
    icon: 'mail',
    description: 'Assayer invited to review and submit eligible payables',
  },
  [AssayerInvoiceStatus.SUBMITTED]: {
    label: 'Submitted',
    semantic: 'info',
    icon: 'file-text',
    description: 'Invoice submitted by assayer; awaiting ops approval',
  },
  [AssayerInvoiceStatus.APPROVED]: {
    label: 'Approved',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Assayer invoice approved for payout',
  },
  [AssayerInvoiceStatus.CANCELLED]: {
    label: 'Cancelled',
    semantic: 'danger',
    icon: 'x-circle',
    description: 'Invoice cancelled; underlying lines returned to pool',
  },
};

// ── 13. Expense Claim Status (3 States) ─────────────────────────────────────
export const EXPENSE_STATUS_MAP: Record<ExpenseStatus, StatusDescriptor> = {
  [ExpenseStatus.PENDING]: {
    label: 'Pending Review',
    semantic: 'pending',
    icon: 'clock',
    description: 'Reimbursement claim submitted; awaiting desk audit',
  },
  [ExpenseStatus.APPROVED]: {
    label: 'Approved',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Expense approved and queued for payout ledger',
  },
  [ExpenseStatus.REJECTED]: {
    label: 'Rejected',
    semantic: 'danger',
    icon: 'x-circle',
    description: 'Claim rejected due to policy breach or missing receipts',
  },
};

// ── 14. Document Workflow Status (9 States) ─────────────────────────────────
export const DOCUMENT_STATUS_MAP: Record<DocumentStatus, StatusDescriptor> = {
  [DocumentStatus.UPLOADED]: {
    label: 'Uploaded',
    semantic: 'neutral',
    icon: 'inbox',
  },
  [DocumentStatus.DISPATCHED]: {
    label: 'Dispatched',
    semantic: 'info',
    icon: 'mail',
  },
  [DocumentStatus.RECEIVED]: {
    label: 'Received',
    semantic: 'info',
    icon: 'file-check',
  },
  [DocumentStatus.SENT_TO_DATA_ENTRY]: {
    label: 'In Data Entry',
    semantic: 'pending',
    icon: 'clock',
  },
  [DocumentStatus.SENT_TO_EXTERNAL_OCR]: {
    label: 'In OCR Engine',
    semantic: 'pending',
    icon: 'clock',
  },
  [DocumentStatus.EXCEL_GENERATED]: {
    label: 'Excel Generated',
    semantic: 'positive',
    icon: 'file-text',
  },
  [DocumentStatus.PROCESSED]: {
    label: 'Processed',
    semantic: 'positive',
    icon: 'check',
  },
  [DocumentStatus.COMPLETED]: {
    label: 'Completed',
    semantic: 'positive',
    icon: 'check-circle',
  },
  [DocumentStatus.ARCHIVED]: {
    label: 'Archived',
    semantic: 'archived',
    icon: 'archive',
  },
};

// ── 15. Validation Status (7 States) ────────────────────────────────────────
export const VALIDATION_STATUS_MAP: Record<ValidationStatus, StatusDescriptor> = {
  [ValidationStatus.PENDING]: {
    label: 'Pending Validation',
    semantic: 'pending',
    icon: 'clock',
  },
  [ValidationStatus.ASSIGNED]: {
    label: 'Assigned to Validator',
    semantic: 'info',
    icon: 'users',
  },
  [ValidationStatus.OCR_PROCESSING]: {
    label: 'Processing OCR',
    semantic: 'pending',
    icon: 'clock',
  },
  [ValidationStatus.HUMAN_REVIEW]: {
    label: 'Under Human Review',
    semantic: 'warning',
    icon: 'book-open',
  },
  [ValidationStatus.CORRECTION_REQUIRED]: {
    label: 'Correction Required',
    semantic: 'danger',
    icon: 'alert-triangle',
  },
  [ValidationStatus.APPROVED]: {
    label: 'Validation Approved',
    semantic: 'positive',
    icon: 'check-circle',
  },
  [ValidationStatus.SUBMITTED]: {
    label: 'Submitted to Client',
    semantic: 'positive',
    icon: 'check-check',
  },
};

// ── 16. Schedule Status (4 States) ──────────────────────────────────────────
export const SCHEDULE_STATUS_MAP: Record<ScheduleStatus, StatusDescriptor> = {
  [ScheduleStatus.TENTATIVE]: {
    label: 'Tentative',
    semantic: 'pending',
    icon: 'calendar',
  },
  [ScheduleStatus.CONFIRMED]: {
    label: 'Confirmed',
    semantic: 'positive',
    icon: 'check-check',
  },
  [ScheduleStatus.RESCHEDULED]: {
    label: 'Rescheduled',
    semantic: 'warning',
    icon: 'calendar-off',
  },
  [ScheduleStatus.COMPLETED]: {
    label: 'Completed',
    semantic: 'positive',
    icon: 'check-circle',
  },
};

// ── 17. Feedback Thread Status (5 States) ───────────────────────────────────
export const FEEDBACK_STATUS_MAP: Record<FeedbackStatus, StatusDescriptor> = {
  [FeedbackStatus.OPEN]: {
    label: 'Open',
    semantic: 'pending',
    icon: 'clock',
  },
  [FeedbackStatus.ACKNOWLEDGED]: {
    label: 'Acknowledged',
    semantic: 'info',
    icon: 'mail',
  },
  [FeedbackStatus.IN_PROGRESS]: {
    label: 'In Progress',
    semantic: 'positive',
    icon: 'play-circle',
  },
  [FeedbackStatus.RESOLVED]: {
    label: 'Resolved',
    semantic: 'positive',
    icon: 'check-circle',
  },
  [FeedbackStatus.CLOSED]: {
    label: 'Closed',
    semantic: 'archived',
    icon: 'archive',
  },
};

// ── 18. User Account Status (6 States) ──────────────────────────────────────
export const USER_STATUS_MAP: Record<UserStatus, StatusDescriptor> = {
  [UserStatus.INVITED]: {
    label: 'Invited',
    semantic: 'info',
    icon: 'mail',
  },
  [UserStatus.ACTIVE]: {
    label: 'Active',
    semantic: 'positive',
    icon: 'check-circle',
  },
  [UserStatus.SUSPENDED]: {
    label: 'Suspended',
    semantic: 'danger',
    icon: 'shield-alert',
  },
  [UserStatus.LOCKED]: {
    label: 'Locked',
    semantic: 'danger',
    icon: 'lock',
  },
  [UserStatus.DISABLED]: {
    label: 'Disabled',
    semantic: 'neutral',
    icon: 'ban',
  },
  [UserStatus.ARCHIVED]: {
    label: 'Archived',
    semantic: 'archived',
    icon: 'archive',
  },
};
// ── 19. Derived Operational Attention States (Work Queue Triage) ───────────
export type OperationalAttentionState =
  | 'NEEDS_RESPONSE'
  | 'OVERDUE'
  | 'CHECKIN_MISSING'
  | 'IN_PROGRESS'
  | 'AWAITING_VALIDATION'
  | 'CONFLICT'
  | 'BLOCKED'
  | 'NORMAL';

export const OPERATIONAL_ATTENTION_STATUS_MAP: Record<OperationalAttentionState, StatusDescriptor> = {
  NEEDS_RESPONSE: {
    label: 'Needs Response',
    semantic: 'pending',
    icon: 'clock',
    description: 'Awaiting assayer acknowledgement or response',
  },
  OVERDUE: {
    label: 'Overdue',
    semantic: 'danger',
    icon: 'alert-triangle',
    description: 'Scheduled visit date has passed without completion',
  },
  CHECKIN_MISSING: {
    label: 'Check-in Missing',
    semantic: 'warning',
    icon: 'map-pin',
    description: 'Work underway or submitted without on-site GPS check-in',
  },
  IN_PROGRESS: {
    label: 'In Field',
    semantic: 'positive',
    icon: 'play-circle',
    description: 'Assayer is checked in and conducting field audit',
  },
  AWAITING_VALIDATION: {
    label: 'Awaiting QA',
    semantic: 'info',
    icon: 'file-check',
    description: 'Field audit complete; packet awaiting QA desk review',
  },
  CONFLICT: {
    label: 'Conflict',
    semantic: 'danger',
    icon: 'alert-circle',
    description: 'Concurrent modification (409) or branch scheduling collision',
  },
  BLOCKED: {
    label: 'Blocked',
    semantic: 'danger',
    icon: 'pause-circle',
    description: 'Escalated priority or unresolved blocking field issue',
  },
  NORMAL: {
    label: 'On Track',
    semantic: 'neutral',
    icon: 'check',
    description: 'Accepted visit scheduled for a future date',
  },
};

// ── 20. Derived Workforce Roster Attention States ──────────────────────────
export type RosterAttentionState =
  | 'ACTION_REQUIRED'
  | 'PAYOUT_BLOCKED'
  | 'EMPANELMENT_ISSUE'
  | 'DEPLOYABLE'
  | 'NORMAL';

export const ROSTER_ATTENTION_STATUS_MAP: Record<RosterAttentionState, StatusDescriptor> = {
  ACTION_REQUIRED: {
    label: 'Action Required',
    semantic: 'warning',
    icon: 'alert-circle',
    description: 'Verification or vetting step requires desk action',
  },
  PAYOUT_BLOCKED: {
    label: 'Payout Blocked',
    semantic: 'danger',
    icon: 'ban',
    description: 'Workable assayer missing mandatory banking details or PAN',
  },
  EMPANELMENT_ISSUE: {
    label: 'Empanelment Issue',
    semantic: 'warning',
    icon: 'shield-alert',
    description: 'Expired certification or no plannable client bank standings',
  },
  DEPLOYABLE: {
    label: 'Deployable',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Active lifecycle, complete profile, and plannable with clients',
  },
  NORMAL: {
    label: 'On Track',
    semantic: 'neutral',
    icon: 'check',
    description: 'Standard record with no outstanding operational blocker',
  },
};

// ── 21. Appraiser Recruitment: self-registration application status (5 States) ─
export const APPLICATION_STATUS_MAP: Record<ApplicationStatus, StatusDescriptor> = {
  [ApplicationStatus.DRAFT]: {
    label: 'Draft',
    semantic: 'neutral',
    icon: 'file-edit',
    description: 'Candidate is still filling this in; not yet visible to HR',
  },
  [ApplicationStatus.PENDING_VALIDATION]: {
    label: 'Pending Review',
    semantic: 'pending',
    icon: 'clock',
    description: 'Submitted by the candidate; awaiting an HR decision',
  },
  [ApplicationStatus.AWAITING_INFO]: {
    label: 'Awaiting Info',
    semantic: 'warning',
    icon: 'alert-triangle',
    description: 'HR asked the candidate for a correction or an additional document',
  },
  [ApplicationStatus.REJECTED]: {
    label: 'Rejected',
    semantic: 'danger',
    icon: 'x-circle',
    description: 'HR declined this application',
  },
  [ApplicationStatus.APPROVED]: {
    label: 'Approved',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Promoted to a real assayer record',
  },
};

// ── 22. Appraiser Recruitment: HR interview outcome (2 States) ─────────────
export const INTERVIEW_OUTCOME_MAP: Record<InterviewOutcome, StatusDescriptor> = {
  [InterviewOutcome.PASS]: {
    label: 'Pass',
    semantic: 'positive',
    icon: 'check-circle',
    description: 'Cleared to receive a self-registration invite',
  },
  [InterviewOutcome.FAIL]: {
    label: 'Fail',
    semantic: 'danger',
    icon: 'x-circle',
    description: 'Not cleared; no invite was sent',
  },
};

// ── Backward-compatible Unified Billing Map ─────────────────────────────────
export const BILLING_STATUS_MAP: Record<string, StatusDescriptor> = {
  ...BILLING_STATE_MAP,
  ...INVOICE_STATUS_MAP,
  ...ASSAYER_PAYABLE_STATUS_MAP,
  ...ASSAYER_INVOICE_STATUS_MAP,
};

// ── Safe Unknown Status Humanizer & Diagnostics ─────────────────────────────

const warnedUnknownStatuses = new Set<string>();

function warnUnknownStatusOnce(domain: string, rawStatus: unknown): void {
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production') {
    return;
  }
  const key = `${domain}:${String(rawStatus)}`;
  if (!warnedUnknownStatuses.has(key)) {
    warnedUnknownStatuses.add(key);
    console.warn(
      `[StatusRegistry] Unrecognized status "${String(rawStatus)}" in domain "${domain}". Falling back to safe neutral descriptor.`
    );
  }
}

/**
 * Safely humanizes raw, unknown, or snake_case status strings into clean, readable labels.
 * E.g., 'IN_PROGRESS' -> 'In Progress', 'DOCUMENT_VERIFICATION' -> 'Document Verification'.
 */
export function humanizeStatus(status: unknown): string {
  if (status === null || status === undefined) return 'Unknown';
  const str = String(status).trim();
  if (!str) return 'Unknown';

  return str
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function createFallbackDescriptor(domain: string, rawStatus: unknown): StatusDescriptor {
  warnUnknownStatusOnce(domain, rawStatus);
  const label = humanizeStatus(rawStatus);
  return {
    label,
    semantic: 'neutral',
    icon: 'alert-circle',
    description: `Unrecognized status: ${String(rawStatus ?? 'unknown')}`,
    category: 'neutral',
    fgToken: 'var(--status-neutral-fg, var(--status-inactive-fg))',
    bgToken: 'var(--status-neutral-bg, var(--status-inactive-bg))',
    borderToken: 'var(--status-neutral-border, var(--status-inactive-border))',
  };
}

// ── Unified Pure Registry Resolver ─────────────────────────────────────────
export function getStatusDescriptor(
  domain: StatusDomain,
  status: string | null | undefined
): StatusDescriptor {
  const norm = String(status ?? '').trim().toUpperCase();

  if (domain === 'empanelment' && norm === 'OVERRIDDEN') {
    return {
      ...EMPANELMENT_OVERRIDE_DESCRIPTOR,
      category: EMPANELMENT_OVERRIDE_DESCRIPTOR.semantic,
      ...getSemanticTokens(EMPANELMENT_OVERRIDE_DESCRIPTOR.semantic),
    };
  }

  let map: Record<string, StatusDescriptor>;

  switch (domain) {
    case 'assayerLifecycle':
      map = ASSAYER_LIFECYCLE_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'assayerOperational':
      map = ASSAYER_OPERATIONAL_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'branch':
      map = BRANCH_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'project':
      map = PROJECT_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'assignment':
      map = ASSIGNMENT_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'empanelment':
      map = EMPANELMENT_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'customerMaster':
      map = CUSTOMER_MASTER_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'documentVerification':
      map = DOCUMENT_VERIFICATION_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'billingState':
      map = BILLING_STATE_MAP as Record<string, StatusDescriptor>;
      break;
    case 'invoice':
      map = INVOICE_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'assayerPayable':
      map = ASSAYER_PAYABLE_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'assayerInvoice':
      map = ASSAYER_INVOICE_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'billing':
      map = BILLING_STATUS_MAP;
      break;
    case 'expense':
      map = EXPENSE_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'document':
      map = DOCUMENT_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'validation':
      map = VALIDATION_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'schedule':
      map = SCHEDULE_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'feedback':
      map = FEEDBACK_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'user':
      map = USER_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'attention':
      map = OPERATIONAL_ATTENTION_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'rosterAttention':
      map = ROSTER_ATTENTION_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'applicationStatus':
      map = APPLICATION_STATUS_MAP as Record<string, StatusDescriptor>;
      break;
    case 'interviewOutcome':
      map = INTERVIEW_OUTCOME_MAP as Record<string, StatusDescriptor>;
      break;
    default:
      map = {};
  }

  if (map[norm]) {
    const desc = map[norm];
    const tokens = getSemanticTokens(desc.semantic);
    return {
      ...desc,
      category: desc.semantic,
      ...tokens,
    };
  }

  // Fallback descriptor for unrecognized or evolving backend statuses
  return createFallbackDescriptor(domain, status);
}

export function getSemanticTokens(semantic: SemanticCategory): {
  fgToken: string;
  bgToken: string;
  borderToken: string;
} {
  return {
    fgToken: `var(--status-${semantic}-fg, var(--status-${resolveCategoryCssName(semantic)}-fg))`,
    bgToken: `var(--status-${semantic}-bg, var(--status-${resolveCategoryCssName(semantic)}-bg))`,
    borderToken: `var(--status-${semantic}-border, var(--status-${resolveCategoryCssName(semantic)}-border))`,
  };
}

function resolveCategoryCssName(category: SemanticCategory): string {
  switch (category) {
    case 'positive':
      return 'active';
    case 'neutral':
      return 'inactive';
    default:
      return category;
  }
}
