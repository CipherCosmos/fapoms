import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BranchEntity } from './branch.entity';
import { BranchContactEntity } from './branch-contact.entity';
import { BranchDocumentEntity } from './branch-document.entity';
import { BranchService } from './branch.service';
import { BranchQueryService } from './branch-query.service';
import { BranchController } from './branch.controller';
import { ClientModule } from '../client/client.module';
import { GeoModule } from '../geo/geo.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssayerModule } from '../assayer/assayer.module';
import { ZoneEntity } from '../zone/zone.entity';
import { DayTravelModule } from '../assignment/day-travel.module';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../geo/geo.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BranchEntity,
      BranchContactEntity,
      BranchDocumentEntity,
      ZoneEntity,
      GeoStateEntity,
      GeoDistrictEntity,
      GeoCityEntity,
    ]),
    ClientModule,
    // For `GeoPrecisionService.enqueueBackfill` — the bulk importer hands coarsely placed rows to
    // the precision worker. GeoModule is a leaf; no cycle.
    GeoModule,
    // Branch deactivation cancels open work and tells the assayer holding it (2026-09-24).
    // NotificationsModule imports nothing that imports this module; no cycle.
    NotificationsModule,
    // For switching an assayer's location sharing off when a closure cancels their last job.
    // AssayerModule imports neither this module nor anything that does, so this is no cycle.
    AssayerModule,
    // Re-deciding the assayer's day after a closure cancels the job that carried its travel.
    // A leaf (pricing + notifications only); no cycle.
    DayTravelModule,
  ],
  controllers: [BranchController],
  providers: [BranchService, BranchQueryService],
  exports: [BranchService, BranchQueryService],
})
export class BranchModule {}
