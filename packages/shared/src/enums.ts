export enum ProjectStatus {
  DRAFT = 'DRAFT',
  PLANNING = 'PLANNING',
  SCHEDULING = 'SCHEDULING',
  EXECUTION = 'EXECUTION',
  VALIDATION = 'VALIDATION',
  COMPLETED = 'COMPLETED',
  ARCHIVED = 'ARCHIVED',
  CANCELLED = 'CANCELLED',
  ON_HOLD = 'ON_HOLD',
}

export enum ProjectBranchStatus {
  IMPORTED = 'IMPORTED',
  PLANNING = 'PLANNING',
  CANDIDATE_SEARCH = 'CANDIDATE_SEARCH',
  CONTACT_INITIATED = 'CONTACT_INITIATED',
  NEGOTIATION = 'NEGOTIATION',
  ASSIGNMENT_CONFIRMED = 'ASSIGNMENT_CONFIRMED',
  SCHEDULED = 'SCHEDULED',
  AUDIT_COMPLETED = 'AUDIT_COMPLETED',
  VALIDATION_COMPLETED = 'VALIDATION_COMPLETED',
  CLOSED = 'CLOSED',
  UNABLE_TO_COVER = 'UNABLE_TO_COVER',
  ON_HOLD = 'ON_HOLD',
  CANCELLED = 'CANCELLED',
}

export enum AssessmentStatus {
  PENDING_PLANNING = 'PENDING_PLANNING',
  ASSESSOR_RECOMMENDED = 'ASSESSOR_RECOMMENDED',
  IN_NEGOTIATION = 'IN_NEGOTIATION',
  ASSIGNED_AND_SCHEDULED = 'ASSIGNED_AND_SCHEDULED',
  UNASSIGNED = 'UNASSIGNED',
  AWAITING_CLIENT_DATA = 'AWAITING_CLIENT_DATA',
  CLIENT_DATA_RECEIVED = 'CLIENT_DATA_RECEIVED',
  PDF_GENERATED = 'PDF_GENERATED',
  READY_FOR_DISPATCH = 'READY_FOR_DISPATCH',
  DISPATCHED_TO_ASSESSOR = 'DISPATCHED_TO_ASSESSOR',
  AUDITED_PDF_RECEIVED = 'AUDITED_PDF_RECEIVED',
  SENT_TO_DATA_ENTRY = 'SENT_TO_DATA_ENTRY',
  DATA_ENTRY_IN_PROGRESS = 'DATA_ENTRY_IN_PROGRESS',
  CLARIFICATION_NEEDED = 'CLARIFICATION_NEEDED',
  REPORT_FINALIZED = 'REPORT_FINALIZED',
  PENDING_HEAD_APPROVAL = 'PENDING_HEAD_APPROVAL',
  DELIVERED_TO_CLIENT = 'DELIVERED_TO_CLIENT',
  COMPLETED = 'COMPLETED',
}

export enum AssignmentStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  CHECKED_IN = 'CHECKED_IN',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

/**
 * Assayer reimbursement claim category and review state. Kept here (not in the backend entity) so the
 * mobile submit form and the web review queue validate against the same set the backend DTO enforces —
 * a backend-added category must not silently 400 a field submission.
 */
export enum ExpenseCategory {
  TRAVEL_KM = 'TRAVEL_KM',
  TOLL = 'TOLL',
  FOOD = 'FOOD',
  OTHER = 'OTHER',
}

export enum ExpenseStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum ScheduleStatus {
  TENTATIVE = 'TENTATIVE',
  CONFIRMED = 'CONFIRMED',
  RESCHEDULED = 'RESCHEDULED',
  COMPLETED = 'COMPLETED',
}

export enum DocumentStatus {
  UPLOADED = 'UPLOADED',
  DISPATCHED = 'DISPATCHED',
  RECEIVED = 'RECEIVED',
  SENT_TO_DATA_ENTRY = 'SENT_TO_DATA_ENTRY',
  SENT_TO_EXTERNAL_OCR = 'SENT_TO_EXTERNAL_OCR',
  EXCEL_GENERATED = 'EXCEL_GENERATED',
  PROCESSED = 'PROCESSED',
  COMPLETED = 'COMPLETED',
  ARCHIVED = 'ARCHIVED',
}

/**
 * How a document reached the assayer. Recorded per dispatch so the audit trail can answer
 * "was this sent automatically the day before the audit, or pushed manually by an operator,
 * and by whom" — spec §8.2/§8.3.
 */
export enum DispatchMethod {
  AUTO = 'AUTO',
  MANUAL = 'MANUAL',
}

export enum DocumentType {
  BRANCH_LIST = 'BRANCH_LIST',
  CUSTOMER_MASTER_DATA = 'CUSTOMER_MASTER_DATA',
  PRE_FIELD_AUDIT_PDF = 'PRE_FIELD_AUDIT_PDF',
  AUDITED_RETURN_PDF = 'AUDITED_RETURN_PDF',
  GENERATED_EXCEL = 'GENERATED_EXCEL',
  FINAL_REPORT = 'FINAL_REPORT',
}

export enum ValidationStatus {
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  OCR_PROCESSING = 'OCR_PROCESSING',
  HUMAN_REVIEW = 'HUMAN_REVIEW',
  CORRECTION_REQUIRED = 'CORRECTION_REQUIRED',
  APPROVED = 'APPROVED',
  SUBMITTED = 'SUBMITTED',
}

export enum CustomerMasterStatus {
  DRAFT = 'DRAFT',
  RECONCILED = 'RECONCILED',
  APPROVED = 'APPROVED',
  SUPERSEDED = 'SUPERSEDED',
  REJECTED = 'REJECTED',
}

export enum ValidationQueryStatus {
  OPEN = 'OPEN',
  RESPONDED = 'RESPONDED',
  RESOLVED = 'RESOLVED',
}

export enum AssayerStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
}

export enum AssayerLifecycleStatus {
  INVITED = 'INVITED',
  DOCUMENT_VERIFICATION = 'DOCUMENT_VERIFICATION',
  BACKGROUND_VERIFICATION = 'BACKGROUND_VERIFICATION',
  TRAINING = 'TRAINING',
  ACTIVE = 'ACTIVE',
  ON_LEAVE = 'ON_LEAVE',
  SUSPENDED = 'SUSPENDED',
  INACTIVE = 'INACTIVE',
  RESIGNED = 'RESIGNED',
  TERMINATED = 'TERMINATED',
  ARCHIVED = 'ARCHIVED',
}

export enum UserStatus {
  INVITED = 'INVITED',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  LOCKED = 'LOCKED',
  DISABLED = 'DISABLED',
  ARCHIVED = 'ARCHIVED',
}

export enum SystemRole {
  SUPER_ADMINISTRATOR = 'SUPER_ADMINISTRATOR',
  ADMINISTRATOR = 'ADMINISTRATOR',
  OPERATIONS_MANAGER = 'OPERATIONS_MANAGER',
  OPERATIONS_EXECUTIVE = 'OPERATIONS_EXECUTIVE',
  VALIDATION_MANAGER = 'VALIDATION_MANAGER',
  VALIDATOR = 'VALIDATOR',
  DOCUMENT_EXECUTIVE = 'DOCUMENT_EXECUTIVE',
  /**
   * Owns the collected-paperwork queue. Per spec §12.8 the application does NOT assign work
   * to individual data-entry operators: every returned PDF lands with the Head, who downloads
   * it and distributes work through the existing manual process. The system tracks lifecycle,
   * ownership and progress — it does not route to individuals.
   */
  DATA_ENTRY_HEAD = 'DATA_ENTRY_HEAD',
  ASSAYER = 'ASSAYER',
  CLIENT_USER = 'CLIENT_USER',
  /**
   * Owns the assayer workforce: onboarding and the lifecycle from INVITED through
   * to ACTIVE, personal and banking details, government identity documents, and
   * compensation terms. Assayer records were previously editable by whoever held
   * an operations role, which mixed workforce administration into audit planning.
   */
  HR_MANAGER = 'HR_MANAGER',
  /**
   * Owns the money: client receivables, assayer disbursements, invoicing and
   * financial reporting. Finance work was previously bundled into the operations
   * roles because billing had no dedicated owner, which meant anyone who could
   * plan an audit could also issue an invoice.
   */
  FINANCE_MANAGER = 'FINANCE_MANAGER',
  READ_ONLY_AUDITOR = 'READ_ONLY_AUDITOR',
}

export enum PermissionAction {
  VIEW = 'VIEW',
  CREATE = 'CREATE',
  EDIT = 'EDIT',
  DELETE = 'DELETE',
  ARCHIVE = 'ARCHIVE',
  CLOSE = 'CLOSE',
  EXPORT = 'EXPORT',
  IMPORT = 'IMPORT',
  MERGE = 'MERGE',
  NEGOTIATE = 'NEGOTIATE',
  ACCEPT = 'ACCEPT',
  CANCEL = 'CANCEL',
  ASSIGN = 'ASSIGN',
  REVIEW = 'REVIEW',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  REOPEN = 'REOPEN',
  UPLOAD = 'UPLOAD',
  GENERATE = 'GENERATE',
  DOWNLOAD = 'DOWNLOAD',
  REPLACE = 'REPLACE',
  MODIFY = 'MODIFY',
  RESCHEDULE = 'RESCHEDULE',
}

export enum PermissionResource {
  PROJECT = 'PROJECT',
  BRANCH = 'BRANCH',
  ASSIGNMENT = 'ASSIGNMENT',
  SCHEDULING = 'SCHEDULING',
  /**
   * Candidate recommendation, day planning, and the business-rule engine.
   *
   * The planning controller already guarded 18 endpoints with `planning:*` permissions, but
   * PLANNING was never a member of this enum and no such permission row existed — so the guard
   * could not be satisfied by any role, including SUPER_ADMINISTRATOR. That is why no business
   * rule had ever been created: the rule-management API was unreachable.
   */
  PLANNING = 'PLANNING',
  DOCUMENT = 'DOCUMENT',
  VALIDATION = 'VALIDATION',
  ASSAYER = 'ASSAYER',
  CLIENT = 'CLIENT',
  USER = 'USER',
  ROLE = 'ROLE',
  CONFIGURATION = 'CONFIGURATION',
  REFERENCE_DATA = 'REFERENCE_DATA',
  AUDIT_LOG = 'AUDIT_LOG',
  /**
   * The unified billing engine: receivables, payables, invoices, payments and
   * financial reporting. Billing previously had no permission resource of its own
   * and was guarded only by coarse role checks.
   */
  BILLING = 'BILLING',
}

export enum AuthorizationScope {
  SELF = 'SELF',
  ASSIGNED_RECORDS = 'ASSIGNED_RECORDS',
  TEAM = 'TEAM',
  DEPARTMENT = 'DEPARTMENT',
  REGION = 'REGION',
  STATE = 'STATE',
  CLIENT = 'CLIENT',
  ORGANIZATION = 'ORGANIZATION',
  PLATFORM = 'PLATFORM',
}

export enum CommunicationType {
  PHONE = 'PHONE',
  WHATSAPP = 'WHATSAPP',
  EMAIL = 'EMAIL',
  SYSTEM = 'SYSTEM',
}

export enum TravelMode {
  CAR = 'CAR',
  TRAIN = 'TRAIN',
  BUS = 'BUS',
  FLIGHT = 'FLIGHT',
  TWO_WHEELER = 'TWO_WHEELER',
  OTHER = 'OTHER',
}

export enum EventCategory {
  OPERATIONAL = 'OPERATIONAL',
  USER = 'USER',
  WORKFLOW = 'WORKFLOW',
  SYSTEM = 'SYSTEM',
}

export enum ClientLifecycleStatus {
  PROSPECT = 'PROSPECT',
  ONBOARDING = 'ONBOARDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  INACTIVE = 'INACTIVE',
  TERMINATED = 'TERMINATED',
  ARCHIVED = 'ARCHIVED',
}

export enum ClientType {
  BANK = 'BANK',
  NBFC = 'NBFC',
  MICROFINANCE = 'MICROFINANCE',
  INSURANCE = 'INSURANCE',
  CORPORATE = 'CORPORATE',
  GOVERNMENT = 'GOVERNMENT',
  OTHER = 'OTHER',
}

export enum ClientBillingStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  INACTIVE = 'INACTIVE',
}

export enum ClientBillingEventType {
  STATUS_CHANGE = 'STATUS_CHANGE',
  REMARK = 'REMARK',
  PROFILE_UPDATE = 'PROFILE_UPDATE',
}

export enum ContractStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  TERMINATED = 'TERMINATED',
  RENEWED = 'RENEWED',
}

export enum Priority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

// ---------------------------------------------------------------------------
// Multi-level Billing Engine (Client / Project / Assignment / Assayer Payable)
// ---------------------------------------------------------------------------

/** The operational entity a billing line belongs to. */
export enum BillingLevel {
  CLIENT = 'CLIENT',
  PROJECT = 'PROJECT',
  ASSIGNMENT = 'ASSIGNMENT',
}

/**
 * Canonical billing state machine.
 *
 * Forward spine (spec §6):
 *   Not Billable → Pending Billing → Ready for Billing → Draft → Submitted
 *     → Under Review → (Rejected ⇄ Draft) → Approved → Invoiced
 *     → Partially Paid → Paid
 * Cross-cutting: On Hold, Disputed, Cancelled, Adjusted.
 */
export enum BillingState {
  NOT_BILLABLE = 'NOT_BILLABLE',
  PENDING_BILLING = 'PENDING_BILLING',
  READY_FOR_BILLING = 'READY_FOR_BILLING',
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  REJECTED = 'REJECTED',
  APPROVED = 'APPROVED',
  INVOICED = 'INVOICED',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  ON_HOLD = 'ON_HOLD',
  DISPUTED = 'DISPUTED',
  CANCELLED = 'CANCELLED',
  ADJUSTED = 'ADJUSTED',
}

/** Money-collection status, tracked independently of the approval pipeline. */
export enum PaymentState {
  UNPAID = 'UNPAID',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  REVERSED = 'REVERSED',
}

/** How a price is computed. */
export enum BillingPricingModel {
  FLAT_RATE = 'FLAT_RATE',
  PER_ASSIGNMENT = 'PER_ASSIGNMENT',
  PER_BRANCH = 'PER_BRANCH',
  PER_PACKET = 'PER_PACKET',
  HOURLY = 'HOURLY',
  RETAINER = 'RETAINER',
}

/** Consolidation of a set of approved billing entries into an invoice. */
export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  ISSUED = 'ISSUED',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  DISPUTED = 'DISPUTED',
  CANCELLED = 'CANCELLED',
  VOID = 'VOID',
}

/** Aggregation scope of an invoice. */
export enum InvoiceType {
  CONSOLIDATED = 'CONSOLIDATED',
  PER_PROJECT = 'PER_PROJECT',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  RECEIVED = 'RECEIVED',
  REVERSED = 'REVERSED',
  ALLOCATED = 'ALLOCATED',
}

/**
 * Which way money moved. Both directions live in one payments table so that
 * "every payment the business made or received" is a single query — cash-flow
 * and the assayer's running balance both derive from it.
 *
 * INBOUND  — a client paying one of our invoices (accounts receivable).
 * OUTBOUND — us disbursing an approved assayer payable (accounts payable).
 */
export enum PaymentDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

export enum PaymentMethod {
  BANK_TRANSFER = 'BANK_TRANSFER',
  NEFT = 'NEFT',
  RTGS = 'RTGS',
  UPI = 'UPI',
  CHEQUE = 'CHEQUE',
  CARD = 'CARD',
  OTHER = 'OTHER',
}

/** Assayer payable is deliberately separate from client billing. */
export enum AssayerPayableStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  PAID = 'PAID',
  DISPUTED = 'DISPUTED',
  ON_HOLD = 'ON_HOLD',
}

export enum BillingConflictSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

export enum BillingConflictStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
  MERGED = 'MERGED',
  SEPARATED = 'SEPARATED',
  REASSIGNED = 'REASSIGNED',
  OVERRIDDEN = 'OVERRIDDEN',
  REJECTED = 'REJECTED',
  ON_HOLD = 'ON_HOLD',
}

/** Resolution actions offered on the conflict screen. */
export enum BillingConflictAction {
  RESOLVE = 'RESOLVE',
  MERGE = 'MERGE',
  SEPARATE = 'SEPARATE',
  REASSIGN = 'REASSIGN',
  OVERRIDE = 'OVERRIDE',
  REJECT = 'REJECT',
  PUT_ON_HOLD = 'PUT_ON_HOLD',
}

/** What kind of record a billing history/audit event refers to. */
export enum BillingEntityType {
  ENTRY = 'ENTRY',
  INVOICE = 'INVOICE',
  PAYMENT = 'PAYMENT',
  PAYABLE = 'PAYABLE',
  CONFLICT = 'CONFLICT',
}

/**
 * Notification classification and delivery lifecycle.
 *
 * Before this, a notification row carried only a title, a message and `is_read`.
 * That made three things impossible: knowing *why* a notification exists (no
 * type), knowing whether it ever actually reached anyone (no delivery state),
 * and grouping or filtering a person's inbox (no category). All three are
 * required for the notification centre and for push retry, so they are modelled
 * here rather than encoded into the title string.
 */
export enum NotificationCategory {
  ASSIGNMENT = 'ASSIGNMENT',
  VALIDATION = 'VALIDATION',
  DOCUMENT = 'DOCUMENT',
  PLANNING = 'PLANNING',
  WORKFORCE = 'WORKFORCE',
  BILLING = 'BILLING',
  SYSTEM = 'SYSTEM',
}

/**
 * Delivery lifecycle for one notification row.
 *
 * `PENDING` → `SENT` → `DELIVERED` → `READ` is the happy path. `FAILED` is
 * terminal only once attempts are exhausted; `SUPPRESSED` means a preference or
 * a dedupe rule deliberately stopped it, which is distinct from failure and must
 * not be retried.
 */
export enum NotificationStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  FAILED = 'FAILED',
  SUPPRESSED = 'SUPPRESSED',
}

export enum NotificationChannel {
  IN_APP = 'IN_APP',
  PUSH = 'PUSH',
  EMAIL = 'EMAIL',
}

/** Drives ordering and, later, whether a push may bypass quiet hours. */
export enum NotificationPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}
