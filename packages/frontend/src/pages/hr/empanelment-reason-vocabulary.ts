/**
 * Why a client standing is what it is, as a pick from what HR actually writes plus a way to say
 * something else.
 *
 * Querying `assayer_client_empanelment.status_reason` turned up a firehose of "Working per roster
 * (Project Name: X)" rows first — those are written by the roster importer, not typed by a
 * person, so they are left out of this list entirely rather than offered back as if somebody had
 * chosen them as a reason. Underneath that noise, what a person actually types clusters into a
 * short set of shapes: a status restated on its own, a compound one, and — for a termination —
 * one of three named ways it actually happened.
 *
 * This field stays optional and free text stays available: "Other" carries anything, the same as
 * the textarea it replaces, and a value already on the record that predates this list is never
 * blanked or forced into the nearest cluster — see `StatusReasonField` in `AssayerVettingTab.tsx`.
 */
export const EMPANELMENT_STATUS_REASONS = [
  'Inactive',
  'Not recommended',
  'Recommended / No documents',
  'Resigned / Not interested',
  'Rejected',
  'Terminated — fake not identified',
  'Terminated — process not followed',
  'Terminated — not doing audit and not given resignation letter',
] as const;

/**
 * Dropdown sentinel meaning "none of these — let me type it". Never sent to the server: the text
 * typed into the box it reveals is what actually gets saved as `statusReason`.
 */
export const OTHER_STATUS_REASON = '__OTHER__';
