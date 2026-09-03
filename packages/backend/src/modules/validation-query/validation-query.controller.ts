import {
  Controller, Get, Post, Delete, Param, Body, UseGuards, ParseUUIDPipe, Req, Res,
  UseInterceptors, UploadedFile, UploadedFiles, Query, Inject, BadRequestException,
  ForbiddenException, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { assertUploadAllowed } from '../document/upload-validation';
import { memoryStorage } from 'multer';
import { IsOptional, IsString, IsArray, IsNumber, IsObject, IsIn, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ValidationQueryService, ClarificationFilter } from './validation-query.service';
import { QueryThreadService } from './query-thread.service';
import { QueryMessageAuthor } from './validation-query-message.entity';
import { CreateValidationQueryDto, RespondValidationQueryDto } from './dto/validation-query.dto';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, Public } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole } from '@fapoms/shared';
import { Response } from 'express';
import { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { DocumentAccessTokenService } from '../document/document-access-token.service';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

/**
 * Multer memory-storage configuration for chat attachments.
 *
 * Files arrive in req.file.buffer and are immediately pushed to object storage
 * (MinIO / S3). Nothing touches the local filesystem.
 */
const chatMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
};

/**
 * One attachment on a thread message.
 *
 * Declared as a real class rather than an inline type. The global ValidationPipe runs with
 * `whitelist: true`, which strips any property it has no validator metadata for — and an
 * inline TypeScript type carries no metadata at runtime. Every attachment posted to a
 * clarification was therefore emptied before it reached the database: the API answered 200,
 * the row saved, and the files were simply gone. This affected the data-entry desk and the
 * assayer app equally, because the loss happened server-side.
 */
class QueryAttachmentDto {
  @IsString() url: string;
  @IsString() fileName: string;
  @IsString() fileType: string;
  /**
   * The upload endpoint returns these alongside the three required fields, and clients post
   * the object back verbatim. They are declared so `forbidNonWhitelisted` accepts them rather
   * than 400-ing a payload the server itself produced.
   */
  @IsOptional() @IsString() s3Key?: string;
  @IsOptional() @IsNumber() size?: number;
  @IsOptional() @IsString() uploadedBy?: string;
  @IsOptional() @IsString() timestamp?: string;
}

class QueryRegionDto {
  @IsNumber() x: number;
  @IsNumber() y: number;
  @IsNumber() w: number;
  @IsNumber() h: number;
}

class PostQueryMessageDto {
  @IsOptional() @IsString() body?: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QueryAttachmentDto)
  attachments?: QueryAttachmentDto[];
  @IsOptional() @IsNumber() pageNumber?: number;
  @IsOptional() @ValidateNested() @Type(() => QueryRegionDto) region?: QueryRegionDto;
  @IsOptional() @IsString() snapshotPath?: string;
  @IsOptional() @IsString() replyToMessageId?: string;
  @IsOptional() @IsArray() annotations?: any[];
  @IsOptional() @IsObject() voiceNote?: { url: string; durationSeconds: number; mimeType?: string };
}

/** Which slice of the worklist to return, and how many rows. Counts always cover the whole set. */
class ClarificationWorklistQuery {
  @IsOptional() @IsIn(['US', 'ASSAYER', 'OVERDUE', 'DONE', 'ALL'])
  filter?: ClarificationFilter;

  @IsOptional() @Type(() => Number) @IsNumber()
  limit?: number;
}

/**
 * Clarification threads between the desk and the field.
 *
 * Not one route here declares `@RequirePermissions`, and that is a finding rather than an
 * oversight: with the grant table as it stands, every one of them would have to name a permission
 * one of its own roles does not hold.
 *
 * Fourteen routes admit `SystemRole.ASSAYER`, who authenticates from the `assayers` table and
 * holds no permission rows at all — the whole point of the mobile clarification screen. Two more
 * (`worklist`, `worklist/by-assayer`) spread `STAFF_ROLES`, which carries PRODUCT_SUPPORT with no
 * grants and OPERATIONS and AUDITOR with no VALIDATION grants. The last three — raise, resolve and
 * reopen a clarification — admit DESK_OPERATOR, the validator whose job this is, who holds
 * VALIDATION VIEW and REVIEW but neither CREATE nor EDIT.
 *
 * So a custom role reaches none of this until either an assayer principal can hold a grant or
 * DESK_OPERATOR is granted the write it already exercises here by name. Declaring `validation:view`
 * on the three write routes would clear the scanner and hand a read-only custom role the ability to
 * resolve clarifications, which is worse than the gap.
 */
@ApiTags('Validation Queries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('validation-queries')
export class ValidationQueryController {
  constructor(
    private readonly validationQueryService: ValidationQueryService,
    private readonly threadService: QueryThreadService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
    private readonly documentAccessTokenService: DocumentAccessTokenService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // FILE UPLOAD — Multer memory storage + S3 (no filesystem)
  // ───────────────────────────────────────────────────────────────────────────

  @Post('upload-attachment')
  @Roles(SystemRole.ADMIN, SystemRole.ASSAYER, SystemRole.DESK_OPERATOR, SystemRole.DESK)
  @ApiOperation({ summary: 'Upload chat attachment via multipart form-data' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('files', 10, chatMulterOptions), FileScanInterceptor)
  async uploadAttachments(@UploadedFiles() files: Express.Multer.File[], @Req() req: any) {
    // Previously `(files || []).map(...)` — a request carrying no files produced an empty
    // result set and HTTP 201, so a failed attach looked to the caller exactly like a
    // successful one with nothing in it.
    if (!files?.length) {
      throw new BadRequestException('No files were uploaded.');
    }

    const results = await Promise.all(
      (files || []).map(async (file) => {
        // Type + size allowlist, the same gate the document upload paths use. This route
        // scans for malware but accepted ANY declared type; a clarification thread is not a
        // place to smuggle an arbitrary file type into storage.
        assertUploadAllowed({ contentType: file.mimetype, size: file.size, hint: 'Attach a PDF, image, or spreadsheet.' });
        const key = await this.storage.saveFile(
          `chat/${file.originalname}`,
          file.buffer,
          file.mimetype,
        );
        return {
          // Return the key as the URL — the download endpoint resolves it via S3.
          url: `/api/v1/validation-queries/attachment/${encodeURIComponent(key)}`,
          s3Key: key,
          fileName: file.originalname,
          fileType: file.mimetype,
          size: file.size,
          uploadedBy: req.user?.role === 'ASSAYER' ? 'ASSAYER' : 'DESK_OPERATOR',
          timestamp: new Date().toISOString(),
        };
      }),
    );

    return { success: true, data: results };
  }

  // Single file upload fallback (for simpler clients)
  @Post('upload-single')
  @Roles(SystemRole.ADMIN, SystemRole.ASSAYER, SystemRole.DESK_OPERATOR, SystemRole.DESK)
  @ApiOperation({ summary: 'Upload single chat attachment via multipart form-data' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', chatMulterOptions), FileScanInterceptor)
  async uploadSingleAttachment(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    // Was `return { success: false, ... }`, which still went out as HTTP 201 Created. Any
    // client branching on the status code — including anything using `response.ok` — read a
    // rejected upload as a successful one.
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded.');
    }
    // Same allowlist as the multi-file route above.
    assertUploadAllowed({ contentType: file.mimetype, size: file.size, hint: 'Attach a PDF, image, or spreadsheet.' });

    const key = await this.storage.saveFile(
      `chat/${file.originalname}`,
      file.buffer,
      file.mimetype,
    );

    return {
      success: true,
      data: {
        url: `/api/v1/validation-queries/attachment/${encodeURIComponent(key)}`,
        s3Key: key,
        fileName: file.originalname,
        fileType: file.mimetype,
        size: file.size,
        uploadedBy: req.user?.role === 'ASSAYER' ? 'ASSAYER' : 'DESK_OPERATOR',
        timestamp: new Date().toISOString(),
      },
    };
  }

  @Get('attachment-token')
  @Roles(SystemRole.ADMIN, SystemRole.ASSAYER, SystemRole.DESK_OPERATOR, SystemRole.DESK)
  @ApiOperation({ summary: 'Issue a short-lived HMAC signed token for downloading an attachment' })
  async issueAttachmentToken(@Query('key') key: string, @Req() req: any) {
    if (!key) throw new BadRequestException('key query parameter is required.');

    /**
     * `key` is an arbitrary storage path off the query string — resolve it back to the
     * clarification thread it belongs to and authorise the caller against THAT record before
     * signing anything, the same shape as the ownership check on `listMessages`/`respondToQuery`
     * above. Previously this signed a token for whatever key was supplied with no lookup at
     * all, so any of the four roles this route admits could mint a valid download token for ANY
     * object in the bucket — not just a clarification attachment — by guessing or reusing a key.
     * A key that resolves to nothing is refused outright; an assayer is then pinned to their own
     * clarification exactly as elsewhere in this file. Staff are not object-scoped here, same as
     * every other route in this file — only the "does this key belong to a real attachment at
     * all" check applies to them too, since that is the actual gap being closed.
     */
    const queryId = await this.threadService.queryIdForAttachmentKey(key);
    if (!queryId) throw new NotFoundException('No clarification attachment matches that key.');
    await this.assertAssayerOwnsQuery(req, queryId);

    const { token, expiresAt } = this.documentAccessTokenService.issue(key);
    return {
      success: true,
      data: {
        downloadUrl: `/api/v1/validation-queries/attachment/${encodeURIComponent(key)}?token=${token}`,
        token,
        expiresAt,
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FILE DOWNLOAD — Stream from object storage (MinIO / S3) with token auth
  // ───────────────────────────────────────────────────────────────────────────

  @Public()
  @Get('attachment/*path')
  @ApiOperation({ summary: 'Download/view a chat attachment file using JWT or signed HMAC token' })
  async downloadAttachment(
    @Param('path') pathParam: string | string[],
    @Query('token') token: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const rawKey = Array.isArray(pathParam) ? pathParam.join('/') : pathParam;
    const key = decodeURIComponent(rawKey);

    // Check 1: User is already populated by Passport (Bearer header)
    const user = req.user;

    /**
     * Check 2: otherwise it must be a short-lived HMAC token bound to this exact key.
     *
     * A second branch used to sit above this one, accepting a full session JWT from `?token=`.
     * It is gone for the reason set out in `JwtStrategy`: a session token in a URL must be
     * assumed disclosed, and this one would have granted its bearer every attachment in the
     * system rather than the one the link was for. `GET /validation-queries/attachment-token`
     * issues the correct instrument — an HMAC over this key alone, expiring in five minutes —
     * and the assayer app already uses it.
     */
    if (!user) {
      try {
        this.documentAccessTokenService.verify(key, token);
      } catch (err: any) {
        try {
          this.documentAccessTokenService.verify(`uploads/${key}`, token);
        } catch {
          throw err;
        }
      }
    }

    // Support candidate keys for both relative key format and legacy format
    const candidateKeys = [
      key,
      `uploads/${key}`,
      key.startsWith('uploads/') ? key.replace(/^uploads\//, '') : key,
      `uploads/chat/${key}`,
    ];

    let resolvedKey: string | null = null;
    let stat: { size: number; mtimeMs: number } | null = null;

    for (const ck of candidateKeys) {
      try {
        stat = await this.storage.statFile(ck);
        resolvedKey = ck;
        break;
      } catch {
        // try next candidate
      }
    }

    if (!resolvedKey || !stat) {
      return res.status(404).json({ success: false, message: 'File not found in object storage' });
    }

    const ext = key.split('.').pop()?.toLowerCase() ?? '';
    const mimeMap: Record<string, string> = {
      'pdf': 'application/pdf',
      'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
      'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'txt': 'text/plain', 'csv': 'text/csv',
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';
    const fileName = key.split('/').pop() ?? 'attachment';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', stat.size);

    const stream = await this.storage.getFileStream(resolvedKey);
    stream.pipe(res);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // QUERY CRUD
  // ───────────────────────────────────────────────────────────────────────────

  @Roles(...STAFF_ROLES)
  @Get('worklist')
  @ApiOperation({ summary: 'Clarifications enriched for a worklist (branch, assayer, SLA, whose court)' })
  async worklist(@Query() q: ClarificationWorklistQuery, @GlobalScopeFilter() scope?: GlobalScope) {
    return {
      success: true,
      data: await this.validationQueryService.getClarificationWorklist({ filter: q.filter, limit: q.limit, scope }),
    };
  }

  @Roles(...STAFF_ROLES)
  @Get('worklist/by-assayer')
  @ApiOperation({ summary: 'Open clarifications grouped by auditor, most pressing auditor first (for a single call)' })
  async worklistByAssayer(@Query() q: ClarificationWorklistQuery, @GlobalScopeFilter() scope?: GlobalScope) {
    return {
      success: true,
      data: await this.validationQueryService.getClarificationsByAssayer({ limit: q.limit, scope }),
    };
  }

  /**
   * These read routes admit ASSAYER (the mobile app needs its own clarifications) but had NO
   * object-level ownership check — so any field assayer could page the entire query table, read
   * any other assayer's clarifications by id, and pull any validation case's threads (borrower
   * and collateral discussion, PDF crops). The write path was hardened; the reads were not. An
   * assayer is now pinned to their own records on every one of these; staff are unaffected.
   */
  private isAssayerCaller(req: any): boolean {
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    return roles.includes(SystemRole.ASSAYER) && !roles.some((r) => (STAFF_ROLES as unknown as string[]).includes(r));
  }

  private async assertAssayerOwnsQuery(req: any, queryId: string): Promise<void> {
    if (!this.isAssayerCaller(req)) return; // staff are not object-scoped on these routes
    const owner = await this.validationQueryService.ownerAssayerId(queryId);
    if (owner === undefined) throw new NotFoundException('Clarification not found.');
    if (owner !== req.user?.id) throw new ForbiddenException('You can only view your own clarifications.');
  }

  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @Get()
  @ApiOperation({ summary: 'List validation queries (paginated; page/limit, default limit 50)' })
  async findAll(
    @Req() req: any,
    @Query('assayerId') assayerId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // An assayer sees only their own, whatever the query string asks for. Their own claim
    // history does not depend on which region they happen to be standing in, so `scope` is
    // deliberately not passed here — same reasoning `ExpenseService.findForAssayer` documents
    // for `findMine`.
    if (this.isAssayerCaller(req)) {
      const list = await this.validationQueryService.findByAssayer(req.user.id);
      return { success: true, data: list };
    }
    // Staff branch below — mode-aware region filtering applies from here down. `scope` is
    // only forwarded when present so a direct (non-HTTP) caller that supplies no scope keeps
    // hitting the exact unscoped overload — `@GlobalScopeFilter()` itself always resolves to a
    // real object over HTTP, never `undefined`.
    if (assayerId) {
      const list = scope
        ? await this.validationQueryService.findByAssayer(assayerId, scope)
        : await this.validationQueryService.findByAssayer(assayerId);
      return { success: true, data: list };
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const { items, total, page: resolvedPage, limit: resolvedLimit } =
      await this.validationQueryService.findAllQueries(pageNum, limitNum, scope);
    return {
      success: true,
      data: items,
      pagination: { page: resolvedPage, limit: resolvedLimit, total },
    };
  }

  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @ApiOperation({ summary: 'Raise a new validation query to an assayer (Data Entry / Admin)' })
  async createQuery(@Body() dto: CreateValidationQueryDto, @Req() req: any) {
    const query = await this.validationQueryService.createQuery(dto, req.user.id);
    return { success: true, data: query };
  }

  @Post(':id/respond')
  @Roles(SystemRole.ADMIN, SystemRole.ASSAYER, SystemRole.DESK_OPERATOR, SystemRole.DESK)
  @ApiOperation({ summary: 'Respond/reply to an active validation query thread' })
  async respondToQuery(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondValidationQueryDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // The service commits status=RESPONDED before its own (swallowed) ownership check, so gate here:
    // an assayer may answer only their own clarification.
    await this.assertAssayerOwnsQuery(req, id);
    // Staged staff-side region ceiling — a no-op for an assayer caller (already object-scoped
    // above) and for an unrestricted account (`scope.regions` null/empty), so the extra lookup
    // only runs when it can actually matter.
    if (!this.isAssayerCaller(req) && scope?.regions?.length) {
      const region = await this.validationQueryService.resolveRegion(id);
      await this.regionGuard.assertRegionAllowedStaged(region, scope, 'validation-query:respondToQuery');
    }
    const query = await this.validationQueryService.respondToQuery(id, dto.response || '', req.user.id, dto.attachments);
    return { success: true, data: query };
  }

  @Post(':id/resolve')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @ApiOperation({ summary: 'Validator / Data Entry Head marks a responded query as RESOLVED' })
  async resolveQuery(@Param('id', ParseUUIDPipe) id: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    // This route admits no ASSAYER role, so every caller here is staff — the staged region
    // ceiling always applies (skipped only for an unrestricted account, see above).
    if (scope?.regions?.length) {
      const region = await this.validationQueryService.resolveRegion(id);
      await this.regionGuard.assertRegionAllowedStaged(region, scope, 'validation-query:resolveQuery');
    }
    const query = await this.validationQueryService.resolveQuery(id, req.user.id);
    return { success: true, data: query };
  }

  @Post(':id/reopen')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @ApiOperation({ summary: 'Reopen a resolved clarification, returning it to the assayer' })
  async reopenQuery(@Param('id', ParseUUIDPipe) id: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    // Staff-only route, same as resolveQuery above.
    if (scope?.regions?.length) {
      const region = await this.validationQueryService.resolveRegion(id);
      await this.regionGuard.assertRegionAllowedStaged(region, scope, 'validation-query:reopenQuery');
    }
    const query = await this.validationQueryService.reopenQuery(id, req.user.id);
    return { success: true, data: query };
  }

  @Get('validation-case/:validationCaseId')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get all queries raised for a specific validation case' })
  async findByValidationCase(
    @Param('validationCaseId', ParseUUIDPipe) validationCaseId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // Every clarification under one case shares that case's single project branch, so this is
    // a single detail-style ceiling rather than a per-row filter (see
    // `ValidationQueryService.validationCaseRegion`'s doc comment). Staff only — an assayer is
    // already object-scoped below, so the extra lookup is skipped for them.
    if (!this.isAssayerCaller(req) && scope?.regions?.length) {
      const region = await this.validationQueryService.validationCaseRegion(validationCaseId);
      await this.regionGuard.assertRegionAllowedStaged(region, scope, 'validation-query:findByValidationCase');
    }
    let list = await this.validationQueryService.findByValidationCase(validationCaseId);
    // An assayer may see only their own clarifications within a case, never a colleague's.
    if (this.isAssayerCaller(req)) list = list.filter((q) => q.assayerId === req.user?.id);
    return { success: true, data: list };
  }

  @Get('assayer/:assayerId')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get all pending queries assigned to an assayer' })
  async findByAssayer(@Param('assayerId') assayerId: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    // An assayer is pinned to their own id here, ignoring the path param. Their own list does
    // not depend on which region they happen to be standing in, so `scope` is only passed
    // through for a staff caller viewing someone else's clarifications.
    const isAssayer = this.isAssayerCaller(req);
    const targetId = isAssayer ? req.user.id : assayerId;
    // Scope is only forwarded for a staff caller, and only when present — see `findAll`'s
    // `assayerId` branch above for why an absent `scope` keeps hitting the unscoped overload.
    const list = !isAssayer && scope
      ? await this.validationQueryService.findByAssayer(targetId, scope)
      : await this.validationQueryService.findByAssayer(targetId);
    return { success: true, data: list };
  }

  // ── Clarification thread ──────────────────────────────────────────────────
  // A clarification used to be one question and one answer. The desk and the
  // assayer need to go back and forth, with the desk able to point at a specific
  // region of a specific page of the returned PDF.

  @Get(':id/messages')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.OPERATIONS, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Full clarification thread' })
  async listMessages(@Param('id', ParseUUIDPipe) id: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.assertAssayerOwnsQuery(req, id);
    // Staged staff-side region ceiling — see `respondToQuery` above for why this is skipped for
    // an assayer caller (already object-scoped) and for an unrestricted account.
    if (!this.isAssayerCaller(req) && scope?.regions?.length) {
      const region = await this.validationQueryService.resolveRegion(id);
      await this.regionGuard.assertRegionAllowedStaged(region, scope, 'validation-query:listMessages');
    }
    const messages = await this.threadService.listMessages(id);
    // The packet this clarification is about — the same file for every message — resolved once so
    // an anchored message can carry an absolute link to it.
    const documentId = await this.threadService.getQueryDocumentId(id);
    /**
     * Point each anchored message at the actual packet PDF, and keep old crops loadable.
     *
     * A message can be pinned to a rectangle on the returned PDF — `pageNumber` + `region` say
     * where. New messages carry no cropped image at all: `markUrl` is an absolute link to the
     * read-only `/view-mark` page that renders the real document with that rectangle drawn on it,
     * so the desk and the assayer see the SAME mark on the SAME PDF. OLD messages predate this and
     * still hold a `snapshotPath` crop; we keep signing it into `snapshotUrl` — a short-lived HMAC
     * link, no session token in the URL — so their image goes on rendering unchanged.
     */
    const data = messages.map((m) => ({
      ...m,
      snapshotUrl: m.snapshotPath ? this.signedAttachmentUrl(m.snapshotPath) : null,
      markUrl: this.buildMarkUrl(documentId, m.pageNumber, m.region),
    }));
    return { success: true, data };
  }

  /** A five-minute, single-key download link, reusing the attachment-token instrument above. */
  private signedAttachmentUrl(snapshotPathOrKey: string): string {
    const key = QueryThreadService.storageKeyFromUrl(snapshotPathOrKey);
    const { token } = this.documentAccessTokenService.issue(key);
    return `/api/v1/validation-queries/attachment/${encodeURIComponent(key)}?token=${token}`;
  }

  /**
   * An absolute link to the read-only `/view-mark` page for one anchored message: the packet PDF,
   * opened to the message's page with its normalised rectangle highlighted. The viewer fetches the
   * PDF via the document download route using the freshly-issued, document-scoped token below
   * (`DocumentAccessTokenService` — an HMAC over this one document id, expiring in minutes).
   *
   * Null unless the message is genuinely anchored: it needs a resolvable packet `documentId`, a
   * `region`, and its `pageNumber`. Base is `APP_PUBLIC_URL`, then `FRONTEND_URL`, then relative.
   */
  private buildMarkUrl(
    documentId: string | null,
    pageNumber: number | null,
    region: { x: number; y: number; w: number; h: number } | null,
  ): string | null {
    if (!documentId || !region || !pageNumber) return null;
    const base = process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || '';
    const { token } = this.documentAccessTokenService.issue(documentId);
    const regionParam = `${region.x},${region.y},${region.w},${region.h}`;
    return `${base}/view-mark?documentId=${encodeURIComponent(documentId)}` +
      `&token=${encodeURIComponent(token)}&page=${pageNumber}&region=${regionParam}`;
  }

  @Post(':id/messages')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Add a message to a clarification, optionally anchored to a PDF region' })
  async postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PostQueryMessageDto,
    @Req() req: any,
  ) {
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    const isAssayer = roles.includes(SystemRole.ASSAYER) && roles.length === 1;
    const message = await this.threadService.postMessage(
      id,
      isAssayer ? QueryMessageAuthor.ASSAYER : QueryMessageAuthor.STAFF,
      req.user.id,
      req.user.displayName ?? req.user.username ?? null,
      dto,
    );
    return { success: true, data: message };
  }

  @Post(':id/messages/read')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Mark all messages in a thread as read (read receipts)' })
  async markRead(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const result = await this.threadService.markThreadAsRead(id, req.user.id);
    return { success: true, data: result };
  }

  @Post('messages/:messageId/reactions')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Add an emoji reaction to a message' })
  async addReaction(
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: { emoji: string },
    @Req() req: any,
  ) {
    const message = await this.threadService.addReaction(
      messageId,
      dto.emoji,
      req.user.id,
      req.user.displayName ?? req.user.username ?? 'User',
    );
    return { success: true, data: message };
  }

  @Delete('messages/:messageId/reactions')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Remove an emoji reaction from a message' })
  async removeReaction(
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: { emoji: string },
    @Req() req: any,
  ) {
    const message = await this.threadService.removeReaction(messageId, dto.emoji, req.user.id);
    return { success: true, data: message };
  }

  @Post('messages/:messageId/star')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Toggle starred status on a clarification message' })
  async toggleStar(@Param('messageId', ParseUUIDPipe) messageId: string) {
    const message = await this.threadService.toggleStarMessage(messageId);
    return { success: true, data: message };
  }
}
