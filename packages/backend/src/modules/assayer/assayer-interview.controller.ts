import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SystemRole, InterviewOutcome } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { AssayerInterviewService } from './assayer-interview.service';

class RecordInterviewRequestDto {
  @IsString() @MinLength(1) @MaxLength(200)
  candidateName: string;

  @IsString() @MinLength(1) @MaxLength(20)
  mobile: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  @IsEnum(InterviewOutcome)
  outcome: InterviewOutcome;
}

/**
 * What a candidate's name, number or email may be corrected to after the fact. The outcome is not
 * here and never will be: a PASS has already sent somebody a link and a FAIL is a decision that
 * was made, so neither is a typo to fix — record a second interview instead.
 */
class AmendInterviewRequestDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  candidateName?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(20)
  mobile?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;
}

/**
 * The Appraiser Recruitment spec's Module 1 — an internal-only interview gate that decides who
 * gets a self-registration invite. See `AssayerInterviewService` for the pass → invite hand-off.
 */
@ApiTags('Assayer interviews')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assayer-interviews')
export class AssayerInterviewController {
  constructor(private readonly interviews: AssayerInterviewService) {}

  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:create:organization')
  @ApiOperation({ summary: 'Record an interview outcome; a PASS sends the candidate a registration link' })
  async record(@Body() dto: RecordInterviewRequestDto, @Req() req: any) {
    const interview = await this.interviews.record(
      dto,
      req.user.id,
      req.user.displayName ?? req.user.username ?? req.user.email ?? undefined,
      req.user.organizationId,
    );
    return interview;
  }

  /**
   * Correct what was typed, while the candidate has not yet opened their link.
   *
   * This controller had `@Post()` and `@Get()` and nothing else, so a mistyped mobile number could
   * only be repaired by recording a second interview — which sent a second invite and left the log
   * claiming the candidate had been interviewed twice.
   */
  @Patch(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Correct a candidate\'s details before they open their link' })
  async amend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AmendInterviewRequestDto,
    @Req() req: any,
  ) {
    return await this.interviews.amend(id, dto, req.user.id);
  }

  @Get()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'The interview log' })
  async list() {
    return await this.interviews.list();
  }
}
