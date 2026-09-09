import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';

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

  useEffect(() => {
    try {
      sessionStorage.removeItem(RETURN_TO_KEY);
    } catch {
      // Non-fatal: the worst case is landing on the role's home page.
    }
  }, []);

  // ProtectedRoute still guards the destination, so a deep link into a section this role may not
  // open is refused exactly as it would be if they had clicked through to it.
  return <Navigate to={returnTo ?? fallback} replace />;
};
