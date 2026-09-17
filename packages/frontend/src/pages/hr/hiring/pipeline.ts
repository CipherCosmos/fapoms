import {
  ApplicationStatus, AssayerLifecycleStatus, InterviewOutcome, assayerLifecycleLabel,
} from '@fapoms/shared';
import { missingFields, payoutBlockers, type RosterPerson } from '../roster-filters';

/**
 * ONE FUNNEL, ONE VOCABULARY.
 *
 * Hiring somebody ran across three tabs — Interviews, Applications, Onboarding — each with its own
 * queue, its own chips and its own words. The same candidate appeared in one of them at a time and
 * "who needs me today" took three visits to answer. Worse, the tabs disagreed: "Invited" meant an
 * application whose link had been sent on one tab, and an approved assayer who had not started
 * joining on another.
 *
 * This module is the single vocabulary. It takes the three sources the section already fetches and
 * returns one list of people being hired, each row saying where they are and what is needed next.
 * It is deliberately pure: the stage rules are the part that must not drift, so they are testable
 * without a browser.
 */

/** Where a candidate stands, in the order they pass through. */
export type StageKey = 'to-review' | 'waiting' | 'joining' | 'ready' | 'closed';

export interface PipelineStage {
  key: StageKey;
  label: string;
  hint: string;
  /** Red counts mean "there is something here for you to do" — never "this number is large". */
  tone: 'neutral' | 'alert';
}

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  {
    key: 'to-review',
    label: 'To review',
    hint: 'They have sent their form in. Check it and either approve them or send it back.',
    tone: 'alert',
  },
  {
    key: 'waiting',
    label: 'Waiting on them',
    hint: 'The form is with the candidate — not started, or sent back for a correction.',
    tone: 'neutral',
  },
  {
    key: 'joining',
    label: 'Joining',
    hint: 'Approved and on the books: documents, background check and the last few details.',
    tone: 'neutral',
  },
  {
    key: 'ready',
    label: 'Ready to activate',
    hint: 'Everything is in. Make them Active so they can be offered work.',
    tone: 'alert',
  },
  {
    key: 'closed',
    label: 'Not proceeding',
    hint: 'Interviews that did not pass, and applications that were turned down.',
    tone: 'neutral',
  },
];

export interface PipelineRow {
  /** Unique across the three sources, which have their own id spaces. */
  key: string;
  /** Which detail surface opens: an application review, or a joining workspace. */
  kind: 'application' | 'assayer' | 'interview';
  id: string;
  name: string;
  mobile: string | null;
  email: string | null;
  stage: StageKey;
  /** Their exact position, in the words of the step they are on. */
  stageLabel: string;
  /** The one thing this row is waiting for, as an instruction. */
  needs: string;
  /** When this row last moved, where the source records it. Null is "not recorded". */
  since: string | null;
  /** A standing fact about how they got here — shown under the name. */
  note?: string;
  assayerCode?: string | null;
}

export interface ApplicationLike {
  id: string;
  fullName: string | null;
  mobile: string;
  email: string | null;
  status: ApplicationStatus;
  createdAt?: string;
  updatedAt?: string;
  interviewId?: string | null;
  extendedProfile?: Record<string, unknown> | null;
}

export interface InterviewLike {
  id: string;
  candidateName: string;
  mobile: string;
  email: string | null;
  outcome: InterviewOutcome;
  interviewedAt: string;
  interviewedByName?: string | null;
  spawnedApplicationId?: string | null;
  /** What the interviewer wrote down. Stored all along; shown nowhere until the interview drawer. */
  notes?: string | null;
}

/** The desk's own note when somebody was let in without an interview — see `openWithoutInterview`. */
export function withoutInterviewNote(app: ApplicationLike): string | undefined {
  const stamp = (app.extendedProfile ?? {})['openedWithoutInterview'] as
    | { reason?: string; byName?: string }
    | undefined;
  if (!stamp) return undefined;
  return stamp.byName
    ? `Added without an interview — by ${stamp.byName}`
    : 'Added without an interview';
}

/**
 * One application as a pipeline row, or null when it must not be listed.
 *
 * APPROVED applications are dropped on purpose: approval creates the assayer record, so the person
 * is already in the list as the joining row underneath. Listing both is how the old two-tab split
 * showed one candidate twice and made the counts disagree with the roster.
 */
export function applicationRow(app: ApplicationLike): PipelineRow | null {
  const base = {
    key: `application:${app.id}`,
    kind: 'application' as const,
    id: app.id,
    name: app.fullName?.trim() || app.mobile,
    mobile: app.mobile,
    email: app.email,
    since: app.updatedAt ?? app.createdAt ?? null,
    note: withoutInterviewNote(app),
  };

  switch (app.status) {
    case ApplicationStatus.PENDING_VALIDATION:
      return { ...base, stage: 'to-review', stageLabel: 'Form submitted', needs: 'Check their form and documents, then approve or send it back' };
    case ApplicationStatus.DRAFT:
      return { ...base, stage: 'waiting', stageLabel: 'Form not started', needs: 'Waiting for them to fill it in — resend the link if it never arrived' };
    case ApplicationStatus.AWAITING_INFO:
      return { ...base, stage: 'waiting', stageLabel: 'Sent back to them', needs: 'Waiting for them to correct what was asked for' };
    case ApplicationStatus.REJECTED:
      return { ...base, stage: 'closed', stageLabel: 'Turned down', needs: 'No further action' };
    /*
      Shown, not hidden. A candidate who withdraws would otherwise vanish from the desk's pipeline
      with no explanation — the clerk who was chasing them deserves to see what happened, even
      though there is nothing left to chase.
    */
    case ApplicationStatus.WITHDRAWN:
      return { ...base, stage: 'closed', stageLabel: 'Withdrawn', needs: 'They withdrew; their details were erased' };
    case ApplicationStatus.APPROVED:
      return null;
    default:
      return null;
  }
}

/**
 * What the server actually refuses to activate without: bank account, IFSC, PAN (the shared
 * payability rulebook) and a map location. Deliberately NOT `isReadyToActivate`, which requires
 * every critical field — under that reading somebody with no emergency contact is "not ready",
 * the desk never offers the button, and the person sits in Training while the server would have
 * activated them. The softer gaps are still named on the row; they just do not hold the step.
 */
export function activationBlockers(person: RosterPerson): string[] {
  return [
    ...payoutBlockers(person),
    ...(person.latitude == null || person.longitude == null ? ['Home location'] : []),
  ];
}

/** What the joining step this person is on still needs, in the clerk's words. */
function joiningNeeds(person: RosterPerson): string {
  switch (person.lifecycleStatus) {
    case AssayerLifecycleStatus.INVITED:
      return 'Start checking their documents';
    case AssayerLifecycleStatus.DOCUMENT_VERIFICATION:
      return 'Check their PAN and Aadhaar against the originals';
    case AssayerLifecycleStatus.BACKGROUND_VERIFICATION:
      return 'Record the result of their background check';
    case AssayerLifecycleStatus.TRAINING: {
      // Named gaps, not "incomplete": these are exactly what the server refuses to activate without.
      const gaps = activationBlockers(person);
      return gaps.length > 0 ? `Still missing: ${gaps.join(', ')}` : 'Make them Active';
    }
    default:
      return 'Move them on to the next step';
  }
}

/** One person part-way through joining. */
export function assayerRow(person: RosterPerson): PipelineRow {
  const ready = person.lifecycleStatus === AssayerLifecycleStatus.TRAINING
    && activationBlockers(person).length === 0;
  // Everything else the record is short of. Worth saying — HR chases it — but it never holds the
  // step, so it rides as a note rather than as the instruction.
  const soft = ready ? missingFields(person).filter((f) => !activationBlockers(person).includes(f)) : [];
  return {
    key: `assayer:${person.id}`,
    kind: 'assayer',
    id: person.id,
    name: person.displayName,
    mobile: person.phone ?? null,
    email: person.email ?? null,
    assayerCode: person.assayerCode,
    stage: ready ? 'ready' : 'joining',
    stageLabel: ready ? 'Ready to activate' : assayerLifecycleLabel(person.lifecycleStatus),
    needs: ready ? 'Make them Active so they can be offered work' : joiningNeeds(person),
    note: soft.length > 0 ? `Also missing: ${soft.join(', ')}` : undefined,
    since: (person as { updatedAt?: string }).updatedAt ?? null,
  };
}

/**
 * A screening that ended the conversation.
 *
 * A PASS is not listed: it opens an application, which is the row that carries them onward. A FAIL
 * had no home at all before — it sat in a log on a tab that no longer exists — so it is kept here,
 * where somebody about to re-interview the same person can see it.
 */
export function interviewRow(interview: InterviewLike): PipelineRow | null {
  if (interview.outcome !== InterviewOutcome.FAIL) return null;
  return {
    key: `interview:${interview.id}`,
    kind: 'interview',
    id: interview.id,
    name: interview.candidateName,
    mobile: interview.mobile,
    email: interview.email,
    stage: 'closed',
    stageLabel: 'Interview not passed',
    needs: 'No further action',
    since: interview.interviewedAt,
    note: interview.interviewedByName ? `Interviewed by ${interview.interviewedByName}` : undefined,
  };
}

const STAGE_ORDER: Record<StageKey, number> = {
  'to-review': 0, ready: 1, joining: 2, waiting: 3, closed: 4,
};

/**
 * The three sources as one list: what needs a decision first, then what is moving, then what is
 * finished with. Within a stage the person waiting longest comes first, because the oldest is the
 * one nobody has looked at.
 */
export function buildPipeline(input: {
  applications?: ApplicationLike[];
  people?: RosterPerson[];
  interviews?: InterviewLike[];
}): PipelineRow[] {
  const rows: PipelineRow[] = [
    ...(input.applications ?? []).map(applicationRow),
    ...(input.people ?? []).map(assayerRow),
    ...(input.interviews ?? []).map(interviewRow),
  ].filter((r): r is PipelineRow => r !== null);

  return rows.sort((a, b) => {
    const byStage = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
    if (byStage !== 0) return byStage;
    // Unknown dates sink: a row we cannot date must not claim to be the most urgent.
    const at = a.since ? Date.parse(a.since) : Number.POSITIVE_INFINITY;
    const bt = b.since ? Date.parse(b.since) : Number.POSITIVE_INFINITY;
    return at - bt;
  });
}

/** Whole days since a row last moved, or null when the source does not record it. */
export function daysWaiting(since: string | null, now: number = Date.now()): number | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}
