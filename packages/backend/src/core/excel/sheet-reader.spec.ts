import * as xlsx from 'xlsx';
import { parseSheet, rowReader, normaliseHeader, describeMissingColumn, identifyTemplate } from './sheet-reader';

/**
 * The bug these prevent, twice over.
 *
 * Both importers read columns by exact header text. A roster whose column said `ASSAYER CODE`
 * instead of `Assayer Code` failed every one of its 72 rows with "Assayer Code is required" —
 * a wall of identical errors about a column the operator could see in the file. The branch
 * importer had the same defect on `Branch Name`.
 *
 * The cases below are the header spellings real files actually arrive with, not invented ones.
 */

/** Build a workbook from rows of cells, so a test can express a title row or a blank line. */
function workbook(rows: any[][]): Buffer {
  const ws = xlsx.utils.aoa_to_sheet(rows);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/** Build a multi-sheet workbook: `[name, rows]` pairs, in workbook order. */
function multiSheetWorkbook(sheets: [string, any[][]][]): Buffer {
  const wb = xlsx.utils.book_new();
  for (const [name, rows] of sheets) {
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), name);
  }
  return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

describe('normaliseHeader', () => {
  it('collapses the differences that are invisible in Excel', () => {
    const forms = ['Assayer Code', 'Assayer code', 'ASSAYER CODE', 'Assayer_Code', 'AssayerCode', 'Assayer Code '];
    const normalised = new Set(forms.map(normaliseHeader));
    expect([...normalised]).toEqual(['assayercode']);
  });

  it('does not conflate genuinely different columns', () => {
    expect(normaliseHeader('Phone')).not.toBe(normaliseHeader('Alternate Phone'));
  });
});

describe('rowReader', () => {
  const read = (header: string) => rowReader({ [header]: 'AS-01' })('Assayer Code');

  it.each([
    ['canonical', 'Assayer Code'],
    ['lowercase second word', 'Assayer code'],
    ['all caps', 'ASSAYER CODE'],
    ['underscored', 'Assayer_Code'],
    ['no separator', 'AssayerCode'],
    ['trailing space', 'Assayer Code '],
  ])('reads the column when it is spelled %s', (_label, header) => {
    expect(read(header)).toBe('AS-01');
  });

  it('tries each alias in order', () => {
    const get = rowReader({ Mobile: '9876500001' });
    expect(get('Phone', 'Mobile', 'Contact Number')).toBe('9876500001');
  });

  it('treats a blank cell as absent so the next alias wins', () => {
    const get = rowReader({ Phone: '   ', Mobile: '9876500001' });
    expect(get('Phone', 'Mobile')).toBe('9876500001');
  });

  it('returns an empty string rather than throwing on a missing column', () => {
    expect(rowReader({})('Anything')).toBe('');
  });

  it('does not let a duplicate blank column shadow the real one', () => {
    // Two columns normalising to the same key — Excel allows it, and the populated one must win.
    expect(rowReader({ 'Assayer Code': 'AS-01', 'assayer code': '' })('Assayer Code')).toBe('AS-01');
  });

  it('preserves the cell value untouched', () => {
    // Only the column NAME is normalised. Codes are identifiers; changing their case would
    // silently create a second assayer on the next import.
    expect(rowReader({ Code: '  as-01  ' })('Code')).toBe('as-01');
  });
});

describe('parseSheet', () => {
  it('reads a normal sheet from row 1', () => {
    const sheet = parseSheet(workbook([['Assayer Code', 'Phone'], ['AS-01', '9876500001']]), ['Assayer Code']);
    expect(sheet.headerRow).toBe(1);
    expect(sheet.rows).toHaveLength(1);
  });

  /**
   * Client rosters routinely open with a merged title and a blank line. Read from row 1, every
   * column comes back as `__EMPTY` and every lookup fails — which is indistinguishable, to the
   * operator, from the exact-header bug.
   */
  it('finds the header row under a title and a blank line', () => {
    const sheet = parseSheet(
      workbook([['MASTER ROSTER — JULY 2026'], [], ['Assayer Code', 'Phone'], ['AS-01', '9876500001']]),
      ['Assayer Code'],
    );
    expect(sheet.headerRow).toBe(3);
    expect(rowReader(sheet.rows[0])('Assayer Code')).toBe('AS-01');
  });

  it('reports row numbers that match what the operator sees in Excel', () => {
    const sheet = parseSheet(
      workbook([['TITLE'], ['Assayer Code'], ['AS-01'], ['AS-02']]),
      ['Assayer Code'],
    );
    // Headers on file row 2, so the first data row is file row 3.
    expect(sheet.headerRow).toBe(2);
    expect(sheet.headerRow + 1 + 0).toBe(3);
  });

  it('returns an empty result for an empty file rather than throwing', () => {
    expect(parseSheet(workbook([])).rows).toEqual([]);
  });

  /**
   * The shape of the client's real file: one workbook, a Branch sheet and an Assayer sheet.
   *
   * Reading `SheetNames[0]` and nothing else made this workbook impossible to import on the
   * roster screen — sheet 1 is the branch list, so the roster importer found branch columns and
   * refused the file, while the roster sat untouched in sheet 2. Branch import worked and assayer
   * import did not, from the very same file.
   */
  describe('a workbook with more than one sheet', () => {
    const clientWorkbook = () => multiSheetWorkbook([
      ['Branch', [['BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets'],
                  ['BR-1', 'THENKURISSI', 'PALAKKAD', 'Kerala', 'Main Road', '120']]],
      // Trailing space in the sheet name, exactly as the client's file has it.
      ['Assayer ', [['Assayer Name', 'Assayer code', 'Residence Address', 'Location', 'District', 'State', 'Zone'],
                    ['Shinil T', 'AS0643', 'Thykkattu, Kunnamangalam', 'Kunnamangalam', 'Calicut', 'Kerala', 'South']]],
    ]);

    it('finds the roster on the second sheet', () => {
      const sheet = parseSheet(clientWorkbook(), ['Assayer Code', 'Assayer Name', 'Phone']);

      expect(sheet.sheetName).toBe('Assayer ');
      expect(rowReader(sheet.rows[0])('Assayer Code')).toBe('AS0643');
    });

    it('finds the branch list on the first sheet from the same workbook', () => {
      const sheet = parseSheet(clientWorkbook(), ['BRANCH', 'BRANCH_NAME', 'STATE']);

      expect(sheet.sheetName).toBe('Branch');
      expect(rowReader(sheet.rows[0])('BRANCH_NAME')).toBe('THENKURISSI');
    });

    it('prefers the sheet that has the asked-for columns over the one that is merely wider', () => {
      const sheet = parseSheet(multiSheetWorkbook([
        ['Notes', [['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], ['1', '2', '3', '4', '5', '6', '7', '8']]],
        ['Roster', [['Assayer Code', 'Assayer Name'], ['AS-01', 'Nilesh']]],
      ]), ['Assayer Code', 'Assayer Name']);

      expect(sheet.sheetName).toBe('Roster');
    });

    it('still finds a header row buried under a title on a later sheet', () => {
      const sheet = parseSheet(multiSheetWorkbook([
        ['Cover', [['RBL — JUNE 2026']]],
        ['Roster', [['MASTER ROSTER'], [], ['Assayer Code', 'Phone'], ['AS-01', '9876500001']]],
      ]), ['Assayer Code']);

      expect(sheet.sheetName).toBe('Roster');
      expect(sheet.headerRow).toBe(3);
      expect(rowReader(sheet.rows[0])('Assayer Code')).toBe('AS-01');
    });

    /**
     * The wrong-file guard has to survive this. A workbook holding only a branch list, uploaded
     * to the roster screen, must still be recognised as a branch list — searching every sheet
     * must not turn "you are on the wrong screen" into a silent misread.
     */
    it('still identifies a wrong-file upload when no sheet holds the wanted columns', () => {
      const sheet = parseSheet(multiSheetWorkbook([
        ['Branch', [['BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets'],
                    ['BR-1', 'THENKURISSI', 'PALAKKAD', 'Kerala', 'Main Road', '120']]],
        ['Summary', [['Total'], ['72']]],
      ]), ['Assayer Code', 'Assayer Name', 'Phone']);

      expect(identifyTemplate(sheet)?.id).toBe('branch-import');
    });
  });
});

describe('describeMissingColumn', () => {
  it('names the headers the file actually has', () => {
    // The whole point: without this the operator is told a column is missing and has no way to
    // discover what their file calls it instead.
    const sheet = parseSheet(workbook([['Name', 'Phone'], ['Nilesh', '9876500001']]));
    const message = describeMissingColumn('Assayer Code', ['Assayer Code', 'Code'], sheet);

    expect(message).toContain('"Name"');
    expect(message).toContain('"Phone"');
    expect(message).toContain('Assayer Code');
  });
});

/**
 * Two Excel uploads in one product, both behind a toolbar button, is a setup where the wrong
 * file gets picked — and it was: a branch list went to the assayer roster endpoint. Naming what
 * the file actually is turns "rename this column" (terrible advice; the column is correct for
 * what the file is) into "you are on the wrong screen".
 */
describe('identifyTemplate', () => {
  const sheetWith = (headers: string[]) => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([headers, headers.map(() => 'x')]), 'Sheet1');
    return parseSheet(Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })));
  };

  it('recognises a branch list', () => {
    const sheet = sheetWith(['BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets']);
    expect(identifyTemplate(sheet)?.id).toBe('branch-import');
  });

  it('recognises an assayer roster', () => {
    const sheet = sheetWith(['Assayer code', 'Assayer Name', 'Phone', 'Residence Address']);
    expect(identifyTemplate(sheet)?.id).toBe('assayer-roster');
  });

  it('says nothing about a file it does not recognise', () => {
    // Silence matters: a half-matching file must fall through to the column-level message
    // rather than be confidently mislabelled.
    expect(identifyTemplate(sheetWith(['Foo', 'Bar']))).toBeNull();
  });

  it('points the operator at the right screen instead of telling them to rename a column', () => {
    const sheet = sheetWith(['BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets']);
    const message = describeMissingColumn('Assayer Code', ['Assayer Code'], sheet, 'assayer-roster');

    expect(message).toContain('branch list');
    expect(message).toContain('Upload branches');
    // The advice that would have corrupted data if followed.
    expect(message).not.toContain('Rename the column');
  });

  it('still gives the column-level message when the file is the right kind', () => {
    const sheet = sheetWith(['Assayer code', 'Assayer Name', 'Residence Address']);
    const message = describeMissingColumn('Phone', ['Phone', 'Mobile'], sheet, 'assayer-roster');
    expect(message).toContain('Could not find a "Phone" column');
  });
});
