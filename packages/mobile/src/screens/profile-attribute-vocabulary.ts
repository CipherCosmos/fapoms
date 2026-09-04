/**
 * `skills` and `languages` as this screen edits them: a comma-joined string, same convention the
 * rest of `ProfileDataState` already uses (see `useAssayerProfile.ts`'s own `joinArr`/`toArray`
 * pair), plus the chip-picker behaviour on top of it - parsing it into chips, adding one from the
 * roster's vocabulary or freshly typed, and offering suggestions that do not repeat what is
 * already chosen.
 *
 * Kept as a comma string rather than switching `ProfileDataState` to `string[]` so the save path
 * (`api.service.ts`'s `toArray`), the record-completeness count and the diffing in
 * `useAssayerProfile.ts` do not need to change to gain a picker UI.
 */

export function parseAttributeList(value: string | null | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function composeAttributeList(items: string[]): string {
  return items.join(', ');
}

/**
 * Add one value, whether picked from the vocabulary or freshly typed.
 *
 * Compared case-insensitively so typing "hindi" when "Hindi" is already a chip does not add a
 * second, functionally identical entry that only differs in casing - the matching engine on the
 * other end compares these by exact string, so a near-duplicate would look like two different
 * languages. Blank input is a no-op rather than an error: the "add" affordance is reachable with
 * nothing typed, and it should do nothing, not append an empty chip.
 */
export function addAttributeValue(value: string | null | undefined, newItem: string): string {
  const items = parseAttributeList(value);
  const trimmed = newItem.trim();
  if (!trimmed) return composeAttributeList(items);
  const alreadyPresent = items.some((i) => i.toLowerCase() === trimmed.toLowerCase());
  return composeAttributeList(alreadyPresent ? items : [...items, trimmed]);
}

export function removeAttributeValue(value: string | null | undefined, item: string): string {
  return composeAttributeList(parseAttributeList(value).filter((i) => i !== item));
}

/**
 * Vocabulary entries worth showing as suggestions: not already chosen, matching what has been
 * typed so far, alphabetical so the list does not reorder itself as the roster's usage counts
 * change under it.
 */
export function attributeSuggestions(vocabulary: string[], selected: string[], query: string): string[] {
  const selectedLower = new Set(selected.map((s) => s.toLowerCase()));
  const q = query.trim().toLowerCase();
  return vocabulary
    .filter((v) => !selectedLower.has(v.toLowerCase()))
    .filter((v) => !q || v.toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b));
}
