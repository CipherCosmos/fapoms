import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MfaService } from './mfa.service';
import { UserMfaEntity } from './user-mfa.entity';
import { MfaRecoveryCodeEntity } from './mfa-recovery-code.entity';
import { AuditService } from '../../core/audit/audit.service';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { generateTotpSecret, totp, hashRecoveryCode } from './totp';

/**
 * MFA service behaviour across all three factors (authenticator TOTP + delivered email/SMS) and the
 * account-level recovery codes. The security-critical claims verified here:
 *  - a factor never gates login until it is CONFIRMED (enrol-confirm-before-activate), for every type;
 *  - enrolment refuses to clobber an active factor;
 *  - SMS enrolment is refused with a clear error when no SMS provider is configured — never silently;
 *  - wrong codes are rejected and lock the account after a bounded number of tries;
 *  - recovery codes are minted once (first factor), single-use, hashed, and shared across factors;
 *  - removing one factor of several leaves the others and their recovery path intact.
 *
 * Repositories, cache, and the email/SMS providers are small in-memory fakes so the real branching
 * runs (no DB, no network), including the atomic single-use recovery-code consume.
 */
describe('MfaService', () => {
  let service: MfaService;
  const USER = 'user-1';

  // --- in-memory user_mfa (one row per user+type: TOTP / EMAIL / SMS) ---
  let rows: any[] = [];
  const whereMatch = (r: any, where: any): boolean => {
    if (!where) return true;
    if (where.userId !== undefined && r.userId !== where.userId) return false;
    if (where.type !== undefined && r.type !== where.type) return false;
    if (where.confirmedAt !== undefined) {
      // The service only ever passes Not(IsNull()) here — read it as "must be confirmed".
      const wantsNotNull = typeof where.confirmedAt === 'object' && where.confirmedAt !== null;
      if (wantsNotNull && !r.confirmedAt) return false;
    }
    return true;
  };
  const getRow = (type = 'TOTP') => rows.find((r) => r.type === type) || null;
  const mfaRepo = {
    find: jest.fn(async ({ where }: any = {}) => rows.filter((r) => whereMatch(r, where))),
    findOne: jest.fn(async ({ where }: any = {}) => rows.find((r) => whereMatch(r, where)) || null),
    count: jest.fn(async ({ where }: any = {}) => rows.filter((r) => whereMatch(r, where)).length),
    create: jest.fn((d: any) => ({ id: `mfa-${rows.length + 1}`, failedAttempts: 0, lockedUntil: null, confirmedAt: null, ...d })),
    save: jest.fn(async (r: any) => {
      const i = rows.findIndex((x) => x === r || (x.userId === r.userId && x.type === r.type));
      if (i >= 0) rows[i] = r; else rows.push(r);
      return r;
    }),
    delete: jest.fn(async (crit: any) => {
      const before = rows.length;
      rows = rows.filter((r) => !(r.userId === crit.userId && (crit.type === undefined || r.type === crit.type)));
      return { affected: before - rows.length };
    }),
  };

  // --- in-memory mfa_recovery_codes ---
  let codes: Array<{ userId: string; codeHash: string; usedAt: Date | null }> = [];
  const recoveryRepo = {
    count: jest.fn(async ({ where }: any) => codes.filter((c) => c.userId === where.userId && c.usedAt === null).length),
    create: jest.fn((d: any) => ({ usedAt: null, ...d })),
    save: jest.fn(async (r: any[]) => { codes.push(...r); return r; }),
    delete: jest.fn(async ({ userId }: any) => { codes = codes.filter((c) => c.userId !== userId); return { affected: 1 }; }),
    createQueryBuilder: jest.fn(() => {
      const params: any = {};
      const chain: any = {
        update: () => chain, set: () => chain,
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

  // --- cache (enrolment codes), captured from the "sent" message ---
  let cacheStore: Map<string, any>;
  const cache = {
    getJson: jest.fn(async (k: string) => (cacheStore.has(k) ? cacheStore.get(k) : null)),
    setJson: jest.fn(async (k: string, v: any) => { cacheStore.set(k, v); }),
    del: jest.fn(async (k: string) => { cacheStore.delete(k); }),
  };

  // The delivered code is random; capture it from whatever channel "sends" it so a test can enter it.
  let lastCode: string | null = null;
  let smsEnabled = true;
  const capture = (s: string | undefined) => { const m = /\b(\d{6})\b/.exec(s || ''); if (m) lastCode = m[1]; };
  const email = { send: jest.fn(async (payload: any) => { capture(payload.text); return { success: true }; }) };
  const sms = { isEnabled: jest.fn(() => smsEnabled), send: jest.fn(async (_to: string, msg: string) => { capture(msg); return true; }) };

  beforeEach(async () => {
    rows = []; codes = []; cacheStore = new Map(); lastCode = null; smsEnabled = true;
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: getRepositoryToken(UserMfaEntity), useValue: mfaRepo },
        { provide: getRepositoryToken(MfaRecoveryCodeEntity), useValue: recoveryRepo },
        { provide: AuditService, useValue: audit },
        { provide: CacheService, useValue: cache },
        { provide: EmailProvider, useValue: email },
        { provide: SmsProvider, useValue: sms },
      ],
    }).compile();
    service = module.get(MfaService);
  });

  describe('isChallengeRequired / factorsFor — gate only on CONFIRMED factors', () => {
    it('is false when the user has no MFA row', async () => {
      expect(await service.isChallengeRequired(USER)).toBe(false);
      expect(await service.factorsFor(USER)).toEqual([]);
    });
    it('is false while enrolled-but-unconfirmed', async () => {
      rows.push({ userId: USER, type: 'TOTP', secret: generateTotpSecret(), confirmedAt: null });
      expect(await service.isChallengeRequired(USER)).toBe(false);
    });
    it('is true once any factor is confirmed, and factorsFor lists them TOTP-first', async () => {
      rows.push({ userId: USER, type: 'EMAIL', secret: 'a@b.com', confirmedAt: new Date() });
      rows.push({ userId: USER, type: 'TOTP', secret: generateTotpSecret(), confirmedAt: new Date() });
      expect(await service.isChallengeRequired(USER)).toBe(true);
      expect(await service.factorsFor(USER)).toEqual(['TOTP', 'EMAIL']);
    });
  });

  describe('TOTP enrol → confirm', () => {
    it('beginEnrol stores an unconfirmed secret and returns an otpauth URI', async () => {
      const res = await service.beginEnrol(USER, 'alice@example.com');
      expect(res.secret).toBeTruthy();
      expect(res.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      expect(getRow('TOTP').confirmedAt).toBeNull();
      expect(await service.isChallengeRequired(USER)).toBe(false);
    });

    it('beginEnrol refuses to clobber an already-confirmed factor', async () => {
      rows.push({ userId: USER, type: 'TOTP', secret: generateTotpSecret(), confirmedAt: new Date() });
      await expect(service.beginEnrol(USER, 'alice@example.com')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirmEnrol rejects a wrong code and does NOT activate', async () => {
      await service.beginEnrol(USER, 'alice@example.com');
      await expect(service.confirmEnrol(USER, '000000')).rejects.toBeInstanceOf(BadRequestException);
      expect(getRow('TOTP').confirmedAt).toBeNull();
    });

    it('confirmEnrol activates on a correct code and issues single-use recovery codes', async () => {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      const { recoveryCodes } = await service.confirmEnrol(USER, totp(secret));
      expect(getRow('TOTP').confirmedAt).toBeInstanceOf(Date);
      expect(recoveryCodes).toHaveLength(10);
      expect(codes).toHaveLength(10);
      expect(codes.every((c) => !recoveryCodes.includes(c.codeHash))).toBe(true); // only hashes stored
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MFA_ENABLED' }));
    });

    it('confirmEnrol refuses when enrolment was never started', async () => {
      await expect(service.confirmEnrol(USER, '123456')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('email / SMS delivered-factor enrol', () => {
    it('email enrol sends a code, stores an unconfirmed row, and reports a masked destination', async () => {
      const res = await service.beginDeliveredEnrol(USER, 'EMAIL', 'alice@example.com');
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(res.sentTo).toBe('a****@example.com');
      expect(getRow('EMAIL').confirmedAt).toBeNull();
      expect(await service.isChallengeRequired(USER)).toBe(false); // dormant until confirmed
      expect(cacheStore.has(`mfa:enrol:${USER}:EMAIL`)).toBe(true); // code hash stashed, not the code
    });

    it('SMS enrol is refused with a clear message when SMS is not configured', async () => {
      smsEnabled = false;
      await expect(service.beginDeliveredEnrol(USER, 'SMS', '9876543210'))
        .rejects.toThrow(/SMS delivery is not configured/i);
      expect(sms.send).not.toHaveBeenCalled();
      expect(getRow('SMS')).toBeNull();
    });

    it('SMS enrol sends when configured', async () => {
      const res = await service.beginDeliveredEnrol(USER, 'SMS', '9876543210');
      expect(sms.send).toHaveBeenCalledTimes(1);
      expect(res.sentTo).toBe('********10');
    });

    it('email confirm activates with the sent code and rejects a wrong one', async () => {
      await service.beginDeliveredEnrol(USER, 'EMAIL', 'alice@example.com');
      await expect(service.confirmEnrol(USER, '000000', 'EMAIL')).rejects.toBeInstanceOf(BadRequestException);
      const { recoveryCodes } = await service.confirmEnrol(USER, lastCode as string, 'EMAIL');
      expect(getRow('EMAIL').confirmedAt).toBeInstanceOf(Date);
      expect(recoveryCodes).toHaveLength(10); // first factor -> recovery codes minted
      expect(cacheStore.has(`mfa:enrol:${USER}:EMAIL`)).toBe(false); // enrol code consumed
    });

    it('a second factor confirm does NOT reissue recovery codes (keeps the ones already saved)', async () => {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      const first = (await service.confirmEnrol(USER, totp(secret))).recoveryCodes;
      expect(first).toHaveLength(10);
      await service.beginDeliveredEnrol(USER, 'EMAIL', 'alice@example.com');
      const second = (await service.confirmEnrol(USER, lastCode as string, 'EMAIL')).recoveryCodes;
      expect(second).toEqual([]);           // not reissued
      expect(codes).toHaveLength(10);        // the original set is untouched
    });
  });

  describe('sendLoginCode (delivered factor at login)', () => {
    it('sends and returns a hash + masked destination for a confirmed email factor', async () => {
      rows.push({ userId: USER, type: 'EMAIL', secret: 'bob@example.com', confirmedAt: new Date() });
      const res = await service.sendLoginCode(USER, 'EMAIL');
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(res.sentTo).toBe('b**@example.com');
      expect(res.codeHash).toMatch(/^[0-9a-f]{64}$/); // opaque SHA-256, never the code itself
      expect(res.expiresAt).toBeGreaterThan(Date.now());
    });

    it('refuses a factor the user has not confirmed', async () => {
      await expect(service.sendLoginCode(USER, 'EMAIL')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses SMS when the provider is not configured', async () => {
      rows.push({ userId: USER, type: 'SMS', secret: '9876543210', confirmedAt: new Date() });
      smsEnabled = false;
      await expect(service.sendLoginCode(USER, 'SMS')).rejects.toThrow(/not configured/i);
    });
  });

  describe('verify at login', () => {
    async function enrolTotp(): Promise<string> {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      await service.confirmEnrol(USER, totp(secret));
      return secret;
    }

    it('returns false when there is nothing to verify against', async () => {
      expect(await service.verify(USER, '123456')).toBe(false);
    });

    it('accepts a valid TOTP code', async () => {
      const secret = await enrolTotp();
      expect(await service.verify(USER, totp(secret))).toBe(true);
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MFA_VERIFIED' }));
    });

    it('rejects a wrong code and counts the failure', async () => {
      await enrolTotp();
      expect(await service.verify(USER, '000000')).toBe(false);
      expect(getRow('TOTP').failedAttempts).toBe(1);
    });

    it('locks after 5 wrong codes, then refuses even a correct one', async () => {
      const secret = await enrolTotp();
      for (let i = 0; i < 5; i++) expect(await service.verify(USER, '000000')).toBe(false);
      expect(getRow('TOTP').lockedUntil).toBeInstanceOf(Date);
      await expect(service.verify(USER, totp(secret))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accepts a recovery code and burns it (single-use)', async () => {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      const { recoveryCodes } = await service.confirmEnrol(USER, totp(secret));
      const one = recoveryCodes[0];
      expect(one).toMatch(/-/);
      expect(await service.verify(USER, one)).toBe(true);
      expect(await service.verify(USER, one)).toBe(false); // already consumed
      expect(codes.find((c) => c.codeHash === hashRecoveryCode(one))?.usedAt).toBeInstanceOf(Date);
    });

    it('accepts a recovery code for an EMAIL-only account (no TOTP row present)', async () => {
      await service.beginDeliveredEnrol(USER, 'EMAIL', 'alice@example.com');
      const { recoveryCodes } = await service.confirmEnrol(USER, lastCode as string, 'EMAIL');
      expect(getRow('TOTP')).toBeNull(); // no authenticator, yet recovery still works
      expect(await service.verify(USER, recoveryCodes[0])).toBe(true);
    });

    it('resets the failure counter after a success', async () => {
      const secret = await enrolTotp();
      await service.verify(USER, '000000');
      expect(getRow('TOTP').failedAttempts).toBe(1);
      await service.verify(USER, totp(secret));
      expect(getRow('TOTP').failedAttempts).toBe(0);
    });
  });

  describe('disable / regenerate', () => {
    it('disable() with no factor removes everything and audits it', async () => {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      await service.confirmEnrol(USER, totp(secret));
      await service.disable(USER, 'admin-9');
      expect(rows).toHaveLength(0);
      expect(codes).toHaveLength(0);
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MFA_DISABLED' }));
    });

    it('disable(one factor) leaves the others and the shared recovery codes intact', async () => {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      await service.confirmEnrol(USER, totp(secret));                 // TOTP + recovery codes
      await service.beginDeliveredEnrol(USER, 'EMAIL', 'a@b.com');
      await service.confirmEnrol(USER, lastCode as string, 'EMAIL');   // EMAIL, no reissue
      await service.disable(USER, USER, 'TOTP');
      expect(getRow('TOTP')).toBeNull();
      expect(getRow('EMAIL')).not.toBeNull();
      expect(codes).toHaveLength(10); // recovery kept — EMAIL still needs a fallback
    });

    it('removing the LAST factor also clears the recovery codes', async () => {
      await service.beginDeliveredEnrol(USER, 'EMAIL', 'a@b.com');
      await service.confirmEnrol(USER, lastCode as string, 'EMAIL');
      expect(codes).toHaveLength(10);
      await service.disable(USER, USER, 'EMAIL');
      expect(codes).toHaveLength(0);
    });

    it('regenerateRecoveryCodes refuses when no factor is active', async () => {
      await expect(service.regenerateRecoveryCodes(USER)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('regenerateRecoveryCodes replaces the old set (old codes stop working)', async () => {
      const { secret } = await service.beginEnrol(USER, 'alice@example.com');
      const first = (await service.confirmEnrol(USER, totp(secret))).recoveryCodes;
      const second = await service.regenerateRecoveryCodes(USER);
      expect(second).toHaveLength(10);
      expect(codes.some((c) => c.codeHash === hashRecoveryCode(first[0]))).toBe(false);
      expect(await service.verify(USER, first[0])).toBe(false);
    });
  });
});
