/**
 * Canonical human-readable labels for every status enum the product displays.
 *
 * One real-world fact — "what state is this audit in?" — is stored across several entities
 * (ProjectBranchStatus, AssignmentStatus, ScheduleStatus). Each surface used to render those
 * with its own vocabulary, so the same branch showed as "AUDIT_COMPLETED" on Field Execution,
 * "Under Validation" on Planning, and "COMPLETED" on Scheduling — three words for one
 * situation.
 *
 * This lives in the shared package rather than the web app because the mobile app had grown a
 * *second* copy of the same vocabulary, inline in its screens. The desk and the field could
 * therefore describe the same assignment differently, and mobile's copy had already drifted:
 * it was missing CANCELLED entirely and invented ten payable statuses that do not exist.
 *
 * Every surface imports from here. Raw SCREAMING_SNAKE enum values must never be rendered.
 */
import {
  ProjectBranchStatus,
  AssignmentStatus,
  ScheduleStatus,
  ClientLifecycleStatus,
  ClientType,
  ContractStatus,
  BillingState,
  InvoiceStatus,
  AssayerPayableStatus,
  ProjectStatus,
  TravelMode,
  FeedbackStatus,
  FeedbackCategory,
  SystemRole,
  AssayerLifecycleStatus,
  BillingEntityType,
  PaymentDirection,
  PaymentMethod,
  DocumentType,
  ValidationStatus,
  ValidationQueryStatus,
  Priority,
  UserStatus,
} from './enums';

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

/**
 * Money words, shared by the finance desk and the assayer's phone so the same line never
 * reads "PENDING" on one screen and "Awaiting approval" on the other.
 */
export const BILLING_STATE_LABELS: Record<BillingState, string> = {
  [BillingState.UNBILLED]: 'Unbilled',
  [BillingState.INVOICED]: 'Invoiced',
  [BillingState.PAID]: 'Paid',
  [BillingState.CANCELLED]: 'Cancelled',
};

export const PAYABLE_STATUS_LABELS: Record<AssayerPayableStatus, string> = {
  [AssayerPayableStatus.PENDING]: 'Due',
  [AssayerPayableStatus.APPROVED]: 'Approved',
  [AssayerPayableStatus.PAID]: 'Paid',
};

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  [InvoiceStatus.DRAFT]: 'Draft',
  [InvoiceStatus.ISSUED]: 'Sent',
  [InvoiceStatus.PAID]: 'Paid',
  [InvoiceStatus.CANCELLED]: 'Cancelled',
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

/**
 * Project lifecycle wording. The Projects page rendered these with
 * `status.replace(/_/g, ' ')`, so ON_HOLD read "ON HOLD" there while every other surface in the
 * product writes status names in sentence case.
 */
const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  [ProjectStatus.DRAFT]: 'Draft',
  [ProjectStatus.PLANNING]: 'Planning',
  [ProjectStatus.SCHEDULING]: 'Scheduling',
  [ProjectStatus.EXECUTION]: 'Execution',
  [ProjectStatus.VALIDATION]: 'Validation',
  [ProjectStatus.COMPLETED]: 'Completed',
  [ProjectStatus.ARCHIVED]: 'Archived',
  [ProjectStatus.CANCELLED]: 'Cancelled',
  [ProjectStatus.ON_HOLD]: 'On Hold',
};

export function projectStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return PROJECT_STATUS_LABELS[status as ProjectStatus] ?? humanize(status);
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

export function clientLifecycleLabel(status?: string | null): string {
  if (!status) return '—';
  return CLIENT_LIFECYCLE_LABELS[status as ClientLifecycleStatus] ?? humanize(status);
}

export function clientTypeLabel(type?: string | null): string {
  if (!type) return '—';
  return CLIENT_TYPE_LABELS[type as ClientType] ?? humanize(type);
}

/**
 * Client/work priority. CRITICAL was rendered raw in the client create and edit forms, so a
 * picker offered "CRITICAL" beside "Banking & Finance" — the only screaming word on the form.
 */
const PRIORITY_LABELS: Record<Priority, string> = {
  [Priority.LOW]: 'Low',
  [Priority.MEDIUM]: 'Medium',
  [Priority.HIGH]: 'High',
  [Priority.CRITICAL]: 'Critical',
};

export function priorityLabel(priority?: string | null): string {
  if (!priority) return '—';
  return PRIORITY_LABELS[priority as Priority] ?? humanize(priority);
}

/**
 * How exposed a branch is, and how much work it is — the two words the Branches list puts in
 * front of the office.
 *
 * Both were rendered raw. "MEDIUM" in the Risk column and "VERY_COMPLEX" in the detail panel are
 * database spellings; a clerk reading them cannot tell whether the capitals mean "urgent" or are
 * simply how the machine writes things, and an underscore is not a word in any language.
 *
 * Risk deliberately borrows the priority wording rather than inventing a second set: the four
 * bands are the same four words, and having "High" on one screen and "HIGH" on another is exactly
 * the drift this file exists to prevent. `humanize` still catches any band the backend adds
 * before the UI does.
 */
export function riskCategoryLabel(risk?: string | null): string {
  if (!risk) return '—';
  return PRIORITY_LABELS[risk as Priority] ?? humanize(risk);
}

const BRANCH_COMPLEXITY_LABELS: Record<string, string> = {
  SIMPLE: 'Simple',
  STANDARD: 'Standard',
  COMPLEX: 'Complex',
  VERY_COMPLEX: 'Very complex',
};

export function branchComplexityLabel(complexity?: string | null): string {
  if (!complexity) return '—';
  return BRANCH_COMPLEXITY_LABELS[complexity] ?? humanize(complexity);
}

/**
 * Branch type as clients actually send it. The values in the live data are MAIN, METRO, SUB and
 * URBAN — a mix of "what kind of office" and "what kind of place" — so this map covers both
 * families rather than the tidier list the form used to offer.
 */
const BRANCH_TYPE_LABELS: Record<string, string> = {
  MAIN: 'Main branch',
  BRANCH: 'Branch',
  SUB: 'Sub-branch',
  SUB_BRANCH: 'Sub-branch',
  EXTENSION: 'Extension counter',
  MICRO: 'Micro branch',
  METRO: 'Metro',
  URBAN: 'Urban',
  SEMI_URBAN: 'Semi-urban',
  RURAL: 'Rural',
};

export function branchTypeLabel(type?: string | null): string {
  if (!type) return '—';
  return BRANCH_TYPE_LABELS[type] ?? humanize(type);
}

/**
 * Account state in the users directory. These are shown to an administrator deciding whether
 * to suspend or reactivate somebody, which is precisely when the raw enum reads as a system
 * error rather than a state a person chose.
 */
const USER_STATUS_LABELS: Record<UserStatus, string> = {
  [UserStatus.INVITED]: 'Invited',
  [UserStatus.ACTIVE]: 'Active',
  [UserStatus.SUSPENDED]: 'Suspended',
  [UserStatus.LOCKED]: 'Locked',
  [UserStatus.DISABLED]: 'Disabled',
  [UserStatus.ARCHIVED]: 'Archived',
};

export function userStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return USER_STATUS_LABELS[status as UserStatus] ?? humanize(status);
}

export function contractStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return CONTRACT_STATUS_LABELS[status as ContractStatus] ?? humanize(status);
}

export function billingStateLabel(state?: string | null): string {
  if (!state) return '—';
  return BILLING_STATE_LABELS[state as BillingState] ?? humanize(state);
}

export function payableStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return PAYABLE_STATUS_LABELS[status as AssayerPayableStatus] ?? humanize(status);
}

export function invoiceStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return INVOICE_STATUS_LABELS[status as InvoiceStatus] ?? humanize(status);
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

/**
 * Canonical branch-status sets used to compute coverage KPIs. These are the single
 * source of truth so that the planning header ("X% covered"), the Excel export
 * ("Audit Coverage Possible") and any per-branch "done" checks all agree on which
 * statuses count as covered vs pending — previously each used a different subset.
 */
export const BRANCH_COVERED_STATUSES: readonly ProjectBranchStatus[] = [
  ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
  ProjectBranchStatus.SCHEDULED,
  ProjectBranchStatus.AUDIT_COMPLETED,
  ProjectBranchStatus.VALIDATION_COMPLETED,
  ProjectBranchStatus.CLOSED,
];

export const BRANCH_DONE_STATUSES: readonly ProjectBranchStatus[] = [
  ProjectBranchStatus.AUDIT_COMPLETED,
  ProjectBranchStatus.VALIDATION_COMPLETED,
  ProjectBranchStatus.CLOSED,
];

export const BRANCH_PENDING_STATUSES: readonly ProjectBranchStatus[] = [
  ProjectBranchStatus.IMPORTED,
  ProjectBranchStatus.PLANNING,
  ProjectBranchStatus.CANDIDATE_SEARCH,
  ProjectBranchStatus.CONTACT_INITIATED,
  ProjectBranchStatus.NEGOTIATION,
  ProjectBranchStatus.ON_HOLD,
];

/** Statuses that represent a branch's audit being fully finished (for "done" badges). */
export const BRANCH_ACTIVE_COVERED_STATUSES: readonly ProjectBranchStatus[] = [
  ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
  ProjectBranchStatus.SCHEDULED,
];

/**
 * Assignment statuses that have reached the end of their life.
 *
 * The mobile app split Active from History in one place and filtered "current work" in
 * another, each with its own hand-written list, so an assignment could sit in Active on one
 * screen and History on another. Terminal state is expressed by status alone — `isActive`
 * means "not deleted", never "finished".
 */
export const ASSIGNMENT_TERMINAL_STATUSES: readonly AssignmentStatus[] = [
  AssignmentStatus.COMPLETED,
  AssignmentStatus.REJECTED,
  AssignmentStatus.CANCELLED,
];

export function isAssignmentTerminal(status?: string | null): boolean {
  return !!status && (ASSIGNMENT_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Local-timezone `YYYY-MM-DD` key. Using `new Date().toISOString().split('T')[0]`
 * returns the *UTC* date, which is a day behind the user's local "today" for any
 * timezone ahead of UTC — so "today"'s schedules silently moved to the wrong day.
 * Every date-only comparison in a calendar should use this.
 */
export function localDateKey(value?: string | number | Date | null): string {
  if (value == null || value === '') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function todayDateKey(): string {
  return localDateKey(new Date());
}

/**
 * Render a **date-only** value (a `YYYY-MM-DD` column, or anything with no meaningful time-of-day)
 * in the local calendar without the UTC-parse shift.
 *
 * `new Date('2026-08-09').toLocaleDateString()` parses the string as UTC midnight, which renders a
 * day early for every timezone behind UTC — the exact split that let a schedule be bucketed under one
 * day (via `localDateKey`) yet print a different date on its card. Anchoring a bare `YYYY-MM-DD` to
 * *local* midnight removes the shift. Real timestamps (`timestamptz`) are passed through unchanged.
 */
export function formatDateOnly(
  value?: string | number | Date | null,
  options: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' },
  locale = 'en-IN',
): string {
  const d = parseCalendarDate(value);
  if (!d) return '';
  return d.toLocaleDateString(locale, options);
}

/**
 * Turn a date-ish value into a local `Date`, treating a bare `YYYY-MM-DD` as *local* midnight.
 *
 * This is the one place that knows the difference between a calendar date and an instant.
 * `new Date('2026-08-18')` is UTC midnight, which is the evening of the 17th anywhere west of
 * Greenwich — and the mobile schedule computed "days until" and grouped stops by day with exactly
 * that expression. It happened to be right in IST (+05:30 keeps the calendar day) and would have
 * put every stop a day early the moment a device left the country. `formatDateOnly` had the
 * correct handling inline; it is extracted so the other date-only readers can share it instead
 * of each carrying its own `new Date(iso)`.
 *
 * Returns `null` for empty or unparseable input, so callers decide what an absent date means.
 */
export function parseCalendarDate(value?: string | number | Date | null): Date | null {
  if (value == null || value === '') return null;
  let d: Date;
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  } else {
    d = new Date(value);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The `YYYY-MM-DD` calendar date in the operation's business timezone (India), independent of where the
 * process runs. `new Date().toISOString().split('T')[0]` yields the *UTC* date, which is still yesterday
 * for IST between 00:00 and 05:30 — so a server-side "today" default scheduled work a day early. `en-CA`
 * formats as `YYYY-MM-DD`, and the explicit `timeZone` makes the result the same on a UTC server or a
 * local dev box.
 */
export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';
export function businessDateKey(value: Date | string | number, timeZone: string = BUSINESS_TIME_ZONE): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone });
}
export function businessTodayDateKey(timeZone: string = BUSINESS_TIME_ZONE): string {
  return businessDateKey(new Date(), timeZone);
}

/**
 * The same "today", for SQL.
 *
 * `CURRENT_DATE` is the *database session's* date, and the database runs UTC — so between
 * midnight and 05:30 in India it is still yesterday. Every query that buckets by day, counts
 * "days away" or decides what is overdue was reading that clock, which put the boundary of the
 * working day at half past five in the morning. Interpolate this instead; it needs no
 * parameter and is safe to inline.
 */
export const BUSINESS_TODAY_SQL = `((NOW() AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date)`;

/**
 * Reasons an assayer can flag an assignment to the operations desk from the field app.
 *
 * The field app cannot cancel or reassign work — those stay with the desk. This is the
 * assayer's one channel to raise a problem on their own initiative, so the categories are the
 * real situations a field worker hits: a branch they cannot get into, a job they cannot make,
 * a safety concern, or something needing the desk's clarification. Shared so the mobile picker,
 * the backend audit/notification text, and the web desk view all read the same words.
 */
export const ASSIGNMENT_ISSUE_CATEGORIES = [
  'CANNOT_ATTEND',
  'BRANCH_INACCESSIBLE',
  'NEEDS_CLARIFICATION',
  'SAFETY_CONCERN',
  'OTHER',
] as const;

export type AssignmentIssueCategory = (typeof ASSIGNMENT_ISSUE_CATEGORIES)[number];

export const ASSIGNMENT_ISSUE_CATEGORY_LABELS: Record<AssignmentIssueCategory, string> = {
  CANNOT_ATTEND: 'Cannot attend',
  BRANCH_INACCESSIBLE: 'Branch inaccessible',
  NEEDS_CLARIFICATION: 'Needs clarification',
  SAFETY_CONCERN: 'Safety concern',
  OTHER: 'Other',
};

export function assignmentIssueCategoryLabel(category?: string | null): string {
  if (!category) return 'Issue';
  return ASSIGNMENT_ISSUE_CATEGORY_LABELS[category as AssignmentIssueCategory] ?? category;
}

/** How an assayer travels. Rendered wherever a transport rate or recommendation is shown. */
export const TRAVEL_MODE_LABELS: Record<TravelMode, string> = {
  [TravelMode.CAR]: 'Own Car',
  [TravelMode.TWO_WHEELER]: 'Own Two-Wheeler',
  [TravelMode.BUS]: 'Bus',
  [TravelMode.TRAIN]: 'Train',
  [TravelMode.AUTO_RICKSHAW]: 'Auto-Rickshaw',
  [TravelMode.TAXI]: 'Taxi / Cab',
  [TravelMode.FLIGHT]: 'Flight',
  [TravelMode.OTHER]: 'Other',
};

/** Stable display order — everyday modes first, so dropdowns lead with the common cases. */
export const TRAVEL_MODE_ORDER: readonly TravelMode[] = [
  TravelMode.TWO_WHEELER,
  TravelMode.CAR,
  TravelMode.BUS,
  TravelMode.TRAIN,
  TravelMode.AUTO_RICKSHAW,
  TravelMode.TAXI,
  TravelMode.FLIGHT,
  TravelMode.OTHER,
];

export function travelModeLabel(mode?: string | null): string {
  if (!mode) return '—';
  return TRAVEL_MODE_LABELS[mode as TravelMode] ?? mode;
}

/**
 * Feedback wording, shared so the two surfaces of one conversation say the same thing.
 *
 * The web triage desk and the mobile app each wrote their own map, and they disagreed on the two
 * words users actually exchange: the desk said "Acknowledged" where the phone said "Seen", and
 * "Enhancement" where the phone said "Idea". Both are describing the same thread — so a field
 * assayer would report that their issue was marked "Seen" while the product team was looking at a
 * badge reading "Acknowledged", and neither could tell whether they were discussing the same
 * state. Mobile also rendered the raw category (`ENHANCEMENT`) in thread headers, which is the
 * SCREAMING_SNAKE leak this file exists to prevent.
 *
 * One wording, chosen for the person being told rather than for the schema.
 */
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  // "New", which is what both surfaces already said — it reads as a queue position rather than
  // a state, which is how the person looking at it thinks about it.
  [FeedbackStatus.OPEN]: 'New',
  // "Acknowledged", not mobile's "Seen". The enum means the team has replied and is engaging;
  // "Seen" reads as merely opened, which understates it to the person waiting for an answer.
  [FeedbackStatus.ACKNOWLEDGED]: 'Acknowledged',
  [FeedbackStatus.IN_PROGRESS]: 'In progress',
  [FeedbackStatus.RESOLVED]: 'Resolved',
  [FeedbackStatus.CLOSED]: 'Closed',
};

export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  [FeedbackCategory.BUG]: 'Bug',
  // "Enhancement", not mobile's "Idea". Friendlier is not worth two names for one thing when
  // both people are looking at the same thread.
  [FeedbackCategory.ENHANCEMENT]: 'Enhancement',
  [FeedbackCategory.PROCESS]: 'Process',
  [FeedbackCategory.QUESTION]: 'Question',
  [FeedbackCategory.OTHER]: 'Other',
};

export function feedbackStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return FEEDBACK_STATUS_LABELS[status as FeedbackStatus] ?? status;
}

export function feedbackCategoryLabel(category?: string | null): string {
  if (!category) return '—';
  return FEEDBACK_CATEGORY_LABELS[category as FeedbackCategory] ?? category;
}

// ---------------------------------------------------------------------------
// Words for people, workforce state, money records and activity feeds
// ---------------------------------------------------------------------------
//
// These five vocabularies were the ones still being rendered by de-casing the raw enum at the
// call site — `role.replace(/_/g, ' ')` on the user directory, a lower-cased role on assayer
// remarks, `documentType.replace(/_/g, ' ')` on the HR register. That produces "OPERATIONS
// EXECUTIVE" and "PAN" rather than "Operations Executive" and "PAN Card", and it means the same
// value can read differently on two screens. They belong here with everything else.

/**
 * Job titles, written the way the organisation says them out loud.
 *
 * Not a de-cased enum: `SUPER_ADMINISTRATOR` de-cases to "Super Administrator", but
 * `HR_MANAGER` de-cases to "Hr Manager" and `PRODUCT_SUPPORT` to "Product Support" where the
 * team is spoken of as "Product & Support". Spelling them out is the only way both read right.
 */
export const ROLE_LABELS: Record<SystemRole, string> = {
  [SystemRole.SUPER_ADMINISTRATOR]: 'Super Administrator',
  [SystemRole.ADMINISTRATOR]: 'Administrator',
  [SystemRole.OPERATIONS_MANAGER]: 'Operations Manager',
  [SystemRole.OPERATIONS_EXECUTIVE]: 'Operations Executive',
  [SystemRole.VALIDATION_MANAGER]: 'Validation Manager',
  [SystemRole.VALIDATOR]: 'Validator',
  [SystemRole.DOCUMENT_EXECUTIVE]: 'Document Executive',
  [SystemRole.DATA_ENTRY_HEAD]: 'Data Entry Head',
  [SystemRole.ASSAYER]: 'Assayer',
  [SystemRole.CLIENT_USER]: 'Client User',
  [SystemRole.HR_MANAGER]: 'HR Manager',
  [SystemRole.FINANCE_MANAGER]: 'Finance Manager',
  [SystemRole.READ_ONLY_AUDITOR]: 'Read-Only Auditor',
  [SystemRole.PRODUCT_SUPPORT]: 'Product & Support',
};

export function roleLabel(role?: string | null): string {
  if (!role) return '—';
  return ROLE_LABELS[role as SystemRole] ?? humanize(role);
}

/** Several roles on one line ("Operations Manager, Validator"). Empty list reads as a dash. */
export function roleListLabel(roles?: readonly (string | null | undefined)[] | null): string {
  const named = (roles ?? []).filter(Boolean).map((r) => roleLabel(r));
  return named.length ? named.join(', ') : '—';
}

/**
 * Where an assayer sits with HR — onboarding, working, or gone.
 *
 * These are read by people outside HR too (planning sees who can be offered work), so the
 * onboarding steps say what is being waited on rather than naming the check.
 */
export const ASSAYER_LIFECYCLE_LABELS: Record<AssayerLifecycleStatus, string> = {
  [AssayerLifecycleStatus.INVITED]: 'Invited',
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: 'Document Verification',
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: 'Background Verification',
  [AssayerLifecycleStatus.TRAINING]: 'Training',
  [AssayerLifecycleStatus.ACTIVE]: 'Active',
  [AssayerLifecycleStatus.ON_LEAVE]: 'On Leave',
  [AssayerLifecycleStatus.SUSPENDED]: 'Suspended',
  [AssayerLifecycleStatus.INACTIVE]: 'Inactive',
  [AssayerLifecycleStatus.RESIGNED]: 'Resigned',
  [AssayerLifecycleStatus.TERMINATED]: 'Terminated',
  [AssayerLifecycleStatus.ARCHIVED]: 'Archived',
};

export function assayerLifecycleLabel(status?: string | null): string {
  if (!status) return '—';
  return ASSAYER_LIFECYCLE_LABELS[status as AssayerLifecycleStatus] ?? humanize(status);
}

/**
 * How someone is engaged — on the payroll, on a contract, or through an agency.
 *
 * There was no shared wording for this at all, so the assayer record rendered the stored value
 * straight onto the screen: every person on the live roster reads "INTERNAL" under Employment.
 * The create/edit form offers a list that does not even contain that value, so an office user had
 * no way to find out what it means. Free text is allowed here (imports carry whatever the client's
 * sheet said), which is why unknown values fall through to sentence case rather than "—".
 */
export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  INTERNAL: 'On our payroll',
  FULL_TIME: 'Full time',
  PART_TIME: 'Part time',
  CONTRACT: 'On contract',
  INTERN: 'Intern',
  CONSULTANT: 'Consultant',
  FREELANCE: 'Freelance',
  EXTERNAL: 'Outside agency',
};

export function employmentTypeLabel(type?: string | null): string {
  if (!type) return '—';
  return EMPLOYMENT_TYPE_LABELS[type.toUpperCase()] ?? humanize(type);
}

/**
 * The client-side ledger line for one assignment. Same values as `billingStateLabel` — named
 * for the record the finance desk is actually looking at ("this billing entry"), because
 * "state" is the schema's word and "status" is the one on the screen.
 */
export function billingEntryStatusLabel(status?: string | null): string {
  return billingStateLabel(status);
}

/** Which ledger a billing history row belongs to. */
export const BILLING_ENTITY_TYPE_LABELS: Record<BillingEntityType, string> = {
  [BillingEntityType.ENTRY]: 'Billing Entry',
  [BillingEntityType.INVOICE]: 'Invoice',
  [BillingEntityType.PAYMENT]: 'Payment',
  [BillingEntityType.PAYABLE]: 'Assayer Payable',
};

export function billingEntityTypeLabel(type?: string | null): string {
  if (!type) return '—';
  return BILLING_ENTITY_TYPE_LABELS[type as BillingEntityType] ?? humanize(type);
}

/** Which way the money moved, said from the business's side of the transaction. */
export const PAYMENT_DIRECTION_LABELS: Record<PaymentDirection, string> = {
  [PaymentDirection.INBOUND]: 'Received from Client',
  [PaymentDirection.OUTBOUND]: 'Paid to Assayer',
};

export function paymentDirectionLabel(direction?: string | null): string {
  if (!direction) return '—';
  return PAYMENT_DIRECTION_LABELS[direction as PaymentDirection] ?? humanize(direction);
}

/** How a payment was made. The Indian rails keep their everyday initialisms. */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.BANK_TRANSFER]: 'Bank Transfer',
  [PaymentMethod.NEFT]: 'NEFT',
  [PaymentMethod.RTGS]: 'RTGS',
  [PaymentMethod.UPI]: 'UPI',
  [PaymentMethod.CHEQUE]: 'Cheque',
  [PaymentMethod.CARD]: 'Card',
  [PaymentMethod.OTHER]: 'Other',
};

export function paymentMethodLabel(method?: string | null): string {
  if (!method) return '—';
  return PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? humanize(method);
}

/**
 * Government identity papers held on an assayer's HR record.
 *
 * De-casing is actively wrong here: `PAN` is an initialism people say as "PAN card", and
 * `AADHAAR` alone reads as a bare word where the register lists a document. Both the short
 * backend value (`PAN`) and the longer form some payloads carry (`PAN_CARD`) map to the same
 * words, so the register cannot show two names for one paper.
 */
export const HR_DOCUMENT_TYPES = [
  'AADHAAR',
  'PAN',
  'DRIVING_LICENCE',
  'VOTER_ID',
  'PASSPORT',
] as const;

export type HrDocumentType = (typeof HR_DOCUMENT_TYPES)[number];

export const HR_DOCUMENT_TYPE_LABELS: Record<string, string> = {
  AADHAAR: 'Aadhaar',
  AADHAAR_CARD: 'Aadhaar',
  PAN: 'PAN Card',
  PAN_CARD: 'PAN Card',
  DRIVING_LICENCE: 'Driving Licence',
  DRIVING_LICENSE: 'Driving Licence',
  VOTER_ID: 'Voter ID',
  PASSPORT: 'Passport',
  BANK_PASSBOOK: 'Bank Passbook',
  CANCELLED_CHEQUE: 'Cancelled Cheque',
  PHOTOGRAPH: 'Photograph',
  OTHER: 'Other',
};

export function hrDocumentTypeLabel(type?: string | null): string {
  if (!type) return '—';
  return HR_DOCUMENT_TYPE_LABELS[type] ?? humanize(type);
}

/**
 * Audit-document types (the paperwork that moves between the desk, the assayer and the client).
 * Distinct from `HR_DOCUMENT_TYPE_LABELS`, which is a person's identity papers — the two were
 * both called "documents" and had to be told apart in words, not only by which page you are on.
 */
export const AUDIT_DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  [DocumentType.BRANCH_LIST]: 'Branch List',
  [DocumentType.CUSTOMER_MASTER_DATA]: 'Customer Master Data',
  [DocumentType.PRE_FIELD_AUDIT_PDF]: 'Pre-Field Audit PDF',
  [DocumentType.AUDITED_RETURN_PDF]: 'Audited Return PDF',
  [DocumentType.GENERATED_EXCEL]: 'Generated Excel',
  [DocumentType.FINAL_REPORT]: 'Final Report',
};

export function auditDocumentTypeLabel(type?: string | null): string {
  if (!type) return '—';
  return AUDIT_DOCUMENT_TYPE_LABELS[type as DocumentType] ?? humanize(type);
}

/**
 * Activity-feed wording.
 *
 * An event type is a sentence about something that happened, not a name — so unlike every other
 * map here these read as sentence case ("Status changed"), which is how a timeline entry is
 * spoken. The backend emits well over a hundred event types and grows a new one with every
 * feature; enumerating all of them here would go stale the week it was written. So this maps the
 * handful the generic feeds actually render, and `activityEventLabel` falls back to sentence-
 * casing the raw value — `ASSIGNMENT_SLA_BREACHED` reads as "Assignment sla breached", which is
 * plain enough to be useful and never a raw SCREAMING_SNAKE leak.
 */
export const ACTIVITY_EVENT_LABELS: Record<string, string> = {
  STATUS_CHANGE: 'Status changed',
  STATUS_CHANGED: 'Status changed',
  TRANSITION: 'Moved to next stage',
  COMMENT: 'Comment added',
  REMARK_ADDED: 'Remark added',
  CREATED: 'Created',
  UPDATED: 'Updated',
  DELETED: 'Deleted',
  PROFILE_UPDATE: 'Details updated',
  ASSIGNED: 'Assigned',
  UNASSIGNED: 'Unassigned',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  ESCALATED: 'Escalated',
  REMINDER_SENT: 'Reminder sent',
  DOCUMENT_UPLOADED: 'Document uploaded',
  DOCUMENT_DISPATCHED: 'Document sent out',
  PAYMENT_RECORDED: 'Payment recorded',
  INVOICE_ISSUED: 'Invoice sent',
};

/**
 * Sentence case for a SCREAMING_SNAKE value: first letter up, the rest as ordinary words.
 * Kept separate from `humanize` (Title Case) because a name and a sentence are not written
 * the same way, and mixing the two is what made feeds read like a database dump.
 */
function sentenceCase(value: string): string {
  const words = value.split('_').filter(Boolean).join(' ').toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : value;
}

export function activityEventLabel(eventType?: string | null): string {
  if (!eventType) return 'Activity';
  return ACTIVITY_EVENT_LABELS[eventType] ?? sentenceCase(eventType);
}

/**
 * Where a returned packet sits in the data-entry / validation pipeline.
 *
 * The only vocabulary the desk screens display that had no entry here — the reviews queue,
 * the case workspace header and the audit trail each de-cased `ValidationStatus` themselves,
 * so a case read "OCR PROCESSING" and "CORRECTION REQUIRED" to the operator working it.
 *
 * De-casing is wrong for two of these regardless of the shouting. `OCR_PROCESSING` names the
 * scanning technology, which means nothing to the data-entry staff who see it; what they need
 * to know is that the machine is still reading the pages. And `SUBMITTED` alone does not say
 * submitted to whom — from this desk it always means the client. The wording matches the
 * reviews queue's own tab labels ("In review", "Approved", "Submitted") so the tab a person
 * clicked and the chip on the row it returns are never two different words.
 */
export const VALIDATION_STATUS_LABELS: Record<ValidationStatus, string> = {
  [ValidationStatus.PENDING]: 'Not started',
  [ValidationStatus.ASSIGNED]: 'Assigned',
  [ValidationStatus.OCR_PROCESSING]: 'Being read',
  [ValidationStatus.HUMAN_REVIEW]: 'In review',
  [ValidationStatus.CORRECTION_REQUIRED]: 'Needs correction',
  [ValidationStatus.APPROVED]: 'Approved',
  [ValidationStatus.SUBMITTED]: 'Submitted to client',
};

export function validationStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return VALIDATION_STATUS_LABELS[status as ValidationStatus] ?? humanize(status);
}

/**
 * Where a clarification thread with the assayer stands.
 *
 * The case workspace printed the raw enum on every thread chip — a clerk saw the word
 * "RESPONDED" and had no way to know whether that meant the assayer had replied (so the desk
 * must act) or that we had replied (so the assayer must). The three values are really three
 * answers to "whose move is it", and the cross-case Clarifications worklist already words it
 * that way in its tabs, so the chip on a thread and the tab that lists it now agree.
 */
export const VALIDATION_QUERY_STATUS_LABELS: Record<ValidationQueryStatus, string> = {
  [ValidationQueryStatus.OPEN]: 'Waiting on the assayer',
  [ValidationQueryStatus.RESPONDED]: 'Assayer replied — your turn',
  [ValidationQueryStatus.RESOLVED]: 'Closed',
};

export function validationQueryStatusLabel(status?: string | null): string {
  if (!status) return '—';
  return VALIDATION_QUERY_STATUS_LABELS[status as ValidationQueryStatus] ?? humanize(status);
}

/**
 * How a call to an assayer about a branch ended.
 *
 * Lived as an identical copy inside PlanningWorkspace.tsx and OperationsInbox.tsx, because the
 * shared package was frozen while a billing refactor landed and the two screens both needed it
 * at once. Duplicated vocabularies are exactly how the same value comes to read two different
 * ways on two screens, which is the problem this whole file exists to prevent — so it belongs
 * here, and the outcome picker and the outcome chip now read from one list.
 */
export const CALL_OUTCOME_LABELS: Record<string, string> = {
  AGREED: 'Agreed',
  NEGOTIATING: 'Negotiating',
  DECLINED: 'Declined the work',
  NO_ANSWER: 'No answer',
  CALLBACK_REQUESTED: 'Asked to call back',
  WRONG_NUMBER: 'Wrong number',
};

export function callOutcomeLabel(outcome?: string | null): string {
  if (!outcome) return '—';
  return CALL_OUTCOME_LABELS[outcome] ?? humanize(outcome);
}
