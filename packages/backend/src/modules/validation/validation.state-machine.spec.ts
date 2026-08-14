import { ValidationStateMachine } from './validation.state-machine';
import { ValidationCaseEntity } from './validation-case.entity';
import { ValidationStatus, VALIDATION_TRANSITIONS, toWorkflowTransitions } from '@fapoms/shared';
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

  describe('one table, not three', () => {
    it('refuses to approve a case nobody ever reviewed', () => {
      // The hole this closed. The machine's private table allowed ASSIGNED -> APPROVED, so a
      // case could go from "a reviewer was named" straight to approved — no OCR, no human
      // looking at it — and validation approval is what releases work downstream. There is no
      // auto-approve path, so the only way here was a person approving unreviewed work.
      expect(AssignmentlessCase(ValidationStatus.ASSIGNED)).toBe(false);
    });

    it('still allows the routes real work takes', () => {
      // Hand-back from data entry goes straight to review (getOrAdvanceForHandBack), and a case
      // with nothing to scan skips OCR. The shared table used to forbid both while the machine
      // allowed them, so the documented pipeline and the running system disagreed about the
      // most common route through validation.
      expect(AssignmentlessCase(ValidationStatus.PENDING, ValidationStatus.HUMAN_REVIEW)).toBe(true);
      expect(AssignmentlessCase(ValidationStatus.ASSIGNED, ValidationStatus.HUMAN_REVIEW)).toBe(true);
    });

    it('matches the table the workflow engine gates on', () => {
      // The engine checks its registration BEFORE the machine runs, so any edge the two disagree
      // on is decided by the engine — silently. Both now come from VALIDATION_TRANSITIONS.
      const registered = new Set(
        toWorkflowTransitions(VALIDATION_TRANSITIONS).flatMap(({ from, to }) =>
          from.map((f) => `${f}->${to}`),
        ),
      );
      for (const from of Object.values(ValidationStatus)) {
        for (const to of Object.values(ValidationStatus)) {
          expect(ValidationStateMachine.canTransition(from, to))
            .toBe(registered.has(`${from}->${to}`));
        }
      }
    });
  });
});

/** Helper: may a case in `from` move to `to` (default APPROVED)? */
function AssignmentlessCase(from: ValidationStatus, to = ValidationStatus.APPROVED): boolean {
  return ValidationStateMachine.canTransition(from, to);
}
