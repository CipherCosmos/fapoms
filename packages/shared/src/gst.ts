/**
 * GST helpers shared by the invoice document (backend) and the printed invoice (frontend).
 *
 * India charges GST as CGST+SGST when the seller and the place of supply are in the same state,
 * and IGST when they differ. The one fact that decides it is the two-digit GST state code, which
 * is also the first two characters of every GSTIN. So the split is derivable from the two parties'
 * GSTINs alone — no separate state field has to be kept in sync — with the state name kept only
 * for display and as a fallback when a GSTIN has not been entered yet.
 *
 * Nothing here computes tax. The rate and the rupee tax amount are already stored on each billing
 * line; this module only decides how an already-computed tax figure is *labelled* (one IGST line,
 * or a CGST half and an SGST half) and turns a total into words for the foot of the invoice.
 */

/** Two-digit GST state code → state / UT name. Codes are the official GSTIN prefixes. */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

const normalize = (s: string): string =>
  s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');

/** State / UT name (however spelled) → its two-digit GST code. Built from the map above. */
const NAME_TO_CODE: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  // Iterate low → high so the modern code wins where a name maps to more than one (Andhra → 37).
  for (const code of Object.keys(GST_STATE_CODES).sort()) {
    out[normalize(GST_STATE_CODES[code])] = code;
  }
  // Common alternative spellings real client records carry.
  out[normalize('Orissa')] = '21';
  out[normalize('Pondicherry')] = '34';
  out[normalize('NCT of Delhi')] = '07';
  out[normalize('New Delhi')] = '07';
  return out;
})();

/** The name for a two-digit GST state code, or null if it is not a code we know. */
export function gstStateCodeToName(code?: string | null): string | null {
  if (!code) return null;
  const c = String(code).trim().padStart(2, '0');
  return GST_STATE_CODES[c] ?? null;
}

/**
 * The two-digit state code carried by a GSTIN, or null when the value is absent or not
 * GSTIN-shaped. A GSTIN is 15 characters: two digits of state code, then the PAN and a suffix.
 * We validate only enough to trust the prefix — a full checksum is not needed to read two digits.
 */
export function gstinStateCode(gstin?: string | null): string | null {
  if (!gstin) return null;
  const g = String(gstin).trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(g)) return null;
  const code = g.slice(0, 2);
  return GST_STATE_CODES[code] ? code : null;
}

/** A state / UT name → its GST code, tolerant of spelling and punctuation, or null. */
export function gstStateNameToCode(stateName?: string | null): string | null {
  if (!stateName) return null;
  return NAME_TO_CODE[normalize(String(stateName))] ?? null;
}

/**
 * The GST state code for a party, preferring the GSTIN (authoritative) and falling back to a
 * typed state name. Returns null when neither yields a code — the caller then cannot know whether
 * the supply is intra- or inter-state and must say so rather than guess a tax split.
 */
export function resolveGstStateCode(opts: { gstin?: string | null; stateName?: string | null }): string | null {
  return gstinStateCode(opts.gstin) ?? gstStateNameToCode(opts.stateName);
}

// ── Amount in words ────────────────────────────────────────────────────────

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** Two-or-three-digit group (0–999) to words. */
function underThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)]);
    n %= 10;
    if (n) parts.push(ONES[n]);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(' ');
}

/** Whole number to words in the Indian system (crore / lakh / thousand). */
function integerToIndianWords(value: number): string {
  if (value === 0) return 'Zero';
  let n = Math.floor(value);
  const segments: string[] = [];

  const crore = Math.floor(n / 10000000);
  if (crore > 0) { segments.push(`${integerToIndianWords(crore)} Crore`); n %= 10000000; }

  const lakh = Math.floor(n / 100000);
  if (lakh > 0) { segments.push(`${underThousand(lakh)} Lakh`); n %= 100000; }

  const thousand = Math.floor(n / 1000);
  if (thousand > 0) { segments.push(`${underThousand(thousand)} Thousand`); n %= 1000; }

  if (n > 0) segments.push(underThousand(n));

  return segments.join(' ');
}

/**
 * A rupee amount as the words printed at the foot of an invoice — e.g.
 * `"Indian Rupees One Lakh Twenty Thousand Five Hundred and Fifty Paise Only"`.
 *
 * Uses the Indian numbering system (lakh/crore). Paise are included only when non-zero. Negative
 * inputs are worded as their magnitude with a leading "Minus", which should not occur on an
 * invoice but is handled rather than silently dropped.
 */
export function numberToIndianWords(amount: number | string | null | undefined): string {
  const num = Number(amount ?? 0);
  if (!Number.isFinite(num)) return 'Indian Rupees Zero Only';
  const sign = num < 0 ? 'Minus ' : '';
  const abs = Math.abs(num);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  const rupeeWords = `Indian Rupees ${integerToIndianWords(rupees)}`;
  const paiseWords = paise > 0 ? ` and ${underThousand(paise)} Paise` : '';
  return `${sign}${rupeeWords}${paiseWords} Only`;
}
