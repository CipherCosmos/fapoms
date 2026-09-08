/**
 * FAPOMS — RolesGuard Truth-Table Security Test Suite
 *
 * Exhaustively validates all rows of the authorization decision matrix per Phase 0.2:
 * 1. Direct role match
 * 2. Role hierarchy implication (DEVELOPER -> ADMIN, PRODUCT_SUPPORT)
 * 3. Role hierarchy one-way boundary (ADMIN does NOT imply DEVELOPER)
 * 4. Unknown/unregistered role names
 * 5. Strict role whitelist: custom roles DENIED even with matching permissions if no fallback declared
 * 6. Explicit fallback via @AllowPermissionFallback()
 * 7. Fallback requires ALL permissions (not just some)
 * 8. Explicit fallback via @RolesFallbackPermissions(...)
 * 9. @RoleOnly() suppresses all fallback behavior
 * 10. Permission-only routes (@RequirePermissions without @Roles)
 * 11. @AnyAuthenticated() routes
 * 12. Deny by default when no audience is specified
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SystemRole } from '@fapoms/shared';
import {
  RolesGuard,
  ROLES_KEY,
  PERMISSIONS_KEY,
  ANY_AUTHENTICATED_KEY,
  ROLE_ONLY_KEY,
  ALLOW_PERMISSION_FALLBACK_KEY,
  ROLES_FALLBACK_PERMISSIONS_KEY,
} from './guards';

describe('RolesGuard — Complete Truth-Table Security Matrix', () => {
  const createMockContext = (user: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => function testHandler() {},
      getClass: () => class TestController {},
    } as any);

  const mockReflector = (metadata: Record<string, any>): Reflector =>
    ({
      getAllAndOverride: (key: string) => metadata[key],
    } as unknown as Reflector);

  const createPrincipal = (roles: Array<string | { name: string; permissions?: Array<{ resource: string; action: string; scope: string }> }>) => ({
    id: 'user-uuid-1',
    roles: roles.map((r) =>
      typeof r === 'string' ? { name: r, permissions: [] } : r,
    ),
  });

  // ---------------------------------------------------------------------------
  // Row 1: Direct role match
  // ---------------------------------------------------------------------------
  describe('Row 1: Direct role match', () => {
    it('admits principal when role directly matches one of @Roles', () => {
      const guard = new RolesGuard(
        mockReflector({ [ROLES_KEY]: [SystemRole.ADMIN, SystemRole.OPERATIONS] }),
      );
      const principal = createPrincipal([SystemRole.OPERATIONS]);
      expect(guard.canActivate(createMockContext(principal))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Row 2: Role hierarchy implication (DEVELOPER -> ADMIN)
  // ---------------------------------------------------------------------------
  describe('Row 2: Role hierarchy implication', () => {
    it('admits DEVELOPER on @Roles(ADMIN) via role implication hierarchy', () => {
      const guard = new RolesGuard(mockReflector({ [ROLES_KEY]: [SystemRole.ADMIN] }));
      const principal = createPrincipal([SystemRole.DEVELOPER]);
      expect(guard.canActivate(createMockContext(principal))).toBe(true);
    });

    it('admits DEVELOPER on @Roles(PRODUCT_SUPPORT) via role implication hierarchy', () => {
      const guard = new RolesGuard(
        mockReflector({ [ROLES_KEY]: [SystemRole.PRODUCT_SUPPORT] }),
      );
      const principal = createPrincipal([SystemRole.DEVELOPER]);
      expect(guard.canActivate(createMockContext(principal))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Row 3: Role hierarchy is strictly one-way
  // ---------------------------------------------------------------------------
  describe('Row 3: Role hierarchy one-way boundary', () => {
    it('refuses ADMIN on @Roles(DEVELOPER) — ADMIN cannot escalate to DEVELOPER', () => {
      const guard = new RolesGuard(
        mockReflector({ [ROLES_KEY]: [SystemRole.DEVELOPER] }),
      );
      const principal = createPrincipal([SystemRole.ADMIN]);
      expect(() => guard.canActivate(createMockContext(principal))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Row 4: Unknown role names
  // ---------------------------------------------------------------------------
  describe('Row 4: Unknown role names', () => {
    it('refuses unknown role names that are not in SystemRole or the whitelist', () => {
      const guard = new RolesGuard(
        mockReflector({ [ROLES_KEY]: [SystemRole.ADMIN, SystemRole.OPERATIONS] }),
      );
      const principal = createPrincipal(['UNKNOWN_ROLE_FOOBAR']);
      expect(() => guard.canActivate(createMockContext(principal))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Row 5: INVARIANT 1 — Strict role whitelist (NO implicit fallback)
  // ---------------------------------------------------------------------------
  describe('Row 5: Strict role whitelist (Invariant 1)', () => {
    it('refuses custom roles on @Roles route without explicit fallback, EVEN IF holding the permission', () => {
      const guard = new RolesGuard(
        mockReflector({
          [ROLES_KEY]: [SystemRole.ADMIN],
          [PERMISSIONS_KEY]: ['ASSAYER:VIEW:ORGANIZATION'],
          // Note: NO ALLOW_PERMISSION_FALLBACK_KEY or ROLES_FALLBACK_PERMISSIONS_KEY
        }),
      );
      const principal = createPrincipal([
        {
          name: 'CUSTOM_AUDITOR',
          permissions: [
            { resource: 'ASSAYER', action: 'VIEW', scope: 'ORGANIZATION' },
          ],
        },
      ]);
      expect(() => guard.canActivate(createMockContext(principal))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Row 6: Explicit fallback via @AllowPermissionFallback()
  // ---------------------------------------------------------------------------
  describe('Row 6: Explicit fallback via @AllowPermissionFallback()', () => {
    it('admits custom role when @AllowPermissionFallback() is set and permissions match', () => {
      const guard = new RolesGuard(
        mockReflector({
          [ROLES_KEY]: [SystemRole.ADMIN],
          [PERMISSIONS_KEY]: ['ASSAYER:VIEW:ORGANIZATION'],
          [ALLOW_PERMISSION_FALLBACK_KEY]: true,
        }),
      );
      const principal = createPrincipal([
        {
          name: 'CUSTOM_AUDITOR',
          permissions: [
            { resource: 'ASSAYER', action: 'VIEW', scope: 'ORGANIZATION' },
          ],
        },
      ]);
      expect(guard.canActivate(createMockContext(principal))).toBe(true);
    });

    it('admits custom role holding PLATFORM scope on an ORGANIZATION check', () => {
      const guard = new RolesGuard(
        mockReflector({
          [ROLES_KEY]: [SystemRole.ADMIN],
          [PERMISSIONS_KEY]: ['ASSAYER:VIEW:ORGANIZATION'],
          [ALLOW_PERMISSION_FALLBACK_KEY]: true,
        }),
      );
      const principal = createPrincipal([
        {
          name: 'CUSTOM_AUDITOR',
          permissions: [
            { resource: 'ASSAYER', action: 'VIEW', scope: 'PLATFORM' },
          ],
        },
      ]);
      expect(guard.canActivate(createMockContext(principal))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Row 7: Fallback requires ALL permissions (every semantics)
  // ---------------------------------------------------------------------------
  describe('Row 7: Fallback requires ALL permissions', () => {
    it('refuses custom role holding only 1 of 2 required permissions on fallback route', () => {
      const guard = new RolesGuard(
        mockReflector({
          [ROLES_KEY]: [SystemRole.ADMIN],
          [PERMISSIONS_KEY]: ['ASSAYER:VIEW:ORGANIZATION', 'ASSAYER:EDIT:ORGANIZATION'],
          [ALLOW_PERMISSION_FALLBACK_KEY]: true,
        }),
      );
      const principal = createPrincipal([
        {
          name: 'CUSTOM_AUDITOR',
          permissions: [
            { resource: 'ASSAYER', action: 'VIEW', scope: 'ORGANIZATION' },
          ],
        },
      ]);
      expect(() => guard.canActivate(createMockContext(principal))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Row 8: Explicit fallback via @RolesFallbackPermissions(...)
  // ---------------------------------------------------------------------------
  describe('Row 8: Explicit fallback via @RolesFallbackPermissions(...)', () => {
    it('admits custom role with matching fallback permissions on @RolesFallbackPermissions route', () => {
      const guard = new RolesGuard(
        mockReflector({
          [ROLES_KEY]: [SystemRole.ADMIN, SystemRole.ASSAYER],
          [ROLES_FALLBACK_PERMISSIONS_KEY]: ['ASSAYER:EDIT:ORGANIZATION'],
        }),
      );
      const principal = createPrincipal([
        {
          name: 'HR_OPERATOR',
          permissions: [
            { resource: 'ASSAYER', action: 'EDIT', scope: 'ORGANIZATION' },
          ],
        },
      ]);
      expect(guard.canActivate(createMockContext(principal))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Row 9: @RoleOnly() suppresses all fallback
  // ---------------------------------------------------------------------------
  describe('Row 9: @RoleOnly() suppresses fallback', () => {
    it('refuses custom role on @RoleOnly() route even if fallback metadata was present', () => {
      const guard = new RolesGuard(
        mockReflector({
          [ROLES_KEY]: [SystemRole.ADMIN],
          [PERMISSIONS_KEY]: ['CONFIGURATION:EDIT:PLATFORM'],
          [ALLOW_PERMISSION_FALLBACK_KEY]: true,
          [ROLE_ONLY_KEY]: true,
        }),
      );
      const principal = createPrincipal([
        {
          name: 'CUSTOM_ADMIN',
          permissions: [
            { resource: 'CONFIGURATION', action: 'EDIT', scope: 'PLATFORM' },
          ],
        },
      ]);
      expect(() => guard.canActivate(createMockContext(principal))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Row 10: Permission-only routes (@RequirePermissions without @Roles)
  // ---------------------------------------------------------------------------
  describe('Row 10: Permission-only routes (Invariant 2)', () => {
    it('admits principal holding declared permissions when route has no @Roles', () => {
      const guard = new RolesGuard(
        mockReflector({
          [PERMISSIONS_KEY]: ['PROJECT:CREATE:ORGANIZATION'],
        }),
      );
      const principal = createPrincipal([
        {
          name: 'PROJECT_COORDINATOR',
          permissions: [
            { resource: 'PROJECT', action: 'CREATE', scope: 'ORGANIZATION' },
          ],
        },
      ]);
      expect(guard.canActivate(createMockContext(principal))).toBe(true);
    });

    it('refuses principal lacking declared permissions when route has no @Roles', () => {
      const guard = new RolesGuard(
        mockReflector({
          [PERMISSIONS_KEY]: ['PROJECT:CREATE:ORGANIZATION'],
        }),
      );
      const principal = createPrincipal([
        {
          name: 'PROJECT_VIEWER',
          permissions: [
            { resource: 'PROJECT', action: 'VIEW', scope: 'ORGANIZATION' },
          ],
        },
      ]);
      expect(() => guard.canActivate(createMockContext(principal))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Row 11: @AnyAuthenticated() routes
  // ---------------------------------------------------------------------------
  describe('Row 11: @AnyAuthenticated() routes', () => {
    it('admits any authenticated principal regardless of role', () => {
      const guard = new RolesGuard(
        mockReflector({ [ANY_AUTHENTICATED_KEY]: true }),
      );
      const principal = createPrincipal(['ANY_USER']);
      expect(guard.canActivate(createMockContext(principal))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Row 12: Deny by default
  // ---------------------------------------------------------------------------
  describe('Row 12: Deny by default', () => {
    it('refuses requests when no roles, permissions, or anyAuthenticated decorators are set', () => {
      const guard = new RolesGuard(mockReflector({}));
      const principal = createPrincipal([SystemRole.ADMIN]);
      expect(() => guard.canActivate(createMockContext(principal))).toThrow(
        ForbiddenException,
      );
    });
  });
});
