import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AssayerEntity, AssayerWithWorkforceAttributes } from '../assayer/assayer.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssignmentStatus } from '@fapoms/shared';

export interface ConstraintContext {
  assayer: AssayerEntity;
  branch: BranchEntity;
  project?: ProjectEntity | null;
  scheduledDate: Date;
}

export interface ConstraintResult {
  passed: boolean;
  reason?: string;
}

@Injectable()
export class ConstraintEvaluator {
  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(ScheduleEntity)
    private readonly scheduleRepository: Repository<ScheduleEntity>,
    private readonly holidayService: HolidayService,
  ) {}

  /**
   * Evaluates if the assayer has a double-booking conflict on the scheduled date.
   */
  async checkDoubleBooking(assayerId: string, scheduledDate: Date): Promise<ConstraintResult> {
    const doubleBooked = await this.assignmentRepository.findOne({
      where: {
        assayerId,
        scheduledDate,
        status: In([AssignmentStatus.ACCEPTED]),
        isActive: true,
      },
    });

    if (doubleBooked) {
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
  async checkHoliday(state: string, scheduledDate: Date): Promise<ConstraintResult> {
    const isHoliday = await this.holidayService.isHoliday(scheduledDate, state);
    if (isHoliday) {
      return {
        passed: false,
        reason: `Holiday Conflict: Target date is a holiday in ${state}.`,
      };
    }
    return { passed: true };
  }

  /**
   * Evaluates if the assayer possesses all required skills and certifications.
   */
  checkSkillsAndCertifications(assayerEntity: AssayerEntity, project: ProjectEntity): ConstraintResult {
    const assayer = assayerEntity as AssayerWithWorkforceAttributes;
    if (project.requiredSkills && project.requiredSkills.length > 0) {
      const assayerSkills = (assayer.skills || []).map((s) => s.trim().toLowerCase());
      const missingSkills = project.requiredSkills.filter(
        (skill) => !assayerSkills.includes(skill.trim().toLowerCase())
      );
      if (missingSkills.length > 0) {
        return {
          passed: false,
          reason: `Assayer Qualification Conflict: Assayer lacks required skills: ${missingSkills.join(', ')}`,
        };
      }
    }

    if (project.requiredCertifications && project.requiredCertifications.length > 0) {
      const assayerCerts = (assayer.certifications || []).map((c) => c.name.trim().toLowerCase());
      const missingCerts = project.requiredCertifications.filter(
        (cert) => !assayerCerts.includes(cert.trim().toLowerCase())
      );
      if (missingCerts.length > 0) {
        return {
          passed: false,
          reason: `Assayer Qualification Conflict: Assayer lacks required certifications: ${missingCerts.join(', ')}`,
        };
      }
    }

    return { passed: true };
  }
}
