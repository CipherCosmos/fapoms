import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useImportJob, summariseImport, ImportReport } from './useImportJob';
import { ImportProgressPanel } from './ImportProgressPanel';
import { api } from '../../services/api';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

/**
 * The import lifetime, pinned.
 *
 * Every bug this hook exists to fix was a screen treating an import as a request that returns:
 * the Branches page awaited an inline import of 3,759 rows and timed out; the Projects page got a
 * `202` with a job id and answered "Branches uploaded." at the moment the work started. Both are
 * covered below as the behaviours they should have had.
 */

/** A harness that renders the hook's phase through the real panel, as the pages do. */
const Harness: React.FC<{ url: string; file: File }> = ({ url, file }) => {
  const job = useImportJob();
  return (
    <div>
      <button onClick={() => void job.start(url, file)}>upload</button>
      <span data-testid="phase">{job.state.phase}</span>
      <span data-testid="busy">{String(job.busy)}</span>
      <ImportProgressPanel state={job.state} onDismiss={job.reset} />
    </div>
  );
};

const file = () => new File(['x'], 'branches.xlsx');

const REPORT: ImportReport = {
  totalRows: 3, created: 2, updated: 1, linked: 0, skipped: [], imprecise: [],
};

beforeEach(() => {
  jest.useFakeTimers();
  mockRequest.mockReset();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

const click = async () => {
  await act(async () => {
    screen.getByText('upload').click();
  });
};

describe('useImportJob — a small file that finishes inside the request', () => {
  it('goes straight to done and reports what it did', async () => {
    mockRequest.mockResolvedValueOnce(REPORT);
    render(<Harness url="/branches/import/c-1" file={file()} />);
    await click();

    expect(screen.getByTestId('phase')).toHaveTextContent('done');
    expect(screen.getByText(/3 row\(s\) read: 2 created, 1 updated/)).toBeInTheDocument();
  });
});

describe('useImportJob — a large file the server queues', () => {
  const queued = {
    queued: true, jobId: '42', statusUrl: '/branches/import/c-1/jobs/42',
    totalRows: 3759, message: 'This file has 3759 row(s)…',
  };

  it('does not claim the import is finished when the server has only accepted it', async () => {
    mockRequest.mockResolvedValueOnce(queued).mockResolvedValue({
      state: 'active', progress: null, result: null, error: null, totalRows: 3759,
    });
    render(<Harness url="/branches/import/c-1" file={file()} />);
    await click();

    // The exact bug on the Projects page: 202 was read as success.
    expect(screen.getByTestId('phase')).toHaveTextContent('running');
    expect(screen.queryByText(/uploaded\./i)).not.toBeInTheDocument();
    expect(screen.getByTestId('busy')).toHaveTextContent('true');
  });

  it('shows how far it has got, from the job\'s own counters', async () => {
    mockRequest.mockResolvedValueOnce(queued).mockResolvedValue({
      state: 'active',
      progress: { processed: 1000, total: 3759, created: 900, updated: 100, linked: 0, skipped: 0, imprecise: 0 },
      result: null, error: null, totalRows: 3759,
    });
    render(<Harness url="/branches/import/c-1" file={file()} />);
    await click();
    await act(async () => { jest.advanceTimersByTime(2100); });

    await waitFor(() => expect(screen.getByText(/1000 of 3759 rows/)).toBeInTheDocument());
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '27');
  });

  it('lands on the finished report once the job completes', async () => {
    mockRequest
      .mockResolvedValueOnce(queued)
      .mockResolvedValueOnce({ state: 'active', progress: null, result: null, error: null, totalRows: 3759 })
      .mockResolvedValue({ state: 'completed', progress: null, result: REPORT, error: null, totalRows: 3 });

    render(<Harness url="/branches/import/c-1" file={file()} />);
    await click();
    await act(async () => { jest.advanceTimersByTime(2100); });
    await act(async () => { jest.advanceTimersByTime(2100); });

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('done'));
    expect(screen.getByTestId('busy')).toHaveTextContent('false');
  });

  /**
   * A dropped poll is not a failed import — the job keeps running on the server. Reporting failure
   * here would repeat, from the other direction, the lie the old inline timeout told.
   */
  it('keeps waiting when a status check fails', async () => {
    mockRequest
      .mockResolvedValueOnce(queued)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ state: 'completed', progress: null, result: REPORT, error: null, totalRows: 3 });

    render(<Harness url="/branches/import/c-1" file={file()} />);
    // The first poll runs as soon as the job is accepted, so the rejection has already been
    // handled here: still `running`, not `error`.
    await click();
    expect(screen.getByTestId('phase')).toHaveTextContent('running');

    // ...and the retry two seconds later finds the finished job.
    await act(async () => { jest.advanceTimersByTime(2100); });
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('done'));
  });

  it('reports a job the server marked failed, with its reason', async () => {
    mockRequest.mockResolvedValueOnce(queued).mockResolvedValue({
      state: 'failed', progress: null, result: null, error: 'Sheet "Branch" was not found.', totalRows: 3759,
    });
    render(<Harness url="/branches/import/c-1" file={file()} />);
    await click();
    await act(async () => { jest.advanceTimersByTime(2100); });

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('error'));
    expect(screen.getByText(/Sheet "Branch" was not found\./)).toBeInTheDocument();
  });
});

describe('summariseImport', () => {
  /**
   * A file whose headers do not match parses fine and imports nothing. Both pages used to report
   * that in green — "0 created, 0 updated" — which tells an operator their upload worked.
   */
  it('calls a file that produced nothing a failure, not a success', () => {
    const s = summariseImport({ totalRows: 400, created: 0, updated: 0, skipped: [], imprecise: [] });
    expect(s.tone).toBe('error');
    expect(s.text).toMatch(/column headings probably do not match/);
  });

  it('names the rows it could not use rather than counting them', () => {
    const s = summariseImport({
      totalRows: 2, created: 1, updated: 0,
      skipped: [{ row: 7, reason: "Could not verify 'Gujrat' as a real state." }],
      imprecise: [],
    });
    expect(s.tone).toBe('error');
    expect(s.text).toContain('row 7');
    expect(s.text).toContain('Gujrat');
  });

  /**
   * An imprecisely located branch DID import — it just cannot be planned or checked into until
   * someone corrects where it is. A warning on a successful import, not a failure.
   */
  it('warns about imprecise rows without calling the import a failure', () => {
    const s = summariseImport({
      totalRows: 1, created: 1, updated: 0, skipped: [],
      imprecise: [{ row: 2, reason: 'placed to about 15 km' }],
    });
    expect(s.tone).toBe('warning');
    expect(s.text).toContain('could not be located precisely');
  });

  /**
   * The case that motivated `unchanged`: re-uploading a sheet to check it landed.
   *
   * `updated` counts real changes only — an identical re-import writes nothing, which is correct —
   * so this outcome arrives as `created: 0, updated: 0`, exactly like a file whose column headings
   * did not match. Reported as "your headings are wrong", it sends an operator to fix a file that
   * is already perfect. Verified against the running server: a second upload of the same workbook
   * returns 0 created, 0 updated.
   */
  it('says "already up to date" rather than "your headings are wrong" for an unchanged re-import', () => {
    const s = summariseImport({
      totalRows: 2, created: 0, updated: 0, unchanged: 2, skipped: [], imprecise: [],
    });
    expect(s.tone).toBe('success');
    expect(s.text).toMatch(/Already up to date/);
  });

  it('still calls a file that matched nothing at all a failure', () => {
    const s = summariseImport({
      totalRows: 400, created: 0, updated: 0, unchanged: 0, skipped: [], imprecise: [],
    });
    expect(s.tone).toBe('error');
    expect(s.text).toMatch(/column headings probably do not match/);
  });

  it('mentions the up-to-date rows alongside the changed ones', () => {
    const s = summariseImport({
      totalRows: 10, created: 3, updated: 1, unchanged: 6, skipped: [], imprecise: [],
    });
    expect(s.text).toContain('6 already up to date');
  });

  /**
   * Restoring an archived branch puts it back into every list, every plan and every future import
   * match. Before, the importer could not even see an archived branch — it created a second one
   * beside it — so there was nothing to report. Now that it restores instead, the operator has to
   * be told, in the headline rather than behind a disclosure.
   */
  it('names restored branches in the headline, not only in a section', () => {
    const s = summariseImport({
      totalRows: 1, created: 0, updated: 1, skipped: [], imprecise: [],
      revived: [{ row: 2, solId: 'BR-1', reason: '"Thenkurissi" was archived and has been restored.' }],
    });
    expect(s.text).toContain('1 archived branch(es) restored');
    expect(s.sections?.some((x) => /restored/i.test(x.label))).toBe(true);
  });

  it('says nothing about restoring when a server reports no such field', () => {
    const s = summariseImport({ totalRows: 1, created: 1, updated: 0, skipped: [], imprecise: [] });
    expect(s.text).not.toMatch(/restored/i);
  });

  it('mentions project linking only when there is a project', () => {
    expect(summariseImport({ ...REPORT, linked: 3 }).text).toContain('newly linked');
    expect(summariseImport({ ...REPORT, linked: 0 }).text).not.toContain('newly linked');
  });
});
