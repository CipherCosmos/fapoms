import { ApplicationStatus, AssayerLifecycleStatus, InterviewOutcome } from '@fapoms/shared';
import {
  buildPipeline, applicationRow, assayerRow, interviewRow, daysWaiting, PIPELINE_STAGES,
  type ApplicationLike, type InterviewLike,
} from './pipeline';
import type { RosterPerson } from '../roster-filters';

/**
 * The hiring funnel's one vocabulary.
 *
 * Three tabs used to describe this funnel in three vocabularies, and they disagreed: "Invited"
 * named both an application whose link had been sent and an approved assayer who had not started
 * joining. These tests pin the merged reading — which source owns a candidate at each point, and
 * what the screen says is needed next.
 */

const app = (over: Partial<ApplicationLike> = {}): ApplicationLike => ({
  id: 'app-1', fullName: 'Sunita Rao', mobile: '+919000000001', email: null,
  status: ApplicationStatus.PENDING_VALIDATION, createdAt: '2026-09-01T00:00:00.000Z', ...over,
});

const person = (over: Partial<RosterPerson> = {}): RosterPerson => ({
  id: 'as-1', assayerCode: 'AS0001', displayName: 'Ravi Pillai', phone: '+919000000002',
  lifecycleStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
  panNumber: 'ABCDE1234F', bankAccountNumber: '000111222333', ifscCode: 'HDFC0000001',
  latitude: 9.9, longitude: 76.2,
  ...over,
} as RosterPerson);

const interview = (over: Partial<InterviewLike> = {}): InterviewLike => ({
  id: 'int-1', candidateName: 'A. Fail', mobile: '+919000000003', email: null,
  outcome: InterviewOutcome.FAIL, interviewedAt: '2026-09-02T00:00:00.000Z', ...over,
});

describe('one candidate is listed once, by whichever source owns them now', () => {
  it('drops an approved application: the assayer record it created is the row that carries them on', () => {
    expect(applicationRow(app({ status: ApplicationStatus.APPROVED }))).toBeNull();
  });

  it('drops a passed interview: it opened an application, and that is the row', () => {
    expect(interviewRow(interview({ outcome: InterviewOutcome.PASS }))).toBeNull();
  });

  it('keeps a failed interview, which had no home before', () => {
    expect(interviewRow(interview())).toMatchObject({ stage: 'closed', stageLabel: 'Interview not passed' });
  });

  it('never lists the same person twice when their application and their record both exist', () => {
    const rows = buildPipeline({
      applications: [app({ status: ApplicationStatus.APPROVED })],
      people: [person()],
      interviews: [interview({ outcome: InterviewOutcome.PASS, spawnedApplicationId: 'app-1' })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('assayer');
  });
});

describe('what the row says is needed next', () => {
  it('asks for a decision on a submitted form', () => {
    expect(applicationRow(app())).toMatchObject({
      stage: 'to-review',
      needs: 'Check their form and documents, then approve or send it back',
    });
  });

  it('separates a form never started from one sent back', () => {
    expect(applicationRow(app({ status: ApplicationStatus.DRAFT }))!.stageLabel).toBe('Form not started');
    expect(applicationRow(app({ status: ApplicationStatus.AWAITING_INFO }))!.stageLabel).toBe('Sent back to them');
    // Both are waiting on the candidate, not on the desk.
    expect(applicationRow(app({ status: ApplicationStatus.DRAFT }))!.stage).toBe('waiting');
    expect(applicationRow(app({ status: ApplicationStatus.AWAITING_INFO }))!.stage).toBe('waiting');
  });

  it('names the joining step a person is on', () => {
    expect(assayerRow(person({ lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION })).needs)
      .toBe('Record the result of their background check');
  });

  /** The same gaps the server refuses to activate without — not a vague "incomplete". */
  it('names exactly what is missing before somebody can be made Active', () => {
    const row = assayerRow(person({
      lifecycleStatus: AssayerLifecycleStatus.TRAINING,
      bankAccountNumber: null,
      latitude: null,
      longitude: null,
    }));
    expect(row.stage).toBe('joining');
    expect(row.needs).toContain('Bank account');
    expect(row.needs).toContain('Home location');
  });

  it('puts somebody with nothing missing in Ready to activate', () => {
    const row = assayerRow(person({ lifecycleStatus: AssayerLifecycleStatus.TRAINING }));
    expect(row.stage).toBe('ready');
    expect(row.needs).toBe('Make them Active so they can be offered work');
  });

  /**
   * The chip has to mean "the server will accept Active now". `isReadyToActivate` means every
   * critical field is present, which is a stricter question: under it, somebody missing only an
   * emergency contact never gets the button, and sits in Training while the server would have
   * activated them on request.
   */
  it('still reads as ready when only a non-blocking field is missing, and says what it is', () => {
    const row = assayerRow(person({
      lifecycleStatus: AssayerLifecycleStatus.TRAINING,
      emergencyContactPhone: null,
      dateOfBirth: null,
    }));
    expect(row.stage).toBe('ready');
    expect(row.note).toMatch(/Also missing:/);
  });
});

describe('the desk shortcut is visible on the row', () => {
  it('says who let somebody in without an interview', () => {
    const row = applicationRow(app({
      extendedProfile: { openedWithoutInterview: { reason: 'Walk-in, known to the branch', byName: 'Meera' } },
    }));
    expect(row!.note).toBe('Added without an interview — by Meera');
  });

  it('says nothing extra for the ordinary route', () => {
    expect(applicationRow(app())!.note).toBeUndefined();
  });
});

describe('order of work', () => {
  it('leads with what needs a decision, then what is ready, and sinks what is finished with', () => {
    const rows = buildPipeline({
      applications: [
        app({ id: 'a-draft', status: ApplicationStatus.DRAFT }),
        app({ id: 'a-review' }),
        app({ id: 'a-rejected', status: ApplicationStatus.REJECTED }),
      ],
      people: [person({ id: 'p-ready', lifecycleStatus: AssayerLifecycleStatus.TRAINING })],
    });
    expect(rows.map((r) => r.stage)).toEqual(['to-review', 'ready', 'waiting', 'closed']);
  });

  it('within a stage, the one waiting longest is first', () => {
    const rows = buildPipeline({
      applications: [
        app({ id: 'newer', createdAt: '2026-09-10T00:00:00.000Z' }),
        app({ id: 'older', createdAt: '2026-09-01T00:00:00.000Z' }),
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(['older', 'newer']);
  });

  it('a row with no date recorded never claims to be the most urgent', () => {
    const rows = buildPipeline({
      applications: [
        app({ id: 'undated', createdAt: undefined }),
        app({ id: 'dated', createdAt: '2026-09-01T00:00:00.000Z' }),
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(['dated', 'undated']);
  });
});

describe('waiting time', () => {
  it('counts whole days, and says nothing when the source does not record one', () => {
    const now = Date.parse('2026-09-16T00:00:00.000Z');
    expect(daysWaiting('2026-09-13T00:00:00.000Z', now)).toBe(3);
    expect(daysWaiting(null, now)).toBeNull();
    expect(daysWaiting('not a date', now)).toBeNull();
  });
});

describe('the chips', () => {
  it('marks as a task only the two stages where somebody is waiting on this desk', () => {
    const alerting = PIPELINE_STAGES.filter((s) => s.tone === 'alert').map((s) => s.key);
    expect(alerting).toEqual(['to-review', 'ready']);
  });
});

/**
 * A candidate who withdraws would otherwise vanish from the desk's board with no explanation —
 * `applicationRow` returns null for anything it does not recognise, and the clerk who had been
 * chasing them would simply find the row gone one morning.
 */
describe('a withdrawn application', () => {
  const app = (over: Partial<ApplicationLike> = {}): ApplicationLike => ({
    id: 'a1', fullName: 'Ramesh Kulkarni', mobile: '9822014455', email: null,
    status: ApplicationStatus.WITHDRAWN, createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z', ...over,
  } as ApplicationLike);

  it('stays on the board as closed, saying what happened', () => {
    const row = applicationRow(app());
    expect(row).not.toBeNull();
    expect(row!.stage).toBe('closed');
    expect(row!.stageLabel).toBe('Withdrawn');
    expect(row!.needs).toMatch(/erased/);
  });

  /** Closed, not a task: nobody is waiting on the desk for this one. */
  it('asks nothing of the desk', () => {
    expect(PIPELINE_STAGES.find((s) => s.key === 'closed')!.tone).not.toBe('alert');
  });
});
