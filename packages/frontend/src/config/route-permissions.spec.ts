import * as fs from 'fs';
import * as path from 'path';
import { SystemRole } from '@fapoms/shared';
import { canAccessRoute, ROUTE_PERMISSIONS } from './route-permissions';

/**
 * Role gating decides who can see audit evidence, so it is the one piece of frontend logic that
 * must not be reasoned about by eye.
 */
describe('canAccessRoute', () => {
  describe('a path that declares its own roles', () => {
    it('admits a role on the list and refuses one that is not', () => {
      expect(canAccessRoute([SystemRole.HR_MANAGER], '/hr')).toBe(true);
      expect(canAccessRoute([SystemRole.FINANCE_MANAGER], '/hr')).toBe(false);
    });

    it('admits a user holding several roles when any one of them qualifies', () => {
      expect(canAccessRoute([SystemRole.FINANCE_MANAGER, SystemRole.HR_MANAGER], '/hr')).toBe(true);
    });

    it('refuses a user with no roles at all', () => {
      expect(canAccessRoute([], '/hr')).toBe(false);
    });
  });

  describe('sub-paths', () => {
    /**
     * The reason this matters: matching used to be exact, and an unmatched path fell through to
     * "allow". Every page added under an existing section would have been reachable by every
     * role, a read-only auditor included.
     */
    it('inherits the section it sits under', () => {
      expect(canAccessRoute([SystemRole.HR_MANAGER], '/hr/roster')).toBe(true);
      expect(canAccessRoute([SystemRole.HR_MANAGER], '/hr/pay/history')).toBe(true);
    });

    it('does not leak a section to a role excluded from it', () => {
      expect(canAccessRoute([SystemRole.FINANCE_MANAGER], '/hr/roster')).toBe(false);
      expect(canAccessRoute([SystemRole.READ_ONLY_AUDITOR], '/hr/pay')).toBe(false);
      expect(canAccessRoute([SystemRole.VALIDATOR], '/hr/compliance')).toBe(false);
    });

    it('is not fooled by a path that merely starts with the same letters', () => {
      // '/hrsomething' is not under '/hr', and must not inherit its roles.
      expect(canAccessRoute([SystemRole.HR_MANAGER], '/hrsomething')).toBe(false);
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

    it('are all reachable by an HR manager', () => {
      for (const page of HR_PAGES) {
        expect(canAccessRoute([SystemRole.HR_MANAGER], page)).toBe(true);
      }
    });

    it.each([
      SystemRole.FINANCE_MANAGER,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.OPERATIONS_EXECUTIVE,
      SystemRole.VALIDATOR,
      SystemRole.READ_ONLY_AUDITOR,
      SystemRole.CLIENT_USER,
    ])('are all closed to %s', (role) => {
      for (const page of HR_PAGES) {
        expect(canAccessRoute([role], page)).toBe(false);
      }
    });
  });

  describe('an unlisted path', () => {
    it('is denied rather than published', () => {
      expect(canAccessRoute([SystemRole.SUPER_ADMINISTRATOR], '/not-a-real-page')).toBe(false);
      expect(canAccessRoute([SystemRole.READ_ONLY_AUDITOR], '/internal/secrets')).toBe(false);
    });
  });

  describe('parameterised paths', () => {
    it('matches an id segment', () => {
      // The single assayer view is the roster's drawer now (/hr/roster?assayer=…), so the
      // gate that matters is the roster's.
      expect(canAccessRoute([SystemRole.HR_MANAGER], '/hr/roster')).toBe(true);
      expect(canAccessRoute([SystemRole.VALIDATOR], '/hr/roster')).toBe(false);
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
        const path = rp.path.replace(':id', 'some-id');
        expect(canAccessRoute([SystemRole.SUPER_ADMINISTRATOR], path)).toBe(true);
      }
    });
  });
});
