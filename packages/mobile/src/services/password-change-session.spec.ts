/**
 * Changing your password must not leave the app holding a dead session.
 *
 * Verified against the running backend: `POST /assayers/me/change-password` answers 201 and
 * revokes everything the caller holds. The same access token immediately answers
 * `401 "User not found or inactive"`, and `POST /auth/refresh` with the refresh token from that
 * session answers `401 "Invalid or expired refresh token"`. No replacement pair is returned.
 *
 * The app used to read the 201 as "done" and carry on. It then looked signed in while every
 * request 401'd and `tryRefresh()` could not help, so the forced-rotation gate — the screen whose
 * whole job is to stop an assayer being stranded on an issued password — dropped them onto a home
 * screen reading "Nothing scheduled" with their actual job invisible. Only force-quitting cleared
 * it, because the cold-start `validateSession` is the single path that notices a dead token.
 *
 * So: sign in again with the password just chosen, silently. And if that cannot be done, destroy
 * the session rather than leave it half-alive — `reauthRequired` sends the caller to the login
 * screen, which is worse to use and honest about what happened.
 *
 * Native modules are mocked away rather than loaded; this suite runs in node and none of the
 * code under test touches them.
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

/** What the backend actually returns from the change route — no tokens in it. */
const CHANGE_OK = { success: true, message: 'Your password has been changed.' };

/** A fresh sign-in, carrying the replacement pair. */
const loginOk = (token: string) =>
  json(
    {
      success: true,
      data: {
        accessToken: token,
        refreshToken: `${token}-refresh`,
        user: { id: 'assayer-1', username: 'AS-01', name: 'Nilesh Rahane' },
      },
    },
    200,
  );

/**
 * Route by path, because one call to `changeOwnPassword` now makes two requests. The cache-buster
 * `fetchWithAuthOnce` appends means these have to be substring matches, not equality.
 */
const router = (handlers: { change?: () => Response; login?: () => Response }) =>
  jest.fn(async (url: string, init?: RequestInit) => {
    void init;
    if (String(url).includes('/assayers/me/change-password')) {
      return (handlers.change ?? (() => json(CHANGE_OK, 201)))();
    }
    if (String(url).includes('/auth/login')) {
      return (handlers.login ?? (() => loginOk('token-2')))();
    }
    throw new Error(`unexpected request: ${url}`);
  });

/** A signed-in session, as `login()` would have left it. */
const signedIn = () => {
  MobileApiService.setAuthToken('token-1', 'assayer-1', 'Nilesh Rahane');
  MobileApiService.setLoginId('AS-01');
};

describe('the session across a password change', () => {
  afterEach(() => {
    MobileApiService.clearSession();
  });

  it('signs back in behind the scenes, so the assayer keeps their place', async () => {
    signedIn();
    global.fetch = router({}) as any;

    const res = await MobileApiService.changeOwnPassword('old-one', 'new-one');

    expect(res).toEqual({ success: true });
    expect(res.reauthRequired).toBeUndefined();
    // The replacement pair is installed — not the revoked one it started with.
    expect(MobileApiService.getAuthToken()).toBe('token-2');
    expect(MobileApiService.currentUserId).toBe('assayer-1');
  });

  it('signs in with the NEW password, not the old one', async () => {
    signedIn();
    const fetchMock = router({});
    global.fetch = fetchMock as any;

    await MobileApiService.changeOwnPassword('old-one', 'new-one');

    const loginCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/auth/login'));
    expect(loginCall).toBeDefined();
    const body = JSON.parse(String(loginCall![1]?.body));
    // The identifier is the one typed at sign-in, never the display name.
    expect(body).toEqual({ username: 'AS-01', password: 'new-one' });
  });

  it('destroys the session when it cannot sign back in, rather than leaving it dead-but-present', async () => {
    signedIn();
    global.fetch = router({ login: () => json({ success: false, message: 'Invalid credentials' }, 401) }) as any;

    const res = await MobileApiService.changeOwnPassword('old-one', 'new-one');

    // The change itself DID happen — saying otherwise would invite the assayer to redo it with a
    // "current password" that is no longer current.
    expect(res.success).toBe(true);
    expect(res.reauthRequired).toBe(true);
    expect(MobileApiService.getAuthToken()).toBeNull();
  });

  it('destroys the session when no sign-in identifier was ever stored', async () => {
    // A session restored by a build that predates `fapoms_assayer_loginId`.
    MobileApiService.setAuthToken('token-1', 'assayer-1', 'Nilesh Rahane');
    const fetchMock = router({});
    global.fetch = fetchMock as any;

    const res = await MobileApiService.changeOwnPassword('old-one', 'new-one');

    expect(res).toEqual({ success: true, reauthRequired: true });
    expect(MobileApiService.getAuthToken()).toBeNull();
    // Nothing was guessed at: no sign-in was attempted with an identifier it did not have.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/auth/login'))).toBe(false);
  });

  it('leaves the session alone when the change is refused', async () => {
    signedIn();
    const fetchMock = router({
      change: () => json({ success: false, message: 'Your current password is not correct.' }, 400),
    });
    global.fetch = fetchMock as any;

    const res = await MobileApiService.changeOwnPassword('wrong-one', 'new-one');

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not correct/i);
    // Still signed in on the original token: nothing was revoked, so nothing needs rebuilding.
    expect(MobileApiService.getAuthToken()).toBe('token-1');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/auth/login'))).toBe(false);
  });

  it('forgets the sign-in identifier on sign-out, so a shared handset does not leak it', () => {
    signedIn();
    expect(MobileApiService.currentLoginId).toBe('AS-01');

    MobileApiService.clearSession();

    expect(MobileApiService.currentLoginId).toBeNull();
  });
});
