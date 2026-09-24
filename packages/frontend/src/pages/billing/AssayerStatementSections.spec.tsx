import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatementBody } from './AssayerStatementSections';
import type { AssayerStatement } from '../../services/billing';

jest.mock('../../services/api', () => ({ api: { request: jest.fn(async () => ({ items: [], total: 0, page: 1, limit: 20 })) } }));

/**
 * 2026-09-24 audit: the statement carried the whole decrypted PAN and this line printed it. The
 * server now sends the last four (nothing to an auditor) and the page says which it is showing.
 */
const statement = (over: Partial<AssayerStatement> = {}): AssayerStatement => ({
  assayerId: 'a-1', assayerName: 'Asha', assayerCode: 'AS-1', pan: '******234F', panMasked: true, panOnFile: true,
  tdsSection: '194J',
  totals: { earned: 0, paid: 0, outstanding: 0, awaitingApproval: 0, onHoldOrDisputed: 0, tdsWithheld: 0, payableCount: 0 },
  payables: [], payments: [], ...over,
} as AssayerStatement);

const draw = (data: AssayerStatement) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <StatementBody data={data} />
  </QueryClientProvider>,
);

describe('the statement header never shows a whole PAN', () => {
  it('shows the last four and says so', () => {
    draw(statement());
    expect(screen.getByText('******234F (last 4 only)')).toBeTruthy();
  });

  it('for an auditor, says only that one is on file', () => {
    draw(statement({ pan: null, panOnFile: true }));
    expect(screen.getByText('on file')).toBeTruthy();
  });

  it('still says when there is none', () => {
    draw(statement({ pan: null, panOnFile: false }));
    expect(screen.getByText('not on file')).toBeTruthy();
  });
});

/**
 * 2026-09-24 contract audit (E3): an office-approved payout still waiting on the HOD read as a
 * bare "Approved" here, while the pay screen said it could not be paid yet.
 */
describe('a payout waiting for the HOD says so on the statement', () => {
  const row = (hodApproved: boolean) => ({
    id: 'p-1', payableNumber: 'PAY-1', status: 'APPROVED', onHold: false, holdReason: null,
    assignmentId: 'as-1', expenseId: null, baseAmount: 1000, travelAmount: 0, tdsAmount: 0,
    totalAmount: 1000, paidAmount: 0, outstanding: 1000, createdAt: '2026-09-20T00:00:00Z',
    invoiceNumber: null, invoiceStatus: null, hodApproved,
  });

  it('office-approved only: "Waiting for HOD approval"', () => {
    draw(statement({ payables: [row(false)] as AssayerStatement['payables'] }));
    expect(screen.getByText('Waiting for HOD approval')).toBeTruthy();
  });

  it('HOD-approved: "Ready to pay"', () => {
    draw(statement({ payables: [row(true)] as AssayerStatement['payables'] }));
    expect(screen.getByText('Ready to pay')).toBeTruthy();
  });
});
