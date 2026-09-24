import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { readPreference, writePreference } from '../../services/token-store';
import { loadScripts } from '../theme/fonts';
import { translatorFor, type T } from './catalogues';
import {
  LANGUAGE_PREFERENCE_KEY,
  resolveStartLanguage,
  scriptOf,
  type AppLanguage,
} from './languages';

/**
 * The language the app is in, for every screen below it.
 *
 * A provider (not a module-level singleton) because the language screen must re-render the whole
 * tree on the frame a language is tapped, and the fonts for that script must load with it.
 */
interface I18nValue {
  language: AppLanguage;
  /** False until the stored choice has been read; screens should not render text before then. */
  ready: boolean;
  /** True on first launch (no stored choice): show the language screen. */
  needsChoice: boolean;
  t: T;
  /** Switch now; persisted in the background. */
  setLanguage: (language: AppLanguage) => void;
  /** Mark the first-launch question answered (stores the current language). */
  confirmLanguage: () => Promise<void>;
}

const I18nContext = createContext<I18nValue | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<AppLanguage>('en');
  const [ready, setReady] = useState(false);
  const [needsChoice, setNeedsChoice] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let stored: string | null = null;
      try {
        stored = await readPreference(LANGUAGE_PREFERENCE_KEY);
      } catch {
        stored = null;
      }
      const start = resolveStartLanguage(stored);
      // Latin first: numbers, codes and English always need it. The chosen script alongside.
      await loadScripts(['latin', scriptOf(start.language)]);
      if (cancelled) return;
      setLanguageState(start.language);
      setNeedsChoice(start.needsChoice);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLanguage = useCallback((next: AppLanguage) => {
    setLanguageState(next);
    void loadScripts([scriptOf(next)]);
    // Only persisted once the first-launch question has been answered — until then the choice is
    // still being made on the language screen.
    if (!needsChoice) void writePreference(LANGUAGE_PREFERENCE_KEY, next);
  }, [needsChoice]);

  const confirmLanguage = useCallback(async () => {
    await writePreference(LANGUAGE_PREFERENCE_KEY, language);
    setNeedsChoice(false);
  }, [language]);

  const t = useMemo(() => translatorFor(language), [language]);

  const value = useMemo<I18nValue>(
    () => ({ language, ready, needsChoice, t, setLanguage, confirmLanguage }),
    [language, ready, needsChoice, t, setLanguage, confirmLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}

/** The translator. Changes identity when the language changes, so memoised rows re-render. */
export function useT(): T {
  return useI18n().t;
}
