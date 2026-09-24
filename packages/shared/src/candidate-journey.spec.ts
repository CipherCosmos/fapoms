import { ApplicationStatus } from './assayer-application';
import { AssayerLifecycleStatus } from './enums';
import { AssayerUnavailableReason } from './assayer-roster-vocabulary';
import { ONBOARDING_STAGES } from './assayer-lifecycle';
import {
  CANDIDATE_JOURNEY_NEXT_WORDS, CANDIDATE_JOURNEY_STEP_WORDS, candidateJourney, candidateJourneyStage,
  readCandidateJourneyProgress, type CandidateJourneyProgress,
} from './candidate-journey';

/** The steps as `candidateJourney` lays them out, one "step:state" string each. */
const laidOut = (view: ReturnType<typeof candidateJourney>) => view?.steps.map((s) => `${s.step}:${s.state}`);

const at = (stage: CandidateJourneyProgress['stage'], asks: CandidateJourneyProgress['asks'] = []): CandidateJourneyProgress =>
  ({ stage, paused: false, asks });

describe('where a lifecycle status sits on the candidate\'s road', () => {
  /**
   * Every joining stage must be a step. A stage added to `ONBOARDING_STAGES` without a place here
   * would otherwise read as "paused" to every candidate walking through it — the safe default for
   * an unknown value, and exactly the wrong thing to say to somebody who is simply progressing.
   */
  it.each(ONBOARDING_STAGES)('puts %s on the road, not on a side road', (lifecycle) => {
    expect(candidateJourneyStage(lifecycle)).toMatchObject({ paused: false, stage: expect.any(String) });
  });

  it('says ready to start work once they are active, or on leave from work', () => {
    expect(candidateJourneyStage(AssayerLifecycleStatus.ACTIVE)).toEqual({ stage: 'READY', paused: false });
    expect(candidateJourneyStage(AssayerLifecycleStatus.ON_LEAVE)).toEqual({ stage: 'READY', paused: false });
  });

  /**
   * The side roads are exactly these. A lifecycle value added later lands on the paused side by
   * default, and this list then fails, so somebody decides where it belongs instead of it drifting.
   */
  it('reads every side road as paused, and nothing else', () => {
    const paused = Object.values(AssayerLifecycleStatus).filter((s) => candidateJourneyStage(s).paused);
    expect(paused.sort()).toEqual([
      AssayerLifecycleStatus.ARCHIVED, AssayerLifecycleStatus.INACTIVE, AssayerLifecycleStatus.RESIGNED,
      AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.TERMINATED,
    ].sort());
  });

  it('names no step while paused', () => {
    expect(candidateJourneyStage(AssayerLifecycleStatus.INACTIVE)).toEqual({ stage: null, paused: true });
    expect(candidateJourneyStage(null)).toEqual({ stage: null, paused: true });
    expect(candidateJourneyStage('SOMETHING_NEW')).toEqual({ stage: null, paused: true });
  });

  /**
   * The privacy half: the function cannot be told why somebody is inactive, so a failed background
   * check and a refused approval produce the same answer by construction. Pinned anyway, because
   * the natural "improvement" — passing the reason in to say something kinder — would undo it.
   */
  it('cannot tell a failed background check from a refused approval', () => {
    expect(candidateJourneyStage.length).toBe(1);
    const failed = { lifecycle: AssayerLifecycleStatus.INACTIVE, reason: AssayerUnavailableReason.BGV_FAILED };
    const refused = { lifecycle: AssayerLifecycleStatus.INACTIVE, reason: AssayerUnavailableReason.APPROVAL_REJECTED };
    expect(candidateJourneyStage(failed.lifecycle)).toEqual(candidateJourneyStage(refused.lifecycle));
  });
});

describe('the journey a finished application shows', () => {
  it('shows a submitted form as sent, with HR checking it', () => {
    const view = candidateJourney(ApplicationStatus.PENDING_VALIDATION, null);
    expect(laidOut(view)).toEqual([
      'SENT:done', 'FORM_CHECK:current', 'DOCUMENTS:ahead', 'BACKGROUND:ahead',
      'APPROVAL:ahead', 'TRAINING:ahead', 'READY:ahead',
    ]);
    expect(view?.next).toBe('FORM_CHECK');
  });

  it('follows the record after approval', () => {
    expect(laidOut(candidateJourney(ApplicationStatus.APPROVED, at('BACKGROUND')))).toEqual([
      'SENT:done', 'FORM_CHECK:done', 'DOCUMENTS:done', 'BACKGROUND:current',
      'APPROVAL:ahead', 'TRAINING:ahead', 'READY:ahead',
    ]);
    expect(candidateJourney(ApplicationStatus.APPROVED, at('TRAINING'))?.next).toBe('TRAINING');
  });

  /**
   * The approver may send somebody straight to work (2026-09-24), so while the approval is pending
   * the page must not promise training — the step says "if needed" and the sentence offers both.
   */
  it('never promises training before the approval decides it', () => {
    const view = candidateJourney(ApplicationStatus.APPROVED, at('APPROVAL'));
    expect(view?.steps.find((s) => s.step === 'TRAINING')?.state).toBe('ahead');
    expect(CANDIDATE_JOURNEY_STEP_WORDS.TRAINING).toMatch(/if needed/);
    expect(CANDIDATE_JOURNEY_NEXT_WORDS.APPROVAL).toMatch(/training if it is needed/);
    expect(CANDIDATE_JOURNEY_NEXT_WORDS.APPROVAL).toMatch(/start work straight away/);
  });

  it('puts somebody who is ready to start work at the end of the road', () => {
    expect(laidOut(candidateJourney(ApplicationStatus.APPROVED, at('READY')))).toEqual([
      'SENT:done', 'FORM_CHECK:done', 'DOCUMENTS:done', 'BACKGROUND:done',
      'APPROVAL:done', 'TRAINING:done', 'READY:current',
    ]);
  });

  /** An older server, or a record the server could not read: approved, and nothing more claimed. */
  it('claims nothing past the form check when the server did not say where they are', () => {
    const view = candidateJourney(ApplicationStatus.APPROVED, null);
    expect(laidOut(view)).toEqual([
      'SENT:done', 'FORM_CHECK:done', 'DOCUMENTS:ahead', 'BACKGROUND:ahead',
      'APPROVAL:ahead', 'TRAINING:ahead', 'READY:ahead',
    ]);
    expect(view?.next).toBe('UNKNOWN');
  });

  it('shows a paused journey as paused, with no steps and nothing asked', () => {
    const view = candidateJourney(ApplicationStatus.APPROVED, {
      stage: null, paused: true, asks: [{ requirement: 'PAN_CARD', label: 'PAN Card', note: 'x' }],
    });
    expect(view).toEqual({ steps: [], next: null, paused: true, asks: [] });
  });

  it('carries what HR asked for after approval, and only after approval', () => {
    const asks = [{ requirement: 'PAN_CARD', label: 'PAN Card', note: 'The number is cut off.' }];
    expect(candidateJourney(ApplicationStatus.APPROVED, at('DOCUMENTS', asks))?.asks).toEqual(asks);
    expect(candidateJourney(ApplicationStatus.PENDING_VALIDATION, at('DOCUMENTS', asks))?.asks).toEqual([]);
  });

  /** Each of these already has a screen of its own: the form, or a closing line. */
  it.each([ApplicationStatus.DRAFT, ApplicationStatus.AWAITING_INFO, ApplicationStatus.REJECTED, ApplicationStatus.WITHDRAWN])(
    'has no journey for a %s application',
    (status) => {
      expect(candidateJourney(status, at('READY'))).toBeNull();
    },
  );
});

describe('reading the journey off a response', () => {
  it('reads what the server sends', () => {
    expect(readCandidateJourneyProgress({
      stage: 'DOCUMENTS', paused: false, asks: [{ requirement: 'PAN_CARD', label: ' PAN Card ', note: '  Retake it.  ' }],
    })).toEqual({ stage: 'DOCUMENTS', paused: false, asks: [{ requirement: 'PAN_CARD', label: 'PAN Card', note: 'Retake it.' }] });
  });

  it('reads nothing from an older server, or from something that is not a journey', () => {
    expect(readCandidateJourneyProgress(undefined)).toBeNull();
    expect(readCandidateJourneyProgress('READY')).toBeNull();
    expect(readCandidateJourneyProgress({ stage: 'NOWHERE', paused: false })).toBeNull();
  });

  /** The two steps before approval are the application's to report, never the record's. */
  it('does not take a step from before approval', () => {
    expect(readCandidateJourneyProgress({ stage: 'SENT', paused: false })).toBeNull();
    expect(readCandidateJourneyProgress({ stage: 'FORM_CHECK', paused: false })).toBeNull();
  });

  it('drops an ask it cannot show, and keeps one without a note', () => {
    const read = readCandidateJourneyProgress({
      stage: 'READY', paused: false,
      asks: [null, { requirement: 'PAN_CARD' }, { label: 'No key' }, { requirement: 'PHOTOGRAPH', label: 'Photograph', note: '  ' }],
    });
    expect(read?.asks).toEqual([{ requirement: 'PHOTOGRAPH', label: 'Photograph', note: null }]);
  });

  it('keeps a paused journey paused, whatever else came with it', () => {
    expect(readCandidateJourneyProgress({
      stage: 'BACKGROUND', paused: true, asks: [{ requirement: 'PAN_CARD', label: 'PAN Card', note: 'x' }],
    })).toEqual({ stage: null, paused: true, asks: [] });
  });
});
