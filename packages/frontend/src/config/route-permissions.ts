import { SystemRole } from '@fapoms/shared';

/**
 * Who may open a page.
 *
 * `allowedRoles` names the BUILT-IN roles, which is a closed set written in code.
 * `requiredPermissions` names what the screen's own API asks for, which is what a role built in
 * Admin → Roles can actually hold. Both are needed, and the reason is an incident: an
 * administrator created `HR_OPERATOR`, granted it the workforce permissions and assigned it to a
 * clerk. That role is a database row, so it matched no `SystemRole` and therefore no
 * `allowedRoles` entry anywhere — every route in this table answered "no", the clerk was bounced
 * to a dashboard whose API also refused them, and the role builder in the admin screen was, in
 * practice, a form that granted nothing.
 *
 * `anyAuthenticated` is the third state and mirrors the backend decorator of the same name: a
 * handful of routes are genuinely open to every signed-in principal because they only ever show
 * that person their own records. Spelling that out beats listing every role, which is exactly the
 * expression that could not see a database role.
 *
 * Keys are the stored `RESOURCE:ACTION:SCOPE` rows in upper case. A PLATFORM grant is widened to
 * the narrower scopes before it reaches here (`permissionKeysFrom`), so entries below name the
 * scope the backend route names — `assayer:view:organization` becomes `ASSAYER:VIEW:ORGANIZATION`
 * — and nothing in this file has to think about scope again.
 */
export type RoutePermission = {
  path: string;
  allowedRoles: SystemRole[];
  /**
   * ALL of these, not any — the same rule `RolesGuard` and `PermissionsGuard` apply. Holding one
   * of three permissions a screen needs is not holding what the screen needs.
   *
   * Left off deliberately wherever the API behind a page declares no permissions of its own: this
   * table must not open a page whose data will be refused. Those pages stay reachable by role
   * name alone until the backend route names what it requires, and each one is marked below.
   */
  requiredPermissions?: string[];
  /** Open to every signed-in principal, because the page only ever shows them their own records. */
  anyAuthenticated?: true;
};

export const ROUTE_PERMISSIONS: RoutePermission[] = [
  {
    // GET /system-dashboard/operations asks for project:view:organization — deliberately the
    // lowest common grant of the six roles it serves, since a dashboard is the floor of the app.
    // A role without it lands somewhere it can use instead (see defaultRouteFor).
    path: '/dashboard',
    allowedRoles: Object.values(SystemRole),
    requiredPermissions: ['PROJECT:VIEW:ORGANIZATION'],
  },
  {
    /**
     * The feedback & collaboration channel — super administrators only, by decision
     * (2026-08-17): the platform owner asked for feedback, notification rules and platform
     * settings to be visible to the super administrator and nobody else. This used to be open
     * to every role (reporters saw their own items, the PRODUCT_SUPPORT team and admins the
     * triage desk); the header launcher is gated on this same entry (Header.tsx), so no other
     * web user sees a feedback surface at all. Mirrors FEEDBACK_TEAM_ROLES on the backend.
     *
     * No permission: the backend gates the triage queue on FEEDBACK_TEAM_ROLES by name and
     * declares nothing a role could be granted, so there is nothing here to honour yet.
     */
    path: '/feedback',
    allowedRoles: [SystemRole.ADMIN],
  },
  {
    // The command centre this page draws asks for planning:view:organization.
    path: '/executive-map',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
    requiredPermissions: ['PLANNING:VIEW:ORGANIZATION'],
  },
  {
    // Everyone who works the book needs to see which project a branch belongs to.
    // No permission: GET /projects is gated on STAFF_ROLES and declares none.
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
    requiredPermissions: ['PLANNING:VIEW:ORGANIZATION'],
  },
  {
    // The Operations Inbox: every assignment awaiting a desk decision (call tasks for
    // phone-channel assayers, counters, replacements, unscheduled, overdue). Same roles that
    // may transition assignments, since every card action IS an assignment transition.
    // No permission: the assignment reads are gated on STAFF_ROLES and declare none.
    path: '/inbox',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    // The "Falling behind" board: overdue/breached assignments ranked most-overdue-first. Same
    // coordinator roles that work the inbox, since chasing is the same operations job.
    // No permission, for the same reason as /inbox — it is the same controller.
    path: '/falling-behind',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    // Operations executives work this queue daily; finance needs it to see what was billable.
    // No permission, for the same reason as /inbox.
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
    requiredPermissions: ['SCHEDULING:VIEW:ORGANIZATION'],
  },
  {
    // CLIENT_USER stays out: `users` has no client_id, so an external user cannot be scoped.
    // No permission: GET /clients is gated on STAFF_ROLES and declares none.
    path: '/clients',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
  },
  {
    path: '/billing',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
    requiredPermissions: ['BILLING:VIEW:ORGANIZATION'],
  },
  {
    // Read-only for most; write controls are gated separately by canManageBranches().
    // No permission: GET /branches is gated on STAFF_ROLES and declares none.
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
    // The workforce console, and the entry this whole change exists for: GET /hr/workforce asks
    // for assayer:view:organization and answers a custom role holding it, so the web app must
    // too — otherwise the API serves a page the navigation refuses to open.
    path: '/hr',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
    requiredPermissions: ['ASSAYER:VIEW:ORGANIZATION'],
  },
  {
    // No permission: the branch-paperwork reads are gated by role name and declare none.
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
    // The desk overview draws /validation/attention, /workload and /activity, all three of which
    // ask for validation:view:organization.
    path: '/data-entry',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR,
    ],
    requiredPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
  },
  {
    // Now a redirect into Platform Settings' travel section, which holds the rate card and the
    // dials that read it. Kept permitted so old links land where the page moved. Managing the
    // rates is still gated by canManageTransportRates(). Carries no permission because its
    // destination carries none — a redirect that outlives its target's gate is a hole.
    path: '/transport-costs',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
  },
  {
    // Platform configuration — super administrators only, by decision (2026-08-17; see
    // /feedback above). Wider staff used to be able to read it; the backend
    // PlatformSettingsController now admits the same single role, so the page and the API agree.
    // Two other roles reach one section each and see nothing else on the page: OPERATIONS the
    // eligibility rules folded in from `/rules`, which they own and hold the write permission
    // for, and AUDITOR the travel rate card folded in from `/transport-costs`, which they could
    // always read. See canManagePlanningRules and canReadTravelSettings.
    //
    // No permission: GET /platform-settings is gated by role name and declares none. Note the
    // asymmetry — saving a setting DOES require configuration:edit:platform — so naming that key
    // here would open a read the API refuses.
    path: '/admin/settings',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
  },
  {
    // Container logs. Administrators only, gated on the role itself rather than a grantable
    // permission: logs are the least filtered view of the system there is, and that is not a
    // capability anyone should be able to add to a role by editing a role. Mirrors
    // @Roles(SystemRole.ADMIN) on ServiceLogsController. The absence of a permission here is the
    // decision, not an omission.
    path: '/admin/logs',
    allowedRoles: [SystemRole.ADMIN],
  },
  {
    // Which events the platform raises, to whom, on what channels — super administrators only,
    // by the same decision. Mirrors NOTIFICATION_ADMIN_ROLES on the backend controller, which
    // gates the catalogue by role name and declares no permission to honour.
    path: '/admin/notifications',
    allowedRoles: [SystemRole.ADMIN],
  },
  {
    // Read for most; create/edit/delete is gated by canManageHolidays().
    // No permission: GET /holidays is gated on STAFF_ROLES and declares none.
    path: '/holidays',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR],
  },
  {
    /**
     * Suspending the platform's operational controls. Administrators only, and deliberately not
     * extended to OPERATIONS the way /rules is: configuring a business rule is an operational
     * decision; switching the controls off for a window is not.
     *
     * It does carry a permission, because the backend's own catalogue and history routes ask for
     * configuration:view:platform and will answer a role that holds it. Withholding the page from
     * someone the API already serves hides the screen, not the capability.
     */
    path: '/admin/rule-bypass',
    allowedRoles: [SystemRole.ADMIN],
    requiredPermissions: ['CONFIGURATION:VIEW:PLATFORM'],
  },
  {
    // Now a redirect into Platform Settings' rules section. The path stays permitted so old
    // links and bookmarks land where the feature moved rather than on the login screen. Carries
    // no permission for the same reason /transport-costs does not: its destination has none.
    path: '/rules',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    // Territorial zones group branches for coverage planning. Read for ops; create/edit gated
    // by canManageZones(). Mirrors the zone controller's own role list, which declares no
    // permission on the read.
    path: '/zones',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    path: '/users',
    allowedRoles: [SystemRole.ADMIN],
    requiredPermissions: ['USER:VIEW:ORGANIZATION'],
  },
  {
    // Own profile and own password. Every signed-in principal, mirroring @AnyAuthenticated() on
    // /users/me — and the reason this is a flag rather than a list of every role: a clerk on a
    // custom role must always be able to reach their own account, not least to change a password
    // somebody else issued them.
    path: '/settings',
    allowedRoles: [],
    anyAuthenticated: true,
  },
  {
    // Everyone has a notification inbox; it only ever shows their own. @AnyAuthenticated() too.
    path: '/notifications',
    allowedRoles: [],
    anyAuthenticated: true,
  },
  {
    // Redirect shims kept for old links. They forward to /data-entry and /hr respectively, and
    // must carry the same roles AND the same permissions as their destination, or the redirect
    // lands on a denied page.
    path: '/validation',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR,
    ],
    requiredPermissions: ['VALIDATION:VIEW:ORGANIZATION'],
  },
  {
    path: '/assayers',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
    requiredPermissions: ['ASSAYER:VIEW:ORGANIZATION'],
  },
];

/**
 * Whether this person may open a path.
 *
 * Three things this has had to get right, each of them the fix for a real defect:
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
 *
 * 3. The question was "is your role name on the list", which no role created in Admin → Roles
 *    could ever answer yes to. The name is now a shortcut rather than the whole rule — match it
 *    and you are in, exactly as before, so no built-in role gains or loses anything — and
 *    otherwise the question becomes whether you hold what the page requires.
 *
 * FAIL CLOSED is the part to keep. An entry that lists no permissions offers nothing to check, so
 * an unrecognised role is still refused. The alternative — reading "nothing listed" as "nothing
 * required" — turns every forgotten entry into an open page, which is the defect in (2) wearing a
 * different hat. RolesGuard on the backend takes exactly this position.
 */
export function canAccessRoute(
  userRoles: SystemRole[],
  userPermissions: string[],
  path: string,
): boolean {
  const matches = ROUTE_PERMISSIONS.filter((rp) => {
    if (rp.path.includes(':id')) {
      return new RegExp(`^${rp.path.replace(/:id/g, '[^/]+')}$`).test(path);
    }
    return path === rp.path || path.startsWith(`${rp.path}/`);
  });

  if (matches.length === 0) return false;

  // Most specific wins: `/hr/pay` beats `/hr` when both are declared.
  const routeConfig = matches.reduce((best, rp) => (rp.path.length > best.path.length ? rp : best));

  if (routeConfig.anyAuthenticated) return true;
  if (userRoles.some((role) => routeConfig.allowedRoles.includes(role))) return true;

  // `every`, not `some` — see the type's own note. An empty list can never satisfy this, which is
  // what makes the fail-closed rule above true rather than merely intended.
  const required = routeConfig.requiredPermissions ?? [];
  if (required.length === 0) return false;
  const held = new Set(userPermissions.map((p) => p.toUpperCase()));
  return required.every((perm) => held.has(perm.toUpperCase()));
}

/**
 * Where each built-in role starts its day, when it can.
 *
 * This is a preference, not a grant: every entry is checked against `canAccessRoute` before it is
 * returned, so a role whose home page is closed to it is never sent there.
 *
 * It used to be a chain of `if`s that had rotted in a specific and visible way — ADMIN was tested
 * twice, four consecutive branches all tested OPERATIONS so only the first could ever fire, and
 * DESK appeared twice inside one condition. Thirteen roles collapsed onto eight and the branches
 * of the roles that disappeared were rewritten in place instead of being removed, so the billing,
 * workforce and field-work homes below the first OPERATIONS branch became unreachable code. They
 * are gone; what is left is one line per surviving role, and the ordered list underneath now does
 * the job those dead branches were reaching for.
 */
const HOME_BY_ROLE: [SystemRole, string][] = [
  [SystemRole.ADMIN, '/dashboard'],          // runs the whole board
  [SystemRole.OPERATIONS, '/executive-map'], // live pipeline overview
  [SystemRole.DESK, '/documents'],           // packets out, packets back
  [SystemRole.DESK_OPERATOR, '/data-entry'], // their share of the desk's queue
];

/**
 * Everything else, most operationally specific first.
 *
 * A role built in Admin → Roles has no home of its own, so it gets the first page it can actually
 * use — which is the only honest answer available and, for the workforce role that prompted all
 * this, is `/hr`. The last two entries are open to every signed-in principal, so the search
 * always terminates on something usable: `/dashboard` is emphatically NOT the safety net it was,
 * because landing there was how the whole problem presented — a page the person could open and
 * could not load, with a Retry button that failed identically every time.
 */
const LANDING_ORDER: string[] = [
  '/dashboard',
  '/executive-map',
  '/inbox',
  '/planning',
  '/assignments',
  '/scheduling',
  '/hr',
  '/documents',
  '/data-entry',
  '/billing',
  '/clients',
  '/projects',
  '/branches',
  '/holidays',
  '/zones',
  '/users',
  '/admin/settings',
  '/notifications',
  '/settings',
];

/** The first page this person can actually open — their landing page after signing in. */
export function defaultRouteFor(userRoles: SystemRole[], userPermissions: string[]): string {
  const home = HOME_BY_ROLE.find(([role]) => userRoles.includes(role))?.[1];
  const candidates = home ? [home, ...LANDING_ORDER] : LANDING_ORDER;
  return (
    candidates.find((path) => canAccessRoute(userRoles, userPermissions, path))
    // Unreachable while /settings stays open to everyone, and left here so that if it ever
    // stops being open this returns a real path rather than undefined.
    ?? '/settings'
  );
}
