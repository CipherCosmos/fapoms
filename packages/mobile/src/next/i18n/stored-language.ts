import { readPreference } from '../../services/token-store';
import { LANGUAGE_PREFERENCE_KEY, resolveStartLanguage, type AppLanguage } from './languages';

/** The chosen language, for code with no React tree (the background runtime). English if none. */
export async function readStoredLanguage(): Promise<AppLanguage> {
  try {
    return resolveStartLanguage(await readPreference(LANGUAGE_PREFERENCE_KEY)).language;
  } catch {
    return resolveStartLanguage(null).language;
  }
}
