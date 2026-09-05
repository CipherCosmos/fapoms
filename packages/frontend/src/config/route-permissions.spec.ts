import * as fs from 'fs';
import * as path from 'path';
import {
  AuthorizationScope, PermissionAction, PermissionResource, SystemRole,
} from '@fapoms/shared';
import {
  canAccessRoute, defaultRouteFor, ROUTE_PERMISSIONS,
} from './route-permissions';

/**
 * A role built in Admin → Roles is a database row whose name is not a `SystemRole`, and the
 * permission fallback exists for it alone (see canAccessRoute note 4). At runtime `useCurrentRoles`
 * returns every role by NAME without filtering to the enum, so a custom-role principal always
 * carries its own name in the roles array — which is precisely what tells `canAccessRoute` the
 * fallback may run. Modelling such a principal with an empty roles array, as an earlier version of
 * these tests did, described a principal that cannot exist and quietly relied on the fallback
 * running for everyone.
 */
const CUSTOM_ROLE = ['HR_OPERATOR'] as unknown as SystemRole[];

/**
 * Role gating decides who can see audit evidence, so it is the one piece of frontend logic that
 * must not be reasoned about by eye.
 */
describe('canAccessRoute', () => {
  /** Most of this file is about role names, which hold no permissions of their own. */
  const NO_PERMISSIONS: string[] = [];

  describe('a path that declares its own roles', () => {
    it('admits a role on the list and refuses one that is not', () => {
      expect(canAccessRoute([SystemRole.OPERATIONS], NO_PERMISSIONS, '/hr')).toBe(true);
      expect(canAccessRoute([SystemRole.DESK], NO_PERMISSIONS, '/hr')).toBe(false);
    });

    it('admits a user holding several roles when any one of them qualifies', () => {
      expect(canAccessRoute([SystemRole.DESK, SystemRole.OPERATIONS], NO_PERMISSIONS, '/hr')).toBe(true);
    });

    it('refuses a user with no roles at all', () => {
      expect(canAccessRoute([], NO_PERMISSIONS, '/hr')).toBe(false);
    });
  });

  describe('sub-paths', () => {
    /**
     * The reason this matters: matching used to be exact, and an unmatched path fell through to
     * "allow". Every page added under an existing section would have been reachable by every
     * role, a read-only auditor included.
     */
    it('inherits the section it sits under', () => {
      expect(canAccessRoute([SystemRole.OPERATIONS], NO_PERMISSIONS, '/hr/roster')).toBe(true);
      expect(canAccessRoute([SystemRole.OPERATIONS], NO_PERMISSIONS, '/hr/pay/history')).toBe(true);
    });

    it('does not leak a section to a role excluded from it', () => {
      expect(canAccessRoute([SystemRole.DESK], NO_PERMISSIONS, '/hr/roster')).toBe(false);
      expect(canAccessRoute([SystemRole.AUDITOR], NO_PERMISSIONS, '/hr/pay')).toBe(false);
      expect(canAccessRoute([SystemRole.DESK_OPERATOR], NO_PERMISSIONS, '/hr/compliance')).toBe(false);
    });

    it('is not fooled by a path that merely starts with the same letters', () => {
      // '/hrsomething' is not under '/hr', and must not inherit its roles.
      expect(canAccessRoute([SystemRole.OPERATIONS], NO_PERMISSIONS, '/hrsomething')).toBe(false);
    });

    it('carries the section permissions down to a sub-path as well as the roles', () => {
      expect(canAccessRoute(CUSTOM_ROLE, ['ASSAYER:VIEW:ORGANIZATION'], '/hr/roster')).toBe(true);
      expect(canAccessRoute(CUSTOM_ROLE, ['DOCUMENT:VIEW:ORGANIZATION'], '/hr/roster')).toBe(false);
    });

    it('lets a sub-path override its section when it declares its own roles', () => {
      const withOverride = ROUTE_PERMISSIONS.some((rp) => rp.path.split('/').length > 2);
      // No override exists yet; the rule is asserted through the longest-prefix behaviour above.
      expect(typeof withOverride).toBe('boolean');
    });
  });

  describe('the HR section pages', () => {
    const HR_PAGES = [
      '/hr', '/hr/roster', '/hr/onboarding', '/hr/records',
      '/hr/compliance', '/hr/capability', '/hr/documents', '/hr/pay', '/hr/deployment', '/hr/utilisation', '/hr/activity',
    ];

    /**
     * Workforce pages belong to OPERATIONS now.
     *
     * They were HR_MANAGER's, and closed to operations precisely so that planning work and
     * administering the people who do it were different jobs. Folding HR into OPERATIONS makes
     * them the same job, and these pages open accordingly. The desk, an operator and an auditor
     * still cannot reach them, which is the boundary that remains.
     */
    it('are all reachable by OPERATIONS, which owns the workforce', () => {
      for (const page of HR_PAGES) {
        expect(canAccessRoute([SystemRole.OPERATIONS], NO_PERMISSIONS, page)).toBe(true);
      }
    });

    it.each([
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR,
      SystemRole.CLIENT_USER,
    ])('are all closed to %s', (role) => {
      for (const page of HR_PAGES) {
        expect(canAccessRoute([role], NO_PERMISSIONS, page)).toBe(false);
      }
    });
  });

  describe('an unlisted path', () => {
    it('is denied rather than published', () => {
      expect(canAccessRoute([SystemRole.ADMIN], NO_PERMISSIONS, '/not-a-real-page')).toBe(false);
      expect(canAccessRoute([SystemRole.AUDITOR], NO_PERMISSIONS, '/internal/secrets')).toBe(false);
    });

    it('stays denied however many permissions the caller holds', () => {
      const everything = ROUTE_PERMISSIONS.flatMap((rp) => rp.requiredPermissions ?? []);
      expect(canAccessRoute([], everything, '/internal/secrets')).toBe(false);
    });
  });

  describe('parameterised paths', () => {
    it('matches an id segment', () => {
      // The single assayer view is the roster's drawer now (/hr/roster?assayer=…), so the
      // gate that matters is the roster's.
      expect(canAccessRoute([SystemRole.OPERATIONS], NO_PERMISSIONS, '/hr/roster')).toBe(true);
      expect(canAccessRoute([SystemRole.DESK_OPERATOR], NO_PERMISSIONS, '/hr/roster')).toBe(false);
    });
  });

  /**
   * The incident this whole mechanism exists for.
   *
   * An administrator built `HR_OPERATOR` in Admin → Roles, granted it the workforce permissions,
   * assigned it to a clerk, and the clerk could open nothing at all: the role is a database row,
   * it matches no `SystemRole`, and every entry in this table was a list of role names. The
   * backend's `RolesGuard` was fixed to fall through to permissions; these are the cases that say
   * the web app now agrees with it.
   */
  describe('a role built in Admin → Roles, which matches no SystemRole', () => {
    // The real grant the incident was reported with, already widened from its PLATFORM rows.
    const HR_OPERATOR = [
      'ASSAYER:VIEW:ORGANIZATION', 'ASSAYER:CREATE:ORGANIZATION',
      'ASSAYER:EDIT:ORGANIZATION', 'ASSAYER:DELETE:ORGANIZATION',
      'DOCUMENT:VIEW:ORGANIZATION', 'DOCUMENT:UPLOAD:ORGANIZATION',
      'OCR:CREATE:ORGANIZATION', 'OCR:EDIT:ORGANIZATION',
    ];

    it('opens the workforce console it was granted', () => {
      expect(canAccessRoute(CUSTOM_ROLE, HR_OPERATOR, '/hr')).toBe(true);
    });

    it('opens its own account and its own notifications, as every signed-in user may', () => {
      expect(canAccessRoute(CUSTOM_ROLE, HR_OPERATOR, '/settings')).toBe(true);
      expect(canAccessRoute(CUSTOM_ROLE, [], '/notifications')).toBe(true);
    });

    /**
     * Found 2026-09-04: `/documents` used to declare no `requiredPermissions` at all, even
     * though the page's own main content fetch (`GET /documents/operations/overview`) has
     * always required `document:view:organization` on the backend — so this exact role, which
     * genuinely holds that permission, was refused a page its own API would have served. Fixed
     * by adding the permission this route's entry was missing; this pins the fix as a positive
     * case, sitting right next to the still-correct fail-closed examples below.
     */
    it('opens branch paperwork once the route names the permission its own API already requires', () => {
      expect(canAccessRoute(CUSTOM_ROLE, HR_OPERATOR, '/documents')).toBe(true);
    });

    it('does not open the billing book, the user list or the audit map it was not granted', () => {
      expect(canAccessRoute(CUSTOM_ROLE, HR_OPERATOR, '/billing')).toBe(false);
      expect(canAccessRoute(CUSTOM_ROLE, HR_OPERATOR, '/users')).toBe(false);
      expect(canAccessRoute(CUSTOM_ROLE, HR_OPERATOR, '/executive-map')).toBe(false);
    });

    /**
     * FAIL CLOSED, and the case worth keeping. These two genuinely name no permission because
     * the API behind each one names none either, so holding a plausible-looking permission still
     * does not open them. Reading "nothing listed" as "nothing required" is the same defect as an
     * allow-by-default fallback, which is how forgetting an entry would publish a page.
     * `/documents` used to be a third example here — see the positive test above for why it
     * moved: its own API always required a permission, this table just hadn't said so.
     */
    it('is refused a page that lists no permissions, even holding the obvious ones', () => {
      expect(canAccessRoute(CUSTOM_ROLE, ['CONFIGURATION:EDIT:PLATFORM'], '/admin/settings')).toBe(false);
      expect(canAccessRoute(CUSTOM_ROLE, ['AUDIT_LOG:VIEW:PLATFORM'], '/admin/logs')).toBe(false);
    });

    it('needs the exact key a page lists, not a neighbour on the same resource', () => {
      // Every entry currently names one permission, so `every` and `some` cannot be told apart
      // from the outside yet; what this pins down is that the match is by whole key. Being
      // granted create/edit/delete on assayers is not being granted the console that reads them.
      expect(canAccessRoute(CUSTOM_ROLE, ['ASSAYER:CREATE:ORGANIZATION'], '/hr')).toBe(false);
      expect(canAccessRoute(CUSTOM_ROLE, ['ASSAYER:VIEW:SELF'], '/hr')).toBe(false);
    });

    it('is matched case-insensitively, since the backend declares these in lower case', () => {
      expect(canAccessRoute(CUSTOM_ROLE, ['assayer:view:organization'], '/hr')).toBe(true);
    });
  });

  /**
   * The permission fallback is for custom roles only — the fix for a real leak.
   *
   * A built-in role that a route deliberately leaves off its `allowedRoles` must not slip in
   * through a permission it holds for an unrelated page. AUDITOR is the reported case: it is not on
   * `/planning`'s list (planning is operations' job) yet it holds `PLANNING:VIEW:ORGANIZATION` for
   * `/executive-map`, which it does own. When the fallback ran for every role, that one shared
   * permission opened `/planning` to AUDITOR by the back door — the shell loaded, the page's own
   * API then 403'd, and the result read as a misleading "no assayers found" empty state. This is
   * the frontend catching up to `RolesGuard`, which already filters to unrecognised roles first.
   */
  describe('the permission fallback is offered to custom roles only', () => {
    it('refuses a built-in role a page it holds the permission for but is not listed on', () => {
      // AUDITOR holds PLANNING:VIEW:ORGANIZATION (widened from its /executive-map grant) but is
      // deliberately absent from /planning's allowedRoles. The permission must not let it in.
      expect(canAccessRoute([SystemRole.AUDITOR], ['PLANNING:VIEW:ORGANIZATION'], '/planning')).toBe(false);
    });

    it('still admits a built-in role that is named on the route, permission or not', () => {
      // OPERATIONS is on /planning's list, so it never reaches the fallback — unaffected.
      expect(canAccessRoute([SystemRole.OPERATIONS], [], '/planning')).toBe(true);
      expect(canAccessRoute([SystemRole.ADMIN], [], '/planning')).toBe(true);
    });

    it('still admits a custom role that genuinely holds the page permission', () => {
      // The fallback is for exactly this principal: a database role granted what the page asks for.
      expect(canAccessRoute(CUSTOM_ROLE, ['PLANNING:VIEW:ORGANIZATION'], '/planning')).toBe(true);
    });

    it('refuses a custom role that does not hold the page permission', () => {
      expect(canAccessRoute(CUSTOM_ROLE, ['ASSAYER:VIEW:ORGANIZATION'], '/planning')).toBe(false);
    });

    /**
     * The mixed principal: a person carrying both a built-in role and a custom one. The presence
     * of the custom role is what re-opens the fallback, so the merged permission set is checked —
     * matching the runtime, where such a person's cache carries both roles' grants together.
     */
    it('offers the fallback to a principal who also holds a custom role', () => {
      const roles = [SystemRole.AUDITOR, ...CUSTOM_ROLE] as unknown as SystemRole[];
      expect(canAccessRoute(roles, ['PLANNING:VIEW:ORGANIZATION'], '/planning')).toBe(true);
    });
  });

  /**
   * The dashboard is the app's floor, but only for the roles that can load it.
   *
   * Its entry lists the six roles that hold `PROJECT:VIEW`, not every role. Listing every role let
   * the name match admit PRODUCT_SUPPORT and ASSAYER — which hold nothing — so `requiredPermissions`
   * was never consulted for them and `defaultRouteFor` sent them to a page whose API 403s, where the
   * dashboard hung on loading skeletons. These pin the floor to the roles that can actually stand
   * on it.
   */
  describe('the operations dashboard', () => {
    it.each([
      SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK,
      SystemRole.DESK_OPERATOR, SystemRole.AUDITOR, SystemRole.CLIENT_USER,
    ])('opens for %s, which holds project:view', (role) => {
      expect(canAccessRoute([role], [], '/dashboard')).toBe(true);
    });

    it.each([
      SystemRole.PRODUCT_SUPPORT, SystemRole.ASSAYER,
    ])('is closed to %s, which holds no project:view and would only see a 403', (role) => {
      expect(canAccessRoute([role], [], '/dashboard')).toBe(false);
    });

    it('still opens for a custom role granted project:view', () => {
      expect(canAccessRoute(CUSTOM_ROLE, ['PROJECT:VIEW:ORGANIZATION'], '/dashboard')).toBe(true);
    });
  });

  /**
   * The data-entry desk is DESK/DESK_OPERATOR's, admins' to run — not the auditor's.
   *
   * AUDITOR used to be listed, but the page fetches a non-head's PERSONAL queue
   * (GET /documents/data-entry/mine, @Roles ADMIN/DESK/DESK_OPERATOR) for anyone who is not a desk
   * head, which 403s an auditor and would be empty even if it did not. Auditor oversight of
   * validation is the dashboard's job, not the desk's working queue.
   */
  describe('the data-entry desk', () => {
    it.each(['/data-entry', '/validation'])('opens %s for the desk roles', (path) => {
      expect(canAccessRoute([SystemRole.ADMIN], [], path)).toBe(true);
      expect(canAccessRoute([SystemRole.DESK], [], path)).toBe(true);
      expect(canAccessRoute([SystemRole.DESK_OPERATOR], [], path)).toBe(true);
    });

    it.each(['/data-entry', '/validation'])('is closed to AUDITOR at %s, whose personal queue fetch 403s', (path) => {
      expect(canAccessRoute([SystemRole.AUDITOR], [], path)).toBe(false);
    });
  });

  describe('a built-in role', () => {
    it('still gets in on its name alone, holding no permissions', () => {
      // The point of keeping the name as a shortcut: nothing that worked before this change
      // depends on a permission row existing.
      for (const rp of ROUTE_PERMISSIONS) {
        for (const role of rp.allowedRoles) {
          expect({ path: rp.path, role, allowed: canAccessRoute([role], [], rp.path) })
            .toEqual({ path: rp.path, role, allowed: true });
        }
      }
    });
  });

  describe('every route the app can render', () => {
    it('has an entry, so nothing is denied by omission', () => {
      /**
       * Read the routes out of App.tsx rather than keeping a copy here.
       *
       * This was a hand-maintained array, and it drifted exactly as you would expect: five
       * pages were added and none of them reached the list, so the test that exists to prove
       * "no page is mounted without a permissions entry" quietly stopped covering the newest
       * pages — the ones most likely to have been forgotten. Parsing the router means the
       * check cannot fall behind it.
       */
      const appSource = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
      const mounted = [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)]
        .map((m) => m[1])
        // '*' is the not-found catch-all, '/' the redirect, and '/login' is deliberately
        // public — it is the one route reached before anyone has a role at all.
        .filter((p) => p !== '*' && p !== '/' && p !== '/login')
        // Child routes of a layout are governed by their parent's entry.
        .filter((p) => p.startsWith('/'));

      expect(mounted.length).toBeGreaterThan(15);

      const declared = new Set(ROUTE_PERMISSIONS.map((rp) => rp.path));
      const undeclared = mounted.filter((p) => {
        if (declared.has(p)) return false;
        // Longest-prefix matching means a sub-path inherits its section's entry.
        return ![...declared].some((d) => p.startsWith(d + '/'));
      });
      expect({ undeclared }).toEqual({ undeclared: [] });
    });

    it('grants the developer everything — implication covers the admin estate, its own name the rest', () => {
      // DEVELOPER ⇒ ADMIN + PRODUCT_SUPPORT (role-hierarchy.ts), so every entry naming any of
      // the three admits it. This is the role with genuinely maximal reach now.
      for (const rp of ROUTE_PERMISSIONS) {
        const routePath = rp.path.replace(':id', 'some-id');
        expect({ path: routePath, allowed: canAccessRoute([SystemRole.DEVELOPER], [], routePath) })
          .toEqual({ path: routePath, allowed: true });
      }
    });

    it('grants a super administrator everything except what the developer split fenced off', () => {
      // Implication runs DEVELOPER → ADMIN, never the reverse: the service logs are the
      // technical estate, and the support desk moved to the people who answer the tickets.
      const CLOSED_TO_ADMIN = ['/admin/logs', '/feedback'];
      for (const rp of ROUTE_PERMISSIONS) {
        const routePath = rp.path.replace(':id', 'some-id');
        const expected = !CLOSED_TO_ADMIN.includes(rp.path);
        expect({ path: routePath, allowed: canAccessRoute([SystemRole.ADMIN], [], routePath) })
          .toEqual({ path: routePath, allowed: expected });
      }
    });

    /**
     * A permission key nobody holds is worse than none at all: the entry reads as though a role
     * could be granted the page, and no role ever can. Shape-checking against the enums catches
     * the plausible typo — a missing scope, a pluralised resource, `MODIFY` where the stored
     * action is `EDIT` — at the point it is written rather than in a support ticket.
     */
    it('names permissions that exist, in the stored RESOURCE:ACTION:SCOPE form', () => {
      const resources = new Set<string>(Object.values(PermissionResource));
      const actions = new Set<string>(Object.values(PermissionAction));
      const scopes = new Set<string>(Object.values(AuthorizationScope));

      const bad: string[] = [];
      for (const rp of ROUTE_PERMISSIONS) {
        for (const key of rp.requiredPermissions ?? []) {
          const [resource, action, scope, ...rest] = key.split(':');
          if (rest.length || !resources.has(resource) || !actions.has(action) || !scopes.has(scope)) {
            bad.push(`${rp.path} → ${key}`);
          }
        }
      }
      expect(bad).toEqual([]);
    });

    /**
     * A redirect that outlives its target's gate is a hole: it lands the visitor on a page the
     * destination's own entry would have refused them.
     */
    it.each([
      ['/validation', '/data-entry'],
      ['/assayers', '/hr'],
    ])('keeps the %s shim in step with %s', (shim, destination) => {
      const entry = (p: string) => ROUTE_PERMISSIONS.find((rp) => rp.path === p)!;
      expect([...(entry(shim).requiredPermissions ?? [])].sort())
        .toEqual([...(entry(destination).requiredPermissions ?? [])].sort());
    });
  });

  /**
   * The DEVELOPER split (2026-09-05): a top role implying ADMIN and PRODUCT_SUPPORT
   * (role-hierarchy.ts), with an exclusive technical estate the implication cannot open in
   * reverse. These pin both directions, and the two-person-rule surfaces the split created.
   */
  describe('the DEVELOPER role and the technical estate', () => {
    it('reaches the admin pages through implication, without being listed on them', () => {
      expect(canAccessRoute([SystemRole.DEVELOPER], [], '/admin/settings')).toBe(true);
      expect(canAccessRoute([SystemRole.DEVELOPER], [], '/users')).toBe(true);
      expect(canAccessRoute([SystemRole.DEVELOPER], [], '/admin/notifications')).toBe(true);
      expect(canAccessRoute([SystemRole.DEVELOPER], [], '/admin/rule-bypass')).toBe(true);
    });

    it('alone reads the service logs — a pure ADMIN is refused the technical estate', () => {
      expect(canAccessRoute([SystemRole.DEVELOPER], [], '/admin/logs')).toBe(true);
      expect(canAccessRoute([SystemRole.ADMIN], [], '/admin/logs')).toBe(false);
    });

    it('shares the support desk with PRODUCT_SUPPORT; ADMIN lost it', () => {
      expect(canAccessRoute([SystemRole.DEVELOPER], [], '/feedback')).toBe(true);
      expect(canAccessRoute([SystemRole.PRODUCT_SUPPORT], [], '/feedback')).toBe(true);
      expect(canAccessRoute([SystemRole.ADMIN], [], '/feedback')).toBe(false);
    });

    /**
     * /admin/approvals is the ADMIN's page — the approve side of the destructive two-person
     * rule. The ROUTE gate is implication-aware, so a developer passes it too and sees the
     * queue; what it cannot do is act, because the page gates approve/reject on the DIRECT
     * role (canApproveDestructiveActions) and the backend refuses a developer's approval
     * regardless. Everyone else is refused at the door.
     */
    it('lets ADMIN and (read-only, by implication) DEVELOPER open the approvals queue', () => {
      expect(canAccessRoute([SystemRole.ADMIN], [], '/admin/approvals')).toBe(true);
      expect(canAccessRoute([SystemRole.DEVELOPER], [], '/admin/approvals')).toBe(true);
      expect(canAccessRoute([SystemRole.OPERATIONS], [], '/admin/approvals')).toBe(false);
      expect(canAccessRoute([SystemRole.AUDITOR], [], '/admin/approvals')).toBe(false);
    });

    it('keeps the developer pages closed to a custom role, whatever it holds', () => {
      // Both entries deliberately declare no permission — the estate is not grantable from the
      // role editor, so the fail-closed rule refuses every permission set.
      expect(canAccessRoute(CUSTOM_ROLE, ['CONFIGURATION:EDIT:PLATFORM', 'AUDIT_LOG:VIEW:PLATFORM'], '/admin/logs')).toBe(false);
      expect(canAccessRoute(CUSTOM_ROLE, ['CONFIGURATION:EDIT:PLATFORM'], '/admin/approvals')).toBe(false);
    });
  });
});

/**
 * Where a person lands after signing in.
 *
 * The old chain of `if`s had rotted where a role consolidation had rewritten each branch in
 * place: ADMIN was tested twice, four consecutive branches all tested OPERATIONS so only the
 * first could fire, and DESK appeared twice in one condition. Every unrecognised role fell
 * through to `/dashboard`, which is exactly how the incident presented — a clerk on a page they
 * could open and could not load.
 */
describe('defaultRouteFor', () => {
  it.each([
    [SystemRole.DEVELOPER, '/dashboard'],
    [SystemRole.ADMIN, '/dashboard'],
    [SystemRole.OPERATIONS, '/executive-map'],
    [SystemRole.DESK, '/documents'],
    [SystemRole.DESK_OPERATOR, '/data-entry'],
  ])('lands %s on its own home', (role, expected) => {
    expect(defaultRouteFor([role], [])).toBe(expected);
  });

  it('lands product support on the desk it works, not its notification inbox', () => {
    // /feedback opened to PRODUCT_SUPPORT with the developer split and joined LANDING_ORDER;
    // before that the role fell through to /notifications — a page about the work, not the work.
    expect(defaultRouteFor([SystemRole.PRODUCT_SUPPORT], [])).toBe('/feedback');
  });

  it('lands a workforce role built in the admin screen on the workforce console', () => {
    expect(defaultRouteFor(CUSTOM_ROLE, ['ASSAYER:VIEW:ORGANIZATION'])).toBe('/hr');
  });

  it('lands a read-only auditor on the overview it can read', () => {
    expect(defaultRouteFor([SystemRole.AUDITOR], [])).toBe('/dashboard');
  });

  it.each([
    SystemRole.PRODUCT_SUPPORT,
    SystemRole.ASSAYER,
  ])('does not strand %s on a dashboard whose data it cannot load', (role) => {
    const landing = defaultRouteFor([role], []);
    expect(landing).not.toBe('/dashboard');
    expect(canAccessRoute([role], [], landing)).toBe(true);
  });

  it('never returns a page the person cannot open', () => {
    const everyRole: SystemRole[][] = Object.values(SystemRole).map((r) => [r]);
    const cases: [SystemRole[], string[]][] = [
      ...everyRole.map((roles) => [roles, []] as [SystemRole[], string[]]),
      [[], []],
      [CUSTOM_ROLE, ['ASSAYER:VIEW:ORGANIZATION']],
      [CUSTOM_ROLE, ['BILLING:VIEW:ORGANIZATION']],
      [CUSTOM_ROLE, ['VALIDATION:VIEW:ORGANIZATION']],
    ];
    for (const [roles, permissions] of cases) {
      const landing = defaultRouteFor(roles, permissions);
      expect({ roles, landing, reachable: canAccessRoute(roles, permissions, landing) })
        .toEqual({ roles, landing, reachable: true });
    }
  });

  /**
   * The specific failure the owner reported: a role with no dashboard grant was sent to the
   * dashboard anyway, which then answered 403 and offered a Retry that could only fail again.
   */
  it('does not send someone to the dashboard when the dashboard is closed to them', () => {
    expect(defaultRouteFor(CUSTOM_ROLE, ['ASSAYER:VIEW:ORGANIZATION'])).not.toBe('/dashboard');
    expect(defaultRouteFor([], [])).not.toBe('/dashboard');
  });

  it('still answers with something usable for an account granted nothing at all', () => {
    const landing = defaultRouteFor([], []);
    expect(canAccessRoute([], [], landing)).toBe(true);
  });
});
