/**
 * `emergencyRelation` as a fixed choice, matching the web's `EMERGENCY_CONTACT_RELATIONS`
 * (`packages/frontend/src/pages/hr/AssayerForms.tsx`) so the same six relationships mean the
 * same thing on both sides of the same record.
 *
 * There is no shared-package home for this list (unlike regions): it is a plain 7-value UI
 * convenience, not a server-enforced enum - `emergencyContactRelation` is a free-text column and
 * the API stores whatever string arrives. Hardcoded here for that reason, matching the web's own
 * hardcoded copy rather than inventing a shared export for a list nothing server-side reads.
 */
export const EMERGENCY_RELATIONS = ['Spouse', 'Parent', 'Sibling', 'Child', 'Friend', 'Colleague'] as const;

export const EMERGENCY_RELATION_OTHER = 'Other';

export interface EmergencyRelationSelection {
  /** One of `EMERGENCY_RELATIONS`, `EMERGENCY_RELATION_OTHER`, or `''` when nothing is on file. */
  choice: string;
  /**
   * The text to show in the "Other" box. Holds the stored value whenever it does not match one
   * of the six fixed relations - including a value recorded before this screen offered a picker
   * at all - so an existing "Cousin" or "Guardian" is preserved and editable rather than being
   * blanked the moment this UI replaces the old free-text box.
   */
  otherText: string;
}

/** Read a stored value into `{ choice, otherText }`. Blank input means nothing is chosen yet -
 *  it is not forced into "Other" with an empty box, which would look like a required field the
 *  assayer had already answered wrong. */
export function resolveEmergencyRelation(value: string | null | undefined): EmergencyRelationSelection {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return { choice: '', otherText: '' };
  if ((EMERGENCY_RELATIONS as readonly string[]).includes(trimmed)) {
    return { choice: trimmed, otherText: '' };
  }
  return { choice: EMERGENCY_RELATION_OTHER, otherText: trimmed };
}

/** The value actually saved: the fixed choice as-is, or the typed text when the choice is
 *  "Other" - never the literal word "Other" itself, since that would replace whatever the
 *  assayer typed with a label that names nothing. */
export function composeEmergencyRelation(choice: string, otherText: string): string {
  return choice === EMERGENCY_RELATION_OTHER ? otherText.trim() : choice;
}
