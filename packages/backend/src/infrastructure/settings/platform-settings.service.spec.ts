import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PlatformSettingsService, SECRET_MASK } from './platform-settings.service';
import { PlatformSettingEntity } from './platform-setting.entity';
import { CacheService } from '../cache/cache.service';
import { SETTING_BY_KEY } from './settings.registry';

/**
 * The contract that makes this safe to add to a running system: nothing changes until somebody
 * saves something, a saved value wins over the environment, and a credential typed here never
 * comes back out.
 */
describe('PlatformSettingsService', () => {
  let service: PlatformSettingsService;
  let repo: any;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: any) => ({ ...v })),
      save: jest.fn(async (v: any) => v),
      delete: jest.fn(async () => ({ affected: 1 })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformSettingsService,
        { provide: getRepositoryToken(PlatformSettingEntity), useValue: repo },
        {
          provide: CacheService,
          useValue: {
            wrap: jest.fn((_k: string, _t: number, load: () => any) => load()),
            del: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(PlatformSettingsService);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('resolution order', () => {
    it('uses the shipped default when nothing is saved and no environment variable is set', async () => {
      delete process.env.EMAIL_DIGEST_CRON;
      expect(await service.get('digest.cron')).toBe(SETTING_BY_KEY['digest.cron'].default);
    });

    it('prefers an environment variable over the shipped default', async () => {
      process.env.EMAIL_DIGEST_CRON = '0 7 * * *';
      expect(await service.get('digest.cron')).toBe('0 7 * * *');
    });

    it('prefers a saved value over the environment — taking over a deployment-configured key', async () => {
      process.env.EMAIL_DIGEST_CRON = '0 7 * * *';
      repo.find.mockResolvedValue([{ key: 'digest.cron', value: '45 9 * * 1-5', isSecret: false }]);
      expect(await service.get('digest.cron')).toBe('45 9 * * 1-5');
    });

    it('reports where the value in force came from', async () => {
      process.env.EMAIL_DIGEST_CRON = '0 7 * * *';
      const all = await service.describeAll();
      expect(all.find((s) => s.key === 'digest.cron')?.source).toBe('environment');
      expect(all.find((s) => s.key === 'fees.platformBaseFee')?.source).toBe('default');
    });

    it('falls back to environment and defaults when the settings table cannot be read', async () => {
      // A configuration lookup that cannot answer must never stop the platform pricing work.
      repo.find.mockRejectedValue(new Error('db down'));
      expect(await service.getNumber('fees.platformBaseFee')).toBe(1200);
    });
  });

  describe('secrets', () => {
    beforeEach(() => { process.env.PII_ENCRYPTION_KEY = 'a'.repeat(64); });

    it('never returns a stored credential, only whether one exists', async () => {
      repo.find.mockResolvedValue([
        { key: 'email.gmailAppPassword', value: 'enc:whatever', isSecret: true },
      ]);
      const row = (await service.describeAll()).find((s) => s.key === 'email.gmailAppPassword')!;
      expect(row.value).toBe(SECRET_MASK);
      expect(row.isSet).toBe(true);
      expect(JSON.stringify(row)).not.toContain('whatever');
    });

    it('treats the mask coming back as "leave it alone", not as a new value', async () => {
      // What a form submits when the user edited other fields and did not retype the password.
      await service.set('email.gmailAppPassword', SECRET_MASK);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('refuses to store a credential when there is no encryption key', async () => {
      delete process.env.PII_ENCRYPTION_KEY;
      await expect(service.set('email.gmailAppPassword', 'hunter2')).rejects.toThrow(/PII_ENCRYPTION_KEY/);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('stores a credential as ciphertext, not as typed', async () => {
      await service.set('email.gmailAppPassword', 'hunter2');
      const saved = repo.save.mock.calls[0][0];
      expect(saved.value).not.toBe('hunter2');
      expect(saved.isSecret).toBe(true);
    });
  });

  describe('validation', () => {
    it('rejects a number below its floor with the operator’s units', async () => {
      await expect(service.set('fees.platformBaseFee', -5)).rejects.toThrow(/cannot be below/);
    });

    it('rejects a value outside a select’s options', async () => {
      await expect(service.set('email.transport', 'CARRIER_PIGEON')).rejects.toThrow(/must be one of/);
    });

    it('rejects a cron that is not five fields, and says what the fields are', async () => {
      await expect(service.set('digest.cron', '8am daily')).rejects.toThrow(/five cron fields/);
    });

    it('refuses an unknown key rather than storing something nothing reads', async () => {
      await expect(service.set('not.a.real.setting', 1)).rejects.toThrow(/Unknown setting/);
    });

    it('coerces a form’s string into the declared type', async () => {
      await service.set('fees.platformBaseFee', '1500');
      expect(repo.save.mock.calls[0][0].value).toBe(1500);
    });
  });

  describe('change listeners', () => {
    it('tells a registered listener when its group changes, so it can rebuild', async () => {
      const seen: string[] = [];
      service.onChange('email.', (key) => { seen.push(key); });
      await service.set('email.from', 'FAPOMS <x@y.in>');
      expect(seen).toEqual(['email.from']);
    });

    it('does not wake listeners watching a different group', async () => {
      const seen: string[] = [];
      service.onChange('email.', (key) => { seen.push(key); });
      await service.set('fees.platformBaseFee', 1300);
      expect(seen).toEqual([]);
    });

    it('a listener that throws does not fail the save it describes', async () => {
      service.onChange('email.', () => { throw new Error('transport rebuild failed'); });
      await expect(service.set('email.from', 'x@y.in')).resolves.toBeUndefined();
      expect(repo.save).toHaveBeenCalled();
    });
  });

  it('reset removes the saved row so the key follows the environment again', async () => {
    await service.reset('digest.cron');
    expect(repo.delete).toHaveBeenCalledWith({ key: 'digest.cron' });
  });
});
