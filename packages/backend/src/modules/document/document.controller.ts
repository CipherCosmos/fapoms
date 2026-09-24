import { Controller, Logger, Get, Post, Put, Param, Query, UseGuards, ParseUUIDPipe, Req, Patch, UseInterceptors, UploadedFile, UploadedFiles, Res, Body, BadRequestException, NotImplementedException, NotFoundException, ForbiddenException, ConflictException, Inject, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiQuery } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsInt, IsUUID, IsEnum, IsArray, ArrayNotEmpty, Min, MaxLength, IsEmail } from 'class-validator';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { FileScanService } from '../../infrastructure/security/file-scan.service';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { DocumentService } from './document.service';
import type { DocumentEntity } from './document.entity';
import { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { OcrProcessingService } from '../../infrastructure/ocr/ocr-processing.service';
import { AssessmentEntity } from '../project/assessment.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, Public, AllowPermissionFallback } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole, DocumentStatus, DocumentType, AssignmentStatus , DispatchMethod, OTHER_CONFLICT_ERROR_CODES, isAssignmentTerminal, AssignmentAction } from '@fapoms/shared';
import { evaluateOwnership, evaluateSubmitReturn } from '../assignment/assignment-capabilities';
import { IN_FLIGHT_ASSIGNMENT_STATUSES } from '../assignment/assignment-workload';
import { withCode } from '../../infrastructure/http/api-error';

import { ValidationService } from '../validation/validation.service';
import { DocumentAccessTokenService } from './document-access-token.service';
import { ChunkedUploadService } from './chunked-upload.service';
import { assertUploadAllowed, uploadMulterOptions, diskUploadMulterOptions, MAX_UPLOAD_BYTES, MAX_RESUMABLE_UPLOAD_BYTES, SPREADSHEET_UPLOAD_TYPES, SCAN_UPLOAD_TYPES } from './upload-validation';
import { DiskUploadScanInterceptor } from './disk-upload-scan.interceptor';
import { DocumentDispatchJobsService } from './document-dispatch-jobs.service';
import { jobActorFrom } from '../../infrastructure/queue/job-actor';
import { createReadStream } from 'fs';
import { AssignmentService } from '../assignment/assignment.service';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { AuditRead } from '../../core/audit/audit-read.decorator';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';
import { buildPaginationMeta } from '../../infrastructure/http/pagination';
import { deriveFileIntegrity, verifyClientHash } from './document-integrity';

/**
 * Multer memory-storage configuration shared by the single-file document upload routes.
 *
 * Every `FileInterceptor`/`FilesInterceptor` on this controller used to declare no `limits` at
 * all, so multer buffered an entire file into memory — of any size — before the handler's own
 * `assertUploadAllowed` size check ever ran. A request body multer never caps is a request body
 * the process cannot bound the memory cost of, regardless of what the handler goes on to check.
 * `MAX_UPLOAD_BYTES` is the same ceiling `assertUploadAllowed` enforces by default on these
 * routes (see `upload-validation.ts`), so the multer-level cap and the app-level cap agree —
 * multer just gets to reject the oversized request earlier, mid-stream, rather than after the
 * whole file has already landed in the process.
 */
const documentUploadMulterOptions = uploadMulterOptions({ maxBytes: MAX_UPLOAD_BYTES });

/**
 * Same ceiling as `documentUploadMulterOptions`, plus the per-request file-count cap that already
 * exists as the interceptor's own `maxCount` argument — restated here so multer enforces both at the
 * streaming layer.
 *
 * Disk, not memory, and this is the one route where that is right. A day's batch is up to 100 files
 * of up to 50 MB each, and in memory that was up to 5 GB held at once in an API container capped at
 * 1.5 GB — one large batch could get the API killed for every user. On disk the batch costs one file
 * at a time: `DiskUploadScanInterceptor` reads each back to scan it, and the handler streams each
 * one to storage. See `diskUploadMulterOptions`.
 */
const documentBatchUploadMulterOptions = diskUploadMulterOptions({ maxBytes: MAX_UPLOAD_BYTES, maxFiles: 100 });

/**
 * The resumable-chunk upload route has no `assertUploadAllowed` call of its own — each PUT is
 * one slice of a file whose *total* size was already checked against `MAX_RESUMABLE_UPLOAD_BYTES`
 * when the session was opened (`ChunkedUploadService.createSession`). A single chunk can
 * therefore never legitimately exceed that same ceiling, so it is reused here as the multer-level
 * cap rather than inventing a separate number for chunks.
 */
const resumableChunkMulterOptions = uploadMulterOptions({ maxBytes: MAX_RESUMABLE_UPLOAD_BYTES });

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
    private readonly regionGuard: RegionGuardService,
    private readonly dispatchJobs: DocumentDispatchJobsService,
  ) {}

  @Post('upload')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @RequirePermissions('document:upload:organization')
  @UseInterceptors(FileInterceptor('file', documentUploadMulterOptions), FileScanInterceptor)
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

    /**
     * Derived before the bytes leave this scope, because this is the only place they exist.
     *
     * Everything the row used to record about content came from the request: `file.mimetype` is
     * the `Content-Type` the client wrote into its own multipart header, and there was no hash at
     * all. A client-supplied `sha256` is accepted here only to be checked against the one computed
     * from the buffer — it is a useful transit checksum and never the authority.
     */
    const integrity = deriveFileIntegrity(file.buffer, file.mimetype);
    const clientHash = verifyClientHash(integrity, (req?.body?.sha256 ?? null) as string | null);
    if (clientHash.supplied && !clientHash.matches) {
      throw withCode(new BadRequestException(
        'UPLOAD_CHECKSUM_MISMATCH: the bytes received do not match the sha256 supplied with them. '
        + 'Nothing was stored. Retry the upload.',
      ), OTHER_CONFLICT_ERROR_CODES.UPLOAD_CHECKSUM_MISMATCH);
    }

    const savedPath = await this.storage.saveFile(file.originalname, file.buffer, integrity.effectiveMimeType);

    // Customer master data upload endpoint accepts documents of type CUSTOMER_MASTER_DATA

    const doc = await this.documentService.create({
      assessmentId,
      fileName: file.originalname,
      filePath: savedPath,
      fileSize: file.size,
      mimeType: file.mimetype,
      type: targetType,
      customerMasterVersionId,
      integrity,
    }, req?.user?.id || '00000000-0000-0000-0000-000000000000');

    return doc;
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
  // The URL this mints is a write credential for the bucket, so it asks for the same permission
  // as the upload it stands in for — not a lesser one because no bytes move on this request.
  @RequirePermissions('document:upload:organization')
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
    return { objectKey, uploadUrl, method: 'PUT', headers: { 'Content-Type': contentType }, expiresIn };
  }

  @Post('upload/finalize')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @RequirePermissions('document:upload:organization')
  @ApiOperation({ summary: 'Register a file uploaded via a presigned URL as a document' })
  async finalizeUpload(@Body() body: FinalizeUploadRequestDto, @Req() req: any) {
    // Only keys minted by presignUpload can be finalized — never an arbitrary storage key,
    // so a caller cannot register another namespace's object (a pre-field PDF, someone
    // else's return) as their own document.
    if (!body.objectKey.startsWith('documents/direct/')) {
      throw new BadRequestException('objectKey is not a direct-upload key issued by /documents/upload/presign.');
    }
    /**
     * Idempotent, not merely repeatable. Verified live: finalizing the same objectKey twice
     * created two separate `documents` rows pointing at the identical storage object — the same
     * packet then double-counted everywhere a branch's documents are listed or dispatched
     * (operations overview, data-entry queue), and could be dispatched/notified twice for what
     * is genuinely one file. A retry here is not a hypothetical: this is the one upload route
     * whose bytes travel client→storage directly, so the client's own network can drop the
     * finalize response after the server already succeeded, and an honest retry resends the
     * identical request. Short-circuit before repeating the stat/scan/create work.
     */
    const existing = await this.documentService.findByFilePath(body.objectKey);
    if (existing) {
      return existing;
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
    /**
     * The presigned PUT bypassed the API, so these bytes did not arrive through it — but the
     * malware scan reads the whole object back to inspect it, and that buffer is as good a source
     * of truth as an upload buffer. It attests to what storage holds at registration time, which
     * is precisely what a document's integrity metadata should say.
     *
     * The earlier position was that this route cannot hash what it never receives. That is true
     * of the PUT and false of finalize as implemented: the object is already fully in memory
     * here, and the cost is already being paid by the scan.
     */
    let integrity: ReturnType<typeof deriveFileIntegrity> | undefined;
    try {
      const stream = await this.storage.getFileStream(body.objectKey);
      const parts: Buffer[] = [];
      for await (const chunk of stream as any) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const stored = Buffer.concat(parts);
      await this.fileScanner.scanOrThrow(stored, body.fileName, body.contentType);
      integrity = deriveFileIntegrity(stored, body.contentType);
    } catch (err) {
      await this.storage.deleteFile(body.objectKey).catch(() => undefined);
      throw err;
    }

    // The client wrote this object straight into the store, so the app never had the chance to
    // encrypt it on the way in. It is encrypted here, after it has passed the scan and before it is
    // registered — see document-cipher.ts. A failure leaves no plaintext document on the record.
    try {
      await this.storage.sealObject?.(body.objectKey);
    } catch (err) {
      await this.storage.deleteFile(body.objectKey).catch(() => undefined);
      throw err;
    }

    const doc = await this.documentService.create(
      {
        assessmentId: body.assessmentId,
        fileName: body.fileName,
        filePath: body.objectKey,
        // `size` comes from a real HeadObject, so it was already trustworthy; the derived count
        // is used anyway so one source describes every field.
        fileSize: integrity?.byteLength ?? size,
        mimeType: body.contentType,
        type: body.type,
        customerMasterVersionId: body.customerMasterVersionId,
        integrity,
      },
      req?.user?.id || '00000000-0000-0000-0000-000000000000',
    );

    return doc;
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

    const ownAssignment = await this.assertMaySubmitReturnFor(req.user, { assignmentId: body.assignmentId });

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

    // A finished job: the same bytes again are a retry of a delivered upload and get the stored
    // document back; different bytes are refused. Nothing is scanned or written for a replay.
    const replay = await this.replayOrRefuseOnFinishedJob(ownAssignment, deriveFileIntegrity(buffer, 'application/pdf').sha256);
    if (replay && ownAssignment) {
      return {
        success: true,
        assignmentCompletion: this.replayedCompletion(ownAssignment),
        data: replay,
        documentUrl: `/documents/${replay.id}/download`,
      };
    }

    // Malware scan BEFORE the file is stored — this JSON base64 route bypassed the
    // FileScanInterceptor that guards every multipart upload route (the interceptor reads a
    // multipart file, not a base64 body), so an audited-return PDF arriving here reached storage
    // and the data-entry pipeline unscanned. `scanOrThrow` fails closed when scanning is required.
    await this.fileScanner.scanOrThrow(buffer, fileName, 'application/pdf');

    /**
     * The JSON sibling of `mobile-upload-binary`, and it must describe its bytes the same way.
     *
     * Both routes produce an `AUDITED_RETURN_PDF`, both mark it RECEIVED, both feed the data-entry
     * queue. Only the binary one derived integrity, so a client that preferred no digest on its
     * audit evidence could simply post base64 to this one instead. The bytes are fully in hand
     * either way — `Buffer.from(body.fileData, 'base64')` above.
     */
    const integrity = deriveFileIntegrity(buffer, 'application/pdf');
    const savedFilePath = await this.storage.saveFile(fileName, buffer, integrity.effectiveMimeType);

    let doc = await this.documentService.create({
      assessmentId: targetId,
      fileName,
      filePath: savedFilePath,
      fileSize: integrity.byteLength,
      mimeType: 'application/pdf',
      type: DocumentType.AUDITED_RETURN_PDF,
      integrity,
    }, req?.user?.id || '00000000-0000-0000-0000-000000000000');

    // Marks the assayer's paperwork as returned, which is what puts it into the Data Entry
    // Head's queue. This was `.catch(() => {})` — and since receiveDocument used to reject
    // anything not already DISPATCHED, every audited return failed here invisibly and never
    // reached the queue. Surface failures instead of swallowing them.
    //
    // The result is reassigned onto `doc`, which used to be discarded — verified live: the
    // response this endpoint returns to the assayer's phone reported `status: "UPLOADED"` while
    // the row it was reading right back out of the database already said RECEIVED. `doc` is left
    // at its pre-receive value on failure (the existing fallback: a receive that did not happen
    // must not be reported as though it did).
    try {
      doc = await this.documentService.receiveDocument(doc.id, req?.user?.id || 'SYSTEM');
    } catch (err: any) {
      console.error(
        `Audited return ${doc.id} uploaded but could not be marked received — it will not appear in the data-entry queue:`,
        err?.message,
      );
    }

    const completion = await this.completeAssignmentForReturn(doc, body.assignmentId, targetId, req?.user, fileName);

    // The upload succeeded either way; `assignmentCompletion` says whether the job actually
    // closed. An assayer who uploaded a return and saw only "success" had every reason to
    // believe it had.
    return { success: true, assignmentCompletion: completion, data: doc, documentUrl: `/documents/${doc.id}/download` };
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
  @UseInterceptors(FileInterceptor('file', documentUploadMulterOptions), FileScanInterceptor)
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

    const ownAssignment = await this.assertMaySubmitReturnFor(req.user, { assignmentId });

    let targetId = assessmentId || assignmentId;
    if (assignmentId && !assessmentId) {
      const assignment = await this.assignmentRepository
        .findOne({ where: { id: assignmentId } })
        .catch(() => null);
      if (assignment?.projectBranchId) targetId = assignment.projectBranchId;
    }

    // Same derivation as the back-office route: a handset's declared content type is a claim
    // like any other, and the field PDF is the evidence an audit rests on.
    const integrity = deriveFileIntegrity(file.buffer, file.mimetype || 'application/pdf');
    const clientHash = verifyClientHash(integrity, (req?.body?.sha256 ?? null) as string | null);
    if (clientHash.supplied && !clientHash.matches) {
      throw withCode(new BadRequestException(
        'UPLOAD_CHECKSUM_MISMATCH: the bytes received do not match the sha256 supplied with them. '
        + 'Nothing was stored. Retry the upload.',
      ), OTHER_CONFLICT_ERROR_CODES.UPLOAD_CHECKSUM_MISMATCH);
    }

    // A finished job: the same bytes again are a retry of a delivered upload and get the stored
    // document back, with nothing written and completion not re-run; different bytes are refused.
    const replay = await this.replayOrRefuseOnFinishedJob(ownAssignment, integrity.sha256);
    if (replay && ownAssignment) {
      return { success: true, assignmentCompletion: this.replayedCompletion(ownAssignment), data: replay };
    }

    const savedFilePath = await this.storage.saveFile(file.originalname, file.buffer, integrity.effectiveMimeType);
    let doc = await this.documentService.create(
      {
        assessmentId: targetId,
        fileName: file.originalname,
        filePath: savedFilePath,
        fileSize: file.size,
        mimeType: file.mimetype || 'application/pdf',
        type: DocumentType.AUDITED_RETURN_PDF,
        integrity,
      },
      req.user.id,
    );

    // Reassigned rather than discarded — see the identical fix on the JSON sibling
    // (`mobileUpload`) above for why: this response was reporting the pre-receive UPLOADED
    // snapshot to the caller even though the row underneath it had already moved to RECEIVED.
    try {
      doc = await this.documentService.receiveDocument(doc.id, req.user.id);
    } catch (err: any) {
      console.error(`Audited return ${doc.id} could not be marked received:`, err?.message);
    }

    const completion = await this.completeAssignmentForReturn(doc, assignmentId, targetId, req.user, file.originalname);

    // The upload succeeded either way; `assignmentCompletion` says whether the job actually
    // closed. An assayer who uploaded a return and saw only "success" had every reason to
    // believe it had.
    return { success: true, assignmentCompletion: completion, data: doc };
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
  private async assertMaySubmitReturnFor(
    user: any,
    ref: { assignmentId?: string | null; targetId?: string | null },
  ): Promise<AssignmentEntity | null> {
    const roles: string[] = (user?.roles ?? []).map((r: any) => (typeof r === 'string' ? r : r?.name)).filter(Boolean);
    if (!roles.includes(SystemRole.ASSAYER)) return null; // staff path, already role-gated

    let assignment: AssignmentEntity | null = null;
    if (ref.assignmentId) {
      assignment = await this.assignmentRepository
        .findOne({ where: { id: ref.assignmentId } })
        .catch(() => null);
      if (!assignment) {
        throw new NotFoundException('That assignment could not be found.');
      }
    } else if (ref.targetId) {
      /**
       * The resumable path names its target, not its assignment.
       *
       * `POST /upload/session` carries only `assessmentId`, and the assayer app fills it with the
       * ASSIGNMENT's own id (see `uploadAuditPdfResumable`) — while an older caller may send a real
       * assessment or project-branch id. The same three readings `completeAssignmentForReturn`
       * resolves by, asked here of the caller's own assignments only: a target they hold no
       * assignment on is somebody else's work. A live one wins over a finished one, so an old
       * cancelled assignment on the same branch does not shadow the current job.
       */
      const mine = await this.assignmentRepository
        .find({
          where: [
            { id: ref.targetId, assayerId: user?.id },
            { assessmentId: ref.targetId, assayerId: user?.id },
            { projectBranchId: ref.targetId, assayerId: user?.id },
          ],
        })
        .catch(() => [] as AssignmentEntity[]);
      assignment = mine.find((a) => !isAssignmentTerminal(a.status)) ?? mine[0] ?? null;
      if (!assignment) {
        this.logger.warn(
          `Assayer ${user?.id} attempted to upload field paperwork against ${ref.targetId}, on which they hold no assignment.`,
        );
        throw new ForbiddenException('You can only submit paperwork for an assignment that is assigned to you.');
      }
    } else {
      throw new BadRequestException('An assignment must be specified when submitting an audited return.');
    }

    // `evaluateOwnership` — the rule the field app's SUBMIT_RETURN capability is built from.
    if (!evaluateOwnership(AssignmentAction.SUBMIT_RETURN, assignment, user?.id).allowed) {
      this.logger.warn(
        `Assayer ${user?.id} attempted to submit an audited return for assignment ${assignment.id}, which belongs to ${assignment.assayerId}.`,
      );
      throw new ForbiddenException('You can only submit paperwork for an assignment that is assigned to you.');
    }

    return assignment;
  }

  /**
   * The second half of the same rule: what an assayer's upload on a FINISHED job gets.
   *
   * A finished job takes no more field paperwork from the field. "Finished" is the shared
   * terminal rule (`isAssignmentTerminal`: COMPLETED, REJECTED, CANCELLED), not a list written
   * here. A COMPLETED assignment has already booked its payable and client line, so a late upload
   * used to land a second "audited return" beside the one the data-entry desk already worked from.
   * The way back for a return that genuinely needs replacing is operations reopening the
   * assignment (`POST /assignments/:id/reopen`), after which the upload goes through again.
   *
   * EXCEPT the same file again. Weak signal is the normal case at a branch: the return lands, the
   * job closes, and the response never reaches the phone. The app's upload outbox then retries,
   * and it treats any 4xx other than 401/408/429 as a permanent refusal — so refusing the retry
   * parked a delivered packet as "refused" and sent the assayer to redo papers the desk already
   * had. A byte-identical file (`content_sha256`, derived from the bytes, never the client's
   * claim) already stored as this assignment's audited return is therefore answered as the
   * success it was: the EXISTING document, nothing written, completion not re-run. Only a
   * DIFFERENT file on a finished job is refused with `ASSIGNMENT_CLOSED`.
   *
   * Returns the stored document to replay, or null to proceed with an ordinary upload. `assignment`
   * is what `assertMaySubmitReturnFor` resolved — null for staff, who are never stopped here: a
   * back-office upload of a scan that arrived by email is the exception this route has always
   * allowed.
   */
  private async replayOrRefuseOnFinishedJob(
    assignment: AssignmentEntity | null,
    sha256: string,
  ): Promise<DocumentEntity | null> {
    if (!assignment) return null;
    // `evaluateSubmitReturn` — a finished job (`isAssignmentTerminal`) takes no more paperwork. The
    // same function tells the field app, in advance, that a return can no longer be sent.
    const gate = evaluateSubmitReturn(assignment);
    if (gate.allowed) return null;

    const stored = await this.documentService.findStoredReturnByContent(
      [assignment.id, assignment.assessmentId, assignment.projectBranchId].filter(Boolean) as string[],
      sha256,
    );
    if (stored) {
      this.logger.log(
        `Assignment ${assignment.id} is ${assignment.status}; an identical return (${sha256.slice(0, 12)}…) is already stored `
        + `as document ${stored.id}, so this retry is answered with it and nothing new is written.`,
      );
      return stored;
    }
    throw withCode(new ConflictException(gate.reason), gate.code as any);
  }

  /**
   * What a replayed upload reports about the job — the same `assignmentCompletion` shape a first
   * upload returns, read off the job as it now stands. Completion is NOT re-run: the first attempt
   * already did whatever it could.
   */
  private replayedCompletion(assignment: AssignmentEntity): { completed: boolean; blockedReason?: string } {
    return assignment.status === AssignmentStatus.COMPLETED
      ? { completed: true }
      : { completed: false, blockedReason: `This assignment is ${String(assignment.status).toLowerCase()}.` };
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
    /**
     * Ownership is checked before a multipart upload is opened in the store, so a refused caller
     * leaves nothing behind — same rule, same function, as both single-shot routes.
     *
     * The finished-job half is NOT asked here, deliberately. No bytes exist yet, and the installed
     * app never resumes an old session after a lost response: every outbox retry calls
     * `uploadAuditPdfResumable` again, which opens a FRESH session. Refusing that create on a
     * finished job would refuse the identical-file retry before it could be recognised (and the
     * app would fall back to the single-shot route anyway). So the owner may open a session on a
     * finished job, and `completeUpload` decides — replay for the same bytes, refusal for others.
     */
    await this.assertMaySubmitReturnFor(req.user, { targetId: body.assessmentId });
    const session = await this.chunkedUploadService.createSession({
      assessmentId: body.assessmentId,
      fileName: body.fileName,
      fileSize: Number(body.fileSize),
      chunkSize: body.chunkSize ? Number(body.chunkSize) : undefined,
      createdBy: req.user.id,
    });
    return session;
  }

  /**
   * What the client calls after a reconnect: returns which chunks are already stored so it can
   * skip them. This is the difference between resuming a 90%-complete upload and repeating it.
   */
  @Get('upload/session/:uploadId')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Resume: report which chunks the server already holds' })
  async getUploadSession(@Param('uploadId') uploadId: string, @Req() req: any) {
    const session = await this.chunkedUploadService.getSessionFor(uploadId, req?.user?.id);
    const received = await this.chunkedUploadService.receivedChunks(uploadId);
    const missing: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) if (!received.includes(i)) missing.push(i);
    return {
      ...session,
      receivedChunks: received,
      missingChunks: missing,
      progress: Math.round((received.length / session.totalChunks) * 100),
    };
  }

  @Put('upload/session/:uploadId/chunk/:index')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @UseInterceptors(FileInterceptor('chunk', resumableChunkMulterOptions))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload one chunk (binary, resumable)' })
  async uploadChunk(
    @Param('uploadId') uploadId: string,
    @Param('index') index: string,
    @UploadedFile() chunk: any,
    @Req() req: any,
  ) {
    await this.chunkedUploadService.getSessionFor(uploadId, req?.user?.id);
    if (!chunk?.buffer) {
      throw new BadRequestException('No chunk content received.');
    }
    const progress = await this.chunkedUploadService.saveChunk(uploadId, Number(index), chunk.buffer);
    return { ...progress, index: Number(index) };
  }

  @Get('upload/session/:uploadId/chunk/:index/presigned-url')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Get a direct pre-signed PUT URL for uploading one chunk directly to MinIO (low 2G/3G optimization)' })
  async getChunkPresignedUrl(
    @Param('uploadId') uploadId: string,
    @Param('index') index: string,
    @Req() req: any,
  ) {
    await this.chunkedUploadService.getSessionFor(uploadId, req?.user?.id);
    const data = await this.chunkedUploadService.getPresignedPartUrl(uploadId, Number(index));
    return { ...data, index: Number(index) };
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

    /**
     * Only the account that opened the session may complete it, and only for an assignment that is
     * theirs. Both asked BEFORE `assemble`, which finalises the object in the store, so a refusal
     * leaves the multipart upload open and the session intact.
     *
     * Whether the job is finished is decided after assembly instead, because that decision needs
     * the bytes (an identical retry is replayed, a different file refused) and the parts only
     * become one object — one hash — once assembled. See below.
     */
    const opened = await this.chunkedUploadService.getSessionFor(uploadId, req?.user?.id);
    const ownAssignment = await this.assertMaySubmitReturnFor(req.user, { assignmentId: body?.assignmentId, targetId: opened.assessmentId });

    // assemble() calls S3 CompleteMultipartUpload — the object is now in MinIO
    // under s3Key. No buffer assembly happens in this process; no filesystem I/O.
    const { s3Key, session } = await this.chunkedUploadService.assemble(uploadId);

    // Scan the assembled object before registering it. Chunks are meaningless individually, so this
    // is the correct point to inspect the whole file; reject + delete on a hit.
    /**
     * The scan already reads the whole object back into this process, so the bytes to describe
     * are right here. Derived from the same buffer the scanner sees, which is the assembled
     * object as stored — not as the client described it.
     */
    let integrity: ReturnType<typeof deriveFileIntegrity> | undefined;
    try {
      const stream = await this.storage.getFileStream(s3Key);
      const parts: Buffer[] = [];
      for await (const chunk of stream as any) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const assembled = Buffer.concat(parts);
      await this.fileScanner.scanOrThrow(assembled, session.fileName, 'application/pdf');
      integrity = deriveFileIntegrity(assembled, 'application/pdf');
    } catch (err) {
      await this.storage.deleteFile(s3Key).catch(() => undefined);
      await this.chunkedUploadService.discard(uploadId).catch(() => undefined);
      throw err;
    }

    /**
     * A finished job, now that the assembled bytes have a hash.
     *
     * Same bytes as the return already stored: this is the outbox retrying a delivered upload
     * through a fresh session, so the duplicate object just assembled is deleted, the session is
     * closed, and the stored document is answered — no new row, no completion re-run.
     *
     * Different bytes: refused with `ASSIGNMENT_CLOSED`. The assembled object is deleted and the
     * session closed too — once CompleteMultipartUpload has run the session cannot be assembled a
     * second time, and keeping an orphan object for a job that takes no paperwork keeps nothing
     * useful. After operations reopens the job the phone sends the file again, as it would anyway.
     */
    let replay: DocumentEntity | null = null;
    try {
      replay = await this.replayOrRefuseOnFinishedJob(ownAssignment, integrity!.sha256);
    } catch (err) {
      await this.storage.deleteFile(s3Key).catch(() => undefined);
      await this.chunkedUploadService.discard(uploadId).catch(() => undefined);
      throw err;
    }
    if (replay && ownAssignment) {
      await this.storage.deleteFile(s3Key).catch(() => undefined);
      await this.chunkedUploadService.discard(uploadId).catch(() => undefined);
      return {
        success: true,
        assignmentCompletion: type === DocumentType.AUDITED_RETURN_PDF ? this.replayedCompletion(ownAssignment) : undefined,
        data: replay,
      };
    }

    let doc = await this.documentService.create(
      {
        assessmentId: session.assessmentId,
        fileName: session.fileName,
        filePath: s3Key,        // store the S3 object key, not a filesystem path
        /**
         * `session.fileSize` is the number the client announced when it opened the upload
         * session, and it was being stored as fact. Verified in certification: a session that
         * declared 1,000 bytes and then uploaded 4,194,320 produced a row reading `file_size =
         * 1000`, while the download route served the real 4 MB. `integrity.byteLength` is counted
         * from the assembled object; the declaration is only ever a hint for chunk planning.
         */
        fileSize: integrity?.byteLength ?? session.fileSize,
        mimeType: 'application/pdf',
        type,
        integrity,
      },
      req.user.id,
    );

    // Redis session entry is cleaned up only after the DB record is safely persisted.
    // If create() throws, the multipart upload stays open in MinIO and the client
    // can retry completion without re-uploading any chunks.
    await this.chunkedUploadService.discard(uploadId);

    let completion: { completed: boolean; blockedReason?: string } | undefined;
    if (type === DocumentType.AUDITED_RETURN_PDF) {
      // Reassigned rather than discarded — the third occurrence of the same gap fixed on
      // `mobileUpload`/`mobileUploadBinary` above: the response was reporting the pre-receive
      // UPLOADED snapshot even once the row itself had moved to RECEIVED.
      try {
        doc = await this.documentService.receiveDocument(doc.id, req.user.id);
      } catch (err: any) {
        console.error(`Chunked audited return ${doc.id} could not be marked received:`, err?.message);
      }
      completion = await this.completeAssignmentForReturn(doc, body?.assignmentId, session.assessmentId, req.user, session.fileName);
    }

    // The upload succeeded either way; `assignmentCompletion` says whether the job actually
    // closed. An assayer who uploaded a return and saw only "success" had every reason to
    // believe it had.
    return { success: true, assignmentCompletion: completion, data: doc };
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
  /**
   * The assignment a return uploaded against a project branch belongs to — deterministically.
   *
   * A branch accumulates assignment rows over its life (a cancelled one, then its replacement; a
   * declined offer and the one after it), and this was an unordered `findOne` by branch: Postgres
   * could hand back any of them, so a return could land on — and try to complete — a dead row
   * while the live job stayed open. Preference, in order:
   *   1. the live row (PENDING/ACCEPTED/CHECKED_IN/IN_PROGRESS, not deleted) — at most one exists,
   *      `idx_assignments_single_active_branch` guarantees it; newest first only as a tie-break;
   *   2. otherwise the most recently created row of any status (id as the final tie-break), which
   *      is the one whose outcome the return most plausibly describes.
   */
  private async assignmentForBranch(projectBranchId: string): Promise<AssignmentEntity | null> {
    return this.preferredAssignment({ projectBranchId });
  }

  /**
   * The same preference, by assessment — the lookup just before the branch fallback. An assessment
   * belongs to one project branch, so it has the same history of rows and had the same unordered
   * `findOne` (E11 leftover, 2026-09-24).
   */
  private async assignmentForAssessment(assessmentId: string): Promise<AssignmentEntity | null> {
    return this.preferredAssignment({ assessmentId });
  }

  /** Live row first, else the newest (id as tie-break) — see `assignmentForBranch`. */
  private async preferredAssignment(
    key: { projectBranchId: string } | { assessmentId: string },
  ): Promise<AssignmentEntity | null> {
    const live = await this.assignmentRepository
      .findOne({
        where: { ...key, isActive: true, status: In(IN_FLIGHT_ASSIGNMENT_STATUSES) },
        relations: ['projectBranch'],
        order: { createdAt: 'DESC', id: 'DESC' },
      })
      .catch(() => null);
    if (live) return live;
    return this.assignmentRepository
      .findOne({
        where: { ...key },
        relations: ['projectBranch'],
        order: { createdAt: 'DESC', id: 'DESC' },
      })
      .catch(() => null);
  }

  private async completeAssignmentForReturn(
    doc: { id: string; assessmentId: string | null },
    assignmentId: string | undefined,
    fallbackTargetId: string | undefined,
    user: any,
    fileName: string,
  ): Promise<{ completed: boolean; blockedReason?: string }> {
    const userId: string = user?.id || 'SYSTEM';
    let targetAsn = null;
    if (assignmentId) {
      targetAsn = await this.assignmentRepository
        .findOne({ where: { id: assignmentId }, relations: ['projectBranch'] })
        .catch(() => null);
    }
    if (!targetAsn && doc.assessmentId) {
      targetAsn = await this.assignmentForAssessment(doc.assessmentId);
    }
    if (!targetAsn && fallbackTargetId) {
      targetAsn = await this.assignmentForBranch(fallbackTargetId);
    }

    /**
     * Ownership is enforced on the RESOLVED assignment, not just the client-supplied `assignmentId`.
     *
     * The two mobile paths pre-check `assertMaySubmitReturnFor(user, assignmentId)`, but this method
     * resolves a target through two further fallbacks (by assessment, then by project branch) — so a
     * pure assayer who omits `assignmentId` and lets the assessment/branch fallback pick a target
     * could still drive SOMEONE ELSE'S assignment to COMPLETED, booking a payable and a client
     * invoice line for a branch they never visited. The resumable chunked `completeUpload` had no
     * pre-check at all. Enforcing here, on whatever `targetAsn` was actually resolved, closes both.
     * CONFIRMED-EXPLOITABLE class (see the branch-PDF IDOR fixed the same day). Staff pass through.
     */
    const roles: string[] = (user?.roles ?? []).map((r: any) => (typeof r === 'string' ? r : r?.name)).filter(Boolean);
    const isPureAssayer = roles.includes(SystemRole.ASSAYER) && !roles.some((r) => r !== SystemRole.ASSAYER);
    if (isPureAssayer && targetAsn && targetAsn.assayerId !== userId) {
      this.logger.warn(
        `Assayer ${userId} attempted to complete assignment ${targetAsn.id} (owner ${targetAsn.assayerId}) via an audited-return upload.`,
      );
      throw new ForbiddenException('You can only submit paperwork for an assignment that is assigned to you.');
    }

    if (targetAsn && targetAsn.status !== AssignmentStatus.COMPLETED) {
      try {
        /**
         * No reason is supplied here, deliberately.
         *
         * `completeAssignment` asks for a stated reason when the attendance record is incomplete —
         * no arrival, or an arrival with no departure — because for a bank collateral audit time on
         * site is the evidence. This call used to pass `Audited return PDF uploaded (<file>)`, which
         * satisfied that requirement with a sentence no human wrote and nobody could be asked about.
         * A control a machine can discharge on your behalf is not a control.
         *
         * So an upload closes the job only when the attendance record already stands on its own.
         * Otherwise the refusal is reported to the caller below, and somebody accounts for the gap
         * through the completion route, where the reason is theirs.
         */
        await this.assignmentService.completeAssignment(targetAsn.id, userId);
        return { completed: true };
      } catch (err: any) {
        /**
         * The upload itself succeeded and the document is stored, so this does not throw. But it no
         * longer disappears into a server log either: the caller reports that the job is still open
         * and why, because an assayer who uploaded their return and saw "success" had every reason
         * to believe the job was closed when it was not.
         */
        this.logger.warn(
          `Assignment ${targetAsn.id} stayed open after its audited return landed: ${err?.message}`,
        );
        return { completed: false, blockedReason: err?.message ?? 'The assignment could not be closed.' };
      }
    }
    return { completed: targetAsn?.status === AssignmentStatus.COMPLETED };
  }

  @Get(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @RequirePermissions('document:view:organization')
  @ApiOperation({ summary: 'Get document metadata' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    const doc = await this.documentService.findOne(id);
    // Staged region ceiling — `findOne` already eager-loads `assessment.branch`, so no second
    // query is needed to learn the document's region. Same resolution path `issueDownloadToken`
    // uses below, staged rather than immediate-enforcing (see region-guard.service.ts).
    await this.regionGuard.assertRegionAllowedStaged(doc.assessment?.branch?.region ?? null, scope, 'document:findOne');
    return doc;
  }

  @Get(':id/download')
  // Reachable without a bearer token *only* with a valid signed token bound to this exact
  // document (see DocumentAccessTokenService). The assayer app opens PDFs via
  // Linking.openURL(), which delegates to the OS browser and cannot send an Authorization
  // header — that constraint is why this endpoint was fully public, exposing bank customer
  // paperwork to anyone who could reach the API.
  @Public()
  // The token mint (`download-token`) records WHO asked; this records that the file was actually
  // fetched — from which address, and how often (a range resume is its own fetch). A bad or
  // expired token is logged as a failed attempt.
  @AuditRead({ resource: 'DOCUMENT', idParam: 'id', eventType: 'DOCUMENT_DOWNLOADED' })
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
  // Minting a download token IS the access to a document — bank customer paperwork and scanned ID
  // cards live here — so it is the point to log "who accessed document X". Records the access, not
  // the file.
  @AuditRead({ resource: 'DOCUMENT', idParam: 'id' })
  @ApiOperation({ summary: 'Issue a short-lived signed download URL for a document' })
  async issueDownloadToken(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // Confirms the document exists (and 404s if not) before minting a token for it — and is
    // also the row the scope checks below read from (`findOne` already eager-loads
    // `assessment.branch`, so no second query is needed to learn the document's region).
    const doc = await this.documentService.findOne(id);

    // Field assayers are additionally constrained to documents that have actually
    // been dispatched to a branch they are assigned to. Previously this endpoint
    // minted a token for any document id to any assayer, so undispatched paperwork
    // — and other branches' paperwork — was downloadable.
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r);
    /**
     * A "pure" assayer — ASSAYER and nothing else, the same test `isAssayerCaller` in
     * validation-query.controller.ts applies. This used to be computed as
     * `roles.some((r) => r !== SystemRole.ASSAYER)` and named `isPrivileged`: true for ANY role
     * set that happened to include so much as one non-ASSAYER role, which is every staff
     * account on this route (OPERATIONS, DESK, DESK_OPERATOR). "Privileged" then skipped the
     * assayer ownership check with NOTHING put in its place — so any of those roles could mint a
     * download token for ANY document id in the entire system, not merely "an assayer's
     * undispatched paperwork", with zero region/project/client check either.
     *
     * The trigger condition for the assayer branch is unchanged (still only a pure-ASSAYER
     * caller); what changed is the other branch, which used to do nothing and now enforces the
     * same region ceiling `branch.controller.ts`/`assignment.controller.ts` already apply to
     * their own single-record reads — `RegionGuardService.assertRegionAllowed` against the
     * document's branch region, sourced from `GlobalScopeFilter` (`users.regions`).
     */
    const isPureAssayer = roles.includes(SystemRole.ASSAYER) && !roles.some((r) => r !== SystemRole.ASSAYER);
    if (isPureAssayer) {
      await this.documentService.assertAssayerMayDownload(id, req.user.assayerId ?? req.user.id);
    } else {
      this.regionGuard.assertRegionAllowed(doc.assessment?.branch?.region ?? null, scope);
    }
    const { token, expiresAt } = this.documentAccessTokenService.issue(id);
    return { downloadUrl: `/documents/${id}/download?token=${token}`, token, expiresAt };
  }

  /**
   * Spec §8.6: the chain-of-custody view for one document — who moved it, when, and by what
   * method — which is what answers "where is branch X's paperwork right now".
   */
  @Get(':id/trail')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @RequirePermissions('document:view:organization')
  @ApiOperation({ summary: 'Full transport/chain-of-custody trail for a document' })
  async getTransportTrail(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    const doc = await this.documentService.findOne(id);
    await this.regionGuard.assertRegionAllowedStaged(doc.assessment?.branch?.region ?? null, scope, 'document:trail');
    return {
      documentId: doc.id,
      fileName: doc.fileName,
      type: doc.type,
      status: doc.status,
      assessmentId: doc.assessmentId,
      branch: doc.assessment?.branch?.name ?? null,
      project: doc.assessment?.project?.name ?? null,
      trail: this.documentService.buildTransportTrail(doc),
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
    return doc;
  }

  /**
   * The region ceiling for one document id, for the write routes.
   *
   * The reads in this file each spell this out inline — `findOne`, `trail` and the download token
   * all resolve `doc.assessment?.branch?.region` and stage it. Dispatch spelled it out nowhere,
   * on either the single route or the batch, so the release of a packet was outside a boundary
   * its own metadata read was inside. Written once here because the batch needs it per id and the
   * single route needs the identical line; the three read sites above do the same thing inline and
   * should adopt this the next time one of them is touched.
   *
   * A document that cannot be loaded is passed over rather than thrown on: it has no region to
   * breach, `dispatchMany` already reports an unknown id as a per-id failure, and a 404 raised
   * here would turn one bad id into a whole-batch refusal.
   */
  private async assertDocumentRegion(
    documentId: string,
    scope: GlobalScope | undefined,
    context: string,
  ): Promise<void> {
    const doc = await this.documentService.findOne(documentId).catch(() => null);
    if (!doc) return;
    await this.regionGuard.assertRegionAllowedStaged(doc.assessment?.branch?.region ?? null, scope, context);
  }

  /**
   * `branchEmail` sends the packet to the bank branch instead of telling the assayer to download
   * it — how several clients work, with the assayer collecting it there. Absent, this behaves
   * exactly as it always has.
   *
   * It is also why the region ceiling below matters more here than on a metadata read: the
   * address is supplied by the caller, so an unguarded dispatch would email another region's bank
   * paperwork wherever the caller asked.
   */
  @Post(':id/dispatch')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Dispatch a document to the assayer, or email it to a branch' })
  async dispatchDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { branchEmail?: string } | undefined,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.assertDocumentRegion(id, scope, 'document:dispatch');
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
  // Streams the file through an internal call to `downloadFile`, which bypasses that route's own
  // access record — so this route records it, against the branch it was addressed by.
  @AuditRead({ resource: 'PROJECT_BRANCH', idParam: 'projectBranchId', eventType: 'PRE_FIELD_PACKET_DOWNLOADED' })
  @ApiOperation({ summary: 'Directly download the Pre-Audit PDF file for a project branch' })
  async downloadBranchPdf(
    @Param('projectBranchId', ParseUUIDPipe) projectBranchId: string,
    @Req() req: any,
    @Res() res: Response,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // This route mints its own download token below (`documentAccessTokenService.issue`)
    // rather than going through `issueDownloadToken`, so it needs the same staged region
    // ceiling directly — resolved via the project branch, since no document has been loaded
    // yet at this point.
    const region = await this.documentService.resolveProjectBranchRegion(projectBranchId);
    await this.regionGuard.assertRegionAllowedStaged(region, scope, 'document:downloadBranchPdf');

    // A pure assayer may only pull a branch's packet if they actually hold a live assignment on it.
    // The region ceiling above is staff-oriented and a no-op in the default `log` mode, so without
    // this any signed-in assayer could stream any branch's audit PDF by iterating UUIDs (confirmed
    // exploitable 2026-09-04). Staff fall through to the region ceiling as before.
    const pdfRoles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r);
    if (pdfRoles.includes(SystemRole.ASSAYER) && !pdfRoles.some((r) => r !== SystemRole.ASSAYER)) {
      await this.documentService.assertAssayerAssignedToBranch(projectBranchId, req.user.assayerId ?? req.user.id);
    }

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
  async findByProjectBranch(
    @Param('projectBranchId', ParseUUIDPipe) projectBranchId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // Every document under one project branch belongs to that single branch, so this is a
    // detail-route ceiling (gate, not filter) — same shape as `findOne`, resolved via the
    // project branch since no document has been loaded yet at this point.
    const region = await this.documentService.resolveProjectBranchRegion(projectBranchId);
    await this.regionGuard.assertRegionAllowedStaged(region, scope, 'document:findByProjectBranch');

    // Assayers get the dispatch-gated view: only paperwork operations has actually
    // released to them, never documents still being prepared internally.
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r);
    const assayerOnly = roles.includes(SystemRole.ASSAYER) && !roles.some((r) => r !== SystemRole.ASSAYER);
    if (assayerOnly) {
      // Must hold a live assignment on this branch — see the note on `assertAssayerAssignedToBranch`.
      await this.documentService.assertAssayerAssignedToBranch(projectBranchId, req.user.assayerId ?? req.user.id);
      const { documents, readiness } = await this.documentService.findDispatchedForAssayer(projectBranchId);
      return { success: true, data: documents, meta: { readiness } };
    }
    const list = await this.documentService.findByProjectBranch(projectBranchId);
    return list;
  }

  // Must admit every role the frontend /documents route (and the document-list gate) allows, or the
  // page's first call 403s and renders only an error banner for validation/audit viewers.
  @Get('operations/overview')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @RequirePermissions('document:view:organization')
  // …and a role built in Admin → Roles holding `document:view` too. The comment above says this
  // route "must admit every role the frontend /documents route allows"; that table admits a custom
  // role on this permission, so until now the sentence was only true of built-in names and the page
  // drew full chrome with no data and nothing said. RolesGuard's fallback reads permissions from
  // the caller's unrecognised roles only, so no built-in role's access changes.
  @AllowPermissionFallback()
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
  @RequirePermissions('document:upload:organization')
  // DiskUploadScanInterceptor, not FileScanInterceptor: the files are on disk, and the shared
  // interceptor only scans a `buffer` — it would pass every one of them unscanned. This one scans
  // each file from disk and deletes them all when the request ends, whatever happened.
  @UseInterceptors(FilesInterceptor('files', 100, documentBatchUploadMulterOptions), DiskUploadScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: "Upload a day's generated audit PDFs together, matching each file to its branch by filename" })
  async uploadGeneratedBatch(
    @UploadedFiles() files: any[],
    @Query('projectId', ParseUUIDPipe) projectId: string,
    @Query('auditDate') auditDate: string,
    @Req() req: any,
    @Query('customerMasterVersionId') customerMasterVersionId?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    if (!files?.length) throw new BadRequestException('No files received.');
    if (!auditDate) throw new BadRequestException('auditDate is required.');

    const { matches, unmatched, branchesWithoutFile } =
      await this.documentService.matchPdfsToBranches(projectId, auditDate, files.map((f) => f.originalname));

    /**
     * The region ceiling, per matched branch, before the first file is filed.
     *
     * `GET /documents/project/:projectId` narrows what a region-scoped desk may READ of a
     * project's packets, and the three project-branch reads in this file each assert the same
     * boundary — this route, which CREATES those packets, asserted nothing. Matched branches
     * rather than the project as a whole (`assertProjectInScope`) because the day's filing is a
     * per-branch operation: a national project legitimately spans regions, and refusing it
     * wholesale would stop the in-region filing this route exists to do. Staged, like every other
     * document boundary — see `region-guard.service.ts` on why these six roll out behind
     * `security.regionScope.mode`.
     */
    for (const m of matches) {
      const region = await this.documentService.resolveProjectBranchRegion(m.projectBranchId);
      await this.regionGuard.assertRegionAllowedStaged(region, scope, 'document:uploadGeneratedBatch');
    }

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
        // The one route in the file that saved straight to storage with no type check at all —
        // every other upload route calls this (see the identical note on `uploadExcelReport`
        // just below and `POST /customer-master/upload`). Size is already capped at the multer
        // layer here (`documentBatchUploadMulterOptions`); this closes the type gap, scoped to
        // what a generated audit packet can actually be. A rejected file lands in `failed` with
        // a clear reason, exactly like any other per-file failure in this loop — it does not
        // abort the rest of the batch.
        assertUploadAllowed({
          contentType: file.mimetype,
          size: file.size,
          fileName: file.originalname,
          allowed: SCAN_UPLOAD_TYPES,
        });
        // Streamed from the temp file rather than read into memory: the S3 engine encrypts a stream
        // part by part, so storing a 50 MB packet costs a few MB of buffer, not two copies of it.
        const savedPath = await this.storage.saveFile(file.originalname, createReadStream(file.path), file.mimetype, file.size);
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

  /**
   * Accepts the batch and answers 202 `{ jobId }`; the documents go out on the dispatch queue.
   *
   * This used to send everything inside the request. With a branch address that is a storage read
   * and an SMTP send per document, so thirty of them outlived the web client's 30-second timeout:
   * the screen said it failed while the server kept sending, and Send again emailed the branch a
   * second copy. Poll `GET /documents/dispatch-batch/:jobId` for progress and per-document results.
   *
   * `POST /documents/:id/dispatch` stays synchronous — for one document the email is the answer.
   */
  @Post('dispatch-batch')
  @HttpCode(202)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'Start releasing several documents to their assayers or a branch; poll dispatch-batch/:jobId' })
  async dispatchBatch(
    @Body() body: DispatchBatchRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    if (!body?.documentIds?.length) {
      throw new BadRequestException('documentIds is required.');
    }
    // Every id before any of them is accepted, so a batch holding one out-of-region document is
    // refused whole rather than half-dispatched — the shape `assayer.bulkTransitionLifecycle` uses.
    // Checked here, in the request, because the worker has no region scope to check against.
    for (const documentId of body.documentIds) {
      await this.assertDocumentRegion(documentId, scope, 'document:dispatchBatch');
    }
    const data = await this.dispatchJobs.enqueueBatch(
      { documentIds: body.documentIds, branchEmail: body.branchEmail },
      jobActorFrom(req),
    );
    return {
      success: true,
      data,
      message: data.deduplicated
        ? 'These documents are already being sent.'
        : `Sending ${body.documentIds.length} document(s).`,
    };
  }

  /**
   * Where a batch dispatch has got to, and which documents went once it is done.
   *
   * Readable only by the person who started it (`assertJobVisibleTo`): Bull's job ids are a counter,
   * and the result names the documents and why each one that failed did not go.
   */
  @Get('dispatch-batch/:jobId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK)
  @ApiOperation({ summary: 'State, progress and per-document result of a batch dispatch' })
  async getDispatchBatchJob(@Param('jobId') jobId: string, @Req() req: any) {
    return await this.dispatchJobs.status(jobId, req?.user?.id);
  }

  @Get('project-branch/:projectBranchId/assayer-view')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @ApiOperation({ summary: "Dispatch-gated documents for a branch, with readiness so the field app can explain what to expect" })
  async assayerBranchDocuments(
    @Param('projectBranchId', ParseUUIDPipe) projectBranchId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const region = await this.documentService.resolveProjectBranchRegion(projectBranchId);
    await this.regionGuard.assertRegionAllowedStaged(region, scope, 'document:assayerBranchDocuments');
    // A pure assayer must hold a live assignment on this branch — see `assertAssayerAssignedToBranch`.
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r);
    if (roles.includes(SystemRole.ASSAYER) && !roles.some((r) => r !== SystemRole.ASSAYER)) {
      await this.documentService.assertAssayerAssignedToBranch(projectBranchId, req.user.assayerId ?? req.user.id);
    }
    const { documents, readiness } = await this.documentService.findDispatchedForAssayer(projectBranchId);
    return { success: true, data: documents, meta: { readiness } };
  }

  @Get('assessment/:assessmentId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @RequirePermissions('document:view:organization')
  @ApiOperation({ summary: 'Get documents for an assessment' })
  async findByAssessment(@Param('assessmentId', ParseUUIDPipe) assessmentId: string, @GlobalScopeFilter() scope?: GlobalScope) {
    // Every document under one assessment belongs to that assessment's single branch, so this
    // is a detail-route ceiling — resolved via the assessment's own `branch` relation, since
    // there is no project-branch id in this route's URL.
    const region = await this.documentService.resolveAssessmentRegion(assessmentId);
    await this.regionGuard.assertRegionAllowedStaged(region, scope, 'document:findByAssessment');
    const list = await this.documentService.findByAssessment(assessmentId);
    return list;
  }

  @Get('project/:projectId')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get all documents for a project' })
  async findByProject(@Param('projectId', ParseUUIDPipe) projectId: string, @GlobalScopeFilter() scope?: GlobalScope) {
    // A project spans multiple branches — potentially multiple regions — so this is a list to
    // filter (mode-aware, in the service), not a single ceiling to gate.
    const list = await this.documentService.findByProject(projectId, scope);
    return list;
  }

  @Get()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @RequirePermissions('document:view:organization')
  @ApiOperation({ summary: 'Get all system documents' })
  async findAll(
    @GlobalScopeFilter() scope: GlobalScope | undefined,
    @Query('limit', new ParseLimitPipe({ default: 50, max: 500 })) limit: number,
    @Query('offset') offset?: string,
  ) {
    // Garbage/negative offsets fall back to 0 rather than throwing — an out-of-range page is a
    // client mistake, not a request worth failing.
    const parsedOffset = Number(offset);
    const safeOffset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.floor(parsedOffset) : 0;
    const { data, total } = await this.documentService.findAll(scope, limit, safeOffset);
    // Nested under meta.pagination, matching the shape every other paged list here uses
    // (branch/client/user/zone/…) — this route's own request stays offset-based (no client reads
    // this response today, confirmed by grep; nothing needs the request shape to change), so page
    // is derived from it rather than the other way around.
    const page = Math.floor(safeOffset / limit) + 1;
    return { data, meta: { pagination: buildPaginationMeta({ page, limit, total }) } };
  }

  @Get('stats/summary')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR)
  @RequirePermissions('document:view:organization')
  @ApiOperation({ summary: 'Get document statistics' })
  async getStats(@GlobalScopeFilter() scope?: GlobalScope) {
    const stats = await this.documentService.getDocumentStats(scope);
    return stats;
  }

  @Get('queue/data-entry')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @RequirePermissions('document:view:organization')
  @ApiOperation({ summary: 'Get data entry queue — all received PDFs grouped by assessment' })
  async getDataEntryQueue(@GlobalScopeFilter() scope?: GlobalScope) {
    const queue = await this.documentService.findDataEntryQueue(scope);
    return queue;
  }

  @Post(':id/send-external-ocr')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  // Named for OCR but it is a document transition — one of the four STATUS_HAS_ITS_OWN_ROUTE
  // states above, and the same permission `PATCH :id/status` asks for. The `ocr:*` permissions
  // belong to the OCR boundary, which receives results; nothing is submitted to it here.
  @RequirePermissions('document:edit:organization')
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
  @RequirePermissions('document:upload:organization')
  @UseInterceptors(FileInterceptor('file', documentUploadMulterOptions), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload generated Excel report for an assessment from External OCR' })
  async uploadExcelReport(
    @UploadedFile() file: any,
    @Query('assessmentId', ParseUUIDPipe) assessmentId: string,
    @Req() req: any,
  ) {
    /**
     * The one route in this file that had neither guard. Verified live: a request with no file
     * field at all was accepted (`file?.buffer || Buffer.from('')` quietly substitutes an empty
     * buffer) and produced a `GENERATED_EXCEL` document — `fileSize: 0` — immediately marked
     * COMPLETED, exactly as if the External OCR export had actually landed. That is the same
     * "silently fabricate a document instead of reporting the failure" shape `downloadFile`'s own
     * doc comment on this file calls "the worst available behaviour" for an audit artifact: a
     * failed export becomes indistinguishable from a genuine zero-row report, and this status is
     * what the pipeline reads as "this branch's report exists."
     */
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file content received. The generated Excel report must be a real uploaded file.');
    }
    // Every sibling upload route enforces this; this one, alone, did not — see the same note on
    // `POST /customer-master/upload`. Narrowed to spreadsheet types: the summary says "Excel
    // report", and the mimeType saved a few lines down is hardcoded to xlsx regardless of what
    // was actually sent, so a mismatched upload here would previously have been mislabelled
    // rather than refused.
    assertUploadAllowed({
      contentType: file.mimetype,
      size: file.size,
      fileName: file.originalname,
      allowed: SPREADSHEET_UPLOAD_TYPES,
    });

    const savedPath = await this.storage.saveFile(
      file.originalname,
      file.buffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    const doc = await this.documentService.create({
      assessmentId,
      fileName: file.originalname,
      filePath: savedPath,
      fileSize: file.size,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      type: DocumentType.GENERATED_EXCEL,
    }, req?.user?.id || assessmentId);

    // Reassigned rather than discarded — the same stale-response gap fixed on the mobile/chunked
    // return-upload paths above: the response was reporting UPLOADED to the caller while the row
    // it just wrote itself already said COMPLETED.
    const completed = await this.documentService.updateStatus(doc.id, DocumentStatus.COMPLETED, req?.user?.id || 'SYSTEM');

    return { success: true, data: completed, message: 'Excel report uploaded. The document is marked completed.' };
  }

  // ── Data entry desk ───────────────────────────────────────────────────────

  @Get('data-entry/queue')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.OPERATIONS, SystemRole.AUDITOR)
  @RequirePermissions('document:view:organization')
  @ApiOperation({ summary: "Returned packets at the data entry desk and who owns each" })
  async dataEntryQueue(
    @Query('assignedTo') assignedTo?: string,
    @Query('lane') lane?: 'unassigned' | 'working' | 'rework' | 'done',
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    return await this.documentService.dataEntryQueue({ assignedTo, lane, search, page, limit }, scope);
  }

  @Get('data-entry/mine')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @RequirePermissions('document:view:organization')
  @ApiOperation({ summary: 'Packets delegated to the signed-in team member' })
  async myDataEntryQueue(
    @Req() req: any,
    @Query('lane') lane?: 'unassigned' | 'working' | 'rework' | 'done',
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    return await this.documentService.dataEntryQueue({ assignedTo: req.user.id, lane, search, page, limit }, scope);
  }

  @Get('data-entry/team')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  // Returns people, but it is not the user directory — `GET /users` is that, and it is gated
  // separately. This is the delegation picker for one document screen, restricted to the desk's
  // own members, and `user:view` would lock DESK out of a list it exists to serve.
  @RequirePermissions('document:view:organization')
  @ApiOperation({ summary: 'People a returned packet can be delegated to' })
  async dataEntryTeam() {
    return await this.documentService.dataEntryTeam();
  }

  @Post(':id/assign-data-entry')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @RequirePermissions('document:edit:organization')
  @ApiOperation({ summary: 'Delegate a returned packet to a data entry team member' })
  async assignDataEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignDataEntryRequestDto,
    @Req() req: any,
  ) {
    const doc = await this.documentService.assignForDataEntry(id, body.assigneeId, req.user.id);
    return doc;
  }

  @Post(':id/complete-data-entry')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @ApiOperation({ summary: 'Hand a processed packet back to the data entry head' })
  async completeDataEntry(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const doc = await this.documentService.completeDataEntry(id, req.user.id);
    return doc;
  }
}
