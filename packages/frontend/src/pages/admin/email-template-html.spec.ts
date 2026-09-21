import { EMAIL_LAYOUT_MARKER, renderEmailLayout } from '@fapoms/shared';

import { compileVisualToHtml, shadeColor, type VisualTemplateData } from './email-template-html';
import { readVisualStamp, stripStamp } from './email-template-authorship';

/**
 * The simple editor's email is drawn by the same layout as the server's built-in emails. What the
 * form adds is per template: which blocks, carrying which `{{tokens}}` — and those tokens must reach
 * the stored template literally, or the server has nothing to fill in at send time.
 */

const FIELDS: VisualTemplateData = {
  subject: 'Subject',
  headline: 'Welcome aboard',
  greeting: 'Dear {{fullName}},',
  leadMessage: 'Please complete your registration.',
  buttonLabel: 'Finish now',
  footerNotice: 'Questions? Write to {{supportEmail}}.',
  primaryColor: '#4F46E5',
  accentBg: '#EEF2FF',
  headerStyle: 'framed-card',
  companyName: 'Acme Assaying',
};

/** Every token each template's form must write, besides the header's {{logoUrl}} — trusted markup verbatim. */
const TOKENS: Record<string, string[]> = {
  'otp-verification': ['{{otpCode}}', '{{validMinutes}}'],
  'registration-invite': ['href="{{inviteUrl}}"', '&bull; PAN &amp; Aadhaar Cards<br/>'],
  'app-credentials': ['{{username}}', '{{temporaryPassword}}', '{{validDays}}', 'href="{{loginUrl}}"'],
  'application-approved': ['{{assayerCode}}', '{{effectiveDate}}', 'href="{{loginUrl}}"'],
  'application-rejected': ['{{reviewNotes}}'],
  'branch-audit-paperwork': ['{{bankName}}', '{{branchName}}', '{{documentType}}', '{{fileName}}', 'href="{{downloadUrl}}"'],
  'morning-digest': ['{{briefDate}}', '{{subjectCounts}}', '>{{{digestSectionsHtml}}}</div>', 'href="{{portalUrl}}"'],
};

describe('compileVisualToHtml', () => {
  it.each(Object.entries(TOKENS))('writes every token %s needs, literally', (key, tokens) => {
    const html = compileVisualToHtml(key, FIELDS);
    for (const token of ['src="{{logoUrl}}"', ...tokens]) {
      expect(html).toContain(token);
    }
  });

  it.each(Object.keys(TOKENS))('carries the form fields and the brand choices for %s', (key) => {
    const html = compileVisualToHtml(key, FIELDS);
    expect(html).toContain('Welcome aboard</h1>');
    expect(html).toContain('Dear {{fullName}},');
    expect(html).toContain('Please complete your registration.');
    expect(html).toContain('Questions? Write to {{supportEmail}}.');
    expect(html).toContain('Acme Assaying Official Notice');
    expect(html).toContain('background-color:#4F46E5');
    expect(html).toContain('background-color:#EEF2FF');
    expect(html).not.toContain('#ED6714');
  });

  it.each([
    ['registration-invite', 'Finish now →'],
    ['app-credentials', 'Finish now →'],
    ['application-approved', 'Finish now →'],
    ['branch-audit-paperwork', 'Finish now ↓'],
    ['morning-digest', 'Finish now →'],
  ])('labels the %s button with the form’s wording', (key, label) => {
    expect(compileVisualToHtml(key, FIELDS)).toContain(`${label}</a>`);
  });

  it('falls back to each template’s own button wording', () => {
    const html = compileVisualToHtml('registration-invite', { ...FIELDS, buttonLabel: undefined });
    expect(html).toContain('Complete Registration →</a>');
  });

  it.each([
    ['gradient-banner', `linear-gradient(135deg, #4F46E5 0%, ${shadeColor('#4F46E5', -18)} 100%)`],
    ['accent-line', 'height:5px;background-color:#4F46E5'],
    ['framed-card', 'Acme Assaying Official Notice'],
  ] as const)('draws the %s header when chosen', (headerStyle, fragment) => {
    expect(compileVisualToHtml('otp-verification', { ...FIELDS, headerStyle })).toContain(fragment);
  });

  it('draws the banner for a form saved before the header choice existed', () => {
    const html = compileVisualToHtml('otp-verification', { ...FIELDS, headerStyle: undefined });
    expect(html).toContain('linear-gradient(135deg, #4F46E5');
  });

  it('writes a real email for a template the form has no blocks for', () => {
    const html = compileVisualToHtml('account-setup-link', FIELDS);
    expect(html).toContain(EMAIL_LAYOUT_MARKER);
    expect(html).toContain('Welcome aboard</h1>');
    expect(html).toContain('Dear {{fullName}},');
    expect(html).toContain('Please complete your registration.');
    expect(html).toContain('Questions? Write to {{supportEmail}}.');
    expect(html).toContain('src="{{logoUrl}}"');
    // No template-specific block it cannot know the tokens for.
    expect(html).not.toContain('Direct link:');
  });

  it('treats what is typed into the form as text, not markup — the signature included', () => {
    const typed = {
      ...FIELDS,
      headline: '--><img src=x onerror="alert(1)">',
      leadMessage: `Tom & Jerry's "code"`,
      primaryColor: '#fff;"><script>',
    };
    const html = compileVisualToHtml('otp-verification', typed);
    expect(html).not.toContain('<img src=x');
    expect(html.indexOf('-->')).toBeGreaterThan(html.indexOf('"primaryColor"'));
    expect(readVisualStamp(html)).toEqual(typed);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('Tom &amp; Jerry&#39;s &quot;code&quot;');
  });

  it('still signs its work so the form reopens with the same fields', () => {
    const html = compileVisualToHtml('app-credentials', FIELDS);
    expect(readVisualStamp(html)).toEqual(FIELDS);
  });

  /** The point of the shared layout: the form and the server cannot drift into two designs again. */
  it('draws through the same shell as the server’s built-in emails', () => {
    const body = stripStamp(compileVisualToHtml('otp-verification', FIELDS));
    const serverShell = renderEmailLayout({ title: 'x' });
    const shellOpening = serverShell.slice(serverShell.indexOf('<body'), serverShell.indexOf(EMAIL_LAYOUT_MARKER) + EMAIL_LAYOUT_MARKER.length);

    expect(body).toContain(EMAIL_LAYOUT_MARKER);
    expect(body).toContain(shellOpening);
  });
});
