import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, PermissionsGuard, JwtAuthGuard, ROLES_KEY, ANY_AUTHENTICATED_KEY, PASSWORD_CHANGE_EXEMPT_KEY } from './guards';

/**
 * These lock in DENY-BY-DEFAULT.
 *
 * Both guards used to `return true` when a route carried no metadata. Because most controllers
 * apply @UseGuards at the class level and annotate only some handlers, that silently left ~50
 * endpoints open to every authenticated principal — including a field assayer — among them
 * every billing read, bank borrower records, and `GET /users/:id`. Nothing in the code looked
 * wrong; the omission itself granted access.
 *
 * If someone ever restores the old `return true`, these fail.
 */
describe('Authorization guards — deny by default', () => {
  const ctx = (user: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    }) as any;

  const reflectorReturning = (map: Record<string, any>) =>
    ({ getAllAndOverride: (key: string) => map[key] }) as unknown as Reflector;

  const staffUser = { id: 'u-1', roles: [{ name: 'OPERATIONS' }] };
  const assayer = { id: 'a-1', roles: [{ name: 'ASSAYER' }] };

  describe('RolesGuard', () => {
    it('DENIES a route that declares no audience at all', () => {
      const guard = new RolesGuard(reflectorReturning({}));
      expect(() => guard.canActivate(ctx(staffUser))).toThrow(ForbiddenException);
    });

    it('DENIES an assayer on an unannotated route (the billing/PII exposure)', () => {
      const guard = new RolesGuard(reflectorReturning({}));
      expect(() => guard.canActivate(ctx(assayer))).toThrow(ForbiddenException);
    });

    it('allows a route that explicitly opts in via @AnyAuthenticated()', () => {
      const guard = new RolesGuard(reflectorReturning({ [ANY_AUTHENTICATED_KEY]: true }));
      expect(guard.canActivate(ctx(assayer))).toBe(true);
    });

    it('allows a principal holding one of the required roles', () => {
      const guard = new RolesGuard(reflectorReturning({ [ROLES_KEY]: ['OPERATIONS'] }));
      expect(guard.canActivate(ctx(staffUser))).toBe(true);
    });

    it('denies a principal missing every required role', () => {
      const guard = new RolesGuard(reflectorReturning({ [ROLES_KEY]: ['OPERATIONS'] }));
      expect(() => guard.canActivate(ctx(assayer))).toThrow(ForbiddenException);
    });

    it('denies when there is no authenticated principal', () => {
      const guard = new RolesGuard(reflectorReturning({ [ROLES_KEY]: ['ADMIN'] }));
      expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
    });

    it('explains itself in language a non-technical user can act on', () => {
      const guard = new RolesGuard(reflectorReturning({}));
      try {
        guard.canActivate(ctx(staffUser));
        fail('expected a ForbiddenException');
      } catch (e: any) {
        expect(e.message).toMatch(/not available to your role/i);
        expect(e.message).toMatch(/administrator/i);
      }
    });
  });

  describe('PermissionsGuard', () => {
    it('is a no-op when a route requires no specific permission (roles do the gating)', () => {
      const guard = new PermissionsGuard(reflectorReturning({}));
      expect(guard.canActivate(ctx(staffUser))).toBe(true);
    });

    it('denies when a required permission is absent', () => {
      const guard = new PermissionsGuard(reflectorReturning({ permissions: ['BILLING:READ:PLATFORM'] }));
      expect(() => guard.canActivate(ctx(assayer))).toThrow(ForbiddenException);
    });

    it('treats PLATFORM scope as implying narrower scopes', () => {
      const guard = new PermissionsGuard(reflectorReturning({ permissions: ['BILLING:READ:ORGANIZATION'] }));
      const financeUser = {
        id: 'f-1',
        roles: [{ name: 'OPERATIONS', permissions: [{ resource: 'BILLING', action: 'READ', scope: 'PLATFORM' }] }],
      };
      expect(guard.canActivate(ctx(financeUser))).toBe(true);
    });
  });
  /**
   * Forced password change is enforced server-side, not just in the browser. The passport parent
   * is stubbed so these exercise only the mustChangePassword branch this guard adds on top of it.
   */
  describe('JwtAuthGuard — forced password change', () => {
    const parentProto = Object.getPrototypeOf(JwtAuthGuard.prototype);
    let spy: jest.SpyInstance;
    beforeEach(() => { spy = jest.spyOn(parentProto, 'canActivate').mockResolvedValue(true); });
    afterEach(() => spy.mockRestore());

    // The shape validateJwtPayload builds for a field account — the flag rides the principal.
    const assayerPrincipal = (mustChangePassword: boolean) =>
      ({ id: 'a-1', roles: [{ name: 'ASSAYER' }], mustChangePassword });

    it('blocks an ordinary route when a staff user still owes a password change', async () => {
      const guard = new JwtAuthGuard(reflectorReturning({}) as any);
      await expect(
        guard.canActivate(ctx({ id: 'u-1', mustChangePassword: true })),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * The field-workforce half of the rule. The assayer principal used to carry no flag at all,
     * so the entire mobile population was exempt — the group the rule matters most for, since
     * the bulk import seeded one shared default password (`assayer123`) onto every account it
     * created and every HR reset issues a temporary password that HR knows. Restoring the old
     * flag-less principal in validateJwtPayload would make this fail.
     */
    it('blocks an ordinary route when an ASSAYER principal still owes a password change', async () => {
      const guard = new JwtAuthGuard(reflectorReturning({}) as any);
      await expect(guard.canActivate(ctx(assayerPrincipal(true)))).rejects.toThrow(ForbiddenException);
    });

    it('allows an exempt route (change-password, own profile, logout) even while pending', async () => {
      const guard = new JwtAuthGuard(reflectorReturning({ [PASSWORD_CHANGE_EXEMPT_KEY]: true }) as any);
      await expect(
        guard.canActivate(ctx({ id: 'u-1', mustChangePassword: true })),
      ).resolves.toBe(true);
      // The same escape hatch must hold for the assayer, or enforcement becomes a lockout loop:
      // every route 403s, including the only route that clears the 403.
      await expect(guard.canActivate(ctx(assayerPrincipal(true)))).resolves.toBe(true);
    });

    /**
     * The refusal must be tellable apart from "no permission" and from a dead session. The
     * mobile client signs the user out on auth failures during session validation; a client
     * that can read `code` routes to the change-password screen instead. The message stays
     * what the web already displays.
     */
    it('names itself: the 403 body carries code PASSWORD_CHANGE_REQUIRED', async () => {
      const guard = new JwtAuthGuard(reflectorReturning({}) as any);
      try {
        await guard.canActivate(ctx(assayerPrincipal(true)));
        fail('expected a ForbiddenException');
      } catch (e: any) {
        expect(e.getResponse().code).toBe('PASSWORD_CHANGE_REQUIRED');
        expect(e.message).toMatch(/change your password/i);
      }
    });

    it('does not touch a principal whose flag is false or absent (staff or assayer)', async () => {
      const guard = new JwtAuthGuard(reflectorReturning({}) as any);
      await expect(guard.canActivate(ctx({ id: 'u-2' }))).resolves.toBe(true);
      await expect(guard.canActivate(ctx(assayerPrincipal(false)))).resolves.toBe(true);
      // A principal cached before the flag existed carries no key at all; it must pass, not 403.
      await expect(guard.canActivate(ctx({ id: 'a-1', roles: [{ name: 'ASSAYER' }] }))).resolves.toBe(true);
    });
  });
});
