import * as xlsx from 'xlsx';
import { DocumentController } from './document.controller';

/**
 * `validateCustomerExcel` used to read `SheetNames[0]` unconditionally and match columns with a
 * hand-rolled `row['Account Number'] || row.ACCOUNT_NO || row.AccountNo` chain per field — the
 * same gap as `customer-master.service.ts`'s real importer, and drifted from it besides: this
 * preview recognised a bare `BRANCH`/`Branch` header for the SOL ID column that the real importer
 * did not, so a file using that heading could preview as "0 missing branches" and then import
 * with every row unmatched. Both now read the same alias list from one place
 * (`customer-master.service.ts`'s exported `CUSTOMER_*_ALIASES`).
 *
 * The method touches nothing on `this` — it is a pure function of the uploaded buffer — so the
 * controller is constructed with every other dependency `null`, same as this file's sibling
 * `document-controller-ownership.spec.ts` already does for its own single-method tests.
 */
describe('validateCustomerExcel — column-name tolerance', () => {
  const controller = new DocumentController(
    null as any, null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any, null as any,
  );

  function fileFromAoa(rows: unknown[][]) {
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buffer = Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    return { buffer, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: buffer.length, originalname: 'f.xlsx' };
  }

  it('recognises BRANCH as a SOL ID column, the same as the real importer now does', () => {
    const file = fileFromAoa([
      ['Account Number', 'BRANCH'],
      ['ACC-1', '0001'],
      ['ACC-2', '0002'],
    ]);
    const result = (controller as any).validateCustomerExcel(file);
    expect(result.data.summary.missingBranchCodesCount).toBe(0);
    expect(result.data.summary.uniqueBranchesCount).toBe(2);
  });

  it('matches the SCREAMING_SNAKE spelling too', () => {
    const file = fileFromAoa([
      ['ACCOUNT_NO', 'SOL_ID'],
      ['ACC-1', '0001'],
    ]);
    const result = (controller as any).validateCustomerExcel(file);
    expect(result.data.summary.totalRowsProcessed).toBe(1);
    expect(result.data.summary.missingBranchCodesCount).toBe(0);
  });

  it('finds the header row even when a title sits above it', () => {
    const file = fileFromAoa([
      ['CUSTOMER MASTER — SEPTEMBER 2026'],
      [],
      ['Account Number', 'SOL ID'],
      ['ACC-1', '0001'],
      ['ACC-1', '0001'], // deliberate duplicate account
    ]);
    const result = (controller as any).validateCustomerExcel(file);
    expect(result.data.summary.totalRowsProcessed).toBe(2);
    expect(result.data.summary.duplicateAccountsCount).toBe(1);
  });

  it('still counts a genuinely missing SOL ID as a missing branch', () => {
    const file = fileFromAoa([
      ['Account Number', 'SOL ID'],
      ['ACC-1', ''],
    ]);
    const result = (controller as any).validateCustomerExcel(file);
    expect(result.data.summary.missingBranchCodesCount).toBe(1);
  });
});
