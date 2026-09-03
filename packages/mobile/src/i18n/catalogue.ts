/**
 * The shape of a translation catalogue, and the types that make English the compile-time
 * source of truth.
 *
 * The brief for this app is that a missing key must never reach a field assayer's screen as
 * `profile.address.title` or as a blank line. There are two independent guards for that, and
 * this file is the first: `TranslationKey` is derived from the English catalogue itself, so a
 * key that does not exist is a type error at `t('…')` rather than a runtime surprise on a
 * screen somebody is stuck on. The second guard — the humanising fallback in `i18n.ts` — only
 * ever fires for keys assembled at runtime from server data, which is the one path types
 * cannot cover.
 *
 * English is the only locale required to be complete. Every other locale is a
 * `PartialCatalogue`: it may translate as much or as little as has actually been reviewed, and
 * anything it omits falls through to English. That is a deliberate stance rather than a
 * shortcut — a half-finished locale that renders English for the sentences nobody has checked
 * yet is safe to ship, whereas one padded out with unreviewed machine output on a
 * compliance-bearing screen is not.
 */

/** A catalogue is a tree of strings; nesting exists only to group keys by screen. */
export type CatalogueNode = { readonly [key: string]: string | CatalogueNode };

/**
 * Every dotted leaf path through a catalogue, as a string-literal union.
 *
 * Depth is bounded by the catalogue's own nesting (three levels at most here), so the
 * recursion terminates without a depth counter.
 */
export type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];

/**
 * A locale that may translate any subset of English.
 *
 * Optional at every level, but not loose: the keys are still checked, so a typo in a
 * translated key is a compile error instead of a silent no-op that quietly renders English
 * forever and looks, to a reviewer, exactly like a translation that is working.
 */
export type PartialCatalogue<T> = {
  [K in keyof T]?: T[K] extends string ? string : PartialCatalogue<T[K]>;
};
