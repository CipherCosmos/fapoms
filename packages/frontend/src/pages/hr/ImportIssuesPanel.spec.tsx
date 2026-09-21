import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportIssuesPanel } from './ImportIssuesPanel';
import { api } from '../../services/api';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
  Link: () => null,
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
}));
jest.mock('../../components/ui', () => ({
  useToast: () => ({ toast: jest.fn() }),
  AlertBanner: ({ message, children }: any) => (message || children ? <div role="alert">{message ?? children}</div> : null),
}));

const mockRequest = api.request as jest.Mock;

/**
 * The review-queue panel, pinned on the property that used to fail silently: the header must
 * own up to rows the server did not send. `openCount` is a full count while the list is capped
 * (500 today, 200 before), so at 283 open findings the old panel headlined a number whose last
 * 83 rows simply were not there — nothing on screen said so. And now that the data-integrity
 * scan writes into the same queue, the copy can no longer claim everything here is an
 * unreadable import cell.
 */

const issue = (over: Partial<Record<string, unknown>> & { id: string }) => ({
  sourceSheet: 'Data integrity',
  sourceRow: 0,
  sourceColumn: 'No date of birth · AS0001',
  rawValue: 'no date of birth',
  reason: 'AS0001 (Person One) has no date of birth on the record.',
  sourceAssayerCode: 'AS0001',
  assayer: { id: 'a-1', assayerCode: 'AS0001', firstName: 'Person', lastName: 'One' },
  ...over,
});

/**
 * The panel reads the queue through react-query now, so the badge in the tab strip and the list
 * on the page share one response instead of fetching the same URL twice and disagreeing. A fresh
 * client per test keeps one test's cached queue out of the next one's.
 */
const renderPanel = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

beforeEach(() => mockRequest.mockReset());

describe('ImportIssuesPanel', () => {
  it('says "showing X of Y" when the server sent fewer rows than are open — nothing hidden silently', async () => {
    mockRequest.mockResolvedValue({
      rows: [issue({ id: 'i-1' }), issue({ id: 'i-2', sourceColumn: 'No region on the record · AS0002', sourceAssayerCode: 'AS0002' })],
      openCount: 8,
    });

    renderPanel(<ImportIssuesPanel canManage={false} />);

    await waitFor(() => expect(screen.getByText(/8 record problems to review/)).toBeInTheDocument());
    expect(screen.getByText(/showing 2 of 8/)).toBeInTheDocument();
    // The grouping underneath only ever sees this same capped page, so "2 distinct problems" has
    // to own up to being a count of the page, not of everything open.
    expect(screen.getByText(/2 distinct problems in this page/)).toBeInTheDocument();
  });

  it('claims no shortfall when every open row is on screen', async () => {
    mockRequest.mockResolvedValue({ rows: [issue({ id: 'i-1' })], openCount: 1 });

    renderPanel(<ImportIssuesPanel canManage={false} />);

    await waitFor(() => expect(screen.getByText(/1 record problem to review/)).toBeInTheDocument());
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument();
    // Nothing is missing here, so "One distinct problem" needs no page caveat either.
    expect(screen.getByText(/One distinct problem/)).toBeInTheDocument();
    expect(screen.queryByText(/in this page/)).not.toBeInTheDocument();
  });

  it('no longer claims everything is an unreadable import cell — scanner findings share this queue', async () => {
    mockRequest.mockResolvedValue({ rows: [issue({ id: 'i-1' })], openCount: 1 });

    renderPanel(<ImportIssuesPanel canManage={false} />);

    await waitFor(() => expect(screen.getByText(/checks failing on live records/)).toBeInTheDocument());
    expect(screen.queryByText(/from the roster import could not be read/)).not.toBeInTheDocument();
  });

  it('keeps the grouping: two rows with the same problem are one line with both people behind it', async () => {
    mockRequest.mockResolvedValue({
      rows: [
        issue({ id: 'i-1', sourceSheet: 'Assayers', sourceColumn: 'Active / Inactive', rawValue: '???', reason: 'Could not be read.' }),
        issue({
          id: 'i-2', sourceSheet: 'Assayers', sourceColumn: 'Active / Inactive', rawValue: '???', reason: 'Could not be read.',
          sourceAssayerCode: 'AS0002', assayer: { id: 'a-2', assayerCode: 'AS0002', firstName: 'Person', lastName: 'Two' },
        }),
      ],
      openCount: 2,
    });

    renderPanel(<ImportIssuesPanel canManage={false} />);

    await waitFor(() => expect(screen.getByText(/One distinct problem/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/2 record problems to review/));
    // One row in the list — the detail beside it names the same count, so scope to the list.
    const list = await screen.findByTestId('queue-group-list');
    expect(within(list).getByText(/2 people/)).toBeInTheDocument();
  });

  it('renders nothing at all while the queue is empty', async () => {
    mockRequest.mockResolvedValue({ rows: [], openCount: 0 });

    const { container } = renderPanel(<ImportIssuesPanel canManage={false} />);

    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  /**
   * The scanner keys one row per person per check — `source_column` is "<title> · <code>",
   * because the queue's unique constraint is (sheet, column) and each person's finding has to be
   * closable on its own. Grouped on the raw column, its 133 findings are 133 groups of one, and
   * the panel degenerates into the flat list grouping exists to prevent: 67 separate lines all
   * reading "no date of birth" with a single name beside each.
   */
  describe('grouping a scan finding', () => {
    const scan = (id: string, code: string, reason: string) => issue({
      id,
      sourceSheet: 'Data integrity',
      sourceColumn: `No date of birth · ${code}`,
      rawValue: 'no date of birth',
      reason,
      sourceAssayerCode: code,
      assayer: { id: `a-${code}`, assayerCode: code, firstName: 'Person', lastName: code },
    });

    it('collects one check into one line, however many people are behind it', async () => {
      mockRequest.mockResolvedValue({
        rows: [
          scan('i-1', 'AS0001', 'AS0001 (Person One) has no date of birth on the record.'),
          scan('i-2', 'AS0002', 'AS0002 (Person Two) has no date of birth on the record.'),
          scan('i-3', 'AS0003', 'AS0003 (Person Three) has no date of birth on the record.'),
        ],
        openCount: 3,
      });

      renderPanel(<ImportIssuesPanel canManage={false} />);

      await waitFor(() => expect(screen.getByText(/One distinct problem/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/3 record problems to review/));
      // One heading carrying the check's name — the appraiser code is on the person chip, not
      // in the heading. Scoped to the list; the detail beside it shows the same title.
      const list = await screen.findByTestId('queue-group-list');
      expect(within(list).getByText('No date of birth')).toBeInTheDocument();
      expect(within(list).getByText(/3 people/)).toBeInTheDocument();
      expect(within(list).queryByText(/No date of birth · AS0001/)).not.toBeInTheDocument();
    });

    it('labels the one sentence it can show as an example, not as a description of all of them', async () => {
      mockRequest.mockResolvedValue({
        rows: [
          scan('i-1', 'AS0001', 'AS0001 (Person One) has no date of birth on the record.'),
          scan('i-2', 'AS0002', 'AS0002 (Person Two) has no date of birth on the record.'),
        ],
        openCount: 2,
      });

      renderPanel(<ImportIssuesPanel canManage={false} />);
      await waitFor(() => expect(screen.getByText(/2 record problems to review/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/2 record problems to review/));

      // Each row says something different about its own person, so the first row's sentence is
      // an example — unlabelled it reads as a statement about the whole group.
      await waitFor(() => expect(screen.getByText(/For example:/)).toBeInTheDocument());
    });

    it('does not fold two different checks together', async () => {
      mockRequest.mockResolvedValue({
        rows: [
          scan('i-1', 'AS0001', 'AS0001 (Person One) has no date of birth on the record.'),
          issue({
            id: 'i-2',
            sourceSheet: 'Data integrity',
            sourceColumn: 'Home pin is a placeholder, not a home · AS0002',
            rawValue: 'state centroid',
            reason: 'AS0002 (Person Two) has a home pin that is the middle of the state.',
            sourceAssayerCode: 'AS0002',
            assayer: { id: 'a-2', assayerCode: 'AS0002', firstName: 'Person', lastName: 'Two' },
          }),
        ],
        openCount: 2,
      });

      renderPanel(<ImportIssuesPanel canManage={false} />);

      await waitFor(() => expect(screen.getByText(/2 distinct problems/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/2 record problems to review/));
      const list = await screen.findByTestId('queue-group-list');
      expect(within(list).getByText('No date of birth')).toBeInTheDocument();
      expect(within(list).getByText('Home pin is a placeholder, not a home')).toBeInTheDocument();
    });

    it('still splits import cells by the text in them — two unreadable words are two decisions', async () => {
      mockRequest.mockResolvedValue({
        rows: [
          issue({ id: 'i-1', sourceSheet: 'Assayers', sourceColumn: 'Active / Inactive', rawValue: '???', reason: 'Could not be read.' }),
          issue({
            id: 'i-2', sourceSheet: 'Assayers', sourceColumn: 'Active / Inactive', rawValue: 'N/A', reason: 'Could not be read.',
            sourceAssayerCode: 'AS0002', assayer: { id: 'a-2', assayerCode: 'AS0002', firstName: 'Person', lastName: 'Two' },
          }),
        ],
        openCount: 2,
      });

      renderPanel(<ImportIssuesPanel canManage={false} />);

      await waitFor(() => expect(screen.getByText(/2 distinct problems/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/2 record problems to review/));
      const list = await screen.findByTestId('queue-group-list');
      expect(within(list).getByText(/“\?\?\?” —/)).toBeInTheDocument();
      expect(within(list).getByText(/“N\/A” —/)).toBeInTheDocument();
    });
  });

  /**
   * Closing a group ran a sequential loop of individual POSTs inside one `try`, so the first
   * failure threw: everything after it was never attempted, everything before it had already
   * been closed on the server, and the operator saw one generic red toast. "Two closed, one
   * refused" was indistinguishable from "nothing closed" — and pressing the button again
   * re-posted the two that had worked.
   */
  describe('closing a group', () => {
    const group = {
      rows: [
        issue({ id: 'i-1', sourceSheet: 'Assayers', sourceColumn: 'Active / Inactive', rawValue: '???', reason: 'Could not be read.' }),
        issue({
          id: 'i-2', sourceSheet: 'Assayers', sourceColumn: 'Active / Inactive', rawValue: '???', reason: 'Could not be read.',
          sourceAssayerCode: 'AS0002', assayer: { id: 'a-2', assayerCode: 'AS0002', firstName: 'Person', lastName: 'Two' },
        }),
        issue({
          id: 'i-3', sourceSheet: 'Assayers', sourceColumn: 'Active / Inactive', rawValue: '???', reason: 'Could not be read.',
          sourceAssayerCode: 'AS0003', assayer: { id: 'a-3', assayerCode: 'AS0003', firstName: 'Person', lastName: 'Three' },
        }),
      ],
      openCount: 3,
    };

    const BATCH_URL = '/assayers/roster/import-issues/resolve';
    const batchCalls = () => mockRequest.mock.calls.filter(([url]) => url === BATCH_URL);
    const perIdCalls = () => mockRequest.mock.calls.filter(([url]) => /import-issues\/[^/]+\/resolve$/.test(String(url)));

    /**
     * Lists the queue, and answers the batch route. `outcome` decides each id the way the server
     * does — per id — or `refuse` fails the whole request, as a region refusal or a dropped
     * connection does.
     */
    const serveBatch = (
      opts: { outcome?: (id: string) => { resolved: boolean; reason?: string }; refuse?: Error } = {},
    ) => {
      mockRequest.mockImplementation((url: string, init?: { body?: string }) => {
        if (url !== BATCH_URL) return Promise.resolve(group);
        if (opts.refuse) return Promise.reject(opts.refuse);
        const { ids } = JSON.parse(String(init?.body));
        const decide = opts.outcome ?? (() => ({ resolved: true }));
        return Promise.resolve({ results: ids.map((id: string) => ({ id, ...decide(id) })) });
      });
    };

    const openTheDecideForm = async () => {
      renderPanel(<ImportIssuesPanel canManage />);
      await waitFor(() => expect(screen.getByText(/3 record problems to review/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/3 record problems to review/));
      // The first group is selected on open, so its decision form is already on screen.
      fireEvent.change(await screen.findByLabelText(/What was decided/), {
        target: { value: 'Availability note in the wrong column — ignore.' },
      });
    };

    /**
     * It sent one POST per cell, all at once — 68 requests for one unreadable word on 68 rows —
     * while `POST …/import-issues/resolve` takes the whole group and answers per id.
     */
    it('closes the whole group in one request carrying every cell and the one decision', async () => {
      serveBatch();

      await openTheDecideForm();
      fireEvent.click(screen.getByRole('button', { name: /Close 3 cells/ }));

      await waitFor(() => expect(batchCalls()).toHaveLength(1));
      expect(JSON.parse(batchCalls()[0][1].body)).toEqual({
        ids: ['i-1', 'i-2', 'i-3'], resolution: 'Availability note in the wrong column — ignore.',
      });
      expect(perIdCalls()).toHaveLength(0);
    });

    it('reports what closed and what did not, naming each cell the server would not close', async () => {
      serveBatch({ outcome: (id) => (id === 'i-3' ? { resolved: false, reason: 'Already closed by somebody else.' } : { resolved: true }) });

      await openTheDecideForm();
      fireEvent.click(screen.getByRole('button', { name: /Close 3 cells/ }));

      await waitFor(() => expect(screen.getByText(/2 cells closed; 1 cell could not be/)).toBeInTheDocument());
      expect(screen.getByText(/AS0003 — Already closed by somebody else/)).toBeInTheDocument();
      // The reader must not re-run the two that worked.
      expect(screen.getByText(/do not need doing again/)).toBeInTheDocument();
    });

    /**
     * The route refuses the WHOLE request when any id is outside the caller's regions. Reporting
     * that as a generic failure — or worse, as success — would leave the reader guessing which
     * cells closed. None did, and the panel says so against each.
     */
    it('reports every cell as not closed when the server refuses the whole request', async () => {
      serveBatch({ refuse: new Error('One of these is outside your regions.') });

      await openTheDecideForm();
      fireEvent.click(screen.getByRole('button', { name: /Close 3 cells/ }));

      await waitFor(() => expect(screen.getByText(/0 cells closed; 3 cells could not be/)).toBeInTheDocument());
    });

    it('refuses a blank account of what was decided, in the form rather than in a toast', async () => {
      serveBatch();

      renderPanel(<ImportIssuesPanel canManage />);
      await waitFor(() => expect(screen.getByText(/3 record problems to review/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/3 record problems to review/));
      fireEvent.click(await screen.findByRole('button', { name: /Close 3 cells/ }));

      expect(screen.getByRole('alert')).toHaveTextContent(/Say what was decided/);
      // And nothing was posted — a blank close would put the guess back with no record of it.
      expect(batchCalls()).toHaveLength(0);
      expect(perIdCalls()).toHaveLength(0);
    });

    it('says nothing about failures when every cell closed', async () => {
      serveBatch();

      await openTheDecideForm();
      fireEvent.click(screen.getByRole('button', { name: /Close 3 cells/ }));

      await waitFor(() => expect(batchCalls()).toHaveLength(1));
      expect(screen.queryByText(/could not be/)).not.toBeInTheDocument();
    });
  });

  /**
   * The queue is written per person per check, so one person lands under as many headings as
   * they have problems. Filed by person, each one appears once with everything open against
   * them — the shape the fix takes, since the record is opened and corrected once.
   */
  describe('filing the queue by person', () => {
    const personIssue = (id: string, column: string, reason: string) => issue({
      id,
      sourceSheet: 'Data integrity',
      sourceColumn: `${column} · AS0001`,
      rawValue: column.toLowerCase(),
      reason,
      sourceAssayerCode: 'AS0001',
      assayer: { id: 'a-1', assayerCode: 'AS0001', firstName: 'Person', lastName: 'One' },
    });
    const serveTwoPeople = () => {
      mockRequest.mockResolvedValue({
        rows: [
          personIssue('i-1', 'No date of birth', 'AS0001 (Person One) has no date of birth on the record.'),
          personIssue('i-2', 'No phone number on the record', 'AS0001 (Person One) has no phone number on the record.'),
          issue({
            id: 'i-3', sourceSheet: 'Assayers', sourceColumn: 'Active / Inactive', rawValue: '???',
            reason: 'Could not be read.', sourceAssayerCode: 'AS0002',
            assayer: { id: 'a-2', assayerCode: 'AS0002', firstName: 'Person', lastName: 'Two' },
          }),
        ],
        openCount: 3,
      });
    };

    const openPersonView = async () => {
      renderPanel(<ImportIssuesPanel canManage />);
      await waitFor(() => expect(screen.getByText(/3 record problems to review/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/3 record problems to review/));
      fireEvent.click(screen.getByRole('button', { name: /By person/ }));
    };

    it('lists each person once, with everything open against them behind the row', async () => {
      serveTwoPeople();
      await openPersonView();

      await waitFor(() => expect(screen.getByRole('button', { name: /AS0001 — Person One/ })).toBeInTheDocument());
      // Both of their checks named on the one row, not two rows in two places.
      expect(screen.getByText(/No date of birth · No phone number on the record/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /2 open issues/ })).toBeInTheDocument();
    });

    it('closes everything for the person in one pass', async () => {
      serveTwoPeople();
      await openPersonView();

      fireEvent.click(await screen.findByRole('button', { name: /AS0001 — Person One/ }));
      fireEvent.change(screen.getByLabelText(/What was decided/), {
        target: { value: 'Corrected on their record while it was open.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Close 2 issues/ }));

      // One batch request carrying both of this person's entries — and not the other person's.
      await waitFor(() => {
        const posted = mockRequest.mock.calls.filter(([url]) => url === '/assayers/roster/import-issues/resolve');
        expect(posted).toHaveLength(1);
        expect(JSON.parse(posted[0][1].body).ids).toEqual(['i-1', 'i-2']);
      });
    });

    it('separates import cells from data checks, so each writer is worked its own way', async () => {
      serveTwoPeople();
      renderPanel(<ImportIssuesPanel canManage={false} />);
      await waitFor(() => expect(screen.getByText(/3 record problems to review/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/3 record problems to review/));

      fireEvent.click(screen.getByRole('button', { name: /Import cells/ }));
      const list = screen.getByTestId('queue-group-list');
      expect(within(list).queryByText('No date of birth')).not.toBeInTheDocument();
      expect(within(list).getByText('Active / Inactive')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Data checks/ }));
      expect(within(list).queryByText('Active / Inactive')).not.toBeInTheDocument();
      expect(within(list).getByText('No date of birth')).toBeInTheDocument();
    });

    it('finds one problem in a long list by search', async () => {
      serveTwoPeople();
      renderPanel(<ImportIssuesPanel canManage={false} />);
      await waitFor(() => expect(screen.getByText(/3 record problems to review/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/3 record problems to review/));

      fireEvent.change(screen.getByLabelText(/Find a problem/), { target: { value: 'phone number' } });

      const list = screen.getByTestId('queue-group-list');
      expect(within(list).queryByText('No date of birth')).not.toBeInTheDocument();
      expect(within(list).getByText('No phone number on the record')).toBeInTheDocument();
      expect(screen.getByText(/1 matching problem/)).toBeInTheDocument();
    });
  });
});
