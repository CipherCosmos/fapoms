import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { promises as dns } from 'dns';

import { PlatformSettingsService } from './platform-settings.service';
import { PlatformSettingEntity } from './platform-setting.entity';
import { CacheService } from '../cache/cache.service';
import { isInternalHost, isPrivateAddress, validatePublicUrl, validateSmtpHost } from './setting-validators';

/**
 * The two address settings: where emailed links point, and which host the API opens an SMTP
 * connection to. In production a plain-http or internal public URL, and an SMTP host on a
 * private/loopback/link-local address, are refused at save time.
 */
describe('address settings are refused when they point inward', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.restoreAllMocks();
  });

  describe('isPrivateAddress / isInternalHost', () => {
    it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.101.1.1', '0.0.0.0', '::1', '::', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1'])(
      '%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));
    it.each(['8.8.8.8', '172.32.0.1', '142.250.1.1', '2607:f8b0::1'])('%s is public', (ip) => expect(isPrivateAddress(ip)).toBe(false));
    it.each(['localhost', 'api.localhost', 'redis', 'mail.internal', 'box.local', '[::1]', '127.0.0.1'])(
      '%s is internal', (h) => expect(isInternalHost(h)).toBe(true));
    it.each(['smtp.gmail.com', 'fapoms.example.in', '8.8.8.8'])('%s is not internal', (h) => expect(isInternalHost(h)).toBe(false));
  });

  describe('in production', () => {
    beforeEach(() => { process.env.NODE_ENV = 'production'; });

    it('app.publicUrl must be an https origin on a public host', () => {
      expect(validatePublicUrl('https://fapoms.example.in')).toBeNull();
      expect(validatePublicUrl('https://fapoms.example.in/')).toBeNull();
      expect(validatePublicUrl('http://fapoms.example.in')).toMatch(/https/);
      expect(validatePublicUrl('https://localhost:5173')).toMatch(/public address/);
      expect(validatePublicUrl('https://10.0.0.5')).toMatch(/public address/);
      expect(validatePublicUrl('https://fapoms.example.in/app?x=1')).toMatch(/no path/);
      expect(validatePublicUrl('https://user:pw@fapoms.example.in')).toMatch(/no path/);
      expect(validatePublicUrl('javascript:alert(1)')).toMatch(/https/);
      expect(validatePublicUrl('not a url')).toMatch(/full address/);
    });

    it('email.smtpHost refuses private, loopback and link-local hosts', async () => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '142.250.1.1', family: 4 }] as any);
      expect(await validateSmtpHost('smtp.gmail.com')).toBeNull();
      for (const h of ['127.0.0.1', '169.254.169.254', '10.0.0.2', 'localhost', 'redis', '::1', 'fe80::1']) {
        expect(await validateSmtpHost(h)).toMatch(/not a local or private|will not connect|server name/);
      }
    });

    it('email.smtpHost refuses a public-looking name that resolves inward', async () => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
      expect(await validateSmtpHost('smtp.evil.example')).toMatch(/resolves to a local or private/);
    });
  });

  describe('outside production', () => {
    beforeEach(() => { process.env.NODE_ENV = 'development'; });
    it('local development addresses are accepted', async () => {
      expect(validatePublicUrl('http://localhost:5173')).toBeNull();
      expect(await validateSmtpHost('localhost')).toBeNull();
      expect(validatePublicUrl('http://localhost:5173/some/path')).toMatch(/no path/);
    });
  });

  describe('the save path runs them', () => {
    let service: PlatformSettingsService;
    let repo: any;
    beforeEach(async () => {
      process.env.NODE_ENV = 'production';
      repo = {
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((v: any) => ({ ...v })),
        save: jest.fn(async (v: any) => v),
        delete: jest.fn(async () => ({ affected: 1 })),
      };
      const module = await Test.createTestingModule({
        providers: [
          PlatformSettingsService,
          { provide: getRepositoryToken(PlatformSettingEntity), useValue: repo },
          { provide: CacheService, useValue: { wrap: jest.fn((_k: string, _t: number, load: () => any) => load()), del: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();
      service = module.get(PlatformSettingsService);
    });

    it('refuses an http public URL and an internal SMTP host without storing them', async () => {
      await expect(service.set('app.publicUrl', 'http://fapoms.example.in')).rejects.toThrow(/https/);
      await expect(service.set('email.smtpHost', '169.254.169.254')).rejects.toThrow(/private/);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('stores a good public URL', async () => {
      await service.set('app.publicUrl', 'https://fapoms.example.in');
      expect(repo.save).toHaveBeenCalled();
    });
  });
});
