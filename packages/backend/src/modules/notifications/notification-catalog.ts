import { NotificationCategory, NotificationChannel, NotificationPriority } from '@fapoms/shared';
import { FEEDBACK_TEAM_ROLE_NAMES } from '../feedback/feedback-roles';

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

  /**
   * Merge a burst of this type to the same recipient into one notification.
   *
   * Declared per type because only some events arrive in bursts, and only some read sensibly
   * when summarised. The ones that do share a shape: a single operator action, or a single
   * scheduled sweep, produces N of them at once. Activating 25 assayers through the bulk
   * lifecycle endpoint put 25 identical "New assayer onboarded" lines in every operations user's
   * bell; offering one assayer 40 branches from the planning queue sent them 40 pushes in a row.
   * Neither the second line nor the fortieth push carried information the first did not.
   *
   * `dedupeKey` does not solve this — it collapses *the same event re-fired*, which is a
   * different thing from *different events of the same kind arriving together*.
   *
   * Set only where a summary is genuinely as useful as the individual lines. A per-record
   * decision an operator must act on separately (a rejected assignment, a raised query) is not a
   * candidate no matter how many arrive.
   */
  collapse?: {
    /**
     * How long after the first of a burst later ones still merge into it. Long enough to cover
     * one operator action or one sweep; short enough that two unrelated events an hour apart
     * stay two notifications.
     */
    windowSeconds: number;
    /** Summary title. `${count}` is the number of merged events, including the first. */
    title: string;
    /** Summary body. `${count}` available; other placeholders come from the FIRST event. */
    body: string;
    /**
     * Where the merged row points. Defaults to the type's own `link`, which is usually wrong
     * for a summary — it names one record out of several — so give a list route.
     */
    link?: string;
  };
}

/**
 * These were pairs — OPS was manager plus executive, ADMINS was super plus administrator,
 * VALIDATION was validation manager plus validator — and no notification in this catalogue
 * ever addressed one half without the other. That the catalogue had already stopped
 * distinguishing them is part of why the roles were merged.
 */
const OPS = ['OPERATIONS'];
const ADMINS = ['ADMIN'];
const VALIDATION = ['DESK', 'DESK_OPERATOR'];
const BOTH_CHANNELS = [NotificationChannel.IN_APP, NotificationChannel.PUSH];
const IN_APP = [NotificationChannel.IN_APP];
/**
 * Channel sets that also email.
 *
 * Email is reserved for events that force a decision or mean money/work has silently stopped
 * — the ones whose "entire purpose is to provoke a human response" and which today land in a
 * bell nobody has open at 2am (push is dead in production behind a placeholder
 * google-services.json). Over-notification was a measured production bug twice; routine
 * flow-following events must never grow an EMAIL channel. Email reaches internal users only —
 * assayer recipients on these types are unaffected.
 */
const ALL_CHANNELS = [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL];
const IN_APP_AND_EMAIL = [NotificationChannel.IN_APP, NotificationChannel.EMAIL];

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
    /**
     * Bulk assign offers one assayer every ticked branch — as many as forty — as that many
     * separate POSTs. Each was its own push, so the assayer's phone buzzed forty times for one
     * operator action, and the fortieth told them nothing the first had not. The summary sends
     * them to the list, where they can work through the offers properly.
     *
     * Short window: these are individual offers a person must act on, so two genuinely separate
     * offers half an hour apart must stay two notifications.
     */
    collapse: {
      windowSeconds: 180,
      title: '${count} new assignments offered',
      body: 'You have ${count} new assignments waiting. Open them to accept or decline.',
      link: '/assignments',
    },
  },
  /**
   * Raised by the phone channel, where the desk confirms the assignment on the assayer's behalf
   * at the moment it is created (see CreateAssignmentDto.acceptOnBehalf).
   *
   * It replaces the ASSIGNMENT_OFFERED + ASSIGNMENT_ACCEPTED pair rather than joining them,
   * because on this path both would be untrue: the offer would ask the assayer to "accept or
   * decline" work already committed, and the acceptance would tell the rest of ops that the
   * assayer accepted it in the app when a colleague did it by phone.
   *
   * Deliberately reaches the assayer AND ops from one definition: the assayer needs it on push
   * (this is the only signal the job exists — nothing will appear in their offers list to
   * accept), and ops needs the desk's commitment on the record where an in-app acceptance
   * would have been.
   */
  ASSIGNMENT_DESK_CONFIRMED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    roles: OPS,
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Assignment confirmed',
    body: '${branchName} on ${scheduledDate} is confirmed for ${assayerName} at ₹${agreedFee}, agreed by phone. No acceptance needed.',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
    // Reached by the same bulk-assign path as ASSIGNMENT_OFFERED, so it bursts the same way.
    collapse: {
      windowSeconds: 180,
      title: '${count} assignments confirmed',
      body: '${count} assignments are confirmed for ${assayerName}, agreed by phone. No acceptance needed.',
      link: '/assignments',
    },
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
    // Also to ADMINS: this is the auto-decline-on-negotiation-limit path too (see
    // AssignmentService.proposeCounterFee), and an OPS-only audience resolved to zero
    // recipients on a deployment with no active OPERATIONS_MANAGER/EXECUTIVE — a stalled
    // branch nobody was told about. SLA_BREACHED and ESCALATED already carry this fallback.
    roles: [...OPS, ...ADMINS],
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
    channels: ALL_CHANNELS,
    title: 'Assignment cancelled',
    body: 'Your audit at ${branchName} on ${scheduledDate} has been cancelled. Reason: ${reason}',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  /**
   * The assayer wants a different fee — ops has to answer before the branch stalls.
   *
   * Also to ADMINS, same reasoning as ASSIGNMENT_REJECTED just above: an OPS-only audience
   * resolves to zero recipients wherever no OPERATIONS_MANAGER/EXECUTIVE is active, which
   * silently drops the one notification a negotiation actually depends on.
   */
  ASSIGNMENT_COUNTER_OFFERED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    roles: [...OPS, ...ADMINS],
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
    channels: ALL_CHANNELS,
    title: 'SLA breached',
    body: '${branchName} has breached its ${slaType} SLA and needs attention.',
    link: '/assignments?id=${assignmentId}',
    skipActor: true,
  },
  ASSIGNMENT_ESCALATED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.CRITICAL,
    roles: [...OPS, ...ADMINS],
    channels: ALL_CHANNELS,
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
    channels: ALL_CHANNELS,
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
  /**
   * The desk closed the clarification. The assayer is told because from their side the thread
   * simply goes quiet — and worse, `QueryThreadService` refuses further messages on a resolved
   * query with a 403, so someone still typing an answer hits a wall with no explanation. Raising
   * and answering both notified; closing did not.
   */
  VALIDATION_QUERY_RESOLVED: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.NORMAL,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Clarification closed',
    body: 'The desk has closed the question on ${branchName}. No reply is needed.',
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
    roles: ['DESK'],
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
    // `/assignments`, not `/data-entry`. Operations is notified because a branch has cleared the
    // pipeline and its assignment can close — but `/data-entry` is the validation desk's screen
    // and operations cannot open it, so every one of these bounced them to `/dashboard` with no
    // explanation. Stage 3 is where they act on this.
    link: '/assignments',
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
    roles: ['DESK', 'DESK'],
    channels: IN_APP,
    title: 'Packet waiting for assignment',
    body: '${branchName} has been at the desk ${hours}h with nobody assigned.',
    link: '/data-entry/packets?lane=unassigned',
    skipActor: true,
  },
  DESK_ENTRY_OVERDUE: {
    category: NotificationCategory.DOCUMENT,
    priority: NotificationPriority.NORMAL,
    roles: ['DESK', 'DESK'],
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
    roles: ['DESK', 'DESK'],
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
    roles: ['DESK', 'DESK'],
    channels: IN_APP,
    title: 'Review pending too long',
    body: '${branchName} has been awaiting a review decision for ${hours}h.',
    link: '/data-entry/reviews?status=HUMAN_REVIEW',
    skipActor: true,
  },
  DESK_SUBMIT_OVERDUE: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.HIGH,
    roles: ['DESK', 'DESK'],
    channels: IN_APP_AND_EMAIL,
    title: 'Approved report not sent to client',
    body: '${branchName} was approved ${hours}h ago and still has not been submitted.',
    link: '/data-entry/reviews?status=APPROVED',
    skipActor: true,
  },
  DESK_OCR_STUCK: {
    category: NotificationCategory.DOCUMENT,
    priority: NotificationPriority.NORMAL,
    roles: ['DESK', 'DESK'],
    channels: IN_APP,
    title: 'Packet stuck at external OCR',
    body: '${branchName} went to the OCR application ${hours}h ago and has not come back.',
    link: '/data-entry/packets',
    skipActor: true,
  },
  DESK_CLARIFICATION_OVERDUE: {
    category: NotificationCategory.VALIDATION,
    priority: NotificationPriority.NORMAL,
    roles: ['DESK', 'DESK'],
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
    roles: ['DESK', 'DESK'],
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
    roles: ['DESK'],
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
    channels: ALL_CHANNELS,
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
    channels: ALL_CHANNELS,
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
    roles: [...OPS, ...ADMINS, 'OPERATIONS'],
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

  /**
   * A payout that nobody has approved.
   *
   * Booking a payable was automatic; every step after it was a person clicking, and nothing ever
   * said the person had not clicked. A payable could sit in PENDING ("Due") indefinitely — the
   * assayer had done the work, the money was calculated and waiting, and the only surface was a
   * figure on a finance page somebody had to think to open. The assayer's own screen showed it as
   * owed, so the silence looked like a decision.
   *
   * Raised once per payable per day by the SLA scanner, not per tick, or a 15-minute job would
   * turn a slow week into 672 notifications.
   */
  PAYABLE_AWAITING_APPROVAL: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.NORMAL,
    roles: [...OPS, ...ADMINS],
    channels: BOTH_CHANNELS,
    title: 'Payouts waiting for approval',
    body: '${count} payout(s) worth ₹${amount} have been waiting ${days}+ day(s) for approval.',
    link: '/billing?tab=payouts',
  },

  /**
   * Work that was attended but never closed, so no payout was ever booked.
   *
   * Completion is the only thing that creates a payable, and nothing completes an assignment on
   * its own — it needs ops to click Complete, a return PDF to land, or a schedule to be marked
   * done. An audit genuinely performed whose paperwork nobody filed is therefore invisible to
   * billing forever: the assayer is simply never paid, and no alarm exists. This is that alarm.
   */
  ASSIGNMENT_ATTENDED_NOT_CLOSED: {
    category: NotificationCategory.ASSIGNMENT,
    priority: NotificationPriority.HIGH,
    roles: [...OPS, ...ADMINS],
    channels: BOTH_CHANNELS,
    title: 'Attended audits not closed',
    body: '${count} audit(s) were attended but never completed, so nothing has been booked for payment. Oldest: ${oldest}.',
    link: '/assignments',
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
    roles: ['OPERATIONS'],
    channels: IN_APP,
    title: 'Assayer document expiring',
    body: "${assayerName}'s ${documentName} expires on ${expiryDate}.",
    link: '/hr',
  },
  /**
   * The certification half of the expiry sweep.
   *
   * Deliberately its own type rather than more rows through ASSAYER_DOCUMENT_EXPIRING. A
   * government document is renewed by the assayer at a government office; a professional
   * certification is renewed through a certifying body, often with a re-examination, and it is
   * the only one of the two that blocks work: `assayer.service.ts` refuses to assign an assayer
   * whose certification has lapsed. Nothing warned about it before — the sweep read only
   * `assayer_government_documents` — so the first anyone heard was an assignment being refused
   * on the day it was needed. The body says so in as many words, because the recipient is an HR
   * coordinator who should not have to know that "expired certification" and "cannot be
   * assigned" are the same fact.
   *
   * HIGH like its document sibling, in-app to the same HR audience, linking to the same `/hr`
   * page whose "Certifications falling due" panel already lists these.
   */
  ASSAYER_CERTIFICATION_EXPIRING: {
    category: NotificationCategory.WORKFORCE,
    priority: NotificationPriority.HIGH,
    roles: ['OPERATIONS'],
    channels: IN_APP,
    title: 'Assayer certification expiring',
    body: "${assayerName}'s ${certificationName} certification expires on ${expiryDate}. Once it lapses they cannot be assigned to work that requires it, so please start the renewal.",
    link: '/hr',
  },
  ASSAYER_ONBOARDED: {
    category: NotificationCategory.WORKFORCE,
    priority: NotificationPriority.LOW,
    // HR and admins only. Operations was included and cannot open `/hr` — and new capacity
    // reaches them where they use it, in the planning screen's candidate list, rather than as a
    // bell item linking to a roster they are not permitted to see.
    roles: ['OPERATIONS', ...ADMINS],
    channels: IN_APP,
    title: 'New assayer onboarded',
    body: '${assayerName} is now active and available for assignment.',
    link: '/hr',
    skipActor: true,
    // The measured case: one bulk lifecycle transition activating 25 assayers wrote 25 of these
    // into every operations user's bell, 50 rows in a single minute. Who exactly was activated
    // is a roster question, and the roster is one click away.
    collapse: {
      windowSeconds: 900,
      title: '${count} new assayers onboarded',
      body: '${count} assayers are now active and available for assignment.',
      link: '/hr',
    },
  },

  // ── Feedback & collaboration channel ────────────────────────────────────────
  // The two-way channel between every user and the team that owns feedback. The team
  // (FEEDBACK_TEAM_ROLES — super administrators only, see feedback-roles.ts) hears about
  // new items and reporter replies; the reporter hears about team replies and status changes. RECORD_OWNER carries a
  // user reporter/assignee, ASSIGNED_ASSAYER carries a field-assayer reporter —
  // only the id that was set on the emit resolves.
  FEEDBACK_SUBMITTED: {
    category: NotificationCategory.FEEDBACK,
    priority: NotificationPriority.NORMAL,
    roles: [...FEEDBACK_TEAM_ROLE_NAMES],
    channels: IN_APP,
    title: 'New feedback',
    body: '${reporterName} reported a ${category}: "${title}".',
    link: '/feedback?id=${threadId}',
    skipActor: true,
  },
  FEEDBACK_TEAM_REPLY: {
    category: NotificationCategory.FEEDBACK,
    priority: NotificationPriority.NORMAL,
    roles: [],
    special: ['RECORD_OWNER', 'ASSIGNED_ASSAYER'],
    channels: IN_APP,
    title: 'Reply on your feedback',
    body: 'The product team replied on "${title}".',
    link: '/feedback?id=${threadId}',
    skipActor: true,
  },
  FEEDBACK_REPORTER_REPLY: {
    category: NotificationCategory.FEEDBACK,
    priority: NotificationPriority.NORMAL,
    roles: [...FEEDBACK_TEAM_ROLE_NAMES],
    special: ['RECORD_OWNER'],
    channels: IN_APP,
    title: 'New reply on feedback',
    body: '${reporterName} replied on "${title}".',
    link: '/feedback?id=${threadId}',
    skipActor: true,
  },
  FEEDBACK_STATUS_CHANGED: {
    category: NotificationCategory.FEEDBACK,
    priority: NotificationPriority.NORMAL,
    roles: [],
    special: ['RECORD_OWNER', 'ASSIGNED_ASSAYER'],
    channels: IN_APP,
    title: 'Feedback updated',
    body: 'Your feedback "${title}" is now ${status}.',
    link: '/feedback?id=${threadId}',
    skipActor: true,
  },
  FEEDBACK_ASSIGNED: {
    category: NotificationCategory.FEEDBACK,
    priority: NotificationPriority.NORMAL,
    roles: [],
    special: ['RECORD_OWNER'],
    channels: IN_APP,
    title: 'Feedback assigned to you',
    body: 'You now own "${title}" (${category}).',
    link: '/feedback?id=${threadId}',
    skipActor: true,
  },
  // Response-time SLA breaches, raised by the 15-minute scanner (FeedbackEscalationService).
  // One per breached item per day; the team must unstick these.
  FEEDBACK_SLA_FIRST_RESPONSE_BREACH: {
    category: NotificationCategory.FEEDBACK,
    priority: NotificationPriority.HIGH,
    roles: [...FEEDBACK_TEAM_ROLE_NAMES],
    channels: IN_APP_AND_EMAIL,
    title: 'Feedback awaiting first response',
    body: '"${title}" has waited ${hours}h with no reply from the team.',
    link: '/feedback?id=${threadId}',
  },
  FEEDBACK_SLA_RESOLUTION_BREACH: {
    category: NotificationCategory.FEEDBACK,
    priority: NotificationPriority.HIGH,
    roles: [...FEEDBACK_TEAM_ROLE_NAMES],
    special: ['RECORD_OWNER'],
    channels: IN_APP_AND_EMAIL,
    title: 'Feedback past its resolution SLA',
    body: '${severity} item "${title}" has been open ${hours}h, past its resolution target.',
    link: '/feedback?id=${threadId}',
  },

  // ── Security ──────────────────────────────────────────────────────────────
  /**
   * Lockouts used to be silent: five failed attempts flipped the account and nobody — not the
   * admins, not the owner — was told until the user phoned in. A burst of these is also the
   * cheapest intrusion signal this platform has (assayer brute-forcing was a real, exploited
   * gap when 24 of 25 accounts shared a default password), which is why it emails: the people
   * who can respond are precisely the ones not watching a dashboard when it happens.
   */
  ACCOUNT_LOCKED: {
    category: NotificationCategory.SYSTEM,
    priority: NotificationPriority.CRITICAL,
    roles: ADMINS,
    channels: IN_APP_AND_EMAIL,
    title: 'Account locked after failed sign-ins',
    body: '${accountLabel} was locked for 15 minutes after ${attempts} failed sign-in attempts. Repeated lockouts may indicate someone probing credentials.',
    link: '/users',
    // The lock event itself is the news; the actor is the attacker, not a colleague.
    skipActor: false,
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
