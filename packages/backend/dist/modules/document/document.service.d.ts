import { ValidationService } from '../validation/validation.service';
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
import { DocumentStatus, DocumentType, DispatchMethod } from '@fapoms/shared';
export interface CreateDocumentDto {
    assessmentId: string;
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType?: string;
    type: DocumentType;
    customerMasterVersionId?: string;
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
    private readonly validationService;
    private readonly logger;
    dataEntryQueue(assignedTo?: string): Promise<any>;
    dataEntryTeam(): Promise<any[]>;
    assignForDataEntry(documentId: string, assigneeId: string, actorId: string): Promise<DocumentEntity>;
    completeDataEntry(documentId: string, actorId: string): Promise<DocumentEntity>;
    constructor(documentRepository: Repository<DocumentEntity>, assessmentRepository: Repository<AssessmentEntity>, projectBranchRepository: Repository<ProjectBranchEntity>, assignmentRepository: Repository<AssignmentEntity>, auditService: AuditService, eventPublisher: DomainEventPublisher, notificationService: NotificationService, pushNotificationService: PushNotificationService, localStorageService: LocalStorageService, validationService: ValidationService);
    create(dto: CreateDocumentDto, userId: string): Promise<DocumentEntity>;
    findOne(id: string): Promise<DocumentEntity>;
    updateStatus(id: string, status: DocumentStatus, userId: string): Promise<DocumentEntity>;
    operationsOverview(filters?: {
        projectId?: string;
        status?: string;
        type?: string;
    }): Promise<any>;
    matchPdfsToBranches(projectId: string, auditDate: string, fileNames: string[]): Promise<{
        matches: Array<{
            fileName: string;
            projectBranchId: string;
            branchName: string;
            branchCode: string | null;
            matchedOn: 'CODE' | 'NAME';
        }>;
        unmatched: Array<{
            fileName: string;
            reason: string;
        }>;
        branchesWithoutFile: Array<{
            projectBranchId: string;
            branchName: string;
            branchCode: string | null;
        }>;
    }>;
    dispatchMany(documentIds: string[], userId: string): Promise<{
        dispatched: string[];
        failed: Array<{
            documentId: string;
            reason: string;
        }>;
    }>;
    private static readonly ASSAYER_VISIBLE_TYPES;
    private static readonly DISPATCHED_STATUSES;
    findDispatchedForAssayer(projectBranchId: string): Promise<{
        documents: DocumentEntity[];
        readiness: {
            state: 'READY' | 'PREPARING' | 'NONE';
            dispatchedCount: number;
            awaitingDispatchCount: number;
            message: string;
            lastDispatchedAt: Date | null;
        };
    }>;
    assertAssayerMayDownload(documentId: string, assayerId: string): Promise<void>;
    findByProjectBranch(projectBranchId: string): Promise<DocumentEntity[]>;
    findByAssessment(assessmentId: string): Promise<DocumentEntity[]>;
    findByProject(projectId: string): Promise<DocumentEntity[]>;
    dispatchDocument(id: string, userId: string, method?: DispatchMethod): Promise<DocumentEntity>;
    receiveDocument(id: string, userId: string): Promise<DocumentEntity>;
    private static readonly PIPELINE_ORDER;
    private static readonly DOCUMENT_TO_ASSESSMENT;
    syncAssessmentFromDocument(doc: DocumentEntity, userId: string): Promise<void>;
    findDataEntryQueue(): Promise<{
        assessmentId: string;
        project: string;
        branch: string;
        assayer: string | null;
        receivedAt: Date | null;
        daysPending: number | null;
        status: DocumentStatus;
        documents: DocumentEntity[];
    }[]>;
    markSentToExternalOcr(id: string, userId: string): Promise<DocumentEntity>;
    buildTransportTrail(doc: DocumentEntity): {
        stage: string;
        at: Date | null;
        by: string | null;
        method: DispatchMethod | null;
        done: boolean;
    }[];
    findAll(): Promise<DocumentEntity[]>;
    getDocumentStats(): Promise<{
        total: number;
        uploaded: number;
        dispatched: number;
        received: number;
    }>;
}
