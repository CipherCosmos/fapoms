import 'reflect-metadata';
import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { generateTotpSecret, totp } from './totp';

/**
 * TURNING TWO-STEP VERIFICATION OFF NEEDS MORE THAN A SESSION.
 *
 * DELETE /auth/mfa and POST /auth/mfa/recovery/regenerate used to accept any live session. A stolen
 * session could therefore switch MFA off, or mint itself a fresh set of recovery codes, and the
 * account's owner would never know until the next time it mattered. Both now need the current
 * password or a fresh authenticator code in the body.
 */
describe('MFA step-up on disable and recovery regenerate', () => {
  const USER = 'u-1';
  const PASSWORD = 'correct horse battery 42';
  let passwordHash: string;
  let secret: string;
  let rows: any[];
  let service: MfaService;
  let controller: MfaController;
  let disableSpy: jest.SpyInstance;
  let regenSpy: jest.SpyInstance;
  const audit = { recordEventSafe: jest.fn(), recordEvent: jest.fn() };

  beforeAll(async () => { passwordHash = await bcrypt.hash(PASSWORD, 4); });

  beforeEach(() => {
    jest.clearAllMocks();
    secret = generateTotpSecret();
    rows = [{ userId: USER, type: 'TOTP', secret, confirmedAt: new Date(), failedAttempts: 0, lockedUntil: null }];
    const matches = (r: any, w: any) => (!w.userId || r.userId === w.userId) && (!w.type || r.type === w.type)
      && (w.confirmedAt === undefined || !!r.confirmedAt);
    const mfaRepo = {
      findOne: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
      count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
      save: jest.fn(async (r: any) => r),
      delete: jest.fn(async (crit: any) => { rows = rows.filter((r) => !(r.userId === crit.userId && (!crit.type || r.type === crit.type))); }),
    };
    const recoveryRepo = {
      delete: jest.fn(async () => ({ affected: 0 })),
      create: jest.fn((d: any) => d),
      save: jest.fn(async (d: any) => d),
    };
    const usersRepo = {
      createQueryBuilder: jest.fn(() => {
        const qb: any = { addSelect: () => qb, where: () => qb, getOne: async () => ({ id: USER, passwordHash }) };
        return qb;
      }),
    };
    service = new MfaService(
      mfaRepo as any, recoveryRepo as any, usersRepo as any, audit as any, {} as any, {} as any, {} as any,
    );
    disableSpy = jest.spyOn(service, 'disable');
    regenSpy = jest.spyOn(service, 'regenerateRecoveryCodes');
    controller = new MfaController(service);
  });

  const req = { user: { id: USER } };

  describe('DELETE /auth/mfa', () => {
    it('refuses with no proof at all, and removes nothing', async () => {
      await expect(controller.disable(req, {} as any)).rejects.toThrow(BadRequestException);
      await expect(controller.disable(req, undefined as any, 'TOTP')).rejects.toThrow(BadRequestException);
      expect(disableSpy).not.toHaveBeenCalled();
      expect(rows).toHaveLength(1);
    });

    it('refuses a wrong password, audits it, and removes nothing', async () => {
      await expect(controller.disable(req, { currentPassword: 'not it' } as any)).rejects.toThrow(ForbiddenException);
      expect(disableSpy).not.toHaveBeenCalled();
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MFA_STEP_UP_FAILED' }));
    });

    it('refuses a wrong authenticator code, and counts it toward the lockout', async () => {
      const wrong = totp(secret) === '000000' ? '111111' : '000000';
      await expect(controller.disable(req, { code: wrong } as any)).rejects.toThrow(ForbiddenException);
      expect(disableSpy).not.toHaveBeenCalled();
      expect(rows[0].failedAttempts).toBe(1);
    });

    it('refuses a recovery code — those are for a lost device, not for switching MFA off', async () => {
      await expect(controller.disable(req, { code: 'ABCD-EFGH' } as any)).rejects.toThrow(ForbiddenException);
      expect(disableSpy).not.toHaveBeenCalled();
    });

    it('accepts the current password', async () => {
      await expect(controller.disable(req, { currentPassword: PASSWORD } as any, 'TOTP')).resolves.toEqual({ message: 'TOTP factor removed.' });
      expect(disableSpy).toHaveBeenCalledWith(USER, USER, 'TOTP');
    });

    it('accepts a fresh authenticator code', async () => {
      await expect(controller.disable(req, { code: totp(secret) } as any)).resolves.toEqual({ message: 'MFA disabled.' });
      expect(disableSpy).toHaveBeenCalledWith(USER, USER, undefined);
    });
  });

  describe('POST /auth/mfa/recovery/regenerate', () => {
    it('refuses with no proof, and mints nothing', async () => {
      await expect(controller.regenerate(req, {} as any)).rejects.toThrow(BadRequestException);
      expect(regenSpy).not.toHaveBeenCalled();
    });

    it('refuses a wrong password', async () => {
      await expect(controller.regenerate(req, { currentPassword: 'guess' } as any)).rejects.toThrow(ForbiddenException);
      expect(regenSpy).not.toHaveBeenCalled();
    });

    it('accepts the current password or a fresh code', async () => {
      const a = await controller.regenerate(req, { currentPassword: PASSWORD } as any);
      expect(a.recoveryCodes).toHaveLength(10);
      const b = await controller.regenerate(req, { code: totp(secret) } as any);
      expect(b.recoveryCodes).toHaveLength(10);
      expect(regenSpy).toHaveBeenCalledTimes(2);
    });
  });

  /** The global pipe runs whitelist + forbidNonWhitelisted; the body has to survive it. */
  describe('the request body, through the global validation pipe', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const bodyType = (method: 'disable' | 'regenerate') =>
      (Reflect.getMetadata('design:paramtypes', MfaController.prototype, method) as any[])[1];

    it.each(['disable', 'regenerate'] as const)('%s accepts a password or a code, and refuses junk', async (method) => {
      const metatype = bodyType(method);
      const meta = { type: 'body' as const, metatype, data: '' };
      await expect(pipe.transform({ currentPassword: 'x' }, meta)).resolves.toMatchObject({ currentPassword: 'x' });
      await expect(pipe.transform({ code: '123456' }, meta)).resolves.toMatchObject({ code: '123456' });
      await expect(pipe.transform({ password: 'x' }, meta)).rejects.toThrow(BadRequestException);
      await expect(pipe.transform({ code: 123456 }, meta)).rejects.toThrow(BadRequestException);
    });
  });
});
