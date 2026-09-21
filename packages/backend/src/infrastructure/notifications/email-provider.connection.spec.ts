/**
 * THE MAIL CONNECTION IS REUSED, AND IT CANNOT HANG.
 *
 * Measured on the live stack before this: scheduling an interview (one invite email) took 4.95 s
 * and sending a colleague a setup link 2.82 s, against well under 0.1 s for ordinary requests —
 * because every message opened, authenticated and closed its own SMTP session, and nodemailer's
 * default idle-socket wait is ten minutes.
 */
const createTransport = jest.fn();
jest.mock('nodemailer', () => ({ createTransport }), { virtual: false });

import { EmailProvider, MAIL_CONNECTION_OPTIONS } from './email-provider';

describe('EmailProvider connection handling', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    createTransport.mockReset();
    createTransport.mockImplementation(() => ({ sendMail: jest.fn(), close: jest.fn() }));
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
    delete process.env.SMTP_HOST;
  });

  afterAll(() => {
    process.env = saved;
  });

  it('keeps a pool of connections rather than opening one per message', async () => {
    process.env.GMAIL_USER = 'desk@example.com';
    process.env.GMAIL_APP_PASSWORD = 'app-password';

    await new EmailProvider().reconfigure();

    const options = createTransport.mock.calls[0][0];
    expect(options.pool).toBe(true);
    expect(options.maxConnections).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['Gmail', { GMAIL_USER: 'desk@example.com', GMAIL_APP_PASSWORD: 'app-password' }],
    ['SMTP', { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }],
  ])('bounds every wait on the %s transport to seconds, not nodemailer\'s minutes', async (_name, env) => {
    Object.assign(process.env, env);

    await new EmailProvider().reconfigure();

    const options = createTransport.mock.calls[0][0];
    expect(options.pool).toBe(true);
    expect(options.connectionTimeout).toBeLessThanOrEqual(15_000);
    expect(options.greetingTimeout).toBeLessThanOrEqual(15_000);
    expect(options.socketTimeout).toBeLessThanOrEqual(60_000);
    expect(options).toMatchObject(MAIL_CONNECTION_OPTIONS);
  });

  it('closes the old pool when the mailbox is reconfigured, so its sessions do not linger', async () => {
    process.env.GMAIL_USER = 'desk@example.com';
    process.env.GMAIL_APP_PASSWORD = 'app-password';
    const provider = new EmailProvider();

    await provider.reconfigure();
    const first = createTransport.mock.results[0].value;
    await provider.reconfigure();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(provider.isEnabled()).toBe(true);
  });

  it('closes the pool on shutdown', async () => {
    process.env.GMAIL_USER = 'desk@example.com';
    process.env.GMAIL_APP_PASSWORD = 'app-password';
    const provider = new EmailProvider();
    await provider.reconfigure();
    const transport = createTransport.mock.results[0].value;

    provider.onModuleDestroy();

    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(provider.isEnabled()).toBe(false);
  });
});
