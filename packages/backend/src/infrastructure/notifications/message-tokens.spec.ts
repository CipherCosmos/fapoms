import { COMMON_MESSAGE_TOKENS, smsWordingProblems } from '@fapoms/shared';
import { DEFAULT_COMPANY_NAME, MessageTokensService, formatBusinessDate, formatBusinessTime } from './message-tokens';
import { EmailTemplateRenderer } from './email-template-renderer';
import { validateTemplateContract } from './email-template-validator';
import { EMAIL_TEMPLATE_REGISTRY } from './email-template-registry';

/**
 * ONE SET OF PLACEHOLDERS, THE SAME IN EVERY EMAIL AND EVERY TEXT.
 *
 * An administrator writing wording should not have to learn which message calls the person `name`
 * and which calls them `displayName`, nor find out that a text cannot name the number it is going
 * to. {{name}}, {{phone}}, {{email}}, {{companyName}}, {{portalUrl}}, {{time}} and {{date}} are
 * filled for every message on both channels, and the send may still say something else under the
 * same name — a candidate's name on a message going to their manager, say — by passing it itself.
 *
 * What must not drift: the list is one list (so an email screen and an SMS screen cannot diverge),
 * the values are filled rather than left as visible {{braces}}, and a value the sender passes wins.
 */
describe('The values every message carries', () => {
  const tokens = (companyName?: string) => new MessageTokensService(
    companyName === undefined ? undefined : ({ get: async () => companyName } as any),
  );

  it('fills every placeholder on the shared list, so no wording can arrive with empty braces', async () => {
    const common = await tokens('Sumeru Global Support Solutions').common(
      { name: 'Ramesh Kumar', phone: '+919876543210', email: 'ramesh@example.com' },
      new Date('2026-09-19T13:12:00Z'),
    );

    expect(Object.keys(common).sort()).toEqual([...COMMON_MESSAGE_TOKENS].sort());
    expect(common).toMatchObject({
      name: 'Ramesh Kumar',
      phone: '+919876543210',
      email: 'ramesh@example.com',
      companyName: 'Sumeru Global Support Solutions',
    });
    expect(common.portalUrl).toMatch(/^https?:\/\//);
    // Asia/Kolkata, the clock people in the office read — 13:12 UTC is 6:42 pm there.
    expect(common.time).toBe('6:42 pm');
    // Spelled the way this locale abbreviates it ("Sept"), not the way a developer assumes.
    expect(common.date).toBe('19 Sept 2026');
  });

  /**
   * A sender that knows nothing about the recipient still produces a sendable message: the personal
   * values go out empty rather than as the literal word "undefined" or an unfilled placeholder.
   */
  it('leaves the values it was not told blank rather than printing undefined', async () => {
    const common = await tokens('Sumeru Global').common();

    expect(common.name).toBe('');
    expect(common.phone).toBe('');
    expect(common.email).toBe('');
    expect(common.companyName).toBe('Sumeru Global');
  });

  it('falls back to the firm\'s name when Platform Settings has none saved', async () => {
    await expect(tokens('   ').common()).resolves.toMatchObject({ companyName: DEFAULT_COMPANY_NAME });
    await expect(tokens().common()).resolves.toMatchObject({ companyName: DEFAULT_COMPANY_NAME });
  });

  /** A settings store that is down must not stop a one-time code going out. */
  it('still fills everything when the settings store throws', async () => {
    const service = new MessageTokensService({ get: async () => { throw new Error('settings down'); } } as any);

    await expect(service.common({ name: 'Asha' })).resolves.toMatchObject({
      name: 'Asha', companyName: DEFAULT_COMPANY_NAME,
    });
  });

  it('reads the time and date in the business time zone, not the server\'s', () => {
    const midnightIst = new Date('2026-01-31T18:31:00Z');

    expect(formatBusinessTime(midnightIst)).toBe('12:01 am');
    // The same instant is still 31 January in UTC and already 1 February in the office.
    expect(formatBusinessDate(midnightIst)).toBe('1 Feb 2026');
  });
});

describe('The same placeholders in an email', () => {
  const definition = EMAIL_TEMPLATE_REGISTRY['app-credentials'];

  /** The renderer is given a loader that hands back wording using only common placeholders. */
  const rendererFor = (html: string, tokensService?: MessageTokensService) => new EmailTemplateRenderer(
    {
      loadActiveTemplate: async () => ({
        html, subjectTemplate: 'A message for {{name}}', source: 'override', version: 3,
        checksum: 'abc', isFallback: false,
      }),
    } as any,
    tokensService,
  );

  it('fills the common values even though the sender passed none of them', async () => {
    const service = new MessageTokensService({ get: async () => 'Sumeru Global' } as any);
    const rendered = await rendererFor('<p>Hello {{name}}, from {{companyName}} at {{time}}.</p>', service)
      .render(definition.key, { ...definition.sampleData }, { name: 'Ramesh Kumar' });

    expect(rendered.html).toContain('Hello Ramesh Kumar');
    expect(rendered.html).toContain('from Sumeru Global');
    expect(rendered.html).not.toContain('{{');
    expect(rendered.subject).toBe('A message for Ramesh Kumar');
  });

  /**
   * The recipient of an email is the address it is going to; `EmailService` passes it so wording can
   * say "sent to {{email}}" without every caller remembering to include it in its own data.
   */
  it('names the address it is going to', async () => {
    const service = new MessageTokensService({ get: async () => 'Sumeru Global' } as any);
    const rendered = await rendererFor('<p>{{email}}</p>', service)
      .render(definition.key, { ...definition.sampleData }, { email: 'ramesh@example.com' });

    expect(rendered.html).toContain('ramesh@example.com');
  });

  /**
   * A template whose own `name` means somebody other than the recipient — the candidate on a message
   * to their manager — must keep it. The sender's data is the last word.
   */
  it('lets what the sender passed win over the common value', async () => {
    const service = new MessageTokensService({ get: async () => 'Sumeru Global' } as any);
    const rendered = await rendererFor('<p>{{name}}</p>', service)
      .render(definition.key, { ...definition.sampleData, name: 'Asha Patel' }, { name: 'Ramesh Kumar' });

    expect(rendered.html).toContain('Asha Patel');
    expect(rendered.html).not.toContain('Ramesh Kumar');
  });

  /** The dozen specs that build a renderer with a loader alone must keep working. */
  it('renders without the token service at all, as it did before these values existed', async () => {
    const rendered = await rendererFor('<p>Hello {{name}}.</p>')
      .render(definition.key, { ...definition.sampleData, name: 'Asha Patel' });

    expect(rendered.html).toContain('Hello Asha Patel');
  });
});

describe('The same placeholders in edited wording', () => {
  /**
   * Both editing screens refuse a placeholder nobody fills in — it would arrive as a blank the DLT
   * template never had, or an empty sentence in an email. The shared values must be on the allowed
   * side of that rule on both screens, or an administrator is told the wording is wrong when it is not.
   *
   * The rule itself is proved in the shared package's own spec; what this asserts is that the copy of
   * it the server actually loads (the built `@fapoms/shared`) carries it — a stale build of that
   * package is a trap this repository has been caught by before.
   */
  it('is accepted by the SMS wording check without the template declaring it', () => {
    const problems = smsWordingProblems(
      'Hi {{name}}, {{code}} is your code from {{companyName}}. Sent {{time}} on {{date}}.',
      ['code'],
    );

    expect(problems).toEqual([]);
  });

  it('still refuses a placeholder that is on neither list', () => {
    const problems = smsWordingProblems('Hi {{name}}, {{code}} expires {{whenever}}.', ['code']);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('{{whenever}}');
  });

  it('is accepted by the email template check the same way', () => {
    const definition = EMAIL_TEMPLATE_REGISTRY['app-credentials'];
    const html = `<p>Hi {{name}} ({{displayName}}) of {{companyName}}, this is your access at {{time}} on {{date}}. `
      + `Username {{username}}, temporary password {{temporaryPassword}}, valid {{validDays}} days. `
      + `Sign in at {{loginUrl}} — {{portalUrl}} — <img src="{{logoUrl}}" alt=""></p>`;

    const result = validateTemplateContract(definition, html, 'Your access, {{name}}');

    expect(result.errors).toEqual([]);
  });
});
