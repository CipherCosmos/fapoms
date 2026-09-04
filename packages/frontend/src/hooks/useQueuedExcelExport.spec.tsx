import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { useQueuedExcelExport } from './useQueuedExcelExport';
import { api } from '../services/api';

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

/**
 * Task 5: the four report export buttons now enqueue, poll, and download instead of blocking on
 * a synchronous GET. This pins the three-call shape (`POST .../jobs` → `GET /reports/jobs/:id`
 * repeatedly → `GET /reports/jobs/:id/download`) so a call site cannot silently regress back to
 * hitting the endpoint directly.
 */

let savedAnchor: { href: string; download: string; clicked: boolean } | null = null;

beforeAll(() => {
  const realCreateElement = document.createElement.bind(document);
  jest.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = realCreateElement(tag);
    if (tag === 'a') {
      savedAnchor = { href: '', download: '', clicked: false };
      Object.defineProperty(el, 'href', { set: (v) => { savedAnchor!.href = v; }, get: () => savedAnchor!.href });
      Object.defineProperty(el, 'download', { set: (v) => { savedAnchor!.download = v; }, get: () => savedAnchor!.download });
      el.click = () => { savedAnchor!.clicked = true; };
    }
    return el;
  });
  global.URL.createObjectURL = jest.fn(() => 'blob:fake');
  global.URL.revokeObjectURL = jest.fn();
});

const Harness: React.FC = () => {
  const { download, busy } = useQueuedExcelExport();
  return (
    <div>
      <button onClick={() => void download('/reports/assignments/jobs', { status: 'OPEN' })}>export</button>
      <span data-testid="busy">{String(busy)}</span>
    </div>
  );
};

beforeEach(() => {
  jest.useFakeTimers();
  mockRequest.mockReset();
  savedAnchor = null;
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

const click = async () => {
  await act(async () => {
    screen.getByText('export').click();
  });
};

describe('useQueuedExcelExport', () => {
  it('enqueues with the query params, polls until done, then downloads under the job\'s filename', async () => {
    const blob = new Blob(['x']);
    mockRequest
      .mockResolvedValueOnce({ jobId: 'job-1', deduplicated: false }) // POST .../jobs
      .mockResolvedValueOnce({ // GET jobs/job-1 — still running
        jobId: 'job-1', state: 'running', progress: { percent: 40, stage: 'Building rows' },
      })
      .mockResolvedValueOnce({ // GET jobs/job-1 — done
        jobId: 'job-1', state: 'done', progress: { percent: 100, stage: 'Done' },
        result: { filename: 'assignments_123.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 10 },
      })
      .mockResolvedValueOnce(blob); // GET jobs/job-1/download

    render(<Harness />);
    await click();
    expect(screen.getByTestId('busy')).toHaveTextContent('true');

    // First poll tick — still running.
    await act(async () => { jest.advanceTimersByTime(2000); await Promise.resolve(); });
    // Second poll tick — done, triggers the download call.
    await act(async () => { jest.advanceTimersByTime(2000); await Promise.resolve(); });

    expect(mockRequest).toHaveBeenNthCalledWith(1, '/reports/assignments/jobs?status=OPEN', { method: 'POST' });
    expect(mockRequest).toHaveBeenNthCalledWith(2, '/reports/jobs/job-1');
    expect(mockRequest).toHaveBeenNthCalledWith(3, '/reports/jobs/job-1');
    expect(mockRequest).toHaveBeenNthCalledWith(4, '/reports/jobs/job-1/download', { raw: true });
    expect(savedAnchor?.download).toBe('assignments_123.xlsx');
    expect(savedAnchor?.clicked).toBe(true);
    expect(screen.getByTestId('busy')).toHaveTextContent('false');
  });

  it('surfaces a failed job as a thrown, user-facing error and clears busy', async () => {
    mockRequest
      .mockResolvedValueOnce({ jobId: 'job-2', deduplicated: false })
      .mockResolvedValueOnce({ jobId: 'job-2', state: 'failed', progress: { percent: 0, stage: '' }, error: 'boom' });

    const onError = jest.fn();
    const Failing: React.FC = () => {
      const { download, busy } = useQueuedExcelExport();
      return (
        <div>
          <button onClick={() => { download('/reports/billing/jobs').catch(onError); }}>export</button>
          <span data-testid="busy">{String(busy)}</span>
        </div>
      );
    };
    render(<Failing />);
    await click();
    await act(async () => { await Promise.resolve(); });

    expect(onError).toHaveBeenCalled();
    expect(screen.getByTestId('busy')).toHaveTextContent('false');
  });

  it('omits the query string entirely when no params are given', async () => {
    mockRequest.mockResolvedValueOnce({ jobId: 'job-3', deduplicated: false });
    mockRequest.mockResolvedValueOnce({
      jobId: 'job-3', state: 'done', progress: { percent: 100, stage: 'Done' },
      result: { filename: 'roster.xlsx', mimeType: 'x', sizeBytes: 1 },
    });
    mockRequest.mockResolvedValueOnce(new Blob(['x']));

    const NoParams: React.FC = () => {
      const { download } = useQueuedExcelExport();
      return <button onClick={() => void download('/reports/assayer-roster/jobs')}>export</button>;
    };
    render(<NoParams />);
    await click();
    await act(async () => { await Promise.resolve(); });

    expect(mockRequest).toHaveBeenNthCalledWith(1, '/reports/assayer-roster/jobs', { method: 'POST' });
  });
});
