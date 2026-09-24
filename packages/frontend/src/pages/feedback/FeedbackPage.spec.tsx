import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SystemRole } from '@fapoms/shared';
import { FeedbackPage } from './FeedbackPage';

/**
 * 2026-09-25, owner: support has a reporting side for everyone and a resolution side for the
 * developers, but "normal people don't able to use the support at all". The route is open to all
 * now; this pins that the page gives a normal user the reporting side and never touches the
 * desk's endpoints (which would 403), while the desk still gets its queue.
 */
jest.mock('../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../hooks/useCurrentRoles'),
  useCurrentRoles: jest.fn(),
  useCurrentPermissions: jest.fn(() => []),
}));
jest.mock('../../services/socket', () => ({ connectSocket: () => null, getSocket: () => null }));
jest.mock('../../services/feedback', () => ({
  ...jest.requireActual('../../services/feedback'),
  getMyFeedback: jest.fn(async () => []),
  getQueue: jest.fn(async () => ({ data: [], meta: { pagination: { total: 0 } } })),
  getStats: jest.fn(async () => null),
  getDigest: jest.fn(async () => ({ openCount: 0, topThemes: [], aging: [], criticalOpen: [] })),
  getAttention: jest.fn(async () => null),
  getAssignees: jest.fn(async () => []),
  getThread: jest.fn(),
}));

const roles = jest.requireMock('../../hooks/useCurrentRoles') as { useCurrentRoles: jest.Mock };
const api = jest.requireMock('../../services/feedback') as Record<string, jest.Mock>;

const draw = () => render(<MemoryRouter initialEntries={['/feedback']}><FeedbackPage /></MemoryRouter>);

beforeEach(() => jest.clearAllMocks());

describe('Support page', () => {
  it.each([SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.ADMIN, SystemRole.CLIENT_USER])(
    'gives %s the reporting side and leaves the desk alone',
    async (role) => {
      roles.useCurrentRoles.mockReturnValue([role]);
      draw();
      expect(screen.getByText('My support requests')).toBeInTheDocument();
      await waitFor(() => expect(api.getMyFeedback).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: /support/i })).toBeInTheDocument();
      for (const deskOnly of ['getQueue', 'getStats', 'getDigest', 'getAttention', 'getAssignees']) {
        expect({ deskOnly, called: api[deskOnly].mock.calls.length }).toEqual({ deskOnly, called: 0 });
      }
      expect(screen.queryByText('Support desk')).toBeNull();
    },
  );

  it('still gives a developer the desk', async () => {
    roles.useCurrentRoles.mockReturnValue([SystemRole.DEVELOPER]);
    draw();
    expect(screen.getByText('Support desk')).toBeInTheDocument();
    await waitFor(() => expect(api.getQueue).toHaveBeenCalled());
    expect(api.getMyFeedback).not.toHaveBeenCalled();
  });
});
