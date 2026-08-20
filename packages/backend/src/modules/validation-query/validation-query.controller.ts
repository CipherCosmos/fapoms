import {
  Controller, Get, Post, Delete, Param, Body, UseGuards, ParseUUIDPipe, Req, Res,
  UseInterceptors, UploadedFile, UploadedFiles, Query, Inject, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
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
  async issueAttachmentToken(@Query('key') key: string) {
    if (!key) throw new BadRequestException('key query parameter is required.');
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
  async worklist(@Query() q: ClarificationWorklistQuery) {
    return {
      success: true,
      data: await this.validationQueryService.getClarificationWorklist({ filter: q.filter, limit: q.limit }),
    };
  }

  @Roles(...STAFF_ROLES)
  @Get('worklist/by-assayer')
  @ApiOperation({ summary: 'Open clarifications grouped by auditor, most pressing auditor first (for a single call)' })
  async worklistByAssayer(@Query() q: ClarificationWorklistQuery) {
    return {
      success: true,
      data: await this.validationQueryService.getClarificationsByAssayer({ limit: q.limit }),
    };
  }

  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @Get()
  @ApiOperation({ summary: 'List validation queries (paginated; page/limit, default limit 50)' })
  async findAll(
    @Query('assayerId') assayerId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (assayerId) {
      const list = await this.validationQueryService.findByAssayer(assayerId);
      return { success: true, data: list };
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const { items, total, page: resolvedPage, limit: resolvedLimit } =
      await this.validationQueryService.findAllQueries(pageNum, limitNum);
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
  ) {
    const query = await this.validationQueryService.respondToQuery(id, dto.response || '', req.user.id, dto.attachments);
    return { success: true, data: query };
  }

  @Post(':id/resolve')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @ApiOperation({ summary: 'Validator / Data Entry Head marks a responded query as RESOLVED' })
  async resolveQuery(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const query = await this.validationQueryService.resolveQuery(id, req.user.id);
    return { success: true, data: query };
  }

  @Post(':id/reopen')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR)
  @ApiOperation({ summary: 'Reopen a resolved clarification, returning it to the assayer' })
  async reopenQuery(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const query = await this.validationQueryService.reopenQuery(id, req.user.id);
    return { success: true, data: query };
  }

  @Get('validation-case/:validationCaseId')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get all queries raised for a specific validation case' })
  async findByValidationCase(@Param('validationCaseId', ParseUUIDPipe) validationCaseId: string) {
    const list = await this.validationQueryService.findByValidationCase(validationCaseId);
    return { success: true, data: list };
  }

  @Get('assayer/:assayerId')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get all pending queries assigned to an assayer' })
  async findByAssayer(@Param('assayerId') assayerId: string) {
    const list = await this.validationQueryService.findByAssayer(assayerId);
    return { success: true, data: list };
  }

  // ── Clarification thread ──────────────────────────────────────────────────
  // A clarification used to be one question and one answer. The desk and the
  // assayer need to go back and forth, with the desk able to point at a specific
  // region of a specific page of the returned PDF.

  @Get(':id/messages')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.OPERATIONS, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Full clarification thread' })
  async listMessages(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const messages = await this.threadService.listMessages(id);
    /**
     * Hand the mobile app a picture it can actually load.
     *
     * A message can be pinned to a rectangle on the returned PDF — `pageNumber` + `region` say
     * where, and `snapshotPath` is the desk's cropped image of it. Those two fields already ride
     * along on the entity, but `snapshotPath` is a storage key no image tag can fetch on its own.
     * We wrap it in the same short-lived HMAC link `attachment-token` issues for every other chat
     * attachment, so the phone renders the crop without a session token ever touching the URL.
     * No new route and no widening of access: the link is signed against this one key and expires.
     */
    const data = messages.map((m) => ({
      ...m,
      snapshotUrl: m.snapshotPath ? this.signedAttachmentUrl(m.snapshotPath) : null,
    }));
    return { success: true, data };
  }

  /** A five-minute, single-key download link, reusing the attachment-token instrument above. */
  private signedAttachmentUrl(snapshotPathOrKey: string): string {
    const key = QueryThreadService.storageKeyFromUrl(snapshotPathOrKey);
    const { token } = this.documentAccessTokenService.issue(key);
    return `/api/v1/validation-queries/attachment/${encodeURIComponent(key)}?token=${token}`;
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
