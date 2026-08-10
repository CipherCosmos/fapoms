import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SystemRole } from '@fapoms/shared';
import { UserService } from './user.service';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { PermissionEntity } from './permission.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

/**
 * Guard rails on the role editor.
 *
 * These are the rules that stop an administrator locking the organisation — or themselves — out
 * of the system from a screen that otherwise looks like ordinary CRUD.
 */
describe('UserService — roles & permissions', () => {
  let service: UserService;

  const mockUserRepo = {
    createQueryBuilder: jest.fn(),
  };
  const mockRoleRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((v: any) => v),
    save: jest.fn((v: any) => Promise.resolve({ id: 'role-1', ...v })),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const mockPermissionRepo = {
    find: jest.fn(),
  };
  const mockAudit = { recordEventSafe: jest.fn().mockResolvedValue(undefined) };
  const mockEvents = { publish: jest.fn() };

  /** Query builder used both for holder counts and holder-id lookups. */
  const queryBuilder = (result: { count?: number; raw?: any[] }) => ({
    select: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(result.count ?? 0),
    getRawMany: jest.fn().mockResolvedValue(result.raw ?? []),
  });

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
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  describe('createRole', () => {
    it('normalises the name to UPPER_SNAKE so it matches how guards compare names', async () => {
      mockRoleRepo.findOne.mockResolvedValue(null);
      mockPermissionRepo.find.mockResolvedValue([]);

      await service.createRole({ name: 'regional auditor', displayName: 'Regional Auditor' }, 'actor-1');

      expect(mockRoleRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'REGIONAL_AUDITOR' }),
      );
    });

    it('refuses a duplicate role name', async () => {
      mockRoleRepo.findOne.mockResolvedValue({ id: 'existing', name: 'AUDITOR' });

      await expect(
        service.createRole({ name: 'AUDITOR', displayName: 'Auditor' }, 'actor-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('setRolePermissions', () => {
    it('replaces the permission set and invalidates every holder so it applies without re-login', async () => {
      const role = { id: 'role-1', name: 'OPERATIONS_MANAGER', permissions: [{ id: 'p1' }] };
      mockRoleRepo.findOne.mockResolvedValue(role);
      mockPermissionRepo.find.mockResolvedValue([{ id: 'p2' }, { id: 'p3' }]);
      mockUserRepo.createQueryBuilder.mockReturnValue(
        queryBuilder({ raw: [{ id: 'user-a' }, { id: 'user-b' }] }),
      );

      await service.setRolePermissions('role-1', ['p2', 'p3'], 'actor-1');

      expect(mockRoleRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ permissions: [{ id: 'p2' }, { id: 'p3' }] }),
      );
      // Both holders must have their cached RBAC principal dropped.
      expect(mockEvents.publish).toHaveBeenCalledWith('user:role-changed', { userId: 'user-a' });
      expect(mockEvents.publish).toHaveBeenCalledWith('user:role-changed', { userId: 'user-b' });
    });

    it('rejects permission ids that do not exist rather than silently granting fewer', async () => {
      mockRoleRepo.findOne.mockResolvedValue({ id: 'role-1', name: 'AUDITOR', permissions: [] });
      mockPermissionRepo.find.mockResolvedValue([{ id: 'p1' }]); // asked for two, found one

      await expect(
        service.setRolePermissions('role-1', ['p1', 'ghost'], 'actor-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to strip every permission from SUPER_ADMINISTRATOR — that lockout is unrecoverable', async () => {
      mockRoleRepo.findOne.mockResolvedValue({
        id: 'role-sa',
        name: SystemRole.SUPER_ADMINISTRATOR,
        permissions: [{ id: 'p1' }],
      });
      mockPermissionRepo.find.mockResolvedValue([]);

      await expect(service.setRolePermissions('role-sa', [], 'actor-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockRoleRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('deleteRole', () => {
    it('refuses to delete a built-in role, whose name the guards compare against', async () => {
      mockRoleRepo.findOne.mockResolvedValue({ id: 'role-1', name: SystemRole.OPERATIONS_MANAGER });

      await expect(service.deleteRole('role-1', 'actor-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockRoleRepo.remove).not.toHaveBeenCalled();
    });

    it('refuses to delete a custom role that users still hold', async () => {
      mockRoleRepo.findOne.mockResolvedValue({ id: 'role-9', name: 'REGIONAL_AUDITOR' });
      mockUserRepo.createQueryBuilder.mockReturnValue(queryBuilder({ count: 3 }));

      await expect(service.deleteRole('role-9', 'actor-1')).rejects.toBeInstanceOf(ConflictException);
      expect(mockRoleRepo.remove).not.toHaveBeenCalled();
    });

    it('deletes an unused custom role', async () => {
      mockRoleRepo.findOne.mockResolvedValue({ id: 'role-9', name: 'REGIONAL_AUDITOR' });
      mockUserRepo.createQueryBuilder.mockReturnValue(queryBuilder({ count: 0 }));

      await service.deleteRole('role-9', 'actor-1');

      expect(mockRoleRepo.remove).toHaveBeenCalled();
    });

    it('reports a missing role rather than succeeding silently', async () => {
      mockRoleRepo.findOne.mockResolvedValue(null);

      await expect(service.deleteRole('nope', 'actor-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
