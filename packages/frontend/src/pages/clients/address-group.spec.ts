import { applyPlaceToAddressGroup, composeAddress, emptyAddressGroup, stateOptionsFor } from './address-group';

/**
 * The address breakdown clients never had (see CLAUDE-facing task notes): a pincode/city/
 * district/state cross-fill built on `IndiaPlaceResult`, folded back into the one text column
 * `clients.address` / `client_billing.billing_address` actually store. The properties that
 * matter here are the ones that would silently regress a save: an existing free-text address
 * must round-trip untouched, and picking a place must actually update the other fields.
 */

const place = {
  label: 'Kothrud, Pune',
  type: 'city',
  state: 'MAHARASHTRA',
  district: 'Pune',
  pincode: '411038',
};

describe('composeAddress', () => {
  it('preserves an existing free-text address verbatim when the breakdown is never touched', () => {
    // This is the capability-preservation case: an address this feature's autocomplete does
    // not recognise (or a value with commas/spacing of its own) must still be accepted and
    // saved exactly as typed, not silently rewritten.
    const group = emptyAddressGroup('C/o Sharma & Sons, near the old bus stand');
    expect(composeAddress(group)).toBe('C/o Sharma & Sons, near the old bus stand');
  });

  it('folds a fully filled breakdown into one string', () => {
    const group = { address: 'Plot 12, MG Road', city: 'Pune', district: 'Pune', state: 'Maharashtra', pincode: '411001' };
    expect(composeAddress(group)).toBe('Plot 12, MG Road, Pune, Pune, Maharashtra - 411001');
  });

  it('omits blank parts rather than leaving stray separators', () => {
    const group = { address: '', city: 'Pune', district: '', state: '', pincode: '411001' };
    expect(composeAddress(group)).toBe('Pune - 411001');
  });

  it('composes to an empty string when nothing at all was entered', () => {
    expect(composeAddress(emptyAddressGroup())).toBe('');
  });
});

describe('applyPlaceToAddressGroup', () => {
  it('picking a pincode result fills district, city and a canonicalised state', () => {
    const next = applyPlaceToAddressGroup('pincode', place, emptyAddressGroup());
    expect(next.pincode).toBe('411038');
    expect(next.district).toBe('Pune');
    expect(next.city).toBe('Kothrud');
    expect(next.state).toBe('Maharashtra'); // canonicalStateName turns MAHARASHTRA into this
  });

  it('does not overwrite a city the operator already typed', () => {
    const next = applyPlaceToAddressGroup('pincode', place, { ...emptyAddressGroup(), city: 'Old City Name' });
    expect(next.city).toBe('Old City Name');
  });

  it('leaves the free-text address line alone', () => {
    const next = applyPlaceToAddressGroup('pincode', place, emptyAddressGroup('Plot 12, MG Road'));
    expect(next.address).toBe('Plot 12, MG Road');
  });
});

describe('stateOptionsFor', () => {
  it('adds an "(as recorded)" option for a legacy value outside the static list', () => {
    const options = stateOptionsFor('MAHARASHTRA'); // the roster spelling, not the canonical one
    expect(options.some((o) => o.value === 'MAHARASHTRA' && o.label.includes('as recorded'))).toBe(true);
  });

  it('does not add a second option for a value already in the list', () => {
    const options = stateOptionsFor('Kerala');
    expect(options.filter((o) => o.value === 'Kerala')).toHaveLength(1);
  });

  it('is just the static list when nothing has been chosen yet', () => {
    const options = stateOptionsFor('');
    expect(options.some((o) => o.label.includes('as recorded'))).toBe(false);
  });
});
