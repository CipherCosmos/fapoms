import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScopeProvider } from '../context/ScopeContext';
import { useGlobalSearch } from './useGlobalSearch';
import { api } from '../services/api';

jest.mock('../services/api', () => ({
  api: {
    request: jest.fn(async (p: string) => (String(p).startsWith('/search')
      ? { branches: [], assayers: [], projects: [], clients: [], assignments: [] }
      : { data: {} })),
  },
}));
const request = api.request as jest.Mock;

/**
 * App-wide chrome must not ask what a custom role is refused. `GET /scope/options` and
 * `GET /search` are staff role NAMES on the server (no fallback), and they ran on every page for
 * a role built in Admin → Roles — a stream of background 403s.
 */
const signIn = (roles: string[]) => {
  localStorage.setItem('fapoms_token', 't');
  localStorage.setItem('fapoms_user_cache', JSON.stringify({ id: 'me', roles }));
};
const wrap = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

beforeEach(() => { request.mockClear(); localStorage.clear(); jest.useRealTimers(); });

describe('scope options', () => {
  it.each([
    [['MAP_VIEWER'], false],
    [['OPERATIONS'], true],
  ])('roles %j → asked: %s', async (roles, asked) => {
    signIn(roles as string[]);
    await act(async () => { render(<ScopeProvider><div /></ScopeProvider>, { wrapper: wrap }); });
    expect(request.mock.calls.some(([p]) => String(p).startsWith('/scope/options'))).toBe(asked);
  });
});

describe('global search', () => {
  it.each([
    [['MAP_VIEWER'], false],
    [['AUDITOR'], true],
  ])('roles %j → asked: %s', async (roles, asked) => {
    signIn(roles as string[]);
    jest.useFakeTimers();
    const { result } = renderHook(() => useGlobalSearch(), { wrapper: wrap });
    act(() => { result.current.setQuery('pune'); });
    await act(async () => { jest.advanceTimersByTime(300); });
    jest.useRealTimers();
    expect(request.mock.calls.some(([p]) => String(p).startsWith('/search'))).toBe(asked);
  });
});
