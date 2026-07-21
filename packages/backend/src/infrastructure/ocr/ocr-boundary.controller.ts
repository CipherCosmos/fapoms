import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OcrProcessingService } from './ocr-processing.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../../modules/auth/guards';
import { SystemRole } from '@fapoms/shared';

class ReceiveOcrResultsDto {
  externalJobId: string;
  ocrPayload: any;
}

@ApiTags('OCR Integration Boundary')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ocr-boundary')
export class OcrBoundaryController {
  constructor(private readonly ocrProcessingService: OcrProcessingService) {}

  @Post('jobs')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Create a new OCR tracking job request' })
  async createJob(
    @Query('documentId', ParseUUIDPipe) documentId: string,
    @Req() req: any,
  ) {
    const job = await this.ocrProcessingService.createJob(documentId, req.user.id);
    return {
      success: true,
      data: job,
    };
  }

  @Post('jobs/:id/results')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Callback endpoint to receive external OCR engine scan results' })
  async callbackOcr(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveOcrResultsDto,
    @Req() req: any,
  ) {
    const job = await this.ocrProcessingService.receiveOcrResults(id, dto.externalJobId, dto.ocrPayload, req.user.id);
    return {
      success: true,
      data: job,
    };
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Get status tracking details of an OCR job' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const job = await this.ocrProcessingService.findOne(id);
    return {
      success: true,
      data: job,
    };
  }
}
