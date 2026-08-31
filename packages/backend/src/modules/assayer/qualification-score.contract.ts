import {
  BackgroundCheckVerdict,
  RiskGrade,
  EmpanelmentStatus,
  EMPANELMENT_SCORE_CAPS,
  QUALIFICATION_DIMENSIONS,
  QualificationDimensionKey,
  CRITICAL_ASSAYER_RECORD_FIELDS,
  missingAssayerRecordFields,
} from '@fapoms/shared';
import { RemarkSummary, remarksScoreFrom } from '../assayer-remarks/assayer-remark.contract';

/**
 * The qualification formulas — pure functions from roster data to 0–100 judgments.
 *
 * The shape follows `assayer-remark.contract.ts`: every function is deterministic, bounded by
 * construction, and pinned by `qualification-score.contract.spec.ts` so a formula cannot drift
 * without a failing test saying so. Inputs are structural (plain fields, not entities) so the
 * spec feeds literal objects and the service feeds dossier rows — same numbers, one source.
 *
 * `null` means "not yet assessed" and is contagious upward in exactly one way: a dimension
 * with no data returns null, and the weighted mean skips it (re-normalizing over what is
 * present). It is never coerced to 0 — an unvetted person is unknown, not disqualified.
 */

export interface ScoredDimension {
  key: QualificationDimensionKey;
  score: number | null;
  basis: string[];
}

const round1 = (n: number): number => Number(n.toFixed(1));
const clamp100 = (n: number): number => Math.max(0, Math.min(100, n));

// ── Identity verification ───────────────────────────────────────────────────

export interface IdentityDocInput {
  /** From the dossier checklist: true when the requirement is an identity document. */
  identity: boolean;
  /** Null when no row exists — the document was never received at all. */
  id: string | null;
  label: string;
  verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED' | null;
  expiryDate: string | Date | null;
}

/**
 * Mean over the identity documents ON FILE — deliberately not over the full identity list.
 *
 * The eight identity requirements are alternatives, not a checklist: a person proves who they
 * are with Aadhaar + PAN, or a passport, or a driving licence — nobody holds all eight, and
 * averaging over the absent alternatives would cap an impeccably-verified person near 25.
 * What this measures is: of the identity paperwork this person DID submit, how much has the
 * vetting team verified, and is it still in date.
 *
 * Per document: VERIFIED and unexpired = 100 · on file but PENDING = 50 · VERIFIED but past
 * expiry = 50 (it proved identity once; it needs renewing) · REJECTED = 0. Nothing on file at
 * all → null ("not yet assessed"), never zero.
 */
export function identityVerificationScore(docs: IdentityDocInput[], now: Date = new Date()): ScoredDimension {
  const onFile = docs.filter((d) => d.identity && d.id !== null);
  if (onFile.length === 0) {
    return { key: 'identityVerification', score: null, basis: ['No identity documents on file yet.'] };
  }
  const basis: string[] = [];
  let sum = 0;
  for (const d of onFile) {
    const expired = d.expiryDate != null && new Date(d.expiryDate).getTime() < now.getTime();
    let points: number;
    if (d.verificationStatus === 'VERIFIED' && !expired) {
      points = 100;
      basis.push(`${d.label}: verified`);
    } else if (d.verificationStatus === 'VERIFIED' && expired) {
      points = 50;
      basis.push(`${d.label}: verified but expired — needs renewal`);
    } else if (d.verificationStatus === 'REJECTED') {
      points = 0;
      basis.push(`${d.label}: rejected at verification`);
    } else {
      points = 50;
      basis.push(`${d.label}: on file, awaiting verification`);
    }
    sum += points;
  }
  return { key: 'identityVerification', score: round1(sum / onFile.length), basis };
}

// ── Record completeness / payability ────────────────────────────────────────

/**
 * The share of CRITICAL record fields present, from the same rubric the roster screens use
 * (`ASSAYER_RECORD_FIELDS`). Never null: the rubric always answers, and an empty record is
 * genuinely a 0 — there is nothing "unassessed" about a missing bank account. The basis names
 * what each missing field blocks, in the rubric's own words ("Payouts", "TDS deduction…").
 */
export function payabilityScore(assayer: Record<string, unknown>): ScoredDimension {
  const missing = missingAssayerRecordFields(assayer as any);
  const total = CRITICAL_ASSAYER_RECORD_FIELDS.length;
  const present = total - missing.length;
  // Non-critical gaps inform but do not score: the critical set is the rubric's own judgment
  // of what matters, and averaging in the long tail would drown it.
  const basis = missing.length === 0
    ? ['Every critical record field is filled in.']
    : missing.map((f) => `${f.label} missing — blocks: ${f.blocks.toLowerCase()}`);
  return { key: 'payability', score: round1((100 * present) / total), basis };
}

// ── Background check ────────────────────────────────────────────────────────

export interface BackgroundCheckInput {
  verdict: BackgroundCheckVerdict | string;
  riskGrade: RiskGrade | string | null;
  cibilBand: string | null;
  cibilScore: number | null;
  checkedOn: string | Date | null;
}

const VERDICT_BASE: Record<string, number> = {
  [BackgroundCheckVerdict.CLEAR]: 100,
  [BackgroundCheckVerdict.ADVERSE_FINDING]: 40,
  [BackgroundCheckVerdict.CIVIL_CASE]: 25,
  [BackgroundCheckVerdict.CRIMINAL_CASE]: 0,
};

const RISK_PENALTY: Record<string, number> = {
  [RiskGrade.LOW]: 0,
  [RiskGrade.MEDIUM]: 10,
  [RiskGrade.HIGH]: 30,
  [RiskGrade.VERY_HIGH]: 50,
};

/**
 * The most recent check's verdict, discounted by risk grade, halved once it goes stale.
 *
 * CIBIL is shown in the basis but deliberately not scored: the band already informed the
 * recorded risk grade, and scoring both would count one bureau pull twice. Staleness halves
 * rather than nulls — an old CLEAR still says something, just not enough to lean on.
 */
export function backgroundCheckScore(
  check: BackgroundCheckInput | null,
  validityMonths: number,
  now: Date = new Date(),
): ScoredDimension {
  if (!check || check.verdict === BackgroundCheckVerdict.NOT_CHECKED || !(check.verdict in VERDICT_BASE)) {
    return { key: 'backgroundCheck', score: null, basis: ['No background check on file yet.'] };
  }
  const basis: string[] = [`Verdict: ${String(check.verdict).replace(/_/g, ' ').toLowerCase()}`];
  let score = VERDICT_BASE[check.verdict as string];
  const penalty = check.riskGrade != null ? RISK_PENALTY[check.riskGrade as string] ?? 0 : 0;
  if (penalty > 0) basis.push(`Risk grade ${String(check.riskGrade).replace(/_/g, ' ').toLowerCase()} (−${penalty})`);
  score = clamp100(score - penalty);

  if (check.cibilBand) basis.push(`CIBIL: ${check.cibilBand.replace(/_/g, ' ').toLowerCase()}${check.cibilScore ? ` (${check.cibilScore})` : ''} — informational, not scored`);

  const checkedAt = check.checkedOn ? new Date(check.checkedOn).getTime() : NaN;
  const validMs = validityMonths * 30.44 * 86_400_000;
  if (!Number.isFinite(checkedAt) || now.getTime() - checkedAt > validMs) {
    score = score / 2;
    basis.push(`Check is stale (older than ${validityMonths} months) — re-check due, score halved`);
  }
  return { key: 'backgroundCheck', score: round1(score), basis };
}

// ── References ──────────────────────────────────────────────────────────────

export interface ReferenceInput {
  fullName: string;
  checkedAt: string | Date | null;
}

/**
 * `target` checked references = full marks (a settings knob, default 2 — resolved by the
 * service from `qualification.referencesTarget`). Referees merely recorded but never called
 * count for nothing — the dimension measures the calls, not the paperwork. No referees on
 * file at all → null.
 */
export function referencesScore(refs: ReferenceInput[], target = 2): ScoredDimension {
  if (refs.length === 0) {
    return { key: 'references', score: null, basis: ['No referees on file yet.'] };
  }
  const effectiveTarget = Number.isFinite(target) && target > 0 ? target : 2;
  const checked = refs.filter((r) => r.checkedAt != null).length;
  const unchecked = refs.length - checked;
  const basis = [`${checked} of ${refs.length} referee${refs.length === 1 ? '' : 's'} checked`];
  if (unchecked > 0) basis.push(`${unchecked} awaiting a call`);
  return { key: 'references', score: round1(100 * Math.min(1, checked / effectiveTarget)), basis };
}

// ── Credentials ─────────────────────────────────────────────────────────────

export interface AttributeInput {
  type: 'SKILL' | 'CERTIFICATION' | 'LANGUAGE' | string;
  name: string;
  expiryDate: string | Date | null;
}

/**
 * Mean of the sub-signals that exist: breadth of skills (20 points each, capped at five) and
 * currency of certifications (share still in date). A person with neither on record is
 * unassessed, not unskilled — the roster simply hasn't recorded them.
 */
export function credentialsScore(attributes: AttributeInput[], now: Date = new Date()): ScoredDimension {
  const skills = attributes.filter((a) => a.type === 'SKILL');
  const certs = attributes.filter((a) => a.type === 'CERTIFICATION');
  const signals: number[] = [];
  const basis: string[] = [];

  if (skills.length > 0) {
    signals.push(Math.min(100, 20 * skills.length));
    basis.push(`${skills.length} skill${skills.length === 1 ? '' : 's'} on record`);
  }
  if (certs.length > 0) {
    const valid = certs.filter((c) => c.expiryDate == null || new Date(c.expiryDate).getTime() >= now.getTime());
    const lapsed = certs.length - valid.length;
    signals.push((100 * valid.length) / certs.length);
    basis.push(`${valid.length} of ${certs.length} certification${certs.length === 1 ? '' : 's'} current`);
    if (lapsed > 0) basis.push(`${lapsed} certification${lapsed === 1 ? '' : 's'} lapsed`);
  }
  if (signals.length === 0) {
    return { key: 'credentials', score: null, basis: ['No skills or certifications recorded yet.'] };
  }
  return { key: 'credentials', score: round1(signals.reduce((a, b) => a + b, 0) / signals.length), basis };
}

// ── Track record ────────────────────────────────────────────────────────────

export interface TrackRecordInput {
  totalAssignments: number;
  completedAssignments: number;
  onTimeCompletions: number;
  /** 0–100, computed the way getProfile computes it. */
  acceptanceRate: number | null;
  remarkSummary: RemarkSummary | null;
}

/**
 * Mean of the signals that exist: completion rate, on-time rate, acceptance rate, and the
 * remarks score. Zero assignments → null — deliberately ignoring the columns' flattering
 * defaults (performanceRating 5.00, acceptance 100-with-no-history), which would hand a
 * perfect track record to someone who has never been offered work.
 */
export function trackRecordScore(input: TrackRecordInput): ScoredDimension {
  const total = Number(input.totalAssignments) || 0;
  if (total <= 0) {
    return { key: 'trackRecord', score: null, basis: ['No work history yet.'] };
  }
  const completed = Number(input.completedAssignments) || 0;
  const signals: number[] = [];
  const basis: string[] = [];

  signals.push((100 * completed) / total);
  basis.push(`${completed} of ${total} assignments completed`);

  if (completed > 0) {
    const onTime = Number(input.onTimeCompletions) || 0;
    signals.push((100 * onTime) / completed);
    basis.push(`${onTime} of ${completed} completed on time`);
  }
  if (input.acceptanceRate != null && Number.isFinite(Number(input.acceptanceRate))) {
    signals.push(clamp100(Number(input.acceptanceRate)));
    basis.push(`${Math.round(Number(input.acceptanceRate))}% of offers accepted`);
  }
  if (input.remarkSummary && input.remarkSummary.weightedMean !== null) {
    signals.push(remarksScoreFrom(input.remarkSummary));
    basis.push(`${input.remarkSummary.count} staff remark${input.remarkSummary.count === 1 ? '' : 's'} in the last year`);
  }
  return { key: 'trackRecord', score: round1(signals.reduce((a, b) => a + b, 0) / signals.length), basis };
}

// ── Partner requirements ────────────────────────────────────────────────────

/**
 * The share of THIS partner's required skills and certifications the assayer holds — the same
 * `requiredSkills`/`requiredCertifications` lists the planning engine's client-preference
 * scorer reads, matched case-insensitively. A partner that lists no requirements has expressed
 * none, so the dimension is null for them (not a free 100).
 */
export function partnerRequirementsScore(
  required: { skills: string[]; certifications: string[] },
  held: { skills: string[]; certifications: string[] },
): ScoredDimension {
  const wanted = [
    ...required.skills.map((s) => ({ kind: 'skill', name: s })),
    ...required.certifications.map((c) => ({ kind: 'certification', name: c })),
  ];
  if (wanted.length === 0) {
    return { key: 'partnerRequirements', score: null, basis: ['This partner lists no specific requirements.'] };
  }
  const heldSet = new Set([...held.skills, ...held.certifications].map((s) => s.toLowerCase().trim()));
  const missing = wanted.filter((w) => !heldSet.has(w.name.toLowerCase().trim()));
  const matched = wanted.length - missing.length;
  const basis = [`Meets ${matched} of ${wanted.length} listed requirement${wanted.length === 1 ? '' : 's'}`];
  for (const m of missing) basis.push(`Missing required ${m.kind}: ${m.name}`);
  return { key: 'partnerRequirements', score: round1((100 * matched) / wanted.length), basis };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Weighted mean over the dimensions that HAVE a score, weights re-normalized over what is
 * present — the same null-skipping discipline the recommendation engine's aggregation uses.
 * Everything null → null: a wholly unassessed person has no number, and printing one would be
 * fake precision.
 */
export function overallScore(
  dimensions: Array<{ key: QualificationDimensionKey; score: number | null }>,
  weights: Record<string, number>,
): number | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const d of dimensions) {
    if (d.score === null) continue;
    const w = Number(weights[d.key]) || 0;
    weighted += d.score * w;
    totalWeight += w;
  }
  if (totalWeight <= 0) return null;
  return round1(weighted / totalWeight);
}

/** The default weights, from the shared vocabulary — the settings registry overrides these. */
export function defaultWeights(): Record<string, number> {
  return Object.fromEntries(QUALIFICATION_DIMENSIONS.map((d) => [d.key, d.defaultWeight]));
}

/**
 * Apply the empanelment standing's ceiling to a computed partner score. The cap is a ceiling,
 * never a floor — a score already below it passes through untouched. No standing, or a
 * standing without a cap (ACTIVE, RECOMMENDED), changes nothing.
 */
export function applyStandingCap(
  computed: number | null,
  standing: EmpanelmentStatus | null,
  caps: Partial<Record<EmpanelmentStatus, number>> = EMPANELMENT_SCORE_CAPS,
): { effective: number | null; cap: number | null } {
  if (computed === null || standing === null) return { effective: computed, cap: null };
  const cap = caps[standing];
  if (cap === undefined) return { effective: computed, cap: null };
  return { effective: Math.min(computed, cap), cap };
}
