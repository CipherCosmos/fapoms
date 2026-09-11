import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ExpenseReview } from './ExpenseReview';
import { ToastProvider } from '../components/ui';
import * as expensesService from '../services/expenses';
import { AppError } from '../services/errors';

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

/**
 * Approve, and specifically a rapid double-tap on it.
 *
 * Live-verified against the real backend this session (Track K): a genuine double-click on this
 * exact button, and separately two truly concurrent `POST /expenses/:id/review` calls, both
 * produced exactly one state change — the server's own locked compare-and-swap is the backstop.
 * This suite locks in the client half: the button must go `disabled` on the *first* click,
 * synchronously enough that a second click before the request resolves never reaches
 * `reviewExpense` at all, so the network is not depended on to catch what the UI can prevent.
 */
describe('ExpenseReview — approve', () => {
  it('approves a claim and removes it from the queue on success', async () => {
    mockReview.mockResolvedValue(claim({ status: 'APPROVED' }));
    renderPage();
    await waitFor(() => expect(screen.getByText('Test Assayer')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Approve'));

    await waitFor(() => expect(mockReview).toHaveBeenCalledWith('e-1', true));
    await waitFor(() => expect(screen.queryByText('Test Assayer')).not.toBeInTheDocument());
  });

  it('a second click before the first request resolves never calls reviewExpense again', async () => {
    // A promise this test resolves on its own timeline, so the row stays "busy" across both
    // clicks — the exact window a real double-tap races.
    let resolveReview!: (v: unknown) => void;
    mockReview.mockReturnValue(new Promise((res) => { resolveReview = res; }));
    renderPage();
    await waitFor(() => expect(screen.getByText('Test Assayer')).toBeInTheDocument());

    const approveButton = screen.getByTitle('Approve');
    fireEvent.click(approveButton);
    expect(mockReview).toHaveBeenCalledTimes(1);
    // `disabled={busyId === c.id || !!bulkProgress}` should already be true by now — `setBusyId`
    // runs synchronously before the first `await`, and `fireEvent` flushes that render.
    expect(approveButton).toBeDisabled();

    fireEvent.click(approveButton);
    expect(mockReview).toHaveBeenCalledTimes(1); // still one — the second click never reached the handler's call

    resolveReview(claim({ status: 'APPROVED' }));
    await waitFor(() => expect(screen.queryByText('Test Assayer')).not.toBeInTheDocument());
    expect(mockReview).toHaveBeenCalledTimes(1); // and stays one, even after the row leaves the queue
  });

  it('re-enables the button and keeps the claim on screen if the request fails, so a retry is possible', async () => {
    mockReview.mockRejectedValue(new Error('network blip'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Test Assayer')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Approve'));
    await waitFor(() => expect(mockReview).toHaveBeenCalledTimes(1));

    // The row is still here to retry against, and the button is usable again — a failed approve
    // must not strand the claim in a permanently-disabled state.
    await waitFor(() => expect(screen.getByTitle('Approve')).not.toBeDisabled());
    expect(screen.getByText('Test Assayer')).toBeInTheDocument();
  });
});

/**
 * The "Trail" control: only a claim that could plausibly have a movement trail behind it should
 * offer to show one. Showing it on a claim with no journey (a food receipt, a toll) would imply
 * the platform can verify something it fundamentally cannot for that category.
 */
describe('ExpenseReview — movement trail visibility', () => {
  it('shows "Trail" for a TRAVEL_KM claim with an assignment behind it', async () => {
    mockGetPending.mockResolvedValue([claim({ category: 'TRAVEL_KM' })]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Test Assayer')).toBeInTheDocument());
    expect(screen.getByTitle('Check the recorded movement trail')).toBeInTheDocument();
  });

  it('hides "Trail" for a non-travel category (e.g. a food or toll claim)', async () => {
    mockGetPending.mockResolvedValue([claim({ category: 'FOOD' })]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Test Assayer')).toBeInTheDocument());
    expect(screen.queryByTitle('Check the recorded movement trail')).not.toBeInTheDocument();
  });

  it('hides "Trail" for a TRAVEL_KM claim with no assignmentId to look a trail up against', async () => {
    mockGetPending.mockResolvedValue([claim({ category: 'TRAVEL_KM', assignmentId: null })]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Test Assayer')).toBeInTheDocument());
    expect(screen.queryByTitle('Check the recorded movement trail')).not.toBeInTheDocument();
  });
});

/**
 * A queue that could not be read is not a queue that is clear.
 *
 * The load used to `catch`, fire a toast, and leave `claims` at `[]`. Four seconds later the only
 * thing on screen was "No expense claims are awaiting review." over "0 pending · ₹0" — a claim
 * about assayers' own reimbursements that nobody had verified. The banner has to outlive the
 * toast, and the table has to stop contradicting it.
 */
describe('ExpenseReview — a refused queue is not a cleared one', () => {
  const refused = new AppError(
    'You do not have permission to perform this action. Ask an administrator if you require access.',
    'Forbidden', 403, 'permission-required',
  );
  /**
   * The banner, told apart from the toast. Both say "Could not load", which is the point — the
   * toast is for the reviewer who is looking, the banner for the one who is not — so every query
   * here names the banner's own sentence rather than the shared prefix.
   */
  const banner = /Could not load the expense claims waiting for review/;

  it('states the refusal, and does not say the queue is empty', async () => {
    mockGetPending.mockReset().mockRejectedValue(refused);
    renderPage();

    await waitFor(() => expect(screen.getByText(banner)).toBeInTheDocument());
    // Once in the banner, once in the toast — the reason is quoted, not summarised as "unknown".
    expect(screen.getAllByText(/do not have permission/).length).toBeGreaterThan(0);
    expect(screen.queryByText('No expense claims are awaiting review.')).not.toBeInTheDocument();
  });

  it('offers no Retry for a refusal — pressing it could only fail the same way', async () => {
    mockGetPending.mockReset().mockRejectedValue(refused);
    renderPage();
    await waitFor(() => expect(screen.getByText(banner)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('does offer Retry when the failure is one a retry could fix', async () => {
    mockGetPending.mockReset().mockRejectedValue(
      new AppError('The server could not complete that request.', 'Internal Server Error', 500, 'retryable'),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(banner)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('clears the banner once a later load succeeds', async () => {
    mockGetPending.mockReset()
      .mockRejectedValueOnce(refused)
      .mockResolvedValue([claim()]);
    renderPage();
    await waitFor(() => expect(screen.getByText(banner)).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Refresh'));
    await waitFor(() => expect(screen.getByText('Test Assayer')).toBeInTheDocument());
    expect(screen.queryByText(banner)).not.toBeInTheDocument();
  });
});
