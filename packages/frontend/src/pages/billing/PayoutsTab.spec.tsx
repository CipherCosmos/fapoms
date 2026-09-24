import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { APPROVE_WITHOUT_BILL_REASONS, InviteOutcomeSummary, isInviteEligible, PayoutsTab } from './PayoutsTab';
import { ToastProvider } from '../../components/ui';
import { api } from '../../services/api';
import { billingApi } from '../../services/billing';
import { AssayerPayableStatus } from '@fapoms/shared';
import type { PayoutRow } from '../../services/billing';
import type { AssayerInvoiceInviteAllResult } from '../../services/billing';

/**
 * The bulk invitation round's summary. What matters here is honesty about the one outcome that
 * is NOT a business decision: 'failed' means an infrastructure error stopped ONE assayer's
 * invite while the round carried on, so it must be listed name-by-name with the server's error
 * text and never folded into "skipped" — a desk that reads "5 skipped" when one of them was a
 * database timeout will never re-run the round for that assayer.
 */

// `PayoutsTab` transitively imports `services/api`, whose Vite-only `import.meta.env` ts-jest
// cannot parse. Stubbing it cuts the chain — nothing in this suite calls the API.
jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/billing', () => {
  const actual = jest.requireActual('../../services/billing');
  return {
    ...actual,
    billingApi: { ...actual.billingApi, listPayouts: jest.fn(), approvePayouts: jest.fn(), payPayouts: jest.fn() },
  };
});
// The tab also asks the Jobs tray for approve/pay runs it did not start (`useBackgroundJob`); no socket here.
jest.mock('../../services/socket', () => ({
  connectSocket: () => null,
  subscribeToConnection: (cb: (live: boolean) => void) => { cb(true); return () => undefined; },
}));
// The real poller, with a short interval so a test is not waiting 1.5 s per read.
jest.mock('../../services/queued-job', () => {
  const actual = jest.requireActual('../../services/queued-job');
  return {
    ...actual,
    waitForQueuedJob: jest.fn((path: string, opts: Record<string, unknown> = {}) =>
      actual.waitForQueuedJob(path, { ...opts, pollMs: 5 })),
  };
});

const result = (over: Partial<AssayerInvoiceInviteAllResult> = {}): AssayerInvoiceInviteAllResult => ({
  outcomes: [
    { assayerId: 'as-1', outcome: 'invited', invoiceId: 'i-1', invoiceNumber: 'AINV-1', lineCount: 4 },
    { assayerId: 'as-2', outcome: 'invited', invoiceId: 'i-2', invoiceNumber: 'AINV-2', lineCount: 1 },
    { assayerId: 'as-3', outcome: 'skipped-active-invoice' },
    { assayerId: 'as-4', outcome: 'nothing-eligible' },
    { assayerId: 'as-5', outcome: 'failed', error: 'database timed out' },
  ],
  invited: 2,
  skipped: 3,
  ...over,
});

const names: Record<string, string> = { 'as-5': 'Ravi Pillai' };
const nameOf = (id: string) => names[id] ?? `assayer ${id}`;

describe('InviteOutcomeSummary — grouped counts, failures listed distinctly', () => {
  it('groups the two expected refusals as counts and lists nobody for them', () => {
    render(<InviteOutcomeSummary result={result()} nameOf={nameOf} />);

    expect(screen.getByText(/invited — each now sees their amounts/)).toBeInTheDocument();
    expect(screen.getByText(/skipped — they already hold an active bill/)).toBeInTheDocument();
    expect(screen.getByText(/had nothing eligible left by their turn/)).toBeInTheDocument();
    // Refused-for-business-reasons assayers are counts, not a name-by-name list.
    expect(screen.queryByText(/assayer as-3/)).not.toBeInTheDocument();
    expect(screen.queryByText(/assayer as-4/)).not.toBeInTheDocument();
  });

  it('renders a failed outcome as a system error with the assayer named and the server text shown', () => {
    render(<InviteOutcomeSummary result={result()} nameOf={nameOf} />);

    // Named as what it is — a system error, explicitly NOT an invitation — with the error text.
    expect(screen.getByText(/1 failed — a system error, not a decision about their work/)).toBeInTheDocument();
    expect(screen.getByText('Ravi Pillai')).toBeInTheDocument();
    expect(screen.getByText(/database timed out/)).toBeInTheDocument();
  });

  it('shows no failure box when every outcome is a business outcome', () => {
    const clean = result({
      outcomes: [
        { assayerId: 'as-1', outcome: 'invited', invoiceId: 'i-1', invoiceNumber: 'AINV-1', lineCount: 4 },
        { assayerId: 'as-3', outcome: 'skipped-active-invoice' },
      ],
      invited: 1,
      skipped: 1,
    });
    render(<InviteOutcomeSummary result={clean} nameOf={nameOf} />);
    expect(screen.queryByText(/failed — a system error/)).not.toBeInTheDocument();
  });

  it('says plainly when there was nobody to invite', () => {
    render(<InviteOutcomeSummary result={{ outcomes: [], invited: 0, skipped: 0 }} nameOf={nameOf} />);
    expect(screen.getByText(/there was nobody to invite/)).toBeInTheDocument();
  });
});

/**
 * The client's mirror of the server's eligibility predicate — what enables a group's "Invite to
 * invoice" button. Kept in lockstep with `ASSAYER_INVOICE_ELIGIBLE_SQL` by assertion: due or
 * approved, not held, not already on an invoice, not pre-invoicing history.
 */
describe('isInviteEligible', () => {
  const row = (over: Partial<PayoutRow> = {}): PayoutRow => ({
    status: AssayerPayableStatus.PENDING,
    onHold: false,
    assayerInvoiceId: null,
    preInvoicingEra: false,
    ...over,
  } as PayoutRow);

  it('accepts due and approved rows that nothing disqualifies', () => {
    expect(isInviteEligible(row())).toBe(true);
    expect(isInviteEligible(row({ status: AssayerPayableStatus.APPROVED }))).toBe(true);
  });

  it('refuses held, invoiced, settled and pre-invoicing rows', () => {
    expect(isInviteEligible(row({ onHold: true }))).toBe(false);
    expect(isInviteEligible(row({ assayerInvoiceId: 'i-1' }))).toBe(false);
    expect(isInviteEligible(row({ preInvoicingEra: true }))).toBe(false);
    expect(isInviteEligible(row({ status: AssayerPayableStatus.PAID }))).toBe(false);
    expect(isInviteEligible(row({ status: AssayerPayableStatus.VOIDED }))).toBe(false);
  });
});

/**
 * Approve and Pay run on the server's queue. One transaction per payout inside the request outlived
 * this client's 30 s at realistic batch sizes: the screen said the approval failed while the server
 * kept approving, and a second press queued the same approvals again. The server now accepts the
 * batch and answers with a run to follow; these prove the tab follows the run it started — the
 * server's progress line while it runs, the SAME done/refused rendering when it finishes.
 */
describe('PayoutsTab — approve and pay follow the run the server accepted', () => {
  const mockList = billingApi.listPayouts as jest.Mock;
  const mockApprove = billingApi.approvePayouts as jest.Mock;
  const mockPay = billingApi.payPayouts as jest.Mock;
  const mockRequest = api.request as jest.Mock;

  const payout = (over: Partial<PayoutRow> = {}): PayoutRow => ({
    id: 'p-1', payableNumber: 'PAY-1', assayerId: 'as-1', assignmentId: 'a-1', expenseId: null,
    status: AssayerPayableStatus.PENDING, onHold: false, holdReason: null,
    baseAmount: 1500, travelAmount: 300, taxAmount: 0, tdsAmount: 0, totalAmount: 1800, paidAmount: 0, currency: 'INR',
    assayerName: 'Asha Menon', assayerCode: 'AS-01', clientName: 'SBI', projectName: 'Gold audit',
    assignmentNumber: 'ASG-1', branchName: 'Kochi', assayerInvoiceId: null, preInvoicingEra: false,
    createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  } as PayoutRow);

  /** Serves the run's poll: running until the test says the server has finished. */
  const serveRun = (jobId: string, stage: string, result: unknown) => {
    const run = { finished: false };
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/jobs?')) return { active: [], recent: [] };
      if (path !== `/billing-engine/bulk-jobs/${jobId}`) throw new Error(`unexpected request ${path}`);
      return run.finished
        ? { jobId, state: 'done', progress: { percent: 100, stage: 'Complete' }, result }
        : { jobId, state: 'running', progress: { percent: 50, stage } };
    });
    return run;
  };

  /**
   * `stage` decides which actions the tab offers, so each test renders the stage whose action it
   * is about: 'NOT_BILLED' is the only place a payout can be approved without the assayer having
   * confirmed a bill, and 'TO_PAY' is the only place one can be paid.
   */
  const renderTab = async (row: PayoutRow, stage: 'NOT_BILLED' | 'TO_PAY' = 'NOT_BILLED') => {
    mockList.mockResolvedValue({ items: [row], total: 1, page: 1, limit: 20 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <PayoutsTab stage={stage} onStage={jest.fn()} canAct />
          </ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText('ASG-1');
    // [0] ticks the assayer's group; [1] is the payout's own row.
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
  };

  /**
   * Walk the exception dialog: pick a reason, type the total, submit. Both are required — the
   * reason is written to the payout's history, and the typed total is what stops the whole thing
   * being done by reflex.
   */
  const approveWithoutBill = async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Approve without a bill \(1/ }));
    // `Select` is the app's own menu component, not a native <select>: open it, then pick.
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: APPROVE_WITHOUT_BILL_REASONS[0] }));
    fireEvent.change(screen.getByPlaceholderText('1800'), { target: { value: '1800' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve ₹1,800' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Approve ₹1,800' }));
  };

  beforeEach(() => {
    mockList.mockReset();
    mockApprove.mockReset().mockResolvedValue({ jobId: '8', deduplicated: false, backgroundJobId: 'row-8' });
    mockPay.mockReset().mockResolvedValue({ jobId: '9', deduplicated: false, backgroundJobId: 'row-9' });
    mockRequest.mockReset();
  });

  it('shows the approval run’s progress, then the refusals it finished with, in the server’s words', async () => {
    const run = serveRun('8', 'Approving payouts (1/2)', { done: [], refused: [{ id: 'p-1', reason: 'PAY-1 is on hold: Client dispute.' }] });
    await renderTab(payout());

    await approveWithoutBill();

    expect(await screen.findByText('Approving payouts (1/2)…')).toBeInTheDocument();
    // The reason travels with the ids: it lands on each payout's history row, which is the only
    // way an exception can be told from the rule six months later.
    expect(mockApprove).toHaveBeenCalledWith(['p-1'], APPROVE_WITHOUT_BILL_REASONS[0]);
    // While it runs, the button that started it cannot start it again.
    expect(screen.getByRole('button', { name: /^Approve without a bill \(1/ })).toBeDisabled();

    run.finished = true;
    expect(await screen.findByText('0 approved, 1 refused')).toBeInTheDocument();
    expect(screen.getByText('PAY-1 is on hold: Client dispute.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Approving payouts (1/2)…')).not.toBeInTheDocument());
  });

  it('pays through a queued run and reports what it paid', async () => {
    const run = serveRun('9', 'Paying payouts (1/2)', { done: [{ payableId: 'p-1', paymentId: 'pay-1' }], refused: [] });
    await renderTab(payout({ status: AssayerPayableStatus.APPROVED }), 'TO_PAY');

    fireEvent.click(screen.getByRole('button', { name: /^Record payment \(1/ }));
    fireEvent.change(await screen.findByPlaceholderText('Bank / UTR reference *'), { target: { value: 'UTR-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    expect((await screen.findAllByText('Paying payouts (1/2)…')).length).toBeGreaterThan(0);
    expect(mockPay).toHaveBeenCalledWith(expect.objectContaining({ payableIds: ['p-1'], paymentReference: 'UTR-1', method: 'NEFT' }));

    run.finished = true;
    expect(await screen.findByText('1 payout paid')).toBeInTheDocument();
  });

  /**
   * A payment pressed, then the page reloaded: the run is still going on the server. The tab must
   * say so and hold the Pay button — a second press under a new reference is how a batch gets
   * recorded as paid twice — and read the list again when the run finishes.
   */
  it('after a refresh, shows a pay run still going on the server and holds the Pay button', async () => {
    const running = {
      id: 'row-7', kind: 'BILLING_PAY_PAYOUTS', status: 'RUNNING', title: 'Pay 12 payouts (ref UTR-7)',
      progress: { processed: 3, total: 12, percent: 25, stage: 'Paying payouts (3/12)', message: null },
    };
    const server = { done: false };
    mockRequest.mockImplementation(async (path: string) => {
      if (path.includes('kind=BILLING_PAY_PAYOUTS') && !server.done) return { active: [running], recent: [] };
      if (path.startsWith('/jobs?')) return { active: [], recent: [] };
      throw new Error(`unexpected request ${path}`);
    });
    await renderTab(payout({ status: AssayerPayableStatus.APPROVED }), 'TO_PAY');

    expect(await screen.findByText(/Pay 12 payouts \(ref UTR-7\) is still running on the server \(Paying payouts \(3\/12\)\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Record payment \(1/ })).toBeDisabled();
    expect(mockPay).not.toHaveBeenCalled();
  });

  it('says a run that failed on the server failed, with the server’s reason', async () => {
    mockRequest.mockImplementation(async (path: string) => (path.startsWith('/jobs?')
      ? { active: [], recent: [] }
      : { jobId: '8', state: 'failed', progress: { percent: 0, stage: 'Failed' }, error: 'The database was unavailable.' }));
    await renderTab(payout());

    await approveWithoutBill();

    expect(await screen.findByText('Approval failed')).toBeInTheDocument();
    expect(screen.getByText(/The database was unavailable/)).toBeInTheDocument();
  });
});
