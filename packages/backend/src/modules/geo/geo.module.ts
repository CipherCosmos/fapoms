import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from './geo.entities';
import { PostGISRoutingProvider, OSRMRoutingProvider, RoutingService } from './routing.provider';

@Module({
  imports: [
    TypeOrmModule.forFeature([GeoStateEntity, GeoDistrictEntity, GeoCityEntity]),
  ],
  providers: [PostGISRoutingProvider, OSRMRoutingProvider, RoutingService],
  exports: [RoutingService, TypeOrmModule],
})
export class GeoModule {}
