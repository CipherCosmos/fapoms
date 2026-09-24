import { EMERGENCY_CONTACT_RELATIONS } from '@fapoms/shared';

/**
 * `emergencyRelation` as a fixed choice, matching the web's `AssayerForms.tsx` dropdown so the
 * same six relationships mean the same thing on both sides of the same record.
 *
 * The six names are `@fapoms/shared`'s `EMERGENCY_CONTACT_RELATIONS` — not a server-enforced enum
 * (`emergencyContactRelation` is a free-text column and the API stores whatever string arrives),
 * but shared anyway, because a UI convenience two clients both offer is exactly how "the same six
 * relationships" quietly stops being true: nothing before this stopped one side from adding a
 * seventh option the other never gained. Re-exported under this file's existing name so
 * `ProfileScreen.tsx` and this file's own spec need no change.
 */
export const EMERGENCY_RELATIONS = EMERGENCY_CONTACT_RELATIONS;

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

/** Read a stored (or in-progress) value into `{ choice, otherText }`. Blank input means nothing
 *  is chosen yet - it is not forced into "Other" with an empty box, which would look like a
 *  required field the assayer had already answered wrong.
 *
 *  The typed text is returned exactly as typed, spaces included. It used to be trimmed here, and
 *  since the box re-reads its text from this on every keystroke, a space typed at the end of a word
 *  vanished before the next letter arrived - "Family friend" could not be typed at all. Trimming
 *  happens once, on save (`emergencyRelationForSave`). */
export function resolveEmergencyRelation(value: string | null | undefined): EmergencyRelationSelection {
  const raw = String(value ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return { choice: '', otherText: '' };
  // "Other" chosen with nothing typed yet - see `composeEmergencyRelation`.
  if (trimmed === EMERGENCY_RELATION_OTHER) return { choice: EMERGENCY_RELATION_OTHER, otherText: '' };
  if ((EMERGENCY_RELATIONS as readonly string[]).includes(trimmed)) {
    return { choice: trimmed, otherText: '' };
  }
  return { choice: EMERGENCY_RELATION_OTHER, otherText: raw.replace(/^\s+/, '') };
}

/** The in-progress value while the form is being edited: the fixed choice as-is, or the typed text
 *  when the choice is "Other".
 *
 *  "Other" with nothing typed yet is held as the word "Other" itself. It used to become '', which
 *  reads back as nothing chosen - so tapping "Other" did nothing at all and the box to type in
 *  never appeared. The word is never saved: `emergencyRelationForSave` turns it back into ''. */
export function composeEmergencyRelation(choice: string, otherText: string): string {
  if (choice !== EMERGENCY_RELATION_OTHER) return choice;
  return otherText.trim() ? otherText : EMERGENCY_RELATION_OTHER;
}

/** What is actually sent: trimmed, and never the bare word "Other", which names nobody - an
 *  "Other" left empty saves as no relation, the same as it did before. */
export function emergencyRelationForSave(value: string | null | undefined): string {
  const trimmed = String(value ?? '').trim();
  return trimmed === EMERGENCY_RELATION_OTHER ? '' : trimmed;
}
