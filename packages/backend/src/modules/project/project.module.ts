/**
 * FAPOMS — Project Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

import { ProjectService } from './project.service';
import { ImportJobService } from './import-job.service';
import { ImportJobWorker } from './import-job.worker';
import { IMPORT_QUEUE } from './import-job.constants';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectQueryService } from './project-query.service';
import { ProjectController } from './project.controller';
import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { AssessmentEntity } from './assessment.entity';
import { CallLogEntity } from './call-log.entity';
import { CallLogService } from './call-log.service';
import { CallLogController } from './call-log.controller';
import { ClientEntity } from '../client/client.entity';
import { UserEntity } from '../user/user.entity';
import { ZoneEntity } from '../zone/zone.entity';
import { PlatformModule } from '../platform/platform.module';
import { BranchModule } from '../branch/branch.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    // `BranchEntity` is registered here as well as in BranchModule because the Excel importer
    // resolves every branch code in a file with one `In(codes)` query rather than a
    // `BranchQueryService.findOneByCode` per row, and BranchModule exports its services but not
    // its repositories. Registering the same entity in two modules is how TypeORM expects a
    // repository to be shared.
    TypeOrmModule.forFeature([ProjectEntity, ProjectBranchEntity, AssessmentEntity, CallLogEntity, ClientEntity, UserEntity, ZoneEntity, BranchEntity]),
    /**
     * Spreadsheet imports run here, on a queue of this module's own.
     *
     * Not the shared `background-jobs` queue: that one adds named jobs to an unnamed processor,
     * so nothing added to it is ever picked up. See import-job.constants.ts.
     */
    BullModule.registerQueue({ name: IMPORT_QUEUE }),
    PlatformModule,
    BranchModule,
    NotificationsModule,
  ],
  controllers: [ProjectController, CallLogController],
  providers: [ProjectService, ProjectQueryService, CallLogService, ImportJobService, ImportJobWorker],
  exports: [ProjectService, ProjectQueryService, CallLogService, ImportJobService, TypeOrmModule],
})
export class ProjectModule {}
