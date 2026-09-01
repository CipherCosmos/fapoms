import {
  Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req, Res,
  UseInterceptors, UploadedFiles, BadRequestException, NotFoundException, Inject, Logger,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import {
  IsOptional, IsString, IsNotEmpty, IsEnum, IsArray, IsObject, IsBoolean, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { FeedbackService, FEEDBACK_TEAM_ROLES } from './feedback.service';
import { FeedbackThreadService, FeedbackActor } from './feedback-thread.service';
import { FeedbackEscalationService } from './feedback-escalation.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, AnyAuthenticated } from '../auth/guards';
import { FeedbackCategory, FeedbackSeverity, FeedbackStatus, SystemRole } from '@fapoms/shared';
import { FeedbackAttachmentDto } from './feedback-attachment.dto';
import { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { assertUploadAllowed } from '../document/upload-validation';
import { MAX_FEEDBACK_ATTACHMENT_MB, MAX_FEEDBACK_ATTACHMENTS } from '@fapoms/shared';

/**
 * The ceiling for a file attached to a report, in bytes.
 *
 * Deliberately far below the audit-document limit. That one exists for multi-hundred-page colour
 * scans; these are screenshots. Using it here meant five attachments could buffer a quarter of a
 * gigabyte of request body in the server's heap for one report — and, on the connections this is
 * used over, an upload nobody would wait for. `DOCUMENT_MAX_UPLOAD_MB` deliberately does not
 * raise this: a deployment that accepts bigger scans has not asked for bigger screenshots.
 */
const FEEDBACK_MAX_ATTACHMENT_BYTES = MAX_FEEDBACK_ATTACHMENT_MB * 1024 * 1024;

/**
 * Files arrive in memory and go straight to object storage; nothing touches the local disk.
 *
 * The multer ceiling matters as much as the check in the handler: multer enforces it *while*
 * reading the body, so an oversized file is cut off early rather than fully buffered and then
 * rejected. `assertUploadAllowed` still runs, for the type allowlist multer knows nothing about
 * and to produce the message a person reads.
 */
const feedbackMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: FEEDBACK_MAX_ATTACHMENT_BYTES, files: MAX_FEEDBACK_ATTACHMENTS },
};

// Real classes, not inline TS types: the global ValidationPipe runs `whitelist: true`,
// which strips any property without a class-validator decorator on it.

class CreateFeedbackRequestDto {
  @IsOptional() @IsString() title?: string;
  @IsString() @IsNotEmpty() body: string;
  @IsOptional() @IsEnum(FeedbackCategory) category?: FeedbackCategory;
  @IsOptional() @IsString() area?: string;
  @IsOptional() @IsObject() appContext?: Record<string, unknown>;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FeedbackAttachmentDto)
  attachments?: FeedbackAttachmentDto[];
}

class PostFeedbackMessageRequestDto {
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FeedbackAttachmentDto)
  attachments?: FeedbackAttachmentDto[];
  @IsOptional() @IsBoolean() isInternal?: boolean;
}

class TriageFeedbackRequestDto {
  @IsOptional() @IsEnum(FeedbackCategory) category?: FeedbackCategory;
  @IsOptional() @IsEnum(FeedbackSeverity) severity?: FeedbackSeverity;
  @IsOptional() @IsEnum(FeedbackStatus) status?: FeedbackStatus;
  // Nullable-by-string: '' clears the assignee, a uuid sets it.
  @IsOptional() @IsString() assignedToUserId?: string | null;
  @IsOptional() @IsString() duplicateOfId?: string | null;
  @IsOptional() @IsString() note?: string;
}

class ResolveFeedbackRequestDto {
  @IsOptional() @IsString() note?: string;
}

/**
 * The two-way feedback & collaboration channel.
 *
 * Reporter routes (`create`, `mine`, view/reply on one's own thread) are open to
 * **any authenticated principal** — staff, client users, and field assayers alike,
 * because everyone who uses FAPOMS can raise a bug, an idea or a question. The
 * service enforces that a non-team caller only ever touches their own threads.
 *
 * Team routes (the queue, stats, digest, triage, resolve) are gated to
 * {@link FEEDBACK_TEAM_ROLES} — super administrators only (see feedback-roles.ts).
 */
@ApiTags('Feedback')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('feedback')
export class FeedbackController {
  constructor(
    private readonly feedbackService: FeedbackService,
    private readonly threadService: FeedbackThreadService,
    private readonly escalation: FeedbackEscalationService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
  ) {}

  private readonly logger = new Logger(FeedbackController.name);

  /** Resolve the caller into a reporter/team actor across both identity spaces. */
  private actor(req: any): FeedbackActor {
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    // An assayer token carries exactly the synthetic ['ASSAYER'] role and `req.user.id` is the assayer id.
    const isAssayer = roles.includes(SystemRole.ASSAYER) && roles.length === 1;
    const isTeam = roles.some((r) => (FEEDBACK_TEAM_ROLES as unknown as string[]).includes(r));
    return {
      userId: isAssayer ? null : req.user.id,
      assayerId: isAssayer ? req.user.id : null,
      name: req.user.displayName ?? req.user.username ?? req.user.name ?? null,
      isTeam,
    };
  }

  // ── Reporter side (anyone signed in) ────────────────────────────────────────

  @Post()
  @AnyAuthenticated()
  // Filing a thread fans out a realtime notification to the whole feedback team and can escalate.
  // 20/min is far above any human filing rate but stops one account (staff, client or assayer)
  // flooding the team's inbox and the notification pipeline. A retrying slow client is unaffected.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'File a bug, enhancement, process idea or question' })
  async create(@Body() dto: CreateFeedbackRequestDto, @Req() req: any) {
    const thread = await this.feedbackService.create(dto, this.actor(req));
    return { success: true, data: thread };
  }

  /**
   * Attach a screenshot, a log or a document to a report.
   *
   * Feedback is where somebody says "this screen is wrong", and a picture of the screen settles
   * in one glance what a paragraph of description cannot. The column and the DTO field for it
   * had existed since the channel was built; nothing could ever fill them, because there was no
   * route to put a file anywhere.
   *
   * Deliberately reusing what already guards every other upload here rather than starting a
   * second set of rules: `assertUploadAllowed` for the type allowlist and the size ceiling, and
   * `FileScanInterceptor` for malware. A file arriving on this route is exactly as constrained
   * as one arriving on a document upload.
   *
   * The reply is the descriptor the create and reply routes expect back verbatim.
   */
  @Post('attachments')
  @AnyAuthenticated()
  @UseInterceptors(FilesInterceptor('files', MAX_FEEDBACK_ATTACHMENTS, feedbackMulterOptions), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload files to attach to a report or a reply' })
  async uploadAttachments(@UploadedFiles() files: Express.Multer.File[], @Req() req: any) {
    if (!files?.length) throw new BadRequestException('No file was uploaded.');

    const saved = await Promise.all(
      files.map(async (file) => {
        assertUploadAllowed({
          contentType: file.mimetype,
          size: file.size,
          maxBytes: FEEDBACK_MAX_ATTACHMENT_BYTES,
          hint: 'A screenshot is usually enough — a full screen recording rarely is.',
        });
        const key = await this.storage.saveFile(
          `feedback/${file.originalname}`,
          file.buffer,
          file.mimetype,
        );
        return {
          // The only URL shape the attachment DTO accepts, so a client cannot post a link to
          // anywhere this server did not put a file.
          url: `/api/v1/feedback/attachments/${encodeURIComponent(key)}`,
          storageKey: key,
          fileName: file.originalname,
          fileType: file.mimetype,
          size: file.size,
        };
      }),
    );
    return { success: true, data: saved };
  }

  /**
   * Fetch an attachment, if this caller may read the report it is attached to.
   *
   * Scoped to the report rather than served on the strength of a session alone: feedback can
   * contain a screenshot of somebody's pay, their bank details or a client's branch list, and
   * "any signed-in account may file feedback" is a far wider door than "may read this report".
   *
   * The key names the file; the *thread that references it* decides who may have it. `findOne`
   * already encodes that rule — the reporter, or the product team — so this cannot drift from
   * what the thread itself allows. A key no message references belongs to nobody and is not
   * served, which covers both an abandoned upload and a guessed key.
   */
  @Get('attachments/*path')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Download a file attached to a report you can see' })
  async downloadAttachment(
    @Param('path') path: string | string[],
    @Req() req: any,
    @Res() res: any,
  ) {
    const key = decodeURIComponent(Array.isArray(path) ? path.join('/') : path);
    const threadId = await this.threadService.threadIdForAttachment(key);
    if (!threadId) throw new NotFoundException('That file is not attached to any report.');

    // Throws Forbidden for anyone who is neither the reporter nor the product team.
    await this.feedbackService.findOne(threadId, this.actor(req));

    const stream = await this.storage.getFileStream(key);
    // `attachment`, and never the uploader's own content type: these are files a stranger sent,
    // and rendering one inline on the app's own origin is how an SVG or an HTML file becomes
    // stored XSS against whoever opens the report.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${(key.split('/').pop() ?? 'file').replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    /**
     * A stream that fails must not take the process with it.
     *
     * An unhandled `error` event on a Node readable throws, and a throw from a stream callback
     * is outside any request's try/catch — it reaches the process, not the exception filter. So
     * object storage being briefly unreachable, or an object having been removed underneath a
     * link somebody kept, would end the server for everybody rather than failing one download.
     *
     * Headers are already sent by the time bytes flow, so there is no status left to change:
     * the honest thing is to log it and cut the response, which surfaces client-side as a
     * truncated download rather than as a silent, plausible-looking half a file.
     */
    stream.on('error', (err: Error) => {
      this.logger.error(`Attachment ${key} could not be streamed: ${err.message}`);
      res.destroy(err);
    });
    // The other half: if the reader goes away mid-download, stop reading. Without this the
    // stream keeps pulling from storage into a socket nobody is listening to.
    res.on('close', () => stream.destroy());

    stream.pipe(res);
  }

  @Get('mine')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Feedback I have reported' })
  async mine(@Req() req: any) {
    return { success: true, data: await this.feedbackService.findMine(this.actor(req)) };
  }

  @Get('similar')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Open items similar to what I am about to file — vote instead of duplicating' })
  async similar(@Query('text') text: string, @Req() req: any) {
    return { success: true, data: await this.feedbackService.similar(text ?? '', this.actor(req)) };
  }

  // ── Team side ───────────────────────────────────────────────────────────────
  // Static routes must precede ':id' or the router parses 'stats'/'digest' as a uuid.

  @Get()
  @Roles(...FEEDBACK_TEAM_ROLES)
  @ApiOperation({ summary: 'The triage queue, paginated and filterable' })
  async queue(
    @Req() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: FeedbackStatus,
    @Query('category') category?: FeedbackCategory,
    @Query('severity') severity?: FeedbackSeverity,
    // 'me' resolves to the caller; 'none' → unassigned.
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: 'recent' | 'impact',
  ) {
    const assignee = assignedToUserId === 'me' ? req.user.id : assignedToUserId;
    const result = await this.feedbackService.findAllForTeam({ page, limit, status, category, severity, assignedToUserId: assignee, search, sort });
    return {
      success: true,
      data: result.items,
      meta: { pagination: { page: result.page, limit: result.limit, total: result.total } },
    };
  }

  @Get('stats')
  @Roles(...FEEDBACK_TEAM_ROLES)
  @ApiOperation({ summary: 'Headline counts for the team dashboard' })
  async stats() {
    return { success: true, data: await this.feedbackService.stats() };
  }

  @Get('digest')
  @Roles(...FEEDBACK_TEAM_ROLES)
  @ApiOperation({ summary: 'Themes, aging items and open criticals — the reporting rollup' })
  async digest() {
    return { success: true, data: await this.feedbackService.digest() };
  }

  @Get('assignees')
  @Roles(...FEEDBACK_TEAM_ROLES)
  @ApiOperation({ summary: 'People a thread can be assigned to' })
  async assignees() {
    return { success: true, data: await this.feedbackService.teamMembers() };
  }

  @Get('attention')
  @Roles(...FEEDBACK_TEAM_ROLES)
  @ApiOperation({ summary: 'SLA breaches: items awaiting first response or past their resolution clock' })
  async attention() {
    return { success: true, data: await this.escalation.attention() };
  }

  // ── One thread (reporter own, or team) ──────────────────────────────────────

  @Get(':id')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'One feedback thread' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return { success: true, data: await this.feedbackService.findOne(id, this.actor(req)) };
  }

  @Get(':id/messages')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'The conversation on a thread (internal notes hidden from reporters)' })
  async messages(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return { success: true, data: await this.threadService.listMessages(id, this.actor(req)) };
  }

  @Post(':id/messages')
  @AnyAuthenticated()
  // Same reasoning as create: a reply also notifies the other side. 30/min allows a brisk
  // back-and-forth while capping spam.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Reply on a thread' })
  async postMessage(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PostFeedbackMessageRequestDto, @Req() req: any) {
    return { success: true, data: await this.threadService.postMessage(id, this.actor(req), dto) };
  }

  @Post(':id/messages/read')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Mark the other side\'s messages read' })
  async markRead(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return { success: true, data: await this.threadService.markRead(id, this.actor(req)) };
  }

  @Post(':id/vote')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Add or remove your "me too" on an item' })
  async vote(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return { success: true, data: await this.feedbackService.vote(id, this.actor(req)) };
  }

  // ── Team decisions ──────────────────────────────────────────────────────────

  @Post(':id/triage')
  @Roles(...FEEDBACK_TEAM_ROLES)
  @ApiOperation({ summary: 'Set category, severity, status, assignee or duplicate link' })
  async triage(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TriageFeedbackRequestDto, @Req() req: any) {
    return { success: true, data: await this.feedbackService.triage(id, dto, req.user.id) };
  }

  @Post(':id/resolve')
  @Roles(...FEEDBACK_TEAM_ROLES)
  @ApiOperation({ summary: 'Mark an item resolved' })
  async resolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveFeedbackRequestDto, @Req() req: any) {
    return { success: true, data: await this.feedbackService.resolve(id, req.user.id, dto.note) };
  }

  @Post(':id/reopen')
  @Roles(...FEEDBACK_TEAM_ROLES)
  @ApiOperation({ summary: 'Reopen a resolved or closed item' })
  async reopen(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return { success: true, data: await this.feedbackService.reopen(id, req.user.id) };
  }
}
