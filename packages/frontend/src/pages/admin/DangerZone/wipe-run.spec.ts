import { runApprovedWipe, WIPE_OUTCOME_UNKNOWN } from './wipe-run';
import { api } from '../../../services/api';
import { AppError } from '../../../services/errors';

/**
 * How the Danger Zone tells a wipe's ending.
 *
 * The execute call used to hold the backup and the wipe in one request and give up at 180 s, so on
 * a large database the screen said "Wipe failed" while the server went on deleting. The server now
 * accepts the wipe and this watches it. What must not regress: a refusal the server made before
 * starting is reported as "not started"; the run's own failure is reported in the server's words;
 * and anything this screen could not see the end of — no answer to the start, or a watch that ran
 * out — is reported as UNKNOWN, pointing at the request's status, never as "failed".
 */

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

const BODY = {
  requestId: 'req-1',
  domainKeys: ['clients'],
  keepUserIds: ['dev-1'],
  takeBackupFirst: true,
  confirmationPhrase: 'DELETE ALL SELECTED DATA',
};
const RESULT = { removed: { clients: 5 }, backup: { filename: 'on-demand.dump', sizeBytes: 4096 } };
const status = (state: string, over: Record<string, unknown> = {}) => ({
  jobId: 'job-1', state, progress: { percent: 0, stage: 'Taking a backup first' }, ...over,
});

beforeEach(() => mockRequest.mockReset());

describe('runApprovedWipe', () => {
  /** The ordinary ending: start, watch the stages go by, hand back what the server measured. */
  it('starts the wipe, follows its stages, and returns what was removed', async () => {
    mockRequest
      .mockResolvedValueOnce({ jobId: 'job-1', deduplicated: false })
      .mockResolvedValueOnce(status('running', { progress: { percent: 0, stage: 'Wiping' } }))
      .mockResolvedValueOnce(status('done', { result: RESULT }));
    const stages: string[] = [];

    const outcome = await runApprovedWipe(BODY, { pollMs: 1, onStage: (s) => stages.push(s) });

    expect(outcome).toEqual({ kind: 'done', result: RESULT });
    expect(mockRequest.mock.calls[0][0]).toBe('/admin/data-reset/execute');
    expect(JSON.parse(mockRequest.mock.calls[0][1].body)).toEqual(BODY);
    expect(mockRequest.mock.calls[1][0]).toBe('/admin/data-reset/runs/job-1');
    expect(stages).toContain('Wiping');
  });

  /** The run's own failure (approval expired, backup refused) reaches the developer verbatim. */
  it("reports the run's own failure in the server's words", async () => {
    mockRequest
      .mockResolvedValueOnce({ jobId: 'job-1', deduplicated: false })
      .mockResolvedValueOnce(status('failed', { error: 'Could not take a backup before wiping — nothing was deleted.' }));

    const outcome = await runApprovedWipe(BODY, { pollMs: 1 });

    expect(outcome).toEqual({ kind: 'failed', message: 'Could not take a backup before wiping — nothing was deleted.' });
  });

  /** A 4xx on the start is the server declining before anything began — nothing to watch. */
  it('reports a refused start as not started, without watching anything', async () => {
    mockRequest.mockRejectedValueOnce(new AppError('A wipe for this request is already running.', '409', 409, 'conflict'));

    const outcome = await runApprovedWipe(BODY, { pollMs: 1 });

    expect(outcome.kind).toBe('refused');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  /**
   * No answer to the start (a dropped connection, a timeout) or a 5xx from a proxy mid-deploy does
   * not prove the server never accepted the wipe. Saying "failed" there is the original lie.
   */
  it('reports a start that got no clear answer as unknown, not as refused', async () => {
    mockRequest.mockRejectedValueOnce(new AppError('Could not reach the server.', 'Failed to fetch', undefined, 'retryable'));
    expect(await runApprovedWipe(BODY, { pollMs: 1 })).toEqual({ kind: 'unknown', message: WIPE_OUTCOME_UNKNOWN });

    mockRequest.mockRejectedValueOnce(new AppError('Bad gateway', '502', 502, 'retryable'));
    expect((await runApprovedWipe(BODY, { pollMs: 1 })).kind).toBe('unknown');
  });

  /**
   * A run whose status can no longer be read (the server restarted and forgot it, so every poll
   * 404s) or that outlasts the watch is reported as unknown with the pointer to the request's
   * status — the wipe may well have committed.
   */
  it('reports a watch that ran out as unknown, pointing at the request status', async () => {
    mockRequest
      .mockResolvedValueOnce({ jobId: 'job-1', deduplicated: false })
      .mockRejectedValue(new AppError('No such wipe run on this server.', '404', 404, 'non-retryable'));

    // A long give-up window: the 404 alone must end the watch as unknown, not the timeout.
    const outcome = await runApprovedWipe(BODY, { pollMs: 1, giveUpMs: 60_000 });

    expect(outcome).toEqual({ kind: 'unknown', message: WIPE_OUTCOME_UNKNOWN });
    expect(WIPE_OUTCOME_UNKNOWN).toMatch(/Executed means the wipe went through/);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});
