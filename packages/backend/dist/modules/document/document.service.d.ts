import { Repository } from 'typeorm';
import { DocumentEntity } from './document.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { DocumentStatus, DocumentType } from '@fapoms/shared';
export interface CreateDocumentDto {
    assessmentId: string;
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType?: string;
    type: DocumentType;
}
export declare class DocumentService {
    private readonly documentRepository;
    private readonly assessmentRepository;
    private readonly projectBranchRepository;
    private readonly assignmentRepository;
    private readonly auditService;
    private readonly eventPublisher;
    private readonly notificationService;
    private readonly pushNotificationService;
    private readonly localStorageService;
    constructor(documentRepository: Repository<DocumentEntity>, assessmentRepository: Repository<AssessmentEntity>, projectBranchRepository: Repository<ProjectBranchEntity>, assignmentRepository: Repository<AssignmentEntity>, auditService: AuditService, eventPublisher: DomainEventPublisher, notificationService: NotificationService, pushNotificationService: PushNotificationService, localStorageService: LocalStorageService);
    create(dto: CreateDocumentDto, userId: string): Promise<DocumentEntity>;
    findOne(id: string): Promise<DocumentEntity>;
    updateStatus(id: string, status: DocumentStatus, userId: string): Promise<DocumentEntity>;
    findByProjectBranch(projectBranchId: string): Promise<DocumentEntity[]>;
    findByAssessment(assessmentId: string): Promise<DocumentEntity[]>;
    findByProject(projectId: string): Promise<DocumentEntity[]>;
    dispatchDocument(id: string, userId: string): Promise<DocumentEntity>;
    receiveDocument(id: string, userId: string): Promise<DocumentEntity>;
    findDataEntryQueue(): Promise<{
        project: string;
        branch: string;
        documents: DocumentEntity[];
    }[]>;
    findAll(): Promise<DocumentEntity[]>;
    getDocumentStats(): Promise<{
        total: number;
        uploaded: number;
        dispatched: number;
        received: number;
    }>;
}
