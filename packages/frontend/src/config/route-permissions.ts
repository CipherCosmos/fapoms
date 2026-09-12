import { SystemRole, expandRoles } from '@fapoms/shared';

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
    //
    // Those six roles are named here rather than `Object.values(SystemRole)`, and the difference is
    // a real defect this closes. Listing every role made the name match (which runs first) admit
    // the two roles that hold NOTHING — PRODUCT_SUPPORT and ASSAYER — so `requiredPermissions` was
    // never consulted for them: `defaultRouteFor` sent them here as their first "reachable" page,
    // the snapshot API then 403'd, and the dashboard sat on loading skeletons forever. Naming only
    // the roles that actually hold the grant makes the entry mean what its own comment says — a
    // role without project:view lands elsewhere — while a custom role granted it still reaches the
    // page through the permission fallback.
    path: '/dashboard',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.OPERATIONS,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR,
      SystemRole.CLIENT_USER,
    ],
    requiredPermissions: ['PROJECT:VIEW:ORGANIZATION'],
  },
  {
    /**
     * The support desk — the people who ANSWER the tickets, not the business owner. Since the
     * DEVELOPER split (2026-09-05) that is DEVELOPER and PRODUCT_SUPPORT, and ADMIN loses the
     * page: running the business does not include working the product-support queue. (A
     * developer also reaches it through implication — DEVELOPER ⇒ PRODUCT_SUPPORT — but is
     * named anyway so this table reads as the complete answer.) The header launcher is gated
     * on this same entry (Header.tsx); sending feedback stays open to everyone — only browsing
     * the channel is restricted. Mirrors FEEDBACK_TEAM_ROLES on the backend.
     *
     * No permission: the backend gates the triage queue on FEEDBACK_TEAM_ROLES by name and
     * declares nothing a role could be granted, so there is nothing here to honour yet.
     */
    path: '/feedback',
    allowedRoles: [SystemRole.DEVELOPER, SystemRole.PRODUCT_SUPPORT],
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
    /**
     * The planning workspace. Permission OFF, and for a reason `/executive-map` above does not
     * share even though the two name the same grant.
     *
     * `GET /planning/*` honours the fallback now, so the recommendations and day plans this page
     * draws would be served. But the page is keyed on a PROJECT, and its project picker is fed by
     * `GET /projects` — `@Roles(...STAFF_ROLES)` in `modules/project/**`, another workstream's, with
     * no fallback. Measured live: the picker came up empty and the workspace announced "No branches
     * in this project yet. Add branches to the project before visits can be planned for them." — a
     * confident, specific, wrong statement, produced by a refusal.
     *
     * `/executive-map` stays open because its own content (`GET /planning/command-center`) fills
     * completely; only a client filter is short. This page's content is the project.
     *
     * `@RolesFallbackPermissions('project:view:organization')` on `ProjectController.findAll`
     * restores it; the permission belongs back here in the same change.
     */
    path: '/planning',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
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
    /**
     * The workforce console. The permission is OFF, and that is a correction, not a retreat.
     *
     * The line that stood here said "GET /hr/workforce asks for assayer:view:organization and
     * answers a custom role holding it, so the web app must too". Half of that was true. The route
     * (`modules/assayer/hr.controller.ts`) does declare `assayer:view:organization` — but its
     * `@Roles(ADMIN, OPERATIONS)` carries neither `@AllowPermissionFallback()` nor
     * `@RolesFallbackPermissions(...)`, so `RolesGuard` hard-denies every unrecognised role before
     * it ever looks at a permission. Measured against a custom role holding exactly
     * ASSAYER:VIEW:ORGANIZATION: `GET /hr/workforce` → 403.
     *
     * So this table was opening a page whose data is refused — the one thing the type's own note
     * says it must not do. What the operator got was worse than a closed door: "The workforce
     * figures could not be loaded just now. An unknown problem occurred. Please try again." —
     * honest that something failed, wrong about what, and an invitation to retry forever.
     *
     * ONE LINE fixes it properly, and it is not in this workstream's files: add
     * `@AllowPermissionFallback()` beside the `@RequirePermissions('assayer:view:organization')` on
     * `HrController.workforce`. Restore this key in the same change.
     */
    path: '/hr',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    /**
     * Registering an assayer — a page of its own now, not a modal launched from the roster (see
     * `registration/RegistrationPage.tsx`). Declared as its own literal entries, longer than `/hr`
     * itself, rather than left to inherit that entry's prefix match: `/hr` only asks for
     * `ASSAYER:VIEW:ORGANIZATION`, which is the roster's OWN gate, not the "Add assayer" button's.
     * canCreateAssayers() — what the roster actually checks before showing that button and the
     * resume icon — asks for ASSAYER:CREATE:ORGANIZATION, so this mirrors that rather than the
     * section's read gate; a role that can browse the roster but not create on it would otherwise
     * land on a page whose own `POST /assayers` the API refuses.
     */
    path: '/hr/register',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
    // Permission off, for the same reason as `/hr` above and one of its own: `POST /assayers`
    // lives in `modules/assayer/**` and offers no permission fallback either, so a custom role
    // holding ASSAYER:CREATE would land on a registration wizard whose Save is refused — a worse
    // outcome than not being offered the page, because it is discovered after the typing.
  },
  {
    /**
     * The resume path, `/hr/register/:assayerId`. Kept as its own literal entry alongside
     * `/hr/register` above rather than relying on that one's prefix match, so both read the same
     * in this table — though the prefix match is what actually governs a real id at runtime:
     * `canAccessRoute`'s own `:id`-parameterised matching keys on the literal substring `:id`,
     * which `:assayerId` does not contain, so THIS entry only ever matches its own literal path
     * text (as the fitness spec below does, substituting `:id` for `some-id` on every entry) and
     * `/hr/register`'s prefix rule is what actually opens `/hr/register/<real-uuid>`. Named to
     * match the route it gates (`App.tsx`'s `roster/:assayerId` uses the same word) rather than
     * `:id`, since nothing here depends on the difference mattering.
     */
    path: '/hr/register/:assayerId',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
    // Permission off, mirroring `/hr/register` above — these two must always agree.
  },
  {
    /**
     * Appraiser Recruitment's interview gate — HR's own screen for recording an interview
     * outcome before a candidate is invited to self-register. Mirrors
     * `@Roles(ADMIN, OPERATIONS)` on `AssayerInterviewController` exactly.
     *
     * Permission off, for the same reason `/hr/register` is: the controller carries
     * `@RequirePermissions('assayer:create:organization' | 'assayer:view:organization')` on its
     * two routes but neither offers `@AllowPermissionFallback()`/`@RolesFallbackPermissions(...)`,
     * so a custom role holding that grant would still be hard-denied by `RolesGuard` before the
     * permission is ever read. Naming the permission here would open a page whose own API refuses
     * exactly the role this table let in — the one thing this table's own note (above) says it
     * must not do.
     */
    path: '/hr/interviews',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    /**
     * Appraiser Recruitment's HR review queue for self-registration applications — a separate,
     * NEW candidate-facing intake path that coexists with (does not replace) `/hr/register` above.
     * Mirrors `@Roles(ADMIN, OPERATIONS)` on `HrApplicationsController` exactly.
     *
     * Permission off, for the same reason as `/hr/interviews` just above: every route on this
     * controller declares a `@RequirePermissions(...)` (view/create/edit) but none carries the
     * fallback decorator, so `RolesGuard` never reaches the permission check for a custom role.
     */
    path: '/hr/applications',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
  },
  {
    // The comment this replaced ("no permission: gated by role name and declare none") was true
    // of most reads under this controller but not this page's own main content fetch:
    // `Documents.tsx`'s `loadOverview()` calls `GET /documents/operations/overview`, whose handler
    // carries `@RequirePermissions('document:view:organization')` alongside its `@Roles`. Found
    // 2026-09-04 while wiring `DOCUMENT_UPLOADED`'s notification fallback (see
    // notification-catalog.ts) — without this, `canAccessRoute`'s permission fallback is
    // fail-closed on an empty `requiredPermissions` list, so no custom role could ever open this
    // page, even one holding exactly the permission its own data fetch asks for.
    path: '/documents',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.OPERATIONS,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR,
    ],
    requiredPermissions: ['DOCUMENT:VIEW:ORGANIZATION'],
  },
  {
    // The desk overview draws /validation/attention, /workload and /activity, all three of which
    // ask for validation:view:organization.
    //
    // AUDITOR is deliberately NOT here, and leaving it in was a leak. The page classifies anyone who
    // is not a desk head as a working member and fetches their personal queue,
    // GET /documents/data-entry/mine — whose @Roles names only ADMIN, DESK and DESK_OPERATOR. An
    // auditor is a built-in role, so it gets no permission fallback there and the fetch 403s; and
    // even if it were served, `/mine` returns the caller's OWN assigned records, which an auditor
    // never has. Auditor oversight of validation belongs on the dashboard's validation panel and the
    // assignments board, not on the desk's working queue. The desk is DESK/DESK_OPERATOR's, admins'
    // to run.
    path: '/data-entry',
    allowedRoles: [
      SystemRole.ADMIN,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
    ],
    // Permission off. All three of the fetches named above declare
    // `validation:view:organization` and none of them offers a fallback, so a custom role holding
    // that grant was admitted here and refused by every one of them. `modules/validation/**` is
    // another workstream's; adding `@AllowPermissionFallback()` to `attention`, `workload` and
    // `activity` and restoring this key is the whole fix.
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
    // Container logs. Developers only — the technical estate, gated on the role itself rather
    // than a grantable permission: logs are the least filtered view of the system there is, and
    // that is not a capability anyone should be able to add to a role by editing a role. ADMIN
    // is deliberately NOT here and cannot arrive by implication (it runs DEVELOPER → ADMIN,
    // never the reverse) — the business owner does not read raw service logs. Mirrors
    // @Roles(SystemRole.DEVELOPER) on ServiceLogsController. The absence of a permission here
    // is the decision, not an omission.
    path: '/admin/logs',
    allowedRoles: [SystemRole.DEVELOPER],
  },
  {
    // The approve side of the destructive-action two-person rule: a DEVELOPER requests a data
    // wipe in the Danger Zone, an ADMIN decides it here. Listed as ADMIN's page — developers
    // are refused the approve/reject ACTIONS by design, but the route gate cannot express that:
    // implication makes every developer pass an ADMIN name-match, so the page itself gates its
    // buttons on the DIRECT role (canApproveDestructiveActions) and the backend refuses a
    // developer's approval anyway. A developer landing here sees the queue read-only.
    // No permission: approval must not be grantable to a custom role by editing a role.
    path: '/admin/approvals',
    allowedRoles: [SystemRole.ADMIN],
  },
  {
    // Security & compliance: the incident register with its CERT-In/DPDP clocks and the
    // compliance-health summary. Administrators run it, auditors read it — mirrors the backend
    // ComplianceController, whose reads are @Roles(ADMIN, AUDITOR) and whose writes are ADMIN.
    // No permission: the controller gates by role name and declares none.
    path: '/admin/compliance',
    allowedRoles: [SystemRole.ADMIN, SystemRole.AUDITOR],
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
    ],
    // Permission off, mirroring `/data-entry` — a redirect must never outlive its target's gate.
  },
  {
    // A redirect into `/hr/roster`, so it carries what `/hr` carries — which since this change is
    // roles only. `GET /assayers` declares `assayer:view:organization` and offers no fallback
    // (`modules/assayer/**`), so admitting a custom role here sent it to a roster that answers 403.
    path: '/assayers',
    allowedRoles: [SystemRole.ADMIN, SystemRole.OPERATIONS],
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
 *
 * 4. The permission fallback is for CUSTOM roles only, and this took a real leak to notice. AUDITOR
 *    is a built-in role deliberately left off `/planning`'s `allowedRoles` (planning is an
 *    operations job), yet it holds `PLANNING:VIEW:ORGANIZATION` for a different page it does own,
 *    `/executive-map`. When the fallback ran for every role, that one shared permission opened
 *    `/planning` to AUDITOR by the back door — the shell loaded, then the page's own API 403'd and
 *    the result read as a misleading "no assayers found" empty state. So the fallback now runs only
 *    when the person holds a role that is NOT a built-in `SystemRole` (a role built in Admin →
 *    Roles). For a purely built-in principal, `allowedRoles` is the whole and deliberate answer:
 *    what a built-in role may open is decided in this table, never inferred from a permission it
 *    happens to hold for something else. This mirrors RolesGuard, which filters to `unrecognised`
 *    roles before it consults permissions for exactly this reason.
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
  // The caller's names are expanded through the role hierarchy before matching (role-hierarchy.ts
  // in @fapoms/shared): DEVELOPER implies ADMIN and PRODUCT_SUPPORT, so every entry naming those
  // admits a developer without this table listing it on 20 rows. One-way — an entry naming only
  // DEVELOPER (/admin/logs) still excludes admins — and the same expansion RolesGuard applies, so
  // the navigation and the API keep agreeing.
  if (expandRoles(userRoles).some((role) => routeConfig.allowedRoles.includes(role as SystemRole))) return true;

  // The permission fallback exists so a role built in Admin → Roles — which by definition matches
  // no `allowedRoles` entry — can still reach the pages it was granted. It must NOT hand a built-in
  // role a page it was deliberately kept off (see note 4). If every role the person holds is a
  // built-in `SystemRole`, the role-name check above was the whole answer, and it said no.
  // RAW names here, not the expansion: expansion only ever adds built-in names, and the fallback
  // must open exactly when the person actually carries a database-defined role.
  const knownRoleNames = new Set<string>(Object.values(SystemRole));
  const hasCustomRole = userRoles.some((role) => !knownRoleNames.has(role));
  if (!hasCustomRole) return false;

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
  // First match wins for a person holding several roles, so the most capable role sits first —
  // DEVELOPER above ADMIN, mirroring the hierarchy (DEVELOPER ⇒ ADMIN, role-hierarchy.ts).
  [SystemRole.DEVELOPER, '/dashboard'],      // runs the machine; same board as ADMIN
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
  // The support desk: for PRODUCT_SUPPORT this is the job itself, and before this entry the
  // role fell through to its own notification inbox — a page about the work instead of the work.
  // Placed after the operational pages so no role that can open one of those lands here instead.
  '/feedback',
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
