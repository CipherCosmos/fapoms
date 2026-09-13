/**
 * Turns `GET /assayers/workforce-attribute/vocabulary`'s raw, per-category rows into a clean,
 * de-duplicated, sorted list of names — the one piece of that endpoint's shaping web and mobile
 * each hand-rolled independently (`useWorkforceVocabulary.ts`, `services/workforce-vocabulary.ts`).
 *
 * These values feed the matching engine by exact string comparison. A typo is never rejected —
 * "Gold Valuar" simply becomes a requirement nobody on the roster holds, so a branch quietly
 * matches nobody and the coordinator sees an empty candidate list with no hint that a
 * misspelling caused it — which is why de-duplication and a stable sort matter here at all: the
 * picker a form offers is the only defence against retyping a near-miss of an existing value.
 *
 * `unknown` rather than a typed array: this is a network response, and the two hand-rolled
 * versions disagreed about how defensively to treat it (one trusted `{ name: string }[]`
 * outright, the other guarded against a non-array, a non-object entry, and a whitespace-only
 * name) — the more defensive of the two is the one real HTTP responses actually need.
 */
export function cleanVocabularyList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const names = list
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}
