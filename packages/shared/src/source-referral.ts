import { normalisePhone } from './identity-validation';
import { referenceEmailProblem } from './application-references';

/**
 * WHO REFERRED THIS ASSAYER — the source reference (owner, 2026-09-23).
 *
 * Not one of the three references the candidate gives for background verification: those vouch
 * for them; this is who brought them to us. One per person. HR records it at intake; the candidate
 * may fill it on their form when HR left it blank; it travels interview → application → assayer.
 */
export enum ReferralSourceType {
  /** Somebody already on our roster. */
  ASSAYER = 'ASSAYER',
  /** One of our own staff. */
  STAFF = 'STAFF',
  /** A client bank's branch. */
  BANK_BRANCH = 'BANK_BRANCH',
  OTHER = 'OTHER',
}

export const REFERRAL_SOURCE_LABELS: Record<ReferralSourceType, string> = {
  [ReferralSourceType.ASSAYER]: 'An assayer of ours',
  [ReferralSourceType.STAFF]: 'Our staff',
  [ReferralSourceType.BANK_BRANCH]: 'A bank branch',
  [ReferralSourceType.OTHER]: 'Someone else',
};

/** Who wrote it down — HR's entry is not the candidate's to change. */
export type ReferralRecordedBy = 'HR' | 'CANDIDATE';

export interface SourceReferral {
  type: ReferralSourceType;
  name: string;
  /** The 10-digit national number. */
  mobile: string | null;
  email: string | null;
  recordedBy: ReferralRecordedBy;
}

/**
 * Tidy a raw source-referral payload, or name why it cannot be kept. `null` or an all-empty entry
 * means "nobody" and clears it. The same rule at every door — HR's dialog, the candidate's form on
 * the web and on the phone, the record — so each refuses the same things with the same words.
 */
export function normalizeSourceReferral(raw: unknown, recordedBy: ReferralRecordedBy): {
  referral: SourceReferral | null;
  error: string | null;
} {
  if (raw === null || raw === undefined) return { referral: null, error: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { referral: null, error: 'Who referred them could not be read.' };
  const row = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const type = str(row.type);
  const name = str(row.name);
  const rawMobile = str(row.mobile);
  const email = str(row.email).toLowerCase();
  if (!type && !name && !rawMobile && !email) return { referral: null, error: null };

  if (!(Object.values(ReferralSourceType) as string[]).includes(type)) {
    return { referral: null, error: 'Say who referred them — an assayer, our staff, a bank branch or someone else.' };
  }
  if (!name) return { referral: null, error: 'Give the name of the person who referred them.' };
  if (name.length > 200) return { referral: null, error: 'Keep the referrer’s name under 200 characters.' };
  const mobile = rawMobile ? normalisePhone(rawMobile) : null;
  if (rawMobile && !mobile) return { referral: null, error: `The referrer’s mobile should be a 10-digit Indian number.` };
  if (email) {
    const bad = referenceEmailProblem(email);
    if (bad) return { referral: null, error: `The referrer’s email ${bad}.` };
  }
  if (!mobile && !email) {
    return { referral: null, error: `Give a mobile or an email for ${name}, so they can be reached.` };
  }
  return {
    referral: { type: type as ReferralSourceType, name, mobile: mobile ?? null, email: email || null, recordedBy },
    error: null,
  };
}

/** May the candidate change what is on file? Only what they wrote themselves, or nothing yet. */
export function candidateMayEditSourceReferral(current: Pick<SourceReferral, 'recordedBy'> | null | undefined): boolean {
  return !current || current.recordedBy === 'CANDIDATE';
}

/** One line for a screen: "Ravi Kumar (an assayer of ours) · 98765 43210 · ravi@x.in". */
export function sourceReferralLine(r: SourceReferral | null | undefined): string {
  if (!r) return '';
  const label = REFERRAL_SOURCE_LABELS[r.type]?.toLowerCase() ?? r.type;
  return [`${r.name} (${label})`, r.mobile, r.email].filter(Boolean).join(' · ');
}
