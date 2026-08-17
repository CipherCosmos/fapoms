import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { CallLogService, CallOutcome } from './call-log.service';
import { CallLogEntity } from './call-log.entity';
import { AssessmentEntity } from './assessment.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';

/**
 * Reading a branch's call history must not require an assessment to exist.
 *
 * Reported from production as a 404 on
 * `GET /call-logs/last-contact?projectBranchId=8058137e-…`. The route was deployed and mapped —
 * unauthenticated it answers 401, not 404 — so the 404 came from the service: every read went
 * through `resolveAssessmentId`, which throws when the branch has no assessment row yet.
 *
 * The planning workspace fetches last-contact whenever an operator selects a branch, so on any
 * such branch the request failed and the candidate list lost the "called 2h ago — no answer"
 * hints it exists to show. Ten of ninety-eight project branches in the development database have
 * no assessment row, so this was never rare.
 */
describe('CallLogService — reads on a branch with no assessment', () => {
  let service: CallLogService;

  const callLogRepo = { find: jest.fn(), create: jest.fn(), save: jest.fn() };
  const assessmentRepo = { findOne: jest.fn() };
  const projectBranchRepo = { findOne: jest.fn() };
  const audit = { recordEvent: jest.fn(), recordEventSafe: jest.fn() };

  const BRANCH = 'pb-1';
  const knownBranch = { id: BRANCH, projectId: 'p-1', branchId: 'b-1' };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallLogService,
        { provide: getRepositoryToken(CallLogEntity), useValue: callLogRepo },
        { provide: getRepositoryToken(AssessmentEntity), useValue: assessmentRepo },
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: projectBranchRepo },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(CallLogService);
  });

  describe('when the branch exists but has no assessment', () => {
    beforeEach(() => {
      projectBranchRepo.findOne.mockResolvedValue(knownBranch);
      assessmentRepo.findOne.mockResolvedValue(null);
    });

    it('reports an empty call history rather than 404 — nobody has been called', async () => {
      await expect(service.findForProjectBranch(BRANCH)).resolves.toEqual([]);
    });

    it('reports no last contact rather than 404, so selecting the branch does not fail', async () => {
      await expect(service.lastContactByAssayer(BRANCH)).resolves.toEqual({});
    });

    it('does not query the call log at all — there is no assessment to key on', async () => {
      await service.lastContactByAssayer(BRANCH);
      expect(callLogRepo.find).not.toHaveBeenCalled();
    });

    it('STILL refuses to record a call: a log has nowhere to be stored yet', async () => {
      // The write path keeps its 404 deliberately. A call log hangs off the assessment, so
      // accepting one here would have nowhere to put it.
      await expect(
        service.create(
          { projectBranchId: BRANCH, assayerId: 'a-1', outcome: CallOutcome.NO_ANSWER },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(callLogRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('when the branch itself does not exist', () => {
    beforeEach(() => {
      projectBranchRepo.findOne.mockResolvedValue(null);
    });

    it('is still a 404 on read — that question is about nothing, not empty', async () => {
      // The distinction the fix rests on: a missing *assessment* has an empty answer, a missing
      // *branch* has no answer. Collapsing both to [] would hide a bad id from the caller.
      await expect(service.findForProjectBranch('nope')).rejects.toThrow(NotFoundException);
      await expect(service.lastContactByAssayer('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('when the assessment does exist', () => {
    it('reads the history against it, newest first', async () => {
      projectBranchRepo.findOne.mockResolvedValue(knownBranch);
      assessmentRepo.findOne.mockResolvedValue({ id: 'as-1' });
      callLogRepo.find.mockResolvedValue([
        { assessorId: 'a-1', outcome: 'AGREED', timestamp: new Date('2026-08-02'), negotiatedFee: '1500' },
        { assessorId: 'a-1', outcome: 'NO_ANSWER', timestamp: new Date('2026-08-01'), negotiatedFee: null },
        { assessorId: 'a-2', outcome: 'DECLINED', timestamp: new Date('2026-08-01'), negotiatedFee: null },
      ]);

      const out = await service.lastContactByAssayer(BRANCH);

      expect(callLogRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { assessmentId: 'as-1', isActive: true } }),
      );
      // Newest per assayer wins, and the fee comes back as a number rather than a numeric string.
      expect(out['a-1']).toEqual({ outcome: 'AGREED', timestamp: new Date('2026-08-02'), negotiatedFee: 1500 });
      expect(out['a-2'].outcome).toBe('DECLINED');
      expect(out['a-2'].negotiatedFee).toBeNull();
    });
  });
});
