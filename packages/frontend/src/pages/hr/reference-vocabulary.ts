/**
 * How a referee knows the person, as a fixed list rather than free text.
 *
 * Free text here produced nothing usable — every one of the 1,983 imported references has this
 * blank — and free text is also how one relationship becomes "Ex-manager", "ex manager" and
 * "Former Manager". A short list covers what a reference actually is; anything else is a note,
 * not a relationship.
 *
 * Shared between the registration wizard (`RegistrationWizard.tsx`, where a reference is first
 * added) and the vetting tab (`AssayerVettingTab.tsx`, where an existing one is corrected),
 * because both write the same column — `assayer_reference.relationship`, a plain varchar with no
 * FK — and a list kept twice is a list that drifts the moment one screen gets an option the other
 * does not.
 */
export const RELATIONSHIPS = [
  'Former manager', 'Former colleague', 'Current colleague', 'Client contact',
  'Friend', 'Neighbour', 'Relative',
] as const;

export type Relationship = (typeof RELATIONSHIPS)[number];

/**
 * The options to actually render, with room for a value already on the record that predates this
 * list or was typed before either screen had a dropdown. Dropping it instead would either blank
 * the field — reading as "nobody knows how this person knows them", which would be false — or
 * silently overwrite it with the first option the moment the form is saved untouched. Same escape
 * hatch, same reason, as the "(as recorded)" options `AssayerForms.tsx` builds for a manager or a
 * rating that no longer matches its own list.
 */
export function relationshipOptions(current: string | null | undefined): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [
    { value: '', label: 'Not recorded' },
    ...RELATIONSHIPS.map((r) => ({ value: r as string, label: r as string })),
  ];
  if (current && !(RELATIONSHIPS as readonly string[]).includes(current)) {
    options.push({ value: current, label: `${current} — as recorded` });
  }
  return options;
}
