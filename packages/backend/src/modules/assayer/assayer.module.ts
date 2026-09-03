import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AssayerLocationPingEntity } from './assayer-location-ping.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';
import { AssayerScoreOverrideEntity } from './assayer-score-override.entity';
import { QualificationScoreService } from './qualification-score.service';
import { ClientEntity } from '../client/client.entity';
import { RosterImportService } from './roster-import.service';
import { RosterImportWorker } from './roster-import.worker';
import { ImportModule } from '../import/import.module';
import { RosterRecordsService } from './roster-records.service';
import { DataIntegrityService } from './data-integrity.service';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { HrController } from './hr.controller';
import { HrWorkforceService } from './hr-workforce.service';
import { AssayerService } from './assayer.service';
import { LocationTrailService } from './location-trail.service';
import { AssayerController } from './assayer.controller';
import { AssayerSelfServiceController } from './assayer-self-service.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { GeoModule } from '../geo/geo.module';

@Module({
  imports: [
    // The shared import queue — a leaf module, so this cannot introduce a cycle. Roster imports
    // are queued for the same reason branch imports are: they are long, and the request path
    // was being kept open for up to fifteen minutes to hold one.
    ImportModule,
    // HR and ops learn when someone becomes assignable, and when credentials fall due.
    NotificationsModule,
    StorageModule,
    // For `GeoPrecisionService.enqueueBackfill` — the roster importer hands freshly imported
    // appraisers to the precision worker instead of leaving them for the nightly sweep.
    // Same hand-off the branch importer uses; GeoModule is a leaf, no cycle.
    GeoModule,
    TypeOrmModule.forFeature([
      AssayerEntity,
      AssayerCommercialProfileEntity,
      WorkforceAttributeEntity,
      AssayerDocumentEntity,
      AssayerRemarkEntity,
      AssayerActivityEntity,
      AssayerLocationPingEntity,
      AssayerReferenceEntity,
      AssayerClientEmpanelmentEntity,
      AssayerBackgroundCheckEntity,
      AssayerImportIssueEntity,
      AssayerScoreOverrideEntity,
      ClientEntity,
    ]),
  ],
  // `AssayerSelfServiceController` is listed after `AssayerController` on purpose. Nest matches
  // routes in registration order, and the two share the `assayers` prefix; keeping the
  // long-established routes first means a new self-service path can never shadow one of them.
  controllers: [AssayerController, HrController, AssayerSelfServiceController],
  providers: [AssayerService, HrWorkforceService, LocationTrailService, RosterImportService, RosterImportWorker, RosterRecordsService, QualificationScoreService, DataIntegrityService],
  exports: [AssayerService, HrWorkforceService, LocationTrailService, RosterImportService, RosterRecordsService, QualificationScoreService, DataIntegrityService, TypeOrmModule],
})
export class AssayerModule {}
