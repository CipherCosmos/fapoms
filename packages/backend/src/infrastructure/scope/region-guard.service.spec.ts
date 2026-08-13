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
});
