import { DocumentController } from './document.controller';
import { AssignmentStatus, SystemRole } from '@fapoms/shared';

/**
 * E17(d): a return uploaded with only the project branch to go on used an unordered `findOne` by
 * branch. A branch accumulates rows — the cancelled assignment and its replacement, a declined
 * offer and the next one — so which row the upload tried to complete was whatever Postgres handed
 * back first. It now prefers the live row, else the newest.
 */
describe('audited return resolved by project branch', () => {
  const dead = { id: 'asn-old', projectBranchId: 'pb-1', status: AssignmentStatus.CANCELLED, assayerId: 'as-1', createdAt: new Date('2026-09-01') };
  const live = { id: 'asn-live', projectBranchId: 'pb-1', status: AssignmentStatus.ACCEPTED, assayerId: 'as-1', createdAt: new Date('2026-09-10') };

  /** Mimics the database: returns the first row matching `where`, in `order` if one is given. */
  const repoOver = (rows: any[]) => ({
    findOne: jest.fn(async (opts: any) => {
      const w = opts.where ?? {};
      let hits = rows.filter((r) =>
        (w.projectBranchId === undefined || r.projectBranchId === w.projectBranchId)
        && (w.assessmentId === undefined || r.assessmentId === w.assessmentId)
        && (w.isActive === undefined || (r.isActive ?? true) === w.isActive)
        && (w.status === undefined || (w.status?._value ?? [w.status]).includes(r.status)));
      if (opts.order?.createdAt === 'DESC') hits = [...hits].sort((a, b) => +b.createdAt - +a.createdAt);
      return hits[0] ?? null;
    }),
  });

  const controller = (rows: any[]) => {
    const c: any = Object.create(DocumentController.prototype);
    c.assignmentRepository = repoOver(rows);
    c.assignmentService = { completeAssignment: jest.fn(async () => undefined) };
    c.logger = { warn: jest.fn() };
    return c;
  };

  it('completes the live assignment even when the dead one comes first in storage', async () => {
    const c = controller([dead, live]);
    const out = await c.completeAssignmentForReturn(
      { id: 'doc-1', assessmentId: null }, undefined, 'pb-1', { id: 'as-1', roles: [SystemRole.ASSAYER] }, 'r.pdf',
    );
    expect(out).toEqual({ completed: true });
    expect(c.assignmentService.completeAssignment).toHaveBeenCalledWith('asn-live', 'as-1');
  });

  it('with no live row, takes the newest — deterministically', async () => {
    const newer = { ...dead, id: 'asn-newer', createdAt: new Date('2026-09-20'), status: AssignmentStatus.REJECTED };
    const c = controller([dead, newer]);
    const picked = await c.assignmentForBranch('pb-1');
    expect(picked.id).toBe('asn-newer');
  });

  it('asks for the order explicitly on both reads', async () => {
    const c = controller([]);
    await c.assignmentForBranch('pb-1');
    for (const [opts] of c.assignmentRepository.findOne.mock.calls) {
      expect(opts.order).toEqual({ createdAt: 'DESC', id: 'DESC' });
    }
    expect(c.assignmentRepository.findOne.mock.calls[0][0].where).toMatchObject({ projectBranchId: 'pb-1', isActive: true });
  });

  /**
   * E11 leftover: the lookup by assessment id, which runs just before the branch fallback, had the
   * same unordered `findOne` — an assessment belongs to one project branch and carries the same
   * history of rows. It now uses the same live-first, newest-next preference.
   */
  it('by assessment id: completes the live assignment even when the dead one comes first', async () => {
    const c = controller([{ ...dead, assessmentId: 'as-9' }, { ...live, assessmentId: 'as-9' }]);
    const out = await c.completeAssignmentForReturn(
      { id: 'doc-1', assessmentId: 'as-9' }, undefined, undefined, { id: 'as-1', roles: [SystemRole.ASSAYER] }, 'r.pdf',
    );
    expect(out).toEqual({ completed: true });
    expect(c.assignmentService.completeAssignment).toHaveBeenCalledWith('asn-live', 'as-1');
    for (const [opts] of c.assignmentRepository.findOne.mock.calls) {
      expect(opts.order).toEqual({ createdAt: 'DESC', id: 'DESC' });
    }
  });

  it('by assessment id with no live row: the newest, deterministically', async () => {
    const newer = { ...dead, id: 'asn-newer', assessmentId: 'as-9', createdAt: new Date('2026-09-20'), status: AssignmentStatus.REJECTED };
    const c = controller([{ ...dead, assessmentId: 'as-9' }, newer]);
    expect((await c.assignmentForAssessment('as-9')).id).toBe('asn-newer');
  });
});
