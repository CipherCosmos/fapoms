/**
 * Which catalogue to render, given what the handset says and what the assayer chose.
 *
 * Pure on purpose. Everything that could go wrong in locale selection — an unsupported
 * language, a region-tagged tag like `hi-IN`, a phone that reports nothing at all — is decided
 * here, over plain strings, so it can be tested in this package's node-only jest setup without
 * a React Native runtime or the native `expo-localization` module. The one impure part, asking
 * the OS what it prefers, is a two-line adapter in `device-locale.ts`.
 */

/** The locales this app actually ships a catalogue for. English is always present. */
export const SUPPORTED_LOCALES = ['en', 'hi'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * What the assayer picked in Profile → App → Language.
 *
 * `system` is the default and means "whatever the handset is set to". It is a distinct state
 * from `en`: someone who never opens the setting should follow their phone if they later
 * switch it to Hindi, whereas someone who explicitly chose English must stay on English.
 */
export type LanguagePreference = 'system' | SupportedLocale;

export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = 'system';

/** The locale rendered when nothing else can be determined. Also the fallback catalogue. */
export const BASE_LOCALE: SupportedLocale = 'en';

function isSupported(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || (typeof value === 'string' && isSupported(value));
}

/**
 * The best supported locale for one BCP 47 tag, or null if there is no honest match.
 *
 * Matching is on the primary subtag only: a phone set to `hi-IN` and one set to plain `hi`
 * want the same catalogue, and there is no separate Indian-Hindi variant to distinguish them.
 * Anything unsupported returns null rather than guessing — a Tamil handset is better served by
 * readable English than by Hindi chosen because it is the other Indian language in the build.
 */
export function matchLocaleTag(tag: string | null | undefined): SupportedLocale | null {
  if (!tag) return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isSupported(primary) ? primary : null;
}

/**
 * The locale to render.
 *
 * An explicit choice always wins, including an explicit choice of English. Only `system`
 * consults the handset, and it walks the device's preference list in order — Android and iOS
 * both let a user rank several languages, and someone whose first choice is unsupported but
 * whose second is Hindi should get Hindi rather than the English default.
 */
export function resolveLocale(
  preference: LanguagePreference,
  deviceTags: readonly (string | null | undefined)[],
): SupportedLocale {
  if (preference !== 'system') return preference;
  for (const tag of deviceTags) {
    const matched = matchLocaleTag(tag);
    if (matched) return matched;
  }
  return BASE_LOCALE;
}
