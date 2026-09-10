import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

/**
 * Where an unauthenticated visitor was trying to go, held until they have signed in.
 *
 * sessionStorage rather than localStorage: it belongs to this tab and this attempt, and must not
 * outlive the browser session or leak between tabs.
 */
export const RETURN_TO_KEY = 'fapoms_return_to';

/**
 * Sends a signed-in person to wherever they were headed, or to their role's home.
 *
 * Lives beside `ProtectedRoute` rather than inside App.tsx because it is the same kind of thing —
 * route plumbing that decides where somebody ends up — and because App.tsx cannot be mounted in a
 * test at all: it imports Login.tsx, which uses `import.meta`, which jest's CommonJS transform
 * cannot parse. Leaving the destination logic in there meant the one rule that says where a
 * signed-in person belongs was the one rule no test could exercise.
 *
 * The destination is captured once, in a `useState` initialiser, and cleared in an effect — never
 * read-and-cleared inline in the element expression. React StrictMode double-invokes render in
 * development, so an inline consume returned the path on the first pass and `null` on the second,
 * and it was the second result the router actually used. Reading once fixes that, and clearing in
 * an effect keeps the render itself free of side effects.
 */
export const PostLoginRedirect: React.FC<{ fallback: string }> = ({ fallback }) => {
  const here = useLocation();
  const [returnTo] = useState<string | null>(() => {
    try {
      const target = sessionStorage.getItem(RETURN_TO_KEY);
      // Never `/login`: a signed-in person sent back to the sign-in route is a redirect loop, and
      // that route is now itself one of the two that render this component.
      return target && target !== '/login' ? target : null;
    } catch {
      return null;
    }
  });

  /**
   * Never navigate to where this is already rendering.
   *
   * `/` and `/login` render the SAME element, deliberately, so that where a signed-in person
   * belongs is defined once. React therefore reuses this component instance across the move
   * between them: the `useState` initialiser does not re-run and neither does the effect below.
   * With `/` remembered as the destination — which it was, because the catch-all recorded every
   * unauthenticated path including that one — the reused instance kept rendering
   * `<Navigate to="/" />` at `/`, and `Navigate` re-navigates on every render. That is an update
   * loop, and what it looks like from outside is signing in at the site root and getting a blank
   * page.
   *
   * Recording `/` is fixed below in `RememberAndRedirectToLogin`. This is the half that holds
   * even if some future writer puts a self-referential path back: a destination equal to the
   * current location is not a destination, it is the fallback's job.
   */
  const destination = returnTo && returnTo !== `${here.pathname}${here.search}` && returnTo !== here.pathname
    ? returnTo
    : null;

  useEffect(() => {
    try {
      sessionStorage.removeItem(RETURN_TO_KEY);
    } catch {
      // Non-fatal: the worst case is landing on the role's home page.
    }
  }, []);

  // ProtectedRoute still guards the destination, so a deep link into a section this role may not
  // open is refused exactly as it would be if they had clicked through to it.
  return <Navigate to={destination ?? fallback} replace />;
};

/**
 * Records the requested path, then sends the visitor to sign in.
 *
 * A component rather than an inline `<Navigate>` because the write has to happen as an effect —
 * doing it during render would be a side effect in the render phase.
 *
 * It lives here beside the component that spends what it saves, and not in App.tsx where it was
 * written, for the reason given above: App.tsx cannot be mounted in a test at all, so the two
 * halves of "where does somebody end up" were the one rule no test could reach. Both halves had a
 * defect. This is the half that recorded `/` as a destination.
 */
export const RememberAndRedirectToLogin: React.FC = () => {
  const location = useLocation();
  useEffect(() => {
    const target = `${location.pathname}${location.search}`;
    /**
     * `/` is not a destination. It is the route that decides where a signed-in person belongs,
     * and the fallback already says the same thing better — with the person's roles known, which
     * they are not at the moment this runs. Recording it produced a redirect to the very route
     * doing the redirecting.
     *
     * `/login` is excluded for the older reason: sending a freshly signed-in person back to the
     * sign-in screen is a loop of its own.
     */
    if (location.pathname === '/' || location.pathname === '/login') return;
    try {
      sessionStorage.setItem(RETURN_TO_KEY, target);
    } catch {
      // Storage unavailable (private mode, quota) — fall back to the role home after sign-in.
    }
  }, [location.pathname, location.search]);
  return <Navigate to="/login" replace />;
};
