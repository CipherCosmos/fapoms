import * as fs from 'fs';
import * as path from 'path';

/**
 * Soft deletion has to reach the grandchildren, not just the children.
 *
 * Every `remove()` in this codebase sets `is_active = false` and then hand-writes an UPDATE per
 * child table. That works exactly as long as somebody remembers the whole tree — and on this
 * database nobody had:
 *
 *   - Deleting a client deactivated its branches and stopped. `BranchService.remove` knows a
 *     branch also owns contacts, documents, project links and assessments, but the client path
 *     never called it, so 11 branch contacts stayed live under 10 deleted SBI branches.
 *   - Deleting an assayer deactivated their assignments and stopped, leaving 2 ACCEPTED
 *     schedules live — dated slots on the dispatch calendar held by a profile that no longer
 *     exists.
 *
 * Both are the same failure: a partial cascade is invisible. The parent disappears from its own
 * list, everything looks right, and the orphans surface weeks later somewhere nobody connected
 * to the deletion.
 *
 * So the tree is declared here and checked against the source. This is a structural test, not a
 * behavioural one — it cannot prove the UPDATEs are correct, only that no branch of the cascade
 * has been forgotten, which is the mistake that actually gets made.
 */

const SRC = path.join(__dirname, '../..');

/**
 * What each soft delete must reach.
 *
 * Read as: "when you delete a CLIENT, these tables must also be deactivated". Grandchildren are
 * listed explicitly rather than implied by the child's own entry, because these services do not
 * call each other — each writes its own SQL, so each needs its own complete list.
 */
const CASCADES: { service: string; removes: string; mustDeactivate: string[] }[] = [
  {
    service: 'modules/client/client.service.ts',
    removes: 'client',
    mustDeactivate: [
      'client_configurations',
      'client_contacts',
      'client_contracts',
      'client_billing',
      'branches',
      // The grandchildren the branch owns. Missing these is the SBI bug.
      'branch_contacts',
      'branch_documents',
      'project_branches',
      'assessments',
      'zones',
    ],
  },
  {
    service: 'modules/branch/branch.service.ts',
    removes: 'branch',
    mustDeactivate: ['branch_contacts', 'branch_documents', 'project_branches', 'assessments'],
  },
  {
    service: 'modules/project/project.service.ts',
    removes: 'project',
    mustDeactivate: [
      'project_branches',
      'assessments',
      'assignments',
      // The dated slots those assignments carry — the same gap the assayer path had.
      'schedules',
      'documents',
      'validation_cases',
      'validation_queries',
    ],
  },
  {
    service: 'modules/assayer/assayer.service.ts',
    removes: 'assayer',
    mustDeactivate: [
      'assayer_commercial_profiles',
      'assayer_documents',
      'assayer_government_documents',
      'assignments',
      // The scheduled visits those assignments carry. Missing this is the AS-02 bug.
      'schedules',
    ],
  },
];

/** The body of the service's `remove(` method, up to the next method at the same indent. */
function removeMethodBody(relativePath: string): string {
  const source = fs.readFileSync(path.join(SRC, relativePath), 'utf8');
  const start = source.indexOf('async remove(');
  if (start === -1) return '';
  // The audit event is always the last thing a remove() does, so it is a reliable terminator
  // and keeps the slice from running into the next method.
  const end = source.indexOf('async ', start + 10);
  return source.slice(start, end === -1 ? source.length : end);
}

describe('soft-delete cascades', () => {
  it.each(CASCADES)('deleting a $removes deactivates everything beneath it', ({ service, mustDeactivate }) => {
    const body = removeMethodBody(service);
    expect(body).not.toBe('');

    const missing = mustDeactivate.filter((table) => {
      // Look for the table being set inactive anywhere in the method — the statements vary
      // (direct `WHERE x_id = $2`, or `WHERE ... IN (SELECT ...)` for grandchildren), so match
      // on the table name appearing in an UPDATE that clears is_active.
      const updatePattern = new RegExp(`UPDATE\\s+${table}\\s+SET\\s+is_active\\s*=\\s*false`, 'i');
      return !updatePattern.test(body);
    });

    expect(missing).toEqual([]);
  });

  /**
   * The cascades are hand-written SQL rather than repository calls, so they bypass TypeORM's
   * entity hooks entirely. That is a deliberate choice — one statement per child table beats N
   * round trips for a client with thousands of branches — but it means the `updated_by` audit
   * column has to be set explicitly, and forgetting it loses who performed the deletion.
   */
  it.each(CASCADES)('records who performed the deletion on every cascaded row ($removes)', ({ service }) => {
    const body = removeMethodBody(service);
    const updates = body.match(/UPDATE\s+\w+\s+SET\s+is_active\s*=\s*false[^`]*/gi) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const statement of updates) {
      expect(statement).toContain('updated_by');
    }
  });
});
