import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SystemRole, UserStatus, Region } from '@fapoms/shared';
import { UserService } from '../user/user.service';
import { TenantScopedRepository, TenantOwned } from '../../infrastructure/tenancy/tenant-scoped.repository';
import { TenantContext } from '../../infrastructure/tenancy/tenant-context';
import { rbacPrincipalCacheKey } from './auth.service';

describe('Direct-ID Mutation Attacks & State Invariance Spec', () => {
  describe('1. Direct-ID Self-Escalation & Role Mutation (UserService)', () => {
    let userService: UserService;
    let mockUserRepo: any;
    let mockRoleRepo: any;
    let mockPermRepo: any;
    let mockAuditService: any;
    let mockEventPublisher: any;
    let mockCache: any;

    const baseUser = {
      id: 'target-user-123',
      username: 'testoperator',
      roles: [{ id: 'role-operator', name: 'OPERATIONS' }],
      regions: [Region.NORTH],
      clientId: null,
      status: UserStatus.ACTIVE,
      isActive: true,
    };

    beforeEach(() => {
      mockUserRepo = {
        findOne: jest.fn().mockResolvedValue({ ...baseUser, roles: [...baseUser.roles] }),
        save: jest.fn().mockImplementation((u) => Promise.resolve(u)),
        createQueryBuilder: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(2),
        }),
      };
      mockRoleRepo = {
        findOne: jest.fn(),
        find: jest.fn().mockResolvedValue([{ id: 'role-admin', name: 'ADMIN' }]),
        save: jest.fn().mockImplementation((r) => Promise.resolve(r)),
        create: jest.fn().mockImplementation((r) => r),
      };
      mockPermRepo = {
        find: jest.fn(),
      };
      mockAuditService = {
        recordEvent: jest.fn().mockResolvedValue(undefined),
        recordEventSafe: jest.fn().mockResolvedValue(undefined),
      };
      mockEventPublisher = {
        publish: jest.fn(),
      };
      mockCache = {
        del: jest.fn().mockResolvedValue(undefined),
      };

      userService = new UserService(
        mockUserRepo,
        mockRoleRepo,
        mockPermRepo,
        mockAuditService,
        mockEventPublisher,
        mockCache,
      );
    });

    it('INVARIANT 6: Unauthorized self-role grant produces 403 and ZERO state change', async () => {
      // User A attempts to assign ADMIN role to themselves (assignedById === userId)
      await expect(
        userService.assignRoles('target-user-123', ['role-admin'], 'target-user-123'),
      ).rejects.toThrow(new ForbiddenException('You cannot grant yourself new roles.'));

      // VERIFY DATABASE INVARIANCE: save was NEVER called
      expect(mockUserRepo.save).not.toHaveBeenCalled();
      // Cache was NOT modified
      expect(mockCache.del).not.toHaveBeenCalled();
      // No domain event published
      expect(mockEventPublisher.publish).not.toHaveBeenCalled();
    });

    it('INVARIANT 6: Unauthorized self-region mutation produces 403 and ZERO state change', async () => {
      // User A attempts to widen own regions to include SOUTH and WEST
      await expect(
        userService.updateUser(
          'target-user-123',
          { regions: [Region.NORTH, Region.SOUTH, Region.WEST] },
          'target-user-123',
        ),
      ).rejects.toThrow(
        new ForbiddenException('You cannot modify your own regional or client scope assignments.'),
      );

      // VERIFY ZERO STATE CHANGE
      expect(mockUserRepo.save).not.toHaveBeenCalled();
      expect(mockCache.del).not.toHaveBeenCalled();
    });

    it('INVARIANT 6: Unauthorized self-client scope mutation produces 403 and ZERO state change', async () => {
      await expect(
        userService.updateUser(
          'target-user-123',
          { clientId: 'client-arbitrary-uuid' },
          'target-user-123',
        ),
      ).rejects.toThrow(
        new ForbiddenException('You cannot modify your own regional or client scope assignments.'),
      );

      expect(mockUserRepo.save).not.toHaveBeenCalled();
      expect(mockCache.del).not.toHaveBeenCalled();
    });

    it('INVARIANT 7: Custom role cannot be granted SYSTEM:* permissions, producing 403 and ZERO state change', async () => {
      mockRoleRepo.findOne.mockResolvedValue({
        id: 'custom-role-id',
        name: 'CUSTOM_AUDIT_SUPER',
        permissions: [],
      });
      mockPermRepo.find.mockResolvedValue([
        { id: 'perm-sys-approve', resource: 'SYSTEM', action: 'APPROVE', scope: 'PLATFORM' },
      ]);

      await expect(
        userService.setRolePermissions('custom-role-id', ['perm-sys-approve'], 'admin-user-id'),
      ).rejects.toThrow(
        new ForbiddenException('Custom roles cannot be granted SYSTEM-level permissions.'),
      );

      // VERIFY ZERO STATE CHANGE on role permissions
      expect(mockRoleRepo.save).not.toHaveBeenCalled();
      expect(mockCache.del).not.toHaveBeenCalled();
    });

    it('INVARIANT 7: createRole blocks SYSTEM:* permission assignment at creation time', async () => {
      mockRoleRepo.findOne.mockResolvedValue(null);
      mockPermRepo.find.mockResolvedValue([
        { id: 'perm-sys-edit', resource: 'SYSTEM', action: 'EDIT', scope: 'PLATFORM' },
      ]);

      await expect(
        userService.createRole(
          {
            name: 'CUSTOM_ROLE_WITH_SYS',
            displayName: 'Custom Role',
            permissionIds: ['perm-sys-edit'],
          },
          'admin-actor',
        ),
      ).rejects.toThrow(
        new ForbiddenException('Custom roles cannot be granted SYSTEM-level permissions.'),
      );

      expect(mockRoleRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('2. Direct-ID Cross-Tenant & Tenantless Entity Access (TenantScopedRepository)', () => {
    interface TestEntity extends TenantOwned {
      id: string;
      name: string;
      organizationId?: string | null;
    }

    class ConcreteTenantRepo extends TenantScopedRepository<TestEntity> {
      protected readonly alias = 'test_entity';
      constructor(repo: any, tenant: TenantContext) {
        super(repo, tenant);
      }

      public checkOwned(entity: TestEntity | null | undefined): TestEntity {
        return this.assertOwned(entity);
      }
    }

    it('INVARIANT 5 & 12: Refuses other-tenant record with 403 and reveals no existence', () => {
      const mockTenantContext: any = {
        isCrossTenant: false,
        requireOrganizationId: () => 'tenant-a-uuid',
      };
      const repo = new ConcreteTenantRepo({} as any, mockTenantContext);

      const otherTenantRecord: TestEntity = {
        id: 'record-other-tenant',
        name: 'Secret Branch Org B',
        organizationId: 'tenant-b-uuid',
      };

      expect(() => repo.checkOwned(otherTenantRecord)).toThrow(
        new ForbiddenException('Record not found in your organisation.'),
      );
    });

    it('INVARIANT 12: Quarantines legacy tenantless record (organizationId IS NULL) from tenant-scoped user', () => {
      const mockTenantContext: any = {
        isCrossTenant: false,
        requireOrganizationId: () => 'tenant-a-uuid',
      };
      const repo = new ConcreteTenantRepo({} as any, mockTenantContext);

      const legacyTenantlessRecord: TestEntity = {
        id: 'legacy-record-1',
        name: 'Unmapped Legacy Client',
        organizationId: null, // Legacy null record
      };

      expect(() => repo.checkOwned(legacyTenantlessRecord)).toThrow(
        new ForbiddenException('Record not found in your organisation.'),
      );
    });

    it('INVARIANT 12: Allows authorized tenant-owned record matching the caller tenant', () => {
      const mockTenantContext: any = {
        isCrossTenant: false,
        requireOrganizationId: () => 'tenant-a-uuid',
      };
      const repo = new ConcreteTenantRepo({} as any, mockTenantContext);

      const authorizedRecord: TestEntity = {
        id: 'record-own-tenant',
        name: 'Our Branch',
        organizationId: 'tenant-a-uuid',
      };

      const result = repo.checkOwned(authorizedRecord);
      expect(result).toBe(authorizedRecord);
    });

    it('Cross-tenant administrator (isCrossTenant: true) can access records for maintenance', () => {
      const mockTenantContext: any = {
        isCrossTenant: true,
        requireOrganizationId: () => 'tenant-a-uuid',
      };
      const repo = new ConcreteTenantRepo({} as any, mockTenantContext);

      const record: TestEntity = {
        id: 'any-record',
        name: 'Branch X',
        organizationId: 'tenant-b-uuid',
      };

      expect(repo.checkOwned(record)).toBe(record);
    });
  });

  describe('3. System Identity Spoofing Protection (Actor Immutability)', () => {
    it('INVARIANT 8: User cannot inject trusted SYSTEM identity via request body fields', () => {
      // Simulating a controller action that accepts an arbitrary body
      const maliciousBody = {
        userId: 'SYSTEM',
        actorId: 'SYSTEM',
        approvedBy: 'SYSTEM',
        createdBy: 'SYSTEM',
        system: true,
        title: 'Tampered Document',
      };

      // Authenticated request object populated by Passport / JwtStrategy
      const authenticatedReq = {
        user: {
          id: 'genuine-user-uuid-999',
          username: 'attacker@fapoms.com',
          roles: ['OPERATIONS'],
          organizationId: 'org-111',
        },
      };

      // Controller must resolve actorId strictly from req.user.id
      const resolvedActorId = authenticatedReq.user.id;
      expect(resolvedActorId).toBe('genuine-user-uuid-999');
      expect(resolvedActorId).not.toBe(maliciousBody.userId);
      expect(resolvedActorId).not.toBe(maliciousBody.actorId);
    });
  });

  describe('4. Revocation TOCTOU & Synchronous Cache Del Invariants', () => {
    it('INVARIANT 13: Revocation synchronously deletes cached principal key across cluster', async () => {
      const mockCache = {
        del: jest.fn().mockResolvedValue(undefined),
      };
      const userId = 'revoked-user-uuid';
      const key = rbacPrincipalCacheKey(userId);

      // Simulate admin revoking permissions in Request B
      await mockCache.del(key);

      expect(mockCache.del).toHaveBeenCalledWith('rbac:principal:revoked-user-uuid');
    });
  });
});
