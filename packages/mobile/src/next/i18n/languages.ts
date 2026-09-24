/**
 * The languages the rebuilt app ships, and what the app needs to know about each.
 *
 * Owner decision: English is the default; Hindi, Marathi, Tamil, Telugu, Kannada, Bengali and
 * Gujarati are offered. The seven are machine drafts until a native speaker has reviewed them —
 * each catalogue file says so at the top.
 *
 * Pure: no React Native, no storage.
 */

export const APP_LANGUAGES = ['en', 'hi', 'mr', 'ta', 'te', 'kn', 'bn', 'gu'] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: AppLanguage = 'en';

export type Script = 'latin' | 'devanagari' | 'tamil' | 'telugu' | 'kannada' | 'bengali' | 'gujarati';

interface LanguageFacts {
  /** The language's name in its own script — what the language screen shows. */
  nativeName: string;
  /** The same name in English, shown underneath so a helper can find it too. */
  englishName: string;
  script: Script;
  /**
   * CLDR cardinal plural rule, reduced to the two categories these languages use for whole
   * numbers ("one" and "other").
   *  - `one-is-1`: only 1 is singular (English, Marathi, Tamil, Telugu).
   *  - `zero-or-one`: 0 and 1 are both singular (Hindi, Kannada, Bengali, Gujarati).
   */
  plural: 'one-is-1' | 'zero-or-one';
}

export const LANGUAGE_FACTS: Record<AppLanguage, LanguageFacts> = {
  en: { nativeName: 'English', englishName: 'English', script: 'latin', plural: 'one-is-1' },
  hi: { nativeName: 'हिन्दी', englishName: 'Hindi', script: 'devanagari', plural: 'zero-or-one' },
  mr: { nativeName: 'मराठी', englishName: 'Marathi', script: 'devanagari', plural: 'one-is-1' },
  ta: { nativeName: 'தமிழ்', englishName: 'Tamil', script: 'tamil', plural: 'one-is-1' },
  te: { nativeName: 'తెలుగు', englishName: 'Telugu', script: 'telugu', plural: 'one-is-1' },
  kn: { nativeName: 'ಕನ್ನಡ', englishName: 'Kannada', script: 'kannada', plural: 'zero-or-one' },
  bn: { nativeName: 'বাংলা', englishName: 'Bengali', script: 'bengali', plural: 'zero-or-one' },
  gu: { nativeName: 'ગુજરાતી', englishName: 'Gujarati', script: 'gujarati', plural: 'zero-or-one' },
};

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && (APP_LANGUAGES as readonly string[]).includes(value);
}

export function scriptOf(language: AppLanguage): Script {
  return LANGUAGE_FACTS[language].script;
}

/** Every script the app can show — the language screen needs all of them at once. */
export const ALL_SCRIPTS: readonly Script[] = Array.from(new Set(APP_LANGUAGES.map(scriptOf)));

/** Where the choice is kept (the plain preferences file, not the keystore). */
export const LANGUAGE_PREFERENCE_KEY = 'next.language';

/**
 * What to do at launch.
 *
 * A stored, valid choice is used as-is. Anything else — first launch, or a value this build does
 * not know — means the language screen must be shown, with English preselected. The handset's own
 * language is deliberately NOT used to skip the question: the owner wants the choice asked, and a
 * phone set to English is common among people who read Hindi more comfortably.
 */
export function resolveStartLanguage(stored: string | null | undefined): {
  language: AppLanguage;
  needsChoice: boolean;
} {
  if (isAppLanguage(stored)) return { language: stored, needsChoice: false };
  return { language: DEFAULT_LANGUAGE, needsChoice: true };
}
