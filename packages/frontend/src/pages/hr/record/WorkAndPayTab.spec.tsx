import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { WorkAndPayTab, payForAssignment } from './WorkAndPayTab';
import { AssayerRecord } from '../AssayerRecord';
import { api } from '../../../services/api';
import { AppError } from '../../../services/errors';

/**
 * The record's "Work & pay" tab: what the person has on, what they finished, and what each
 * finished job paid them — three existing reads joined on the assignment id.
 *
 * Every assertion about pay waits on text that only the STATEMENT can produce (a payout stage, a
 * figure), never on the work list alone: the lists and the statement are separate requests, and
 * asserting on the second while waiting for the first is this repo's known flake.
 */

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../../services/socket', () => ({ connectSocket: () => null }));
jest.mock('../../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../../hooks/useCurrentRoles'),
  useCurrentRoles: () => ['ADMIN'],
}));

const mockRequest = api.request as jest.Mock;

const branch = (name: string, city: string) => ({ branch: { name, city } });

const upcoming = {
  id: 'asn-up', assignmentNumber: 'ASN-UP-1', status: 'ACCEPTED', scheduledDate: '2026-09-30',
  agreedFee: '1800', projectBranch: branch('Kochi Main', 'Kochi'), project: { name: 'SBI Gold Audit' },
};
/** Settled recently, so `scope=active` returns it too — it must show under Completed only. */
const recentDone = {
  id: 'asn-recent', assignmentNumber: 'ASN-RECENT', status: 'COMPLETED', scheduledDate: '2026-09-10',
  completionDate: '2026-09-11', agreedFee: '1500', projectBranch: branch('Aluva', 'Aluva'), project: { name: 'SBI Gold Audit' },
};
const doneBilled = { ...recentDone };
const doneHeld = {
  id: 'asn-held', assignmentNumber: 'ASN-HELD', status: 'COMPLETED', completionDate: '2026-09-02',
  agreedFee: '1200', projectBranch: branch('Thrissur', 'Thrissur'), project: { name: 'Canara Audit' },
};
const doneUnbilled = {
  id: 'asn-unbilled', assignmentNumber: 'ASN-UNBILLED', status: 'COMPLETED', completionDate: '2026-08-20',
  agreedFee: '900', projectBranch: branch('Kottayam', 'Kottayam'), project: { name: 'Canara Audit' },
};
const olderDone = {
  id: 'asn-old', assignmentNumber: 'ASN-OLD', status: 'COMPLETED', completionDate: '2026-05-01',
  agreedFee: '700', projectBranch: branch('Palakkad', 'Palakkad'), project: { name: 'Old Project' },
};

const payable = (over: Record<string, unknown>) => ({
  id: `p-${String(over.assignmentId)}`, payableNumber: `PAY-${String(over.assignmentId)}`, status: 'PENDING',
  onHold: false, holdReason: null, expenseId: null, baseAmount: 0, travelAmount: 0, tdsAmount: 0,
  totalAmount: 0, paidAmount: 0, outstanding: 0, createdAt: '2026-09-11T00:00:00.000Z',
  invoiceNumber: null, invoiceStatus: null, ...over,
});

const statement = {
  assayerId: 'a-1', assayerName: 'Person One', assayerCode: 'AS0001', pan: null, tdsSection: '194J',
  totals: { earned: 2700, paid: 1000, outstanding: 1700, awaitingApproval: 0, onHoldOrDisputed: 1200, tdsWithheld: 0, payableCount: 2 },
  payables: [
    payable({ assignmentId: 'asn-recent', totalAmount: 1500, paidAmount: 1000, outstanding: 500, invoiceNumber: 'AINV-7', invoiceStatus: 'INVITED' }),
    payable({ assignmentId: 'asn-held', status: 'APPROVED', onHold: true, holdReason: 'Report missing', totalAmount: 1200, outstanding: 1200 }),
  ],
  payments: [
    { id: 'pm-1', paymentReference: 'UTR-555', method: 'NEFT', amount: 1000, paidDate: '2026-09-15', balanceAfter: 1700, notes: null },
  ],
};

const REFUSED = new AppError('You do not have permission to perform this action.', 'Forbidden', 403, 'permission-required');

interface Serve {
  statement?: unknown;
  historyPages?: Array<{ items: unknown[]; meta: { hasMore: boolean; nextCursor: string | null } }>;
}

const serve = ({ statement: stmt = statement, historyPages }: Serve = {}) => {
  const pages = historyPages ?? [{ items: [doneBilled, doneHeld, doneUnbilled], meta: { hasMore: false, nextCursor: null } }];
  mockRequest.mockImplementation((url: string) => {
    if (url.startsWith('/assignments/assayer/a-1?scope=active')) {
      return Promise.resolve({ success: true, items: [upcoming, recentDone], meta: { hasMore: false, nextCursor: null } });
    }
    if (url.startsWith('/assignments/assayer/a-1?scope=history')) {
      const cursor = new URLSearchParams(url.split('?')[1]).get('before');
      const page = cursor ? pages[Number(cursor.replace('cur-', ''))] : pages[0];
      return Promise.resolve({ success: true, ...page });
    }
    if (url === '/billing-engine/assayers/a-1/statement') {
      return stmt instanceof Error ? Promise.reject(stmt) : Promise.resolve(stmt);
    }
    if (url.startsWith('/billing-engine/assayer-invoices')) return Promise.resolve({ items: [], hasMore: false });
    return Promise.reject(new Error(`unexpected request: ${url}`));
  });
};

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

const renderTab = () => render(
  <QueryClientProvider client={client()}>
    <MemoryRouter>
      <WorkAndPayTab assayerId="a-1" />
    </MemoryRouter>
  </QueryClientProvider>,
);

/** The row in a section whose assignment number is `number`. */
const rowOf = (sectionId: string, number: string) =>
  within(screen.getByTestId(sectionId)).getByText(number).closest('tr') as HTMLElement;

beforeEach(() => mockRequest.mockReset());

describe('Work & pay', () => {
  it('lists booked work under Coming up and finished work under Completed — settled work never in both', async () => {
    serve();
    renderTab();

    const inFlight = await screen.findByTestId('work-in-flight');
    await within(inFlight).findByText('ASN-UP-1');
    expect(within(inFlight).getByText('Accepted')).toBeInTheDocument();
    expect(within(inFlight).getByText('SBI Gold Audit')).toBeInTheDocument();
    expect(within(inFlight).getByText('₹1,800')).toBeInTheDocument();
    expect(within(inFlight).getByText('ASN-UP-1').closest('a')).toHaveAttribute('href', '/assignments?id=asn-up');
    // `scope=active` also returned the recently completed job; it belongs below only.
    expect(within(inFlight).queryByText('ASN-RECENT')).not.toBeInTheDocument();

    const history = screen.getByTestId('work-history');
    await within(history).findByText('ASN-RECENT');
    expect(within(history).getByText('ASN-HELD')).toBeInTheDocument();
    expect(within(history).queryByText('ASN-UP-1')).not.toBeInTheDocument();

    const headline = screen.getByTestId('work-headline');
    await waitFor(() => expect(within(headline).getByText('Completed').previousSibling).toHaveTextContent('3'));
    expect(within(headline).getByText('In progress').previousSibling).toHaveTextContent('1');
  });

  it('puts each completed job next to its own pay, joined by assignment id, in the pay screen’s stage words', async () => {
    serve();
    renderTab();

    // Waits on text only the statement can produce.
    await screen.findByText('With the assayer');
    const billed = rowOf('work-history', 'ASN-RECENT');
    // Date, Assignment, Branch, Project, Status, Fee | Earned, Paid, Still owed, Payout stage
    const cells = within(billed).getAllByRole('cell').map((c) => c.textContent);
    expect(cells.slice(5)).toEqual(['₹1,500', '₹1,500', '₹1,000', '₹500', 'With the assayer']);

    const held = rowOf('work-history', 'ASN-HELD');
    expect(within(held).getAllByRole('cell').map((c) => c.textContent).slice(6))
      .toEqual(['₹1,200', '₹0', '₹1,200', 'On hold: Report missing']);

    // The money section reuses the statement's parts: totals and the payments made.
    const money = screen.getByTestId('work-money');
    expect(within(money).getByText('UTR-555')).toBeInTheDocument();
    expect(within(money).getByText('Still owed')).toBeInTheDocument();
  });

  it('says "Not billed yet" for a completed job no payout exists for', async () => {
    serve();
    renderTab();

    await screen.findByText('With the assayer');
    const unbilled = rowOf('work-history', 'ASN-UNBILLED');
    expect(within(unbilled).getByText('Not billed yet')).toBeInTheDocument();
    expect(within(unbilled).queryByText('₹0')).not.toBeInTheDocument();
  });

  it('pages older work with the cursor the last page handed back', async () => {
    serve({
      historyPages: [
        { items: [doneBilled], meta: { hasMore: true, nextCursor: 'cur-1' } },
        { items: [olderDone], meta: { hasMore: false, nextCursor: null } },
      ],
    });
    renderTab();

    await screen.findByText('ASN-RECENT', { selector: 'a' });
    const headline = screen.getByTestId('work-headline');
    await waitFor(() => expect(within(headline).getByText('Completed').previousSibling).toHaveTextContent('1+'));
    expect(screen.queryByText('ASN-OLD')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));

    await screen.findByText('ASN-OLD');
    expect(mockRequest).toHaveBeenCalledWith('/assignments/assayer/a-1?scope=history&limit=50&before=cur-1');
    expect(screen.getByText('ASN-RECENT', { selector: 'a' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    await waitFor(() => expect(within(headline).getByText('Completed').previousSibling).toHaveTextContent(/^2$/));
  });

  it('a refused statement drops the pay, says why once, and never shows ₹0', async () => {
    serve({ statement: REFUSED });
    renderTab();

    await screen.findByText('Pay details need billing access.');
    // The work still shows.
    await screen.findByText('ASN-HELD');
    expect(screen.getByText('ASN-UP-1')).toBeInTheDocument();
    // No money anywhere: no zero, no pay columns, no money section, no money tiles.
    expect(screen.queryByText(/₹0/)).not.toBeInTheDocument();
    expect(screen.queryByText('Not billed yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Payout stage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('work-money')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('work-headline')).queryByText('Earned')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('work-headline')).queryByText('Still owed')).not.toBeInTheDocument();
  });
});

describe('payForAssignment', () => {
  it('sums the fee and its reimbursements, leaves a voided payout out, and names the fee’s stage', () => {
    const line = payForAssignment([
      payable({ assignmentId: 'x', status: 'PAID', totalAmount: 1000, paidAmount: 1000, outstanding: 0 }),
      payable({ assignmentId: 'x', id: 'r', expenseId: 'e-1', status: 'APPROVED', totalAmount: 200, outstanding: 200 }),
      payable({ assignmentId: 'x', id: 'v', expenseId: 'e-2', status: 'VOIDED', totalAmount: 999, outstanding: 999 }),
    ] as any);
    expect(line).toEqual({ earned: 1200, paid: 1000, owed: 200, stage: 'Paid' });
  });

  it('is null when nothing was billed', () => {
    expect(payForAssignment([])).toBeNull();
  });
});

describe('?tab=work on the record', () => {
  it('opens the Work & pay tab', async () => {
    serve();
    const base = mockRequest.getMockImplementation()!;
    mockRequest.mockImplementation((url: string) => {
      if (url === '/assayers/a-1') {
        return Promise.resolve({
          id: 'a-1', assayerCode: 'AS0001', displayName: 'Person One', lifecycleStatus: 'ACTIVE', managerId: null,
        });
      }
      if (url.includes('/dossier')) return Promise.resolve({ empanelments: [], currentCheck: null });
      if (url.includes('/photo')) return Promise.reject(new Error('no photograph'));
      if (url.includes('/payables') || url.includes('/activity') || url.includes('/workforce-attribute')) return Promise.resolve([]);
      return base(url);
    });

    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={['/hr/roster/a-1?tab=work']}>
          <AssayerRecord assayerId="a-1" canManage onClose={() => {}} onChanged={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByTestId('work-in-flight');
    await screen.findByText('With the assayer');
    expect(screen.getByRole('button', { name: /Work & pay/ })).toBeInTheDocument();
  });
});
