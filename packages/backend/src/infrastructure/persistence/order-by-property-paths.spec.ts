import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

/**
 * `orderBy` takes a property path, not a column name.
 *
 * WHERE clauses in a query builder are passed through to SQL untouched, so `a.sla_due_date`
 * works there and reads naturally next to hand-written predicates. Ordering is different: the
 * moment a query joins a relation and calls `take()`, TypeORM fetches distinct ids in a
 * subquery and re-applies the ordering to it — which means every ORDER BY term is looked up in
 * the entity metadata. A column name resolves to nothing, and the lookup dereferences it
 * anyway:
 *
 *   TypeError: Cannot read properties of undefined (reading 'databaseName')
 *       at SelectQueryBuilder.createOrderByCombinedWithSelectExpression
 *
 * That was a 500 on every request to the Falling Behind board, from a single underscore. It
 * survived a full unit suite because the repositories are mocked there — nothing resolved a
 * real property path — and it does not fail until a query has both a joined relation and a
 * row limit, so the two neighbouring queries written the same way kept working.
 *
 * The rule is cheap to hold and the failure is expensive to find, so it is a lint rather than
 * a test of behaviour: no ordering term in the backend may name a database column.
 */
describe('query builder ordering', () => {
  const ROOT = join(__dirname, '..', '..');

  /** Every `.orderBy(...)`/`.addOrderBy(...)` argument in the backend, with where it came from. */
  const orderingTerms = (): { file: string; line: number; term: string }[] => {
    const files = execSync(
      `git ls-files '*.ts' | grep -v '\\.spec\\.ts$' | grep -v '/migrations/'`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean);

    const found: { file: string; line: number; term: string }[] = [];
    for (const relative of files) {
      const lines = readFileSync(join(ROOT, relative), 'utf8').split('\n');
      lines.forEach((text, i) => {
        for (const m of text.matchAll(/\.(?:add)?orderBy\(\s*'([^']+)'/gi)) {
          found.push({ file: relative, line: i + 1, term: m[1] });
        }
      });
    }
    return found;
  };

  it('names entity properties, never database columns', () => {
    // `alias.some_column` — an underscore inside the part after the dot is the tell.
    const columnNamed = orderingTerms().filter(({ term }) => /^\w+\.\w*_\w/.test(term));

    expect(columnNamed.map((t) => `${t.file}:${t.line} → ${t.term}`)).toEqual([]);
  });

  it('finds ordering terms at all, so the rule cannot pass by scanning nothing', () => {
    expect(orderingTerms().length).toBeGreaterThan(5);
  });
});
