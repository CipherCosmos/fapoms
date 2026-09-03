jest.mock('expo-localization', () => ({ getLocales: () => [] }));

// eslint-disable-next-line import/first
import { applyLanguagePreference, i18n } from './i18n';
// eslint-disable-next-line import/first
import { en } from './locales/en';

/**
 * Renders the entire catalogue, in every locale, and looks at what comes out.
 *
 * The three fallback suites next to this one check the *rules*. This one checks the *content*,
 * and it is the cheapest guard there is against the two ways a catalogue rots in practice: a key
 * added to `en.ts` as an empty string, and a translated sentence whose placeholder was mistyped
 * (`%{cout}`) — which renders as the literal `%{cout}` on screen and is invisible to anyone
 * reviewing Devanagari prose they cannot machine-check.
 *
 * Every possible interpolation variable is supplied at once. That is deliberate: i18n-js ignores
 * variables a string does not use, so one bag covers every key without this test having to know
 * which sentence takes which name, and a placeholder nobody supplies fails loudly here.
 */
const EVERY_VARIABLE = {
  amount: '₹1', branch: 'B', category: 'c', code: 'AS0001', coords: '1, 2', count: 3, date: 'D',
  distance: '1 km', document: 'd', done: 1, field: 'f', fields: 'a, b', file: 'f.pdf', hours: 1,
  instruction: 'i', km: 1, kmh: 40, languages: 2, limit: '₹9', max: 3, minutes: 5, mode: 'bus',
  name: 'X', number: 'L1', page: 2, pages: '2, 3', percent: 10, progress: 'p', rate: 50,
  reason: 'r', required: 2, round: 1, since: '', skills: 1, state: 'S', time: 'T', title: 't',
  total: 4, uploaded: 2, wait: 'w', what: 'w', who: 'W',
};

function leafKeys(node: unknown, path: string[] = []): string[] {
  if (typeof node === 'string') return [path.join('.')];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leafKeys(v, [...path, k]));
}

describe('the catalogue as a whole', () => {
  const keys = leafKeys(en);

  afterEach(() => applyLanguagePreference('en'));

  it.each(['en', 'hi'] as const)('renders every key in %s', (locale) => {
    applyLanguagePreference(locale);
    for (const key of keys) {
      const rendered = i18n.t(key, EVERY_VARIABLE);
      expect({ key, ok: typeof rendered === 'string' && rendered.trim() !== '' }).toEqual({ key, ok: true });
      // No debug output and no unsubstituted placeholder ever reaches a screen.
      expect({ key, rendered }).toEqual({ key, rendered: expect.not.stringMatching(/\[missing|%\{/) });
    }
  });
});
