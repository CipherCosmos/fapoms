import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from './geo.entities';
import { PostGISRoutingProvider, OSRMRoutingProvider, RoutingService } from './routing.provider';
import { GeoController } from './geo.controller';
import { GeoSeedService } from './geo-seed.service';
import { GeoPrecisionService } from './geo-precision.service';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';

@Module({
  imports: [
    // Branch and assayer rows are registered here for the precision service alone. It reads and
    // rewrites only the geo columns, which is why it lives in the geo module rather than being
    // duplicated into both feature modules — the manual-pin rule has to have exactly one home.
    TypeOrmModule.forFeature([GeoStateEntity, GeoDistrictEntity, GeoCityEntity, BranchEntity, AssayerEntity]),
  ],
  controllers: [GeoController],
  providers: [PostGISRoutingProvider, OSRMRoutingProvider, RoutingService, GeoSeedService, GeoPrecisionService],
  exports: [RoutingService, GeoPrecisionService, TypeOrmModule],
})
export class GeoModule {}
