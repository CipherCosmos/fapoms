import {
  AssignmentRule,
  OVERRIDABLE_WITH_A_REASON,
  NOT_OVERRIDABLE_BECAUSE,
  canOverrideAssignmentRule,
  overrideAdviceFor,
} from './assignment-override';

/**
 * The planning screen offers "Assign anyway" and invites a considered justification. Until this
 * list existed, exactly one of the seven blocking checks on the write path read that field — so an
 * operator overriding a skills, distance or rotation exclusion typed their reason, pressed Confirm
 * and was refused by a rule that had never looked at it.
 */
describe('what a stated reason may waive', () => {
  it.each([
    AssignmentRule.CLIENT_ELIGIBILITY,
    AssignmentRule.SKILLS_AND_CERTIFICATIONS,
    AssignmentRule.DISTANCE_CEILING,
    AssignmentRule.REPEAT_AUDITOR_ROTATION,
    AssignmentRule.DATE_AVAILABILITY,
  ])('%s is an operator judgement, so a reason waives it', (rule) => {
    expect(canOverrideAssignmentRule(rule)).toBe(true);
  });

  /**
   * Two different kinds of "no". Three of these are physically impossible; the distance FLOOR is
   * the one integrity rule deliberately kept out of an operator's hands — it exists to stop
   * somebody valuing gold at a branch beside their own home.
   */
  it.each([
    AssignmentRule.DISTANCE_FLOOR,
    AssignmentRule.ASSAYER_DOUBLE_BOOKED,
    AssignmentRule.BRANCH_ALREADY_ASSIGNED,
    AssignmentRule.BRANCH_NOT_OPEN,
    AssignmentRule.PROFILE_NOT_DEPLOYABLE,
  ])('%s is not an operator judgement, so no reason waives it', (rule) => {
    expect(canOverrideAssignmentRule(rule)).toBe(false);
  });

  /**
   * The floor and the ceiling are the same setting and opposite decisions. Collapsing them — which
   * is what the code did while they were distinguishable only by reading the English in the
   * message — either lets a conflict of interest through or refuses a legitimate long journey.
   */
  it('separates the conflict-of-interest floor from the service ceiling', () => {
    expect(canOverrideAssignmentRule(AssignmentRule.DISTANCE_CEILING)).toBe(true);
    expect(canOverrideAssignmentRule(AssignmentRule.DISTANCE_FLOOR)).toBe(false);
  });

  it('every rule is on exactly one list, so none is silently unclassified', () => {
    for (const rule of Object.values(AssignmentRule)) {
      const overridable = OVERRIDABLE_WITH_A_REASON.includes(rule);
      const explained = rule in NOT_OVERRIDABLE_BECAUSE;
      expect({ rule, classified: overridable !== explained }).toEqual({ rule, classified: true });
    }
  });
});

/**
 * A refusal that does not say whether a reason would have helped is what had operators retyping
 * the same justification into the same button.
 */
describe('what the operator is told', () => {
  it('tells them a reason is what is missing, when it is', () => {
    expect(overrideAdviceFor(AssignmentRule.SKILLS_AND_CERTIFICATIONS)).toMatch(/needs a stated reason/);
  });

  it('explains why no reason will do, and where the real remedy is', () => {
    const advice = overrideAdviceFor(AssignmentRule.DISTANCE_FLOOR);
    expect(advice).toMatch(/conflict-of-interest/i);
    // Points at the setting that actually changes it, rather than leaving them hunting.
    expect(advice).toMatch(/Settings/);
  });

  it('never leaves a rule without an explanation', () => {
    for (const rule of Object.values(AssignmentRule)) {
      expect(overrideAdviceFor(rule).length).toBeGreaterThan(20);
    }
  });
});
