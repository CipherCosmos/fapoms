import { NotificationCategory, NotificationChannel, NotificationPriority } from '@fapoms/shared';

/**
 * The single registry of what this system can notify anyone about.
 *
 * The problem this solves: ~151 business events fire across the services, and
 * exactly 10 of them told anybody. The other 141 changed state silently. Worse,
 * the 10 that did notify each hand-built their own title string and picked their
 * own recipient inline, so "who hears about a rejected assignment" was an answer
 * spread across four files and impossible to audit or change.
 *
 * Everything about a notification type is declared here instead: its category,
 * urgency, which roles receive it, whether the directly-involved party receives
 * it, and how it reads. Adding an event to the system is adding a row here —
 * not writing another bespoke `notificationService.create(...)` call.
 *
 * `roles` is the *role-aware fan-out*: a role name resolves at send time to every
 * active user currently holding it, so notifications follow the org chart rather
 * than hardcoded user ids that rot the moment someone changes job.
 */

/** Recipient shorthands that are not role names. */
export type SpecialRecipient =
  /** The assayer the record belongs to. */
  | 'ASSIGNED_ASSAYER'
  /** The ops user who created/owns the record. */
  | 'RECORD_OWNER';

export interface NotificationTypeDef {
  category: NotificationCategory;
  priority: NotificationPriority;
  /** Roles whose active holders receive this. */
  roles: string[];
  /** Non-role recipients resolved from the payload. */
  special?: SpecialRecipient[];
  channels: NotificationChannel[];
  /** `${...}` placeholders are filled from the emit payload. */
  title: string;
  body: string;
  /** Frontend route for the click-through; `${...}` filled from payload. */
  link?: string;
  /**
   * Suppresses the notification for whoever performed the action. Almost always
   * true — being told about your own click is noise that trains people to
   * ignore the bell.
   */
  skipActor?: boolean;
}

const OPS = ['OPERATIONS_MANAGER', 'OPERATIONS_EXECUTIVE'];
const ADMINS = ['SUPER_ADMINISTRATOR', 'ADMINISTRATOR'];
const VALIDATION = ['VALIDATION_MANAGER', 'VALIDATOR'];
const BOTH_CHANNELS = [NotificationChannel.IN_APP, NotificationChannel.PUSH];
const IN_APP = [NotificationChannel.IN_APP];

/**
 * `link` is what the web app calls `navigate()` with when a notification is clicked
 * (Notifications.tsx). It must therefore match a route the frontend actually declares.
 *
 * These used to read `/assignments/${assignmentId}`, and the frontend has no
 * `/assignments/:id` route — only `/assignments`, which already accepts `?id=` and
 * pre-selects that row. So every assignment notification fell through to the catch-all
 * `path="*"` and silently redirected to the dashboard: the user clicked "New assignment
 * offered — Thrissur Main" and landed on a dashboard with no explanation and no way back to
 * the record. Six of the sixteen types were affected, including all the assignment-lifecycle
 * ones that make up most real traffic.
 */
export const NOTIFICATION_CATALOG: Record<string, NotificationTypeDef> = {
  // ── Assignment lifecycle ────────────────────────────────────────────────
  ASSIGNMENT_OFFERED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'New assignment offered',
    body: 'You have been offered ${branchName} on ${scheduledDate}. Please accept or decline.',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  ASSIGNMENT_ACCEPTED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.NORMAL,
    roles: OPS,
    channels: IN_APP,
    title: 'Assignment accepted',
    body: '${assayerName} accepted ${branchName}.',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  ASSIGNMENT_REJECTED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    roles: OPS,
    channels: BOTH_CHANNELS,
    title: 'Assignment declined',
    body: '${assayerName} declined ${branchName}. Reason: ${reason}. A replacement is needed.',
    link: '/planning',
    skipActor: true,
  },
  ASSIGNMENT_ESCALATED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.CRITICAL,
    roles: [...OPS, ...ADMINS],
    channels: BOTH_CHANNELS,
    title: 'Assignment escalated',
    body: '${branchName} has been marked critical. ${reason}',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  ASSIGNMENT_ISSUE_REPORTED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    // To the desk, not the assayer who raised it: this is the signal that pulls ops in to
    // reassign, reschedule or clear the problem the field flagged.
    roles: [...OPS, ...ADMINS],
    channels: BOTH_CHANNELS,
    title: 'Field issue reported',
    body: '${branchName}: ${categoryLabel}. ${note}',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  ASSIGNMENT_AUTO_DECLINED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    roles: OPS,
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Offer expired',
    body: '${branchName} was not answered in time and has been withdrawn automatically.',
    link: '/planning',
  },

  // ── Validation ──────────────────────────────────────────────────────────
  VALIDATION_QUERY_RAISED: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Clarification needed',
    body: 'A question was raised on your report for ${branchName}. Please respond.',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  VALIDATION_QUERY_ANSWERED: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.NORMAL,
    roles: VALIDATION,
    channels: IN_APP,
    title: 'Clarification answered',
    body: '${assayerName} responded on ${branchName}.',
    link: '/data-entry',
    skipActor: true,
  },
  VALIDATION_COMPLETED: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.NORMAL,
    roles: OPS,
    channels: IN_APP,
    title: 'Validation complete',
    body: '${branchName} has passed validation.',
    link: '/data-entry',
    skipActor: true,
  },

  // ── Documents ───────────────────────────────────────────────────────────
  DOCUMENT_UPLOADED: {
    category: NotificationCategory.DOCUMENT,
    priority: NotificationPriority.NORMAL,
    roles: ['DOCUMENT_EXECUTIVE', 'DATA_ENTRY_HEAD'],
    channels: IN_APP,
    title: 'New document received',
    body: '${assayerName} uploaded ${documentName} for ${branchName}.',
    link: '/documents',
    skipActor: true,
  },
  DOCUMENT_REJECTED: {
    category: NotificationCategory.DOCUMENT,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Document needs re-upload',
    body: '${documentName} for ${branchName} was not accepted. Reason: ${reason}',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },

  // ── Planning ────────────────────────────────────────────────────────────
  BRANCH_UNABLE_TO_COVER: {
    category: NotificationCategory.PLANNING,
    priority: NotificationPriority.CRITICAL,
    roles: [...OPS, ...ADMINS],
    channels: BOTH_CHANNELS,
    title: 'Branch cannot be covered',
    body: '${branchName} has no available assayer and needs a decision.',
    link: '/planning',
    skipActor: true,
  },

  // ── Expenses ────────────────────────────────────────────────────────────
  // Reimbursement is money owed to a person for outlay they have already made, so both
  // directions are worth pushing: ops needs to know a claim is waiting, and the assayer
  // needs to know the outcome without having to keep checking the app.
  EXPENSE_CLAIMED: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.NORMAL,
    roles: [...OPS, ...ADMINS, 'FINANCE_MANAGER'],
    channels: IN_APP,
    title: 'Expense claim submitted',
    body: '₹${amount} (${category}) claimed against ${branchName}.',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  EXPENSE_APPROVED: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.NORMAL,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Expense approved',
    body: 'Your ₹${amount} ${category} claim has been approved.',
    link: '/earnings',
    skipActor: true,
  },
  EXPENSE_REJECTED: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Expense not approved',
    body: 'Your ₹${amount} ${category} claim was not approved. Reason: ${reason}',
    link: '/earnings',
    skipActor: true,
  },

  // ── Workforce (HR) ──────────────────────────────────────────────────────
  ASSAYER_DOCUMENT_EXPIRING: {
    category: NotificationCategory.WORKFORCE,
    priority: NotificationPriority.HIGH,
    roles: ['HR_MANAGER'],
    channels: IN_APP,
    title: 'Assayer document expiring',
    body: "${assayerName}'s ${documentName} expires on ${expiryDate}.",
    link: '/hr',
  },
  ASSAYER_ONBOARDED: {
    category: NotificationCategory.WORKFORCE,
    priority: NotificationPriority.LOW,
    roles: ['HR_MANAGER', ...OPS],
    channels: IN_APP,
    title: 'New assayer onboarded',
    body: '${assayerName} is now active and available for assignment.',
    link: '/hr',
    skipActor: true,
  },
};

/** Fills `${key}` placeholders, leaving unknown keys visibly blank rather than printing `undefined`. */
export function renderTemplate(tpl: string, payload: Record<string, any>): string {
  return tpl.replace(/\$\{(\w+)\}/g, (_, k) => {
    const v = payload?.[k];
    return v === undefined || v === null || v === '' ? '—' : String(v);
  });
}
