import React from 'react';
import { render, screen } from '@testing-library/react';
import type { PayoutDestinationCheck } from '@fapoms/shared';
import { DestinationWarnings } from './DestinationWarnings';

/** Audit F2/F3 (2026-09-24): what the approve, HOD and pay screens say about where money goes. */
const check = (over: Partial<PayoutDestinationCheck> = {}): PayoutDestinationCheck => ({
  payableId: 'p-1', payableNumber: 'PY-1', assayerId: 'a-1', assayerName: 'Asha', assayerCode: 'AS-1',
  verified: true, sharedWithAnotherRecord: false, snapshotDiffersFromRecord: false,
  snapshotAccountTail: null, recordAccountTail: '******3210', warnings: [], blocking: null, ...over,
});

describe('DestinationWarnings', () => {
  it('says nothing when there is nothing to say', () => {
    const { container } = render(<DestinationWarnings checks={[check()]} />);
    expect(container.innerHTML).toBe('');
  });

  it('groups one sentence across payouts, naming them', () => {
    const w = 'Bank details are not verified.';
    render(<DestinationWarnings checks={[check({ warnings: [w] }), check({ payableId: 'p-2', payableNumber: 'PY-2', warnings: [w] })]} />);
    expect(screen.getAllByText(/Bank details are not verified/)).toHaveLength(1);
    expect(screen.getByText(/PY-1 \(Asha\), PY-2 \(Asha\)/)).toBeTruthy();
  });

  it('shows a refusal in the danger tone and a warning in the warning tone', () => {
    const refusal = "This bank account is on another assayer's record.";
    render(<DestinationWarnings checks={[check({ warnings: [refusal, 'Changed since approval.'], blocking: refusal })]} />);
    const alert = screen.getByTestId('destination-warnings');
    const [first, second] = Array.from(alert.children) as HTMLElement[];
    expect(first.getAttribute('style')).toContain('var(--danger)');
    expect(second.getAttribute('style')).toContain('var(--warning)');
  });
});
