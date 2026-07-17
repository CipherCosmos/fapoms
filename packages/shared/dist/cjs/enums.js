"use strict";
/**
 * FAPOMS — Canonical Business Enumerations
 *
 * These enumerations represent the reference data and state values
 * defined in the business specifications (Parts 6, 7, 8).
 *
 * Every enum value corresponds to a business concept.
 * Do not rename without explicit business specification approval.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Priority = exports.EventCategory = exports.TravelMode = exports.CommunicationType = exports.AuthorizationScope = exports.PermissionResource = exports.PermissionAction = exports.SystemRole = exports.UserStatus = exports.AssayerStatus = exports.ValidationStatus = exports.DocumentType = exports.DocumentStatus = exports.ScheduleStatus = exports.AssignmentStatus = exports.ProjectBranchStatus = exports.ProjectStatus = void 0;
// ---------------------------------------------------------------------------
// Project Lifecycle (Part 6 §3)
// ---------------------------------------------------------------------------
var ProjectStatus;
(function (ProjectStatus) {
    ProjectStatus["DRAFT"] = "DRAFT";
    ProjectStatus["PLANNING"] = "PLANNING";
    ProjectStatus["SCHEDULING"] = "SCHEDULING";
    ProjectStatus["EXECUTION"] = "EXECUTION";
    ProjectStatus["VALIDATION"] = "VALIDATION";
    ProjectStatus["COMPLETED"] = "COMPLETED";
    ProjectStatus["ARCHIVED"] = "ARCHIVED";
    ProjectStatus["CANCELLED"] = "CANCELLED";
    ProjectStatus["ON_HOLD"] = "ON_HOLD";
})(ProjectStatus || (exports.ProjectStatus = ProjectStatus = {}));
// ---------------------------------------------------------------------------
// Project Branch Lifecycle (Part 6 §4)
// ---------------------------------------------------------------------------
var ProjectBranchStatus;
(function (ProjectBranchStatus) {
    ProjectBranchStatus["IMPORTED"] = "IMPORTED";
    ProjectBranchStatus["PLANNING"] = "PLANNING";
    ProjectBranchStatus["CANDIDATE_SEARCH"] = "CANDIDATE_SEARCH";
    ProjectBranchStatus["CONTACT_INITIATED"] = "CONTACT_INITIATED";
    ProjectBranchStatus["NEGOTIATION"] = "NEGOTIATION";
    ProjectBranchStatus["ASSIGNMENT_CONFIRMED"] = "ASSIGNMENT_CONFIRMED";
    ProjectBranchStatus["SCHEDULED"] = "SCHEDULED";
    ProjectBranchStatus["AUDIT_COMPLETED"] = "AUDIT_COMPLETED";
    ProjectBranchStatus["VALIDATION_COMPLETED"] = "VALIDATION_COMPLETED";
    ProjectBranchStatus["CLOSED"] = "CLOSED";
    ProjectBranchStatus["UNABLE_TO_COVER"] = "UNABLE_TO_COVER";
    ProjectBranchStatus["ON_HOLD"] = "ON_HOLD";
    ProjectBranchStatus["CANCELLED"] = "CANCELLED";
})(ProjectBranchStatus || (exports.ProjectBranchStatus = ProjectBranchStatus = {}));
// ---------------------------------------------------------------------------
// Assignment Lifecycle (Part 6 §5)
// ---------------------------------------------------------------------------
var AssignmentStatus;
(function (AssignmentStatus) {
    AssignmentStatus["CREATED"] = "CREATED";
    AssignmentStatus["CANDIDATE_SELECTED"] = "CANDIDATE_SELECTED";
    AssignmentStatus["CONTACT_INITIATED"] = "CONTACT_INITIATED";
    AssignmentStatus["NEGOTIATION"] = "NEGOTIATION";
    AssignmentStatus["ACCEPTED"] = "ACCEPTED";
    AssignmentStatus["SCHEDULED"] = "SCHEDULED";
    AssignmentStatus["AUDIT_COMPLETED"] = "AUDIT_COMPLETED";
    AssignmentStatus["CLOSED"] = "CLOSED";
    AssignmentStatus["REJECTED"] = "REJECTED";
    AssignmentStatus["CANCELLED"] = "CANCELLED";
})(AssignmentStatus || (exports.AssignmentStatus = AssignmentStatus = {}));
// ---------------------------------------------------------------------------
// Schedule Lifecycle (Part 6 §6)
// ---------------------------------------------------------------------------
var ScheduleStatus;
(function (ScheduleStatus) {
    ScheduleStatus["TENTATIVE"] = "TENTATIVE";
    ScheduleStatus["CONFIRMED"] = "CONFIRMED";
    ScheduleStatus["RESCHEDULED"] = "RESCHEDULED";
    ScheduleStatus["COMPLETED"] = "COMPLETED";
})(ScheduleStatus || (exports.ScheduleStatus = ScheduleStatus = {}));
// ---------------------------------------------------------------------------
// Document Lifecycle (Part 6 §7)
// ---------------------------------------------------------------------------
var DocumentStatus;
(function (DocumentStatus) {
    DocumentStatus["UPLOADED"] = "UPLOADED";
    DocumentStatus["PROCESSED"] = "PROCESSED";
    DocumentStatus["GENERATED"] = "GENERATED";
    DocumentStatus["DISPATCHED"] = "DISPATCHED";
    DocumentStatus["RECEIVED"] = "RECEIVED";
    DocumentStatus["ARCHIVED"] = "ARCHIVED";
})(DocumentStatus || (exports.DocumentStatus = DocumentStatus = {}));
var DocumentType;
(function (DocumentType) {
    DocumentType["BRANCH_LIST"] = "BRANCH_LIST";
    DocumentType["CUSTOMER_MASTER_DATA"] = "CUSTOMER_MASTER_DATA";
    DocumentType["GENERATED_PDF"] = "GENERATED_PDF";
    DocumentType["RETURNED_AUDIT_PDF"] = "RETURNED_AUDIT_PDF";
    DocumentType["GENERATED_EXCEL"] = "GENERATED_EXCEL";
    DocumentType["FINAL_REPORT"] = "FINAL_REPORT";
})(DocumentType || (exports.DocumentType = DocumentType = {}));
// ---------------------------------------------------------------------------
// Validation Lifecycle (Part 6 §8)
// ---------------------------------------------------------------------------
var ValidationStatus;
(function (ValidationStatus) {
    ValidationStatus["PENDING"] = "PENDING";
    ValidationStatus["ASSIGNED"] = "ASSIGNED";
    ValidationStatus["OCR_PROCESSING"] = "OCR_PROCESSING";
    ValidationStatus["HUMAN_REVIEW"] = "HUMAN_REVIEW";
    ValidationStatus["CORRECTION_REQUIRED"] = "CORRECTION_REQUIRED";
    ValidationStatus["APPROVED"] = "APPROVED";
    ValidationStatus["SUBMITTED"] = "SUBMITTED";
})(ValidationStatus || (exports.ValidationStatus = ValidationStatus = {}));
// ---------------------------------------------------------------------------
// Assayer Lifecycle (Part 6 §9)
// ---------------------------------------------------------------------------
var AssayerStatus;
(function (AssayerStatus) {
    AssayerStatus["REGISTERED"] = "REGISTERED";
    AssayerStatus["ACTIVE"] = "ACTIVE";
    AssayerStatus["INACTIVE"] = "INACTIVE";
    AssayerStatus["BUSY"] = "BUSY";
    AssayerStatus["SUSPENDED"] = "SUSPENDED";
})(AssayerStatus || (exports.AssayerStatus = AssayerStatus = {}));
// ---------------------------------------------------------------------------
// User Status (Part 8 §5)
// ---------------------------------------------------------------------------
var UserStatus;
(function (UserStatus) {
    UserStatus["INVITED"] = "INVITED";
    UserStatus["ACTIVE"] = "ACTIVE";
    UserStatus["SUSPENDED"] = "SUSPENDED";
    UserStatus["LOCKED"] = "LOCKED";
    UserStatus["DISABLED"] = "DISABLED";
    UserStatus["ARCHIVED"] = "ARCHIVED";
})(UserStatus || (exports.UserStatus = UserStatus = {}));
// ---------------------------------------------------------------------------
// System Roles (Part 8 §6)
// ---------------------------------------------------------------------------
var SystemRole;
(function (SystemRole) {
    SystemRole["SUPER_ADMINISTRATOR"] = "SUPER_ADMINISTRATOR";
    SystemRole["ADMINISTRATOR"] = "ADMINISTRATOR";
    SystemRole["OPERATIONS_MANAGER"] = "OPERATIONS_MANAGER";
    SystemRole["OPERATIONS_EXECUTIVE"] = "OPERATIONS_EXECUTIVE";
    SystemRole["VALIDATION_MANAGER"] = "VALIDATION_MANAGER";
    SystemRole["VALIDATOR"] = "VALIDATOR";
    SystemRole["DOCUMENT_EXECUTIVE"] = "DOCUMENT_EXECUTIVE";
    SystemRole["ASSAYER"] = "ASSAYER";
    SystemRole["CLIENT_USER"] = "CLIENT_USER";
    SystemRole["READ_ONLY_AUDITOR"] = "READ_ONLY_AUDITOR";
})(SystemRole || (exports.SystemRole = SystemRole = {}));
// ---------------------------------------------------------------------------
// Permission Actions (Part 8 §7)
// ---------------------------------------------------------------------------
var PermissionAction;
(function (PermissionAction) {
    PermissionAction["VIEW"] = "VIEW";
    PermissionAction["CREATE"] = "CREATE";
    PermissionAction["EDIT"] = "EDIT";
    PermissionAction["DELETE"] = "DELETE";
    PermissionAction["ARCHIVE"] = "ARCHIVE";
    PermissionAction["CLOSE"] = "CLOSE";
    PermissionAction["EXPORT"] = "EXPORT";
    PermissionAction["IMPORT"] = "IMPORT";
    PermissionAction["MERGE"] = "MERGE";
    PermissionAction["NEGOTIATE"] = "NEGOTIATE";
    PermissionAction["ACCEPT"] = "ACCEPT";
    PermissionAction["CANCEL"] = "CANCEL";
    PermissionAction["ASSIGN"] = "ASSIGN";
    PermissionAction["REVIEW"] = "REVIEW";
    PermissionAction["APPROVE"] = "APPROVE";
    PermissionAction["REJECT"] = "REJECT";
    PermissionAction["REOPEN"] = "REOPEN";
    PermissionAction["UPLOAD"] = "UPLOAD";
    PermissionAction["GENERATE"] = "GENERATE";
    PermissionAction["DOWNLOAD"] = "DOWNLOAD";
    PermissionAction["REPLACE"] = "REPLACE";
    PermissionAction["MODIFY"] = "MODIFY";
    PermissionAction["RESCHEDULE"] = "RESCHEDULE";
})(PermissionAction || (exports.PermissionAction = PermissionAction = {}));
// ---------------------------------------------------------------------------
// Permission Resources (Part 8 §7)
// ---------------------------------------------------------------------------
var PermissionResource;
(function (PermissionResource) {
    PermissionResource["PROJECT"] = "PROJECT";
    PermissionResource["BRANCH"] = "BRANCH";
    PermissionResource["ASSIGNMENT"] = "ASSIGNMENT";
    PermissionResource["SCHEDULING"] = "SCHEDULING";
    PermissionResource["DOCUMENT"] = "DOCUMENT";
    PermissionResource["VALIDATION"] = "VALIDATION";
    PermissionResource["ASSAYER"] = "ASSAYER";
    PermissionResource["CLIENT"] = "CLIENT";
    PermissionResource["USER"] = "USER";
    PermissionResource["ROLE"] = "ROLE";
    PermissionResource["CONFIGURATION"] = "CONFIGURATION";
    PermissionResource["REFERENCE_DATA"] = "REFERENCE_DATA";
    PermissionResource["AUDIT_LOG"] = "AUDIT_LOG";
})(PermissionResource || (exports.PermissionResource = PermissionResource = {}));
// ---------------------------------------------------------------------------
// Authorization Scopes (Part 8 §9)
// ---------------------------------------------------------------------------
var AuthorizationScope;
(function (AuthorizationScope) {
    AuthorizationScope["SELF"] = "SELF";
    AuthorizationScope["ASSIGNED_RECORDS"] = "ASSIGNED_RECORDS";
    AuthorizationScope["TEAM"] = "TEAM";
    AuthorizationScope["DEPARTMENT"] = "DEPARTMENT";
    AuthorizationScope["REGION"] = "REGION";
    AuthorizationScope["STATE"] = "STATE";
    AuthorizationScope["CLIENT"] = "CLIENT";
    AuthorizationScope["ORGANIZATION"] = "ORGANIZATION";
    AuthorizationScope["PLATFORM"] = "PLATFORM";
})(AuthorizationScope || (exports.AuthorizationScope = AuthorizationScope = {}));
// ---------------------------------------------------------------------------
// Communication Types (Part 2 §13)
// ---------------------------------------------------------------------------
var CommunicationType;
(function (CommunicationType) {
    CommunicationType["PHONE"] = "PHONE";
    CommunicationType["WHATSAPP"] = "WHATSAPP";
    CommunicationType["EMAIL"] = "EMAIL";
    CommunicationType["SYSTEM"] = "SYSTEM";
})(CommunicationType || (exports.CommunicationType = CommunicationType = {}));
// ---------------------------------------------------------------------------
// Travel Mode (Part 2 §14)
// ---------------------------------------------------------------------------
var TravelMode;
(function (TravelMode) {
    TravelMode["CAR"] = "CAR";
    TravelMode["TRAIN"] = "TRAIN";
    TravelMode["BUS"] = "BUS";
    TravelMode["FLIGHT"] = "FLIGHT";
    TravelMode["TWO_WHEELER"] = "TWO_WHEELER";
    TravelMode["OTHER"] = "OTHER";
})(TravelMode || (exports.TravelMode = TravelMode = {}));
// ---------------------------------------------------------------------------
// Business Event Categories (Part 6 §10)
// ---------------------------------------------------------------------------
var EventCategory;
(function (EventCategory) {
    EventCategory["OPERATIONAL"] = "OPERATIONAL";
    EventCategory["USER"] = "USER";
    EventCategory["WORKFLOW"] = "WORKFLOW";
    EventCategory["SYSTEM"] = "SYSTEM";
})(EventCategory || (exports.EventCategory = EventCategory = {}));
// ---------------------------------------------------------------------------
// Priority Levels
// ---------------------------------------------------------------------------
var Priority;
(function (Priority) {
    Priority["LOW"] = "LOW";
    Priority["MEDIUM"] = "MEDIUM";
    Priority["HIGH"] = "HIGH";
    Priority["CRITICAL"] = "CRITICAL";
})(Priority || (exports.Priority = Priority = {}));
//# sourceMappingURL=enums.js.map