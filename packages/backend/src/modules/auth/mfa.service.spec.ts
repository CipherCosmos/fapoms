import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MfaService } from './mfa.service';
import { UserMfaEntity } from './user-mfa.entity';
import { MfaRecoveryCodeEntity } from './mfa-recovery-code.entity';
import { AuditService } from '../../core/audit/audit.service';
import { generateTotpSecret, totp, hashRecoveryCode } from './totp';

/**
 * MFA service behaviour. The security-critical claims verified here:
 *  - a factor is never "required" at login until it is CONFIRMED (enrol-confirm-before-activate);
 *  - enrolment refuses to clobber an active factor;
 *  - wrong codes are rejected and lock the account after a bounded number of tries (brute-force cap);
 *  - recovery codes are single-use (a used code never works twice);
 *  - disable/regenerate are guarded and audited.
 *
 * Repositories are backed by small in-memory fakes so the real branching runs (no DB), including the
 * atomic single-use recovery-code consume, which is expressed as a conditional UPDATE.
 */
describe('MfaService', () => {
  let service: MfaService;
  const USER = 'user-1';

  // --- in-memory user_mfa (one row per user+type; the service only uses TOTP) ---
  let mfaRow: any;
  const mfaRepo = {
    findOne: jest.fn(async ({ where }: any) => (mfaRow && mfaRow.userId === where.userId && mfaRow.type === where.type ? mfaRow : null)),
    create: jest.fn((d: any) => ({ failedAttempts: 0, lockedUntil: null, confirmedAt: null, ...d })),
    save: jest.fn(async (r: any) => { mfaRow = r; return r; }),
    delete: jest.fn(async () => { mfaRow = null; return { affected: 1 }; }),
  };

  // --- in-memory mfa_recovery_codes ---
  let codes: Array<{ userId: string; codeHash: string; usedAt: Date | null }> = [];
  const recoveryRepo = {
    count: jest.fn(async ({ where }: any) => codes.filter((c) => c.userId === where.userId && c.usedAt === null).length),
    create: jest.fn((d: any) => ({ usedAt: null, ...d })),
    save: jest.fn(async (rows: any[]) => { codes.push(...rows); return rows; }),
    delete: jest.fn(async ({ userId }: any) => { codes = codes.filter((c) => c.userId !== userId); return { affected: 1 }; }),
    // Mirrors the conditional UPDATE in consumeRecoveryCode: mark used only if currently unused.
    createQueryBuilder: jest.fn(() => {
      const params: any = {};
      const chain: any = {
        update: () => chain,
        set: () => chain,
        where: (_sql: string, p: any) => { Object.assign(params, p); return chain; },
        andWhere: (_sql: string, p?: any) => { if (p) Object.assign(params, p); return chain; },
        execute: async () => {
          const hit = codes.find((c) => c.userId === params.userId && c.codeHash === params.hash && c.usedAt === null);
          if (hit) { hit.usedAt = new Date(); return { affected: 1 }; }
          return { affected: 0 };
        },
      };
      return chain;
    }),
  };

  const audit = { recordEventSafe: jest.fn().mockResolvedValue(undefined), recordEvent: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    mfaRow = null;
    codes = [];
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: getRepositoryToken(UserMfaEntity), useValue: mfaRepo },
        { provide: getRepositoryToken(MfaRecoveryCodeEntity), useValue: recoveryRepo },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(MfaService);
  });

  describe('isChallengeRequired — a factor gates login only once CONFIRMED', () => {
    it('is false when the user has no MFA row', async () => {
      expect(await service.isChallengeRequired(USER)).toBe(false);
    });
    it('is false while enrolled-but-unconfirmed (a code has not been proven)', async () => {
      mfaRow = { userId: USER, type: 'TOTP', secret: generateTotpSecret(), confirmedAt: null };
      expect(await service.isChallengeRequired(USER)).toBe(false);
    });
    it('is true once confirmed', async () => {
      mfaRow = { userId: USER, type: 'TOTP', secret: generateTotpSecret(), confirmedAt: new Date() };
      expect(await service.isChallengeRequired(USER)).toBe(true);
    });
  });

  describe('enrol → confirm', () => {
    it('beginEnrol stores an unconfirmed secret and returns an otpauth URI', async () => {
      const res = await service.beginEnrol(USER, 'alice@example.com');
      expect(res.secret).toBeTruthy();
      expect(res.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      expect(mfaRow.confirmedAt).toBeNull();
      expect(await service.isChallengeRequired(USER)).toBe(false); // still dormant
    });

    it('beginEnrol refuses to clobber an already-confirmed factor', async () => {
      mfaRow = { userId: USER, type: 'TOTP', secret: generateTotpSecret(), confirmedAt: new Date() };
      await expect(service.beginEnrol(USER, 'alice@example.com')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirmEnrol rejects a wrong code and does NOT activate', async () => {
      await service.beginEnrol(USER, 'alice@example.com');
      await expect(service.confirmEnrol(USER, '000000')).rejects.toBeInstanceOf(BadRequestException);
      expect(mfaRow.confirmedAt).toBeNull();
    });

    it('confirmEnrol activates on a correct code and issues single-use recovery codes', async () => {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      const { recoveryCodes } = await service.confirmEnrol(USER, totp(secret));
      expect(mfaRow.confirmedAt).toBeInstanceOf(Date);
      expect(recoveryCodes).toHaveLength(10);
      expect(codes).toHaveLength(10);
      // Stored only as hashes — the plaintext never equals what is persisted.
      expect(codes.every((c) => !recoveryCodes.includes(c.codeHash))).toBe(true);
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MFA_ENABLED' }));
    });

    it('confirmEnrol refuses when enrolment was never started', async () => {
      await expect(service.confirmEnrol(USER, '123456')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('verify at login', () => {
    async function enrolConfirmed(): Promise<string> {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      await service.confirmEnrol(USER, totp(secret));
      return secret;
    }

    it('returns false when there is nothing confirmed to verify against', async () => {
      expect(await service.verify(USER, '123456')).toBe(false);
    });

    it('accepts a valid TOTP code', async () => {
      const secret = await enrolConfirmed();
      expect(await service.verify(USER, totp(secret))).toBe(true);
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MFA_VERIFIED' }));
    });

    it('rejects a wrong code and counts the failure', async () => {
      await enrolConfirmed();
      expect(await service.verify(USER, '000000')).toBe(false);
      expect(mfaRow.failedAttempts).toBe(1);
    });

    it('locks the account after 5 consecutive wrong codes, then refuses even a correct one', async () => {
      const secret = await enrolConfirmed();
      for (let i = 0; i < 5; i++) expect(await service.verify(USER, '000000')).toBe(false);
      expect(mfaRow.lockedUntil).toBeInstanceOf(Date);
      expect(mfaRow.lockedUntil.getTime()).toBeGreaterThan(Date.now());
      // Even the right code is refused while locked.
      await expect(service.verify(USER, totp(secret))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accepts a recovery code and burns it (single-use)', async () => {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      const { recoveryCodes } = await service.confirmEnrol(USER, totp(secret));
      const one = recoveryCodes[0];
      expect(one).toMatch(/-/); // recovery codes are hyphenated, which is how verify routes them
      expect(await service.verify(USER, one)).toBe(true);
      // Second use of the same code must fail — it was consumed.
      expect(await service.verify(USER, one)).toBe(false);
      expect(codes.find((c) => c.codeHash === hashRecoveryCode(one))?.usedAt).toBeInstanceOf(Date);
    });

    it('resets the failure counter after a success', async () => {
      const secret = await enrolConfirmed();
      await service.verify(USER, '000000'); // one failure
      expect(mfaRow.failedAttempts).toBe(1);
      await service.verify(USER, totp(secret)); // success
      expect(mfaRow.failedAttempts).toBe(0);
    });
  });

  describe('disable / regenerate', () => {
    it('disable removes the factor and every recovery code, and audits it', async () => {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      await service.confirmEnrol(USER, totp(secret));
      await service.disable(USER, 'admin-9');
      expect(mfaRow).toBeNull();
      expect(codes).toHaveLength(0);
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MFA_DISABLED' }));
    });

    it('regenerateRecoveryCodes refuses when MFA is not active', async () => {
      await expect(service.regenerateRecoveryCodes(USER)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('regenerateRecoveryCodes replaces the old set (old codes stop working)', async () => {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      const first = (await service.confirmEnrol(USER, totp(secret))).recoveryCodes;
      const second = await service.regenerateRecoveryCodes(USER);
      expect(second).toHaveLength(10);
      // An old code is gone — its hash is no longer stored.
      expect(codes.some((c) => c.codeHash === hashRecoveryCode(first[0]))).toBe(false);
      expect(await service.verify(USER, first[0])).toBe(false);
    });
  });
});
