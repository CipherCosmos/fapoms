import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { HrPayPage } from './HrPayPage';
import { api } from '../../services/api';
import { ONBOARDING_NEXT_STEP } from '@fapoms/shared';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('./HrLayout', () => ({ useHr: () => ({ canManage: true }) }));
const mockRequest = api.request as jest.Mock;

/**
 * Pay & terms, and the four figures at the top of it.
 *
 * This page asked for a thousand rows and then counted them. On a roster of 1,155 that made every
 * tile a count of part of the roster presented as a count of all of it — "On the roster 1,000"
 * under a heading that means everybody, and "Cannot be paid — no bank details" blind to 155 people
 * who might be exactly that. There is no wording that rescues a wrong number, so the fix is the
 * whole roster; the banner below is only for when even that cannot be managed.
 */

const rosterPage = (firstIndex: number, count: number, total: number) => ({
  success: true,
  data: Array.from({ length: count }, (_, i) => ({
    id: `a-${firstIndex + i}`,
    assayerCode: `AS-${firstIndex + i}`,
    displayName: `Person ${firstIndex + i}`,
    district: 'Ernakulam',
    lifecycleStatus: 'ACTIVE',
    bankAccountNumber: null,
    ifscCode: null,
  })),
  meta: { pagination: { total } },
});

/** Routes the two calls the page makes, whatever order they resolve in. */
const serve = (pages: ReturnType<typeof rosterPage>[]) => {
  let next = 0;
  mockRequest.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith('/assayers/commercial/roster') ? [] : pages[next++]),
  );
};

const renderPage = () => render(<MemoryRouter><HrPayPage /></MemoryRouter>);

beforeEach(() => mockRequest.mockReset());

describe('HrPayPage', () => {
  it('counts and lists all 1,155 people, not the thousand the first request returns', async () => {
    serve([rosterPage(1, 1000, 1155), rosterPage(1001, 155, 1155)]);

    renderPage();

    // The tile reads the roster, so it is the count that was silently wrong.
    await waitFor(() => expect(screen.getByText('On the roster').previousSibling).toHaveTextContent('1155'));
    // And the person past the old cut-off has a row to set pay terms on.
    expect(screen.getByText('Person 1100')).toBeInTheDocument();
    expect(screen.queryByText(/could be loaded/)).not.toBeInTheDocument();
  });

  it('says so plainly when part of the roster is missing, rather than quietly counting less', async () => {
    serve([rosterPage(1, 2, 1155), rosterPage(3, 0, 1155)]);

    renderPage();

    await waitFor(() => expect(screen.getByText(/Only 2 of the 1155 people/)).toBeInTheDocument());
    expect(screen.getByText(/leave 1153 out/)).toBeInTheDocument();
  });

  it('shows no warning at all on a roster it loaded in full', async () => {
    serve([rosterPage(1, 6, 6)]);

    renderPage();

    await waitFor(() => expect(screen.getByText('Person 1')).toBeInTheDocument());
    expect(screen.queryByText(/could be loaded/)).not.toBeInTheDocument();
  });
});

/**
 * Somebody still joining is not a pricing omission.
 *
 * `lifecycleStatus` arrived on every row of this page, was declared on the interface, and was
 * then read by nothing — so a trainee sat in the table beside working assayers under the same
 * amber "paid the client default", with nothing to say they cannot be sent anywhere yet.
 */
describe('HrPayPage — people who have not finished joining', () => {
  const joiner = (lifecycleStatus: string) => ({
    success: true,
    data: [{
      id: 'a-1', assayerCode: 'AS-1', displayName: 'New Joiner', district: 'Ernakulam',
      lifecycleStatus, bankAccountNumber: '123', ifscCode: 'ABCD0123456',
    }],
    meta: { pagination: { total: 1 } },
  });

  it('says what has to happen next, in the words the planner already used', async () => {
    serve([joiner('TRAINING') as any]);

    renderPage();

    // Verbatim from ONBOARDING_NEXT_STEP in @fapoms/shared — the sentence the planner prints when
    // it refuses this person work. A second wording here would send a clerk looking for a
    // different instruction than the one that sent them.
    await waitFor(() => expect(
      screen.getByText(`Still joining — ${ONBOARDING_NEXT_STEP.TRAINING}`),
    ).toBeInTheDocument());
  });

  it('says nothing of the sort about somebody who has finished joining', async () => {
    serve([joiner('ACTIVE') as any]);

    renderPage();

    await waitFor(() => expect(screen.getByText('New Joiner')).toBeInTheDocument());
    expect(screen.queryByText(/Still joining/)).not.toBeInTheDocument();
  });
});
