import { AssayerLifecycleStatus } from './enums';
import {
  ONBOARDING_STAGES, ONBOARDING_NEXT_STEP,
  isOnboardingStage, onboardingNextStep, nextOnboardingStep,
  nextAssayerLifecycleStates, canTransitionAssayerLifecycle,
} from './assayer-lifecycle';

/**
 * ONE HOME FOR "WHAT BLOCKS ACTIVATION".
 *
 * The next-step map used to exist twice — in the planner, which prints it when it refuses to
 * offer an unfinished joiner work, and hand-copied into the HR frontend, which is the screen the
 * planner sends people to. A frontend spec pinned the strings word for word to keep the two in
 * step, which catches a divergence only after somebody has written it and can never guard the
 * keys or the stage list behind them. Both sides read this file now.
 *
 * `nextOnboardingStep` is the part with real content: the HR record offers it as a button, so it
 * must never name a move the state machine would refuse. It is derived from the stage order and
 * then checked against the transition map, which is the only place those two are held against
 * each other.
 */

describe('the joining stages', () => {
  it('are the four an assayer walks before they may be given work', () => {
    expect(ONBOARDING_STAGES).toEqual([
      AssayerLifecycleStatus.INVITED,
      AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
      AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      AssayerLifecycleStatus.TRAINING,
    ]);
  });

  it('answer the "is this person joining?" question for a plain string', () => {
    // The lifecycle status arrives as a `string` from an API payload nearly everywhere it is
    // asked about, which is why this is a predicate rather than an array for callers to search.
    expect(isOnboardingStage('TRAINING')).toBe(true);
    expect(isOnboardingStage(AssayerLifecycleStatus.ACTIVE)).toBe(false);
    expect(isOnboardingStage(null)).toBe(false);
    expect(isOnboardingStage(undefined)).toBe(false);
    expect(isOnboardingStage('NOT_A_STAGE')).toBe(false);
  });
});

describe('what has to happen next', () => {
  it('carries a sentence for every joining stage and none for anything past joining', () => {
    for (const stage of ONBOARDING_STAGES) expect(onboardingNextStep(stage)).toBeTruthy();
    for (const stage of Object.values(AssayerLifecycleStatus)) {
      if (ONBOARDING_STAGES.includes(stage)) continue;
      expect(onboardingNextStep(stage)).toBeNull();
    }
  });

  it('has exactly the joining stages as its keys', () => {
    expect(Object.keys(ONBOARDING_NEXT_STEP).sort()).toEqual([...ONBOARDING_STAGES].sort());
  });

  /**
   * The planner prints "Onboarding not finished: <step>." and the HR record prints "they are
   * <step>." Either reads as a typo if an entry arrives capitalised or already punctuated.
   *
   * "Capitalised" has to mean a capitalised WORD, not a capital letter. The sibling rule about
   * consequence sentences — printed after "blocks" on the same screens — was once enforced as a
   * blind first-letter check, and the entry "TDS deduction and statutory filing" came out on a
   * clerk's screen as "blocks tDS deduction", on the field most likely to make somebody stop and
   * ask whether the software can be trusted. `blocksPhrase` in the HR frontend
   * (`pages/hr/assayer-shared.ts`) is the canonical fix and encodes the rule this now matches: a
   * leading run of two or more capitals is a name, so it is left alone.
   *
   * The rule is restated here rather than imported because `@fapoms/shared` is the base package
   * and cannot depend on the frontend; the tidier arrangement is to move `blocksPhrase` into
   * shared and have the frontend import it, which is a frontend change and not this file's to
   * make. Restating it in an assertion is not a second implementation — nothing here formats
   * anything.
   *
   * All four current values begin lower-case, so this exemption changes nothing today. It is here
   * for the first step that has to lead with an acronym ("KYC re-verification pending…"), which
   * the old assertion would have refused outright and sent somebody to fix by lower-casing the
   * acronym — reproducing "tDS" in the other of the two places this text is printed.
   */
  it('reads as a continuation, because both screens print it mid-sentence', () => {
    for (const step of Object.values(ONBOARDING_NEXT_STEP)) {
      if (!/^[A-Z]{2}/.test(step)) expect(step[0]).toBe(step[0].toLowerCase());
      expect(step.endsWith('.')).toBe(false);
    }
  });

  it('names the HR roster, which is where it sends people', () => {
    for (const step of Object.values(ONBOARDING_NEXT_STEP)) {
      expect(step).toContain('HR roster');
    }
  });
});

describe('the forward step', () => {
  it('walks the chain one stage at a time, and ends at Active', () => {
    expect(nextOnboardingStep(AssayerLifecycleStatus.INVITED)).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
    expect(nextOnboardingStep(AssayerLifecycleStatus.DOCUMENT_VERIFICATION)).toBe(AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
    expect(nextOnboardingStep(AssayerLifecycleStatus.BACKGROUND_VERIFICATION)).toBe(AssayerLifecycleStatus.TRAINING);
    expect(nextOnboardingStep(AssayerLifecycleStatus.TRAINING)).toBe(AssayerLifecycleStatus.ACTIVE);
  });

  it('never skips a stage — four decisions stay four decisions', () => {
    // The button is a shortcut for a judgement somebody in HR makes about a real person; a single
    // press that walked INVITED to ACTIVE would have made three of those four judgements up.
    let at: string = AssayerLifecycleStatus.INVITED;
    const walked: string[] = [at];
    for (let i = 0; i < 10; i += 1) {
      const next = nextOnboardingStep(at);
      if (!next) break;
      walked.push(next);
      at = next;
    }
    expect(walked).toEqual([...ONBOARDING_STAGES, AssayerLifecycleStatus.ACTIVE]);
  });

  it('is nothing for anybody who is not joining', () => {
    for (const stage of [
      AssayerLifecycleStatus.ACTIVE,
      AssayerLifecycleStatus.ON_LEAVE,
      AssayerLifecycleStatus.SUSPENDED,
      AssayerLifecycleStatus.INACTIVE,
      AssayerLifecycleStatus.RESIGNED,
      AssayerLifecycleStatus.TERMINATED,
      AssayerLifecycleStatus.ARCHIVED,
    ]) {
      expect(nextOnboardingStep(stage)).toBeNull();
    }
    expect(nextOnboardingStep(null)).toBeNull();
  });

  it('is only ever a move the state machine will actually accept', () => {
    // The whole reason this is derived-then-checked rather than a fifth hand-written list: a
    // button offering a transition the server refuses can only ever return 400.
    for (const stage of ONBOARDING_STAGES) {
      const forward = nextOnboardingStep(stage);
      if (!forward) continue;
      expect(nextAssayerLifecycleStates(stage)).toContain(forward);
      expect(canTransitionAssayerLifecycle(stage, forward)).toBe(true);
    }
  });
});
