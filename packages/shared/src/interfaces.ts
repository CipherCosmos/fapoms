/**
 * FAPOMS — Canonical Domain Interfaces
 *
 * These interfaces represent the business entities defined across
 * Parts 2, 7, and 8 of the specification. They are the canonical
 * data model shared between backend and frontend.
 *
 * System identifiers (id) are separate from business identifiers
 * (clientCode, branchCode, solId, etc.) per Part 7 §12.
 */

import {
  AssayerStatus,
  AssignmentStatus,
  AuthorizationScope,
  CommunicationType,
  DocumentStatus,
  DocumentType,
  EventCategory,
  PermissionAction,
  PermissionResource,
  Priority,
  ProjectBranchStatus,
  ProjectStatus,
  ScheduleStatus,
  SystemRole,
  TravelMode,
  UserStatus,
  ValidationStatus,
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

export interface Client extends AuditMetadata {
  id: string;
  clientCode: string;           // Business identifier
  name: string;
  displayName: string;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  configuration?: ClientConfiguration;
}

export interface ClientConfiguration {
  id: string;
  clientId: string;
  importMapping?: Record<string, string>;
  workingDays?: number[];       // 0=Sun, 1=Mon, ..., 6=Sat
  defaultRadius?: number;       // km
  slaRules?: Record<string, unknown>;
  effectiveFrom: string;        // ISO 8601
  effectiveTo?: string;         // ISO 8601
}

// ---------------------------------------------------------------------------
// Project (Part 2 §3)
// ---------------------------------------------------------------------------

export interface Project extends ExtendedAuditMetadata {
  id: string;
  projectNumber: string;        // Business identifier
  clientId: string;
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
  clientId?: string;            // Which client this branch belongs to
}

// ---------------------------------------------------------------------------
// Project Branch (Part 2 §5) — Transactional
// ---------------------------------------------------------------------------

export interface ProjectBranch extends ExtendedAuditMetadata {
  id: string;
  projectId: string;
  branchId: string;
  status: ProjectBranchStatus;
  priority: Priority;
  zoneId?: string;
  assignmentId?: string;
  scheduledDate?: string;
  remarks?: string;

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
  panNumber?: string;
  bankAccountNumber?: string;
  ifscCode?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Assignment (Part 2 §8) — Transactional
// ---------------------------------------------------------------------------

export interface Assignment extends ExtendedAuditMetadata {
  id: string;
  assignmentNumber: string;     // Business identifier
  projectBranchId: string;
  projectId: string;
  assayerId: string;
  status: AssignmentStatus;
  proposedFee?: number;
  agreedFee?: number;
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

export interface Communication extends AuditMetadata {
  id: string;
  assignmentId: string;
  type: CommunicationType;
  direction: 'INBOUND' | 'OUTBOUND';
  subject?: string;
  notes: string;
  contactedAt: string;
  contactedBy: string;
}

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
  projectBranchId?: string;
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
  projectBranchId: string;
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
  departmentId?: string;
  phone?: string;
  lastLoginAt?: string;
}

// ---------------------------------------------------------------------------
// Role & Permission (Part 8 §6-9)
// ---------------------------------------------------------------------------

export interface Role extends AuditMetadata {
  id: string;
  name: SystemRole;
  displayName: string;
  description: string;
  permissions: Permission[];
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

export interface GeoState {
  id: string;
  name: string;
  code: string;
}

export interface GeoDistrict {
  id: string;
  name: string;
  stateId: string;
}

export interface GeoCity {
  id: string;
  name: string;
  districtId: string;
  pincode?: string;
}

// ---------------------------------------------------------------------------
// Coverage Metrics (Part 2 §15, Part 5 §7)
// ---------------------------------------------------------------------------

export interface CoverageMetrics {
  totalBranches: number;
  assignedBranches: number;
  scheduledBranches: number;
  completedBranches: number;
  unassignedBranches: number;
  unableToCover: number;
  coveragePercentage: number;       // Confirmed coverage
  plannedCoveragePercentage: number; // Including in-negotiation
}

// ---------------------------------------------------------------------------
// Candidate Recommendation (Part 5 §6, Part 9 §10-11)
// ---------------------------------------------------------------------------

export interface CandidateRecommendation {
  assayerId: string;
  assayerName: string;
  distanceKm: number;
  estimatedTravelCost: number;
  state: string;
  activeAssignments: number;
  totalHistoricalAssignments: number;
  lastAssignmentDate?: string;
  availabilityStatus: AssayerStatus;
  score: number;                    // Composite recommendation score
}
