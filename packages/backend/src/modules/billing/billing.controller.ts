import { Controller, Get, Post, Body, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BillingService } from './billing.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';
import { IsUUID, IsNumber, IsOptional, IsString, Min } from 'class-validator';

class CreateBillingRecordDto {
  @IsUUID()
  assayerId: string;

  @IsOptional()
  @IsUUID()
  auditId?: string;

  @IsOptional()
  @IsUUID()
  assignmentId?: string;

  @IsNumber()
  @Min(0)
  baseFee: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  travelAllowance?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  penalties?: number;

  @IsOptional()
  @IsString()
  invoiceStatus?: string;
}

@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Create a billing record with auto-calculated GST and TDS' })
  async createBillingRecord(@Body() dto: CreateBillingRecordDto) {
    const record = await this.billingService.createBillingRecord(dto);
    return {
      success: true,
      data: record,
    };
  }

  @Get('assayer/:assayerId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get billing records for an assayer' })
  async getAssayerBilling(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const records = await this.billingService.getAssayerBilling(assayerId);
    return {
      success: true,
      data: records,
    };
  }
}
