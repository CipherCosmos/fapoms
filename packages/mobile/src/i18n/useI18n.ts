import { useCallback, useEffect, useState } from 'react';
import { getPreference, setPreference } from '../services/preferences';
import {
  applyLanguagePreference,
  getActiveLocale,
  getLanguagePreference,
  onLanguageChange,
  t,
  type TranslationKey,
  type TranslationVars,
} from './i18n';
import type { LanguagePreference, SupportedLocale } from './locale-resolution';

/**
 * How components translate.
 *
 * Deliberately a subscription hook rather than a `<LanguageProvider>` around the app. A
 * provider would have to sit outside `AppErrorBoundary` and the cold-start splash to cover
 * every screen, and any component rendered outside it — the error fallback in particular —
 * would throw instead of rendering. Subscribing per component has none of that ordering, adds
 * no node to the tree, and costs one listener per mounted component that shows text.
 *
 * Language changes are rare (a handful per install, if ever), so re-rendering every subscriber
 * on one is not a cost worth engineering around.
 */

/**
 * `t`, plus a re-render when the language changes.
 *
 * Returns the same stable function every time; what makes the screen update is the state bump
 * this hook performs on a language change, not a new translator identity. That matters for the
 * memoised rows and `React.memo` list items this app is full of — a new `t` on every render
 * would defeat every one of them.
 */
export function useT(): (key: TranslationKey, vars?: TranslationVars) => string {
  const [, setTick] = useState(0);
  useEffect(() => onLanguageChange(() => setTick((n) => n + 1)), []);
  return t;
}

/**
 * The active locale, for the rare case where it has to be a `useMemo` dependency.
 *
 * `useT` alone is not enough there: a list grouped and labelled inside a memo keyed on its data
 * would keep the sentences it built in the previous language, because the data did not change.
 * ScheduleScreen's day grouping is the case this exists for.
 */
export function useLocale(): SupportedLocale {
  const [, setTick] = useState(0);
  useEffect(() => onLanguageChange(() => setTick((n) => n + 1)), []);
  return getActiveLocale();
}

export interface LanguageControl {
  /** What the assayer chose: `system`, or a specific language. */
  preference: LanguagePreference;
  /** What that resolves to right now, once the handset's own setting is taken into account. */
  locale: SupportedLocale;
  /** Applies the choice immediately and persists it. */
  setLanguage: (preference: LanguagePreference) => void;
}

/**
 * The Language setting's own state. Only the settings row needs this; screens want `useT`.
 *
 * The write is fire-and-forget on purpose: the language must change on the frame the option is
 * tapped, and a slow file write on a cheap handset must not hold that up. `setPreference`
 * already swallows a failed write and keeps the value applied for the session, which is the
 * right trade — a preference that did not persist is a smaller problem than a tap that
 * appeared to do nothing.
 */
export function useLanguage(): LanguageControl {
  const [, setTick] = useState(0);
  useEffect(() => onLanguageChange(() => setTick((n) => n + 1)), []);

  const setLanguage = useCallback((preference: LanguagePreference) => {
    applyLanguagePreference(preference);
    void setPreference('language', preference);
    // Choosing the language you are already on fires no i18n-js change event, so the row would
    // not re-tick its own selected state. Cheap to bump unconditionally.
    setTick((n) => n + 1);
  }, []);

  return { preference: getLanguagePreference(), locale: getActiveLocale(), setLanguage };
}

/**
 * Bring the translator in line with what is on disk. Call once at startup, after
 * `loadPreferences()` and before the first screen renders.
 */
export function initI18nFromPreferences(): SupportedLocale {
  return applyLanguagePreference(getPreference('language'));
}
