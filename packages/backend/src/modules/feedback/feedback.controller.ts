import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsOptional, IsString, IsNotEmpty, IsEnum, IsArray, IsObject, IsBoolean } from 'class-validator';

import { FeedbackService, FEEDBACK_TEAM_ROLES } from './feedback.service';
import { FeedbackThreadService, FeedbackActor } from './feedback-thread.service';
import { FeedbackEscalationService } from './feedback-escalation.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, AnyAuthenticated } from '../auth/guards';
import { FeedbackCategory, FeedbackSeverity, FeedbackStatus, SystemRole } from '@fapoms/shared';

// Real classes, not inline TS types: the global ValidationPipe runs `whitelist: true`,
// which strips any property without a class-validator decorator on it.

class CreateFeedbackRequestDto {
  @IsOptional() @IsString() title?: string;
  @IsString() @IsNotEmpty() body: string;
  @IsOptional() @IsEnum(FeedbackCategory) category?: FeedbackCategory;
  @IsOptional() @IsString() area?: string;
  @IsOptional() @IsObject() appContext?: Record<string, unknown>;
  @IsOptional() @IsArray() attachments?: { url: string; fileName: string; fileType: string }[];
}

class PostFeedbackMessageRequestDto {
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsArray() attachments?: { url: string; fileName: string; fileType: string }[];
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
  ) {}

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
  @ApiOperation({ summary: 'File a bug, enhancement, process idea or question' })
  async create(@Body() dto: CreateFeedbackRequestDto, @Req() req: any) {
    const thread = await this.feedbackService.create(dto, this.actor(req));
    return { success: true, data: thread };
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
