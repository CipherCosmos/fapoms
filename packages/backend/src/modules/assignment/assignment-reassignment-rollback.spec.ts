import { ConflictException } from '@nestjs/common';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentReassignmentEntity } from './assignment-reassignment.entity';
import { AssignmentStatus, AssayerStatus } from '@fapoms/shared';

/**
 * When a later step fails, nothing from the earlier ones may survive.
 *
 * Reassignment does five things that must happen together: it closes the outgoing ownership
 * interval, moves the assignment row, verifies the move, opens the new interval, and records the
 * event. If any one of them fails, all of them must be undone — a committed row move with no
 * lineage, or lineage with no audit, is a history nobody can reconstruct from.
 *
 * These tests inject a failure at each step in turn and assert the unit of work was aborted
 * rather than partly applied. They deliberately do NOT relax any constraint to make failure
 * easier to produce: the failures are injected into the collaborators, and the transaction
 * boundary is the thing under test.
 */
describe('AssignmentService.reassignAssignment — transactional integrity', () => {
  const ASSIGNMENT = 'a1000000-0000-4000-a000-000000000001';
  const OLD_ASSAYER = 'aa000000-0000-4000-a000-00000000000a';
  const NEW_ASSAYER = 'bb000000-0000-4000-b000-00000000000b';
  const ACTOR = 'u0000000-0000-4000-u000-000000000001';

  const makeService = (fail: {
    onCloseInterval?: boolean;
    onAssignmentSave?: boolean;
    onLineageSave?: boolean;
    onAudit?: boolean;
  } = {}) => {
    const committed = { assignmentSaves: 0, lineageSaves: 0, auditWrites: 0, emits: 0 };
    /** Set when the unit of work propagated the failure — i.e. the transaction aborted. */
    let unitOfWorkAborted = false;

    const openInterval = {
      id: 'lineage-0', assignmentId: ASSIGNMENT, previousAssayerId: null,
      newAssayerId: OLD_ASSAYER, ownershipEndedAt: null, isActive: true,
    };

    const assignmentRow = {
      id: ASSIGNMENT,
      assayerId: OLD_ASSAYER,
      assayer: { id: OLD_ASSAYER, displayName: 'Outgoing', assayerCode: 'AS-OLD' },
      status: AssignmentStatus.PENDING,
      projectBranchId: 'pb-1',
      projectBranch: { id: 'pb-1', project: { clientId: null }, branch: { name: 'Branch' } },
      scheduledDate: null,
      currentOwnershipStartedAt: null,
      entityVersion: 1,
    };

    const manager: any = {
      query: jest.fn(async (sql: string) => {
        if (/FOR UPDATE/.test(sql) && /assignments/.test(sql)) {
          return [{ status: AssignmentStatus.PENDING, assayer_id: OLD_ASSAYER, entity_version: 1 }];
        }
        if (/SELECT assayer_id, entity_version, status FROM assignments/.test(sql)) {
          return [{ assayer_id: NEW_ASSAYER, entity_version: 2, status: AssignmentStatus.PENDING }];
        }
        return [];
      }),
      findOne: jest.fn(async (target: any) => {
        if (target === AssignmentEntity) return assignmentRow;
        if (target === AssignmentReassignmentEntity) return openInterval;
        return null;
      }),
      create: jest.fn((_cls: any, dto: any) => ({ id: 'lineage-1', ...dto })),
      save: jest.fn(async (e: any) => {
        // Closing the outgoing interval: the existing lineage row, given an end timestamp.
        if (e?.id === 'lineage-0') {
          if (fail.onCloseInterval) throw new Error('INJECTED: closing the ownership interval failed');
          committed.lineageSaves++;
          return e;
        }
        if (e?.previousAssayerId !== undefined) {
          if (fail.onLineageSave) throw new Error('INJECTED: writing the new ownership interval failed');
          committed.lineageSaves++;
          return e;
        }
        if (fail.onAssignmentSave) throw new Error('INJECTED: the assignment row write failed');
        committed.assignmentSaves++;
        return e;
      }),
    };

    const emit = jest.fn(() => { committed.emits++; });
    const auditService = {
      recordEventSafe: jest.fn(async () => {
        if (fail.onAudit) throw new Error('INJECTED: the audit write failed');
        committed.auditWrites++;
      }),
    };

    const service = Object.create(AssignmentService.prototype) as AssignmentService;
    (service as any).uow = {
      run: jest.fn(async (work: any) => {
        try {
          return await work(manager, emit);
        } catch (err) {
          // A real unit of work rolls the transaction back here. Nothing the work did survives,
          // which is what the counters below stand in for.
          unitOfWorkAborted = true;
          committed.assignmentSaves = 0;
          committed.lineageSaves = 0;
          committed.auditWrites = 0;
          throw err;
        }
      }),
    };
    (service as any).assignmentRepository = { manager: { query: jest.fn(async () => []) } };
    (service as any).auditService = auditService;
    (service as any).assayerService = {
      findOne: jest.fn(async () => ({
        id: NEW_ASSAYER, status: AssayerStatus.ACTIVE, isActive: true,
        displayName: 'Incoming', assayerCode: 'AS-NEW',
      })),
    };
    (service as any).targetEligibility = {
      evaluate: jest.fn().mockResolvedValue({
        outcome: 'ALLOWED', standing: 'ACTIVE', empanelmentId: null, empanelmentEffectiveAt: null,
      }),
      resolveBlock: jest.fn(),
    };
    (service as any).ruleBypass = { isBypassedSync: () => false, noteBypass: jest.fn() };

    return { service, committed, aborted: () => unitOfWorkAborted };
  };

  const reassign = (service: AssignmentService) =>
    service.reassignAssignment(ASSIGNMENT, NEW_ASSAYER, ACTOR, 'desk moved the audit to a nearer assayer');

  it('commits all five steps together when nothing fails', async () => {
    const { service, committed, aborted } = makeService();
    await reassign(service);
    expect(aborted()).toBe(false);
    expect(committed.assignmentSaves).toBe(1);
    expect(committed.lineageSaves).toBe(2); // interval closed, new interval opened
    expect(committed.auditWrites).toBe(1);
  });

  it('aborts everything when closing the outgoing ownership interval fails', async () => {
    const { service, committed, aborted } = makeService({ onCloseInterval: true });
    await expect(reassign(service)).rejects.toThrow(/INJECTED/);
    expect(aborted()).toBe(true);
    expect(committed).toMatchObject({ assignmentSaves: 0, lineageSaves: 0, auditWrites: 0 });
  });

  it('aborts everything when the assignment row write fails', async () => {
    const { service, committed, aborted } = makeService({ onAssignmentSave: true });
    await expect(reassign(service)).rejects.toThrow(/INJECTED/);
    expect(aborted()).toBe(true);
    expect(committed).toMatchObject({ assignmentSaves: 0, lineageSaves: 0, auditWrites: 0 });
  });

  it('aborts the committed row move when the lineage write fails afterwards', async () => {
    const { service, committed, aborted } = makeService({ onLineageSave: true });
    await expect(reassign(service)).rejects.toThrow(/INJECTED/);
    expect(aborted()).toBe(true);
    // The move itself must not survive its own history failing to record.
    expect(committed.assignmentSaves).toBe(0);
    expect(committed.auditWrites).toBe(0);
  });

  it('aborts the row move and the lineage when the audit write fails', async () => {
    const { service, committed, aborted } = makeService({ onAudit: true });
    await expect(reassign(service)).rejects.toThrow(/INJECTED/);
    expect(aborted()).toBe(true);
    expect(committed).toMatchObject({ assignmentSaves: 0, lineageSaves: 0, auditWrites: 0 });
  });

  /**
   * The verification failure is the one the fix introduced, and it must roll back like any other.
   * A row that did not move must leave no lineage and no audit behind it.
   */
  it('aborts everything when the post-write verification finds the row did not move', async () => {
    const { service, committed, aborted } = makeService();
    // Re-point the read-back at the old assayer: the write silently did not take.
    const svc = service as any;
    const originalRun = svc.uow.run;
    svc.uow.run = jest.fn(async (work: any) => originalRun(async (manager: any, emit: any) => {
      const realQuery = manager.query;
      manager.query = jest.fn(async (sql: string, params?: any[]) => {
        if (/SELECT assayer_id, entity_version, status FROM assignments/.test(sql)) {
          return [{ assayer_id: OLD_ASSAYER, entity_version: 2, status: AssignmentStatus.PENDING }];
        }
        return realQuery(sql, params);
      });
      return work(manager, emit);
    }));

    await expect(reassign(service)).rejects.toThrow(ConflictException);
    expect(aborted()).toBe(true);
    expect(committed).toMatchObject({ lineageSaves: 0, auditWrites: 0 });
  });
});
