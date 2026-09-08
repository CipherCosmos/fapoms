import { readFileSync } from 'fs';
import { join } from 'path';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, ROLES_KEY, PERMISSIONS_KEY, ROLE_ONLY_KEY, ALLOW_PERMISSION_FALLBACK_KEY } from '../../modules/auth/guards';
import { PlatformSettingsController } from './platform-settings.controller';
import { SETTINGS_GROUPS } from './settings.registry';

/**
 * `set()`/`reset()` (`PUT`/`DELETE /platform-settings/:key`) must stay reachable by the ADMIN
 * role ONLY — never by a custom role that merely holds `configuration:edit:platform`.
 *
 * Confirmed LIVE, 2026-09-04, before this suite existed: a role holding nothing but
 * `configuration:edit:platform` wrote and reset a real setting (`digest.cron`) with no ADMIN
 * role on the account — the same shape as the two sibling fixes this session
 * (`rule-bypass.controller.ts`, `notification-admin.controller.ts`; see `RELAY/findings/L.md`
 * and `RELAY/handoffs/L.md`). This file's own docstring says writing is "administrators only,
 * because these values price work and address mail for the whole organisation" — `@RoleOnly()`
 * is what makes that true against the custom-role permission fallback.
 *
 * Two layers, both needed — same reasoning as `rule-bypass.controller.spec.ts`, which this
 * mirrors closely:
 *  1. A behavioural test proves `RolesGuard` actually refuses this shape of caller when
 *     `ROLE_ONLY_KEY` is set.
 *  2. A source check confirms `@RoleOnly()` decorates the real `set`/`reset` handlers in the
 *     real controller file, so deleting the decorator would fail this suite even though the
 *     behavioural test alone would not notice.
 */
describe('PlatformSettingsController — set/reset resist the custom-role permission fallback', () => {
  const ctx = (user: any): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  }) as any;

  const reflectorReturning = (map: Record<string, any>) =>
    ({ getAllAndOverride: (key: string) => map[key] }) as unknown as Reflector;

  /** Shaped like Track L's live QATRACK_L_CONFIG_EDITOR probe role. */
  const configEditorOnly = {
    id: 'u-config-editor',
    roles: [{
      name: 'QATRACK_L_CONFIG_EDITOR',
      permissions: [{ resource: 'CONFIGURATION', action: 'EDIT', scope: 'PLATFORM' }],
    }],
  };

  const admin = { id: 'u-admin', roles: [{ name: 'ADMIN', permissions: [] }] };

  /** The metadata `set()`/`reset()` carry as of this fix. */
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
    'sanity check: the exact same custom role WOULD have gotten in if fallback were enabled — proving ' +
      'the two tests above are actually exercising the decorator, not passing for an unrelated reason',
    () => {
      const routeWithExplicitFallback = {
        [ROLES_KEY]: ['ADMIN'],
        [PERMISSIONS_KEY]: ['configuration:edit:platform'],
        [ALLOW_PERMISSION_FALLBACK_KEY]: true,
      };
      const guard = new RolesGuard(reflectorReturning(routeWithExplicitFallback));
      expect(guard.canActivate(ctx(configEditorOnly))).toBe(true);

      const routeWithoutFallback = {
        [ROLES_KEY]: ['ADMIN'],
        [PERMISSIONS_KEY]: ['configuration:edit:platform'],
      };
      const guardStrict = new RolesGuard(reflectorReturning(routeWithoutFallback));
      expect(() => guardStrict.canActivate(ctx(configEditorOnly))).toThrow(ForbiddenException);
    },
  );

  describe('the real controller file', () => {
    const source = readFileSync(join(__dirname, 'platform-settings.controller.ts'), 'utf8');

    /**
     * The decorator block immediately above a given handler's `async name(` line. Same
     * line-walking technique `rule-bypass.controller.spec.ts` uses, for the same reason: a raw
     * `lastIndexOf('}', ...)` is fooled by an object literal inside a prior method's own body.
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

    it('set() is decorated with @RoleOnly()', () => {
      expect(decoratorsAbove('set')).toMatch(/@RoleOnly\(\)/);
    });

    it('reset() is decorated with @RoleOnly()', () => {
      expect(decoratorsAbove('reset')).toMatch(/@RoleOnly\(\)/);
    });

    it('set() and reset() still declare the ADMIN role and the permission, unchanged', () => {
      for (const handler of ['set', 'reset']) {
        const block = decoratorsAbove(handler);
        expect(block).toMatch(/@Roles\(\.\.\.SETTINGS_ADMIN_ROLES\)/);
        expect(block).toMatch(/@RequirePermissions\('configuration:edit:platform'\)/);
      }
    });

    it('findAll()/limits() are NOT decorated with @RoleOnly() (unchanged, intended reach)', () => {
      // findAll() is the class-level-gated read (ADMIN/OPERATIONS/AUDITOR); limits() is
      // deliberately @AnyAuthenticated — neither is a write, and this fix must not spread to either.
      expect(decoratorsAbove('findAll')).not.toMatch(/@RoleOnly\(\)/);
      expect(decoratorsAbove('limits')).not.toMatch(/@RoleOnly\(\)/);
    });
  });
});

/**
 * The read half of the 2026-09-05 technical/business split: what `GET /platform-settings`
 * shows each kind of caller. The write half (the per-key fence) is proven in
 * `platform-settings.service.spec.ts`; this proves the screen never offers a knob the fence
 * would refuse — a pure administrator sees business-audience groups and keys only, a developer
 * sees everything, and the narrow single-group readers (AUDITOR) are exactly as they were.
 */
describe('PlatformSettingsController.findAll — the audience split', () => {
  // One key per interesting case: a technical group, a business group, the technical override
  // inside a business group, and the AUDITOR-readable transport group. Real registry keys, so
  // audienceOfSetting resolves them exactly as production does.
  const described = [
    { key: 'email.from', group: 'email' },
    { key: 'fees.platformBaseFee', group: 'fees' },
    { key: 'billing.assayerInvoicingEnabled', group: 'billing' },
    { key: 'transport.avgSpeedKmh.CAR', group: 'transport' },
  ];

  const controller = new PlatformSettingsController(
    { describeAll: jest.fn(async () => described) } as any,
    {} as any,
  );

  const reqWithRoles = (...names: string[]) => ({ user: { roles: names.map((name) => ({ name })) } });
  const keysOf = (data: any) => data.settings.map((s: any) => s.key);
  const groupKeysOf = (data: any) => data.groups.map((g: any) => g.key);

  it('a pure administrator sees the business groups and business keys only', async () => {
    const { data } = await controller.findAll(reqWithRoles('ADMIN'));

    expect(groupKeysOf(data)).toEqual(
      SETTINGS_GROUPS.filter((g) => g.audience === 'business').map((g) => g.key),
    );
    // The billing group is shown, but the technical rollout flag parked inside it is not.
    expect(groupKeysOf(data)).toContain('billing');
    expect(keysOf(data)).toEqual(['fees.platformBaseFee', 'transport.avgSpeedKmh.CAR']);
  });

  it('a developer sees every group and every key', async () => {
    const { data } = await controller.findAll(reqWithRoles('DEVELOPER'));

    expect(groupKeysOf(data)).toEqual(SETTINGS_GROUPS.map((g) => g.key));
    expect(keysOf(data)).toEqual(described.map((s) => s.key));
  });

  it('a migrated administrator holding both names is treated as the developer, not the admin', async () => {
    // DEVELOPER is checked BEFORE ADMIN in the controller — order is the point of this test.
    const { data } = await controller.findAll(reqWithRoles('ADMIN', 'DEVELOPER'));

    expect(keysOf(data)).toContain('email.from');
    expect(keysOf(data)).toContain('billing.assayerInvoicingEnabled');
  });

  it('AUDITOR still reads exactly the transport group, unchanged by the split', async () => {
    const { data } = await controller.findAll(reqWithRoles('AUDITOR'));

    expect(groupKeysOf(data)).toEqual(['transport']);
    expect(keysOf(data)).toEqual(['transport.avgSpeedKmh.CAR']);
  });

  it('OPERATIONS still reads no groups at all, unchanged by the split', async () => {
    const { data } = await controller.findAll(reqWithRoles('OPERATIONS'));

    expect(data.groups).toEqual([]);
    expect(data.settings).toEqual([]);
  });
});
