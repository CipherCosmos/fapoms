import { readFileSync } from 'fs';
import { join } from 'path';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, ROLES_KEY, PERMISSIONS_KEY, ROLE_ONLY_KEY } from '../auth/guards';

/**
 * `update()`, `reset()`, `testEmail()` and `runDigest()` must stay reachable by the role each
 * one names ONLY — never by a custom role (a database row built in Admin -> Roles) that merely
 * holds the matching permission. See the class-level comment on `NotificationAdminController`
 * for the full story: the platform owner's own instruction was "visible to the super
 * administrator and nobody else," and every write here pairs `@Roles` with `@RequirePermissions`
 * — the shape that makes a route reachable by ANY role holding that one permission via
 * `RolesGuard`'s custom-role fallback, "nobody else" notwithstanding.
 *
 * Since 2026-09-05 the four writes are two audiences (see the controller's amended class
 * comment): `update`/`reset` are business messaging policy and keep `@Roles(ADMIN)` +
 * `configuration:edit:platform`; `testEmail`/`runDigest` are the developer's transport
 * plumbing — `@Roles(DEVELOPER)` (one-way: an administrator does not pass) +
 * `system:edit:platform`. Both shapes keep `@RoleOnly()`, which is what this suite pins.
 *
 * Confirmed LIVE, 2026-09-04, before this suite existed: a role holding nothing but
 * `configuration:edit:platform` (role QATRACK_L_CONFIG_EDITOR, user qatrack-l-configeditor —
 * the same account that opened the rule-bypass window in the sibling finding, see
 * `../platform/rule-bypass/rule-bypass.controller.spec.ts`) called, and succeeded on:
 *   - PUT /notification-admin/catalog/EXPENSE_CLAIMED  (200 — rewrote a live routing rule)
 *   - DELETE /notification-admin/catalog/EXPENSE_CLAIMED  (200)
 *   - POST /notification-admin/email/test  (201 — sent a real email through the real transport)
 *   - POST /notification-admin/digest/run  (201 — and this one was not a drill: it queued and
 *     ran the real morning digest job, which sent a real, unscheduled, duplicate digest email to
 *     6 real candidate recipients, confirmed in `docker logs fapoms-backend`:
 *     "Morning digest: 6 sent, 0 failed, 6 candidate recipient(s)" immediately after the probe,
 *     on top of the legitimate scheduled run's "5 sent" earlier the same morning)
 * See `RELAY/findings/L.md` for the full repro. `GET /notification-admin/catalog` was and
 * remains correctly refused (403) — it declares no `@RequirePermissions` at all, so it was
 * never reachable by the fallback; this suite pins that it stays that way too.
 *
 * Two layers, both needed — see the sibling rule-bypass suite for why one alone is not enough:
 *  1. Behavioural: `RolesGuard` actually refuses this caller shape once `ROLE_ONLY_KEY` is set,
 *     using the same map-mocked `Reflector` convention as `../auth/custom-role-access.spec.ts`.
 *  2. Source: `@RoleOnly()` genuinely decorates the four real handlers in the real file, so a
 *     future edit that drops the decorator fails this suite, not just a re-derived mock.
 */
describe('NotificationAdminController — mutating routes resist the custom-role permission fallback', () => {
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
  const developer = { id: 'u-dev', roles: [{ name: 'DEVELOPER', permissions: [] }] };

  /** The metadata the two catalog writes (`update`/`reset`) carry as of this fix. */
  const ROUTE_AS_FIXED = {
    [ROLES_KEY]: ['ADMIN'],
    [PERMISSIONS_KEY]: ['configuration:edit:platform'],
    [ROLE_ONLY_KEY]: true,
  };

  /** The metadata the two transport routes (`testEmail`/`runDigest`) carry since 2026-09-05. */
  const TRANSPORT_ROUTE = {
    [ROLES_KEY]: ['DEVELOPER'],
    [PERMISSIONS_KEY]: ['system:edit:platform'],
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
      'the two tests above exercise the decorator, not an unrelated reason',
    () => {
      const routeWithoutRoleOnly = {
        [ROLES_KEY]: ['ADMIN'],
        [PERMISSIONS_KEY]: ['configuration:edit:platform'],
        // No ROLE_ONLY_KEY — the pre-fix shape, reproducing the live finding.
      };
      const guard = new RolesGuard(reflectorReturning(routeWithoutRoleOnly));
      expect(guard.canActivate(ctx(configEditorOnly))).toBe(true);
    },
  );

  describe('the transport routes (email/test, digest/run) since the 2026-09-05 developer split', () => {
    it('admits DEVELOPER by name', () => {
      const guard = new RolesGuard(reflectorReturning(TRANSPORT_ROUTE));
      expect(guard.canActivate(ctx(developer))).toBe(true);
    });

    it('refuses ADMIN — implication is one-way, and @RoleOnly() closes the permission door', () => {
      // An administrator holding even the exact matching grant does not pass: DEVELOPER is not
      // implied by ADMIN, and the fallback that would have judged the grant is disabled.
      const adminWithGrant = {
        id: 'u-admin-2',
        roles: [{ name: 'ADMIN', permissions: [{ resource: 'SYSTEM', action: 'EDIT', scope: 'PLATFORM' }] }],
      };
      const guard = new RolesGuard(reflectorReturning(TRANSPORT_ROUTE));
      expect(() => guard.canActivate(ctx(adminWithGrant))).toThrow(ForbiddenException);
    });

    it('refuses a custom role holding only system:edit:platform, same as the catalog writes', () => {
      const systemEditorOnly = {
        id: 'u-system-editor',
        roles: [{ name: 'QATRACK_SYSTEM_EDITOR', permissions: [{ resource: 'SYSTEM', action: 'EDIT', scope: 'PLATFORM' }] }],
      };
      const guard = new RolesGuard(reflectorReturning(TRANSPORT_ROUTE));
      expect(() => guard.canActivate(ctx(systemEditorOnly))).toThrow(ForbiddenException);
    });
  });

  describe('the real controller file', () => {
    const source = readFileSync(join(__dirname, 'notification-admin.controller.ts'), 'utf8');

    /**
     * The decorator block immediately above a given handler's `async name(` line — line-based,
     * walking backward to the nearest two-space-indented lone `}` (the end of the previous
     * method). Same technique as the sibling rule-bypass suite and
     * `../auth/route-permission-parity.spec.ts`, for the same reason: a raw
     * `lastIndexOf('}', ...)` is fooled by a nested object literal in a prior method's own body.
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

    it.each(['update', 'reset', 'testEmail', 'runDigest'])('%s() is decorated with @RoleOnly()', (handler) => {
      expect(decoratorsAbove(handler)).toMatch(/@RoleOnly\(\)/);
    });

    it.each(['update', 'reset'])(
      '%s() still declares ADMIN and @RequirePermissions(\'configuration:edit:platform\') — business messaging policy, unchanged',
      (handler) => {
        const block = decoratorsAbove(handler);
        expect(block).toMatch(/@Roles\(\.\.\.NOTIFICATION_ADMIN_ROLES\)/);
        expect(block).toMatch(/@RequirePermissions\('configuration:edit:platform'\)/);
      },
    );

    it.each(['testEmail', 'runDigest'])(
      '%s() declares DEVELOPER and @RequirePermissions(\'system:edit:platform\') — transport plumbing since 2026-09-05',
      (handler) => {
        const block = decoratorsAbove(handler);
        expect(block).toMatch(/@Roles\(SystemRole\.DEVELOPER\)/);
        expect(block).toMatch(/@RequirePermissions\('system:edit:platform'\)/);
        expect(block).not.toMatch(/configuration:edit:platform/);
      },
    );

    it('catalog(), emailStatus() and preview() need no @RoleOnly() — they declare no @RequirePermissions at all', () => {
      // These three inherit only the class-level @Roles(ADMIN) and name no permission, so
      // RolesGuard's fail-closed rule already refuses any role it does not name by name — the
      // fallback branch never activates for lack of anything to check. Confirmed live: GET
      // /notification-admin/catalog 403'd for the config-editor-only role throughout this
      // investigation, before and after the fix below.
      for (const handler of ['catalog', 'emailStatus', 'preview']) {
        const block = decoratorsAbove(handler);
        expect(block).not.toMatch(/@RequirePermissions\(/);
        expect(block).not.toMatch(/@RoleOnly\(\)/);
      }
    });
  });
});
