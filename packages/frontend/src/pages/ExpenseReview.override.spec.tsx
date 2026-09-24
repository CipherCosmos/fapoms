import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OTHER_CONFLICT_ERROR_CODES } from '@fapoms/shared';
import { ExpenseReview } from './ExpenseReview';
import { ToastProvider } from '../components/ui';
import * as expensesService from '../services/expenses';
import { AppError } from '../services/errors';

/**
 * Approving a claim the approval rules refuse (owner decision 2026-09-24): the refusal is shown
 * with the server's own sentence naming which rule applies; an administrator may approve anyway
 * with a written reason; anyone else is told who can and may reject instead.
 *
 * Mutation checks: showing the reason field to a non-senior, dropping the minimum-length gate on
 * "Approve anyway", not sending the reason, or treating the refusal as a plain failed request
 * (toast only) each turn a test here red.
 */

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../services/expenses', () => {
  const actual = jest.requireActual('../services/expenses');
  return { ...actual, getPendingExpenses: jest.fn(), reviewExpense: jest.fn() };
});
jest.mock('../components/TravelEvidence', () => ({ TravelEvidence: () => null }));

const mockGetPending = expensesService.getPendingExpenses as jest.Mock;
const mockReview = expensesService.reviewExpense as jest.Mock;

const claim = {
  id: 'e-1', assignmentId: 'a-1', assayerId: 'as-1', category: 'FOOD', amount: 500,
  description: 'Lunch while on site', receiptUrl: null, status: 'PENDING', reviewedBy: null, reviewedAt: null,
  reviewNotes: null, reimbursementPayableId: null, createdAt: new Date().toISOString(),
  assayer: { id: 'as-1', displayName: 'Test Assayer', assayerCode: 'AS1' },
  assignment: { id: 'a-1', assignmentNumber: 'ASG-1' },
};

const REFUSAL = 'This claim cannot be approved: Assignment ASG-1 has been cancelled. A senior can still approve it by writing a reason.';
const refused = () => new AppError(REFUSAL, REFUSAL, 409, 'conflict', OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSIGNMENT_CANCELLED);

const signInAs = (role: string) =>
  localStorage.setItem('fapoms_user_cache', JSON.stringify({ id: 'u-1', roles: [{ name: role, permissions: [] }] }));

const renderPage = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider><ExpenseReview /></ToastProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText('Test Assayer')).toBeInTheDocument());
};

beforeEach(() => {
  localStorage.clear();
  mockGetPending.mockReset().mockResolvedValue([claim]);
  mockReview.mockReset();
});

describe('ExpenseReview — approval refused by the rules', () => {
  it('shows the reviewer which rule refused it, offers Reject instead, and no override to a non-senior', async () => {
    signInAs('OPERATIONS');
    mockReview.mockRejectedValue(refused());
    await renderPage();

    fireEvent.click(screen.getByTitle('Approve'));

    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(screen.getByText(/Only an administrator can approve it anyway/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Why approve it anyway/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve anyway/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Reject instead/ }));
    expect(await screen.findByText('Reject expense claim')).toBeInTheDocument();
  });

  it('lets an administrator approve anyway once a real reason is written, and sends that reason', async () => {
    signInAs('ADMIN');
    mockReview.mockRejectedValueOnce(refused()).mockResolvedValueOnce({ ...claim, status: 'APPROVED' });
    await renderPage();

    fireEvent.click(screen.getByTitle('Approve'));
    const box = await screen.findByLabelText(/Why approve it anyway/);
    const button = screen.getByRole('button', { name: /Approve anyway/ });
    expect(button).toBeDisabled();

    fireEvent.change(box, { target: { value: 'too short' } }); // 9 characters
    expect(button).toBeDisabled();

    const why = 'Visit done on the 12th, cancelled afterwards by mistake';
    fireEvent.change(box, { target: { value: `  ${why}  ` } });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    await waitFor(() => expect(mockReview).toHaveBeenLastCalledWith('e-1', true, undefined, why));
    await waitFor(() => expect(screen.queryByText('Test Assayer')).not.toBeInTheDocument());
  });

  it('a DEVELOPER counts as an administrator here, through the role hierarchy', async () => {
    signInAs('DEVELOPER');
    mockReview.mockRejectedValue(refused());
    await renderPage();
    fireEvent.click(screen.getByTitle('Approve'));
    expect(await screen.findByLabelText(/Why approve it anyway/)).toBeInTheDocument();
  });

  it('an ordinary failure is still just a failed request — no refusal dialog', async () => {
    signInAs('ADMIN');
    mockReview.mockRejectedValue(new Error('network blip'));
    await renderPage();
    fireEvent.click(screen.getByTitle('Approve'));
    await waitFor(() => expect(screen.getByTitle('Approve')).not.toBeDisabled());
    expect(screen.queryByText(/cannot be approved as it stands/)).not.toBeInTheDocument();
  });
});
