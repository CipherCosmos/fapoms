import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SessionsPanel } from './SessionsPanel';
import * as sessions from '../../services/sessions';
import type { SessionView } from '../../services/sessions';

jest.mock('../../services/sessions', () => ({
  getMySessions: jest.fn(),
  getUserSessions: jest.fn(),
  revokeSession: jest.fn(),
}));

const getMySessions = jest.mocked(sessions.getMySessions);
const revokeSession = jest.mocked(sessions.revokeSession);

const session = (over: Partial<SessionView> = {}): SessionView => ({
  id: 's-1',
  ipAddress: '203.0.113.5',
  device: 'Chrome on Windows',
  browser: 'Chrome',
  os: 'Windows',
  loginMethod: 'PASSWORD',
  createdAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1e6).toISOString(),
  revokedAt: null,
  revokedReason: null,
  active: true,
  current: false,
  ...over,
});

const renderPanel = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionsPanel />
    </QueryClientProvider>,
  );
};

describe('SessionsPanel', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists sessions with device and IP, and flags the current device', async () => {
    getMySessions.mockResolvedValue([
      session({ id: 'here', current: true, device: 'Chrome on macOS', ipAddress: '10.0.0.2' }),
      session({ id: 'old', device: 'Old phone', ipAddress: '203.0.113.9' }),
    ]);
    renderPanel();

    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('Old phone')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.9/)).toBeInTheDocument();
  });

  it('offers Sign out on other devices but not the current one', async () => {
    getMySessions.mockResolvedValue([
      session({ id: 'here', current: true }),
      session({ id: 'old', device: 'Old phone' }),
    ]);
    renderPanel();
    await screen.findByText('Old phone');
    // Exactly one Sign out button — the non-current active session.
    expect(screen.getAllByRole('button', { name: /sign out/i })).toHaveLength(1);
  });

  it('revokes a device when Sign out is clicked', async () => {
    getMySessions.mockResolvedValue([session({ id: 'old', device: 'Old phone' })]);
    revokeSession.mockResolvedValue({ success: true });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith('old'));
  });

  it('shows an empty state when there are no sessions', async () => {
    getMySessions.mockResolvedValue([]);
    renderPanel();
    expect(await screen.findByText(/No sessions on record/i)).toBeInTheDocument();
  });
});
