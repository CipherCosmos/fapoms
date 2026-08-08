import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConstraintEvaluator } from './constraint.evaluator';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { HolidayService } from '../holiday/holiday.service';

/**
 * ConstraintEvaluator holds the rules that more than one screen depends on. Each of these was
 * previously spelled out separately in several places, and the copies had drifted — which is
 * the whole reason they live here now.
 */
describe('ConstraintEvaluator', () => {
  let evaluator: ConstraintEvaluator;

  const mockAssignmentRepo = { findOne: jest.fn() };
  const mockScheduleRepo = { findOne: jest.fn() };
  const mockHolidayService = { isHoliday: jest.fn() };

  const AUDIT_DATE = new Date('2026-08-20');

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConstraintEvaluator,
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: getRepositoryToken(ScheduleEntity), useValue: mockScheduleRepo },
        { provide: HolidayService, useValue: mockHolidayService },
      ],
    }).compile();

    evaluator = module.get(ConstraintEvaluator);
    jest.clearAllMocks();
    mockHolidayService.isHoliday.mockResolvedValue(false);
    mockAssignmentRepo.findOne.mockResolvedValue(null);
  });

  describe('checkDateAvailability', () => {
    it('reports the most specific reason rather than a generic refusal', async () => {
      mockHolidayService.isHoliday.mockResolvedValue(true);

      const result = await evaluator.checkDateAvailability({
        assayerId: 'as-1',
        branchState: 'Maharashtra',
        scheduledDate: AUDIT_DATE,
      });

      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/Holiday Conflict/);
    });

    it('catches leave even when the date itself is workable', async () => {
      const assayer: any = {
        id: 'as-1',
        leaves: [{ startDate: '2026-08-18', endDate: '2026-08-25' }],
      };

      const result = await evaluator.checkDateAvailability({
        assayer,
        assayerId: 'as-1',
        branchState: 'Maharashtra',
        scheduledDate: AUDIT_DATE,
      });

      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/on leave/i);
    });

    it('catches a date outside the project timeline', async () => {
      const project: any = { startDate: '2026-09-01', endDate: '2026-12-31' };

      const result = await evaluator.checkDateAvailability({
        assayerId: 'as-1',
        project,
        scheduledDate: AUDIT_DATE,
      });

      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/Timeline Conflict/);
    });

    it('does not let an assignment double-book against itself when it is moved', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue({ id: 'asn-1', assignmentNumber: 'A-1' });

      const clash = await evaluator.checkDateAvailability({
        assayerId: 'as-1',
        scheduledDate: AUDIT_DATE,
      });
      expect(clash.passed).toBe(false);

      const moving = await evaluator.checkDateAvailability({
        assayerId: 'as-1',
        scheduledDate: AUDIT_DATE,
        excludeAssignmentId: 'asn-1',
      });
      expect(moving.passed).toBe(true);
    });
  });

  describe('checkDistancePolicy', () => {
    const preferences = { minDistanceKm: 5, maxDistanceKm: 150 };

    it('refuses an assayer inside the conflict-of-interest floor', () => {
      const result = evaluator.checkDistancePolicy(preferences, 2);
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/Conflict of interest/);
    });

    it('never relaxes the floor, even when the ceiling is relaxed', () => {
      const result = evaluator.checkDistancePolicy(preferences, 2, { relaxDistance: true });
      expect(result.passed).toBe(false);
    });

    it('relaxes only the serviceability ceiling', () => {
      expect(evaluator.checkDistancePolicy(preferences, 400).passed).toBe(false);
      expect(evaluator.checkDistancePolicy(preferences, 400, { relaxDistance: true }).passed).toBe(true);
    });

    it('permits a distance inside the band, and says nothing when there is no rule', () => {
      expect(evaluator.checkDistancePolicy(preferences, 60).passed).toBe(true);
      expect(evaluator.checkDistancePolicy(null, 2).passed).toBe(true);
      expect(evaluator.checkDistancePolicy(preferences, null).passed).toBe(true);
    });
  });

  describe('checkSkillsAndCertifications', () => {
    const project: any = { requiredCertifications: ['Gold Assaying'], requiredSkills: [] };

    it('rejects a certification that has lapsed by the audit date', () => {
      const assayer: any = {
        skills: [],
        certifications: [{ name: 'Gold Assaying', expiryDate: '2026-07-01' }],
      };

      const result = evaluator.checkSkillsAndCertifications(assayer, project, AUDIT_DATE);

      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/expired/i);
    });

    it('accepts one that is still valid on that date', () => {
      const assayer: any = {
        skills: [],
        certifications: [{ name: 'Gold Assaying', expiryDate: '2027-01-01' }],
      };

      expect(evaluator.checkSkillsAndCertifications(assayer, project, AUDIT_DATE).passed).toBe(true);
    });

    it('accepts a certification recorded without an expiry', () => {
      const assayer: any = { skills: [], certifications: [{ name: 'Gold Assaying' }] };
      expect(evaluator.checkSkillsAndCertifications(assayer, project, AUDIT_DATE).passed).toBe(true);
    });
  });

  describe("the client's own working days", () => {
    it('treats a day the client does not work as unworkable', async () => {
      // HolidayService owns this rule; the evaluator's job is to pass the client through so it
      // can be applied at all. Before this, working_days was stored, settable through the API,
      // and read by nothing.
      mockHolidayService.isHoliday.mockImplementation(
        async (_d: Date, _s?: string, clientId?: string) => clientId === 'client-sat-off',
      );

      const blocked = await evaluator.checkHoliday('Maharashtra', AUDIT_DATE, 'client-sat-off');
      expect(blocked.passed).toBe(false);

      const allowed = await evaluator.checkHoliday('Maharashtra', AUDIT_DATE, 'client-sat-on');
      expect(allowed.passed).toBe(true);
    });

    it('passes the client through from the composite availability gate', async () => {
      mockHolidayService.isHoliday.mockResolvedValue(false);

      await evaluator.checkDateAvailability({
        assayerId: 'as-1',
        branchState: 'Maharashtra',
        clientId: 'client-1',
        scheduledDate: AUDIT_DATE,
      });

      expect(mockHolidayService.isHoliday).toHaveBeenCalledWith(AUDIT_DATE, 'Maharashtra', 'client-1');
    });
  });

});
