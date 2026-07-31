export var ProjectStatus;
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
})(ProjectStatus || (ProjectStatus = {}));
export var ProjectBranchStatus;
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
})(ProjectBranchStatus || (ProjectBranchStatus = {}));
export var AssessmentStatus;
(function (AssessmentStatus) {
    AssessmentStatus["PENDING_PLANNING"] = "PENDING_PLANNING";
    AssessmentStatus["ASSESSOR_RECOMMENDED"] = "ASSESSOR_RECOMMENDED";
    AssessmentStatus["IN_NEGOTIATION"] = "IN_NEGOTIATION";
    AssessmentStatus["ASSIGNED_AND_SCHEDULED"] = "ASSIGNED_AND_SCHEDULED";
    AssessmentStatus["UNASSIGNED"] = "UNASSIGNED";
    AssessmentStatus["AWAITING_CLIENT_DATA"] = "AWAITING_CLIENT_DATA";
    AssessmentStatus["CLIENT_DATA_RECEIVED"] = "CLIENT_DATA_RECEIVED";
    AssessmentStatus["PDF_GENERATED"] = "PDF_GENERATED";
    AssessmentStatus["READY_FOR_DISPATCH"] = "READY_FOR_DISPATCH";
    AssessmentStatus["DISPATCHED_TO_ASSESSOR"] = "DISPATCHED_TO_ASSESSOR";
    AssessmentStatus["AUDITED_PDF_RECEIVED"] = "AUDITED_PDF_RECEIVED";
    AssessmentStatus["SENT_TO_DATA_ENTRY"] = "SENT_TO_DATA_ENTRY";
    AssessmentStatus["DATA_ENTRY_IN_PROGRESS"] = "DATA_ENTRY_IN_PROGRESS";
    AssessmentStatus["CLARIFICATION_NEEDED"] = "CLARIFICATION_NEEDED";
    AssessmentStatus["REPORT_FINALIZED"] = "REPORT_FINALIZED";
    AssessmentStatus["PENDING_HEAD_APPROVAL"] = "PENDING_HEAD_APPROVAL";
    AssessmentStatus["DELIVERED_TO_CLIENT"] = "DELIVERED_TO_CLIENT";
    AssessmentStatus["COMPLETED"] = "COMPLETED";
})(AssessmentStatus || (AssessmentStatus = {}));
export var AssignmentStatus;
(function (AssignmentStatus) {
    AssignmentStatus["PENDING"] = "PENDING";
    AssignmentStatus["ACCEPTED"] = "ACCEPTED";
    AssignmentStatus["CHECKED_IN"] = "CHECKED_IN";
    AssignmentStatus["IN_PROGRESS"] = "IN_PROGRESS";
    AssignmentStatus["COMPLETED"] = "COMPLETED";
    AssignmentStatus["REJECTED"] = "REJECTED";
    AssignmentStatus["CANCELLED"] = "CANCELLED";
})(AssignmentStatus || (AssignmentStatus = {}));
export var ScheduleStatus;
(function (ScheduleStatus) {
    ScheduleStatus["TENTATIVE"] = "TENTATIVE";
    ScheduleStatus["CONFIRMED"] = "CONFIRMED";
    ScheduleStatus["RESCHEDULED"] = "RESCHEDULED";
    ScheduleStatus["COMPLETED"] = "COMPLETED";
})(ScheduleStatus || (ScheduleStatus = {}));
export var DocumentStatus;
(function (DocumentStatus) {
    DocumentStatus["UPLOADED"] = "UPLOADED";
    DocumentStatus["DISPATCHED"] = "DISPATCHED";
    DocumentStatus["RECEIVED"] = "RECEIVED";
    DocumentStatus["SENT_TO_DATA_ENTRY"] = "SENT_TO_DATA_ENTRY";
    DocumentStatus["SENT_TO_EXTERNAL_OCR"] = "SENT_TO_EXTERNAL_OCR";
    DocumentStatus["EXCEL_GENERATED"] = "EXCEL_GENERATED";
    DocumentStatus["PROCESSED"] = "PROCESSED";
    DocumentStatus["COMPLETED"] = "COMPLETED";
    DocumentStatus["ARCHIVED"] = "ARCHIVED";
})(DocumentStatus || (DocumentStatus = {}));
/**
 * How a document reached the assayer. Recorded per dispatch so the audit trail can answer
 * "was this sent automatically the day before the audit, or pushed manually by an operator,
 * and by whom" — spec §8.2/§8.3.
 */
export var DispatchMethod;
(function (DispatchMethod) {
    DispatchMethod["AUTO"] = "AUTO";
    DispatchMethod["MANUAL"] = "MANUAL";
})(DispatchMethod || (DispatchMethod = {}));
export var DocumentType;
(function (DocumentType) {
    DocumentType["BRANCH_LIST"] = "BRANCH_LIST";
    DocumentType["CUSTOMER_MASTER_DATA"] = "CUSTOMER_MASTER_DATA";
    DocumentType["PRE_FIELD_AUDIT_PDF"] = "PRE_FIELD_AUDIT_PDF";
    DocumentType["AUDITED_RETURN_PDF"] = "AUDITED_RETURN_PDF";
    DocumentType["GENERATED_EXCEL"] = "GENERATED_EXCEL";
    DocumentType["FINAL_REPORT"] = "FINAL_REPORT";
})(DocumentType || (DocumentType = {}));
export var ValidationStatus;
(function (ValidationStatus) {
    ValidationStatus["PENDING"] = "PENDING";
    ValidationStatus["ASSIGNED"] = "ASSIGNED";
    ValidationStatus["OCR_PROCESSING"] = "OCR_PROCESSING";
    ValidationStatus["HUMAN_REVIEW"] = "HUMAN_REVIEW";
    ValidationStatus["CORRECTION_REQUIRED"] = "CORRECTION_REQUIRED";
    ValidationStatus["APPROVED"] = "APPROVED";
    ValidationStatus["SUBMITTED"] = "SUBMITTED";
})(ValidationStatus || (ValidationStatus = {}));
export var CustomerMasterStatus;
(function (CustomerMasterStatus) {
    CustomerMasterStatus["DRAFT"] = "DRAFT";
    CustomerMasterStatus["RECONCILED"] = "RECONCILED";
    CustomerMasterStatus["APPROVED"] = "APPROVED";
    CustomerMasterStatus["SUPERSEDED"] = "SUPERSEDED";
    CustomerMasterStatus["REJECTED"] = "REJECTED";
})(CustomerMasterStatus || (CustomerMasterStatus = {}));
export var ValidationQueryStatus;
(function (ValidationQueryStatus) {
    ValidationQueryStatus["OPEN"] = "OPEN";
    ValidationQueryStatus["RESPONDED"] = "RESPONDED";
    ValidationQueryStatus["RESOLVED"] = "RESOLVED";
})(ValidationQueryStatus || (ValidationQueryStatus = {}));
export var AssayerStatus;
(function (AssayerStatus) {
    AssayerStatus["ACTIVE"] = "ACTIVE";
    AssayerStatus["INACTIVE"] = "INACTIVE";
    AssayerStatus["SUSPENDED"] = "SUSPENDED";
})(AssayerStatus || (AssayerStatus = {}));
export var AssayerLifecycleStatus;
(function (AssayerLifecycleStatus) {
    AssayerLifecycleStatus["INVITED"] = "INVITED";
    AssayerLifecycleStatus["DOCUMENT_VERIFICATION"] = "DOCUMENT_VERIFICATION";
    AssayerLifecycleStatus["BACKGROUND_VERIFICATION"] = "BACKGROUND_VERIFICATION";
    AssayerLifecycleStatus["TRAINING"] = "TRAINING";
    AssayerLifecycleStatus["ACTIVE"] = "ACTIVE";
    AssayerLifecycleStatus["ON_LEAVE"] = "ON_LEAVE";
    AssayerLifecycleStatus["SUSPENDED"] = "SUSPENDED";
    AssayerLifecycleStatus["INACTIVE"] = "INACTIVE";
    AssayerLifecycleStatus["RESIGNED"] = "RESIGNED";
    AssayerLifecycleStatus["TERMINATED"] = "TERMINATED";
    AssayerLifecycleStatus["ARCHIVED"] = "ARCHIVED";
})(AssayerLifecycleStatus || (AssayerLifecycleStatus = {}));
export var UserStatus;
(function (UserStatus) {
    UserStatus["INVITED"] = "INVITED";
    UserStatus["ACTIVE"] = "ACTIVE";
    UserStatus["SUSPENDED"] = "SUSPENDED";
    UserStatus["LOCKED"] = "LOCKED";
    UserStatus["DISABLED"] = "DISABLED";
    UserStatus["ARCHIVED"] = "ARCHIVED";
})(UserStatus || (UserStatus = {}));
export var SystemRole;
(function (SystemRole) {
    SystemRole["SUPER_ADMINISTRATOR"] = "SUPER_ADMINISTRATOR";
    SystemRole["ADMINISTRATOR"] = "ADMINISTRATOR";
    SystemRole["OPERATIONS_MANAGER"] = "OPERATIONS_MANAGER";
    SystemRole["OPERATIONS_EXECUTIVE"] = "OPERATIONS_EXECUTIVE";
    SystemRole["VALIDATION_MANAGER"] = "VALIDATION_MANAGER";
    SystemRole["VALIDATOR"] = "VALIDATOR";
    SystemRole["DOCUMENT_EXECUTIVE"] = "DOCUMENT_EXECUTIVE";
    /**
     * Owns the collected-paperwork queue. Per spec §12.8 the application does NOT assign work
     * to individual data-entry operators: every returned PDF lands with the Head, who downloads
     * it and distributes work through the existing manual process. The system tracks lifecycle,
     * ownership and progress — it does not route to individuals.
     */
    SystemRole["DATA_ENTRY_HEAD"] = "DATA_ENTRY_HEAD";
    SystemRole["ASSAYER"] = "ASSAYER";
    SystemRole["CLIENT_USER"] = "CLIENT_USER";
    SystemRole["READ_ONLY_AUDITOR"] = "READ_ONLY_AUDITOR";
})(SystemRole || (SystemRole = {}));
export var PermissionAction;
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
})(PermissionAction || (PermissionAction = {}));
export var PermissionResource;
(function (PermissionResource) {
    PermissionResource["PROJECT"] = "PROJECT";
    PermissionResource["BRANCH"] = "BRANCH";
    PermissionResource["ASSIGNMENT"] = "ASSIGNMENT";
    PermissionResource["SCHEDULING"] = "SCHEDULING";
    /**
     * Candidate recommendation, day planning, and the business-rule engine.
     *
     * The planning controller already guarded 18 endpoints with `planning:*` permissions, but
     * PLANNING was never a member of this enum and no such permission row existed — so the guard
     * could not be satisfied by any role, including SUPER_ADMINISTRATOR. That is why no business
     * rule had ever been created: the rule-management API was unreachable.
     */
    PermissionResource["PLANNING"] = "PLANNING";
    PermissionResource["DOCUMENT"] = "DOCUMENT";
    PermissionResource["VALIDATION"] = "VALIDATION";
    PermissionResource["ASSAYER"] = "ASSAYER";
    PermissionResource["CLIENT"] = "CLIENT";
    PermissionResource["USER"] = "USER";
    PermissionResource["ROLE"] = "ROLE";
    PermissionResource["CONFIGURATION"] = "CONFIGURATION";
    PermissionResource["REFERENCE_DATA"] = "REFERENCE_DATA";
    PermissionResource["AUDIT_LOG"] = "AUDIT_LOG";
})(PermissionResource || (PermissionResource = {}));
export var AuthorizationScope;
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
})(AuthorizationScope || (AuthorizationScope = {}));
export var CommunicationType;
(function (CommunicationType) {
    CommunicationType["PHONE"] = "PHONE";
    CommunicationType["WHATSAPP"] = "WHATSAPP";
    CommunicationType["EMAIL"] = "EMAIL";
    CommunicationType["SYSTEM"] = "SYSTEM";
})(CommunicationType || (CommunicationType = {}));
export var TravelMode;
(function (TravelMode) {
    TravelMode["CAR"] = "CAR";
    TravelMode["TRAIN"] = "TRAIN";
    TravelMode["BUS"] = "BUS";
    TravelMode["FLIGHT"] = "FLIGHT";
    TravelMode["TWO_WHEELER"] = "TWO_WHEELER";
    TravelMode["OTHER"] = "OTHER";
})(TravelMode || (TravelMode = {}));
export var EventCategory;
(function (EventCategory) {
    EventCategory["OPERATIONAL"] = "OPERATIONAL";
    EventCategory["USER"] = "USER";
    EventCategory["WORKFLOW"] = "WORKFLOW";
    EventCategory["SYSTEM"] = "SYSTEM";
})(EventCategory || (EventCategory = {}));
export var ClientLifecycleStatus;
(function (ClientLifecycleStatus) {
    ClientLifecycleStatus["PROSPECT"] = "PROSPECT";
    ClientLifecycleStatus["ONBOARDING"] = "ONBOARDING";
    ClientLifecycleStatus["ACTIVE"] = "ACTIVE";
    ClientLifecycleStatus["SUSPENDED"] = "SUSPENDED";
    ClientLifecycleStatus["UNDER_REVIEW"] = "UNDER_REVIEW";
    ClientLifecycleStatus["INACTIVE"] = "INACTIVE";
    ClientLifecycleStatus["TERMINATED"] = "TERMINATED";
    ClientLifecycleStatus["ARCHIVED"] = "ARCHIVED";
})(ClientLifecycleStatus || (ClientLifecycleStatus = {}));
export var ClientType;
(function (ClientType) {
    ClientType["BANK"] = "BANK";
    ClientType["NBFC"] = "NBFC";
    ClientType["MICROFINANCE"] = "MICROFINANCE";
    ClientType["INSURANCE"] = "INSURANCE";
    ClientType["CORPORATE"] = "CORPORATE";
    ClientType["GOVERNMENT"] = "GOVERNMENT";
    ClientType["OTHER"] = "OTHER";
})(ClientType || (ClientType = {}));
export var ContractStatus;
(function (ContractStatus) {
    ContractStatus["DRAFT"] = "DRAFT";
    ContractStatus["ACTIVE"] = "ACTIVE";
    ContractStatus["EXPIRED"] = "EXPIRED";
    ContractStatus["TERMINATED"] = "TERMINATED";
    ContractStatus["RENEWED"] = "RENEWED";
})(ContractStatus || (ContractStatus = {}));
export var Priority;
(function (Priority) {
    Priority["LOW"] = "LOW";
    Priority["MEDIUM"] = "MEDIUM";
    Priority["HIGH"] = "HIGH";
    Priority["CRITICAL"] = "CRITICAL";
})(Priority || (Priority = {}));
//# sourceMappingURL=enums.js.map