import {
  DEFAULT_EMAIL_BRAND,
  EMAIL_LAYOUT_MARKER,
  EMAIL_TONE_STYLES,
  escapeEmailHtml,
  isEmailTemplateToken,
  renderEmailLayout,
  safeEmailColor,
  safeEmailUrl,
  shadeColor,
  trustedEmailHtml,
} from './email-layout';

/**
 * The one email layout. Both the server's emails and the admin template editor draw through it, so
 * what these pin is what every email the platform sends can rely on: nothing given is lost, nothing
 * not given is drawn, text never becomes markup, and a link is never a script.
 */

const FULL = {
  brand: { logoUrl: 'https://app.example.com/sumeru-logo@2x.png' },
  title: 'Your code is ready',
  subtitle: 'A subtitle line',
  badge: { text: 'Security' },
  bodyLines: ['First paragraph.', 'Second paragraph.'],
  codeBox: { code: '849201', label: 'One-Time Verification Code', note: 'Strictly confidential' },
  kvTable: [
    { label: 'Username', value: 'AS-p1' },
    { label: 'Temporary Password', value: 'river-otter-42', highlight: true },
  ],
  callout: { title: 'Heads up', text: 'Callout body.' },
  blocks: [trustedEmailHtml('<div class="extra">Extra block</div>')],
  button: { href: 'https://app.example.com/login', label: 'Sign in' },
  securityNotice: 'Never share this code.',
  footer: 'You are receiving this because of your role.',
};

describe('renderEmailLayout — every section it is given', () => {
  const html = renderEmailLayout(FULL);

  it.each([
    ['the title, in the heading and the document title', '<title>Your code is ready</title>'],
    ['the heading', 'Your code is ready</h1>'],
    ['the subtitle', 'A subtitle line'],
    ['the badge', 'Security</span>'],
    ['the first body line', 'First paragraph.'],
    ['the second body line', 'Second paragraph.'],
    ['the code', '849201'],
    ['the code label', 'One-Time Verification Code'],
    ['the code note', 'Strictly confidential'],
    ['a table label', 'Username'],
    ['a table value', 'AS-p1'],
    ['the highlighted value', 'river-otter-42'],
    ['the callout title', 'Heads up'],
    ['the callout text', 'Callout body.'],
    ['a trusted block, verbatim', '<div class="extra">Extra block</div>'],
    ['the button label', 'Sign in</a>'],
    ['the button link', 'href="https://app.example.com/login"'],
    ['the spelled-out link', 'Direct link:'],
    ['the security notice', 'Never share this code.'],
    ['the footer', 'You are receiving this because of your role.'],
    ['the logo', 'src="https://app.example.com/sumeru-logo@2x.png"'],
    ['the company and product line', `${DEFAULT_EMAIL_BRAND.companyName} &bull; ${DEFAULT_EMAIL_BRAND.productName}`],
    ['the shared-shell marker', EMAIL_LAYOUT_MARKER],
  ])('draws %s', (_what, fragment) => {
    expect(html).toContain(fragment);
  });

  it('keeps the sections in reading order', () => {
    const order = ['Security</span>', '</h1>', 'A subtitle line', 'First paragraph.', '849201', 'AS-p1', 'Callout body.', 'Extra block', 'Sign in</a>', 'Never share this code.', 'You are receiving this'];
    const positions = order.map((fragment) => html.indexOf(fragment));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('renderEmailLayout — nothing it is not given', () => {
  const html = renderEmailLayout({ title: 'Bare' });

  it.each([
    ['no badge', 'text-transform:uppercase;background-color:'],
    ['no subtitle', 'font-size:13.5px'],
    ['no body paragraph', 'font-size:14.5px'],
    ['no code box', 'letter-spacing:6px'],
    ['no key-value table', 'width:38%'],
    ['no callout', 'border-left:3px'],
    ['no button', 'Direct link:'],
    ['no security notice', 'Note:</strong>'],
    ['no footer line', 'font-size:11.5px;color:#9CA3AF'],
    ['no logo', '<img'],
  ])('draws %s', (_what, fragment) => {
    expect(html).not.toContain(fragment);
  });

  it('still draws the shell, the title and the brand line', () => {
    expect(html).toContain(EMAIL_LAYOUT_MARKER);
    expect(html).toContain('Bare</h1>');
    expect(html).toContain(DEFAULT_EMAIL_BRAND.companyName);
  });

  it('treats empty text as not given', () => {
    const empty = renderEmailLayout({
      title: 'Empty',
      badge: { text: '' },
      codeBox: { code: '' },
      callout: { text: '' },
      kvTable: [],
      bodyLines: ['', trustedEmailHtml('   ')],
      securityNotice: '',
    });
    expect(empty).not.toContain('letter-spacing:6px');
    expect(empty).not.toContain('border-left:3px');
    expect(empty).not.toContain('Note:</strong>');
    expect(empty).not.toContain('font-size:14.5px');
  });
});

describe('escaping', () => {
  const HOSTILE = `<script>alert("x")</script> & 'quoted'`;
  const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;';

  it('escapes the five characters', () => {
    expect(escapeEmailHtml(HOSTILE)).toBe(ESCAPED);
    expect(escapeEmailHtml(null)).toBe('');
    expect(escapeEmailHtml(undefined)).toBe('');
    expect(escapeEmailHtml(42)).toBe('42');
  });

  it('escapes every text field of the layout', () => {
    const html = renderEmailLayout({
      brand: { companyName: HOSTILE, productName: HOSTILE, headerStyle: 'framed-card', logoUrl: 'https://x.test/l.png' },
      title: HOSTILE,
      subtitle: HOSTILE,
      badge: { text: HOSTILE },
      bodyLines: [HOSTILE],
      codeBox: { code: HOSTILE, label: HOSTILE, note: HOSTILE },
      kvTable: [{ label: HOSTILE, value: HOSTILE }],
      callout: { title: HOSTILE, text: HOSTILE },
      button: { href: 'https://x.test', label: HOSTILE },
      securityNotice: HOSTILE,
      footer: HOSTILE,
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(`'quoted'`);
    expect(html).not.toContain('"x"');
    // 15 text slots plus the logo's alt text, the banner company name and the footer brand line.
    expect(html.split(ESCAPED).length - 1).toBeGreaterThanOrEqual(15);
  });

  it('escapes quotes inside a link so an attribute cannot be broken out of', () => {
    const html = renderEmailLayout({ title: 't', button: { href: 'https://x.test/" onmouseover="alert(1)', label: 'go' } });
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain('https://x.test/&quot; onmouseover=&quot;alert(1)');
  });
});

describe('links', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'mailto:someone@example.com',
    '{{{rawUrl}}}',
    '',
    '   ',
  ])('drops %j', (href) => {
    expect(safeEmailUrl(href)).toBeNull();
    const html = renderEmailLayout({ title: 't', button: { href, label: 'Open' }, brand: { logoUrl: href } });
    expect(html).not.toContain('Open</a>');
    expect(html).not.toContain('Direct link:');
    expect(html).not.toContain('<img');
    expect(html.toLowerCase()).not.toContain('script:');
  });

  it.each([
    ['https://app.example.com/a?b=1&c=2', 'https://app.example.com/a?b=1&amp;c=2'],
    ['http://localhost:5173/x', 'http://localhost:5173/x'],
    ['/relative/path', '/relative/path'],
    ['cid:sumeru-logo', 'cid:sumeru-logo'],
    ['{{inviteUrl}}', '{{inviteUrl}}'],
    [' {{ loginUrl }} ', '{{ loginUrl }}'],
  ])('keeps %j', (href, expected) => {
    expect(safeEmailUrl(href)).toBe(expected);
    expect(renderEmailLayout({ title: 't', button: { href, label: 'Open' } })).toContain(`href="${expected}"`);
  });

  it('recognises only whole escaped tokens', () => {
    expect(isEmailTemplateToken('{{otpCode}}')).toBe(true);
    expect(isEmailTemplateToken('{{{digestSectionsHtml}}}')).toBe(false);
    expect(isEmailTemplateToken('see {{otpCode}}')).toBe(false);
    expect(isEmailTemplateToken(null)).toBe(false);
  });
});

describe('template tokens', () => {
  it('survive as plain text, because escaping never touches braces', () => {
    const html = renderEmailLayout({
      title: 'Hello {{fullName}}',
      bodyLines: ['Dear {{fullName}},'],
      codeBox: { code: '{{otpCode}}', note: 'Valid for {{validMinutes}} minutes' },
      kvTable: [{ label: 'Username', value: '{{username}}' }],
      footer: 'Contact {{supportEmail}}',
      brand: { logoUrl: '{{logoUrl}}' },
    });
    for (const token of ['{{fullName}}', '{{otpCode}}', '{{validMinutes}}', '{{username}}', '{{supportEmail}}']) {
      expect(html).toContain(token);
    }
    expect(html).toContain('src="{{logoUrl}}"');
  });

  it('survive verbatim inside trusted blocks, raw tokens included', () => {
    const html = renderEmailLayout({
      title: 't',
      blocks: [trustedEmailHtml('<div>{{{digestSectionsHtml}}}</div>')],
      callout: { title: 'Documents', text: trustedEmailHtml('&bull; PAN<br/>&bull; {{bankName}}') },
    });
    expect(html).toContain('<div>{{{digestSectionsHtml}}}</div>');
    expect(html).toContain('&bull; PAN<br/>&bull; {{bankName}}');
  });

  it('are the only thing a trusted wrapper lets through — a plain string with markup is still text', () => {
    const html = renderEmailLayout({ title: 't', bodyLines: ['<b>{{name}}</b>'] });
    expect(html).toContain('&lt;b&gt;{{name}}&lt;/b&gt;');
  });
});

describe('tones', () => {
  it('draws the badge and callout in the tone asked for', () => {
    const html = renderEmailLayout({
      title: 't',
      badge: { text: 'Alert', tone: 'crimson' },
      callout: { text: 'Done', tone: 'emerald' },
    });
    expect(html).toContain(`background-color:${EMAIL_TONE_STYLES.crimson.badgeBg};color:${EMAIL_TONE_STYLES.crimson.badgeText}`);
    expect(html).toContain(`background-color:${EMAIL_TONE_STYLES.emerald.calloutBg};border-left:3px solid ${EMAIL_TONE_STYLES.emerald.calloutBorder}`);
  });

  it('defaults the badge to gold and the callout to flame, including for an unknown tone', () => {
    const html = renderEmailLayout({
      title: 't',
      badge: { text: 'Info' },
      callout: { text: 'Note', tone: 'neon' as never },
    });
    expect(html).toContain(`background-color:${EMAIL_TONE_STYLES.gold.badgeBg}`);
    expect(html).toContain(`border-left:3px solid ${EMAIL_TONE_STYLES.flame.calloutBorder}`);
  });

  it('draws a toned code box in its tone rather than the brand colour', () => {
    const html = renderEmailLayout({ title: 't', codeBox: { code: 'AS-01', tone: 'emerald' } });
    expect(html).toContain(`background-color:${EMAIL_TONE_STYLES.emerald.calloutBg}`);
  });
});

describe('brand', () => {
  it('uses the chosen colours for the header, the button and the code box', () => {
    const html = renderEmailLayout({
      brand: { primaryColor: '#047857', accentColor: '#ECFDF5' },
      title: 't',
      codeBox: { code: '1' },
      button: { href: 'https://x.test', label: 'Go' },
    });
    expect(html).toContain('height:5px;background-color:#047857');
    expect(html).toContain('border-radius:6px;background-color:#047857');
    expect(html).toContain('background-color:#ECFDF5');
    expect(html).not.toContain(DEFAULT_EMAIL_BRAND.primaryColor);
  });

  it.each([
    ['gradient-banner', 'linear-gradient(135deg, #4F46E5'],
    ['framed-card', 'Acme Official Notice'],
    ['accent-line', 'height:5px;background-color:#4F46E5'],
  ] as const)('draws the %s header', (headerStyle, fragment) => {
    const html = renderEmailLayout({ brand: { headerStyle, primaryColor: '#4F46E5', companyName: 'Acme' }, title: 't' });
    expect(html).toContain(fragment);
  });

  it('refuses a colour that could escape the style attribute', () => {
    const hostile = 'red;"><img src=x>';
    expect(safeEmailColor(hostile, '#ED6714')).toBe('#ED6714');
    const html = renderEmailLayout({ brand: { primaryColor: hostile, accentColor: hostile }, title: 't' });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain(`background-color:${DEFAULT_EMAIL_BRAND.primaryColor}`);
  });

  it('accepts hex and named colours', () => {
    expect(safeEmailColor('#abc', 'x')).toBe('#abc');
    expect(safeEmailColor(' #AABBCC ', 'x')).toBe('#AABBCC');
    expect(safeEmailColor('navy', 'x')).toBe('navy');
    expect(safeEmailColor('#12345', 'x')).toBe('x');
    expect(safeEmailColor(undefined, 'x')).toBe('x');
  });
});

describe('shadeColor', () => {
  it('darkens and lightens each channel, clamped', () => {
    expect(shadeColor('#ED6714', -18)).toBe('#bf3900');
    expect(shadeColor('#000000', 10)).toBe('#1a1a1a');
    expect(shadeColor('#FFFFFF', 10)).toBe('#ffffff');
    expect(shadeColor('#fff', -100)).toBe('#000000');
  });

  it('leaves a colour it cannot read unchanged', () => {
    expect(shadeColor('navy', -18)).toBe('navy');
    expect(shadeColor('#12', -18)).toBe('#12');
  });
});

describe('a callout that is a list', () => {
  it('keeps one item per line instead of running them into a paragraph', () => {
    const html = renderEmailLayout({ title: 'T', bodyLines: ['Hi'], callout: { title: 'Asked for', text: '• PAN card: retake\n• IFSC: fix it' } });
    expect(html).toMatch(/white-space:pre-line;">• PAN card: retake\n• IFSC: fix it<\/div>/);
  });
});

