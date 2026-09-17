import React from 'react';
import { render, screen } from '@testing-library/react';
import { EmpanelmentStatus } from '@fapoms/shared';

// The shared label map and hard-block set live in the Vetting tab module, which reaches the API
// client (and through it `import.meta`) on import.
jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../../services/socket', () => ({ connectSocket: () => null, disconnectSocket: () => null }));

import { EmpanelmentStandingCard, isHardBlockedStanding } from './EmpanelmentStandingCard';
import { HARD_BLOCKED_STANDINGS } from '../AssayerVettingTab';

/**
 * The record's client-bank card, read the way an HR clerk reads it.
 *
 * It printed the raw enum — `DOCUMENTS_PENDING` — while every other screen about the same person
 * said "Documents pending", and it explained a final decision in the language of a policy manual.
 * The words now come from the one label map, and the hard-block rule from the one set.
 */

const row = (status: string, id = status.toLowerCase(), name = 'State Bank') => ({
  id: `emp-${id}`,
  assayerId: 'a-1',
  clientId: `c-${id}`,
  status,
  statusReason: null,
  client: { id: `c-${id}`, name },
});

describe('EmpanelmentStandingCard — standing words', () => {
  it('says "Documents pending", never DOCUMENTS_PENDING', () => {
    render(<EmpanelmentStandingCard empanelments={[row(EmpanelmentStatus.DOCUMENTS_PENDING)]} />);

    expect(screen.getByTestId('empanelment-badge-c-documents_pending')).toHaveTextContent('Documents pending');
    expect(screen.queryByText(/DOCUMENTS_PENDING/)).not.toBeInTheDocument();
  });

  it('uses the shared label for every standing that has one', () => {
    render(<EmpanelmentStandingCard empanelments={[row(EmpanelmentStatus.INACTIVE)]} />);
    expect(screen.getByText('Empanelled before, dormant now')).toBeInTheDocument();
  });

  it('writes a standing with no label in plain words rather than as a code', () => {
    render(<EmpanelmentStandingCard empanelments={[row('SUSPENDED')]} />);
    expect(screen.getByTestId('empanelment-badge-c-suspended')).toHaveTextContent('Suspended');
    expect(screen.queryByText('SUSPENDED')).not.toBeInTheDocument();
  });
});

describe('EmpanelmentStandingCard — a bank’s final decision', () => {
  it('reads the hard-block rule from the one shared set', () => {
    for (const s of ['REJECTED', 'TERMINATED', 'EXPIRED', 'SUSPENDED']) {
      expect(HARD_BLOCKED_STANDINGS.has(s)).toBe(true);
      expect(isHardBlockedStanding(s)).toBe(true);
    }
    expect(isHardBlockedStanding(EmpanelmentStatus.ACTIVE)).toBe(false);
    expect(isHardBlockedStanding(null)).toBe(false);
  });

  it('marks it "Final" in plain words, with no way to change it', () => {
    const onEditStanding = jest.fn();
    render(
      <EmpanelmentStandingCard
        empanelments={[row(EmpanelmentStatus.REJECTED, 'r', 'Axis Bank'), row(EmpanelmentStatus.ACTIVE, 'a', 'HDFC Bank')]}
        canManage
        onEditStanding={onEditStanding}
      />,
    );

    expect(screen.getByTestId('hard-block-indicator-c-r')).toHaveTextContent('Final');
    expect(screen.queryByTestId('edit-standing-btn-c-r')).not.toBeInTheDocument();
    // The bank that has not closed the door can still be updated.
    expect(screen.getByTestId('edit-standing-btn-c-a')).toBeInTheDocument();

    expect(screen.getByTestId('hard-block-explanation'))
      .toHaveTextContent('Axis Bank’s decision is final. Nobody here can change it.');
    expect(screen.queryByText(/Non-overridable|hard-blocked by policy|supervisor bypass/i)).not.toBeInTheDocument();
  });

  it('speaks of several banks when more than one has decided', () => {
    render(
      <EmpanelmentStandingCard
        empanelments={[row(EmpanelmentStatus.REJECTED, 'r'), row(EmpanelmentStatus.TERMINATED, 't')]}
      />,
    );
    expect(screen.getByTestId('hard-block-explanation'))
      .toHaveTextContent('These banks’ decisions are final. Nobody here can change them.');
  });

  it('says nothing about final decisions when no bank has made one', () => {
    render(<EmpanelmentStandingCard empanelments={[row(EmpanelmentStatus.ACTIVE)]} />);
    expect(screen.queryByTestId('hard-block-explanation')).not.toBeInTheDocument();
  });
});
