/**
 * FAPOMS — Transport Rate Controller
 *
 * The management surface for the transport rate card (the Transport Costs dashboard) and the
 * estimator behind it. Reading is staff-wide — every desk shows the recommendation — but
 * writing moves real money on every future offer, so it is held to the roles that own rates
 * elsewhere in the product (operations own planning inputs, finance owns what things cost).
 */

import { Controller, Get, Post, Put, Delete, Param, Body, Query, Req, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean, Min, Max, Matches } from 'class-validator';
import { SystemRole } from '@fapoms/shared';

import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { TransportRateService, TransportEstimate, RoadLeg } from './transport-rate.service';
import { TransportRateEntity } from './transport-rate.entity';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateTransportRateRequestDto {
  @IsString() @IsNotEmpty()
  mode: string;

  @IsString() @IsNotEmpty()
  scopeType: string;

  @IsOptional() @IsString()
  scopeValue?: string | null;

  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000)
  baseFare?: number;

  @IsNumber() @Min(0) @Max(100_000)
  perKmRate: number;

  @IsOptional() @IsBoolean()
  isPreferred?: boolean;

  @IsString() @Matches(DATE_ONLY, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom: string;

  @IsOptional() @Matches(DATE_ONLY, { message: 'effectiveTo must be YYYY-MM-DD' })
  effectiveTo?: string | null;

  @IsOptional() @IsString()
  notes?: string | null;
}

export class UpdateTransportRateRequestDto {
  @IsOptional() @IsString()
  mode?: string;

  @IsOptional() @IsString()
  scopeType?: string;

  @IsOptional() @IsString()
  scopeValue?: string | null;

  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000)
  baseFare?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(100_000)
  perKmRate?: number;

  @IsOptional() @IsBoolean()
  isPreferred?: boolean;

  @IsOptional() @Matches(DATE_ONLY, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom?: string;

  @IsOptional() @Matches(DATE_ONLY, { message: 'effectiveTo must be YYYY-MM-DD' })
  effectiveTo?: string | null;

  @IsOptional() @IsString()
  notes?: string | null;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

const RATE_MANAGER_ROLES = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.OPERATIONS_MANAGER,
  SystemRole.FINANCE_MANAGER,
] as const;

@ApiTags('Transport Rates')
@ApiBearerAuth()
@Controller('transport-rates')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles(...STAFF_ROLES)
export class TransportRateController {
  constructor(private readonly transportRateService: TransportRateService) {}

  @Get()
  @ApiOperation({ summary: 'List every transport rate, including retired rows' })
  async findAll(): Promise<{ success: boolean; data: TransportRateEntity[] }> {
    return { success: true, data: await this.transportRateService.findAll() };
  }

  /**
   * The dashboard's "try it" panel and any surface that wants per-mode costs AND times for a
   * journey. Place accepts raw spellings — the service canonicalises exactly as the quote path
   * does, so what the estimator shows is what an offer would use.
   *
   * `durationMinutes` (one way) lets a caller that already routed the road hand the drive time
   * in, so car/taxi/auto/two-wheeler show the real figure instead of a distance-÷-speed guess;
   * `roadSource` says whether that route was OSRM or the routing layer's own estimate (defaults
   * to ESTIMATE — the honest assumption when nobody says). Without it every mode is estimated
   * and says so.
   */
  @Get('estimate')
  @ApiOperation({ summary: 'Estimate per-mode journey costs and times for a distance and place' })
  async estimate(
    @Query('distanceKm') distanceKm: string,
    @Query('state') state?: string,
    @Query('region') region?: string,
    @Query('onDate') onDate?: string,
    @Query('durationMinutes') durationMinutes?: string,
    @Query('roadSource') roadSource?: string,
  ): Promise<{ success: boolean; data: TransportEstimate }> {
    const km = Number(distanceKm);
    const at = onDate && DATE_ONLY.test(onDate) ? new Date(`${onDate}T00:00:00Z`) : undefined;
    const minutes = Number(durationMinutes);
    const road: RoadLeg | null =
      Number.isFinite(minutes) && minutes > 0
        ? { distanceKm: km, durationMinutes: minutes, source: roadSource === 'OSRM' ? 'OSRM' : 'ESTIMATE' }
        : null;
    const data = await this.transportRateService.estimate(
      Number.isFinite(km) ? km : 0,
      { state: state || null, region: region || null },
      at,
      { road },
    );
    return { success: true, data };
  }

  @Post()
  @Roles(...RATE_MANAGER_ROLES)
  @ApiOperation({ summary: 'Create a transport rate' })
  async create(
    @Body() dto: CreateTransportRateRequestDto,
    @Req() req: any,
  ): Promise<{ success: boolean; data: TransportRateEntity }> {
    const data = await this.transportRateService.create(dto, req.user?.id);
    return { success: true, data };
  }

  @Put(':id')
  @Roles(...RATE_MANAGER_ROLES)
  @ApiOperation({ summary: 'Update a transport rate' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTransportRateRequestDto,
    @Req() req: any,
  ): Promise<{ success: boolean; data: TransportRateEntity }> {
    const data = await this.transportRateService.update(id, dto, req.user?.id);
    return { success: true, data };
  }

  /**
   * DELETE retires, never destroys: a rate that priced an offer is part of that offer's audit
   * trail. The row stays visible in the dashboard's history with isActive=false.
   */
  @Delete(':id')
  @Roles(...RATE_MANAGER_ROLES)
  @ApiOperation({ summary: 'Retire a transport rate (soft delete)' })
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ): Promise<{ success: boolean; data: TransportRateEntity }> {
    const data = await this.transportRateService.deactivate(id, req.user?.id);
    return { success: true, data };
  }
}
