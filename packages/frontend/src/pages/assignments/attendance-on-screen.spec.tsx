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
import { readAttendance, formatMinutesOnSite, attendanceSummary } from './attendance';
import type { Assignment } from './types';

/**
 * What the web app says about a visit's two ends.
 *
 * Before this, `checkedOutAt` appeared **nowhere in the frontend** — grep returned nothing outside
 * the mobile app — while the backend's integrity scanner had been calling check-in and check-out
 * "attendance evidence" since it was written. The drawer drew the arrival and stopped, so a visit
 * that ended properly and a visit whose end was never recorded rendered identically, and the
 * reason the desk was made to state at completion was stored and then shown to nobody.
 *
 * Time on site is what a client dispute, a travel claim and a bank's audit file are read out of.
 * These tests assert the screen states it — including, and especially, when it cannot.
 *
 * Every case asserts BOTH halves: what appears, and that the wrong thing does not. A panel that
 * said "no check-out recorded" over a complete visit would be as wrong as saying nothing.
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
  status: 'COMPLETED',
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

describe('the visit on screen', () => {
  describe('when both ends of the visit are on record', () => {
    const complete: Assignment = {
      ...base,
      checkedInAt: '2026-09-08T09:00:00.000Z',
      checkedOutAt: '2026-09-08T11:15:00.000Z',
      checkInDistanceMeters: 42,
      checkOutDistanceMeters: 55,
      checkInLatitude: 12.93, checkInLongitude: 77.62,
      checkOutLatitude: 12.93, checkOutLongitude: 77.62,
    };

    it('shows the arrival, the departure and the time on site', () => {
      renderDrawer(complete);

      expect(screen.getByText(/Attendance on site/i)).toBeInTheDocument();
      expect(screen.getByText(/Checked in/i)).toBeInTheDocument();
      expect(screen.getByText(/Checked out/i)).toBeInTheDocument();
      // 09:00 to 11:15 is 2h 15m. The number is the point of the panel.
      expect(screen.getByText('2h 15m on site')).toBeInTheDocument();
    });

    it('does not claim a gap that is not there', () => {
      renderDrawer(complete);

      expect(screen.queryByText(/No check-out recorded/i)).toBeNull();
      expect(screen.queryByText(/time on site unknown/i)).toBeNull();
    });

    it('offers both ends on a map, not just the arrival', () => {
      renderDrawer(complete);

      expect(screen.getByRole('link', { name: /Arrival on map/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Departure on map/i })).toBeInTheDocument();
    });
  });

  describe('when the assayer arrived and the departure was never recorded', () => {
    const noDeparture: Assignment = {
      ...base,
      checkedInAt: '2026-09-08T09:00:00.000Z',
      checkedOutAt: null,
      completedWithoutCheckOutReason: 'Left about 4pm; phone battery died before checking out.',
    };

    it('says so in words rather than leaving an absence to be noticed', () => {
      renderDrawer(noDeparture);

      expect(screen.getByText(/No check-out recorded — time on site unknown/i)).toBeInTheDocument();
      // And the arrival is still shown: half a record is still worth reading.
      expect(screen.getByText(/Checked in/i)).toBeInTheDocument();
    });

    it('shows the stated reason, which until now was stored and displayed to nobody', () => {
      renderDrawer(noDeparture);

      expect(screen.getByText(/Left about 4pm; phone battery died/i)).toBeInTheDocument();
    });

    it('does not invent a duration', () => {
      renderDrawer(noDeparture);

      // The duration line is `<n>h <n>m on site` / `<n>m on site`. Matching that shape rather
      // than the words "on site", which the panel's own heading also contains.
      expect(screen.queryByText(/^\d+[hm].*on site$/)).toBeNull();
      expect(screen.queryByText(/0m on site/)).toBeNull();
    });

    it('is honest when the gap predates the requirement and no reason was recorded', () => {
      // The 15 rows already in the database. Saying "no reason was given" would read as somebody
      // having declined to explain; they were never asked.
      renderDrawer({ ...noDeparture, completedWithoutCheckOutReason: null });

      expect(screen.getByText(/completed before a departure was required/i)).toBeInTheDocument();
    });

    it('reads as still-open rather than as a gap while the visit is in progress', () => {
      renderDrawer({ ...noDeparture, status: 'IN_PROGRESS', completedWithoutCheckOutReason: null });

      expect(screen.getByText(/has not checked out of this branch yet/i)).toBeInTheDocument();
    });
  });

  describe('when there was no arrival at all', () => {
    it('states the absence and the reason given for it', () => {
      renderDrawer({
        ...base,
        checkedInAt: null,
        checkedOutAt: null,
        completedWithoutCheckInReason: 'Assayer never opened the app; branch manager confirmed by phone.',
      });

      expect(screen.getByText(/No check-in recorded/i)).toBeInTheDocument();
      expect(screen.getByText(/branch manager confirmed by phone/i)).toBeInTheDocument();
    });

    it('draws nothing about attendance on a job that has not been done yet', () => {
      // A PENDING offer has no attendance to report and must not be dressed as a gap.
      renderDrawer({ ...base, status: 'PENDING', checkedInAt: null, checkedOutAt: null });

      expect(screen.queryByText(/Attendance on site/i)).toBeNull();
    });
  });
});

describe('readAttendance', () => {
  const at = (ci: string | null, co: string | null) =>
    readAttendance({ checkedInAt: ci, checkedOutAt: co } as Assignment);

  it('measures the span between the two ends', () => {
    expect(at('2026-09-08T09:00:00Z', '2026-09-08T11:15:00Z').minutesOnSite).toBe(135);
  });

  it('reports an unmeasurable visit as null, never as zero', () => {
    // Zero is a claim — "the visit took no time". An absent measurement is not a measurement.
    expect(at('2026-09-08T09:00:00Z', null).minutesOnSite).toBeNull();
    expect(at(null, null).minutesOnSite).toBeNull();
    expect(at('2026-09-08T09:00:00Z', null).durationLabel).toBeNull();
  });

  it('refuses to render a negative span from a bad clock', () => {
    expect(at('2026-09-08T11:15:00Z', '2026-09-08T09:00:00Z').minutesOnSite).toBeNull();
  });

  it('names which end is missing', () => {
    expect(at('2026-09-08T09:00:00Z', '2026-09-08T11:15:00Z').gap).toBe('NONE');
    expect(at('2026-09-08T09:00:00Z', null).gap).toBe('NO_DEPARTURE');
    expect(at(null, null).gap).toBe('NO_ARRIVAL');
  });

  it('takes the reason from the column that matches the gap', () => {
    const r = readAttendance({
      checkedInAt: '2026-09-08T09:00:00Z',
      checkedOutAt: null,
      completedWithoutCheckInReason: 'wrong one',
      completedWithoutCheckOutReason: 'battery died',
    } as Assignment);
    expect(r.gapReason).toBe('battery died');
  });

  it('treats a whitespace-only reason as no reason', () => {
    const r = readAttendance({
      checkedInAt: '2026-09-08T09:00:00Z', checkedOutAt: null,
      completedWithoutCheckOutReason: '   ',
    } as Assignment);
    expect(r.gapReason).toBeNull();
  });
});

describe('formatMinutesOnSite', () => {
  it.each([[45, '45m'], [60, '1h'], [135, '2h 15m'], [1, '1m']])('%i → %s', (m, out) => {
    expect(formatMinutesOnSite(m as number)).toBe(out);
  });
});

describe('attendanceSummary', () => {
  it('never reports only the half that exists', () => {
    // The queue's arrival marker used to say "Checked in <time>" and nothing else, which is how a
    // missing departure stayed invisible on the list.
    const s = attendanceSummary(readAttendance({
      checkedInAt: '2026-09-08T09:00:00Z', checkedOutAt: null,
    } as Assignment));
    expect(s).toMatch(/never checked out/i);
    expect(s).toMatch(/no time on site/i);
  });

  it('gives the duration when there is one', () => {
    const s = attendanceSummary(readAttendance({
      checkedInAt: '2026-09-08T09:00:00Z', checkedOutAt: '2026-09-08T11:15:00Z',
    } as Assignment));
    expect(s).toMatch(/2h 15m on site/);
  });
});
