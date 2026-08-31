import * as xlsx from 'xlsx';
import { ONBOARDING_DOCUMENT_COLUMNS, ONBOARDING_DOCUMENT_LABELS, OnboardingDocument } from '@fapoms/shared';
import { RosterImportService } from './roster-import.service';
import { AssayerService } from './assayer.service';

/**
 * The gate for "template ↔ importer are in sync".
 *
 * `AssayerService.generateTemplate()` publishes the download-and-fill template.
 * `RosterImportService.importAssayerSheet()` is what the Import button runs. If the template ships
 * a column the importer does not read, a person fills it in and the data silently vanishes — the
 * exact failure this pair of files exists to prevent.
 *
 * So: generate the real template, put ONE filled sample row under EVERY column it ships, and run
 * that workbook through the real importer (as a rehearsal — `dryRun`). Every column must be read
 * and mapped: the row is read, nothing is skipped, no cell raises a review issue, and the related
 * tables (references, documents, background check, empanelment) each receive what the row carried.
 * If a template column is not one the importer reads, one of these counts falls short and the test
 * fails.
 */
describe('the roster template round-trips through the importer', () => {
  /** Every non-empty onboarding-document column the importer reads — 18 of the 21 requirements. */
  const documentLabels = new Set(
    (Object.keys(ONBOARDING_DOCUMENT_COLUMNS) as OnboardingDocument[])
      .filter((doc) => ONBOARDING_DOCUMENT_COLUMNS[doc])
      .map((doc) => ONBOARDING_DOCUMENT_LABELS[doc]),
  );
  const expectedDocumentCount = documentLabels.size;

  /**
   * A sample cell for one column, chosen so nothing is left unreadable: valid mobile numbers, a
   * real zone, a readable availability cell, recognised check outcomes. A document column gets a
   * plain "Yes" so it is actually recorded. Everything else is free text the importer stores as-is.
   */
  function sampleFor(header: string): string {
    const specific: Record<string, string> = {
      'Appraiser code': 'AS9001',
      'Appraiser Name': 'Shinil T',
      'PAN Number': 'ABCDE1234F',
      'Aadhaar Card Number': '123412341234',
      'Date of Birth': '1980-05-05',
      'Qualification': 'B.Com',
      'VSTS Code': 'VSTS-9001',
      'Phone Number 1': '9876543210',
      'Phone Number 2': '9876500011',
      'Email ID': 'shinil@example.com',
      'Residence Address': '12 MG Road, Kunnamangalam, Kozhikode',
      'Location': 'Kunnamangalam',
      'District': 'Kozhikode',
      'State': 'Kerala',
      'Zone': 'South',
      'Bank Name': 'State Bank of India',
      'Account Number': '00112233445566',
      'IFSC Code': 'SBIN0001234',
      'Joining Date': '2015-06-01',
      'Exit Date': '2024-01-31',
      'HR Name': 'Anita R',
      'Total Experience': '20 Years',
      'Active / Inactive': 'Active / Regular',
      'Status': 'Active',
      'Remarks': 'Reliable, prefers local work.',
      'Reference 1 Name': 'Ramesh K',
      'Reference 1 Contact': '9800000001',
      'Reference 2 Name': 'Suresh M',
      'Reference 2 Contact': '9800000002',
      'NDA Hard Copy Status': 'Bangalore office',
      'Background Verification Done': 'Clear',
      'CIBIL Status': 'Good',
      'CIBIL Score': '750',
      'CIBIL Date': '2025-01-15',
      'ICICI Status': 'Recommended',
      'ICICI Documents Required': 'PAN copy',
    };
    if (header in specific) return specific[header];
    if (documentLabels.has(header)) return 'Yes';
    return 'Sample';
  }

  /**
   * A UnitOfWork whose `run` executes the work against an in-memory manager. Nothing is persisted;
   * we only need the importer to be able to read the clients map and write its entities somewhere.
   * The one client the roster names — ICICI — is present, so the empanelment column maps to a
   * standing rather than being counted as a missing client.
   */
  function mockUow() {
    let idCounter = 1;
    const clients = [{ id: 'client-icici', name: 'ICICI Bank Ltd', displayName: 'ICICI' }];
    const manager = {
      find: async () => clients,
      findOne: async () => undefined,
      create: (_entity: unknown, obj: Record<string, any>) => ({ ...obj }),
      save: async (_entity: unknown, obj: any) => {
        if (obj && obj.id == null) obj.id = `id-${idCounter++}`;
        return obj;
      },
    };
    return { run: (work: (m: any, emit: any) => Promise<any>) => work(manager, () => {}) };
  }

  /** The precision hand-off is fire-and-forget; the import must not depend on it resolving. */
  function mockGeoPrecision() {
    return { enqueueBackfill: jest.fn().mockResolvedValue(undefined) };
  }

  it('reads and maps every column the template ships', async () => {
    // The real template, generated the same way the download button does.
    const templateBuffer = await (AssayerService.prototype.generateTemplate as any).call({});
    const templateWb = xlsx.read(templateBuffer, { type: 'buffer' });
    const headers = (xlsx.utils.sheet_to_json(templateWb.Sheets.Assayers, { header: 1 })[0] ?? []) as string[];
    expect(headers.length).toBeGreaterThan(40);

    // One filled row under every column.
    const row: Record<string, string> = {};
    for (const header of headers) row[header] = sampleFor(header);

    const filled = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(filled, xlsx.utils.json_to_sheet([row], { header: headers }), 'Assayers');
    const filledBuffer = Buffer.from(xlsx.write(filled, { type: 'buffer', bookType: 'xlsx' }));

    const service = new RosterImportService(mockUow() as any, mockGeoPrecision() as any);
    const summary = await service.importAssayerSheet(filledBuffer, 'test-user', { dryRun: true });

    // The row was read, placed, and nothing was refused or left unreadable.
    expect(summary.rowsRead).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.created).toBe(1);
    expect(summary.issues).toBe(0);
    expect(summary.notes).toEqual([]);
    expect(summary.dryRun).toBe(true);

    // The aux columns actually mapped — this is what a missing read-alias would break.
    expect(summary.references).toBe(2);
    expect(summary.onboardingDocuments).toBe(expectedDocumentCount);
    expect(summary.backgroundChecks).toBe(1);
    expect(summary.empanelments).toBe(1);
  });


  /**
   * A blank Zone must not make somebody invisible.
   *
   * `region` is what `findAll` scopes every roster read by, so a null one removes the person
   * from a region-scoped desk's roster, map and capacity tile while their own record looks
   * complete. The state already says where they are; the importer now falls back to it, the
   * way `create()` always has.
   */
  it('derives the region from the state when the Zone column is blank', async () => {
    const templateBuffer = await (AssayerService.prototype.generateTemplate as any).call({});
    const templateWb = xlsx.read(templateBuffer, { type: 'buffer' });
    const headers = (xlsx.utils.sheet_to_json(templateWb.Sheets.Assayers, { header: 1 })[0] ?? []) as string[];

    const row: Record<string, string> = {};
    for (const header of headers) row[header] = sampleFor(header);
    row['Zone'] = '';
    row['State'] = 'Kerala';

    const saved: any[] = [];
    const uow = mockUow();
    const inner = uow.run;
    uow.run = (work: any) => inner(async (m: any, emit: any) => {
      const origSave = m.save;
      m.save = async (entity: any, obj: any) => {
        const out = await origSave(entity, obj);
        if (obj?.assayerCode) saved.push(out);
        return out;
      };
      return work(m, emit);
    });

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([row], { header: headers }), 'Assayers');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const service = new RosterImportService(uow as any, mockGeoPrecision() as any);
    await service.importAssayerSheet(buffer, 'test-user', { dryRun: true });

    expect(saved.length).toBeGreaterThan(0);
    // Kerala sits in the South region — the point is that it is not null.
    expect(saved[0].region).toBeTruthy();
  });

  it('skips a row with no appraiser code, and only for that reason', async () => {
    const templateBuffer = await (AssayerService.prototype.generateTemplate as any).call({});
    const templateWb = xlsx.read(templateBuffer, { type: 'buffer' });
    const headers = (xlsx.utils.sheet_to_json(templateWb.Sheets.Assayers, { header: 1 })[0] ?? []) as string[];

    const row: Record<string, string> = {};
    for (const header of headers) row[header] = sampleFor(header);
    row['Appraiser code'] = ''; // the one field the importer refuses a row for

    const filled = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(filled, xlsx.utils.json_to_sheet([row], { header: headers }), 'Assayers');
    const filledBuffer = Buffer.from(xlsx.write(filled, { type: 'buffer', bookType: 'xlsx' }));

    const service = new RosterImportService(mockUow() as any, mockGeoPrecision() as any);
    const summary = await service.importAssayerSheet(filledBuffer, 'test-user', { dryRun: true });

    expect(summary.rowsRead).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(0);
  });
});
