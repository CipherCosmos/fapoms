import { normalisePhone } from './identity-validation';

/**
 * People who can vouch for a candidate, collected before they are a real assayer.
 *
 * Three is the rule: enough that one unreachable referee does not stall hiring, few enough
 * that the desk actually rings them. At least one must carry a number — a name nobody can
 * call is not a reference, it is a line in a form. Rows live on the application
 * (`extendedProfile.references`) until approval replays them onto the record through
 * `RosterRecordsService.saveReference`, which is the same call the desk wizard used to make
 * directly.
 */
export const APPLICATION_REFERENCES_MAX = 3;

export interface ApplicationReference {
  fullName: string;
  phone?: string;
  relationship?: string;
  /** Optional — collected where known, never a blocker. */
  email?: string;
}

/** The shape an email must have to be kept: one @, one dot past it, nothing spaced. */
function emailProblem(value: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'does not look like an email address';
  if (value.length > 255) return 'is longer than an email address can be';
  return null;
}

/**
 * The same rule for the roster door, which writes references straight onto the record rather
 * than through the application normalizer above.
 */
export function referenceEmailProblem(email: string): string | null {
  return emailProblem(email);
}

/**
 * Tidy a raw references payload into the shape promotion replays — trimmed, empties dropped,
 * capped at three — or name why it cannot be kept.
 *
 * Shared rather than server-only so every door (candidate link, desk fill-in, mobile) refuses
 * the same payloads with the same words, instead of each form inventing its own ceiling.
 */
export function normalizeApplicationReferences(raw: unknown): {
  references: ApplicationReference[];
  error: string | null;
} {
  if (raw === undefined) return { references: [], error: null };
  if (!Array.isArray(raw)) return { references: [], error: 'References must be a list.' };
  const kept: ApplicationReference[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const fullName = typeof row.fullName === 'string' ? row.fullName.trim() : '';
    // The 10-digit national number when it is one — what every form displays behind its fixed
    // "+91" — so "+91 98765 43210" and "9876543210" are stored alike and never shown as
    // "+91 919876543210". Anything that is not a mobile number yet is kept as its digits, so the
    // candidate sees what they typed and `referenceSubmitProblem` can name it.
    const rawPhone = typeof row.phone === 'string' ? row.phone : '';
    const phone = normalisePhone(rawPhone) ?? rawPhone.replace(/\D/g, '');
    const relationship = typeof row.relationship === 'string' ? row.relationship.trim() : '';
    const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
    if (!fullName && !phone && !email) continue;
    if (!fullName) return { references: [], error: 'Every reference needs a name.' };
    if (email) {
      const bad = emailProblem(email);
      if (bad) return { references: [], error: `The email for “${fullName}” ${bad}.` };
    }
    kept.push({
      fullName,
      ...(phone ? { phone } : {}),
      ...(relationship ? { relationship } : {}),
      ...(email ? { email } : {}),
    });
  }
  if (kept.length > APPLICATION_REFERENCES_MAX) {
    return {
      references: [],
      error: `Only ${APPLICATION_REFERENCES_MAX} references are needed — remove ${kept.length - APPLICATION_REFERENCES_MAX}.`,
    };
  }
  return { references: kept, error: null };
}

/**
 * Whether the references satisfy the submit rule: at least one a desk can actually ring.
 *
 * Null when satisfied; the sentence for the form or the submit refusal otherwise. A name with
 * no number fails: the check these exist for is a phone call, and "recorded but unrung" is a
 * state the roster already tracks per reference.
 */
export function referenceSubmitProblem(references: ApplicationReference[] | null | undefined): string | null {
  const rows = Array.isArray(references) ? references : [];
  const ringable = rows.filter((r) => r?.fullName?.trim() && normalisePhone(r.phone ?? ''));
  if (ringable.length === 0) {
    return 'Add at least one reference with a name and a 10-digit mobile number.';
  }
  for (const row of rows) {
    if (row?.fullName?.trim() && row.phone && !normalisePhone(row.phone)) {
      return `“${row.fullName.trim()}” does not carry a valid 10-digit mobile number.`;
    }
  }
  return null;
}

/**
 * A reference's number the way every screen shows it: `+91 98220 14455` for a mobile, as typed
 * for anything else.
 *
 * One rule, because four screens each wrote `+91 ${phone}` for themselves — which printed a
 * referee's landline as "+91 020 2612 3456" and a 12-digit paste as "+91 919822014455".
 */
export function referencePhoneForDisplay(phone: string | null | undefined): string {
  const raw = (phone ?? '').trim();
  if (!raw) return '';
  const mobile = normalisePhone(raw);
  return mobile ? `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}` : raw;
}

