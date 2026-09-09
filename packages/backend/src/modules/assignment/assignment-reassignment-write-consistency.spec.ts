import { ConflictException } from '@nestjs/common';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentReassignmentEntity } from './assignment-reassignment.entity';
import { AssignmentStatus, AssayerStatus } from '@fapoms/shared';

/**
 * A reassignment must record what happened, never what was asked for.
 *
 * `reassignAssignment()` returned 201, answered with the new assayer, wrote a lineage row and
 * wrote an `ASSIGNMENT_REASSIGNED` audit event — and left the assignment row pointing at the OLD
 * assayer. Reproduced deterministically on a live single call: the API said `a953bf04`, the
 * database said `e40947e8`, and `entity_version` went 1 → 2, so the UPDATE unquestionably ran.
 *
 * The mechanism was `AssignmentEntity` mapping two properties onto `assayer_id` — the scalar
 * `assayerId` and the `@ManyToOne` relation `assayer`. The entity was loaded WITH that relation
 * hydrated to the outgoing assayer, and TypeORM builds the column from the relation when both are
 * present. Setting only the scalar wrote every other column faithfully and put the old id back.
 *
 * Two things are pinned here, and the second matters more than the first. Setting the relation
 * fixes this instance. Reading the row back inside the transaction and refusing to record
 * anything that did not happen fixes the *class* — whatever future mapping change, trigger or
 * rule silently rewrites the column, the operation now fails loudly instead of producing a
 * confident, wrong history. An audit trail that is wrong is worse than one that is missing,
 * because it is trusted.
 */
describe('AssignmentService.reassignAssignment — write consistency', () => {
  const ASSIGNMENT = '466c56d9-13c5-4197-895a-545bdf9729b1';
  const OLD_ASSAYER = 'e40947e8-4bd7-416c-8f62-8ee018bc9d84';
  const NEW_ASSAYER = 'a953bf04-ecc5-42cf-9f83-2a21796699a0';
  const ACTOR = 'u0000000-0000-4000-u000-000000000001';

  /**
   * @param persistedAssayerId what the row holds when read back after the save. Defaults to a
   *   correct write; set it to OLD_ASSAYER to simulate exactly the silent revert that happened.
   */
  const makeService = (opts: {
    lockedStatus?: AssignmentStatus;
    persistedAssayerId?: string;
    persistedVersion?: number;
  } = {}) => {
    const lockedVersion = 1;
    const lineageSaved: any[] = [];
    const assignmentsSaved: any[] = [];

    const assignmentRow = {
      id: ASSIGNMENT,
      assayerId: OLD_ASSAYER,
      // Hydrated to the OUTGOING assayer, which is the whole trap.
      assayer: { id: OLD_ASSAYER, displayName: 'Outgoing', assayerCode: 'AS-OLD' },
      status: opts.lockedStatus ?? AssignmentStatus.PENDING,
      projectBranchId: 'pb-1',
      projectBranch: { id: 'pb-1', project: { clientId: null }, branch: { name: 'Branch' } },
      scheduledDate: null,
      currentOwnershipStartedAt: null,
      entityVersion: lockedVersion,
    };

    const manager: any = {
      query: jest.fn(async (sql: string) => {
        if (/FROM assignments WHERE id = \$1 FOR UPDATE/.test(sql) || /FOR UPDATE/.test(sql) && /assignments/.test(sql)) {
          return [{
            status: opts.lockedStatus ?? AssignmentStatus.PENDING,
            assayer_id: OLD_ASSAYER,
            entity_version: lockedVersion,
          }];
        }
        // The read-back after the save.
        if (/SELECT assayer_id, entity_version, status FROM assignments/.test(sql)) {
          return [{
            assayer_id: opts.persistedAssayerId ?? NEW_ASSAYER,
            entity_version: opts.persistedVersion ?? lockedVersion + 1,
            status: AssignmentStatus.PENDING,
          }];
        }
        return [];
      }),
      findOne: jest.fn(async (target: any) => {
        if (target === AssignmentEntity) return assignmentRow;
        if (target === AssignmentReassignmentEntity) return null;
        return null;
      }),
      create: jest.fn((_cls: any, dto: any) => ({ id: 'lineage-1', ...dto })),
      save: jest.fn(async (e: any) => {
        if (e?.previousAssayerId !== undefined) { lineageSaved.push(e); return e; }
        assignmentsSaved.push(e);
        return e;
      }),
    };

    const emit = jest.fn();
    const auditService = { recordEventSafe: jest.fn() };
    const service = Object.create(AssignmentService.prototype) as AssignmentService;
    (service as any).uow = { run: jest.fn(async (work: any) => work(manager, emit)) };
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
    // Reassignment now tells the losing assayer, the gaining assayer and the desk. `emitSafe`
    // never throws in production; the stub records so the tests can assert who was told.
    (service as any).notificationDispatch = { emitSafe: jest.fn() };

    return {
      service, manager, auditService, lineageSaved, assignmentsSaved, emit,
      notified: (service as any).notificationDispatch.emitSafe as jest.Mock,
    };
  };

  const reassign = (service: AssignmentService) =>
    service.reassignAssignment(ASSIGNMENT, NEW_ASSAYER, ACTOR, 'desk moved the audit to a nearer assayer');

  it('sets the relation as well as the scalar, so TypeORM cannot build the column from a stale relation', async () => {
    const { service, assignmentsSaved } = makeService();

    await reassign(service);

    const saved = assignmentsSaved[0];
    expect(saved.assayerId).toBe(NEW_ASSAYER);
    // The assertion that fails if the second line of the fix is removed. Both properties map to
    // `assayer_id`, and the relation is the one TypeORM reads.
    expect(saved.assayer?.id).toBe(NEW_ASSAYER);
  });

  it('records lineage and audit from the row as persisted, not from the request', async () => {
    const { service, lineageSaved, auditService } = makeService();

    await reassign(service);

    expect(lineageSaved).toHaveLength(1);
    expect(lineageSaved[0]).toMatchObject({
      previousAssayerId: OLD_ASSAYER,
      newAssayerId: NEW_ASSAYER,
      ownershipEndedAt: null,
    });
    expect(auditService.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ASSIGNMENT_REASSIGNED',
        metadata: expect.objectContaining({ newAssayerId: NEW_ASSAYER, entityVersion: 2 }),
      }),
      expect.anything(),
    );
  });

  /**
   * Reassignment takes work from one person and gives it to another, and told nobody. Every other
   * transition — offered, accepted, rejected, cancelled, escalated — emits. Verified live on an
   * ACCEPTED assignment: the move succeeded and zero notification rows were written, so the
   * assayer who had committed to the audit kept it on their schedule.
   */
  describe('tells the three parties who need to know', () => {
    it('notifies the assayer who lost the work, the one who gained it, and the desk', async () => {
      const { service, notified } = makeService();

      await reassign(service);

      const types = notified.mock.calls.map((c: any[]) => c[0].type);
      expect(types).toEqual(expect.arrayContaining([
        'ASSIGNMENT_REASSIGNED_AWAY',
        'ASSIGNMENT_OFFERED',
        'ASSIGNMENT_REASSIGNED',
      ]));
    });

    it('addresses the losing notice to the outgoing assayer and the offer to the incoming one', async () => {
      const { service, notified } = makeService();

      await reassign(service);

      const away = notified.mock.calls.find((c: any[]) => c[0].type === 'ASSIGNMENT_REASSIGNED_AWAY')![0];
      const offer = notified.mock.calls.find((c: any[]) => c[0].type === 'ASSIGNMENT_OFFERED')![0];
      expect(away.assayerId).toBe(OLD_ASSAYER);
      expect(offer.assayerId).toBe(NEW_ASSAYER);
    });

    it('tells nobody when the write did not take', async () => {
      const { service, notified } = makeService({ persistedAssayerId: OLD_ASSAYER });
      await expect(reassign(service)).rejects.toThrow(ConflictException);
      expect(notified).not.toHaveBeenCalled();
    });

    it('tells nobody when a terminal assignment is refused', async () => {
      const { service, notified } = makeService({ lockedStatus: AssignmentStatus.CANCELLED });
      await expect(reassign(service)).rejects.toThrow(/ASSIGNMENT_CANCELLED/);
      expect(notified).not.toHaveBeenCalled();
    });
  });

  describe('when the write did not actually move the row', () => {
    /** Exactly the observed defect: the save resolves, the column still holds the old assayer. */
    const silentRevert = () => makeService({ persistedAssayerId: OLD_ASSAYER });

    it('raises a conflict instead of answering success', async () => {
      const { service } = silentRevert();
      await expect(reassign(service)).rejects.toThrow(ConflictException);
      await expect(reassign(service)).rejects.toThrow(/REASSIGNMENT_NOT_PERSISTED/);
    });

    it('writes no lineage row', async () => {
      const { service, lineageSaved } = silentRevert();
      await expect(reassign(service)).rejects.toThrow(ConflictException);
      expect(lineageSaved).toHaveLength(0);
    });

    it('writes no audit event', async () => {
      const { service, auditService } = silentRevert();
      await expect(reassign(service)).rejects.toThrow(ConflictException);
      expect(auditService.recordEventSafe).not.toHaveBeenCalled();
    });

    it('emits no reassignment event to downstream consumers', async () => {
      const { service, emit } = silentRevert();
      await expect(reassign(service)).rejects.toThrow(ConflictException);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('when the row moved but the version did not advance as expected', () => {
    it('raises a conflict and records nothing', async () => {
      const { service, lineageSaved, auditService } = makeService({ persistedVersion: 7 });
      await expect(reassign(service)).rejects.toThrow(/REASSIGNMENT_VERSION_MISMATCH/);
      expect(lineageSaved).toHaveLength(0);
      expect(auditService.recordEventSafe).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle guards', () => {
    it('refuses to reassign a COMPLETED assignment', async () => {
      const { service } = makeService({ lockedStatus: AssignmentStatus.COMPLETED });
      await expect(reassign(service)).rejects.toThrow(/already been completed/);
    });

    /**
     * The revival defect: reassignment set status unconditionally back to PENDING and cleared
     * `cancelReason`, so a cancelled assignment came back to life under an audit event that said
     * only "reassigned". Nobody approved a reopening, because nothing ever asked.
     */
    it('refuses to reassign a CANCELLED assignment rather than silently reviving it', async () => {
      const { service, lineageSaved, auditService, assignmentsSaved } =
        makeService({ lockedStatus: AssignmentStatus.CANCELLED });
      await expect(reassign(service)).rejects.toThrow(/ASSIGNMENT_CANCELLED/);
      expect(assignmentsSaved).toHaveLength(0);
      expect(lineageSaved).toHaveLength(0);
      expect(auditService.recordEventSafe).not.toHaveBeenCalled();
    });

    it('still allows reassigning a REJECTED assignment — a declined offer is the reason the desk reassigns', async () => {
      const { service, assignmentsSaved } = makeService({ lockedStatus: AssignmentStatus.REJECTED });
      await reassign(service);
      expect(assignmentsSaved[0].assayerId).toBe(NEW_ASSAYER);
    });
  });
});
