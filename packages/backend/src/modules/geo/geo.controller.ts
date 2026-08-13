import { Controller, Get, Post, Param, Body, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString, IsArray, ValidateNested, IsBoolean, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoutingService, DestinationCoords } from './routing.provider';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from './geo.entities';
import { autocompleteIndia } from './india-autocomplete.helper';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, AnyAuthenticated } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { GeoPrecisionService, GeoTarget } from './geo-precision.service';

/** Geo reference data is effectively static (seeded once), so a long TTL is safe. */
const GEO_CACHE_TTL_SECONDS = 3600;

/** The two things that carry a coordinate. Validated rather than cast — this reaches a repository. */
function assertTarget(value: string): GeoTarget {
  if (value === 'branch' || value === 'assayer') return value;
  throw new BadRequestException(`Unknown target "${value}". Use "branch" or "assayer".`);
}

export class BackfillDto {
  @IsOptional()
  @IsNumber()
  limit?: number;
}

export class PinCoordinateDto {
  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @IsNumber()
  @IsNotEmpty()
  longitude: number;

  /** What the person pinned it to ("front door, next to the ATM"), kept for whoever checks later. */
  @IsOptional()
  @IsString()
  note?: string;
}

export class CoordinateDto {
  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @IsNumber()
  @IsNotEmpty()
  longitude: number;
}

export class DestinationDto extends CoordinateDto implements DestinationCoords {
  @IsString()
  @IsNotEmpty()
  id: string;
}

export class OptimizeRouteDto {
  @ValidateNested()
  @Type(() => CoordinateDto)
  @IsNotEmpty()
  origin: CoordinateDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DestinationDto)
  @IsNotEmpty()
  destinations: DestinationDto[];

  @IsOptional()
  @IsBoolean()
  roundTrip?: boolean;

  @IsOptional()
  @IsString()
  mode?: 'driving' | 'walking' | 'cycling';
}

@ApiTags('Geo')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('geo')
export class GeoController {
  constructor(
    private readonly routingService: RoutingService,
    @InjectRepository(GeoStateEntity)
    private readonly stateRepo: Repository<GeoStateEntity>,
    @InjectRepository(GeoDistrictEntity)
    private readonly districtRepo: Repository<GeoDistrictEntity>,
    @InjectRepository(GeoCityEntity)
    private readonly cityRepo: Repository<GeoCityEntity>,
    private readonly cache: CacheService,
    private readonly geoPrecision: GeoPrecisionService,
  ) {}

  @Get('autocomplete')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Live whole-India place search (state/district/city/town/pincode) for type-ahead' })
  async autocomplete(@Query('q') q?: string) {
    const results = await autocompleteIndia((q || '').trim());
    return { success: true, data: results };
  }

  @Get('states')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'List all states in geographic reference data' })
  async getStates() {
    const states = await this.cache.wrap('ref:geo:states', GEO_CACHE_TTL_SECONDS, () =>
      this.stateRepo.find({ order: { name: 'ASC' } }),
    );
    return { success: true, data: states };
  }

  @Get('states/:stateId/districts')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'List districts for a state' })
  async getDistricts(@Param('stateId') stateId: string) {
    const districts = await this.cache.wrap(`ref:geo:districts:${stateId}`, GEO_CACHE_TTL_SECONDS, () =>
      this.districtRepo.find({ where: { stateId }, order: { name: 'ASC' } }),
    );
    return { success: true, data: districts };
  }

  @Get('districts/:districtId/cities')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'List cities for a district' })
  async getCities(@Param('districtId') districtId: string) {
    const cities = await this.cache.wrap(`ref:geo:cities:${districtId}`, GEO_CACHE_TTL_SECONDS, () =>
      this.cityRepo.find({ where: { districtId }, order: { name: 'ASC' } }),
    );
    return { success: true, data: cities };
  }

  @Post('route/optimize')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Calculate optimized route sequence (TSP solver) for multiple destinations' })
  async optimizeRoute(@Body() dto: OptimizeRouteDto) {
    if (dto.destinations.length > 20) {
      throw new BadRequestException('Optimization limit exceeded: Cannot optimize more than 20 destinations at once.');
    }
    const result = await this.routingService.optimizeRoute(dto.origin, dto.destinations, dto.roundTrip, dto.mode);
    return {
      success: true,
      data: result,
    };
  }

  // -----------------------------------------------------------------------
  // Coordinate precision
  // -----------------------------------------------------------------------

  @Get('precision/:target')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.HR_MANAGER)
  @ApiOperation({ summary: 'How precise the stored coordinates are, by tier' })
  async precisionSummary(@Param('target') target: string) {
    return { success: true, data: await this.geoPrecision.summary(assertTarget(target)) };
  }

  @Get('precision/:target/imprecise')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.HR_MANAGER)
  @ApiOperation({ summary: 'Records still on a district/state centroid — the manual-pin worklist' })
  async impreciseRecords(@Param('target') target: string, @Query('limit') limit = 100) {
    return { success: true, data: await this.geoPrecision.imprecise(assertTarget(target), Number(limit) || 100) };
  }

  @Post('precision/:target/backfill')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Re-resolve coarse coordinates through the free geocoders' })
  async backfillPrecision(@Param('target') target: string, @Body() dto: BackfillDto) {
    // Bounded, and deliberately not "all". The free providers allow about one lookup a second,
    // so an unbounded run on a national estate would hold an HTTP request open for hours.
    const limit = Math.min(Math.max(Number(dto?.limit) || 25, 1), 200);
    return { success: true, data: await this.geoPrecision.backfill(assertTarget(target), limit) };
  }

  @Post('precision/:target/:id/pin')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.HR_MANAGER)
  @ApiOperation({ summary: 'Pin a record to an exact coordinate by hand (5-10 m, and never re-geocoded)' })
  async pin(
    @Param('target') target: string,
    @Param('id') id: string,
    @Body() dto: PinCoordinateDto,
    @Req() req: any,
  ) {
    const geo = await this.geoPrecision.pinManually(
      assertTarget(target), id, dto.latitude, dto.longitude, req.user.id, dto.note,
    );
    return { success: true, data: geo };
  }
}
