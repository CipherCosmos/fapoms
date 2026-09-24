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
  district?: string | null;
  state: string | null;
  address: string | null;
  pincode?: string | null;
  phone?: string | null;
  micr?: string | null;
  bankCode?: string | null;
  ifsc?: string;
}

interface DirectoryAnswer {
  BANK?: string;
  BRANCH?: string;
  CITY?: string;
  STATE?: string;
  DISTRICT?: string;
  CENTRE?: string;
  ADDRESS?: string;
  CONTACT?: string;
  MICR?: string;
  BANKCODE?: string;
  IFSC?: string;
}

/** In-memory cache so bulk imports and repeated lookups are sub-millisecond. */
const ifscMemoryCache = new Map<string, IfscLookupResult | null>();
const MAX_CACHE_SIZE = 5000;

export function clearIfscCache(): void {
  ifscMemoryCache.clear();
}

function extractPincode(address?: string | null, micr?: string | null): string | null {
  if (address) {
    const match = address.match(/\b([1-9][0-9]{5})\b/);
    if (match) return match[1];
  }
  return null;
}

function toResult(data: DirectoryAnswer, ifscCode: string): IfscLookupResult | null {
  if (!data?.BANK) return null;
  const address = data.ADDRESS?.trim() || null;
  const micr = data.MICR?.trim() || null;
  const district = data.DISTRICT?.trim() || data.CENTRE?.trim() || null;
  const contact = data.CONTACT?.trim() || null;
  const pincode = extractPincode(address, micr);

  return {
    bankName: data.BANK.trim(),
    branchName: data.BRANCH?.trim() ?? '',
    city: data.CITY?.trim() || null,
    district,
    state: data.STATE?.trim() || null,
    address,
    pincode,
    phone: contact || null,
    micr,
    bankCode: data.BANKCODE?.trim() || ifscCode.substring(0, 4),
    ifsc: ifscCode,
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

  if (ifscMemoryCache.has(candidate)) {
    return ifscMemoryCache.get(candidate) ?? null;
  }

  let result: IfscLookupResult | null = null;
  const primary = await getJson(`https://ifsc.razorpay.com/${candidate}`);
  if (primary) {
    result = toResult(primary, candidate);
  } else {
    const fallback = await getJson(`https://bank-apis.justinclicks.com/API/V1/IFSC/${candidate}`);
    result = fallback ? toResult(fallback, candidate) : null;
  }

  if (ifscMemoryCache.size >= MAX_CACHE_SIZE) {
    const firstKey = ifscMemoryCache.keys().next().value;
    if (firstKey) ifscMemoryCache.delete(firstKey);
  }
  ifscMemoryCache.set(candidate, result);

  return result;
}

/** Map of popular bank abbreviations / names to their 4-letter RBI IFSC prefix. */
const BANK_CODE_MAP: Record<string, string> = {
  SBI: 'SBIN',
  SBIN: 'SBIN',
  HDFC: 'HDFC',
  HDFCBANK: 'HDFC',
  ICICI: 'ICIC',
  ICIC: 'ICIC',
  AXIS: 'UTIB',
  UTIB: 'UTIB',
  PNB: 'PUNB',
  PUNB: 'PUNB',
  BOB: 'BARB',
  BARB: 'BARB',
  CANARA: 'CNRB',
  CNRB: 'CNRB',
  UNION: 'UBIN',
  UBIN: 'UBIN',
  BOI: 'BKID',
  BKID: 'BKID',
  KOTAK: 'KKBK',
  KKBK: 'KKBK',
  INDUSIND: 'INDB',
  INDB: 'INDB',
  YES: 'YESB',
  YESB: 'YESB',
  IDFC: 'IDFB',
  IDFB: 'IDFB',
  FEDERAL: 'FDRL',
  FDRL: 'FDRL',
  INDIAN: 'IDIB',
  IDIB: 'IDIB',
  CENTRAL: 'CBIN',
  CBIN: 'CBIN',
  IOB: 'IOBA',
  IOBA: 'IOBA',
  UCO: 'UCBA',
  UCBA: 'UCBA',
  BOM: 'MAHB',
  MAHB: 'MAHB',
  PSB: 'PSIB',
  PSIB: 'PSIB',
  SIB: 'SIBL',
  SIBL: 'SIBL',
  KVB: 'KVBL',
  KVBL: 'KVBL',
  BANDHAN: 'BDBL',
  BDBL: 'BDBL',
  RBL: 'RATN',
  RATN: 'RATN',
  AUBL: 'AUBL',
  AUBANK: 'AUBL',
  EQUITAS: 'ESFB',
  ESFB: 'ESFB',
  UJJIVAN: 'UJVN',
  UJVN: 'UJVN',
  JANA: 'JSFB',
  JSFB: 'JSFB',
  SURYODAY: 'SURY',
  SURY: 'SURY',
  UTKARSH: 'UTKS',
  UTKS: 'UTKS',
  FINCARE: 'FSFB',
  FSFB: 'FSFB',
  ESAF: 'ESMF',
  ESMF: 'ESMF',
  CSB: 'CSBK',
  CSBK: 'CSBK',
  CUB: 'CIUB',
  CIUB: 'CIUB',
  DCB: 'DCBL',
  DCBL: 'DCBL',
  KARNATAKA: 'KARB',
  KARB: 'KARB',
  TMB: 'TMBL',
  TMBL: 'TMBL',
  JKBANK: 'JAKA',
  JAKA: 'JAKA',
  DHANLAXMI: 'DLXB',
  DLXB: 'DLXB',
  SCBL: 'SCBL',
  HSBC: 'HSBC',
  CITI: 'CITI',
  DBSS: 'DBSS',
};

/** Normalise any bank identifier (client name, client code, acronym) to its 4-letter IFSC prefix. */
export function resolveBankCode(identifier?: string | null): string | null {
  if (!identifier) return null;

  // 1. Pre-normalize common abbreviations, punctuation, and corporate suffixes before stripping
  let text = identifier.trim().toUpperCase();
  text = text
    .replace(/\bST(\.|\b)\s*/g, 'STATE ')
    .replace(/\b(BK|BNK)(\.|\b)\s*/g, 'BANK ')
    .replace(/\b(NATL|NAT)(\.|\b)\s*/g, 'NATIONAL ')
    .replace(/&/g, ' AND ')
    .replace(/\b(LTD|LIMITED|CORP|CORPORATION|INC|CO|COMPANY)\b/g, '')
    .trim();

  const clean = text.replace(/[^A-Z]/g, '');
  if (!clean) return null;
  if (BANK_CODE_MAP[clean]) return BANK_CODE_MAP[clean];

  // If the identifier is already a valid 4-character uppercase alphabetic bank code, trust it
  if (/^[A-Z]{4}$/.test(clean)) return clean;

  // Check specific compound bank names first before general ones like "BANK OF INDIA"
  if (clean.includes('CITYUNION') || clean.includes('CUB')) return 'CIUB';
  if (clean.includes('STATEBANK') || clean.includes('SBI')) return 'SBIN';
  if (clean.includes('CENTRALBANK') || clean.includes('CBI')) return 'CBIN';
  if (clean.includes('UNIONBANK') || clean.includes('UBI')) return 'UBIN';
  if (clean.includes('BANKOFBARODA') || clean.includes('BARODA') || clean.includes('BOB')) return 'BARB';
  if (clean.includes('BANKOFMAHARASHTRA') || clean.includes('MAHARASHTRA') || clean.includes('BOM')) return 'MAHB';
  if (clean.includes('INDIANOVERSEAS') || clean.includes('IOB')) return 'IOBA';
  if (clean.includes('PUNJABANDSIND') || clean.includes('PUNJABSIND') || clean.includes('PSB') || clean.includes('PSIB')) return 'PSIB';
  if (clean.includes('PUNJABNATIONAL') || clean.includes('PNB')) return 'PUNB';
  if (clean.includes('BANKOFINDIA') || clean.includes('BOI')) return 'BKID';
  if (clean.includes('INDIANBANK') || clean.includes('IDIB')) return 'IDIB';

  if (clean.includes('HDFC')) return 'HDFC';
  if (clean.includes('ICICI')) return 'ICIC';
  if (clean.includes('AXIS') || clean.includes('UTIBANK') || clean.includes('UTI')) return 'UTIB';
  if (clean.includes('KOTAK')) return 'KKBK';
  if (clean.includes('RBL') || clean.includes('RATNAKAR')) return 'RATN';
  if (clean.includes('CANARA')) return 'CNRB';
  if (clean.includes('INDUSIND')) return 'INDB';
  if (clean.includes('YESBANK') || clean.startsWith('YESB') || clean.includes('YES')) return 'YESB';
  if (clean.includes('IDFC')) return 'IDFB';
  if (clean.includes('FEDERAL')) return 'FDRL';
  if (clean.includes('BANDHAN')) return 'BDBL';
  if (clean.includes('AU') && (clean.includes('SMALL') || clean.includes('BANK') || clean.includes('FINANCE'))) return 'AUBL';
  if (clean.includes('EQUITAS')) return 'ESFB';
  if (clean.includes('UJJIVAN')) return 'UJVN';
  if (clean.includes('JANA')) return 'JSFB';
  if (clean.includes('SURYODAY')) return 'SURY';
  if (clean.includes('UTKARSH')) return 'UTKS';
  if (clean.includes('FINCARE')) return 'FSFB';
  if (clean.includes('ESAF')) return 'ESMF';
  if (clean.includes('CATHOLIC') || clean.includes('CSB')) return 'CSBK';
  if (clean.includes('KARUR') || clean.includes('KVB')) return 'KVBL';
  if (clean.includes('SOUTHINDIAN')) return 'SIBL';
  if (clean.includes('JAMMU') || clean.includes('KASHMIR') || clean.includes('JKB')) return 'JAKA';
  if (clean.includes('KARNATAKA')) return 'KARB';
  if (clean.includes('TAMILNAD') || clean.includes('MERCANTILE')) return 'TMBL';
  if (clean.includes('DHANLAXMI') || clean.includes('DHANALAKSHMI')) return 'DLXB';
  if (clean.includes('DEVELOPMENTCREDIT') || clean.includes('DCB')) return 'DCBL';
  if (clean.includes('UCOBANK') || clean.includes('UCO')) return 'UCBA';
  if (clean.includes('STANDARDCHARTERED') || clean.includes('STANCHAR')) return 'SCBL';
  if (clean.includes('HSBC')) return 'HSBC';
  if (clean.includes('CITIBANK') || clean.includes('CITI')) return 'CITI';
  if (clean.includes('DEUTSCHE')) return 'DEUT';
  if (clean.includes('BARCLAYS')) return 'BARC';
  if (clean.includes('DBS')) return 'DBSS';
  return null;
}

/**
 * Infer a 11-character Indian IFSC code from a bank identifier and branch SOL ID.
 * Standard IFSC structure: 4-letter bank code + '0' + 6-digit zero-padded branch code.
 */
export function inferIfscFromSolId(bankIdentifier: string | undefined | null, solId: string | undefined | null): string | null {
  if (!bankIdentifier || !solId) return null;
  const bankCode = resolveBankCode(bankIdentifier);
  if (!bankCode) return null;

  const raw = String(solId).trim();
  // Strip non-alphanumeric or common prefixes like "SOL-" or "BR-"
  const cleaned = raw.replace(/^(SOL|BRANCH|BR)[-_ ]*/i, '').replace(/[^A-Za-z0-9]/g, '');
  if (!cleaned) return null;

  // If already an 11-char IFSC starting with this bank code, return it
  if (cleaned.length === 11 && cleaned.startsWith(bankCode)) return cleaned.toUpperCase();

  // If numeric or alphanumeric branch code: pad to 6 characters
  const branchPart = /^\d+$/.test(cleaned)
    ? cleaned.padStart(6, '0')
    : cleaned.toUpperCase().padEnd(6, '0');

  const candidate = `${bankCode}0${branchPart}`;
  return IFSC_PATTERN.test(candidate) ? candidate : null;
}

/**
 * High-level lookup: attempts direct lookup if `code` is an IFSC, or infers IFSC using `bankIdentifier` + `solId`.
 */
export async function lookupBranchByIfscOrSol(
  bankIdentifier?: string | null,
  ifscOrSol?: string | null,
): Promise<IfscLookupResult | null> {
  if (!ifscOrSol) return null;
  const trimmed = ifscOrSol.trim().toUpperCase();
  if (IFSC_PATTERN.test(trimmed)) {
    const direct = await lookupIfsc(trimmed);
    if (direct) return direct;
  }

  const inferred = inferIfscFromSolId(bankIdentifier, ifscOrSol);
  if (inferred && inferred !== trimmed) {
    return await lookupIfsc(inferred);
  }
  return null;
}
