import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { SystemRole } from '@fapoms/shared';
import { ProtectedRoute } from './ProtectedRoute';

/** Reports where the router ended up, which is the whole question for a redirecting guard. */
const Where: React.FC<{ name: string }> = ({ name }) => {
  const { pathname } = useLocation();
  return <div>{`${name} @ ${pathname}`}</div>;
};

/**
 * Mounts the guard over a handful of real paths and starts at `from`.
 *
 * Every page renders the same marker, so a test asserts on where the router settled rather than
 * on any page's contents — the guard's only job is to decide that.
 */
const openAt = (from: string, roles: SystemRole[], permissions: string[]) =>
  render(
    <MemoryRouter initialEntries={[from]}>
      <Routes>
        <Route element={<ProtectedRoute userRoles={roles} userPermissions={permissions}><Where name="page" /></ProtectedRoute>}>
          {['/dashboard', '/hr', '/billing', '/users', '/settings', '/notifications', '/documents']
            .map((p) => <Route key={p} path={p} element={<Where name="page" />} />)}
        </Route>
      </Routes>
    </MemoryRouter>,
  );

/**
 * Being refused a page is normal; being dumped on a page you also cannot use is the bug.
 *
 * The guard used to send every refusal to `/dashboard`, which is how the incident looked from the
 * outside: a workforce clerk on a role built in Admin → Roles was refused everywhere, landed on
 * the dashboard, and the dashboard's own API refused them too.
 */
describe('ProtectedRoute', () => {
  const HR_ONLY = ['ASSAYER:VIEW:ORGANIZATION'];

  it('renders a page the person may open', () => {
    openAt('/hr', [], HR_ONLY);
    expect(screen.getByText('page @ /hr')).toBeInTheDocument();
  });

  it('sends a refusal to a page they can use, not to the dashboard', () => {
    openAt('/billing', [], HR_ONLY);
    expect(screen.getByText('page @ /hr')).toBeInTheDocument();
  });

  it('does the same for the dashboard itself, which this role cannot load either', () => {
    openAt('/dashboard', [], HR_ONLY);
    expect(screen.getByText('page @ /hr')).toBeInTheDocument();
  });

  it('leaves a built-in role exactly where it was allowed to go', () => {
    openAt('/billing', [SystemRole.OPERATIONS], []);
    expect(screen.getByText('page @ /billing')).toBeInTheDocument();
  });

  it('refuses a built-in role a page outside its remit', () => {
    openAt('/users', [SystemRole.DESK_OPERATOR], []);
    expect(screen.queryByText('page @ /users')).not.toBeInTheDocument();
  });

  it('waits rather than deciding while the profile is still loading', () => {
    render(
      <MemoryRouter initialEntries={['/billing']}>
        <Routes>
          <Route path="/billing" element={<ProtectedRoute isLoading><Where name="page" /></ProtectedRoute>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/Loading session/)).toBeInTheDocument();
  });

  /**
   * An account that exists and has been granted nothing still has to land somewhere, and the
   * somewhere has to be a page it can open. Its own notification inbox is that page — every
   * signed-in principal has one and it only ever shows them their own.
   *
   * The written refusal in the component is the terminal case beneath this: it renders only if
   * the landing page is itself refused, which cannot happen while the inbox stays open to all.
   * It is there so that closing that door produces a sentence rather than a redirect loop.
   */
  it('lands an account granted nothing on the one page every user has', () => {
    openAt('/documents', [], []);
    expect(screen.getByText('page @ /notifications')).toBeInTheDocument();
  });
});
