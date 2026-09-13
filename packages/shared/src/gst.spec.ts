import {
  GST_STATE_CODES,
  gstStateCodeToName,
  gstinStateCode,
  gstStateNameToCode,
  resolveGstStateCode,
  numberToIndianWords,
} from './gst';

describe('gstStateCodeToName', () => {
  it('resolves a known code to its state name', () => {
    expect(gstStateCodeToName('27')).toBe('Maharashtra');
    expect(gstStateCodeToName('99')).toBe('Centre Jurisdiction');
  });

  it('pads a single digit before looking it up', () => {
    expect(gstStateCodeToName('7')).toBe('Delhi');
  });

  it('returns null for an unknown code, and for nothing at all', () => {
    expect(gstStateCodeToName('50')).toBeNull();
    expect(gstStateCodeToName(null)).toBeNull();
    expect(gstStateCodeToName(undefined)).toBeNull();
    expect(gstStateCodeToName('')).toBeNull();
  });
});

describe('gstinStateCode', () => {
  it('reads the state code off a well-formed GSTIN', () => {
    expect(gstinStateCode('27ABCDE1234F1Z5')).toBe('27');
  });

  it('uppercases before matching, so a lowercase GSTIN still resolves', () => {
    expect(gstinStateCode('27abcde1234f1z5')).toBe('27');
  });

  it('rejects a value that is not GSTIN-shaped', () => {
    expect(gstinStateCode('not-a-gstin')).toBeNull();
    expect(gstinStateCode('27ABCDE1234F1Z')).toBeNull(); // 14 chars, one short
    expect(gstinStateCode('ABCDE1234F1Z5AB')).toBeNull(); // doesn't start with 2 digits
    expect(gstinStateCode(null)).toBeNull();
    expect(gstinStateCode(undefined)).toBeNull();
  });

  it('rejects a shape-valid GSTIN whose prefix is not a real state code', () => {
    // '50' is not a key in GST_STATE_CODES — shape alone must not be trusted.
    expect(GST_STATE_CODES['50']).toBeUndefined();
    expect(gstinStateCode('50ABCDE1234F1Z5')).toBeNull();
  });
});

describe('gstStateNameToCode', () => {
  it('resolves the canonical spelling', () => {
    expect(gstStateNameToCode('Maharashtra')).toBe('27');
  });

  it('is tolerant of case and punctuation', () => {
    expect(gstStateNameToCode('MAHARASHTRA')).toBe('27');
    expect(gstStateNameToCode('  maharashtra  ')).toBe('27');
  });

  it('accepts the common alternative spellings client records carry', () => {
    expect(gstStateNameToCode('Orissa')).toBe('21');
    expect(gstStateNameToCode('Pondicherry')).toBe('34');
    expect(gstStateNameToCode('New Delhi')).toBe('07');
  });

  it('resolves Andhra Pradesh to the modern code (37), not the legacy one (28) — the exact ' +
    'ambiguity the module comment calls out, verified rather than assumed', () => {
    expect(gstStateNameToCode('Andhra Pradesh')).toBe('37');
  });

  it('returns null for a name it does not recognise', () => {
    expect(gstStateNameToCode('Narnia')).toBeNull();
    expect(gstStateNameToCode(null)).toBeNull();
  });
});

describe('resolveGstStateCode', () => {
  it('prefers the GSTIN over a typed state name when both are present', () => {
    expect(resolveGstStateCode({ gstin: '27ABCDE1234F1Z5', stateName: 'Kerala' })).toBe('27');
  });

  it('falls back to the state name when there is no GSTIN', () => {
    expect(resolveGstStateCode({ stateName: 'Kerala' })).toBe('32');
  });

  it('falls back to the state name when the GSTIN does not resolve', () => {
    expect(resolveGstStateCode({ gstin: 'garbage', stateName: 'Kerala' })).toBe('32');
  });

  it('returns null when neither yields a code', () => {
    expect(resolveGstStateCode({})).toBeNull();
    expect(resolveGstStateCode({ gstin: 'garbage', stateName: 'Narnia' })).toBeNull();
  });
});

describe('numberToIndianWords', () => {
  it('renders the module doc comment\'s own worked example exactly', () => {
    // 1,20,500.50 -> one lakh, twenty thousand, five hundred rupees, and fifty paise.
    expect(numberToIndianWords(120500.5)).toBe(
      'Indian Rupees One Lakh Twenty Thousand Five Hundred and Fifty Paise Only',
    );
  });

  it('omits the paise clause entirely when there are none', () => {
    expect(numberToIndianWords(500)).toBe('Indian Rupees Five Hundred Only');
  });

  it('handles zero', () => {
    expect(numberToIndianWords(0)).toBe('Indian Rupees Zero Only');
    expect(numberToIndianWords(null)).toBe('Indian Rupees Zero Only');
    expect(numberToIndianWords(undefined)).toBe('Indian Rupees Zero Only');
  });

  it('words a negative amount as its magnitude with a leading Minus, rather than dropping the sign', () => {
    expect(numberToIndianWords(-50)).toBe('Minus Indian Rupees Fifty Only');
  });

  it('treats a non-finite input as zero rather than throwing or printing NaN', () => {
    expect(numberToIndianWords('not a number')).toBe('Indian Rupees Zero Only');
    expect(numberToIndianWords(Infinity)).toBe('Indian Rupees Zero Only');
  });

  it('reaches into crore for a large amount', () => {
    expect(numberToIndianWords(10_000_000)).toBe('Indian Rupees One Crore Only');
  });

  it('accepts a numeric string the same as a number', () => {
    expect(numberToIndianWords('500')).toBe(numberToIndianWords(500));
  });
});
