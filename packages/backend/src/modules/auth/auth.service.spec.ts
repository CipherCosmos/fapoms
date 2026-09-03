import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuthService, rbacPrincipalCacheKey } from './auth.service';
import { UserEntity } from '../user/user.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AuditService } from '../../core/audit/audit.service';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

describe('AuthService', () => {
  let service: AuthService;

  const mockUserRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockRefreshTokenRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((data) => data),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const mockAssayerRepo = {
    // The assayer login path now records failed attempts and clears them on success.
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn(),
    // `verifyAssayerIdentifier` counts rather than selecting, because password_hash is
    // `select: false` and must not ride along into an unauthenticated response.
    count: jest.fn().mockResolvedValue(1),
  };

  const mockJwtService = {
    sign: jest.fn().mockReturnValue('signed.jwt.token'),
  };

  const mockConfigService = {
    get: jest.fn((_key: string, defaultValue: any) => defaultValue),
  };

  const mockAuditService = {
    recordEvent: jest.fn().mockResolvedValue(undefined), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }),
  };

  // Cache always misses in tests so validateJwtPayload exercises the real DB path.
  const mockCache = {
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };

  const mockEvents = {
    subscribe: jest.fn(),
    publish: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(UserEntity), useValue: mockUserRepo },
        { provide: getRepositoryToken(RefreshTokenEntity), useValue: mockRefreshTokenRepo },
        { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerRepo },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: CacheService, useValue: mockCache },
        { provide: DomainEventPublisher, useValue: mockEvents },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn(), emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
    mockConfigService.get.mockImplementation((_key: string, defaultValue: any) => defaultValue);
    mockRefreshTokenRepo.save.mockImplementation((a) => Promise.resolve(a));
  });

  describe('login — assayer path (no matching system User)', () => {
    beforeEach(() => {
      mockUserRepo.findOne.mockResolvedValue(null);
    });

    it('rejects an unrecognized username instead of falling back to any active assayer', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(null);

      await expect(service.login('totally-unknown-user', 'whatever')).rejects.toThrow(UnauthorizedException);

      // Must never issue a second, unscoped lookup for "any active assayer"
      expect(mockAssayerRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('rejects the hardcoded "admin123" bypass password when the real password is wrong', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', passwordHash: hash, lifecycleStatus: 'ACTIVE',
      });

      await expect(service.login('AS-01', 'admin123')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an assayer with no passwordHash set rather than skipping verification', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', passwordHash: null, lifecycleStatus: 'ACTIVE',
      });

      await expect(service.login('AS-01', 'any-password')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a correct password if the assayer account is not ACTIVE', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', passwordHash: hash, lifecycleStatus: 'SUSPENDED',
      });

      await expect(service.login('AS-01', 'correct-password')).rejects.toThrow(ForbiddenException);
    });

    /**
     * Leave is not a withdrawal of access.
     *
     * The gate was `lifecycleStatus !== 'ACTIVE'`, so the moment HR marked somebody ON_LEAVE they
     * were locked out of the only screen that tells them when their leave ends, lets them set
     * availability for afterwards, or shows a message from the desk — and the refusal read
     * "Account is on_leave", which sounds like a fault to report. What leave means is "do not
     * offer them work", and that is enforced somewhere else entirely: `deriveOperationalStatus`
     * maps ON_LEAVE to INACTIVE, so the planner stops selecting them regardless of this.
     */
    it('lets somebody on leave sign in — leave stops work being offered, not access', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', passwordHash: hash, lifecycleStatus: 'ON_LEAVE',
        organizationId: 'org-1', displayName: 'Meera Iyer',
      });

      await expect(service.login('AS-01', 'correct-password')).resolves.toBeDefined();
    });

    /**
     * The expiry HR is told about is the expiry that applies.
     *
     * Issuing app access returns an `expiresAt` for HR to read out, and for a while nothing
     * compared against it: there was no column to hold it, so a credential an administrator chose
     * and spoke aloud worked for ever while the API said otherwise in the same breath as issuing
     * it. Telling somebody a credential expires when it does not is worse than saying nothing,
     * because it is exactly what stops them chasing it.
     */
    it('refuses a temporary password past its expiry', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', passwordHash: hash, lifecycleStatus: 'ACTIVE',
        mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.login('AS-01', 'correct-password'))
        .rejects.toThrow(/temporary password you were given has expired/i);
    });

    it('accepts a temporary password still inside its window', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', passwordHash: hash, lifecycleStatus: 'ACTIVE',
        organizationId: 'org-1', displayName: 'Meera Iyer',
        mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() + 60_000),
      });

      await expect(service.login('AS-01', 'correct-password')).resolves.toBeDefined();
    });

    /**
     * The two ways `tempPasswordExpiresAt` can be irrelevant, both of which must let somebody in.
     * Getting either wrong locks real people out of an application they already use — which is a
     * worse failure than the one this check exists to prevent.
     */
    it('ignores a stale expiry once the assayer has chosen their own password', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', passwordHash: hash, lifecycleStatus: 'ACTIVE',
        organizationId: 'org-1', displayName: 'Meera Iyer',
        // The clear-on-change path nulls this; belt and braces if a row ever escaped it.
        mustChangePassword: false, tempPasswordExpiresAt: new Date(Date.now() - 86_400_000),
      });

      await expect(service.login('AS-01', 'correct-password')).resolves.toBeDefined();
    });

    it('lets in an account whose password predates the expiry column', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', passwordHash: hash, lifecycleStatus: 'ACTIVE',
        organizationId: 'org-1', displayName: 'Meera Iyer',
        // Null means no expiry applies. The column was added without a backfill precisely
        // because guessing an issue date nobody recorded would lock these people out.
        mustChangePassword: true, tempPasswordExpiresAt: null,
      });

      await expect(service.login('AS-01', 'correct-password')).resolves.toBeDefined();
    });

    /**
     * Sign-in is decided in three places, and all three have to agree.
     *
     * Widening the login alone was inert. `verifyAssayerIdentifier` gates the step BEFORE the
     * password — the app confirms an identifier and shows the person's name, then asks for the
     * password — so answering null there makes the account look non-existent and the widened
     * login is never reached. And `refreshAccessToken` gates every token renewal, where the
     * mobile client treats a refusal as session death and clears the stored session: a narrower
     * rule there would have signed somebody on leave in and thrown them out at the first token
     * expiry, which reads as a broken app rather than as a policy.
     */
    it('lets somebody on leave past the identifier check that precedes the password', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Meera Iyer', lifecycleStatus: 'ON_LEAVE',
      });

      await expect(service.verifyAssayerIdentifier('AS-01'))
        .resolves.toEqual({ displayName: 'Meera Iyer', assayerCode: 'AS-01' });
    });

    /**
     * Recognised, but with no password ever issued.
     *
     * 540 sign-in-eligible assayers are in this state — imported from the roster, never invited.
     * The check confirmed the identifier and returned their real name for all of them, and the
     * password step then answered "Invalid credentials" every time: the app greeted somebody by
     * name and told them their password was wrong for an account that has never had one.
     */
    it('says access has not been issued rather than greeting somebody with no credential', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Meera Iyer', lifecycleStatus: 'ACTIVE',
      });
      mockAssayerRepo.count.mockResolvedValue(0);

      await expect(service.verifyAssayerIdentifier('AS-01'))
        .resolves.toMatchObject({ assayerCode: 'AS-01', needsAppAccess: true });
    });

    it('does not flag an account that has a password', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Meera Iyer', lifecycleStatus: 'ACTIVE',
      });
      mockAssayerRepo.count.mockResolvedValue(1);

      const out = await service.verifyAssayerIdentifier('AS-01');
      expect(out).toEqual({ displayName: 'Meera Iyer', assayerCode: 'AS-01' });
    });

    it('still hides a suspended account at the identifier check', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Meera Iyer', lifecycleStatus: 'SUSPENDED',
      });

      await expect(service.verifyAssayerIdentifier('AS-01')).resolves.toBeNull();
    });

    /**
     * The refusal used to be the enum, lower-cased: "Account is invited". An assayer standing
     * outside a branch learns nothing from that and cannot tell whether to wait or to call
     * somebody. Safe to be specific — the password was verified before this point, so only the
     * account's real holder ever reads it.
     */
    it.each([
      ['SUSPENDED', /access is on hold/i],
      ['TERMINATED', /account is closed/i],
      ['RESIGNED', /account is closed/i],
      ['ARCHIVED', /account is closed/i],
    ])('tells a %s assayer what to do next, not the name of the enum', async (status, expected) => {
      const hash = await bcrypt.hash('correct-password', 4);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', passwordHash: hash, lifecycleStatus: status,
      });

      await expect(service.login('AS-01', 'correct-password')).rejects.toThrow(expected);
    });

    /**
     * The four onboarding stages sign in now, and this used to assert the opposite.
     *
     * They were refused, which made the phone half of registration impossible: an assayer could
     * be sent an invite and then not use it until after they were activated, by which point the
     * documents it existed to collect had been collected some other way. They are let in, but
     * only into a session marked `onboarding`, which `JwtAuthGuard` confines to the registration
     * routes — see `onboarding-session.spec.ts`. Signing in is not being on duty: the derived
     * operational status for all four is INACTIVE, so the planner will not offer them work.
     */
    it.each(['INVITED', 'DOCUMENT_VERIFICATION', 'BACKGROUND_VERIFICATION', 'TRAINING'])(
      'lets a %s assayer sign in to finish their own registration',
      async (status) => {
        const hash = await bcrypt.hash('correct-password', 4);
        mockAssayerRepo.findOne.mockResolvedValue({
          id: 'asr-1', assayerCode: 'AS-01', displayName: 'Meera Iyer', email: null,
          phone: '9999999999', passwordHash: hash, lifecycleStatus: status, organizationId: 'org-1',
        });

        await expect(service.login('AS-01', 'correct-password')).resolves.toBeDefined();
      },
    );

    it('logs in successfully with an exact identifier match and the correct password', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Test Assayer', email: null, phone: '9999999999',
        passwordHash: hash, lifecycleStatus: 'ACTIVE', organizationId: 'org-1',
      });

      const result = await service.login('AS-01', 'correct-password');

      expect(result.user.id).toBe('asr-1');
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.refreshToken).toBeDefined();
    });
  });

  /**
   * The token renewal has to admit exactly who the login admits.
   *
   * Every assayer session refreshes within the hour, and the mobile client treats a refused
   * refresh as session death — it clears the stored session and drops the person back to the
   * login screen. So a renewal rule narrower than the sign-in rule does not keep anybody out; it
   * signs them in, lets them start work, and ejects them at the first token expiry. That is the
   * shape a partial fix would have taken here: the login was widened to admit ON_LEAVE and this
   * path still demanded ACTIVE.
   */
  describe('token renewal admits whoever sign-in admits', () => {
    const storedToken = () => ({
      id: 'rt-1', userId: 'asr-1', tokenHash: 'hash', isRevoked: false,
      expiresAt: new Date(Date.now() + 10000),
    });

    it('renews a session for somebody on leave', async () => {
      mockRefreshTokenRepo.findOne.mockResolvedValue(storedToken());
      mockUserRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Meera Iyer', email: null,
        phone: '9999999999', lifecycleStatus: 'ON_LEAVE', organizationId: 'org-1',
      });

      await expect(service.refreshAccessToken('some-refresh-token')).resolves.toBeDefined();
    });

    it('refuses to renew a suspended account, in the words the login uses', async () => {
      mockRefreshTokenRepo.findOne.mockResolvedValue(storedToken());
      mockUserRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Meera Iyer', email: null,
        phone: '9999999999', lifecycleStatus: 'SUSPENDED', organizationId: 'org-1',
      });

      await expect(service.refreshAccessToken('some-refresh-token'))
        .rejects.toThrow(/access is on hold/i);
    });
  });

  describe('biometricLogin', () => {
    it('rejects when there is no matching, non-revoked, unexpired refresh token', async () => {
      mockRefreshTokenRepo.findOne.mockResolvedValue(null);

      await expect(service.biometricLogin('some-refresh-token')).rejects.toThrow(UnauthorizedException);
    });

    it('redeems a valid stored refresh token and issues a fresh token pair for an assayer', async () => {
      mockRefreshTokenRepo.findOne.mockResolvedValue({
        id: 'rt-1', userId: 'asr-1', tokenHash: 'hash', isRevoked: false, expiresAt: new Date(Date.now() + 10000),
      });
      mockUserRepo.findOne.mockResolvedValue(null); // not a system user
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Test Assayer', email: null, phone: '9999999999',
        lifecycleStatus: 'ACTIVE', organizationId: 'org-1',
      });

      const result = await service.biometricLogin('some-refresh-token');

      expect(result.user.id).toBe('asr-1');
      expect(result.accessToken).toBe('signed.jwt.token');
      // Old token must be revoked (rotation) — never reusable
      expect(mockRefreshTokenRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isRevoked: true }),
      );
    });

    it('rejects when the resolved assayer account is not ACTIVE', async () => {
      mockRefreshTokenRepo.findOne.mockResolvedValue({
        id: 'rt-1', userId: 'asr-1', tokenHash: 'hash', isRevoked: false, expiresAt: new Date(Date.now() + 10000),
      });
      mockUserRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', lifecycleStatus: 'SUSPENDED',
      });

      await expect(service.biometricLogin('some-refresh-token')).rejects.toThrow(ForbiddenException);
    });

    /**
     * Biometric resume involves no password, so this response is the app's ONLY cue that a
     * forced change is pending. It used to be omitted — the biometric path silently walked past
     * the rotation requirement that /auth/login reported — and with the guard now refusing such
     * a session on every non-exempt route, omitting it again would strand the user in
     * unexplained 403s instead of on the change-password screen.
     */
    it('carries mustChangePassword so the client can route to the change-password screen', async () => {
      mockRefreshTokenRepo.findOne.mockResolvedValue({
        id: 'rt-1', userId: 'asr-1', tokenHash: 'hash', isRevoked: false, expiresAt: new Date(Date.now() + 10000),
      });
      mockUserRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Test Assayer', email: null, phone: '9999999999',
        lifecycleStatus: 'ACTIVE', organizationId: 'org-1', mustChangePassword: true,
      });

      const result = await service.biometricLogin('some-refresh-token');

      expect(result.user.mustChangePassword).toBe(true);
    });
  });

  describe('validateJwtPayload — the assayer principal carries the rotation flag', () => {
    const assayerPayload = {
      sub: 'asr-1', username: 'AS-01', email: 'as-01@fapoms.com',
      roles: ['ASSAYER'], permissions: ['assignment:read:organization'], organizationId: 'org-1',
    } as any;

    /**
     * This is the principal `JwtAuthGuard` reads on every request. Without the flag on it, the
     * guard's forced-rotation check could never fire for a field account — the exemption that
     * left the whole workforce usable on seeded/HR-known passwords.
     */
    it('puts mustChangePassword on the principal the guard enforces against', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Test Assayer', mustChangePassword: true,
      });

      const principal = await service.validateJwtPayload(assayerPayload);

      expect(principal.mustChangePassword).toBe(true);
      // And the cached copy must say the same, or the guard flip-flops with the cache.
      expect(mockCache.setJson).toHaveBeenCalledWith(
        rbacPrincipalCacheKey('asr-1'),
        expect.objectContaining({ mustChangePassword: true }),
        expect.anything(),
      );
    });

    it('carries false once the password is the assayer\'s own, leaving ordinary sessions alone', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', assayerCode: 'AS-01', displayName: 'Test Assayer', mustChangePassword: false,
      });

      const principal = await service.validateJwtPayload(assayerPayload);

      expect(principal.mustChangePassword).toBe(false);
    });
  });
    describe('brute-force lockout', () => {
      // The assayer branch had no attempt counter and the app has no rate limiting, while
      // every imported account shared the importer's documented default password.
      const bcrypt = require('bcrypt');
      const realHash = bcrypt.hashSync('correct-horse', 4);

      it('counts a failed attempt', async () => {
        mockAssayerRepo.findOne.mockResolvedValue({
          id: 'a-1', assayerCode: 'AS0001', lifecycleStatus: 'ACTIVE',
          passwordHash: realHash, failedLoginAttempts: 0, lockedUntil: null,
        });

        await expect(service.login('AS0001', 'wrong', '1.1.1.1', 'jest')).rejects.toThrow();

        expect(mockAssayerRepo.update).toHaveBeenCalledWith('a-1',
          expect.objectContaining({ failedLoginAttempts: 1, lockedUntil: null }));
      });

      it('locks the account on the fifth consecutive failure', async () => {
        mockAssayerRepo.findOne.mockResolvedValue({
          id: 'a-1', assayerCode: 'AS0001', lifecycleStatus: 'ACTIVE',
          passwordHash: realHash, failedLoginAttempts: 4, lockedUntil: null,
        });

        await expect(service.login('AS0001', 'wrong', '1.1.1.1', 'jest')).rejects.toThrow();

        const patch = mockAssayerRepo.update.mock.calls.at(-1)[1];
        expect(patch.failedLoginAttempts).toBe(5);
        expect(patch.lockedUntil).toBeInstanceOf(Date);
        expect(patch.lockedUntil.getTime()).toBeGreaterThan(Date.now());
      });

      it('refuses a locked account even when the password is correct', async () => {
        mockAssayerRepo.findOne.mockResolvedValue({
          id: 'a-1', assayerCode: 'AS0001', lifecycleStatus: 'ACTIVE',
          passwordHash: realHash, failedLoginAttempts: 5,
          lockedUntil: new Date(Date.now() + 10 * 60 * 1000),
        });

        await expect(service.login('AS0001', 'correct-horse', '1.1.1.1', 'jest'))
          .rejects.toThrow(/try again in \d+ minute/i);
      });

      it('clears the counter after a successful sign-in', async () => {
        mockAssayerRepo.findOne.mockResolvedValue({
          id: 'a-1', assayerCode: 'AS0001', lifecycleStatus: 'ACTIVE',
          passwordHash: realHash, failedLoginAttempts: 3, lockedUntil: null,
        });

        await service.login('AS0001', 'correct-horse', '1.1.1.1', 'jest');

        expect(mockAssayerRepo.update).toHaveBeenCalledWith('a-1',
          { failedLoginAttempts: 0, lockedUntil: null });
      });
    });

  describe('login — staff user path re-selects passwordHash (select: false on the entity)', () => {
    it('authenticates a staff user even though the relation-loaded row does not carry the hash', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      // The first findOne (with relations) simulates `select: false` — no passwordHash on the
      // returned row. The second, targeted findOne is what opts back in.
      mockUserRepo.findOne
        .mockResolvedValueOnce({
          id: 'u-1', username: 'staff1', email: 'staff1@example.com', roles: [],
          status: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null,
        })
        .mockResolvedValueOnce({ id: 'u-1', passwordHash: hash });

      const result = await service.login('staff1', 'correct-password');

      expect(result.user.id).toBe('u-1');
      expect(result.accessToken).toBe('signed.jwt.token');
      // The targeted re-select must have been asked for by id with an explicit passwordHash select.
      expect(mockUserRepo.findOne).toHaveBeenNthCalledWith(2, {
        where: { id: 'u-1' },
        select: { id: true, passwordHash: true },
      });
    });
  });

  describe('login — assayer-not-found timing oracle (DUMMY_BCRYPT_HASH)', () => {
    it('still spends a bcrypt compare when no assayer matches, so timing does not reveal existence', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.findOne.mockResolvedValue(null);
      const spy = jest.spyOn(bcrypt, 'compare');

      await expect(service.login('nobody-like-this', 'whatever')).rejects.toThrow(UnauthorizedException);

      expect(spy).toHaveBeenCalledWith('whatever', expect.stringMatching(/^\$2[aby]\$/));
      spy.mockRestore();
    });
  });

  describe('refresh token reuse detection', () => {
    const baseToken = {
      id: 'rt-1', userId: 'u-1', tokenHash: 'hash', isRevoked: true,
      expiresAt: new Date(Date.now() + 100000),
    };

    it('rejects but does NOT revoke the family inside the grace window (an ordinary two-tab race)', async () => {
      mockRefreshTokenRepo.findOne.mockResolvedValue({ ...baseToken, revokedAt: new Date() });

      await expect(service.refreshAccessToken('some-token')).rejects.toThrow(UnauthorizedException);

      expect(mockRefreshTokenRepo.update).not.toHaveBeenCalled();
      expect(mockAuditService.recordEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'REFRESH_TOKEN_REUSE_DETECTED' }),
      );
    });

    it('treats a reuse outside the grace window as theft: revokes every session and audits it', async () => {
      mockRefreshTokenRepo.findOne.mockResolvedValue({
        ...baseToken, revokedAt: new Date(Date.now() - 60_000), // 60s ago, past the 30s default grace
      });

      await expect(service.refreshAccessToken('stolen-token')).rejects.toThrow(UnauthorizedException);

      expect(mockRefreshTokenRepo.update).toHaveBeenCalledWith(
        { userId: 'u-1', isRevoked: false },
        expect.objectContaining({ isRevoked: true }),
      );
      expect(mockCache.del).toHaveBeenCalledWith(rbacPrincipalCacheKey('u-1'));
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'REFRESH_TOKEN_REUSE_DETECTED', entityId: 'u-1' }),
      );
    });

    it('rejects an expired (but not revoked) token without touching reuse handling', async () => {
      mockRefreshTokenRepo.findOne.mockResolvedValue({
        ...baseToken, isRevoked: false, revokedAt: null, expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.refreshAccessToken('expired-token')).rejects.toThrow(UnauthorizedException);
      expect(mockRefreshTokenRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllSessions', () => {
    it('revokes every live refresh token for the user and drops their cached principal', async () => {
      await service.revokeAllSessions('u-9');

      expect(mockRefreshTokenRepo.update).toHaveBeenCalledWith(
        { userId: 'u-9', isRevoked: false },
        expect.objectContaining({ isRevoked: true }),
      );
      expect(mockCache.del).toHaveBeenCalledWith(rbacPrincipalCacheKey('u-9'));
    });
  });

  describe('user:password-changed — session revocation and cache invalidation wiring', () => {
    it('subscribes on module init and revokes sessions when the event fires', async () => {
      service.onModuleInit();

      const passwordChangedHandler = mockEvents.subscribe.mock.calls.find(
        (call: any[]) => call[0] === 'user:password-changed',
      )?.[1];
      expect(passwordChangedHandler).toBeDefined();

      await passwordChangedHandler({ userId: 'u-42' });

      expect(mockRefreshTokenRepo.update).toHaveBeenCalledWith(
        { userId: 'u-42', isRevoked: false },
        expect.objectContaining({ isRevoked: true }),
      );
      expect(mockCache.del).toHaveBeenCalledWith(rbacPrincipalCacheKey('u-42'));
    });
  });
});
