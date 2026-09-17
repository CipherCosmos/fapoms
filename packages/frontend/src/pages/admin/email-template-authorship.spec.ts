import {
  stampVisual, stripStamp, readVisualStamp, writtenBySimpleEditor, authorshipOf,
} from './email-template-authorship';
import type { VisualTemplateData } from './EmailTemplatesSection';

/**
 * THE SEQUENCE THIS PREVENTS, WHICH USED TO END WITH A PUBLISHED EMAIL NOBODY WROTE:
 *
 *   open a customised template → switch to the simple editor → type one character →
 *   the whole body is recompiled from defaults → publish.
 *
 * Everything below exists to make the third step impossible without somebody being asked first.
 */
const FIELDS: VisualTemplateData = {
  subject: 'Your Appraiser registration code',
  headline: 'Verify your email',
  greeting: 'Hello,',
  leadMessage: 'Enter the six digits below to continue your registration.',
  footerNotice: 'If you did not ask for this, ignore this email.',
  primaryColor: '#ED6714',
  headerStyle: 'gradient-banner',
};

const HAND_WRITTEN = '<html><body><table><tr><td>Somebody wrote this by hand, over an afternoon.</td></tr></table></body></html>';

describe('knowing who wrote a template', () => {
  it('reads back exactly the fields that produced the html', () => {
    const compiled = stampVisual('<html><body>compiled body</body></html>', FIELDS);

    expect(readVisualStamp(compiled)).toEqual(FIELDS);
    expect(writtenBySimpleEditor(compiled)).toBe(true);
    expect(authorshipOf(compiled)).toBe('simple-editor');
  });

  it('does not claim somebody else’s html as its own', () => {
    expect(readVisualStamp(HAND_WRITTEN)).toBeNull();
    expect(writtenBySimpleEditor(HAND_WRITTEN)).toBe(false);
    expect(authorshipOf(HAND_WRITTEN)).toBe('hand-written');
  });

  it('treats an empty template as nothing to lose', () => {
    expect(authorshipOf('')).toBe('empty');
    expect(authorshipOf(null)).toBe('empty');
    expect(authorshipOf('   \n  ')).toBe('empty');
    // A stamp with nothing behind it is still nothing to lose.
    expect(authorshipOf(stampVisual('', FIELDS))).toBe('empty');
  });

  /** Every uncertain case answers "ask first", because asking needlessly is the cheaper mistake. */
  it.each([
    ['damaged json', '<!--fapoms:simple-editor {"headline": -->\n<p>body</p>'],
    ['a list rather than fields', '<!--fapoms:simple-editor ["headline"] -->\n<p>body</p>'],
    ['a stamp with no message in it', '<!--fapoms:simple-editor {"primaryColor":"#fff"} -->\n<p>body</p>'],
    ['a stamp somebody pasted as text', '&lt;!--fapoms:simple-editor {"headline":"x"} --&gt;<p>body</p>'],
  ])('refuses to trust %s', (_case, html) => {
    expect(readVisualStamp(html)).toBeNull();
    expect(authorshipOf(html)).toBe('hand-written');
  });

  it('keeps the email itself unchanged apart from the stamp', () => {
    const body = '<html><body><p>The body</p></body></html>';
    const compiled = stampVisual(body, FIELDS);

    expect(stripStamp(compiled)).toBe(body);
    // The stamp is an HTML comment: invisible in every client, and no validator's business.
    expect(compiled.startsWith('<!--')).toBe(true);
    expect(compiled).toContain(body);
  });

  it('re-stamps rather than stacking stamps on every keystroke', () => {
    const once = stampVisual('<p>body</p>', FIELDS);
    const twice = stampVisual(once, { ...FIELDS, headline: 'Changed' });

    expect(twice.match(/fapoms:simple-editor/g)).toHaveLength(1);
    expect(readVisualStamp(twice)?.headline).toBe('Changed');
  });

  /** Round trip, which is the whole promise: open what the form wrote, and nothing is lost. */
  it('survives a full save-and-reopen', () => {
    const saved = stampVisual('<html><body>compiled</body></html>', FIELDS);
    const reopened = readVisualStamp(saved);

    expect(reopened).toEqual(FIELDS);
    expect(stampVisual('<html><body>compiled</body></html>', reopened as VisualTemplateData)).toBe(saved);
  });
});
