import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OnboardingApprovalEventKind as K, OnboardingApprovalStatus as S } from '@fapoms/shared';
import { api } from '../../../services/api';
import { useApprovalCount } from './approval-queue';

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));

let mockRoles: string[] = ['ADMIN'];
jest.mock('../../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../../hooks/useCurrentRoles'),
  useCurrentRoles: () => mockRoles,
  useCurrentPermissions: () => [],
  useCurrentUserId: () => 'boss-1',
}));

const mockRequest = api.request as jest.Mock;

/**
 * THE NUMBER IN THE NAVIGATION — and when there must be no number at all.
 *
 * A 0 beside "Approvals" tells a senior nothing is waiting on them. So it may only ever come from a
 * queue that actually answered: while it loads, after it fails, and for somebody who cannot approve,
 * there is no number — never a reassuring 0 that nobody measured.
 */
describe('the approvals count', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
  );
  const pending = (id: string, preparers: string[]) => ({
    id, round: 1, status: S.PENDING, decidedAt: null, preparers, assayerId: `a-${id}`, displayName: id, assayerCode: null, region: null,
    events: [{ kind: K.SUBMITTED, byId: preparers[0], byName: null, at: '2026-09-20T09:00:00Z', text: null }],
  });

  beforeEach(() => { mockRoles = ['ADMIN']; mockRequest.mockReset(); });

  it('counts only the decisions waiting on the reader', async () => {
    mockRequest.mockResolvedValue([pending('p1', ['hr-1']), pending('p2', ['hr-1']), pending('p3', ['boss-1'])]);
    const { result } = renderHook(() => useApprovalCount(), { wrapper });
    await waitFor(() => expect(result.current).toBe(2));
  });

  it('has no number while the queue is still loading', () => {
    mockRequest.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useApprovalCount(), { wrapper });
    expect(result.current).toBeNull();
  });

  it('has no number when the queue failed to load', async () => {
    mockRequest.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useApprovalCount(), { wrapper });
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeNull();
  });

  it('asks nothing, and shows nothing, for somebody who cannot approve', () => {
    mockRoles = ['OPERATIONS'];
    const { result } = renderHook(() => useApprovalCount(), { wrapper });
    expect(result.current).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
