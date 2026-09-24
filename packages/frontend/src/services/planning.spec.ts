import {
  executeCoveragePlan,
  getCoveragePlanPreview,
  createCoveragePlan,
  getDayPlans,
  offerBranchesInBulk,
  markBranchesUnableToCover,
  buildRouteOptimizePayload,
  optimizeRoute,
  getProjects,
} from './planning';
import { api } from './api';
import { waitForQueuedJob } from './queued-job';

/**
 * THE PLANNING SCREENS START SERVER JOBS AND POLL THEM; THEY DO NOT HOLD A REQUEST OPEN FOR THE WORK.
 *
 * Deploying a coverage plan did every assignment inside one request, past the client's 30 s: the
 * screen said the deploy failed while the server carried on, and the operator pressed Deploy again.
 * The coverage preview and day plans ran the recommendation engine per branch inside a GET although
 * queued twins existed. The bulk offer and bulk unable-to-cover were browser loops of one POST per
 * branch, past the per-user rate limit. What must not regress: each of these is ONE POST to a job
 * route, then polls of the right status route — read jobs and write jobs are numbered separately, so
 * polling the wrong one reads somebody else's job id space — and the result is the job's result.
 */

jest.mock('./api', () => ({ api: { request: jest.fn() } }));
jest.mock('./queued-job', () => {
  const actual = jest.requireActual('./queued-job');
  return {
    ...actual,
    waitForQueuedJob: jest.fn((path: string, opts: Record<string, unknown> = {}) =>
      actual.waitForQueuedJob(path, { ...opts, pollMs: 1 })),
  };
});

const mockRequest = api.request as jest.Mock;
const mockWait = waitForQueuedJob as jest.Mock;

/** Answers the enqueue with `jobId`, then the status route with `running` once and `done` after. */
const serveJob = (enqueuePath: string, statusPath: string, result: unknown, jobId = '9') => {
  let polls = 0;
  mockRequest.mockImplementation(async (url: string) => {
    if (url === enqueuePath) return { jobId, deduplicated: false };
    if (url === statusPath) {
      polls += 1;
      return polls === 1
        ? { jobId, state: 'running', progress: { percent: 40, stage: 'Creating offers (2/5)' } }
        : { jobId, state: 'done', progress: { percent: 100, stage: 'Complete' }, result };
    }
    // Answered as a failed job rather than thrown: the poller retries a failed READ indefinitely (a
    // blip is not the job failing), so a throw here would turn a wrong route into a 30 s timeout.
    return { jobId, state: 'failed', progress: { percent: 0, stage: 'Failed' }, error: `unexpected request ${url}` };
  });
};

const calledPaths = () => mockRequest.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);

beforeEach(() => {
  mockRequest.mockReset();
  mockWait.mockClear();
});

describe('deploying a coverage plan', () => {
  it('starts the deploy as a write job, reports its progress, and resolves with the deploy result', async () => {
    const deployResult = { message: 'Coverage plan deployed', deployedCount: 5, skippedCount: 0, deployed: [], skipped: [] };
    serveJob('/planning/coverage-plans/plan-1/execute', '/planning/write-jobs/9', deployResult);
    const stages: string[] = [];

    const result = await executeCoveragePlan('plan-1', '2026-10-01', { onProgress: (p) => stages.push(p.stage) });

    expect(result).toEqual(deployResult);
    expect(stages).toEqual(['Creating offers (2/5)']);
    const [, init] = mockRequest.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ scheduledDate: '2026-10-01' });
    expect(calledPaths()).toEqual([
      'POST /planning/coverage-plans/plan-1/execute',
      'GET /planning/write-jobs/9',
      'GET /planning/write-jobs/9',
    ]);
  });

  /** A second press joins the running deploy on the server; the screen is told, not left to guess. */
  it('says when the press joined a deploy that was already running', async () => {
    mockRequest.mockImplementation(async (url: string) =>
      url.endsWith('/execute')
        ? { jobId: '4', deduplicated: true }
        : { jobId: '4', state: 'done', progress: { percent: 100, stage: 'Complete' }, result: { deployedCount: 1 } });
    const joined = jest.fn();

    await executeCoveragePlan('plan-1', undefined, { onJoined: joined });

    expect(joined).toHaveBeenCalledTimes(1);
  });

  it('reports the job\'s own failure in its words', async () => {
    mockRequest.mockImplementation(async (url: string) =>
      url.endsWith('/execute')
        ? { jobId: '5', deduplicated: false }
        : { jobId: '5', state: 'failed', progress: { percent: 0, stage: 'Failed' }, error: 'Execution denied: only APPROVED plans can be deployed.' });

    await expect(executeCoveragePlan('plan-1')).rejects.toThrow('Execution denied: only APPROVED plans can be deployed.');
  });
});

describe('the coverage-plan preview, plan version and day plans', () => {
  it('reads the coverage preview through its queued twin, not the synchronous GET', async () => {
    serveJob('/planning/projects/p-1/coverage-plan/jobs', '/planning/jobs/9', { coveragePercentage: 91 });

    await expect(getCoveragePlanPreview('p-1')).resolves.toEqual({ coveragePercentage: 91 });
    expect(calledPaths()[0]).toBe('POST /planning/projects/p-1/coverage-plan/jobs');
    expect(calledPaths()).not.toContain('GET /planning/projects/p-1/coverage-plan');
  });

  it('generates a plan version as a write job and resolves with the saved plan', async () => {
    serveJob('/planning/projects/p-1/coverage-plan/versions/jobs', '/planning/write-jobs/9', { id: 'plan-1', status: 'GENERATED', currentVersion: 2 });

    await expect(createCoveragePlan('p-1')).resolves.toEqual({ id: 'plan-1', status: 'GENERATED', currentVersion: 2 });
    expect(calledPaths()[0]).toBe('POST /planning/projects/p-1/coverage-plan/versions/jobs');
  });

  it('plans days through the queued route with the same parameters', async () => {
    const statusPath = '/planning/jobs/9';
    mockRequest.mockImplementation(async (url: string) =>
      url.startsWith('/planning/day-plans/jobs?')
        ? { jobId: '9', deduplicated: false }
        : url === statusPath
          ? { jobId: '9', state: 'done', progress: { percent: 100, stage: 'Complete' }, result: { clusters: [] } }
          : { jobId: '9', state: 'failed', progress: { percent: 0, stage: 'Failed' }, error: `unexpected ${url}` });

    await expect(getDayPlans({ targetDate: '2026-10-02', projectIds: ['p-1', 'p-2'], minDistanceKm: 15 })).resolves.toEqual({ clusters: [] });

    const [url, init] = mockRequest.mock.calls[0];
    expect(init.method).toBe('POST');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('projectIds')).toBe('p-1,p-2');
    expect(params.get('targetDate')).toBe('2026-10-02');
    expect(params.get('minDistanceKm')).toBe('15');
    expect(mockWait).toHaveBeenCalledWith(statusPath, expect.anything());
  });
});

describe('bulk actions from the planning queue', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `pb-${i}`);

  /** 500 ticked branches used to be 500 requests; the rate limit refused some of them. */
  it('offers a whole selection in ONE request and returns every branch\'s outcome', async () => {
    const outcome = { succeeded: [{ projectBranchId: 'pb-0', assignmentId: 'a-0', status: 'PENDING' }], failed: [{ projectBranchId: 'pb-1', error: 'Branch Busy' }] };
    serveJob('/planning/bulk-offers/jobs', '/planning/write-jobs/9', outcome);

    const result = await offerBranchesInBulk({ projectBranchIds: ids, assayerId: 'as-1', assayerName: 'Ravi', acceptOnBehalf: false });

    expect(result).toEqual(outcome);
    expect(mockRequest.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(mockRequest.mock.calls.some(([url]) => url === '/assignments')).toBe(false);
    expect(JSON.parse(mockRequest.mock.calls[0][1].body)).toMatchObject({ projectBranchIds: ids, assayerId: 'as-1' });
  });

  it('marks a whole selection unable to cover in ONE request', async () => {
    serveJob('/planning/unable-to-cover/jobs', '/planning/write-jobs/9', { succeeded: [], failed: [] });

    await markBranchesUnableToCover(ids, 'No assayer within range');

    expect(mockRequest.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(mockRequest.mock.calls.some(([url]) => String(url).includes('/unable-to-cover') && String(url).startsWith('/projects/'))).toBe(false);
    expect(JSON.parse(mockRequest.mock.calls[0][1].body)).toEqual({ projectBranchIds: ids, reason: 'No assayer within range' });
  });
});

/**
 * Coordinates are Postgres decimals and arrive as strings. The optimize route validates numbers,
 * so a string refused the whole "Optimize route" request.
 */
describe('optimizeRoute — coordinates are numbers on the wire', () => {
  it('coerces string decimals to numbers and drops a stop with no usable coordinates', async () => {
    const built = buildRouteOptimizePayload({
      origin: { latitude: '19.0760', longitude: '72.8777' },
      destinations: [
        { id: 'b1', latitude: '19.1136', longitude: '72.8697' },
        { id: 'b2', latitude: 'not-a-number', longitude: '72.1' },
      ],
      roundTrip: true,
      mode: 'driving',
    });
    expect(built).toEqual({
      origin: { latitude: 19.076, longitude: 72.8777 },
      destinations: [{ id: 'b1', latitude: 19.1136, longitude: 72.8697 }],
      roundTrip: true,
      mode: 'driving',
    });

    mockRequest.mockReset();
    mockRequest.mockResolvedValue({ optimizedSequence: [], totalDistanceKm: 0, totalDurationMinutes: 0 });
    await optimizeRoute({ origin: { latitude: '19.0760', longitude: '72.8777' }, destinations: [{ id: 'b1', latitude: '19.1', longitude: '72.8' }] });
    const [url, opts] = mockRequest.mock.calls[0];
    expect(url).toBe('/geo/route/optimize');
    const sent = JSON.parse(opts.body);
    expect(typeof sent.origin.latitude).toBe('number');
    expect(typeof sent.destinations[0].longitude).toBe('number');
  });
});

describe('getProjects — asks for the server\'s ceiling, not its 50-row default', () => {
  it('passes limit=200', async () => {
    mockRequest.mockReset();
    mockRequest.mockResolvedValue([]);
    await getProjects();
    expect(mockRequest.mock.calls[0][0]).toBe('/projects?limit=200');
  });
});
