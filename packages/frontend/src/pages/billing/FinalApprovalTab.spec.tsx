import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemRole, type FinalApprovalItem, type FinalApprovalQueue } from '@fapoms/shared';
import { FinalApprovalTab } from './FinalApprovalTab';
import { JOBS, jobFromParam } from './vocabulary';
import { ToastProvider } from '../../components/ui';
import { billingApi } from '../../services/billing';
import { canGiveFinalBillingApproval } from '../../hooks/useCurrentRoles';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/billing', () => {
  const actual = jest.requireActual('../../services/billing');
  return {
    ...actual,
    billingApi: {
      ...actual.billingApi,
      getFinalApprovalQueue: jest.fn(),
      finalApprove: jest.fn(),
      finalReject: jest.fn(),
      finalApproveMany: jest.fn(),
      followBulkJob: jest.fn(),
    },
  };
});
jest.mock('../../services/socket', () => ({
  connectSocket: () => null,
  subscribeToConnection: (cb: (live: boolean) => void) => { cb(true); return () => undefined; },
}));

/**
 * THE HOD'S QUEUE (2026-09-24): everything the office approved that waits for the final approval.
 * The HOD approves (one row, or the ticked rows as one queued run) or sends back with a reason the
 * office can act on. Only whoever holds the final billing approval gets the tab.
 */
const item = (over: Partial<FinalApprovalItem> = {}): FinalApprovalItem => ({
  kind: 'ASSAYER_BILL', id: 'ainv-1', number: 'AINV-1', payeeName: 'Asha Menon', payeeCode: 'AS-01',
  amount: 5400, currency: 'INR', lineCount: 3, officeApprovedBy: 'office-1', officeApprovedByName: 'Priya Menon',
  officeApprovedAt: '2026-09-20T10:00:00.000Z', officeNote: null, assignmentNumber: null, lastRejectReason: null,
  ...over,
});
const queueOf = (items: FinalApprovalItem[]): FinalApprovalQueue => ({
  items,
  counts: {
    ASSAYER_BILL: items.filter((i) => i.kind === 'ASSAYER_BILL').length,
    DIRECT_PAYOUT: items.filter((i) => i.kind === 'DIRECT_PAYOUT').length,
    EXPENSE_REIMBURSEMENT: items.filter((i) => i.kind === 'EXPENSE_REIMBURSEMENT').length,
    CLIENT_INVOICE: items.filter((i) => i.kind === 'CLIENT_INVOICE').length,
  },
  total: items.length,
  truncated: false,
});

const ITEMS = [
  item(),
  item({ kind: 'DIRECT_PAYOUT', id: 'p-1', number: 'PY-1', amount: 1800, lineCount: 1, assignmentNumber: 'ASN-7', officeNote: 'Assayer has left; settling final dues' }),
  item({ kind: 'CLIENT_INVOICE', id: 'inv-1', number: 'INV-1', payeeName: 'SBI', payeeCode: null, amount: 12000, lastRejectReason: 'Wrong GSTIN on the client' }),
];

const draw = async (items = ITEMS) => {
  (billingApi.getFinalApprovalQueue as jest.Mock).mockResolvedValue(queueOf(items));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider><FinalApprovalTab /></ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await screen.findByText('AINV-1');
};

const rowOf = (number: string) => screen.getByText(number).closest('tr') as HTMLElement;

describe('FinalApprovalTab — the HOD’s queue', () => {
  beforeEach(() => jest.clearAllMocks());

  /** Audit F2/F3 (2026-09-24): the HOD sees what the office saw about where the money goes. */
  it('shows a row\'s bank-account warnings, and a refusal-to-come in the danger tone', async () => {
    await draw([
      item({ warnings: ['Bank details are not verified — there is no verified bank passbook and no verified identity document on file. The money will go to the account typed on the record.'] }),
      item({ kind: 'DIRECT_PAYOUT', id: 'p-9', number: 'PY-9', lineCount: 1, warnings: ["This bank account (the same account number and IFSC) is on another assayer's record. Payment to it is refused until one of the two records is corrected."] }),
      item({ kind: 'CLIENT_INVOICE', id: 'inv-9', number: 'INV/26-27/000001', payeeCode: null }),
    ]);
    expect(within(rowOf('AINV-1')).getByText(/Bank details are not verified/)).toBeTruthy();
    const shared = within(rowOf('PY-9')).getByText(/on another assayer's record/);
    expect(shared.closest('div')?.getAttribute('style')).toMatch(/var\(--danger\)/);
    expect(within(rowOf('INV/26-27/000001')).queryByTestId('destination-warnings')).toBeNull();
  });

  it('lists each item with what it is, who is paid, the amount and who approved it at the office', async () => {
    await draw();
    const bill = rowOf('AINV-1');
    expect(within(bill).getByText('Assayer bill')).toBeInTheDocument();
    expect(within(bill).getByText('Asha Menon')).toBeInTheDocument();
    expect(within(bill).getByText('Priya Menon')).toBeInTheDocument();
    expect(within(rowOf('PY-1')).getByText('Payout approved without a bill')).toBeInTheDocument();
    expect(within(rowOf('PY-1')).getByText('Assayer has left; settling final dues')).toBeInTheDocument();
    expect(within(rowOf('INV-1')).getByText(/Sent back before: Wrong GSTIN/)).toBeInTheDocument();
  });

  it('filters by kind, with counts', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /^Client invoice/ }));
    expect(screen.queryByText('AINV-1')).not.toBeInTheDocument();
    expect(screen.getByText('INV-1')).toBeInTheDocument();
  });

  it('approves one item after the confirmation, naming it by kind and id', async () => {
    (billingApi.finalApprove as jest.Mock).mockResolvedValue({});
    await draw();
    fireEvent.click(within(rowOf('PY-1')).getByRole('button', { name: /Approve/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve ₹1,800' }));
    await waitFor(() => expect(billingApi.finalApprove).toHaveBeenCalledWith({ kind: 'DIRECT_PAYOUT', id: 'p-1' }));
    expect(await screen.findByText('PY-1 approved')).toBeInTheDocument();
  });

  it('shows the server’s refusal in its own words (e.g. the office approver cannot also approve)', async () => {
    const { AppError } = jest.requireActual('../../services/errors');
    (billingApi.finalApprove as jest.Mock).mockRejectedValue(
      new AppError('Segregation of duties: the same account cannot approve assayer bill AINV-1 at the office and also give it the final approval.', undefined, 409),
    );
    await draw();
    fireEvent.click(within(rowOf('AINV-1')).getByRole('button', { name: /Approve/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve ₹5,400' }));
    expect(await screen.findByText(/Segregation of duties/)).toBeInTheDocument();
  });

  it('sends back only with a reason the office can act on', async () => {
    (billingApi.finalReject as jest.Mock).mockResolvedValue({});
    await draw();
    fireEvent.click(within(rowOf('INV-1')).getByRole('button', { name: /Send back/ }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Send back' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for sending it back'), { target: { value: 'no' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for sending it back'), { target: { value: 'The PO number is missing from the invoice.' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(billingApi.finalReject).toHaveBeenCalledWith(
      { kind: 'CLIENT_INVOICE', id: 'inv-1' }, 'The PO number is missing from the invoice.',
    ));
  });

  it('bulk-approves the ticked items as one queued run and reports what was refused', async () => {
    (billingApi.finalApproveMany as jest.Mock).mockResolvedValue({ jobId: '5', deduplicated: false, backgroundJobId: 'row-5' });
    (billingApi.followBulkJob as jest.Mock).mockResolvedValue({
      done: [{ kind: 'ASSAYER_BILL', id: 'ainv-1' }],
      refused: [{ kind: 'DIRECT_PAYOUT', id: 'p-1', reason: 'PY-1 is on hold: PAN mismatch.' }],
    });
    await draw();
    fireEvent.click(within(rowOf('AINV-1')).getByRole('checkbox'));
    fireEvent.click(within(rowOf('PY-1')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /^Approve 2 · ₹7,200/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^Approve 2 · ₹7,200$/ }));
    await waitFor(() => expect(billingApi.finalApproveMany).toHaveBeenCalledWith([
      { kind: 'ASSAYER_BILL', id: 'ainv-1' }, { kind: 'DIRECT_PAYOUT', id: 'p-1' },
    ]));
    expect(await screen.findByText('1 approved, 1 refused')).toBeInTheDocument();
    expect(screen.getByText('PY-1 is on hold: PAN mismatch.')).toBeInTheDocument();
  });

  it('says so when nothing is waiting', async () => {
    (billingApi.getFinalApprovalQueue as jest.Mock).mockResolvedValue(queueOf([]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(<MemoryRouter><QueryClientProvider client={client}><ToastProvider><FinalApprovalTab /></ToastProvider></QueryClientProvider></MemoryRouter>);
    expect(await screen.findByText('Nothing is waiting for your final approval.')).toBeInTheDocument();
  });
});

describe('who gets the Final approval tab', () => {
  it('Admin, Developer (through Admin), and a custom HOD role holding the permission — never the office', () => {
    expect(canGiveFinalBillingApproval([SystemRole.ADMIN], [])).toBe(true);
    expect(canGiveFinalBillingApproval([SystemRole.DEVELOPER], [])).toBe(true);
    expect(canGiveFinalBillingApproval(['HOD' as SystemRole], ['BILLING:FINAL_APPROVE:ORGANIZATION', 'BILLING:VIEW:ORGANIZATION'])).toBe(true);
    expect(canGiveFinalBillingApproval([SystemRole.OPERATIONS], ['BILLING:APPROVE:ORGANIZATION', 'BILLING:VIEW:ORGANIZATION'])).toBe(false);
    expect(canGiveFinalBillingApproval([SystemRole.AUDITOR], ['BILLING:VIEW:ORGANIZATION'])).toBe(false);
  });

  it('is a Billing job reachable by ?tab=final', () => {
    expect(JOBS.map((j) => j.key)).toContain('final');
    expect(jobFromParam('final')).toBe('final');
  });
});
