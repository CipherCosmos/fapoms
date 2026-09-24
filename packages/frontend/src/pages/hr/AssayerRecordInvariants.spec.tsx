import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { AssayerLifecycleStatus } from '@fapoms/shared';
import { AssayerRecord } from './AssayerRecord';
import { api } from '../../services/api';
import { EmpanelmentStandingCard } from './record/EmpanelmentStandingCard';
import { DeploymentReadinessCard } from './record/DeploymentReadinessCard';
import { BankProfileCard } from './record/BankProfileCard';
import { FrozenPayoutDestinationCard } from './record/FrozenPayoutDestinationCard';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
}));
jest.mock('../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../hooks/useCurrentRoles'),
  useCurrentRoles: () => ['ADMIN'],
  canManageAssayers: () => true,
  canDeleteAssayers: () => true,
}));

const mockRequest = api.request as jest.Mock;

const baseAssayer = (over: Record<string, any> = {}) => ({
  id: 'a-1',
  assayerCode: 'AS0001',
  displayName: 'Person One',
  phone: '+919000000000',
  email: 'p1@example.com',
  city: 'Kochi',
  state: 'Kerala',
  lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
  panNumber: 'ABCDE1234F',
  bankAccountNumber: '000111222333',
  ifscCode: 'HDFC0000001',
  bankName: 'HDFC Bank',
  ...over,
});

describe('Monolith 3 Invariants Regression Suite', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  describe('1. Absolute Empanelment Hard-Block Invariant', () => {
    const hardBlockedStatuses = ['REJECTED', 'TERMINATED', 'EXPIRED', 'SUSPENDED'];

    hardBlockedStatuses.forEach((status) => {
      it(`prohibits any override affordance for hard-blocked ${status} standing`, () => {
        const empanelments = [
          {
            id: `emp-${status.toLowerCase()}`,
            status,
            statusReason: 'Policy violation or standing revocation',
            client: { id: 'c-1', name: 'State Bank' },
          },
        ];

        render(
          <EmpanelmentStandingCard
            empanelments={empanelments}
            onManageVetting={jest.fn()}
          />,
        );

        // Plain words, never the stored code.
        expect(screen.getByText(new RegExp(`^${status}$`, "i"))).toBeInTheDocument();
        expect(screen.queryByText(status)).not.toBeInTheDocument();
        // Explanation must be visible explaining why it cannot be overridden
        expect(screen.getByTestId('hard-block-explanation')).toBeInTheDocument();
        expect(screen.getByText(/decision is final/i)).toBeInTheDocument();

        // Must NOT have any override or edit button
        expect(screen.queryByRole('button', { name: /Override/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Change/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Assign anyway/i })).not.toBeInTheDocument();
      });
    });

    it('does not imply global block when only one client relationship is restricted', () => {
      const empanelments = [
        {
          id: 'emp-1',
          status: 'REJECTED',
          statusReason: 'Branch ban',
          client: { id: 'c-1', name: 'Axis Bank' },
        },
        {
          id: 'emp-2',
          status: 'ACTIVE',
          statusReason: null,
          client: { id: 'c-2', name: 'HDFC Bank' },
        },
      ];

      render(
        <EmpanelmentStandingCard
          empanelments={empanelments}
          onManageVetting={jest.fn()}
        />,
      );

      // Both standings are independently visible
      expect(screen.getByText('Axis Bank')).toBeInTheDocument();
      expect(screen.getByText('Rejected')).toBeInTheDocument();
      expect(screen.getByText('HDFC Bank')).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
  });

  describe('2. Backend-Authoritative Deployment Readiness', () => {
    it('shows assayer as BLOCKED when backend reports blocked, even if lifecycleStatus is ACTIVE', () => {
      const activeAssayer = baseAssayer({ lifecycleStatus: AssayerLifecycleStatus.ACTIVE });
      const dossierWithBackendBlock = {
        deployable: false,
        deploymentBlockers: [
          'Mandatory CIBIL credit score below policy minimum (580 < 650)',
          'Annual police clearance certificate expired',
        ],
      };

      render(
        <DeploymentReadinessCard
          assayer={activeAssayer}
          dossier={dossierWithBackendBlock as any}
        />,
      );

      // Must display blocked verdict
      expect(screen.getByTestId('deployment-readiness-card')).toBeInTheDocument();
      expect(screen.getByText('Not yet')).toBeInTheDocument();
      // Must display the authoritative blocker reasons provided by backend
      expect(screen.getByText(/Mandatory CIBIL credit score below policy minimum/)).toBeInTheDocument();
      expect(screen.getByText(/Annual police clearance certificate expired/)).toBeInTheDocument();
    });

    it('does not infer deployability from ACTIVE alone if onboarding documents are incomplete', () => {
      const activeAssayer = baseAssayer({ lifecycleStatus: AssayerLifecycleStatus.ACTIVE });
      const dossierIncomplete = {
        deployable: false,
        deploymentBlockers: ['Missing identity gate document: PAN Card'],
      };

      render(
        <DeploymentReadinessCard
          assayer={activeAssayer}
          dossier={dossierIncomplete as any}
        />,
      );

      expect(screen.getByText('Not yet')).toBeInTheDocument();
      expect(screen.getByText(/Missing identity gate document: PAN Card/)).toBeInTheDocument();
    });
  });

  describe('3. Payments & Banking Separation Invariants', () => {
    it('renders live bank profile and frozen payable destination independently', () => {
      const assayer = baseAssayer({
        bankAccountNumber: '111122223333',
        ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank',
      });

      const frozenPayables = [
        {
          id: 'pay-1',
          payableNumber: 'PAY-2026-001',
          amount: 5000,
          currency: 'INR',
          status: 'APPROVED',
          destinationBankAccountNumber: '999988887777', // differs from live bank
          destinationIfsc: 'SBIN0001234',
          destinationBankName: 'State Bank of India',
          destinationAccountHolderName: 'Person One Original',
          approvedAt: '2026-08-15T10:00:00Z',
        },
      ];

      const { container: c1 } = render(<BankProfileCard assayer={assayer} canManage />);
      const { container: c2 } = render(<FrozenPayoutDestinationCard payables={frozenPayables} />);

      // Current live bank card shows HDFC Bank
      expect(within(c1).getByText('HDFC Bank')).toBeInTheDocument();
      expect(within(c1).getByText('HDFC0000001')).toBeInTheDocument();

      // Frozen payable destination shows State Bank of India
      expect(within(c2).getByText('State Bank of India')).toBeInTheDocument();
      expect(within(c2).getByText('SBIN0001234')).toBeInTheDocument();
      expect(within(c2).getByText(/Saved at the moment the payment was approved/i)).toBeInTheDocument();

      // Frozen payable must NOT have an edit affordance
      expect(within(c2).queryByRole('button', { name: /Edit/i })).not.toBeInTheDocument();
    });

    it('does not treat departed assayer with incomplete bank as active payout work queue', () => {
      const resignedAssayer = baseAssayer({
        lifecycleStatus: AssayerLifecycleStatus.RESIGNED,
        bankAccountNumber: null,
        ifscCode: null,
      });

      render(<BankProfileCard assayer={resignedAssayer} canManage />);

      // Must explicitly note that departed assayers are not active payout blockers
      expect(screen.getByTestId('departed-payout-notice')).toBeInTheDocument();
      expect(screen.getByText(/They have left \(Resigned\)/)).toBeInTheDocument();
    });
  });

  describe('5. Lifecycle 409 Concurrency Recovery', () => {
    it('on a 409, changes nothing, says so plainly, and re-reads the record', async () => {
      // Pinned and payable, so the move reaches the server — Active is refused on the page without those.
      const initial = baseAssayer({ lifecycleStatus: AssayerLifecycleStatus.TRAINING, latitude: 9.93, longitude: 76.26 });
      mockRequest.mockImplementation((url: string) => {
        if (url === '/assayers/a-1') return Promise.resolve(initial);
        if (url.endsWith('/dossier')) return Promise.resolve({ onboarding: [], empanelments: [] });
        if (url.endsWith('/payables')) return Promise.resolve([]);
        if (url.includes('/assignments/assayer/')) return Promise.resolve({ items: [] });
        if (url.endsWith('/activity')) return Promise.resolve([]);
        if (url.endsWith('/lifecycle')) {
          return Promise.reject(new Error('Illegal lifecycle transition: current status is SUSPENDED, cannot transition to ACTIVE'));
        }
        return Promise.reject(new Error('unknown url'));
      });

      render(
        <AssayerRecord
          assayerId="a-1"
          canManage
          onClose={jest.fn()}
          onChanged={jest.fn()}
        />,
      );

      await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

      const moveButton = screen.getByRole('button', { name: 'Move to Active' });
      fireEvent.click(moveButton);

      const dialog = await screen.findByRole('dialog');
      const confirmBtn = within(dialog).getByRole('button', { name: 'Move to Active' });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText(/Someone else changed this person’s stage at the same time/)).toBeInTheDocument();
      });

      // Must re-read server truth
      expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1');
    });
  });

  describe('6. Authorization Boundaries', () => {
    it('denies edit and lifecycle actions for read-only user', async () => {
      mockRequest.mockImplementation((url: string) => {
        if (url === '/assayers/a-1') return Promise.resolve(baseAssayer());
        if (url.endsWith('/dossier')) return Promise.resolve({ onboarding: [], empanelments: [] });
        if (url.endsWith('/payables')) return Promise.resolve([]);
        if (url.includes('/assignments/assayer/')) return Promise.resolve({ items: [] });
        if (url.endsWith('/activity')) return Promise.resolve([]);
        return Promise.reject(new Error('unknown url'));
      });

      render(
        <AssayerRecord
          assayerId="a-1"
          canManage={false}
          onClose={jest.fn()}
          onChanged={jest.fn()}
        />,
      );

      await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

      // No Edit button
      expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument();
      // No lifecycle actions
      expect(screen.queryByText('What happens next')).not.toBeInTheDocument();
      // No delete button
      expect(screen.queryByRole('button', { name: /Delete/i })).not.toBeInTheDocument();
    });
  });
});
