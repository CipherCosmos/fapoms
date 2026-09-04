import { lookupIfsc } from './ifsc-lookup.helper';

/**
 * Mirrors the resilience contract `autocompleteIndia` already has: never throw, and never call
 * the network for input that cannot possibly be valid.
 */
describe('lookupIfsc', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('never calls fetch for a malformed code', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const result = await lookupIfsc('not-an-ifsc');

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null (not a throw) when the network call rejects', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('network down'));
    global.fetch = fetchMock as any;

    const result = await lookupIfsc('SBIN0001234');

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on a 404 (unknown but valid-shaped code) without throwing', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    global.fetch = fetchMock as any;

    const result = await lookupIfsc('SBIN0009999');

    expect(result).toBeNull();
  });

  it('maps the raw Razorpay field names to the typed shape on a successful lookup', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        BANK: 'State Bank of India',
        BRANCH: 'MUMBAI MAIN',
        ADDRESS: 'FORT, MUMBAI',
        CITY: 'MUMBAI',
        DISTRICT: 'MUMBAI',
        STATE: 'MAHARASHTRA',
      }),
    });
    global.fetch = fetchMock as any;

    const result = await lookupIfsc('sbin0000001');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ifsc.razorpay.com/SBIN0000001',
      expect.anything(),
    );
    expect(result).toEqual({
      bankName: 'State Bank of India',
      branchName: 'MUMBAI MAIN',
      city: 'MUMBAI',
      state: 'MAHARASHTRA',
      address: 'FORT, MUMBAI',
    });
  });
});
