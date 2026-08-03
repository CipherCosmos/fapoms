import { Repository } from 'typeorm';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AssayerEntity } from '../assayer/assayer.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectEntity } from '../project/project.entity';
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
export declare class ConstraintEvaluator {
    private readonly assignmentRepository;
    private readonly scheduleRepository;
    private readonly holidayService;
    constructor(assignmentRepository: Repository<AssignmentEntity>, scheduleRepository: Repository<ScheduleEntity>, holidayService: HolidayService);
    checkDoubleBooking(assayerId: string, scheduledDate: Date): Promise<ConstraintResult>;
    checkLeaves(assayer: AssayerEntity, scheduledDate: Date): ConstraintResult;
    checkProjectTimeline(project: ProjectEntity, scheduledDate: Date): ConstraintResult;
    checkHoliday(state: string, scheduledDate: Date): Promise<ConstraintResult>;
    checkSkillsAndCertifications(assayerEntity: AssayerEntity, project: ProjectEntity): ConstraintResult;
}
