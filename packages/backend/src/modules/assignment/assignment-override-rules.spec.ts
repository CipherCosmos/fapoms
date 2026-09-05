import { BadRequestException } from '@nestjs/common';
import { AssignmentRule, ASSIGNMENT_ERROR_CODES } from '@fapoms/shared';
import { AssignmentService } from './assignment.service';

/**
 * "Assign anyway" now waives what it says it waives.
 *
 * Six of the seven blocking checks on the assignment path used to throw unconditionally while a
 * seventh consulted `overrideReason` — so the planning panel offered the button, the operator
 * typed a considered justification, and a rule that had never read the field refused them. The
 * panel even suggested the wording: its prompt for a skills exclusion read "Skill or certification
 * requirement waived by ops", for an action the server would always refuse.
 *
 * A file of its own, and a static method rather than a constructed service: this is one decision,
 * it has no collaborators, and `assignment.service.spec.ts` is large, heavily shared and under
 * concurrent edit.
 */
const apply = (rule: AssignmentRule, reason?: string) =>
  AssignmentService.applyOverridePolicy(rule, 'Blocked.', reason);

describe('applyOverridePolicy — what a stated reason waives', () => {
  it('lets a reason waive a missing certification, which it never could before', () => {
    expect(apply(AssignmentRule.SKILLS_AND_CERTIFICATIONS, 'Renewal lodged; certificate due Friday.'))
      .toMatchObject({ rule: AssignmentRule.SKILLS_AND_CERTIFICATIONS });
  });

  it.each([
    AssignmentRule.CLIENT_ELIGIBILITY,
    AssignmentRule.SKILLS_AND_CERTIFICATIONS,
    AssignmentRule.DISTANCE_CEILING,
    AssignmentRule.REPEAT_AUDITOR_ROTATION,
    AssignmentRule.DATE_AVAILABILITY,
  ])('waives %s with a stated reason', (rule) => {
    expect(apply(rule, 'Cleared by ops after speaking to the branch.').overrideReason)
      .toBe('Cleared by ops after speaking to the branch.');
  });

  it('refuses without a reason, and says a reason is what is missing', () => {
    expect(() => apply(AssignmentRule.SKILLS_AND_CERTIFICATIONS))
      .toThrow(/needs a stated reason/i);
  });

  /**
   * The floor and the ceiling are the same client setting and opposite decisions. The ceiling is a
   * cost question an operator may answer; the floor is the conflict-of-interest rule, which exists
   * to stop somebody valuing gold at a branch beside their own home, and is not theirs to waive.
   */
  it('refuses the distance FLOOR however good the reason, and points at the real remedy', () => {
    expect(() => apply(AssignmentRule.DISTANCE_FLOOR, 'Ops are happy; they know the family well.'))
      .toThrow(/conflict-of-interest/i);
    expect(() => apply(AssignmentRule.DISTANCE_FLOOR, 'Ops are happy; they know the family well.'))
      .toThrow(/Settings/);
  });

  it.each([
    AssignmentRule.DISTANCE_FLOOR,
    AssignmentRule.ASSAYER_DOUBLE_BOOKED,
    AssignmentRule.BRANCH_ALREADY_ASSIGNED,
    AssignmentRule.BRANCH_NOT_OPEN,
    AssignmentRule.PROFILE_NOT_DEPLOYABLE,
  ])('never waives %s', (rule) => {
    expect(() => apply(rule, 'A thoroughly reasonable justification from ops.')).toThrow(BadRequestException);
  });

  /**
   * The client has to be able to tell "type a reason" apart from "this will never work" — that
   * distinction is the whole difference between a dead end and a decision, and a bare 400 cannot
   * carry it.
   */
  it('distinguishes a missing reason from a rule that will never listen', () => {
    const codeOf = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e?.response?.code ?? e?.code; } };

    expect(codeOf(() => apply(AssignmentRule.SKILLS_AND_CERTIFICATIONS)))
      .toBe(ASSIGNMENT_ERROR_CODES.OVERRIDE_REASON_REQUIRED);
    expect(codeOf(() => apply(AssignmentRule.DISTANCE_FLOOR, 'Any reason at all, sincerely meant.')))
      .toBe(ASSIGNMENT_ERROR_CODES.RULE_NOT_OVERRIDABLE);
  });

  it('does not accept whitespace as a reason', () => {
    expect(() => apply(AssignmentRule.DISTANCE_CEILING, '   ')).toThrow(/needs a stated reason/i);
  });

  it('keeps the barred reason on the waiver, so the record says what was set aside', () => {
    const waived = AssignmentService.applyOverridePolicy(
      AssignmentRule.DISTANCE_CEILING,
      "Out of range: 90.0km exceeds the client's 50km limit.",
      'Nobody nearer is free; travel approved.',
    );
    expect(waived.barredReason).toMatch(/90.0km/);
  });
});
