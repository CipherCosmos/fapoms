import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ExpenseReview } from './ExpenseReview';
import { ToastProvider } from '../components/ui';
import * as expensesService from '../services/expenses';

/**
 * The rejection reason picker: preset+Other, the same pattern as PayoutsTab's HoldModal.
 *
 * There is no real rejection history in this database (zero claims ever rejected), so the
 * presets are seeded from context rather than mined — the point of these tests is only that
 * whichever path is used, the exact text reaches `reviewExpense`, never a placeholder or a
 * half-applied value.
 */

// `services/expenses.ts` imports `./api`, which pulls in a Vite-only `import.meta.env` (via
// `session.ts` -> `socket.ts`) that ts-jest cannot parse. Stubbing `services/api` here cuts that
// chain before `requireActual` below ever reaches it — nothing in this suite calls the real API.
jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../services/expenses', () => {
  const actual = jest.requireActual('../services/expenses');
  return {
    ...actual,
    getPendingExpenses: jest.fn(),
    reviewExpense: jest.fn(),
  };
});

// Only relevant to travel claims; this suite uses a FOOD claim, but stub it out regardless so
// an unrelated network call never trips up an unmocked fetch.
jest.mock('../components/TravelEvidence', () => ({ TravelEvidence: () => null }));

const mockGetPending = expensesService.getPendingExpenses as jest.Mock;
const mockReview = expensesService.reviewExpense as jest.Mock;

const claim = (over: Record<string, unknown> = {}) => ({
  id: 'e-1',
  assignmentId: 'a-1',
  assayerId: 'as-1',
  category: 'FOOD',
  amount: 500,
  description: 'Lunch while on site',
  receiptUrl: null,
  status: 'PENDING',
  reviewedBy: null,
  reviewedAt: null,
  reviewNotes: null,
  reimbursementPayableId: null,
  createdAt: new Date().toISOString(),
  assayer: { id: 'as-1', displayName: 'Test Assayer', assayerCode: 'AS1' },
  assignment: { id: 'a-1', assignmentNumber: 'ASG-1' },
  ...over,
});

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider><ExpenseReview /></ToastProvider>
    </QueryClientProvider>,
  );
};

/** Open the reject modal for the one claim on screen and open its reason picker. */
const openRejectPicker = async () => {
  renderPage();
  await waitFor(() => expect(screen.getByText('Test Assayer')).toBeInTheDocument());
  fireEvent.click(screen.getByTitle('Reject'));
  await waitFor(() => expect(screen.getByText('Reject expense claim')).toBeInTheDocument());
  // The trigger's own accessible role, not its label text — the label span, its parent button
  // and the outer wrapper all carry the same text node, so a text query would match all three.
  fireEvent.click(screen.getByRole('combobox'));
};

beforeEach(() => {
  mockGetPending.mockReset().mockResolvedValue([claim()]);
  mockReview.mockReset().mockResolvedValue(claim({ status: 'REJECTED' }));
});

describe('ExpenseReview — reject reason', () => {
  it('sends the exact preset text, not a placeholder or the label with punctuation stripped', async () => {
    await openRejectPicker();

    fireEvent.click(await screen.findByRole('option', { name: 'Amount exceeds policy limit' }));
    fireEvent.click(screen.getByRole('button', { name: /Reject claim/ }));

    await waitFor(() => expect(mockReview).toHaveBeenCalledWith('e-1', false, 'Amount exceeds policy limit'));
  });

  it('sends the exact free text typed under Other, not the preset placeholder', async () => {
    await openRejectPicker();

    fireEvent.click(await screen.findByRole('option', { name: 'Other…' }));
    const textarea = await screen.findByPlaceholderText(
      'Explain why this claim is being rejected — the assayer will see this.',
    );
    fireEvent.change(textarea, { target: { value: 'The receipt is for a different assignment entirely.' } });
    fireEvent.click(screen.getByRole('button', { name: /Reject claim/ }));

    await waitFor(() =>
      expect(mockReview).toHaveBeenCalledWith('e-1', false, 'The receipt is for a different assignment entirely.'));
  });

  it('keeps the reject button disabled until a reason is actually chosen or typed', async () => {
    await openRejectPicker();
    expect(screen.getByRole('button', { name: /Reject claim/ })).toBeDisabled();

    fireEvent.click(await screen.findByRole('option', { name: 'Other…' }));
    expect(screen.getByRole('button', { name: /Reject claim/ })).toBeDisabled();

    const textarea = await screen.findByPlaceholderText(
      'Explain why this claim is being rejected — the assayer will see this.',
    );
    fireEvent.change(textarea, { target: { value: 'Enough detail here' } });
    expect(screen.getByRole('button', { name: /Reject claim/ })).not.toBeDisabled();
  });
});
