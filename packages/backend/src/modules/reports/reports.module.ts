import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssignmentModule } from '../assignment/assignment.module';
import { BillingEngineModule } from '../billing-engine/billing-engine.module';
import { PlanningModule } from '../planning/planning.module';
import { AssayerModule } from '../assayer/assayer.module';
import { ProjectModule } from '../project/project.module';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportJobsService } from './report-jobs.service';
import { ReportJobsWorker } from './report-jobs.worker';
import { ReportFileStore } from './report-file.store';
import { REPORT_QUEUE } from './report-jobs.contract';

@Module({
  imports: [
    /**
     * Exports get their own queue, separate from both 'planning-jobs' and the shared
     * 'background-jobs'.
     *
     * Separate from planning because the two block differently: a plan waits on Postgres and
     * leaves the event loop free, whereas `xlsx.write` is synchronous CPU that stops the process
     * dead — so their concurrency ceilings are answers to different questions and should not be
     * coupled. Separate from 'background-jobs' because that queue does not currently deliver
     * anything: `BullQueueManager` adds named jobs while `BullProcessor` declares a bare
     * `@Process()`, which in Bull matches only unnamed jobs. `ReportJobsWorker` names its
     * handlers from the same constants the enqueue side uses, so the two halves cannot disagree.
     *
     * The Redis connection comes from the single `BullModule.forRoot` in app.module.ts, so
     * registering a queue here needs no change outside this module.
     */
    BullModule.registerQueue({ name: REPORT_QUEUE }),
    TypeOrmModule.forFeature([AssayerEntity]),
    AssignmentModule,
    BillingEngineModule,
    PlanningModule,
    AssayerModule,
    ProjectModule,
  ],
  controllers: [ReportsController],
  // ReportFileStore injects the REDIS_CLIENT token from the @Global RedisClientModule, so it
  // needs no import here.
  providers: [ReportsService, ReportJobsService, ReportJobsWorker, ReportFileStore],
  exports: [ReportsService],
})
export class ReportsModule {}
