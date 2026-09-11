import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { SystemRole } from '@fapoms/shared';

/**
 * Who the "nothing here yet" message is written for.
 *
 * The empty state used to tell every reader to "Choose one in Planning" and hand them a link to
 * it. Planning is restricted to ADMIN and OPERATIONS holding PLANNING:VIEW:ORGANIZATION, so a desk
 * operator, an auditor or a validator got an instruction they could not carry out attached to a
 * link that would bounce them straight back out — the screen said the queue was empty and then
 * wasted the single action it offered.
 *
 * Only the two role hooks are mocked here. `canAccessRoute` is deliberately the real one, so these
 * tests are pinned to the actual permission table rather than to a second opinion about it: if
 * someone changes who may reach /planning, this suite follows them there.
 */
jest.mock('../../hooks/useCurrentRoles', () => ({
  useCurrentRoles: jest.fn(() => [] as string[]),
  useCurrentPermissions: jest.fn(() => [] as string[]),
}));

jest.mock('../../services/api', () => ({ api: { request: jest.fn().mockResolvedValue([]) } }));

import { useCurrentRoles, useCurrentPermissions } from '../../hooks/useCurrentRoles';
import { AssignmentTable } from './AssignmentTable';

const asRoles = useCurrentRoles as unknown as jest.Mock;
const asPerms = useCurrentPermissions as unknown as jest.Mock;

/** The empty queue: no assignments at all, no filters, no search. */
const renderEmptyQueue = () =>
  render(
    <MemoryRouter>
      <AssignmentTable
        assignments={[]}
        filteredAssignments={[]}
        selectedAsnId={null}
        onSelectAssignment={jest.fn()}
        statusFilter="ALL"
        searchTerm=""
        isLoading={false}
        page={1}
        total={0}
        totalPages={1}
        setPage={jest.fn()}
        dateSort="asc"
        setDateSort={jest.fn()}
        quickBusyId={null}
        onQuickAction={jest.fn()}
        isAttentionView={false}
        openIssueAssignmentIds={new Set()}
        todayStr="2026-09-09"
      />
    </MemoryRouter>,
  );

describe('the empty assignment queue', () => {
  afterEach(() => jest.clearAllMocks());

  it('points a planner at Planning, with a link', () => {
    asRoles.mockReturnValue([SystemRole.OPERATIONS]);
    asPerms.mockReturnValue(['PLANNING:VIEW:ORGANIZATION']);

    renderEmptyQueue();

    expect(screen.getByRole('link', { name: 'Planning' })).toHaveAttribute('href', '/planning');
  });

  it('does not send someone who cannot plan to a page that will refuse them', () => {
    asRoles.mockReturnValue([SystemRole.DESK]);
    asPerms.mockReturnValue([]);

    renderEmptyQueue();

    expect(screen.queryByRole('link', { name: 'Planning' })).not.toBeInTheDocument();
    // Still told what the situation is, and explicitly that it is not theirs to act on — an empty
    // screen with no explanation is its own kind of dead end.
    expect(screen.getByText(/Nothing is waiting on you/i)).toBeInTheDocument();
  });

  /**
   * The database-defined roles, which are the reason this asks `canAccessRoute` rather than
   * testing a role list.
   *
   * A role built in Admin → Roles matches no `allowedRoles` entry by definition, so for those the
   * routing table's answer is the whole answer — and asking it, rather than hard-coding
   * `roles.includes(OPERATIONS)`, is what makes this link track the page it points at.
   *
   * That answer is currently NO, and this test asserts the new one rather than the old. `/planning`
   * stopped naming a permission: the workspace is keyed on a project list served by
   * `GET /projects`, which refuses every custom role, so the page would open and never fill. A link
   * offered here would be a link to that. When `ProjectController.findAll` honours the fallback and
   * `/planning` names its permission again, this flips back on its own — which is the point of
   * asking `canAccessRoute` instead of restating the rule here.
   */
  it('does not offer the planning link to a role the planning page is closed to', () => {
    asRoles.mockReturnValue(['Regional Planner']);
    asPerms.mockReturnValue(['PLANNING:VIEW:ORGANIZATION']);

    renderEmptyQueue();

    expect(screen.queryByRole('link', { name: 'Planning' })).not.toBeInTheDocument();
  });

  it('withholds it from a custom role that lacks the permission', () => {
    asRoles.mockReturnValue(['Regional Planner']);
    asPerms.mockReturnValue([]);

    renderEmptyQueue();

    expect(screen.queryByRole('link', { name: 'Planning' })).not.toBeInTheDocument();
  });

  it('says the queue is empty either way', () => {
    asRoles.mockReturnValue([SystemRole.DESK]);
    asPerms.mockReturnValue([]);

    renderEmptyQueue();

    expect(screen.getByText('Nobody has been given a branch to audit yet')).toBeInTheDocument();
  });
});
