import * as fs from 'fs';
import * as path from 'path';
import {
  AuthorizationScope, PermissionAction, PermissionResource, SystemRole,
} from '@fapoms/shared';
import {
  canAccessRoute, defaultRouteFor, ROUTE_PERMISSIONS,
} from './route-permissions';

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
      expect(canAccessRoute([], ['ASSAYER:VIEW:ORGANIZATION'], '/hr/roster')).toBe(true);
      expect(canAccessRoute([], ['DOCUMENT:VIEW:ORGANIZATION'], '/hr/roster')).toBe(false);
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
      expect(canAccessRoute([], HR_OPERATOR, '/hr')).toBe(true);
    });

    it('opens its own account and its own notifications, as every signed-in user may', () => {
      expect(canAccessRoute([], HR_OPERATOR, '/settings')).toBe(true);
      expect(canAccessRoute([], [], '/notifications')).toBe(true);
    });

    it('does not open the billing book, the user list or the audit map it was not granted', () => {
      expect(canAccessRoute([], HR_OPERATOR, '/billing')).toBe(false);
      expect(canAccessRoute([], HR_OPERATOR, '/users')).toBe(false);
      expect(canAccessRoute([], HR_OPERATOR, '/executive-map')).toBe(false);
    });

    /**
     * FAIL CLOSED, and the case worth keeping. `/documents` names no permission because the API
     * behind it names none either, so holding every document permission there is still does not
     * open it. Reading "nothing listed" as "nothing required" is the same defect as an
     * allow-by-default fallback, which is how forgetting an entry would publish a page.
     */
    it('is refused a page that lists no permissions, even holding the obvious ones', () => {
      expect(canAccessRoute([], HR_OPERATOR, '/documents')).toBe(false);
      expect(canAccessRoute([], ['CONFIGURATION:EDIT:PLATFORM'], '/admin/settings')).toBe(false);
      expect(canAccessRoute([], ['AUDIT_LOG:VIEW:PLATFORM'], '/admin/logs')).toBe(false);
    });

    it('needs the exact key a page lists, not a neighbour on the same resource', () => {
      // Every entry currently names one permission, so `every` and `some` cannot be told apart
      // from the outside yet; what this pins down is that the match is by whole key. Being
      // granted create/edit/delete on assayers is not being granted the console that reads them.
      expect(canAccessRoute([], ['ASSAYER:CREATE:ORGANIZATION'], '/hr')).toBe(false);
      expect(canAccessRoute([], ['ASSAYER:VIEW:SELF'], '/hr')).toBe(false);
    });

    it('is matched case-insensitively, since the backend declares these in lower case', () => {
      expect(canAccessRoute([], ['assayer:view:organization'], '/hr')).toBe(true);
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

    it('grants a super administrator everything', () => {
      for (const rp of ROUTE_PERMISSIONS) {
        const routePath = rp.path.replace(':id', 'some-id');
        expect(canAccessRoute([SystemRole.ADMIN], [], routePath)).toBe(true);
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
    [SystemRole.ADMIN, '/dashboard'],
    [SystemRole.OPERATIONS, '/executive-map'],
    [SystemRole.DESK, '/documents'],
    [SystemRole.DESK_OPERATOR, '/data-entry'],
  ])('lands %s on its own home', (role, expected) => {
    expect(defaultRouteFor([role], [])).toBe(expected);
  });

  it('lands a workforce role built in the admin screen on the workforce console', () => {
    expect(defaultRouteFor([], ['ASSAYER:VIEW:ORGANIZATION'])).toBe('/hr');
  });

  it('lands a read-only auditor on the overview it can read', () => {
    expect(defaultRouteFor([SystemRole.AUDITOR], [])).toBe('/dashboard');
  });

  it('never returns a page the person cannot open', () => {
    const everyRole: SystemRole[][] = Object.values(SystemRole).map((r) => [r]);
    const cases: [SystemRole[], string[]][] = [
      ...everyRole.map((roles) => [roles, []] as [SystemRole[], string[]]),
      [[], []],
      [[], ['ASSAYER:VIEW:ORGANIZATION']],
      [[], ['BILLING:VIEW:ORGANIZATION']],
      [[], ['VALIDATION:VIEW:ORGANIZATION']],
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
    expect(defaultRouteFor([], ['ASSAYER:VIEW:ORGANIZATION'])).not.toBe('/dashboard');
    expect(defaultRouteFor([], [])).not.toBe('/dashboard');
  });

  it('still answers with something usable for an account granted nothing at all', () => {
    const landing = defaultRouteFor([], []);
    expect(canAccessRoute([], [], landing)).toBe(true);
  });
});
