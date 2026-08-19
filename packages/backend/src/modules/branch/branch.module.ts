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
import { ZoneEntity } from '../zone/zone.entity';
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
  ],
  controllers: [BranchController],
  providers: [BranchService, BranchQueryService],
  exports: [BranchService, BranchQueryService],
})
export class BranchModule {}
