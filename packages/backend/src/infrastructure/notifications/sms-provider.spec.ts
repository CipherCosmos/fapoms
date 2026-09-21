import { Logger } from '@nestjs/common';
import { SmsProvider } from './sms-provider';
import { PlatformSettingsService } from '../settings/platform-settings.service';

/**
 * `SmsProvider` — the configured holder in front of whichever SMS adapter is chosen.
 *
 * Pinned against the REAL `PlatformSettingsService` over an in-memory table, so "saved first,
 * environment second" is the registry's own resolution and not a re-derived mock of it. What these
 * guard, in the owner's terms: the settings screen is the primary place and takes effect without a
 * restart; an administrator's "Off" is never overruled by a key left in the environment; and under
 * DLT a text with no template id is refused here rather than billed and blocked by the operators.
 */
describe('SmsProvider', () => {
  const realFetch = global.fetch;
  const ENV_KEYS = ['SMS_PROVIDER', 'SMS_PINNACLE_API_KEY', 'SMS_SENDER_ID', 'SMS_DLT_ENTITY_ID'];
  const savedEnv: Record<string, string | undefined> = {};
  let fetchMock: jest.Mock;
  let logSpies: jest.SpyInstance[];

  /** The real settings service over a table held in a Map. Secrets are stored plaintext, which `decryptField` passes through. */
  const settingsWith = (rows: Record<string, unknown> = {}) => {
    const table = new Map<string, any>(
      Object.entries(rows).map(([key, value]) => [key, { key, value, isSecret: key === 'sms.pinnacle.apiKey' }]),
    );
    const repository = {
      find: async () => [...table.values()],
      findOne: async ({ where: { key } }: any) => table.get(key) ?? null,
      save: async (row: any) => { table.set(row.key, row); return row; },
      create: (row: any) => row,
      delete: async ({ key }: any) => { table.delete(key); },
    };
    const cache = { wrap: (_k: string, _t: number, load: () => Promise<unknown>) => load(), del: async () => undefined };
    return new PlatformSettingsService(repository as never, cache as never);
  };

  const ready = async (settings?: PlatformSettingsService) => {
    const provider = new SmsProvider(settings);
    await provider.onModuleInit();
    return provider;
  };

  const sentBody = (call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body);
  const sentKey = (call = 0) => fetchMock.mock.calls[call][1].headers.apikey;

  beforeEach(() => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"status":"success","msgid":"req-1"}' });
    (global as any).fetch = fetchMock;
    logSpies = (['log', 'warn', 'error', 'debug'] as const)
      .map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    (global as any).fetch = realFetch;
    logSpies.forEach((s) => s.mockRestore());
  });

  describe('where the configuration comes from', () => {
    it('uses the values saved on the settings screen over the environment', async () => {
      process.env.SMS_PINNACLE_API_KEY = 'env-key';
      process.env.SMS_SENDER_ID = 'ENVHDR';
      const provider = await ready(settingsWith({
        'sms.provider': 'PINNACLE', 'sms.pinnacle.apiKey': 'saved-key', 'sms.senderId': 'sumeru',
      }));

      await provider.send({ to: '9876543210', text: 'hello' });

      expect(sentKey()).toBe('saved-key');
      expect(sentBody().sender).toBe('SUMERU');
    });

    it('falls back to the environment variables when nothing is saved', async () => {
      process.env.SMS_PINNACLE_API_KEY = 'env-key';
      process.env.SMS_SENDER_ID = 'ENVHDR';
      const provider = await ready(settingsWith());

      // Nothing saved, a key in the environment: the deployment configured before the screen keeps sending.
      expect(provider.isEnabled()).toBe(true);
      await provider.send({ to: '9876543210', text: 'hello' });
      expect(sentKey()).toBe('env-key');
      expect(sentBody()).toMatchObject({ sender: 'ENVHDR' });
    });

    it('reads the environment alone when there is no settings module', async () => {
      process.env.SMS_PINNACLE_API_KEY = 'env-key';
      process.env.SMS_SENDER_ID = 'ENVHDR';
      const provider = await ready();

      expect(provider.describe()).toMatchObject({ enabled: true, provider: 'PINNACLE', senderId: 'ENVHDR' });
    });

    /** The email provider's provenance bug, not repeated: a saved "Off" beside a live env key must mean off. */
    it('stays off when an administrator saved Off, even with a key still in the environment', async () => {
      process.env.SMS_PINNACLE_API_KEY = 'env-key';
      process.env.SMS_SENDER_ID = 'ENVHDR';
      const provider = await ready(settingsWith({ 'sms.provider': 'NONE' }));

      expect(provider.isEnabled()).toBe(false);
      expect(provider.describe().problem).toMatch(/switched off/);
      await expect(provider.send({ to: '9876543210', text: 'hello' })).resolves.toMatchObject({ success: false, permanent: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rebuilds on a save under sms., with no restart', async () => {
      const settings = settingsWith({ 'sms.provider': 'PINNACLE', 'sms.pinnacle.apiKey': 'saved-key', 'sms.senderId': 'SUMERU' });
      const provider = await ready(settings);
      expect(provider.isEnabled()).toBe(true);

      await settings.set('sms.provider', 'NONE', 'u-dev');

      expect(provider.isEnabled()).toBe(false);
      await settings.set('sms.provider', 'PINNACLE', 'u-dev');
      expect(provider.isEnabled()).toBe(true);
    });
  });

  describe('what it refuses to send with', () => {
    it('stays disabled without a key, and never calls the gateway', async () => {
      const provider = await ready(settingsWith({ 'sms.provider': 'PINNACLE', 'sms.senderId': 'SUMERU' }));

      expect(provider.describe()).toMatchObject({ enabled: false, provider: 'PINNACLE' });
      expect(provider.describe().problem).toMatch(/API key is missing/);
      await expect(provider.send({ to: '9876543210', text: 'x' })).resolves.toMatchObject({ success: false, permanent: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['', 'SUMER', 'SUMERU1', '123456', 'SU MER'])('refuses the sender header %p — DLT headers are six letters', async (header) => {
      const provider = await ready(settingsWith({ 'sms.provider': 'PINNACLE', 'sms.pinnacle.apiKey': 'k', 'sms.senderId': header }));

      expect(provider.isEnabled()).toBe(false);
      expect(provider.describe().problem).toMatch(/sender header/i);
    });

    it('says so once per configuration, not once per text', async () => {
      const provider = await ready(settingsWith());
      const warn = logSpies[1];
      const before = warn.mock.calls.length;

      for (let i = 0; i < 5; i++) await provider.send({ to: '9876543210', text: `t${i}` });

      expect(before).toBe(1);
      expect(warn.mock.calls.length).toBe(1);
    });
  });

  describe('each send', () => {
    const configured = (extra: Record<string, unknown> = {}) =>
      ready(settingsWith({ 'sms.provider': 'PINNACLE', 'sms.pinnacle.apiKey': 'k', 'sms.senderId': 'SUMERU', ...extra }));

    it('hands the gateway an E.164 Indian mobile, whatever shape it was typed in', async () => {
      const provider = await configured();

      await provider.send({ to: '+91 98765-43210', text: 'hello' });

      expect(sentBody().message).toEqual([{ number: '919876543210', text: 'hello' }]);
    });

    it('refuses what is not an Indian mobile, permanently, without calling the gateway', async () => {
      const provider = await configured();

      for (const to of ['0712345678', '9404410787 / 9850042526', '12345']) {
        await expect(provider.send({ to, text: 'hello' })).resolves.toMatchObject({ success: false, permanent: true });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('under DLT, refuses a text with no DLT template id and says where to add it', async () => {
      const provider = await configured({ 'sms.dltEntityId': '1201159178483176112' });

      const result = await provider.send({ to: '9876543210', text: 'Your code is 1', dltTemplateId: null });

      expect(result).toEqual({
        success: false,
        permanent: true,
        error: expect.stringMatching(/has no DLT template id; add it under SMS templates/),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('under DLT, sends a text that has one, with the entity id', async () => {
      const provider = await configured({ 'sms.dltEntityId': '1201159178483176112' });

      await expect(provider.send({ to: '9876543210', text: 'Your code is 1', dltTemplateId: '1107160000000012345' }))
        .resolves.toMatchObject({ success: true });
      // Pinnacle takes the content template id per message; the Principal Entity is mapped to the
      // header in its panel, so it is a platform-side rule rather than a field.
      expect(sentBody()).toMatchObject({ dlttempid: '1107160000000012345' });
    });

    it('without DLT configured, still sends a text that has no template id', async () => {
      const provider = await configured();

      await expect(provider.send({ to: '9876543210', text: 'hello' })).resolves.toMatchObject({ success: true });
    });

    it('never logs the key or the text, across configuring and sending', async () => {
      const provider = await configured({ 'sms.pinnacle.apiKey': 'msg91-secret-key' });
      fetchMock.mockRejectedValueOnce(new Error('network down'));

      await provider.send({ to: '9876543210', text: 'temporary password tiger-mango-river-stone4' });

      const logged = logSpies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
      expect(logged).not.toContain('tiger-mango-river-stone4');
      expect(logged).not.toContain('msg91-secret-key');
    });
  });
});

/**
 * A deployment names its SMS company beside the key in its environment file, and the screen still
 * wins once somebody chooses there. Without the fallback, `SMS_PROVIDER=PINNACLE` in the file was
 * read by nobody and the boot log said "not configured" instead of naming what was missing.
 */
describe('naming the SMS company in the environment', () => {
  it('reads SMS_PROVIDER as the fallback for the saved choice, beside each company\'s key', async () => {
    const { SETTING_BY_KEY } = await import('../settings/settings.registry');
    expect(SETTING_BY_KEY['sms.provider'].envVar).toBe('SMS_PROVIDER');
    expect(SETTING_BY_KEY['sms.pinnacle.apiKey'].envVar).toBe('SMS_PINNACLE_API_KEY');
    expect(SETTING_BY_KEY['sms.pinnacle.apiKey'].secret).toBe(true);
  });
});
