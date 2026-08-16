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
