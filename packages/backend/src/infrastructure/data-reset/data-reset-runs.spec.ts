import { BadRequestException, ConflictException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { DataResetRuns, DATA_RESET_RUN_UNEXPECTED_FAILURE } from './data-reset-runs';
import { DataResetController, DATA_RESET_CONFIRMATION_PHRASE } from './data-reset.controller';

/**
 * The wipe is accepted, then watched.
 *
 * `POST /admin/data-reset/execute` used to run the backup and the wipe inside the request, and the
 * web stopped waiting at 180 s — so on a large database the screen said "Wipe failed" while the
 * server went on deleting. What must hold now: execute answers before the work finishes; the poll
 * tells the truth about running / done / failed; only the developer who started a run can read
 * it; and nothing about the two-person rule moved — the wipe still receives the consume hook, a
 * failed backup still stops the wipe before it starts.
 */

/** A promise the test settles by hand, so "still running" is a state the test can observe. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** Lets the run's `.then` handlers execute. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const OWNER = { requestId: 'req-1', requestedBy: 'dev-1' };
const RESULT = { removed: { clients: 5 }, backup: null };

describe('DataResetRuns', () => {
  let runs: DataResetRuns;

  beforeEach(() => {
    runs = new DataResetRuns();
  });

  /**
   * The whole point of the change: the job id comes back while the work is still pending, and the
   * poll says "running" until the wipe has actually finished, then hands back what was removed.
   */
  it('answers with a job id while the wipe is still running, and reports the result once it is done', async () => {
    const work = deferred<typeof RESULT>();
    const { jobId } = runs.start(OWNER, 'Wiping', () => work.promise);

    expect(runs.describe(jobId, 'dev-1')).toMatchObject({ jobId, state: 'running', progress: { stage: 'Wiping' } });

    work.resolve(RESULT);
    await flush();

    const status = runs.describe(jobId, 'dev-1');
    expect(status.state).toBe('done');
    expect(status.result).toEqual(RESULT);
    expect(status.finishedAt).not.toBeNull();
  });

  /** The spinner has to move from "backup" to "wiping" when the dump is done, not stay stuck. */
  it('moves the stage from the backup to the wipe as the work reports it', async () => {
    const work = deferred<typeof RESULT>();
    const { jobId } = runs.start(OWNER, 'Taking a backup first', (setStage) => {
      setStage('Wiping');
      return work.promise;
    });
    await flush();
    expect(runs.describe(jobId, 'dev-1').progress.stage).toBe('Wiping');
  });

  /**
   * Every guard on the wipe path throws a message written for the operator ("This approval was
   * already used", "Could not take a backup … nothing was deleted") and those must reach the
   * screen verbatim. Anything else is a driver or programming error whose text names internals,
   * so the screen gets a fixed sentence pointing at the request's status instead.
   */
  it("reports a deliberate refusal in its own words, and an unexpected error without its internals", async () => {
    const refused = runs.start(OWNER, 'Wiping', async () => {
      throw new ConflictException('This approval was already used — each approval runs exactly one wipe.');
    });
    const crashed = runs.start({ ...OWNER, requestId: 'req-2' }, 'Wiping', async () => {
      throw new Error('relation "assayer_government_documents" does not exist');
    });
    await flush();

    expect(runs.describe(refused.jobId, 'dev-1')).toMatchObject({
      state: 'failed',
      error: 'This approval was already used — each approval runs exactly one wipe.',
    });
    const crash = runs.describe(crashed.jobId, 'dev-1');
    expect(crash.state).toBe('failed');
    expect(crash.error).toBe(DATA_RESET_RUN_UNEXPECTED_FAILURE);
    expect(crash.error).not.toMatch(/assayer_government_documents/);
  });

  /**
   * A run's result names what was deleted and where the backup file is. Only its starter may read
   * it, and a stranger's id answers exactly like an unknown one so the 404 confirms nothing.
   */
  it('lets only the developer who started a run read it, with the same 404 as an unknown id', async () => {
    const { jobId } = runs.start(OWNER, 'Wiping', async () => RESULT);
    await flush();

    expect(() => runs.describe(jobId, 'dev-2')).toThrow(NotFoundException);
    expect(() => runs.describe(jobId, undefined)).toThrow(NotFoundException);
    const stranger = (() => { try { runs.describe(jobId, 'dev-2'); } catch (e) { return (e as Error).message; } })();
    const unknown = (() => { try { runs.describe('00000000-0000-4000-8000-000000000000', 'dev-1'); } catch (e) { return (e as Error).message; } })();
    expect(stranger).toBe(unknown);
  });

  /**
   * A double submit (two tabs) must not start a second backup and a second wipe attempt for the
   * same approval. But a run that FAILED consumed nothing, so retrying it has to stay possible.
   */
  it('refuses a second run of the same request while the first is going, and allows a retry after it failed', async () => {
    const work = deferred<typeof RESULT>();
    runs.start(OWNER, 'Wiping', () => work.promise);

    expect(() => runs.start(OWNER, 'Wiping', async () => RESULT)).toThrow(ConflictException);

    work.reject(new ConflictException('This approval expired.'));
    await flush();

    expect(() => runs.start(OWNER, 'Wiping', async () => RESULT)).not.toThrow();
  });

  /**
   * The request-scoped wipe got this for free: the HTTP server's close waited for the open request
   * before the database pool was torn down. A run outside the request has to ask for it.
   */
  it('waits for an in-flight wipe at shutdown so the pool is not closed under its transaction', async () => {
    const work = deferred<typeof RESULT>();
    runs.start(OWNER, 'Wiping', () => work.promise);

    let shutDown = false;
    const shutdown = runs.beforeApplicationShutdown().then(() => { shutDown = true; });
    await flush();
    expect(shutDown).toBe(false);

    work.resolve(RESULT);
    await shutdown;
    expect(shutDown).toBe(true);
  });
});

describe('DataResetController execute — accepted, then run', () => {
  let runs: DataResetRuns;
  let dataReset: { execute: jest.Mock };
  let backup: { createDump: jest.Mock };
  let approvals: { assertExecutableAndConsume: jest.Mock };
  let controller: DataResetController;
  const req = { user: { id: 'dev-1' } };
  const dto = (over: Record<string, unknown> = {}) => ({
    domainKeys: ['clients'],
    requestId: '11111111-1111-4111-8111-111111111111',
    keepUserIds: ['keep-1'],
    takeBackupFirst: true,
    confirmationPhrase: DATA_RESET_CONFIRMATION_PHRASE,
    ...over,
  });

  beforeEach(() => {
    runs = new DataResetRuns();
    dataReset = { execute: jest.fn().mockResolvedValue(RESULT) };
    backup = { createDump: jest.fn() };
    approvals = { assertExecutableAndConsume: jest.fn().mockResolvedValue(undefined) };
    controller = new DataResetController(dataReset as any, backup as any, approvals as any, runs);
  });

  /**
   * The bug itself: with a slow `pg_dump`, execute must already have answered. And once the dump
   * lands, the wipe it starts is the same wipe as before — the approval consumed through the hook,
   * on the transaction's manager, and the caller force-kept.
   */
  it('answers before the backup finishes, then runs the same wipe with the consume hook', async () => {
    const dump = deferred<any>();
    backup.createDump.mockReturnValue(dump.promise);

    const accepted = await controller.execute(dto() as any, req);
    expect(accepted.jobId).toEqual(expect.any(String));
    expect(runs.describe(accepted.jobId, 'dev-1')).toMatchObject({ state: 'running', progress: { stage: 'Taking a backup first' } });
    expect(dataReset.execute).not.toHaveBeenCalled();

    dump.resolve({ filename: 'on-demand.dump', path: '/app/backups/on-demand.dump', sizeBytes: 4096, createdAt: 'now' });
    await flush();

    expect(dataReset.execute).toHaveBeenCalledTimes(1);
    const input = dataReset.execute.mock.calls[0][0];
    expect(input.keepUserIds).toEqual(expect.arrayContaining(['keep-1', 'dev-1']));
    expect(input.backup).toMatchObject({ filename: 'on-demand.dump' });

    const manager = { query: jest.fn() };
    await input.consumeApproval(manager);
    expect(approvals.assertExecutableAndConsume).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111', 'dev-1', ['clients'], manager,
    );
    expect(runs.describe(accepted.jobId, 'dev-1')).toMatchObject({ state: 'done', result: RESULT });
  });

  /** A backup that could not be taken still means no wipe — and the screen says why. */
  it('never starts the wipe when the backup fails, and reports the backup refusal', async () => {
    backup.createDump.mockRejectedValue(
      new InternalServerErrorException('Could not take a backup before wiping — nothing was deleted.'),
    );

    const { jobId } = await controller.execute(dto() as any, req);
    await flush();

    expect(dataReset.execute).not.toHaveBeenCalled();
    expect(runs.describe(jobId, 'dev-1')).toMatchObject({
      state: 'failed',
      error: 'Could not take a backup before wiping — nothing was deleted.',
    });
  });

  /** A wrong phrase is refused as a 400 before anything starts — not a 202 carrying `success: false`. */
  it('refuses a wrong confirmation phrase before any backup or wipe begins', async () => {
    await expect(controller.execute(dto({ confirmationPhrase: 'delete' }) as any, req)).rejects.toThrow(BadRequestException);
    await flush();
    expect(backup.createDump).not.toHaveBeenCalled();
    expect(dataReset.execute).not.toHaveBeenCalled();
  });
});
