/**
 * FAPOMS — what "assign anyway" is actually allowed to waive.
 *
 * ## The problem this exists to fix
 *
 * The planning screen offers an **Assign anyway** button beside every excluded appraiser, invites
 * the operator to type a considered justification, and sends it as `overrideReason`. Until this
 * list existed, exactly **one** of the seven blocking checks on the write path read that field —
 * the client empanelment one. An operator who overrode a *skills* exclusion, or a *distance*
 * exclusion, or a *rotation* one, typed their reason, pressed Confirm and got a flat refusal from
 * a rule that had never looked at what they wrote.
 *
 * Worse, the refusal was unpredictable from the screen: the panel's own suggested wording for a
 * skills exclusion was *"Skill or certification requirement waived by ops"* — a sentence the
 * product offered to write on the operator's behalf for an action the server would always refuse.
 *
 * ## Why a list rather than a flag per call site
 *
 * Three places have to agree about this and cannot be allowed to drift: the recommendation engine
 * decides whether to offer the button, the assignment service decides whether to honour it, and
 * the panel explains to a person why a button is missing. Each deciding for itself is how the
 * button came to be offered for rules nothing would waive.
 *
 * ## The split, and the reasoning behind it
 *
 * Overridable rules are **judgement calls an operator is entitled to make** and be accountable
 * for. Non-overridable ones are of two kinds: things that are physically impossible (a person
 * cannot audit two branches at once), and one integrity rule that is deliberately not an
 * operator's to waive — the conflict-of-interest distance floor, which exists precisely to stop
 * somebody valuing gold at a branch beside their own home, and which a platform administrator
 * lifts for a client in Settings if it is genuinely wrong.
 */

/** Every rule that can stop an assignment being created. */
export enum AssignmentRule {
  /** No Active or Recommended empanelment standing with this client. */
  CLIENT_ELIGIBILITY = 'CLIENT_ELIGIBILITY',
  /** Missing a skill or certification the project requires. */
  SKILLS_AND_CERTIFICATIONS = 'SKILLS_AND_CERTIFICATIONS',
  /** Further from the branch than the client's service limit. */
  DISTANCE_CEILING = 'DISTANCE_CEILING',
  /** Closer to the branch than the client's independence floor — conflict of interest. */
  DISTANCE_FLOOR = 'DISTANCE_FLOOR',
  /** Audited this branch most recently; the rotation rule wants somebody else. */
  REPEAT_AUDITOR_ROTATION = 'REPEAT_AUDITOR_ROTATION',
  /** On leave, or the date is a holiday or outside the project timeline. */
  DATE_AVAILABILITY = 'DATE_AVAILABILITY',
  /** Already assigned somewhere else that day. */
  ASSAYER_DOUBLE_BOOKED = 'ASSAYER_DOUBLE_BOOKED',
  /** This branch already has a live assignment. */
  BRANCH_ALREADY_ASSIGNED = 'BRANCH_ALREADY_ASSIGNED',
  /** The branch is cancelled or completed — there is no work to give. */
  BRANCH_NOT_OPEN = 'BRANCH_NOT_OPEN',
  /** The appraiser's profile is deleted, or their onboarding is unfinished. */
  PROFILE_NOT_DEPLOYABLE = 'PROFILE_NOT_DEPLOYABLE',
}

/**
 * The rules a stated reason waives.
 *
 * Each is a decision an operator can legitimately make and be held to afterwards: this person is
 * not on the bank's panel but the desk has cleared it; the certification lapsed last week and the
 * renewal is in hand; they are further out than usual because nobody nearer is free; they audited
 * this branch last time and the rotation is worth breaking for continuity; they are on leave and
 * have agreed to come in.
 *
 * Every one is audited against the assignment with the reason attached — see
 * `ASSIGNMENT_ELIGIBILITY_OVERRIDDEN`.
 */
export const OVERRIDABLE_WITH_A_REASON: readonly AssignmentRule[] = [
  AssignmentRule.CLIENT_ELIGIBILITY,
  AssignmentRule.SKILLS_AND_CERTIFICATIONS,
  AssignmentRule.DISTANCE_CEILING,
  AssignmentRule.REPEAT_AUDITOR_ROTATION,
  AssignmentRule.DATE_AVAILABILITY,
];

/**
 * Why the others cannot be waived, in the words the operator is shown.
 *
 * Written as sentences rather than codes because this text goes on screen the moment somebody asks
 * why there is no button. "Not overridable" on its own invites them to hunt for a setting; naming
 * the reason either satisfies them or tells them exactly where to go.
 */
export const NOT_OVERRIDABLE_BECAUSE: Partial<Record<AssignmentRule, string>> = {
  [AssignmentRule.DISTANCE_FLOOR]:
    'This is the conflict-of-interest rule — the appraiser lives too close to the branch to value '
    + 'its gold independently. It is not an operator\'s to waive. A platform administrator can '
    + 'change this client\'s minimum-distance rule in Settings if it is set wrongly.',
  [AssignmentRule.ASSAYER_DOUBLE_BOOKED]:
    'They are already booked elsewhere that day. Nobody can be in two branches at once — pick '
    + 'another date, or another person.',
  [AssignmentRule.BRANCH_ALREADY_ASSIGNED]:
    'This branch already has a live assignment. Cancel or reassign the existing one first.',
  [AssignmentRule.BRANCH_NOT_OPEN]:
    'This branch is closed or cancelled, so there is no work to assign.',
  [AssignmentRule.PROFILE_NOT_DEPLOYABLE]:
    'Their profile is not deployable — onboarding is unfinished or the record is deleted. Finish '
    + 'onboarding on their record; dispatching somebody who has not cleared document and '
    + 'background checks is the exact thing that process exists to prevent.',
};

/** Can a stated reason get past this rule? */
export const canOverrideAssignmentRule = (rule: AssignmentRule): boolean =>
  OVERRIDABLE_WITH_A_REASON.includes(rule);

/**
 * The shortest honest sentence to put on a refusal.
 *
 * A refusal that does not say whether a reason would have helped is the thing that made this
 * whole area frustrating: the operator retypes their justification, presses the same button and
 * gets the same error, with nothing telling them the rule was never going to listen.
 */
export function overrideAdviceFor(rule: AssignmentRule): string {
  return canOverrideAssignmentRule(rule)
    ? 'Assigning anyway needs a stated reason — record one, or choose an eligible candidate.'
    : (NOT_OVERRIDABLE_BECAUSE[rule] ?? 'This rule cannot be waived.');
}
