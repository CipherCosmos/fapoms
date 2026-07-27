import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { SlaScannerWorker } from './sla-scanner.worker';
import { AssignmentModule } from '../../modules/assignment/assignment.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'sla-scanner' }),
    AssignmentModule,
  ],
  providers: [SlaScannerWorker],
  exports: [SlaScannerWorker],
})
export class SlaScannerModule implements OnModuleInit {
  private readonly logger = new Logger(SlaScannerModule.name);

  constructor(@InjectQueue('sla-scanner') private readonly slaQueue: Queue) {}

  async onModuleInit() {
    if (process.env.NODE_ENV !== 'test') {
      await this.slaQueue.add(
        'scan',
        {},
        {
          repeat: { cron: '*/5 * * * *' },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      this.logger.log('SLA scanner repeatable job registered (every 5 minutes)');
    }
  }
}
