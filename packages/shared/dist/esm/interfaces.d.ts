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
import { AssayerStatus, AssignmentStatus, AuthorizationScope, CommunicationType, DocumentStatus, DocumentType, EventCategory, PermissionAction, PermissionResource, Priority, ProjectBranchStatus, ProjectStatus, ScheduleStatus, SystemRole, TravelMode, UserStatus, ValidationStatus } from './enums';
/** Audit metadata present on every transactional entity */
export interface AuditMetadata {
    createdBy: string;
    createdAt: string;
    updatedBy: string;
    updatedAt: string;
    version: number;
    isActive: boolean;
}
/** Extended audit metadata for business-critical entities */
export interface ExtendedAuditMetadata extends AuditMetadata {
    previousState?: string;
    newState?: string;
    changeReason?: string;
}
export interface Client extends AuditMetadata {
    id: string;
    clientCode: string;
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
    workingDays?: number[];
    defaultRadius?: number;
    slaRules?: Record<string, unknown>;
    effectiveFrom: string;
    effectiveTo?: string;
}
export interface Project extends ExtendedAuditMetadata {
    id: string;
    projectNumber: string;
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
export interface Branch extends AuditMetadata {
    id: string;
    branchCode: string;
    solId?: string;
    name: string;
    address: string;
    state: string;
    district: string;
    city: string;
    pincode?: string;
    latitude?: number;
    longitude?: number;
    clientId?: string;
}
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
    branchName?: string;
    branchCode?: string;
    solId?: string;
    state?: string;
    district?: string;
    city?: string;
}
export interface Assayer extends AuditMetadata {
    id: string;
    assayerCode: string;
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
export interface Assignment extends ExtendedAuditMetadata {
    id: string;
    assignmentNumber: string;
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
    branchName?: string;
    assayerName?: string;
}
export interface Schedule extends AuditMetadata {
    id: string;
    assignmentId: string;
    projectId: string;
    branchId: string;
    assayerId: string;
    status: ScheduleStatus;
    scheduledDate: string;
    confirmedDate?: string;
    completedDate?: string;
    remarks?: string;
}
export interface Zone extends AuditMetadata {
    id: string;
    name: string;
    description?: string;
    clientId?: string;
    states?: string[];
    districts?: string[];
}
export interface Holiday extends AuditMetadata {
    id: string;
    name: string;
    date: string;
    type: 'NATIONAL' | 'BANK' | 'REGIONAL' | 'CUSTOM';
    applicableStates?: string[];
    year: number;
}
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
    parentDocumentId?: string;
    remarks?: string;
}
export interface ValidationCase extends ExtendedAuditMetadata {
    id: string;
    projectBranchId: string;
    documentId: string;
    status: ValidationStatus;
    assignedTo?: string;
    ocrResult?: Record<string, unknown>;
    reviewNotes?: string;
    corrections?: Record<string, unknown>;
    approvedBy?: string;
    approvedAt?: string;
}
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
    scopeValue?: string;
    assignedAt: string;
    assignedBy: string;
}
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
    occurredAt: string;
}
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
export interface CoverageMetrics {
    totalBranches: number;
    assignedBranches: number;
    scheduledBranches: number;
    completedBranches: number;
    unassignedBranches: number;
    unableToCover: number;
    coveragePercentage: number;
    plannedCoveragePercentage: number;
}
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
    score: number;
}
//# sourceMappingURL=interfaces.d.ts.map