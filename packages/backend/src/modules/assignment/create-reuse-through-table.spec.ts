import { readFileSync } from 'fs';
import { join } from 'path';
import { AssignmentStatus } from '@fapoms/shared';
import { AssignmentStateMachine } from './assignment.state-machine';

/**
 * B13 (2026-09-24): `create()` reusing a declined row wrote `status = PENDING` directly — the one
 * way back to PENDING no transition table consulted. It now goes through
 * `AssignmentStateMachine.reassign`, as `reassignAssignment` does.
 */
describe('create() reuses a row only through the transition table', () => {
  const source = readFileSync(join(__dirname, 'assignment.service.ts'), 'utf8');
  const from = source.indexOf('  async create(dto: CreateAssignmentDto');
  const to = source.indexOf('\n  async ', from + 10);
  const body = source.slice(from, to);

  it('has no direct PENDING write and calls the table', () => {
    expect(from).toBeGreaterThan(-1);
    expect(body).not.toMatch(/assignment\.status\s*=\s*AssignmentStatus\.PENDING/);
    expect(body).toMatch(/AssignmentStateMachine\.reassign\(assignment, userId\)/);
  });

  it('the table allows the declined row back and refuses reviving finished work', () => {
    const row = (status: AssignmentStatus) => ({ status }) as any;
    expect(() => AssignmentStateMachine.reassign(row(AssignmentStatus.REJECTED), 'u')).not.toThrow();
    expect(() => AssignmentStateMachine.reassign(row(AssignmentStatus.COMPLETED), 'u')).toThrow();
    expect(() => AssignmentStateMachine.reassign(row(AssignmentStatus.CANCELLED), 'u')).toThrow();
  });
});
