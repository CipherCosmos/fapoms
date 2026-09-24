import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { PermissionEntity } from './permission.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { EmailService } from '../notifications/email.service';
import { UserStatus } from '@fapoms/shared';

/**
 * SETTING A PASSWORD THROUGH A LINK ENDS EVERY SESSION OPENED WITH THE OLD ONE.
 *
 * A reset link is what somebody asks for when they think their account was used by someone else.
 * An admin reset already published 'user:password-changed' (AuthService subscribes and calls
 * revokeAllSessions, which kills every refresh token). The link path did not, so a stolen refresh
 * token kept rotating after the owner had "reset" their password.
 */
describe('completePasswordSetup revokes existing sessions', () => {
  let service: UserService;
  let stored: Partial<UserEntity>;
  const events = { publish: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    stored = {
      id: 'u9', username: 'meera', email: 'meera@example.in', displayName: 'Meera Rao',
      firstName: 'Meera', lastName: 'Rao', status: UserStatus.ACTIVE,
      failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: false,
      passwordSetupTokenHash: null, passwordSetupExpiresAt: null,
    } as Partial<UserEntity>;
    const users = {
      findOne: jest.fn(async (opts: any) => {
        const wanted = opts?.where?.passwordSetupTokenHash;
        if (wanted !== undefined) return stored.passwordSetupTokenHash === wanted ? stored : null;
        return stored;
      }),
      save: jest.fn(async (u: Partial<UserEntity>) => u),
      find: jest.fn(async () => []),
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          addSelect: () => qb, where: () => qb, andWhere: () => qb,
          getOne: async () => stored,
        };
        return qb;
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(UserEntity), useValue: users },
        { provide: getRepositoryToken(RoleEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: getRepositoryToken(PermissionEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: AuditService, useValue: { recordEvent: jest.fn(), recordEventSafe: jest.fn() } },
        { provide: DomainEventPublisher, useValue: events },
        { provide: CacheService, useValue: { del: jest.fn().mockResolvedValue(undefined) } },
        { provide: EmailService, useValue: { queue: jest.fn().mockResolvedValue({ id: 'e', status: 'QUEUED' }) } },
      ],
    }).compile();
    service = module.get(UserService);
  });

  it('publishes user:password-changed for the holder once the new password is saved', async () => {
    const { link } = await service.sendPasswordSetupLink('u9', 'admin-1', 'RESET');
    events.publish.mockClear();

    await service.completePasswordSetup(link.split('/').pop()!, 'a-decent-password-42');

    expect(events.publish).toHaveBeenCalledWith('user:password-changed', { userId: 'u9' });
  });

  it('publishes nothing when the link is refused', async () => {
    await expect(service.completePasswordSetup('not-a-real-token', 'a-decent-password-42')).rejects.toThrow();
    expect(events.publish).not.toHaveBeenCalledWith('user:password-changed', expect.anything());
  });
});
