/**
 * The language choice survives a restart.
 *
 * Worth its own suite because this app has been bitten by exactly this before: the theme
 * preference and every auth token were written to `globalThis.localStorage`, which React Native
 * does not have, so on a handset every one of them silently did nothing and reset on each
 * launch. A language setting that forgets itself is that same bug wearing a different hat, and
 * it is invisible in a simulator where the app is rarely killed.
 *
 * The device store is faked rather than exercised: `token-store` is the module that owns the
 * real file, it is covered where it lives, and loading it here would pull in
 * `expo-file-system` and `expo-secure-store`, which this package's node-only jest run cannot
 * load. What is under test is the round trip through `preferences.ts` and into the translator.
 */
const disk = new Map<string, string>();

jest.mock('../services/token-store', () => ({
  readPreference: jest.fn(async (key: string) => disk.get(key) ?? null),
  writePreference: jest.fn(async (key: string, value: string) => {
    disk.set(key, value);
  }),
}));

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'hi-IN' }] }));

// eslint-disable-next-line import/first
import { DEFAULT_PREFERENCES, getPreference, loadPreferences, setPreference } from '../services/preferences';
// eslint-disable-next-line import/first
import { applyLanguagePreference, getActiveLocale, getLanguagePreference } from './i18n';
// eslint-disable-next-line import/first
import { initI18nFromPreferences } from './useI18n';

const STORAGE_KEY = 'fapoms_pref_language';

beforeEach(async () => {
  disk.clear();
  await loadPreferences();
  applyLanguagePreference('en');
});

describe('the language preference persists', () => {
  it('defaults to following the handset when nothing has been chosen', async () => {
    expect(DEFAULT_PREFERENCES.language).toBe('system');
    expect(getPreference('language')).toBe('system');
  });

  it('writes the choice to the device store', async () => {
    await setPreference('language', 'hi');
    expect(disk.get(STORAGE_KEY)).toBe('hi');
  });

  it('reads the choice back on the next launch', async () => {
    await setPreference('language', 'hi');

    // A cold start: the in-memory cache is rebuilt from disk, exactly as App.tsx does before
    // the first screen renders.
    await loadPreferences();

    expect(getPreference('language')).toBe('hi');
    expect(initI18nFromPreferences()).toBe('hi');
    expect(getActiveLocale()).toBe('hi');
    expect(getLanguagePreference()).toBe('hi');
  });

  it('keeps an explicit English choice distinct from following the handset', async () => {
    // The handset is mocked as Hindi throughout. Someone who deliberately chose English must
    // stay on English across restarts — the bug this guards is treating `en` as "no choice".
    await setPreference('language', 'en');
    await loadPreferences();

    expect(getPreference('language')).toBe('en');
    expect(initI18nFromPreferences()).toBe('en');
  });

  it('follows the handset again once the choice is set back to the phone default', async () => {
    await setPreference('language', 'en');
    await loadPreferences();
    await setPreference('language', 'system');
    await loadPreferences();

    expect(initI18nFromPreferences()).toBe('hi');
  });

  it('falls back to the default when the stored value is not a language this build ships', async () => {
    // A preferences file written by a later build that shipped Tamil, opened by this one.
    disk.set(STORAGE_KEY, 'ta');
    await loadPreferences();

    expect(getPreference('language')).toBe('system');
  });

  it('keeps the value applied for the session when the write fails', async () => {
    const { writePreference } = jest.requireMock('../services/token-store');
    (writePreference as jest.Mock).mockRejectedValueOnce(new Error('disk full'));

    await setPreference('language', 'hi');

    // The switch the assayer just flipped stays flipped. Reverting it on a failed write would
    // make the tap look like it did nothing.
    expect(getPreference('language')).toBe('hi');
  });
});
