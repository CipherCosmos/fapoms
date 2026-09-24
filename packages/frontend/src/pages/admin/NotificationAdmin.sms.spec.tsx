import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationAdmin } from './NotificationAdmin';
import { api } from '../../services/api';

/**
 * SMS as a per-event channel on Notification Rules.
 *
 * The owner's decision is that every event starts with SMS off and an administrator switches it on
 * one event at a time. This screen is the only place that happens, so the column has to exist, has
 * to show an event's real state (off unless the live channels say otherwise), and ticking it has to
 * save the event's channels with SMS added — not replace them, which would silently switch off the
 * bell and the push for that event in the same click.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../hooks/useCurrentRoles'),
  useCurrentRoles: () => ['ADMIN'],
  canAdministerNotifications: () => true,
}));

const mockRequest = api.request as jest.Mock;

const escalation = {
  type: 'ASSIGNMENT_ESCALATED',
  category: 'ASSIGNMENT',
  priority: 'CRITICAL',
  roles: ['OPERATIONS'],
  channels: ['IN_APP', 'PUSH', 'EMAIL'],
  title: 'Assignment escalated',
  body: 'It needs attention.',
  enabled: true,
  overridden: [],
  notes: null,
  placeholders: [],
  defaults: { channels: ['IN_APP', 'PUSH', 'EMAIL'], priority: 'CRITICAL', roles: ['OPERATIONS'], title: 'Assignment escalated', body: 'It needs attention.' },
};
const textedEvent = { ...escalation, type: 'ASSIGNMENT_SLA_BREACH', title: 'SLA breached', channels: ['IN_APP', 'SMS'], overridden: ['channels'] };

const renderScreen = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}><NotificationAdmin /></QueryClientProvider>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockImplementation((url: string, options?: { method?: string }) => {
    if (url === '/notification-admin/email/status') return Promise.resolve({ enabled: true, from: 'ops@example.in' });
    if (url === '/notification-admin/catalog') {
      return Promise.resolve({ types: [escalation, textedEvent], channels: ['IN_APP', 'PUSH', 'EMAIL', 'SMS'], priorities: [], categories: ['ASSIGNMENT'], roles: [] });
    }
    if (options?.method === 'PUT') return Promise.resolve({});
    return Promise.resolve({});
  });
});

describe('NotificationAdmin — the SMS channel', () => {
  it('shows an SMS column beside the other channels', async () => {
    renderScreen();
    expect(await screen.findByRole('columnheader', { name: 'SMS' })).toBeInTheDocument();
  });

  it('shows SMS unticked for an event left at its default, and ticked for one an administrator switched on', async () => {
    renderScreen();

    const off = await screen.findByRole('checkbox', { name: 'SMS for Assignment escalated' });
    const on = screen.getByRole('checkbox', { name: 'SMS for SLA breached' });
    expect(off).not.toBeChecked();
    expect(on).toBeChecked();
    // The cost warning is on the box before it is ticked, where it can still change the decision.
    expect(off).toHaveAttribute('title', expect.stringMatching(/paid for/));
  });

  it('ticking SMS saves the event with SMS added to the channels it already had', async () => {
    renderScreen();

    fireEvent.click(await screen.findByRole('checkbox', { name: 'SMS for Assignment escalated' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/notification-admin/catalog/ASSIGNMENT_ESCALATED',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const put = mockRequest.mock.calls.find(([url, o]) => url === '/notification-admin/catalog/ASSIGNMENT_ESCALATED' && o?.method === 'PUT')!;
    expect(JSON.parse(put[1].body)).toEqual({ channels: ['IN_APP', 'PUSH', 'EMAIL', 'SMS'] });
  });

  it('unticking SMS saves the event without it, leaving its other channels alone', async () => {
    renderScreen();

    fireEvent.click(await screen.findByRole('checkbox', { name: 'SMS for SLA breached' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/notification-admin/catalog/ASSIGNMENT_SLA_BREACH',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const put = mockRequest.mock.calls.find(([url, o]) => url === '/notification-admin/catalog/ASSIGNMENT_SLA_BREACH' && o?.method === 'PUT')!;
    expect(JSON.parse(put[1].body)).toEqual({ channels: ['IN_APP'] });
  });
});
