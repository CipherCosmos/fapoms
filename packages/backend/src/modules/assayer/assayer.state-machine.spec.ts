import { AssayerStateMachine } from './assayer.state-machine';
import { AssayerEntity } from './assayer.entity';
import { AssayerLifecycleStatus } from '@fapoms/shared';
import { BadRequestException } from '@nestjs/common';

describe('AssayerStateMachine', () => {
  let assayer: AssayerEntity;

  beforeEach(() => {
    assayer = {
      id: 'asr-1',
      lifecycleStatus: AssayerLifecycleStatus.INVITED,
      status: 'INACTIVE',
      isActive: true,
    } as AssayerEntity;
  });

  it('should transition from INVITED to DOCUMENT_VERIFICATION', () => {
    const event = AssayerStateMachine.verifyDocuments(assayer, 'user-1');
    expect(assayer.lifecycleStatus).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
    expect(event.previousState).toBe(AssayerLifecycleStatus.INVITED);
    expect(event.newState).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
  });

  it('should throw BadRequestException on invalid transition', () => {
    expect(() => {
      AssayerStateMachine.activate(assayer, 'user-1');
    }).toThrow(BadRequestException);
  });
});
