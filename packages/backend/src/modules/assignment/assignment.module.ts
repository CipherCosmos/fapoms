import { Module, forwardRef } from '@nestjs/common';
import { DocumentModule } from '../document/document.module';
import { PricingModule } from '../pricing/pricing.module';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssignmentService } from './assignment.service';
import { OperationsInboxService } from './operations-inbox.service';
import { AssignmentController } from './assignment.controller';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentCommentEntity } from './assignment-comment.entity';
import { AssignmentReassignmentEntity } from './assignment-reassignment.entity';
import { HolidayModule } from '../holiday/holiday.module';
import { PlatformModule } from '../platform/platform.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssayerModule } from '../assayer/assayer.module';
import { ProjectModule } from '../project/project.module';
import { PlanningModule } from '../planning/planning.module';

import { GeoModule } from '../geo/geo.module';
import { ValidationModule } from '../validation/validation.module';
import { BillingEngineModule } from '../billing-engine/billing-engine.module';

import { OperationalIntegrityService } from './operational-integrity.service';
import { AssignmentTargetEligibilityService } from './assignment-target-eligibility.policy';

@Module({
  imports: [
    TypeOrmModule.forFeature([AssignmentEntity, AssignmentCommentEntity, AssignmentReassignmentEntity]),
    HolidayModule,
    PlatformModule,
    NotificationsModule,
    AssayerModule,
    ProjectModule,
    GeoModule,
    ValidationModule,
    PricingModule,
    BillingEngineModule,
    forwardRef(() => DocumentModule),
    forwardRef(() => PlanningModule),
  ],
  controllers: [AssignmentController],
  providers: [AssignmentService, OperationsInboxService, OperationalIntegrityService, AssignmentTargetEligibilityService],
  exports: [AssignmentService, OperationsInboxService, OperationalIntegrityService, AssignmentTargetEligibilityService],
})
export class AssignmentModule {}

