import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { SystemRole } from '@fapoms/shared';
import { Sidebar } from './Sidebar';

jest.mock('./GlobalSearch', () => ({ GlobalSearch: () => null }));
jest.mock('./BrandLogo', () => ({ BrandLogo: () => null }));

let mockWaiting: number | null = 3;
jest.mock('../pages/hr/approvals/approval-queue', () => ({
  useApprovalCount: () => mockWaiting,
}));

/**
 * THE APPROVER'S NUMBER, IN THE NAVIGATION EVERYBODY SEES.
 *
 * On the Workforce row, not a row of its own: the HR section's pages were taken out of the sidebar
 * on purpose (several rows for one subject, two lighting up at once), and the Approvals tab inside
 * Workforce carries the same number from the same query.
 */
describe('the sidebar and approvals', () => {
  const draw = (roles: SystemRole[], collapsed = false) => render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Sidebar collapsed={collapsed} user={{ displayName: 'A', email: 'a@x', roles: roles.map((name) => ({ name })) }} />
    </MemoryRouter>,
  );

  beforeEach(() => { mockWaiting = 3; });

  it('shows an approver how many joiners wait for them, on the Workforce row', () => {
    draw([SystemRole.ADMIN]);
    const workforce = screen.getByRole('link', { name: /Workforce/ });
    expect(screen.getByTestId('sidebar-badge-/hr')).toHaveTextContent('3');
    expect(workforce).toHaveAttribute('title', expect.stringContaining('3 joiners are waiting for your approval'));
  });

  it('keeps the number when the sidebar is collapsed to icons', () => {
    draw([SystemRole.ADMIN], true);
    expect(screen.getByTestId('sidebar-badge-/hr')).toHaveTextContent('3');
  });

  /** Zero is not news, and a count the reader cannot clear is noise. */
  it('shows no number when nothing is waiting, or for somebody who cannot approve', () => {
    mockWaiting = 0;
    const { unmount } = draw([SystemRole.ADMIN]);
    expect(screen.queryByTestId('sidebar-badge-/hr')).not.toBeInTheDocument();
    unmount();

    mockWaiting = null;
    draw([SystemRole.OPERATIONS]);
    expect(screen.getByRole('link', { name: /Workforce/ })).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-badge-/hr')).not.toBeInTheDocument();
  });

  it('adds no row of its own for approvals', () => {
    draw([SystemRole.ADMIN]);
    expect(screen.queryByRole('link', { name: /^Approvals/ })).not.toBeInTheDocument();
  });

  /**
   * It was called "Approvals" and described as management approvals and fee overrides, none of
   * which it holds — so an approver looking for joiners would have landed on data-wipe requests.
   */
  it('names the admin data-wipe page for what it is', () => {
    draw([SystemRole.ADMIN]);
    const link = screen.getByRole('link', { name: /Data-wipe requests/ });
    expect(link).toHaveAttribute('href', '/admin/approvals');
    expect(link).toHaveAttribute('title', expect.stringContaining('wipe data'));
  });
});
