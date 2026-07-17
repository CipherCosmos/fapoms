import { Repository } from 'typeorm';
import { AssignmentEntity } from './assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
export interface CreateAssignmentDto {
    projectBranchId: string;
    assayerId: string;
    proposedFee: number;
    scheduledDate: string;
    remarks?: string;
}
export declare class AssignmentService {
    private readonly assignmentRepository;
    private readonly projectBranchRepository;
    private readonly holidayService;
    private readonly auditService;
    constructor(assignmentRepository: Repository<AssignmentEntity>, projectBranchRepository: Repository<ProjectBranchEntity>, holidayService: HolidayService, auditService: AuditService);
    create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentEntity>;
    findAll(page?: number, limit?: number): Promise<{
        assignments: AssignmentEntity[];
        total: number;
    }>;
}
