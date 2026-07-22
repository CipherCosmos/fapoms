import { Controller, Post, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString, IsArray, ValidateNested, IsBoolean, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { RoutingService, DestinationCoords } from './routing.provider';
import { JwtAuthGuard, RolesGuard } from '../auth/guards';

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
}

@ApiTags('Geo')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('geo')
export class GeoController {
  constructor(private readonly routingService: RoutingService) {}

  @Post('route/optimize')
  @ApiOperation({ summary: 'Calculate optimized route sequence (TSP solver) for multiple destinations' })
  async optimizeRoute(@Body() dto: OptimizeRouteDto) {
    if (dto.destinations.length > 20) {
      throw new BadRequestException('Optimization limit exceeded: Cannot optimize more than 20 destinations at once.');
    }
    const result = await this.routingService.optimizeRoute(dto.origin, dto.destinations, dto.roundTrip);
    return {
      success: true,
      data: result,
    };
  }
}
