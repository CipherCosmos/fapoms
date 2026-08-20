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

/**
 * Who a person is, in this business.
 *
 * There were thirteen of these, and the application could not tell most of them apart. Three
 * had no capability of their own at all: OPERATIONS_EXECUTIVE could reach nothing an
 * OPERATIONS_MANAGER could not, and VALIDATION_MANAGER and VALIDATOR were both strict subsets
 * of DATA_ENTRY_HEAD. ADMINISTRATOR and SUPER_ADMINISTRATOR differed by seven routes, all of
 * them the product-feedback queue. The notification catalogue had already given up on the
 * distinctions and addressed them in fixed pairs — OPS, ADMINS, VALIDATION — never one without
 * the other. Meanwhile eleven of the thirteen had nobody in them.
 *
 * A role now names a job someone actually does, and each one can do something the others
 * cannot. The names say what the person does rather than where they sit in a hierarchy.
 */
export enum SystemRole {
  /** Runs the platform: configuration, users and roles, data resets, everything below. */
  ADMIN = 'ADMIN',

  /**
   * Runs the work: clients, projects, branches, planning, assignments and scheduling — and,
   * folded in here rather than split off, the money and the workforce. One person approves a
   * payout, issues an invoice, onboards an assayer and plans the audit they are sent on.
   *
   * That last point is a deliberate trade. FINANCE_MANAGER and HR_MANAGER existed so that the
   * person who creates the work is not the person who approves payment for it. With them folded
   * in, that check is gone unless an ADMIN does the approving — ADMIN is still on the
   * disbursement path for exactly that reason. Worth revisiting if the team grows.
   */
  OPERATIONS = 'OPERATIONS',

  /**
   * Runs the paperwork, end to end: packets out to the field, packets back, into data entry,
   * through validation and clarification, out as a finished report.
   *
   * This was three roles — DOCUMENT_EXECUTIVE for the outbound half, DATA_ENTRY_HEAD for the
   * inbound half, VALIDATION_MANAGER for a supervisory layer that could do nothing the head
   * could not. It is one desk, and it is one role.
   */
  DESK = 'DESK',

  /**
   * Works a share of the desk's queue rather than the whole of it: takes a packet, types it up,
   * hands it back. The one distinction the system genuinely draws here is "mine" versus "the
   * team's", which is a real difference between doing the work and running it.
   */
  DESK_OPERATOR = 'DESK_OPERATOR',

  /** Sees everything and changes nothing. For oversight and review. */
  AUDITOR = 'AUDITOR',

  /**
   * The product and support team. Owns the two-way feedback channel: receives bug reports,
   * enhancement requests and suggestions from staff, clients and field assayers, triages them
   * and replies in thread. ADMIN holds the same queue, so nothing waits on this being staffed.
   */
  PRODUCT_SUPPORT = 'PRODUCT_SUPPORT',

  /**
   * The field assayer. An external principal: authenticated from the `assayers` table, with no
   * row in `roles` and no permission grants — every route they reach is gated by name alone.
   */
  ASSAYER = 'ASSAYER',

  /** The client's own people, seeing their own work. An external principal, like ASSAYER. */
  CLIENT_USER = 'CLIENT_USER',
}

/**
 * What each of the old thirteen became.
 *
 * Kept because the mapping is the explanation: it is what the migration applies to existing
 * role rows, and it is how anyone reading old code, an old audit row or an old screenshot can
 * find the role that replaced the one they are looking at.
 */
export const LEGACY_ROLE_ALIASES: Record<string, SystemRole> = {
  SUPER_ADMINISTRATOR: SystemRole.ADMIN,
  ADMINISTRATOR: SystemRole.ADMIN,
  OPERATIONS_MANAGER: SystemRole.OPERATIONS,
  OPERATIONS_EXECUTIVE: SystemRole.OPERATIONS,
  FINANCE_MANAGER: SystemRole.OPERATIONS,
  HR_MANAGER: SystemRole.OPERATIONS,
  DOCUMENT_EXECUTIVE: SystemRole.DESK,
  DATA_ENTRY_HEAD: SystemRole.DESK,
  VALIDATION_MANAGER: SystemRole.DESK,
  VALIDATOR: SystemRole.DESK_OPERATOR,
  READ_ONLY_AUDITOR: SystemRole.AUDITOR,
  PRODUCT_SUPPORT: SystemRole.PRODUCT_SUPPORT,
  ASSAYER: SystemRole.ASSAYER,
  CLIENT_USER: SystemRole.CLIENT_USER,
};

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
  /**
   * The OCR boundary: submitting a packet for recognition, its callback, and retrying a job.
   *
   * Same story as PLANNING above, and the holiday calendar before it. Three routes were guarded
   * by `ocr:create|edit:organization` while OCR was not a member of this enum, so no such
   * permission row existed and no role could hold one — the routes were refused to every
   * principal, super administrator included. The parity spec now fails on this shape rather
   * than waiting for someone to notice a feature has never worked.
   */
  OCR = 'OCR',
  VALIDATION = 'VALIDATION',
  ASSAYER = 'ASSAYER',
  CLIENT = 'CLIENT',
  USER = 'USER',
  ROLE = 'ROLE',
  /** The organisation record itself — creating, editing and removing one. Also absent, also
   *  guarding three routes that consequently nobody could call. */
  ORGANIZATION = 'ORGANIZATION',
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
