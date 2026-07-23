import { ValidationCaseEntity } from './validation-case.entity';
import { ValidationApprovedEvent, ValidationCorrectionRequestedEvent, ValidationSubmittedEvent } from '../../core/events/domain-events';
export declare class ValidationStateMachine {
    private static validateTransition;
    static approveValidation(validationCase: ValidationCaseEntity, userId: string, remarks?: string, notes?: string, ocrResult?: any): ValidationApprovedEvent;
    static requestCorrection(validationCase: ValidationCaseEntity, userId: string, remarks?: string, notes?: string, ocrResult?: any): ValidationCorrectionRequestedEvent;
    static submitValidation(validationCase: ValidationCaseEntity, userId: string, remarks?: string, notes?: string, ocrResult?: any): ValidationSubmittedEvent;
}
