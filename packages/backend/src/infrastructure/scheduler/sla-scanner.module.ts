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

  private static readonly CRON = '*/15 * * * *';

  async onModuleInit() {
    if (process.env.NODE_ENV !== 'test') {
      // Bull tracks repeatable jobs by their cron string, so simply changing the cron
      // here (e.g. 5min -> 15min) registers an ADDITIONAL repeatable job rather than
      // replacing the old one — any previously-deployed schedule keeps firing forever
      // alongside the new one. Remove every other stale "scan" repeatable first so this
      // queue always converges to exactly one active schedule, regardless of what ran before.
      const existing = await this.slaQueue.getRepeatableJobs();
      for (const job of existing) {
        if (job.name === 'scan' && job.cron !== SlaScannerModule.CRON) {
          await this.slaQueue.removeRepeatableByKey(job.key);
          this.logger.warn(`Removed stale SLA scanner schedule: ${job.cron}`);
        }
      }

      await this.slaQueue.add(
        'scan',
        {},
        {
          repeat: { cron: SlaScannerModule.CRON },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      this.logger.log('SLA scanner repeatable job registered (every 15 minutes)');
    }
  }
}
