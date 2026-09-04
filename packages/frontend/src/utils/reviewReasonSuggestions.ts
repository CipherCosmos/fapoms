/**
 * Suggestion lists for the free-text reason/note boxes in the data-entry review flow.
 *
 * These back a `<datalist>` on an otherwise ordinary text control — never a `<select>` — so they
 * can only ever suggest, never constrain: typing anything not on the list, or nothing at all,
 * keeps working exactly as it did before this file existed.
 *
 * `CORRECTION_NOTE_SUGGESTIONS` is shared between CaseWorkspace's case-level correction note and
 * ReviewsQueue's bulk "send back for rework" note — they are the same reviewer writing the same
 * kind of reason, just from two different screens, so one list keeps them from drifting apart.
 */
export const CORRECTION_NOTE_SUGGESTIONS = [
  'Scan is illegible',
  'Wrong field extracted',
  'Signature does not match',
  'Stamp missing or unclear',
  'Wrong branch/SOL code',
  'Value does not match the document',
] as const;

/** ThreadPanel's region-flag note — what's wrong with the marked area on the PDF. */
export const REGION_FLAG_SUGGESTIONS = [
  'Illegible',
  'Cut off',
  'Wrong page',
  "Value doesn't match",
  'Missing signature or stamp',
] as const;
