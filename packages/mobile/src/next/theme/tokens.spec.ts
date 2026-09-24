import { colors, touch } from './tokens';
import { FINE_PRINT_SIZE, MIN_FONT_SIZE, fontFamilyFor, type } from './typography';
import { APP_LANGUAGES } from '../i18n/languages';

/** WCAG relative luminance / contrast, done by arithmetic because eyes are bad at it. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const ch = (p: string) => {
    const c = parseInt(p, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(h.slice(0, 2)) + 0.7152 * ch(h.slice(2, 4)) + 0.0722 * ch(h.slice(4, 6));
}
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('colour contrast (WCAG AA, 4.5:1 for text)', () => {
  const pairs: [string, string, string][] = [
    ['ink on ground', colors.ink, colors.ground],
    ['ink on surface', colors.ink, colors.surface],
    ['secondary on ground', colors.inkSecondary, colors.ground],
    ['secondary on surface', colors.inkSecondary, colors.surface],
    ['white on accent', colors.onAccent, colors.accent],
    ['white on pressed accent', colors.onAccent, colors.accentPressed],
    ['white on success', '#FFFFFF', colors.success],
    ['white on info', '#FFFFFF', colors.info],
    ['white on danger', '#FFFFFF', colors.danger],
    ['success on its tint', colors.success, colors.successSoft],
    ['info on its tint', colors.info, colors.infoSoft],
    ['danger on its tint', colors.danger, colors.dangerSoft],
    ['accent on its tint', colors.accent, colors.accentSoft],
    ['accent text on surface (quiet button)', colors.accent, colors.surface],
    ['disabled text on disabled fill', colors.disabledInk, colors.disabledFill],
    ['danger text on surface (field error)', colors.danger, colors.surface],
  ];
  it.each(pairs)('%s', (_name, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('type scale', () => {
  it('never goes below 16, except the one fine-print size of 15', () => {
    for (const [name, style] of Object.entries(type)) {
      if (name === 'fine') expect(style.fontSize).toBe(FINE_PRINT_SIZE);
      else expect(style.fontSize).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
    }
    expect(type.body.fontSize).toBe(18);
  });

  it('leaves room above and below the line for Indic vowel signs', () => {
    for (const style of Object.values(type)) expect(style.lineHeight / style.fontSize).toBeGreaterThanOrEqual(1.35);
  });

  it('keeps buttons and rows at thumb size', () => {
    expect(touch.minTarget).toBeGreaterThanOrEqual(48);
    expect(touch.button).toBeGreaterThanOrEqual(56);
    expect(touch.buttonLarge).toBeLessThanOrEqual(60);
  });
});

describe('fontFamilyFor', () => {
  const all = new Set([
    'NotoSans_400Regular', 'NotoSans_700Bold', 'Baloo2_700Bold', 'NotoSansDevanagari_400Regular',
    'NotoSansDevanagari_700Bold', 'NotoSansTamil_400Regular', 'NotoSansTamil_700Bold',
    'NotoSansTelugu_400Regular', 'NotoSansTelugu_700Bold', 'NotoSansKannada_400Regular',
    'NotoSansKannada_700Bold', 'NotoSansBengali_400Regular', 'NotoSansBengali_700Bold',
    'NotoSansGujarati_400Regular', 'NotoSansGujarati_700Bold',
  ]);

  it('uses Baloo 2 for headings where it has the glyphs (Latin, Devanagari)', () => {
    expect(fontFamilyFor('en', 'heading', all)).toBe('Baloo2_700Bold');
    expect(fontFamilyFor('hi', 'heading', all)).toBe('Baloo2_700Bold');
    expect(fontFamilyFor('mr', 'regular', all)).toBe('NotoSansDevanagari_400Regular');
  });

  it('never gives a Tamil (etc.) heading a font without Tamil glyphs', () => {
    expect(fontFamilyFor('ta', 'heading', all)).toBe('NotoSansTamil_700Bold');
    expect(fontFamilyFor('gu', 'strong', all)).toBe('NotoSansGujarati_700Bold');
  });

  it('falls back to the system font while a script is still loading', () => {
    expect(fontFamilyFor('te', 'regular', new Set())).toBeUndefined();
  });

  it('has a family for every language and role', () => {
    for (const lang of APP_LANGUAGES) for (const role of ['heading', 'strong', 'regular'] as const) {
      expect(fontFamilyFor(lang, role, all)).toBeDefined();
    }
  });
});
