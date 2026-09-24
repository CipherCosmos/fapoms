import {
  lookupIfsc,
  clearIfscCache,
  resolveBankCode,
  inferIfscFromSolId,
  lookupBranchByIfscOrSol,
} from './ifsc-lookup.helper';

/**
 * The IFSC directory read in two tiers: Razorpay first (the long-standing source),
 * a second keyless directory for codes it 404s. The contract is unchanged —
 * parsed result or null, never a throw — so both the authenticated geo route and
 * the public registration lookup inherit the wider coverage untouched.
 */
describe('lookupIfsc', () => {
  beforeEach(() => {
    clearIfscCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('spends no request on a malformed code', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      await expect(lookupIfsc('NOTACODE')).resolves.toBeNull();
      await expect(lookupIfsc('')).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('answers from the primary directory without touching the fallback', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        BANK: 'HDFC Bank',
        BRANCH: 'MG Road',
        CITY: 'Pune',
        DISTRICT: 'Pune',
        STATE: 'Maharashtra',
        ADDRESS: '101 MG Road, Camp, Pune 411001',
        CONTACT: '+919876543210',
        MICR: '411240002',
      }),
    } as any);
    try {
      const res = await lookupIfsc('hdfc0001234');
      expect(res).toMatchObject({
        bankName: 'HDFC Bank',
        branchName: 'MG Road',
        city: 'Pune',
        district: 'Pune',
        state: 'Maharashtra',
        address: '101 MG Road, Camp, Pune 411001',
        pincode: '411001',
        phone: '+919876543210',
        micr: '411240002',
        ifsc: 'HDFC0001234',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toContain('ifsc.razorpay.com/HDFC0001234');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('serves repeated lookups from cache without issuing network requests', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ BANK: 'HDFC Bank', BRANCH: 'MG Road' }),
    } as any);
    try {
      await lookupIfsc('HDFC0001234');
      await lookupIfsc('HDFC0001234');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('falls through to the second directory when the primary 404s', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ BANK: 'AU Small Finance Bank', BRANCH: 'Main', CITY: 'Jaipur', STATE: 'Rajasthan' }),
      } as any);
    try {
      await expect(lookupIfsc('AUBL0002001')).resolves.toMatchObject({
        bankName: 'AU Small Finance Bank',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[1][0]).toContain('justinclicks.com');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('tries the fallback when the primary request itself fails', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ BANK: 'HDFC Bank', BRANCH: 'MG Road' }),
      } as any);
    try {
      await expect(lookupIfsc('HDFC0001234')).resolves.toMatchObject({ bankName: 'HDFC Bank' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('answers null when neither directory knows the code', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as any);
    try {
      await expect(lookupIfsc('ZZZZ0123456')).resolves.toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('answers null when the fallback answers without a bank', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ SOMETHING: 'else' }) } as any);
    try {
      await expect(lookupIfsc('HDFC0001234')).resolves.toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('IFSC Bank Code Resolution & SOL ID Inference', () => {
  it('resolves bank codes from abbreviations and full client names', () => {
    expect(resolveBankCode('SBI')).toBe('SBIN');
    expect(resolveBankCode('State Bank of India')).toBe('SBIN');
    expect(resolveBankCode('state bank of india')).toBe('SBIN');
    expect(resolveBankCode('STATE BANK OF INDIA')).toBe('SBIN');
    expect(resolveBankCode('St. Bank of India')).toBe('SBIN');
    expect(resolveBankCode('St Bank of India')).toBe('SBIN');
    expect(resolveBankCode('State Bk of India')).toBe('SBIN');
    expect(resolveBankCode('State Bk. of India')).toBe('SBIN');
    expect(resolveBankCode('ST BK OF INDIA')).toBe('SBIN');
    expect(resolveBankCode('S.B.I.')).toBe('SBIN');
    expect(resolveBankCode('S. B. I.')).toBe('SBIN');
    expect(resolveBankCode('SBI Bank')).toBe('SBIN');
    expect(resolveBankCode('State Bank')).toBe('SBIN');
    expect(resolveBankCode('State Bank of Bikaner and Jaipur')).toBe('SBIN');
    expect(resolveBankCode('State Bank of Hyderabad')).toBe('SBIN');
    expect(resolveBankCode('State Bank of Patiala')).toBe('SBIN');
    expect(resolveBankCode('State Bank of Mysore')).toBe('SBIN');
    expect(resolveBankCode('State Bank of Travancore')).toBe('SBIN');
    expect(resolveBankCode('HDFC')).toBe('HDFC');
    expect(resolveBankCode('HDFC Bank Limited')).toBe('HDFC');
    expect(resolveBankCode('ICICI Bank')).toBe('ICIC');
    expect(resolveBankCode('Axis Bank')).toBe('UTIB');
    expect(resolveBankCode('UTI Bank')).toBe('UTIB');
    expect(resolveBankCode('RBL')).toBe('RATN');
    expect(resolveBankCode('RBL Bank')).toBe('RATN');
    expect(resolveBankCode('The Ratnakar Bank Ltd')).toBe('RATN');
    expect(resolveBankCode('RATN')).toBe('RATN');
    expect(resolveBankCode('Kotak Mahindra Bank')).toBe('KKBK');
    expect(resolveBankCode('IndusInd Bank')).toBe('INDB');
    expect(resolveBankCode('AU Small Finance Bank')).toBe('AUBL');
    expect(resolveBankCode('Equitas Small Finance Bank')).toBe('ESFB');
    expect(resolveBankCode('CSB Bank')).toBe('CSBK');
    expect(resolveBankCode('City Union Bank')).toBe('CIUB');
    expect(resolveBankCode('Punjab National Bank')).toBe('PUNB');
    expect(resolveBankCode('Punjab Natl Bank')).toBe('PUNB');
    expect(resolveBankCode('Canara Bank')).toBe('CNRB');
    expect(resolveBankCode('Unknown Non Bank')).toBeNull();
  });

  it('infers valid 11-char IFSC codes from bank identifiers and branch SOL IDs', () => {
    expect(inferIfscFromSolId('HDFC', '1042')).toBe('HDFC0001042');
    expect(inferIfscFromSolId('State Bank of India', '14')).toBe('SBIN0000014');
    expect(inferIfscFromSolId('ICICI', 'SOL-4021')).toBe('ICIC0004021');
    expect(inferIfscFromSolId('RBL Bank', '1050')).toBe('RATN0001050');
    expect(inferIfscFromSolId('The Ratnakar Bank', '99')).toBe('RATN0000099');
    expect(inferIfscFromSolId('Axis Bank', '502')).toBe('UTIB0000502');
    expect(inferIfscFromSolId('HDFC', 'HDFC0001042')).toBe('HDFC0001042');
  });

  it('lookupBranchByIfscOrSol transparently looks up by IFSC or inferred SOL ID', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ BANK: 'HDFC Bank', BRANCH: 'Uppal', CITY: 'Hyderabad', STATE: 'Telangana' }),
    } as any);
    try {
      const res = await lookupBranchByIfscOrSol('HDFC', '1042');
      expect(res).toMatchObject({ bankName: 'HDFC Bank', branchName: 'Uppal' });
      expect(fetchSpy.mock.calls[0][0]).toContain('HDFC0001042');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
