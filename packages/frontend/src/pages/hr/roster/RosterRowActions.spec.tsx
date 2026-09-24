import React from 'react';
import { render, screen } from '@testing-library/react';
import { AssayerLifecycleStatus } from '@fapoms/shared';

import { RosterRowActions } from './RosterRowActions';

/**
 * The roster's per-row bin must appear exactly when `DELETE /assayers/:id` will be served.
 *
 * That route is `@Roles(ADMIN)` with no permission fallback (assayer.controller.ts). The bin used to
 * ride on `canManage` — ADMIN, OPERATIONS, or any custom role with assayer:edit — so an operations
 * clerk was offered a Delete whose click could only answer 403.
 */

let mockRoles: string[] = [];
jest.mock('../../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../../hooks/useCurrentRoles'),
  useCurrentRoles: () => mockRoles,
}));

const person = {
  id: 'a-1',
  assayerCode: 'AS0001',
  displayName: 'Person One',
  lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
} as any;

function renderAs(roles: string[], canManage = true) {
  mockRoles = roles;
  // The helper reads permissions from the cache when not given them; give OPERATIONS its real
  // assayer:delete grant so the test proves the permission alone no longer opens the bin.
  localStorage.setItem('fapoms_user_cache', JSON.stringify({
    roles, permissions: ['ASSAYER:DELETE:ORGANIZATION', 'ASSAYER:EDIT:ORGANIZATION'],
  }));
  return render(
    <RosterRowActions
      person={person}
      canCreate
      canManage={canManage}
      onEdit={jest.fn()}
      onResumeRegistration={jest.fn()}
      onStartTransition={jest.fn()}
      onDelete={jest.fn()}
    />,
  );
}

afterEach(() => localStorage.clear());

describe('RosterRowActions delete gate', () => {
  it.each([['ADMIN'], ['DEVELOPER']])('offers Delete to %s', (role) => {
    renderAs([role]);
    expect(screen.getByRole('button', { name: 'Delete Person One' })).toBeInTheDocument();
  });

  it.each([['OPERATIONS'], ['Regional HR Head']])(
    'keeps Edit but not Delete for %s, who holds assayer:delete yet is refused by the route',
    (role) => {
      renderAs([role]);
      expect(screen.getByRole('button', { name: 'Edit Person One' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete Person One' })).not.toBeInTheDocument();
    },
  );

  it('offers nothing to an admin on a read-only roster', () => {
    renderAs(['ADMIN'], false);
    expect(screen.queryByRole('button', { name: 'Delete Person One' })).not.toBeInTheDocument();
  });
});
