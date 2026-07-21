import { Repository } from 'typeorm';
import { CommunicationEntity } from './communication.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { CommunicationType } from '@fapoms/shared';
export interface CreateCommunicationDto {
    assignmentId: string;
    type: CommunicationType;
    content: string;
    recipientRef?: string;
}
export declare class CommunicationService {
    private readonly communicationRepository;
    private readonly assignmentRepository;
    private readonly auditService;
    constructor(communicationRepository: Repository<CommunicationEntity>, assignmentRepository: Repository<AssignmentEntity>, auditService: AuditService);
    create(dto: CreateCommunicationDto, userId: string): Promise<CommunicationEntity>;
    findByAssignment(assignmentId: string): Promise<CommunicationEntity[]>;
}
