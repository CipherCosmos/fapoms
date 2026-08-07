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
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsUUID, IsDateString, Min } from 'class-validator';

import { FeePolicyService, FeeRates, FeeBreakdown } from './fee-policy.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';

class QuoteRequestDto {
  @IsUUID()
  assayerId: string;

  @IsOptional() @IsUUID()
  clientId?: string;

  /** Alternative to clientId — the server resolves the client's rate card from the project. */
  @IsOptional() @IsUUID()
  projectId?: string;

  @IsNumber() @Min(0)
  distanceKm: number;

  @IsOptional() @IsNumber() @Min(1)
  branchCount?: number;

  @IsOptional() @IsDateString()
  onDate?: string;
}

@ApiTags('Pricing')
@ApiBearerAuth()
@Controller('pricing')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles(...STAFF_ROLES)
export class PricingController {
  constructor(private readonly feePolicyService: FeePolicyService) {}

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
  async quote(@Body() dto: QuoteRequestDto): Promise<FeeBreakdown> {
    const clientId = dto.clientId
      ?? (dto.projectId ? await this.feePolicyService.resolveClientIdForProject(dto.projectId) : null);

    return this.feePolicyService.quote({
      assayerId: dto.assayerId,
      clientId,
      distanceKm: dto.distanceKm,
      branchCount: dto.branchCount,
      onDate: dto.onDate ? new Date(dto.onDate) : undefined,
    });
  }
}
