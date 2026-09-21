import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssayerInvoicesTab } from './AssayerInvoicesTab';
import { ToastProvider } from '../../components/ui';
import { billingApi } from '../../services/billing';
import { api } from '../../services/api';
import { AssayerInvoiceStatus } from '@fapoms/shared';
import type { AssayerInvoiceSummary, AssayerInvoiceInvitation } from '@fapoms/shared';

/**
 * The ops half of the consent loop: what this proves is the FRICTION and the ORDER, not the
 * rendering. Approving an assayer invoice approves every pending payout on it in one gesture,
 * so the confirm must restate the line count and rupee total and demand the total typed back
 * (the same rule PayoutsTab's bulk approve follows); cancelling is the only "no" the flow has,
 * so it must not go through without a reason; and SUBMITTED rows must outrank everything else
 * on the list, because a submitted invoice is the one thing here waiting on ops.
 */

// `services/billing.ts` imports `./api`, which pulls in a Vite-only `import.meta.env` that
// ts-jest cannot parse. Stubbing `services/api` cuts that chain — nothing here calls the real API.
jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
// The real poller, with a short interval so a test is not waiting 1.5 s per read.
jest.mock('../../services/queued-job', () => {
  const actual = jest.requireActual('../../services/queued-job');
  return {
    ...actual,
    waitForQueuedJob: jest.fn((path: string, opts: Record<string, unknown> = {}) =>
      actual.waitForQueuedJob(path, { ...opts, pollMs: 5 })),
  };
});
jest.mock('../../services/billing', () => {
  const actual = jest.requireActual('../../services/billing');
  return {
    ...actual,
    billingApi: {
      ...actual.billingApi,
      listAssayerInvoices: jest.fn(),
      getAssayerInvoice: jest.fn(),
      approveAssayerInvoice: jest.fn(),
      cancelAssayerInvoice: jest.fn(),
      reviseAssayerInvoice: jest.fn(),
      inviteAllAssayerInvoices: jest.fn(),
      holdPayout: jest.fn(),
    },
  };
});

const mockList = billingApi.listAssayerInvoices as jest.Mock;
const mockGet = billingApi.getAssayerInvoice as jest.Mock;
const mockApprove = billingApi.approveAssayerInvoice as jest.Mock;
const mockCancel = billingApi.cancelAssayerInvoice as jest.Mock;
const mockInviteAll = billingApi.inviteAllAssayerInvoices as jest.Mock;
const mockRequest = api.request as jest.Mock;

const summary = (over: Partial<AssayerInvoiceSummary> = {}): AssayerInvoiceSummary => ({
  id: 'inv-1',
  invoiceNumber: 'AINV-1',
  assayerId: 'as-1',
  status: AssayerInvoiceStatus.SUBMITTED,
  invitedAt: '2026-09-01T10:00:00.000Z',
  invitedBy: 'ops-1',
  submittedAt: '2026-09-02T10:00:00.000Z',
  approvedAt: null,
  approvedBy: null,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  lineCount: 3,
  subtotalBase: 3000,
  subtotalTravel: 600,
  tdsAmount: 72,
  totalAmount: 3528,
  currency: 'INR',
  notes: null,
  assayerName: 'Asha Menon',
  assayerCode: 'AS-01',
  ...over,
});

const detail = (over: Partial<AssayerInvoiceInvitation> = {}): AssayerInvoiceInvitation => ({
  ...summary(),
  lines: [
    {
      payableId: 'p-1', payableNumber: 'PAY-1', kind: 'FEE', payableStatus: 'PENDING', onHold: false,
      assignmentId: 'a-1', assignmentNumber: 'ASG-1', branchName: 'Kochi', serviceDate: '2026-08-20',
      expenseCategory: null, baseAmount: 1500, travelAmount: 300, tdsAmount: 36, totalAmount: 1764,
    },
    {
      payableId: 'p-2', payableNumber: 'PAY-2', kind: 'FEE', payableStatus: 'PENDING', onHold: false,
      assignmentId: 'a-2', assignmentNumber: 'ASG-2', branchName: 'Thrissur', serviceDate: '2026-08-22',
      expenseCategory: null, baseAmount: 1500, travelAmount: 300, tdsAmount: 36, totalAmount: 1764,
    },
    {
      payableId: 'p-3', payableNumber: 'PAY-3', kind: 'EXPENSE', payableStatus: 'PENDING', onHold: false,
      assignmentId: 'a-1', assignmentNumber: 'ASG-1', branchName: 'Kochi', serviceDate: '2026-08-20',
      expenseCategory: 'TOLL', baseAmount: 0, travelAmount: 0, tdsAmount: 0, totalAmount: 0,
    },
  ],
  ...over,
});

const page = (items: AssayerInvoiceSummary[]) => ({ items, total: items.length, page: 1, limit: 50 });

const renderTab = (canAct = true) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <AssayerInvoicesTab filter="ALL" onFilter={jest.fn()} canAct={canAct} />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

/** Load the list, open the one invoice on it, and wait for the drawer's footer to be live. */
const openDrawer = async () => {
  renderTab();
  fireEvent.click(await screen.findByText('AINV-1'));
  await screen.findByRole('button', { name: /Approve \(3/ });
};

beforeEach(() => {
  mockList.mockReset().mockResolvedValue(page([summary()]));
  mockGet.mockReset().mockResolvedValue(detail());
  mockApprove.mockReset().mockResolvedValue(summary({ status: AssayerInvoiceStatus.APPROVED }));
  mockCancel.mockReset().mockResolvedValue(summary({ status: AssayerInvoiceStatus.CANCELLED }));
});

describe('AssayerInvoicesTab — SUBMITTED first', () => {
  it('puts submitted invoices above everything else, whatever order the server sent', async () => {
    // Server order is newest-first; the SUBMITTED one arrives LAST and must render FIRST,
    // because it is the only row on this list waiting on ops rather than on an assayer.
    mockList.mockResolvedValue(page([
      summary({ id: 'i-a', invoiceNumber: 'AINV-APPROVED', status: AssayerInvoiceStatus.APPROVED, approvedAt: '2026-09-03T10:00:00.000Z' }),
      summary({ id: 'i-b', invoiceNumber: 'AINV-INVITED', status: AssayerInvoiceStatus.INVITED, submittedAt: null }),
      summary({ id: 'i-c', invoiceNumber: 'AINV-SUBMITTED', status: AssayerInvoiceStatus.SUBMITTED }),
    ]));

    renderTab();
    await screen.findByText('AINV-SUBMITTED');

    const numbers = screen.getAllByText(/^AINV-/).map((el) => el.textContent);
    expect(numbers[0]).toBe('AINV-SUBMITTED');
    // The rest keep the server's order — the sort is a promotion, not a reshuffle.
    expect(numbers.slice(1)).toEqual(['AINV-APPROVED', 'AINV-INVITED']);
  });

  it('explains the flow when there is nothing to show', async () => {
    mockList.mockResolvedValue(page([]));
    renderTab();
    expect(await screen.findByText(/Send them with the button above; once an assayer confirms one, it comes back here for your approval\./)).toBeInTheDocument();
  });
});

describe('AssayerInvoicesTab — approve friction', () => {
  it('restates the line count and total, and only approves once the total is typed back', async () => {
    await openDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Approve \(3/ }));

    // The dialog names what is being accepted: the count and the rupee total the assayer confirmed.
    expect(await screen.findByText('3 lines')).toBeInTheDocument();
    expect(screen.getByText(/Every pending payout on it is approved in the same step/)).toBeInTheDocument();

    // The action button is disabled until the total's digits are typed — a click cannot do it.
    const approveBtn = screen.getByRole('button', { name: 'Approve ₹3,528' });
    expect(approveBtn).toBeDisabled();
    fireEvent.click(approveBtn);
    expect(mockApprove).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('3528'), { target: { value: '3528' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve ₹3,528' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Approve ₹3,528' }));

    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('inv-1'));
  });

  it('shows the server’s refusal sentence verbatim when approval is refused', async () => {
    // The hold refusal (like the drift 409) is a sentence written for a human — it must reach
    // the screen unparaphrased, because it names the payable and the way out.
    mockApprove.mockRejectedValue(new Error('PAY-2 on hold — release the hold or cancel AINV-1 first.'));
    await openDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Approve \(3/ }));
    fireEvent.change(await screen.findByPlaceholderText('3528'), { target: { value: '3528' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve ₹3,528' }));

    expect(await screen.findByText(/PAY-2 on hold — release the hold or cancel AINV-1 first\./)).toBeInTheDocument();
  });

  it('offers no approve for an invoice the assayer has not submitted', async () => {
    mockList.mockResolvedValue(page([summary({ status: AssayerInvoiceStatus.INVITED, submittedAt: null })]));
    mockGet.mockResolvedValue(detail({ status: AssayerInvoiceStatus.INVITED, submittedAt: null }));

    renderTab();
    fireEvent.click(await screen.findByText('AINV-1'));
    await screen.findByText(/Waiting on the assayer/);

    expect(screen.queryByRole('button', { name: /Approve \(3/ })).not.toBeInTheDocument();
    // Cancel remains — it is the only way to unwind an invitation.
    expect(screen.getByRole('button', { name: 'Cancel invoice' })).toBeInTheDocument();
  });
});

describe('AssayerInvoicesTab — cancel requires a reason', () => {
  /**
   * Two buttons share the name "Cancel invoice" (the footer toggle that OPENS the panel, and
   * the panel's primary that PERFORMS it — the same naming the client-invoice drawer uses), so
   * the performer is picked out by its primary styling rather than by DOM order.
   */
  const panelCancelButton = () =>
    screen.getAllByRole('button', { name: 'Cancel invoice' }).find((b) => b.className.includes('btn-primary'))!;

  const openCancelPanel = async () => {
    await openDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel invoice' }));
    await screen.findByText(/releases every line back to the unbilled pool/);
  };

  it('keeps the cancel button dead until a reason is chosen, then sends that exact reason', async () => {
    await openCancelPanel();

    expect(panelCancelButton()).toBeDisabled();
    fireEvent.click(panelCancelButton());
    expect(mockCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Invited by mistake' }));
    fireEvent.click(panelCancelButton());

    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('inv-1', 'Invited by mistake'));
  });

  it('sends the exact free text typed under Other', async () => {
    await openCancelPanel();

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Other…' }));
    fireEvent.change(screen.getByPlaceholderText('Reason *'), {
      target: { value: 'Assayer left the panel this week.' },
    });
    fireEvent.click(panelCancelButton());

    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('inv-1', 'Assayer left the panel this week.'));
  });
});

/**
 * The monthly bills round is about 1,200 assayers, a transaction and a notification each. Run inside
 * the request it outlived this client's 30 s: the screen said it failed while the server carried on
 * inviting, and the next press ran it again. The server now accepts the round and runs it on a
 * queue; this proves the screen follows the run it started — the server's own progress while it
 * runs, the same outcome summary when it is done, and the run's failure when it fails.
 */
describe('AssayerInvoicesTab — the monthly bills round runs on the server', () => {
  const running = { jobId: '41', state: 'running', progress: { percent: 50, stage: 'Inviting assayers (600/1200)' } };

  const startRound = async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /^Send bills$/ }));
    // The confirm dialog's own button carries the same words as the one that opened it.
    fireEvent.click((await screen.findAllByRole('button', { name: /^Send bills$/ })).at(-1)!);
  };

  beforeEach(() => {
    mockInviteAll.mockReset().mockResolvedValue({ jobId: '41', deduplicated: false });
    mockRequest.mockReset();
  });

  it('shows the server’s progress while the round runs, then the outcome it finished with', async () => {
    let finished = false;
    mockRequest.mockImplementation(async (path: string) => {
      if (path !== '/billing-engine/bulk-jobs/41') throw new Error(`unexpected request ${path}`);
      return finished
        ? {
          jobId: '41',
          state: 'done',
          progress: { percent: 100, stage: 'Complete' },
          result: {
            invited: 2,
            skipped: 2,
            outcomes: [
              { assayerId: 'as-1', outcome: 'invited', invoiceId: 'i-1', invoiceNumber: 'AINV-9', lineCount: 3 },
              { assayerId: 'as-2', outcome: 'invited', invoiceId: 'i-2', invoiceNumber: 'AINV-10', lineCount: 1 },
              { assayerId: 'as-3', outcome: 'skipped-active-invoice' },
              { assayerId: 'as-4', outcome: 'failed', error: 'database timed out' },
            ],
          },
        }
        : running;
    });

    await startRound();

    expect(await screen.findByText('Inviting assayers (600/1200)…')).toBeInTheDocument();
    // A second press while it runs would only join the same run; the button says it is busy instead.
    expect(screen.getByRole('button', { name: /Sending…/ })).toBeDisabled();
    expect(mockInviteAll).toHaveBeenCalledTimes(1);

    finished = true;
    // The outcome is a summary, not a toast line: the one assayer the round FAILED on is named
    // and set apart, instead of being counted into "skipped" as though somebody decided it.
    expect(await screen.findByText(/invited — each now sees their amounts/)).toBeInTheDocument();
    expect(screen.getByText(/skipped — they already hold an active bill/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed — a system error, not a decision about their work/)).toBeInTheDocument();
    expect(screen.getByText(/database timed out/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Inviting assayers (600/1200)…')).not.toBeInTheDocument());
  });

  it('reports the run’s own failure in the server’s words, not a generic one', async () => {
    mockRequest.mockResolvedValue({
      jobId: '41', state: 'failed', progress: { percent: 10, stage: 'Failed' },
      error: 'Assayer invoicing is not enabled on this deployment.',
    });

    await startRound();

    expect(await screen.findByText('Could not send the bills')).toBeInTheDocument();
    expect(screen.getByText(/Assayer invoicing is not enabled on this deployment/)).toBeInTheDocument();
  });
});
