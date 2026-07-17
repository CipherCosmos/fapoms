/**
 * FAPOMS — Canonical Business Enumerations
 *
 * These enumerations represent the reference data and state values
 * defined in the business specifications (Parts 6, 7, 8).
 *
 * Every enum value corresponds to a business concept.
 * Do not rename without explicit business specification approval.
 */

// ---------------------------------------------------------------------------
// Project Lifecycle (Part 6 §3)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Project Branch Lifecycle (Part 6 §4)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Assignment Lifecycle (Part 6 §5)
// ---------------------------------------------------------------------------

export enum AssignmentStatus {
  CREATED = 'CREATED',
  CANDIDATE_SELECTED = 'CANDIDATE_SELECTED',
  CONTACT_INITIATED = 'CONTACT_INITIATED',
  NEGOTIATION = 'NEGOTIATION',
  ACCEPTED = 'ACCEPTED',
  SCHEDULED = 'SCHEDULED',
  AUDIT_COMPLETED = 'AUDIT_COMPLETED',
  CLOSED = 'CLOSED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

// ---------------------------------------------------------------------------
// Schedule Lifecycle (Part 6 §6)
// ---------------------------------------------------------------------------

export enum ScheduleStatus {
  TENTATIVE = 'TENTATIVE',
  CONFIRMED = 'CONFIRMED',
  RESCHEDULED = 'RESCHEDULED',
  COMPLETED = 'COMPLETED',
}

// ---------------------------------------------------------------------------
// Document Lifecycle (Part 6 §7)
// ---------------------------------------------------------------------------

export enum DocumentStatus {
  UPLOADED = 'UPLOADED',
  PROCESSED = 'PROCESSED',
  GENERATED = 'GENERATED',
  DISPATCHED = 'DISPATCHED',
  RECEIVED = 'RECEIVED',
  ARCHIVED = 'ARCHIVED',
}

export enum DocumentType {
  BRANCH_LIST = 'BRANCH_LIST',
  CUSTOMER_MASTER_DATA = 'CUSTOMER_MASTER_DATA',
  GENERATED_PDF = 'GENERATED_PDF',
  RETURNED_AUDIT_PDF = 'RETURNED_AUDIT_PDF',
  GENERATED_EXCEL = 'GENERATED_EXCEL',
  FINAL_REPORT = 'FINAL_REPORT',
}

// ---------------------------------------------------------------------------
// Validation Lifecycle (Part 6 §8)
// ---------------------------------------------------------------------------

export enum ValidationStatus {
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  OCR_PROCESSING = 'OCR_PROCESSING',
  HUMAN_REVIEW = 'HUMAN_REVIEW',
  CORRECTION_REQUIRED = 'CORRECTION_REQUIRED',
  APPROVED = 'APPROVED',
  SUBMITTED = 'SUBMITTED',
}

// ---------------------------------------------------------------------------
// Assayer Lifecycle (Part 6 §9)
// ---------------------------------------------------------------------------

export enum AssayerStatus {
  REGISTERED = 'REGISTERED',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  BUSY = 'BUSY',
  SUSPENDED = 'SUSPENDED',
}

// ---------------------------------------------------------------------------
// User Status (Part 8 §5)
// ---------------------------------------------------------------------------

export enum UserStatus {
  INVITED = 'INVITED',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  LOCKED = 'LOCKED',
  DISABLED = 'DISABLED',
  ARCHIVED = 'ARCHIVED',
}

// ---------------------------------------------------------------------------
// System Roles (Part 8 §6)
// ---------------------------------------------------------------------------

export enum SystemRole {
  SUPER_ADMINISTRATOR = 'SUPER_ADMINISTRATOR',
  ADMINISTRATOR = 'ADMINISTRATOR',
  OPERATIONS_MANAGER = 'OPERATIONS_MANAGER',
  OPERATIONS_EXECUTIVE = 'OPERATIONS_EXECUTIVE',
  VALIDATION_MANAGER = 'VALIDATION_MANAGER',
  VALIDATOR = 'VALIDATOR',
  DOCUMENT_EXECUTIVE = 'DOCUMENT_EXECUTIVE',
  ASSAYER = 'ASSAYER',
  CLIENT_USER = 'CLIENT_USER',
  READ_ONLY_AUDITOR = 'READ_ONLY_AUDITOR',
}

// ---------------------------------------------------------------------------
// Permission Actions (Part 8 §7)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Permission Resources (Part 8 §7)
// ---------------------------------------------------------------------------

export enum PermissionResource {
  PROJECT = 'PROJECT',
  BRANCH = 'BRANCH',
  ASSIGNMENT = 'ASSIGNMENT',
  SCHEDULING = 'SCHEDULING',
  DOCUMENT = 'DOCUMENT',
  VALIDATION = 'VALIDATION',
  ASSAYER = 'ASSAYER',
  CLIENT = 'CLIENT',
  USER = 'USER',
  ROLE = 'ROLE',
  CONFIGURATION = 'CONFIGURATION',
  REFERENCE_DATA = 'REFERENCE_DATA',
  AUDIT_LOG = 'AUDIT_LOG',
}

// ---------------------------------------------------------------------------
// Authorization Scopes (Part 8 §9)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Communication Types (Part 2 §13)
// ---------------------------------------------------------------------------

export enum CommunicationType {
  PHONE = 'PHONE',
  WHATSAPP = 'WHATSAPP',
  EMAIL = 'EMAIL',
  SYSTEM = 'SYSTEM',
}

// ---------------------------------------------------------------------------
// Travel Mode (Part 2 §14)
// ---------------------------------------------------------------------------

export enum TravelMode {
  CAR = 'CAR',
  TRAIN = 'TRAIN',
  BUS = 'BUS',
  FLIGHT = 'FLIGHT',
  TWO_WHEELER = 'TWO_WHEELER',
  OTHER = 'OTHER',
}

// ---------------------------------------------------------------------------
// Business Event Categories (Part 6 §10)
// ---------------------------------------------------------------------------

export enum EventCategory {
  OPERATIONAL = 'OPERATIONAL',
  USER = 'USER',
  WORKFLOW = 'WORKFLOW',
  SYSTEM = 'SYSTEM',
}

// ---------------------------------------------------------------------------
// Priority Levels
// ---------------------------------------------------------------------------

export enum Priority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}
