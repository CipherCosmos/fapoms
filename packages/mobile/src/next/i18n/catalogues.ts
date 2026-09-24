/**
 * All catalogues, and a translator bound to one language.
 *
 * Pure (no React Native), so the background runtime — which runs with no screen — and the tests
 * translate through exactly the same code as the UI.
 */
import { en, type EnglishCatalogue } from './locales/en';
import { hi } from './locales/hi';
import { mr } from './locales/mr';
import { ta } from './locales/ta';
import { te } from './locales/te';
import { kn } from './locales/kn';
import { bn } from './locales/bn';
import { gu } from './locales/gu';
import type { AppLanguage } from './languages';
import { translate, type CatalogueNode, type CatalogueOf, type Leaves, type TranslationVars } from './translate';

export const CATALOGUES: Record<AppLanguage, CatalogueOf<EnglishCatalogue>> = { en, hi, mr, ta, te, kn, bn, gu };

/** Every key English defines. Anything else is a compile error at `t('…')`. */
export type TranslationKey = Leaves<EnglishCatalogue>;

export type T = (key: TranslationKey, vars?: TranslationVars) => string;

/**
 * A translator for one language. Also accepts a plain `string` key at runtime (server-driven
 * codes such as `today.actions.<ACTION>`) — an unknown one is humanised, never shown raw.
 */
export function translatorFor(language: AppLanguage): T & ((key: string, vars?: TranslationVars) => string) {
  const catalogues = {
    active: CATALOGUES[language] as unknown as CatalogueNode,
    fallback: en as unknown as CatalogueNode,
  };
  return (key: string, vars?: TranslationVars) => translate(catalogues, language, key, vars);
}
