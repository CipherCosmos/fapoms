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
  /**
   * The product / support / development team. Owns the two-way feedback channel:
   * receives bug reports, enhancement requests and process suggestions from every
   * other user (staff, clients and field assayers), triages them, and replies in
   * thread. This is a product-facing responsibility, deliberately distinct from
   * ADMINISTRATOR (system configuration) — though admins also hold the feedback
   * queue so nothing is ever blocked waiting for this role to be staffed.
   */
  PRODUCT_SUPPORT = 'PRODUCT_SUPPORT',
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

/**
 * How a field worker physically gets to a branch. The vocabulary of the transport rate card:
 * every mode here can carry a per-km cost, and the offer engine recommends travel money in
 * terms of these. CAR/TWO_WHEELER mean the assayer's own vehicle (fuel + wear); TAXI and
 * AUTO_RICKSHAW are hired point-to-point; BUS/TRAIN are fares. OTHER exists for the true
 * odd cases (ferry, shared jeep) and deliberately has no special handling anywhere.
 */
export enum TravelMode {
  CAR = 'CAR',
  TRAIN = 'TRAIN',
  BUS = 'BUS',
  FLIGHT = 'FLIGHT',
  TWO_WHEELER = 'TWO_WHEELER',
  AUTO_RICKSHAW = 'AUTO_RICKSHAW',
  TAXI = 'TAXI',
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
// Billing — the assignment is the ledger line
// ---------------------------------------------------------------------------
//
// Two ledgers, one source. When an assignment completes, the system books the assayer's fee
// as a payable (what we owe them) and the client's line as a billing entry (what they owe us).
// Each side has a three-step life and one flag. Nothing here is typed by a human.

/**
 * The client-side line for one assignment.
 *
 *   UNBILLED → INVOICED → PAID          (+ CANCELLED when its invoice is cancelled it goes
 *                                         back to UNBILLED; CANCELLED is for a line that
 *                                         will never be billed)
 *
 * "Partially paid" is not a state: it is `INVOICED` with `paidAmount > 0`. A held line is
 * `onHold = true`, whatever its state — a hold blocks invoicing, it is not a place in the
 * pipeline.
 */
export enum BillingState {
  UNBILLED = 'UNBILLED',
  INVOICED = 'INVOICED',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

/**
 * A client invoice: a set of completed assignments for one client.
 *
 *   DRAFT → ISSUED ("Sent") → PAID     (+ CANCELLED from DRAFT or an unpaid ISSUED)
 *
 * Part-payment is derived: `paidAmount > 0 && outstandingAmount > 0`.
 */
export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  ISSUED = 'ISSUED',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

/**
 * Which way money moved. Both directions live in one payments table so that
 * "every payment the business made or received" is a single query — cash-flow
 * and the assayer's statement both derive from it.
 *
 * INBOUND  — a client paying one of our invoices (accounts receivable).
 * OUTBOUND — us paying an approved assayer payable (accounts payable).
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

/**
 * What we owe an assayer for one assignment (or one approved expense claim).
 *
 *   PENDING ("Due") → APPROVED → PAID
 *
 * One approval gate — finance or an administrator — then payment. PAID is reached only by
 * recording a disbursement; it is never set by hand. A held payable is `onHold = true`.
 */
export enum AssayerPayableStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  PAID = 'PAID',
}

/** What kind of record a billing history row refers to. */
export enum BillingEntityType {
  ENTRY = 'ENTRY',
  INVOICE = 'INVOICE',
  PAYMENT = 'PAYMENT',
  PAYABLE = 'PAYABLE',
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
  FEEDBACK = 'FEEDBACK',
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

/**
 * The two-way feedback & collaboration channel between every FAPOMS user and the
 * product/support team. A "thread" is one reported item (a bug, an idea, a
 * question) plus the back-and-forth about it — modelled after the assayer
 * clarification thread, but the counterparty here is the PRODUCT_SUPPORT team
 * rather than the desk.
 */

/** What kind of thing was reported. AI-suggested on submit, editable by the team. */
export enum FeedbackCategory {
  /** Something is broken or behaving wrongly. */
  BUG = 'BUG',
  /** A request for a new capability or an improvement to an existing one. */
  ENHANCEMENT = 'ENHANCEMENT',
  /** A workflow / process / policy that should change. */
  PROCESS = 'PROCESS',
  /** A how-do-I / clarification, not a defect or a request. */
  QUESTION = 'QUESTION',
  /** Anything that does not fit the above. */
  OTHER = 'OTHER',
}

/** How urgent the item is. AI-suggested from language cues, editable by the team. */
export enum FeedbackSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/** Where a reported item sits in its lifecycle. */
export enum FeedbackStatus {
  /** Filed, not yet triaged by the team. */
  OPEN = 'OPEN',
  /** The team has seen it and is engaging (replied / triaged). */
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  /** Actively being worked. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Addressed — fixed, shipped, or answered. */
  RESOLVED = 'RESOLVED',
  /** Closed without further action (won't-fix, duplicate, stale). */
  CLOSED = 'CLOSED',
}

/** Which side of a feedback thread a message came from. */
export enum FeedbackAuthorType {
  /** The user or field assayer who raised the item. */
  REPORTER = 'REPORTER',
  /** A product/support/dev-team member. */
  TEAM = 'TEAM',
  /** An automated system line (status change, assignment, triage note). */
  SYSTEM = 'SYSTEM',
}
