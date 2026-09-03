import { I18n } from 'i18n-js';
import type { Leaves } from './catalogue';
import { en } from './locales/en';
import { hi } from './locales/hi';
import { getDeviceLanguageTags } from './device-locale';
import {
  BASE_LOCALE,
  DEFAULT_LANGUAGE_PREFERENCE,
  resolveLocale,
  type LanguagePreference,
  type SupportedLocale,
} from './locale-resolution';

/**
 * The app's translator.
 *
 * `i18n-js` + `expo-localization` is the conventional Expo pairing and is what this uses. Two
 * things made it the right call here rather than a heavier framework: it has no dependency on
 * `Intl`/ICU, which Hermes ships only partially and which this app's minimum Android targets
 * cannot be relied on for; and it is a plain object with a `t()` on it, so services and hooks
 * that are not React components can translate without a provider in scope.
 *
 * ── The rule this file exists to enforce ───────────────────────────────────────────────────
 *
 * A missing key must render the English sentence. Never `profile.address.title`, never blank.
 * Three layers, in the order they fire:
 *
 *   1. `TranslationKey` (from `catalogue.ts`) makes a key that does not exist in English a
 *      compile error. Most misses never reach a build.
 *   2. `enableFallback` + `defaultLocale = 'en'` means a key present in English but absent from
 *      the active locale renders the English sentence. That is the normal, expected path — the
 *      Hindi catalogue is deliberately partial.
 *   3. `humaniseMissing` catches the residue: keys assembled at runtime from server data, which
 *      types cannot see. It renders a readable phrase built from the last key segment rather
 *      than i18n-js's default `[missing "en.x.y" translation]`, and shouts in development.
 */

/** Every dotted key the English catalogue defines. Anything else is a compile error. */
export type TranslationKey = Leaves<typeof en>;

/** Values substituted into `%{name}` placeholders. */
export type TranslationVars = Record<string, string | number>;

/**
 * The last resort, for a key no catalogue has.
 *
 * i18n-js's own strategies are all wrong for this audience: `message` renders
 * `[missing "en.foo.bar" translation]`, `error` throws, and `guess` produces the key's last
 * segment verbatim (`titleForced`). Turning `titleForced` into "Title forced" is not good copy,
 * but it is a readable English phrase rather than debug output on a field worker's screen, and
 * it degrades a missing string into something merely clumsy instead of something alarming.
 *
 * In development it is loud, because the only real fix is to add the key.
 */
function humaniseMissing(_i18n: I18n, scope: Readonly<string | string[]>): string {
  const key = Array.isArray(scope) ? scope.join('.') : String(scope);
  // `typeof` guard rather than a bare `__DEV__`: this module is also loaded by the package's
  // node-only jest run, which has no React Native globals, and the missing-key path is exactly
  // what those tests exercise.
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.warn(`[i18n] No translation for "${key}" in any locale — add it to locales/en.ts.`);
  }

  const last = key.split('.').pop() ?? key;
  const words = last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

const MISSING_STRATEGY = 'humanise';

export const i18n = new I18n(
  { en, hi },
  {
    locale: BASE_LOCALE,
    defaultLocale: BASE_LOCALE,
    // The whole point: an untranslated key falls through to English instead of rendering as
    // missing. Without this, a partial Hindi catalogue would be unusable.
    enableFallback: true,
  },
);
// Registered and selected after construction rather than through the constructor options,
// whose `missingBehavior` is typed to i18n-js's three built-in strategies only.
i18n.missingTranslation.register(MISSING_STRATEGY, humaniseMissing);
i18n.missingBehavior = MISSING_STRATEGY;

/**
 * Translate one key.
 *
 * Exported as a bare function as well as through `useT()` so non-React code — the upload
 * outbox, the notification service, the server-error mapper — can produce a localised sentence
 * without a component tree. React components should prefer `useT()`, which re-renders them when
 * the language changes; this function reads whatever locale is active at the moment it is
 * called and does not subscribe.
 */
export function t(key: TranslationKey, vars?: TranslationVars): string {
  return i18n.t(key, vars);
}

/**
 * Whether the active locale actually has its own wording for a key.
 *
 * Used by the tests, and by nothing in the UI — the app never wants to behave differently
 * because a string fell back, it just renders English.
 */
export function hasOwnTranslation(locale: SupportedLocale, key: TranslationKey): boolean {
  const segments = key.split('.');
  let node: unknown = (i18n.translations as Record<string, unknown>)[locale];
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string';
}

let currentPreference: LanguagePreference = DEFAULT_LANGUAGE_PREFERENCE;

export function getLanguagePreference(): LanguagePreference {
  return currentPreference;
}

/** The locale actually being rendered, after the preference and the handset are reconciled. */
export function getActiveLocale(): SupportedLocale {
  return i18n.locale as SupportedLocale;
}

/**
 * Point the translator at a preference.
 *
 * Persisting is the caller's job (see `services/preferences.ts`) so this stays synchronous:
 * the language has to change on the frame the assayer taps the option, not after a file write
 * on a cheap handset.
 */
export function applyLanguagePreference(preference: LanguagePreference): SupportedLocale {
  currentPreference = preference;
  const locale = resolveLocale(preference, getDeviceLanguageTags());
  i18n.locale = locale;
  return locale;
}

/**
 * Subscribe to language changes. Returns an unsubscribe function.
 *
 * `LanguageProvider` uses this to re-render the tree; nothing else should need it.
 */
export function onLanguageChange(listener: () => void): () => void {
  return i18n.onChange(listener);
}
