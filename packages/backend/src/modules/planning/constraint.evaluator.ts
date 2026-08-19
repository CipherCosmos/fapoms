import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AssayerEntity, AssayerWithWorkforceAttributes } from '../assayer/assayer.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssignmentStatus, businessDateKey, BypassableRule } from '@fapoms/shared';
import { COMMITTED_ASSIGNMENT_STATUSES } from '../assignment/assignment-workload';
import { RuleBypassService } from '../platform/rule-bypass/rule-bypass.service';

export interface ConstraintContext {
  assayer: AssayerEntity;
  branch: BranchEntity;
  project?: ProjectEntity | null;
  scheduledDate: Date;
}

export interface ConstraintResult {
  passed: boolean;
  reason?: string;
  /**
   * Set when this check passed only because an administrator has the rule suspended. Callers
   * that surface outcomes to a person should say so — a plan that is valid only while a bypass
   * window is open should not read as an ordinary plan.
   */
  bypassed?: BypassableRule;
}

@Injectable()
export class ConstraintEvaluator {
  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(ScheduleEntity)
    private readonly scheduleRepository: Repository<ScheduleEntity>,
    private readonly holidayService: HolidayService,
    /**
     * Rules an administrator has deliberately suspended — see modules/platform/rule-bypass.
     *
     * Consulted here rather than at each of the dozen call sites because this class IS the
     * chokepoint: seven of the twelve suspendable rules are decided in this file, and a bypass
     * honoured by the planner but not by the assignment write path would be worse than no
     * bypass at all — the operator would be told the rule is off and still be refused.
     */
    private readonly ruleBypass: RuleBypassService,
  ) {}

  /**
   * Let a suspended rule through, recording that it happened.
   *
   * Returns a passing result carrying `bypassed`, so a caller that wants to warn ("assigned
   * with the certification check suspended") can, while every existing caller that only reads
   * `passed` keeps working unchanged.
   */
  private allowBypassed(rule: BypassableRule, detail: string): ConstraintResult {
    this.ruleBypass.noteBypass(rule, { detail });
    return { passed: true, bypassed: rule };
  }

  /**
   * Every rule that decides whether one assayer may work one date, in one place.
   *
   * These four checks existed individually and each caller picked its own subset, so the
   * answer to "can this assayer work this date?" depended on which screen asked. Creating an
   * assignment checked holidays and double-booking; SchedulingService.create checked leave,
   * project timeline and holidays; rescheduling checked none of them; and the candidate list
   * used a fourth combination. An operator could therefore reschedule an audit onto a
   * registered bank holiday, or onto a date the assayer was already booked or on leave, and
   * it would be written to schedules, assignments, project_branches and assessments without
   * objection.
   *
   * Returns the first failure so the caller reports the most specific reason, not a generic
   * "unavailable". `excludeAssignmentId` lets a reschedule ignore the assignment being moved,
   * which would otherwise double-book against itself.
   */
  async checkDateAvailability(params: {
    assayer?: AssayerEntity | null;
    assayerId?: string | null;
    project?: ProjectEntity | null;
    branchState?: string | null;
    /** The client whose configured working days apply to this date. */
    clientId?: string | null;
    scheduledDate: Date;
    excludeAssignmentId?: string;
  }): Promise<ConstraintResult> {
    const { assayer, project, scheduledDate, excludeAssignmentId } = params;
    const assayerId = params.assayerId ?? assayer?.id ?? null;

    const holiday = await this.checkHoliday(params.branchState || '', scheduledDate, params.clientId ?? undefined);
    if (!holiday.passed) return holiday;

    if (assayer) {
      const leave = this.checkLeaves(assayer, scheduledDate);
      if (!leave.passed) return leave;
    }

    if (project) {
      const timeline = this.checkProjectTimeline(project, scheduledDate);
      if (!timeline.passed) return timeline;
    }

    if (assayerId) {
      const booking = await this.checkDoubleBooking(assayerId, scheduledDate, excludeAssignmentId);
      if (!booking.passed) return booking;
    }

    return { passed: true };
  }

  /**
   * Evaluates if the assayer has a double-booking conflict on the scheduled date.
   */
  async checkDoubleBooking(
    assayerId: string,
    scheduledDate: Date,
    excludeAssignmentId?: string,
  ): Promise<ConstraintResult> {
    const doubleBooked = await this.assignmentRepository.findOne({
      where: {
        assayerId,
        // `scheduledDate` is a `date` column — match on the date-only key, not a Date-with-time,
        // which never equals a midnight `date` value in Postgres and silenced this guard.
        scheduledDate: businessDateKey(scheduledDate) as any,
        // Every status that means the assayer's day is already committed — not just ACCEPTED.
        // Checking in moves an assignment to CHECKED_IN, which made the person invisible to
        // this guard: they could be booked a second branch for the same date while standing in
        // the first one. `COMMITTED_ASSIGNMENT_STATUSES` is the shared answer to "is this day
        // spoken for", and exists precisely so the two callers of this question agree.
        status: In(COMMITTED_ASSIGNMENT_STATUSES),
        isActive: true,
      },
    });

    // Moving an assignment must not collide with the assignment being moved.
    if (doubleBooked && excludeAssignmentId && doubleBooked.id === excludeAssignmentId) {
      return { passed: true };
    }

    if (doubleBooked) {
      if (this.ruleBypass.isBypassedSync(BypassableRule.DOUBLE_BOOKING)) {
        return this.allowBypassed(BypassableRule.DOUBLE_BOOKING, `would have collided with ${doubleBooked.assignmentNumber}`);
      }
      return {
        passed: false,
        reason: `Assayer double booking: already committed to assignment ${doubleBooked.assignmentNumber} on ${scheduledDate.toISOString().split('T')[0]}.`,
      };
    }

    return { passed: true };
  }

  /**
   * Evaluates if the scheduled date falls within any active leave range of the assayer.
   */
  checkLeaves(assayer: AssayerEntity, scheduledDate: Date): ConstraintResult {
    if (assayer.leaves && assayer.leaves.length > 0) {
      const targetTime = scheduledDate.getTime();
      const onLeave = assayer.leaves.some((leave) => {
        const start = new Date(leave.startDate).getTime();
        const end = new Date(leave.endDate).getTime();
        return targetTime >= start && targetTime <= end;
      });
      if (onLeave) {
        if (this.ruleBypass.isBypassedSync(BypassableRule.ASSAYER_LEAVE)) {
          return this.allowBypassed(BypassableRule.ASSAYER_LEAVE, 'assayer is on recorded leave');
        }
        return {
          passed: false,
          reason: `Assayer Unavailable: Assayer is on leave on ${scheduledDate.toISOString().split('T')[0]}.`,
        };
      }
    }
    return { passed: true };
  }

  /**
   * Evaluates if the scheduled date lies within the project start and end dates.
   */
  checkProjectTimeline(project: ProjectEntity, scheduledDate: Date): ConstraintResult {
    // Guarded once at the top rather than at each end of the window — the rule is "the date must
    // be inside the engagement", and suspending it suspends both bounds.
    if (this.ruleBypass.isBypassedSync(BypassableRule.PROJECT_TIMELINE)) {
      const outside =
        (project.startDate && scheduledDate.getTime() < new Date(project.startDate).getTime()) ||
        (project.endDate && scheduledDate.getTime() > new Date(project.endDate).getTime());
      if (outside) {
        return this.allowBypassed(
          BypassableRule.PROJECT_TIMELINE,
          `${scheduledDate.toISOString().slice(0, 10)} is outside ${project.startDate ?? '—'}..${project.endDate ?? '—'}`,
        );
      }
    }
    const scheduledTime = scheduledDate.getTime();
    if (project.startDate) {
      const projectStart = new Date(project.startDate).getTime();
      if (scheduledTime < projectStart) {
        return {
          passed: false,
          reason: `Timeline Conflict: Scheduled date is before project start date ${project.startDate}.`,
        };
      }
    }
    if (project.endDate) {
      const projectEnd = new Date(project.endDate).getTime();
      if (scheduledTime > projectEnd) {
        return {
          passed: false,
          reason: `Timeline Conflict: Scheduled date is after project end date ${project.endDate}.`,
        };
      }
    }
    return { passed: true };
  }

  /**
   * Evaluates if the scheduled date is a regional holiday for the branch.
   */
  async checkHoliday(state: string, scheduledDate: Date, clientId?: string): Promise<ConstraintResult> {
    // clientId matters: the client's own configured working days decide whether the date is
    // workable at all, before any holiday row is consulted.
    const isHoliday = await this.holidayService.isHoliday(scheduledDate, state, clientId);
    if (isHoliday) {
      if (this.ruleBypass.isBypassedSync(BypassableRule.HOLIDAY_CALENDAR)) {
        return this.allowBypassed(BypassableRule.HOLIDAY_CALENDAR, `${scheduledDate.toISOString().slice(0, 10)} is a holiday in ${state}`);
      }
      return {
        passed: false,
        reason: `Holiday Conflict: Target date is a holiday in ${state}.`,
      };
    }
    return { passed: true };
  }

  /**
   * The client's territorial rules for who may audit a branch.
   *
   * `minDistanceKm` is a conflict-of-interest floor — an assayer must be far enough from the
   * branch they audit, not close to it — and `maxDistanceKm` is a serviceability ceiling. The
   * day planner enforced both as hard exclusions, while the single-branch path only subtracted
   * 40 points from the score and the write path did not check at all, so an operator could
   * assign an assayer living beside the branch simply by using the per-branch flow. A control
   * that one screen enforces and another merely discourages is not a control.
   *
   * `relaxDistance` exists for the ceiling only: when nothing is serviceable, ops may knowingly
   * reach further. The floor is never relaxed — that is the whole point of it.
   */
  checkDistancePolicy(
    planningPreferences: Record<string, any> | null | undefined,
    distanceKm: number | null | undefined,
    options?: { relaxDistance?: boolean },
  ): ConstraintResult {
    if (distanceKm === null || distanceKm === undefined || !Number.isFinite(Number(distanceKm))) {
      return { passed: true };
    }
    const distance = Number(distanceKm);

    const minDistance = Number(planningPreferences?.minDistanceKm);
    if (Number.isFinite(minDistance) && minDistance > 0 && distance < minDistance) {
      if (this.ruleBypass.isBypassedSync(BypassableRule.DISTANCE_POLICY)) {
        return this.allowBypassed(BypassableRule.DISTANCE_POLICY, `${distance.toFixed(1)}km is inside the ${minDistance}km independence floor`);
      }
      return {
        passed: false,
        reason: `Conflict of interest: ${distance.toFixed(1)}km is within the client's ${minDistance}km minimum-distance rule.`,
      };
    }

    const maxDistance = Number(planningPreferences?.maxDistanceKm);
    if (!options?.relaxDistance && Number.isFinite(maxDistance) && maxDistance > 0 && distance > maxDistance) {
      if (this.ruleBypass.isBypassedSync(BypassableRule.DISTANCE_POLICY)) {
        return this.allowBypassed(BypassableRule.DISTANCE_POLICY, `${distance.toFixed(1)}km exceeds the ${maxDistance}km service limit`);
      }
      return {
        passed: false,
        reason: `Out of range: ${distance.toFixed(1)}km exceeds the client's ${maxDistance}km limit.`,
      };
    }

    return { passed: true };
  }

  /**
   * Evaluates if the assayer possesses all required skills and certifications.
   */
  checkSkillsAndCertifications(
    assayerEntity: AssayerEntity,
    project: ProjectEntity,
    scheduledDate?: Date,
  ): ConstraintResult {
    const assayer = assayerEntity as AssayerWithWorkforceAttributes;
    if (project.requiredSkills && project.requiredSkills.length > 0) {
      const assayerSkills = (assayer.skills || []).map((s) => s.trim().toLowerCase());
      const missingSkills = project.requiredSkills.filter(
        (skill) => !assayerSkills.includes(skill.trim().toLowerCase())
      );
      if (missingSkills.length > 0) {
        if (this.ruleBypass.isBypassedSync(BypassableRule.SKILLS_AND_CERTIFICATIONS)) {
          return this.allowBypassed(BypassableRule.SKILLS_AND_CERTIFICATIONS, `missing skills: ${missingSkills.join(', ')}`);
        }
        return {
          passed: false,
          reason: `Assayer Qualification Conflict: Assayer lacks required skills: ${missingSkills.join(', ')}`,
        };
      }
    }

    if (project.requiredCertifications && project.requiredCertifications.length > 0) {
      /**
       * A certification the assayer no longer holds does not qualify them.
       *
       * This gate matched on name alone while the CERTIFICATION business rule
       * (platform/rules/rule.engine.ts) also required the certification to be unexpired on the
       * audit date. Since this is the hard gate — it blocks assignment creation and filters the
       * candidate list — an assayer with a lapsed certification passed the check that actually
       * stops work while failing the rule that only advises. Expiry dates are real, maintained
       * data: all 24 certifications on record carry one.
       */
      const asOf = scheduledDate ?? new Date();
      const assayerCerts = (assayer.certifications || [])
        .filter((c) => !c.expiryDate || new Date(c.expiryDate) > asOf)
        .map((c) => c.name.trim().toLowerCase());
      const missingCerts = project.requiredCertifications.filter(
        (cert) => !assayerCerts.includes(cert.trim().toLowerCase())
      );
      if (missingCerts.length > 0) {
        if (this.ruleBypass.isBypassedSync(BypassableRule.SKILLS_AND_CERTIFICATIONS)) {
          return this.allowBypassed(BypassableRule.SKILLS_AND_CERTIFICATIONS, `missing or expired certification: ${missingCerts.join(', ')}`);
        }
        return {
          passed: false,
          reason: `Assayer Qualification Conflict: Assayer lacks a valid certification (missing or expired): ${missingCerts.join(', ')}`,
        };
      }
    }

    return { passed: true };
  }
}
