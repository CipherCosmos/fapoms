import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerGovernmentDocumentEntity } from './assayer-government-document.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AssayerLocationPingEntity } from './assayer-location-ping.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerOnboardingDocumentEntity } from './assayer-onboarding-document.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';
import { HrController } from './hr.controller';
import { HrWorkforceService } from './hr-workforce.service';
import { AssayerService } from './assayer.service';
import { LocationTrailService } from './location-trail.service';
import { AssayerController } from './assayer.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    // HR and ops learn when someone becomes assignable, and when credentials fall due.
    NotificationsModule,
    TypeOrmModule.forFeature([
      AssayerEntity,
      AssayerCommercialProfileEntity,
      WorkforceAttributeEntity,
      AssayerGovernmentDocumentEntity,
      AssayerDocumentEntity,
      AssayerRemarkEntity,
      AssayerActivityEntity,
      AssayerLocationPingEntity,
      AssayerReferenceEntity,
      AssayerClientEmpanelmentEntity,
      AssayerBackgroundCheckEntity,
      AssayerOnboardingDocumentEntity,
      AssayerImportIssueEntity,
    ]),
  ],
  controllers: [AssayerController, HrController],
  providers: [AssayerService, HrWorkforceService, LocationTrailService],
  exports: [AssayerService, HrWorkforceService, LocationTrailService, TypeOrmModule],
})
export class AssayerModule {}
