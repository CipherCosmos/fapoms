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
import { ClientEntity } from '../client/client.entity';
import { RosterImportService } from './roster-import.service';
import { RosterRecordsService } from './roster-records.service';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { HrController } from './hr.controller';
import { HrWorkforceService } from './hr-workforce.service';
import { AssayerService } from './assayer.service';
import { LocationTrailService } from './location-trail.service';
import { AssayerController } from './assayer.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { GeoModule } from '../geo/geo.module';

@Module({
  imports: [
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
      ClientEntity,
    ]),
  ],
  controllers: [AssayerController, HrController],
  providers: [AssayerService, HrWorkforceService, LocationTrailService, RosterImportService, RosterRecordsService],
  exports: [AssayerService, HrWorkforceService, LocationTrailService, RosterImportService, RosterRecordsService, TypeOrmModule],
})
export class AssayerModule {}
