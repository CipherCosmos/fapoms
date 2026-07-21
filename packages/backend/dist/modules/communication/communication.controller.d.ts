import { CommunicationService, CreateCommunicationDto } from './communication.service';
import { CommunicationType } from '@fapoms/shared';
declare class CreateCommunicationRequestDto implements CreateCommunicationDto {
    assignmentId: string;
    type: CommunicationType;
    content: string;
    recipientRef?: string;
}
export declare class CommunicationController {
    private readonly communicationService;
    constructor(communicationService: CommunicationService);
    create(dto: CreateCommunicationRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./communication.entity").CommunicationEntity;
    }>;
    findByAssignment(assignmentId: string): Promise<{
        success: boolean;
        data: import("./communication.entity").CommunicationEntity[];
    }>;
}
export {};
