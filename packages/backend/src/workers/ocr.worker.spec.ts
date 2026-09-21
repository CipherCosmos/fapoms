import { OcrWorker } from './ocr.worker';
import { OcrJobStatus } from '../infrastructure/ocr/ocr-job.entity';

/**
 * The OCR worker records a hand-over. It does not imitate one.
 *
 * OCR in this product is an outside application a person feeds by hand: the desk marks a return
 * "sent for scanning", somebody runs it through, and the result comes back through the
 * `/ocr-boundary` callback or an uploaded Generated Excel. This worker's only job is to record
 * that the file has left, truthfully.
 *
 * It used to do two dishonest things, and both are pinned below:
 *
 *  - `retryCount = retryCount + 1` on EVERY claim, so the column that exists to count retries
 *    counted ordinary successful claims. With Bull configured `attempts: 5`, a job handled once
 *    read `retryCount: 1` and was indistinguishable from one that had genuinely failed and been
 *    re-attempted. The number now comes from Bull's own `attemptsMade`.
 *  - it wrote PROCESSING unconditionally, including over a job the callback had already
 *    COMPLETED — putting a job whose results a reviewer had seen back into the waiting pile.
 */
describe('OcrWorker — records the hand-over honestly', () => {
  const makeWorker = (row: Record<string, unknown> | null) => {
    const saved: Array<Record<string, unknown>> = [];
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
      save: jest.fn(async (r: Record<string, unknown>) => { saved.push({ ...r }); return r; }),
    };
    return { worker: new OcrWorker(repo as never), repo, saved };
  };

  const job = (attemptsMade = 0) => ({
    id: '1',
    attemptsMade,
    data: { documentId: 'doc-1', userId: 'u-1', fileName: 'return.pdf' },
  }) as never;

  it('records a first hand-over with retryCount 0 — a claim is not a retry', async () => {
    const row = { documentId: 'doc-1', status: OcrJobStatus.PENDING, retryCount: 0 };
    const { worker, saved } = makeWorker(row);

    await worker.processOcr(job(0));

    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe(OcrJobStatus.PROCESSING);
    expect(saved[0].retryCount).toBe(0);
  });

  it('does not inflate retryCount when the same job is claimed again', async () => {
    const row = { documentId: 'doc-1', status: OcrJobStatus.PROCESSING, retryCount: 0 };
    const { worker, saved } = makeWorker(row);

    await worker.processOcr(job(0));
    await worker.processOcr(job(0));

    // Two claims, still zero retries — the old code would have written 1 then 2.
    expect(saved.map((s) => s.retryCount)).toEqual([0, 0]);
  });

  it('reports the retry count Bull actually made, when it is genuinely retrying', async () => {
    const row = { documentId: 'doc-1', status: OcrJobStatus.PENDING, retryCount: 0 };
    const { worker, saved } = makeWorker(row);

    await worker.processOcr(job(3));

    expect(saved[0].retryCount).toBe(3);
  });

  it.each([OcrJobStatus.COMPLETED, OcrJobStatus.DEAD_LETTER])(
    'leaves a %s job alone rather than putting it back in the waiting pile',
    async (status) => {
      const row = { documentId: 'doc-1', status, retryCount: 2 };
      const { worker, repo } = makeWorker(row);

      await worker.processOcr(job(0));

      expect(repo.save).not.toHaveBeenCalled();
    },
  );

  it('says so and writes nothing when there is no job row for the document', async () => {
    const { worker, repo } = makeWorker(null);

    await worker.processOcr(job(0));

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('marks the job FAILED with a reason when the hand-over cannot be recorded', async () => {
    const row: Record<string, unknown> = { documentId: 'doc-1', status: OcrJobStatus.PENDING, retryCount: 0 };
    const { worker, repo } = makeWorker(row);
    repo.save.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(worker.processOcr(job(0))).rejects.toThrow('database unavailable');
    expect(row.status).toBe(OcrJobStatus.FAILED);
    expect(row.failureReason).toBe('database unavailable');
  });
});
