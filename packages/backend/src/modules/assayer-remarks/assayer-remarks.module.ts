import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssayerRemarkEntity } from '../assayer/assayer-remark.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssayerActivityEntity } from '../assayer/assayer-activity.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssayerModule } from '../assayer/assayer.module';
import { AssayerRemarksService } from './assayer-remarks.service';
import { AssayerRemarksController } from './assayer-remarks.controller';

/**
 * Staff remarks about assayers, and the batch loader the recommendation engine scores from.
 *
 * The entity lives in modules/assayer because the table did — see the note on
 * AssayerRemarkEntity. Everything that decides what a remark means (who may write one, what a
 * rating is, how it decays into a score) lives here. PlanningModule imports this module for
 * `AssayerRemarksService.loadScoringWindow`; nothing here depends on planning, so there is no
 * cycle to guard against.
 *
 * AuditService comes from the global AuditModule; AssayerModule is imported for
 * `AssayerService.recomputeAverageRating` (the profile's cached 1–5 figure derived from these
 * rows). AssayerModule imports nothing that leads back here, so there is no cycle.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AssayerRemarkEntity, AssayerEntity, AssignmentEntity, AssayerActivityEntity]),
    AssayerModule,
  ],
  controllers: [AssayerRemarksController],
  providers: [AssayerRemarksService],
  exports: [AssayerRemarksService],
})
export class AssayerRemarksModule {}
