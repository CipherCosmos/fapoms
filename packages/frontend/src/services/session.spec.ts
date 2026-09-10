/**
 * This package's jest runs on `testEnvironment: node`, which has no localStorage. A minimal
 * in-memory stand-in is installed here rather than switching the whole suite to jsdom — that
 * would change the environment for every other spec in the package to test one module.
 */
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

/** The same stand-in for the tab-scoped half. The return path and the sign-out reason live here. */
const tabStore = new Map<string, string>();
(globalThis as any).sessionStorage = {
  getItem: (k: string) => (tabStore.has(k) ? tabStore.get(k)! : null),
  setItem: (k: string, v: string) => void tabStore.set(k, String(v)),
  removeItem: (k: string) => void tabStore.delete(k),
  clear: () => tabStore.clear(),
};

jest.mock('./socket', () => ({ disconnectSocket: jest.fn() }));

import { clearSession, endSession } from './session';
import { queryClient } from '../queryClient';
import { disconnectSocket } from './socket';

/**
 * Session teardown had drifted: logout removed three hardcoded keys, and the global scope key
 * added later was never added to that list. On a shared desk that meant the next person to
 * sign in inherited the previous operator's region — silently narrowing a national user's
 * whole application to someone else's territory.
 */
describe('clearSession', () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
  });

  it('clears the auth credentials', () => {
    localStorage.setItem('fapoms_token', 'jwt');
    localStorage.setItem('fapoms_refresh_token', 'refresh');
    localStorage.setItem('fapoms_user_cache', '{}');

    clearSession();

    expect(localStorage.getItem('fapoms_token')).toBeNull();
    expect(localStorage.getItem('fapoms_refresh_token')).toBeNull();
    expect(localStorage.getItem('fapoms_user_cache')).toBeNull();
  });

  // The regression this file exists for.
  it('clears the global scope selection so it cannot follow the next sign-in', () => {
    localStorage.setItem('fapoms_global_scope', JSON.stringify({ region: 'WEST' }));
    localStorage.setItem('fapoms_selected_project', 'proj-1');

    clearSession();

    expect(localStorage.getItem('fapoms_global_scope')).toBeNull();
    // Cleared too, or ScopeContext's legacy-migration path would resurrect it.
    expect(localStorage.getItem('fapoms_selected_project')).toBeNull();
  });

  // Logout navigates with the router rather than reloading, so the in-memory cache would
  // otherwise survive into the next session.
  it('empties the React Query cache', () => {
    queryClient.setQueryData(['branches', 'list', 'region=WEST', 1], [{ id: 'b1' }]);
    expect(queryClient.getQueryData(['branches', 'list', 'region=WEST', 1])).toBeDefined();

    clearSession();

    expect(queryClient.getQueryData(['branches', 'list', 'region=WEST', 1])).toBeUndefined();
  });

  it('leaves device-level preferences alone', () => {
    localStorage.setItem('fapoms_theme', 'noir');
    clearSession();
    expect(localStorage.getItem('fapoms_theme')).toBe('noir');
  });

  /**
   * The live socket joins its rooms once, from the token presented at connect time. A socket
   * left running across a router-navigated logout therefore keeps the previous user's `user:`,
   * `role:` and `region:` rooms — so the next person on that tab receives someone else's region
   * traffic and none of their own, which presents as "live updates don't work for me".
   */
  it('tears down the live socket so the next sign-in does not inherit its rooms', () => {
    clearSession();
    expect(disconnectSocket).toHaveBeenCalled();
  });
});

/**
 * Signing out has to end the session on the SERVER, not just forget it on this device.
 *
 * `clearSession` alone left the refresh token valid until it expired, so a copy of it — from a
 * shared machine, a synced browser profile, a disk image — could still be exchanged for a fresh
 * access token after the user had pressed Sign Out. Refresh tokens rotate on use, so that access
 * could be renewed indefinitely. The backend has always exposed `POST /auth/logout`; the web app
 * simply never called it.
 */
describe('endSession', () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  it('revokes the refresh token server-side before tearing down locally', async () => {
    localStorage.setItem('fapoms_token', 'jwt');
    localStorage.setItem('fapoms_refresh_token', 'refresh');

    await endSession();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt' }),
      }),
    );
    expect(localStorage.getItem('fapoms_token')).toBeNull();
    expect(localStorage.getItem('fapoms_refresh_token')).toBeNull();
  });

  /**
   * Best-effort by design: a failed revoke must never trap someone in a session they asked to
   * leave. The local teardown happens either way.
   */
  it('still signs out locally when the revoke call fails', async () => {
    localStorage.setItem('fapoms_token', 'jwt');
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('offline'));

    await expect(endSession()).resolves.toBeUndefined();
    expect(localStorage.getItem('fapoms_token')).toBeNull();
  });

  it('does not call the endpoint when there is no token to revoke', async () => {
    await endSession();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

/**
 * `RETURN_TO_KEY` exists twice, on purpose (see the comment above it in `session.ts`): this module
 * loads the query client and the socket, and `PostLoginRedirect` must not. Two constants with one
 * value only work while they hold the same value, and nothing about a drift would fail — the 401
 * handler would write one key, the redirect would read another, and everybody would simply land
 * on their role's home page after an expiry instead of where they were. That is a silent loss of
 * the exact behaviour the pair was added for.
 */
describe('the two copies of the return-to storage key', () => {
  it('still name the same sessionStorage entry', async () => {
    const { RETURN_TO_KEY: fromService } = await import('./session');
    const { RETURN_TO_KEY: fromRedirect } = await import('../components/PostLoginRedirect');
    expect(fromRedirect).toBe(fromService);
    // Named rather than compared alone, so a rename of BOTH still has to be a deliberate edit
    // here — the key is persisted state and changing it strands whatever a live tab has stored.
    expect(fromService).toBe('fapoms_return_to');
  });
});

/**
 * SIGNING OUT MUST NOT HAND THE NEXT PERSON THE PREVIOUS USER'S PAGE.
 *
 * `SESSION_KEYS` is a localStorage list, and the pending return path is sessionStorage — so a
 * sign-out cleared the tokens, the cache, the scope and the socket, and left behind the one thing
 * that decides where the NEXT sign-in lands. Whoever signed in on that tab afterwards was taken
 * to the page the previous user had been trying to open.
 *
 * The asymmetry with `clearSession` is deliberate and is the reason this cannot simply be added
 * to that function: the 401 handler in `api.ts` writes the return path one line before calling
 * `clearSession`, because preserving the destination across an expiry is the whole point of that
 * path. Clearing it there would delete what was just written.
 */
describe('what a deliberate sign-out forgets', () => {
  const RETURN_TO = 'fapoms_return_to';
  const REASON = 'fapoms_signed_out_reason';

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    queryClient.clear();
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  it('forgets where the previous person was going', async () => {
    localStorage.setItem('fapoms_token', 'jwt');
    sessionStorage.setItem(RETURN_TO, '/billing');

    await endSession();

    expect(sessionStorage.getItem(RETURN_TO)).toBeNull();
  });

  it('forgets the explanation too, which belonged to a sign-out that did not happen', async () => {
    // Left behind, it tells the next person their session expired. It did not; they just arrived.
    localStorage.setItem('fapoms_token', 'jwt');
    sessionStorage.setItem(REASON, 'expired');

    await endSession();

    expect(sessionStorage.getItem(REASON)).toBeNull();
  });

  it('forgets it even when the revoke call fails, because the sign-out happens anyway', async () => {
    localStorage.setItem('fapoms_token', 'jwt');
    sessionStorage.setItem(RETURN_TO, '/billing');
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('offline'));

    await endSession();

    expect(sessionStorage.getItem(RETURN_TO)).toBeNull();
  });

  it('forgets it when there was no token to revoke at all', async () => {
    sessionStorage.setItem(RETURN_TO, '/billing');

    await endSession();

    expect(sessionStorage.getItem(RETURN_TO)).toBeNull();
  });

  /**
   * The other direction, and the one that would break the expiry feature if it were wrong.
   * `clearSession` is shared with the 401 handler, which has just recorded the destination.
   */
  it('leaves the return path alone when only clearSession runs, which the 401 path depends on', () => {
    sessionStorage.setItem(RETURN_TO, '/billing');

    clearSession();

    expect(sessionStorage.getItem(RETURN_TO)).toBe('/billing');
  });
});
