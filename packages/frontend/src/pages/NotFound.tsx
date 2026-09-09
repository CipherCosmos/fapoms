import React from 'react';
import { Link, useLocation } from 'react-router-dom';

/**
 * The end of the road: a URL this application has no route for.
 *
 * This used to be `<Navigate to="/" replace />`, which is a redirect wearing a 404's clothes.
 * Three things went wrong with it, and only the third was ever visible.
 *
 * Somebody who mistyped a path or followed a stale bookmark landed on the dashboard with no
 * message, so nothing on screen distinguished "that page does not exist" from "that page loaded".
 * A link shared in chat that had gone stale looked to the recipient like it had worked.
 *
 * The URL was rewritten on the way, so the thing that failed was gone before anyone could read it.
 * There was nothing left to paste into a bug report.
 *
 * And a genuinely missing route was indistinguishable from a working one, which is how a real bug
 * survived: every roster row's "Open full profile" button pointed at `/assayers/:id` while no such
 * route existed, and instead of failing visibly it threw the operator out of Workforce and back to
 * the dashboard. The redirect is what hid it. That route exists now, declared in App.tsx, but the
 * next one like it should announce itself rather than wait to be noticed.
 *
 * So: say so, keep the URL, and offer the way back instead of taking it automatically. Not being
 * allowed in is a different answer and `ProtectedRoute` already gives it, so anything arriving
 * here has no route at all, for anyone.
 */
export const NotFound: React.FC<{ landing: string }> = ({ landing }) => {
  const { pathname } = useLocation();
  return (
    <div style={{ maxWidth: 520, margin: '18vh auto', padding: '0 24px', textAlign: 'center', color: 'var(--text-secondary)' }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 19, color: 'var(--text-primary)' }}>
        That page doesn’t exist
      </h2>
      <p style={{ margin: '0 0 18px', fontSize: 13.5, lineHeight: 1.6 }}>
        Nothing is published at{' '}
        {/* The path they actually asked for, kept verbatim: it is the one detail worth reporting,
            and React escapes it, so a crafted URL renders as text rather than as markup. */}
        <code style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 4, padding: '1px 5px', fontSize: 12.5, wordBreak: 'break-all' }}>
          {pathname}
        </code>
        . It may have moved, or the link may have been mistyped or gone stale.
      </p>
      <Link to={landing} style={{ fontSize: 13.5, color: 'var(--accent-primary)', textDecoration: 'none', fontWeight: 500 }}>
        Back to your home page
      </Link>
    </div>
  );
};
