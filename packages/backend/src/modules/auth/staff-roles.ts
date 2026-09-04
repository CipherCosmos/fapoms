import { SystemRole } from '@fapoms/shared';

/**
 * Every internal staff role.
 *
 * Read routes across most controllers carried no `@Roles` at all, and RolesGuard
 * treats absent metadata as "no restriction" — so any authenticated principal,
 * including a field assayer's mobile token and an external CLIENT_USER, could
 * read the entire client book, branch list, project portfolio and validation
 * queue. Applying this at controller level closes that by default; individual
 * routes still override it where a narrower or wider list is correct.
 *
 * CLIENT_USER stays out, but no longer for want of a column: `users.client_id`
 * exists, and `global-scope.ts#resolveClientScope` gives a client user a
 * per-client ceiling that `assertClientAllowed` enforces. The reason now is
 * blast radius. This list is a blanket grant applied across most controllers,
 * and only the handful of routes that deliberately name CLIENT_USER also apply
 * that ceiling — so adding it here would hand client users every staff read
 * route, most of which never narrow the query to their own client. Grant
 * CLIENT_USER per route, next to the scoping that makes the route safe.
 *
 * ASSAYER stays out for the neighbouring reason: the mobile app reaches its own
 * records through assayer-scoped routes that set their own `@Roles`.
 */
export const STAFF_ROLES: SystemRole[] = [
  SystemRole.ADMIN,
  SystemRole.OPERATIONS,
  SystemRole.DESK,
  SystemRole.DESK_OPERATOR,
  SystemRole.AUDITOR,
  SystemRole.PRODUCT_SUPPORT,
];
