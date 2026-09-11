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
          {['/dashboard', '/hr', '/billing', '/users', '/settings', '/notifications', '/documents',
            '/admin/settings', '/admin/logs', '/admin/approvals', '/feedback']
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
  /**
   * The clerk's single grant, and why it is a paperwork one rather than the workforce one this
   * test was written with.
   *
   * `/hr` was the reachable page here, on the strength of `GET /hr/workforce` declaring
   * `assayer:view:organization`. That route refuses a custom role — its `@Roles` list carries no
   * permission fallback — so the entry stopped naming the permission, and sending a refusal to
   * `/hr` would now be sending it to a page that opens and cannot load: the very failure this
   * describe block exists to prevent. `/documents` is the same shape and is genuinely served:
   * `GET /documents/operations/overview` declares `document:view:organization` and honours it.
   */
  const PAPERWORK_ONLY = ['DOCUMENT:VIEW:ORGANIZATION'];
  /**
   * The clerk's role is a row built in Admin → Roles, so its name is not a `SystemRole`.
   * At runtime `useCurrentRoles` returns that name in the roles array, and the permission fallback
   * runs only for a principal carrying such a name (it must not hand a built-in role a page it was
   * deliberately left off — see canAccessRoute). So the clerk is modelled by its actual role name,
   * not by an empty roles array, which would describe a principal that cannot exist.
   */
  const HR_OPERATOR = ['HR_OPERATOR'] as unknown as SystemRole[];

  it('renders a page the person may open', () => {
    openAt('/documents', HR_OPERATOR, PAPERWORK_ONLY);
    expect(screen.getByText('page @ /documents')).toBeInTheDocument();
  });

  it('sends a refusal to a page they can use, not to the dashboard', () => {
    openAt('/billing', HR_OPERATOR, PAPERWORK_ONLY);
    expect(screen.getByText('page @ /documents')).toBeInTheDocument();
  });

  it('does the same for the dashboard itself, which this role cannot load either', () => {
    openAt('/dashboard', HR_OPERATOR, PAPERWORK_ONLY);
    expect(screen.getByText('page @ /documents')).toBeInTheDocument();
  });

  /**
   * The page this role is no longer offered, asserted here as well as in route-permissions.spec:
   * a refusal must never be redirected onto another refusal.
   */
  it('does not send a workforce-granted custom role to a workforce page its API refuses', () => {
    openAt('/hr', HR_OPERATOR, ['ASSAYER:VIEW:ORGANIZATION']);
    expect(screen.queryByText('page @ /hr')).not.toBeInTheDocument();
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

  /**
   * The DEVELOPER split (2026-09-05). The route gate expands roles through the hierarchy
   * (DEVELOPER ⇒ ADMIN + PRODUCT_SUPPORT, one-way), so a developer opens the admin estate
   * unlisted while a pure admin is turned away from the technical pages — redirected to a page
   * they can use, exactly like any other refusal.
   */
  describe('the developer split', () => {
    it('lets a DEVELOPER through admin-listed doors by implication', () => {
      openAt('/admin/settings', [SystemRole.DEVELOPER], []);
      expect(screen.getByText('page @ /admin/settings')).toBeInTheDocument();
    });

    it('lets a DEVELOPER manage users, also by implication', () => {
      openAt('/users', [SystemRole.DEVELOPER], []);
      expect(screen.getByText('page @ /users')).toBeInTheDocument();
    });

    it('turns a pure ADMIN away from the service logs — implication is one-way', () => {
      openAt('/admin/logs', [SystemRole.ADMIN], []);
      expect(screen.queryByText('page @ /admin/logs')).not.toBeInTheDocument();
      expect(screen.getByText('page @ /dashboard')).toBeInTheDocument();
    });

    it('opens the approvals queue to the ADMIN who decides there', () => {
      openAt('/admin/approvals', [SystemRole.ADMIN], []);
      expect(screen.getByText('page @ /admin/approvals')).toBeInTheDocument();
    });

    it('opens the support desk to PRODUCT_SUPPORT, its actual job', () => {
      openAt('/feedback', [SystemRole.PRODUCT_SUPPORT], []);
      expect(screen.getByText('page @ /feedback')).toBeInTheDocument();
    });

    it('turns an ADMIN away from the support desk it no longer runs', () => {
      openAt('/feedback', [SystemRole.ADMIN], []);
      expect(screen.queryByText('page @ /feedback')).not.toBeInTheDocument();
      expect(screen.getByText('page @ /dashboard')).toBeInTheDocument();
    });
  });
});
