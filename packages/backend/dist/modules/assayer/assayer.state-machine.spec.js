"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assayer_state_machine_1 = require("./assayer.state-machine");
const shared_1 = require("@fapoms/shared");
const common_1 = require("@nestjs/common");
describe('AssayerStateMachine', () => {
    let assayer;
    beforeEach(() => {
        assayer = {
            id: 'asr-1',
            lifecycleStatus: shared_1.AssayerLifecycleStatus.INVITED,
            status: 'INACTIVE',
            isActive: true,
        };
    });
    it('should transition from INVITED to DOCUMENT_VERIFICATION', () => {
        const event = assayer_state_machine_1.AssayerStateMachine.verifyDocuments(assayer, 'user-1');
        expect(assayer.lifecycleStatus).toBe(shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
        expect(event.previousState).toBe(shared_1.AssayerLifecycleStatus.INVITED);
        expect(event.newState).toBe(shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
    });
    it('should throw BadRequestException on invalid transition', () => {
        expect(() => {
            assayer_state_machine_1.AssayerStateMachine.activate(assayer, 'user-1');
        }).toThrow(common_1.BadRequestException);
    });
});
//# sourceMappingURL=assayer.state-machine.spec.js.map