import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, Region } from '@fapoms/shared';

import { ExpenseService } from './expense.service';
import { ExpenseEntity, ExpenseCategory, ExpenseStatus } from './expense.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

const OWNER = 'assayer-owner';
const INTRUDER = 'assayer-intruder';

/**
 * A fake query builder good enough for the `getRawAndEntities()` / `getRawOne()` shapes the
 * staged region checks use. Every chain method returns `this`, mirroring TypeORM's
 * `SelectQueryBuilder` fluent API closely enough for these tests without pulling in a real one.
 */
function fakeQueryBuilder(terminal: { rawAndEntities?: { entities: any[]; raw: any[] }; rawOne?: any }) {
  const qb: any = {
    leftJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawAndEntities: jest.fn().mockResolvedValue(terminal.rawAndEntities ?? { entities: [], raw: [] }),
    getRawOne: jest.fn().mockResolvedValue(terminal.rawOne ?? null),
  };
  return qb;
}

/**
 * A `RegionGuardService` double that runs the same predicate the real `assertRegionAllowedStaged`
 * does (see `region-guard.service.ts`), parameterised on rollout mode, so these tests exercise
 * genuine allow/refuse/log behaviour rather than asserting on a bare spy. The real method's own
 * exhaustive mode-transition coverage lives in `region-guard.service.spec.ts`; this file only
 * needs to prove each expense route feeds it the right region and reacts correctly.
 */
function fakeRegionGuard(mode: 'off' | 'log' | 'enforce') {
  const logger = { warn: jest.fn() };
  return {
    mode,
    logger,
    stagedMode: jest.fn(async () => mode),
    assertRegionAllowedStaged: jest.fn(async (region: string | null | undefined, scope: any, context: string) => {
      if (mode === 'off') return;
      const allowed = scope?.regions;
      if (!allowed || allowed.length === 0) return;
      if (!region) return;
      if (!allowed.includes(region)) {
        if (mode === 'enforce') {
          throw new ForbiddenException('That record belongs to a region your account is not assigned to.');
        }
        logger.warn(`[region-scope:${context}] would refuse — record region "${region}" not in [${allowed.join(', ')}]`);
      }
    }),
  };
}

describe('ExpenseService', () => {
  let service: ExpenseService;
  let expenseRepo: any;
  let assignmentRepo: any;
  let dispatch: any;
  let billing: any;
  let regionGuard: ReturnType<typeof fakeRegionGuard>;
  /** The transaction's manager: `save` lands on the expense repo so the tests can see the row. */
  let txManager: any;
  let uow: any;

  const assignment = (status: AssignmentStatus = AssignmentStatus.CHECKED_IN, region: string | null = null) => ({
    id: 'asn-1',
    assayerId: OWNER,
    assignmentNumber: 'ASN-001',
    status,
    projectBranch: { branch: { name: 'Thrissur Main', region } },
  });

  /** Rebuilds the module with a given rollout mode; defaults to 'log', the shipped default. */
  const buildModule = async (mode: 'off' | 'log' | 'enforce' = 'log') => {
    expenseRepo = {
      create: jest.fn((v) => v),
      save: jest.fn((v) => Promise.resolve({ id: 'exp-1', ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(),
    };
    assignmentRepo = {
      findOne: jest.fn().mockResolvedValue(assignment()),
      createQueryBuilder: jest.fn(),
    };
    dispatch = { emitSafe: jest.fn(), emit: jest.fn() };
    billing = { createReimbursementPayable: jest.fn().mockResolvedValue({ id: 'pay-1' }) };
    txManager = { save: jest.fn((v: any) => expenseRepo.save(v)) };
    // A UnitOfWork double that models ROLLBACK: the callback's writes reach the repository only
    // if the callback resolves. A throw propagates and nothing is "committed".
    uow = { run: jest.fn(async (work: any) => work(txManager, jest.fn())) };
    regionGuard = fakeRegionGuard(mode);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: PlatformSettingsService,
          // Nothing configured in tests: every lookup falls through to the caller's fallback,
          // which is the shipped constant.
          useValue: {
            get: jest.fn(async () => null),
            getMany: jest.fn(async () => ({})),
            getNumber: jest.fn(async (_k: string, fb?: number) => fb as number),
            describeAll: jest.fn(async () => []),
            onChange: jest.fn(),
          },
        },
        ExpenseService,
        { provide: getRepositoryToken(ExpenseEntity), useValue: expenseRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: AuditService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined) , recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); })} },
        { provide: NotificationDispatchService, useValue: dispatch },
        { provide: BillingEngineService, useValue: billing },
        { provide: UnitOfWork, useValue: uow },
        { provide: RegionGuardService, useValue: regionGuard },
      ],
    }).compile();

    service = module.get<ExpenseService>(ExpenseService);
  };

  beforeEach(async () => {
    await buildModule('log');
  });

  const valid = { category: ExpenseCategory.TOLL, amount: 240, description: 'NH-48 toll' };

  describe('create', () => {
    it('records a claim for the assayer the assignment belongs to', async () => {
      const result = await service.create('asn-1', valid, 'user-1', OWNER);
      expect(result).toMatchObject({ assayerId: OWNER, amount: 240, status: ExpenseStatus.PENDING });
      expect(dispatch.emitSafe).toHaveBeenCalledWith(expect.objectContaining({ type: 'EXPENSE_CLAIMED' }));
    });

    it("refuses a claim against another assayer's assignment", async () => {
      await expect(service.create('asn-1', valid, 'user-1', INTRUDER)).rejects.toThrow(ForbiddenException);
      expect(expenseRepo.save).not.toHaveBeenCalled();
    });

    it('lets internal staff raise a claim on an assayer\'s behalf', async () => {
      // No claimant id => staff path, so the ownership check does not apply.
      await expect(service.create('asn-1', valid, 'ops-1', null)).resolves.toMatchObject({ assayerId: OWNER });
    });

    it('rejects a zero or negative amount', async () => {
      await expect(service.create('asn-1', { ...valid, amount: 0 }, 'u', OWNER)).rejects.toThrow(BadRequestException);
      await expect(service.create('asn-1', { ...valid, amount: -5 }, 'u', OWNER)).rejects.toThrow(BadRequestException);
    });

    it('caps a single claim so one entry cannot commit an unbounded sum', async () => {
      await expect(service.create('asn-1', { ...valid, amount: 99999 }, 'u', OWNER)).rejects.toThrow(BadRequestException);
    });

    it('refuses a claim before the visit has started', async () => {
      // Nothing has been spent on an assignment that is merely offered.
      assignmentRepo.findOne.mockResolvedValue(assignment(AssignmentStatus.PENDING));
      await expect(service.create('asn-1', valid, 'u', OWNER)).rejects.toThrow(BadRequestException);
    });

    it('allows a claim after completion, when receipts are usually entered', async () => {
      assignmentRepo.findOne.mockResolvedValue(assignment(AssignmentStatus.COMPLETED));
      await expect(service.create('asn-1', valid, 'u', OWNER)).resolves.toBeDefined();
    });

    it('throws when the assignment does not exist', async () => {
      assignmentRepo.findOne.mockResolvedValue(null);
      await expect(service.create('nope', valid, 'u', OWNER)).rejects.toThrow(NotFoundException);
    });
  });

  describe('review', () => {
    const pending = { id: 'exp-1', assayerId: OWNER, amount: 240, category: ExpenseCategory.TOLL, status: ExpenseStatus.PENDING };

    it('approves a pending claim and stamps the reviewer', async () => {
      expenseRepo.findOne.mockResolvedValue({ ...pending });
      const result = await service.review('exp-1', true, 'ops-1', 'Receipt verified');
      expect(result.status).toBe(ExpenseStatus.APPROVED);
      expect(result.reviewedBy).toBe('ops-1');
      expect(result.reviewedAt).toBeInstanceOf(Date);
    });

    it('requires a reason to reject — an unexplained refusal cannot be acted on', async () => {
      expenseRepo.findOne.mockResolvedValue({ ...pending });
      await expect(service.review('exp-1', false, 'ops-1')).rejects.toThrow(BadRequestException);
      await expect(service.review('exp-1', false, 'ops-1', '  ')).rejects.toThrow(BadRequestException);
    });

    it('rejects with a reason and notifies the assayer', async () => {
      expenseRepo.findOne.mockResolvedValue({ ...pending });
      const result = await service.review('exp-1', false, 'ops-1', 'No receipt attached');
      expect(result.status).toBe(ExpenseStatus.REJECTED);
      expect(dispatch.emitSafe).toHaveBeenCalledWith(expect.objectContaining({ type: 'EXPENSE_REJECTED' }));
    });

    it('will not review the same claim twice', async () => {
      expenseRepo.findOne.mockResolvedValue({ ...pending, status: ExpenseStatus.APPROVED });
      await expect(service.review('exp-1', false, 'ops-1', 'reversing')).rejects.toThrow(BadRequestException);
    });

    it('refuses to let the claim\'s raiser approve their own claim', async () => {
      // Approving books a payable — money out. The same person entering and approving a claim
      // is exactly the self-dealing separation of duties exists to stop.
      expenseRepo.findOne.mockResolvedValue({ ...pending, createdBy: 'ops-1' });
      await expect(service.review('exp-1', true, 'ops-1', 'Looks fine')).rejects.toThrow(ForbiddenException);
      expect(expenseRepo.save).not.toHaveBeenCalled();
    });

    it('still lets the claim\'s raiser reject their own claim', async () => {
      // Rejecting moves no money, so self-rejection is harmless and stays allowed.
      expenseRepo.findOne.mockResolvedValue({ ...pending, createdBy: 'ops-1' });
      const result = await service.review('exp-1', false, 'ops-1', 'Filed by mistake');
      expect(result.status).toBe(ExpenseStatus.REJECTED);
    });

    it('lets a different reviewer approve a claim they did not raise', async () => {
      expenseRepo.findOne.mockResolvedValue({ ...pending, createdBy: 'ops-1' });
      const result = await service.review('exp-1', true, 'ops-2', 'Verified independently');
      expect(result.status).toBe(ExpenseStatus.APPROVED);
    });
  });

  describe('summaryForAssayer', () => {
    it('totals claims by state, coercing decimal strings from the driver', async () => {
      expenseRepo.find.mockResolvedValue([
        { amount: '240.00', status: ExpenseStatus.PENDING },
        { amount: '100.50', status: ExpenseStatus.APPROVED },
        { amount: '75.00', status: ExpenseStatus.REJECTED },
        { amount: '10.00', status: ExpenseStatus.PENDING },
      ]);
      await expect(service.summaryForAssayer(OWNER)).resolves.toEqual({
        pending: 250, approved: 100.5, rejected: 75, totalClaimed: 425.5,
      });
    });
  });

  describe('reimbursement — approval has to end in money', () => {
    const approved = (over: any = {}) => ({
      id: 'exp-1', assignmentId: 'asn-1', assayerId: OWNER, amount: 240,
      category: ExpenseCategory.TOLL, description: 'NH-48 toll',
      status: ExpenseStatus.PENDING, reimbursementPayableId: null, ...over,
    });

    beforeEach(() => {
      expenseRepo.findOne.mockResolvedValue(approved());
      expenseRepo.save.mockImplementation((v: any) => Promise.resolve(v));
    });

    it('raises a payable when a claim is approved, on the same transaction as the approval', async () => {
      // Before this, APPROVED was the end of the road: nothing owed the assayer the money and
      // there was no state that said it was still coming.
      await service.review('exp-1', true, 'reviewer-1');
      expect(uow.run).toHaveBeenCalledTimes(1);
      expect(billing.createReimbursementPayable).toHaveBeenCalledWith(
        expect.objectContaining({ assayerId: OWNER, amount: 240, assignmentId: 'asn-1' }),
        txManager,
        'reviewer-1',
      );
      // The approval itself is saved through the transaction's manager, not the repository.
      expect(txManager.save).toHaveBeenCalledWith(expect.objectContaining({ status: ExpenseStatus.APPROVED }));
    });

    it('links the claim to the payable that will pay it', async () => {
      await service.review('exp-1', true, 'reviewer-1');
      expect(txManager.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ reimbursementPayableId: 'pay-1' }),
      );
    });

    it('raises nothing when a claim is rejected, and opens no transaction', async () => {
      await service.review('exp-1', false, 'reviewer-1', 'Duplicate of ASN-001');
      expect(billing.createReimbursementPayable).not.toHaveBeenCalled();
      expect(uow.run).not.toHaveBeenCalled();
    });

    it('rolls the approval back when the payable cannot be raised', async () => {
      // The approval and the money are one act. An approved claim with no payable behind it is
      // the state that used to need an "unpaid approvals" queue, a retry button, and opened a
      // double-payment window on the retry. Now the reviewer sees the failure and the claim
      // stays PENDING.
      billing.createReimbursementPayable.mockRejectedValueOnce(new Error('db down'));
      await expect(service.review('exp-1', true, 'reviewer-1')).rejects.toThrow('db down');
      expect(expenseRepo.save).not.toHaveBeenCalled();
      expect(dispatch.emitSafe).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'EXPENSE_APPROVED' }));
    });
  });

  describe('region scoping (staged rollout) — create', () => {
    const NORTH_SCOPE = { regions: [Region.NORTH] };

    it('never checks an unrestricted account, in any mode', async () => {
      await buildModule('enforce');
      assignmentRepo.findOne.mockResolvedValue(assignment(AssignmentStatus.CHECKED_IN, 'SOUTH'));
      await expect(service.create('asn-1', valid, 'u', OWNER, { regions: null })).resolves.toBeDefined();
    });

    it('enforce mode refuses a claim against an out-of-region assignment, before it is written', async () => {
      await buildModule('enforce');
      assignmentRepo.findOne.mockResolvedValue(assignment(AssignmentStatus.CHECKED_IN, 'SOUTH'));
      await expect(service.create('asn-1', valid, 'u', OWNER, NORTH_SCOPE)).rejects.toThrow(ForbiddenException);
      expect(expenseRepo.save).not.toHaveBeenCalled();
    });

    it('log mode never refuses and the response is unchanged, but records what would happen', async () => {
      await buildModule('log');
      assignmentRepo.findOne.mockResolvedValue(assignment(AssignmentStatus.CHECKED_IN, 'SOUTH'));
      const unscoped = await service.create('asn-1', valid, 'u', OWNER);
      assignmentRepo.findOne.mockResolvedValue(assignment(AssignmentStatus.CHECKED_IN, 'SOUTH'));
      const scoped = await service.create('asn-1', valid, 'u', OWNER, NORTH_SCOPE);
      expect(scoped).toMatchObject({ assayerId: OWNER, amount: 240, status: ExpenseStatus.PENDING });
      expect(Object.keys(scoped).sort()).toEqual(Object.keys(unscoped).sort());
      expect(regionGuard.logger.warn).toHaveBeenCalled();
    });

    it('off mode skips the check and behaves exactly as before region scoping existed', async () => {
      await buildModule('off');
      assignmentRepo.findOne.mockResolvedValue(assignment(AssignmentStatus.CHECKED_IN, 'SOUTH'));
      await expect(service.create('asn-1', valid, 'u', OWNER, NORTH_SCOPE)).resolves.toBeDefined();
      expect(expenseRepo.save).toHaveBeenCalled();
    });
  });

  describe('region scoping (staged rollout) — findForAssignment', () => {
    const rows = (region: string | null) => ({
      entities: [{ id: 'e1', assignmentId: 'asn-1' }],
      raw: [{ region }],
    });

    it('one lookup covers the whole list — enforce mode refuses an out-of-region assignment', async () => {
      await buildModule('enforce');
      expenseRepo.createQueryBuilder.mockReturnValue(fakeQueryBuilder({ rawAndEntities: rows('SOUTH') }));
      await expect(
        service.findForAssignment('asn-1', { regions: [Region.NORTH] }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('log mode returns the identical rows and only logs', async () => {
      await buildModule('log');
      expenseRepo.createQueryBuilder.mockReturnValue(fakeQueryBuilder({ rawAndEntities: rows('SOUTH') }));
      await expect(
        service.findForAssignment('asn-1', { regions: [Region.NORTH] }),
      ).resolves.toEqual([{ id: 'e1', assignmentId: 'asn-1' }]);
      expect(regionGuard.logger.warn).toHaveBeenCalled();
    });

    it('an empty result has nothing to check and resolves cleanly', async () => {
      await buildModule('enforce');
      expenseRepo.createQueryBuilder.mockReturnValue(fakeQueryBuilder({ rawAndEntities: { entities: [], raw: [] } }));
      await expect(service.findForAssignment('asn-1', { regions: [Region.NORTH] })).resolves.toEqual([]);
    });

    it('an unrestricted account is never refused, regardless of the assignment region', async () => {
      await buildModule('enforce');
      expenseRepo.createQueryBuilder.mockReturnValue(fakeQueryBuilder({ rawAndEntities: rows('SOUTH') }));
      await expect(service.findForAssignment('asn-1', { regions: null })).resolves.toEqual([
        { id: 'e1', assignmentId: 'asn-1' },
      ]);
    });
  });

  describe('region scoping (staged rollout) — findForAssayer', () => {
    it("findMine's call (no scope argument) never touches the region-aware query, in any mode", async () => {
      await buildModule('enforce');
      expenseRepo.find.mockResolvedValue([{ id: 'e1' }]);
      const result = await service.findForAssayer(OWNER, undefined);
      expect(result).toEqual([{ id: 'e1' }]);
      expect(expenseRepo.find).toHaveBeenCalled();
      expect(expenseRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('enforce mode filters out an assayer claim tied to an assignment outside the scope', async () => {
      await buildModule('enforce');
      expenseRepo.createQueryBuilder.mockReturnValue(
        fakeQueryBuilder({
          rawAndEntities: {
            entities: [{ id: 'e1' }, { id: 'e2' }],
            raw: [{ region: 'NORTH' }, { region: 'SOUTH' }],
          },
        }),
      );
      const result = await service.findForAssayer(OWNER, undefined, { regions: [Region.NORTH] });
      expect(result).toEqual([{ id: 'e1' }]);
    });

    it('log mode returns every row and logs how many would have been filtered', async () => {
      await buildModule('log');
      expenseRepo.createQueryBuilder.mockReturnValue(
        fakeQueryBuilder({
          rawAndEntities: {
            entities: [{ id: 'e1' }, { id: 'e2' }],
            raw: [{ region: 'NORTH' }, { region: 'SOUTH' }],
          },
        }),
      );
      // The per-row filter's log line comes from ExpenseService's own logger (it is computed
      // from the already-fetched rows, not from RegionGuardService), so it's spied here rather
      // than on the region-guard double.
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const result = await service.findForAssayer(OWNER, undefined, { regions: [Region.NORTH] });
      expect(result).toEqual([{ id: 'e1' }, { id: 'e2' }]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('would filter'));
      warnSpy.mockRestore();
    });

    it('off mode falls back to the original query untouched, even for a scoped caller', async () => {
      await buildModule('off');
      expenseRepo.find.mockResolvedValue([{ id: 'e1' }]);
      const result = await service.findForAssayer(OWNER, undefined, { regions: [Region.NORTH] });
      expect(result).toEqual([{ id: 'e1' }]);
      expect(expenseRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('an unrestricted caller never triggers the region-aware query', async () => {
      await buildModule('enforce');
      expenseRepo.find.mockResolvedValue([{ id: 'e1' }]);
      const result = await service.findForAssayer(OWNER, undefined, { regions: null });
      expect(result).toEqual([{ id: 'e1' }]);
      expect(expenseRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('region scoping (staged rollout) — findPending', () => {
    it('this is the bulk cross-region view: enforce mode drops rows outside scope', async () => {
      await buildModule('enforce');
      expenseRepo.createQueryBuilder.mockReturnValue(
        fakeQueryBuilder({
          rawAndEntities: {
            entities: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
            raw: [{ region: 'NORTH' }, { region: 'SOUTH' }, { region: null }],
          },
        }),
      );
      const result = await service.findPending({ regions: [Region.NORTH] });
      // p1 is in-scope; p3 has no resolvable region and stays visible (a data gap, not a
      // boundary — see RegionGuardService.assertRegionAllowed's doc comment).
      expect(result).toEqual([{ id: 'p1' }, { id: 'p3' }]);
    });

    it('log mode returns the unfiltered list and records the would-be count from rows already in memory', async () => {
      await buildModule('log');
      const qb = fakeQueryBuilder({
        rawAndEntities: {
          entities: [{ id: 'p1' }, { id: 'p2' }],
          raw: [{ region: 'NORTH' }, { region: 'SOUTH' }],
        },
      });
      expenseRepo.createQueryBuilder.mockReturnValue(qb);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const result = await service.findPending({ regions: [Region.NORTH] });
      expect(result).toEqual([{ id: 'p1' }, { id: 'p2' }]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('would filter'));
      // No second query: everything came from the one call to getRawAndEntities.
      expect(qb.getRawAndEntities).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('an unrestricted account gets the plain query untouched', async () => {
      await buildModule('enforce');
      expenseRepo.find.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
      const result = await service.findPending({ regions: null });
      expect(result).toEqual([{ id: 'p1' }, { id: 'p2' }]);
      expect(expenseRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('off mode falls back to the plain query even for a scoped caller', async () => {
      await buildModule('off');
      expenseRepo.find.mockResolvedValue([{ id: 'p1' }]);
      const result = await service.findPending({ regions: [Region.NORTH] });
      expect(result).toEqual([{ id: 'p1' }]);
      expect(expenseRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('no scope argument at all (route never wired) behaves like an unrestricted account', async () => {
      await buildModule('enforce');
      expenseRepo.find.mockResolvedValue([{ id: 'p1' }]);
      await expect(service.findPending()).resolves.toEqual([{ id: 'p1' }]);
    });
  });

  describe('region scoping (staged rollout) — review', () => {
    const pendingWithAssignment = {
      id: 'exp-1',
      assignmentId: 'asn-1',
      assayerId: OWNER,
      amount: 240,
      category: ExpenseCategory.TOLL,
      status: ExpenseStatus.PENDING,
    };

    it('enforce mode refuses reviewing an out-of-region claim before any mutation happens', async () => {
      await buildModule('enforce');
      expenseRepo.findOne.mockResolvedValue({ ...pendingWithAssignment });
      assignmentRepo.createQueryBuilder.mockReturnValue(fakeQueryBuilder({ rawOne: { region: 'SOUTH' } }));
      await expect(
        service.review('exp-1', true, 'reviewer-1', 'Looks fine', { regions: [Region.NORTH] }),
      ).rejects.toThrow(ForbiddenException);
      expect(expenseRepo.save).not.toHaveBeenCalled();
      expect(txManager.save).not.toHaveBeenCalled();
      expect(billing.createReimbursementPayable).not.toHaveBeenCalled();
    });

    it('log mode lets the review proceed and only logs', async () => {
      await buildModule('log');
      expenseRepo.findOne.mockResolvedValue({ ...pendingWithAssignment });
      assignmentRepo.createQueryBuilder.mockReturnValue(fakeQueryBuilder({ rawOne: { region: 'SOUTH' } }));
      const result = await service.review('exp-1', true, 'reviewer-1', 'Looks fine', { regions: [Region.NORTH] });
      expect(result.status).toBe(ExpenseStatus.APPROVED);
      expect(regionGuard.logger.warn).toHaveBeenCalled();
    });

    it('an unrestricted reviewer never triggers the assignment-region lookup', async () => {
      await buildModule('enforce');
      expenseRepo.findOne.mockResolvedValue({ ...pendingWithAssignment });
      await service.review('exp-1', false, 'reviewer-1', 'Duplicate', { regions: null });
      expect(assignmentRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('no scope argument at all (route never wired) behaves exactly as before', async () => {
      await buildModule('enforce');
      expenseRepo.findOne.mockResolvedValue({ ...pendingWithAssignment });
      const result = await service.review('exp-1', true, 'reviewer-1', 'Looks fine');
      expect(result.status).toBe(ExpenseStatus.APPROVED);
      expect(assignmentRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
