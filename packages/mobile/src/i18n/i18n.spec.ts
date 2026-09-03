/**
 * `expo-localization` is a native module with an ESM build; this suite runs in node, where it
 * cannot be loaded. `device-locale.ts` already guards its require, but mocking the module
 * outright is what lets a test *choose* what the handset reports — which is the whole point of
 * the unsupported-locale case below.
 */
const deviceLocales: Array<{ languageTag: string }> = [];
jest.mock('expo-localization', () => ({ getLocales: () => deviceLocales }));

// eslint-disable-next-line import/first
import { applyLanguagePreference, getActiveLocale, hasOwnTranslation, i18n, t } from './i18n';
// eslint-disable-next-line import/first
import { matchLocaleTag, resolveLocale } from './locale-resolution';
// eslint-disable-next-line import/first
import { en } from './locales/en';
// eslint-disable-next-line import/first
import { hi } from './locales/hi';

function setDeviceLocales(...tags: string[]) {
  deviceLocales.length = 0;
  for (const languageTag of tags) deviceLocales.push({ languageTag });
}

afterEach(() => {
  setDeviceLocales();
  applyLanguagePreference('en');
});

/**
 * The guarantee the whole feature rests on: whatever goes wrong, the assayer sees an English
 * sentence. Not a key, not a blank line, not `[missing "…"]`.
 */
describe('a key with no translation falls back to English', () => {
  it('renders the English sentence for a key Hindi does not translate', () => {
    // `login.tagline` is deliberately absent from `hi` — it is the product's strapline and the
    // same in every locale. It is the honest example of the fallback doing its job.
    expect(hasOwnTranslation('hi', 'login.tagline')).toBe(false);
    applyLanguagePreference('hi');
    expect(t('login.tagline')).toBe(en.login.tagline);
  });

  it('still translates the keys Hindi does define', () => {
    applyLanguagePreference('hi');
    expect(t('login.signIn')).toBe(hi.login?.signIn);
    expect(t('login.signIn')).not.toBe(en.login.signIn);
  });

  it('interpolates into the fallback sentence, not just the translated one', () => {
    applyLanguagePreference('hi');
    // Hindi has this one, and reorders the placeholders. Both values must still land.
    expect(t('registration.progress', { done: 2, required: 5 })).toContain('2');
    expect(t('registration.progress', { done: 2, required: 5 })).toContain('5');
  });

  it('renders a readable phrase, never a raw key, for a key no catalogue has', () => {
    // Reaching past the typed `t()` on purpose: this is the runtime-assembled-key path, the one
    // case `TranslationKey` cannot cover, and the only way the humanising strategy can fire.
    const rendered = i18n.t('profile.address.title');
    expect(rendered).toBe('Title');
    expect(rendered).not.toContain('profile.address.title');
    expect(rendered).not.toContain('missing');
    expect(rendered.trim()).not.toBe('');
  });

  it('never renders an empty string for a missing key', () => {
    for (const key of ['a', 'deeply.nested.unknown_key', 'someCamelCaseKey']) {
      expect(i18n.t(key).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('an unsupported device locale falls back to English', () => {
  it('ignores a language this app ships no catalogue for', () => {
    // Tamil: a real language for this workforce, and one there is no catalogue for yet. Falling
    // back to Hindi because it is "the other Indian language" would be worse than English.
    setDeviceLocales('ta-IN');
    applyLanguagePreference('system');
    expect(getActiveLocale()).toBe('en');
    expect(t('login.signIn')).toBe(en.login.signIn);
  });

  it('falls back when the handset reports nothing at all', () => {
    setDeviceLocales();
    applyLanguagePreference('system');
    expect(getActiveLocale()).toBe('en');
  });

  it('matches a supported language regardless of its region tag', () => {
    setDeviceLocales('hi-IN');
    applyLanguagePreference('system');
    expect(getActiveLocale()).toBe('hi');
  });

  it('walks past unsupported languages to a supported one further down the list', () => {
    setDeviceLocales('ta-IN', 'hi-IN', 'en-IN');
    applyLanguagePreference('system');
    expect(getActiveLocale()).toBe('hi');
  });

  it('lets an explicit choice of English beat a Hindi handset', () => {
    setDeviceLocales('hi-IN');
    applyLanguagePreference('en');
    expect(getActiveLocale()).toBe('en');
  });

  it('tolerates malformed tags without throwing', () => {
    expect(matchLocaleTag('')).toBeNull();
    expect(matchLocaleTag(null)).toBeNull();
    expect(matchLocaleTag(undefined)).toBeNull();
    expect(matchLocaleTag('  HI_in  ')).toBe('hi');
    expect(resolveLocale('system', [null, undefined, '', 'zz'])).toBe('en');
  });
});

/**
 * The Hindi catalogue is allowed to be incomplete, but it is not allowed to be wrong. A
 * translated sentence that drops a placeholder renders "%{count} papers" as " papers" — a
 * silent data loss that no type can catch and nobody reviewing Devanagari prose would notice.
 */
describe('the Hindi draft is structurally sound', () => {
  const placeholders = (s: string) => (s.match(/%\{(\w+)\}/g) ?? []).sort();

  function walk(source: Record<string, unknown>, draft: Record<string, unknown>, path: string[]) {
    for (const [key, value] of Object.entries(draft)) {
      const original = source[key];
      const here = [...path, key];
      if (typeof value === 'string') {
        expect(typeof original).toBe('string');
        expect({ key: here.join('.'), placeholders: placeholders(value) }).toEqual({
          key: here.join('.'),
          placeholders: placeholders(original as string),
        });
      } else if (value && typeof value === 'object') {
        walk(original as Record<string, unknown>, value as Record<string, unknown>, here);
      }
    }
  }

  it('carries the same placeholders as the English it replaces', () => {
    walk(en as unknown as Record<string, unknown>, hi as Record<string, unknown>, []);
  });

  it('keeps the terms that must not be translated in English', () => {
    // The compliance rule, asserted rather than left to a code review: these are legal,
    // financial or printed-on-the-document terms, and a coined Hindi equivalent on a screen
    // that bears on pay or eligibility is worse than the English word.
    expect(hi.login?.codeLabel).toContain('ASSAYER CODE');
    expect(hi.login?.badCredentials).toContain('ASSAYER CODE');
    expect(hi.registration?.hints?.NDA).toContain('NDA');
  });
});
