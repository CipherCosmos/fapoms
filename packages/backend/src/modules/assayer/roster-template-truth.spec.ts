import * as xlsx from 'xlsx';

/**
 * The template's instructions have to be true — measured against the FULL roster importer.
 *
 * The Download-template button and the Import button have to describe the same file. Import now
 * runs `RosterImportService.importAssayerSheet`, which reads the client's real roster and skips a
 * row for exactly one reason: no appraiser code. Every other field records a reviewable issue but
 * the row still imports. So the template it publishes must (a) ship a column for every field that
 * importer reads, (b) document every column it ships and ship every column it documents, and
 * (c) mark Required 'Yes' for `Appraiser code` alone — marking anything else required would tell
 * operators a row will be refused when it will not.
 *
 * This reads the generated workbook and checks those claims. The round-trip proof that every
 * shipped column is actually READ by the importer lives in `roster-import.spec.ts`.
 */
describe('the assayer roster template', () => {
  /** The one field the full importer refuses a row for — see `importAssayerSheet`. */
  const HARD_REQUIRED = ['Appraiser code'];

  let instructions: Array<{ Field: string; Required: string; Description: string }>;
  let headers: string[];

  beforeAll(async () => {
    // The generator touches nothing but xlsx, so it runs on a bare instance.
    const { AssayerService } = await import('./assayer.service');
    const buffer = await (AssayerService.prototype.generateTemplate as any).call({});
    const wb = xlsx.read(buffer, { type: 'buffer' });
    instructions = xlsx.utils.sheet_to_json(wb.Sheets.Instructions);
    headers = (xlsx.utils.sheet_to_json(wb.Sheets.Assayers, { header: 1 })[0] ?? []) as string[];
  });

  it('ships the sheet named "Assayers", where the importer looks', async () => {
    const { AssayerService } = await import('./assayer.service');
    const buffer = await (AssayerService.prototype.generateTemplate as any).call({});
    const wb = xlsx.read(buffer, { type: 'buffer' });
    expect(wb.SheetNames).toContain('Assayers');
  });

  it('documents every column it ships, and ships every column it documents', () => {
    expect(instructions.map((r) => r.Field).sort()).toEqual([...headers].sort());
  });

  it('marks required exactly the one field a row is rejected for', () => {
    const marked = instructions.filter((r) => r.Required === 'Yes').map((r) => r.Field).sort();
    expect(marked).toEqual([...HARD_REQUIRED].sort());
  });

  it('does not mark Appraiser Name required — the importer accepts a nameless row', () => {
    expect(instructions.find((r) => r.Field === 'Appraiser Name')!.Required).toBe('No');
  });

  it('does not mark State required — the importer imports a row without it', () => {
    expect(instructions.find((r) => r.Field === 'State')!.Required).toBe('No');
  });

  it('calls out State, Appraiser Name and Zone as strongly recommended', () => {
    for (const field of ['State', 'Appraiser Name', 'Zone']) {
      const row = instructions.find((r) => r.Field === field)!;
      expect(row).toBeDefined();
      expect(row.Description).toMatch(/recommend/i);
    }
  });

  it('leaves no column unexplained', () => {
    const undescribed = instructions.filter((r) => !r.Description?.trim()).map((r) => r.Field);
    expect(undescribed).toEqual([]);
  });

  it('uses clean, correctly-spelled headers, not the client file’s typos', () => {
    const normalised = new Set(headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, '')));
    // The clean spellings the template must publish...
    for (const clean of ['totalexperience', 'reference1name', 'cibildate', 'accountnumber', 'aadhaarcardnumber']) {
      expect(normalised.has(clean)).toBe(true);
    }
    // ...and the raw typos it must NOT.
    for (const typo of ['totalexpierence', 'refference1name', 'acnumber', 'aadharcardnumber']) {
      expect(normalised.has(typo)).toBe(false);
    }
  });
});
