import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InvoiceStatus, SystemRole } from '@fapoms/shared';
import { TodoTab } from './TodoTab';

/**
 * 2026-09-24 contract audit.
 *  - P6: the tab billing opens on asked every visitor for the expense claims awaiting review. The
 *    server lets only ADMIN and OPERATIONS read them, so an auditor or a custom HOD role got a
 *    403 and a "could not load" box on their first screen.
 *  - Invoices the HOD approved but nobody has sent yet had no row: until sent they are owed by
 *    nobody, and nothing else on the list mentioned them.
 */
jest.mock('../../hooks/useBilling', () => ({
  useBillingOverview: jest.fn(),
  useAssayerInvoices: jest.fn(),
  useBillingInvoices: jest.fn(),
  useInvoiceable: jest.fn(),
}));
jest.mock('../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../hooks/useCurrentRoles'),
  useCurrentRoles: jest.fn(),
}));
jest.mock('../../services/expenses', () => ({ getPendingExpenses: jest.fn(async () => []) }));
jest.mock('./MoneyPosition', () => ({ MoneyPosition: () => null, AttentionList: () => null }));

const billing = jest.requireMock('../../hooks/useBilling') as Record<string, jest.Mock>;
const roles = jest.requireMock('../../hooks/useCurrentRoles') as { useCurrentRoles: jest.Mock };
const expenses = jest.requireMock('../../services/expenses') as { getPendingExpenses: jest.Mock };

const ok = <T,>(data: T) => ({ data, isError: false, isLoading: false, isFetching: false, fetchStatus: 'idle', error: null, refetch: jest.fn() });

const overview = {
  total: 0, clients: [], attention: [],
  payouts: {
    approved: 0, approvedCount: 0, awaitingHod: 0, awaitingHodCount: 0, held: 0, heldCount: 0,
    unbilled: 0, unbilledCount: 0, inClaimReview: 0, inClaimReviewCount: 0,
  },
  receivables: { aging: { d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }, held: 0, unbilled: 0 },
};

beforeEach(() => {
  jest.clearAllMocks();
  billing.useBillingOverview.mockReturnValue(ok(overview));
  billing.useAssayerInvoices.mockReturnValue(ok({ items: [], total: 0 }));
  billing.useInvoiceable.mockReturnValue(ok({ clients: [], total: 0 }));
  billing.useBillingInvoices.mockImplementation((p: { status?: InvoiceStatus }) =>
    ok({ items: [], total: p.status === InvoiceStatus.HOD_APPROVED ? 3 : 0 }));
});

const draw = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TodoTab onGo={jest.fn()} />
  </QueryClientProvider>,
);

describe('Billing to-do', () => {
  it('does not ask for expense claims on behalf of a role the server refuses', async () => {
    roles.useCurrentRoles.mockReturnValue([SystemRole.AUDITOR]);
    draw();
    await new Promise((r) => setTimeout(r, 0));
    expect(expenses.getPendingExpenses).not.toHaveBeenCalled();
    expect(screen.queryByText(/could not/i)).toBeNull();
  });

  it('still asks for them for operations', async () => {
    roles.useCurrentRoles.mockReturnValue([SystemRole.OPERATIONS]);
    draw();
    await new Promise((r) => setTimeout(r, 0));
    expect(expenses.getPendingExpenses).toHaveBeenCalled();
  });

  it('lists invoices the HOD approved that nobody has sent yet', () => {
    roles.useCurrentRoles.mockReturnValue([SystemRole.ADMIN]);
    draw();
    expect(screen.getByText('3 invoices are approved by the HOD and ready to send')).toBeTruthy();
  });
});
