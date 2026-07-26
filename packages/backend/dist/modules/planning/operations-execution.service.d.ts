import { Repository } from 'typeorm';
import { OperationsExecutionGroupEntity } from './operations-execution-group.entity';
import { OperationsExecutionConversationEntity, NegotiationParticipant } from './operations-execution-conversation.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
export interface GroupPackageDto {
    assayerId: string;
    name?: string;
    assignmentIds: string[];
    logisticsPreferences?: any;
}
export declare class OperationsExecutionService {
    private readonly groupRepository;
    private readonly conversationRepository;
    private readonly assignmentRepository;
    constructor(groupRepository: Repository<OperationsExecutionGroupEntity>, conversationRepository: Repository<OperationsExecutionConversationEntity>, assignmentRepository: Repository<AssignmentEntity>);
    packageAssignments(dto: GroupPackageDto): Promise<OperationsExecutionGroupEntity>;
    postConversationMessage(groupId: string, sender: NegotiationParticipant, message: string, feeOverride?: number, dateOverride?: string): Promise<OperationsExecutionConversationEntity>;
    evaluateOperationalReadiness(groupId: string): Promise<{
        isReady: boolean;
        checks: Record<string, boolean>;
    }>;
}
