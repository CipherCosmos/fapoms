import * as fs from 'fs';
import * as path from 'path';
import { CATALOGUES } from './catalogues';
import { APP_LANGUAGES, LANGUAGE_FACTS } from './languages';
import { en } from './locales/en';
import { isPluralForms, leafPaths, lookup, placeholdersOf, type CatalogueNode } from './translate';

/**
 * Every language says everything English says, with the same blanks to fill.
 *
 * A missing key would silently render English in the middle of a Tamil screen; a missing
 * placeholder would print a sentence with a hole in it ("You have reached") or, worse, one with
 * the raw marker left in. Both are caught here rather than on a phone.
 */
const english = en as unknown as CatalogueNode;
const englishKeys = leafPaths(english).sort();

function formsOf(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (isPluralForms(node)) return [node.one, node.other];
  return [];
}

describe.each(APP_LANGUAGES.filter((l) => l !== 'en'))('catalogue %s', (language) => {
  const catalogue = CATALOGUES[language] as unknown as CatalogueNode;

  it('has exactly the English keys — none missing, none extra', () => {
    expect(leafPaths(catalogue).sort()).toEqual(englishKeys);
  });

  it('uses the same placeholders as English in every sentence', () => {
    const mismatches: string[] = [];
    for (const key of englishKeys) {
      const want = formsOf(lookup(english, key)).map(placeholdersOf);
      const got = formsOf(lookup(catalogue, key)).map(placeholdersOf);
      // Each plural form must carry the same set as its English counterpart.
      if (JSON.stringify(want) !== JSON.stringify(got)) mismatches.push(`${key}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('keeps plural leaves plural', () => {
    for (const key of englishKeys) {
      expect(isPluralForms(lookup(catalogue, key))).toBe(isPluralForms(lookup(english, key)));
    }
  });

  it('has no empty sentence', () => {
    const empty = englishKeys.filter((k) => formsOf(lookup(catalogue, k)).some((s) => s.trim() === ''));
    expect(empty).toEqual([]);
  });

  it('is marked as a draft that needs native review', () => {
    const source = fs.readFileSync(path.join(__dirname, 'locales', `${language}.ts`), 'utf8');
    expect(source.slice(0, 200)).toContain('DRAFT — needs native review');
  });

  it('is written in its own script, not left in English', () => {
    // A catalogue copied from English and never translated would pass the parity checks above.
    const script = LANGUAGE_FACTS[language].script;
    const ranges: Record<string, RegExp> = {
      devanagari: /[ऀ-ॿ]/,
      tamil: /[஀-௿]/,
      telugu: /[ఀ-౿]/,
      kannada: /[ಀ-೿]/,
      bengali: /[ঀ-৿]/,
      gujarati: /[઀-૿]/,
    };
    const translated = englishKeys.filter((k) => formsOf(lookup(catalogue, k)).some((s) => ranges[script].test(s)));
    // Pure-placeholder sentences ("%{bank} · %{branch}", "%{day} %{month}") are legitimately identical.
    expect(translated.length / englishKeys.length).toBeGreaterThan(0.85);
  });
});

describe('English catalogue', () => {
  it('has no empty sentence', () => {
    expect(englishKeys.filter((k) => formsOf(lookup(english, k)).some((s) => s.trim() === ''))).toEqual([]);
  });

  it('carries %{count} in both forms of every plural', () => {
    for (const key of englishKeys) {
      const node = lookup(english, key);
      if (isPluralForms(node)) {
        expect(placeholdersOf(node.one)).toContain('count');
        expect(placeholdersOf(node.other)).toContain('count');
      }
    }
  });

  it('is not marked as a draft', () => {
    const source = fs.readFileSync(path.join(__dirname, 'locales', 'en.ts'), 'utf8');
    expect(source).not.toContain('DRAFT');
  });
});
