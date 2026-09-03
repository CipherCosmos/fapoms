import {
  PLACEHOLDER_PIN_METRES,
  isPlaceholderPin,
  missingAssayerRecordFields,
  splitMissingByOwnership,
} from './assayer-record';

/**
 * A coordinate can be present and still be nothing.
 *
 * Creating an assayer geocodes the address, so somebody entered with nothing but a state comes
 * straight back holding that state's centroid — accurate to about two hundred kilometres, and not
 * blank, so every "is this field filled in?" test said yes. The registration flow's review step
 * listed Phone, PAN, Bank and IFSC as gaps and said nothing about Map location; the roster's
 * "incomplete record" filter agreed with it. Meanwhile the data-integrity scan raised the same
 * record as "Home pin is a placeholder, not a home" — one record, two answers, and the reassuring
 * one on the screen a clerk actually reads.
 *
 * A wrong pin is worse than an absent one. `recommendation.engine.ts` lets a candidate through its
 * distance check when a coordinate is missing, which is at least a known blind spot; a centroid
 * gets measured against as though it were a house.
 */
describe('a pin that is a placeholder rather than a home', () => {
  const complete = {
    phone: '+919000000000',
    panNumber: 'ABCDE1234F',
    bankAccountNumber: '12345678901',
    ifscCode: 'HDFC0000123',
    joiningDate: '2024-01-01',
    emergencyContactPhone: '+919000000001',
    latitude: 19.7515,
    longitude: 75.7139,
  };

  it('counts Map location as missing when the pin is a state centroid', () => {
    const gaps = missingAssayerRecordFields({
      ...complete,
      geoAccuracyMeters: PLACEHOLDER_PIN_METRES,
    });

    expect(gaps.map((f) => f.key)).toEqual(['latitude']);
  });

  it('counts it missing for the country-centre fallback too', () => {
    const gaps = missingAssayerRecordFields({ ...complete, geoAccuracyMeters: 500_000 });

    expect(gaps.map((f) => f.key)).toContain('latitude');
  });

  it('leaves a real pin alone', () => {
    // A resolved address lands in metres or a few kilometres; a pincode pin is ~3 km.
    expect(missingAssayerRecordFields({ ...complete, geoAccuracyMeters: 3_000 })).toEqual([]);
    expect(missingAssayerRecordFields({ ...complete, geoAccuracyMeters: 25 })).toEqual([]);
  });

  it('says nothing about a record that never carried the accuracy figure', () => {
    // A half-filled registration form, or a projection selected for something else. Reading an
    // absent number as bad news would put a gap on screen for a pin that may be perfectly good.
    expect(missingAssayerRecordFields(complete)).toEqual([]);
    expect(isPlaceholderPin(complete)).toBe(false);
    expect(isPlaceholderPin(null)).toBe(false);
  });

  it('still reports an absent coordinate, and does not report it twice', () => {
    const gaps = missingAssayerRecordFields({
      ...complete,
      latitude: null,
      longitude: null,
      geoAccuracyMeters: PLACEHOLDER_PIN_METRES,
    });

    expect(gaps.filter((f) => f.key === 'latitude')).toHaveLength(1);
  });

  it('reads the snake_case column name as well, for callers that pass a raw row', () => {
    expect(isPlaceholderPin({ geo_accuracy_meters: 100_000 })).toBe(true);
    expect(isPlaceholderPin({ geo_accuracy_meters: 900 })).toBe(false);
  });

  it('puts the gap on the assayer, who can move their own pin', () => {
    const { yours, hr } = splitMissingByOwnership({
      ...complete,
      geoAccuracyMeters: PLACEHOLDER_PIN_METRES,
    });

    expect(yours.map((f) => f.key)).toContain('latitude');
    expect(hr.map((f) => f.key)).not.toContain('latitude');
  });
});
