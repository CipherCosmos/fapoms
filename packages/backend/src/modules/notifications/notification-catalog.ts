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
  /**
   * Work taken away after it was accepted. The mobile app cannot discover this by
   * polling — the assignment simply vanishes from a later fetch — so an assayer who
   * is told nothing keeps it on their schedule and can drive to a branch that no
   * longer expects them. Push, always.
   */
  ASSIGNMENT_CANCELLED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.CRITICAL,
    roles: OPS,
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Assignment cancelled',
    body: 'Your audit at ${branchName} on ${scheduledDate} has been cancelled. Reason: ${reason}',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  /** The assayer wants a different fee — ops has to answer before the branch stalls. */
  ASSIGNMENT_COUNTER_OFFERED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    roles: OPS,
    channels: BOTH_CHANNELS,
    title: 'Counter-offer received',
    body: '${assayerName} proposed ₹${proposedFee} for ${branchName}. Reason: ${reason}',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  /**
   * The SLA clock ran out. This was written to the audit log and nowhere else, so the
   * one event whose entire purpose is to provoke a human response provoked none.
   */
  ASSIGNMENT_SLA_BREACHED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.CRITICAL,
    roles: [...OPS, ...ADMINS],
    channels: BOTH_CHANNELS,
    title: 'SLA breached',
    body: '${branchName} has breached its ${slaType} SLA and needs attention.',
    link: '/assignments?id=${assignmentId}',
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
  // ── Schedule dispatch ─────────────────────────────────────────────────────
  // The whole point of Stage 2 is telling the assayer when to show up — yet until these
  // entries existed, creating or moving a schedule sent the assayer nothing at all.
  SCHEDULE_DISPATCHED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Audit scheduled',
    body: 'Your audit at ${branchName} is confirmed for ${scheduledDate}.',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  SCHEDULE_RESCHEDULED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Audit date changed',
    body: 'Your audit at ${branchName} has moved from ${previousDate} to ${newDate}.',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  /** A cancelled visit is as time-critical as a moved one, and was the only transition that told the assayer nothing. */
  SCHEDULE_CANCELLED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Audit cancelled',
    body: 'Your audit at ${branchName} on ${scheduledDate} is no longer scheduled.',
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
  /**
   * Validation sent the work back. The rework lands in the data-entry operator's queue,
   * so the operator who submitted it — `RECORD_OWNER` — is the one who must hear, not
   * just the desk at large.
   */
  VALIDATION_CORRECTION_REQUIRED: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.HIGH,
    roles: ['DATA_ENTRY_HEAD'],
    special: ['RECORD_OWNER'],
    channels: IN_APP,
    title: 'Correction required',
    body: '${branchName} was sent back for correction. Reason: ${reason}',
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

  // ── Desk SLA escalations ────────────────────────────────────────────────
  // The data-entry mirror of the assignment flow's SLA alerts: every stage of
  // packet → entry → review → submit that stalls past its threshold chases the
  // head (and, where one exists, the responsible member) once a day until it
  // moves. Emitted by DeskEscalationService from the 15-minute SLA scan.
  DESK_PACKET_UNASSIGNED_SLA: {
    category: NotificationCategory.DOCUMENT,
    priority: NotificationPriority.HIGH,
    roles: ['DATA_ENTRY_HEAD', 'VALIDATION_MANAGER'],
    channels: IN_APP,
    title: 'Packet waiting for assignment',
    body: '${branchName} has been at the desk ${hours}h with nobody assigned.',
    link: '/data-entry/packets?lane=unassigned',
    skipActor: true,
  },
  DESK_ENTRY_OVERDUE: {
    category: NotificationCategory.DOCUMENT,
    priority: NotificationPriority.NORMAL,
    roles: ['DATA_ENTRY_HEAD', 'VALIDATION_MANAGER'],
    special: ['RECORD_OWNER'],
    channels: IN_APP,
    title: 'Data entry running late',
    body: '${branchName} has been with ${who} for ${hours}h without a hand-back.',
    link: '/data-entry/packets',
    skipActor: true,
  },
  DESK_REWORK_STALE: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.HIGH,
    roles: ['DATA_ENTRY_HEAD', 'VALIDATION_MANAGER'],
    special: ['RECORD_OWNER'],
    channels: IN_APP,
    title: 'Rework not picked up',
    body: '${branchName} was sent back ${hours}h ago and has not been fixed.',
    link: '/data-entry/packets?lane=rework',
    skipActor: true,
  },
  DESK_REVIEW_OVERDUE: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.NORMAL,
    roles: ['DATA_ENTRY_HEAD', 'VALIDATION_MANAGER'],
    channels: IN_APP,
    title: 'Review pending too long',
    body: '${branchName} has been awaiting a review decision for ${hours}h.',
    link: '/data-entry/reviews?status=HUMAN_REVIEW',
    skipActor: true,
  },
  DESK_SUBMIT_OVERDUE: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.HIGH,
    roles: ['DATA_ENTRY_HEAD', 'VALIDATION_MANAGER'],
    channels: IN_APP,
    title: 'Approved report not sent to client',
    body: '${branchName} was approved ${hours}h ago and still has not been submitted.',
    link: '/data-entry/reviews?status=APPROVED',
    skipActor: true,
  },
  DESK_OCR_STUCK: {
    category: NotificationCategory.DOCUMENT,
    priority: NotificationPriority.NORMAL,
    roles: ['DATA_ENTRY_HEAD', 'VALIDATION_MANAGER'],
    channels: IN_APP,
    title: 'Packet stuck at external OCR',
    body: '${branchName} went to the OCR application ${hours}h ago and has not come back.',
    link: '/data-entry/packets',
    skipActor: true,
  },
  DESK_CLARIFICATION_OVERDUE: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.NORMAL,
    roles: ['DATA_ENTRY_HEAD', 'VALIDATION_MANAGER'],
    channels: IN_APP,
    title: 'Clarification unresolved',
    body: 'A clarification on ${branchName} is ${hours}h old with no resolution — the report cannot ship until it closes.',
    link: '/data-entry/clarifications',
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

  // ── Data entry hand-offs ────────────────────────────────────────────────
  // Work moving between desks. Each hand-off previously relied on the receiving
  // person noticing a new row in a queue they had to remember to look at — one
  // failure branch literally asked the operator to go tell their supervisor by hand.
  DATA_ENTRY_ASSIGNED: {
    category: NotificationCategory.DOCUMENT,
    priority: NotificationPriority.NORMAL,
    roles: [],
    special: ['RECORD_OWNER'],
    channels: IN_APP,
    title: 'Data entry assigned to you',
    body: '${documentName} for ${branchName} is ready for data entry.',
    link: '/data-entry',
    skipActor: true,
  },
  DATA_ENTRY_COMPLETED: {
    category: NotificationCategory.DOCUMENT,
    priority: NotificationPriority.NORMAL,
    roles: ['DATA_ENTRY_HEAD'],
    channels: IN_APP,
    title: 'Data entry ready for review',
    body: '${userName} finished data entry on ${branchName}.',
    link: '/data-entry',
    skipActor: true,
  },

  // ── Field operations ────────────────────────────────────────────────────
  // A second incident path parallel to ASSIGNMENT_ISSUE_REPORTED. Only one of the
  // two notified, so whether ops heard about a field problem depended on which
  // screen raised it.
  FIELD_INCIDENT_REPORTED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.CRITICAL,
    roles: [...OPS, ...ADMINS],
    channels: BOTH_CHANNELS,
    title: 'Field incident reported',
    body: '${severity} incident at ${branchName}: ${description}',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  FIELD_INCIDENT_RESOLVED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.NORMAL,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: IN_APP,
    title: 'Incident resolved',
    body: 'The incident you reported at ${branchName} has been resolved. ${resolution}',
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

  /**
   * Money moving toward the assayer. The system notified them about a ₹200 expense
   * decision but said nothing when their actual fee was approved or paid — the two
   * events they most want to hear and cannot poll for.
   */
  PAYABLE_APPROVED: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.NORMAL,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Payment approved',
    body: 'Your ₹${amount} payment for ${branchName} has been approved.',
    link: '/earnings',
    skipActor: true,
  },
  PAYABLE_PAID: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Payment sent',
    body: '₹${amount} for ${branchName} has been paid. Reference: ${paymentReference}',
    link: '/earnings',
    skipActor: true,
  },
  /** A CRITICAL conflict freezes billing — nobody was told the money had stopped. */
  BILLING_CONFLICT_RAISED: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.HIGH,
    roles: ['FINANCE_MANAGER', ...OPS, ...ADMINS],
    channels: BOTH_CHANNELS,
    title: 'Billing conflict raised',
    body: '${severity} conflict on ${branchName}: ${description}',
    link: '/billing',
    skipActor: true,
  },

  // ── Calls ───────────────────────────────────────────────────────────────
  /** An unanswered clarification call left no trace anywhere the callee would look. */
  CALL_MISSED: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['RECORD_OWNER', 'ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Missed call',
    body: '${callerName} tried to call you about a clarification.',
    link: '/data-entry',
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

/**
 * Fills `${key}` placeholders. A missing value becomes `—`, and then a cleanup pass
 * removes the sentence fragments that dash would sit inside — "Reason: —." or
 * "…for —." read as broken on a phone's lock screen, which is exactly where these
 * land. The result is a shorter sentence, not a visibly holed one.
 */
export function renderTemplate(tpl: string, payload: Record<string, any>): string {
  const filled = tpl.replace(/\$\{(\w+)\}/g, (_, k) => {
    const v = payload?.[k];
    return v === undefined || v === null || v === '' ? '—' : String(v);
  });
  return filled
    // "Reason: —." / "Reason: —" — drop the whole clause when there is no reason.
    .replace(/\s*Reason:\s*—\.?/g, '')
    // "(—)" from parenthesised values like "(${category})".
    .replace(/\s*\(\s*—\s*\)/g, '')
    // "₹— " from money placeholders.
    .replace(/₹—\s*/g, '')
    // Prepositional phrases pointing at nothing: "for —", "at —", "on —", "against —"…
    .replace(/\s(?:for|at|on|from|to|against|of)\s+—(?=[\s.,;]|$)/g, '')
    // Whatever dashes survive at a sentence edge.
    .replace(/(^|\.\s+)—\s*/g, '$1')
    // Tidy the seams the removals leave behind.
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .trim();
}
