import { Test, TestingModule } from '@nestjs/testing';
import { OperationsAntiCorruptionLayer } from './operations-acl.adapter';
import { AssignmentEntity } from '../assignment/assignment.entity';

describe('OperationsAntiCorruptionLayer', () => {
  let acl: OperationsAntiCorruptionLayer;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OperationsAntiCorruptionLayer],
    }).compile();

    acl = module.get<OperationsAntiCorruptionLayer>(OperationsAntiCorruptionLayer);
  });

  it('should map AssignmentEntity to WorkAllocation contract structure', () => {
    const mockAssignment = {
      id: 'asn-1',
      assayerId: 'as-1',
      agreedFee: 2500,
      status: 'SCHEDULED',
    } as AssignmentEntity;

    const allocation = acl.mapAssignmentToWorkAllocation(mockAssignment);
    expect(allocation.allocationId).toBe('asn-1');
    expect(allocation.assayerId).toBe('as-1');
    expect(allocation.agreedFee).toBe(2500);
    expect(allocation.status).toBe('SCHEDULED');
  });
});
