import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { api } from '../services/api';
import { AppError } from '../services/errors';

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../context/ScopeContext', () => ({
  useScope: () => ({ scopeParams: {}, scopeKey: 'national' }),
  withScope: () => '',
}));

const mockRequest = api.request as jest.Mock;

/**
 * "Refused" and "broken" are different answers, and the dashboard used to give only one of them.
 *
 * A workforce clerk on a role that does not include cross-project figures was shown "Could not
 * load the operational snapshot" with a Retry button — which could only fail again, identically,
 * for as long as the role stayed the same. It reads as an outage, and it produced support calls
 * about a decision somebody had made deliberately.
 */
describe('Dashboard, when the snapshot comes back refused', () => {
  const renderDashboard = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <MemoryRouter>
        <QueryClientProvider client={client}><Dashboard /></QueryClientProvider>
      </MemoryRouter>,
    );
  };

  beforeEach(() => {
    mockRequest.mockReset();
    localStorage.setItem('fapoms_user_cache', JSON.stringify({
      roles: [{ name: 'HR_OPERATOR', permissions: [{ resource: 'ASSAYER', action: 'VIEW', scope: 'PLATFORM' }] }],
    }));
  });
  afterEach(() => localStorage.clear());

  it('says the figures are not part of their access, and offers no Retry', async () => {
    mockRequest.mockRejectedValue(new AppError('You do not have permission to do this.', 'Insufficient role permissions', 403));

    renderDashboard();

    expect(await screen.findByText(/not part of your access/i)).toBeInTheDocument();
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not load the operational snapshot/)).not.toBeInTheDocument();
  });

  it('points them at a page they can actually open', async () => {
    mockRequest.mockRejectedValue(new AppError('Refused', 'Insufficient role permissions', 403));

    renderDashboard();

    // The workforce console, which is what this role's permissions do reach.
    expect(await screen.findByText('Go to my start page')).toBeInTheDocument();
  });

  it('still reports a genuine outage as an outage, with the Retry that can fix it', async () => {
    mockRequest.mockRejectedValue(new AppError('Something went wrong on our side.', 'HTTP 500', 500));

    renderDashboard();

    expect(await screen.findByText(/Could not load the operational snapshot/)).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('treats a network failure, which carries no status at all, as an outage too', async () => {
    mockRequest.mockRejectedValue(new AppError('Could not reach the server.', 'Failed to fetch'));

    renderDashboard();

    expect(await screen.findByText(/Could not load the operational snapshot/)).toBeInTheDocument();
  });
});
