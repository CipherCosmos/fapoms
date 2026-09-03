import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';

import { HrOverviewPage } from './HrOverviewPage';
import { HrUtilisationPage } from './HrUtilisationPage';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';

/**
 * THE ATTRITION PERCENTAGE, AND THE TWO SCREENS THAT PRINT IT.
 *
 * There was a spec here before that tested nothing. It declared a local `rate()` helper that
 * applied the attrition formula, then asserted that helper against the same formula — one
 * assertion was literally the identical expression on both sides. It imported neither the screens
 * nor the service, so either could have changed its denominator and the suite would have stayed
 * green, while its docblock claimed to pin "the denominator is sent now rather than guessed at by
 * the screen". A test that cannot fail is worse than no test: it is a claim of cover.
 *
 * These render the real screens against a payload shaped like the server's, and hold them to the
 * three things that actually went wrong:
 *
 *   - the explanation under the percentage must divide the numbers it names and land on the
 *     percentage above it. The Overview tile used to quote `headcount.total` — every live record,
 *     including people who left before the window — so a tile reading 25% was explained by two
 *     numbers that work out to 20%, and the figure repeated in a meeting was the wrong one;
 *   - both screens must say it the same way, because they print the same number;
 *   - the leavers with no leaving date must be visible. Twenty-five people are off the roster and
 *     cannot be placed inside a twelve-month window, so the rate is computed without them. The
 *     server publishes that count for exactly this reason and no screen could read it.
 */

/**
 * A payload shaped the way `/hr/workforce` answers, typed rather than cast.
 *
 * The typing is the point for `undatedExits`: the frontend interface stopped at `joins90d`, so a
 * field the server had been sending all along was invisible to every screen. An object literal
 * checked against `HrWorkforceOverview` stops compiling if that field is dropped again.
 */
const payload = (attrition: Partial<HrWorkforceOverview['attrition']> = {}): HrWorkforceOverview => ({
  generatedAt: '2026-09-03T09:00:00.000Z',
  headcount: {
    // Deliberately not any term of the rate, and deliberately a memorable number: this is the
    // population the hover used to quote by mistake.
    total: 1163,
    active: 6,
    onboarding: 0,
    exited: 446,
    byLifecycle: [],
    byEmployment: [],
    tenure: { unknown: 0, under_3m: 0, m3_to_1y: 0, over_1y: 0 },
  },
  pipeline: { stalledAfterDays: 14, inProgress: 0, stages: [], stalled: [] },
  compliance: {
    roster: 717,
    incompleteCount: 8,
    fields: [],
    incomplete: [],
    governmentDocuments: { byStatus: [], roster: 717, withGovDoc: 0, withFile: 0 },
    workByOthers: [],
    workByOthersCount: 0,
  },
  expiries: {
    certifications: { rows: [], expired: 0, within30: 0, within90: 0, within180: 0 },
    documents: { rows: [], expired: 0, within30: 0, within90: 0, within180: 0 },
  },
  capability: {
    coverage: { withSkill: 0, withLanguage: 0, withCertification: 0, roster: 717 },
    skills: [], languages: [], certifications: [], unprofiled: 0,
  },
  deployment: { territories: [], hiringNeeded: [], idleTerritories: [] },
  utilisation: {
    idleAfterDays: 30, idleCount: 0, neverAssigned: 0, idle: [], utilization: [],
    utilizationCounts: { idle: 0, underUtilized: 0, balanced: 0, overUtilized: 0, total: 0 },
    performance: {
      avgRating: null, rated: 0, belowPar: 0, totalAssignments: 4,
      completedAssignments: 4, cancelledAssignments: 0, onTimeCompletions: 4, onTimeRate: 100,
    },
  },
  attrition: {
    totalExits: 27,
    exits90d: 1,
    exits12m: 2,
    terminations: 1,
    joins90d: 0,
    // 2 exits against 6 still on the roster: 2 / (6 + 2) = 25%.
    attritionRate12m: 25,
    averageHeadcount12m: 8,
    undatedExits: 25,
    recent: [],
    ...attrition,
  },
  activity: [],
  actions: [],
});

/** Both pages read their payload from the HR layout's outlet context, so that is what is faked. */
let mockData: HrWorkforceOverview;
jest.mock('./HrLayout', () => ({
  useHr: () => ({ data: mockData, canManage: true, refetch: jest.fn() }),
  resolveHrDestination: (link: string) => link,
}));

const renderPage = (Page: React.FC, data: HrWorkforceOverview) => {
  mockData = data;
  return render(<MemoryRouter><Page /></MemoryRouter>);
};

/** The `title` on the tile carrying this caption — the sentence a clerk gets on hover. */
const hintUnder = (caption: string): string =>
  screen.getByText(caption).parentElement!.getAttribute('title') ?? '';

describe('the attrition percentage, on the screens that print it', () => {
  it('explains the Overview tile with the two numbers it was actually divided by', () => {
    renderPage(HrOverviewPage, payload());

    const hint = hintUnder('Left in the past year');
    const [, exits, roster] = hint.match(/^(\d+) people left in the last 12 months, out of (\d+) on the roster/)!;

    // The hover's own arithmetic has to land on the number printed above it.
    expect(Math.round((Number(exits) / Number(roster)) * 1000) / 10).toBe(25);
    expect(screen.getAllByText('25%').length).toBeGreaterThan(0);
    // And it must be the roster-plus-leavers population, not the every-live-record one sitting in
    // the same payload — quoting that is the original defect.
    expect(Number(roster)).toBe(8);
    expect(hint).not.toContain('1163');
  });

  it('gives the Workload screen the same sentence, because it is the same number', () => {
    const overviewView = renderPage(HrOverviewPage, payload());
    const overview = hintUnder('Left in the past year');
    overviewView.unmount();

    renderPage(HrUtilisationPage, payload());
    const workload = hintUnder('Share of the roster, past year');

    // This screen used to say "as a percentage of the people on the books" and name no numbers,
    // which describes a formula rather than accounting for this figure.
    expect(workload).toBe(overview);
    expect(workload).toContain('out of 8 on the roster');
  });

  it('says on both screens that 25 leavers are missing from the figure', () => {
    for (const Page of [HrOverviewPage, HrUtilisationPage]) {
      const view = renderPage(Page, payload());
      expect(screen.getByText(/25 more people left without a leaving date/)).toBeInTheDocument();
      expect(screen.getByText(/worked out without them/)).toBeInTheDocument();
      view.unmount();
    }
  });

  it('says nothing about missing dates when every leaver has one', () => {
    renderPage(HrOverviewPage, payload({ undatedExits: 0 }));

    expect(screen.queryByText(/without a leaving date/)).not.toBeInTheDocument();
    // The hover stays a clean two numbers rather than trailing an empty caveat.
    expect(hintUnder('Left in the past year')).toBe(
      '2 people left in the last 12 months, out of 8 on the roster over that period',
    );
  });

  it('counts one leaver as a person, on a roster where that is the whole story', () => {
    renderPage(HrOverviewPage, payload({
      exits12m: 1, averageHeadcount12m: 8, attritionRate12m: 12.5, undatedExits: 1,
    }));

    expect(hintUnder('Left in the past year')).toContain('1 person left in the last 12 months');
    expect(screen.getByText(/^1 more person left without a leaving date/)).toBeInTheDocument();
  });
});
