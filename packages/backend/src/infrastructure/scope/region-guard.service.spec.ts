import { ForbiddenException } from '@nestjs/common';
import { Region } from '@fapoms/shared';
import { RegionGuardService } from './region-guard.service';

/**
 * The region ceiling on single-record reads.
 *
 * These cases exist because the list-scoping and the detail-route ceiling are two separate
 * mechanisms, and an adversarial review found six detail routes where only the first had been
 * applied. A scoped list is discovery control; this is access control.
 */
describe('RegionGuardService', () => {
  const dataSource = { query: jest.fn() };
  const guard = new RegionGuardService(dataSource as any);

  const west = { regions: [Region.WEST] };
  const national = { regions: null as any };

  beforeEach(() => dataSource.query.mockReset());

  describe('assertRegionAllowed', () => {
    it('allows anything when the account holds no assignment', () => {
      expect(() => guard.assertRegionAllowed(Region.SOUTH, national)).not.toThrow();
      expect(() => guard.assertRegionAllowed(Region.SOUTH, undefined)).not.toThrow();
      expect(() => guard.assertRegionAllowed(Region.SOUTH, { regions: [] })).not.toThrow();
    });

    it('allows a record inside the assignment', () => {
      expect(() => guard.assertRegionAllowed(Region.WEST, west)).not.toThrow();
    });

    it('refuses a record outside the assignment', () => {
      expect(() => guard.assertRegionAllowed(Region.SOUTH, west)).toThrow(ForbiddenException);
    });

    // A branch whose region could not be resolved must stay visible, or it becomes
    // permanently unfixable — only a scoped operator ever looks at it.
    it('allows a record with no region rather than hiding it forever', () => {
      expect(() => guard.assertRegionAllowed(null, west)).not.toThrow();
    });
  });

  describe('per-entity lookups', () => {
    it('refuses a branch in another region', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.SOUTH }]);
      await expect(guard.assertBranchInScope('b1', west)).rejects.toThrow(ForbiddenException);
    });

    it('allows a branch in the held region', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }]);
      await expect(guard.assertBranchInScope('b1', west)).resolves.toBeUndefined();
    });

    // Skipping the query entirely for national accounts keeps the ceiling off the hot path
    // for the desks it does not apply to.
    it('does not query at all for an unassigned account', async () => {
      await guard.assertBranchInScope('b1', national);
      await guard.assertAssignmentInScope('a1', national);
      await guard.assertScheduleInScope('s1', national);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('walks assignment -> project_branch -> branch', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.SOUTH }]);
      await expect(guard.assertAssignmentInScope('a1', west)).rejects.toThrow(ForbiddenException);
      expect(dataSource.query.mock.calls[0][0]).toContain('project_branches');
    });

    it('walks schedule -> assignment -> project_branch -> branch', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.SOUTH }]);
      await expect(guard.assertScheduleInScope('s1', west)).rejects.toThrow(ForbiddenException);
      expect(dataSource.query.mock.calls[0][0]).toContain('schedules');
    });

    // `GET /assayers/:assayerId/profile` accepts either form; comparing a code against a uuid
    // column raises `invalid input syntax` rather than refusing cleanly.
    it('looks an assayer up by id when given a UUID', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }]);
      await guard.assertAssayerInScope('3f2504e0-4f89-41d3-9a0c-0305e82c3301', west);
      expect(dataSource.query.mock.calls[0][0]).toContain('id = $1');
    });

    it('looks an assayer up by code when given a non-UUID', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }]);
      await guard.assertAssayerInScope('ASY-0042', west);
      expect(dataSource.query.mock.calls[0][0]).toContain('assayer_code = $1');
    });

    it('tolerates a missing record without throwing a lookup error', async () => {
      dataSource.query.mockResolvedValue([]);
      await expect(guard.assertBranchInScope('nope', west)).resolves.toBeUndefined();
    });
  });

  /**
   * `feedbackVerdict` — whether a socket may join a feedback thread's room. Mirrors the HTTP
   * rule in FeedbackService.findOne: the reporter, or a feedback-team role, may; nobody else.
   * `subscribe:feedback` used to be an unconditional join with no check at all.
   */
  describe('feedbackVerdict', () => {
    const THREAD_ID = '33333333-3333-3333-3333-333333333333';

    let row: any;
    const makeQueryBuilder = () => {
      const qb: any = {};
      for (const method of ['select', 'addSelect', 'where']) qb[method] = jest.fn(() => qb);
      qb.getRawOne = jest.fn(async () => row);
      return qb;
    };

    const guardWithRepo = () => {
      const repo = { createQueryBuilder: jest.fn(() => makeQueryBuilder()) };
      const ds = { getRepository: jest.fn(() => repo) };
      return { guard: new RegionGuardService(ds as any), repo };
    };

    it('refuses an unknown thread id', async () => {
      row = undefined;
      const { guard: g } = guardWithRepo();
      const verdict = await g.feedbackVerdict({ id: 'someone' }, THREAD_ID);
      expect(verdict).toEqual({ found: false, allowed: false });
    });

    it('admits the reporter by user id', async () => {
      row = { id: THREAD_ID, reporterUserId: 'reporter-1', reporterAssayerId: null };
      const { guard: g } = guardWithRepo();
      const verdict = await g.feedbackVerdict({ id: 'reporter-1' }, THREAD_ID);
      expect(verdict).toEqual({ found: true, allowed: true });
    });

    it('admits the reporter by assayer id', async () => {
      row = { id: THREAD_ID, reporterUserId: null, reporterAssayerId: 'assayer-1' };
      const { guard: g } = guardWithRepo();
      const verdict = await g.feedbackVerdict({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] }, THREAD_ID);
      expect(verdict).toEqual({ found: true, allowed: true });
    });

    it('admits a feedback-team member who is not the reporter', async () => {
      row = { id: THREAD_ID, reporterUserId: 'reporter-1', reporterAssayerId: null };
      const { guard: g } = guardWithRepo();
      const verdict = await g.feedbackVerdict({ id: 'admin-1', roles: [{ name: 'ADMIN' }] }, THREAD_ID);
      expect(verdict).toEqual({ found: true, allowed: true });
    });

    it('refuses a socket that is neither the reporter nor on the feedback team', async () => {
      row = { id: THREAD_ID, reporterUserId: 'reporter-1', reporterAssayerId: null };
      const { guard: g } = guardWithRepo();
      const verdict = await g.feedbackVerdict({ id: 'assayer-2', roles: [{ name: 'ASSAYER' }] }, THREAD_ID);
      expect(verdict).toEqual({ found: true, allowed: false });
    });
  });
});
