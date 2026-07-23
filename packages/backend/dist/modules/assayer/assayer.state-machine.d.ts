import { AssayerEntity } from './assayer.entity';
import { AssayerDocumentVerificationStartedEvent, AssayerBackgroundCheckInitiatedEvent, AssayerTrainingStartedEvent, AssayerActivatedEvent, AssayerOnLeaveEvent, AssayerSuspendedEvent, AssayerDeactivatedEvent, AssayerResignedEvent, AssayerTerminatedEvent, AssayerArchivedEvent } from '../../core/events/domain-events';
export declare class AssayerStateMachine {
    private static validateTransition;
    private static applyTransition;
    static verifyDocuments(assayer: AssayerEntity, userId: string): AssayerDocumentVerificationStartedEvent;
    static initiateBackgroundCheck(assayer: AssayerEntity, userId: string): AssayerBackgroundCheckInitiatedEvent;
    static startTraining(assayer: AssayerEntity, userId: string): AssayerTrainingStartedEvent;
    static activate(assayer: AssayerEntity, userId: string): AssayerActivatedEvent;
    static putOnLeave(assayer: AssayerEntity, userId: string): AssayerOnLeaveEvent;
    static suspend(assayer: AssayerEntity, userId: string): AssayerSuspendedEvent;
    static deactivate(assayer: AssayerEntity, userId: string): AssayerDeactivatedEvent;
    static acceptResignation(assayer: AssayerEntity, userId: string): AssayerResignedEvent;
    static terminate(assayer: AssayerEntity, userId: string): AssayerTerminatedEvent;
    static archive(assayer: AssayerEntity, userId: string): AssayerArchivedEvent;
}
