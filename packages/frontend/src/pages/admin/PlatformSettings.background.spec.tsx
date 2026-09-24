import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlatformSettings } from './PlatformSettings';
import { ToastProvider } from '../../components/ui';
import { api } from '../../services/api';

jest.mock('../../services/api', () => ({ api: { request: jest.fn(async () => []) } }));
const request = api.request as jest.Mock;

/**
 * Operations and auditors open Settings for their own sections. The email card's status read is
 * `/notification-admin/*` — ADMIN only — so it must not fire for them.
 */
describe('Settings email status read', () => {
  const mount = async (roles: string[]) => {
    localStorage.setItem('fapoms_user_cache', JSON.stringify({ id: 'me', roles }));
    await act(async () => {
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter><ToastProvider><PlatformSettings /></ToastProvider></MemoryRouter>
        </QueryClientProvider>,
      );
    });
  };
  const askedEmail = () => request.mock.calls.some(([p]) => String(p).startsWith('/notification-admin/email/status'));

  beforeEach(() => { request.mockClear(); localStorage.clear(); });

  it('is not asked for OPERATIONS', async () => {
    await mount(['OPERATIONS']);
    expect(askedEmail()).toBe(false);
  });

  it('is asked for ADMIN', async () => {
    await mount(['ADMIN']);
    expect(askedEmail()).toBe(true);
  });
});
