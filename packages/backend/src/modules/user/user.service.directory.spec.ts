import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserStatus } from '@fapoms/shared';
import { UserService } from './user.service';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { PermissionEntity } from './permission.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../../infrastructure/cache/cache.service';

/**
 * `findDirectory` — the "pick a colleague" list behind `GET /users/directory`.
 *
 * It exists specifically because `findAll` is the wrong endpoint for a name picker: gated
 * `@Roles(ADMIN)` plus `user:view:organization`, and it hands back email, lockout state and
 * every role held. These tests pin the narrower query and the narrower shape it is for.
 */
describe('UserService — directory', () => {
  let service: UserService;
  const mockUserRepo = { findAndCount: jest.fn() };
  const mockRoleRepo = {};
  const mockPermissionRepo = {};

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(UserEntity), useValue: mockUserRepo },
        { provide: getRepositoryToken(RoleEntity), useValue: mockRoleRepo },
        { provide: getRepositoryToken(PermissionEntity), useValue: mockPermissionRepo },
        { provide: AuditService, useValue: { recordEventSafe: jest.fn() } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: CacheService, useValue: { del: jest.fn() } },
      ],
    }).compile();
    service = module.get<UserService>(UserService);
  });

  it('asks for active staff only, and nothing but id and display name', async () => {
    mockUserRepo.findAndCount.mockResolvedValue([
      [{ id: 'u-1', displayName: 'Asha Rao' }, { id: 'u-2', displayName: 'Bilal Khan' }],
      2,
    ]);

    const result = await service.findDirectory();

    expect(mockUserRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: UserStatus.ACTIVE }, select: ['id', 'displayName'] }),
    );
    expect(result.people).toEqual([
      { id: 'u-1', displayName: 'Asha Rao' },
      { id: 'u-2', displayName: 'Bilal Khan' },
    ]);
    expect(result.total).toBe(2);
  });

  it('never leaks a field beyond id and display name, even if the repository returns more', async () => {
    mockUserRepo.findAndCount.mockResolvedValue([
      [{ id: 'u-1', displayName: 'Asha Rao', email: 'asha@example.com', passwordHash: 'x' }],
      1,
    ]);

    const result = await service.findDirectory();

    expect(result.people[0]).toEqual({ id: 'u-1', displayName: 'Asha Rao' });
  });
});
