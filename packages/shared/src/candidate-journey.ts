import { ApplicationStatus } from './assayer-application';
import { AssayerLifecycleStatus } from './enums';

/**
 * WHAT A CANDIDATE IS SHOWN AFTER THEY PRESS SUBMIT — the road from the form to their first job.
 *
 * The page they landed on said one line ("Submitted. HR will call you.") while five more steps
 * still lay ahead of them, and it had no way to say that HR had asked them for something. Owner,
 * 2026-09-24: the page is "very basic eventhough they need to pass through several other steps, also
 * they may be asked to update their details or provide extra details". Earlier the same day the
 * owner asked for things to be kept simple, so this is a short list and one sentence, not a
 * dashboard.
 *
 * Both surfaces a candidate can use — the web link (`PublicRegistration.tsx`) and the phone app
 * (`RegistrationStatus.tsx`) — draw the same steps from here, in the same words: the web page reads
 * the English below directly, and the phone app's catalogue points its keys at these same objects,
 * so a translation there is keyed by the same step and nothing is written out twice.
 *
 * Two halves, split by where the facts are allowed to live:
 *
 *  - `candidateJourneyStage` runs on the SERVER. It turns the assayer's lifecycle into one of the
 *    candidate's steps. The raw lifecycle never leaves the server, because the public link is
 *    unauthenticated and the lifecycle's side roads (INACTIVE with BGV_FAILED, APPROVAL_REJECTED)
 *    would tell whoever holds the link how a background check or an approval came out.
 *  - `candidateJourney` runs on the PAGE. It lays the steps out as done, current or ahead, and
 *    picks the one sentence about what happens next.
 */

/** The steps, in the order a candidate walks them. */
export const CANDIDATE_JOURNEY_STEPS = [
  'SENT',
  'FORM_CHECK',
  'DOCUMENTS',
  'BACKGROUND',
  'APPROVAL',
  'TRAINING',
  'READY',
] as const;

export type CandidateJourneyStep = (typeof CANDIDATE_JOURNEY_STEPS)[number];

/**
 * The steps that happen after approval — the ones the server reports from the assayer's record.
 * Before approval the application's own status says where they are, and the page needs nothing more.
 */
export type CandidateJourneyStage = Extract<CandidateJourneyStep, 'DOCUMENTS' | 'BACKGROUND' | 'APPROVAL' | 'TRAINING' | 'READY'>;

/**
 * Each step's name, in the candidate's words rather than HR's.
 *
 * Training says "if needed" because it may not happen: since 2026-09-24 the person giving the final
 * approval can send somebody to training or straight to work. Nothing on this page may promise it.
 */
export const CANDIDATE_JOURNEY_STEP_WORDS = {
  SENT: 'Form sent',
  FORM_CHECK: 'HR checks your form',
  DOCUMENTS: 'Documents checked',
  BACKGROUND: 'Background check',
  APPROVAL: 'Final approval',
  TRAINING: 'Training, if needed',
  READY: 'Ready to start work',
} as const satisfies Record<CandidateJourneyStep, string>;

/** Which "what happens next" sentence a journey ends with. */
export type CandidateJourneyNext = Exclude<CandidateJourneyStep, 'SENT'> | 'UNKNOWN';

/**
 * The one sentence under the steps: what is happening now, and whether they need to do anything.
 *
 * `UNKNOWN` is for an approved application whose stage the server did not say (an older server,
 * or a record it could not read) — it promises nothing it cannot see.
 */
export const CANDIDATE_JOURNEY_NEXT_WORDS = {
  FORM_CHECK: 'HR is checking your form. If anything needs changing, this link will open your form again for you.',
  DOCUMENTS: 'HR is checking your documents. You do not need to do anything unless HR asks.',
  BACKGROUND: 'A background check is being done. It can take a few days. You do not need to do anything.',
  APPROVAL: 'A senior manager gives the final approval. After that you do training if it is needed, or start work straight away.',
  TRAINING: 'You are in training. HR will tell you when you can start work.',
  READY: 'You are ready to start work. Sign in to the appraiser app to see your jobs.',
  UNKNOWN: 'HR will call you about the next steps.',
} as const satisfies Record<CandidateJourneyNext, string>;

/**
 * The rest of what the journey says: the paused line, and the headings of the two kinds of ask.
 *
 * The paused line is deliberately the same whatever paused them. A background check that did not
 * pass and an approval that was refused are HR's conversation to have, by phone, with the person —
 * not something a link anybody might be holding should announce.
 */
export const CANDIDATE_JOURNEY_WORDS = {
  /** What the list of steps is called, for a screen reader. */
  stepsLabel: 'Your steps to joining',
  pausedTitle: 'Your joining is paused.',
  pausedBody: 'HR will contact you.',
  /** Above the list of what HR sent back on the form — the form itself is open below it. */
  fixHeading: 'HR has asked you to fix these:',
  /** Above the documents HR asked for again after approval. */
  resendHeading: 'HR has asked you to send these again:',
  /** When HR's ask carries no sentence of its own. */
  resendFallback: 'Please send a clear copy again.',
  /**
   * How to answer a send-again ask. After approval the link is read-only — the record is theirs to
   * change only behind a sign-in — so the answer is the appraiser app's "Your papers" list, or HR.
   */
  resendHowOnWeb: 'Open the appraiser app, sign in, and send them from Your papers. HR can also add them for you.',
  resendHowInApp: 'Sign in to this app and send them from Your papers. HR can also add them for you.',
  /**
   * An EXPIRED link (owner, 2026-09-24: "status-only after expiry"). It still shows where they have
   * got to, and says it can do nothing else.
   */
  progressOnly: 'This link now only shows your progress. To change anything, ask HR.',
  /** A form HR sent back, behind an expired link: what was asked is listed, and the form cannot open. */
  expiredFixTitle: 'HR has asked you to fix a few things.',
  expiredFixBody: 'This link has expired, so the form cannot be opened here. Ask HR to send you a new link — what you already gave is kept.',
} as const;

/** One document HR has asked an approved candidate to send again. */
export interface CandidateAsk {
  /** The `OnboardingDocument` value — a key, never shown. */
  requirement: string;
  /** The document's name, as the rest of the product names it. */
  label: string;
  /** HR's own sentence, or the send-back guidance when they wrote none. */
  note: string | null;
}

/**
 * What the public registration link reports about an approved candidate. Everything it may say, and
 * nothing it may not: a step, whether they are paused, and the documents they have been asked for.
 */
export interface CandidateJourneyProgress {
  /** Their step; null while paused, which says where they stopped to nobody. */
  stage: CandidateJourneyStage | null;
  paused: boolean;
  asks: CandidateAsk[];
}

/**
 * Where each lifecycle value sits on the candidate's road.
 *
 * INVITED is here although an approved application moves on from it at once: a promotion that was
 * retried, or a rehire, can leave somebody there, and they are then waiting for their documents to
 * be checked like anybody else. ON_LEAVE is somebody already at work.
 *
 * Every value NOT here is a side road — INACTIVE (whatever the reason), SUSPENDED, RESIGNED,
 * TERMINATED, ARCHIVED — and reads as paused.
 */
const STAGE_BY_LIFECYCLE: Partial<Record<AssayerLifecycleStatus, CandidateJourneyStage>> = {
  [AssayerLifecycleStatus.INVITED]: 'DOCUMENTS',
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: 'DOCUMENTS',
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: 'BACKGROUND',
  [AssayerLifecycleStatus.FINAL_APPROVAL]: 'APPROVAL',
  [AssayerLifecycleStatus.TRAINING]: 'TRAINING',
  [AssayerLifecycleStatus.ACTIVE]: 'READY',
  [AssayerLifecycleStatus.ON_LEAVE]: 'READY',
};

/**
 * The candidate's step for an assayer's lifecycle status — server side only.
 *
 * Takes no unavailable reason on purpose. Every INACTIVE reads the same, so the answer for somebody
 * whose background check failed cannot differ from the answer for somebody refused at approval, or
 * parked for any other reason: there is nothing in it to tell them apart.
 */
export function candidateJourneyStage(lifecycleStatus: string | null | undefined): Pick<CandidateJourneyProgress, 'stage' | 'paused'> {
  const stage = lifecycleStatus ? STAGE_BY_LIFECYCLE[lifecycleStatus as AssayerLifecycleStatus] : undefined;
  return stage ? { stage, paused: false } : { stage: null, paused: true };
}

const STAGES: readonly string[] = CANDIDATE_JOURNEY_STEPS;

/**
 * Read the journey off an API response, or null.
 *
 * The response is not trusted to have one: an older server sends none, and the mobile and web
 * services do not declare it. Anything malformed is dropped rather than half-shown.
 */
export function readCandidateJourneyProgress(raw: unknown): CandidateJourneyProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const paused = row.paused === true;
  const stage = typeof row.stage === 'string' && STAGES.includes(row.stage) && row.stage !== 'SENT' && row.stage !== 'FORM_CHECK'
    ? (row.stage as CandidateJourneyStage)
    : null;
  if (!paused && !stage) return null;
  const asks: CandidateAsk[] = [];
  for (const entry of Array.isArray(row.asks) ? row.asks : []) {
    if (!entry || typeof entry !== 'object') continue;
    const ask = entry as Record<string, unknown>;
    if (typeof ask.requirement !== 'string' || !ask.requirement) continue;
    if (typeof ask.label !== 'string' || !ask.label.trim()) continue;
    asks.push({
      requirement: ask.requirement,
      label: ask.label.trim(),
      note: typeof ask.note === 'string' && ask.note.trim() ? ask.note.trim() : null,
    });
  }
  // A paused journey names no step and asks for nothing — see `CANDIDATE_JOURNEY_WORDS`.
  return paused ? { stage: null, paused: true, asks: [] } : { stage, paused: false, asks };
}

export type CandidateStepState = 'done' | 'current' | 'ahead';

export interface CandidateJourneyView {
  /** Empty while paused: a paused journey does not say where it stopped. */
  steps: Array<{ step: CandidateJourneyStep; state: CandidateStepState }>;
  /** Which `CANDIDATE_JOURNEY_NEXT_WORDS` sentence to end with; null while paused. */
  next: CandidateJourneyNext | null;
  paused: boolean;
  /** What HR has asked them to send again — shown first, above everything else. */
  asks: CandidateAsk[];
}

/**
 * The journey a finished application shows, or null for a status that has a screen of its own.
 *
 * Submitted: the form is sent and HR is checking it. Approved: wherever the server says the record
 * is. A draft or a sent-back form is the form itself (its asks are the form's own list); a rejected
 * or withdrawn application has no road left to show.
 */
export function candidateJourney(
  applicationStatus: ApplicationStatus | string,
  progress: CandidateJourneyProgress | null,
): CandidateJourneyView | null {
  let current: CandidateJourneyStep | null;
  let next: CandidateJourneyNext;
  if (applicationStatus === ApplicationStatus.PENDING_VALIDATION) {
    current = 'FORM_CHECK';
    next = 'FORM_CHECK';
  } else if (applicationStatus === ApplicationStatus.APPROVED) {
    if (progress?.paused) return { steps: [], next: null, paused: true, asks: [] };
    current = progress?.stage ?? null;
    next = current ?? 'UNKNOWN';
  } else {
    return null;
  }

  // With no stage from the server, an approved application has certainly passed HR's form check
  // and nothing further is claimed.
  const reached = current ? CANDIDATE_JOURNEY_STEPS.indexOf(current) : CANDIDATE_JOURNEY_STEPS.indexOf('FORM_CHECK') + 1;
  const steps = CANDIDATE_JOURNEY_STEPS.map((step, at) => ({
    step,
    state: (at < reached ? 'done' : at === reached && current ? 'current' : 'ahead') as CandidateStepState,
  }));
  return {
    steps,
    next,
    paused: false,
    asks: applicationStatus === ApplicationStatus.APPROVED ? progress?.asks ?? [] : [],
  };
}
