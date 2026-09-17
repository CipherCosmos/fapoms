import { IFSC_PATTERN } from '@fapoms/shared';

/**
 * IFSC → bank/branch lookup for the onboarding and branch forms.
 *
 * An IFSC code uniquely determines a bank's name, branch, city and state, but nothing in this
 * codebase derives that from the code itself (see the comment on `assayer.entity.ts`'s bank name
 * field). Razorpay publishes a free, keyless, India-specific lookup for exactly this — no signup,
 * no billing, no rate-limit contract to manage — so unlike the geocoders in this module there is
 * no cache and no fallback tier: this is a single request-time lookup for a form field, not a
 * background job worth amortising.
 *
 * Razorpay does not know every code (new and small-bank IFSCs 404 there while being perfectly
 * real), so a miss falls through to a second keyless directory rather than answering null
 * straight away. Order matters: Razorpay first because it is the long-standing source the desk
 * already trusts, the fallback only for what it cannot see.
 */

export interface IfscLookupResult {
  bankName: string;
  branchName: string;
  city: string | null;
  state: string | null;
  address: string | null;
}

interface DirectoryAnswer {
  BANK?: string;
  BRANCH?: string;
  CITY?: string;
  STATE?: string;
  ADDRESS?: string;
}

function toResult(data: DirectoryAnswer): IfscLookupResult | null {
  if (!data?.BANK) return null;
  return {
    bankName: data.BANK,
    branchName: data.BRANCH ?? '',
    city: data.CITY ?? null,
    state: data.STATE ?? null,
    address: data.ADDRESS ?? null,
  };
}

async function getJson(url: string): Promise<DirectoryAnswer | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as DirectoryAnswer;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Look up an IFSC code. Returns `null` for a malformed code (checked before any network call —
 * an obviously-invalid code should never spend a request), for a code neither directory
 * recognises, and for any network/parse failure. Never throws: like `autocompleteIndia`, a lookup
 * failure must read as "no data yet", not as a request failure that blocks the form.
 */
export async function lookupIfsc(code: string): Promise<IfscLookupResult | null> {
  const candidate = (code || '').trim().toUpperCase();
  if (!IFSC_PATTERN.test(candidate)) return null;

  const primary = await getJson(`https://ifsc.razorpay.com/${candidate}`);
  if (primary) {
    const result = toResult(primary);
    if (result) return result;
  }
  const fallback = await getJson(`https://bank-apis.justinclicks.com/API/V1/IFSC/${candidate}`);
  return fallback ? toResult(fallback) : null;
}
