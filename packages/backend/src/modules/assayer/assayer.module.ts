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
import { AssayerIdempotencyEntity } from './assayer-idempotency.entity';
import { AssayerDocumentVersionEntity } from './assayer-document-version.entity';
import { AssayerInterviewEntity } from './assayer-interview.entity';
import { AssayerOnboardingApprovalEntity } from './assayer-onboarding-approval.entity';
import { OnboardingApprovalService } from './onboarding-approval.service';
import { OnboardingApprovalController } from './onboarding-approval.controller';
import { ComplianceStandingService } from './compliance-standing.service';
import { ComplianceReviewService } from './compliance-review.service';
import { ComplianceController } from './compliance.controller';
import { IdCardService } from './id-card.service';
import { MyIdCardController, PublicIdCardController } from './id-card.controller';
import { AssayerApplicationEntity } from './assayer-application.entity';
import { AssayerApplicationDocumentEntity } from './assayer-application-document.entity';
import { QualificationScoreService } from './qualification-score.service';
import { ClientEntity } from '../client/client.entity';
import { RosterImportService } from './roster-import.service';
import { RosterImportJob } from './roster-import.job';
import { RosterRecordsService } from './roster-records.service';
import { DataIntegrityService } from './data-integrity.service';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { HrController } from './hr.controller';
import { HrWorkforceService } from './hr-workforce.service';
import { AssayerService } from './assayer.service';
import { LocationTrailService } from './location-trail.service';
import { AssayerController } from './assayer.controller';
import { RosterQueryService } from './roster-query.service';
import { AssayerSelfServiceController } from './assayer-self-service.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { GeoModule } from '../geo/geo.module';
import { RegistrationApplicationService } from './registration-application.service';
import { AssayerInterviewService } from './assayer-interview.service';
import { AssayerInterviewController } from './assayer-interview.controller';
import { PublicRegistrationController } from './public-registration.controller';
import { HrApplicationsController } from './hr-applications.controller';
import { BullModule } from '@nestjs/bull';
import { WorkforceBulkJobsService } from './workforce-bulk-jobs.service';
import { WorkforceBulkJobsWorker } from './workforce-bulk-jobs.worker';
import { WORKFORCE_BULK_QUEUE } from './workforce-bulk-jobs.contract';

@Module({
  imports: [
    // HR and ops learn when someone becomes assignable, and when credentials fall due.
    NotificationsModule,
    StorageModule,
    // For `GeoPrecisionService.enqueueBackfill` — the roster importer hands freshly imported
    // appraisers to the precision worker instead of leaving them for the nightly sweep.
    // Same hand-off the branch importer uses; GeoModule is a leaf, no cycle.
    GeoModule,
    // Bulk "issue app access" and "notify" over a roster selection — too long for a request.
    BullModule.registerQueue({
      name: WORKFORCE_BULK_QUEUE,
      /*
        A run whose worker died mid-way (deploy, out-of-memory, lost lock) is FAILED, not restarted.
        Bull's default re-runs a stalled job once from the top, and a credential run restarted from
        the top re-rotates every password it had already emailed. `attempts: 1` alone does not stop
        that — stalled recovery is a separate counter.
      */
      settings: { maxStalledCount: 0 },
    }),
    TypeOrmModule.forFeature([
      AssayerEntity,
      AssayerCommercialProfileEntity,
      WorkforceAttributeEntity,
      AssayerDocumentEntity,
      AssayerDocumentVersionEntity,
      AssayerIdempotencyEntity,
      AssayerRemarkEntity,
      AssayerActivityEntity,
      AssayerLocationPingEntity,
      AssayerReferenceEntity,
      AssayerClientEmpanelmentEntity,
      AssayerBackgroundCheckEntity,
      AssayerImportIssueEntity,
      AssayerScoreOverrideEntity,
      AssayerInterviewEntity,
      AssayerOnboardingApprovalEntity,
      AssayerApplicationEntity,
      AssayerApplicationDocumentEntity,
      ClientEntity,
    ]),
  ],
  // `AssayerSelfServiceController` is listed after `AssayerController` on purpose. Nest matches
  // routes in registration order, and the two share the `assayers` prefix; keeping the
  // long-established routes first means a new self-service path can never shadow one of them.
  controllers: [
    AssayerController, HrController, AssayerSelfServiceController,
    AssayerInterviewController, PublicRegistrationController, HrApplicationsController, OnboardingApprovalController, ComplianceController, MyIdCardController, PublicIdCardController,
  ],
  providers: [
    AssayerService, HrWorkforceService, LocationTrailService, RosterImportService,
    // The roster import's background job (`ROSTER_IMPORT`): registered at init, run on the shared
    // tracked-jobs queue — see roster-import.job.ts. BackgroundJobsModule is global.
    RosterImportJob,
    RosterRecordsService, QualificationScoreService, DataIntegrityService, RosterQueryService,
    RegistrationApplicationService, AssayerInterviewService, OnboardingApprovalService, ComplianceStandingService, ComplianceReviewService, IdCardService, WorkforceBulkJobsService, WorkforceBulkJobsWorker,
  ],
  exports: [
    AssayerService, HrWorkforceService, LocationTrailService, RosterImportService, RosterRecordsService,
    QualificationScoreService, DataIntegrityService, RosterQueryService, RegistrationApplicationService,
    ComplianceStandingService,
    TypeOrmModule,
  ],
})
export class AssayerModule {}
