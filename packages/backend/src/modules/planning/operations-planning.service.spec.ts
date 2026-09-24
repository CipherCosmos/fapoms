import { Test, TestingModule } from '@nestjs/testing';
import { OperationsPlanningService, deploymentRequestId, deployFeeFor, COVERAGE_PLAN_TRANSITIONS, canTransitionCoveragePlan, isDateRefusal } from './operations-planning.service';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { AssignmentService } from '../assignment/assignment.service';
import { ProjectQueryService } from '../project/project-query.service';
import { CoveragePlanEntity, CoveragePlanStatus } from './coverage-plan.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { PlanningService } from './planning.service';

describe('OperationsPlanningService', () => {
  let service: OperationsPlanningService;

  const mockPlanRepository = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn((arg) => Promise.resolve({ id: 'cp-1', ...arg })),
    // The earlier-deployment lookup (`assignment_idempotency_records`). Empty by default: a first
    // deploy, which is what every test above this file's idempotency block is about.
    manager: { query: jest.fn().mockResolvedValue([]) },
  };

  const mockVersionRepository = {
    create: jest.fn(),
    save: jest.fn((arg) => Promise.resolve({ id: 'v-1', ...arg })),
  };

  const mockPlanningEngine = {
    generateCoveragePlan: jest.fn().mockResolvedValue({
      clusters: [{ id: 'b-1', assignedAssayerName: 'Vijay Shankar', branchCount: 1 }],
    }),
  };

  const mockAssignmentService = {
    create: jest.fn(),
  };

  // Deployment reuses the single-branch date suggester; by default every branch's first
  // workable date is the same, so tests exercise the per-branch spacing rather than holidays.
  const mockPlanningService = {
    suggestAuditDate: jest.fn().mockResolvedValue({ date: '2026-01-05', skipped: [] }),
  };

  const mockProjectQueryService = {
    findProjectBranches: jest.fn().mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
    ]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: AuditService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }) } },
        OperationsPlanningService,
        { provide: getRepositoryToken(CoveragePlanEntity), useValue: mockPlanRepository },
        { provide: getRepositoryToken(CoveragePlanVersionEntity), useValue: mockVersionRepository },
        { provide: CoveragePlanningEngine, useValue: mockPlanningEngine },
        { provide: AssignmentService, useValue: mockAssignmentService },
        { provide: ProjectQueryService, useValue: mockProjectQueryService },
        { provide: PlanningService, useValue: mockPlanningService },
      ],
    }).compile();

    service = module.get<OperationsPlanningService>(OperationsPlanningService);
    jest.clearAllMocks();
    mockPlanRepository.manager.query.mockReset().mockResolvedValue([]);
    mockPlanningService.suggestAuditDate.mockResolvedValue({ date: '2026-01-05', skipped: [] });
  });

  it('should create a coverage plan version and allow review status transitions', async () => {
    let callCount = 0;
    mockPlanRepository.findOne.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return null;
      return {
        id: 'cp-1',
        projectId: 'p-1',
        status: CoveragePlanStatus.GENERATED,
        currentVersion: 1,
        versions: [],
      };
    });
    mockPlanRepository.create.mockImplementation((arg) => arg);
    mockVersionRepository.create.mockImplementation((arg) => arg);

    const plan = await service.createOrRegeneratePlan('p-1', [], 'u-1', 'Initial Setup');
    expect(plan.status).toBe(CoveragePlanStatus.GENERATED);
    expect(plan.currentVersion).toBe(1);
  });

  it('should refuse execution of unapproved plans', async () => {
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      status: CoveragePlanStatus.GENERATED,
      currentVersion: 1,
      versions: [],
    });

    await expect(
      service.executeApprovedPlan('cp-1', 'u-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('deploys the assayer and branch that were actually approved, and leaves the price to create()', async () => {
    const activeVersion = {
      versionNumber: 1,
      planData: {
        clusters: [{
          id: 'cluster-b-1',
          assignedAssayerName: 'Vijay Shankar',
          assignedAssayerId: 'as-real-1',
          branchIds: ['b-1'],
          estimatedTotalFee: 1800,
          branchCount: 1,
        }],
      },
    };
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [activeVersion],
    });
    mockAssignmentService.create.mockResolvedValue({ id: 'asg-1' });

    await service.executeApprovedPlan('cp-1', 'u-1');

    // Previously this asserted only that create() was called — which it was, with a hardcoded
    // 'as-1' and a flat 1500 fee against whichever project branch happened to be first.
    expect(mockAssignmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectBranchId: 'pb-1', assayerId: 'as-real-1' }),
      'u-1',
    );
    // The cluster's estimate is not a fee anybody typed: create() prices the job (quote + travel
    // once a day). Sending it made every deployed offer a base-only, desk-typed-looking figure.
    expect(mockAssignmentService.create.mock.calls[0][0]).not.toHaveProperty('proposedFee');
  });

  it('refuses to mark a plan DEPLOYED when it produced no assignments', async () => {
    // The old implementation set DEPLOYED unconditionally, so a plan whose every create()
    // threw was still reported to ops and the client as successfully deployed.
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1'], estimatedTotalFee: 1800, branchCount: 1 }] },
      }],
    });
    mockAssignmentService.create.mockRejectedValue(new Error('Assayer is already booked that day'));

    // No longer a thrown error: a fully-skipped deploy is an explained outcome, so the modal
    // can render grouped reasons instead of a red box with the first five.
    const result = await service.executeApprovedPlan('cp-1', 'u-1');
    expect(result.fullySkipped).toBe(true);
    expect(result.deployed).toHaveLength(0);
    expect(result.skippedReasons).toEqual([{ reason: 'Assayer is already booked that day', count: 1 }]);
    expect(mockPlanRepository.save).not.toHaveBeenCalled();
  });

  it('never sends the cluster estimate (whole or split) as a fee — create() prices each branch', async () => {
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1', 'b-2'], estimatedTotalFee: 1800, branchCount: 2 }] },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
      { id: 'pb-2', branchId: 'b-2' },
    ]);
    mockAssignmentService.create.mockResolvedValue({ id: 'asg-1' });

    await service.executeApprovedPlan('cp-1', 'u-1');

    const fees = mockAssignmentService.create.mock.calls.map((c: any[]) => c[0].proposedFee);
    expect(fees).toEqual([undefined, undefined]);
  });

  describe('item 2 — the engine fee is an estimate; only a desk-typed fee is sent', () => {
    const planWith = (branchAssignments: any[]) => ({
      id: 'cp-1', projectId: 'p-1', status: CoveragePlanStatus.APPROVED, currentVersion: 1,
      versions: [{ versionNumber: 1, planData: { clusters: [{ id: 'c-1', branchIds: branchAssignments.map((b) => b.branchId), branchAssignments }] } }],
    });

    it('omits the engine\'s no-travel quote (fee) so create() quotes the journey and applies travel once', async () => {
      mockPlanRepository.findOne.mockResolvedValue(planWith([{ branchId: 'b-1', assayerId: 'as-1', fee: 1500 }]));
      mockAssignmentService.create.mockResolvedValue({ id: 'asg-1' });
      await service.executeApprovedPlan('cp-1', 'u-1');
      expect(mockAssignmentService.create).toHaveBeenCalledTimes(1);
      expect(mockAssignmentService.create.mock.calls[0][0]).not.toHaveProperty('proposedFee');
    });

    it('sends the fee the desk typed on the plan, and only that', async () => {
      mockPlanRepository.findOne.mockResolvedValue(planWith([{ branchId: 'b-1', assayerId: 'as-1', fee: 1500, deskFee: 2100 }]));
      mockAssignmentService.create.mockResolvedValue({ id: 'asg-1' });
      await service.executeApprovedPlan('cp-1', 'u-1');
      expect(mockAssignmentService.create.mock.calls[0][0].proposedFee).toBe(2100);
    });

    it('still deploys a branch whose plan carries no fee at all (the old "no quoted fee" skip is gone)', async () => {
      mockPlanRepository.findOne.mockResolvedValue(planWith([{ branchId: 'b-1', assayerId: 'as-1', fee: null }]));
      mockAssignmentService.create.mockResolvedValue({ id: 'asg-1' });
      const result = await service.executeApprovedPlan('cp-1', 'u-1');
      expect(result.deployed).toHaveLength(1);
    });

    it('deployFeeFor: a typed number, else nothing', () => {
      expect(deployFeeFor({ deskFee: 0 })).toBe(0);
      expect(deployFeeFor({ deskFee: 1750 })).toBe(1750);
      expect(deployFeeFor({ deskFee: null })).toBeUndefined();
      expect(deployFeeFor({})).toBeUndefined();
    });

    it('a manual override carries its typed fee into the saved plan', async () => {
      mockPlanRepository.findOne.mockResolvedValue(null);
      mockPlanningEngine.generateCoveragePlan.mockResolvedValueOnce({
        clusters: [{ id: 'c-1', branchIds: ['b-1'], branchAssignments: [{ branchId: 'b-1', assayerId: 'as-1', fee: 1500 }] }],
      } as any);
      mockPlanRepository.create.mockImplementationOnce((x: any) => x);
      const created: any[] = [];
      mockVersionRepository.create.mockImplementationOnce((x: any) => { created.push(x); return x; });
      await service.createOrRegeneratePlan('p-1', [{ branchId: 'b-1', assayerId: 'as-2', justification: 'nearer', deskFee: 1999 }], 'u-1');
      expect(created[0].planData.clusters[0].branchAssignments[0]).toMatchObject({ assayerId: 'as-2', deskFee: 1999 });
    });
  });

  it('gives each branch its own workable date instead of stacking them all on one day', async () => {
    // The defect that made the bulk path unusable: 155 branches all booked for the same date.
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: {
          clusters: [{
            id: 'c-1',
            assignedAssayerId: 'as-real-1',
            branchIds: ['b-1', 'b-2', 'b-3'],
            estimatedTotalFee: 900,
            branchCount: 3,
          }],
        },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
      { id: 'pb-2', branchId: 'b-2' },
      { id: 'pb-3', branchId: 'b-3' },
    ]);
    mockAssignmentService.create.mockImplementation(async () => ({ id: `asg-${Math.random()}` }));

    const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

    const dates = mockAssignmentService.create.mock.calls.map((c: any[]) => c[0].scheduledDate);
    expect(new Set(dates).size).toBe(3);
    expect(dates[0]).toBe('2026-01-05');
    expect(dates.every((d: string) => new Date(`${d}T00:00:00`).getDay() !== 0)).toBe(true);
    expect(result.dateRange).toEqual({ start: dates[0], end: dates[2] });
    // One lookup per branch, batched — not one per placement attempt.
    expect(mockPlanningService.suggestAuditDate).toHaveBeenCalledTimes(3);
  });

  it('never lands a spread branch on a date that branch\'s calendar rules out', async () => {
    mockPlanningService.suggestAuditDate.mockResolvedValue({
      date: '2026-01-05',
      skipped: [{ date: '2026-01-06', reason: 'Republic Day' }],
    });
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1', 'b-2'], estimatedTotalFee: 900, branchCount: 2 }] },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
      { id: 'pb-2', branchId: 'b-2' },
    ]);
    mockAssignmentService.create.mockImplementation(async () => ({ id: 'asg-x' }));

    await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

    const dates = mockAssignmentService.create.mock.calls.map((c: any[]) => c[0].scheduledDate);
    expect(dates).toEqual(['2026-01-05', '2026-01-07']);
  });

  /**
   * Found live 2026-09-04: a 3-branch same-assayer cluster placed branch 1 on a date pushed
   * forward by a cross-cluster capacity collision (ordinary for the multi-branch bundling this
   * executor exists to deploy), which landed on a non-working Saturday `suggestAuditDate`'s
   * one-time, near-term scan had never recorded as blocked. `assignmentService.create` correctly
   * rejected it — and the branch was simply abandoned, even though the very next day was workable
   * and nothing ever tried it. `blocked` is only ever the handful of dates that one scan happened
   * to step over; `assignmentService.create` is the one place that always knows.
   */
  it('retries the next day when create() rejects for a date-availability reason the resolver did not foresee, instead of abandoning the branch', async () => {
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1'], estimatedTotalFee: 900, branchCount: 1 }] },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([{ id: 'pb-1', branchId: 'b-1' }]);
    // The default `suggestAuditDate` mock (see beforeEach) reports nothing blocked — exactly the
    // live shape that let a real rejection through unforeseen.
    mockAssignmentService.create
      .mockRejectedValueOnce(new BadRequestException('Holiday Conflict: Target date is a holiday in Maharashtra.'))
      .mockResolvedValueOnce({ id: 'asg-1' });

    const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

    expect(mockAssignmentService.create).toHaveBeenCalledTimes(2);
    const dates = mockAssignmentService.create.mock.calls.map((c: any[]) => c[0].scheduledDate);
    expect(dates).toEqual(['2026-01-05', '2026-01-06']);
    expect(result.skipped).toHaveLength(0);
    expect(result.deployed).toEqual([{ branchId: 'b-1', assignmentId: 'asg-1', scheduledDate: '2026-01-06' }]);
  });

  it('does not retry a rejection that advancing the date cannot fix', async () => {
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1'], estimatedTotalFee: 900, branchCount: 1 }] },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([{ id: 'pb-1', branchId: 'b-1' }]);
    // Not a "Holiday Conflict:" prefix — e.g. an eligibility or fee-ceiling refusal. Trying a
    // later date cannot change this answer, so it must fail on the first attempt, as before.
    mockAssignmentService.create.mockRejectedValue(new BadRequestException('Assayer has no empanelment record with this client.'));

    const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

    expect(mockAssignmentService.create).toHaveBeenCalledTimes(1);
    expect(result.skippedReasons).toEqual([
      { reason: 'Assayer has no empanelment record with this client.', count: 1 },
    ]);
  });

  it('retries a rejected branch onto a day its assayer already works — there is no daily cap (E2)', async () => {
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1', 'b-2'], estimatedTotalFee: 1800, branchCount: 2 }] },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
      { id: 'pb-2', branchId: 'b-2' },
    ]);
    // b-1's first attempt (2026-01-05) is rejected for a date reason the resolver missed and
    // succeeds the next day — the day its sibling b-2 is spaced onto. Since 2026-09-24 one assayer
    // may hold several branches on one day, so nothing pushes b-2 further out.
    mockAssignmentService.create
      .mockRejectedValueOnce(new BadRequestException('Holiday Conflict: Target date is a holiday in Maharashtra.'))
      .mockResolvedValue({ id: 'asg-ok' });

    const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

    expect(result.skipped).toHaveLength(0);
    expect(result.deployed.map((d) => d.scheduledDate)).toEqual(['2026-01-06', '2026-01-06']);
  });

  it('puts a cluster planned as one day of work on one day, for its one assayer (E2)', async () => {
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1', 'b-2', 'b-3'], estimatedTotalFee: 2700, branchCount: 3, estimatedDurationDays: 1 }] },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
      { id: 'pb-2', branchId: 'b-2' },
      { id: 'pb-3', branchId: 'b-3' },
    ]);
    mockAssignmentService.create.mockReset().mockResolvedValue({ id: 'asg-ok' });

    const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

    expect(result.deployed.map((d) => d.scheduledDate)).toEqual(['2026-01-05', '2026-01-05', '2026-01-05']);
    expect(mockAssignmentService.create.mock.calls.map((c: any[]) => c[0].assayerId)).toEqual(['as-real-1', 'as-real-1', 'as-real-1']);
  });

  it('shares a multi-day cluster out over its days, several a day when there are more branches than days', async () => {
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1', 'b-2', 'b-3', 'b-4'], estimatedTotalFee: 3600, branchCount: 4, estimatedDurationDays: 2 }] },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
      { id: 'pb-2', branchId: 'b-2' },
      { id: 'pb-3', branchId: 'b-3' },
      { id: 'pb-4', branchId: 'b-4' },
    ]);
    mockAssignmentService.create.mockReset().mockResolvedValue({ id: 'asg-ok' });

    const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

    expect(result.deployed.map((d) => d.scheduledDate)).toEqual(['2026-01-05', '2026-01-05', '2026-01-06', '2026-01-06']);
  });
  /**
   * A deploy is safe to run again.
   *
   * The old synchronous deploy was abandoned by the browser at 30 s while the server carried on, and
   * a worker can die part-way too. Either way the plan is left APPROVED with some offers made, and the
   * next Deploy walked every branch from the top — `create` on a branch with a PENDING offer does not
   * refuse, it reassigns it with a fresh event and notification. These pin that a re-run leaves the
   * earlier run's branches alone, and that the key it writes under is what makes that knowable.
   */
  describe('running the same plan version again', () => {
    const approvedTwoBranchPlan = () => {
      mockPlanRepository.findOne.mockResolvedValue({
        id: 'cp-1',
        projectId: 'p-1',
        status: CoveragePlanStatus.APPROVED,
        currentVersion: 3,
        versions: [{
          versionNumber: 3,
          planData: {
            clusters: [
              { id: 'c-1', assignedAssayerId: 'as-1', branchIds: ['b-1'], estimatedTotalFee: 900, branchCount: 1 },
              { id: 'c-2', assignedAssayerId: 'as-1', branchIds: ['b-2'], estimatedTotalFee: 900, branchCount: 1 },
            ],
          },
        }],
      });
      mockProjectQueryService.findProjectBranches.mockResolvedValue([
        { id: 'pb-1', branchId: 'b-1' },
        { id: 'pb-2', branchId: 'b-2' },
      ]);
    };

    it('leaves a branch an earlier run booked alone, counts it as deployed, and books the rest normally', async () => {
      approvedTwoBranchPlan();
      const earlierKey = deploymentRequestId('cp-1', 3, 'pb-1');
      mockPlanRepository.manager.query.mockResolvedValue([
        { client_request_id: earlierKey, assignment_id: 'asg-earlier', assayer_id: 'as-1', scheduled_date: '2026-01-05' },
      ]);
      mockAssignmentService.create.mockReset().mockResolvedValue({ id: 'asg-new' });

      const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

      // Only the branch nobody had booked is written. It may share as-1's day with the earlier
      // run's branch: several branches per assayer per day are allowed (E2).
      expect(mockAssignmentService.create).toHaveBeenCalledTimes(1);
      expect(mockAssignmentService.create.mock.calls[0][0]).toMatchObject({ projectBranchId: 'pb-2', scheduledDate: '2026-01-05' });
      expect(result.deployed).toEqual([
        { branchId: 'b-1', assignmentId: 'asg-earlier', scheduledDate: '2026-01-05' },
        { branchId: 'b-2', assignmentId: 'asg-new', scheduledDate: '2026-01-05' },
      ]);
      expect(result.alreadyDeployedCount).toBe(1);
      expect(mockPlanRepository.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('assignment_idempotency_records'),
        [[earlierKey, deploymentRequestId('cp-1', 3, 'pb-2')]],
      );
    });

    /**
     * The durable half. The lookup spares a re-run the work; the key on each create is what still
     * refuses a second booking when two runs reach one branch at once, or the lookup could not run.
     */
    it('writes every offer under a key fixed by plan, version and branch — not by who deploys or from when', async () => {
      approvedTwoBranchPlan();
      mockAssignmentService.create.mockReset().mockResolvedValue({ id: 'asg-x' });

      await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');
      const firstKeys = mockAssignmentService.create.mock.calls.map((c: any[]) => c[0].clientRequestId);
      mockAssignmentService.create.mockClear();
      // The first run left nothing behind in this mock world (no idempotency rows), so the plan is
      // put back to APPROVED: this asserts the key, not the lookup.
      approvedTwoBranchPlan();
      await service.executeApprovedPlan('cp-1', 'u-2', '2026-02-10');
      const secondKeys = mockAssignmentService.create.mock.calls.map((c: any[]) => c[0].clientRequestId);

      expect(firstKeys).toEqual(['cplan:cp-1:v3:pb-1', 'cplan:cp-1:v3:pb-2']);
      expect(secondKeys).toEqual(firstKeys);
      expect(firstKeys.every((k: string) => k.length <= 100)).toBe(true);
    });

    it('reports a branch a concurrent run booked first as deployed by that run, not as refused', async () => {
      approvedTwoBranchPlan();
      const key = deploymentRequestId('cp-1', 3, 'pb-1');
      mockPlanRepository.manager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ client_request_id: key, assignment_id: 'asg-rival', assayer_id: 'as-1', scheduled_date: '2026-01-05' }]);
      mockAssignmentService.create.mockReset()
        .mockRejectedValueOnce(new ConflictException('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: clientRequestId has already been used.'))
        .mockResolvedValue({ id: 'asg-2' });

      const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

      expect(result.skipped).toEqual([]);
      expect(result.deployed[0]).toEqual({ branchId: 'b-1', assignmentId: 'asg-rival', scheduledDate: '2026-01-05' });
      expect(result.alreadyDeployedCount).toBe(1);
    });

    it('reports branch-by-branch progress to the job running it', async () => {
      approvedTwoBranchPlan();
      mockAssignmentService.create.mockReset().mockResolvedValue({ id: 'asg-x' });
      const onProgress = jest.fn();

      await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05', onProgress);

      expect(onProgress).toHaveBeenCalledWith(0, 2, 'Creating offers');
      expect(onProgress).toHaveBeenCalledWith(1, 2, 'Creating offers');
    });
  });

  /** The 2026-09-25 planning audit. */
  describe('audit 2026-09-25', () => {
    const approvedPlan = (clusters: any[]) => ({
      id: 'cp-1', projectId: 'p-1', status: CoveragePlanStatus.APPROVED, currentVersion: 1,
      versions: [{ versionNumber: 1, planData: { clusters } }],
    });

    /** F21: status changes go through a table; DEPLOYED is reached only by deploying. */
    it('F21: refuses an edge the table does not hold, and never sets DEPLOYED by hand', async () => {
      mockPlanRepository.findOne.mockResolvedValue({ id: 'cp-1', projectId: 'p-1', status: CoveragePlanStatus.GENERATED, currentVersion: 1 });
      await expect(service.transitionPlanStatus('cp-1', CoveragePlanStatus.DEPLOYED, 'u-1')).rejects.toThrow(/only by deploying/);
      mockPlanRepository.findOne.mockResolvedValue({ id: 'cp-1', projectId: 'p-1', status: CoveragePlanStatus.DEPLOYED, currentVersion: 1 });
      await expect(service.transitionPlanStatus('cp-1', CoveragePlanStatus.APPROVED, 'u-1')).rejects.toThrow(BadRequestException);
      mockPlanRepository.findOne.mockResolvedValue({ id: 'cp-1', projectId: 'p-1', status: CoveragePlanStatus.ARCHIVED, currentVersion: 1 });
      await expect(service.transitionPlanStatus('cp-1', CoveragePlanStatus.UNDER_REVIEW, 'u-1')).rejects.toThrow(/final/);
      expect(mockPlanRepository.save).not.toHaveBeenCalled();
    });

    it('F21: allows the edges the lifecycle uses', async () => {
      mockPlanRepository.findOne.mockResolvedValue({ id: 'cp-1', projectId: 'p-1', status: CoveragePlanStatus.GENERATED, currentVersion: 1 });
      await expect(service.transitionPlanStatus('cp-1', CoveragePlanStatus.APPROVED, 'u-1')).resolves.toMatchObject({ status: CoveragePlanStatus.APPROVED });
      expect(canTransitionCoveragePlan(CoveragePlanStatus.APPROVED, CoveragePlanStatus.LOCKED)).toBe(true);
      expect(canTransitionCoveragePlan(CoveragePlanStatus.DEPLOYED, CoveragePlanStatus.ARCHIVED)).toBe(true);
      // Nothing can move TO deployed through the table.
      for (const from of Object.keys(COVERAGE_PLAN_TRANSITIONS) as CoveragePlanStatus[]) {
        expect(canTransitionCoveragePlan(from, CoveragePlanStatus.DEPLOYED)).toBe(false);
      }
    });

    /** F10: a leave refusal moves the date on, bounded like a holiday; a timeline refusal does not. */
    it('F10: a branch refused for the assayer\'s leave is retried on the next workable day', async () => {
      mockPlanRepository.findOne.mockResolvedValue(approvedPlan([{ id: 'c-1', assignedAssayerId: 'as-1', branchIds: ['b-1'], branchCount: 1 }]));
      mockProjectQueryService.findProjectBranches.mockResolvedValue([{ id: 'pb-1', branchId: 'b-1' }]);
      mockAssignmentService.create
        .mockRejectedValueOnce(new Error('Assayer Unavailable: Assayer is on leave on 2026-01-05.'))
        .mockResolvedValueOnce({ id: 'asg-1' });
      const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');
      expect(result.deployed).toEqual([expect.objectContaining({ branchId: 'b-1', scheduledDate: '2026-01-06' })]);
      expect(isDateRefusal('Timeline Conflict: Scheduled date is after project end date 2026-01-01.')).toBe(false);
      expect(isDateRefusal('Holiday Conflict: Target date is a holiday in MH.')).toBe(true);
    });

    it('F10: a long leave still ends as a skip naming it — bounded, not an unbounded walk', async () => {
      mockPlanRepository.findOne.mockResolvedValue(approvedPlan([{ id: 'c-1', assignedAssayerId: 'as-1', branchIds: ['b-1'], branchCount: 1 }]));
      mockProjectQueryService.findProjectBranches.mockResolvedValue([{ id: 'pb-1', branchId: 'b-1' }]);
      mockAssignmentService.create.mockRejectedValue(new Error('Assayer Unavailable: Assayer is on leave.'));
      const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');
      expect(mockAssignmentService.create).toHaveBeenCalledTimes(10);
      expect(result.skipped[0].reason).toMatch(/on leave/);
      mockAssignmentService.create.mockReset();
    });

    /** Rotation at deploy: a hand-picked assayer's written justification is the offer's override reason. */
    it('rotation: a manual override\'s justification reaches create() as the override reason; engine picks carry none', async () => {
      const created: any[] = [];
      mockVersionRepository.create.mockImplementationOnce((x: any) => { created.push(x); return x; });
      mockPlanningEngine.generateCoveragePlan.mockResolvedValueOnce({
        clusters: [{ id: 'c-1', branchIds: ['b-1', 'b-2'], branchAssignments: [
          { branchId: 'b-1', assayerId: 'as-engine' }, { branchId: 'b-2', assayerId: 'as-engine' },
        ] }],
      });
      mockPlanRepository.findOne.mockResolvedValue(null);
      await service.createOrRegeneratePlan('p-1', [{ branchId: 'b-2', assayerId: 'as-last', justification: 'Only one who knows the vault' }], 'u-1');
      const clusters = created[0].planData.clusters;

      mockPlanRepository.findOne.mockResolvedValue(approvedPlan(clusters));
      mockProjectQueryService.findProjectBranches.mockResolvedValue([{ id: 'pb-1', branchId: 'b-1' }, { id: 'pb-2', branchId: 'b-2' }]);
      mockAssignmentService.create.mockResolvedValue({ id: 'asg' });
      await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');
      const byBranch = Object.fromEntries(mockAssignmentService.create.mock.calls.map((c: any[]) => [c[0].projectBranchId, c[0]]));
      expect(byBranch['pb-2']).toMatchObject({ assayerId: 'as-last', overrideReason: 'Only one who knows the vault' });
      expect(byBranch['pb-1']).not.toHaveProperty('overrideReason');
      mockAssignmentService.create.mockReset();
    });

    /** F19 / F1: the saved version is generated for the scope and start date the preview used. */
    it('F19/F1: generates the version with the caller\'s scope and start date', async () => {
      mockPlanRepository.findOne.mockResolvedValue(null);
      mockVersionRepository.create.mockImplementationOnce((x: any) => x);
      const scope = { regions: ['WEST'] } as any;
      await service.createOrRegeneratePlan('p-1', [], 'u-1', undefined, undefined, { scope, startDate: '2026-10-05' });
      expect(mockPlanningEngine.generateCoveragePlan).toHaveBeenCalledWith('p-1', scope, undefined, '2026-10-05');
    });
  });
});
