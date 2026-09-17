import { lookupIfsc } from './ifsc-lookup.helper';

/**
 * The IFSC directory read in two tiers: Razorpay first (the long-standing source),
 * a second keyless directory for codes it 404s. The contract is unchanged —
 * parsed result or null, never a throw — so both the authenticated geo route and
 * the public registration lookup inherit the wider coverage untouched.
 */
describe('lookupIfsc', () => {
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
      json: async () => ({ BANK: 'HDFC Bank', BRANCH: 'MG Road', CITY: 'Pune', STATE: 'Maharashtra' }),
    } as any);
    try {
      await expect(lookupIfsc('hdfc0001234')).resolves.toMatchObject({ bankName: 'HDFC Bank' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toContain('ifsc.razorpay.com/HDFC0001234');
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
