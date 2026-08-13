import { queryClient } from '../queryClient';

/**
 * Everything this app persists about a signed-in person, in one list.
 *
 * It exists because logout removed three keys by hand and the list had already drifted: the
 * global scope selection was added later and nobody remembered to add it here, so the next
 * person to sign in on the same machine inherited the previous operator's region. That is a
 * confusing filter at best, and on a shared desk it silently narrows a national user's whole
 * application to someone else's territory.
 *
 * Anything stored under a `fapoms_` key that belongs to a *session* rather than a *device*
 * belongs in this list. Device-level preferences (theme) deliberately do not.
 */
const SESSION_KEYS = [
  'fapoms_token',
  'fapoms_refresh_token',
  'fapoms_user_cache',
  // The header's global scope filter. Session state, not a device preference — see above.
  'fapoms_global_scope',
  // The project-only predecessor of the scope key. Cleared too, or it would be read back by
  // ScopeContext's legacy-migration path and resurrect the previous user's project.
  'fapoms_selected_project',
];

/**
 * Clear every trace of the current session.
 *
 * Clears the React Query cache as well as storage. That matters more than it looks: logout
 * navigates with the router rather than reloading the page, so without this the in-memory
 * cache survives into the next sign-in and the new user is served the previous user's
 * branches, assignments and dashboard until each entry happens to go stale. The 401 path in
 * `api.ts` gets away with it only because it uses `location.replace`, which reloads.
 */
export function clearSession(): void {
  for (const key of SESSION_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // A storage failure must not stop the rest of the teardown.
    }
  }
  queryClient.clear();
}
