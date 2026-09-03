/**
 * One import site for localisation.
 *
 * Screens should need exactly `import { useT } from '../i18n';` and nothing else. The runtime,
 * the catalogues and the resolution rules are separate files because they are tested and
 * reasoned about separately, not because callers should have to know about them.
 */
export { t, i18n, applyLanguagePreference, getActiveLocale, getLanguagePreference } from './i18n';
export type { TranslationKey, TranslationVars } from './i18n';
export { useT, useLocale, useLanguage, initI18nFromPreferences } from './useI18n';
export { serverErrorText, translateServerError } from './server-errors';
export type { LanguageControl } from './useI18n';
export {
  SUPPORTED_LOCALES,
  BASE_LOCALE,
  DEFAULT_LANGUAGE_PREFERENCE,
  isLanguagePreference,
  matchLocaleTag,
  resolveLocale,
} from './locale-resolution';
export type { LanguagePreference, SupportedLocale } from './locale-resolution';
