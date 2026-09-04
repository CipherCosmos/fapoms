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
 */

export interface IfscLookupResult {
  bankName: string;
  branchName: string;
  city: string | null;
  state: string | null;
  address: string | null;
}

/**
 * Look up an IFSC code. Returns `null` for a malformed code (checked before any network call —
 * an obviously-invalid code should never spend a request), for a code the API does not recognise
 * (404), and for any network/parse failure. Never throws: like `autocompleteIndia`, a lookup
 * failure must read as "no data yet", not as a request failure that blocks the form.
 */
export async function lookupIfsc(code: string): Promise<IfscLookupResult | null> {
  const candidate = (code || '').trim().toUpperCase();
  if (!IFSC_PATTERN.test(candidate)) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://ifsc.razorpay.com/${candidate}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      BANK?: string;
      BRANCH?: string;
      CITY?: string;
      STATE?: string;
      ADDRESS?: string;
    };
    if (!data?.BANK) return null;

    return {
      bankName: data.BANK,
      branchName: data.BRANCH ?? '',
      city: data.CITY ?? null,
      state: data.STATE ?? null,
      address: data.ADDRESS ?? null,
    };
  } catch {
    return null;
  }
}
