import * as xlsx from 'xlsx';
import { buildWorkbook, toDate, inr } from './excel-export';

describe('buildWorkbook', () => {
  function readBack(buffer: Buffer) {
    return xlsx.read(buffer, { type: 'buffer' });
  }

  it('writes headers on row 1 and data rows below, in one sheet', () => {
    const buffer = buildWorkbook([
      { name: 'People', headers: ['Name', 'Age'], rows: [['Asha', 30], ['Rohan', 41]] },
    ]);
    const wb = readBack(buffer);
    expect(wb.SheetNames).toEqual(['People']);
    const rows = xlsx.utils.sheet_to_json<any[]>(wb.Sheets['People'], { header: 1 });
    expect(rows).toEqual([['Name', 'Age'], ['Asha', 30], ['Rohan', 41]]);
  });

  it('builds more than one sheet, in order', () => {
    const buffer = buildWorkbook([
      { name: 'Data', headers: ['A'], rows: [[1]] },
      { name: 'Instructions', headers: ['Field', 'Description'], rows: [['A', 'the first column']] },
    ]);
    const wb = readBack(buffer);
    expect(wb.SheetNames).toEqual(['Data', 'Instructions']);
  });

  it('still emits a header row plus one blank row when there are zero data rows, so the sheet is not blank in Excel', () => {
    const buffer = buildWorkbook([{ name: 'Empty', headers: ['X', 'Y'], rows: [] }]);
    const wb = readBack(buffer);
    const rows = xlsx.utils.sheet_to_json<any[]>(wb.Sheets['Empty'], { header: 1 });
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual(['X', 'Y']);
  });

  it('sanitises a sheet name Excel would otherwise reject', () => {
    const buffer = buildWorkbook([{ name: 'A/B:C*D?E[F]' + 'x'.repeat(40), headers: ['H'], rows: [] }]);
    const wb = readBack(buffer);
    expect(wb.SheetNames[0].length).toBeLessThanOrEqual(31);
    expect(wb.SheetNames[0]).not.toMatch(/[\\/?*[\]:]/);
  });

  describe('columnWidths', () => {
    it('sets !cols from the given widths, aligned with headers', () => {
      const buffer = buildWorkbook([
        { name: 'Sheet1', headers: ['Short', 'Wide Address Column'], rows: [], columnWidths: [12, 55] },
      ]);
      // `!cols` is genuinely written into the file — xlsx.read only parses column metadata back
      // out with `cellStyles: true` (verified directly: the default read leaves `!cols`
      // undefined even though the bytes are there). The read-back cell also carries extra
      // derived fields (`width`, `wpx`, `MDW`) SheetJS computes from `wch`, so only `wch` itself
      // is asserted, not the whole object.
      const wb = xlsx.read(buffer, { type: 'buffer', cellStyles: true });
      const cols = (wb.Sheets['Sheet1'] as any)['!cols'];
      expect(cols.map((c: any) => c.wch)).toEqual([12, 55]);
    });

    it('leaves !cols unset when no widths are given, so Excel sizes columns itself', () => {
      const buffer = buildWorkbook([{ name: 'Sheet1', headers: ['A'], rows: [] }]);
      const wb = readBack(buffer);
      expect((wb.Sheets['Sheet1'] as any)['!cols']).toBeUndefined();
    });
  });
});

describe('toDate', () => {
  it('formats a Date as local YYYY-MM-DD', () => {
    expect(toDate(new Date(2026, 8, 13))).toBe('2026-09-13'); // month is 0-indexed
  });

  it('formats an ISO string the same way', () => {
    expect(toDate('2026-09-13T00:00:00.000Z')).toBe(toDate(new Date('2026-09-13T00:00:00.000Z')));
  });

  it('returns null for nullish or unparseable input', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate('not a date')).toBeNull();
  });
});

describe('inr', () => {
  it('renders a number with the rupee sign and Indian thousands grouping', () => {
    expect(inr(150000)).toBe('₹1,50,000');
  });

  it('returns null for nullish or non-numeric input, never "₹NaN"', () => {
    expect(inr(null)).toBeNull();
    expect(inr(undefined)).toBeNull();
    expect(inr('not a number')).toBeNull();
  });
});
