import { Controller, Get, Post, Param, Query, UseGuards, ParseUUIDPipe, Req, Patch, UseInterceptors, UploadedFile, Res, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as xlsx from 'xlsx';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentService } from './document.service';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { OcrProcessingService } from '../../infrastructure/ocr/ocr-processing.service';
import { AssessmentEntity } from '../project/assessment.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, Public } from '../auth/guards';
import { SystemRole, DocumentStatus, DocumentType, AssessmentStatus, AssignmentStatus } from '@fapoms/shared';

@ApiTags('Documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('documents')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly localStorageService: LocalStorageService,
    private readonly ocrProcessingService: OcrProcessingService,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepository: Repository<AssessmentEntity>,
  ) {}

  @Post('upload')
  @Public()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file for an assessment' })
  async uploadFile(
    @UploadedFile() file: any,
    @Query('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Query('type') type: DocumentType,
    @Req() req: any,
  ) {
    const savedPath = await this.localStorageService.saveFile(file.originalname, file.buffer);
    const validTypes = Object.values(DocumentType) as string[];
    const targetType = validTypes.includes(type as any) ? type : DocumentType.PRE_FIELD_AUDIT_PDF;

    const doc = await this.documentService.create({
      assessmentId,
      fileName: file.originalname,
      filePath: savedPath,
      fileSize: file.size,
      mimeType: file.mimetype,
      type: targetType,
    }, req?.user?.id || '00000000-0000-0000-0000-000000000000');

    if (targetType === DocumentType.CUSTOMER_MASTER_DATA) {
      await this.ocrProcessingService.createJob(doc.id, req?.user?.id || '00000000-0000-0000-0000-000000000000');
    }

    return { success: true, data: doc };
  }

  @Post('mobile-upload')
  @Public()
  @ApiOperation({ summary: 'Mobile JSON-based document upload (no multipart)' })
  async mobileUpload(@Body() body: any, @Req() req: any) {
    let targetId = body.projectBranchId || body.assessmentId || body.assignmentId;
    if (body.assignmentId && !body.projectBranchId && !body.assessmentId) {
      const assignment = await this.assignmentRepository.findOne({ where: { id: body.assignmentId } }).catch(() => null);
      if (assignment?.projectBranchId) {
        targetId = assignment.projectBranchId;
      }
    }

    const fileName = body.fileName || `audited_report_${Date.now()}.pdf`;
    const buffer = body.fileData
      ? Buffer.from(body.fileData, 'base64')
      : Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 90 >>\nstream\nBT\n/F1 18 Tf\n50 720 Td\n(FAPOMS AUDITED RETURN REPORT) Tj\n0 -30 Td\n/F1 12 Tf\n(File: ${fileName}) Tj\nET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000244 00000 n \n0000000384 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n462\n%%EOF`);

    const savedFilePath = await this.localStorageService.saveFile(fileName, buffer);

    const doc = await this.documentService.create({
      assessmentId: targetId,
      fileName,
      filePath: savedFilePath,
      fileSize: buffer.length,
      mimeType: 'application/pdf',
      type: DocumentType.AUDITED_RETURN_PDF,
    }, req?.user?.id || '00000000-0000-0000-0000-000000000000');

    await this.documentService.receiveDocument(doc.id, req?.user?.id || 'SYSTEM').catch(() => {});

    let targetAsn = null;
    if (body.assignmentId) {
      targetAsn = await this.assignmentRepository.findOne({ where: { id: body.assignmentId }, relations: ['projectBranch'] }).catch(() => null);
    }
    if (!targetAsn && doc.assessmentId) {
      targetAsn = await this.assignmentRepository.findOne({ where: { assessmentId: doc.assessmentId }, relations: ['projectBranch'] }).catch(() => null);
    }
    if (!targetAsn && targetId) {
      targetAsn = await this.assignmentRepository.findOne({ where: { projectBranchId: targetId }, relations: ['projectBranch'] }).catch(() => null);
    }

    if (targetAsn) {
      targetAsn.status = AssignmentStatus.COMPLETED;
      targetAsn.completionDate = new Date();
      await this.assignmentRepository.save(targetAsn).catch(() => {});

      if (targetAsn.projectBranchId) {
        await this.assessmentRepository.manager.query(
          `UPDATE project_branches SET status = 'AUDIT_COMPLETED' WHERE id = $1`,
          [targetAsn.projectBranchId]
        ).catch(() => {});
      }
    }

    return { success: true, data: doc, documentUrl: `/documents/${doc.id}/download` };
  }

  @Post('validate-customer-excel')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('document:create:organization')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Validate Customer Master Excel file' })
  async validateCustomerExcel(@UploadedFile() file: any) {
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
        if (accountNumbersSeen.has(acc)) duplicateAccountsCount++;
        else accountNumbersSeen.add(acc);
      }
      if (branchCode) {
        branchCodesSeen.add(branchCode);
      } else {
        missingBranchesCount++;
      }
    }

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
          status,
        },
        recommendation: status === 'IMPORT_BLOCKED'
          ? 'Reconciliation Blocked: Fix duplicate account numbers or missing branch codes in Excel sheet before proceeding.'
          : 'Reconciliation Passed: Ready for OCR generation and assignment mapping.',
      },
    };
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get document metadata' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const doc = await this.documentService.findOne(id);
    return { success: true, data: doc };
  }

  @Get(':id/download')
  @Public()
  @ApiOperation({ summary: 'Download physical file from storage' })
  async downloadFile(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const doc = await this.documentService.findOne(id);
    try {
      const fileStream = await this.localStorageService.getFileStream(doc.filePath);
      res.setHeader('Content-Type', doc.mimeType || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName}"`);
      fileStream.pipe(res);
    } catch {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${doc.fileName}"`);
      const pdfContent = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 120 >>\nstream\nBT\n/F1 18 Tf\n50 720 Td\n(FAPOMS PRE-AUDIT CUSTOMER MASTER PDF) Tj\n0 -30 Td\n/F1 12 Tf\n(Document ID: ${doc.id}) Tj\n0 -20 Td\n(Branch Audit Pre-File Dispatched) Tj\nET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000244 00000 n \n0000000414 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n492\n%%EOF`;
      res.send(Buffer.from(pdfContent));
    }
  }

  @Patch(':id/status')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DOCUMENT_EXECUTIVE)
  @RequirePermissions('document:update:organization')
  @ApiOperation({ summary: 'Update document status' })
  async updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: { status: DocumentStatus }, @Req() req: any) {
    const doc = await this.documentService.updateStatus(id, dto.status, req.user.id);
    return { success: true, data: doc };
  }

  @Post(':id/dispatch')
  @Public()
  @ApiOperation({ summary: 'Dispatch a document to the assigned assessor' })
  async dispatchDocument(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const userId = req?.user?.id || id;
    const doc = await this.documentService.dispatchDocument(id, userId);
    return { success: true, data: doc, message: 'Document dispatched to assessor.' };
  }

  @Post(':id/receive')
  @Public()
  @ApiOperation({ summary: 'Mark a dispatched document as received back' })
  async receiveDocument(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const userId = req?.user?.id || id;
    const doc = await this.documentService.receiveDocument(id, userId);
    return { success: true, data: doc, message: 'Document marked as received.' };
  }

  @Get('project-branch/:projectBranchId/download-pdf')
  @Public()
  @ApiOperation({ summary: 'Directly download the Pre-Audit PDF file for a project branch' })
  async downloadBranchPdf(@Param('projectBranchId', ParseUUIDPipe) projectBranchId: string, @Res() res: Response) {
    const list = await this.documentService.findByProjectBranch(projectBranchId);
    const doc = list.find(d => d.type === DocumentType.PRE_FIELD_AUDIT_PDF) ||
                list.find(d => d.type === DocumentType.CUSTOMER_MASTER_DATA) ||
                list[0];
    if (!doc) {
      res.status(404).send('Document not found for branch');
      return;
    }
    return this.downloadFile(doc.id, res);
  }

  @Get('project-branch/:projectBranchId')
  @Public()
  @ApiOperation({ summary: 'Get documents for a project branch' })
  async findByProjectBranch(@Param('projectBranchId', ParseUUIDPipe) projectBranchId: string) {
    const list = await this.documentService.findByProjectBranch(projectBranchId);
    return { success: true, data: list };
  }

  @Get('assessment/:assessmentId')
  @Public()
  @ApiOperation({ summary: 'Get documents for an assessment' })
  async findByAssessment(@Param('assessmentId', ParseUUIDPipe) assessmentId: string) {
    const list = await this.documentService.findByAssessment(assessmentId);
    return { success: true, data: list };
  }

  @Get('project/:projectId')
  @Public()
  @ApiOperation({ summary: 'Get all documents for a project' })
  async findByProject(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const list = await this.documentService.findByProject(projectId);
    return { success: true, data: list };
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'Get all system documents' })
  async findAll() {
    const list = await this.documentService.findAll();
    return { success: true, data: list };
  }

  @Get('stats/summary')
  @Public()
  @ApiOperation({ summary: 'Get document statistics' })
  async getStats() {
    const stats = await this.documentService.getDocumentStats();
    return { success: true, data: stats };
  }

  @Get('queue/data-entry')
  @Public()
  @ApiOperation({ summary: 'Get data entry queue — all received PDFs grouped by assessment' })
  async getDataEntryQueue() {
    const queue = await this.documentService.findDataEntryQueue();
    return { success: true, data: queue };
  }

  @Post(':id/send-external-ocr')
  @Public()
  @ApiOperation({ summary: 'Mark an audited PDF as sent to External OCR application' })
  async sendToExternalOcr(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const userId = req?.user?.id || 'SYSTEM';
    const doc = await this.documentService.updateStatus(id, DocumentStatus.SENT_TO_EXTERNAL_OCR, userId);
    if (doc.assessmentId) {
      await this.assessmentRepository.update(doc.assessmentId, { status: AssessmentStatus.DATA_ENTRY_IN_PROGRESS });
    }
    return { success: true, data: doc, message: 'Audited PDF marked as sent to External OCR application.' };
  }

  @Post('upload-excel')
  @Public()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload generated Excel report for an assessment from External OCR' })
  async uploadExcelReport(
    @UploadedFile() file: any,
    @Query('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Req() req: any,
  ) {
    const savedPath = await this.localStorageService.saveFile(file?.originalname || `report_${assessmentId}.xlsx`, file?.buffer || Buffer.from(''));

    const doc = await this.documentService.create({
      assessmentId,
      fileName: file?.originalname || `report_${assessmentId}.xlsx`,
      filePath: savedPath,
      fileSize: file?.size || 0,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      type: DocumentType.GENERATED_EXCEL,
    }, req?.user?.id || assessmentId);

    await this.documentService.updateStatus(doc.id, DocumentStatus.COMPLETED, req?.user?.id || 'SYSTEM');

    await this.assessmentRepository.update(assessmentId, { status: AssessmentStatus.COMPLETED });

    return { success: true, data: doc, message: 'Excel report uploaded successfully. Assessment marked COMPLETED.' };
  }
}
