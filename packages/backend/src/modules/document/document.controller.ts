import { Controller, Logger, Get, Post, Put, Param, Query, UseGuards, ParseUUIDPipe, Req, Patch, UseInterceptors, UploadedFile, UploadedFiles, Res, Body, BadRequestException, NotImplementedException, NotFoundException, ForbiddenException, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiQuery } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsInt, IsUUID, IsEnum, IsArray, ArrayNotEmpty, Min, MaxLength, IsEmail } from 'class-validator';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { FileScanService } from '../../infrastructure/security/file-scan.service';
import { Response } from 'express';
import * as xlsx from 'xlsx';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { DocumentService } from './document.service';
import { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { OcrProcessingService } from '../../infrastructure/ocr/ocr-processing.service';
import { AssessmentEntity } from '../project/assessment.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, Public } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole, DocumentStatus, DocumentType, AssignmentStatus , DispatchMethod } from '@fapoms/shared';

import { ValidationService } from '../validation/validation.service';
import { DocumentAccessTokenService } from './document-access-token.service';
import { ChunkedUploadService } from './chunked-upload.service';
import { assertUploadAllowed } from './upload-validation';
import { AssignmentService } from '../assignment/assignment.service';


/**
 * Runtime-validated bodies for the document mutations.
 *
 * Each of these typed `@Body()` as an inline object literal. TypeScript erases that, so
 * ValidationPipe had no metadata and the values arrived unchecked — a `documentIds` of
 * `"not-an-array"` or a `status` outside the enum reached the service either way.
 */
class CreateUploadSessionRequestDto {
  @IsUUID()
  assessmentId: string;

  @IsString() @IsNotEmpty() @MaxLength(255)
  fileName: string;

  @IsInt() @Min(1)
  fileSize: number;

  @IsOptional() @IsInt() @Min(1)
  chunkSize?: number;
}

class CompleteUploadSessionRequestDto {
  @IsOptional() @IsEnum(DocumentType)
  type?: DocumentType;

  @IsOptional() @IsUUID()
  assignmentId?: string;
}

class UpdateDocumentStatusRequestDto {
  @IsEnum(DocumentStatus)
  status: DocumentStatus;
}

class DispatchBatchRequestDto {
  @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true })
  documentIds: string[];

  /**
   * Send the packets to a bank branch rather than telling the assayer to download them.
   *
   * One address for the whole batch, because the desk dispatches a branch's paperwork together
   * and typing it per document is how a batch of twelve acquires a typo in one of them.
   */
  @IsOptional() @IsEmail()
  branchEmail?: string;
}

class AssignDataEntryRequestDto {
  @IsUUID()
  assigneeId: string;
}



/** Request a presigned URL to upload a large file straight to object storage. */
class PresignUploadRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  contentType?: string;
}

/** Register a file already uploaded via a presigned URL as a document. */
class FinalizeUploadRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  objectKey: string;

  // Accepts an assessment, project-branch, or assignment id — DocumentService.create resolves it.
  @IsUUID()
  assessmentId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;

  @IsEnum(DocumentType)
  type: DocumentType;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  contentType?: string;

  @IsOptional()
  @IsUUID()
  customerMasterVersionId?: string;
}

@ApiTags('Documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('documents')
export class DocumentController {
  private readonly logger = new Logger(DocumentController.name);

  constructor(
    private readonly documentService: DocumentService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
    private readonly ocrProcessingService: OcrProcessingService,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepository: Repository<AssessmentEntity>,
    private readonly validationService: ValidationService,
    private readonly assignmentService: AssignmentService,
    private readonly documentAccessTokenService: DocumentAccessTokenService,
    private readonly chunkedUploadService: ChunkedUploadService,
    private readonly fileScanner: FileScanService,
  ) {}

  @Post('upload')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @UseInterceptors(FileInterceptor('file'), FileScanInterceptor)
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
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file content received.');
    }

    /**
     * The content-type allow-list and size cap, on the path that had neither.
     *
     * This is the door the web client walks through whenever the presigned upload fails for any
     * reason — `uploadDocumentSmart` in Documents.tsx catches *everything* and retries here — so a
     * file that /documents/upload/presign had just refused as a disallowed type was accepted and
     * stored on the very next request. The refusal only ever cost the caller a round trip.
     *
     * Enforced through the shared `assertUploadAllowed` rather than a copy of the rules, because
     * the rules being declared in one place and applied in four was how the paths came to disagree.
     */
    assertUploadAllowed({ contentType: file.mimetype, size: file.size });

    /**
     * An unrecognised `type` is an error, not a default.
     *
     * This used to fall back to PRE_FIELD_AUDIT_PDF, so a typo'd or stale query parameter did not
     * fail — it silently relabelled the document as outbound pre-field paperwork. The file was then
     * routed, dispatched and reported as something it is not, with nothing anywhere recording that a
     * guess had been made. For a system whose product is audit evidence, mislabelling a document is
     * strictly worse than refusing it: the caller can retry a rejection, but nobody can spot a
     * confident wrong label months later. Name the valid values so the caller can fix it.
     */
    const validTypes = Object.values(DocumentType) as string[];
    if (!type || !validTypes.includes(type as any)) {
      throw new BadRequestException(
        `"${type ?? ''}" is not a valid document type. Valid types: ${validTypes.join(', ')}.`,
      );
    }
    const targetType = type;

    const savedPath = await this.storage.saveFile(file.originalname, file.buffer, file.mimetype);

    // Customer master data upload endpoint accepts documents of type CUSTOMER_MASTER_DATA

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

  /**
   * Direct-to-storage upload for large back-office files (generated PDF batches, customer
   * master). The bytes go straight from the client to object storage via a presigned PUT, so
   * they never buffer through this process — the API only mints the URL and, on finalize,
   * records the resulting object as a document.
   *
   * Flow: presign → client PUTs to the returned URL → finalize. Requires an S3/MinIO backend
   * (the local-disk driver has no presign; callers there use POST /documents/upload or the
   * chunked endpoints). The bucket must allow PUT from the caller's origin (CORS). Objects
   * that are presigned but never finalized are orphaned — reap them with a storage lifecycle
   * rule on the `documents/direct/` prefix.
   */
  @Post('upload/presign')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Get a presigned URL to upload a file directly to object storage' })
  async presignUpload(@Body() body: PresignUploadRequestDto) {
    if (typeof this.storage.getSignedUploadUrl !== 'function') {
      /**
       * 501, not 400 — this says nothing is wrong with the *request*, the deployment simply has no
       * object store. The distinction is load-bearing now that the web client stops falling back to
       * the multipart route on a 4xx: a 400 here would be read as "this file was refused" and the
       * upload would fail outright on every local-disk deployment, where falling back is correct.
       */
      throw new NotImplementedException(
        'Direct-to-storage upload is not available on this storage backend. Use POST /documents/upload or the resumable chunked upload endpoints.',
      );
    }
    const contentType = body.contentType || 'application/octet-stream';
    // No bytes exist yet, so only the declared type is checkable here; finalize re-applies the
    // same helper with the object's real size once it has landed.
    assertUploadAllowed({ contentType });
    const safeName = (body.fileName || 'upload.bin').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'upload.bin';
    const objectKey = `documents/direct/${randomUUID()}/${safeName}`;
    const expiresIn = 900; // 15 minutes to complete the PUT
    const uploadUrl = await this.storage.getSignedUploadUrl(objectKey, contentType, expiresIn);
    return {
      success: true,
      data: { objectKey, uploadUrl, method: 'PUT', headers: { 'Content-Type': contentType }, expiresIn },
    };
  }

  @Post('upload/finalize')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Register a file uploaded via a presigned URL as a document' })
  async finalizeUpload(@Body() body: FinalizeUploadRequestDto, @Req() req: any) {
    // Only keys minted by presignUpload can be finalized — never an arbitrary storage key,
    // so a caller cannot register another namespace's object (a pre-field PDF, someone
    // else's return) as their own document.
    if (!body.objectKey.startsWith('documents/direct/')) {
      throw new BadRequestException('objectKey is not a direct-upload key issued by /documents/upload/presign.');
    }
    // Confirm the object actually landed before creating a row that claims it did.
    let size = 0;
    try {
      size = (await this.storage.statFile(body.objectKey)).size;
    } catch {
      throw new BadRequestException('No uploaded object found at objectKey. Complete the presigned PUT before finalizing.');
    }
    if (!size || size <= 0) {
      throw new BadRequestException('Uploaded object is empty.');
    }
    try {
      // Both halves, not just the size: the presign step vouched for a declared content type, but
      // finalize accepts an objectKey and a contentType as separate fields, so nothing tied the
      // finalized document's type back to the one that was presigned.
      assertUploadAllowed({ contentType: body.contentType, size });
    } catch (err) {
      // Delete the rejected object so an over-limit or wrong-type PUT can't leave a costly orphan.
      await this.storage.deleteFile(body.objectKey).catch(() => undefined);
      throw err;
    }
    // Malware-scan the object the client PUT straight to storage — the presigned upload bypassed the
    // API, so this is the first point the bytes can be inspected. Delete + reject on a hit (or when a
    // required scan can't run), so an infected object is never registered as a document.
    try {
      const stream = await this.storage.getFileStream(body.objectKey);
      const parts: Buffer[] = [];
      for await (const chunk of stream as any) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      await this.fileScanner.scanOrThrow(Buffer.concat(parts), body.fileName);
    } catch (err) {
      await this.storage.deleteFile(body.objectKey).catch(() => undefined);
      throw err;
    }

    const doc = await this.documentService.create(
      {
        assessmentId: body.assessmentId,
        fileName: body.fileName,
        filePath: body.objectKey,
        fileSize: size,
        mimeType: body.contentType,
        type: body.type,
        customerMasterVersionId: body.customerMasterVersionId,
      },
      req?.user?.id || '00000000-0000-0000-0000-000000000000',
    );

    return { success: true, data: doc };
  }

  @Post('mobile-upload')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Mobile JSON-based document upload (no multipart)' })
  async mobileUpload(@Body() body: any, @Req() req: any) {
    let targetId = body.projectBranchId || body.assessmentId || body.assignmentId;
    if (body.assignmentId && !body.projectBranchId && !body.assessmentId) {
      const assignment = await this.assignmentRepository.findOne({ where: { id: body.assignmentId } }).catch(() => null);
      if (assignment?.projectBranchId) {
        targetId = assignment.projectBranchId;
      }
    }

    await this.assertMaySubmitReturnFor(req.user, body.assignmentId);

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
    // The binary sibling below caps its uploads; this one did not, so the *larger* of the two
    // encodings (base64 inflates by a third) was the unbounded one. The type is fixed at PDF by
    // this route, so only the size is in question here.
    assertUploadAllowed({
      contentType: 'application/pdf',
      size: buffer.length,
      hint: 'Scan at a lower quality, or split it.',
    });

    const savedFilePath = await this.storage.saveFile(fileName, buffer, 'application/pdf');

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
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @UseInterceptors(FileInterceptor('file'), FileScanInterceptor)
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

    /**
     * The same content-type allow-list and size cap the presigned path applies.
     *
     * They were declared once and enforced only where a presigned URL is minted, so this route —
     * the one the assayer app's "Scan & submit audited return" button actually uses, and the only
     * upload path a field device takes — had neither. Verified against a running server: 60 MB of
     * random bytes declared `application/zip` was accepted and stored as an AUDITED_RETURN_PDF,
     * well over the documented 50 MB limit and a type that is not on the list at all.
     *
     * That matters twice over. The obvious half is storage: any signed-in assayer could fill the
     * volume from a phone. The half that matters more is that everything here flows onward into
     * OCR and data entry as though it were an audit return, so a file that is not what it claims
     * enters the paperwork pipeline for a bank collateral audit.
     *
     * The declared type is still only a declaration — magic-byte sniffing remains the next layer,
     * as the note on `ALLOWED_UPLOAD_TYPES` says. This closes the gap between the two upload
     * routes; it does not pretend to be content verification.
     */
    assertUploadAllowed({
      contentType: file.mimetype || 'application/pdf',
      size: file.size,
      hint: 'Scan at a lower quality, or split it.',
    });

    await this.assertMaySubmitReturnFor(req.user, assignmentId);

    let targetId = assessmentId || assignmentId;
    if (assignmentId && !assessmentId) {
      const assignment = await this.assignmentRepository
        .findOne({ where: { id: assignmentId } })
        .catch(() => null);
      if (assignment?.projectBranchId) targetId = assignment.projectBranchId;
    }

    const savedFilePath = await this.storage.saveFile(file.originalname, file.buffer, file.mimetype || 'application/pdf');
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

  /**
   * An assayer may only submit the audited return for an assignment that is actually theirs.
   *
   * Both mobile upload endpoints took `assignmentId` straight from the request and passed it
   * to `completeAssignmentForReturn`, which cascades into the project-branch state machine,
   * the schedule, the assessment status, the validation case, the audit trail and the
   * assayer's own completion statistics. With only `@Roles(ASSAYER, ...)` on the route and no
   * ownership check, any authenticated assayer could submit a PDF against any other assayer's
   * assignment id and have that branch recorded as audited — a falsified collateral-audit
   * record for a branch nobody visited, delivered to the bank as genuine.
   *
   * Staff roles are deliberately still allowed through so back-office can upload on an
   * assayer's behalf (a real workflow when a scan arrives by email); `createdBy` on the
   * document preserves who actually did it.
   */
  private async assertMaySubmitReturnFor(user: any, assignmentId?: string): Promise<void> {
    const roles: string[] = (user?.roles ?? []).map((r: any) => (typeof r === 'string' ? r : r?.name)).filter(Boolean);
    if (!roles.includes(SystemRole.ASSAYER)) return; // staff path, already role-gated
    if (!assignmentId) {
      throw new BadRequestException('An assignment must be specified when submitting an audited return.');
    }

    const assignment = await this.assignmentRepository
      .findOne({ where: { id: assignmentId } })
      .catch(() => null);

    if (!assignment) {
      throw new NotFoundException('That assignment could not be found.');
    }
    if (assignment.assayerId !== user?.id) {
      this.logger.warn(
        `Assayer ${user?.id} attempted to submit an audited return for assignment ${assignmentId}, which belongs to ${assignment.assayerId}.`,
      );
      throw new ForbiddenException('You can only submit paperwork for an assignment that is assigned to you.');
    }
  }

  // ── Resumable chunked upload ───────────────────────────────────────────────────
  // Field uploads happen on rural 2G/weak-3G where a multi-minute single-request upload
  // frequently drops and, previously, restarted from zero. These three endpoints let a client
  // send fixed-size chunks, ask what survived a disconnect, and transmit only the gaps.

  @Post('upload/session')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Open a resumable upload session' })
  async createUploadSession(
    @Body() body: CreateUploadSessionRequestDto,
    @Req() req: any,
  ) {
    if (!body?.assessmentId || !body?.fileName) {
      throw new BadRequestException('assessmentId and fileName are required.');
    }
    const session = await this.chunkedUploadService.createSession({
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
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Resume: report which chunks the server already holds' })
  async getUploadSession(@Param('uploadId') uploadId: string) {
    const session = await this.chunkedUploadService.getSession(uploadId);
    const received = await this.chunkedUploadService.receivedChunks(uploadId);
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
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
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
    const progress = await this.chunkedUploadService.saveChunk(uploadId, Number(index), chunk.buffer);
    return { success: true, data: { ...progress, index: Number(index) } };
  }

  @Get('upload/session/:uploadId/chunk/:index/presigned-url')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Get a direct pre-signed PUT URL for uploading one chunk directly to MinIO (low 2G/3G optimization)' })
  async getChunkPresignedUrl(
    @Param('uploadId') uploadId: string,
    @Param('index') index: string,
  ) {
    const data = await this.chunkedUploadService.getPresignedPartUrl(uploadId, Number(index));
    return { success: true, data: { ...data, index: Number(index) } };
  }

  @Post('upload/session/:uploadId/complete')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Assemble the chunks into the final document' })
  async completeUpload(
    @Param('uploadId') uploadId: string,
    @Body() body: CompleteUploadSessionRequestDto,
    @Req() req: any,
  ) {
    const type = body?.type && (Object.values(DocumentType) as string[]).includes(body.type)
      ? body.type
      : DocumentType.AUDITED_RETURN_PDF;

    // assemble() calls S3 CompleteMultipartUpload — the object is now in MinIO
    // under s3Key. No buffer assembly happens in this process; no filesystem I/O.
    const { s3Key, session } = await this.chunkedUploadService.assemble(uploadId);

    // Scan the assembled object before registering it. Chunks are meaningless individually, so this
    // is the correct point to inspect the whole file; reject + delete on a hit.
    try {
      const stream = await this.storage.getFileStream(s3Key);
      const parts: Buffer[] = [];
      for await (const chunk of stream as any) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      await this.fileScanner.scanOrThrow(Buffer.concat(parts), session.fileName);
    } catch (err) {
      await this.storage.deleteFile(s3Key).catch(() => undefined);
      await this.chunkedUploadService.discard(uploadId).catch(() => undefined);
      throw err;
    }

    const doc = await this.documentService.create(
      {
        assessmentId: session.assessmentId,
        fileName: session.fileName,
        filePath: s3Key,        // store the S3 object key, not a filesystem path
        fileSize: session.fileSize,
        mimeType: 'application/pdf',
        type,
      },
      req.user.id,
    );

    // Redis session entry is cleaned up only after the DB record is safely persisted.
    // If create() throws, the multipart upload stays open in MinIO and the client
    // can retry completion without re-uploading any chunks.
    await this.chunkedUploadService.discard(uploadId);

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
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.OPERATIONS)
  @RequirePermissions('document:create:organization')
  @UseInterceptors(FileInterceptor('file'), FileScanInterceptor)
  @ApiOperation({ summary: 'Validate Customer Master Excel file' })
  async validateCustomerExcel(@UploadedFile() file: any) {
    // A submitted form with no file attached reaches here as `undefined`, and reading
    // `.buffer` off it threw a TypeError the caller saw as "Internal server error". Ops
    // needs to be told to pick a file, not shown a crash.
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    }
    const workbook = xlsx.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rows: any[] = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const totalRows = rows.length;
    let duplicateAccountsCount = 0;
    let missingBranchesCount = 0;
    const accountNumbersSeen = new Set<string>();
    const solIdsSeen = new Set<string>();

    for (const row of rows) {
      const acc = String(row['Account Number'] || row.ACCOUNT_NO || row.AccountNo || '').trim();
      const solId = String(row['SOL ID'] || row.SOL_ID || row.SolId || row['Branch Code'] || row.BRANCH_CODE || row.BranchCode || row['BRANCH'] || row.Branch || '').trim();
      if (acc) {
        if (accountNumbersSeen.has(acc)) duplicateAccountsCount++;
        else accountNumbersSeen.add(acc);
      }
      if (solId) {
        solIdsSeen.add(solId);
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
          uniqueBranchesCount: solIdsSeen.size,
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
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
      stat = await this.storage.statFile(doc.filePath);
    } catch (err: any) {
      /**
       * A missing file is reported as missing.
       *
       * This previously synthesised a valid-but-blank PDF and returned it with HTTP 200, the
       * real MIME type and the real filename — so a validator, or the bank client, would open
       * the audited return, see an empty page, and reasonably conclude the audit produced
       * nothing. Nothing in the response, the database row, or the logs distinguished that from
       * a genuine empty submission. For a document that is legal evidence in a collateral
       * audit, silently substituting a fake is the worst available behaviour: it converts a
       * detectable storage failure into an undetectable evidentiary one.
       *
       * The original justification was "don't break download links with a 404". A broken link
       * that says so is recoverable; a blank document that looks fine is not.
       */
      this.logger.error(
        `Document ${id} (${doc.fileName}) has a database row but no file at ${doc.filePath}: ${err?.message}`,
      );
      throw new NotFoundException(
        'This document could not be found in storage. The record exists but the file is missing — please report this to your administrator, and do not treat it as an empty submission.',
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
    // `doc.fileName` is stored from client-supplied input on the JSON upload routes, so a quote or
    // a CR/LF in it would break out of the quoted value and corrupt (or split) the response
    // header. Strip the header-breaking characters from the quoted fallback and add the RFC 5987
    // `filename*` form for correct Unicode — the same shape the report exports already use.
    const safeName = (doc.fileName || 'document.pdf').replace(/[\r\n"]/g, '_');
    const encodedName = encodeURIComponent(doc.fileName || 'document.pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`);

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
        const partial = await this.storage.getFileStream(doc.filePath, start, clampedEnd);
        partial.pipe(res);
        return;
      }
    }

    // Content-Length lets the client show real progress and detect a truncated transfer.
    res.setHeader('Content-Length', stat.size);
    const fileStream = await this.storage.getFileStream(doc.filePath);
    fileStream.pipe(res);
  }

  /**
   * Authenticated callers exchange their session for a short-lived, document-scoped download
   * token. Clients that can send a bearer token (the web app) never need this; it exists for
   * the assayer app's OS-browser download handoff.
   */
  @Get(':id/download-token')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, // The whole data entry desk opens returned packets, not just the head, and
    // validation reviews them before they go back to the client.
    SystemRole.DESK, SystemRole.DESK_OPERATOR)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
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

  /**
   * The states a packet reaches by being moved, each with the route that moves it.
   *
   * Every one of these has side effects that the status alone does not carry: dispatching
   * stamps who sent it, when and how, syncs the assessment and notifies the assayer;
   * receiving stamps the return; delegating names an owner. Writing the status directly
   * produced a document that claimed to have been dispatched with an empty transport trail
   * and nobody told — and, because the assayer's view keys off DISPATCHED, released client
   * paperwork to the field with no record of anyone having released it.
   */
  private static readonly STATUS_HAS_ITS_OWN_ROUTE: Partial<Record<DocumentStatus, string>> = {
    [DocumentStatus.DISPATCHED]: 'POST /documents/:id/dispatch',
    [DocumentStatus.RECEIVED]: 'POST /documents/:id/receive',
    [DocumentStatus.SENT_TO_DATA_ENTRY]: 'POST /documents/:id/assign-data-entry',
    [DocumentStatus.SENT_TO_EXTERNAL_OCR]: 'POST /documents/:id/send-external-ocr',
  };

  @Patch(':id/status')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @RequirePermissions('document:edit:organization')
  @ApiOperation({
    summary: 'Update document status',
    description:
      'For the back-office end of the pipeline only. States reached by an act — dispatched, '
      + 'received, delegated, sent to OCR — have their own routes, which record the act. '
      + 'A packet only ever moves forward; see DOCUMENT_TRANSITIONS.',
  })
  async updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDocumentStatusRequestDto, @Req() req: any) {
    const properRoute = DocumentController.STATUS_HAS_ITS_OWN_ROUTE[dto.status];
    if (properRoute) {
      throw new BadRequestException(
        `Use ${properRoute} to move a document to ${dto.status}. Setting the status directly `
        + 'would leave the packet claiming a hand-off that never happened — no timestamp, no '
        + 'record of who did it, and nobody notified.',
      );
    }
    const doc = await this.documentService.updateStatus(id, dto.status, req.user.id);
    return { success: true, data: doc };
  }

  /**
   * `branchEmail` sends the packet to the bank branch instead of telling the assayer to download
   * it — how several clients work, with the assayer collecting it there. Absent, this behaves
   * exactly as it always has.
   */
  @Post(':id/dispatch')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Dispatch a document to the assayer, or email it to a branch' })
  async dispatchDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { branchEmail?: string } | undefined,
    @Req() req: any,
  ) {
    const userId = req?.user?.id || id;
    const doc = await this.documentService.dispatchDocument(id, userId, DispatchMethod.MANUAL, {
      branchEmail: body?.branchEmail,
    });
    return {
      success: true,
      data: doc,
      message: doc.dispatchedToEmail
        ? `Sent to ${doc.dispatchedToEmail}. The assayer has been told to collect it there.`
        : 'Document dispatched to assessor.',
    };
  }

  @Post(':id/receive')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Mark a dispatched document as received back' })
  async receiveDocument(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const userId = req?.user?.id || id;
    const doc = await this.documentService.receiveDocument(id, userId);
    return { success: true, data: doc, message: 'Document marked as received.' };
  }

  @Get('project-branch/:projectBranchId/download-pdf')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
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
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
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

  // Must admit every role the frontend /documents route (and the document-list gate) allows, or the
  // page's first call 403s and renders only an error banner for validation/audit viewers.
  @Get('operations/overview')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'Document control console: branch context, transport trail, pipeline and action queues' })
  @ApiQuery({ name: 'page', required: false, description: 'Branch list page (1-based).' })
  @ApiQuery({ name: 'limit', required: false, description: 'Branch rows per page; clamped server-side.' })
  @ApiQuery({ name: 'search', required: false, description: 'Matches branch name/code, project or client.' })
  @ApiQuery({ name: 'stage', required: false, description: "A DocumentStatus the branch is sitting at, or 'NEVER_PREPARED'." })
  async operationsOverview(
    @Query('projectId') projectId?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('stage') stage?: string,
  ) {
    const data = await this.documentService.operationsOverview({ projectId, status, type, page, limit, search, stage });
    // `pagination` describes `data.branches` only — the one array here that is a window rather
    // than a complete set. Same shape the other paged lists emit (see branch.controller.ts).
    const { page: p, limit: l, total } = data.branchPagination;
    return {
      success: true,
      data,
      meta: {
        pagination: {
          page: p, limit: l, total,
          totalPages: Math.ceil(total / l),
          hasNext: p * l < total,
          hasPrevious: p > 1,
        },
      },
    };
  }

  @Post('upload-generated-batch')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @UseInterceptors(FilesInterceptor('files', 100), FileScanInterceptor)
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
        const savedPath = await this.storage.saveFile(file.originalname, file.buffer, file.mimetype);
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Release several documents to their assayers in one action' })
  async dispatchBatch(@Body() body: DispatchBatchRequestDto, @Req() req: any) {
    if (!body?.documentIds?.length) {
      throw new BadRequestException('documentIds is required.');
    }
    const result = await this.documentService.dispatchMany(body.documentIds, req.user.id, body.branchEmail);
    return {
      success: true,
      data: result,
      message: `Dispatched ${result.dispatched.length} document(s)${result.failed.length ? `, ${result.failed.length} failed` : ''}.`,
    };
  }

  @Get('project-branch/:projectBranchId/assayer-view')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @ApiOperation({ summary: "Dispatch-gated documents for a branch, with readiness so the field app can explain what to expect" })
  async assayerBranchDocuments(@Param('projectBranchId', ParseUUIDPipe) projectBranchId: string) {
    const { documents, readiness } = await this.documentService.findDispatchedForAssayer(projectBranchId);
    return { success: true, data: documents, meta: { readiness } };
  }

  @Get('assessment/:assessmentId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'Get documents for an assessment' })
  async findByAssessment(@Param('assessmentId', ParseUUIDPipe) assessmentId: string) {
    const list = await this.documentService.findByAssessment(assessmentId);
    return { success: true, data: list };
  }

  @Get('project/:projectId')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get all documents for a project' })
  async findByProject(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const list = await this.documentService.findByProject(projectId);
    return { success: true, data: list };
  }

  @Get()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'Get all system documents' })
  async findAll() {
    const list = await this.documentService.findAll();
    return { success: true, data: list };
  }

  @Get('stats/summary')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'Get document statistics' })
  async getStats() {
    const stats = await this.documentService.getDocumentStats();
    return { success: true, data: stats };
  }

  @Get('queue/data-entry')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @ApiOperation({ summary: 'Get data entry queue — all received PDFs grouped by assessment' })
  async getDataEntryQueue() {
    const queue = await this.documentService.findDataEntryQueue();
    return { success: true, data: queue };
  }

  @Post(':id/send-external-ocr')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
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
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @UseInterceptors(FileInterceptor('file'), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload generated Excel report for an assessment from External OCR' })
  async uploadExcelReport(
    @UploadedFile() file: any,
    @Query('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Req() req: any,
  ) {
    const savedPath = await this.storage.saveFile(
      file?.originalname || `report_${assessmentId}.xlsx`,
      file?.buffer || Buffer.from(''),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    const doc = await this.documentService.create({
      assessmentId,
      fileName: file?.originalname || `report_${assessmentId}.xlsx`,
      filePath: savedPath,
      fileSize: file?.size || 0,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      type: DocumentType.GENERATED_EXCEL,
    }, req?.user?.id || assessmentId);

    await this.documentService.updateStatus(doc.id, DocumentStatus.COMPLETED, req?.user?.id || 'SYSTEM');

    return { success: true, data: doc, message: 'Excel report uploaded. The document is marked completed.' };
  }

  // ── Data entry desk ───────────────────────────────────────────────────────

  @Get('data-entry/queue')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.OPERATIONS, SystemRole.AUDITOR)
  @ApiOperation({ summary: "Returned packets at the data entry desk and who owns each" })
  async dataEntryQueue(
    @Query('assignedTo') assignedTo?: string,
    @Query('lane') lane?: 'unassigned' | 'working' | 'rework' | 'done',
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return { success: true, data: await this.documentService.dataEntryQueue({ assignedTo, lane, search, page, limit }) };
  }

  @Get('data-entry/mine')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @ApiOperation({ summary: 'Packets delegated to the signed-in team member' })
  async myDataEntryQueue(
    @Req() req: any,
    @Query('lane') lane?: 'unassigned' | 'working' | 'rework' | 'done',
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return { success: true, data: await this.documentService.dataEntryQueue({ assignedTo: req.user.id, lane, search, page, limit }) };
  }

  @Get('data-entry/team')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @ApiOperation({ summary: 'People a returned packet can be delegated to' })
  async dataEntryTeam() {
    return { success: true, data: await this.documentService.dataEntryTeam() };
  }

  @Post(':id/assign-data-entry')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @ApiOperation({ summary: 'Delegate a returned packet to a data entry team member' })
  async assignDataEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignDataEntryRequestDto,
    @Req() req: any,
  ) {
    const doc = await this.documentService.assignForDataEntry(id, body.assigneeId, req.user.id);
    return { success: true, data: doc };
  }

  @Post(':id/complete-data-entry')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @ApiOperation({ summary: 'Hand a processed packet back to the data entry head' })
  async completeDataEntry(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const doc = await this.documentService.completeDataEntry(id, req.user.id);
    return { success: true, data: doc };
  }
}
