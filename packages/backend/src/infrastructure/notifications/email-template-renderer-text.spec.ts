import { EmailTemplateRenderer } from './email-template-renderer';
import { EMAIL_TEMPLATE_REGISTRY } from './email-template-registry';

/**
 * TWO EMAILS UNDER ONE SUBJECT LINE.
 *
 * Every message carries an HTML body and a plain-text one, and the text half was regenerated from
 * the built-in design no matter what had been published. So an administrator could rewrite the
 * invitation email, preview it, test it, publish it — and everyone reading in plain text still
 * received the old wording. Nothing in the product ever showed that second body, which is why it
 * went unnoticed: the only place it appears is a recipient's screen.
 *
 * This pins the send path, not the conversion (that is `html-to-text.spec.ts`): what `render()`
 * actually puts in the text field of a real email.
 */
describe('the text half of a sent email', () => {
  const KEY = 'registration-invite';
  const payload = { ...EMAIL_TEMPLATE_REGISTRY[KEY].sampleData };

  const rendererServing = (html: string | null) => new EmailTemplateRenderer({
    loadActiveTemplate: async () => ({
      key: KEY,
      definition: EMAIL_TEMPLATE_REGISTRY[KEY],
      source: html ? 'platform' : 'fallback',
      version: html ? 4 : 0,
      subjectTemplate: EMAIL_TEMPLATE_REGISTRY[KEY].defaultSubjectTemplate,
      html,
      checksum: 'abc',
      isFallback: !html,
    }),
  } as never);

  it('says what the published email says, not what the built-in one said', async () => {
    const published = '<html><body>'
      + '<h1>Welcome to the Sumeru appraiser panel</h1>'
      + '<p>Hello {{fullName}}, your registration link is ready and waiting for you.</p>'
      + '<a href="{{inviteUrl}}">Open my registration form</a>'
      + '<p>Questions? Write to {{supportEmail}} at any time.</p>'
      + '</body></html>';

    const rendered = await rendererServing(published).render(KEY, payload);

    expect(rendered.text).toContain('Welcome to the Sumeru appraiser panel');
    // The link survives with its address, or a plain-text reader has no way to act on the email.
    expect(rendered.text).toContain(payload.inviteUrl);
    expect(rendered.text).not.toMatch(/<[a-z]/i);
  });

  it('keeps the hand-written wording when nothing has been published over it', async () => {
    const rendered = await rendererServing(null).render(KEY, payload);
    const builtIn = EMAIL_TEMPLATE_REGISTRY[KEY].fallbackRenderer(payload);

    expect(rendered.text).toBe(builtIn.text);
  });

  it('never sends an empty text body, whatever the html turns out to be', async () => {
    const rendered = await rendererServing('<html><body><img src="{{logoUrl}}"></body></html>')
      .render(KEY, payload);

    expect(rendered.text.trim().length).toBeGreaterThan(20);
  });
});
