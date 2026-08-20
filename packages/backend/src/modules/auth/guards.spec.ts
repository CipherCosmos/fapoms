import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, PermissionsGuard, ROLES_KEY, ANY_AUTHENTICATED_KEY } from './guards';

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
});
