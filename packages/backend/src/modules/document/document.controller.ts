import { Controller, Get, Post, Param, Query, UseGuards, ParseUUIDPipe, Req, Patch, UseInterceptors, UploadedFile, Res, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as xlsx from 'xlsx';
import { DocumentService } from './document.service';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { OcrProcessingService } from '../../infrastructure/ocr/ocr-processing.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole, DocumentStatus, DocumentType } from '@fapoms/shared';

class UpdateDocumentStatusDto {
  status: DocumentStatus;
}

@ApiTags('Documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('documents')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly localStorageService: LocalStorageService,
    private readonly ocrProcessingService: OcrProcessingService,
  ) {}

  @Post('upload')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DOCUMENT_EXECUTIVE)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a physical file and trigger OCR queuing' })
  async uploadFile(
    @UploadedFile() file: any,
    @Query('projectBranchId', ParseUUIDPipe) projectBranchId: string,
    @Query('type') type: DocumentType,
    @Req() req: any,
  ) {
    // 1. Save file to disk storage
    const savedPath = await this.localStorageService.saveFile(file.originalname, file.buffer);

    // 2. Create document database entry
    const doc = await this.documentService.create({
      projectBranchId,
      fileName: file.originalname,
      filePath: savedPath,
      fileSize: file.size,
      mimeType: file.mimetype,
      type,
    }, req.user.id);

    // 3. Auto-ingest into OCR pipeline
    await this.ocrProcessingService.createJob(doc.id, req.user.id);

    return {
      success: true,
      data: doc,
    };
  }

  @Post('validate-customer-excel')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.OPERATIONS_MANAGER)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Validate Customer Master Excel file and return structured Reconciliation Summary Report' })
  async validateCustomerExcel(@UploadedFile() file: any) {
    // Parse Excel workbook buffer
    const workbook = xlsx.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rows: any[] = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    let totalRows = rows.length;
    let duplicateAccountsCount = 0;
    let missingBranchesCount = 0;
    const accountNumbersSeen = new Set<string>();
    const branchCodesSeen = new Set<string>();

    for (const row of rows) {
      const acc = String(row['Account Number'] || row.ACCOUNT_NO || row.AccountNo || '').trim();
      const branchCode = String(row['Branch Code'] || row.BRANCH_CODE || row.BranchCode || '').trim();

      if (acc) {
        if (accountNumbersSeen.has(acc)) {
          duplicateAccountsCount++;
        } else {
          accountNumbersSeen.add(acc);
        }
      }

      if (branchCode) {
        branchCodesSeen.add(branchCode);
      } else {
        missingBranchesCount++;
      }
    }

    const isReplacementUpload = totalRows > 1000;
    const status = (duplicateAccountsCount > 50 || missingBranchesCount > 10) ? 'IMPORT_BLOCKED' : 'VALIDATED_READY_FOR_IMPORT';

    return {
      success: true,
      data: {
        summary: {
          totalRowsProcessed: totalRows,
          uniqueAccountsCount: accountNumbersSeen.size,
          duplicateAccountsCount,
          uniqueBranchesCount: branchCodesSeen.size,
          missingBranchCodesCount: missingBranchesCount,
          isReplacementUpload,
          status,
        },
        recommendation: status === 'IMPORT_BLOCKED'
          ? 'Reconciliation Blocked: Fix duplicate account numbers or missing branch codes in Excel sheet before proceeding.'
          : 'Reconciliation Passed: Ready for OCR generation and assignment mapping.',
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details of a document metadata' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const doc = await this.documentService.findOne(id);
    return {
      success: true,
      data: doc,
    };
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download physical file payload from storage' })
  async downloadFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const doc = await this.documentService.findOne(id);
    const fileStream = await this.localStorageService.getFileStream(doc.filePath);
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName}"`);
    fileStream.pipe(res);
  }

  @Patch(':id/status')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DOCUMENT_EXECUTIVE)
  @ApiOperation({ summary: 'Update status of a document' })
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentStatusDto,
    @Req() req: any,
  ) {
    const doc = await this.documentService.updateStatus(id, dto.status, req.user.id);
    return {
      success: true,
      data: doc,
    };
  }

  @Get('project-branch/:projectBranchId')
  @ApiOperation({ summary: 'Get documents for a project branch link' })
  async findByProjectBranch(@Param('projectBranchId', ParseUUIDPipe) projectBranchId: string) {
    const list = await this.documentService.findByProjectBranch(projectBranchId);
    return {
      success: true,
      data: list,
    };
  }
}
