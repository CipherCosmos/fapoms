import { SystemRole } from '@fapoms/shared';

/**
 * Who sees the feedback channel from the team side — the queue, triage, the SLA digest, the
 * realtime role rooms and the "new feedback" notifications.
 *
 * Super administrators only, by decision (2026-08-17). Until then the desk was shared with
 * PRODUCT_SUPPORT and ADMINISTRATOR; the platform owner asked for feedback, notification rules
 * and platform settings to be visible to the super administrator and nobody else, so every
 * team-side surface reads this one list — the controller guard, the "assign to" roster, the
 * notification catalog's audience, the socket rooms and the morning digest — rather than each
 * carrying its own copy that could drift.
 *
 * The reporter side is untouched: any signed-in principal (staff, client user, field assayer
 * from the mobile app) may still file feedback and follow their own thread through the API. What
 * changed is who receives it. `PRODUCT_SUPPORT` remains a role in the database; it simply no
 * longer opens this desk.
 *
 * A leaf module on purpose — no imports beyond the shared enum — so the notification catalog,
 * the gateway and the scheduler can read it without pulling the feedback service (and its
 * entities) into their import graph.
 */
export const FEEDBACK_TEAM_ROLES = [SystemRole.SUPER_ADMINISTRATOR] as const;

/** The same list as plain strings, for the places that address roles by name (socket rooms, digest audiences, catalog). */
export const FEEDBACK_TEAM_ROLE_NAMES: string[] = [...FEEDBACK_TEAM_ROLES];
