import { BadRequestException } from '@nestjs/common';
import { ValidationCaseEntity } from './validation-case.entity';
import { ValidationStatus } from '@fapoms/shared';
import {
  ValidationApprovedEvent,
  ValidationCorrectionRequestedEvent,
  ValidationSubmittedEvent,
} from '../../core/events/domain-events';

export class ValidationStateMachine {
  private static validateTransition(current: ValidationStatus, target: ValidationStatus) {
    const validPaths: Record<string, string[]> = {
      PENDING: [ValidationStatus.ASSIGNED, ValidationStatus.HUMAN_REVIEW],
      ASSIGNED: [ValidationStatus.OCR_PROCESSING, ValidationStatus.HUMAN_REVIEW, ValidationStatus.APPROVED],
      OCR_PROCESSING: [ValidationStatus.HUMAN_REVIEW],
      HUMAN_REVIEW: [
        ValidationStatus.APPROVED,
        ValidationStatus.CORRECTION_REQUIRED,
      ],
      CORRECTION_REQUIRED: [ValidationStatus.HUMAN_REVIEW],
      APPROVED: [ValidationStatus.SUBMITTED],
    };

    const allowed = validPaths[current] || [];
    if (!allowed.includes(target)) {
      throw new BadRequestException(`Invalid Transition: Cannot transition validation case from ${current} to ${target}.`);
    }
  }

  static approveValidation(
    validationCase: ValidationCaseEntity,
    userId: string,
    remarks?: string,
    notes?: string,
    ocrResult?: any,
  ): ValidationApprovedEvent {
    this.validateTransition(validationCase.status, ValidationStatus.APPROVED);
    const prev = validationCase.status;
    validationCase.status = ValidationStatus.APPROVED;
    validationCase.reviewedAt = new Date();
    if (remarks) validationCase.remarks = remarks;
    if (notes) validationCase.correctionNotes = notes;
    if (ocrResult) validationCase.ocrResult = ocrResult;
    return new ValidationApprovedEvent(validationCase.id, prev, validationCase.status, userId);
  }

  static requestCorrection(
    validationCase: ValidationCaseEntity,
    userId: string,
    remarks?: string,
    notes?: string,
    ocrResult?: any,
  ): ValidationCorrectionRequestedEvent {
    this.validateTransition(validationCase.status, ValidationStatus.CORRECTION_REQUIRED);
    const prev = validationCase.status;
    validationCase.status = ValidationStatus.CORRECTION_REQUIRED;
    if (remarks) validationCase.remarks = remarks;
    if (notes) validationCase.correctionNotes = notes;
    if (ocrResult) validationCase.ocrResult = ocrResult;
    return new ValidationCorrectionRequestedEvent(validationCase.id, prev, validationCase.status, userId);
  }

  static submitValidation(
    validationCase: ValidationCaseEntity,
    userId: string,
    remarks?: string,
    notes?: string,
    ocrResult?: any,
  ): ValidationSubmittedEvent {
    this.validateTransition(validationCase.status, ValidationStatus.SUBMITTED);
    const prev = validationCase.status;
    validationCase.status = ValidationStatus.SUBMITTED;
    if (remarks) validationCase.remarks = remarks;
    if (notes) validationCase.correctionNotes = notes;
    if (ocrResult) validationCase.ocrResult = ocrResult;
    return new ValidationSubmittedEvent(validationCase.id, prev, validationCase.status, userId);
  }
}
