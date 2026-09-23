import { AssayerLifecycleStatus, BackgroundCheckVerdict } from '@fapoms/shared';

/**
 * The rules for issuing an identity ARTIFACT — today the ID card.
 *
 * An artifact is different from a database row. The roster record and its appraiser code are
 * internal bookkeeping; the card is a thing a person carries into a bank branch to prove the
 * company vouches for them. So the code is minted at creation (it is the business key on every
 * screen and import, and deferring it ripples everywhere), and the vetting gate bites HERE
 * instead — on what leaves the building. That split is the owner's decision, 2026-09-12.
 *
 * Pure functions, because the December-31st arithmetic below is exactly the kind of thing that
 * deserves table-driven tests rather than a live clock.
 */

export type IdCardValidityMode = 'CALENDAR_YEAR' | 'ROLLING_MONTHS';

export interface IdCardValidityConfig {
  mode: IdCardValidityMode;
  /** ROLLING_MONTHS only: how many months from issue. */
  rollingMonths: number;
  /**
   * CALENDAR_YEAR only: the fix for the owner's own objection. A card issued on December 31st
   * under a plain calendar-year rule expires the day it is printed. If fewer than this many days
   * remain in the year at issue, validity carries to December 31st of the NEXT year instead.
   */
  graceDays: number;
}

export const ID_CARD_VALIDITY_DEFAULTS: IdCardValidityConfig = {
  mode: 'CALENDAR_YEAR',
  rollingMonths: 12,
  graceDays: 45,
};

const MS_PER_DAY = 86_400_000;

/** Local-calendar-day Dec 31 of the given year. */
const endOfYear = (year: number): Date => new Date(year, 11, 31);

export function idCardValidTill(issuedOn: Date, cfg: IdCardValidityConfig): Date {
  if (cfg.mode === 'ROLLING_MONTHS') {
    const months = Math.max(1, Math.floor(cfg.rollingMonths));
    const target = new Date(issuedOn.getFullYear(), issuedOn.getMonth() + months, issuedOn.getDate());
    // new Date(2026, 0+1, 31) is March 3 — a month with fewer days overflowed. Clamp back to the
    // last day of the intended month rather than silently granting extra days in the next one.
    if (target.getDate() !== issuedOn.getDate()) {
      return new Date(issuedOn.getFullYear(), issuedOn.getMonth() + months + 1, 0);
    }
    return target;
  }

  const sameYearEnd = endOfYear(issuedOn.getFullYear());
  const daysLeft = Math.floor(
    (sameYearEnd.getTime() - new Date(issuedOn.getFullYear(), issuedOn.getMonth(), issuedOn.getDate()).getTime()) /
      MS_PER_DAY,
  );
  return daysLeft < Math.max(0, cfg.graceDays) ? endOfYear(issuedOn.getFullYear() + 1) : sameYearEnd;
}

export interface IdentityArtifactFacts {
  lifecycleStatus: AssayerLifecycleStatus | string;
  /** From `RosterRecordsService.identityStanding` — scan on file AND attested, per document. */
  identityOk: boolean;
  /** Human-readable names of the identity documents that are not verified. */
  identityMissing: string[];
  /** The most recent background check's verdict, or null when none exists at all. */
  latestVerdict: BackgroundCheckVerdict | null;
}

export interface IdentityArtifactAssessment {
  /**
   * Refused regardless of any setting. A card for somebody who is not ACTIVE is indefensible in
   * every mode — there is no estate-backlog argument for it, unlike the two gated arms below.
   */
  refusals: string[];
  /**
   * Refused when `onboarding.identityGate.mode` is `enforce`; issued-but-audited under `warn`.
   *
   * Deliberately the SAME setting that gates activation, not a second knob that can disagree
   * with it. The estate this shipped into had not one verified document row, so a hard gate here
   * would have killed every card in the company on day one — the identical trap the activation
   * gate's own comment records. The card becomes strict in the same moment activation does.
   */
  gated: string[];
}

export function assessIdentityArtifact(f: IdentityArtifactFacts): IdentityArtifactAssessment {
  const refusals: string[] = [];
  const gated: string[] = [];

  if (f.lifecycleStatus !== AssayerLifecycleStatus.ACTIVE) {
    refusals.push(`the record is ${String(f.lifecycleStatus).toLowerCase().replace(/_/g, ' ')}, not active`);
  }

  if (!f.identityOk) {
    gated.push(
      f.identityMissing.length > 0
        ? `${f.identityMissing.join(' and ')} not verified against the original`
        : 'identity documents not verified against the original',
    );
  }

  if (f.latestVerdict === null || f.latestVerdict === BackgroundCheckVerdict.NOT_CHECKED) {
    gated.push('no completed background check on file');
  } else if (f.latestVerdict !== BackgroundCheckVerdict.CLEAR) {
    gated.push(`latest background check verdict is ${f.latestVerdict.toLowerCase().replace(/_/g, ' ')}, not clear`);
  }

  return { refusals, gated };
}

/**
 * The background-verification gate, as a decision table.
 *
 * The owner's process drawing has BGV branching to PASSED and FAILED, with FAILED ending in
 * "not onboarded". The states already exist — the lifecycle's BACKGROUND_VERIFICATION window and
 * the recorded verdict — so this is the EXIT rule.
 *
 * MANDATORY since 2026-09-23 (owner: "background verification is mandatory and uploading the
 * files for BGV is also mandatory"). The absent-check arm used to ride `onboarding.identityGate.mode`
 * and default to WARN — so anybody could be moved out of background verification with no check at
 * all, and only an activity row said so. Now onboarding cannot be finished without:
 *
 *  - a completed check whose latest verdict is CLEAR, and
 *  - the background verification report uploaded (`BGV_REPORT`) — the evidence the verdict came from.
 *
 * WHERE it bites:
 *
 *  - `leave-bgv` (BACKGROUND_VERIFICATION → TRAINING): all of it.
 *  - `finish-onboarding` (INACTIVE → ACTIVE for somebody parked INACTIVE from an onboarding stage):
 *    all of it too. Without this the gate had a side door — park a candidate inactive, then
 *    "reactivate" somebody who was never active and never checked.
 *  - `activate` (every other return to ACTIVE — from leave, suspension, or an inactive spell after
 *    working): the adverse arm only. Returning from leave is not onboarding, and the working roster
 *    predates these checks; refusing their returns would stop the business, not vet anybody.
 *
 * An AFFIRMATIVELY ADVERSE verdict (civil case, criminal case, adverse finding) refuses on every
 * move this guards. The one path forward is a newer check that clears them.
 */
export type BackgroundGateSite = 'leave-bgv' | 'finish-onboarding' | 'activate';

export interface BackgroundGateDecision {
  /** Why the move is refused, as the end of "X cannot be moved: …" — or null. */
  refusal: string | null;
}

const ADVERSE_VERDICTS: BackgroundCheckVerdict[] = [
  BackgroundCheckVerdict.CIVIL_CASE,
  BackgroundCheckVerdict.CRIMINAL_CASE,
  BackgroundCheckVerdict.ADVERSE_FINDING,
];

export function assessBackgroundGate(
  latestVerdict: BackgroundCheckVerdict | null,
  site: BackgroundGateSite,
  /** Whether the background verification report is on file — a `BGV_REPORT` row with a scan. */
  reportOnFile: boolean,
): BackgroundGateDecision {
  if (latestVerdict !== null && ADVERSE_VERDICTS.includes(latestVerdict)) {
    const said = latestVerdict.toLowerCase().replace(/_/g, ' ');
    return {
      refusal:
        `the latest background check came back ${said}. A person with an adverse verdict on file `
        + 'is not onboarded — record a new background check that clears them, or park the record '
        + 'as inactive (background verification failed).',
    };
  }
  if (site === 'activate') return { refusal: null };
  if (latestVerdict === null || latestVerdict === BackgroundCheckVerdict.NOT_CHECKED) {
    return {
      refusal:
        'background verification is mandatory and no completed check is on file. Upload the '
        + 'background verification report and record its result on the Background tab first.',
    };
  }
  if (!reportOnFile) {
    return {
      refusal:
        'the background verification report has not been uploaded. The result is only as good as '
        + 'the report it came from — upload it on the Background tab first.',
    };
  }
  return { refusal: null };
}
