import { Injectable } from '@nestjs/common';
import { WorkAllocation } from './operations-domain-contracts';
import { AssignmentEntity } from '../assignment/assignment.entity';

@Injectable()
export class OperationsAntiCorruptionLayer {
  mapAssignmentToWorkAllocation(entity: AssignmentEntity): WorkAllocation {
    return {
      allocationId: entity.id,
      assayerId: entity.assayerId,
      agreedFee: Number(entity.agreedFee) || 0,
      status: entity.status,
    };
  }
}
