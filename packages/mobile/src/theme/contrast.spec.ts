// `tokens.ts` reaches for `Platform.select` to pick a monospace family. This suite runs in node,
// where the real react-native entry point is untranspiled ESM and cannot be loaded at all.
jest.mock('react-native', () => ({
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
}));

// `type` is imported under another name: as a bare named import it sits next to `type Palette`
// in the same clause, where it reads as the type-only modifier rather than as an identifier.
// eslint-disable-next-line import/first
import { palettes, type as typeScale, type Palette, type Mode } from './tokens';

/**
 * Every text tone stays legible on every ground the app paints it on.
 *
 * This is checked by arithmetic because it cannot be checked by eye. `textFaint` sat below the
 * WCAG AA floor in both themes for as long as the palette has existed — 3.85/3.45/3.02 on dark,
 * and a worse 3.19/3.47/3.36 on light — and nothing surfaced it, because low-contrast grey text
 * looks like a deliberate de-emphasis right up until somebody has to read it in daylight.
 *
 * It mattered more than a tertiary tone normally would: `overline` + `tone="faint"` is the FIELD
 * LABEL style, used at 38 sites including every label on the profile form and all three on the
 * change-password screen. Uppercase, letter-spaced, at the smallest size in the scale, in the
 * lowest-contrast colour, aimed at a low-literacy field workforce.
 *
 * AA and not AAA deliberately: AAA (7:1) would collapse the three text tiers into two, and a
 * scale that cannot express emphasis is its own legibility problem.
 */

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channel = (pair: string) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(h.slice(0, 2))
    + 0.7152 * channel(h.slice(2, 4))
    + 0.0722 * channel(h.slice(4, 6));
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 4.5:1 — the AA floor for normal text.
 *
 * Every tone below is used at 12–15px. AA relaxes to 3:1 only at 18pt, or 14pt bold, and nothing
 * in this scale reaches that: `largeTitle` is the only face big enough and it is never painted in
 * a muted tone.
 */
const AA_NORMAL_TEXT = 4.5;

/** The three surfaces text is painted on. `accent`-grounded text is a separate question. */
const GROUNDS: Array<keyof Palette> = ['bg', 'surface', 'surfaceAlt'];
const TEXT_TONES: Array<keyof Palette> = ['text', 'textMuted', 'textFaint'];

describe('text is legible on every ground, in both themes', () => {
  const modes: Mode[] = ['light', 'dark'];

  for (const mode of modes) {
    describe(mode, () => {
      const palette = palettes[mode];

      for (const tone of TEXT_TONES) {
        for (const ground of GROUNDS) {
          it(`${String(tone)} on ${String(ground)} meets AA`, () => {
            const ratio = contrast(palette[tone] as string, palette[ground] as string);
            // The received value is printed on failure, so whoever changed the colour sees how
            // far off it is rather than only that it is off.
            expect({ tone, ground, ratio: Number(ratio.toFixed(2)) })
              .toEqual({ tone, ground, ratio: expect.any(Number) });
            expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
          });
        }
      }

      it('keeps the three tiers distinguishable from each other', () => {
        // Passing AA by making every tone the same colour would satisfy the rule above and
        // destroy the reason the scale exists.
        expect(contrast(palette.text as string, palette.textMuted as string)).toBeGreaterThan(1.15);
        expect(contrast(palette.textMuted as string, palette.textFaint as string)).toBeGreaterThan(1.15);
      });
    });
  }

  /**
   * The floor itself. `overline` is the label style and sat at 11 while `caption` — plainer, less
   * shouty text — sat at 12; the smallest, most heavily styled face in the scale was also the
   * least readable.
   */
  it('has no face below 12px', () => {
    const tooSmall = Object.entries(typeScale)
      .filter(([, face]) => typeof (face as any)?.fontSize === 'number')
      .filter(([, face]) => (face as any).fontSize < 12)
      .map(([name, face]) => `${name}=${(face as any).fontSize}`);

    expect(tooSmall).toEqual([]);
  });
});
