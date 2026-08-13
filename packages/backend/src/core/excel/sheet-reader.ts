/**
 * FAPOMS — reading a spreadsheet somebody else produced.
 *
 * Every import in this product is fed a file a client or a branch office typed by hand, and the
 * single most common failure is not bad data — it is a header that does not match byte for byte.
 * `xlsx`'s `sheet_to_json` keys each row by the header text verbatim, so `row['Assayer Code']`
 * misses `ASSAYER CODE`, `Assayer_Code`, `Assayer Code ` with a trailing space (invisible in
 * Excel), and the perfectly reasonable `Assayer code` unless someone thought to list it.
 *
 * That failure mode is uniquely bad because it is total and silent-looking: every row fails the
 * same way, so the operator gets a wall of identical "X is required" lines about a column that
 * is plainly there in front of them. It has now happened twice — once on branch import, once on
 * assayer upload — so the reading is done here, once.
 *
 * Two things this deliberately does NOT do: guess at values, or accept a near-miss on a value.
 * It normalises how a column is *found*; what is in the cell is passed through untouched.
 */

import * as xlsx from 'xlsx';

/** A header reduced to something matchable: lowercase, alphanumeric only. */
export function normaliseHeader(header: string): string {
  return String(header ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Reads one row's cells by any of several column names. Returns '' for missing or blank. */
export type RowReader = (...aliases: string[]) => string;

export function rowReader(row: Record<string, any>): RowReader {
  const byHeader = new Map<string, any>();
  for (const [key, value] of Object.entries(row ?? {})) {
    const normalised = normaliseHeader(key);
    // First writer wins, so a real column is never shadowed by a duplicate blank one.
    if (!byHeader.has(normalised)) byHeader.set(normalised, value);
  }
  return (...aliases: string[]) => {
    for (const alias of aliases) {
      const value = byHeader.get(normaliseHeader(alias));
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
    return '';
  };
}

export interface ParsedSheet {
  rows: Record<string, any>[];
  /** Headers exactly as they appear in the file — what to show when nothing matches. */
  headers: string[];
  /** 1-based row in the file the headers were found on. Usually 1. */
  headerRow: number;
  sheetName: string;
}

/**
 * Excel's own placeholder for a column with no header text. A sheet full of these means the
 * header row was not where we looked.
 */
const BLANK_HEADER = /^__EMPTY(_\d+)?$/;

/** How well a candidate header row matches what the caller asked for. Higher is better. */
function scoreHeaders(headers: string[], expected: Set<string>): number {
  const named = headers.filter((h) => !BLANK_HEADER.test(h));
  // Expected columns dominate: one real hit outranks any number of unrelated columns, so a
  // 6-column roster is chosen over a 38-column sheet that happens to be wider.
  return expected.size
    ? named.filter((h) => expected.has(normaliseHeader(h))).length * 100 + named.length
    : named.length;
}

/**
 * Find the table in a workbook: the right sheet, and the right header row within it.
 *
 * **Header row.** Client files routinely open with a merged title ("BRANCH LIST — JULY 2026"),
 * sometimes a blank row, and only then the real headers. Read from row 1, every column comes back
 * as `__EMPTY`, `__EMPTY_1`… and every lookup fails — which presents to the operator as "Assayer
 * Code is required" on all 72 rows of a file whose second row plainly says "Assayer Code".
 *
 * **Sheet.** This used to read `SheetNames[0]` and nothing else, which made the client's actual
 * workbook impossible to import. `RBL(Indel) - Jun'26.xlsx` holds `["Branch", "Assayer "]` — the
 * branch list first, the roster second. Uploading it to the roster screen read sheet 1, found
 * branch columns, and refused the file as "a branch list, not the roster this screen imports",
 * while the roster sat untouched in sheet 2. Branch import worked and assayer import did not,
 * from the very same file — which is exactly how it was reported.
 *
 * One workbook per client is the normal shape of these files, so the sheet is chosen the same way
 * the header row is: score every candidate against the columns the caller needs and keep the best.
 * Ties go to the earliest sheet and earliest row, which is the ordinary single-table case.
 */
export function parseSheet(fileBuffer: Buffer, expectedColumns: string[] = []): ParsedSheet {
  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
  const expected = new Set(expectedColumns.map(normaliseHeader));

  let best: ParsedSheet | null = null;
  let bestScore = -1;

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    // Four is enough for a title, a subtitle and a spacer; beyond that the file is not a table.
    for (let offset = 0; offset < 4; offset++) {
      const rows = xlsx.utils.sheet_to_json<Record<string, any>>(worksheet, { range: offset });
      if (rows.length === 0) continue;

      const headers = Object.keys(rows[0] ?? {});
      const score = scoreHeaders(headers, expected);
      if (score > bestScore) {
        bestScore = score;
        best = { rows, headers, headerRow: offset + 1, sheetName };
      }
    }
  }

  return best ?? { rows: [], headers: [], headerRow: 1, sheetName: workbook.SheetNames[0] ?? '' };
}

/**
 * The importers this product has, by the columns only their template carries.
 *
 * Two Excel uploads in one product, both reached from a toolbar button, is a setup where the
 * wrong file gets picked — and it duly was: a branch list went to the assayer roster endpoint.
 * Recognising the file is what turns "rename this column" (terrible advice, the column is
 * correct for what it is) into "you are on the wrong screen".
 */
const KNOWN_TEMPLATES: { id: string; label: string; where: string; signature: string[] }[] = [
  {
    id: 'branch-import',
    label: 'branch list',
    where: 'Projects → open the project → Upload branches',
    signature: ['BRANCH_NAME', 'Branch Address', 'Packets'],
  },
  {
    id: 'assayer-roster',
    label: 'assayer roster',
    where: 'Workforce → Roster → Upload',
    signature: ['Assayer Code', 'Assayer Name', 'Residence Address'],
  },
];

/** Which importer's file this looks like, or null when it matches none of them. */
export function identifyTemplate(sheet: ParsedSheet): { id: string; label: string; where: string } | null {
  const headers = new Set(sheet.headers.map(normaliseHeader));
  for (const template of KNOWN_TEMPLATES) {
    const matched = template.signature.filter((c) => headers.has(normaliseHeader(c))).length;
    // Two of three signature columns: enough to be confident, loose enough to survive a file
    // that has been lightly edited.
    if (matched >= 2) return { id: template.id, label: template.label, where: template.where };
  }
  return null;
}

/**
 * The message to give an operator when a required column was not found in their file.
 *
 * Listing the headers we actually saw is the whole point. Without it the operator is told a
 * column they are looking at is missing, with no way to discover that the file says "Assayer
 * Code " and the importer wanted "Assayer Code" — a difference of one invisible character.
 *
 * `expectedTemplate` lets the caller say which importer this is, so that a file belonging to
 * the *other* importer is called out as such instead of being met with advice to rename its
 * columns — which would turn a wrong-screen mistake into corrupted data.
 */
export function describeMissingColumn(
  columnLabel: string,
  aliases: string[],
  sheet: ParsedSheet,
  expectedTemplate?: string,
): string {
  const found = sheet.headers.filter((h) => !BLANK_HEADER.test(h));
  const foundList = found.length
    ? found.slice(0, 15).map((h) => `"${h}"`).join(', ') + (found.length > 15 ? ', …' : '')
    : '(none — the sheet has no header text on that row)';

  const actual = identifyTemplate(sheet);
  if (actual && expectedTemplate && actual.id !== expectedTemplate) {
    return (
      `This file is a ${actual.label}, not the roster this screen imports. ` +
      `Its columns are: ${foundList}. ` +
      `Upload it under ${actual.where} instead — importing it here would create records from the wrong data.`
    );
  }

  return (
    `Could not find a "${columnLabel}" column in sheet "${sheet.sheetName}". ` +
    `Looked for: ${aliases.map((a) => `"${a}"`).join(', ')}. ` +
    `The columns in your file (read from row ${sheet.headerRow}) are: ${foundList}. ` +
    `Rename the column to "${columnLabel}", or download the template and paste your data into it.`
  );
}
