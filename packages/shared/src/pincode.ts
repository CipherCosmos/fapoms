import { canonicalStateName } from './regions';
import { canonicalState } from './utils';

/**
 * Reading a pincode out of an address, and refusing to guess.
 *
 * The appraiser roster was kept as a spreadsheet with one free-text address column, so the
 * pincode was written at the end of the address rather than in a field of its own: 1,111 of
 * 1,163 records carry one inside `address` and 8 have it in the `pincode` column. Every screen
 * that reports a missing pincode, and every geocoder that would use one, was looking at the
 * empty column.
 *
 * Pulling it out is worth doing carefully, because a wrong pincode is worse than none: it is the
 * strongest signal the geocoder has, so a bad one puts somebody's home in another state with
 * more confidence than leaving it blank ever would.
 */

/**
 * The first digit of an Indian pincode is its postal circle, and each circle covers a fixed set
 * of states. That makes the state a free check on the number — if they disagree, one of the two
 * is wrong and neither is safe to use.
 *
 * Names are the canonical ones from `canonicalStateName`, so the roster's "M.P", "A.P" and
 * "RAJASTHAN" all compare correctly.
 */
const POSTAL_CIRCLES: Record<string, string[]> = {
  '1': ['Delhi', 'Haryana', 'Punjab', 'Himachal Pradesh', 'Jammu & Kashmir', 'JK', 'Ladakh', 'Chandigarh'],
  '2': ['Uttar Pradesh', 'UP', 'Uttarakhand'],
  '3': ['Rajasthan', 'Gujarat', 'Dadra & Nagar Haveli and Daman & Diu'],
  '4': ['Chhattisgarh', 'Madhya Pradesh', 'MP', 'Maharashtra', 'Goa'],
  '5': ['Andhra Pradesh', 'AP', 'Telangana', 'Karnataka'],
  '6': ['Kerala', 'Tamil Nadu', 'TN', 'Puducherry', 'Lakshadweep'],
  '7': [
    'West Bengal', 'WB', 'Odisha', 'Arunachal Pradesh', 'Assam', 'Manipur', 'Meghalaya',
    'Mizoram', 'Nagaland', 'Sikkim', 'Tripura', 'Andaman & Nicobar Islands',
  ],
  '8': ['Bihar', 'Jharkhand'],
};

/**
 * One comparable form for a state name, whatever spelling it arrived in.
 *
 * `&` and "and" are the same word, and punctuation is noise: this table wrote
 * "Jammu and Kashmir" while `canonicalStateName` answers "Jammu & Kashmir", so every J&K record
 * was reported as a state/pincode conflict when the two agreed perfectly.
 */
const stateKey = (value: string): string =>
  value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');

/**
 * Every form of a state name worth comparing.
 *
 * Two canonicalisers exist and neither covers the roster alone: `canonicalStateName` returns
 * null for "M.P", "A.P", "U.P" and "WB", while `canonicalState` answers "MP" and "JK" — full
 * names for some, abbreviations for others. Taking both, plus the raw value, is what makes the
 * circle check actually run. It was silently skipped on roughly 150 records whose state the
 * first one could not read, which is the worst way for a validation to fail: it reported success.
 */
const stateForms = (state: string): string[] =>
  [canonicalStateName(state), canonicalState(state), state]
    .filter((v): v is string => !!v && v !== 'UNKNOWN')
    .map(stateKey);

export interface PincodeReading {
  pincode: string | null;
  /** Why nothing was taken, for a review queue or a log. Null when one was. */
  reason: string | null;
}

/**
 * The pincode an address ends with, checked against the state it claims.
 *
 * **The last six-digit run, not the first.** Indian addresses put the pincode at the end, and
 * house and plot numbers appear before it: "Z603364, Sundar Nagri, ... Punjab-152116" has two,
 * and only the second is a pincode.
 *
 * `state` is optional — without it the circle check cannot run and only the shape is verified.
 */
export function pincodeFromAddress(
  address: string | null | undefined,
  state?: string | null,
): PincodeReading {
  const runs = String(address ?? '').match(/\d{6}/g);
  if (!runs?.length) return { pincode: null, reason: 'No six-digit number in the address.' };

  const pin = runs[runs.length - 1];

  // 9 is the Army Postal Service, which no appraiser's home address carries. A civilian pincode
  // starts 1–8, so anything else is a house number that happens to be six digits long.
  const circle = POSTAL_CIRCLES[pin[0]];
  if (!circle) {
    return { pincode: null, reason: `"${pin}" is not a civilian pincode — those start 1 to 8.` };
  }

  if (state) {
    const forms = stateForms(state);
    const allowed = new Set(circle.map(stateKey));
    if (forms.length && !forms.some((f) => allowed.has(f))) {
      return {
        pincode: null,
        reason: `"${pin}" belongs to postal circle ${pin[0]} (${circle.slice(0, 3).join(', ')}…), `
          + `but the record says ${canonicalStateName(state) ?? state}. One of the two is wrong.`,
      };
    }
  }

  return { pincode: pin, reason: null };
}

/**
 * The state a record should have said, when its own state column disagrees with its pincode.
 *
 * Four records in the imported roster claim a state their pincode does not belong to. In every
 * one the state column is the wrong half: the district and the address text both name the state
 * the pincode agrees with — "Muzaffarpur, Bihar-847107" filed under U.P, "Murshidabad, West
 * Bengal-742212" filed under U.P, and one whose state column holds "Jahangirpura", a locality in
 * Surat.
 *
 * It matters beyond tidiness because `region` is derived from the state: two of those people are
 * scoped NORTH while living in the East, so the desk that covers them cannot see them and a desk
 * that does not can.
 *
 * Correction only where the evidence is unambiguous — the address names exactly one state from
 * the pincode's own circle. Two candidate states, or none, returns null and leaves a person to
 * decide. Guessing which of two states somebody lives in is how a record acquires a confident
 * wrong answer.
 */
export function stateFromAddressAndPincode(
  address: string | null | undefined,
  pincode: string | null | undefined,
): string | null {
  const pin = String(pincode ?? '').trim();
  const circle = POSTAL_CIRCLES[pin[0]];
  if (!/^\d{6}$/.test(pin) || !circle) return null;

  const haystack = stateKey(String(address ?? ''));
  // Abbreviations are excluded: "AP" and "MP" are two letters and would match inside any number
  // of ordinary words once punctuation is stripped.
  const named = circle.filter((name) => name.length > 4 && haystack.includes(stateKey(name)));

  return named.length === 1 ? named[0] : null;
}
