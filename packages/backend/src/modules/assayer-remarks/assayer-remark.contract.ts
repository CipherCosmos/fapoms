import { SystemRole } from '@fapoms/shared';

/**
 * What a remark is about. Kept deliberately short: a long taxonomy is one nobody fills in
 * consistently, and the scorer does not weight categories differently — the category is for the
 * reader, the rating is for the engine.
 */
export enum AssayerRemarkCategory {
  QUALITY = 'QUALITY',
  PUNCTUALITY = 'PUNCTUALITY',
  CONDUCT = 'CONDUCT',
  PAPERWORK = 'PAPERWORK',
  COMMUNICATION = 'COMMUNICATION',
  OTHER = 'OTHER',
}

/** Rating bounds. The DB CHECK constraint enforces the same range; the DTO validates it first. */
export const REMARK_RATING_MIN = -2;
export const REMARK_RATING_MAX = 2;
/** A remark is a note, not a report. */
export const REMARK_TEXT_MAX = 1000;

/**
 * Who may write a remark: the desks that actually deal with an assayer's work.
 *
 * Operations dispatches and phones them; the validation desk and data-entry read every page of
 * paperwork they hand in; HR owns the employment record; managers and administrators oversee
 * all of it. Listed most-senior first because `snapshotAuthorRole` picks the first match as the
 * role to record against a multi-role author.
 *
 * Deliberately NOT here: ASSAYER (a field worker rating themselves or a colleague is not a
 * staff observation), CLIENT_USER (client feedback is a different channel with a different
 * weight), READ_ONLY_AUDITOR (read-only by definition), PRODUCT_SUPPORT (the product team has
 * no view of anyone's fieldwork).
 */
export const REMARK_WRITE_ROLES: SystemRole[] = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.HR_MANAGER,
  SystemRole.OPERATIONS_MANAGER,
  SystemRole.VALIDATION_MANAGER,
  SystemRole.FINANCE_MANAGER,
  SystemRole.OPERATIONS_EXECUTIVE,
  SystemRole.VALIDATOR,
  SystemRole.DATA_ENTRY_HEAD,
  SystemRole.DOCUMENT_EXECUTIVE,
];

/**
 * Who may remove a remark they did not write. Authors may always retract their own.
 *
 * Moderation power, so narrower than the write list: the workforce owner (HR), the desk that
 * consumes remarks (operations management), and administrators.
 */
export const REMARK_MODERATE_ROLES: SystemRole[] = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.HR_MANAGER,
  SystemRole.OPERATIONS_MANAGER,
];

/**
 * How far back the scorer looks, and how fast a remark fades inside that window.
 *
 * 365 days: a remark older than a year says more about who the person was than who they are.
 * The decay `exp(-ageDays / 90)` gives a remark 37% of its weight at three months, 13% at six,
 * and 2% at a year — so last week's observation dominates last winter's, without last winter's
 * being erased on a fixed cliff-edge. Rejected: a hard "last N remarks" window, which lets one
 * busy month bury a serious concern, and a flat mean, under which a −2 from eleven months ago
 * weighs the same as one from yesterday.
 */
export const REMARK_SCORING_WINDOW_DAYS = 365;
export const REMARK_DECAY_DAYS = 90;

/**
 * Fairness: how many offers in the last 30 days it takes to score zero on rotation.
 *
 * Eight is roughly two offers a week. Below it the fairness score falls linearly from 100, at
 * or above it the candidate scores 0 on this dimension — and ONLY on this dimension, which is
 * 4% of the total. This is a nudge that breaks ties toward the person who has been sitting idle;
 * it is not a quota, and it never removes anyone from a list. Operator-adjustable as the
 * platform setting `planning.fairnessOfferCap`.
 */
export const DEFAULT_FAIRNESS_OFFER_CAP = 8;
export const FAIRNESS_OFFER_CAP_SETTING = 'planning.fairnessOfferCap';
export const FAIRNESS_OFFER_WINDOW_DAYS = 30;

/** The rows the scorer needs — a projection, so the batch load carries no more than this. */
export interface RemarkForScoring {
  rating: number | null;
  category: string;
  content: string;
  authorRole: string | null;
  authorName: string;
  createdAt: Date;
}

/** What each recommended candidate carries so the card can say "3 remarks · avg −0.7". */
export interface RemarkSummary {
  /** Rated remarks inside the scoring window. Unrated notes are not counted. */
  count: number;
  /** Recency-weighted mean rating in [-2, +2], null when count is 0. */
  weightedMean: number | null;
  /** The most recent rated remark, so the card can show what was actually said. */
  latest: {
    rating: number;
    category: string;
    text: string;
    authorRole: string | null;
    createdAt: string;
  } | null;
}

/**
 * Recency-weighted mean of the ratings, or null when there is nothing rated to average.
 *
 * Only remarks inside the scoring window count; the caller is expected to have loaded only
 * those, but the cut-off is applied again here so a caller that loads a wider set (the drawer,
 * say) gets the same number the engine does.
 */
export function summariseRemarks(rows: RemarkForScoring[], now: Date = new Date()): RemarkSummary {
  const windowStart = now.getTime() - REMARK_SCORING_WINDOW_DAYS * 86_400_000;
  let weightSum = 0;
  let weighted = 0;
  let count = 0;
  let latest: RemarkForScoring | null = null;

  for (const r of rows) {
    if (r.rating === null || r.rating === undefined) continue;
    const at = new Date(r.createdAt).getTime();
    if (!Number.isFinite(at) || at < windowStart) continue;
    // Clock skew or a remark written a moment ago: never a negative age.
    const ageDays = Math.max(0, (now.getTime() - at) / 86_400_000);
    const w = Math.exp(-ageDays / REMARK_DECAY_DAYS);
    // The rating is clamped defensively; the DB CHECK makes this a no-op on real rows.
    const rating = Math.max(REMARK_RATING_MIN, Math.min(REMARK_RATING_MAX, Number(r.rating)));
    weighted += w * rating;
    weightSum += w;
    count += 1;
    if (!latest || at > new Date(latest.createdAt).getTime()) latest = r;
  }

  if (count === 0 || weightSum <= 0) return { count: 0, weightedMean: null, latest: null };

  return {
    count,
    weightedMean: Number((weighted / weightSum).toFixed(3)),
    latest: latest
      ? {
          rating: Number(latest.rating),
          category: latest.category,
          text: latest.content,
          authorRole: latest.authorRole,
          createdAt: new Date(latest.createdAt).toISOString(),
        }
      : null,
  };
}

/**
 * The remarks score: `50 + 25 × weighted mean`.
 *
 * No remarks → 50, the same as every other "no signal" default in the engine. All +2 → 100,
 * all −2 → 0. Because the mean is itself bounded to [-2, +2] the score cannot leave [0, 100]
 * — there is no way for a run of remarks, however long or however harsh, to push a candidate
 * below zero on this dimension, and the dimension is one weighted term among seventeen. That
 * is what "influences but never excludes" means in numbers: the worst possible remark history
 * costs at most 6 points of the final score (weight 0.06 × 100).
 */
export function remarksScoreFrom(summary: RemarkSummary): number {
  if (summary.weightedMean === null) return 50;
  const score = 50 + 25 * summary.weightedMean;
  return Math.max(0, Math.min(100, Number(score.toFixed(2))));
}

/**
 * The fairness score: `100 × (1 − min(1, offers / cap))`.
 *
 * 0 recent offers → 100; cap or more → 0; linear between. A non-positive or non-finite cap is
 * treated as the default rather than dividing by zero.
 */
export function fairnessScoreFrom(recentOffers: number, cap: number = DEFAULT_FAIRNESS_OFFER_CAP): number {
  const effectiveCap = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_FAIRNESS_OFFER_CAP;
  const offers = Math.max(0, Number(recentOffers) || 0);
  const score = 100 * (1 - Math.min(1, offers / effectiveCap));
  return Math.max(0, Math.min(100, Number(score.toFixed(2))));
}

/**
 * Which of a multi-role author's roles to write on the remark: the most senior one that
 * authorised the write. A user who is both HR_MANAGER and VALIDATOR is recorded as HR_MANAGER.
 */
export function snapshotAuthorRole(roleNames: string[]): string | null {
  for (const role of REMARK_WRITE_ROLES) {
    if (roleNames.includes(role)) return role;
  }
  return roleNames[0] ?? null;
}
