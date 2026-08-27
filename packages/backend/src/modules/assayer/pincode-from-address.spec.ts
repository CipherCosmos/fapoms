import { pincodeFromAddress } from '@fapoms/shared';

/**
 * Reading a pincode out of an address the roster kept as free text.
 *
 * Every address below is real, from the imported appraiser roster. 1,111 of 1,163 records carry
 * a pincode inside `address` and 8 have it in the column, so every screen reporting a missing
 * pincode — and every geocoder that would use one — was reading the empty field.
 *
 * The rule these tests hold is that a wrong pincode is worse than none. It is the strongest
 * signal the geocoder has, so a bad one places somebody's home in another state with more
 * confidence than a blank ever would.
 */
describe('reading a pincode out of an address', () => {
  it('takes the one at the end, where Indian addresses put it', () => {
    expect(pincodeFromAddress('S/O Shripad Raikar, Plot No-71, Phulewadi, Kolhapur, Maharashtra-416010', 'Maharashtra').pincode)
      .toBe('416010');
  });

  it('is not fooled by a six-digit house number earlier in the line', () => {
    // Real row: "Z603364" is a house number and "152116" is the pincode. Taking the first match
    // would have filed this person in Maharashtra instead of Punjab.
    const address = 'S/O Subhash Chander Soni, Z603364,Sundar Nagri,Galli No 7 A, Abohar, Fazilka, Punjab-152116';
    expect(pincodeFromAddress(address, 'Punjab').pincode).toBe('152116');
  });

  it('reads the roster\'s abbreviated state names', () => {
    // The file writes "M.P" and "A.P"; canonicalStateName is what makes the circle check work.
    expect(pincodeFromAddress('LIG Colony, 85, Near Shiv Mandir, Singrauli, M.P-486889', 'M.P').pincode)
      .toBe('486889');
  });

  describe('what it refuses', () => {
    it('an address with no six-digit run at all', () => {
      const { pincode, reason } = pincodeFromAddress('Near the temple, Arani', 'Tamil Nadu');
      expect(pincode).toBeNull();
      expect(reason).toMatch(/no six-digit number/i);
    });

    it('a six-digit number that is not a civilian pincode', () => {
      // 9 is the Army Postal Service. A home address carrying one is a house number.
      const { pincode, reason } = pincodeFromAddress('Flat 900123, Somewhere', 'Kerala');
      expect(pincode).toBeNull();
      expect(reason).toMatch(/start 1 to 8/i);
    });

    it('a pincode from a postal circle the state does not belong to', () => {
      // 416010 is Maharashtra (circle 4). A record claiming Kerala is wrong about one of the two,
      // and writing the number in anyway would geocode this person 1,000 km from home.
      const { pincode, reason } = pincodeFromAddress('Somewhere, 416010', 'Kerala');
      expect(pincode).toBeNull();
      expect(reason).toMatch(/postal circle 4/i);
    });
  });

  it('checks only the shape when the state is unknown', () => {
    // Better than nothing: a well-formed pincode with no state to check it against is still
    // worth more to the geocoder than a blank field.
    expect(pincodeFromAddress('Somewhere, 416010', null).pincode).toBe('416010');
  });

  it.each([
    ['Delhi', '110015'], ['Uttar Pradesh', '226001'], ['Rajasthan', '335512'],
    ['Madhya Pradesh', '486889'], ['Karnataka', '560001'], ['Kerala', '688005'],
    ['West Bengal', '700001'], ['Bihar', '800001'],
  ])('accepts a %s address with pincode %s', (state, pin) => {
    expect(pincodeFromAddress(`Some road, ${pin}`, state).pincode).toBe(pin);
  });

  /**
   * The state check has to survive the spellings the roster actually uses, or it fails in the
   * worst way available: silently reporting success.
   */
  describe('reading the state it is checked against', () => {
    it('accepts J&K, whose pincodes really are postal circle 1', () => {
      // The first version wrote "Jammu and Kashmir" in its table while canonicalStateName answers
      // "Jammu & Kashmir", so every J&K record was refused as a conflict when the two agreed.
      expect(pincodeFromAddress('Majalta, Jib, Udhampur, J&K 182121', 'J&K').pincode).toBe('182121');
      expect(pincodeFromAddress('Gulab Bagh Zakura, Srinagar, J&K-190006', 'Jammu & Kashmir').pincode)
        .toBe('190006');
    });

    it('checks abbreviations the first canonicaliser cannot read', () => {
      // canonicalStateName returns null for "M.P", "A.P", "U.P" and "WB". A null used to skip the
      // check entirely, so roughly 150 records were filled with no validation at all.
      expect(pincodeFromAddress('Somewhere, M.P-452001', 'M.P').pincode).toBe('452001');
      expect(pincodeFromAddress('Somewhere, U.P-226001', 'U.P').pincode).toBe('226001');

      // And the check now actually catches a conflict stated in an abbreviation.
      expect(pincodeFromAddress('Somewhere, 600001', 'M.P').pincode).toBeNull();
    });

    it('still refuses a real conflict, whichever spelling states it', () => {
      // Real rows: a record whose state column says Tamil Nadu with an Andhra address, and one
      // saying Punjab with an Indore address.
      expect(pincodeFromAddress('12-131 Bajar Street, Chittoor, A.P-517001', 'Tamil Nadu').pincode).toBeNull();
      expect(pincodeFromAddress('18/3 Murai Mohalla, Indore, M.P-452001', 'Punjab').pincode).toBeNull();
    });
  });
});
