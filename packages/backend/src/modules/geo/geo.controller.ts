import { Controller, Get, Post, Param, Body, Query, UseGuards, BadRequestException } from '@nestjs/common';
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
    const states = await this.stateRepo.find({ order: { name: 'ASC' } });
    return { success: true, data: states };
  }

  @Get('states/:stateId/districts')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'List districts for a state' })
  async getDistricts(@Param('stateId') stateId: string) {
    const districts = await this.districtRepo.find({ where: { stateId }, order: { name: 'ASC' } });
    return { success: true, data: districts };
  }

  @Get('districts/:districtId/cities')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'List cities for a district' })
  async getCities(@Param('districtId') districtId: string) {
    const cities = await this.cityRepo.find({ where: { districtId }, order: { name: 'ASC' } });
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
}
