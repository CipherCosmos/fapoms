import * as xlsx from 'xlsx';
import { RosterImportService } from './roster-import.service';

/**
 * One ROSTER_IMPORT_APPLIED audit row per real run, carrying the file name and the run's
 * counts — there was previously no run-level trail of who ran an import file and what it did.
 * Fails on the pre-fix code with "recordEventSafe was never called".
 */
describe('roster import — one audit row per real run', () => {
  const HEADERS = ['Appraiser Name', 'Appraiser code', 'Residence Address', 'Location', 'District', 'State'];

  const book = (rows: any[][]): Buffer => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADERS, ...rows]), 'Assayer');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  const harness = () => {
    let n = 1;
    const manager: any = {
      find: async () => [],
      createQueryBuilder: () => {
        const qb: any = { where: () => qb, andWhere: () => qb, getMany: async () => [] };
        return qb;
      },
      findOne: async () => undefined,
      query: async () => undefined,
      create: (_e: any, obj: any) => ({ ...obj }),
      save: async (_e: any, obj: any) => {
        if (obj && obj.id == null) obj.id = `id-${n++}`;
        return obj;
      },
    };
    const audit = { recordEvent: jest.fn(), recordEventSafe: jest.fn().mockResolvedValue(undefined) };
    const service = new RosterImportService(
      { run: (work: any) => work(manager, () => {}) } as any,
      { enqueueBackfill: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue(false) } as any,
      audit as any,
    );
    return { service, audit };
  };

  it('records ROSTER_IMPORT_APPLIED with the file name and counts on a real run', async () => {
    const { service, audit } = harness();
    await service.importAssayerSheet(
      book([['Person 1', 'AS900', 'Main Road', 'Town', 'District', 'Kerala']]),
      'user-1',
      { dryRun: false, fileName: 'roster-2026-09.xlsx' },
    );

    expect(audit.recordEventSafe).toHaveBeenCalledTimes(1);
    const dto = audit.recordEventSafe.mock.calls[0][0];
    expect(dto.eventType).toBe('ROSTER_IMPORT_APPLIED');
    expect(dto.metadata.fileName).toBe('roster-2026-09.xlsx');
    expect(dto.metadata.created).toBe(1);
  });

  /** A rehearsal writes nothing, so it must not write an audit row either. */
  it('does not record anything for a dry run', async () => {
    const { service, audit } = harness();
    await service.importAssayerSheet(
      book([['Person 1', 'AS901', 'Main Road', 'Town', 'District', 'Kerala']]),
      'user-1',
      { dryRun: true },
    );

    expect(audit.recordEventSafe).not.toHaveBeenCalled();
  });
});
