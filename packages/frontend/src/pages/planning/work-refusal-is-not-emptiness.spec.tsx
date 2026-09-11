import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fromResponse } from '../../services/errors';

/**
 * On the screens that decide who does what work, a refused read must not be drawn as "no work".
 *
 * These are the sentences that were printed over failures, each of which is an instruction the
 * operator would act on:
 *
 *   - the coverage queue: "No branches in this project yet. Add branches to the project before
 *     visits can be planned for them." — go and import a branch file, told to a planner whose
 *     project already has 155 branches. Planning is region-scoped, so a 403 here is ordinary.
 *   - branch history: `(error as Error).message` in red, whatever the throw happened to carry,
 *     with no way to tell a permission from an outage; and nothing at all when the query paused.
 *   - the assignment queue: a FORBIDDEN branch that could never fire, because it tested
 *     `error.statusCode` and an AppError carries `status`. Every refusal therefore read as an
 *     outage with a Retry button that could only fail the same way.
 *
 * Each test asserts BOTH halves: the refusal is stated, AND the screen's own empty sentence is
 * absent.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({ connectSocket: () => null, disconnectSocket: () => null, getSocket: () => null }));

import { BranchListPanel } from './BranchListPanel';
import { BranchHistoryDrawer } from './BranchHistoryDrawer';
import { AssignmentTable } from '../assignments/AssignmentTable';
import { LoadFailure } from '../../components/LoadFailure';
import { api } from '../../services/api';

const request = api.request as jest.Mock;

const REFUSED = fromResponse(403, { message: 'Forbidden' });
const GONE = fromResponse(404, { message: 'Not Found' });

/** A settled failure, as React Query leaves it. */
const failing = (error: unknown) => ({
  data: undefined, isError: true, isLoading: false, isPending: false, isFetching: false,
  fetchStatus: 'idle' as const, error, refetch: jest.fn(),
});

/** The state a bare `isError` misses: failed, then paused before the next attempt. */
const paused = (error: unknown) => ({
  data: undefined, isError: false, isLoading: false, isPending: true, isFetching: false,
  fetchStatus: 'paused' as const, error: null, failureReason: error, refetch: jest.fn(),
});

function draw(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { request.mockReset(); });

describe('Coverage queue — a refused queue is not an empty project', () => {
  const panel = (failure: React.ReactNode) => (
    <BranchListPanel
      branches={[]}
      selectedBranchId={null}
      onSelectBranch={jest.fn()}
      searchTerm=""
      onSearchTermChange={jest.fn()}
      loading={false}
      failure={failure}
    />
  );

  it.each([
    ['a settled 403', () => failing(REFUSED)],
    ['a paused retry', () => paused(REFUSED)],
  ])('says it was refused rather than "No branches in this project yet" (%s)', (_label, state) => {
    // PlanningWorkspace builds exactly this node from `loadFailed(branchesQuery)`.
    draw(panel(<LoadFailure loads={[{ label: 'the coverage queue', query: state() }]} />));

    expect(screen.getByText(/Could not load the coverage queue/)).toBeInTheDocument();
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    expect(screen.queryByText(/No branches in this project yet/)).not.toBeInTheDocument();
  });

  it('still says the project is empty when it genuinely is', () => {
    draw(panel(null));
    expect(screen.getByText(/No branches in this project yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });
});

describe('Branch history — the reason, in the words the app uses everywhere else', () => {
  it('quotes the translated refusal rather than the raw throw text', async () => {
    request.mockRejectedValue(REFUSED);
    draw(<BranchHistoryDrawer projectBranchId="pb-1" onClose={jest.fn()} />);

    expect(await screen.findByText(/Could not load this branch's history/)).toBeInTheDocument();
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    // The drawer's own "this branch has no history" line must not appear beside the refusal.
    expect(screen.queryByText(/Nothing has happened to this branch yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('says a missing branch is missing, and does not offer to fetch it again', async () => {
    request.mockRejectedValue(GONE);
    draw(<BranchHistoryDrawer projectBranchId="pb-1" onClose={jest.fn()} />);

    expect(await screen.findByText(/could not be found/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe('Assignment queue — the refusal branch that never fired', () => {
  const table = (error: unknown, onRetry = jest.fn()) => (
    <AssignmentTable
      assignments={[]}
      isLoading={false}
      isError
      error={error}
      onRetry={onRetry}
      statusFilter="ALL"
      searchTerm=""
      onResetFilters={jest.fn()}
      onSelectAssignment={jest.fn()}
    />
  );

  it('reads a real 403 as a refusal, not an outage', () => {
    draw(table(REFUSED));
    expect(screen.getByText('Assignment queue access restricted')).toBeInTheDocument();
    expect(screen.queryByText('Could not load assignments queue')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nobody has been given a branch to audit yet/)).not.toBeInTheDocument();
  });

  it('keeps Retry for a 5xx, which retrying could actually clear', () => {
    draw(table(fromResponse(500, { message: 'boom' })));
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('drops Retry for a 404 — the record will not exist on a second try either', () => {
    draw(table(GONE));
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
