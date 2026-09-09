import { readFileSync } from 'fs';
import { join } from 'path';
import {
  HELD_RECEIVABLE_SQL,
  REVENUE_TAXABLE_SQL,
  UNBILLED_RECEIVABLE_SQL,
  UNBILLED_ROW_FILTER_SQL,
  UNBILLED_TAXABLE_SQL,
  heldReceivableSql,
  revenueTaxableSql,
  unbilledReceivableSql,
  unbilledRowFilterSql,
  unbilledTaxableSql,
} from './billing-metrics';

/**
 * "Unbilled" must mean one thing across every surface that says the word.
 *
 * It did not. `GET /system-dashboard/operations` returned `money.unbilled = 3200` and
 * `GET /billing-engine/overview` returned `receivables.unbilled = 3456`, live, on the same rows
 * on the same day: one summed `taxable_amount` and the other `total_amount`, so the label was
 * shared and the definition was not.
 *
 * The definition now lives in `billing-metrics.ts`. These tests hold three things:
 *  1. the fragment itself is on the receivable basis and filters the rows it claims to;
 *  2. every surface that reports an unbilled figure selects through the shared fragment rather
 *     than writing its own SUM — checked by reading the sources, because the two live on
 *     different modules and no unit test would otherwise notice one of them drifting away;
 *  3. the ex-GST figure keeps a different name, which is the whole instruction: rename the
 *     metric rather than show two numbers under one label.
 */

const BACKEND_SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(BACKEND_SRC, rel), 'utf8');

const SURFACES = [
  { name: 'billing overview (receivables.unbilled)', file: 'modules/billing-engine/billing-engine.service.ts' },
  { name: 'operations dashboard (money.unbilled)', file: 'modules/user/operations-snapshot.service.ts' },
];

describe('the canonical unbilled definition', () => {
  it('sums the receivable, not the taxable value', () => {
    expect(UNBILLED_RECEIVABLE_SQL).toContain('SUM(total_amount)');
    expect(UNBILLED_RECEIVABLE_SQL).not.toContain('taxable_amount');
  });

  it('counts only live, un-invoiced, un-held lines', () => {
    expect(UNBILLED_ROW_FILTER_SQL).toBe(`state = 'UNBILLED' AND on_hold = false`);
    expect(UNBILLED_RECEIVABLE_SQL).toContain(UNBILLED_ROW_FILTER_SQL);
  });

  it('returns 0 rather than NULL for an empty book', () => {
    expect(UNBILLED_RECEIVABLE_SQL.startsWith('COALESCE(')).toBe(true);
    expect(UNBILLED_RECEIVABLE_SQL.endsWith(', 0)')).toBe(true);
  });

  it('qualifies every column when the caller aliases the table', () => {
    // `overview()` aliases billing_entries (`e`, `be`) for its region predicates; an unqualified
    // fragment there is an ambiguous-column error at runtime, not a compile failure.
    const aliased = unbilledReceivableSql('be');
    expect(aliased).toContain('SUM(be.total_amount)');
    expect(aliased).toContain(`be.state = 'UNBILLED'`);
    expect(aliased).toContain('be.on_hold = false');
    // No bare column names left behind.
    expect(aliased.replace(/be\.[a-z_]+/g, '')).not.toMatch(/\b(total_amount|state|on_hold)\b/);
  });

  it('gives the aliased and unaliased forms the same shape', () => {
    for (const [fn, constant] of [
      [unbilledReceivableSql, UNBILLED_RECEIVABLE_SQL],
      [unbilledTaxableSql, UNBILLED_TAXABLE_SQL],
      [heldReceivableSql, HELD_RECEIVABLE_SQL],
      [revenueTaxableSql, REVENUE_TAXABLE_SQL],
      [unbilledRowFilterSql, UNBILLED_ROW_FILTER_SQL],
    ] as Array<[(a?: string) => string, string]>) {
      expect(fn()).toBe(constant);
      expect(fn('x')).toBe(constant.replace(/\b(total_amount|taxable_amount|state|on_hold)\b/g, 'x.$1'));
    }
  });
});

describe('every surface reports the same unbilled figure', () => {
  for (const { name, file } of SURFACES) {
    it(`${name} selects through the shared fragment`, () => {
      const src = read(file);
      expect(src).toContain(`from './billing-metrics'`.replace('./', file.includes('billing-engine') ? './' : '../billing-engine/'));
      expect(src).toMatch(/\$\{(UNBILLED_RECEIVABLE_SQL|unbilledReceivableSql\([^)]*\))\}\s*(\n\s*)?AS unbilled/);
    });

    it(`${name} has no hand-written unbilled SUM of its own`, () => {
      // The exact shape of the defect: a second SUM over the same rows, on the other basis.
      const offenders = read(file)
        .split('\n')
        .filter((line) => /SUM\(\s*\w*\.?taxable_amount\s*\)\s*FILTER\s*\(\s*WHERE[^)]*UNBILLED/i.test(line));
      expect(offenders).toEqual([]);
    });
  }

  it('leaves no other backend source summing an unbilled figure for itself', () => {
    const { readdirSync, statSync } = jest.requireActual('fs') as typeof import('fs');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const full of walk(BACKEND_SRC)) {
      const rel = full.slice(BACKEND_SRC.length + 1);
      if (rel.includes('billing-engine/billing-metrics.ts') || rel.includes('database/migrations/')) continue;
      for (const line of readFileSync(full, 'utf8').split('\n')) {
        if (/SUM\([^)]*(total_amount|taxable_amount)[^)]*\)\s*FILTER\s*\([^)]*UNBILLED/i.test(line)) {
          offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the ex-GST figure keeps its own name', () => {
  it('is a different fragment from the one labelled unbilled', () => {
    expect(UNBILLED_TAXABLE_SQL).not.toBe(UNBILLED_RECEIVABLE_SQL);
    expect(UNBILLED_TAXABLE_SQL).toContain('SUM(taxable_amount)');
    expect(UNBILLED_TAXABLE_SQL).toContain(UNBILLED_ROW_FILTER_SQL);
  });

  it('keeps revenue on the taxable basis, since margin is computed from it', () => {
    expect(REVENUE_TAXABLE_SQL).toContain('SUM(taxable_amount)');
    expect(REVENUE_TAXABLE_SQL).toContain(`state <> 'CANCELLED'`);
  });

  it('keeps held on the receivable basis, so it adds to the same book as unbilled', () => {
    expect(HELD_RECEIVABLE_SQL).toContain('SUM(total_amount)');
  });

  it('never labels the taxable figure "Unbilled" on a screen', () => {
    // The instruction was to rename the metric rather than show two numbers under one label.
    // "Unbilled revenue" was the operations dashboard's alert label while it carried the taxable
    // number, which named the defect out loud: revenue is this product's word for ex-GST.
    const snapshot = read('modules/user/operations-snapshot.service.ts');
    expect(snapshot).not.toContain("'Unbilled revenue'");
  });
});
