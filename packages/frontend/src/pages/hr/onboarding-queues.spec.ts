import {
  AssayerLifecycleStatus,
  ONBOARDING_NEXT_STEP as SHARED_NEXT_STEP,
  ONBOARDING_STAGES as SHARED_STAGES,
} from '@fapoms/shared';
import {
  ONBOARDING_NEXT_STEP, ONBOARDING_STAGES, onboardingNextStep,
  isAwaitingDocumentCheck, isAwaitingBackgroundCheck, isReadyToActivate,
} from './assayer-shared';
import type { Assayer } from './assayer-shared';

/**
 * The three joining queues, and the sentence that has to read the same in two places.
 *
 * DOCUMENT_VERIFICATION and BACKGROUND_VERIFICATION are enforced lifecycle stages that no screen
 * listed: the roster's "Onboarding" chip put all four joining stages in one pile, so "whose
 * papers am I meant to check today" had no answer anywhere in the application. These are the
 * rules behind the three chips that answer it.
 *
 * `ONBOARDING_NEXT_STEP` used to be pinned here string-for-string, because it was a hand-written
 * COPY of the map in `packages/backend/src/modules/planning/recommendation.engine.ts`. It is not
 * a copy any more — both the planner and this screen import it from `@fapoms/shared` — so the
 * pin has been replaced by the assertion that actually holds now: this is the same map, not an
 * equal one. A string test on a copy fails only after somebody has already written the
 * divergence, and it could never have guarded the four keys or the stage list behind them.
 */

const person = (over: Partial<Assayer> = {}): Assayer => ({
  id: 'a-1',
  assayerCode: 'AS0001',
  employeeId: null,
  employeeCode: null,
  firstName: 'Person',
  lastName: 'One',
  displayName: 'Person One',
  email: 'p1@example.com',
  phone: '+919000000000',
  alternatePhone: null,
  address: '1 Road',
  state: 'Kerala',
  district: 'Ernakulam',
  city: 'Kochi',
  pincode: '682001',
  latitude: 9.9,
  longitude: 76.2,
  status: 'ACTIVE',
  lifecycleStatus: AssayerLifecycleStatus.TRAINING,
  organizationId: null,
  panNumber: 'ABCDE1234F',
  bankAccountNumber: '000111222333',
  ifscCode: 'HDFC0000001',
  notes: null,
  employmentType: 'INTERNAL',
  joiningDate: '2024-01-01',
  exitDate: null,
  terminationDate: null,
  managerId: null,
  department: null,
  region: 'SOUTH',
  emergencyContactName: 'Next Of Kin',
  // Critical, like phone/PAN/bank/IFSC/joining date/latitude — the fixture starts complete so
  // each test can knock out exactly one thing and see the effect.
  emergencyContactPhone: '+919000000001',
  emergencyContactRelation: 'Spouse',
  photograph: null,
  skills: ['Gold'],
  certifications: null,
  languages: null,
  preferredRegions: null,
  specializations: null,
  experienceYears: 4,
  performanceRating: 4,
  leaves: null,
  workingHours: null,
  maxDailyWorkload: 3,
  maxWeeklyWorkload: 15,
  ...over,
});

describe('the joining queues', () => {
  it('"Documents to check" is exactly the document-verification stage, and nothing else', () => {
    expect(isAwaitingDocumentCheck(person({ lifecycleStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION }))).toBe(true);
    for (const stage of [
      AssayerLifecycleStatus.INVITED,
      AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      AssayerLifecycleStatus.TRAINING,
      AssayerLifecycleStatus.ACTIVE,
    ]) {
      expect(isAwaitingDocumentCheck(person({ lifecycleStatus: stage }))).toBe(false);
    }
  });

  it('"Background check due" is exactly the background-verification stage', () => {
    expect(isAwaitingBackgroundCheck(person({ lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION }))).toBe(true);
    expect(isAwaitingBackgroundCheck(person({ lifecycleStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION }))).toBe(false);
    expect(isAwaitingBackgroundCheck(person({ lifecycleStatus: AssayerLifecycleStatus.ACTIVE }))).toBe(false);
  });

  describe('"Ready to activate"', () => {
    it('holds somebody whose next legal step is Active with no required field missing', () => {
      expect(isReadyToActivate(person({ lifecycleStatus: AssayerLifecycleStatus.TRAINING }))).toBe(true);
    });

    it('excludes a record with a critical gap, however far along the stages they are', () => {
      // No bank account: the same rule the roster's "Cannot be paid" chip and the record's own
      // completeness banner use, so a queue can never claim somebody is ready while the banner
      // on their record says two required fields are missing.
      expect(isReadyToActivate(person({
        lifecycleStatus: AssayerLifecycleStatus.TRAINING,
        bankAccountNumber: null,
      }))).toBe(false);
    });

    it('excludes somebody with no home coordinate — 76 ACTIVE people are in that state today', () => {
      // "Map location" is a critical field (latitude), which is the whole reason the record page
      // now carries a pin control. Someone who cannot be distance-filtered is not "ready".
      expect(isReadyToActivate(person({
        lifecycleStatus: AssayerLifecycleStatus.TRAINING,
        latitude: null,
      }))).toBe(false);
    });

    it('excludes the earlier joining stages — the state machine will not take them to Active yet', () => {
      for (const stage of [
        AssayerLifecycleStatus.INVITED,
        AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
        AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      ]) {
        expect(isReadyToActivate(person({ lifecycleStatus: stage }))).toBe(false);
      }
    });

    it('never picks up somebody who is already Active, or who has left', () => {
      expect(isReadyToActivate(person({ lifecycleStatus: AssayerLifecycleStatus.ACTIVE }))).toBe(false);
      // ON_LEAVE and INACTIVE can both reach ACTIVE, so the legal-move test alone would let them
      // in — they are not people who are *joining*, which is what this queue is for.
      expect(isReadyToActivate(person({ lifecycleStatus: AssayerLifecycleStatus.ON_LEAVE }))).toBe(false);
      expect(isReadyToActivate(person({ lifecycleStatus: AssayerLifecycleStatus.INACTIVE }))).toBe(false);
      expect(isReadyToActivate(person({ lifecycleStatus: AssayerLifecycleStatus.RESIGNED }))).toBe(false);
    });
  });

  it('the three queues never claim the same person at once', () => {
    for (const stage of Object.values(AssayerLifecycleStatus)) {
      const p = person({ lifecycleStatus: stage });
      const claims = [isAwaitingDocumentCheck(p), isAwaitingBackgroundCheck(p), isReadyToActivate(p)]
        .filter(Boolean).length;
      expect(claims).toBeLessThanOrEqual(1);
    }
  });

  it('every joining stage the roster groups under "Onboarding" carries a next-step sentence', () => {
    for (const stage of ONBOARDING_STAGES) {
      expect(onboardingNextStep({ lifecycleStatus: stage })).toBeTruthy();
    }
    expect(onboardingNextStep({ lifecycleStatus: AssayerLifecycleStatus.ACTIVE })).toBeNull();
  });

  it('says what the planner says because it IS what the planner says — one map in @fapoms/shared', () => {
    // Identity, not equality. `toEqual` would still pass on a re-introduced copy that happened to
    // hold the same strings today, which is the arrangement this replaced.
    expect(ONBOARDING_NEXT_STEP).toBe(SHARED_NEXT_STEP);
    expect(ONBOARDING_STAGES).toBe(SHARED_STAGES);
  });

  it('covers every joining stage and nothing past joining', () => {
    // The half a string-pin could not check: that the four keys are exactly the joining stages.
    // A stage added to the lifecycle without a sentence would leave the planner refusing work
    // with "Not assignable — profile status is …" and the roster silently saying nothing.
    expect(Object.keys(ONBOARDING_NEXT_STEP).sort()).toEqual([...ONBOARDING_STAGES].sort());
    for (const stage of Object.values(AssayerLifecycleStatus)) {
      if (ONBOARDING_STAGES.includes(stage)) continue;
      expect(onboardingNextStep({ lifecycleStatus: stage })).toBeNull();
    }
  });

  it('reads as a continuation, so both screens can put it mid-sentence', () => {
    // The planner prints "Onboarding not finished: <step>." and the record page prints "they are
    // <step>." Either reads as a typo if an entry arrives capitalised or already punctuated.
    for (const step of Object.values(ONBOARDING_NEXT_STEP)) {
      expect(step[0]).toBe(step[0].toLowerCase());
      expect(step.endsWith('.')).toBe(false);
    }
  });
});
