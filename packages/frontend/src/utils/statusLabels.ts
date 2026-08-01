/**
 * Canonical human-readable labels for every status enum the UI displays.
 *
 * One real-world fact — "what state is this audit in?" — is stored across several
 * entities (ProjectBranchStatus, AssignmentStatus, ScheduleStatus). Each page used to
 * render those with its own vocabulary, so the same branch showed as "AUDIT_COMPLETED"
 * on Field Execution, "Under Validation" on Planning, and its schedule as "COMPLETED"
 * on Scheduling — three different words for one situation.
 *
 * Every page imports from here so the wording is identical wherever it appears.
 * Raw SCREAMING_SNAKE enum values must never be rendered directly to users.
 */
import {
  ProjectBranchStatus,
  AssignmentStatus,
  ScheduleStatus,
  AssessmentStatus,
  ClientLifecycleStatus,
  ClientType,
  ContractStatus,
  ClientBillingStatus,
} from '@fapoms/shared';

/** Where a branch sits in the audit lifecycle. */
const BRANCH_STATUS_LABELS: Record<ProjectBranchStatus, string> = {
  [ProjectBranchStatus.IMPORTED]: 'Imported',
  [ProjectBranchStatus.PLANNING]: 'Planning',
  [ProjectBranchStatus.CANDIDATE_SEARCH]: 'Finding Assayer',
  [ProjectBranchStatus.CONTACT_INITIATED]: 'Contacting Assayer',
  [ProjectBranchStatus.NEGOTIATION]: 'Negotiation',
  [ProjectBranchStatus.ASSIGNMENT_CONFIRMED]: 'Assigned',
  [ProjectBranchStatus.SCHEDULED]: 'Scheduled',
  [ProjectBranchStatus.AUDIT_COMPLETED]: 'Audit Completed',
  [ProjectBranchStatus.VALIDATION_COMPLETED]: 'Validation Completed',
  [ProjectBranchStatus.CLOSED]: 'Closed',
  [ProjectBranchStatus.UNABLE_TO_COVER]: 'Unable to Cover',
  [ProjectBranchStatus.ON_HOLD]: 'On Hold',
  [ProjectBranchStatus.CANCELLED]: 'Cancelled',
};

/** Where the assayer's commitment sits. */
const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  [AssignmentStatus.PENDING]: 'Awaiting Response',
  [AssignmentStatus.ACCEPTED]: 'Accepted',
  [AssignmentStatus.CHECKED_IN]: 'Checked In',
  [AssignmentStatus.IN_PROGRESS]: 'In Progress',
  [AssignmentStatus.COMPLETED]: 'Completed',
  [AssignmentStatus.REJECTED]: 'Rejected',
  [AssignmentStatus.CANCELLED]: 'Cancelled',
};

/** Where the assessment (the document/data-entry pipeline) sits. */
const ASSESSMENT_STATUS_LABELS: Record<AssessmentStatus, string> = {
  [AssessmentStatus.PENDING_PLANNING]: 'Pending Planning',
  [AssessmentStatus.ASSESSOR_RECOMMENDED]: 'Assayer Recommended',
  [AssessmentStatus.IN_NEGOTIATION]: 'In Negotiation',
  [AssessmentStatus.ASSIGNED_AND_SCHEDULED]: 'Assigned & Scheduled',
  [AssessmentStatus.UNASSIGNED]: 'Unassigned',
  [AssessmentStatus.AWAITING_CLIENT_DATA]: 'Awaiting Client Data',
  [AssessmentStatus.CLIENT_DATA_RECEIVED]: 'Client Data Received',
  [AssessmentStatus.PDF_GENERATED]: 'PDF Generated',
  [AssessmentStatus.READY_FOR_DISPATCH]: 'Ready for Dispatch',
  [AssessmentStatus.DISPATCHED_TO_ASSESSOR]: 'Dispatched to Assayer',
  [AssessmentStatus.AUDITED_PDF_RECEIVED]: 'Audited PDF Received',
  [AssessmentStatus.SENT_TO_DATA_ENTRY]: 'Sent to Data Entry',
  [AssessmentStatus.DATA_ENTRY_IN_PROGRESS]: 'Data Entry in Progress',
  [AssessmentStatus.CLARIFICATION_NEEDED]: 'Clarification Needed',
  [AssessmentStatus.REPORT_FINALIZED]: 'Report Finalized',
  [AssessmentStatus.PENDING_HEAD_APPROVAL]: 'Pending Head Approval',
  [AssessmentStatus.DELIVERED_TO_CLIENT]: 'Delivered to Client',
  [AssessmentStatus.COMPLETED]: 'Completed',
};

/** Where the dispatch/visit booking sits. */
const SCHEDULE_STATUS_LABELS: Record<ScheduleStatus, string> = {
  [ScheduleStatus.TENTATIVE]: 'Tentative',
  [ScheduleStatus.CONFIRMED]: 'Confirmed',
  [ScheduleStatus.RESCHEDULED]: 'Rescheduled',
  [ScheduleStatus.COMPLETED]: 'Visit Completed',
};

/** Where a client sits in its commercial lifecycle. */
const CLIENT_LIFECYCLE_LABELS: Record<ClientLifecycleStatus, string> = {
  [ClientLifecycleStatus.PROSPECT]: 'Prospect',
  [ClientLifecycleStatus.ONBOARDING]: 'Onboarding',
  [ClientLifecycleStatus.ACTIVE]: 'Active',
  [ClientLifecycleStatus.SUSPENDED]: 'Suspended',
  [ClientLifecycleStatus.UNDER_REVIEW]: 'Under Review',
  [ClientLifecycleStatus.INACTIVE]: 'Inactive',
  [ClientLifecycleStatus.TERMINATED]: 'Terminated',
  [ClientLifecycleStatus.ARCHIVED]: 'Archived',
};

/** Client industry segment. */
const CLIENT_TYPE_LABELS: Record<ClientType, string> = {
  [ClientType.BANK]: 'Bank',
  [ClientType.NBFC]: 'NBFC',
  [ClientType.MICROFINANCE]: 'Microfinance',
  [ClientType.INSURANCE]: 'Insurance',
  [ClientType.CORPORATE]: 'Corporate',
  [ClientType.GOVERNMENT]: 'Government',
  [ClientType.OTHER]: 'Other',
};

/** Client contract state. */
const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  [ContractStatus.DRAFT]: 'Draft',
  [ContractStatus.ACTIVE]: 'Active',
  [ContractStatus.EXPIRED]: 'Expired',
  [ContractStatus.TERMINATED]: 'Terminated',
  [ContractStatus.RENEWED]: 'Renewed',
};

/** Client billing state. */
const BILLING_STATUS_LABELS: Record<ClientBillingStatus, string> = {
  [ClientBillingStatus.DRAFT]: 'Draft',
  [ClientBillingStatus.ACTIVE]: 'Active',
  [ClientBillingStatus.SUSPENDED]: 'Suspended',
  [ClientBillingStatus.INACTIVE]: 'Inactive',
};

/**
 * Fallback for any value not in the maps above (e.g. a status added to the backend
 * before the UI catches up): turn SCREAMING_SNAKE into Title Case rather than
 * leaking the raw enum to the user.
 */
function humanize(value: string): string {
  return value
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

export function branchStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return BRANCH_STATUS_LABELS[status as ProjectBranchStatus] ?? humanize(status);
}

export function assignmentStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return ASSIGNMENT_STATUS_LABELS[status as AssignmentStatus] ?? humanize(status);
}

export function scheduleStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return SCHEDULE_STATUS_LABELS[status as ScheduleStatus] ?? humanize(status);
}

export function assessmentStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return ASSESSMENT_STATUS_LABELS[status as AssessmentStatus] ?? humanize(status);
}

export function clientLifecycleLabel(status?: string | null): string {
  if (!status) return '—';
  return CLIENT_LIFECYCLE_LABELS[status as ClientLifecycleStatus] ?? humanize(status);
}

export function clientTypeLabel(type?: string | null): string {
  if (!type) return '—';
  return CLIENT_TYPE_LABELS[type as ClientType] ?? humanize(type);
}

export function contractStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return CONTRACT_STATUS_LABELS[status as ContractStatus] ?? humanize(status);
}

export function billingStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return BILLING_STATUS_LABELS[status as ClientBillingStatus] ?? humanize(status);
}

/**
 * Labels a status that may come from either the branch or the assignment axis —
 * used where a single badge renders whichever of the two is available. Branch
 * values win, matching how the badge itself picks its source.
 */
export function anyStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return (
    BRANCH_STATUS_LABELS[status as ProjectBranchStatus] ??
    ASSIGNMENT_STATUS_LABELS[status as AssignmentStatus] ??
    humanize(status)
  );
}
