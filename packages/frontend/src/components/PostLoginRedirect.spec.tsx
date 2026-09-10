import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { PostLoginRedirect, RememberAndRedirectToLogin, RETURN_TO_KEY } from './PostLoginRedirect';

/**
 * WHERE SOMEBODY ENDS UP AFTER SIGNING IN.
 *
 * Two halves of one rule, and until now neither could be tested: the recorder lived in App.tsx,
 * which cannot be mounted in jest because Login.tsx uses `import.meta`. Both halves had a defect.
 *
 *  - Signing in from the site root left a blank screen. `/` was recorded as the destination, and
 *    `/` and `/login` render the SAME element on purpose — so React reused the component instance
 *    across the move between them, the `useState` initialiser never re-ran, and the reused
 *    instance kept rendering `<Navigate to="/" />` while sitting at `/`. `Navigate` re-navigates
 *    on every render, so that is an update loop.
 *  - Signing out handed the next person the previous user's page. Nothing cleared the pending
 *    return path on a deliberate sign-out — `SESSION_KEYS` covers localStorage and this is
 *    sessionStorage — so it waited in the tab for whoever signed in next. That half is
 *    `session.spec.ts`.
 */
describe('where a signed-in person is sent', () => {
  /** Reports where the router settled, which is the only question either half answers. */
  const Where: React.FC = () => <div>{`at ${useLocation().pathname}${useLocation().search}`}</div>;

  const openAt = (from: string) =>
    render(
      <MemoryRouter initialEntries={[from]}>
        <Routes>
          {/*
            `/` and `/login` share one element, exactly as App.tsx does it, because that sharing is
            what makes React reuse the instance — reproduce it and the loop reproduces with it.
          */}
          <Route path="/" element={<PostLoginRedirect fallback="/dashboard" />} />
          <Route path="/login" element={<PostLoginRedirect fallback="/dashboard" />} />
          {['/dashboard', '/billing', '/hr/roster'].map((p) => (
            <Route key={p} path={p} element={<Where />} />
          ))}
        </Routes>
      </MemoryRouter>,
    );

  afterEach(() => sessionStorage.clear());

  it('sends somebody to the page they asked for before signing in', async () => {
    sessionStorage.setItem(RETURN_TO_KEY, '/billing');
    openAt('/login');
    expect(await screen.findByText('at /billing')).toBeInTheDocument();
  });

  it('keeps the query string, because that is what makes a deep link precise', async () => {
    sessionStorage.setItem(RETURN_TO_KEY, '/hr/roster?section=documents');
    openAt('/login');
    expect(await screen.findByText('at /hr/roster?section=documents')).toBeInTheDocument();
  });

  it('spends the destination once and then forgets it', async () => {
    sessionStorage.setItem(RETURN_TO_KEY, '/billing');
    openAt('/login');
    await screen.findByText('at /billing');
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
  });

  it('falls back to the role home when nothing was remembered', async () => {
    openAt('/login');
    expect(await screen.findByText('at /dashboard')).toBeInTheDocument();
  });

  it('lands on the role home rather than looping when the site root was remembered', async () => {
    // The reported defect: sign in at the site root, get a blank page. Without the guard this
    // renders <Navigate to="/" /> at "/" for ever and React throws on the update depth.
    sessionStorage.setItem(RETURN_TO_KEY, '/');
    openAt('/');
    expect(await screen.findByText('at /dashboard')).toBeInTheDocument();
  });

  it('ignores /login as a destination, which would be a loop of its own', async () => {
    sessionStorage.setItem(RETURN_TO_KEY, '/login');
    openAt('/login');
    expect(await screen.findByText('at /dashboard')).toBeInTheDocument();
  });

  it('survives storage that throws, because private mode does', async () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied');
    });
    try {
      openAt('/login');
      expect(await screen.findByText('at /dashboard')).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
    }
  });
});

describe('what an unauthenticated visitor leaves behind', () => {
  const openAt = (from: string) =>
    render(
      <MemoryRouter initialEntries={[from]}>
        <Routes>
          <Route path="/login" element={<div>sign in</div>} />
          <Route path="*" element={<RememberAndRedirectToLogin />} />
        </Routes>
      </MemoryRouter>,
    );

  afterEach(() => sessionStorage.clear());

  it('records the page they were trying to open', async () => {
    openAt('/billing');
    await screen.findByText('sign in');
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBe('/billing');
  });

  it('records the query string with it', async () => {
    openAt('/hr/roster?section=documents');
    await screen.findByText('sign in');
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBe('/hr/roster?section=documents');
  });

  it('does not record the site root, which is not a destination', async () => {
    // `/` is the route that DECIDES where a signed-in person belongs. Remembering it means
    // redirecting to the redirector, and the fallback already answers the same question better —
    // with the person's roles known, which they are not at the moment this runs.
    openAt('/');
    await screen.findByText('sign in');
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
  });

  it('sends them to sign in either way', async () => {
    openAt('/');
    expect(await screen.findByText('sign in')).toBeInTheDocument();
  });

  it('leaves an earlier destination alone rather than overwriting it with the root', async () => {
    sessionStorage.setItem(RETURN_TO_KEY, '/billing');
    openAt('/');
    await screen.findByText('sign in');
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBe('/billing');
  });

  it('does not fall over when storage refuses the write', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      openAt('/billing');
      expect(await screen.findByText('sign in')).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it('waits for nothing: the redirect happens whether or not the write worked', async () => {
    openAt('/billing');
    await waitFor(() => expect(screen.getByText('sign in')).toBeInTheDocument());
  });
});
