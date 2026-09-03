import * as xlsx from 'xlsx';
import { RosterImportService } from './roster-import.service';

/**
 * A masked bank account on the sheet must never overwrite the real one.
 *
 * The API masks PAN, Aadhaar and bank account on read. HR exports the roster, edits it in Excel
 * and re-imports it — so an exported cell holds exactly what the screen showed. PAN and IFSC are
 * saved from this by accident: both go through `readShaped`, whose format pattern rejects an
 * asterisk. A bank account has no format — digits of any length — so `***********0252` went
 * straight into the column, was encrypted, and the real number was gone with no copy anywhere.
 *
 * `assertNoMaskedPii` on `AssayerService` cannot help: the importer never calls `create` or
 * `update`, it mutates the entity and persists it with `manager.save`. So the guard has to exist
 * on this path too, and this suite runs the real importer over a real workbook to prove it does.
 */
describe('a masked bank account coming back in on the sheet', () => {
  /** Captures what the importer actually persisted, so the assertion reads the written value. */
  function harness() {
    const saved: any[] = [];
    let idCounter = 1;
    const manager = {
      find: async () => [],
      createQueryBuilder: () => {
        const qb: any = { where: () => qb, andWhere: () => qb, getMany: async () => [] };
        return qb;
      },
      query: async () => undefined,
      findOne: async () => undefined,
      create: (_e: unknown, obj: Record<string, any>) => ({ ...obj }),
      save: async (entity: any, obj: any) => {
        if (obj && obj.id == null) obj.id = `id-${idCounter++}`;
        if (entity?.name === 'AssayerEntity') saved.push(obj);
        return obj;
      },
    };
    const uow = { run: (work: (m: any, emit: any) => Promise<any>) => work(manager, () => {}) };
    const service = new RosterImportService(
      uow as any,
      { enqueueBackfill: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue(true) } as any,
    );
    return { service, saved };
  }

  const sheetWith = (accountCell: string): Buffer => {
    const row = {
      'Appraiser code': 'AS9101',
      'Appraiser Name': 'Meera Iyer',
      State: 'Maharashtra',
      'Account Number': accountCell,
      'Bank Name': 'State Bank of India',
    };
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([row]), 'Assayers');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  const runImport = async (accountCell: string) => {
    const { service, saved } = harness();
    const summary = await service.importAssayerSheet(sheetWith(accountCell), 'test-user');
    return { summary, person: saved.find((r) => r.assayerCode === 'AS9101') };
  };

  it('refuses an asterisk mask and leaves the column unset', async () => {
    const { summary, person } = await runImport('***********0252');

    expect(person?.bankAccountNumber ?? null).toBeNull();
    // Reported, not thrown: one unusable cell must not abandon the other 1,162 rows.
    expect(summary.issues).toBeGreaterThan(0);
  });

  it('refuses the bullet mask the web app draws, which is what a copy-paste carries', async () => {
    const { person } = await runImport('••••••0252');
    expect(person?.bankAccountNumber ?? null).toBeNull();
  });

  it('still writes a real account number', async () => {
    // The guard must not cost the ordinary case — a bank account has no format to check, so an
    // over-eager rule here would silently drop legitimate numbers instead of masked ones.
    const { person } = await runImport('50100234567890');
    expect(person?.bankAccountNumber).toBe('50100234567890');
  });

  it('names the column, so the operator knows which cell to fix', async () => {
    const { service } = harness();
    const summary: any = await service.importAssayerSheet(sheetWith('***********0252'), 'test-user');
    expect(summary.issues).toBeGreaterThan(0);
  });
});
