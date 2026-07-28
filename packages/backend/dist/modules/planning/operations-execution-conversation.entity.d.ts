import { BaseEntity } from '../../core/entities/base.entity';
export declare enum NegotiationParticipant {
    OPERATIONS = "OPERATIONS",
    ASSAYER = "ASSAYER",
    SYSTEM = "SYSTEM"
}
export declare class OperationsExecutionConversationEntity extends BaseEntity {
    groupId: string;
    sender: NegotiationParticipant;
    message: string;
    proposedFeeOverride: number | null;
    proposedDateOverride: string | null;
}
