/**
 * FAPOMS — Project Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProjectService } from './project.service';
import { ImportJobWorker } from './import-job.worker';
import { ImportModule } from '../import/import.module';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectQueryService } from './project-query.service';
import { ProjectController } from './project.controller';
import { BranchImportController } from './branch-import.controller';
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
import { GeoModule } from '../geo/geo.module';
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
    // The queue itself now lives in `ImportModule`, a leaf every feature module can import.
    // Registering it here made the queue reachable only from code that could already reach
    // `ProjectService` — which is why the Branches page grew its own inline importer instead.
    ImportModule,
    PlatformModule,
    BranchModule,
    NotificationsModule,
    // For `GeoPrecisionService.enqueueBackfill`: the importer hands its coarsely placed branches
    // to the precision worker the moment an import finishes. GeoModule is a leaf — it imports no
    // feature module — so this cannot close a cycle.
    GeoModule,
  ],
  controllers: [ProjectController, CallLogController, BranchImportController],
  providers: [ProjectService, ProjectQueryService, CallLogService, ImportJobWorker],
  exports: [ProjectService, ProjectQueryService, CallLogService, TypeOrmModule],
})
export class ProjectModule {}
