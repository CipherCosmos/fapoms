import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AssayerEntity, AssayerWithWorkforceAttributes } from '../assayer/assayer.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { businessDateKey, BypassableRule, AssignmentRule } from '@fapoms/shared';
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
   * Which rule refused, when one did.
   *
   * The reason sentence is written for a person and must stay that way, so it cannot also be the
   * thing code branches on — and the write path has to branch on it, because whether a stated
   * reason may waive a refusal depends entirely on WHICH refusal it is. `checkDistancePolicy` is
   * the case that forced this: its two branches are the client's independence floor and its
   * service ceiling, one of which an operator may overrule and one of which they may not, and
   * they were distinguishable only by reading the English.
   */
  rule?: AssignmentRule;
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
   * Three checks now — holiday, leave, project timeline. The fourth, double-booking, was retired
   * by the owner on 2026-09-24: an assayer may take several branches on one day.
   *
   * These checks existed individually and each caller picked its own subset, so the
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
    const { assayer, project, scheduledDate } = params;

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

    // No "already booked that day" check any more: owner decision 2026-09-24 (E2) — one assayer
    // may hold several branches on the same day, with no limit. `assayerId` and
    // `excludeAssignmentId` stay in the signature so existing callers need not change.

    return { passed: true };
  }

  /**
   * Evaluates if the scheduled date falls within any active leave range of the assayer.
   */
  checkLeaves(assayer: AssayerEntity, scheduledDate: Date): ConstraintResult {
    if (assayer.leaves && assayer.leaves.length > 0) {
      // Compared as YYYY-MM-DD business-day keys, both ends INCLUSIVE. Leave dates are stored as
      // date strings, so `new Date(endDate)` is midnight of the last day — a timestamp-carrying
      // scheduledDate (any coverage-plan run, `new Date()`) then reads 09:30 > 00:00 and the whole
      // final day of every leave passes the check; a single-day leave never blocked at all. The
      // engine's own conflict describer already compares the string form — now the filter agrees
      // with its explanation.
      const targetKey = businessDateKey(scheduledDate);
      const onLeave = assayer.leaves.some((leave) => {
        const startKey = String(leave.startDate).slice(0, 10);
        const endKey = String(leave.endDate).slice(0, 10);
        return targetKey >= startKey && targetKey <= endKey;
      });
      if (onLeave) {
        if (this.ruleBypass.isBypassedSync(BypassableRule.ASSAYER_LEAVE)) {
          return this.allowBypassed(BypassableRule.ASSAYER_LEAVE, 'assayer is on recorded leave');
        }
        return {
          passed: false,
          reason: `Assayer Unavailable: Assayer is on leave on ${businessDateKey(scheduledDate)}.`,
        };
      }
    }
    return { passed: true };
  }

  /**
   * Evaluates if the scheduled date lies within the project start and end dates.
   *
   * Compared as IST calendar keys, both ends inclusive (F20, 2026-09-25). This compared instants:
   * `project.startDate` is a date column (midnight), the scheduled date usually carries a time or
   * an IST-midnight offset, so the last day of an engagement failed as "after the end date" and a
   * plan run at 09:00 on the first day could read as before it — depending on the server's zone.
   */
  checkProjectTimeline(project: ProjectEntity, scheduledDate: Date): ConstraintResult {
    const dayKey = businessDateKey(scheduledDate);
    const keyOf = (v: Date | string | null | undefined): string | null => {
      if (v == null || v === '') return null;
      return typeof v === 'string' ? v.slice(0, 10) : businessDateKey(v);
    };
    const startKey = keyOf(project.startDate as any);
    const endKey = keyOf(project.endDate as any);
    const before = !!startKey && dayKey < startKey;
    const after = !!endKey && dayKey > endKey;
    // Guarded once rather than at each end of the window — the rule is "the date must be inside
    // the engagement", and suspending it suspends both bounds.
    if ((before || after) && this.ruleBypass.isBypassedSync(BypassableRule.PROJECT_TIMELINE)) {
      return this.allowBypassed(
        BypassableRule.PROJECT_TIMELINE,
        `${dayKey} is outside ${startKey ?? '—'}..${endKey ?? '—'}`,
      );
    }
    if (before) {
      return {
        passed: false,
        reason: `Timeline Conflict: Scheduled date is before project start date ${startKey}.`,
      };
    }
    if (after) {
      return {
        passed: false,
        reason: `Timeline Conflict: Scheduled date is after project end date ${endKey}.`,
      };
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
        return this.allowBypassed(BypassableRule.HOLIDAY_CALENDAR, `${businessDateKey(scheduledDate)} is a holiday in ${state}`);
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
        rule: AssignmentRule.DISTANCE_FLOOR,
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
        rule: AssignmentRule.DISTANCE_CEILING,
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
    return this.checkRequirements(
      assayerEntity,
      project.requiredSkills ?? [],
      project.requiredCertifications ?? [],
      scheduledDate,
      '',
    );
  }

  /**
   * The CLIENT's own required skills and certifications (`planningPreferences.requiredSkills` /
   * `.requiredCertifications`), checked exactly like a project's.
   *
   * Owner decision 2026-09-25: these are a hard requirement, not a preference. They used to be read
   * only by the client-preference SCORER, which dropped a non-matching candidate to 0 on one
   * dimension — so a person the bank had said must hold a certificate still reached the list (a
   * little lower down), and the write path never looked at the field. Now the engine excludes on it
   * and create/reassign refuse on it — both overridable with a written reason, like the project's
   * own skills (same rule, `SKILLS_AND_CERTIFICATIONS`).
   *
   * The preferences arrive from jsonb the API does not type-check, so anything that is not a list
   * of non-empty strings is ignored rather than trusted.
   */
  checkClientRequirements(
    assayerEntity: AssayerEntity,
    planningPreferences: Record<string, any> | null | undefined,
    scheduledDate?: Date,
  ): ConstraintResult {
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
    return this.checkRequirements(
      assayerEntity,
      list(planningPreferences?.requiredSkills),
      list(planningPreferences?.requiredCertifications),
      scheduledDate,
      'The client requires ',
    );
  }

  private checkRequirements(
    assayerEntity: AssayerEntity,
    requiredSkills: string[],
    requiredCertifications: string[],
    scheduledDate: Date | undefined,
    /** Empty for a project's requirements; names the client for the client's own. */
    clientPrefix: string,
  ): ConstraintResult {
    const assayer = assayerEntity as AssayerWithWorkforceAttributes;
    if (requiredSkills.length > 0) {
      const assayerSkills = (assayer.skills || []).map((s) => String(s).trim().toLowerCase());
      const missingSkills = requiredSkills.filter(
        (skill) => !assayerSkills.includes(skill.trim().toLowerCase())
      );
      if (missingSkills.length > 0) {
        if (this.ruleBypass.isBypassedSync(BypassableRule.SKILLS_AND_CERTIFICATIONS)) {
          return this.allowBypassed(BypassableRule.SKILLS_AND_CERTIFICATIONS, `missing skills: ${missingSkills.join(', ')}`);
        }
        return {
          passed: false,
          rule: AssignmentRule.SKILLS_AND_CERTIFICATIONS,
          reason: clientPrefix
            ? `${clientPrefix}skills this assayer lacks: ${missingSkills.join(', ')}`
            : `Assayer Qualification Conflict: Assayer lacks required skills: ${missingSkills.join(', ')}`,
        };
      }
    }

    if (requiredCertifications.length > 0) {
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
        .map((c) => String(c.name ?? '').trim().toLowerCase());
      const missingCerts = requiredCertifications.filter(
        (cert) => !assayerCerts.includes(cert.trim().toLowerCase())
      );
      if (missingCerts.length > 0) {
        if (this.ruleBypass.isBypassedSync(BypassableRule.SKILLS_AND_CERTIFICATIONS)) {
          return this.allowBypassed(BypassableRule.SKILLS_AND_CERTIFICATIONS, `missing or expired certification: ${missingCerts.join(', ')}`);
        }
        return {
          passed: false,
          rule: AssignmentRule.SKILLS_AND_CERTIFICATIONS,
          reason: clientPrefix
            ? `${clientPrefix}a valid certification this assayer lacks (missing or expired): ${missingCerts.join(', ')}`
            : `Assayer Qualification Conflict: Assayer lacks a valid certification (missing or expired): ${missingCerts.join(', ')}`,
        };
      }
    }

    return { passed: true };
  }
}
