import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UserService } from './user.service';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { PermissionEntity } from './permission.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { rbacPrincipalCacheKey } from '../auth/auth.service';

/**
 * Restoring forced-password-change enforcement (JwtAuthGuard) reintroduces a bug the original
 * fix had to close in the SAME commit: AuthService.validateJwtPayload caches the resolved
 * principal in Redis for ~30s, invalidated only by domain events. Without an explicit,
 * DETERMINISTIC invalidation here, a user who just changed a password that cleared
 * `mustChangePassword` would keep failing the guard against their own stale cached principal for
 * up to that TTL — indistinguishable from the guard simply being broken.
 *
 * These tests pin two things: the invalidation call happens with the right key, and it is
 * genuinely AWAITED (not fire-and-forget) so it is guaranteed to have completed before the
 * caller's HTTP response returns — i.e. before their very next request could race it.
 */
describe('UserService — password change cache invalidation & session revocation', () => {
  let service: UserService;

  const mockUserRepo = {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
    save: jest.fn((v: any) => Promise.resolve(v)),
  };
  const mockRoleRepo = { find: jest.fn(), findOne: jest.fn() };
  const mockPermissionRepo = { find: jest.fn() };
  const mockAudit = { recordEvent: jest.fn().mockResolvedValue(undefined), recordEventSafe: jest.fn().mockResolvedValue(undefined) };
  const mockEvents = { publish: jest.fn() };

  // Tracks whether the cache invalidation has actually COMPLETED (not merely been kicked off).
  // A macrotask delay (setTimeout) means this only flips `true` after a full turn of the event
  // loop — long enough that a fire-and-forget (`void this.cache.del(...)`) implementation would
  // NOT have completed it by the time the surrounding service method's promise resolves, so this
  // catches a regression back to that pattern, not just a missing call.
  let cacheInvalidated = false;
  const mockCache = {
    del: jest.fn().mockImplementation(
      (..._keys: string[]) => new Promise<void>((resolve) => setTimeout(() => { cacheInvalidated = true; resolve(); }, 10)),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    cacheInvalidated = false;

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

  describe('changePassword (self-service)', () => {
    const queryBuilder = (user: any) => ({
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(user),
    });

    it('drops the caller\'s cached RBAC principal, fully awaited, before returning', async () => {
      const hash = await bcrypt.hash('old-password', 4);
      mockUserRepo.createQueryBuilder.mockReturnValue(
        queryBuilder({ id: 'u-1', username: 'staff1', passwordHash: hash, mustChangePassword: true }),
      );

      await service.changePassword('u-1', 'old-password', 'brand-new-password');

      // The whole point: by the time this line runs, the invalidation must already have
      // completed — not merely been scheduled.
      expect(cacheInvalidated).toBe(true);
      expect(mockCache.del).toHaveBeenCalledWith(rbacPrincipalCacheKey('u-1'));
    });

    it('publishes user:password-changed so every other session is revoked', async () => {
      const hash = await bcrypt.hash('old-password', 4);
      mockUserRepo.createQueryBuilder.mockReturnValue(
        queryBuilder({ id: 'u-1', username: 'staff1', passwordHash: hash, mustChangePassword: true }),
      );

      await service.changePassword('u-1', 'old-password', 'brand-new-password');

      expect(mockEvents.publish).toHaveBeenCalledWith('user:password-changed', { userId: 'u-1' });
    });

    it('never invalidates the cache when the current password is wrong', async () => {
      const hash = await bcrypt.hash('old-password', 4);
      mockUserRepo.createQueryBuilder.mockReturnValue(
        queryBuilder({ id: 'u-1', username: 'staff1', passwordHash: hash, mustChangePassword: true }),
      );

      await expect(
        service.changePassword('u-1', 'totally-wrong', 'brand-new-password'),
      ).rejects.toThrow(BadRequestException);

      expect(mockCache.del).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword (admin)', () => {
    it('drops the target user\'s cached RBAC principal, fully awaited, before returning', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'u-2', username: 'staff2', status: 'LOCKED', failedLoginAttempts: 5,
        lockedUntil: new Date(),
      });

      await service.resetPassword('u-2', 'a-brand-new-password', 'admin-1');

      expect(cacheInvalidated).toBe(true);
      expect(mockCache.del).toHaveBeenCalledWith(rbacPrincipalCacheKey('u-2'));
    });

    it('publishes user:password-changed so a stolen session cannot survive the reset', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'u-2', username: 'staff2', status: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null,
      });

      await service.resetPassword('u-2', 'a-brand-new-password', 'admin-1');

      expect(mockEvents.publish).toHaveBeenCalledWith('user:password-changed', { userId: 'u-2' });
    });
  });
});
