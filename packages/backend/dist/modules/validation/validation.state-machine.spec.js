"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const validation_state_machine_1 = require("./validation.state-machine");
const shared_1 = require("@fapoms/shared");
const common_1 = require("@nestjs/common");
describe('ValidationStateMachine', () => {
    let validationCase;
    beforeEach(() => {
        validationCase = {
            id: 'val-1',
            status: shared_1.ValidationStatus.HUMAN_REVIEW,
        };
    });
    it('should transition from HUMAN_REVIEW to APPROVED', () => {
        const event = validation_state_machine_1.ValidationStateMachine.approveValidation(validationCase, 'user-1', 'Looks good');
        expect(validationCase.status).toBe(shared_1.ValidationStatus.APPROVED);
        expect(event.previousState).toBe(shared_1.ValidationStatus.HUMAN_REVIEW);
        expect(event.newState).toBe(shared_1.ValidationStatus.APPROVED);
    });
    it('should throw BadRequestException on invalid transition', () => {
        validationCase.status = shared_1.ValidationStatus.PENDING;
        expect(() => {
            validation_state_machine_1.ValidationStateMachine.approveValidation(validationCase, 'user-1');
        }).toThrow(common_1.BadRequestException);
    });
});
//# sourceMappingURL=validation.state-machine.spec.js.map