import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { NotFound } from './NotFound';

/**
 * What a URL with no route does.
 *
 * The behaviour under test is mostly a set of things that must NOT happen, which is why this file
 * exists rather than a single "renders the words" assertion. The old catch-all — `<Navigate to="/"
 * replace />` — passed every test you would write about a 404 page except the ones below, because
 * it never rendered anything at all. It sent people to the dashboard, and a redirect to a working
 * page is indistinguishable from success unless you assert on the URL.
 *
 * That is not a theoretical complaint. Every roster row's "Open full profile" button pointed at a
 * route that did not exist; instead of failing where anyone could see it, the redirect quietly
 * returned the operator to the dashboard, and the bug lived there until somebody noticed the
 * button "did nothing".
 */

/** Reports where the router settled, so a test can prove the URL was left alone. */
const Where: React.FC = () => <div data-testid="url">{useLocation().pathname}</div>;

const openAt = (path: string, landing = '/dashboard') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/dashboard" element={<div>dashboard page</div>} />
        <Route path="/notifications" element={<div>notifications page</div>} />
        <Route path="*" element={<NotFound landing={landing} />} />
      </Routes>
    </MemoryRouter>,
  );

describe('a URL the application has no route for', () => {
  it('says the page does not exist, rather than silently showing another one', () => {
    openAt('/no-such-page');

    expect(screen.getByText(/doesn’t exist/i)).toBeInTheDocument();
    // The specific thing the redirect used to do. If this ever passes, the 404 is gone again.
    expect(screen.queryByText('dashboard page')).not.toBeInTheDocument();
  });

  it('leaves the URL alone, so the failing path can still be read and reported', () => {
    openAt('/planning/2026/branch/BR-4471');

    expect(screen.getByTestId('url')).toHaveTextContent('/planning/2026/branch/BR-4471');
  });

  it('shows the path that was asked for', () => {
    const { container } = openAt('/hr/rooster');

    // Named on screen because it is the one detail worth putting in a bug report, and because
    // "/hr/rooster" versus "/hr/roster" is invisible in a sentence but obvious in a code span.
    //
    // Scoped to the page's own <code>. The harness above echoes the path as well, so an assertion
    // that either element could satisfy would still pass with the code span deleted entirely.
    expect(container.querySelector('code')).toHaveTextContent('/hr/rooster');
  });

  it('offers the way back to the page this person can actually open, not a fixed one', () => {
    // The landing page is computed per-principal by defaultRouteFor. A clerk whose role cannot
    // open the dashboard must not be handed a link to it — that was the original incident: every
    // route said no, the redirect said dashboard, and the dashboard said no as well.
    openAt('/no-such-page', '/notifications');

    expect(screen.getByRole('link', { name: /back to your home page/i }))
      .toHaveAttribute('href', '/notifications');
  });

  it('does not navigate on its own — the way back is offered, not taken', () => {
    openAt('/no-such-page', '/notifications');

    expect(screen.getByTestId('url')).toHaveTextContent('/no-such-page');
    expect(screen.queryByText('notifications page')).not.toBeInTheDocument();
  });

  it('renders a hostile path as text rather than as markup', () => {
    // React escapes this, but the path is the one piece of attacker-controlled content on the
    // page, so it is worth a test that stays behind if the element is ever changed.
    const evil = '/<img src=x onerror=alert(1)>';
    const { container } = openAt(evil);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('code')).toHaveTextContent(evil);
  });
});

/**
 * That the router actually reaches the page above.
 *
 * Everything before this mounts `NotFound` directly, so all of it would still pass if App.tsx went
 * back to `<Route path="*" element={<Navigate to="/" replace />} />` tomorrow — the component would
 * be correct and unreachable, and the tests would say the 404 works. That is the same shape as the
 * bug this whole file is about: the redirect made a broken thing look like a working one.
 *
 * Reading the source is the cheap way to close it. Mounting App.tsx is not available here — it
 * imports Login.tsx, which uses `import.meta`, which jest's CommonJS transform cannot parse.
 */
describe('App wires the catch-all to it', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');

  /**
   * The authenticated catch-all only. The sign-in tree has its own `path="*"`, and that one SHOULD
   * redirect: a signed-out visitor asking for /billing wants the login page and their link kept,
   * not a 404 telling them a page they cannot see does not exist.
   */
  const authenticatedCatchAll = app.slice(app.indexOf('RememberAndRedirectToLogin />'));

  it('renders NotFound for an unknown authenticated path', () => {
    expect(authenticatedCatchAll).toMatch(/<Route\s+path="\*"\s+element=\{<NotFound\b/);
  });

  it('does not silently redirect an unknown path anywhere', () => {
    expect(authenticatedCatchAll).not.toMatch(/<Route\s+path="\*"\s+element=\{<Navigate\b/);
  });

  it('hands it the landing page computed for this principal, not a fixed path', () => {
    // A clerk whose role cannot open the dashboard must not be offered a link to it.
    expect(authenticatedCatchAll).toMatch(/<NotFound\s+landing=\{defaultRouteFor\(/);
  });
});
