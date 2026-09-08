/**
 * FAPOMS — Malformed Authorization State Security Test Suite
 *
 * Enforces Invariant 3:
 * Malformed, null, undefined, incomplete, or ambiguous authorization data
 * must ALWAYS fail closed (ForbiddenException) and never accidentally grant privilege.
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SystemRole } from '@fapoms/shared';
import {
  RolesGuard,
  PermissionsGuard,
  ROLES_KEY,
  PERMISSIONS_KEY,
  ALLOW_PERMISSION_FALLBACK_KEY,
  permissionKeysHeldBy,
} from './guards';

describe('Malformed Authorization State — Fail Closed (Invariant 3)', () => {
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

  const rolesGuard = new RolesGuard(
    mockReflector({
      [ROLES_KEY]: [SystemRole.ADMIN, SystemRole.OPERATIONS],
      [PERMISSIONS_KEY]: ['ASSAYER:VIEW:ORGANIZATION'],
      [ALLOW_PERMISSION_FALLBACK_KEY]: true,
    }),
  );

  const permissionsGuard = new PermissionsGuard(
    mockReflector({
      [PERMISSIONS_KEY]: ['ASSAYER:VIEW:ORGANIZATION'],
    }),
  );

  describe('Null, undefined, or missing user principal', () => {
    it('RolesGuard fails closed when req.user is null', () => {
      expect(() => rolesGuard.canActivate(createMockContext(null))).toThrow(
        ForbiddenException,
      );
    });

    it('RolesGuard fails closed when req.user is undefined', () => {
      expect(() => rolesGuard.canActivate(createMockContext(undefined))).toThrow(
        ForbiddenException,
      );
    });

    it('PermissionsGuard fails closed when req.user is null', () => {
      expect(() => permissionsGuard.canActivate(createMockContext(null))).toThrow(
        ForbiddenException,
      );
    });

    it('PermissionsGuard fails closed when req.user is undefined', () => {
      expect(() => permissionsGuard.canActivate(createMockContext(undefined))).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('Malformed roles structure on user principal', () => {
    it('RolesGuard fails closed when user.roles is null', () => {
      expect(() =>
        rolesGuard.canActivate(createMockContext({ id: 'u1', roles: null })),
      ).toThrow(ForbiddenException);
    });

    it('RolesGuard fails closed when user.roles is undefined', () => {
      expect(() =>
        rolesGuard.canActivate(createMockContext({ id: 'u1', roles: undefined })),
      ).toThrow(ForbiddenException);
    });

    it('RolesGuard fails closed when user.roles is a plain object instead of an array', () => {
      expect(() =>
        rolesGuard.canActivate(createMockContext({ id: 'u1', roles: {} })),
      ).toThrow(ForbiddenException);
    });

    it('RolesGuard fails closed when user.roles contains nulls or booleans', () => {
      expect(() =>
        rolesGuard.canActivate(createMockContext({ id: 'u1', roles: [null, true, 123] })),
      ).toThrow(ForbiddenException);
    });

    it('RolesGuard fails closed when role object has no name property', () => {
      expect(() =>
        rolesGuard.canActivate(
          createMockContext({ id: 'u1', roles: [{ randomField: 'foo' }] }),
        ),
      ).toThrow(ForbiddenException);
    });

    it('RolesGuard fails closed when role name is empty or whitespace string', () => {
      expect(() =>
        rolesGuard.canActivate(
          createMockContext({ id: 'u1', roles: [{ name: '   ' }] }),
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe('Malformed permission entries in user roles', () => {
    it('permissionKeysHeldBy handles null/undefined user safely', () => {
      expect(permissionKeysHeldBy(null).size).toBe(0);
      expect(permissionKeysHeldBy(undefined).size).toBe(0);
      expect(permissionKeysHeldBy({}).size).toBe(0);
      expect(permissionKeysHeldBy({ roles: 'not-an-array' }).size).toBe(0);
    });

    it('permissionKeysHeldBy safely ignores malformed role objects', () => {
      const held = permissionKeysHeldBy({
        roles: [null, undefined, 'ADMIN', { name: 'CUSTOM', permissions: null }],
      });
      expect(held.size).toBe(0);
    });

    it('permissionKeysHeldBy safely ignores permissions missing resource, action, or scope', () => {
      const held = permissionKeysHeldBy({
        roles: [
          {
            name: 'CUSTOM',
            permissions: [
              null,
              undefined,
              { resource: null, action: 'VIEW', scope: 'ORGANIZATION' },
              { resource: 'ASSAYER', action: null, scope: 'ORGANIZATION' },
              { resource: 'ASSAYER', action: 'VIEW', scope: null },
              { resource: '', action: 'VIEW', scope: 'ORGANIZATION' },
              { resource: '   ', action: '   ', scope: '   ' },
              { resource: 'VALID', action: 'VIEW', scope: 'ORGANIZATION' },
            ],
          },
        ],
      });
      expect(held.has('VALID:VIEW:ORGANIZATION')).toBe(true);
      expect(held.size).toBe(1);
    });
  });

  describe('Duplicate roles and permissions', () => {
    it('handles duplicate roles without exploding or bypassing gates', () => {
      const principal = {
        id: 'u1',
        roles: [
          { name: SystemRole.OPERATIONS, permissions: [] },
          { name: SystemRole.OPERATIONS, permissions: [] },
        ],
      };
      expect(rolesGuard.canActivate(createMockContext(principal))).toBe(true);
    });

    it('handles duplicate permissions safely using Set deduplication', () => {
      const principal = {
        id: 'u1',
        roles: [
          {
            name: 'CUSTOM_DUP',
            permissions: [
              { resource: 'ASSAYER', action: 'VIEW', scope: 'ORGANIZATION' },
              { resource: 'ASSAYER', action: 'VIEW', scope: 'ORGANIZATION' },
            ],
          },
        ],
      };
      const held = permissionKeysHeldBy(principal);
      expect(held.size).toBe(1);
      expect(rolesGuard.canActivate(createMockContext(principal))).toBe(true);
    });
  });
});
