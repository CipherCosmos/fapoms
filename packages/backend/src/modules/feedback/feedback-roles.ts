import { SystemRole } from '@fapoms/shared';

/**
 * Who sees the feedback channel from the team side — the queue, triage, the SLA digest, the
 * realtime role rooms and the "new feedback" notifications.
 *
 * Two decisions, two dates. On 2026-08-17 the desk narrowed to super administrators only:
 * until then it was shared with PRODUCT_SUPPORT and ADMINISTRATOR, and the platform owner
 * asked for feedback, notification rules and platform settings to be visible to the super
 * administrator and nobody else. On 2026-09-05 the same owner moved the desk again, to the new
 * DEVELOPER role — "feedback from support is for developer only": what arrives here is bug
 * reports and product questions, which is the technical estate's work, and administrators are
 * business people. PRODUCT_SUPPORT returns as the optional delegate role for a future support
 * hire; ADMIN no longer opens the desk at all (implication is one-way — DEVELOPER passes ADMIN
 * gates, never the reverse).
 *
 * Every team-side surface reads this one list — the controller guard, the "assign to" roster,
 * the notification catalog's audience, the socket rooms and the morning digest — rather than
 * each carrying its own copy that could drift.
 *
 * The reporter side is untouched: any signed-in principal (staff, client user, field assayer
 * from the mobile app) may still file feedback and follow their own thread through the API. What
 * changed, both times, is who receives it.
 *
 * A leaf module on purpose — no imports beyond the shared enum — so the notification catalog,
 * the gateway and the scheduler can read it without pulling the feedback service (and its
 * entities) into their import graph.
 */
export const FEEDBACK_TEAM_ROLES = [SystemRole.DEVELOPER, SystemRole.PRODUCT_SUPPORT] as const;

/** The same list as plain strings, for the places that address roles by name (socket rooms, digest audiences, catalog). */
export const FEEDBACK_TEAM_ROLE_NAMES: string[] = [...FEEDBACK_TEAM_ROLES];
