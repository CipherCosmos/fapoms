import * as xlsx from 'xlsx';

/**
 * The template's instructions have to be true.
 *
 * The roster template ships an Instructions sheet marking each column Required Yes/No. Three of
 * them disagreed with the importer: Phone and Residence Address were marked required and are
 * not — the importer deliberately admits a row without them, because the client rosters it is
 * actually fed have no phone column at all — while State was marked optional and is the one
 * field that hard-fails a row. So the sheet told operators to invent phone numbers into a
 * payroll-adjacent record, and said nothing about the column whose absence would reject their
 * file.
 *
 * This reads the generated workbook and checks the claim against what the importer enforces.
 */
describe('the assayer roster template', () => {
  /** Fields the importer refuses a row for, from `uploadFromExcel`. */
  const HARD_REQUIRED = ['Assayer code', 'Assayer Name', 'State'];

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

  it('documents every column it ships, and ships every column it documents', () => {
    expect(instructions.map((r) => r.Field).sort()).toEqual([...headers].sort());
  });

  it('marks required exactly the fields a row is rejected for', () => {
    const marked = instructions.filter((r) => r.Required === 'Yes').map((r) => r.Field).sort();
    expect(marked).toEqual([...HARD_REQUIRED].sort());
  });

  it('does not ask for a phone the importer accepts a row without', () => {
    expect(instructions.find((r) => r.Field === 'Phone')!.Required).toBe('No');
  });

  it('says State is required, because a row without it is refused', () => {
    const state = instructions.find((r) => r.Field === 'State')!;
    expect(state.Required).toBe('Yes');
    expect(state.Description).toMatch(/region|zone|holiday/i);
  });

  it('leaves no column unexplained', () => {
    const undescribed = instructions.filter((r) => !r.Description?.trim()).map((r) => r.Field);
    expect(undescribed).toEqual([]);
  });
});
