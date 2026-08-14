import { BadRequestException } from '@nestjs/common';
import { ValidationCaseEntity } from './validation-case.entity';
import { ValidationStatus, VALIDATION_TRANSITIONS, isValidTransition } from '@fapoms/shared';
import {
  ValidationApprovedEvent,
  ValidationCorrectionRequestedEvent,
  ValidationSubmittedEvent,
  ValidationMovedToReviewEvent,
} from '../../core/events/domain-events';

export class ValidationStateMachine {
  /**
   * Reads the shared table rather than a private copy of it.
   *
   * The copy that used to live here disagreed with `VALIDATION_TRANSITIONS` in three places —
   * see that table for what was reconciled and why. Two tables for one enum meant the answer to
   * "may this case move" depended on which code path asked.
   */
  private static validateTransition(current: ValidationStatus, target: ValidationStatus) {
    if (!isValidTransition(VALIDATION_TRANSITIONS, current, target)) {
      throw new BadRequestException(
        `Invalid Transition: Cannot transition validation case from ${current} to ${target}.`,
      );
    }
  }

  /** The same question, answered rather than thrown — for callers that report refusals softly. */
  static canTransition(current: ValidationStatus, target: ValidationStatus): boolean {
    return isValidTransition(VALIDATION_TRANSITIONS, current, target);
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

  static moveToReview(
    validationCase: ValidationCaseEntity,
    userId: string,
    remarks?: string,
  ): ValidationMovedToReviewEvent {
    this.validateTransition(validationCase.status, ValidationStatus.HUMAN_REVIEW);
    const prev = validationCase.status;
    validationCase.status = ValidationStatus.HUMAN_REVIEW;
    if (remarks) validationCase.remarks = remarks;
    return new ValidationMovedToReviewEvent(validationCase.id, prev, validationCase.status, userId);
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
