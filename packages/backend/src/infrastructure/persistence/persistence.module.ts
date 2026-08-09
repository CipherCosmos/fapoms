import { Global, Module, OnModuleInit, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { UnitOfWork } from './unit-of-work';
import { TypeOrmUnitOfWork } from './typeorm-unit-of-work';
import { OutboxEntity } from './outbox.entity';
import { OutboxRelay } from './outbox.relay';
import { OutboxWorker } from './outbox.worker';

/**
 * Global so a service can take a transaction boundary without its module having to import
 * anything — the same reasoning that makes `AuditModule` global. A boundary that is awkward to
 * reach for is one people work around, and the workaround here is `DataSource.transaction`.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxEntity]), BullModule.registerQueue({ name: 'outbox' })],
  providers: [
    { provide: UnitOfWork, useClass: TypeOrmUnitOfWork },
    OutboxRelay,
    OutboxWorker,
  ],
  exports: [UnitOfWork],
})
export class PersistenceModule implements OnModuleInit {
  private readonly logger = new Logger(PersistenceModule.name);

  /**
   * One minute is the floor Bull's cron scheduling allows, and it is the recovery latency for
   * an event the in-process publish missed — not for the common case, which the fast path
   * delivers synchronously.
   */
  private static readonly CRON = '* * * * *';

  constructor(@InjectQueue('outbox') private readonly queue: Queue) {}

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;

    // Bull keys repeatable jobs by cron string, so changing CRON registers an additional
    // schedule rather than replacing the old one and both fire forever. Converge to one.
    const existing = await this.queue.getRepeatableJobs();
    for (const job of existing) {
      if (job.name === 'drain' && job.cron !== PersistenceModule.CRON) {
        await this.queue.removeRepeatableByKey(job.key);
        this.logger.warn(`Removed stale outbox relay schedule: ${job.cron}`);
      }
    }

    await this.queue.add(
      'drain',
      {},
      { repeat: { cron: PersistenceModule.CRON }, removeOnComplete: true, removeOnFail: false },
    );
    this.logger.log('Outbox relay repeatable job registered (every minute)');
  }
}
