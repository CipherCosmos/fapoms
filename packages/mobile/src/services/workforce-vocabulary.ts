/**
 * Shapes `GET /assayers/workforce-attribute/vocabulary`'s raw response into the two lists
 * `ProfileScreen` offers as autocomplete suggestions.
 *
 * Split out of `api.service.ts` on purpose, even though it is only ever called from there: that
 * file imports `react-native` at module scope, and this project's plain-node jest config
 * (`jest.config.js`) has no transform for React Native's Flow-typed sources, so nothing in
 * `api.service.ts` can be `import`ed inside a test at all - the import throws a syntax error
 * before a single assertion runs. Pulling the one part of `getWorkforceAttributeVocabulary` that
 * is actually worth unit testing - turning `{ SKILL: [...], LANGUAGE: [...] }` into clean,
 * de-duplicated, sorted name lists - into a file with no React Native import keeps it testable.
 *
 * The endpoint itself is `@Roles(ADMIN, OPERATIONS)`-gated on the backend
 * (`assayer.controller.ts`), same as the web's equivalent hook already documents
 * (`useWorkforceVocabulary.ts`: "the HR-scoped endpoint is not readable by this role"). An
 * assayer calling it from their own profile screen gets a 403 today, which `getWorkforceAttributeVocabulary`
 * in `api.service.ts` turns into an empty result rather than an error - see that method. An empty
 * list is a real, expected state here, not a failure: the chip picker still lets a genuinely new
 * skill or language be typed and added.
 */

interface RawVocabularyEntry {
  name?: unknown;
}

export interface WorkforceVocabulary {
  skills: string[];
  languages: string[];
}

function cleanNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const names = (list as RawVocabularyEntry[])
    .map((entry) => (entry && typeof entry === 'object' ? entry.name : undefined))
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

/** `raw` is the vocabulary endpoint's `data` object: `{ SKILL?, LANGUAGE?, CERTIFICATION?, SPECIALIZATION? }`. */
export function cleanWorkforceVocabulary(raw: unknown): WorkforceVocabulary {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { skills: cleanNames(data.SKILL), languages: cleanNames(data.LANGUAGE) };
}
