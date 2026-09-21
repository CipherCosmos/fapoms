import {
  sourceBadge, sourceOption, sourceHint, TEMPLATE_SOURCE, TEMPLATE_SOURCE_ORDER,
  contentSizeNote, GMAIL_CLIP_BYTES,
} from './email-template-vocabulary';

/**
 * The words on the email screen belong to whoever looks after the company's email, not to the
 * engine underneath it.
 *
 * The screen asked a non-technical administrator to choose between "Platform Override (Custom)",
 * "Filesystem Disk Template (Factory Default)" and "Built-in Fallback" — three storage locations
 * — when the question is only ever "which version of this email should we send?". It also made
 * three claims that were not information ("100% Guaranteed Stable", "Certified Factory Baseline",
 * a "Zero-Downtime Guarantee" paragraph) and printed "Content Size: 12043 characters", a number
 * against no threshold, which is a row people learn to read past.
 *
 * The API values are untouched; only the words changed.
 */
describe('email template vocabulary', () => {
  describe('which version to send', () => {
    it('keeps the three API values exactly', () => {
      // These are sent to the server. Renaming a value is a breaking change; renaming a word is not.
      expect(TEMPLATE_SOURCE_ORDER).toEqual(['platform', 'filesystem', 'fallback']);
    });

    it('names each one in words an operator already owns', () => {
      expect(sourceOption('platform')).toBe('Your edited version');
      expect(sourceOption('filesystem')).toBe('The original design');
      expect(sourceOption('fallback')).toBe('The plain built-in version');
    });

    it('explains every one of them on hover', () => {
      for (const src of TEMPLATE_SOURCE_ORDER) {
        expect(sourceHint(src).length).toBeGreaterThan(30);
        // The explanation must not just be the word again.
        expect(sourceHint(src)).not.toBe(TEMPLATE_SOURCE[src].option);
      }
    });

    it('puts the version number only on the one that has versions', () => {
      // Only a published edit is versioned; the other two are whatever the installed product has.
      expect(sourceBadge('platform', 7)).toBe('Yours · v7');
      expect(sourceBadge('filesystem', 7)).toBe('Original design');
      expect(sourceBadge('platform', null)).toBe('Yours');
    });

    it('shows an unrecognised source rather than an empty chip', () => {
      expect(sourceBadge('something-new' as never)).toBe('something-new');
    });
  });

  describe('size, measured against the number that matters', () => {
    const html = (bytes: number) => 'x'.repeat(bytes);

    it('reassures well under the Gmail limit', () => {
      const n = contentSizeNote(html(12 * 1024));
      expect(n.tone).toBe('ok');
      expect(n.text).toMatch(/12 KB/);
      expect(n.text).toMatch(/under Gmail/);
    });

    it('warns approaching it, before the email is sent rather than after', () => {
      expect(contentSizeNote(html(Math.round(GMAIL_CLIP_BYTES * 0.85))).tone).toBe('warn');
    });

    it('says what actually happens once it is crossed', () => {
      const n = contentSizeNote(html(GMAIL_CLIP_BYTES + 1));
      expect(n.tone).toBe('bad');
      // The consequence, not the threshold: the reader must know the end may go unseen.
      expect(n.text).toMatch(/Message clipped/);
    });

    it('shows a decimal for small emails, so 0 KB never appears', () => {
      expect(contentSizeNote(html(300)).text).toMatch(/^0\.3 KB/);
    });
  });
});
