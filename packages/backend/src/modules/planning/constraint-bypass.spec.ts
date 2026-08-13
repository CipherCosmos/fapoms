import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BypassableRule } from '@fapoms/shared';
import { ConstraintEvaluator } from './constraint.evaluator';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { HolidayService } from '../holiday/holiday.service';
import { RuleBypassService } from '../platform/rule-bypass/rule-bypass.service';

/**
 * That the switch is wired to the rules it claims to control.
 *
 * The service tests prove the window opens, closes and expires. These prove the other half —
 * that each enforcement point actually consults it. That is the half which fails silently: an
 * administrator suspends the certification check, the screen still refuses, and the only symptom
 * is somebody saying "the bypass doesn't work" with no error to point at.
 *
 * Each case asserts both directions, because a bypass that leaks when it is *off* is a far worse
 * bug than one that fails to apply when it is on.
 */
describe('ConstraintEvaluator honours the rule bypass', () => {
  let evaluator: ConstraintEvaluator;
  let suspended: Set<BypassableRule>;
  const noted: BypassableRule[] = [];

  const assignmentRepo = { findOne: jest.fn().mockResolvedValue(null) };
  const scheduleRepo = { findOne: jest.fn().mockResolvedValue(null) };
  const holidayService = { isHoliday: jest.fn().mockResolvedValue(false) };

  beforeEach(async () => {
    suspended = new Set();
    noted.length = 0;
    jest.clearAllMocks();
    assignmentRepo.findOne.mockResolvedValue(null);
    holidayService.isHoliday.mockResolvedValue(false);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConstraintEvaluator,
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: getRepositoryToken(ScheduleEntity), useValue: scheduleRepo },
        { provide: HolidayService, useValue: holidayService },
        {
          provide: RuleBypassService,
          useValue: {
            isBypassedSync: (r: BypassableRule) => suspended.has(r),
            isBypassed: async (r: BypassableRule) => suspended.has(r),
            noteBypass: (r: BypassableRule) => noted.push(r),
          },
        },
      ],
    }).compile();
    evaluator = module.get(ConstraintEvaluator);
  });

  const date = new Date('2026-09-15T00:00:00Z');

  describe('certification requirements', () => {
    const project: any = { id: 'p1', requiredCertifications: ['Gold Assaying L2'], requiredSkills: [] };
    const assayer: any = { id: 'a1', skills: [], certifications: [] };

    it('blocks an unqualified assayer while the rule is enforced', () => {
      const result = evaluator.checkSkillsAndCertifications(assayer, project, date);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('certification');
    });

    it('lets them through once an administrator suspends it', () => {
      suspended.add(BypassableRule.SKILLS_AND_CERTIFICATIONS);
      const result = evaluator.checkSkillsAndCertifications(assayer, project, date);
      expect(result.passed).toBe(true);
      // The caller can tell this passed only because of a bypass, and say so.
      expect(result.bypassed).toBe(BypassableRule.SKILLS_AND_CERTIFICATIONS);
      expect(noted).toContain(BypassableRule.SKILLS_AND_CERTIFICATIONS);
    });

    it('still blocks when a different rule is the one suspended', () => {
      suspended.add(BypassableRule.HOLIDAY_CALENDAR);
      expect(evaluator.checkSkillsAndCertifications(assayer, project, date).passed).toBe(false);
    });
  });

  describe('the conflict-of-interest distance floor', () => {
    const prefs = { minDistanceKm: 25 };

    it('blocks an assayer living beside the branch', () => {
      expect(evaluator.checkDistancePolicy(prefs, 3).passed).toBe(false);
    });

    it('is suspendable', () => {
      suspended.add(BypassableRule.DISTANCE_POLICY);
      const result = evaluator.checkDistancePolicy(prefs, 3);
      expect(result.passed).toBe(true);
      expect(result.bypassed).toBe(BypassableRule.DISTANCE_POLICY);
    });
  });

  describe('the holiday calendar', () => {
    it('blocks a public holiday', async () => {
      holidayService.isHoliday.mockResolvedValue(true);
      await expect(evaluator.checkHoliday('Kerala', date)).resolves.toMatchObject({ passed: false });
    });

    it('is suspendable', async () => {
      holidayService.isHoliday.mockResolvedValue(true);
      suspended.add(BypassableRule.HOLIDAY_CALENDAR);
      await expect(evaluator.checkHoliday('Kerala', date)).resolves.toMatchObject({
        passed: true,
        bypassed: BypassableRule.HOLIDAY_CALENDAR,
      });
    });
  });

  describe('double booking', () => {
    it('blocks a second audit on the same day', async () => {
      assignmentRepo.findOne.mockResolvedValue({ id: 'x', assignmentNumber: 'ASN-1' });
      await expect(evaluator.checkDoubleBooking('a1', date)).resolves.toMatchObject({ passed: false });
    });

    it('is suspendable', async () => {
      assignmentRepo.findOne.mockResolvedValue({ id: 'x', assignmentNumber: 'ASN-1' });
      suspended.add(BypassableRule.DOUBLE_BOOKING);
      await expect(evaluator.checkDoubleBooking('a1', date)).resolves.toMatchObject({
        passed: true,
        bypassed: BypassableRule.DOUBLE_BOOKING,
      });
    });
  });

  describe('recorded leave', () => {
    const onLeave: any = { id: 'a1', leaves: [{ startDate: '2026-09-10', endDate: '2026-09-20' }] };

    it('blocks an assayer on leave', () => {
      expect(evaluator.checkLeaves(onLeave, date).passed).toBe(false);
    });

    it('is suspendable', () => {
      suspended.add(BypassableRule.ASSAYER_LEAVE);
      expect(evaluator.checkLeaves(onLeave, date)).toMatchObject({
        passed: true,
        bypassed: BypassableRule.ASSAYER_LEAVE,
      });
    });
  });

  describe('the project window', () => {
    const project: any = { id: 'p1', startDate: '2026-10-01', endDate: '2026-10-31' };

    it('blocks a date outside the engagement', () => {
      expect(evaluator.checkProjectTimeline(project, date).passed).toBe(false);
    });

    it('is suspendable at both ends', () => {
      suspended.add(BypassableRule.PROJECT_TIMELINE);
      expect(evaluator.checkProjectTimeline(project, date)).toMatchObject({ passed: true });
      expect(evaluator.checkProjectTimeline(project, new Date('2026-12-01T00:00:00Z'))).toMatchObject({ passed: true });
    });
  });

  it('suspends nothing at all when no window is open', () => {
    // The state the platform is in essentially always, asserted explicitly so a default that
    // drifts to "permissive" is caught here rather than in production.
    const project: any = { id: 'p1', requiredCertifications: ['X'], requiredSkills: ['Y'] };
    expect(evaluator.checkSkillsAndCertifications({ id: 'a', skills: [], certifications: [] } as any, project).passed).toBe(false);
    expect(evaluator.checkDistancePolicy({ minDistanceKm: 25 }, 1).passed).toBe(false);
    expect(evaluator.checkLeaves({ id: 'a', leaves: [{ startDate: '2026-09-10', endDate: '2026-09-20' }] } as any, date).passed).toBe(false);
    expect(noted).toHaveLength(0);
  });
});
