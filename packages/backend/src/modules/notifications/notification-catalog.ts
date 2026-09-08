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
  /**
   * A permission that also earns this notification, for a role built in Admin -> Roles that
   * `roles` above has never heard of by name — mirrors `RolesGuard`'s `@RolesFallbackPermissions`
   * (see `usersHoldingPermission` in `permission-audience.ts`). Additive: it never narrows who
   * `roles` already reaches, only widens past a name a custom role will never match.
   *
   * Set to whatever permission gates the frontend page this type's own `link` points at
   * (`route-permissions.ts`'s `requiredPermissions` for that path) — never invented. That
   * match is deliberately the reachability question, not the narrower action one: a custom
   * role that can already open the screen a notification points to should hear about the
   * event, whether or not it also holds the stricter permission needed to act on it (the same
   * relationship the shipped `/hr` fix established — `ASSAYER:VIEW:ORGANIZATION`, not a
   * hypothetical `ASSAYER:EDIT:ORGANIZATION`, earns the workforce types below).
   *
   * Left unset — not an oversight — wherever this reasoning doesn't produce an unambiguous
   * answer:
   *  - `roles: []` with only `special` (`ASSIGNED_ASSAYER`/`RECORD_OWNER`): there is no role
   *    audience to widen in the first place.
   *  - The linked page's own `route-permissions.ts` entry declares NO `requiredPermissions`
   *    at all (e.g. `/assignments`, `/documents`, `/feedback`) — `canAccessRoute`'s permission
   *    fallback treats an empty required-list as fail-closed (see that function's own comment),
   *    so literally no custom role could ever open the page regardless of what is written here;
   *    adding a permission would notify someone about a screen they still cannot reach.
   *  - The audience is ADMIN-only by an explicit product decision unrelated to any resource
   *    permission (`ACCOUNT_LOCKED` is the one exception — see its own comment — everything
   *    under `FEEDBACK_TEAM_ROLE_NAMES` is the rule: "super administrators only... and nobody
   *    else", feedback-roles.ts).
   *  - The event's own audience is genuinely ambiguous between two plausible screens (e.g.
   *    `ASSIGNMENT_ATTENDED_NOT_CLOSED` is computed by `BillingEngineService` but its `link`
   *    and its actual fix — completing the assignment — live on `/assignments`, which has no
   *    permission either way).
   * A wrong guess here would either leak an event to the wrong desk or silently claim a fix
   * that misses its real audience — same discipline as the rest of this file.
   */
  fallbackPermissions?: string[];
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
/** Whoever can read the compliance register — ComplianceController's own @Roles on every GET. */
const COMPLIANCE = ['ADMIN', 'AUDITOR'];
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
    // No ₹ in the body: the assayer sees no money in the app until the invoicing step, and a
    // push on a lock screen is the least private surface of all. The desk's agreed figure is
    // still on the ops record; this sentence only has to say the commitment exists.
    body: '${branchName} on ${scheduledDate} is confirmed for ${assayerName}, agreed by phone. No acceptance needed.',
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
    // Same permission /planning's own route requires (planning.controller.ts) — a custom
    // role that can already open the planning queue a decline needs a replacement from.
    fallbackPermissions: ['PLANNING:VIEW:ORGANIZATION'],
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
  // ASSIGNMENT_COUNTER_OFFERED lived here until in-app fee negotiation was removed: the
  // assayer no longer sees or proposes fees, so there is no counter-offer left to announce.
  // Fee questions are settled by phone; the desk records the outcome via acceptOnBehalf.
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
    fallbackPermissions: ['PLANNING:VIEW:ORGANIZATION'],
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
    // Same permission /data-entry's own route requires (validation.controller.ts) — a
    // custom role built to run the data desk holds this without holding DESK by name.
    fallbackPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
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
    fallbackPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
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
    // Same VALIDATION:VIEW:ORGANIZATION as VALIDATION_QUERY_ANSWERED above — every entry in
    // this SLA-escalation block links into /data-entry, the same permission gates all of them.
    fallbackPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
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
    fallbackPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
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
    fallbackPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
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
    fallbackPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
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
    fallbackPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
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
    fallbackPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
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
    fallbackPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
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
    fallbackPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
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
    fallbackPermissions: ['PLANNING:VIEW:ORGANIZATION'],
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
    // Same permission the expense-review screen requires (GET expenses/pending,
    // expense.controller.ts) — that route's own comment says it plainly: "there is no EXPENSE
    // resource... reads take billing:view". A custom role built to run that review queue
    // holds this without holding OPERATIONS/ADMIN by name.
    fallbackPermissions: ['BILLING:VIEW:ORGANIZATION'],
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
  // Both payable bodies below carry NO ₹: the assayer's app is money-blind until the invoicing
  // step, and a lock-screen push is the least private surface there is. The amounts are one tap
  // away inside the app's (gated) earnings view, where they belong.
  PAYABLE_APPROVED: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.NORMAL,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Payment approved',
    body: 'Your payment for ${branchName} has been approved.',
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
    body: 'Your payment for ${branchName} has been sent. Reference: ${paymentReference}',
    link: '/earnings',
    skipActor: true,
  },

  // ── Assayer invoicing ───────────────────────────────────────────────────
  //
  // The one place an assayer is ever shown money is the in-app invoice review, so none of
  // these three bodies may name an amount. The INVITED push is the doorbell — the reveal
  // happens after they open the app, behind their own sign-in, not on a lock screen.
  ASSAYER_INVOICE_INVITED: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Ready to invoice',
    body: 'You have ${count} completed audits ready to invoice. Review and submit in the app.',
    link: '/earnings',
    skipActor: true,
  },
  ASSAYER_INVOICE_SUBMITTED: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.NORMAL,
    // Ops bodies may carry ₹ (staff screens show money everywhere); ADMINS fallback for the
    // same zero-recipient reason ASSIGNMENT_REJECTED documents.
    roles: [...OPS, ...ADMINS],
    channels: IN_APP,
    title: 'Assayer invoice submitted',
    body: '${assayerName} submitted invoice ${invoiceNumber}: ${count} lines, ₹${total}. Review and approve.',
    link: '/billing?tab=assayer-invoices',
    skipActor: true,
  },
  ASSAYER_INVOICE_APPROVED: {
    category: NotificationCategory.BILLING,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Invoice approved',
    body: 'Your invoice ${invoiceNumber} (${count} audits) has been approved. Your earnings are updated in the app.',
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
    // Same BILLING:VIEW:ORGANIZATION as EXPENSE_CLAIMED above — this links straight into
    // /billing?tab=payouts, which asks for the same permission (billing-engine.controller.ts).
    fallbackPermissions: ['BILLING:VIEW:ORGANIZATION'],
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
    // Same permission /hr's own route requires (hr.controller.ts) — a custom role built to run
    // the HR desk holds this without holding OPERATIONS by name.
    fallbackPermissions: ['ASSAYER:VIEW:ORGANIZATION'],
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
    fallbackPermissions: ['ASSAYER:VIEW:ORGANIZATION'],
    channels: IN_APP,
    title: 'Assayer certification expiring',
    body: "${assayerName}'s ${certificationName} certification expires on ${expiryDate}. Once it lapses they cannot be assigned to work that requires it, so please start the renewal.",
    link: '/hr',
  },
  /**
   * The office could not accept a document, and the person who sent it needs to know.
   *
   * Named for the identity document rather than just DOCUMENT_REJECTED, which already exists on
   * this catalogue for the audit-packet pipeline and is a different resource entirely.
   *
   * Addressed to nobody in the office: `roles: []`. Every other workforce notification goes to the
   * desk, and this one goes the other way — it is the only thing in the system that asks an
   * appraiser to do something about their own paperwork. There is no `link`, because the web route
   * table governs staff routes and the app routes off the type.
   *
   * Worth saying plainly: push is dead in production behind a placeholder `google-services.json`,
   * so the in-app bell and the checklist row are the channel that actually works today. That is
   * why the checklist row carries the whole message on its own rather than relying on this.
   */
  ASSAYER_IDENTITY_DOCUMENT_REJECTED: {
    category: NotificationCategory.WORKFORCE,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['ASSIGNED_ASSAYER'],
    channels: BOTH_CHANNELS,
    title: 'Please send ${documentName} again',
    body: '${guidance}',
    skipActor: true,
  },
  ASSAYER_ONBOARDED: {
    category: NotificationCategory.WORKFORCE,
    priority: NotificationPriority.LOW,
    // HR and admins only. Operations was included and cannot open `/hr` — and new capacity
    // reaches them where they use it, in the planning screen's candidate list, rather than as a
    // bell item linking to a roster they are not permitted to see.
    roles: ['OPERATIONS', ...ADMINS],
    fallbackPermissions: ['ASSAYER:VIEW:ORGANIZATION'],
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
  //
  // User-facing name is "Support" / "Help & Support" — the `title` copy below says so. The
  // event keys, the NotificationCategory.FEEDBACK value and the /feedback link all keep the
  // historical name on purpose (see feedback.service.ts for the full note); only the strings a
  // person reads have changed.
  FEEDBACK_SUBMITTED: {
    category: NotificationCategory.FEEDBACK,
    priority: NotificationPriority.NORMAL,
    roles: [...FEEDBACK_TEAM_ROLE_NAMES],
    channels: IN_APP,
    title: 'New support request',
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
    title: 'Reply on your support request',
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
    title: 'New reply on a support request',
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
    title: 'Support request updated',
    body: 'Your support request "${title}" is now ${status}.',
    link: '/feedback?id=${threadId}',
    skipActor: true,
  },
  FEEDBACK_ASSIGNED: {
    category: NotificationCategory.FEEDBACK,
    priority: NotificationPriority.NORMAL,
    roles: [],
    special: ['RECORD_OWNER'],
    channels: IN_APP,
    title: 'Support request assigned to you',
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
    title: 'Support request awaiting first response',
    body: '"${title}" has waited ${hours}h with no reply from the team.',
    link: '/feedback?id=${threadId}',
  },
  FEEDBACK_SLA_RESOLUTION_BREACH: {
    category: NotificationCategory.FEEDBACK,
    priority: NotificationPriority.HIGH,
    roles: [...FEEDBACK_TEAM_ROLE_NAMES],
    special: ['RECORD_OWNER'],
    channels: IN_APP_AND_EMAIL,
    title: 'Support request past its resolution SLA',
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
    // Same permission /users' own route requires (user.controller.ts findAll) — a custom
    // role that can already see the account list should be told why one just got locked,
    // even without holding ADMIN itself. Unlocking still needs USER:EDIT:ORGANIZATION
    // (unlockAccount) — this only widens who hears, never who can act.
    fallbackPermissions: ['USER:VIEW:ORGANIZATION'],
    channels: IN_APP_AND_EMAIL,
    title: 'Account locked after failed sign-ins',
    body: '${accountLabel} was locked for 15 minutes after ${attempts} failed sign-in attempts. Repeated lockouts may indicate someone probing credentials.',
    link: '/users',
    // The lock event itself is the news; the actor is the attacker, not a colleague.
    skipActor: false,
  },

  // ── Compliance (security incidents & DPDP rights requests) ────────────────
  // SecurityIncidentService and DataRightsRequestService used to notify nobody: raising a
  // CRITICAL data breach or logging a rights request left only an audit-log row and whatever a
  // person happened to see by opening /admin/compliance on their own initiative. The register's
  // own doc-comment (security-incident.entity.ts) says the point is to make the CERT-In 6-hour
  // and DPDP 72-hour clocks "impossible to miss... answerable at a glance rather than
  // reconstructed from memory during an actual incident" — a register nobody is told to look at
  // does not deliver that. Every type below reaches ADMIN (who act on this register) and AUDITOR
  // (who can already read it — see ComplianceController's own @Roles).
  SECURITY_INCIDENT_RAISED: {
    category: NotificationCategory.SYSTEM,
    priority: NotificationPriority.CRITICAL,
    roles: COMPLIANCE,
    channels: ALL_CHANNELS,
    title: 'Security incident raised',
    body: '${severity} ${category} incident raised: "${title}". The CERT-In 6-hour reporting clock is running.',
    link: '/admin/compliance',
    skipActor: true,
  },
  /**
   * A statutory clock — CERT-In's 6 hours, or DPDP's 72-hour Board report — ran out with the
   * milestone still unset. Raised by the same 15-minute scanner that already chases every other
   * SLA in this system (ComplianceEscalationService.scan()); one reminder per clock per incident
   * per day, the same shape as ASSIGNMENT_SLA_BREACHED and the FEEDBACK_SLA_* pair.
   */
  SECURITY_INCIDENT_CLOCK_BREACHED: {
    category: NotificationCategory.SYSTEM,
    priority: NotificationPriority.CRITICAL,
    roles: COMPLIANCE,
    channels: ALL_CHANNELS,
    title: 'Statutory reporting deadline missed',
    body: '"${title}" has missed its ${clockName} deadline and still has not been reported.',
    link: '/admin/compliance',
  },
  DATA_RIGHTS_REQUEST_RECEIVED: {
    category: NotificationCategory.SYSTEM,
    priority: NotificationPriority.NORMAL,
    roles: COMPLIANCE,
    channels: IN_APP,
    title: 'New data rights request',
    body: '${requestType} request received for ${subjectRef}. SLA: ${slaDays} day(s) to respond.',
    link: '/admin/compliance',
    skipActor: true,
  },
  /** The rights-request mirror of FEEDBACK_SLA_RESOLUTION_BREACH — same scanner, same day-bucketed dedupe. */
  DATA_RIGHTS_REQUEST_SLA_BREACH: {
    category: NotificationCategory.SYSTEM,
    priority: NotificationPriority.HIGH,
    roles: COMPLIANCE,
    channels: IN_APP_AND_EMAIL,
    title: 'Data rights request past its SLA',
    body: '${requestType} request has been open ${days} day(s), past its response SLA.',
    link: '/admin/compliance',
  },

  // ── Destructive actions (the two-person rule) ─────────────────────────────
  /**
   * A developer filed a data-wipe request; only an admin's decision can move it. Decision-forcing
   * by definition — nothing happens until a human clicks approve or reject — so it emails, per
   * the ALL/IN_APP_AND_EMAIL discipline above. The body names the requester and how much is
   * selected; deliberately no row counts here (email is the least contained surface — the exact
   * numbers are on the approval screen, where the decision belongs).
   */
  DESTRUCTIVE_ACTION_REQUESTED: {
    category: NotificationCategory.SYSTEM,
    priority: NotificationPriority.HIGH,
    roles: ADMINS,
    channels: IN_APP_AND_EMAIL,
    title: 'A data wipe needs your approval',
    body: '${requesterName} requests a wipe of ${domainCount} data domain(s). Review and approve or reject it.',
    link: '/admin/approvals',
    skipActor: true,
  },
  /**
   * The decision, told to the one person who can act on it: the requesting developer
   * (`RECORD_OWNER`, resolved from `ownerUserId` — the same specific-recipient mechanism the
   * feedback and invoice types use). Approved means a clock is running — the wipe is executable
   * only until the approval's expiry — which is why this also emails rather than waiting in a
   * bell. The service composes `detail` as the "run it until {expiry}" or "Reason: {reason}"
   * sentence, so one template serves both outcomes without a holed fallback.
   */
  DESTRUCTIVE_ACTION_DECIDED: {
    category: NotificationCategory.SYSTEM,
    priority: NotificationPriority.HIGH,
    roles: [],
    special: ['RECORD_OWNER'],
    channels: IN_APP_AND_EMAIL,
    title: 'Data wipe request ${decision}',
    body: 'Your data-wipe request (${domainCount} domain(s)) was ${decision}. ${detail}',
    link: '/admin/settings',
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
