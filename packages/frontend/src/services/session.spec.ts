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

import { clearSession } from './session';
import { queryClient } from '../queryClient';

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
});
