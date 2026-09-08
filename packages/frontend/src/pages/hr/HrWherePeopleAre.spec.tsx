import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

import { HrWherePeopleArePage } from './HrWherePeopleArePage';

/**
 * "Where people are" has to earn its place: three views answering one question an HR manager
 * asks in one breath — "where is everybody, and are they busy?"
 *
 * These hold each view to being usable, not merely present: the workload table is the whole
 * active roster with no server-side narrowing, so it needs its own search and posture filter;
 * the coverage table is a dead end unless a state leads to its people on the roster; and the
 * capped audit trail needs a search because the entry being looked for is rarely on screen.
 */

jest.mock('./HrLayout', () => ({
  useHr: () => ({ data: payload(), canManage: true, refetch: jest.fn() }),
}));

const payload = () => ({
  utilisation: {
    idleAfterDays: 30,
    idleCount: 1,
    neverAssigned: 1,
    idle: [
      {
        id: 'u-3', assayerCode: 'AS0003', displayName: 'Long Laura', state: 'Kerala',
        lastAssignmentDate: '2025-01-01T00:00:00.000Z', daysIdle: 200, totalAssignments: 3,
      },
    ],
    utilization: [
      {
        id: 'u-1', assayerCode: 'AS0001', displayName: 'Idle Ivan', state: 'Kerala', district: 'Ernakulam',
        weeklyCapacity: 15, currentAllocation: 0, remainingCapacity: 15,
        utilizationPercentage: 0, posture: 'IDLE',
      },
      {
        id: 'u-2', assayerCode: 'AS0002', displayName: 'Busy Beena', state: 'Goa', district: 'North Goa',
        weeklyCapacity: 5, currentAllocation: 5, remainingCapacity: 0,
        utilizationPercentage: 100, posture: 'OVER_UTILIZED',
      },
    ],
    utilizationCounts: { idle: 1, underUtilized: 0, balanced: 0, overUtilized: 1, total: 2 },
    performance: {
      avgRating: null, rated: 0, belowPar: 0, totalAssignments: 0,
      completedAssignments: 0, cancelledAssignments: 0, onTimeCompletions: 0, onTimeRate: null,
    },
  },
  deployment: {
    territories: [
      { state: 'Kerala', assayers: 10, active: 8, branches: 40, branchesPerAssayer: 5, posture: 'STRETCHED' },
      { state: 'Goa', assayers: 2, active: 2, branches: 0, branchesPerAssayer: null, posture: 'NO_WORK' },
    ],
    hiringNeeded: [{ state: 'Kerala' }],
    idleTerritories: [{ state: 'Goa' }],
  },
  attrition: {
    totalExits: 0, exits90d: 0, exits12m: 0, terminations: 0, joins90d: 0,
    attritionRate12m: 0, averageHeadcount12m: 2, undatedExits: 0, recent: [],
  },
  activity: [
    {
      id: 'e-1', eventType: 'ASSAYER_CREATED', previousState: null, newState: null,
      performedBy: 'hr.clerk', remarks: null, occurredAt: '2026-09-01T10:00:00.000Z',
      assayerId: 'u-1', assayerCode: 'AS0001', displayName: 'Idle Ivan',
    },
    {
      id: 'e-2', eventType: 'LIFECYCLE_CHANGED', previousState: 'TRAINING', newState: 'ACTIVE',
      performedBy: 'hr.clerk', remarks: 'Training complete', occurredAt: '2026-09-02T10:00:00.000Z',
      assayerId: 'u-2', assayerCode: 'AS0002', displayName: 'Busy Beena',
    },
  ],
});

const renderPage = (view?: string) => render(
  <MemoryRouter initialEntries={[`/hr/where${view ? `?view=${view}` : ''}`]}>
    <HrWherePeopleArePage />
  </MemoryRouter>,
);

describe('Where people are — workload', () => {
  it('lists everybody, then narrows by name search', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Idle Ivan')).toBeInTheDocument());
    expect(screen.getByText('Busy Beena')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Find a person or place/), { target: { value: 'beena' } });

    expect(screen.queryByText('Idle Ivan')).not.toBeInTheDocument();
    expect(screen.getByText('Busy Beena')).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 2 people/)).toBeInTheDocument();
  });

  it('narrows by posture, so the over-capacity few are one click away', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Idle Ivan')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Over capacity/ }));

    expect(screen.queryByText('Idle Ivan')).not.toBeInTheDocument();
    expect(screen.getByText('Busy Beena')).toBeInTheDocument();
  });
});

describe('Where people are — coverage', () => {
  it('sends each state to its people on the roster', async () => {
    renderPage('coverage');
    await waitFor(() => expect(screen.getByText('Kerala')).toBeInTheDocument());

    const links = screen.getAllByRole('link', { name: /See people/ });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/hr/roster?f_state=Kerala');
  });

  it('does not print filler figures beside the hiring brief', async () => {
    renderPage('coverage');
    await waitFor(() => expect(screen.getByText('Kerala')).toBeInTheDocument());

    expect(screen.queryByText('States with work or people')).not.toBeInTheDocument();
    expect(screen.getByText('States that need more people')).toBeInTheDocument();
  });
});

describe('Where people are — recent changes', () => {
  it('searches the trail instead of leaving the wanted entry off screen', async () => {
    renderPage('changes');
    await waitFor(() => expect(screen.getByText('Idle Ivan')).toBeInTheDocument());
    expect(screen.getByText('Busy Beena')).toBeInTheDocument();

    const box = screen.getByPlaceholderText(/Find a person, event or note/);
    fireEvent.change(box, { target: { value: 'training complete' } });

    expect(screen.queryByText('Idle Ivan')).not.toBeInTheDocument();
    expect(screen.getByText('Busy Beena')).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 2 recent changes/)).toBeInTheDocument();
  });
});
