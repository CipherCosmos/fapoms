/**
 * `job.data` used to carry `fileName` and (once added) `overwrite`, and the worker read both
 * off it — into local variables that were then never passed into `importAssayerSheet`'s
 * options. The audit row for every queued import said "an uploaded file" no matter what was
 * uploaded, and no queued run could ever ask for "sheet wins" even if `overwrite: true` reached
 * the queue. Proved here directly against the worker, not just against `ImportJobService` that
 * queues the job.
 */
import { RosterImportWorker } from './roster-import.worker';
import type { RosterImportJobData } from '../import/import-job.service';

describe('RosterImportWorker', () => {
  const importAssayerSheet = jest.fn().mockResolvedValue({
    created: 1, updated: 0, skipped: 0, issues: 0,
  });
  const worker = new RosterImportWorker({ importAssayerSheet } as any);

  const job = (data: Partial<RosterImportJobData>): any => ({
    id: 1,
    data: {
      actorId: 'u-1', fileBase64: Buffer.from('xlsx').toString('base64'),
      fileName: null, totalRows: 10, sheetName: null, overwrite: false,
      ...data,
    },
  });

  beforeEach(() => jest.clearAllMocks());

  it('passes the real file name into the importer, not just the log line', async () => {
    await worker.runRosterImport(job({ fileName: 'sumeru-roster.xlsx' }));

    const [, , options] = importAssayerSheet.mock.calls[0];
    expect(options.fileName).toBe('sumeru-roster.xlsx');
  });

  it('passes overwrite: true through when the queued job carries it', async () => {
    await worker.runRosterImport(job({ overwrite: true }));

    const [, , options] = importAssayerSheet.mock.calls[0];
    expect(options.overwrite).toBe(true);
  });

  it('defaults overwrite to false when the job predates the field', async () => {
    const legacyJob = job({});
    delete (legacyJob.data as any).overwrite;

    await worker.runRosterImport(legacyJob);

    const [, , options] = importAssayerSheet.mock.calls[0];
    expect(options.overwrite).toBe(false);
  });

  it('never runs as a rehearsal', async () => {
    await worker.runRosterImport(job({}));

    const [, , options] = importAssayerSheet.mock.calls[0];
    expect(options.dryRun).toBe(false);
  });
});
