import { htmlToPlainText, plainTextFor } from './html-to-text';

/**
 * The text half of every email used to be regenerated from the built-in renderer no matter what the
 * HTML said, so a redesigned template reached plain-text readers as the old wording. These pin the
 * conversion that replaced it — and the one thing that matters most in it: the reader must still be
 * able to ACT on the email.
 */
describe('turning a sent email into its plain-text half', () => {
  it('keeps the address behind a button, or the email is a dead end', () => {
    const html = '<p>Please finish your registration.</p>'
      + '<a href="https://app.example.com/register/abc123" style="padding:12px">Open my form</a>';

    const text = htmlToPlainText(html);
    expect(text).toContain('Open my form (https://app.example.com/register/abc123)');
  });

  it('does not repeat an address that is already written out', () => {
    expect(htmlToPlainText('<a href="https://x.example.com">https://x.example.com</a>'))
      .toBe('https://x.example.com');
    expect(htmlToPlainText('<a href="mailto:help@example.com">help@example.com</a>'))
      .toBe('help@example.com');
  });

  it('keeps a one-time code that was sitting inside a styled box', () => {
    const html = '<table><tr><td style="font-size:32px;letter-spacing:8px">849201</td></tr></table>'
      + '<p>This code expires in 5 minutes.</p>';

    const text = htmlToPlainText(html);
    expect(text).toContain('849201');
    expect(text).toContain('This code expires in 5 minutes.');
  });

  it('drops everything that is presentation, including the parts that hide text', () => {
    const html = '<head><title>Never shown</title></head>'
      + '<style>.x{color:red}</style>'
      + '<!-- a note to nobody -->'
      + '<p>Only this survives.</p>';

    expect(htmlToPlainText(html)).toBe('Only this survives.');
  });

  it('writes lists as lists rather than running them together', () => {
    const text = htmlToPlainText('<ul><li>Aadhaar</li><li>PAN card</li></ul>');
    expect(text).toBe('- Aadhaar\n- PAN card');
  });

  it('names an image that carries meaning and ignores one that does not', () => {
    expect(htmlToPlainText('<img src="logo.png" alt="Sumeru Global">')).toBe('[Sumeru Global]');
    expect(htmlToPlainText('<p>Hello</p><img src="spacer.gif">')).toBe('Hello');
  });

  it('reads the entities as the characters they stand for', () => {
    expect(htmlToPlainText('<p>Terms &amp; conditions &mdash; 5&nbsp;minutes &#39;only&#39;</p>'))
      .toBe("Terms & conditions — 5 minutes 'only'");
  });

  it('keeps paragraphs apart without leaving a page of blank lines', () => {
    const text = htmlToPlainText('<div><p>One</p><p></p><p></p><p>Two</p></div>');
    expect(text).toBe('One\n\nTwo');
  });

  it('has nothing to say about nothing', () => {
    expect(htmlToPlainText('')).toBe('');
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText(undefined)).toBe('');
  });
});

describe('choosing which text body to send', () => {
  const builtIn = 'Your Appraiser registration verification code is 849201. It expires in 5 minutes.';

  it('uses the customised design once somebody has customised it', () => {
    const html = '<p>Welcome to Sumeru Global. Your verification code is 849201 and it lasts five minutes.</p>';
    expect(plainTextFor(html, builtIn)).toContain('Welcome to Sumeru Global');
  });

  it('keeps the hand-written wording when nothing has been customised', () => {
    // Same meaning either way, and the built-in sentence was written by a person.
    expect(plainTextFor('<p>anything at all</p>', builtIn, { customised: false })).toBe(builtIn);
  });

  /**
   * A near-empty text part is worse than a slightly stale one: it is what a recipient on a
   * text-only client actually receives, and an HTML body that converts to three words is a sign the
   * markup is doing something this conversion does not understand.
   */
  it('falls back rather than sending an almost-empty body', () => {
    expect(plainTextFor('<p>Hi</p>', builtIn)).toBe(builtIn);
    expect(plainTextFor('', builtIn)).toBe(builtIn);
    expect(plainTextFor(null, builtIn)).toBe(builtIn);
  });
});
