import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { BackgroundJobEntity } from './background-job.entity';
import { BackgroundJobRegistry } from './background-job.registry';
import { BackgroundJobStore } from './background-job.store';
import { BackgroundJobsService } from './background-jobs.service';
import { BackgroundJobRunner } from './background-job.runner';
import { BackgroundJobsWorker } from './background-jobs.worker';
import { BackgroundJobRecovery } from './background-jobs.recovery';
import { BackgroundJobsController } from './background-jobs.controller';
import { BackgroundJobTracker } from './background-job.tracker';
import { BullQueueResolver } from './bull-queue.resolver';
import { TRACKED_JOBS_QUEUE } from './background-jobs.contract';

/**
 * FAPOMS — the one mechanism for work that outlives its request (see `background-jobs.contract.ts`
 * for how a feature registers a kind, and `background-jobs.service.ts` for the lifecycle).
 *
 * Global, so any feature module can inject `BackgroundJobRegistry` to register its kinds and
 * `BackgroundJobsService` to start them from its own routes, without importing this module and
 * without this module importing any feature. The dependency only ever points one way: features know
 * about the foundation, the foundation knows about no feature.
 *
 * `DomainEventPublisher` (PlatformModule) is global already; `StorageModule` is imported for the
 * `StorageEngine` token.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([BackgroundJobEntity]),
    BullModule.registerQueue({ name: TRACKED_JOBS_QUEUE }),
    StorageModule,
  ],
  controllers: [BackgroundJobsController],
  providers: [
    BackgroundJobRegistry,
    BackgroundJobStore,
    BackgroundJobsService,
    BackgroundJobRunner,
    BackgroundJobsWorker,
    BackgroundJobRecovery,
    BackgroundJobTracker,
    BullQueueResolver,
  ],
  exports: [BackgroundJobRegistry, BackgroundJobsService, BackgroundJobTracker],
})
export class BackgroundJobsModule {}
