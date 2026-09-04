import { readFileSync } from 'fs';
import { join } from 'path';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, ROLES_KEY, PERMISSIONS_KEY, ROLE_ONLY_KEY } from '../../auth/guards';

/**
 * `enable()`/`disable()` must stay reachable by the ADMIN role ONLY — never by a custom role
 * (a database row built in Admin -> Roles) that merely holds `configuration:edit:platform`.
 *
 * Confirmed LIVE, 2026-09-04, before this suite existed: a role holding nothing but
 * `configuration:edit:platform` — created and granted exactly the way any admin would in the
 * Roles screen, nothing special about it — called `POST /admin/rule-bypass` and
 * `DELETE /admin/rule-bypass` directly and both succeeded (HTTP 201 / 200), suspending and then
 * restoring CLIENT_ELIGIBILITY platform-wide. No ADMIN role anywhere on the account. See
 * `RELAY/findings/L.md` for the full repro (role QATRACK_L_CONFIG_EDITOR, user
 * qatrack-l-configeditor).
 *
 * Root cause: `enable()`/`disable()` pair `@Roles(SystemRole.ADMIN)` with `@RequirePermissions
 * ('configuration:edit:platform')` — the same shape as nearly every other admin-gated route in
 * this app, which is EXACTLY what makes a route reachable by a custom role holding the matching
 * permission (`RolesGuard`'s fallback branch, covered generically for the wanted case in
 * `../auth/custom-role-access.spec.ts`). That fallback is correct and intended almost
 * everywhere — it is the whole reason a role built in Admin -> Roles means anything. This one
 * route is the documented exception: its own comment says access must ride on the ADMIN role
 * itself, "not gated on a permission string," specifically because a bypass window suspends
 * geofencing, distance policy and every other operational control at once. `@RoleOnly()` is the
 * decorator that makes that comment true; this suite pins it.
 *
 * Two layers, both needed:
 *  1. A behavioural test proves `RolesGuard` actually refuses this shape of caller when
 *     `ROLE_ONLY_KEY` is set — using the same map-mocked `Reflector` convention as
 *     `custom-role-access.spec.ts` and `guards.spec.ts`, not a re-implementation of the guard.
 *  2. A source check confirms `@RoleOnly()` decorates the real `enable`/`disable` handlers in the
 *     real controller file — because (1) alone would keep passing even if someone deleted the
 *     decorator from the source, as long as no test recomputed what the route actually declares.
 */
describe('RuleBypassController — enable/disable resist the custom-role permission fallback', () => {
  const ctx = (user: any): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  }) as any;

  const reflectorReturning = (map: Record<string, any>) =>
    ({ getAllAndOverride: (key: string) => map[key] }) as unknown as Reflector;

  /** Shaped exactly like the real QATRACK_L_CONFIG_EDITOR role used in the live repro. */
  const configEditorOnly = {
    id: 'u-config-editor',
    roles: [{
      name: 'QATRACK_L_CONFIG_EDITOR',
      permissions: [{ resource: 'CONFIGURATION', action: 'EDIT', scope: 'PLATFORM' }],
    }],
  };

  const admin = { id: 'u-admin', roles: [{ name: 'ADMIN', permissions: [] }] };

  /** The metadata `enable()`/`disable()` carry as of this fix. */
  const ROUTE_AS_FIXED = {
    [ROLES_KEY]: ['ADMIN'],
    [PERMISSIONS_KEY]: ['configuration:edit:platform'],
    [ROLE_ONLY_KEY]: true,
  };

  it('refuses a custom role holding only configuration:edit:platform', () => {
    const guard = new RolesGuard(reflectorReturning(ROUTE_AS_FIXED));
    expect(() => guard.canActivate(ctx(configEditorOnly))).toThrow(ForbiddenException);
  });

  it('still admits ADMIN by name, unaffected by the fix', () => {
    const guard = new RolesGuard(reflectorReturning(ROUTE_AS_FIXED));
    expect(guard.canActivate(ctx(admin))).toBe(true);
  });

  it(
    'sanity check: the exact same custom role WOULD have gotten in without @RoleOnly — proving ' +
      'the two tests above are actually exercising the decorator, not passing for an unrelated reason',
    () => {
      const routeWithoutRoleOnly = {
        [ROLES_KEY]: ['ADMIN'],
        [PERMISSIONS_KEY]: ['configuration:edit:platform'],
        // No ROLE_ONLY_KEY — this is the pre-fix shape, reproducing the live finding.
      };
      const guard = new RolesGuard(reflectorReturning(routeWithoutRoleOnly));
      expect(guard.canActivate(ctx(configEditorOnly))).toBe(true);
    },
  );

  it(
    'catalogue()/history() are deliberately left reachable via configuration:view:platform — ' +
      'this fix must not spread there too',
    () => {
      // route-permissions.ts (frontend) documents this as intended: "the backend's own catalogue
      // and history routes ask for configuration:view:platform and will answer a role that holds
      // it. Withholding the page from someone the API already serves hides the screen, not the
      // capability." Reading which rules exist and who has bypassed what before is not the same
      // capability as suspending the platform's controls.
      const readRoute = {
        [ROLES_KEY]: ['ADMIN'],
        [PERMISSIONS_KEY]: ['configuration:view:platform'],
        // No ROLE_ONLY_KEY on catalogue()/history() — confirmed against the source below too.
      };
      const guard = new RolesGuard(reflectorReturning(readRoute));
      const viewerOnly = {
        id: 'u-viewer',
        roles: [{
          name: 'QATRACK_L_VIEWER',
          permissions: [{ resource: 'CONFIGURATION', action: 'VIEW', scope: 'PLATFORM' }],
        }],
      };
      expect(guard.canActivate(ctx(viewerOnly))).toBe(true);
    },
  );

  describe('the real controller file', () => {
    const source = readFileSync(join(__dirname, 'rule-bypass.controller.ts'), 'utf8');

    /**
     * The decorator block immediately above a given handler's `async name(` line.
     *
     * Line-based, walking backward to the nearest two-space-indented lone `}` — the end of the
     * PREVIOUS method — rather than a raw string `lastIndexOf('}', ...)`, which lands on the
     * nearest brace by character position and is fooled by a nested object literal in a prior
     * method's own return statement (`catalogue()` returns `{ rules: ..., defaultHours: ... }`,
     * whose inner `}` sits closer to `enable`'s decorators than the method's own closing brace
     * does). Same technique `route-permission-parity.spec.ts` already uses for the same reason.
     */
    const decoratorsAbove = (handlerName: string): string => {
      const lines = source.split('\n');
      const target = lines.findIndex((l) => l.includes(`async ${handlerName}(`));
      expect(target).toBeGreaterThan(-1); // the handler must exist at all

      let start = 0;
      for (let i = target - 1; i >= 0; i--) {
        if (/^ {2}\}\s*$/.test(lines[i]) || /^export class /.test(lines[i])) {
          start = i + 1;
          break;
        }
      }
      return lines.slice(start, target).join('\n');
    };

    it('enable() is decorated with @RoleOnly()', () => {
      expect(decoratorsAbove('enable')).toMatch(/@RoleOnly\(\)/);
    });

    it('disable() is decorated with @RoleOnly()', () => {
      expect(decoratorsAbove('disable')).toMatch(/@RoleOnly\(\)/);
    });

    it('catalogue() and history() are NOT decorated with @RoleOnly() (unchanged, intended reach)', () => {
      expect(decoratorsAbove('catalogue')).not.toMatch(/@RoleOnly\(\)/);
      expect(decoratorsAbove('history')).not.toMatch(/@RoleOnly\(\)/);
    });

    it('enable() and disable() still declare @Roles(SystemRole.ADMIN) and the permission, unchanged', () => {
      for (const handler of ['enable', 'disable']) {
        const block = decoratorsAbove(handler);
        expect(block).toMatch(/@Roles\(SystemRole\.ADMIN\)/);
        expect(block).toMatch(/@RequirePermissions\('configuration:edit:platform'\)/);
      }
    });
  });
});
