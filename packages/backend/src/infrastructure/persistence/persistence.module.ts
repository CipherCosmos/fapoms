import { Global, Module, OnModuleInit, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { UnitOfWork } from './unit-of-work';
import { TypeOrmUnitOfWork } from './typeorm-unit-of-work';
import { OutboxEntity } from './outbox.entity';
import { OutboxRelay } from './outbox.relay';
import { OutboxWorker } from './outbox.worker';
import { ensureRepeatableSchedules } from '../queue/repeatable-schedules';

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

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;

    // Non-blocking and non-fatal: a Redis that is down at boot must not stop the API from
    // starting over a cron registration. See ensureRepeatableSchedules.
    ensureRepeatableSchedules(this.queue, [{ name: 'drain', cron: PersistenceModule.CRON }], this.logger);
  }
}
