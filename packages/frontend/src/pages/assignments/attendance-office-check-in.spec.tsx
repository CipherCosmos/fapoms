import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
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
import { AssignmentDetailDrawer } from './AssignmentDetailDrawer';
import { readAttendance, attendanceSummary } from './attendance';
import type { Assignment } from './types';

/**
 * A check-in the office made, not the assayer's phone.
 *
 * Staff (admin / operations) can now check an assayer in from the office, and must write why
 * (`checkInOfficeReason`). That arrival is vouched for by a person, not fixed by GPS on site, so
 * the screen has to say who made it and why — drawn like any other check-in it would read as
 * attendance evidence it is not. Every case asserts both halves: the office line appears when it
 * should, and never on an ordinary check-in.
 */
function renderDrawer(assignment: Assignment) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AssignmentDetailDrawer
          assignment={assignment}
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
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const base: Assignment = {
  id: 'asn-1',
  assignmentNumber: 'ASN-001',
  projectId: 'proj-1',
  projectBranchId: 'pb-1',
  assayerId: 'as-1',
  status: 'IN_PROGRESS',
  priority: 'MEDIUM',
  proposedFee: 1500,
  agreedFee: 1500,
  scheduledDate: '2026-09-15T10:00:00.000Z',
  createdAt: '2026-09-01T10:00:00.000Z',
  checkedInAt: '2026-09-15T09:00:00.000Z',
  checkedOutAt: null,
  project: { name: 'Q3 Gold Audit' },
  assayer: { displayName: 'Rajesh Kumar' },
  projectBranch: {
    status: ProjectBranchStatus.SCHEDULED,
    branch: { name: 'Koramangala Branch', state: 'Karnataka' },
  },
  assessment: null,
};

const REASON = 'Phone died at the gate; branch manager confirmed arrival by phone.';

describe('readAttendance — office check-in', () => {
  it('carries the office reason when the office checked the assayer in', () => {
    const r = readAttendance({ ...base, checkInOfficeReason: REASON, checkInTimeOutcome: 'NOT_FROM_ASSAYER' });
    expect(r.officeCheckIn).toEqual({ reason: REASON });
  });

  it('is null for an ordinary check-in from the phone', () => {
    expect(readAttendance({ ...base, checkInOfficeReason: null }).officeCheckIn).toBeNull();
    expect(readAttendance(base).officeCheckIn).toBeNull();
  });

  it('is null with no arrival, even if a stray reason is present', () => {
    expect(readAttendance({ ...base, checkedInAt: null, checkInOfficeReason: REASON }).officeCheckIn).toBeNull();
  });
});

describe('attendanceSummary — office check-in', () => {
  it('says the office checked them in, with the reason', () => {
    const s = attendanceSummary(readAttendance({ ...base, checkInOfficeReason: REASON }));
    expect(s).toContain(`Checked in by the office (reason: ${REASON})`);
    // The departure half is still reported.
    expect(s).toMatch(/never checked out/i);
  });

  it('does not mention the office on an ordinary check-in', () => {
    const s = attendanceSummary(readAttendance(base));
    expect(s).not.toMatch(/office/i);
    expect(s).toMatch(/^Checked in /);
  });
});

describe('the drawer — office check-in', () => {
  it('shows "Checked in by the office" and the reason under the check-in line', () => {
    renderDrawer({ ...base, checkInOfficeReason: REASON, checkInTimeOutcome: 'NOT_FROM_ASSAYER' });
    expect(screen.getByText(/Checked in by the office/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(REASON.slice(0, 20)))).toBeInTheDocument();
  });

  it('draws no office line for an ordinary check-in', () => {
    renderDrawer(base);
    expect(screen.getByText(/Attendance on site/i)).toBeInTheDocument();
    expect(screen.queryByText(/Checked in by the office/)).toBeNull();
  });
});
