"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const operations_acl_adapter_1 = require("./operations-acl.adapter");
describe('OperationsAntiCorruptionLayer', () => {
    let acl;
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [operations_acl_adapter_1.OperationsAntiCorruptionLayer],
        }).compile();
        acl = module.get(operations_acl_adapter_1.OperationsAntiCorruptionLayer);
    });
    it('should map AssignmentEntity to WorkAllocation contract structure', () => {
        const mockAssignment = {
            id: 'asn-1',
            assayerId: 'as-1',
            agreedFee: 2500,
            status: 'SCHEDULED',
        };
        const allocation = acl.mapAssignmentToWorkAllocation(mockAssignment);
        expect(allocation.allocationId).toBe('asn-1');
        expect(allocation.assayerId).toBe('as-1');
        expect(allocation.agreedFee).toBe(2500);
        expect(allocation.status).toBe('SCHEDULED');
    });
});
//# sourceMappingURL=operations-acl.adapter.spec.js.map