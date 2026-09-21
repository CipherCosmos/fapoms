import { EMAIL_LAYOUT_MARKER } from '@fapoms/shared';

import { renderEmailHtml, setAppPublicUrl } from './email-provider';
import { escapeHtml } from './email-template-renderer';

/**
 * `renderEmailHtml` is now an adapter over the shared email layout — the one the admin template
 * editor also draws through. What every caller of it relies on is pinned here: all the content it is
 * given arrives, text is never markup, and a link that is not http(s) never becomes a button.
 */
describe('renderEmailHtml', () => {
  beforeAll(() => setAppPublicUrl('https://fapoms.example.com/'));
  afterAll(() => setAppPublicUrl(null));

  const FULL = {
    title: 'Your FAPOMS App Access Credentials',
    subtitle: 'Provisioned today',
    badge: { text: 'Access', tone: 'emerald' as const },
    bodyLines: ['Hello Priya,', 'Use the details below.'],
    otpCode: '849201',
    kvTable: [
      { label: 'Username / Appraiser ID', value: 'AS-p1' },
      { label: 'Temporary Password', value: 'river-otter-42' },
    ],
    callout: { title: 'Heads up', text: 'Change it on first sign-in.', tone: 'flame' as const },
    linkUrl: 'https://fapoms.example.com/login?next=/me&x=1',
    linkLabel: 'Access FAPOMS Portal',
    footer: 'Sent because you were onboarded.',
    securityNotice: 'Never share your password.',
  };

  it('draws through the shared layout, with the platform logo', () => {
    const html = renderEmailHtml(FULL);
    expect(html).toContain(EMAIL_LAYOUT_MARKER);
    expect(html).toContain('src="https://fapoms.example.com/sumeru-logo@2x.png"');
  });

  it.each([
    'Your FAPOMS App Access Credentials</h1>',
    'Provisioned today',
    'Access</span>',
    'Hello Priya,',
    'Use the details below.',
    '849201',
    'One-Time Verification Code',
    'Username / Appraiser ID',
    'AS-p1',
    'river-otter-42',
    'Heads up',
    'Change it on first sign-in.',
    'Access FAPOMS Portal</a>',
    'href="https://fapoms.example.com/login?next=/me&amp;x=1"',
    'Sent because you were onboarded.',
    'Never share your password.',
  ])('keeps %j', (fragment) => {
    expect(renderEmailHtml(FULL)).toContain(fragment);
  });

  it('fills in the default footer and button label', () => {
    const html = renderEmailHtml({ title: 't', bodyLines: [], linkUrl: '/assignments/1' });
    expect(html).toContain('You are receiving this communication regarding your role in FAPOMS.');
    expect(html).toContain('Open in FAPOMS</a>');
    expect(html).toContain('href="/assignments/1"');
  });

  it('escapes every piece of text, quotes included', () => {
    const hostile = `<b>"Bold" & 'brave'</b>`;
    const escaped = '&lt;b&gt;&quot;Bold&quot; &amp; &#39;brave&#39;&lt;/b&gt;';
    const html = renderEmailHtml({
      title: hostile,
      subtitle: hostile,
      badge: { text: hostile },
      bodyLines: [hostile],
      otpCode: hostile,
      kvTable: [{ label: hostile, value: hostile }],
      callout: { title: hostile, text: hostile },
      linkUrl: 'https://x.test',
      linkLabel: hostile,
      footer: hostile,
      securityNotice: hostile,
    });
    expect(html).not.toContain('<b>');
    expect(html).not.toContain(`'brave'`);
    expect(html).not.toContain('"Bold"');
    expect(html.split(escaped).length - 1).toBeGreaterThanOrEqual(13);
  });

  it.each(['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'mailto:a@b.c'])(
    'drops the button for %j',
    (linkUrl) => {
      const html = renderEmailHtml({ title: 't', bodyLines: ['b'], linkUrl, linkLabel: 'Go' });
      expect(html).not.toContain('Go</a>');
      expect(html).not.toContain('Direct link:');
      expect(html.toLowerCase()).not.toContain('script:');
    },
  );

  it('draws no button, code, table, callout or notice it was not given', () => {
    const html = renderEmailHtml({ title: 't', bodyLines: ['b'] });
    expect(html).not.toContain('Direct link:');
    expect(html).not.toContain('One-Time Verification Code');
    expect(html).not.toContain('width:38%');
    expect(html).not.toContain('border-left:3px');
    expect(html).not.toContain('Note:</strong>');
  });
});

describe('escapeHtml (template tokens)', () => {
  it('is the shared escaper: the five characters, and nothing for nothing', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(undefined as unknown as string)).toBe('');
    expect(escapeHtml('{{token}}')).toBe('{{token}}');
  });
});
