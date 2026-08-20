import { SystemRole } from '@fapoms/shared';

export type RoutePermission = {
  path: string;
  allowedRoles: SystemRole[];
};

export const ROUTE_PERMISSIONS: RoutePermission[] = [
  {
    path: '/dashboard',
    allowedRoles: Object.values(SystemRole),
  },
  {
    /**
     * The feedback & collaboration channel — super administrators only, by decision
     * (2026-08-17): the platform owner asked for feedback, notification rules and platform
     * settings to be visible to the super administrator and nobody else. This used to be open
     * to every role (reporters saw their own items, the PRODUCT_SUPPORT team and admins the
     * triage desk); the header launcher is gated on this same entry (Header.tsx), so no other
     * web user sees a feedback surface at all. Mirrors FEEDBACK_TEAM_ROLES on the backend.
     */
    path: '/feedback',
    allowedRoles: [SystemRole.ADMIN],
  },
  {
    path: '/executive-map',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
  },
  {
    // Everyone who works the book needs to see which project a branch belongs to.
    path: '/projects',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.OPERATIONS,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR,
    ],
  },
  {
    path: '/planning',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    // The Operations Inbox: every assignment awaiting a desk decision (call tasks for
    // phone-channel assayers, counters, replacements, unscheduled, overdue). Same roles that
    // may transition assignments, since every card action IS an assignment transition.
    path: '/inbox',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    // Operations executives work this queue daily; finance needs it to see what was billable.
    path: '/assignments',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
  },
  {
    // Document dispatch is driven by the schedule, so the desk needs to see it.
    path: '/scheduling',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.OPERATIONS,
      SystemRole.DESK,
      SystemRole.AUDITOR,
    ],
  },
  {
    // CLIENT_USER stays out: `users` has no client_id, so an external user cannot be scoped.
    path: '/clients',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
  },
  {
    path: '/billing',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
  },
  {
    // Read-only for most; write controls are gated separately by canManageBranches().
    path: '/branches',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.OPERATIONS,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR,
    ],
  },
  {
    path: '/hr',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    path: '/documents',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.OPERATIONS,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR,
    ],
  },
  {
    path: '/data-entry',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR,
    ],
  },
  {
    // The transport rate card behind offer travel recommendations. Executives read it (they
    // negotiate on the phone against these numbers); managing is gated by
    // canManageTransportRates() — ops + finance, mirroring the backend controller.
    path: '/transport-costs',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
  },
  {
    // Platform configuration — super administrators only, by decision (2026-08-17; see
    // /feedback above). Wider staff used to be able to read it; the backend
    // PlatformSettingsController now admits the same single role, so the page and the API agree.
    path: '/admin/settings',
    allowedRoles: [SystemRole.ADMIN],
  },
  {
    // Which events the platform raises, to whom, on what channels — super administrators only,
    // by the same decision. Mirrors NOTIFICATION_ADMIN_ROLES on the backend controller.
    path: '/admin/notifications',
    allowedRoles: [SystemRole.ADMIN],
  },
  {
    // Read for most; create/edit/delete is gated by canManageHolidays().
    path: '/holidays',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
  },
  {
    /**
     * Suspending the platform's operational controls. Administrators only, and deliberately not
     * extended to OPERATIONS_MANAGER the way /rules is: configuring a business rule is an
     * operational decision; switching the controls off for a window is not.
     */
    path: '/admin/rule-bypass',
    allowedRoles: [SystemRole.ADMIN],
  },
  {
    // Operations own planning rules — they hold the write permission, so they need the page.
    path: '/rules',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    // Territorial zones group branches for coverage planning. Read for ops; create/edit gated
    // by canManageZones(). Mirrors the zone controller's own role list.
    path: '/zones',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    path: '/users',
    allowedRoles: [SystemRole.ADMIN],
  },
  {
    path: '/settings',
    allowedRoles: Object.values(SystemRole),
  },
  {
    // Everyone has a notification inbox; it only ever shows their own.
    path: '/notifications',
    allowedRoles: Object.values(SystemRole),
  },
  {
    // Redirect shims kept for old links. They forward to /data-entry and /hr respectively, and
    // must carry the same roles as their destination or the redirect lands on a denied page.
    path: '/validation',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR,
    ],
  },
  {
    path: '/assayers',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
];

/**
 * Whether a role may open a path.
 *
 * Two things this used to get wrong, both of which matter more now that roles have several
 * pages each rather than one:
 *
 * 1. Matching was exact, so a sub-path like `/hr/roster` matched no entry at all — and an
 *    unmatched path fell through to "allow". Every page added under an existing section would
 *    therefore have been reachable by every role, including a read-only auditor. Matching is
 *    now longest-prefix, so a sub-path inherits its section's roles unless it declares its own.
 *
 * 2. The fallback was allow-by-default, which means forgetting an entry silently publishes a
 *    page. For a product whose whole purpose is controlled access to audit evidence, the safe
 *    default is the other way round: an unlisted path is denied, and the omission shows up as a
 *    missing page rather than as a leak.
 */
/**
 * The page each role should land on — the first screen of their actual work, not a generic
 * dashboard. This is the "what do I do when I log in" answer the nav could not give before.
 *
 * A user may hold several roles, so the most operationally specific home wins while admins, who
 * run the whole board, get the overview. Every target below is a route the matching role can
 * already open per ROUTE_PERMISSIONS, so a landing redirect can never bounce into a denied page.
 */
export function defaultRouteForRoles(userRoles: SystemRole[]): string {
  const has = (r: SystemRole) => userRoles.includes(r);
  if (has(SystemRole.ADMIN) || has(SystemRole.ADMIN)) return '/dashboard';
  if (has(SystemRole.OPERATIONS)) return '/executive-map';   // live pipeline overview
  if (has(SystemRole.OPERATIONS)) return '/billing';            // the billing book
  if (has(SystemRole.OPERATIONS)) return '/hr';                      // workforce console
  if (has(SystemRole.OPERATIONS)) return '/assignments';   // field-execution queue
  if (has(SystemRole.DESK)) return '/documents';       // document desk
  if (has(SystemRole.DESK) || has(SystemRole.DESK_OPERATOR) || has(SystemRole.DESK)) {
    return '/data-entry';                                            // validation / data-entry desk
  }
  return '/dashboard';                                               // auditor and anyone else: read-only overview
}

export function canAccessRoute(userRoles: SystemRole[], path: string): boolean {
  const matches = ROUTE_PERMISSIONS.filter((rp) => {
    if (rp.path.includes(':id')) {
      return new RegExp(`^${rp.path.replace(/:id/g, '[^/]+')}$`).test(path);
    }
    return path === rp.path || path.startsWith(`${rp.path}/`);
  });

  if (matches.length === 0) return false;

  // Most specific wins: `/hr/pay` beats `/hr` when both are declared.
  const routeConfig = matches.reduce((best, rp) => (rp.path.length > best.path.length ? rp : best));

  return userRoles.some((role) => routeConfig.allowedRoles.includes(role));
}
