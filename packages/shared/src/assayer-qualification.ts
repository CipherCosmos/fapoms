import { EmpanelmentStatus } from './assayer-roster-vocabulary';

/**
 * The qualification vocabulary — one list of dimensions, shared by the backend that computes
 * them, the web page that shows them, and the printable profile that leaves the building.
 *
 * A dimension is a 0–100 judgment about one aspect of an assayer, computed from data the
 * roster already keeps (see `qualification-score.contract.ts` for the formulas). `null` is a
 * first-class value everywhere in this model and it means "not yet assessed" — no background
 * check on file is not a bad background check, and rendering it as 0 would slander everyone
 * the vetting team simply hasn't reached yet. Screens show nulls as a chip, never as a number.
 *
 * The pattern follows `assayer-record.ts`: keys and labels defined once here, with a spec on
 * each side pinning that nobody drifts.
 */

export type QualificationDimensionKey =
  | 'identityVerification'
  | 'payability'
  | 'backgroundCheck'
  | 'references'
  | 'credentials'
  | 'trackRecord'
  /** Only present on per-partner scores: how much of THAT client's required list is met. */
  | 'partnerRequirements';

export interface QualificationDimensionDef {
  key: QualificationDimensionKey;
  label: string;
  /** One sentence a non-technical operator reads to know what the number measures. */
  meaning: string;
  /** The settings-registry key holding this dimension's relative weight. */
  weightSetting: string;
  /** Default relative weight (weights are normalized over the dimensions present). */
  defaultWeight: number;
  /** Whether the dimension participates in the base profile score or only partner scores. */
  scope: 'profile' | 'partner';
}

export const QUALIFICATION_DIMENSIONS: readonly QualificationDimensionDef[] = [
  {
    key: 'identityVerification',
    label: 'Identity verification',
    meaning: 'How much of their identity paperwork is on file, verified and unexpired.',
    weightSetting: 'qualification.weight.identityVerification',
    defaultWeight: 20,
    scope: 'profile',
  },
  {
    key: 'payability',
    label: 'Record completeness',
    meaning: 'Whether the critical record fields — phone, PAN, bank, location — are filled in.',
    weightSetting: 'qualification.weight.payability',
    defaultWeight: 15,
    scope: 'profile',
  },
  {
    key: 'backgroundCheck',
    label: 'Background check',
    meaning: 'The verdict and risk grade of their most recent background check, aged over time.',
    weightSetting: 'qualification.weight.backgroundCheck',
    defaultWeight: 25,
    scope: 'profile',
  },
  {
    key: 'references',
    label: 'References',
    meaning: 'How many of their referees have actually been called and checked.',
    weightSetting: 'qualification.weight.references',
    defaultWeight: 10,
    scope: 'profile',
  },
  {
    key: 'credentials',
    label: 'Skills & certifications',
    meaning: 'The skills on record and whether their certifications are current.',
    weightSetting: 'qualification.weight.credentials',
    defaultWeight: 15,
    scope: 'profile',
  },
  {
    key: 'trackRecord',
    label: 'Track record',
    meaning: 'Completed work, punctuality, acceptance behaviour and staff remarks.',
    weightSetting: 'qualification.weight.trackRecord',
    defaultWeight: 15,
    scope: 'profile',
  },
  {
    key: 'partnerRequirements',
    label: 'Partner requirements',
    meaning: "How much of this partner's own required skills and certifications they hold.",
    weightSetting: 'qualification.weight.partnerRequirements',
    defaultWeight: 25,
    scope: 'partner',
  },
] as const;

export const PROFILE_DIMENSION_KEYS = QUALIFICATION_DIMENSIONS
  .filter((d) => d.scope === 'profile')
  .map((d) => d.key);

/** A dimension key, or 'overall' — the two things an override may address. */
export type OverridableScoreKey = QualificationDimensionKey | 'overall';

export interface ScoreOverrideView {
  id: string;
  value: number;
  reason: string;
  setBy: string | null;
  setByName: string | null;
  setAt: string;
}

/**
 * One computed dimension as the API serves it. `computed` is what the data says; `override`
 * is a human's stated correction (never a silent replacement — both always travel together);
 * `effective` is what downstream consumers should use.
 */
export interface DimensionScoreView {
  key: QualificationDimensionKey;
  label: string;
  computed: number | null;
  override: ScoreOverrideView | null;
  effective: number | null;
  /** Plain-language atoms explaining the number ("PAN verified", "2 of 3 references checked"). */
  basis: string[];
}

export interface AssayerQualificationView {
  assayerId: string;
  dimensions: DimensionScoreView[];
  overall: { computed: number | null; override: ScoreOverrideView | null; effective: number | null };
  /** The relative weights used, after settings resolution — shown so a score is never a mystery. */
  weights: Record<string, number>;
  computedAt: string;
}

/**
 * Empanelment standing caps a partner score; it does not feed the weighted mean.
 *
 * A REJECTED empanelment is not "one weak dimension among seven" — the partner has said no,
 * and averaging that away would let a strong track record disguise it. The cap states the
 * ceiling plainly; the standing and its reason travel beside the number.
 *
 * ACTIVE, RECOMMENDED and "no row yet" carry no cap: absence of a decision must score the
 * same as today's behaviour, where empanelment feeds planning nothing.
 */
export const DEFAULT_STANDING_CAP_NEGATIVE = 25;
export const DEFAULT_STANDING_CAP_DORMANT = 49;
export const DEFAULT_STANDING_CAP_DOCUMENTS_PENDING = 69;

/**
 * The cap levels are operator policy, not code: the backend resolves them from the settings
 * registry (`qualification.cap.*`) and builds the map through this function — the constants
 * above are only what a fresh install starts with.
 */
export function empanelmentCapsFrom(
  negative: number = DEFAULT_STANDING_CAP_NEGATIVE,
  dormant: number = DEFAULT_STANDING_CAP_DORMANT,
  documentsPending: number = DEFAULT_STANDING_CAP_DOCUMENTS_PENDING,
): Partial<Record<EmpanelmentStatus, number>> {
  return {
    [EmpanelmentStatus.REJECTED]: negative,
    [EmpanelmentStatus.TERMINATED]: negative,
    [EmpanelmentStatus.NOT_RECOMMENDED]: negative,
    [EmpanelmentStatus.RESIGNED]: dormant,
    [EmpanelmentStatus.INACTIVE]: dormant,
    [EmpanelmentStatus.DOCUMENTS_PENDING]: documentsPending,
  };
}

export const EMPANELMENT_SCORE_CAPS: Partial<Record<EmpanelmentStatus, number>> = empanelmentCapsFrom();

export interface PartnerQualificationView {
  client: { id: string; name: string; clientCode: string | null };
  dimensions: DimensionScoreView[];
  computed: number | null;
  /** After the standing cap (and any override on 'overall' for this client). */
  effective: number | null;
  override: ScoreOverrideView | null;
  standing: EmpanelmentStatus | null;
  standingReason: string | null;
  /** The cap applied, when one was ("capped at 25 — empanelment REJECTED"). */
  standingCap: number | null;
  /** Barred outright via the client's restricted list — hard zero, not a cap. */
  barred: boolean;
  /** What to fix to raise the score — missing certs, unverified documents, a stale check. */
  gaps: string[];
}

/**
 * Mask an identifier to its last N characters: `maskTail('ABCDE1234F')` → `'******234F'`.
 *
 * The printable profile leaves the building; PAN and Aadhaar must not. Last-4 is enough for
 * the receiving partner to match a document they were handed separately, and no more. Blank
 * in, blank out — a missing number must print as missing, never as a row of stars.
 */
export function maskTail(value: string | null | undefined, keep = 4): string {
  const v = (value ?? '').trim();
  if (!v) return '';
  if (v.length <= keep) return '*'.repeat(v.length);
  return '*'.repeat(v.length - keep) + v.slice(-keep);
}

/**
 * Is this string something `maskTail` produced rather than a real identifier?
 *
 * The API now masks PAN, Aadhaar and bank account on every read, and the web edit form posts
 * back whichever keys changed. Nothing stopped `******234F` making the return trip and being
 * saved as the person's PAN — the encryption at rest would then be protecting a row of stars,
 * with the real number gone and no copy of it anywhere.
 *
 * The test is "contains one covering character", not a precise shape, and deliberately so. The
 * mask length varies with the value and with `keep`, a client may trim or re-pad the stars, and a
 * partly edited field ("*****1234F") matches no fixed pattern at all — whereas NO legitimate PAN,
 * Aadhaar, bank account or document number contains one of these characters in the first place.
 * Anything that does is a display value someone tried to write back.
 *
 * The bullets are here because a mask is not always drawn with the character `maskTail` writes:
 * the web roster covers these fields with `•` when it prints them, and it posts back the keys the
 * operator changed. So this is the one definition both ends of the guard read — the web app
 * re-exports it as the check it runs before sending, rather than keeping a second rule of its own
 * that had already drifted (it wanted three covering characters where this wants one, so the mask
 * of a five-character account number, `*2345`, was a mask one end refused and the other did not
 * recognise). Widening it costs nothing real: a write carrying a bullet was never a number either.
 */
export function looksMasked(value: string | null | undefined): boolean {
  return /[*•·●]/.test(value ?? '');
}
