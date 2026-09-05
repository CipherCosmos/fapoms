import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

const rosterPage = (firstIndex: number, count: number, total: number, nextCursor: string | null = null) => ({
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
  meta: { pagination: { total, nextCursor } },
});

/** Routes the two calls the page makes, whatever order they resolve in. */
const serve = (pages: ReturnType<typeof rosterPage>[]) => {
  let next = 0;
  mockRequest.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith('/assayers/commercial/roster') ? [] : pages[next++]),
  );
};

/**
 * A fresh, retry-free client per render — the page now reads two `useQuery`s instead of a plain
 * `useEffect`/`useState` fetch, so it needs a `QueryClientProvider` the way every other
 * react-query page's spec already supplies one (see Rules.spec.tsx, ImportIssuesPanel.spec.tsx).
 * `retry: false` matters here specifically: this suite's own "cold-cache timeout" flake was the
 * default 3-retry backoff turning one slow/unmatched mock into a `waitFor` that gave up before
 * react-query's own retries had finished, and a client shared across tests would additionally
 * leak one test's cached roster into the next.
 */
const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><HrPayPage /></MemoryRouter></QueryClientProvider>);
};

beforeEach(() => mockRequest.mockReset());

describe('HrPayPage', () => {
  it('counts and lists all 1,155 people, not the thousand the first request returns', async () => {
    serve([rosterPage(1, 1000, 1155, 'cursor-1'), rosterPage(1001, 155, 1155, null)]);

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

/**
 * "Cannot be paid" now reads `cannotBePaid`/`payoutBlockingGaps` from `@fapoms/shared` — the same
 * rulebook the roster's own chip and the server's aggregate read — rather than a page-local
 * `bankMissing` test that only ever looked at the bank account and IFSC. Two things follow: someone
 * who has left is no longer counted as "cannot be paid" (they are gone, not owed a decision), and a
 * missing PAN blocks a payout exactly as hard as a missing account number always did.
 */
describe('HrPayPage — the strict "Cannot be paid" rule', () => {
  const person = (over: Record<string, unknown>) => ({
    success: true,
    data: [{
      id: 'a-1', assayerCode: 'AS-1', displayName: 'Test Person', district: 'Ernakulam',
      lifecycleStatus: 'ACTIVE', bankAccountNumber: '123', ifscCode: 'ABCD0123456', panNumber: 'ABCDE1234F',
      ...over,
    }],
    meta: { pagination: { total: 1 } },
  });

  it('does not count someone who has resigned in the strict tile, even with no bank details on file', async () => {
    serve([person({
      displayName: 'Gone Already', lifecycleStatus: 'RESIGNED', bankAccountNumber: null, ifscCode: null,
    }) as any]);

    renderPage();

    // The old rule never checked lifecycle at all, so this person's empty bank fields alone used
    // to put them in "Cannot be paid" — a count meant for people payroll still owes a decision to.
    await waitFor(() => expect(screen.getByText('Gone Already')).toBeInTheDocument());
    expect(screen.getByText('Cannot be paid').previousSibling).toHaveTextContent('0');
  });

  it('still counts an active person who is missing only their PAN', async () => {
    serve([person({ displayName: 'No Pan On File', panNumber: null }) as any]);

    renderPage();

    await waitFor(() => expect(screen.getByText('No Pan On File')).toBeInTheDocument());
    expect(screen.getByText('Cannot be paid').previousSibling).toHaveTextContent('1');
    expect(screen.getByText('No PAN on file — add it')).toBeInTheDocument();
  });

  it('puts a departed, unbanked person in the looser tile — never under the strict label', async () => {
    serve([person({
      displayName: 'Gone Unbanked', lifecycleStatus: 'RESIGNED', bankAccountNumber: null, ifscCode: null,
    }) as any]);

    renderPage();

    await waitFor(() => expect(screen.getByText('Gone Unbanked')).toBeInTheDocument());
    expect(screen.getByText('Cannot be paid').previousSibling).toHaveTextContent('0');
    expect(screen.getByText('Missing bank details (including people who left)').previousSibling)
      .toHaveTextContent('1');
  });

  it('shows neither tile once every payout-blocking field is on file', async () => {
    serve([person({ displayName: 'Fully Payable' }) as any]);

    renderPage();

    await waitFor(() => expect(screen.getByText('Fully Payable')).toBeInTheDocument());
    expect(screen.getByText('Cannot be paid').previousSibling).toHaveTextContent('0');
    expect(screen.queryByText(/Missing bank details/)).not.toBeInTheDocument();
  });
});
