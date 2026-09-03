import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, ROLES_KEY, PERMISSIONS_KEY, ANY_AUTHENTICATED_KEY } from './guards';

/**
 * A role built in Admin → Roles can reach what its permissions say it can.
 *
 * Every route names the built-in roles it serves — `@Roles(ADMIN, OPERATIONS)` — and that list is
 * a closed set written in code. A role created in the admin screen is a database row with no entry
 * in `SystemRole`, so its name matched nothing and `RolesGuard` refused it before
 * `PermissionsGuard` ever saw the permissions somebody had deliberately attached. The screen
 * offered a role builder that could not grant access to anything, and said "Insufficient role
 * permissions" while the permissions sat in the database.
 *
 * The name is now a shortcut rather than the whole rule. What this suite has to hold is that it is
 * only a shortcut — that widening the door did not also unlatch it.
 */
describe('a role the route has never heard of', () => {
  const ctx = (user: any): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  }) as any;

  const reflectorReturning = (map: Record<string, any>) =>
    ({ getAllAndOverride: (key: string) => map[key] }) as unknown as Reflector;

  /** A principal shaped the way `validateJwtPayload` builds one. */
  const withPermissions = (roleName: string, perms: Array<[string, string, string]>) => ({
    id: 'u-1',
    roles: [{
      name: roleName,
      permissions: perms.map(([resource, action, scope]) => ({ resource, action, scope })),
    }],
  });

  const HR_ROUTE = {
    [ROLES_KEY]: ['ADMIN', 'OPERATIONS'],
    [PERMISSIONS_KEY]: ['assayer:view:organization'],
  };

  it('gets in when it holds what the route asks for', () => {
    const guard = new RolesGuard(reflectorReturning(HR_ROUTE));
    const hr = withPermissions('HR_OPERATOR', [['ASSAYER', 'VIEW', 'ORGANIZATION']]);

    expect(guard.canActivate(ctx(hr))).toBe(true);
  });

  it('is still refused when it does not', () => {
    const guard = new RolesGuard(reflectorReturning(HR_ROUTE));
    const wrong = withPermissions('HR_OPERATOR', [['BILLING', 'VIEW', 'ORGANIZATION']]);

    expect(() => guard.canActivate(ctx(wrong))).toThrow(ForbiddenException);
  });

  it('needs ALL of them, not one of them', () => {
    // `every`, matching PermissionsGuard downstream. Holding one of three is not holding what the
    // route asked for, and a route requiring two permissions means both.
    const guard = new RolesGuard(reflectorReturning({
      [ROLES_KEY]: ['ADMIN'],
      [PERMISSIONS_KEY]: ['assayer:view:organization', 'assayer:edit:organization'],
    }));
    const halfway = withPermissions('HR_OPERATOR', [['ASSAYER', 'VIEW', 'ORGANIZATION']]);

    expect(() => guard.canActivate(ctx(halfway))).toThrow(ForbiddenException);
  });

  /**
   * The fail-closed half, and the reason the parity spec exists.
   *
   * A route that declares no permission offers nothing to check. Treating that as "nothing
   * required" is precisely the defect the deny-by-default note in `guards.ts` records, where a
   * missing decorator granted access instead of withholding it — so an unrecognised role is
   * refused there, and the route is listed as work to do rather than quietly opened.
   */
  it('is refused on a route that declares no permission, however much it holds', () => {
    const guard = new RolesGuard(reflectorReturning({ [ROLES_KEY]: ['ADMIN'] }));
    const wellStocked = withPermissions('HR_OPERATOR', [
      ['ASSAYER', 'VIEW', 'PLATFORM'], ['BILLING', 'APPROVE', 'PLATFORM'],
    ]);

    expect(() => guard.canActivate(ctx(wellStocked))).toThrow(ForbiddenException);
  });

  it('honours the PLATFORM widening, so a platform grant satisfies a narrower ask', () => {
    const guard = new RolesGuard(reflectorReturning(HR_ROUTE));
    const platform = withPermissions('HR_OPERATOR', [['ASSAYER', 'VIEW', 'PLATFORM']]);

    expect(guard.canActivate(ctx(platform))).toBe(true);
  });

  describe('nothing was loosened', () => {
    it('a named role still gets in without holding the permission', () => {
      // Unchanged behaviour: the name is checked first and short-circuits. PermissionsGuard still
      // runs afterwards and applies the permission rule to built-in roles exactly as before.
      const guard = new RolesGuard(reflectorReturning(HR_ROUTE));
      const ops = { id: 'u-2', roles: [{ name: 'OPERATIONS', permissions: [] }] };

      expect(guard.canActivate(ctx(ops))).toBe(true);
    });

    it('a route with no audience at all still denies', () => {
      const guard = new RolesGuard(reflectorReturning({}));
      expect(() => guard.canActivate(ctx(withPermissions('HR_OPERATOR', [['ASSAYER', 'VIEW', 'PLATFORM']]))))
        .toThrow(ForbiddenException);
    });

    it('@AnyAuthenticated still means any authenticated principal', () => {
      const guard = new RolesGuard(reflectorReturning({ [ANY_AUTHENTICATED_KEY]: true }));
      expect(guard.canActivate(ctx({ id: 'u-3', roles: [] }))).toBe(true);
    });

    it('an assayer principal cannot reach a staff route by holding a permission it was never given', () => {
      // The field principal carries permissions decoded from its own token. This asserts the
      // fallback is a permission check, not a hole: no permissions, no entry.
      const guard = new RolesGuard(reflectorReturning(HR_ROUTE));
      const assayer = { id: 'asr-1', roles: [{ name: 'ASSAYER', permissions: [] }] };

      expect(() => guard.canActivate(ctx(assayer))).toThrow(ForbiddenException);
    });
  });
});
