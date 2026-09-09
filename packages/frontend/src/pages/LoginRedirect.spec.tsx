import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { SystemRole } from '@fapoms/shared';

/**
 * `/login`, visited by somebody who is already signed in.
 *
 * The authenticated route table had no entry for it. Every other path a signed-in person can type
 * resolves to a page, a redirect, or a permission refusal; `/login` alone fell through to the
 * catch-all and rendered "That page doesn't exist" — over the top of the application shell, with
 * the sidebar and the notification bell still on screen, which makes the claim self-evidently
 * false and rather alarming. It is also the single most bookmarked URL this application has: it
 * is what people type when they open the browser in the morning.
 *
 * The fix is a redirect home, sharing the ONE element `/` already renders, so "where does a
 * signed-in person belong" has a single definition. That is what these tests hold: not merely
 * that /login goes somewhere, but that it goes to the same place, computed the same way, waiting
 * for the same profile load.
 *
 * `App.tsx` cannot be mounted here — it imports Login.tsx, which uses `import.meta`, which jest's
 * CommonJS transform cannot parse — so the wiring is read out of the source, exactly as
 * NotFound.spec.tsx does for the catch-all and for the same reason: a correct component that no
 * route reaches is the bug, not the fix.
 */

const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');

/**
 * The signed-in half of the file. Everything above `RememberAndRedirectToLogin` belongs to the
 * signed-OUT route table, which has a `/login` of its own and must keep it — that one renders the
 * actual sign-in form.
 */
const authenticatedTree = app.slice(app.indexOf('RememberAndRedirectToLogin />'));

describe('App routes /login for somebody who is already signed in', () => {
  it('has a /login route in the authenticated table at all — this is the whole defect', () => {
    expect(authenticatedTree).toMatch(/<Route\s+path="\/login"/);
  });

  it('sends them to the same element "/" sends them to, rather than a second opinion', () => {
    // Two copies of "wait for the profile, then redirect to defaultRouteFor(...)" is two places
    // for the wait to be forgotten, and forgetting it flashes the auditor's home at an admin.
    expect(authenticatedTree).toMatch(/<Route\s+path="\/"\s+element=\{homeForSignedInUser\}\s*\/>/);
    expect(authenticatedTree).toMatch(/<Route\s+path="\/login"\s+element=\{homeForSignedInUser\}\s*\/>/);
  });

  it('computes that home per principal and waits for the roles that decide it', () => {
    const binding = app.slice(app.indexOf('const homeForSignedInUser'));
    expect(binding).toMatch(/isLoadingUser && userRoles\.length === 0/);
    expect(binding).toMatch(/defaultRouteFor\(userRoles, userPermissions\)/);
  });

  it('still renders the real sign-in form for somebody who is NOT signed in', () => {
    // The signed-out table is above the slice point and keeps its own /login. Losing it would
    // make the application impossible to enter, so it is worth an explicit assertion.
    const signedOutTree = app.slice(0, app.indexOf('RememberAndRedirectToLogin />'));
    expect(signedOutTree).toMatch(/<Route path="\/login" element=\{<Login onLoginSuccess=\{handleLoginSuccess\} \/>\} \/>/);
  });

  it('leaves logout pointing at the sign-in page', () => {
    // The redirect above is conditioned on holding a token. `handleLogout` drops the token first
    // and then navigates, so the sign-out journey still lands on the form rather than bouncing
    // straight back into the app.
    const logoutStart = app.indexOf('const handleLogout');
    expect(logoutStart).toBeGreaterThan(-1);
    const logout = app.slice(logoutStart, app.indexOf('if (!token)', logoutStart));
    expect(logout).toMatch(/setToken\(null\)/);
    expect(logout).toMatch(/navigate\('\/login'\)/);
    expect(logout.indexOf('setToken(null)')).toBeLessThan(logout.indexOf("navigate('/login')"));
  });
});

/**
 * And that the element the two routes share actually redirects.
 *
 * The assertions above prove `/login` is wired to `homeForSignedInUser`; this proves what being
 * wired to it does. `PostLoginRedirect` is App.tsx's own component and is exported for this — it
 * is what turns "signed in, on a URL that is not a page" into a destination.
 */
import { PostLoginRedirect, RETURN_TO_KEY } from '../components/PostLoginRedirect';
import { defaultRouteFor } from '../config/route-permissions';

const Where: React.FC = () => <div data-testid="url">{useLocation().pathname}</div>;

const landAt = (from: string, fallback: string) =>
  render(
    <MemoryRouter initialEntries={[from]}>
      <Where />
      <Routes>
        <Route path={from} element={<PostLoginRedirect fallback={fallback} />} />
        <Route path="*" element={<div>somewhere else</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('what that shared element does', () => {
  beforeEach(() => { sessionStorage.clear(); });

  it('lands an admin on the admin home page, not on a 404', async () => {
    const home = defaultRouteFor([SystemRole.ADMIN], []);
    landAt('/login', home);

    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent(home));
    expect(screen.queryByText(/doesn’t exist/i)).not.toBeInTheDocument();
  });

  it('lands each role on its own home, rather than a path hard-coded here', async () => {
    const auditorHome = defaultRouteFor([SystemRole.AUDITOR], []);
    landAt('/login', auditorHome);

    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent(auditorHome));
  });

  it('prefers a destination the visitor was already trying to reach', async () => {
    // Signed-out visitor asks for /billing, gets bounced to sign in, signs in: they wanted
    // /billing, and it is still remembered. Landing them on their role home instead would be a
    // regression this route can cause, so it is pinned here.
    sessionStorage.setItem(RETURN_TO_KEY, '/billing');
    landAt('/login', '/dashboard');

    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('/billing'));
    // Consumed, so a later visit to /login goes home rather than back to /billing for ever.
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
  });

  it('never sends anyone back to /login, which is how a redirect loop starts', async () => {
    sessionStorage.setItem(RETURN_TO_KEY, '/login');
    landAt('/login', '/dashboard');

    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('/dashboard'));
  });
});
