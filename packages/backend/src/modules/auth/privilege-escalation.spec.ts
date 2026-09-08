/**
 * FAPOMS — Privilege Escalation & Security Boundary Regression Test Suite
 *
 * Enforces Invariant 4 (Self-escalation prevention) and Invariant 7 (System privileges protection):
 * 1. Users cannot grant themselves new roles.
 * 2. Users cannot alter their own regional or client scopes.
 * 3. Custom roles cannot be created with SYSTEM-level permissions.
 * 4. Custom roles cannot have SYSTEM-level permissions assigned.
 * 5. Role and scope mutations immediately and synchronously invalidate the authorization cache.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { UserService } from '../user/user.service';
import { UserEntity } from '../user/user.entity';
import { RoleEntity } from '../user/role.entity';
import { PermissionEntity } from '../user/permission.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { Region } from '@fapoms/shared';

describe('Privilege Escalation & Scope Protection (Invariants 4 & 7)', () => {
  let service: UserService;

  const mockUserRepo = {
    findOne: jest.fn(),
    save: jest.fn((u: any) => Promise.resolve({ ...u })),
    createQueryBuilder: jest.fn(),
  };

  const mockRoleRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((v: any) => v),
    save: jest.fn((v: any) => Promise.resolve({ id: 'role-1', ...v })),
  };

  const mockPermissionRepo = {
    find: jest.fn(),
  };

  const mockAudit = {
    recordEvent: jest.fn().mockResolvedValue(undefined),
    recordEventSafe: jest.fn().mockResolvedValue(undefined),
  };

  const mockEvents = { publish: jest.fn() };
  const mockCache = { del: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(UserEntity), useValue: mockUserRepo },
        { provide: getRepositoryToken(RoleEntity), useValue: mockRoleRepo },
        { provide: getRepositoryToken(PermissionEntity), useValue: mockPermissionRepo },
        { provide: AuditService, useValue: mockAudit },
        { provide: DomainEventPublisher, useValue: mockEvents },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  describe('Self-Role Escalation Prevention (Invariant 4)', () => {
    it('refuses when a user attempts to assign themselves new roles', async () => {
      const user = {
        id: 'user-self-1',
        username: 'analyst',
        roles: [{ id: 'role-existing', name: 'OPERATIONS' }],
      };
      mockUserRepo.findOne.mockResolvedValue(user);
      mockRoleRepo.find.mockResolvedValue([
        { id: 'role-existing', name: 'OPERATIONS' },
        { id: 'role-new-admin', name: 'ADMIN' },
      ]);

      await expect(
        service.assignRoles(
          'user-self-1',
          ['role-existing', 'role-new-admin'],
          'user-self-1',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockUserRepo.save).not.toHaveBeenCalled();
    });

    it('allows a third-party administrator to assign new roles to a user', async () => {
      const user = {
        id: 'user-target-1',
        username: 'analyst',
        roles: [{ id: 'role-existing', name: 'OPERATIONS' }],
      };
      mockUserRepo.findOne.mockResolvedValue(user);
      mockRoleRepo.find.mockResolvedValue([
        { id: 'role-existing', name: 'OPERATIONS' },
        { id: 'role-new', name: 'DESK' },
      ]);

      const updated = await service.assignRoles(
        'user-target-1',
        ['role-existing', 'role-new'],
        'admin-actor-1',
      );

      expect(updated.roles.length).toBe(2);
      expect(mockCache.del).toHaveBeenCalledWith('rbac:principal:user-target-1');
    });
  });

  describe('Self-Scope Escalation Prevention', () => {
    it('refuses when a user attempts to alter their own regional scope', async () => {
      const user = {
        id: 'user-self-1',
        username: 'operator',
        regions: [Region.NORTH],
      };
      mockUserRepo.findOne.mockResolvedValue(user);

      await expect(
        service.updateUser(
          'user-self-1',
          { regions: [Region.NORTH, Region.WEST] as any },
          'user-self-1',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockUserRepo.save).not.toHaveBeenCalled();
    });

    it('refuses when a user attempts to alter their own client scope', async () => {
      const user = {
        id: 'user-self-1',
        username: 'client-rep',
        clientId: 'client-1',
      };
      mockUserRepo.findOne.mockResolvedValue(user);

      await expect(
        service.updateUser(
          'user-self-1',
          { clientId: 'client-2' },
          'user-self-1',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockUserRepo.save).not.toHaveBeenCalled();
    });

    it('allows an administrator to update another user scope and invalidates cache', async () => {
      const user = {
        id: 'user-target-1',
        username: 'operator',
        regions: [Region.NORTH],
      };
      mockUserRepo.findOne.mockResolvedValue(user);

      await service.updateUser(
        'user-target-1',
        { regions: [Region.NORTH, Region.WEST] as any },
        'admin-actor-1',
      );

      expect(mockCache.del).toHaveBeenCalledWith('rbac:principal:user-target-1');
    });
  });

  describe('System Permissions Protection (Invariant 7)', () => {
    it('refuses to create a custom role with SYSTEM-level permissions', async () => {
      mockRoleRepo.findOne.mockResolvedValue(null);
      mockPermissionRepo.find.mockResolvedValue([
        { id: 'perm-1', resource: 'SYSTEM', action: 'VIEW', scope: 'PLATFORM' },
      ]);

      await expect(
        service.createRole(
          {
            name: 'MALICIOUS_CUSTOM_ROLE',
            displayName: 'Malicious Custom Role',
            permissionIds: ['perm-1'],
          },
          'admin-actor-1',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockRoleRepo.save).not.toHaveBeenCalled();
    });

    it('refuses to assign SYSTEM-level permissions to an existing custom role', async () => {
      const customRole = {
        id: 'role-custom-1',
        name: 'CUSTOM_AUDITOR',
        permissions: [],
      };
      mockRoleRepo.findOne.mockResolvedValue(customRole);
      mockPermissionRepo.find.mockResolvedValue([
        { id: 'perm-sys', resource: 'SYSTEM', action: 'EDIT', scope: 'PLATFORM' },
      ]);

      await expect(
        service.setRolePermissions(
          'role-custom-1',
          ['perm-sys'],
          'admin-actor-1',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockRoleRepo.save).not.toHaveBeenCalled();
    });
  });
});
