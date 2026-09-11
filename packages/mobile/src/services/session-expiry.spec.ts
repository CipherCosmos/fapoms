/**
 * A revoked session must reach the screen, not just the keystore.
 *
 * `doRefresh` has always destroyed the tokens when the server rejects the refresh token. What it
 * did not do was say so. `AuthContext` kept `isAuthenticated` true, App.tsx went on rendering the
 * tabs, and every read 401'd into the "showing your last synced schedule" banner — an assayer
 * reading yesterday's jobs with no prompt to sign in and no way out but force-quitting, since the
 * cold-start `validateSession` is the only other thing that notices.
 *
 * Seen for real on the emulator: an HR password reset revokes the running session, so the app's
 * next request answers 401 and the refresh answers 401 "Invalid or expired refresh token". The
 * 403 PASSWORD_CHANGE_REQUIRED gate that `password-rotation-gate.spec.ts` covers can never fire
 * in that case — the token is dead before the server gets as far as the rotation guard.
 *
 * The other half matters just as much and is why this is not simply "sign out on any 401": a 5xx
 * from a restarting API, a 429, or no signal at all must leave the session ALONE. Being unable to
 * ask is not an answer, and the handset is often in a strongroom with no bars to sign back in on.
 */

jest.mock('react-native', () => ({ Platform: { OS: 'android', select: (o: any) => o.android } }));
jest.mock('expo-file-system', () => ({}));
jest.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
jest.mock('./token-store', () => ({
  readToken: jest.fn().mockResolvedValue(null),
  writeToken: jest.fn().mockResolvedValue(undefined),
  deleteToken: jest.fn().mockResolvedValue(undefined),
  ALL_TOKEN_KEYS: [],
}));
jest.mock('./server-config', () => ({
  getDefaultServerUrl: () => 'http://localhost:3000/api/v1',
  loadStoredServerUrl: jest.fn().mockResolvedValue(null),
  saveServerUrl: jest.fn(),
  clearServerUrl: jest.fn(),
  normaliseServerUrl: (u: string) => u,
}));

import { MobileApiService } from './api.service';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The server's answer once the refresh token has been revoked. */
const REFRESH_REJECTED = () =>
  json({ statusCode: 401, message: 'Invalid or expired refresh token' }, 401);

/** A signed-in session holding both tokens, as `login()` would have left it. */
const signedIn = () => {
  MobileApiService.setAuthToken('token-1', 'assayer-1', 'Nilesh Rahane');
  // There has to be one to reject: with no refresh token `doRefresh` returns early and never
  // reaches the branch under test.
  MobileApiService.refreshToken = 'refresh-1';
};

describe('a session the server has revoked', () => {
  let expired: number;

  beforeEach(() => {
    expired = 0;
    MobileApiService.onSessionExpired = () => { expired += 1; };
  });

  afterEach(() => {
    MobileApiService.onSessionExpired = null;
    MobileApiService.clearSession();
  });

  it('tells the app, so it can stop drawing a signed-in screen', async () => {
    signedIn();
    global.fetch = jest.fn(async (url: string) =>
      String(url).includes('/auth/refresh') ? REFRESH_REJECTED() : json({ message: 'Unauthorized' }, 401),
    ) as any;

    const res = await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/assignments/assayer/assayer-1');

    expect(res.status).toBe(401);
    expect(expired).toBe(1);
    expect(MobileApiService.getAuthToken()).toBeNull();
  });

  it('leaves the session alone when the refresh server is merely unwell', async () => {
    signedIn();
    // A 502 from a restarting API. The token may be perfectly good; only the server is not.
    global.fetch = jest.fn(async (url: string) =>
      String(url).includes('/auth/refresh')
        ? json({ message: 'Bad Gateway' }, 502)
        : json({ message: 'Unauthorized' }, 401),
    ) as any;

    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/assignments/assayer/assayer-1');

    expect(expired).toBe(0);
    expect(MobileApiService.getAuthToken()).toBe('token-1');
  });

  it('leaves the session alone when there is no signal at all', async () => {
    signedIn();
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes('/auth/refresh')) throw new TypeError('Network request failed');
      return json({ message: 'Unauthorized' }, 401);
    }) as any;

    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/assignments/assayer/assayer-1');

    expect(expired).toBe(0);
    expect(MobileApiService.getAuthToken()).toBe('token-1');
  });

  it('does not raise expiry on an ordinary successful request', async () => {
    signedIn();
    global.fetch = jest.fn(async () => json({ success: true }, 200)) as any;

    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/thing');

    expect(expired).toBe(0);
    expect(MobileApiService.getAuthToken()).toBe('token-1');
  });
});
