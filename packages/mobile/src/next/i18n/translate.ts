/**
 * The translator: key lookup, English fallback, `%{name}` placeholders and plurals.
 *
 * Written here rather than reusing `i18n-js` (which the current app uses) because the rebuilt app
 * needs plural rules for eight languages without leaning on `Intl.PluralRules` — Hermes ships
 * `Intl` only partially on the Android versions this workforce carries — and because the whole
 * thing is thirty lines of pure code that the node test run can exercise directly.
 *
 * Rules:
 *  - English (`en.ts`) is the source of truth; `TranslationKey` is derived from it, so an unknown
 *    key is a compile error.
 *  - Every other catalogue must have every English key (`catalogue.spec.ts` enforces it), but if
 *    one is ever missing at runtime the English sentence is shown — never the key.
 *  - A plural leaf is an object `{ one, other }`; it is chosen by the `count` variable using the
 *    language's CLDR rule.
 */
import { LANGUAGE_FACTS, type AppLanguage } from './languages';

export interface PluralForms {
  readonly one: string;
  readonly other: string;
}

export type CatalogueNode = { readonly [key: string]: string | PluralForms | CatalogueNode };

/** Every dotted leaf path, treating `{ one, other }` as a leaf. */
export type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends PluralForms
      ? K
      : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];

/** Same shape as English, every key required, every leaf a string (or plural pair). */
export type CatalogueOf<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : T[K] extends PluralForms ? PluralForms : CatalogueOf<T[K]>;
};

export type TranslationVars = Record<string, string | number>;

export function isPluralForms(node: unknown): node is PluralForms {
  return (
    typeof node === 'object'
    && node !== null
    && typeof (node as PluralForms).one === 'string'
    && typeof (node as PluralForms).other === 'string'
    && Object.keys(node).length === 2
  );
}

/** Which plural form a whole or decimal count takes in a language. */
export function pluralCategory(language: AppLanguage, count: number): 'one' | 'other' {
  const n = Math.abs(count);
  if (!Number.isFinite(n)) return 'other';
  if (LANGUAGE_FACTS[language].plural === 'zero-or-one') {
    // CLDR: i = 0 or n = 1 — the integer part is 0 (so 0, 0.5), or the value is exactly 1.
    return Math.trunc(n) === 0 || n === 1 ? 'one' : 'other';
  }
  // CLDR (en): i = 1 and v = 0 — exactly 1, no decimals.
  return n === 1 ? 'one' : 'other';
}

export function lookup(catalogue: CatalogueNode, key: string): string | PluralForms | undefined {
  let node: unknown = catalogue;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node === 'string' || isPluralForms(node)) return node;
  return undefined;
}

const PLACEHOLDER = /%\{(\w+)\}/g;

/** The `%{name}` placeholders a sentence uses, sorted and de-duplicated. */
export function placeholdersOf(sentence: string): string[] {
  return Array.from(new Set(Array.from(sentence.matchAll(PLACEHOLDER), (m) => m[1]))).sort();
}

export function interpolate(sentence: string, vars?: TranslationVars): string {
  if (!vars) return sentence;
  return sentence.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * The last resort for a key no catalogue has (a key built at runtime from server data): a
 * readable phrase from its last segment, never `today.actions.FOO`.
 */
export function humaniseKey(key: string): string {
  const last = key.split('.').pop() ?? key;
  const words = last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export function translate(
  catalogues: { active: CatalogueNode; fallback: CatalogueNode },
  language: AppLanguage,
  key: string,
  vars?: TranslationVars,
): string {
  const found = lookup(catalogues.active, key);
  const node = found ?? lookup(catalogues.fallback, key);
  // A fallback plural must use the fallback language's rule, not the active one's.
  const ruleLanguage: AppLanguage = found !== undefined ? language : 'en';
  if (node === undefined) return humaniseKey(key);
  if (typeof node === 'string') return interpolate(node, vars);
  const count = Number(vars?.count);
  const form = Number.isFinite(count) ? node[pluralCategory(ruleLanguage, count)] : node.other;
  return interpolate(form, vars);
}

/** Every leaf path in a catalogue, plural pairs counted once. For the parity test. */
export function leafPaths(node: CatalogueNode, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || isPluralForms(v)) out.push(path);
    else out.push(...leafPaths(v as CatalogueNode, path));
  }
  return out;
}
