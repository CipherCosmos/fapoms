import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Users } from '../Users';
import { DirectoryPanel } from './DirectoryPanel';
import { api } from '../../services/api';
import { ToastProvider } from '../../components/ui';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const request = api.request as jest.Mock;

/**
 * People & access for a role built in Admin → Roles holding user:view.
 *
 * `GET /users` serves it (permission fallback); every write, and the audit feed, are role NAMES on
 * the server (ADMIN; ADMIN/AUDITOR). So it reads the list, and is not offered a control — Add, the
 * Manage drawer, bulk status — or a tab that could only answer 403.
 */
const asRole = (roles: string[]) => localStorage.setItem('fapoms_user_cache', JSON.stringify({ id: 'me', roles }));

const PEOPLE = [{ id: 'u-1', username: 'meera', firstName: 'Meera', lastName: 'Iyer', displayName: 'Meera Iyer', regions: [], email: 'm@x.in', status: 'ACTIVE', roles: [{ name: 'OPERATIONS' }], lastLoginAt: null, failedLoginAttempts: 0, lockedUntil: null }];

const mount = (ui: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><ToastProvider>{ui}</ToastProvider></MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (path: string) => {
    if (path.startsWith('/users?') || path === '/users') return { data: PEOPLE, meta: { pagination: { total: 1 } } };
    if (path.startsWith('/users/roles')) return [];
    return [];
  });
});

describe('a custom role with user:view', () => {
  it('reads the directory but gets no Add / Manage controls', async () => {
    asRole(['PEOPLE_READER']);
    mount(<DirectoryPanel />);
    expect(await screen.findByText('Meera Iyer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add someone/i })).not.toBeInTheDocument();
    // Neither the Manage button nor a clickable row.
    expect(screen.queryByRole('button', { name: /manage/i })).not.toBeInTheDocument();
  });

  it('is not offered the Activity tab, and nothing asks /audit-log', async () => {
    asRole(['PEOPLE_READER']);
    mount(<Users />);
    await screen.findByText('Meera Iyer');
    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument();
    expect(request.mock.calls.some(([p]) => String(p).startsWith('/audit-log'))).toBe(false);
  });
});

describe('ADMIN', () => {
  it('keeps every control and the Activity tab', async () => {
    asRole(['ADMIN']);
    mount(<Users />);
    await screen.findByText('Meera Iyer');
    expect(screen.getByRole('button', { name: /add someone/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^manage$/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument());
  });
});
