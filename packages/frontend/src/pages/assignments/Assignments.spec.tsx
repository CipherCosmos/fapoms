import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectBranchStatus } from '@fapoms/shared';

jest.mock('../../services/api', () => ({
  api: { request: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../services/socket', () => ({
  socket: { on: jest.fn(), off: jest.fn() },
  disconnectSocket: jest.fn(),
  useSocketConnection: jest.fn(),
}));

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { computeAssignmentAttention } from './useAssignmentQueue';
import { AssignmentTable } from './AssignmentTable';
import { AssignmentDetailDrawer } from './AssignmentDetailDrawer';
import type { Assignment } from './types';

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Assignments Workspace: Domain & Attention Logic', () => {
  const baseAssignment: Assignment = {
    id: 'asn-1',
    assignmentNumber: 'ASN-001',
    projectId: 'proj-1',
    projectBranchId: 'pb-1',
    assayerId: 'as-1',
    status: 'ACCEPTED',
    priority: 'MEDIUM',
    proposedFee: 1500,
    agreedFee: 1500,
    scheduledDate: '2026-09-15T10:00:00.000Z',
    createdAt: '2026-09-01T10:00:00.000Z',
    project: { name: 'Q3 Gold Audit' },
    assayer: { displayName: 'Rajesh Kumar' },
    projectBranch: {
      status: ProjectBranchStatus.SCHEDULED,
      branch: { name: 'Koramangala Branch', state: 'Karnataka' },
    },
    assessment: null,
  };

  describe('Deterministic Attention Precedence & Priority Separation', () => {
    const today = '2026-09-08';

    it('separates priority from operational blocker: priority CRITICAL alone does NOT yield BLOCKED', () => {
      // Critical priority on an accepted future visit is on-track operationally, with severity surfaced on priority tag
      const criticalAccepted: Assignment = {
        ...baseAssignment,
        priority: 'CRITICAL',
        status: 'ACCEPTED',
        scheduledDate: '2026-09-15T10:00:00.000Z',
      };
      expect(computeAssignmentAttention(criticalAccepted, today, false)).toBe('NORMAL');

      // Only genuine operational blockers (e.g. open field issue) yield BLOCKED
      expect(computeAssignmentAttention(criticalAccepted, today, true)).toBe('BLOCKED');
    });

    it('precedence combination: overdue + open issue -> BLOCKED (Tier 1 blocker overrides Tier 4 overdue)', () => {
      const pastAsnWithIssue: Assignment = {
        ...baseAssignment,
        scheduledDate: '2026-09-01T10:00:00.000Z',
        status: 'ACCEPTED',
      };
      // Blocker on site must be addressed before visit can be salvaged
      expect(computeAssignmentAttention(pastAsnWithIssue, today, true)).toBe('BLOCKED');
      // Without the blocker, it is OVERDUE
      expect(computeAssignmentAttention(pastAsnWithIssue, today, false)).toBe('OVERDUE');
    });

    it('precedence combination: critical + pending -> NEEDS_RESPONSE (Urgency stays on tag; attention is unacknowledged offer)', () => {
      const criticalPending: Assignment = {
        ...baseAssignment,
        priority: 'CRITICAL',
        status: 'PENDING',
        scheduledDate: '2026-09-12T10:00:00.000Z',
      };
      expect(computeAssignmentAttention(criticalPending, today, false)).toBe('NEEDS_RESPONSE');
    });

    it('precedence combination: pending + overdue -> OVERDUE (Calendar breach overrides unreplied offer)', () => {
      const pastPending: Assignment = {
        ...baseAssignment,
        status: 'PENDING',
        scheduledDate: '2026-09-05T10:00:00.000Z',
      };
      expect(computeAssignmentAttention(pastPending, today, false)).toBe('OVERDUE');
    });

    it('precedence combination: completed + missing check-in -> AWAITING_VALIDATION (Field closed, packet at desk QA)', () => {
      const completedNoCheckin: Assignment = {
        ...baseAssignment,
        status: 'COMPLETED',
        checkedInAt: null,
        projectBranch: {
          status: ProjectBranchStatus.AUDIT_COMPLETED,
          branch: { name: 'Koramangala Branch', state: 'Karnataka' },
        },
      };
      expect(computeAssignmentAttention(completedNoCheckin, today, false)).toBe('AWAITING_VALIDATION');
    });

    it('precedence combination: completed + audit-completed -> AWAITING_VALIDATION', () => {
      const completedWithCheckin: Assignment = {
        ...baseAssignment,
        status: 'COMPLETED',
        checkedInAt: '2026-09-08T09:00:00.000Z',
        projectBranch: {
          status: ProjectBranchStatus.AUDIT_COMPLETED,
          branch: { name: 'Koramangala Branch', state: 'Karnataka' },
        },
      };
      expect(computeAssignmentAttention(completedWithCheckin, today, false)).toBe('AWAITING_VALIDATION');
    });

    it('precedence combination: critical + check-in-missing -> CHECKIN_MISSING (Active integrity risk)', () => {
      const criticalMissingCheckin: Assignment = {
        ...baseAssignment,
        priority: 'CRITICAL',
        status: 'IN_PROGRESS',
        checkedInAt: null,
        scheduledDate: '2026-09-08T10:00:00.000Z',
      };
      expect(computeAssignmentAttention(criticalMissingCheckin, today, false)).toBe('CHECKIN_MISSING');
    });

    it('derives IN_PROGRESS if CHECKED_IN or IN_PROGRESS with verified attendance', () => {
      const checkedIn: Assignment = {
        ...baseAssignment,
        status: 'CHECKED_IN',
        checkedInAt: '2026-09-08T09:00:00.000Z',
        scheduledDate: '2026-09-08T10:00:00.000Z',
      };
      expect(computeAssignmentAttention(checkedIn, today, false)).toBe('IN_PROGRESS');
    });

    it('derives NORMAL for on-track future scheduled accepted visit', () => {
      const futureAsn: Assignment = {
        ...baseAssignment,
        status: 'ACCEPTED',
        scheduledDate: '2026-09-20T10:00:00.000Z',
      };
      expect(computeAssignmentAttention(futureAsn, today, false)).toBe('NORMAL');
    });
  });

  describe('Exhaustive ProjectBranchStatus Visual Presentation', () => {
    const allBranchStatuses: ProjectBranchStatus[] = [
      ProjectBranchStatus.IMPORTED,
      ProjectBranchStatus.PLANNING,
      ProjectBranchStatus.CANDIDATE_SEARCH,
      ProjectBranchStatus.CONTACT_INITIATED,
      ProjectBranchStatus.NEGOTIATION,
      ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
      ProjectBranchStatus.SCHEDULED,
      ProjectBranchStatus.AUDIT_COMPLETED,
      ProjectBranchStatus.VALIDATION_COMPLETED,
      ProjectBranchStatus.CLOSED,
      ProjectBranchStatus.UNABLE_TO_COVER,
      ProjectBranchStatus.ON_HOLD,
      ProjectBranchStatus.CANCELLED,
    ];

    allBranchStatuses.forEach((bStatus) => {
      it(`renders safe, non-collapsing badge for branch status: ${bStatus}`, () => {
        const asn: Assignment = {
          ...baseAssignment,
          id: `asn-${bStatus}`,
          projectBranch: {
            status: bStatus,
            branch: { name: 'Koramangala Branch', state: 'Karnataka' },
          },
        };

        const { unmount } = render(
          <MemoryRouter>
            <AssignmentTable
              assignments={[asn]}
              filteredAssignments={[asn]}
              selectedAsnId={asn.id}
              onSelectAssignment={jest.fn()}
              statusFilter="ALL"
              searchTerm=""
              isLoading={false}
              page={1}
              total={1}
              totalPages={1}
              setPage={jest.fn()}
              dateSort="asc"
              setDateSort={jest.fn()}
              quickBusyId={null}
              onQuickAction={jest.fn()}
              isAttentionView={false}
              openIssueAssignmentIds={new Set()}
              todayStr="2026-09-08"
            />
          </MemoryRouter>
        );

        // Verify that branch status column rendered without error
        expect(screen.getByText('Branch Workflow')).toBeInTheDocument();
        expect(screen.getByText('Assignment State')).toBeInTheDocument();
        expect(screen.getByText('Attention')).toBeInTheDocument();
        unmount();
      });
    });
  });

  describe('Workflow Action Contracts & Capability Gating', () => {
    it('hides mutating lifecycle actions when operator lacks capability (canActOnAssignments: false)', () => {
      renderWithProviders(
        <AssignmentDetailDrawer
          assignment={baseAssignment}
          canActOnAssignments={false}
          actionBusy={false}
          actionError={null}
          onClearActionError={jest.fn()}
          onTransition={jest.fn()}
          onEscalate={jest.fn()}
          askToComplete={jest.fn()}
          planningLinkFor={() => '/planning'}
          confirm={jest.fn()}
          confirmWithReason={jest.fn()}
        />
      );

      expect(screen.queryByRole('button', { name: /Mark Audit Complete/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Accept Offer/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /More/i })).toBeNull();
    });

    it('executes regular completion with simple confirmation when check-in is present', async () => {
      const attendedAsn: Assignment = {
        ...baseAssignment,
        status: 'IN_PROGRESS',
        checkedInAt: '2026-09-08T09:00:00.000Z',
      };
      const onTransition = jest.fn().mockResolvedValue(undefined);
      const askToComplete = jest.fn().mockResolvedValue({});

      renderWithProviders(
        <AssignmentDetailDrawer
          assignment={attendedAsn}
          canActOnAssignments={true}
          actionBusy={false}
          actionError={null}
          onClearActionError={jest.fn()}
          onTransition={onTransition}
          onEscalate={jest.fn()}
          askToComplete={askToComplete}
          planningLinkFor={() => '/planning'}
          confirm={jest.fn()}
          confirmWithReason={jest.fn()}
        />
      );

      const completeBtn = screen.getByRole('button', { name: /Mark Audit Complete/i });
      fireEvent.click(completeBtn);

      await waitFor(() => {
        expect(askToComplete).toHaveBeenCalledWith(true);
        expect(onTransition).toHaveBeenCalledWith('COMPLETED', undefined);
      });
    });

    it('preserves exceptional completion: requires reason when completing without check-in', async () => {
      const unattendedAsn: Assignment = {
        ...baseAssignment,
        status: 'IN_PROGRESS',
        checkedInAt: null,
      };
      const onTransition = jest.fn().mockResolvedValue(undefined);
      const askToComplete = jest
        .fn()
        .mockResolvedValue({ reason: 'Vault attendance confirmed via branch manager phone' });

      renderWithProviders(
        <AssignmentDetailDrawer
          assignment={unattendedAsn}
          canActOnAssignments={true}
          actionBusy={false}
          actionError={null}
          onClearActionError={jest.fn()}
          onTransition={onTransition}
          onEscalate={jest.fn()}
          askToComplete={askToComplete}
          planningLinkFor={() => '/planning'}
          confirm={jest.fn()}
          confirmWithReason={jest.fn()}
        />
      );

      const completeBtn = screen.getByRole('button', { name: /Mark Audit Complete/i });
      fireEvent.click(completeBtn);

      await waitFor(() => {
        expect(askToComplete).toHaveBeenCalledWith(false);
        expect(onTransition).toHaveBeenCalledWith(
          'COMPLETED',
          'Vault attendance confirmed via branch manager phone'
        );
      });
    });

    it('aborts exceptional completion if operator cancels or leaves reason blank', async () => {
      const unattendedAsn: Assignment = {
        ...baseAssignment,
        status: 'IN_PROGRESS',
        checkedInAt: null,
      };
      const onTransition = jest.fn();
      const askToComplete = jest.fn().mockResolvedValue(null);

      renderWithProviders(
        <AssignmentDetailDrawer
          assignment={unattendedAsn}
          canActOnAssignments={true}
          actionBusy={false}
          actionError={null}
          onClearActionError={jest.fn()}
          onTransition={onTransition}
          onEscalate={jest.fn()}
          askToComplete={askToComplete}
          planningLinkFor={() => '/planning'}
          confirm={jest.fn()}
          confirmWithReason={jest.fn()}
        />
      );

      const completeBtn = screen.getByRole('button', { name: /Mark Audit Complete/i });
      fireEvent.click(completeBtn);

      await waitFor(() => {
        expect(askToComplete).toHaveBeenCalledWith(false);
        expect(onTransition).not.toHaveBeenCalled();
      });
    });

    it('enforces mandatory reason when cancelling an assignment', async () => {
      const onTransition = jest.fn().mockResolvedValue(undefined);

      renderWithProviders(
        <AssignmentDetailDrawer
          assignment={baseAssignment}
          canActOnAssignments={true}
          actionBusy={false}
          actionError={null}
          onClearActionError={jest.fn()}
          onTransition={onTransition}
          onEscalate={jest.fn()}
          askToComplete={jest.fn()}
          planningLinkFor={() => '/planning'}
          confirm={jest.fn()}
          confirmWithReason={jest.fn()}
        />
      );

      // Open More actions menu
      const moreBtn = screen.getByRole('button', { name: /More/i });
      fireEvent.click(moreBtn);

      // Click Cancel Assignment
      const cancelBtn = screen.getByRole('button', { name: /Cancel Assignment/i });
      fireEvent.click(cancelBtn);

      // Confirm button is initially disabled because reason is empty
      const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
      expect(confirmBtn).toBeDisabled();

      // Enter a valid cancel reason
      const input = screen.getByPlaceholderText(/Reason for cancelling/i);
      fireEvent.change(input, { target: { value: 'Branch is undergoing flood renovation' } });

      expect(confirmBtn).not.toBeDisabled();
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(onTransition).toHaveBeenCalledWith(
          'CANCELLED',
          'Branch is undergoing flood renovation'
        );
      });
    });

    it('executes accept offer flow with user confirmation', async () => {
      const pendingAsn: Assignment = {
        ...baseAssignment,
        status: 'PENDING',
      };
      const onTransition = jest.fn().mockResolvedValue(undefined);
      const confirm = jest.fn().mockResolvedValue(true);

      renderWithProviders(
        <AssignmentDetailDrawer
          assignment={pendingAsn}
          canActOnAssignments={true}
          actionBusy={false}
          actionError={null}
          onClearActionError={jest.fn()}
          onTransition={onTransition}
          onEscalate={jest.fn()}
          askToComplete={jest.fn()}
          planningLinkFor={() => '/planning'}
          confirm={confirm}
          confirmWithReason={jest.fn()}
        />
      );

      const acceptBtn = screen.getByRole('button', { name: /Accept Offer/i });
      fireEvent.click(acceptBtn);

      await waitFor(() => {
        expect(confirm).toHaveBeenCalled();
        expect(onTransition).toHaveBeenCalledWith('ACCEPTED');
      });
    });

    it('renders server business-rule error messages directly in the drawer', () => {
      renderWithProviders(
        <AssignmentDetailDrawer
          assignment={baseAssignment}
          canActOnAssignments={true}
          actionBusy={false}
          actionError="STALE_ASSIGNMENT_VERSION: Assignment has been updated by another operator. Please refresh."
          onClearActionError={jest.fn()}
          onTransition={jest.fn()}
          onEscalate={jest.fn()}
          askToComplete={jest.fn()}
          planningLinkFor={() => '/planning'}
          confirm={jest.fn()}
          confirmWithReason={jest.fn()}
        />
      );

      expect(
        screen.getByText(
          /STALE_ASSIGNMENT_VERSION: Assignment has been updated by another operator/i
        )
      ).toBeInTheDocument();
    });

    it('recovers from 409 optimistic locking conflicts via reload action without corrupting state', () => {
      // 409 is a transient mutation error caught by handler, triggering conflict recovery modal
      const onReload = jest.fn();
      const onClose = jest.fn();

      const { ConflictModal } = require('../../components/ui/ConflictModal');

      renderWithProviders(
        <ConflictModal
          isOpen={true}
          onClose={onClose}
          onReload={onReload}
          message="Assignment has been updated by another dispatcher. Please reload."
        />
      );

      expect(
        screen.getByText(/Assignment has been updated by another dispatcher/i)
      ).toBeInTheDocument();

      const reloadBtn = screen.getByRole('button', { name: /Reload Latest/i });
      fireEvent.click(reloadBtn);
      expect(onReload).toHaveBeenCalled();
    });
  });
});

