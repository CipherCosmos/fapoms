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
