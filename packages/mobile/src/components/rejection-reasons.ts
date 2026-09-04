/**
 * The reasons offered when an assayer declines an offered assignment.
 *
 * Built for THIS situation rather than reused from `ReportIssueModal`'s
 * `ASSIGNMENT_ISSUE_CATEGORIES` (`CANNOT_ATTEND`, `BRANCH_INACCESSIBLE`, `NEEDS_CLARIFICATION`,
 * `SAFETY_CONCERN`, `OTHER`) - that list is for a problem raised on a job already accepted, and a
 * decline happens before the work starts, for different reasons (distance, fee, schedule, the
 * branch itself). Only the shape is reused: fixed chips plus a free-text detail box, capped the
 * same way (1000 chars), so an assayer typing something none of the chips cover still has
 * somewhere to put it.
 */
export const REJECTION_REASON_CATEGORIES = [
  'TOO_FAR',
  'FEE_TOO_LOW',
  'SCHEDULE_CONFLICT',
  'UNCOMFORTABLE_BRANCH',
  'OTHER',
] as const;

export type RejectionReasonCategory = (typeof REJECTION_REASON_CATEGORIES)[number];

/**
 * The text actually sent to the server as the decline reason for a preset pick.
 *
 * Not translated: the replanning desk reads this as plain English regardless of the assayer's
 * device language, the same as every other free-text reason this screen has ever sent (see
 * `assignment.controller.ts`'s own comment on why an empty reason is refused - the desk needs to
 * know why before re-offering the same job).
 */
export const REJECTION_REASON_LABELS: Record<Exclude<RejectionReasonCategory, 'OTHER'>, string> = {
  TOO_FAR: 'Too far to travel',
  FEE_TOO_LOW: 'Fee is too low',
  SCHEDULE_CONFLICT: 'Schedule conflict',
  UNCOMFORTABLE_BRANCH: 'Not comfortable with this branch',
};

/**
 * The reason text this modal sends. A preset category becomes its label, with anything typed in
 * the detail box appended; "Other" has no label of its own, so its whole reason IS the typed
 * detail - matching `composeEmergencyRelation`'s rule that "Other" never contributes a word that
 * names nothing.
 */
export function composeRejectionReason(category: RejectionReasonCategory | null, detail: string): string {
  const trimmedDetail = detail.trim();
  if (!category || category === 'OTHER') return trimmedDetail;
  const label = REJECTION_REASON_LABELS[category];
  return trimmedDetail ? `${label} - ${trimmedDetail}` : label;
}

/**
 * Whether there is enough here to submit - simply whether `composeRejectionReason` would produce
 * anything. A preset category is self-explanatory on its own. Typing in the detail box with no
 * category picked is also enough: that is the plain free-text decline this modal always
 * supported, still available for a reason none of the chips cover, without forcing "Other" to be
 * tapped first. Only "Other" by itself, or nothing at all, is refused - an empty reason is
 * exactly what the server-side check exists to catch, only discovered one round trip later.
 */
export function canSubmitRejectionReason(category: RejectionReasonCategory | null, detail: string): boolean {
  return composeRejectionReason(category, detail).length > 0;
}
