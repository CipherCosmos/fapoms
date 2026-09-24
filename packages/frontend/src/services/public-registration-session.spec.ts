import {
  hydrateRegistration, verifyRegistrationOtp, updateRegistrationDraft, requestRegistrationOtp,
  REGISTRATION_SESSION_HEADER, rememberRegistrationSession,
} from './public-registration';

/**
 * The session key a right code mints is kept for this tab and sent back on every read of saved
 * answers — the header is what the server unlocks the PAN, Aadhaar, bank and scans on.
 */
describe('registration session key', () => {
  const ok = (data: unknown) => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, data }),
  });
  let fetchMock: jest.Mock;

  beforeEach(() => {
    sessionStorage.clear();
    fetchMock = jest.fn(async () => ok({}));
    (global as any).fetch = fetchMock;
  });

  const headersOf = (call: number) => (fetchMock.mock.calls[call][1]?.headers ?? {}) as Record<string, string>;

  it('sends no key before a code has been proven', async () => {
    await hydrateRegistration('tok-abcdefghijklmnopqrstuvwxyz');
    expect(headersOf(0)[REGISTRATION_SESSION_HEADER]).toBeUndefined();
  });

  it('keeps the key from a right code and sends it on hydrate, draft save and code request', async () => {
    const token = 'tok-abcdefghijklmnopqrstuvwxyz';
    fetchMock.mockResolvedValueOnce(ok({ verified: true, channel: 'SMS', sessionKey: 'session-key-123' }));
    await verifyRegistrationOtp(token, '9822014455', '123456');

    await hydrateRegistration(token);
    await updateRegistrationDraft(token, { fullName: 'R' });
    await requestRegistrationOtp(token, '9822014455');
    for (const i of [1, 2, 3]) expect(headersOf(i)[REGISTRATION_SESSION_HEADER]).toBe('session-key-123');
  });

  it('does not lend one link’s key to another', async () => {
    rememberRegistrationSession('tok-aaaaaaaaaaaaaaaaaaaaaaaa1', 'k1');
    await hydrateRegistration('tok-bbbbbbbbbbbbbbbbbbbbbbbbb2');
    expect(headersOf(0)[REGISTRATION_SESSION_HEADER]).toBeUndefined();
  });
});
