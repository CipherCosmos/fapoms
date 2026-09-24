/**
 * FAPOMS — reading a client's branch list: which columns mean what, and which files are not one.
 *
 * Lifted out of `ProjectService`, where the two importers (the queued one and the reconcile preview)
 * each read the same columns through their own copy of the same alias lists. One reading now serves
 * the request (refusing a wrong file before anything is stored) and the rehearsal job alike, so a
 * file refused at the door and a file read in the worker are read identically.
 */

import { BadRequestException } from '@nestjs/common';
import { resolveRegion } from '@fapoms/shared';
import {
  BLANK_HEADER,
  identifyTemplate,
  normaliseHeader,
  parseSheet,
  rowReader,
  type ParsedSheet,
} from '../../../core/excel/sheet-reader';

/** The columns a bank uses to name a branch's SOL ID — "SOL ID", but also a plain "BRANCH" code. */
export const SOL_COLUMNS = [
  'SOL ID', 'SolId', 'SOL_ID', 'Sol', 'SOL', 'SOL NO', 'SolNo',
  'BRANCH', 'Branch Code', 'BranchCode', 'BrCode', 'Code',
] as const;
export const NAME_COLUMNS = ['BRANCH_NAME', 'Branch Name', 'BranchName', 'Name'] as const;

/** One row of a branch list, as text. Nothing here is looked up or guessed. */
export interface BranchSheetRow {
  solId: string;
  name: string;
  district: string;
  state: string;
  address: string;
  pincode: string;
  city: string;
  bank: string;
  ifsc: string;
  location: string;
  latitude: string;
  longitude: string;
  packets: string;
  managerName: string;
  phone: string;
  email: string;
}

/**
 * Parse a branch workbook and refuse the files that are not one: an empty first sheet, or another
 * importer's file (an assayer roster has a name and an address column too, and would otherwise make
 * a "branch" of every person).
 */
export function parseBranchSheet(fileBuffer: Buffer): ParsedSheet {
  let sheet: ParsedSheet;
  try {
    // Finds the header row rather than assuming row 1 — client lists open with a merged title.
    sheet = parseSheet(fileBuffer, ['BRANCH', 'BRANCH_NAME', 'STATE']);
  } catch {
    throw new BadRequestException('This file could not be read as a spreadsheet. Save it as .xlsx and upload it again.');
  }
  if (sheet.rows.length === 0) {
    throw new BadRequestException(
      `The first sheet of this file ("${sheet.sheetName || 'none'}") has no data rows. ` +
        'Download the template, fill in the Branch sheet, and upload that.',
    );
  }
  const identified = identifyTemplate(sheet);
  if (identified && identified.id !== 'branch-import') {
    throw new BadRequestException(
      `This file is a ${identified.label}, not a branch list. ` +
        `Upload it under ${identified.where} instead — importing it here would create branches out of the wrong data.`,
    );
  }
  return sheet;
}

/** Read one row's cells through every alias a real client file has used. */
export function readBranchRow(row: Record<string, unknown>, askedFor?: Set<string>): BranchSheetRow {
  const get = rowReader(row as Record<string, any>, askedFor);
  return {
    solId: get(...SOL_COLUMNS),
    name: get(...NAME_COLUMNS),
    district: get('DISTRICT', 'District', 'DistrictName'),
    state: get('STATE', 'State', 'StateName'),
    address: get('Branch Address', 'Address', 'BranchAddress'),
    pincode: get('Pincode', 'Pin', 'Pin Code', 'Postal Code', 'Zip'),
    city: get('CITY', 'City', 'CityName'),
    bank: get('BANK', 'Bank', 'Bank Name', 'BankName', 'Client', 'Client Name', 'Institution'),
    ifsc: get('IFSC', 'IFSC Code', 'Ifsc', 'IfscCode'),
    location: get('Google Maps Link', 'Maps Link', 'Location URL', 'Map URL', 'Coordinates', 'Location', 'Geo'),
    latitude: get('Latitude', 'Lat'),
    longitude: get('Longitude', 'Lng', 'Long'),
    packets: get('Packets', 'packet_count', 'Packet Count'),
    managerName: get('Branch Manager', 'Manager', 'Manager Name'),
    phone: get('Branch Phone', 'Phone', 'Contact Number'),
    email: get('Branch Email', 'Email'),
  };
}

/** A wholly blank row — the trailing rows Excel leaves behind. Not worth reporting. */
export function isBlankBranchRow(row: Pick<BranchSheetRow, 'solId' | 'name'>): boolean {
  return !row.solId && !row.name;
}

/** The row's number as the person sees it in Excel: the header row, plus whatever preceded it. */
export function sheetRowNumber(sheet: Pick<ParsedSheet, 'headerRow'>, index: number): number {
  return index + sheet.headerRow + 1;
}

/**
 * Name any column nobody read, so a renamed heading cannot cost a field in silence. Only columns
 * carrying data are named; the column is NAMED, never guessed into a field.
 */
export function unrecognisedColumnNotes(sheet: ParsedSheet, askedFor: Set<string>): string[] {
  const notes: string[] = [];
  for (const header of sheet.headers) {
    if (!header || BLANK_HEADER.test(header)) continue;
    if (askedFor.has(normaliseHeader(header))) continue;
    const carrying = sheet.rows.filter((r) => String(r?.[header] ?? '').trim() !== '').length;
    if (carrying === 0) continue;
    notes.push(
      `Column "${header}" was not recognised, so ${carrying} row(s) of data in it were not imported. ` +
        'If that column holds something this system stores, rename its heading to the one the ' +
        'template uses and import again — nothing was guessed.',
    );
  }
  return notes;
}

/**
 * The regions a branch list names directly, and the SOL IDs of rows that name no state (whose region
 * is whatever the branch master says — the caller looks those up, for THIS client only).
 */
export function branchSheetRegions(sheet: ParsedSheet): { regions: Set<string>; solsWithoutState: string[] } {
  const regions = new Set<string>();
  const solsWithoutState: string[] = [];
  for (const raw of sheet.rows) {
    const row = readBranchRow(raw);
    if (isBlankBranchRow(row)) continue;
    const region = resolveRegion(row.state);
    if (region) regions.add(region);
    else if (row.solId) solsWithoutState.push(row.solId.trim());
  }
  return { regions, solsWithoutState };
}
