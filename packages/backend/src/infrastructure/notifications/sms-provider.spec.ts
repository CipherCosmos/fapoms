import { Logger } from '@nestjs/common';
import { SmsProvider } from './sms-provider';

/**
 * `SmsProvider` degrading exactly like `EmailProvider` when unconfigured, and never throwing
 * out of `send` regardless of what MSG91 (or the network) does to it — the same "delivery is
 * best-effort" discipline the email provider already follows for a bounced SMTP call.
 */
describe('SmsProvider', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let warnSpy: jest.SpyInstance;

  const withEnv = (vars: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    withEnv({ SMS_PROVIDER_API_KEY: undefined, SMS_SENDER_ID: undefined, SMS_ROUTE: undefined });
  });

  afterEach(() => {
    (global as any).fetch = realFetch;
    warnSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('warns once at boot and never calls fetch when unconfigured', async () => {
    const provider = new SmsProvider();
    provider.onModuleInit();

    const ok = await provider.send('9876543210', 'temp password is tiger-mango-9');

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not repeat the warning on every send — only once, at boot', async () => {
    const provider = new SmsProvider();
    provider.onModuleInit();

    await provider.send('9876543210', 'one');
    await provider.send('9876543211', 'two');
    await provider.send('9876543212', 'three');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports disabled when only the sender id is missing, without calling fetch', async () => {
    withEnv({ SMS_PROVIDER_API_KEY: 'a-real-key' });
    const provider = new SmsProvider();
    provider.onModuleInit();

    expect(provider.isEnabled()).toBe(false);
    const ok = await provider.send('9876543210', 'message');
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends when configured, and reports enabled', async () => {
    withEnv({ SMS_PROVIDER_API_KEY: 'a-real-key', SMS_SENDER_ID: 'FAPOMS' });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const provider = new SmsProvider();
    provider.onModuleInit();

    expect(provider.isEnabled()).toBe(true);
    const ok = await provider.send('9876543210', 'your temp password is x');

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('msg91.com');
    expect(init.headers.authkey).toBe('a-real-key');
    const body = JSON.parse(init.body);
    expect(body.sender).toBe('FAPOMS');
    expect(body.sms[0].to).toEqual(['919876543210']);
  });

  it('does not throw and returns false on a non-2xx response', async () => {
    withEnv({ SMS_PROVIDER_API_KEY: 'a-real-key', SMS_SENDER_ID: 'FAPOMS' });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    const provider = new SmsProvider();
    provider.onModuleInit();

    await expect(provider.send('9876543210', 'message')).resolves.toBe(false);
  });

  it('does not throw and returns false when the network call itself rejects', async () => {
    withEnv({ SMS_PROVIDER_API_KEY: 'a-real-key', SMS_SENDER_ID: 'FAPOMS' });
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const provider = new SmsProvider();
    provider.onModuleInit();

    await expect(provider.send('9876543210', 'message')).resolves.toBe(false);
  });

  it('never leaks the message text (which carries the temp password) into a logger call', async () => {
    withEnv({ SMS_PROVIDER_API_KEY: 'a-real-key', SMS_SENDER_ID: 'FAPOMS' });
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const provider = new SmsProvider();
    provider.onModuleInit();

    const secretMessage = 'your temporary password is tiger-mango-river-stone4';
    await provider.send('9876543210', secretMessage);

    for (const spy of [warnSpy, logSpy, errorSpy, debugSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain('tiger-mango-river-stone4');
        }
      }
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });
});
