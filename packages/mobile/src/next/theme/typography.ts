/**
 * The type scale, and which font renders which language.
 *
 * Rules the owner set: nothing below 16 (one exception, legal fine print at 15), body at 18,
 * headings in Baloo 2, body in Noto Sans. Line heights are generous because Indic scripts stack
 * vowel signs above and below the line; a Latin-tuned 1.2 clips them.
 *
 * The OS font-size setting is respected: sizes here are the base, and React Native scales them.
 *
 * Baloo 2 covers Latin and Devanagari only. For the other five scripts headings use the bold Noto
 * face of that script (see `fontFamilyFor`), so a Tamil heading is never drawn as boxes.
 * Pure data, checked in `tokens.spec.ts`.
 */
import type { AppLanguage } from '../i18n/languages';
import { scriptOf, type Script } from '../i18n/languages';

export type TextVariant =
  | 'display'
  | 'heading'
  | 'title'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'secondary'
  | 'button'
  | 'fine';

export interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  /** Which face of the language's font pair to use. */
  role: 'heading' | 'strong' | 'regular';
}

export const type: Record<TextVariant, TypeStyle> = {
  display: { fontSize: 30, lineHeight: 42, role: 'heading' },
  heading: { fontSize: 24, lineHeight: 34, role: 'heading' },
  title: { fontSize: 20, lineHeight: 30, role: 'heading' },
  body: { fontSize: 18, lineHeight: 28, role: 'regular' },
  bodyStrong: { fontSize: 18, lineHeight: 28, role: 'strong' },
  label: { fontSize: 16, lineHeight: 24, role: 'strong' },
  secondary: { fontSize: 16, lineHeight: 24, role: 'regular' },
  button: { fontSize: 18, lineHeight: 26, role: 'strong' },
  /** Legal fine print only. The one size under 16. */
  fine: { fontSize: 15, lineHeight: 22, role: 'regular' },
};

/** The floor every variant except `fine` must respect. */
export const MIN_FONT_SIZE = 16;
export const FINE_PRINT_SIZE = 15;

/**
 * How far the OS font scale may grow text. Respected, but capped so a 200% phone setting cannot
 * push a button's label out of the button. 2× the base is still larger than any in-app size.
 */
export const MAX_FONT_SCALE = 2;

/** The registered font family names (the keys passed to `expo-font`). */
export const FONT = {
  latinRegular: 'NotoSans_400Regular',
  latinBold: 'NotoSans_700Bold',
  headingLatinDevanagari: 'Baloo2_700Bold',
  devanagariRegular: 'NotoSansDevanagari_400Regular',
  devanagariBold: 'NotoSansDevanagari_700Bold',
  tamilRegular: 'NotoSansTamil_400Regular',
  tamilBold: 'NotoSansTamil_700Bold',
  teluguRegular: 'NotoSansTelugu_400Regular',
  teluguBold: 'NotoSansTelugu_700Bold',
  kannadaRegular: 'NotoSansKannada_400Regular',
  kannadaBold: 'NotoSansKannada_700Bold',
  bengaliRegular: 'NotoSansBengali_400Regular',
  bengaliBold: 'NotoSansBengali_700Bold',
  gujaratiRegular: 'NotoSansGujarati_400Regular',
  gujaratiBold: 'NotoSansGujarati_700Bold',
} as const;

const SCRIPT_FACES: Record<Script, { regular: string; bold: string; heading: string }> = {
  latin: { regular: FONT.latinRegular, bold: FONT.latinBold, heading: FONT.headingLatinDevanagari },
  devanagari: { regular: FONT.devanagariRegular, bold: FONT.devanagariBold, heading: FONT.headingLatinDevanagari },
  tamil: { regular: FONT.tamilRegular, bold: FONT.tamilBold, heading: FONT.tamilBold },
  telugu: { regular: FONT.teluguRegular, bold: FONT.teluguBold, heading: FONT.teluguBold },
  kannada: { regular: FONT.kannadaRegular, bold: FONT.kannadaBold, heading: FONT.kannadaBold },
  bengali: { regular: FONT.bengaliRegular, bold: FONT.bengaliBold, heading: FONT.bengaliBold },
  gujarati: { regular: FONT.gujaratiRegular, bold: FONT.gujaratiBold, heading: FONT.gujaratiBold },
};

/**
 * The family to draw `role` text in, for a language — or undefined while that script's fonts are
 * not loaded yet, which means "the system font" (always legible, just not ours).
 *
 * Branch names and numbers inside a Hindi sentence are Latin; Android and iOS both fall back per
 * glyph to a system face when the chosen family lacks one, so mixed text still renders.
 */
export function fontFamilyFor(
  language: AppLanguage,
  role: TypeStyle['role'],
  loaded: ReadonlySet<string>,
): string | undefined {
  const faces = SCRIPT_FACES[scriptOf(language)];
  const family = role === 'heading' ? faces.heading : role === 'strong' ? faces.bold : faces.regular;
  return loaded.has(family) ? family : undefined;
}

/** Every family a script needs, for loading. */
export function familiesForScript(script: Script): string[] {
  const f = SCRIPT_FACES[script];
  return Array.from(new Set([f.regular, f.bold, f.heading]));
}
