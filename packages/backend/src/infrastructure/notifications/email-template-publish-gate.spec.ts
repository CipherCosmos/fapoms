import { EmailTemplateLoader } from './email-template-loader';

/**
 * PUBLISHING AN EMAIL NOBODY HAS EVER RECEIVED.
 *
 * The gate on publishing used to be a checkbox the administrator ticked to say they had checked the
 * preview. A browser preview is not a test: a real inbox is a different rendering engine, on a
 * different screen, usually with images switched off — and the people on the other end of these
 * seven templates are candidates being asked for their Aadhaar and their bank details, who will not
 * write in to say the email looked broken.
 *
 * So "I have seen this arrive" became a fact the system checks: the checksum of the HTML that was
 * delivered, against the checksum of the draft about to go live.
 */
describe('remembering which version was actually sent', () => {
  const KEY = 'otp-verification' as const;

  /** The settings store, stubbed down to what the loader actually uses. */
  const loaderWithStore = () => {
    const store: Record<string, unknown> = {};
    const loader = new EmailTemplateLoader({
      get: async (name: string) => store[name] ?? null,
      set: async (name: string, value: unknown) => { store[name] = value; },
    } as never);
    return { loader, store };
  };

  const DRAFT = '<html><body><p>Your code is {{otpCode}} and it lasts {{validMinutes}} minutes.</p></body></html>';
  const EDITED = '<html><body><p>Your code is {{otpCode}}. It lasts {{validMinutes}} minutes.</p></body></html>';

  it('has nothing to say before any test has been sent', async () => {
    const { loader } = loaderWithStore();
    await expect(loader.hasTestedDraft(KEY, DRAFT)).resolves.toBe(false);
  });

  it('recognises the exact version that was delivered', async () => {
    const { loader } = loaderWithStore();
    await loader.recordTestSend(KEY, DRAFT, 'admin@example.com', 'Priya');

    await expect(loader.hasTestedDraft(KEY, DRAFT)).resolves.toBe(true);
  });

  /** The whole point: one more edit after the test, and the test no longer covers what goes live. */
  it('stops recognising it the moment the draft changes again', async () => {
    const { loader } = loaderWithStore();
    await loader.recordTestSend(KEY, DRAFT, 'admin@example.com', 'Priya');

    await expect(loader.hasTestedDraft(KEY, EDITED)).resolves.toBe(false);
  });

  it('keeps who sent it, where, and when — so the record can be shown back', async () => {
    const { loader } = loaderWithStore();
    await loader.recordTestSend(KEY, DRAFT, 'priya@example.com', 'Priya');

    const settings = await loader.getStoredSettings(KEY);
    expect(settings?.lastTestSend).toMatchObject({ to: 'priya@example.com', by: 'Priya' });
    expect(Date.parse(settings?.lastTestSend?.at as string)).not.toBeNaN();
  });

  it('does not lose the versions or the draft it was recorded beside', async () => {
    const { loader } = loaderWithStore();
    await loader.saveDraft(KEY, { html: DRAFT, subjectTemplate: 'Your code' }, 'Priya');
    await loader.recordTestSend(KEY, DRAFT, 'priya@example.com', 'Priya');

    const settings = await loader.getStoredSettings(KEY);
    expect(settings?.draft?.html).toBe(DRAFT);
    expect(settings?.lastTestSend?.checksum).toBeTruthy();
  });
});
