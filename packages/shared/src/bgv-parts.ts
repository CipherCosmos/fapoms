import { CibilBand } from './assayer-roster-vocabulary';

/**
 * THE THREE PARTS OF A BACKGROUND VERIFICATION (owner, 2026-09-24: "address check (physical/digital),
 * cibil check, court check should present before making that done").
 *
 * The agency's report is not one finding but three: whether the person lives where they say (by a
 * visit, or checked digitally), what the credit bureau (CIBIL) holds on them, and whether any court
 * has a case against them. "Clear" is the summary of all three — so a background verification is
 * not recorded as clear until all three are on it, and not while one of them says otherwise (an
 * address that did not verify, a case in court).
 *
 * Only the background verification has parts. The police, credit and identity re-checks are one
 * finding each and are untouched by this.
 *
 * Pure and here, once: the server refuses with these words and the dialog says them first.
 */

export enum AddressCheckMethod {
  /** Somebody from the agency went to the address. */
  PHYSICAL = 'PHYSICAL',
  /** Checked without a visit — a geo-tagged confirmation, a postal or digital verification. */
  DIGITAL = 'DIGITAL',
}

export const ADDRESS_CHECK_METHOD_LABELS: Record<AddressCheckMethod, string> = {
  [AddressCheckMethod.PHYSICAL]: 'Physical visit',
  [AddressCheckMethod.DIGITAL]: 'Digital',
};

export enum AddressCheckResult {
  VERIFIED = 'VERIFIED',
  /** They are not at the address given, or it does not match what they declared. */
  DISCREPANCY = 'DISCREPANCY',
  /** The agency could not confirm it either way — nobody there, address not traceable. */
  UNABLE_TO_VERIFY = 'UNABLE_TO_VERIFY',
}

export const ADDRESS_CHECK_RESULT_LABELS: Record<AddressCheckResult, string> = {
  [AddressCheckResult.VERIFIED]: 'Address verified',
  [AddressCheckResult.DISCREPANCY]: 'Discrepancy found',
  [AddressCheckResult.UNABLE_TO_VERIFY]: 'Could not be verified',
};

export enum CourtCheckResult {
  NO_RECORD = 'NO_RECORD',
  CIVIL_CASE = 'CIVIL_CASE',
  CRIMINAL_CASE = 'CRIMINAL_CASE',
}

export const COURT_CHECK_RESULT_LABELS: Record<CourtCheckResult, string> = {
  [CourtCheckResult.NO_RECORD]: 'No case found',
  [CourtCheckResult.CIVIL_CASE]: 'Civil case found',
  [CourtCheckResult.CRIMINAL_CASE]: 'Criminal case found',
};

/**
 * The CIBIL answers that mean the bureau was asked and replied. "No credit history" is an answer —
 * a first-time borrower has no file. "Check failed" and "Not checked" are not: nobody knows yet.
 *
 * A poor or bad score is still an answer, and does not by itself stop a clear result: how much a
 * credit record matters is the approver's judgement, and they see the band and the score.
 */
export const CIBIL_ANSWERED_BANDS: readonly CibilBand[] = [
  CibilBand.GOOD, CibilBand.AVERAGE, CibilBand.POOR, CibilBand.BAD, CibilBand.NO_CREDIT_HISTORY,
];

/** The words for a CIBIL band — moved here from the vetting tab so the approver's review says the same. */
export const CIBIL_BAND_LABELS: Record<CibilBand, string> = {
  [CibilBand.GOOD]: 'Good',
  [CibilBand.AVERAGE]: 'Average',
  [CibilBand.POOR]: 'Poor',
  [CibilBand.BAD]: 'Bad',
  [CibilBand.NO_CREDIT_HISTORY]: 'No credit history',
  [CibilBand.NOT_CHECKED]: 'Not checked',
  [CibilBand.CHECK_FAILED]: 'Check failed',
};

/** "Good (747)", "No credit history" — or null when no band is on the check. */
export function cibilSummary(p: { cibilBand?: string | null; cibilScore?: number | null }): string | null {
  if (!p.cibilBand) return null;
  const band = CIBIL_BAND_LABELS[p.cibilBand as CibilBand] ?? p.cibilBand;
  return p.cibilScore ? `${band} (${p.cibilScore})` : band;
}

export type BgvPart = 'address' | 'cibil' | 'court';

export const BGV_PARTS: readonly BgvPart[] = ['address', 'cibil', 'court'];

/** Each part's name, as a heading. */
export const BGV_PART_LABELS: Record<BgvPart, string> = {
  address: 'Address check',
  cibil: 'CIBIL check',
  court: 'Court check',
};

/** The same, inside a sentence — the address check says how it may be done. */
const PART_IN_A_SENTENCE: Record<BgvPart, string> = {
  address: 'the address check (physical or digital)',
  cibil: 'the CIBIL check',
  court: 'the court check',
};

/** What a check carries about its parts — the columns of `assayer_background_checks`. */
export interface BgvParts {
  addressCheckMethod?: string | null;
  addressCheckResult?: string | null;
  cibilBand?: string | null;
  courtCheckResult?: string | null;
}

export interface BgvPartState {
  part: BgvPart;
  /** On the check at all. */
  recorded: boolean;
  /** Recorded and consistent with a clear result. */
  clear: boolean;
  /** What a part that is not clear found, as the start of a sentence. Null when clear or not recorded. */
  found: string | null;
}

const isOneOf = <T extends string>(values: Record<string, T>, v: unknown): v is T =>
  typeof v === 'string' && (Object.values(values) as string[]).includes(v);

export function bgvPartStates(p: BgvParts): BgvPartState[] {
  const addressRecorded = isOneOf(AddressCheckMethod, p.addressCheckMethod) && isOneOf(AddressCheckResult, p.addressCheckResult);
  const addressClear = addressRecorded && p.addressCheckResult === AddressCheckResult.VERIFIED;
  const cibilRecorded = typeof p.cibilBand === 'string' && (CIBIL_ANSWERED_BANDS as readonly string[]).includes(p.cibilBand);
  const courtRecorded = isOneOf(CourtCheckResult, p.courtCheckResult);
  const courtClear = courtRecorded && p.courtCheckResult === CourtCheckResult.NO_RECORD;
  return [
    {
      part: 'address', recorded: addressRecorded, clear: addressClear,
      found: addressRecorded && !addressClear
        ? p.addressCheckResult === AddressCheckResult.DISCREPANCY
          ? 'the address check found a discrepancy'
          : 'the address could not be verified'
        : null,
    },
    { part: 'cibil', recorded: cibilRecorded, clear: cibilRecorded, found: null },
    {
      part: 'court', recorded: courtRecorded, clear: courtClear,
      found: courtRecorded && !courtClear
        ? `the court check found a ${p.courtCheckResult === CourtCheckResult.CRIMINAL_CASE ? 'criminal' : 'civil'} case`
        : null,
    },
  ];
}

const joinAnd = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * What stands between these parts and a clear result, in words that finish "still missing: …" —
 * empty when a clear result may be recorded. The parts that were never recorded come first, then
 * any that found something.
 */
export function bgvClearGaps(p: BgvParts): string[] {
  const states = bgvPartStates(p);
  return [
    ...states.filter((s) => !s.recorded).map((s) => PART_IN_A_SENTENCE[s.part]),
    ...states.filter((s) => s.recorded && !s.clear).map((s) => s.found ?? PART_IN_A_SENTENCE[s.part]),
  ];
}

/** Why a background verification with these parts cannot be recorded as clear, or null when it can. */
export function bgvClearRefusal(p: BgvParts): string | null {
  const states = bgvPartStates(p);
  const missing = states.filter((s) => !s.recorded).map((s) => PART_IN_A_SENTENCE[s.part]);
  if (missing.length > 0) {
    return 'A background check is clear only with all three of its parts — the address check '
      + `(physical or digital), the CIBIL check and the court check. Still to fill in: ${joinAnd(missing)}.`;
  }
  const found = states.filter((s) => !s.clear).map((s) => s.found ?? PART_IN_A_SENTENCE[s.part]);
  if (found.length > 0) {
    const said = joinAnd(found);
    return `${said.charAt(0).toUpperCase()}${said.slice(1)}, so the result cannot be clear — record what was found instead.`;
  }
  return null;
}

/** "Physical visit — Address verified", or null when the address check is not on the check. */
export function addressCheckSummary(p: BgvParts): string | null {
  if (!isOneOf(AddressCheckResult, p.addressCheckResult)) return null;
  const how = isOneOf(AddressCheckMethod, p.addressCheckMethod) ? ADDRESS_CHECK_METHOD_LABELS[p.addressCheckMethod] : null;
  return [ADDRESS_CHECK_RESULT_LABELS[p.addressCheckResult], how ? `(${how.toLowerCase()})` : null].filter(Boolean).join(' ');
}
