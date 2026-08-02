import { Controller, Get, Post, Put, Param, Query, UseGuards, ParseUUIDPipe, Req, Patch, UseInterceptors, UploadedFile, UploadedFiles, Res, Body, BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
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

import { ValidationService } from '../validation/validation.service';
import { DocumentAccessTokenService } from './document-access-token.service';
import { ChunkedUploadService } from './chunked-upload.service';
import { AssignmentService } from '../assignment/assignment.service';

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
    private readonly validationService: ValidationService,
    private readonly assignmentService: AssignmentService,
    private readonly documentAccessTokenService: DocumentAccessTokenService,
    private readonly chunkedUploadService: ChunkedUploadService,
  ) {}

  @Post('upload')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.DOCUMENT_EXECUTIVE)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file for an assessment' })
  async uploadFile(
    @UploadedFile() file: any,
    @Query('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Query('type') type: DocumentType,
    @Req() req: any,
    // Set when this packet was generated from a client batch, so the day's run can
    // report how many of its branches have had their PDF produced.
    @Query('customerMasterVersionId') customerMasterVersionId?: string,
  ) {
    const savedPath = await this.localStorageService.saveFile(file.originalname, file.buffer);
    const validTypes = Object.values(DocumentType) as string[];
    const targetType = validTypes.includes(type as any) ? type : DocumentType.PRE_FIELD_AUDIT_PDF;

    // The client's customer master file is a multi-branch batch belonging to one
    // audit date — it is not a per-branch document and must go through
    // /customer-master/upload, which reconciles it and registers a version.
    // Accepting it here filed one branch's row against a file covering ten.
    if (targetType === DocumentType.CUSTOMER_MASTER_DATA) {
      throw new BadRequestException(
        'Customer master data is a multi-branch batch for one audit date — upload it via /customer-master/upload, not as a per-branch document.',
      );
    }

    const doc = await this.documentService.create({
      assessmentId,
      fileName: file.originalname,
      filePath: savedPath,
      fileSize: file.size,
      mimeType: file.mimetype,
      type: targetType,
      customerMasterVersionId,
    }, req?.user?.id || '00000000-0000-0000-0000-000000000000');

    return { success: true, data: doc };
  }

  @Post('mobile-upload')
  @Roles(SystemRole.ASSAYER, SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.DOCUMENT_EXECUTIVE)
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

    // The audited return PDF is the assayer's actual field paperwork — the artifact the whole
    // data-entry pipeline consumes. This used to fall back to synthesizing a placeholder PDF
    // when `fileData` was absent, so a failed or empty upload still produced a document that
    // looked genuine and marked the assignment complete. Reject instead: a missing file is an
    // error, never something to invent.
    if (!body.fileData) {
      throw new BadRequestException(
        'No file content received (fileData is required, base64-encoded). The audited return PDF must be a real uploaded file.',
      );
    }
    const buffer = Buffer.from(body.fileData, 'base64');
    if (buffer.length === 0) {
      throw new BadRequestException('Uploaded file is empty.');
    }

    const savedFilePath = await this.localStorageService.saveFile(fileName, buffer);

    const doc = await this.documentService.create({
      assessmentId: targetId,
      fileName,
      filePath: savedFilePath,
      fileSize: buffer.length,
      mimeType: 'application/pdf',
      type: DocumentType.AUDITED_RETURN_PDF,
    }, req?.user?.id || '00000000-0000-0000-0000-000000000000');

    // Marks the assayer's paperwork as returned, which is what puts it into the Data Entry
    // Head's queue. This was `.catch(() => {})` — and since receiveDocument used to reject
    // anything not already DISPATCHED, every audited return failed here invisibly and never
    // reached the queue. Surface failures instead of swallowing them.
    try {
      await this.documentService.receiveDocument(doc.id, req?.user?.id || 'SYSTEM');
    } catch (err: any) {
      console.error(
        `Audited return ${doc.id} uploaded but could not be marked received — it will not appear in the data-entry queue:`,
        err?.message,
      );
    }

    await this.completeAssignmentForReturn(doc, body.assignmentId, targetId, req?.user?.id || 'SYSTEM', fileName);

    return { success: true, data: doc, documentUrl: `/documents/${doc.id}/download` };
  }

  /**
   * Binary audited-return upload for the assayer app.
   *
   * The JSON/base64 sibling above inflates every upload by 33% (base64 expansion) and forces
   * the whole file into a JS string on the device before sending — punishing on a low-end
   * handset and on a rural 2G link, where that overhead is minutes of extra transfer per scan.
   * Multipart sends the raw bytes and lets the client stream them straight off disk.
   *
   * Same post-upload behaviour as the JSON path — both delegate to the shared helper.
   */
  @Post('mobile-upload-binary')
  @Roles(
    SystemRole.ASSAYER,
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.DOCUMENT_EXECUTIVE,
  )
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Binary audited-return upload (no base64 inflation)' })
  async mobileUploadBinary(
    @UploadedFile() file: any,
    @Query('assessmentId') assessmentId: string,
    @Query('assignmentId') assignmentId: string,
    @Req() req: any,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file content received.');
    }
    let targetId = assessmentId || assignmentId;
    if (assignmentId && !assessmentId) {
      const assignment = await this.assignmentRepository
        .findOne({ where: { id: assignmentId } })
        .catch(() => null);
      if (assignment?.projectBranchId) targetId = assignment.projectBranchId;
    }

    const savedFilePath = await this.localStorageService.saveFile(file.originalname, file.buffer);
    const doc = await this.documentService.create(
      {
        assessmentId: targetId,
        fileName: file.originalname,
        filePath: savedFilePath,
        fileSize: file.size,
        mimeType: file.mimetype || 'application/pdf',
        type: DocumentType.AUDITED_RETURN_PDF,
      },
      req.user.id,
    );

    try {
      await this.documentService.receiveDocument(doc.id, req.user.id);
    } catch (err: any) {
      console.error(`Audited return ${doc.id} could not be marked received:`, err?.message);
    }

    await this.completeAssignmentForReturn(doc, assignmentId, targetId, req.user.id, file.originalname);

    return { success: true, data: doc };
  }

  // ── Resumable chunked upload ───────────────────────────────────────────────────
  // Field uploads happen on rural 2G/weak-3G where a multi-minute single-request upload
  // frequently drops and, previously, restarted from zero. These three endpoints let a client
  // send fixed-size chunks, ask what survived a disconnect, and transmit only the gaps.

  @Post('upload/session')
  @Roles(
    SystemRole.ASSAYER,
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.DOCUMENT_EXECUTIVE,
  )
  @ApiOperation({ summary: 'Open a resumable upload session' })
  async createUploadSession(
    @Body() body: { assessmentId: string; fileName: string; fileSize: number; chunkSize?: number },
    @Req() req: any,
  ) {
    if (!body?.assessmentId || !body?.fileName) {
      throw new BadRequestException('assessmentId and fileName are required.');
    }
    const session = this.chunkedUploadService.createSession({
      assessmentId: body.assessmentId,
      fileName: body.fileName,
      fileSize: Number(body.fileSize),
      chunkSize: body.chunkSize ? Number(body.chunkSize) : undefined,
      createdBy: req.user.id,
    });
    return { success: true, data: session };
  }

  /**
   * What the client calls after a reconnect: returns which chunks are already stored so it can
   * skip them. This is the difference between resuming a 90%-complete upload and repeating it.
   */
  @Get('upload/session/:uploadId')
  @Roles(
    SystemRole.ASSAYER,
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.DOCUMENT_EXECUTIVE,
  )
  @ApiOperation({ summary: 'Resume: report which chunks the server already holds' })
  async getUploadSession(@Param('uploadId') uploadId: string) {
    const session = this.chunkedUploadService.getSession(uploadId);
    const received = this.chunkedUploadService.receivedChunks(uploadId);
    const missing: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) if (!received.includes(i)) missing.push(i);
    return {
      success: true,
      data: {
        ...session,
        receivedChunks: received,
        missingChunks: missing,
        progress: Math.round((received.length / session.totalChunks) * 100),
      },
    };
  }

  @Put('upload/session/:uploadId/chunk/:index')
  @Roles(
    SystemRole.ASSAYER,
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.DOCUMENT_EXECUTIVE,
  )
  @UseInterceptors(FileInterceptor('chunk'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload one chunk (binary, resumable)' })
  async uploadChunk(
    @Param('uploadId') uploadId: string,
    @Param('index') index: string,
    @UploadedFile() chunk: any,
  ) {
    if (!chunk?.buffer) {
      throw new BadRequestException('No chunk content received.');
    }
    const progress = this.chunkedUploadService.saveChunk(uploadId, Number(index), chunk.buffer);
    return { success: true, data: { ...progress, index: Number(index) } };
  }

  @Post('upload/session/:uploadId/complete')
  @Roles(
    SystemRole.ASSAYER,
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.DOCUMENT_EXECUTIVE,
  )
  @ApiOperation({ summary: 'Assemble the chunks into the final document' })
  async completeUpload(
    @Param('uploadId') uploadId: string,
    @Body() body: { type?: DocumentType; assignmentId?: string },
    @Req() req: any,
  ) {
    const { buffer, session } = this.chunkedUploadService.assemble(uploadId);
    const type = body?.type && (Object.values(DocumentType) as string[]).includes(body.type)
      ? body.type
      : DocumentType.AUDITED_RETURN_PDF;

    const savedFilePath = await this.localStorageService.saveFile(session.fileName, buffer);
    const doc = await this.documentService.create(
      {
        assessmentId: session.assessmentId,
        fileName: session.fileName,
        filePath: savedFilePath,
        fileSize: buffer.length,
        mimeType: 'application/pdf',
        type,
      },
      req.user.id,
    );

    // Staging space is only released once the document is safely persisted — if create()
    // throws, the chunks survive and the client can retry completion without re-uploading.
    this.chunkedUploadService.discard(uploadId);

    if (type === DocumentType.AUDITED_RETURN_PDF) {
      try {
        await this.documentService.receiveDocument(doc.id, req.user.id);
      } catch (err: any) {
        console.error(`Chunked audited return ${doc.id} could not be marked received:`, err?.message);
      }
      await this.completeAssignmentForReturn(doc, body?.assignmentId, session.assessmentId, req.user.id, session.fileName);
    }

    return { success: true, data: doc };
  }

  /**
   * Completes the assignment once the assayer's audited return has landed.
   *
   * Shared by the single-shot and resumable-chunked upload paths so both behave identically —
   * duplicating this is exactly how the original cross-view status drift arose.
   *
   * Completion goes through AssignmentService.completeAssignment(), the single owner of that
   * transition: it cascades the project branch (via the state machine, so the domain event
   * fires), the schedule, the assessment status, the validation case, the audit trail, the
   * notification and the assayer stats.
   */
  private async completeAssignmentForReturn(
    doc: { id: string; assessmentId: string | null },
    assignmentId: string | undefined,
    fallbackTargetId: string | undefined,
    userId: string,
    fileName: string,
  ): Promise<void> {
    let targetAsn = null;
    if (assignmentId) {
      targetAsn = await this.assignmentRepository
        .findOne({ where: { id: assignmentId }, relations: ['projectBranch'] })
        .catch(() => null);
    }
    if (!targetAsn && doc.assessmentId) {
      targetAsn = await this.assignmentRepository
        .findOne({ where: { assessmentId: doc.assessmentId }, relations: ['projectBranch'] })
        .catch(() => null);
    }
    if (!targetAsn && fallbackTargetId) {
      targetAsn = await this.assignmentRepository
        .findOne({ where: { projectBranchId: fallbackTargetId }, relations: ['projectBranch'] })
        .catch(() => null);
    }

    if (targetAsn && targetAsn.status !== AssignmentStatus.COMPLETED) {
      try {
        await this.assignmentService.completeAssignment(
          targetAsn.id,
          userId,
          `Audited return PDF uploaded (${fileName})`,
        );
      } catch (err: any) {
        console.error(
          `Failed to complete assignment ${targetAsn.id} after audited-return upload:`,
          err?.message,
        );
      }
    }
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.VALIDATION_MANAGER, SystemRole.VALIDATOR, SystemRole.DATA_ENTRY_HEAD, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Get document metadata' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const doc = await this.documentService.findOne(id);
    return { success: true, data: doc };
  }

  @Get(':id/download')
  // Reachable without a bearer token *only* with a valid signed token bound to this exact
  // document (see DocumentAccessTokenService). The assayer app opens PDFs via
  // Linking.openURL(), which delegates to the OS browser and cannot send an Authorization
  // header — that constraint is why this endpoint was fully public, exposing bank customer
  // paperwork to anyone who could reach the API.
  @Public()
  @ApiOperation({ summary: 'Download a document using a short-lived signed token' })
  async downloadFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('token') token: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    this.documentAccessTokenService.verify(id, token);
    const doc = await this.documentService.findOne(id);

    let stat: { size: number; mtimeMs: number };
    try {
      stat = await this.localStorageService.statFile(doc.filePath);
    } catch {
      // Previously this fell back to sending a synthesized placeholder PDF, so a document
      // whose file was missing from storage still "downloaded" successfully — the assayer
      // received a stub believing it was their branch's customer data, and the underlying
      // storage failure stayed invisible. A missing file is a real error; surface it.
      throw new NotFoundException(
        `File for document ${id} is missing from storage (${doc.filePath}). It may not have been uploaded successfully.`,
      );
    }

    // Stored documents are immutable once written, so a strong validator is safe. A field
    // assayer reopening the same pre-field PDF then transfers 0 bytes instead of re-pulling
    // several MB over 2G.
    const etag = `"${id}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Advertises resumability so clients know they may request a byte range.
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', doc.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName}"`);

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    // Range support is what lets an interrupted download resume from where it stopped rather
    // than re-transferring the whole file — the difference between a recoverable blip and a
    // restart on a 5-minute 2G download.
    const range = req.headers.range as string | undefined;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;

        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
          res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
          res.end();
          return;
        }

        const clampedEnd = Math.min(end, stat.size - 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${clampedEnd}/${stat.size}`);
        res.setHeader('Content-Length', clampedEnd - start + 1);
        const partial = await this.localStorageService.getFileStream(doc.filePath, start, clampedEnd);
        partial.pipe(res);
        return;
      }
    }

    // Content-Length lets the client show real progress and detect a truncated transfer.
    res.setHeader('Content-Length', stat.size);
    const fileStream = await this.localStorageService.getFileStream(doc.filePath);
    fileStream.pipe(res);
  }

  /**
   * Authenticated callers exchange their session for a short-lived, document-scoped download
   * token. Clients that can send a bearer token (the web app) never need this; it exists for
   * the assayer app's OS-browser download handoff.
   */
  @Get(':id/download-token')
  @Roles(
    SystemRole.ASSAYER,
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.DOCUMENT_EXECUTIVE,
    // The whole data entry desk opens returned packets, not just the head, and
    // validation reviews them before they go back to the client.
    SystemRole.DATA_ENTRY_HEAD,
    SystemRole.VALIDATION_MANAGER,
    SystemRole.VALIDATOR,
  )
  @ApiOperation({ summary: 'Issue a short-lived signed download URL for a document' })
  async issueDownloadToken(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    // Confirms the document exists (and 404s if not) before minting a token for it.
    await this.documentService.findOne(id);

    // Field assayers are additionally constrained to documents that have actually
    // been dispatched to a branch they are assigned to. Previously this endpoint
    // minted a token for any document id to any assayer, so undispatched paperwork
    // — and other branches' paperwork — was downloadable.
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r);
    const isPrivileged = roles.some((r) => r !== SystemRole.ASSAYER);
    if (!isPrivileged && roles.includes(SystemRole.ASSAYER)) {
      await this.documentService.assertAssayerMayDownload(id, req.user.assayerId ?? req.user.id);
    }
    const { token, expiresAt } = this.documentAccessTokenService.issue(id);
    return {
      success: true,
      data: { downloadUrl: `/documents/${id}/download?token=${token}`, token, expiresAt },
    };
  }

  /**
   * Spec §8.6: the chain-of-custody view for one document — who moved it, when, and by what
   * method — which is what answers "where is branch X's paperwork right now".
   */
  @Get(':id/trail')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.VALIDATION_MANAGER, SystemRole.VALIDATOR, SystemRole.DATA_ENTRY_HEAD, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Full transport/chain-of-custody trail for a document' })
  async getTransportTrail(@Param('id', ParseUUIDPipe) id: string) {
    const doc = await this.documentService.findOne(id);
    return {
      success: true,
      data: {
        documentId: doc.id,
        fileName: doc.fileName,
        type: doc.type,
        status: doc.status,
        assessmentId: doc.assessmentId,
        branch: doc.assessment?.branch?.name ?? null,
        project: doc.assessment?.project?.name ?? null,
        trail: this.documentService.buildTransportTrail(doc),
      },
    };
  }

  @Patch(':id/status')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DOCUMENT_EXECUTIVE)
  @RequirePermissions('document:edit:organization')
  @ApiOperation({ summary: 'Update document status' })
  async updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: { status: DocumentStatus }, @Req() req: any) {
    const doc = await this.documentService.updateStatus(id, dto.status, req.user.id);
    return { success: true, data: doc };
  }

  @Post(':id/dispatch')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.DOCUMENT_EXECUTIVE)
  @ApiOperation({ summary: 'Dispatch a document to the assigned assessor' })
  async dispatchDocument(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const userId = req?.user?.id || id;
    const doc = await this.documentService.dispatchDocument(id, userId);
    return { success: true, data: doc, message: 'Document dispatched to assessor.' };
  }

  @Post(':id/receive')
  @Roles(SystemRole.ASSAYER, SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.DOCUMENT_EXECUTIVE)
  @ApiOperation({ summary: 'Mark a dispatched document as received back' })
  async receiveDocument(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const userId = req?.user?.id || id;
    const doc = await this.documentService.receiveDocument(id, userId);
    return { success: true, data: doc, message: 'Document marked as received.' };
  }

  @Get('project-branch/:projectBranchId/download-pdf')
  @ApiOperation({ summary: 'Directly download the Pre-Audit PDF file for a project branch' })
  async downloadBranchPdf(@Param('projectBranchId', ParseUUIDPipe) projectBranchId: string, @Req() req: any, @Res() res: Response) {
    // Resolves only from *dispatched* paperwork. This used to pick the first
    // matching document of any status — so an assayer following this link could
    // pull down a pre-audit PDF operations had not released yet.
    const { documents, readiness } = await this.documentService.findDispatchedForAssayer(projectBranchId);
    const doc = documents.find(d => d.type === DocumentType.PRE_FIELD_AUDIT_PDF) ||
                documents.find(d => d.type === DocumentType.CUSTOMER_MASTER_DATA) ||
                documents[0];
    if (!doc) {
      res.status(404).json({ success: false, message: readiness.message, readiness });
      return;
    }
    // Internal re-dispatch to the token-protected handler: the caller already passed this
    // controller's guards, so mint a token for the resolved document rather than requiring
    // the client to make a second round-trip.
    const { token } = this.documentAccessTokenService.issue(doc.id);
    return this.downloadFile(doc.id, token, req, res);
  }

  @Get('project-branch/:projectBranchId')
  @ApiOperation({ summary: 'Get documents for a project branch' })
  async findByProjectBranch(@Param('projectBranchId', ParseUUIDPipe) projectBranchId: string, @Req() req: any) {
    // Assayers get the dispatch-gated view: only paperwork operations has actually
    // released to them, never documents still being prepared internally.
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r);
    const assayerOnly = roles.includes(SystemRole.ASSAYER) && !roles.some((r) => r !== SystemRole.ASSAYER);
    if (assayerOnly) {
      const { documents, readiness } = await this.documentService.findDispatchedForAssayer(projectBranchId);
      return { success: true, data: documents, meta: { readiness } };
    }
    const list = await this.documentService.findByProjectBranch(projectBranchId);
    return { success: true, data: list };
  }

  @Get('operations/overview')
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.DOCUMENT_EXECUTIVE,
    SystemRole.DATA_ENTRY_HEAD,
  )
  @ApiOperation({ summary: 'Document control console: branch context, transport trail, pipeline and action queues' })
  async operationsOverview(
    @Query('projectId') projectId?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
  ) {
    return { success: true, data: await this.documentService.operationsOverview({ projectId, status, type }) };
  }

  @Post('upload-generated-batch')
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.DOCUMENT_EXECUTIVE,
  )
  @UseInterceptors(FilesInterceptor('files', 100))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: "Upload a day's generated audit PDFs together, matching each file to its branch by filename" })
  async uploadGeneratedBatch(
    @UploadedFiles() files: any[],
    @Query('projectId', ParseUUIDPipe) projectId: string,
    @Query('auditDate') auditDate: string,
    @Req() req: any,
    @Query('customerMasterVersionId') customerMasterVersionId?: string,
  ) {
    if (!files?.length) throw new BadRequestException('No files received.');
    if (!auditDate) throw new BadRequestException('auditDate is required.');

    const { matches, unmatched, branchesWithoutFile } =
      await this.documentService.matchPdfsToBranches(projectId, auditDate, files.map((f) => f.originalname));

    const byName = new Map(files.map((f) => [f.originalname, f]));
    const created: Array<{ documentId: string; fileName: string; branchName: string }> = [];
    const failed: Array<{ fileName: string; reason: string }> = [];

    // Only files that matched exactly one branch are stored. An unmatched file is
    // returned to the operator rather than filed against a guessed branch — a
    // misfiled packet sends one branch's customers to another branch's assayer.
    for (const m of matches) {
      const file = byName.get(m.fileName);
      if (!file) continue;
      try {
        const savedPath = await this.localStorageService.saveFile(file.originalname, file.buffer);
        const doc = await this.documentService.create({
          assessmentId: m.projectBranchId,
          fileName: file.originalname,
          filePath: savedPath,
          fileSize: file.size,
          mimeType: file.mimetype,
          type: DocumentType.PRE_FIELD_AUDIT_PDF,
          customerMasterVersionId,
        }, req.user.id);
        created.push({ documentId: doc.id, fileName: file.originalname, branchName: m.branchName });
      } catch (err) {
        failed.push({ fileName: file.originalname, reason: (err as Error).message });
      }
    }

    return {
      success: true,
      data: { created, unmatched, failed, branchesWithoutFile },
      message:
        `Filed ${created.length} of ${files.length} packet(s).` +
        (unmatched.length ? ` ${unmatched.length} could not be matched to a branch.` : '') +
        (branchesWithoutFile.length ? ` ${branchesWithoutFile.length} scheduled branch(es) still have no packet.` : ''),
    };
  }

  @Post('dispatch-batch')
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.DOCUMENT_EXECUTIVE,
  )
  @ApiOperation({ summary: 'Release several documents to their assayers in one action' })
  async dispatchBatch(@Body() body: { documentIds: string[] }, @Req() req: any) {
    if (!body?.documentIds?.length) {
      throw new BadRequestException('documentIds is required.');
    }
    const result = await this.documentService.dispatchMany(body.documentIds, req.user.id);
    return {
      success: true,
      data: result,
      message: `Dispatched ${result.dispatched.length} document(s)${result.failed.length ? `, ${result.failed.length} failed` : ''}.`,
    };
  }

  @Get('project-branch/:projectBranchId/assayer-view')
  @Roles(SystemRole.ASSAYER, SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.VALIDATION_MANAGER, SystemRole.VALIDATOR, SystemRole.DATA_ENTRY_HEAD, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: "Dispatch-gated documents for a branch, with readiness so the field app can explain what to expect" })
  async assayerBranchDocuments(@Param('projectBranchId', ParseUUIDPipe) projectBranchId: string) {
    const { documents, readiness } = await this.documentService.findDispatchedForAssayer(projectBranchId);
    return { success: true, data: documents, meta: { readiness } };
  }

  @Get('assessment/:assessmentId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.VALIDATION_MANAGER, SystemRole.VALIDATOR, SystemRole.DATA_ENTRY_HEAD, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Get documents for an assessment' })
  async findByAssessment(@Param('assessmentId', ParseUUIDPipe) assessmentId: string) {
    const list = await this.documentService.findByAssessment(assessmentId);
    return { success: true, data: list };
  }

  @Get('project/:projectId')
  @ApiOperation({ summary: 'Get all documents for a project' })
  async findByProject(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const list = await this.documentService.findByProject(projectId);
    return { success: true, data: list };
  }

  @Get()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.VALIDATION_MANAGER, SystemRole.VALIDATOR, SystemRole.DATA_ENTRY_HEAD, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Get all system documents' })
  async findAll() {
    const list = await this.documentService.findAll();
    return { success: true, data: list };
  }

  @Get('stats/summary')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.VALIDATION_MANAGER, SystemRole.VALIDATOR, SystemRole.DATA_ENTRY_HEAD, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Get document statistics' })
  async getStats() {
    const stats = await this.documentService.getDocumentStats();
    return { success: true, data: stats };
  }

  @Get('queue/data-entry')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: 'Get data entry queue — all received PDFs grouped by assessment' })
  async getDataEntryQueue() {
    const queue = await this.documentService.findDataEntryQueue();
    return { success: true, data: queue };
  }

  @Post(':id/send-external-ocr')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: 'Mark an audited PDF as sent to External OCR application' })
  async sendToExternalOcr(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    // Was a raw `assessmentRepository.update(...)` alongside a status write — the same
    // hand-rolled pattern that produced the cross-view drift repaired earlier. The service
    // owns the transition: it validates the source status, stamps the transport trail, writes
    // the audit event, and advances the assessment through the one pipeline mapping.
    const doc = await this.documentService.markSentToExternalOcr(id, req.user.id);
    return { success: true, data: doc, message: 'Audited PDF marked as sent to External OCR application.' };
  }

  @Post('upload-excel')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DATA_ENTRY_HEAD)
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

  // ── Data entry desk ───────────────────────────────────────────────────────

  @Get('data-entry/queue')
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR,
    SystemRole.DATA_ENTRY_HEAD, SystemRole.DOCUMENT_EXECUTIVE,
    SystemRole.VALIDATION_MANAGER, SystemRole.OPERATIONS_MANAGER,
  )
  @ApiOperation({ summary: "Returned packets at the data entry desk and who owns each" })
  async dataEntryQueue(@Query('assignedTo') assignedTo?: string) {
    return { success: true, data: await this.documentService.dataEntryQueue(assignedTo) };
  }

  @Get('data-entry/mine')
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR,
    SystemRole.DATA_ENTRY_HEAD, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.VALIDATOR,
  )
  @ApiOperation({ summary: 'Packets delegated to the signed-in team member' })
  async myDataEntryQueue(@Req() req: any) {
    return { success: true, data: await this.documentService.dataEntryQueue(req.user.id) };
  }

  @Get('data-entry/team')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: 'People a returned packet can be delegated to' })
  async dataEntryTeam() {
    return { success: true, data: await this.documentService.dataEntryTeam() };
  }

  @Post(':id/assign-data-entry')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: 'Delegate a returned packet to a data entry team member' })
  async assignDataEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { assigneeId: string },
    @Req() req: any,
  ) {
    const doc = await this.documentService.assignForDataEntry(id, body.assigneeId, req.user.id);
    return { success: true, data: doc };
  }

  @Post(':id/complete-data-entry')
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR,
    SystemRole.DATA_ENTRY_HEAD, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.VALIDATOR,
  )
  @ApiOperation({ summary: 'Hand a processed packet back to the data entry head' })
  async completeDataEntry(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const doc = await this.documentService.completeDataEntry(id, req.user.id);
    return { success: true, data: doc };
  }
}
