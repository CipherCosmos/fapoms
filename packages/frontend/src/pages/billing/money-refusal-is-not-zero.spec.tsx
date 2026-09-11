import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppError } from '../../services/errors';

/**
 * A refusal on a money screen must never be drawn as ₹0, or as "nothing to do".
 *
 * The shipped defect this pins down: every list surface here defaults its rows to `[]` and its
 * totals to `0`, so a 403 — a role that is simply not on the disbursement path — fell through the
 * `isError` check (which misses a query that failed and PAUSED) and landed on the empty state.
 * The screens then said, with no hedging:
 *
 *   - Payouts:           "No payouts yet. They appear here the moment an assignment completes."
 *   - Assayer invoices:  "Nothing waiting for approval."
 *   - Ready to invoice:  "Nothing to invoice. Completed assignments appear here automatically."
 *   - Expense claims:    "No expense claims are awaiting review."
 *
 * Each of those is a statement about money somebody is owed, or money the business is owed, and
 * each was false. The second failure mode is the same lie told the other way round: the invoice
 * drawer and the assignment money card both guarded on `!data`, so a 403 or a 404 opened a panel
 * titled "Loading…" that never resolved.
 *
 * These tests drive the real components against a refusing API and assert both halves: the
 * refusal is stated, AND the empty-state sentence is absent. Asserting only the first would pass
 * on a screen that printed both at once, which is the same lie with a banner over it.
 */

// `services/api` reads Vite's `import.meta.env`, which ts-jest cannot parse. Every fetch on these
// screens goes through the hooks below, which are mocked wholesale, so nothing reaches it.
jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({ connectSocket: () => null, disconnectSocket: () => null }));

import { PayoutsTab } from './PayoutsTab';
import { InvoicesTab } from './InvoicesTab';
import { AssayerInvoicesTab } from './AssayerInvoicesTab';
import { InvoiceDetailDrawer } from './InvoiceDetailDrawer';
import { AssignmentMoneyCard } from './AssignmentMoneyCard';

const REFUSED = new AppError(
  'You do not have permission to perform this action. Ask an administrator if you require access.',
  'Forbidden',
  403,
  'permission-required',
);

/** A query result in the state React Query leaves behind when a fetch failed and settled. */
const failing = () => ({
  data: undefined,
  isError: true,
  isLoading: false,
  isPending: false,
  isFetching: false,
  fetchStatus: 'idle' as const,
  error: REFUSED,
  refetch: jest.fn(),
});

/**
 * The state a bare `isError` check misses: React Query paused the retry, so `isError` is false,
 * `data` is undefined and `isLoading` is false. This is the exact shape that produced the
 * "/scheduling shows 0 active schedules" finding, so it gets its own pass through every screen.
 */
const paused = () => ({
  data: undefined,
  isError: false,
  isLoading: false,
  isPending: true,
  isFetching: false,
  fetchStatus: 'paused' as const,
  error: null,
  failureReason: REFUSED,
  refetch: jest.fn(),
});

// Declared inside the factory rather than above it: `jest.mock` is hoisted above the imports, and
// the factory runs the moment PayoutsTab is first required — before any `const` up here exists.
jest.mock('../../hooks/useBilling', () => {
  const idleMutation = () => ({ isPending: false, mutate: jest.fn(), mutateAsync: jest.fn() });
  return {
    usePayouts: jest.fn(),
    useInvoiceable: jest.fn(),
    useBillingInvoices: jest.fn(),
    useAssayerInvoices: jest.fn(),
    useBillingInvoice: jest.fn(),
    useAssignmentMoney: jest.fn(),
    useAssayerInvoiceLookup: jest.fn(() => new Map()),
    useAssayerInvoice: jest.fn(() => ({ data: undefined, isLoading: false, isError: false, fetchStatus: 'idle', error: null, refetch: jest.fn() })),
    useApprovePayouts: jest.fn(idleMutation),
    usePayPayouts: jest.fn(idleMutation),
    useHoldPayout: jest.fn(idleMutation),
    useReopenAssignment: jest.fn(idleMutation),
    useInviteAssayerInvoice: jest.fn(idleMutation),
    useInviteAllAssayerInvoices: jest.fn(idleMutation),
    useApproveAssayerInvoice: jest.fn(idleMutation),
    useCancelAssayerInvoice: jest.fn(idleMutation),
    useSendInvoice: jest.fn(idleMutation),
    useRecordBillingPayment: jest.fn(idleMutation),
    useCancelInvoice: jest.fn(idleMutation),
    useReversePayment: jest.fn(idleMutation),
    useEditClientLine: jest.fn(idleMutation),
  };
});
const billingHooks = jest.requireMock('../../hooks/useBilling') as Record<string, jest.Mock>;

const ok = <T,>(data: T) => ({
  data, isError: false, isLoading: false, isPending: false, isFetching: false,
  fetchStatus: 'idle' as const, error: null, refetch: jest.fn(),
});

function draw(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Both halves of the rule, in one assertion pair. */
function expectRefusalNotEmptiness(emptySentence: RegExp) {
  expect(screen.getByText(/Could not load/)).toBeInTheDocument();
  expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
  expect(screen.queryByText(emptySentence)).not.toBeInTheDocument();
}

beforeEach(() => {
  // Sensible non-failing defaults; each test overrides the one query it is about.
  billingHooks.usePayouts.mockReturnValue(ok({ items: [], total: 0 }));
  billingHooks.useInvoiceable.mockReturnValue(ok({ clients: [], total: 0 }));
  billingHooks.useBillingInvoices.mockReturnValue(ok({ items: [], total: 0 }));
  billingHooks.useAssayerInvoices.mockReturnValue(ok({ items: [], total: 0 }));
  billingHooks.useBillingInvoice.mockReturnValue(ok(undefined));
  billingHooks.useAssignmentMoney.mockReturnValue(ok(undefined));
  billingHooks.useAssayerInvoiceLookup.mockReturnValue(new Map());
});

describe('Payouts — a refused list is not an empty one', () => {
  it.each([['a settled 403', failing], ['a paused retry', paused]])(
    'says it was refused rather than "No payouts yet" (%s)',
    (_label, state) => {
      billingHooks.usePayouts.mockReturnValue(state());
      draw(<PayoutsTab filter="ALL" onFilter={jest.fn()} canAct canReviewClaims />);
      expectRefusalNotEmptiness(/No payouts yet/);
    },
  );

  it('offers no Retry for a refusal — the button could only fail identically', () => {
    billingHooks.usePayouts.mockReturnValue(failing());
    draw(<PayoutsTab filter="ALL" onFilter={jest.fn()} canAct canReviewClaims />);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('still shows the genuine empty state when the load actually succeeded', () => {
    draw(<PayoutsTab filter="ALL" onFilter={jest.fn()} canAct canReviewClaims />);
    expect(screen.getByText(/No payouts yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });
});

describe('Invoices — a refused book is not an unbilled one', () => {
  it.each([['a settled 403', failing], ['a paused retry', paused]])(
    'says the work-to-invoice list was refused rather than "Nothing to invoice" (%s)',
    (_label, state) => {
      billingHooks.useInvoiceable.mockReturnValue(state());
      draw(<InvoicesTab filter="ALL" onFilter={jest.fn()} canAct />);
      expectRefusalNotEmptiness(/Nothing to invoice/);
    },
  );

  it('says the invoice list was refused rather than "No invoices yet"', () => {
    billingHooks.useBillingInvoices.mockReturnValue(failing());
    draw(<InvoicesTab filter="ALL" onFilter={jest.fn()} canAct />);
    expectRefusalNotEmptiness(/No invoices yet/);
  });
});

describe('Assayer invoices — a refused queue is not an approved one', () => {
  it.each([['a settled 403', failing], ['a paused retry', paused]])(
    'says it was refused rather than "No assayer invoices yet" (%s)',
    (_label, state) => {
      billingHooks.useAssayerInvoices.mockReturnValue(state());
      draw(<AssayerInvoicesTab filter="ALL" onFilter={jest.fn()} canAct />);
      expectRefusalNotEmptiness(/No assayer invoices yet/);
    },
  );
});

describe('Invoice drawer — a refused invoice is not a slow one', () => {
  it('names the refusal instead of hanging on "Loading…"', () => {
    billingHooks.useBillingInvoice.mockReturnValue(failing());
    draw(<InvoiceDetailDrawer invoiceId="inv-1" onClose={jest.fn()} canAct />);
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('names a 404 as a missing record rather than hanging on "Loading…"', () => {
    const gone = new AppError('That record could not be found. It may have been removed or renamed.', 'Not Found', 404, 'non-retryable');
    billingHooks.useBillingInvoice.mockReturnValue({ ...failing(), error: gone });
    draw(<InvoiceDetailDrawer invoiceId="inv-1" onClose={jest.fn()} canAct />);
    expect(screen.getByText(/could not be found/)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    // A record that does not exist will not exist on a second try either.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe("Assignment money card — a refused ledger is not a loading one", () => {
  it('names the refusal instead of a permanent "Loading…"', () => {
    billingHooks.useAssignmentMoney.mockReturnValue(failing());
    draw(<AssignmentMoneyCard assignmentId="asn-1" status="COMPLETED" canEdit />);
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('does not claim the assignment is unbooked when the fetch never landed', () => {
    billingHooks.useAssignmentMoney.mockReturnValue(failing());
    draw(<AssignmentMoneyCard assignmentId="asn-1" status="COMPLETED" canEdit />);
    expect(screen.queryByText(/not booked yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing to book/i)).not.toBeInTheDocument();
  });
});

// Expense Review's own refusal case lives in `pages/ExpenseReview.spec.tsx`, beside the rest of
// that screen's tests — it fetches with useState/useEffect rather than through `useBilling`, so it
// needs a different set of mocks than this file installs.
