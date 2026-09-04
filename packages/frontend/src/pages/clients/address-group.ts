import { INDIAN_STATES, canonicalStateName } from '@fapoms/shared';
import type { IndiaPlaceResult } from '../../components/ui/Autocomplete';

/**
 * The five-field address breakdown (Autocomplete-backed pincode/city/district/state, plus a
 * free-text line) that Branches.tsx and the assayer registration wizard already use.
 *
 * Clients differ from branches and assayers in one respect that matters here: the `clients`
 * table (and `client_billing`) store address as a single text column, not four separate ones.
 * There was no migration for this feature, so the breakdown below exists purely for entry - the
 * Autocomplete gives the office a real place to pick instead of typing blind - and `composeAddress`
 * folds the result back into the one string the API actually accepts. An existing client's or
 * billing profile's free-text address is never parsed apart to seed these fields; it starts out
 * sitting whole in `address`, so leaving pincode/city/district/state untouched round-trips the
 * old value exactly.
 */
export interface AddressGroup {
  address: string;
  pincode: string;
  district: string;
  city: string;
  state: string;
}

export const emptyAddressGroup = (address = ''): AddressGroup => ({
  address, pincode: '', district: '', city: '', state: '',
});

/**
 * Same mechanism as `applyPlaceToBranch` in Branches.tsx, adapted to this file's field names.
 * Picking a real place from any of the three geo-backed fields fills state, district and (when
 * it is not already set) city - the fields the lookup already knows the moment it knows one of
 * them.
 */
export function applyPlaceToAddressGroup(
  fieldKey: 'city' | 'district' | 'pincode',
  place: IndiaPlaceResult,
  group: AddressGroup,
): AddressGroup {
  const primary = (place.label || '').split(',')[0].trim();
  const next = { ...group };
  if (place.state) {
    // Canonicalised for the same reason Branches does it: State renders as a <select> matching
    // by exact string, and a raw "MAHARASHTRA" from the lookup would land on "Select..." instead
    // of the option it actually means.
    next.state = canonicalStateName(place.state) ?? place.state;
  }
  if (place.district) next.district = place.district;
  if (fieldKey === 'city') next.city = primary;
  if (fieldKey === 'district') {
    next.district = place.district || primary;
    if (!next.city) next.city = primary;
  }
  if (fieldKey === 'pincode') {
    if (place.pincode) next.pincode = place.pincode;
    if (!next.city) next.city = primary;
  }
  return next;
}

/**
 * Folds the breakdown back into the single string the `address` / `billingAddress` column
 * stores. Parts left blank are simply omitted - most importantly, a group whose city/district/
 * state/pincode were never touched composes back to exactly `address.trim()`, so an existing
 * free-text address this feature's autocomplete does not recognise is preserved verbatim rather
 * than being silently rewritten or rejected.
 */
export function composeAddress(group: AddressGroup): string {
  const parts = [group.address, group.city, group.district, group.state]
    .map((s) => (s || '').trim())
    .filter(Boolean);
  const line = parts.join(', ');
  const pincode = (group.pincode || '').trim();
  if (!pincode) return line;
  return line ? `${line} - ${pincode}` : pincode;
}

/**
 * State options for a <Select>, with the branch form's exact escape hatch: a legacy value that
 * predates (or simply is not in) the static list gets its own option labelled "(as recorded)"
 * instead of being dropped from the dropdown or blocked from saving.
 */
export function stateOptionsFor(currentState: string): { value: string; label: string }[] {
  if (!currentState || INDIAN_STATES.some((s) => s.value === currentState)) return INDIAN_STATES;
  return [...INDIAN_STATES, { value: currentState, label: `${currentState} (as recorded)` }];
}
