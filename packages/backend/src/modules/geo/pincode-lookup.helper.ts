import { matchIndianState, pincodeFromAddress } from '@fapoms/shared';
import { pincodePlace } from './osm-geocoder';

export interface PincodeLookupResult {
  /** Always a value the app's own state dropdowns offer — see `matchIndianState`. */
  state: string;
  district: string;
  /** Best available town name (post-office block, falling back to district). */
  city: string | null;
  /**
   * Where the answer came from, because the two sources do not deserve the same trust.
   * `directory` is India Post, which defines what a pincode means. `map` is OpenStreetMap, a
   * good guess that the candidate should confirm.
   */
  source: 'directory' | 'map';
}

/**
 * WHY THERE ARE THREE ANSWERS, NOT TWO.
 *
 * `found` fills the address in. `not-found` means the directory genuinely has no such pincode —
 * the candidate should check their digits. `unavailable` means nobody could ask: the lookup itself
 * failed. Collapsing the last two is what put "We could not find this pincode in the postal
 * directory — check the digits" in front of people whose digits were perfectly right.
 */
export type PincodeLookup =
  | { status: 'found'; place: PincodeLookupResult }
  | { status: 'not-found' }
  | { status: 'unavailable' };

/**
 * THE POSTAL DIRECTORY DECIDES, THE MAP ONLY STANDS IN.
 *
 * This order was the other way round for speed — the self-hosted Nominatim answers in ~260ms
 * against India Post's ~3.6s — and measuring it showed what that cost. Across twenty pincodes
 * spread over the postal circles the two sources agreed on the state 18 times and on the district
 * 14 times, and one of the two state disagreements was simply OSM being wrong: for 160017 it
 * answered Punjab / Sahibzada Ajit Singh Nagar, because the nearest thing it knows is across the
 * Mohali border, where India Post answers Chandigarh. A pincode is a postal artefact and India
 * Post is the register that defines it; OpenStreetMap is volunteers drawing what is near a point.
 * For an address that decides where somebody is deployed and what their travel is worth, the
 * register wins and the extra three seconds are the cheapest part of the transaction.
 *
 * The map is still asked when the directory cannot be reached, because a hand-typed address is
 * worse than a checked suggestion — but it comes back marked `map`, so the form can ask the
 * candidate to confirm it rather than presenting it as established fact.
 */
export async function lookupPincodeDetailed(pin: string): Promise<PincodeLookup> {
  const candidate = (pin || '').trim();
  if (!/^\d{6}$/.test(candidate)) return { status: 'not-found' };

  const cached = readCache(candidate);
  if (cached) return cached;

  const directory = await askPostalDirectory(candidate);
  if (directory.status !== 'unavailable') return writeCache(candidate, directory);

  const map = await askMap(candidate);
  // An OSM miss is not the directory saying no — it is the only source we could reach having
  // nothing to say, which is still "nobody could tell us".
  return map.status === 'found' ? writeCache(candidate, map) : { status: 'unavailable' };
}

/** The older shape, for callers that only care whether a place came back. */
export async function lookupPincode(pin: string): Promise<PincodeLookupResult | null> {
  const answer = await lookupPincodeDetailed(pin);
  return answer.status === 'found' ? answer.place : null;
}

// ── The two sources ─────────────────────────────────────────────────────────

async function askPostalDirectory(pincode: string): Promise<PincodeLookup> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, {
      signal: controller.signal,
    });
    if (!res.ok) return { status: 'unavailable' };
    const data = (await res.json()) as Array<{
      Status?: string;
      PostOffice?: Array<{
        State?: string; District?: string; Block?: string; Division?: string; Name?: string;
      }>;
    }>;
    // "No records found" is the directory answering, and answering no — which is a real answer.
    if (data?.[0]?.Status && data[0].Status !== 'Success') return { status: 'not-found' };
    const postOffice = data?.[0]?.PostOffice?.[0];
    if (!postOffice?.State || !postOffice?.District) return { status: 'not-found' };

    return verified(pincode, {
      state: postOffice.State,
      district: postOffice.District,
      city: townFromDirectory(postOffice),
      source: 'directory',
    });
  } catch {
    // Timed out, DNS failure, blocked egress: nobody could ask, so do not tell the candidate
    // their pincode is wrong.
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * THE DIRECTORY HAS NO FIELD THAT MEANS "TOWN".
 *
 * It has a post office `Name`, the `Block` it sits in, the postal `Division` above that and the
 * revenue `District`, and which of them is the town changes from pincode to pincode. Taking the
 * block, as this did, filled Guwahati in as "Gmc" (Guwahati Municipal Corporation) and Srinagar as
 * "Badyar Balla" — the name of one locality's post office. Taking the division instead would have
 * filed Daman under Valsad, a town in another state.
 *
 * So the block is used only when a second field of the directory agrees it is a place name:
 * equal to the district, or the division named after it ("New Delhi" under "New Delhi Central",
 * "Bangalore" under "Bangalore East"). With nothing corroborating it the district is used, which
 * is never the wrong answer — only a less specific one — and the candidate can type the town over
 * it. A guess that is usually right is worse here than a coarse answer that always is.
 */
function townFromDirectory(
  postOffice: { District?: string; Block?: string; Division?: string },
): string {
  const district = (postOffice.District ?? '').trim();
  const block = (postOffice.Block ?? '').trim();
  const division = (postOffice.Division ?? '').trim();
  if (!block || block === 'NA') return district;

  const key = (v: string) => v.toLowerCase().replace(/[^a-z ]/g, '').trim();
  const namesSamePlace = (a: string, b: string): boolean => {
    const [x, y] = [key(a), key(b)];
    if (!x || !y) return false;
    return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
  };

  return namesSamePlace(block, district) || namesSamePlace(block, division) ? block : district;
}

async function askMap(pincode: string): Promise<PincodeLookup> {
  try {
    const place = await pincodePlace(pincode);
    if (!place) return { status: 'unavailable' };
    return verified(pincode, { ...place, source: 'map' });
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * A reading nobody can stand behind is not handed over.
 *
 * Two things are checked, and both of them have put a wrong address on a record before:
 *
 * 1. The state has to be one this app's dropdowns offer. Filling "Jammu & Kashmir" into a select
 *    whose option reads "Jammu and Kashmir" leaves the field empty while the candidate watches it
 *    appear to fill — they then submit a record with no state at all.
 * 2. The state has to belong to the pincode's own postal circle (`pincodeFromAddress`). The first
 *    digit fixes the circle, so a reading that lands outside it contradicts the number it came
 *    from, and neither half is safe to keep.
 *
 * Failing either returns `unavailable`, not `not-found`: the pincode is not being called wrong,
 * we are admitting we cannot resolve it. The candidate types the address instead, which is the
 * outcome an unverifiable auto-fill should always degrade to.
 */
function verified(pincode: string, place: PincodeLookupResult): PincodeLookup {
  const state = matchIndianState(place.state);
  if (!state) return { status: 'unavailable' };
  if (pincodeFromAddress(pincode, state).reason) return { status: 'unavailable' };
  return { status: 'found', place: { ...place, state } };
}

// ── Cache ───────────────────────────────────────────────────────────────────

/**
 * Pincodes do not move, so an answer is good until the process restarts — and the directory the
 * candidate is waiting on takes about three and a half seconds. Only settled answers are kept:
 * `unavailable` means we failed to ask, and remembering a failure would keep failing after the
 * network came back.
 */
const CACHE_LIMIT = 5000;
const cache = new Map<string, PincodeLookup>();

function readCache(pincode: string): PincodeLookup | null {
  return cache.get(pincode) ?? null;
}

function writeCache(pincode: string, answer: PincodeLookup): PincodeLookup {
  if (answer.status === 'unavailable') return answer;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(pincode, answer);
  return answer;
}

/** Test seam: the cache is process-wide, so a suite that stubs `fetch` has to start clean. */
export function __resetPincodeCache(): void {
  cache.clear();
}
