import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { BullQueueManager } from './bull-queue-manager';
import { BullProcessor } from './bull-processor';

const QUEUE_NAME = 'background-jobs';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAME }),
  ],
  providers: [
    BullQueueManager,
    BullProcessor,
  ],
  exports: [BullQueueManager],
})
export class QueueModule {}
