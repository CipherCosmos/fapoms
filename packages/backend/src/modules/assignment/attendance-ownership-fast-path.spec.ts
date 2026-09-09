import { SystemRole } from '@fapoms/shared';
import { AssignmentService } from './assignment.service';

/**
 * Check-in and check-out must ask who is calling before ANY shortcut answers.
 *
 * This file exists because the first repair of that defect only half-landed, and the existing
 * unit tests could not tell. `check-out.spec.ts` builds a `dataSource` with no `transaction`, so
 * `runTransactional` takes its fallback branch, `manager.query` is undefined, the locked row is
 * never read and all three of the shortcuts that read it are skipped. Every ownership assertion
 * in that file therefore lands on the *second* copy of the check — the one that runs after
 * `findOne` — and passed happily while the first copy was still returning the whole record to a
 * stranger. Live HTTP re-verification after the fix is what caught it.
 *
 * So the harness here is deliberately the one the deployed code takes: a real transaction, a
 * `manager.query` that returns a locked row, and a `findOne` that would hand over the entity if
 * anything reached it. Two things are asserted on every refusal — the error, and that `findOne`
 * was never called — because "returned no record" and "never looked one up" are different
 * promises and only the second one closes a disclosure.
 */
describe('attendance shortcuts run behind the ownership check', () => {
  const OWNER = 'assayer-owner';
  const STRANGER = 'assayer-stranger';

  const ENTITY = {
    id: 'asg-1',
    assayerId: OWNER,
    status: 'CHECKED_IN',
    checkedInAt: new Date('2026-09-01T04:00:00Z'),
    checkedOutAt: null,
    syncToken: 'SYNC-1',
    // The fields the live leak handed over: the assignee's contact details and home fix.
    assayer: { displayName: 'Owner', email: 'owner@example.invalid', phone: '+910000000000' },
    projectBranch: { branch: { name: 'Fort Branch', latitude: 18.52, longitude: 73.85 } },
  };

  /**
   * @param row  what `SELECT … FOR UPDATE` finds
   * @param actorRoles  roles the calling *user* holds, empty for a bare assayer principal
   */
  const makeService = (row: Record<string, any>, actorRoles: string[] = []) => {
    const service = Object.create(AssignmentService.prototype) as AssignmentService;
    const findOne = jest.fn().mockResolvedValue({ ...ENTITY });
    (service as any).findOne = findOne;
    (service as any).assignmentRepository = { save: jest.fn(async (a: any) => a) };

    const manager = {
      query: jest.fn().mockResolvedValue([row]),
      save: jest.fn(async (a: any) => a),
      findOne: jest.fn().mockResolvedValue(null),
    };
    (service as any).dataSource = {
      transaction: (work: any) => work(manager),
      getRepository: () => ({
        findOne: jest.fn().mockResolvedValue(
          actorRoles.length ? { id: 'u-1', roles: actorRoles.map((name) => ({ name })) } : null,
        ),
      }),
    };
    (service as any).locationTrail = { record: jest.fn().mockResolvedValue(undefined) };
    (service as any).auditService = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    (service as any).notificationService = { create: jest.fn().mockResolvedValue(undefined) };
    (service as any).ruleBypass = { isBypassed: jest.fn().mockResolvedValue(false), noteBypass: jest.fn() };
    return { service, findOne };
  };

  const checkedInRow = {
    id: 'asg-1', status: 'CHECKED_IN', entity_version: 3, assayer_id: OWNER,
    checked_in_at: new Date('2026-09-01T04:00:00Z'), checked_out_at: null, sync_token: 'SYNC-1',
  };

  describe('recordCheckIn', () => {
    it('refuses a stranger an already-checked-in assignment, and looks up no record to refuse with', async () => {
      const { service, findOne } = makeService(checkedInRow);
      const res: any = await service.recordCheckIn('asg-1', 1, 1, undefined, STRANGER, 5);

      expect(res.success).toBe(false);
      expect(res.error).toBe('NOT_YOUR_ASSIGNMENT');
      expect(res.assignment).toBeFalsy();
      expect(findOne).not.toHaveBeenCalled();
    });

    it('answers a stranger nothing about a cancelled assignment — not even that it is cancelled', async () => {
      const { service, findOne } = makeService({ ...checkedInRow, status: 'CANCELLED', checked_in_at: null });
      const res: any = await service.recordCheckIn('asg-1', 1, 1, undefined, STRANGER, 5);

      expect(res.error).toBe('NOT_YOUR_ASSIGNMENT');
      expect(res.error).not.toBe('ASSIGNMENT_CANCELLED');
      expect(findOne).not.toHaveBeenCalled();
    });

    it('answers a stranger nothing about a completed assignment either', async () => {
      const { service } = makeService({ ...checkedInRow, status: 'COMPLETED', checked_in_at: null });
      const res: any = await service.recordCheckIn('asg-1', 1, 1, undefined, STRANGER, 5);

      expect(res.error).toBe('NOT_YOUR_ASSIGNMENT');
      expect(res.error).not.toBe('ASSIGNMENT_COMPLETED');
    });

    it('refuses a version oracle too — a stranger cannot learn the server version', async () => {
      const { service } = makeService(checkedInRow);
      const res: any = await service.recordCheckIn('asg-1', 1, 1, undefined, STRANGER, 5, {
        expectedVersion: 1,
      });

      expect(res.error).toBe('NOT_YOUR_ASSIGNMENT');
      expect(String(res.message)).not.toContain('version 3');
    });

    it('still gives the assignee the idempotent answer on a retry', async () => {
      const { service } = makeService(checkedInRow);
      const res: any = await service.recordCheckIn('asg-1', 1, 1, undefined, OWNER, 5);

      expect(res.success).toBe(true);
      expect(res.message).toMatch(/^Already checked in at /);
      expect(res.assignment).toBeTruthy();
    });

    it('still lets operations answer for the assignee', async () => {
      const { service } = makeService(checkedInRow, [SystemRole.OPERATIONS]);
      const res: any = await service.recordCheckIn('asg-1', 1, 1, undefined, 'ops-user', 5);

      expect(res.success).toBe(true);
      expect(res.assignment).toBeTruthy();
    });

    it('refuses a desk user — reading is not the same grant as attending', async () => {
      const { service, findOne } = makeService(checkedInRow, [SystemRole.DESK]);
      const res: any = await service.recordCheckIn('asg-1', 1, 1, undefined, 'desk-user', 5);

      expect(res.error).toBe('NOT_YOUR_ASSIGNMENT');
      expect(findOne).not.toHaveBeenCalled();
    });
  });

  describe('recordCheckOut', () => {
    const checkedOutRow = { ...checkedInRow, checked_out_at: new Date('2026-09-01T09:30:00Z') };

    it('refuses a stranger an already-checked-out assignment, and looks up no record to refuse with', async () => {
      const { service, findOne } = makeService(checkedOutRow);
      const res: any = await service.recordCheckOut('asg-1', 1, 1, undefined, STRANGER, 5);

      expect(res.success).toBe(false);
      expect(res.error).toBe('NOT_YOUR_ASSIGNMENT');
      expect(res.assignment).toBeFalsy();
      expect(findOne).not.toHaveBeenCalled();
    });

    it('answers a stranger nothing about a cancelled or completed assignment', async () => {
      for (const status of ['CANCELLED', 'COMPLETED']) {
        const { service, findOne } = makeService({ ...checkedOutRow, status });
        const res: any = await service.recordCheckOut('asg-1', 1, 1, undefined, STRANGER, 5);
        expect(res.error).toBe('NOT_YOUR_ASSIGNMENT');
        expect(findOne).not.toHaveBeenCalled();
      }
    });

    it('does not tell a stranger whether the assignee ever checked in', async () => {
      const { service } = makeService({ ...checkedInRow, checked_in_at: null, checked_out_at: null });
      const res: any = await service.recordCheckOut('asg-1', 1, 1, undefined, STRANGER, 5);

      expect(res.error).toBe('NOT_YOUR_ASSIGNMENT');
      expect(res.error).not.toBe('NOT_CHECKED_IN');
    });

    it('still gives the assignee the idempotent answer on a retry', async () => {
      const { service } = makeService(checkedOutRow);
      const res: any = await service.recordCheckOut('asg-1', 1, 1, undefined, OWNER, 5);

      expect(res.success).toBe(true);
      expect(res.message).toMatch(/^Already checked out at /);
    });
  });
});
