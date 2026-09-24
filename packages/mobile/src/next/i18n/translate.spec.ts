import { translatorFor } from './catalogues';
import { resolveStartLanguage, isAppLanguage, ALL_SCRIPTS, APP_LANGUAGES } from './languages';
import { humaniseKey, interpolate, pluralCategory, translate, type CatalogueNode } from './translate';

describe('pluralCategory', () => {
  it('treats only 1 as singular in English, Marathi, Tamil and Telugu', () => {
    for (const lang of ['en', 'mr', 'ta', 'te'] as const) {
      expect(pluralCategory(lang, 1)).toBe('one');
      expect(pluralCategory(lang, 0)).toBe('other');
      expect(pluralCategory(lang, 2)).toBe('other');
      expect(pluralCategory(lang, 1.5)).toBe('other');
    }
  });

  it('treats 0 and 1 as singular in Hindi, Kannada, Bengali and Gujarati (CLDR i = 0 or n = 1)', () => {
    for (const lang of ['hi', 'kn', 'bn', 'gu'] as const) {
      expect(pluralCategory(lang, 0)).toBe('one');
      expect(pluralCategory(lang, 1)).toBe('one');
      expect(pluralCategory(lang, 0.5)).toBe('one');
      expect(pluralCategory(lang, 2)).toBe('other');
      expect(pluralCategory(lang, 1.5)).toBe('other');
    }
  });

  it('never throws on nonsense', () => {
    expect(pluralCategory('en', Number.NaN)).toBe('other');
    expect(pluralCategory('hi', Number.POSITIVE_INFINITY)).toBe('other');
    expect(pluralCategory('en', -1)).toBe('one');
  });
});

describe('translate', () => {
  const active: CatalogueNode = { a: { hello: 'नमस्ते %{name}', n: { one: '%{count} काम', other: '%{count} काम (बहु)' } } };
  const fallback: CatalogueNode = {
    a: { hello: 'Hello %{name}', n: { one: '%{count} job', other: '%{count} jobs' }, onlyEn: 'Only English %{x}' },
  };

  it('uses the active language when it has the key', () => {
    expect(translate({ active, fallback }, 'hi', 'a.hello', { name: 'Asha' })).toBe('नमस्ते Asha');
  });

  it('falls back to English for a missing key, never to the key itself', () => {
    expect(translate({ active, fallback }, 'hi', 'a.onlyEn', { x: 1 })).toBe('Only English 1');
  });

  it('humanises a key nobody has', () => {
    expect(translate({ active, fallback }, 'hi', 'today.actions.SOMETHING_NEW')).toBe('Something new');
    expect(humaniseKey('a.b.checkInOpens')).toBe('Check in opens');
  });

  it('picks the plural form by the active language rule', () => {
    expect(translate({ active, fallback }, 'hi', 'a.n', { count: 0 })).toBe('0 काम');
    expect(translate({ active, fallback }, 'hi', 'a.n', { count: 3 })).toBe('3 काम (बहु)');
  });

  it('uses the English rule when the plural itself fell back to English', () => {
    expect(translate({ active: {}, fallback }, 'hi', 'a.n', { count: 0 })).toBe('0 jobs');
  });

  it('uses "other" when no count is given', () => {
    expect(translate({ active, fallback }, 'en', 'a.n')).toBe('%{count} काम (बहु)');
  });

  it('leaves an unfilled placeholder visible rather than printing "undefined"', () => {
    expect(interpolate('Hi %{name}', {})).toBe('Hi %{name}');
    expect(interpolate('Hi %{name}', { name: 0 })).toBe('Hi 0');
  });
});

describe('translatorFor (real catalogues)', () => {
  it('translates a plural in English and Hindi', () => {
    expect(translatorFor('en')('today.jobCount', { count: 1 })).toBe('1 job');
    expect(translatorFor('en')('today.jobCount', { count: 4 })).toBe('4 jobs');
    expect(translatorFor('hi')('today.jobCount', { count: 4 })).toBe('4 काम');
  });

  it('turns a server action code into a sentence even if a new one appears', () => {
    const t = translatorFor('en');
    expect(t('today.actions.CHECK_IN')).toBe('I have reached');
    expect(t('today.actions.BRAND_NEW_ACTION')).toBe('Brand new action');
  });
});

describe('language resolution', () => {
  it('uses a stored, known choice', () => {
    expect(resolveStartLanguage('ta')).toEqual({ language: 'ta', needsChoice: false });
  });

  it('asks on first launch, with English preselected', () => {
    expect(resolveStartLanguage(null)).toEqual({ language: 'en', needsChoice: true });
    expect(resolveStartLanguage('')).toEqual({ language: 'en', needsChoice: true });
  });

  it('asks again when the stored value is one this build does not know', () => {
    expect(resolveStartLanguage('fr')).toEqual({ language: 'en', needsChoice: true });
    expect(resolveStartLanguage('system')).toEqual({ language: 'en', needsChoice: true });
  });

  it('knows exactly the eight languages the owner asked for', () => {
    expect([...APP_LANGUAGES].sort()).toEqual(['bn', 'en', 'gu', 'hi', 'kn', 'mr', 'ta', 'te']);
    expect(isAppLanguage('hi')).toBe(true);
    expect(isAppLanguage('HI')).toBe(false);
    expect([...ALL_SCRIPTS].sort()).toEqual(['bengali', 'devanagari', 'gujarati', 'kannada', 'latin', 'tamil', 'telugu']);
  });
});
