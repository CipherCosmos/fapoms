/**
 * FAPOMS — Pricing Controller
 *
 * Exists so no client ever recomputes a fee. The Planning screen used to carry its own copy
 * of the formula — twice, and the two copies disagreed with each other (one applied the 10 km
 * free-commute allowance, the "Optimized Route Details" line did not) as well as with the two
 * server-side copies. Quoting through here means the number ops is shown is, by construction,
 * the number the server will store.
 */

import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsUUID, IsDateString, IsIn, Min } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeePolicyService, FeeRates, FeeBreakdown } from './fee-policy.service';
import { BranchEntity } from '../branch/branch.entity';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { dayTravelAlreadyCharged } from '../assignment/assignment-day-travel';

class QuoteRequestDto {
  @IsUUID()
  assayerId: string;

  @IsOptional() @IsUUID()
  clientId?: string;

  /** Alternative to clientId — the server resolves the client's rate card from the project. */
  @IsOptional() @IsUUID()
  projectId?: string;

  /**
   * Where the work is, so the transport rate card can price the actual journey. The Planning
   * screen has always sent this field; it used to be ignored.
   */
  @IsOptional() @IsUUID()
  branchId?: string;

  /** Direct place inputs, for callers quoting without a concrete branch. */
  @IsOptional() @IsString()
  state?: string;

  @IsOptional() @IsString()
  region?: string;

  @IsNumber() @Min(0)
  distanceKm: number;

  /**
   * The routed drive time for `distanceKm`, one way, when the caller has one. Lets the mode
   * comparison time car/taxi/auto/two-wheeler by the real road instead of an average speed;
   * the fee is unaffected. `roadSource` says whether the route came from OSRM or the routing
   * layer's own estimate — assumed ESTIMATE when unstated, the honest default.
   */
  @IsOptional() @IsNumber() @Min(0)
  durationMinutes?: number;

  @IsOptional() @IsIn(['OSRM', 'ESTIMATE'])
  roadSource?: 'OSRM' | 'ESTIMATE';

  @IsOptional() @IsNumber() @Min(1)
  branchCount?: number;

  @IsOptional() @IsDateString()
  onDate?: string;

  /**
   * The job being moved on a reassign (or re-dated): it must not count as "travel already paid"
   * for its own day. Only read together with `onDate`.
   */
  @IsOptional() @IsUUID()
  excludeAssignmentId?: string;
}

@ApiTags('Pricing')
@ApiBearerAuth()
@Controller('pricing')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles(...STAFF_ROLES)
export class PricingController {
  constructor(
    private readonly feePolicyService: FeePolicyService,
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
  ) {}

  @Get('rates')
  @ApiOperation({ summary: 'Resolve the fee rate card in force for a client' })
  async getRates(
    @Query('clientId') clientId?: string,
    @Query('projectId') projectId?: string,
  ): Promise<FeeRates> {
    const resolved = clientId
      || (projectId ? await this.feePolicyService.resolveClientIdForProject(projectId) : null);
    return this.feePolicyService.getRates(resolved);
  }

  @Post('quote')
  @ApiOperation({ summary: 'Quote a fee for an assayer/branch pairing using the contracted rates' })
  async quote(@Body() dto: QuoteRequestDto): Promise<FeeBreakdown & { travelAlreadyCharged?: boolean }> {
    const clientId = dto.clientId
      ?? (dto.projectId ? await this.feePolicyService.resolveClientIdForProject(dto.projectId) : null);

    // Place, best effort: the branch row when one was named, direct inputs otherwise. A
    // branch that cannot be loaded degrades to legacy travel pricing, never to an error —
    // this endpoint's job is to always have a number for the desk.
    let place: { state: string | null; region: string | null } | null =
      dto.state || dto.region ? { state: dto.state ?? null, region: dto.region ?? null } : null;
    if (dto.branchId) {
      const branch = await this.branchRepository
        .findOne({ where: { id: dto.branchId }, select: ['id', 'state', 'region'] })
        .catch(() => null);
      if (branch) place = { state: branch.state ?? null, region: branch.region ?? null };
    }

    /**
     * Travel once per assayer per day (E2), applied to the QUOTE too (B6, 2026-09-24). The assign
     * form pre-fills its fee box from this answer; quoted without the day, an assayer's second job
     * showed a travel-inclusive figure, and posting it back charged the journey twice. With
     * `onDate`, when another of this assayer's jobs that day already carries the travel, the answer
     * is the base-only price the server will record, flagged `travelAlreadyCharged`.
     */
    if (dto.onDate && dto.distanceKm > 0) {
      const alreadyPaid = await dayTravelAlreadyCharged(
        this.branchRepository.manager as any, dto.assayerId, dto.onDate.slice(0, 10), dto.excludeAssignmentId ?? null,
      ).catch(() => false);
      if (alreadyPaid) {
        const baseOnly = await this.feePolicyService.quote({
          assayerId: dto.assayerId,
          clientId,
          distanceKm: 0,
          branchCount: dto.branchCount,
          onDate: new Date(dto.onDate),
          place,
          road: null,
        });
        // The distance is still a measurement worth showing; only the charge drops.
        return { ...baseOnly, distanceKm: dto.distanceKm, travelAlreadyCharged: true };
      }
    }

    return this.feePolicyService.quote({
      assayerId: dto.assayerId,
      clientId,
      distanceKm: dto.distanceKm,
      branchCount: dto.branchCount,
      onDate: dto.onDate ? new Date(dto.onDate) : undefined,
      place,
      road:
        dto.durationMinutes && dto.durationMinutes > 0
          ? { distanceKm: dto.distanceKm, durationMinutes: dto.durationMinutes, source: dto.roadSource ?? 'ESTIMATE' }
          : null,
    });
  }
}
