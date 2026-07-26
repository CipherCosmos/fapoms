import { Controller, Get, Post, Body, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { LedgerService } from './ledger.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';
import { IsUUID, IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

class CreateLedgerEntryDto {
  @IsUUID()
  assayerId: string;

  @IsEnum(['CREDIT', 'DEBIT'])
  type: 'CREDIT' | 'DEBIT';

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  referenceId?: string;
}

@ApiTags('Ledger')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Add a financial ledger entry for an assayer' })
  async createEntry(@Body() dto: CreateLedgerEntryDto) {
    const entry = await this.ledgerService.addEntry(dto.assayerId, dto.type, dto.amount, dto.referenceId);
    return {
      success: true,
      data: entry,
    };
  }

  @Get('assayer/:assayerId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get financial ledger entries for an assayer' })
  async getLedger(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const entries = await this.ledgerService.getLedger(assayerId);
    return {
      success: true,
      data: entries,
    };
  }
}
