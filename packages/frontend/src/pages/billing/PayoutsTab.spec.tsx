import React from 'react';
import { render, screen } from '@testing-library/react';
import { InviteOutcomeSummary, isInviteEligible } from './PayoutsTab';
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
    expect(screen.getByText(/skipped — they already hold an active invoice/)).toBeInTheDocument();
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
