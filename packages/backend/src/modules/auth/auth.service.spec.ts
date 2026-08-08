import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { UserEntity } from '../user/user.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AuditService } from '../../core/audit/audit.service';

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
  };

  const mockAssayerRepo = {
    // The assayer login path now records failed attempts and clears them on success.
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn(),
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
  });
    describe('brute-force lockout', () => {
      // The assayer branch had no attempt counter and the app has no rate limiting, while
      // 24 of 25 live accounts shared the importer's documented default password.
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


});
