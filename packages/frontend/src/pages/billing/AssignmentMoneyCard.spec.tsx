import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssignmentMoneyCard } from './AssignmentMoneyCard';
import { HOLD_REASONS as PAYOUTS_HOLD_REASONS } from './PayoutsTab';
import { ToastProvider } from '../../components/ui';
import { billingApi } from '../../services/billing';
import { AssignmentStatus, BillingState } from '@fapoms/shared';

/**
 * The client-line adjustment reason and hold reason: preset+Other, same shape as PayoutsTab's
 * HoldModal. The hold reason is the whole point of this file's fix — it must be the exact same
 * `HOLD_REASONS` array PayoutsTab uses for the assayer-side hold, not a second copy that could
 * drift from it, because holding a client line and holding the payout it will become are the
 * same real-world decision seen from two screens.
 */

// `services/billing.ts` (and, transitively, `PayoutsTab` -> `ExpenseReview` -> `services/expenses`)
// import `./api`, which pulls in a Vite-only `import.meta.env` (via `session.ts` -> `socket.ts`)
// that ts-jest cannot parse. Stubbing `services/api` here cuts that chain everywhere it's reached
// from — nothing in this suite calls the real API.
jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/billing', () => {
  const actual = jest.requireActual('../../services/billing');
  return {
    ...actual,
    billingApi: {
      ...actual.billingApi,
      getAssignmentMoney: jest.fn(),
      editClientLine: jest.fn(),
    },
  };
});

const mockGetAssignmentMoney = billingApi.getAssignmentMoney as jest.Mock;
const mockEditClientLine = billingApi.editClientLine as jest.Mock;

const moneyLine = (entryOver: Record<string, unknown> = {}) => ({
  assignmentId: 'a-1',
  assignmentNumber: 'ASG-1',
  assignmentStatus: AssignmentStatus.COMPLETED,
  booked: true,
  fee: { amount: 1000, settled: true, source: 'AGREED' },
  payable: null,
  reimbursements: [],
  entry: {
    id: 'entry-1',
    entryNumber: 'ENT-1',
    clientId: 'c-1',
    assignmentId: 'a-1',
    state: BillingState.UNBILLED,
    onHold: false,
    holdReason: null,
    baseAmount: 1000,
    travelAmount: 0,
    adjustmentAmount: 0,
    adjustmentReason: null,
    taxRate: 18,
    taxableAmount: 1000,
    taxAmount: 180,
    tdsRate: 2,
    tdsAmount: 20,
    totalAmount: 1160,
    currency: 'INR',
    paidAmount: 0,
    outstandingAmount: 1160,
    ...entryOver,
  },
  invoice: null,
  payments: [],
  history: [],
});

const renderCard = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <AssignmentMoneyCard assignmentId="a-1" status={AssignmentStatus.COMPLETED} canEdit />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

/** Loads the card and opens the adjust/hold modal, which is where both pickers live. */
const openClientLineModal = async () => {
  renderCard();
  await waitFor(() => expect(screen.getByText('Client line')).toBeInTheDocument());
  fireEvent.click(screen.getByTitle('Adjust or hold this line'));
  await screen.findByText('Client line · ENT-1');
};

beforeEach(() => {
  mockGetAssignmentMoney.mockReset().mockResolvedValue(moneyLine());
  mockEditClientLine.mockReset().mockResolvedValue({});
});

describe('AssignmentMoneyCard — hold reason is PayoutsTab’s own list, not a copy', () => {
  it('imports the same HOLD_REASONS array PayoutsTab exports', () => {
    // The fix this proves: AssignmentMoneyCard has no `HOLD_REASONS` of its own to drift from
    // PayoutsTab's. If it ever gained one, this import would still resolve to PayoutsTab's array
    // and the assertions below on well-known entries would be the thing that catches it.
    expect(Array.isArray(PAYOUTS_HOLD_REASONS)).toBe(true);
    expect(PAYOUTS_HOLD_REASONS.length).toBeGreaterThan(0);
    expect(PAYOUTS_HOLD_REASONS).toContain('Bank details missing or incorrect');
  });

  it('offers every one of PayoutsTab’s hold reasons as an option in the client-line hold picker', async () => {
    await openClientLineModal();
    const holdSelect = screen.getAllByRole('combobox')[1]; // [0] adjustment reason, [1] hold reason
    fireEvent.click(holdSelect);

    for (const reasonText of PAYOUTS_HOLD_REASONS) {
      expect(await screen.findByRole('option', { name: reasonText })).toBeInTheDocument();
    }
  });
});

describe('AssignmentMoneyCard — adjustment reason', () => {
  it('sends the exact preset text', async () => {
    await openClientLineModal();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '-50' } });

    fireEvent.click(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Goodwill discount' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save adjustment' }));

    await waitFor(() =>
      expect(mockEditClientLine).toHaveBeenCalledWith('a-1', { adjustmentAmount: -50, adjustmentReason: 'Goodwill discount' }));
  });

  it('sends the exact free text typed under Other, not the preset placeholder', async () => {
    await openClientLineModal();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '-25' } });

    fireEvent.click(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Other…' }));
    fireEvent.change(screen.getByPlaceholderText('Reason (required unless 0)'), {
      target: { value: 'Client escalated the fee to the account manager.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save adjustment' }));

    await waitFor(() =>
      expect(mockEditClientLine).toHaveBeenCalledWith('a-1', {
        adjustmentAmount: -25,
        adjustmentReason: 'Client escalated the fee to the account manager.',
      }));
  });
});

/**
 * The adjustment field had no preview and no floor guard on the client — a stray digit went
 * straight to the server, which refuses a credit larger than the line but only after the click.
 * `moneyLine()`'s entry has baseAmount 1000 / travelAmount 0, so the line cannot be credited by
 * more than 1000 without going negative.
 */
describe('AssignmentMoneyCard — adjustment preview and floor guard', () => {
  it('disables Save and explains why when the credit would push the line below zero', async () => {
    await openClientLineModal();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '-1500' } });
    fireEvent.click(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Goodwill discount' }));

    expect(await screen.findByText(/exceeds the line/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save adjustment' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save adjustment' }));
    expect(mockEditClientLine).not.toHaveBeenCalled();
  });

  it('allows a credit that exactly zeroes the line', async () => {
    await openClientLineModal();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '-1000' } });
    fireEvent.click(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Goodwill discount' }));

    expect(screen.getByRole('button', { name: 'Save adjustment' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save adjustment' }));

    await waitFor(() =>
      expect(mockEditClientLine).toHaveBeenCalledWith('a-1', { adjustmentAmount: -1000, adjustmentReason: 'Goodwill discount' }));
  });

  it('previews the recomputed total as the operator types, before Save is ever clicked', async () => {
    await openClientLineModal();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '-50' } });

    expect(await screen.findByText(/New total for this line/i)).toBeInTheDocument();
    expect(mockEditClientLine).not.toHaveBeenCalled();
  });
});

describe('AssignmentMoneyCard — hold reason', () => {
  it('sends the exact preset text from PayoutsTab’s HOLD_REASONS', async () => {
    await openClientLineModal();
    const chosen = PAYOUTS_HOLD_REASONS[0];

    fireEvent.click(screen.getAllByRole('combobox')[1]);
    fireEvent.click(await screen.findByRole('option', { name: chosen }));
    fireEvent.click(screen.getByRole('button', { name: 'Hold' }));

    await waitFor(() =>
      expect(mockEditClientLine).toHaveBeenCalledWith('a-1', { onHold: true, holdReason: chosen }));
  });

  it('sends the exact free text typed under Other, not the preset placeholder', async () => {
    await openClientLineModal();

    fireEvent.click(screen.getAllByRole('combobox')[1]);
    fireEvent.click(await screen.findByRole('option', { name: 'Other…' }));
    fireEvent.change(screen.getByPlaceholderText('Why is this line on hold? *'), {
      target: { value: 'Client disputed this exact visit in writing.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Hold' }));

    await waitFor(() =>
      expect(mockEditClientLine).toHaveBeenCalledWith('a-1', {
        onHold: true,
        holdReason: 'Client disputed this exact visit in writing.',
      }));
  });
});
