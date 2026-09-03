import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
  });

  it('claims no shortfall when every open row is on screen', async () => {
    mockRequest.mockResolvedValue({ rows: [issue({ id: 'i-1' })], openCount: 1 });

    renderPanel(<ImportIssuesPanel canManage={false} />);

    await waitFor(() => expect(screen.getByText(/1 record problem to review/)).toBeInTheDocument());
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText(/2 people/)).toBeInTheDocument());
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
      // in the heading.
      await waitFor(() => expect(screen.getByText('No date of birth')).toBeInTheDocument());
      expect(screen.getByText(/3 people/)).toBeInTheDocument();
      expect(screen.queryByText(/No date of birth · AS0001/)).not.toBeInTheDocument();
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
      await waitFor(() => expect(screen.getByText('No date of birth')).toBeInTheDocument());
      expect(screen.getByText('Home pin is a placeholder, not a home')).toBeInTheDocument();
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
      await waitFor(() => expect(screen.getByText(/“\?\?\?” —/)).toBeInTheDocument());
      expect(screen.getByText(/“N\/A” —/)).toBeInTheDocument();
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

    /** Lists the queue, and lets each resolve POST be decided by `resolve`. */
    const serveWithResolves = (resolve: (id: string) => Promise<unknown>) => {
      mockRequest.mockImplementation((url: string) => {
        const m = url.match(/import-issues\/([^/]+)\/resolve$/);
        return m ? resolve(m[1]) : Promise.resolve(group);
      });
    };

    const openTheDecideForm = async () => {
      renderPanel(<ImportIssuesPanel canManage />);
      await waitFor(() => expect(screen.getByText(/3 record problems to review/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/3 record problems to review/));
      fireEvent.click(await screen.findByText('Decide this'));
      fireEvent.change(screen.getByLabelText(/What was decided/), {
        target: { value: 'Availability note in the wrong column — ignore.' },
      });
    };

    it('attempts every cell even after one is refused, rather than stopping at the first', async () => {
      serveWithResolves((id) => (id === 'i-1' ? Promise.reject(new Error('nope')) : Promise.resolve({})));

      await openTheDecideForm();
      fireEvent.click(screen.getByRole('button', { name: /Close 3 cells/ }));

      // The old loop would have thrown on i-1 and never posted i-2 or i-3.
      await waitFor(() => {
        const posted = mockRequest.mock.calls.filter(([url]) => String(url).endsWith('/resolve'));
        expect(posted).toHaveLength(3);
      });
    });

    it('reports what closed and what did not, naming each cell that refused', async () => {
      serveWithResolves((id) => (id === 'i-3' ? Promise.reject(new Error('Row already resolved.')) : Promise.resolve({})));

      await openTheDecideForm();
      fireEvent.click(screen.getByRole('button', { name: /Close 3 cells/ }));

      await waitFor(() => expect(screen.getByText(/2 cells closed; 1 cell could not be/)).toBeInTheDocument());
      expect(screen.getByText(/AS0003 —/)).toBeInTheDocument();
      // The reader must not re-run the two that worked.
      expect(screen.getByText(/do not need doing again/)).toBeInTheDocument();
    });

    it('refuses a blank account of what was decided, in the form rather than in a toast', async () => {
      serveWithResolves(() => Promise.resolve({}));

      renderPanel(<ImportIssuesPanel canManage />);
      await waitFor(() => expect(screen.getByText(/3 record problems to review/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/3 record problems to review/));
      fireEvent.click(await screen.findByText('Decide this'));
      fireEvent.click(screen.getByRole('button', { name: /Close 3 cells/ }));

      expect(screen.getByRole('alert')).toHaveTextContent(/Say what was decided/);
      // And nothing was posted — a blank close would put the guess back with no record of it.
      expect(mockRequest.mock.calls.filter(([url]) => String(url).endsWith('/resolve'))).toHaveLength(0);
    });

    it('says nothing about failures when every cell closed', async () => {
      serveWithResolves(() => Promise.resolve({}));

      await openTheDecideForm();
      fireEvent.click(screen.getByRole('button', { name: /Close 3 cells/ }));

      await waitFor(() => {
        const posted = mockRequest.mock.calls.filter(([url]) => String(url).endsWith('/resolve'));
        expect(posted).toHaveLength(3);
      });
      expect(screen.queryByText(/could not be/)).not.toBeInTheDocument();
    });
  });
});
