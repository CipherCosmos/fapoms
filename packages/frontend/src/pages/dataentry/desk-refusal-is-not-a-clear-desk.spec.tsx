import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { SystemRole } from '@fapoms/shared';
import { fromResponse } from '../../services/errors';

/**
 * The data-entry desk is the worst case of the whole defect, because its screens are read as
 * statements about whether there is work.
 *
 * `DataEntryOverview` made five requests and threw away all five failures —
 * `.catch(() => setCounts(null))`, `.catch(() => setActivity([]))`, and so on. There was no error
 * variable on the component at all. A desk head whose requests were failing saw:
 *
 *   - seven tiles reading "…", indefinitely, with nothing to say they never would resolve;
 *   - NO "Needs attention" banner, because `attention` fell back to null — so a desk with items
 *     past their due date looked exactly like a desk with none. Management by exception, with the
 *     exception silently removed;
 *   - "Nothing has happened on the desk yet", off an activity list that defaulted to `[]`.
 *
 * The queues beneath it did the same in their own words: "No packets in this lane", "No report is
 * waiting to be reviewed", "Nothing is waiting on you", "Nothing has been said on this question
 * yet" — that last one under an invitation to type the first message, on a clarification the field
 * assayer may already have answered.
 *
 * One thing was already right and stays right: "Nothing needs doing right now" requires every
 * figure to have ARRIVED as a number, so it could not be printed over a failure. It is asserted
 * here so a later refactor cannot quietly loosen it.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({
  connectSocket: () => null, disconnectSocket: () => null, getSocket: () => null,
}));

import { api } from '../../services/api';
import { DataEntryOverview } from './DataEntryOverview';
import { ThreadPanel } from './ThreadPanel';

const request = api.request as jest.Mock;

const REFUSED = fromResponse(403, { message: 'Forbidden' });

/** Sign in as a desk head, which is what `deskRole` reads out of the user cache. */
function asDeskHead() {
  localStorage.setItem('fapoms_user_cache', JSON.stringify({ roles: [SystemRole.DESK] }));
}

const draw = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

// jsdom does not implement scrollIntoView; ThreadPanel calls it on every message-list update.
beforeAll(() => { (Element.prototype as any).scrollIntoView = jest.fn(); });

beforeEach(() => {
  request.mockReset();
  localStorage.clear();
});

describe('Desk overview — five swallowed failures', () => {
  it('names what could not be read, instead of showing seven tiles of "…" and nothing else', async () => {
    asDeskHead();
    request.mockRejectedValue(REFUSED);
    draw(<DataEntryOverview />);

    await waitFor(() => expect(screen.getByText(/Could not load/)).toBeInTheDocument());
    // Each of the four head-side requests is named by what it feeds, not by its URL.
    expect(screen.getByText(/the packet counts/)).toBeInTheDocument();
    expect(screen.getByText(/the review workload/)).toBeInTheDocument();
    expect(screen.getByText(/what is past its due date/)).toBeInTheDocument();
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
  });

  it('does not report an unread activity log as a desk that has done nothing', async () => {
    asDeskHead();
    request.mockRejectedValue(REFUSED);
    draw(<DataEntryOverview />);

    await waitFor(() => expect(screen.getByText(/Could not load/)).toBeInTheDocument());
    expect(screen.queryByText(/Nothing has happened on the desk yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/This is not saying the desk has been idle/)).toBeInTheDocument();
  });

  it('never claims "Nothing needs doing right now" when the figures never arrived', async () => {
    asDeskHead();
    request.mockRejectedValue(REFUSED);
    draw(<DataEntryOverview />);

    await waitFor(() => expect(screen.getByText(/Could not load/)).toBeInTheDocument());
    expect(screen.queryByText('Nothing needs doing right now.')).not.toBeInTheDocument();
  });

  it('still gives the all-clear on a desk that genuinely has nothing on it', async () => {
    asDeskHead();
    request.mockImplementation((url: string) => {
      if (url.startsWith('/documents/data-entry/queue')) {
        return Promise.resolve({ counts: { unassigned: 0, working: 0, rework: 0, done: 0 }, total: 0, page: 1, limit: 1, items: [] });
      }
      if (url === '/validation/workload') {
        return Promise.resolve({ totals: { inReview: 0, unroutedReviews: 0, approved: 0, openClarifications: 0 }, members: [] });
      }
      if (url.startsWith('/validation/activity')) return Promise.resolve([]);
      if (url === '/validation/attention') return Promise.resolve({});
      return Promise.resolve([]);
    });
    draw(<DataEntryOverview />);

    await waitFor(() => expect(screen.getByText('Nothing needs doing right now.')).toBeInTheDocument());
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing has happened on the desk yet/)).toBeInTheDocument();
  });

  it('reports only the request that failed, leaving the ones that worked unmentioned', async () => {
    asDeskHead();
    request.mockImplementation((url: string) => {
      if (url === '/validation/attention') return Promise.reject(REFUSED);
      if (url.startsWith('/documents/data-entry/queue')) {
        return Promise.resolve({ counts: { unassigned: 2, working: 1, rework: 0, done: 0 }, total: 3, page: 1, limit: 1, items: [] });
      }
      if (url === '/validation/workload') {
        return Promise.resolve({ totals: { inReview: 0, unroutedReviews: 0, approved: 0, openClarifications: 0 }, members: [] });
      }
      return Promise.resolve([]);
    });
    draw(<DataEntryOverview />);

    await waitFor(() => expect(screen.getByText(/what is past its due date/)).toBeInTheDocument());
    expect(screen.queryByText(/the packet counts/)).not.toBeInTheDocument();
    expect(screen.queryByText(/the review workload/)).not.toBeInTheDocument();
  });
});

describe('Clarification thread — a refused thread is not a new one', () => {
  it('does not invite a second question over a conversation it could not read', async () => {
    request.mockRejectedValue(REFUSED);
    draw(
      <ThreadPanel
        queryId="q-1"
        status="OPEN"
        pending={null}
        onClearPending={jest.fn()}
        onFocusRegion={jest.fn()}
        onResolved={jest.fn()}
        onChanged={jest.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Could not load this conversation/)).toBeInTheDocument());
    expect(screen.queryByText('Nothing has been said on this question yet.')).not.toBeInTheDocument();
  });

  it('still says the thread is new when it genuinely is', async () => {
    request.mockResolvedValue([]);
    draw(
      <ThreadPanel
        queryId="q-1"
        status="OPEN"
        pending={null}
        onClearPending={jest.fn()}
        onFocusRegion={jest.fn()}
        onResolved={jest.fn()}
        onChanged={jest.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('Nothing has been said on this question yet.')).toBeInTheDocument());
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });
});
