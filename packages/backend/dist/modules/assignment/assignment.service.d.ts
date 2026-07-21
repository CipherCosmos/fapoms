import { DataSource, Repository } from 'typeorm';
import { AssignmentEntity } from './assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { AssignmentStatus } from '@fapoms/shared';
export interface CreateAssignmentDto {
    projectBranchId: string;
    assayerId: string;
    proposedFee: number;
    scheduledDate: string;
    remarks?: string;
}
export interface UpdateAssignmentDetailsDto {
    proposedFee?: number;
    agreedFee?: number;
    scheduledDate?: string;
    remarks?: string;
}
export interface TransitionAssignmentDto {
    targetStatus: AssignmentStatus;
    remarks?: string;
    reason?: string;
    fee?: number;
    scheduledDate?: string;
}
export declare class AssignmentService {
    private readonly assignmentRepository;
    private readonly projectBranchRepository;
    private readonly holidayService;
    private readonly auditService;
    private readonly dataSource;
    constructor(assignmentRepository: Repository<AssignmentEntity>, projectBranchRepository: Repository<ProjectBranchEntity>, holidayService: HolidayService, auditService: AuditService, dataSource: DataSource);
    create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentEntity>;
    findOne(id: string): Promise<AssignmentEntity>;
    update(id: string, dto: UpdateAssignmentDetailsDto, userId: string): Promise<AssignmentEntity>;
    transition(id: string, targetStatus: AssignmentStatus, userId: string, remarks?: string, reason?: string, fee?: number, scheduledDate?: string): Promise<AssignmentEntity>;
    findAll(page?: number, limit?: number): Promise<{
        assignments: AssignmentEntity[];
        total: number;
    }>;
}
