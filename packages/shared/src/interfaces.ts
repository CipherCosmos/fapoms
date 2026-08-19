/**
 * FAPOMS — Shared Domain Shapes (API payloads, NOT the schema)
 *
 * ## Read this before trusting anything below
 *
 * These are convenience types for data crossing the wire between backend and frontend. They
 * are **not** the source of truth for the database. The TypeORM entities are — one per table,
 * under `packages/backend/src/modules/*` — and where an interface here disagrees with an
 * entity, the entity is right and this file is stale.
 *
 * The header used to call these "canonical", which was actively misleading: several described
 * a specification that was never built. `Communication`, for instance, still declares
 * `direction`, `subject`, `contactedAt` and `contactedBy`, none of which exist on
 * `communication.entity.ts` (which has `content`, `recipientRef`, `isDelivered`). Twelve more
 * interfaces described tables nothing had ever read them for and have been deleted.
 *
 * So: model a DTO on the entity, not on this file. Add something here only when two packages
 * genuinely need to agree on a payload shape, and delete it when they stop.
 *
 * System identifiers (id) are separate from business identifiers
 * (clientCode, branchCode, solId, etc.) per Part 7 §12.
 */

import {
  AssayerStatus,
  AssayerLifecycleStatus,
  AssignmentStatus,
  AuthorizationScope,
  ClientLifecycleStatus,
  ClientType,
  ContractStatus,
  DocumentStatus,
  DocumentType,
  EventCategory,
  PermissionAction,
  PermissionResource,
  Priority,
  ProjectStatus,
  ScheduleStatus,
  SystemRole,
  TravelMode,
  UserStatus,
  ValidationStatus,
  BillingState,
  InvoiceStatus,
  PaymentMethod,
  PaymentDirection,
  AssayerPayableStatus,
  BillingEntityType,
} from './enums';

// ---------------------------------------------------------------------------
// Base Types — Audit Metadata (Part 7 §11)
// ---------------------------------------------------------------------------

/** Audit metadata present on every transactional entity */
export interface AuditMetadata {
  createdBy: string;
  createdAt: string;      // ISO 8601
  updatedBy: string;
  updatedAt: string;      // ISO 8601
  version: number;
  isActive: boolean;
}

/** Extended audit metadata for business-critical entities */
export interface ExtendedAuditMetadata extends AuditMetadata {
  previousState?: string;
  newState?: string;
  changeReason?: string;
}

// ---------------------------------------------------------------------------
// Client (Part 2 §2)
// ---------------------------------------------------------------------------

export interface Organization {
  id: string;
  organizationCode: string;
  name: string;
  displayName?: string;
  address?: string;
  contactEmail?: string;
  contactPhone?: string;
  status: string;
}

export interface Client extends AuditMetadata {
  id: string;
  clientCode: string;           // Business identifier
  name: string;
  displayName: string;
  website?: string;
  industry?: string;
  clientType: ClientType;
  registrationNumber?: string;
  taxId?: string;
  lifecycleStatus: ClientLifecycleStatus;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  organizationId?: string;
  priority: string;
  budget?: number;
  preferredAssayers?: string[];
  restrictedAssayers?: string[];
  planningPreferences?: Record<string, unknown>;
  configuration?: ClientConfiguration;
  contacts?: ClientContact[];
  contracts?: ClientContract[];
  billing?: ClientBilling;
}

export interface ClientConfiguration {
  id: string;
  clientId: string;
  importMapping?: Record<string, string>;
  workingDays?: number[];       // 0=Sun, 1=Mon, ..., 6=Sat
  defaultRadius?: number;       // km
  slaRules?: Record<string, unknown>;
  serviceLevel?: string;
  maxResponseTimeHours?: number;
  penaltyRate?: number;
  serviceHours?: Record<string, unknown>;
  // Client rate card — what the client is billed per audit.
  defaultBaseFee?: number;
  travelFeePerKm?: number;
  freeTravelAllowanceKm?: number;
  effectiveFrom: string;        // ISO 8601
  effectiveTo?: string;         // ISO 8601
}

export interface ClientContact extends AuditMetadata {
  id: string;
  clientId: string;
  name: string;
  email: string;
  phone: string;
  designation: string;
  department?: string;
  isPrimary: boolean;
  notes?: string;
}

export interface ClientContract extends AuditMetadata {
  id: string;
  clientId: string;
  contractNumber: string;
  title: string;
  description?: string;
  signedDate?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  value?: number;
  currency: string;
  status: ContractStatus;
  terms?: Record<string, unknown>;
  documentUrl?: string;
}

export interface ClientBilling extends AuditMetadata {
  id: string;
  clientId: string;
  paymentTerms: string;
  currency: string;
  taxIdentifier?: string;
  invoiceCycle: string;
  billingAddress: string;
  bankAccount?: string;
  bankName?: string;
  ifscCode?: string;
  notes?: string;
  gstRate?: number;
  tdsRate?: number;
}

// ---------------------------------------------------------------------------
// Project (Part 2 §3)
// ---------------------------------------------------------------------------

export interface Project extends ExtendedAuditMetadata {
  id: string;
  projectNumber: string;        // Business identifier
  clientId: string;
  organizationId?: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  priority: Priority;
  startDate?: string;
  endDate?: string;
  totalBranches: number;
  assignedBranches: number;
  coveragePercentage: number;
}

// ---------------------------------------------------------------------------
// Branch (Part 2 §4) — Permanent Master Entity
// ---------------------------------------------------------------------------

export interface Branch extends AuditMetadata {
  id: string;
  branchCode: string;           // Business identifier
  solId?: string;               // SOL ID (bank-specific)
  name: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  region?: string;
  territory?: string;
  zoneId?: string;
  branchType?: string;
  phone?: string;
  email?: string;
  managerName?: string;
  openingDate?: string;
  lastAuditDate?: string;
  operatingHours?: Record<string, unknown>;
  riskScore: number;
  complexity: string;
  riskCategory?: string;
  estimatedDurationHours: number;
  requiredCompetencies?: string[];
  clientId?: string;
  organizationId?: string;
  contacts?: BranchContact[];
  documents?: BranchDocument[];
}

export interface BranchContact extends AuditMetadata {
  id: string;
  branchId: string;
  name: string;
  email: string;
  phone: string;
  designation: string;
  department?: string;
  isPrimary: boolean;
  notes?: string;
}

export interface BranchDocument extends AuditMetadata {
  id: string;
  branchId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType?: string;
  category: string;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// Assessment (Section 4, Section 9 — Proposed Data Model)
// ---------------------------------------------------------------------------

/**
 * The row a project's paperwork for one branch hangs off.
 *
 * It used to carry a lifecycle of its own — eighteen states — plus a scheduled audit date, an
 * assigned assayer, an agreed fee, a packet size, a priority, a zone and remarks. All of it was
 * written and none of it was ever read: no query filtered on it, no screen showed it, and three
 * services spent their own code keeping it in step with the branch and the assignment that
 * actually hold those facts. What is left is what documents are attached to.
 */
export interface Assessment extends ExtendedAuditMetadata {
  id: string;
  projectId: string;
  branchId: string;

  // Denormalized for display (populated from Branch)
  branchName?: string;
  branchCode?: string;
  solId?: string;
  state?: string;
  district?: string;
  city?: string;
}


// ---------------------------------------------------------------------------
// Assayer (Part 2 §6) — Permanent Master Entity
// ---------------------------------------------------------------------------

export interface Assayer extends AuditMetadata {
  id: string;
  assayerCode: string;          // Business identifier
  employeeId?: string;
  employeeCode?: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email?: string;
  phone: string;
  alternatePhone?: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  status: AssayerStatus;
  lifecycleStatus: AssayerLifecycleStatus;
  organizationId?: string;
  panNumber?: string;
  bankAccountNumber?: string;
  ifscCode?: string;
  notes?: string;
  employmentType?: string;
  joiningDate?: string;
  exitDate?: string;
  terminationDate?: string;
  managerId?: string;
  department?: string;
  region?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  photograph?: string;
}





// ---------------------------------------------------------------------------
// Assignment (Part 2 §8) — Transactional
// ---------------------------------------------------------------------------

export interface Assignment extends ExtendedAuditMetadata {
  id: string;
  assignmentNumber: string;
  assessmentId: string;
  projectId: string;
  assayerId: string;
  status: AssignmentStatus;
  proposedFee?: number;
  agreedFee?: number;
  // Number of counter-offer rounds; present on assignment payloads and read by negotiation UIs.
  negotiationCount?: number;
  scheduledDate?: string;
  completionDate?: string;
  remarks?: string;
  cancelReason?: string;
  rejectReason?: string;

  // Denormalized for display
  branchName?: string;
  assayerName?: string;
}

// ---------------------------------------------------------------------------
// Schedule (Part 2 §7) — Owned by Assignment
// ---------------------------------------------------------------------------

export interface Schedule extends AuditMetadata {
  id: string;
  assignmentId: string;
  projectId: string;
  branchId: string;
  assayerId: string;
  status: ScheduleStatus;
  scheduledDate: string;        // ISO 8601 date
  confirmedDate?: string;
  completedDate?: string;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// Zone (Part 2 §9)
// ---------------------------------------------------------------------------

export interface Zone extends AuditMetadata {
  id: string;
  name: string;
  description?: string;
  clientId?: string;            // Per-client zones
  states?: string[];
  districts?: string[];
}

// ---------------------------------------------------------------------------
// Holiday (Part 2 §10)
// ---------------------------------------------------------------------------

export interface Holiday extends AuditMetadata {
  id: string;
  name: string;
  date: string;                 // ISO 8601 date
  type: 'NATIONAL' | 'BANK' | 'REGIONAL' | 'CUSTOM';
  applicableStates?: string[];  // Empty = nationwide
  year: number;
}

// ---------------------------------------------------------------------------
// Communication (Part 2 §13)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Travel (Part 2 §14)
// ---------------------------------------------------------------------------

export interface Travel extends AuditMetadata {
  id: string;
  assignmentId: string;
  estimatedDistanceKm: number;
  estimatedCost: number;
  currency: string;
  travelMode: TravelMode;
  origin?: string;
  destination?: string;
  remarks?: string;
}

// ---------------------------------------------------------------------------
// Document (Part 3 §11, Part 6 §7)
// ---------------------------------------------------------------------------

export interface Document extends AuditMetadata {
  id: string;
  assessmentId?: string;
  projectId?: string;
  type: DocumentType;
  status: DocumentStatus;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  versionNumber: number;
  parentDocumentId?: string;    // For versioned documents
  remarks?: string;
}

// ---------------------------------------------------------------------------
// Validation Case (Part 7 §3)
// ---------------------------------------------------------------------------

export interface ValidationCase extends ExtendedAuditMetadata {
  id: string;
  assessmentId: string;
  documentId: string;
  status: ValidationStatus;
  assignedTo?: string;          // User ID of validator
  ocrResult?: Record<string, unknown>;
  reviewNotes?: string;
  corrections?: Record<string, unknown>;
  approvedBy?: string;
  approvedAt?: string;
}

// ---------------------------------------------------------------------------
// User (Part 2 §11, Part 8)
// ---------------------------------------------------------------------------

export interface User extends AuditMetadata {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  status: UserStatus;
  organizationId?: string;
  departmentId?: string;
  phone?: string;
  lastLoginAt?: string;
}

// ---------------------------------------------------------------------------
// Role & Permission (Part 8 §6-9)
// ---------------------------------------------------------------------------

export interface Capability extends AuditMetadata {
  id: string;
  name: string;
  displayName: string;
  description: string;
  category: string;
  permissions: Permission[];
}

export interface Responsibility extends AuditMetadata {
  id: string;
  name: string;
  displayName: string;
  description: string;
  capabilities: Capability[];
}

export interface Role extends AuditMetadata {
  id: string;
  name: SystemRole;
  displayName: string;
  description: string;
  permissions: Permission[];
  responsibilities: Responsibility[];
}

export interface Permission {
  id: string;
  resource: PermissionResource;
  action: PermissionAction;
  scope: AuthorizationScope;
  description?: string;
}

export interface UserRole {
  userId: string;
  roleId: string;
  scope?: AuthorizationScope;
  scopeValue?: string;         // e.g., specific region or client ID
  assignedAt: string;
  assignedBy: string;
}

// ---------------------------------------------------------------------------
// Audit Event (Part 6 §11)
// ---------------------------------------------------------------------------

export interface AuditEvent {
  id: string;
  category: EventCategory;
  eventType: string;
  entityType: string;
  entityId: string;
  previousState?: string;
  newState?: string;
  userId?: string;
  userDisplayName?: string;
  ipAddress?: string;
  remarks?: string;
  metadata?: Record<string, unknown>;
  occurredAt: string;          // ISO 8601
}

// ---------------------------------------------------------------------------
// Geographic Reference Data (Part 7 §10)
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// Coverage Metrics (Part 2 §15, Part 5 §7)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Candidate Recommendation (Part 5 §6, Part 9 §10-11)
// ---------------------------------------------------------------------------

/**
 * Where a distance or travel-time figure came from. Mirrors `RouteSource` in the backend's
 * `geo/routing.provider.ts`, which is where the values are minted:
 *   - `OSRM`     — the road network. Say "212 km by road".
 *   - `ESTIMATE` — great-circle distance and an assumed speed. Say "~164 km (straight line,
 *                  estimate)". The straight line under-states the road by 11–56 % on real
 *                  pairs, so this must never be presented as a road figure.
 * Shared so the web and mobile apps render the label the same way — see `formatRouteDistance`.
 */
export type RouteSource = 'OSRM' | 'ESTIMATE';

/**
 * The branch → candidate journey as the recommendation API reports it. `distanceSource` is
 * null exactly when `distanceKm` is: no coordinates, no route, no label. A `distanceKm` with a
 * null source from an older server is treated as an estimate by every renderer — the only
 * honest default.
 */
export interface CandidateRoute {
  distanceKm: number | null;
  durationMinutes: number | null;
  distanceSource: RouteSource | null;
}

// ---------------------------------------------------------------------------
// Assayer Commercial Profile (Enterprise)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Workforce Attribute (Enterprise)
// ---------------------------------------------------------------------------

export interface WorkforceAttribute extends AuditMetadata {
  id: string;
  assayerId: string;
  type: 'SKILL' | 'CERTIFICATION' | 'LANGUAGE';
  name: string;
  level?: string;
  expiryDate?: string;
  metadata?: Record<string, unknown>;
}


// ---------------------------------------------------------------------------
// Billing — the assignment is the ledger line
// ---------------------------------------------------------------------------

/** The client-side line for one assignment. One per assignment, created when it completes. */
export interface BillingEntry extends AuditMetadata {
  id: string;
  entryNumber: string;
  clientId: string;
  projectId?: string | null;
  assignmentId: string;
  assayerId?: string | null;
  state: BillingState;
  /** A held line cannot be invoiced. The reason is shown wherever the hold is. */
  onHold: boolean;
  holdReason?: string | null;
  /** The day the work was delivered — what the invoice line is dated. */
  serviceDate?: string | null;
  description?: string | null;
  invoiceId?: string | null;
  // Money. base + travel + adjustment = taxable; taxable + GST − TDS = total.
  baseAmount: number;
  travelAmount: number;
  adjustmentAmount: number;
  adjustmentReason?: string | null;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
  tdsRate: number;
  tdsAmount: number;
  totalAmount: number;
  currency: string;
  paidAmount: number;
  outstandingAmount: number;
  // Labels attached by list endpoints.
  clientName?: string | null;
  projectName?: string | null;
  projectNumber?: string | null;
  assignmentNumber?: string | null;
  branchName?: string | null;
  assayerName?: string | null;
}

/** A client invoice: a set of completed assignments for one client. */
export interface BillingInvoice extends AuditMetadata {
  id: string;
  invoiceNumber: string;
  clientId: string;
  projectId?: string | null;
  status: InvoiceStatus;
  issueDate?: string | null;
  dueDate?: string | null;
  currency: string;
  /** Pre-tax taxable value of the invoiced lines. */
  subtotal: number;
  taxAmount: number;
  /** Total TDS withheld by the client across this invoice's lines. */
  tdsAmount: number;
  /** subtotal + GST − TDS. */
  total: number;
  paidAmount: number;
  outstandingAmount: number;
  notes?: string | null;
  entries?: BillingEntry[];
  payments?: BillingPayment[];
  /** On list rows only. */
  entryCount?: number;
  clientName?: string | null;
}

/** One real movement of money, in either direction. Reversed = `isActive: false`. */
export interface BillingPayment extends AuditMetadata {
  id: string;
  direction: PaymentDirection;
  paymentReference: string;
  method: PaymentMethod;
  amount: number;
  currency: string;
  receivedDate?: string | null;
  notes?: string | null;
  invoiceId?: string | null;
  payableId?: string | null;
  assayerId?: string | null;
  /** OUTBOUND only: what the assayer was still owed after this payment. */
  runningBalance?: number | null;
}

/** What we owe an assayer for one assignment, or for one approved expense claim. */
export interface AssayerPayable extends AuditMetadata {
  id: string;
  payableNumber: string;
  assayerId: string;
  clientId?: string | null;
  projectId?: string | null;
  assignmentId: string;
  /** Set on reimbursement payables; null on the fee payable. */
  expenseId?: string | null;
  status: AssayerPayableStatus;
  /** A held payable cannot be approved or paid. */
  onHold: boolean;
  holdReason?: string | null;
  baseAmount: number;
  travelAmount: number;
  taxAmount: number;
  tdsAmount: number;
  totalAmount: number;
  currency: string;
  paidAmount: number;
  approvedAt?: string | null;
  approvedBy?: string | null;
  paidAt?: string | null;
  paidBy?: string | null;
  rateSnapshot?: Record<string, unknown> | null;
  remarks?: string | null;
  // Labels attached by list endpoints.
  assayerName?: string | null;
  assayerCode?: string | null;
  projectName?: string | null;
  clientName?: string | null;
  assignmentNumber?: string | null;
  branchName?: string | null;
}

export interface BillingHistoryEvent extends AuditMetadata {
  id: string;
  clientId?: string | null;
  projectId?: string | null;
  assignmentId?: string | null;
  assayerId?: string | null;
  entityType: BillingEntityType;
  entityId: string;
  action: string;
  fromState?: string | null;
  toState?: string | null;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  reason?: string | null;
  userName?: string | null;
}

/** Something finance should look at. Derived on every read — never stored, never "resolved". */
export interface BillingAttentionItem {
  kind:
    | 'UNBOOKED'            // a COMPLETED assignment with no payable or no client line
    | 'UNSETTLED_FEE'       // booked from a proposed fee that was never agreed
    | 'FEE_CHANGED'         // the assignment fee moved after the line was booked
    | 'HELD'                // a held payout or client line
    | 'OVERDUE_INVOICE';    // a sent invoice past its due date
  assignmentId?: string | null;
  assignmentNumber?: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  payableId?: string | null;
  entryId?: string | null;
  clientName?: string | null;
  assayerName?: string | null;
  amount?: number | null;
  detail: string;
}

/** The finance overview: every headline figure, from one endpoint, off one set of rows. */
export interface BillingOverview {
  currency: string;
  payouts: {
    /** Σ net still to pay on PENDING payables (not held). */
    due: number;
    /** Σ net still to pay on APPROVED payables (not held). */
    approved: number;
    /** Σ paid out, ever. */
    paid: number;
    /** Σ net still owed on held payables. */
    held: number;
    dueCount: number;
    approvedCount: number;
    heldCount: number;
  };
  receivables: {
    /** Σ total on UNBILLED, un-held client lines. */
    unbilled: number;
    /** Σ invoice totals on sent (ISSUED) and PAID invoices. */
    invoiced: number;
    /** Σ collected against invoices. */
    collected: number;
    /** Σ still owed on sent invoices. */
    outstanding: number;
    /** Σ total on held client lines. */
    held: number;
    aging: { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
  };
  margin: {
    /** Σ taxable on live client lines (ex-GST). */
    revenue: number;
    /** Σ gross (base + travel, pre-TDS) on live payables. */
    cost: number;
    margin: number;
    marginPct: number | null;
  };
  tax: { gstCollected: number; tdsWithheldByClients: number; tdsWithheldFromAssayers: number };
  cashflow: { in: number; out: number; net: number };
  attention: BillingAttentionItem[];
  byClient: Array<{
    clientId: string;
    clientName: string;
    clientRate: number | null;
    unbilled: number;
    invoiced: number;
    outstanding: number;
    revenue: number;
    cost: number;
    margin: number;
    assignmentCount: number;
  }>;
  recentActivity: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    fromState?: string | null;
    toState?: string | null;
    reason?: string | null;
    occurredAt: string;
    userName?: string | null;
  }>;
}

/** Everything money-related about one assignment — the one line the assignment detail shows. */
export interface AssignmentMoneyLine {
  assignmentId: string;
  assignmentNumber: string | null;
  assignmentStatus: string | null;
  booked: boolean;
  /** The fee the money was (or would be) booked from, and whether it was ever agreed. */
  fee: { amount: number; settled: boolean; source: 'AGREED' | 'PROPOSED' | 'NONE' } | null;
  payable: AssayerPayable | null;
  reimbursements: AssayerPayable[];
  entry: BillingEntry | null;
  invoice: Pick<BillingInvoice, 'id' | 'invoiceNumber' | 'status' | 'issueDate' | 'dueDate' | 'total' | 'paidAmount' | 'outstandingAmount'> | null;
  payments: BillingPayment[];
  history: BillingHistoryEvent[];
}
