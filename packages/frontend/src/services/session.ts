import { queryClient } from '../queryClient';
import { disconnectSocket } from './socket';
import { fetchWithTimeout } from './http';

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
 * Where an unauthenticated visitor was trying to go, held until they have signed in.
 *
 * The literal is owned by `App.tsx`, which writes it whenever the router bounces someone to
 * /login, and `PostLoginRedirect` consumes it. It is repeated here — rather than imported from
 * `App.tsx` — because a service importing the root component would close an import cycle through
 * every route in the app. The two must stay in step; that is why the name is a constant on both
 * sides and not an inline string.
 *
 * It matters here because the 401 handler in `api.ts` does NOT go through the router: it calls
 * `location.replace('/login')` directly, so `RememberAndRedirectToLogin` never mounts and never
 * records the path. An expiry mid-navigation therefore lost the destination, and the only reason
 * it ever appeared to work is that a value left over from an *earlier* bounce was still sitting in
 * sessionStorage. The handler now writes the key itself.
 */
export const RETURN_TO_KEY = 'fapoms_return_to';

/**
 * Why the person is looking at the login screen, when they did not ask to be.
 *
 * Being dropped on a sign-in form with no explanation reads as "the app broke" — which is the
 * worst possible reading, because it is the one that makes people stop trusting the numbers they
 * were just looking at. This carries a reason from the moment of the forced sign-out to the login
 * screen that renders a moment later, across the full page reload that `location.replace` causes
 * (which is why it is storage and not React state).
 *
 * sessionStorage, like the return path: this belongs to this tab and this attempt.
 */
export const SIGNED_OUT_REASON_KEY = 'fapoms_signed_out_reason';

/**
 * The reasons, kept as a closed set so the login screen can phrase each one properly instead of
 * printing whatever string it happens to find.
 *
 *  - `expired`      — the session timed out while reading or navigating. Nothing was lost.
 *  - `expired_save` — it timed out while a change was being *sent*. The change did not save, and
 *                     the page it was typed on is gone. Saying so is the whole point: silent data
 *                     loss that the user discovers hours later is far more damaging than being
 *                     told plainly to enter it again.
 */
export type SignedOutReason = 'expired' | 'expired_save';

/**
 * Record why this sign-out is happening, and where to come back to.
 *
 * Best-effort throughout: private-mode browsers and full storage throw on write, and failing to
 * explain a sign-out must never *prevent* the sign-out.
 */
export function rememberForcedSignOut(reason: SignedOutReason, returnTo: string): void {
  try {
    sessionStorage.setItem(SIGNED_OUT_REASON_KEY, reason);
    // Never remember /login itself, or signing in would redirect to the screen just left.
    if (returnTo && !returnTo.startsWith('/login')) {
      sessionStorage.setItem(RETURN_TO_KEY, returnTo);
    }
  } catch {
    // Worst case: the person lands on their role's home page with no explanation — exactly the
    // behaviour that existed before, so this can only ever be an improvement or a no-op.
  }
}

/**
 * Read the reason once and forget it, so it explains the sign-out that caused it and nothing
 * afterwards. Without the clear, someone who signed out, signed in, then visited /login again by
 * hand would be told their session had expired, which is simply untrue.
 */
export function consumeSignedOutReason(): SignedOutReason | null {
  try {
    const raw = sessionStorage.getItem(SIGNED_OUT_REASON_KEY);
    sessionStorage.removeItem(SIGNED_OUT_REASON_KEY);
    return raw === 'expired' || raw === 'expired_save' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Clear every trace of the current session.
 *
 * Clears the React Query cache as well as storage. That matters more than it looks: logout
 * navigates with the router rather than reloading the page, so without this the in-memory
 * cache survives into the next sign-in and the new user is served the previous user's
 * branches, assignments and dashboard until each entry happens to go stale. The 401 path in
 * `api.ts` gets away with it only because it uses `location.replace`, which reloads.
 *
 * The live socket is torn down for the same reason, and it was missed for the same reason. Its
 * rooms are joined once, from the token presented at connect time — so a socket that survives a
 * router-navigated logout keeps the *previous* user's `user:`, `role:` and `region:` rooms. The
 * next person signing in on that tab then gets someone else's region traffic and none of their
 * own, which reads as "live updates just don't work for me". Reading the token freshly on
 * reconnect does not help: an already-connected socket never reconnects.
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
  disconnectSocket();
}

/**
 * Sign out for real: revoke the refresh token on the server, then tear down locally.
 *
 * `clearSession` alone only forgets the tokens on this device — it leaves the refresh token
 * valid until it expires. Anyone holding a copy (a shared or public machine, a browser profile
 * that syncs, a disk image) could exchange it for a fresh access token *after* the user had
 * pressed Sign Out, and because refresh tokens rotate on use they could keep doing so
 * indefinitely. The backend has always exposed `POST /auth/logout` — "revoke all refresh tokens
 * for this user" — the web app simply never called it.
 *
 * Best-effort by design: a failed or offline revoke must never trap someone in a session they
 * asked to leave, so the local teardown happens either way. The two other `clearSession` callers
 * deliberately do not come through here — sign-*in* clears stale state before authenticating,
 * and the 401 handler is already holding a token the server has rejected.
 */
export async function endSession(): Promise<void> {
  try {
    const token = localStorage.getItem('fapoms_token');
    if (token) {
      // Bounded so "best-effort" stays true. The local teardown below lives in `finally`, which
      // an unsettled fetch never reaches — so a stalled server did exactly what the comment above
      // promises cannot happen: it trapped the user in the session they asked to leave. The
      // timeout turns that into the already-handled failure path.
      await fetchWithTimeout('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
    }
  } catch {
    // Network down, token already expired, server unreachable — none of these should stop a
    // person from signing out of this device.
  } finally {
    clearSession();
  }
}
