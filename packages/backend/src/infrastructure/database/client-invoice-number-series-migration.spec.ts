import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Audit F7 (2026-09-24): client invoice numbers `INV/25-26/000123`, from one counter row per
 * financial year, advanced inside the invoice's own transaction.
 */
describe('ClientInvoiceNumberSeries1801300000100', () => {
  const dir = join(__dirname, 'migrations');
  const migration = readFileSync(join(dir, '1801300000100-ClientInvoiceNumberSeries.ts'), 'utf8');

  it('keys the counter on the financial year and bounds the serial to six digits', () => {
    expect(migration).toMatch(/PRIMARY KEY \("financial_year"\)/);
    expect(migration).toContain(`CHECK ("last_serial" BETWEEN 1 AND 999999)`);
    expect(migration).toContain(`CHECK ("financial_year" ~ '^[0-9]{2}-[0-9]{2}$')`);
  });

  it('does not renumber existing invoices', () => {
    expect(migration).not.toMatch(/UPDATE\s+"?billing_invoices"?/i);
  });

  it('runs after the HOD final-approval migration, and nothing else shares its timestamps', () => {
    const stamps = readdirSync(dir).filter((f) => /^\d+-.*\.ts$/.test(f)).map((f) => Number(f.split('-')[0]));
    expect(stamps).toContain(1801200000000);
    expect(Math.min(1801300000000, 1801300000100)).toBeGreaterThan(1801200000000);
    expect(stamps.filter((s) => s === 1801300000000 || s === 1801300000100)).toHaveLength(2);
  });
});
