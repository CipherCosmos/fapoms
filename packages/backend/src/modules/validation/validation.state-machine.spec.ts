import { ValidationStateMachine } from './validation.state-machine';
import { ValidationCaseEntity } from './validation-case.entity';
import { ValidationStatus } from '@fapoms/shared';
import { BadRequestException } from '@nestjs/common';

describe('ValidationStateMachine', () => {
  let validationCase: ValidationCaseEntity;

  beforeEach(() => {
    validationCase = {
      id: 'val-1',
      status: ValidationStatus.HUMAN_REVIEW,
    } as ValidationCaseEntity;
  });

  it('should transition from HUMAN_REVIEW to APPROVED', () => {
    const event = ValidationStateMachine.approveValidation(validationCase, 'user-1', 'Looks good');
    expect(validationCase.status).toBe(ValidationStatus.APPROVED);
    expect(event.previousState).toBe(ValidationStatus.HUMAN_REVIEW);
    expect(event.newState).toBe(ValidationStatus.APPROVED);
  });

  it('should throw BadRequestException on invalid transition', () => {
    validationCase.status = ValidationStatus.PENDING;
    expect(() => {
      ValidationStateMachine.approveValidation(validationCase, 'user-1');
    }).toThrow(BadRequestException);
  });
});
