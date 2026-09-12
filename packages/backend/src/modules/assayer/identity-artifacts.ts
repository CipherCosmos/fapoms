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
 * the recorded verdict — so this adds the missing part: the EXIT rule.
 *
 * Two arms with deliberately different strictness:
 *
 *  - An AFFIRMATIVELY ADVERSE verdict (civil case, criminal case, adverse finding) refuses in
 *    every mode, on every move it guards. Somebody wrote that verdict down on purpose; it is not
 *    a backlog artifact, and "warn" would let a criminal-case record be quietly onboarded with
 *    only an audit row to show for it. The one path forward is a newer check that clears them.
 *  - AN ABSENT check (none at all, or NOT_CHECKED) rides `onboarding.identityGate.mode`, exactly
 *    like the identity arm and for exactly its reason: on the day the gates shipped the estate
 *    had never run a check once, and enforce-from-boot is how a control gets switched off
 *    permanently instead of adopted.
 *
 * WHERE it bites is as deliberate as HOW:
 *
 *  - `leave-bgv` (BACKGROUND_VERIFICATION → TRAINING): both arms. This is the onboarding exit the
 *    drawing gates.
 *  - `activate`: the adverse arm only. Activation is also how a person parked as BGV_FAILED would
 *    re-enter, so the adverse arm is the "not onboarded until re-vetted" rule. The absent arm
 *    stays out of activation on purpose — returns from leave or suspension are not onboarding,
 *    and double-gating them on a check nobody ran would refuse half the working roster the day
 *    the mode turns to enforce.
 */
export type BackgroundGateSite = 'leave-bgv' | 'activate';

export interface BackgroundGateDecision {
  /** Refused regardless of mode — an adverse verdict somebody recorded on purpose. */
  refusal: string | null;
  /** Refused under `enforce`, audited under `warn` — the check simply has not happened. */
  gated: string | null;
}

const ADVERSE_VERDICTS: BackgroundCheckVerdict[] = [
  BackgroundCheckVerdict.CIVIL_CASE,
  BackgroundCheckVerdict.CRIMINAL_CASE,
  BackgroundCheckVerdict.ADVERSE_FINDING,
];

export function assessBackgroundGate(
  latestVerdict: BackgroundCheckVerdict | null,
  site: BackgroundGateSite,
): BackgroundGateDecision {
  if (latestVerdict !== null && ADVERSE_VERDICTS.includes(latestVerdict)) {
    const said = latestVerdict.toLowerCase().replace(/_/g, ' ');
    return {
      refusal:
        `the latest background check came back ${said}. A person with an adverse verdict on file `
        + 'is not onboarded — record a new background check that clears them, or park the record '
        + 'as inactive (background verification failed).',
      gated: null,
    };
  }
  if (site === 'leave-bgv' && (latestVerdict === null || latestVerdict === BackgroundCheckVerdict.NOT_CHECKED)) {
    return {
      refusal: null,
      gated:
        'no completed background check is on file. Record the check\'s outcome on the vetting '
        + 'screen before moving them out of background verification.',
    };
  }
  return { refusal: null, gated: null };
}
