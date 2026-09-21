import { Logger } from '@nestjs/common';
import {
  PINNACLE_SEND_URL, PINNACLE_UNICODE_CONFIRMED, PinnacleTransport,
} from './pinnacle.transport';

/**
 * PINNACLE, AGAINST THE REQUEST THE OPERATIONS TEAM SUPPLIED.
 *
 *   POST https://api.pinnacle.in/index.php/sms/json, `apikey` header,
 *   { sender, message: [{ number, text }], messagetype: 'TXT', dlttempid }
 *
 * The parts that must not drift: the key travels in a header and never in a log, the number goes as
 * country-code digits with no plus, the DLT template id rides on every message that has one, and a
 * reply that does not positively confirm acceptance is a failure — a gateway in this family answers
 * 200 with an error for an unregistered template, and a "sent" we invented would strand somebody
 * waiting for a one-time code.
 */
describe('PinnacleTransport', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let warnSpy: jest.SpyInstance;
  const settings = { senderId: 'SUMGLB', dltEntityId: '1701158920000000000' };
  const transport = () => new PinnacleTransport({ apiKey: 'pinnacle-key-abc' });
  const message = { to: '+919113066745', text: 'Use 482910 to verify your profile.', dltTemplateId: '1777178971152755392' };
  const reply = (body: unknown, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(body) });

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    (global as any).fetch = realFetch;
    warnSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('posts the supplied shape: sender, one message with country-code digits, the type and the DLT template id', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 'success', msgid: '9f2c' }));

    const result = await transport().send(message, settings);

    expect(result).toEqual({ success: true, providerMessageId: '9f2c' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PINNACLE_SEND_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      sender: 'SUMGLB',
      message: [{ number: '919113066745', text: 'Use 482910 to verify your profile.' }],
      messagetype: 'TXT',
      dlttempid: '1777178971152755392',
    });
  });

  it('carries the key in the header, never in the URL or the body', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 'success' }));

    await transport().send(message, settings);

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.headers.apikey).toBe('pinnacle-key-abc');
    expect(url).not.toContain('pinnacle-key-abc');
    expect(init.body).not.toContain('pinnacle-key-abc');
  });

  it('leaves the DLT template id out when a message has none, rather than sending an empty one', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 'success' }));

    await transport().send({ to: '+919113066745', text: 'plain' }, settings);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('dlttempid');
  });

  /**
   * Refusing beats delivering question marks: the unicode message type is not confirmed for this
   * account, and a code nobody can read is worse than a clear refusal the desk can act on.
   */
  it('refuses a text needing characters GSM-7 has no room for, while the unicode type is unconfirmed', async () => {
    expect(PINNACLE_UNICODE_CONFIRMED).toBe(false);

    const result = await transport().send({ ...message, text: 'आपका कोड 482910' }, settings);

    expect(result).toMatchObject({ success: false, permanent: true });
    expect(result.error).toMatch(/unicode/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a 200 that does not confirm acceptance as a refusal, not a send', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 'error', message: 'Invalid DLT template id' }));

    const result = await transport().send(message, settings);

    expect(result).toMatchObject({ success: false, permanent: true });
    expect(result.error).toContain('Invalid DLT template id');
  });

  it('treats an empty 200 body as unconfirmed rather than sent', async () => {
    fetchMock.mockResolvedValueOnce(reply({}));

    await expect(transport().send(message, settings)).resolves.toMatchObject({ success: false, permanent: true });
  });

  it('accepts a reply that only carries a message id', async () => {
    fetchMock.mockResolvedValueOnce(reply([{ messageid: 'abc123' }]));

    await expect(transport().send(message, settings)).resolves.toEqual({ success: true, providerMessageId: 'abc123' });
  });

  it('reports a refused request as permanent and a gateway fault as retryable', async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 'Header not approved' }, false, 400));
    await expect(transport().send(message, settings)).resolves.toMatchObject({ success: false, permanent: true });

    fetchMock.mockResolvedValueOnce(reply({}, false, 503));
    await expect(transport().send(message, settings)).resolves.toMatchObject({ success: false, permanent: false });
  });

  it('gives up on a gateway that never answers instead of holding the caller open', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }));

    const result = await transport().send(message, settings);

    expect(result).toMatchObject({ success: false });
    expect(result.permanent).toBeFalsy();
    expect(result.error).toMatch(/did not answer in time/);
  });

  it('never puts the message text or the key into a log line, whatever happens', async () => {
    const secret = 'temporary password is tiger-mango-9';
    fetchMock.mockResolvedValueOnce(reply({ status: 'error', message: 'refused' }));
    await transport().send({ ...message, text: secret }, settings);
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await transport().send({ ...message, text: secret }, settings);

    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain('tiger-mango-9');
        expect(String(arg)).not.toContain('pinnacle-key-abc');
      }
    }
  });
});
