import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The assessment stays a link.
 *
 * It exists so a document has something to hang off for one project and one branch. On top of
 * that it had grown an eighteen-state `status`, an `audit_date`, an `assigned_assessor_id`, an
 * `agreed_fee`, a `packet_size`, a `coverage_flag`, a `priority`, a `zone_id` and `remarks` —
 * every one of them written by some service and read by nobody. Four code paths translated
 * between three vocabularies to keep that decoration in step with the branch and the assignment
 * that actually hold those facts.
 *
 * This guards the shape rather than the behaviour, because there is no behaviour to guard: the
 * point is that these facts have one home each, and it is not here. A field re-added to this
 * entity should have to justify itself against a failing test.
 */
describe('the assessment entity', () => {
  const source = readFileSync(join(__dirname, 'assessment.entity.ts'), 'utf8');

  it('carries the link and nothing else', () => {
    const columns = [...source.matchAll(/^\s{2}(\w+)[?!]?:/gm)].map((m) => m[1]);
    expect(columns.sort()).toEqual(['assignments', 'branch', 'branchId', 'project', 'projectId']);
  });

  it.each([
    ['status', 'the branch and the document each already say where the work is'],
    ['auditDate', 'the audit date lives on the project branch'],
    ['assignedAssessorId', 'the assayer lives on the assignment'],
    ['agreedFee', 'the fee lives on the assignment, and billing reads it from there'],
    ['packetSize', 'the packet count lives on the project branch'],
    ['coverageFlag', 'nothing ever read it'],
    ['priority', 'nothing ever read it'],
    ['zoneId', 'the zone lives on the branch'],
    ['remarks', 'nothing ever read it'],
  ])('does not bring back `%s` — %s', (field) => {
    expect(source).not.toContain(`  ${field}:`);
  });

  it('keeps no index on a column it no longer has', () => {
    expect(source).not.toContain("@Index(['status'])");
  });
});
